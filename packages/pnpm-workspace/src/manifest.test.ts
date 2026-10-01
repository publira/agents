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
    });
  });

  it("applies pnpm's defaults to settings the file leaves out", () => {
    expect(parseWorkspaceManifest("packages:\n  - packages/*\n")).toStrictEqual(
      {
        minimumReleaseAge: DEFAULT_MINIMUM_RELEASE_AGE_MINUTES,
        minimumReleaseAgeExclude: [],
        packages: ["packages/*"],
      }
    );
  });

  it("accepts an empty file", () => {
    expect(parseWorkspaceManifest("")).toStrictEqual({
      minimumReleaseAge: DEFAULT_MINIMUM_RELEASE_AGE_MINUTES,
      minimumReleaseAgeExclude: [],
      packages: [],
    });
  });

  it("rejects a setting of the wrong type", () => {
    expect(() =>
      parseWorkspaceManifest("minimumReleaseAgeExclude: next\n")
    ).toThrow(ZodError);
  });
});
