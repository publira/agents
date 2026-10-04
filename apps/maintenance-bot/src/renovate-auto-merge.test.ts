import { describe, expect, it, vi } from "vitest";

import type { Log } from "./log.ts";
import {
  readRenovateAutoMerge,
  renovateAutoMergeEnabled,
} from "./renovate-auto-merge.ts";

describe(readRenovateAutoMerge, () => {
  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["true", true],
  ])("reads %o as %o", (value, enabled) => {
    expect(readRenovateAutoMerge({ RENOVATE_AUTO_MERGE: value })).toBe(enabled);
  });

  it.each(["1", "TRUE", "yes"])("refuses %o", (value) => {
    expect(() => readRenovateAutoMerge({ RENOVATE_AUTO_MERGE: value })).toThrow(
      "RENOVATE_AUTO_MERGE must be true or false"
    );
  });
});

describe(renovateAutoMergeEnabled, () => {
  it("takes an invalid setting as off, and logs it", () => {
    const log = vi.fn<Log>();

    expect(
      renovateAutoMergeEnabled(log, { RENOVATE_AUTO_MERGE: "on" })
    ).toBeFalsy();
    expect(log).toHaveBeenCalledWith(
      "error",
      "Renovate auto-merge is off: its setting is invalid",
      { error: "RENOVATE_AUTO_MERGE must be true or false" }
    );
  });
});
