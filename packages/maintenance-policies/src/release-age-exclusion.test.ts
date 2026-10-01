import { describe, expect, it } from "vitest";

import { evaluateReleaseAgeExclusion } from "./release-age-exclusion.ts";

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
    ).toStrictEqual({ action: "keep" });
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
    ).toStrictEqual({ action: "expired" });
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
