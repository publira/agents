import { describe, expect, it } from "vitest";

import { parsePackageSelector } from "./package-selector.ts";

describe(parsePackageSelector, () => {
  it("selects every version of a bare name", () => {
    expect(parsePackageSelector("next")).toStrictEqual({
      name: "next",
      versions: [],
    });
  });

  it("selects every version of a scope pattern", () => {
    expect(parsePackageSelector("@publira/*")).toStrictEqual({
      name: "@publira/*",
      versions: [],
    });
  });

  it("reads the version of a scoped package", () => {
    expect(parsePackageSelector("@next/env@16.3.8")).toStrictEqual({
      name: "@next/env",
      versions: ["16.3.8"],
    });
  });

  it("reads versions joined with ||", () => {
    expect(parsePackageSelector("webpack@4.47.0 || 5.102.1")).toStrictEqual({
      name: "webpack",
      versions: ["4.47.0", "5.102.1"],
    });
  });

  it.each(["", "next@", "next@ || "])("rejects %j", (selector) => {
    expect(() => parsePackageSelector(selector)).toThrow(
      "Invalid package selector"
    );
  });
});
