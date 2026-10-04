import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  DEFAULT_MINIMUM_RELEASE_AGE_MINUTES,
  parseWorkspaceManifest,
} from "./manifest.ts";

describe(parseWorkspaceManifest, () => {
  it("reads the packages and the release age settings", () => {
    const manifest = parseWorkspaceManifest(`
packages:
  - apps/*
  - packages/*
minimumReleaseAge: 4320
minimumReleaseAgeExclude:
  - "@publira/*"
  - next@16.3.8
catalog:
  zod: 4.6.5
`);

    expect(manifest).toStrictEqual({
      minimumReleaseAge: 4320,
      minimumReleaseAgeExclude: ["@publira/*", "next@16.3.8"],
      packages: ["apps/*", "packages/*"],
      registries: {},
      registry: undefined,
    });
  });

  it("applies pnpm's defaults to settings the file leaves out", () => {
    expect(parseWorkspaceManifest("packages:\n  - packages/*\n")).toStrictEqual(
      {
        minimumReleaseAge: DEFAULT_MINIMUM_RELEASE_AGE_MINUTES,
        minimumReleaseAgeExclude: [],
        packages: ["packages/*"],
        registries: {},
        registry: undefined,
      }
    );
  });

  it("accepts an empty file", () => {
    expect(parseWorkspaceManifest("")).toStrictEqual({
      minimumReleaseAge: DEFAULT_MINIMUM_RELEASE_AGE_MINUTES,
      minimumReleaseAgeExclude: [],
      packages: [],
      registries: {},
      registry: undefined,
    });
  });

  it("reads the registry settings", () => {
    expect(
      parseWorkspaceManifest(`
registry: https://registry.example.com/
registries:
  "@buf": https://buf.build/gen/npm/v1
`)
    ).toMatchObject({
      registries: { "@buf": "https://buf.build/gen/npm/v1" },
      registry: "https://registry.example.com/",
    });
  });

  it("rejects a setting of the wrong type", () => {
    expect(() =>
      parseWorkspaceManifest("minimumReleaseAgeExclude: next\n")
    ).toThrow(ZodError);
  });
});
