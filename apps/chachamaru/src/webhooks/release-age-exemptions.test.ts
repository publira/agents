import { createGitHubClient } from "@publira/github";
import type { GitHubApp, WebhookDelivery } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import type { approveReleaseAgeExemption } from "#jobs/exempt-release-age-violations.ts";
import type { Log } from "#runtime/log.ts";

import { createReleaseAgeExemptionHandlers } from "./release-age-exemptions.ts";

const BOT = "chachamaru-bot[bot]";
const URL = "https://github.com/publira/publira/pull/3949#issuecomment-50";

const octokit = createGitHubClient();

const setup = ({
  dryRun = false,
  approve = vi.fn<typeof approveReleaseAgeExemption>(() =>
    Promise.resolve({
      approvedIn: URL,
      commitSha: "new-commit",
      entries: ["playwright@1.64.0"],
      headSha: "head",
      outdatedQuestions: { minimized: 1 },
      status: "committed" as const,
    })
  ),
} = {}) => {
  const app: GitHubApp = {
    getBotLogin: () => Promise.resolve(BOT),
    getInstallationOctokit: () => Promise.resolve(octokit),
    getRepositoryOctokit: () => Promise.reject(new Error("unused")),
    octokit: createGitHubClient(),
  };

  const log = vi.fn<Log>();

  return {
    approve,
    context: { app, log },
    handlers: createReleaseAgeExemptionHandlers({
      approve,
      readSettings: () => ({ dryRun, renovateAutoMerge: false }),
    }),
    log,
  };
};

const delivery = ({
  action = "created",
  pullRequest = true,
  issueAuthor = "renovate[bot]",
} = {}): WebhookDelivery => ({
  id: "delivery-1",
  name: "issue_comment",
  payload: {
    action,
    comment: {
      body: "@chachamaru-bot add",
      html_url: URL,
      id: 50,
      user: { login: "ykzts" },
    },
    installation: { id: 42 },
    issue: {
      number: 3949,
      ...(pullRequest && { pull_request: { url: "https://api.github.com" } }),
      user: { login: issueAuthor },
    },
    repository: { name: "publira", owner: { login: "publira" } },
  },
});

describe(createReleaseAgeExemptionHandlers, () => {
  it("passes a new comment on a Renovate pull request to the job", async () => {
    const { approve, context, handlers, log } = setup({ dryRun: true });

    await handlers.issue_comment(delivery(), context);

    expect(approve).toHaveBeenCalledWith({
      botLogin: BOT,
      comment: {
        author: "ykzts",
        body: "@chachamaru-bot add",
        id: 50,
        url: URL,
      },
      dryRun: true,
      octokit,
      owner: "publira",
      pullNumber: 3949,
      repo: "publira",
    });
    expect(log).toHaveBeenCalledWith(
      "info",
      "Release age exemption approval evaluated",
      expect.objectContaining({
        commit: "new-commit",
        installation: 42,
        job: "exempt-release-age-violations",
        modelInvoked: false,
        pullRequest: 3949,
        requestAuthor: "ykzts",
        requestComment: 50,
        status: "committed",
      })
    );
  });

  it.each([
    ["an edited comment", { action: "edited" }],
    ["a comment on an issue", { pullRequest: false }],
    ["a comment on another pull request", { issueAuthor: "ykzts" }],
  ])("ignores %s", async (_label, options) => {
    const { approve, context, handlers } = setup();

    await handlers.issue_comment(delivery(options), context);

    expect(approve).not.toHaveBeenCalled();
  });

  it("logs a job that threw", async () => {
    const { context, handlers, log } = setup({
      approve: vi.fn<typeof approveReleaseAgeExemption>(() =>
        Promise.reject(new Error("Server Error"))
      ),
    });

    await handlers.issue_comment(delivery(), context);

    expect(log).toHaveBeenCalledWith(
      "error",
      "Release age exemption approval failed",
      expect.objectContaining({ error: "Server Error", modelInvoked: false })
    );
  });
});
