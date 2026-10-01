import { createHmac } from "node:crypto";

import { createGitHubClient } from "@publira/github";
import type { GitHubApp } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import type { Log } from "../log.ts";
import { receiveWebhook } from "./receive-webhook.ts";
import type { WebhookHandler } from "./receive-webhook.ts";

const webhookSecret = "test-secret";

// The handlers under test never call GitHub.
const app: GitHubApp = {
  getBotLogin: () => Promise.reject(new Error("unused")),
  getInstallationOctokit: () => Promise.reject(new Error("unused")),
  getRepositoryOctokit: () => Promise.reject(new Error("unused")),
  octokit: createGitHubClient(),
};

const payload = {
  action: "opened",
  installation: { id: 42 },
  pull_request: { body: "Private details", number: 7 },
  repository: { full_name: "publira/agents" },
};

const webhookRequest = ({
  event = "pull_request",
  body = JSON.stringify(payload),
  secret = webhookSecret,
} = {}) =>
  new Request("https://bot.example/github/webhooks", {
    body,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "delivery-1",
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    method: "POST",
  });

const setup = (handlers: Record<string, WebhookHandler> = {}) => {
  const tasks: Promise<unknown>[] = [];
  const log = vi.fn<Log>();
  return {
    log,
    // Every line the request logged, as written.
    logged: () => JSON.stringify(log.mock.calls),
    options: {
      app,
      handlers,
      log,
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(task);
      },
      webhookSecret,
    },
    settle: () => Promise.all(tasks),
  };
};

describe(receiveWebhook, () => {
  it("runs the event's handler after answering", async () => {
    const handler = vi.fn<WebhookHandler>(() => Promise.resolve());
    const { log, options, settle } = setup({ pull_request: handler });

    const response = await receiveWebhook(webhookRequest(), options);

    expect(response.status).toBe(202);
    await settle();
    expect(handler).toHaveBeenCalledWith(
      { id: "delivery-1", name: "pull_request", payload },
      { app, log }
    );
    expect(log).toHaveBeenLastCalledWith("info", "Webhook handled", {
      action: "opened",
      delivery: "delivery-1",
      event: "pull_request",
      installation: 42,
      repository: "publira/agents",
    });
  });

  it("acknowledges an event without a handler", async () => {
    const { log, options } = setup();

    const response = await receiveWebhook(
      webhookRequest({ event: "ping" }),
      options
    );

    expect(response.status).toBe(204);
    expect(log).toHaveBeenCalledWith(
      "info",
      "Webhook ignored: no handler for the event",
      expect.objectContaining({ delivery: "delivery-1", event: "ping" })
    );
  });

  it("does not take an event name for an inherited property", async () => {
    const { options } = setup();

    const response = await receiveWebhook(
      webhookRequest({ event: "toString" }),
      options
    );

    expect(response.status).toBe(204);
  });

  it("rejects a request signed with another secret", async () => {
    const handler = vi.fn<WebhookHandler>(() => Promise.resolve());
    const { options } = setup({ pull_request: handler });

    const response = await receiveWebhook(
      webhookRequest({ secret: "other-secret" }),
      options
    );

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses every request when the App is not configured", async () => {
    const { options } = setup();

    const response = await receiveWebhook(webhookRequest(), {
      ...options,
      webhookSecret: undefined,
    });

    expect(response.status).toBe(503);
  });

  it("logs a failed handler without the payload", async () => {
    const { logged, log, options, settle } = setup({
      pull_request: () => Promise.reject(new Error("Not Found")),
    });

    await receiveWebhook(webhookRequest(), options);
    await settle();

    expect(log).toHaveBeenLastCalledWith(
      "error",
      "Webhook handler failed",
      expect.objectContaining({ delivery: "delivery-1", error: "Not Found" })
    );
    expect(logged()).not.toContain("Private details");
    expect(logged()).not.toContain(webhookSecret);
  });
});
