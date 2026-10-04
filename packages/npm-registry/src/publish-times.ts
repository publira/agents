import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";

export interface RegistryOptions {
  /** Defaults to the global `fetch`; tests pass their own. */
  fetch?: typeof fetch;
  /** Defaults to the public npm registry. */
  registryUrl?: string;
  /** How long one attempt may take, in milliseconds. */
  timeout?: number;
  /** How many times a request that failed for a reason that can pass is tried again. */
  retries?: number;
  /** The wait before the first retry, in milliseconds; it doubles after each. */
  retryDelay?: number;
}

// The registry's rate limit and server errors.
const RETRIED_STATUSES = new Set([429, 500, 502, 503, 504]);

// `time` maps each version to its publish time, next to the `created` and
// `modified` keys. An unpublished package keeps an `unpublished` object there
// instead of its versions.
const packumentSchema = z.object({
  time: z
    .object({
      created: z.iso.datetime().optional(),
      modified: z.iso.datetime().optional(),
      unpublished: z.looseObject({}).optional(),
    })
    .catchall(z.iso.datetime()),
});

/**
 * Fetches when each published version of a package was published, keyed by
 * version. A package the registry does not have has no versions.
 */
export const fetchPublishTimes = async (
  name: string,
  {
    fetch: fetchImpl = fetch,
    registryUrl = DEFAULT_REGISTRY_URL,
    timeout = 30_000,
    retries = 2,
    retryDelay = 1000,
  }: RegistryOptions = {}
): Promise<Map<string, Date>> => {
  // The registry takes a scoped name with its slash escaped.
  const url = new URL(
    name.replace("/", "%2f"),
    `${registryUrl.replace(/\/$/u, "")}/`
  );

  // A request that failed or timed out, and the registry's rate limit and
  // server errors, are tried again; the rest fail at once.
  const request = async (retry: number): Promise<Response> => {
    const again = async () => {
      await sleep(retryDelay * 2 ** retry);
      return request(retry + 1);
    };
    let response: Response;

    try {
      response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      if (retry < retries) {
        return again();
      }
      throw new Error(
        `The npm registry did not answer for ${JSON.stringify(name)}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }

    return RETRIED_STATUSES.has(response.status) && retry < retries
      ? again()
      : response;
  };
  const response = await request(0);

  if (response.status === 404) {
    return new Map();
  }

  if (!response.ok) {
    throw new Error(
      `The npm registry answered ${response.status} for ${JSON.stringify(name)}`
    );
  }

  const {
    time: {
      created: _created,
      modified: _modified,
      unpublished: _unpublished,
      ...versions
    },
  } = packumentSchema.parse(await response.json());

  return new Map(
    Object.entries(versions).map(([version, publishedAt]) => [
      version,
      new Date(publishedAt),
    ])
  );
};
