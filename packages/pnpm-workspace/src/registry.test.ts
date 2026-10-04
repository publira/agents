import { describe, expect, it } from "vitest";

import { PUBLIC_NPM_REGISTRY_URL, resolvePackageRegistry } from "./registry.ts";

const noManifestSettings = { registries: {}, registry: undefined };

describe(resolvePackageRegistry, () => {
  it("defaults to the public npm registry", () => {
    expect(
      resolvePackageRegistry("next", { manifest: noManifestSettings })
    ).toBe(PUBLIC_NPM_REGISTRY_URL);
  });

  it("reads a scope's registry from .npmrc", () => {
    const settings = {
      manifest: noManifestSettings,
      npmrc: "# Generated SDKs\n@buf:registry=https://buf.build/gen/npm/v1\n",
    };

    expect(
      resolvePackageRegistry("@buf/googleapis_googleapis.bufbuild_es", settings)
    ).toBe("https://buf.build/gen/npm/v1");
    expect(resolvePackageRegistry("@next/env", settings)).toBe(
      PUBLIC_NPM_REGISTRY_URL
    );
  });

  it("reads the default registry from .npmrc", () => {
    expect(
      resolvePackageRegistry("next", {
        manifest: noManifestSettings,
        npmrc: 'registry = "https://registry.example.com/"\n',
      })
    ).toBe("https://registry.example.com/");
  });

  it("prefers the workspace manifest's settings", () => {
    const settings = {
      manifest: {
        registries: { "@buf": "https://buf.example.com/" },
        registry: "https://registry.example.com/",
      },
      npmrc:
        "@buf:registry=https://buf.build/gen/npm/v1\nregistry=https://npmrc.example.com/\n",
    };

    expect(resolvePackageRegistry("@buf/sdk", settings)).toBe(
      "https://buf.example.com/"
    );
    expect(resolvePackageRegistry("next", settings)).toBe(
      "https://registry.example.com/"
    );
  });

  it("reads registries.default", () => {
    expect(
      resolvePackageRegistry("next", {
        manifest: {
          registries: { default: "https://registry.example.com/" },
          registry: undefined,
        },
      })
    ).toBe("https://registry.example.com/");
  });

  it("knows the scope pnpm sends to JSR", () => {
    expect(
      resolvePackageRegistry("@jsr/std__path", { manifest: noManifestSettings })
    ).toBe("https://npm.jsr.io/");
  });
});
