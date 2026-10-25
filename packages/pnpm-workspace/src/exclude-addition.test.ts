import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { addReleaseAgeExclusions } from "./exclude-addition.ts";
import { removeReleaseAgeExclusions } from "./exclude-removal.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/${name}.yaml`, import.meta.url), "utf-8");

const playwright = [
  "@playwright/test@1.64.0",
  "playwright-core@1.64.0",
  "playwright@1.64.0",
];

const comment = [
  "Exempted for #3949 on a maintainer's approval:",
  "https://github.com/publira/publira/pull/3949#issuecomment-123",
];

const added = (source: string) => {
  const addition = addReleaseAgeExclusions(source, playwright, comment);

  if (addition.result !== "edited") {
    throw new Error(`Expected an edit, got: ${addition.reason}`);
  }

  return addition.source;
};

describe(addReleaseAgeExclusions, () => {
  it("adds the entries and their comment at the end of the list", () => {
    const source = fixture("publira");

    expect(added(source)).toBe(
      source.replace(
        "  - next@16.3.8\n",
        [
          "  - next@16.3.8",
          "  # Exempted for #3949 on a maintainer's approval:",
          "  # https://github.com/publira/publira/pull/3949#issuecomment-123",
          '  - "@playwright/test@1.64.0"',
          "  - playwright-core@1.64.0",
          "  - playwright@1.64.0",
          "",
        ].join("\n")
      )
    );
  });

  it("adds what the cleanup removes again, comment and all", () => {
    const source = fixture("publira");
    const removal = removeReleaseAgeExclusions(added(source), playwright);

    expect(removal).toStrictEqual({ result: "edited", source });
  });

  it("follows the list's indentation and line breaks", () => {
    expect(
      added(
        "packages:\r\n- apps/*\r\nminimumReleaseAgeExclude:\r\n- '@publira/*'\r\n# Trailing.\r\nsavePrefix: ''\r\n"
      )
    ).toBe(
      [
        "packages:",
        "- apps/*",
        "minimumReleaseAgeExclude:",
        "- '@publira/*'",
        "# Exempted for #3949 on a maintainer's approval:",
        "# https://github.com/publira/publira/pull/3949#issuecomment-123",
        '- "@playwright/test@1.64.0"',
        "- playwright-core@1.64.0",
        "- playwright@1.64.0",
        "# Trailing.",
        "savePrefix: ''",
        "",
      ].join("\r\n")
    );
  });

  it("adds the key to a file without it", () => {
    expect(added("packages:\n  - apps/*\n")).toBe(
      [
        "packages:",
        "  - apps/*",
        "minimumReleaseAgeExclude:",
        "  # Exempted for #3949 on a maintainer's approval:",
        "  # https://github.com/publira/publira/pull/3949#issuecomment-123",
        '  - "@playwright/test@1.64.0"',
        "  - playwright-core@1.64.0",
        "  - playwright@1.64.0",
        "",
      ].join("\n")
    );
  });

  it("refuses a list written in flow style", () => {
    expect(
      addReleaseAgeExclusions(
        'minimumReleaseAgeExclude: ["@publira/*"]\n',
        playwright,
        comment
      )
    ).toStrictEqual({
      reason: "minimumReleaseAgeExclude is not written as a block list",
      result: "refused",
    });
  });

  it("refuses a list whose entries do not each sit on one line", () => {
    expect(
      addReleaseAgeExclusions(
        "minimumReleaseAgeExclude:\n  - >-\n    @publira/*\n",
        playwright,
        comment
      )
    ).toStrictEqual({
      reason:
        "minimumReleaseAgeExclude has entries that do not each sit on one line",
      result: "refused",
    });
  });

  it("refuses a selector the list already has", () => {
    expect(
      addReleaseAgeExclusions(
        "minimumReleaseAgeExclude:\n  - playwright@1.64.0\n",
        ["playwright@1.64.0"],
        comment
      )
    ).toStrictEqual({
      reason:
        'minimumReleaseAgeExclude should list [], not ["playwright@1.64.0"]',
      result: "refused",
    });
  });
});
