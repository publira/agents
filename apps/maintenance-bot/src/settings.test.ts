import { describe, expect, it, vi } from "vitest";

import type { Log } from "./log.ts";
import { readSettings } from "./settings.ts";

describe(readSettings, () => {
  it("writes, but does not auto-merge, by default", () => {
    const log = vi.fn<Log>();

    expect(readSettings(log, {})).toStrictEqual({
      dryRun: false,
      renovateAutoMerge: false,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("reads an empty variable as unset", () => {
    expect(
      readSettings(vi.fn<Log>(), {
        DRY_RUN: "",
        RENOVATE_AUTO_MERGE: "",
      })
    ).toStrictEqual(readSettings(vi.fn<Log>(), {}));
  });

  it("reads true and false", () => {
    expect(
      readSettings(vi.fn<Log>(), {
        DRY_RUN: "true",
        RENOVATE_AUTO_MERGE: "true",
      })
    ).toStrictEqual({
      dryRun: true,
      renovateAutoMerge: true,
    });
  });

  it.each(["1", "TRUE", "yes", "on"])(
    "takes the safe side of %o, and logs it",
    (value) => {
      const log = vi.fn<Log>();

      expect(
        readSettings(log, {
          DRY_RUN: value,
          RENOVATE_AUTO_MERGE: value,
        })
      ).toStrictEqual({
        dryRun: true,
        renovateAutoMerge: false,
      });
      expect(log).toHaveBeenCalledWith(
        "error",
        "Setting is invalid; using the safe value",
        { setting: "DRY_RUN", value: true }
      );
      expect(log).toHaveBeenCalledWith(
        "error",
        "Setting is invalid; using the safe value",
        { setting: "RENOVATE_AUTO_MERGE", value: false }
      );
      expect(log).toHaveBeenCalledTimes(2);
    }
  );
});
