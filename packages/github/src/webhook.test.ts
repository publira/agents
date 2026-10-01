import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyWebhookDelivery, WebhookVerificationError } from "./webhook.ts";

const secret = "test-secret";
const body = JSON.stringify({ action: "opened", installation: { id: 42 } });

const sign = (payload: string, key = secret) =>
  `sha256=${createHmac("sha256", key).update(payload).digest("hex")}`;

const deliveryHeaders = (overrides: Record<string, string | null> = {}) => {
  const headers = new Headers({
    "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    "x-github-event": "pull_request",
    "x-hub-signature-256": sign(body),
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) {
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
};

describe(verifyWebhookDelivery, () => {
  it("parses a delivery signed with the secret", async () => {
    await expect(
      verifyWebhookDelivery({ body, headers: deliveryHeaders(), secret })
    ).resolves.toStrictEqual({
      id: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      name: "pull_request",
      payload: { action: "opened", installation: { id: 42 } },
    });
  });

  it.each([
    ["another secret", sign(body, "other-secret")],
    ["another body", sign(`${body} `)],
    ["the SHA-1 scheme", sign(body).replace("sha256=", "sha1=")],
    ["a truncated signature", sign(body).slice(0, -2)],
  ])("rejects a signature made with %s", async (_label, signature) => {
    await expect(
      verifyWebhookDelivery({
        body,
        headers: deliveryHeaders({ "x-hub-signature-256": signature }),
        secret,
      })
    ).rejects.toThrow(WebhookVerificationError);
  });

  it.each(["x-github-delivery", "x-github-event", "x-hub-signature-256"])(
    "rejects a request without %s",
    async (header) => {
      await expect(
        verifyWebhookDelivery({
          body,
          headers: deliveryHeaders({ [header]: null }),
          secret,
        })
      ).rejects.toThrow(WebhookVerificationError);
    }
  );

  it("rejects a signed body that is not JSON", async () => {
    const form = "payload=%7B%7D";

    await expect(
      verifyWebhookDelivery({
        body: form,
        headers: deliveryHeaders({ "x-hub-signature-256": sign(form) }),
        secret,
      })
    ).rejects.toThrow("not JSON");
  });

  it("refuses to verify with an empty secret", async () => {
    await expect(
      verifyWebhookDelivery({
        body,
        headers: deliveryHeaders({ "x-hub-signature-256": sign(body, "") }),
        secret: "",
      })
    ).rejects.toThrow("secret is empty");
  });
});
