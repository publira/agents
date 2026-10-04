import { createRenovateApprovalHandlers } from "./approve-equivalent-renovate-updates.ts";
import type { WebhookHandlers } from "./receive-webhook.ts";

/**
 * The handlers the bot runs, by event name. Subscribe the GitHub App to an
 * event only once it has a handler here; the others are acknowledged and
 * dropped.
 */
export const webhookHandlers: WebhookHandlers = {
  ...createRenovateApprovalHandlers(),
};
