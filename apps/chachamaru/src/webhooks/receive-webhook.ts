import {
  verifyWebhookDelivery,
  WebhookVerificationError,
} from "@publira/github";
import type { GitHubApp, WebhookDelivery } from "@publira/github";
import { z } from "zod";

import { log as defaultLog, loggableFailure, withFields } from "../log.ts";
import type { Log, LogFields } from "../log.ts";

/**
 * Handles one event. GitHub can deliver an event more than once, and a
 * failed delivery can be redelivered, so a handler must be safe to run again:
 * it checks what is already in place before it writes, as the `ensure*` and
 * `commitToBranch` helpers of `@publira/github` do.
 */
export type WebhookHandler = (
  delivery: WebhookDelivery,
  context: { app: GitHubApp; log: Log }
) => Promise<void>;

/** Handlers by event name, such as `pull_request`. */
export type WebhookHandlers = Readonly<Record<string, WebhookHandler>>;

/**
 * Joins sets of handlers into one. The handlers that several sets have for
 * the same event all run, each whether or not another fails; the first
 * failure is passed on once they are done.
 */
export const combineWebhookHandlers = (
  ...sets: readonly WebhookHandlers[]
): WebhookHandlers => {
  const byEvent = new Map<string, WebhookHandler[]>();
  for (const handlers of sets) {
    for (const [name, handler] of Object.entries(handlers)) {
      byEvent.set(name, [...(byEvent.get(name) ?? []), handler]);
    }
  }

  return Object.fromEntries(
    [...byEvent].map(([name, handlers]): [string, WebhookHandler] => [
      name,
      async (delivery, context) => {
        const results = await Promise.allSettled(
          handlers.map((handler) => handler(delivery, context))
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed !== undefined) {
          throw failed.reason;
        }
      },
    ])
  );
};

export interface ReceiveWebhookOptions {
  /** `undefined` when the GitHub App is not configured. */
  app: GitHubApp | undefined;
  webhookSecret: string | undefined;
  handlers: WebhookHandlers;
  /** Keeps the handler running after the response is sent. */
  waitUntil: (task: Promise<unknown>) => void;
  log?: Log;
}

// Only what identifies a delivery in the logs.
const payloadSummary = z.object({
  action: z.string().optional(),
  installation: z.object({ id: z.number() }).optional(),
  repository: z.object({ full_name: z.string() }).optional(),
});

const summarize = ({ id, name, payload }: WebhookDelivery): LogFields => {
  const { data } = payloadSummary.safeParse(payload);
  return {
    action: data?.action,
    delivery: id,
    event: name,
    installation: data?.installation?.id,
    repository: data?.repository?.full_name,
  };
};

/**
 * Answers a GitHub webhook request. It verifies the signature, then answers
 * at once and runs the event's handler in the background: GitHub gives up on
 * a delivery after 10 seconds.
 */
export const receiveWebhook = async (
  request: Request,
  {
    app,
    webhookSecret,
    handlers,
    waitUntil,
    log = defaultLog,
  }: ReceiveWebhookOptions
): Promise<Response> => {
  if (app === undefined || webhookSecret === undefined) {
    log("error", "Webhook received, but the GitHub App is not configured");
    return new Response("The GitHub App is not configured\n", {
      status: 503,
    });
  }

  let delivery: WebhookDelivery;
  try {
    delivery = await verifyWebhookDelivery({
      body: await request.text(),
      headers: request.headers,
      secret: webhookSecret,
    });
  } catch (error) {
    if (!(error instanceof WebhookVerificationError)) {
      throw error;
    }
    log("warn", "Webhook rejected", {
      delivery: request.headers.get("x-github-delivery"),
      reason: error.message,
    });
    return new Response(`${error.message}\n`, { status: 401 });
  }

  const fields = summarize(delivery);
  const handler = Object.hasOwn(handlers, delivery.name)
    ? handlers[delivery.name]
    : undefined;

  if (handler === undefined) {
    log("info", "Webhook ignored: no handler for the event", fields);
    return new Response(null, { status: 204 });
  }

  log("info", "Webhook accepted", fields);
  const handle = async () => {
    try {
      // The handler's lines name the delivery they come from.
      await handler(delivery, {
        app,
        log: withFields(log, { delivery: delivery.id, event: delivery.name }),
      });
      log("info", "Webhook handled", fields);
    } catch (error) {
      log("error", "Webhook handler failed", {
        ...fields,
        ...loggableFailure.safeParse(error).data,
      });
    }
  };
  waitUntil(handle());

  return new Response(null, { status: 202 });
};
