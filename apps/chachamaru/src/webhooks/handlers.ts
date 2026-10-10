import { createAgentAssistedPullRequestHandlers } from "./agent-assisted-pull-requests.ts";
import { createParentIssueHandlers } from "./parent-issues.ts";
import { combineWebhookHandlers } from "./receive-webhook.ts";
import type { WebhookHandlers } from "./receive-webhook.ts";
import { createRenovateUpdateHandlers } from "./renovate-updates.ts";

/**
 * The handlers the bot runs, by event name. Subscribe the GitHub App to an
 * event only once it has a handler here; the others are acknowledged and
 * dropped.
 */
export const webhookHandlers: WebhookHandlers = combineWebhookHandlers(
  createAgentAssistedPullRequestHandlers(),
  createParentIssueHandlers(),
  createRenovateUpdateHandlers()
);
