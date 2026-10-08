import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

/** A Feature in an OCI registry, by tag. */
export interface FeatureLocation {
  /** Such as `ghcr.io`. */
  registry: string;
  /** Such as `devcontainers/features/docker-in-docker`. */
  repository: string;
  tag: string;
}

/** What a Feature's tag resolves to, as `devcontainer upgrade` locks it. */
export interface ResolvedFeature {
  /** The digest of the Feature's manifest, `sha256:...`. */
  digest: string;
  /** The version its metadata declares. */
  version: string;
  /** The references of the Features its metadata depends on. */
  dependsOn: string[];
}

export interface RegistryOptions {
  /** Defaults to the global `fetch`; tests pass their own. */
  fetch?: typeof fetch;
  /** How long one attempt may take, in milliseconds. */
  timeout?: number;
  /** How many times a request that failed for a reason that can pass is tried again. */
  retries?: number;
  /** The wait before the first retry, in milliseconds; it doubles after each. */
  retryDelay?: number;
}

const MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";

// The rate limit and server errors.
const RETRIED_STATUSES = new Set([429, 500, 502, 503, 504]);

const tokenSchema = z.union([
  z.object({ token: z.string().min(1) }).transform(({ token }) => token),
  z
    .object({ access_token: z.string().min(1) })
    .transform(({ access_token: token }) => token),
]);

// The Feature's `devcontainer-feature.json`, which the Dev Container CLI
// copies into the manifest when it publishes a Feature.
const metadataSchema = z.looseObject({
  dependsOn: z.record(z.string(), z.unknown()).optional(),
  version: z.string().min(1),
});

const manifestSchema = z.looseObject({
  annotations: z.looseObject({
    "dev.containers.metadata": z
      .string()
      .transform((metadata, context) => {
        try {
          return JSON.parse(metadata);
        } catch {
          context.issues.push({
            code: "custom",
            input: metadata,
            message: "is not JSON",
          });
          return z.NEVER;
        }
      })
      .pipe(metadataSchema),
  }),
});

// `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="..."`
const parseBearerChallenge = (header: string | null) => {
  if (header === null || !/^Bearer\s/iu.test(header)) {
    return;
  }
  const parameters = new Map(
    [...header.matchAll(/(?<key>\w+)="(?<value>[^"]*)"/gu)].map((match) => [
      match.groups?.key ?? "",
      match.groups?.value ?? "",
    ])
  );
  const realm = parameters.get("realm");
  return realm === undefined || !realm.startsWith("https://")
    ? undefined
    : { parameters, realm };
};

/**
 * Resolves a Feature's tag in its registry to what the Dev Container CLI
 * locks: the digest of its manifest and the version its metadata declares.
 * The registry is read anonymously, after an anonymous token when it asks
 * for one, so a private Feature fails.
 */
export const resolveFeature = async (
  { registry, repository, tag }: FeatureLocation,
  {
    fetch: fetchImpl = fetch,
    timeout = 30_000,
    retries = 2,
    retryDelay = 1000,
  }: RegistryOptions = {}
): Promise<ResolvedFeature> => {
  const name = `${registry}/${repository}:${tag}`;

  // A request that failed or timed out, and the rate limit and server errors,
  // are tried again; the rest fail at once.
  const request = async (
    url: URL,
    headers: Record<string, string>,
    retry = 0
  ): Promise<Response> => {
    const again = async () => {
      await sleep(retryDelay * 2 ** retry);
      return request(url, headers, retry + 1);
    };
    let response: Response;

    try {
      response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      if (retry < retries) {
        return again();
      }
      throw new Error(
        `${url.host} did not answer for ${name}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }

    return RETRIED_STATUSES.has(response.status) && retry < retries
      ? again()
      : response;
  };

  const manifestUrl = new URL(
    `https://${registry}/v2/${repository}/manifests/${tag}`
  );
  const accept = { accept: MANIFEST_MEDIA_TYPE };
  let response = await request(manifestUrl, accept);

  if (response.status === 401) {
    const challenge = parseBearerChallenge(
      response.headers.get("www-authenticate")
    );
    if (challenge === undefined) {
      throw new Error(`${registry} asks for credentials to read ${name}`);
    }

    const tokenUrl = new URL(challenge.realm);
    for (const key of ["service", "scope"]) {
      const value = challenge.parameters.get(key);
      if (value !== undefined) {
        tokenUrl.searchParams.set(key, value);
      }
    }
    const tokenResponse = await request(tokenUrl, {
      accept: "application/json",
    });
    if (!tokenResponse.ok) {
      throw new Error(
        `${tokenUrl.host} answered ${tokenResponse.status} for a token to read ${name}`
      );
    }
    const token = tokenSchema.parse(await tokenResponse.json());

    response = await request(manifestUrl, {
      ...accept,
      authorization: `Bearer ${token}`,
    });
  }

  if (!response.ok) {
    throw new Error(`${registry} answered ${response.status} for ${name}`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const reported = response.headers.get("docker-content-digest");

  if (reported !== null && reported !== digest) {
    throw new Error(
      `${registry} reported digest ${reported} for ${name}, but its manifest hashes to ${digest}`
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf-8"));
  } catch {
    throw new Error(`The manifest of ${name} is not JSON`);
  }
  const manifest = manifestSchema.safeParse(json);

  if (!manifest.success) {
    throw new Error(
      `The manifest of ${name} carries no Feature metadata with a version`
    );
  }

  const metadata = manifest.data.annotations["dev.containers.metadata"];

  return {
    dependsOn: Object.keys(metadata.dependsOn ?? {}),
    digest,
    version: metadata.version,
  };
};
