import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { resolveFeature } from "./registry.ts";

const location = {
  registry: "ghcr.io",
  repository: "devcontainers/features/docker-in-docker",
  tag: "4.1.3",
};

const MANIFEST_URL =
  "https://ghcr.io/v2/devcontainers/features/docker-in-docker/manifests/4.1.3";

interface FeatureMetadata {
  id?: string;
  version?: string;
  dependsOn?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const DOCKER_IN_DOCKER: FeatureMetadata = {
  id: "docker-in-docker",
  version: "4.1.3",
};

const manifest = (metadata: FeatureMetadata = DOCKER_IN_DOCKER) =>
  JSON.stringify({
    annotations: {
      "com.github.package.type": "devcontainer_feature",
      "dev.containers.metadata": JSON.stringify(metadata),
    },
    config: { mediaType: "application/vnd.devcontainers" },
    schemaVersion: 2,
  });

const digestOf = (body: string) =>
  `sha256:${createHash("sha256").update(body).digest("hex")}`;

const challenge = new Response("", {
  headers: {
    "www-authenticate":
      'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:devcontainers/features/docker-in-docker:pull"',
  },
  status: 401,
});

// Answers like ghcr.io: a manifest only with the anonymous token.
const fakeRegistry = (
  body = manifest(),
  headers: Record<string, string> = {}
) =>
  vi.fn<typeof fetch>((input, init) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");

    if (url.startsWith("https://ghcr.io/token?")) {
      return Promise.resolve(Response.json({ token: "anonymous" }));
    }
    if (url === MANIFEST_URL) {
      return Promise.resolve(
        authorization === "Bearer anonymous"
          ? new Response(body, {
              headers: { "docker-content-digest": digestOf(body), ...headers },
            })
          : challenge.clone()
      );
    }
    return Promise.resolve(new Response("", { status: 404 }));
  });

describe(resolveFeature, () => {
  it("resolves a tag to its manifest's digest and version", async () => {
    const fetchImpl = fakeRegistry();

    await expect(
      resolveFeature(location, { fetch: fetchImpl })
    ).resolves.toStrictEqual({
      dependsOn: [],
      digest: digestOf(manifest()),
      version: "4.1.3",
    });
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(
      "https://ghcr.io/token?service=ghcr.io&scope=repository%3Adevcontainers%2Ffeatures%2Fdocker-in-docker%3Apull"
    );
    expect(
      new Headers(fetchImpl.mock.calls[2]?.[1]?.headers).get("accept")
    ).toBe("application/vnd.oci.image.manifest.v1+json");
  });

  it("lists the Features it depends on", async () => {
    const body = manifest({
      dependsOn: { "ghcr.io/devcontainers/features/common-utils:2": {} },
      version: "4.1.3",
    });

    await expect(
      resolveFeature(location, { fetch: fakeRegistry(body) })
    ).resolves.toMatchObject({
      dependsOn: ["ghcr.io/devcontainers/features/common-utils:2"],
    });
  });

  it("refuses a manifest whose reported digest differs", async () => {
    await expect(
      resolveFeature(location, {
        fetch: fakeRegistry(manifest(), {
          "docker-content-digest": "sha256:other",
        }),
      })
    ).rejects.toThrow("reported digest sha256:other");
  });

  it("refuses a manifest without Feature metadata", async () => {
    await expect(
      resolveFeature(location, {
        fetch: fakeRegistry(JSON.stringify({ schemaVersion: 2 })),
      })
    ).rejects.toThrow("carries no Feature metadata");
  });

  it("fails for a tag the registry does not have", async () => {
    await expect(
      resolveFeature({ ...location, tag: "9.9.9" }, { fetch: fakeRegistry() })
    ).rejects.toThrow(
      "ghcr.io answered 404 for ghcr.io/devcontainers/features/docker-in-docker:9.9.9"
    );
  });

  it("tries a server error again", async () => {
    const registry = fakeRegistry();
    let failed = false;
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      if (!failed) {
        failed = true;
        return Promise.resolve(new Response("", { status: 503 }));
      }
      return registry(input, init);
    });

    await expect(
      resolveFeature(location, { fetch: fetchImpl, retryDelay: 0 })
    ).resolves.toMatchObject({ version: "4.1.3" });
  });
});
