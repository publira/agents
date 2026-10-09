import { createGitHubClient } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import {
  labelAgentAssistedPullRequest,
  summarizeLabelAgentAssistedPullRequestResult,
} from "./label-agent-assisted-pull-request.ts";

const REPOSITORY = "/repos/publira/agents";
const PULL = `${REPOSITORY}/pulls/70`;
const ISSUE_LABELS = `${REPOSITORY}/issues/70/labels`;

const ASSISTED =
  "feat: add a maintenance policy\n\nAssisted-by: Claude Code:claude-opus-5-5";
const UNASSISTED = "fix: handle a missing label";

interface Scenario {
  draft?: boolean;
  messages?: readonly string[];
  labels?: readonly string[];
  labelDefined?: boolean;
  /** Whether the label is still on the pull request when it is removed. */
  removable?: boolean;
}

// Answers the GitHub API for publira/agents#70 and records the requests.
const fakeGitHub = ({
  draft = false,
  messages = [UNASSISTED, ASSISTED],
  labels = [],
  labelDefined = true,
  removable = true,
}: Scenario = {}) => {
  const routes: string[] = [];
  const writes: { route: string; body: unknown }[] = [];

  const fetchImpl = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const route = `${method} ${url.pathname}`;
    routes.push(route);
    if (method !== "GET") {
      writes.push({
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        route,
      });
    }

    const respond = () => {
      switch (route) {
        case `GET ${PULL}`: {
          return Response.json({
            draft,
            labels: labels.map((name) => ({ name })),
            number: 70,
          });
        }
        case `GET ${PULL}/commits`: {
          return Response.json(
            messages.map((message) => ({ commit: { message } }))
          );
        }
        case `GET ${REPOSITORY}/labels/ai-assisted`: {
          return labelDefined
            ? Response.json({ name: "ai-assisted" })
            : Response.json({ message: "Not Found" }, { status: 404 });
        }
        case `POST ${ISSUE_LABELS}`: {
          return Response.json([{ name: "ai-assisted" }]);
        }
        case `DELETE ${ISSUE_LABELS}/ai-assisted`: {
          return removable
            ? Response.json([])
            : Response.json(
                { message: "Label does not exist" },
                { status: 404 }
              );
        }
        default: {
          return Response.json({ message: "Not Found" }, { status: 404 });
        }
      }
    };
    const response = respond();
    Object.defineProperty(response, "url", { value: url.href });
    return Promise.resolve(response);
  });

  return {
    octokit: createGitHubClient({ fetch: fetchImpl }),
    routes,
    writes,
  };
};

const options = { owner: "publira", pullNumber: 70, repo: "agents" };

describe(labelAgentAssistedPullRequest, () => {
  it("labels a pull request whose commits disclose an agent", async () => {
    const github = fakeGitHub();

    await expect(
      labelAgentAssistedPullRequest({ ...options, octokit: github.octokit })
    ).resolves.toStrictEqual({ commits: 2, status: "added" });
    expect(github.writes).toStrictEqual([
      { body: { labels: ["ai-assisted"] }, route: `POST ${ISSUE_LABELS}` },
    ]);
  });

  it("takes the label off when no commit discloses an agent", async () => {
    const github = fakeGitHub({
      labels: ["ai-assisted"],
      messages: [UNASSISTED],
    });

    await expect(
      labelAgentAssistedPullRequest({ ...options, octokit: github.octokit })
    ).resolves.toStrictEqual({ commits: 1, status: "removed" });
    expect(github.writes).toStrictEqual([
      { body: undefined, route: `DELETE ${ISSUE_LABELS}/ai-assisted` },
    ]);
  });

  it("accepts a label someone took off a moment before", async () => {
    const github = fakeGitHub({
      labels: ["ai-assisted"],
      messages: [UNASSISTED],
      removable: false,
    });

    await expect(
      labelAgentAssistedPullRequest({ ...options, octokit: github.octokit })
    ).resolves.toStrictEqual({
      commits: 1,
      reason: "the label is already gone",
      status: "left",
    });
  });

  it.each([
    ["a draft", { draft: true }, "it is a draft"],
    [
      "a pull request in a repository without the label",
      { labelDefined: false },
      "the repository does not define the ai-assisted label",
    ],
    [
      "a pull request that is already labelled",
      { labels: ["ai-assisted"] },
      "it is already labelled",
    ],
  ])("leaves %s", async (_, scenario, reason) => {
    const github = fakeGitHub(scenario);

    await expect(
      labelAgentAssistedPullRequest({ ...options, octokit: github.octokit })
    ).resolves.toStrictEqual({ commits: 2, reason, status: "left" });
    expect(github.writes).toStrictEqual([]);
  });

  it.each([
    ["add", {}, "would-add"],
    [
      "remove",
      { labels: ["ai-assisted"], messages: [UNASSISTED] },
      "would-remove",
    ],
  ])(
    "only tells what it would %s in a dry run",
    async (_, scenario, status) => {
      const github = fakeGitHub(scenario);

      await expect(
        labelAgentAssistedPullRequest({
          ...options,
          dryRun: true,
          octokit: github.octokit,
        })
      ).resolves.toMatchObject({ status });
      expect(github.writes).toStrictEqual([]);
    }
  );
});

describe(summarizeLabelAgentAssistedPullRequestResult, () => {
  it("logs the decision without a model", () => {
    expect(
      summarizeLabelAgentAssistedPullRequestResult({
        commits: 3,
        reason: "it is a draft",
        status: "left",
      })
    ).toStrictEqual({
      commits: 3,
      modelInvoked: false,
      reason: "it is a draft",
      status: "left",
    });
  });
});
