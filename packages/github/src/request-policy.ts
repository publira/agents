import { setTimeout as sleep } from "node:timers/promises";

import type { Octokit } from "@octokit/rest";
import { z } from "zod";

/** How the clients time out and retry their requests to GitHub. */
export interface RequestPolicy {
  /** How long one attempt may take, in milliseconds. */
  timeout: number;
  /** How many times a failed read is tried again. */
  retries: number;
  /** The wait before the first retry, in milliseconds; it doubles after each. */
  retryDelay: number;
}

export const DEFAULT_REQUEST_POLICY: Readonly<RequestPolicy> = {
  retries: 2,
  retryDelay: 1000,
  timeout: 30_000,
};

// Only reads are tried again: a write that failed may still have been
// applied, and repeating it could, for one, submit a second review. GraphQL
// queries are POST requests, so they are not either.
const RETRIED_METHODS = new Set(["GET", "HEAD"]);

// GitHub's server errors. Octokit reports a request that failed or timed
// out before an answer as 500.
const SERVER_ERRORS = new Set([500, 502, 503, 504]);

// GitHub answers a rate-limited request with either status. A 403 is
// otherwise a missing permission, which waiting does not cure.
const RATE_LIMITED = new Set([403, 429]);

// A longer wait fails the request; the next run tries it again.
const MAX_WAIT_MS = 10_000;

const failure = z.object({
  response: z
    .object({
      headers: z.looseObject({
        "retry-after": z.coerce.number().optional(),
        "x-ratelimit-remaining": z.coerce.number().optional(),
        "x-ratelimit-reset": z.coerce.number().optional(),
      }),
    })
    .optional(),
  status: z.number(),
});

type Failure = z.infer<typeof failure>;

/**
 * How long GitHub asks a rate-limited request to wait: `retry-after`, or
 * until the primary limit resets once it ran out. Without either, GitHub asks
 * for at least a minute, and a 403 is not a rate limit at all.
 */
const rateLimitWait = (
  headers: NonNullable<Failure["response"]>["headers"] | undefined,
  now: number
): number | undefined => {
  if (headers?.["retry-after"] !== undefined) {
    return headers["retry-after"] * 1000;
  }
  if (
    headers?.["x-ratelimit-remaining"] === 0 &&
    headers["x-ratelimit-reset"] !== undefined
  ) {
    return Math.max(0, headers["x-ratelimit-reset"] * 1000 - now);
  }
};

/** How long to wait before trying again, or `undefined` not to. */
const retryWait = (
  failed: Failure | undefined,
  delay: number,
  now: number
): number | undefined => {
  if (failed === undefined) {
    return undefined;
  }

  const headers = failed.response?.headers;
  let wait: number | undefined;

  if (SERVER_ERRORS.has(failed.status)) {
    wait =
      headers?.["retry-after"] === undefined
        ? delay
        : rateLimitWait(headers, now);
  } else if (RATE_LIMITED.has(failed.status)) {
    wait = rateLimitWait(headers, now);
  }

  return wait !== undefined && wait <= MAX_WAIT_MS ? wait : undefined;
};

/**
 * Makes every request of a client time out, and has the reads that failed
 * for a reason that can pass tried again. The jobs fail closed on an error
 * that remains, and their next run tries again.
 */
export const applyRequestPolicy = (
  octokit: Octokit,
  policy: Partial<RequestPolicy> = {}
): Octokit => {
  const { retries, retryDelay, timeout } = {
    ...DEFAULT_REQUEST_POLICY,
    ...policy,
  };

  octokit.hook.wrap("request", (request, options) => {
    const callerSignal = options.request?.signal;
    const attempt = async (
      retry: number
    ): Promise<Awaited<ReturnType<typeof request>>> => {
      const signal = AbortSignal.timeout(timeout);
      // Octokit sends the options it passed the hook, so they are changed in
      // place; a copy would be ignored.
      options.request = {
        ...options.request,
        signal:
          callerSignal === undefined
            ? signal
            : AbortSignal.any([callerSignal, signal]),
      };

      try {
        return await request(options);
      } catch (error) {
        const wait =
          retry < retries && RETRIED_METHODS.has(options.method)
            ? retryWait(
                failure.safeParse(error).data,
                retryDelay * 2 ** retry,
                Date.now()
              )
            : undefined;

        if (wait === undefined) {
          throw error;
        }
        await sleep(wait);
        return attempt(retry + 1);
      }
    };

    return attempt(0);
  });

  return octokit;
};
