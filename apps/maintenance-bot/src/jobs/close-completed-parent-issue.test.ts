import { createGitHubClient } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import {
  closeCompletedParentIssue,
  COMPLETED_PARENT_COMMENT,
  summarizeCloseCompletedParentIssueResult,
} from "./close-completed-parent-issue.ts";

const BOT = "publira-maintenance[bot]";
const ISSUE = "/repos/publira/publira/issues/3408";
const CLOSED_AT = "2026-10-05T03:00:00Z";

interface Scenario {
  state?: string;
  subIssues?: readonly { state: string }[];
  comments?: readonly { body: string; user: { login: string } }[];
}

// Answers the GitHub API for publira/publira#3408, a parent issue, and
// records the writes.
const fakeGitHub = ({
  state = "open",
  subIssues = [{ state: "closed" }, { state: "closed" }],
  comments = [],
}: Scenario = {}) => {
  const routes: string[] = [];
  const writes: { route: string; body: unknown }[] = [];
  const posted = [...comments].map((comment, index) => ({
    created_at: CLOSED_AT,
    id: index + 1,
    updated_at: CLOSED_AT,
    ...comment,
  }));

  const fetchImpl = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const route = `${method} ${url.pathname}`;
    const body =
      init?.body === undefined ? undefined : JSON.parse(String(init.body));
    routes.push(route);
    if (method !== "GET") {
      writes.push({ body, route });
    }

    const respond = () => {
      switch (route) {
        case `GET ${ISSUE}`: {
          return Response.json({ number: 3408, state });
        }
        case `GET ${ISSUE}/sub_issues`: {
          return Response.json(subIssues);
        }
        case `PATCH ${ISSUE}`: {
          return Response.json({
            closed_at: CLOSED_AT,
            number: 3408,
            state: "closed",
            updated_at: CLOSED_AT,
          });
        }
        case `GET ${ISSUE}/comments`: {
          return Response.json(posted);
        }
        case `POST ${ISSUE}/comments`: {
          const comment = {
            body: body.body,
            created_at: CLOSED_AT,
            id: 100,
            updated_at: CLOSED_AT,
            user: { login: BOT },
          };
          posted.push(comment);
          return Response.json(comment, { status: 201 });
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

const options = {
  author: BOT,
  issueNumber: 3408,
  owner: "publira",
  repo: "publira",
};

describe(closeCompletedParentIssue, () => {
  it("closes an issue whose sub-issues are all closed, and comments", async () => {
    const github = fakeGitHub();

    await expect(
      closeCompletedParentIssue({ ...options, octokit: github.octokit })
    ).resolves.toStrictEqual({
      comment: { created: true, id: 100 },
      status: "closed",
      subIssues: 2,
    });
    expect(github.writes).toStrictEqual([
      {
        body: { state: "closed", state_reason: "completed" },
        route: `PATCH ${ISSUE}`,
      },
      {
        body: { body: COMPLETED_PARENT_COMMENT },
        route: `POST ${ISSUE}/comments`,
      },
    ]);
  });

  it("does not comment again when a concurrent run already did", async () => {
    const github = fakeGitHub({
      comments: [{ body: COMPLETED_PARENT_COMMENT, user: { login: BOT } }],
    });

    await expect(
      closeCompletedParentIssue({ ...options, octokit: github.octokit })
    ).resolves.toMatchObject({ comment: { created: false, id: 1 } });
    expect(github.writes.map(({ route }) => route)).toStrictEqual([
      `PATCH ${ISSUE}`,
    ]);
  });

  it("only tells what it would do in a dry run", async () => {
    const github = fakeGitHub();

    await expect(
      closeCompletedParentIssue({
        ...options,
        author: undefined,
        dryRun: true,
        octokit: github.octokit,
      })
    ).resolves.toStrictEqual({ status: "would-close", subIssues: 2 });
    expect(github.writes).toStrictEqual([]);
  });

  it("leaves an issue with an open sub-issue", async () => {
    const github = fakeGitHub({
      subIssues: [{ state: "closed" }, { state: "open" }],
    });

    await expect(
      closeCompletedParentIssue({ ...options, octokit: github.octokit })
    ).resolves.toStrictEqual({
      reason: "1 of its 2 sub-issues is open",
      status: "left",
    });
    expect(github.writes).toStrictEqual([]);
  });

  it("leaves a closed issue without listing its sub-issues", async () => {
    const github = fakeGitHub({ state: "closed" });

    await expect(
      closeCompletedParentIssue({ ...options, octokit: github.octokit })
    ).resolves.toStrictEqual({
      reason: "it is already closed",
      status: "left",
    });
    expect(github.routes).toStrictEqual([`GET ${ISSUE}`]);
  });
});

describe(summarizeCloseCompletedParentIssueResult, () => {
  it("names the comment of a close", () => {
    expect(
      summarizeCloseCompletedParentIssueResult({
        comment: { created: true, id: 100 },
        status: "closed",
        subIssues: 2,
      })
    ).toStrictEqual({
      comment: 100,
      commentCreated: true,
      modelInvoked: false,
      reason: undefined,
      status: "closed",
      subIssues: 2,
    });
  });
});
