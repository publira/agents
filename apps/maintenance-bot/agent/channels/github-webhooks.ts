import { defineChannel, POST } from "eve/channels";

import { getGitHubApp, readGitHubAppConfig } from "../../src/github-app.ts";
import { webhookHandlers } from "../../src/webhooks/handlers.ts";
import { receiveWebhook } from "../../src/webhooks/receive-webhook.ts";

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
