import { z } from "zod";

import {
  labelAgentAssistedPullRequest,
  summarizeLabelAgentAssistedPullRequestResult,
} from "../jobs/label-agent-assisted-pull-request.ts";
import { loggableFailure, withFields } from "../log.ts";
import { readSettings } from "../settings.ts";
import type { WebhookHandler } from "./receive-webhook.ts";

const pullRequestEvent = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
  pull_request: z.object({ number: z.number() }),
  repository: z.object({
    name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
});

// The actions after which the commits or the draft state may have changed.
// The job reads whether the pull request is a draft, and leaves one alone.
const EVALUATED_ACTIONS = new Set([
  "opened",
  "ready_for_review",
  "synchronize",
]);

export interface AgentAssistedPullRequestHandlerOptions {
  label: typeof labelAgentAssistedPullRequest;
  /** Reads the settings for each delivery. */
  readSettings: typeof readSettings;
}

/**
 * The handler that labels a pull request `ai-assisted` when its commits
 * disclose an agent, and takes the label off when they no longer do, by
 * event name. Tests replace the job.
 */
export const createAgentAssistedPullRequestHandlers = ({
  label = labelAgentAssistedPullRequest,
  readSettings: read = readSettings,
}: Partial<AgentAssistedPullRequestHandlerOptions> = {}): Record<
  "pull_request",
  WebhookHandler
> => ({
  async pull_request(delivery, { app, log }) {
    const payload = pullRequestEvent.parse(delivery.payload);

    if (!EVALUATED_ACTIONS.has(payload.action)) {
      return;
    }
    const { dryRun } = read(log);
    const location = {
      owner: payload.repository.owner.login,
      pullNumber: payload.pull_request.number,
      repo: payload.repository.name,
    };
    const jobLog = withFields(log, {
      dryRun,
      installation: payload.installation.id,
      job: "label-agent-assisted-pull-request",
      owner: location.owner,
      pullRequest: location.pullNumber,
      repo: location.repo,
    });

    try {
      const result = await label({
        ...location,
        dryRun,
        octokit: await app.getInstallationOctokit(payload.installation.id),
      });
      jobLog(
        "info",
        "Agent assistance label evaluated",
        summarizeLabelAgentAssistedPullRequestResult(result)
      );
    } catch (error) {
      jobLog("error", "Agent assistance label evaluation failed", {
        ...loggableFailure.safeParse(error).data,
        modelInvoked: false,
      });
    }
  },
});
