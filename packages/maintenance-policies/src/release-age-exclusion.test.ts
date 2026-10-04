import { describe, expect, it } from "vitest";

import {
  evaluateReleaseAgeExclusion,
  findReleaseAgeExclusionKeepReason,
} from "./release-age-exclusion.ts";

const ONE_DAY = 1440;

const publishTimes = new Map([
  ["16.3.7", new Date("2026-09-20T10:00:00.000Z")],
  ["16.3.8", new Date("2026-09-30T08:00:00.000Z")],
]);

describe(evaluateReleaseAgeExclusion, () => {
  it("keeps an entry that exempts every version", () => {
    expect(
      evaluateReleaseAgeExclusion({
        minimumReleaseAge: ONE_DAY,
        now: new Date("2026-10-10T00:00:00.000Z"),
        publishTimes,
        versions: [],
      })
    ).toStrictEqual({ action: "keep", reason: "unpinned" });
  });

  it("waits while a pinned version is inside the window", () => {
    expect(
      evaluateReleaseAgeExclusion({
        minimumReleaseAge: ONE_DAY,
        now: new Date("2026-09-30T20:00:00.000Z"),
        publishTimes,
        versions: ["16.3.7", "16.3.8"],
      })
    ).toStrictEqual({
      action: "waiting",
      availableAt: new Date("2026-10-01T08:00:00.000Z"),
    });
  });

  it("expires an entry once the newest pinned version leaves the window", () => {
    expect(
      evaluateReleaseAgeExclusion({
        minimumReleaseAge: ONE_DAY,
        now: new Date("2026-10-01T08:00:00.000Z"),
        publishTimes,
        versions: ["16.3.7", "16.3.8"],
      })
    ).toStrictEqual({
      action: "expired",
      availableAt: new Date("2026-10-01T08:00:00.000Z"),
    });
  });

  it("cannot judge a version the registry does not list", () => {
    expect(
      evaluateReleaseAgeExclusion({
        minimumReleaseAge: ONE_DAY,
        now: new Date("2026-10-10T00:00:00.000Z"),
        publishTimes,
        versions: ["16.3.8", "16.3.9"],
      })
    ).toStrictEqual({ action: "unknown", missingVersions: ["16.3.9"] });
  });
});

const PUBLIC_NPM = "https://registry.npmjs.org/";

describe(findReleaseAgeExclusionKeepReason, () => {
  it.each([
    ["next", ["16.3.8"]],
    ["@next/env", ["16.3.8"]],
    ["webpack", ["4.47.0", "5.102.1"]],
    ["@buf/sdk", ["2.13.0-20260414192239-c17df5b2beca.1"]],
  ])("judges %s@%j", (name, versions) => {
    expect(
      findReleaseAgeExclusionKeepReason({
        name,
        registryUrl: PUBLIC_NPM,
        versions,
      })
    ).toBeUndefined();
  });

  it.each([
    ["@publira/*", []],
    ["next", []],
    ["@next/*", ["16.3.8"]],
    ["next", ["^16.3.0"]],
    ["next", ["16.3"]],
    ["next", ["latest"]],
    ["webpack", ["5.102.1", "5.x"]],
  ])("keeps %s@%j as unpinned", (name, versions) => {
    expect(
      findReleaseAgeExclusionKeepReason({
        name,
        registryUrl: PUBLIC_NPM,
        versions,
      })
    ).toBe("unpinned");
  });

  it.each([
    "https://buf.build/gen/npm/v1",
    "https://npm.jsr.io/",
    "http://registry.npmjs.org/",
    // An environment variable pnpm would substitute.
    `\${NPM_REGISTRY}`,
  ])("keeps a package from %s", (registryUrl) => {
    expect(
      findReleaseAgeExclusionKeepReason({
        name: "@buf/sdk",
        registryUrl,
        versions: ["1.0.0"],
      })
    ).toBe("other-registry");
  });

  it("accepts the public registry without its trailing slash", () => {
    expect(
      findReleaseAgeExclusionKeepReason({
        name: "next",
        registryUrl: "https://registry.npmjs.org",
        versions: ["16.3.8"],
      })
    ).toBeUndefined();
  });
});
