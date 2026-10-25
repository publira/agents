import { defineChannel, POST } from "eve/channels";

import { getGitHubApp, readGitHubAppConfig } from "#runtime/github-app.ts";
import { webhookHandlers } from "#webhooks/handlers.ts";
import { receiveWebhook } from "#webhooks/receive-webhook.ts";

// The GitHub App's webhook URL. The signature, checked against
// GITHUB_WEBHOOK_SECRET, authenticates the request; the handlers run jobs
// without starting an agent session.
export default defineChannel({
  routes: [
    POST("/github/webhooks", (request, { waitUntil }) =>
      receiveWebhook(request, {
        app: getGitHubApp(),
        handlers: webhookHandlers,
        waitUntil,
        webhookSecret: readGitHubAppConfig()?.webhookSecret,
      })
    ),
  ],
});
