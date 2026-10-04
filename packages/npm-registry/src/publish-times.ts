import { z } from "zod";

export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";

export interface RegistryOptions {
  /** Defaults to the global `fetch`; tests pass their own. */
  fetch?: typeof fetch;
  /** Defaults to the public npm registry. */
  registryUrl?: string;
}

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
  }: RegistryOptions = {}
): Promise<Map<string, Date>> => {
  // The registry takes a scoped name with its slash escaped.
  const url = new URL(
    name.replace("/", "%2f"),
    `${registryUrl.replace(/\/$/u, "")}/`
  );
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
  });

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
