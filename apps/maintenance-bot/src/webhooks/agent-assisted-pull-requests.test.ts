import { createGitHubClient } from "@publira/github";
import type { GitHubApp, WebhookDelivery } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import type { labelAgentAssistedPullRequest } from "../jobs/label-agent-assisted-pull-request.ts";
import type { Log } from "../log.ts";
import { createAgentAssistedPullRequestHandlers } from "./agent-assisted-pull-requests.ts";

const octokit = createGitHubClient();

const setup = ({
  dryRun = false,
  label = vi.fn<typeof labelAgentAssistedPullRequest>(() =>
    Promise.resolve({ commits: 2, status: "added" })
  ),
} = {}) => {
  const app: GitHubApp = {
    getBotLogin: () => Promise.reject(new Error("unused")),
    getInstallationOctokit: () => Promise.resolve(octokit),
    getRepositoryOctokit: () => Promise.reject(new Error("unused")),
    octokit: createGitHubClient(),
  };

  return {
    context: { app, log: vi.fn<Log>() },
    handlers: createAgentAssistedPullRequestHandlers({
      label,
      readSettings: () => ({ dryRun, renovateAutoMerge: false }),
    }),
    label,
  };
};

const delivery = (action: string): WebhookDelivery => ({
  id: "delivery-1",
  name: "pull_request",
  payload: {
    action,
    installation: { id: 42 },
    pull_request: { draft: false, labels: [], number: 70 },
    repository: { name: "agents", owner: { login: "publira" } },
  },
});

describe(createAgentAssistedPullRequestHandlers, () => {
  it.each(["opened", "ready_for_review", "synchronize"])(
    "evaluates a pull request on %s",
    async (action) => {
      const { context, handlers, label } = setup({ dryRun: true });

      await handlers.pull_request(delivery(action), context);

      expect(label).toHaveBeenCalledWith({
        dryRun: true,
        octokit,
        owner: "publira",
        pullNumber: 70,
        repo: "agents",
      });
      expect(context.log).toHaveBeenCalledWith(
        "info",
        "Agent assistance label evaluated",
        {
          commits: 2,
          dryRun: true,
          installation: 42,
          job: "label-agent-assisted-pull-request",
          modelInvoked: false,
          owner: "publira",
          pullRequest: 70,
          reason: undefined,
          repo: "agents",
          status: "added",
        }
      );
    }
  );

  it.each(["closed", "edited", "labeled", "reopened"])(
    "leaves a pull request alone on %s",
    async (action) => {
      const { context, handlers, label } = setup();

      await handlers.pull_request(delivery(action), context);

      expect(label).not.toHaveBeenCalled();
    }
  );

  it("logs a failed evaluation", async () => {
    const { context, handlers } = setup({
      label: vi.fn<typeof labelAgentAssistedPullRequest>(() =>
        Promise.reject(Object.assign(new Error("Forbidden"), { status: 403 }))
      ),
    });

    await handlers.pull_request(delivery("synchronize"), context);

    expect(context.log).toHaveBeenCalledWith(
      "error",
      "Agent assistance label evaluation failed",
      expect.objectContaining({
        error: "Forbidden",
        job: "label-agent-assisted-pull-request",
        modelInvoked: false,
        status: 403,
      })
    );
  });
});
