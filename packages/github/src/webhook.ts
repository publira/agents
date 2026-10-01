import { verify } from "@octokit/webhooks-methods";

export interface WebhookDelivery {
  /** `X-GitHub-Delivery`; a redelivery keeps the ID of the original. */
  id: string;
  /** `X-GitHub-Event`, such as `pull_request`. */
  name: string;
  payload: unknown;
}

export interface VerifyWebhookDeliveryOptions {
  /** The App's webhook secret. */
  secret: string;
  headers: Headers;
  /** The raw request body, exactly as GitHub signed it. */
  body: string;
}

/** The request is not a GitHub webhook delivery signed with the secret. */
export class WebhookVerificationError extends Error {
  override name = "WebhookVerificationError";
}

/**
 * Checks a webhook delivery's `X-Hub-Signature-256` against the secret, then
 * parses it. Nothing in the payload is trusted before the signature matches.
 */
export const verifyWebhookDelivery = async ({
  secret,
  headers,
  body,
}: VerifyWebhookDeliveryOptions): Promise<WebhookDelivery> => {
  if (secret === "") {
    throw new Error("The webhook secret is empty");
  }

  const id = headers.get("x-github-delivery");
  const name = headers.get("x-github-event");
  const signature = headers.get("x-hub-signature-256");

  if (id === null || name === null || signature === null || body === "") {
    throw new WebhookVerificationError(
      "The request is not a GitHub webhook delivery"
    );
  }

  if (!(await verify(secret, body, signature))) {
    throw new WebhookVerificationError(
      "The webhook signature does not match the secret"
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    // A repository webhook can be set to send a form instead.
    throw new WebhookVerificationError("The webhook payload is not JSON");
  }

  return { id, name, payload };
};
