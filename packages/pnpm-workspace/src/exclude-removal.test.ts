import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  deleteBlockLines,
  removeReleaseAgeExclusions,
  verifyReleaseAgeExclusionRemoval,
} from "./exclude-removal.ts";

// pnpm-workspace.yaml as publira/publira#3408, publira/website#113, and
// publira/comic-viewer#318 left it.
const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/${name}.yaml`, import.meta.url), "utf-8");

const nextRelease = [
  "@next/env@16.3.8",
  "@next/swc-darwin-arm64@16.3.8",
  "@next/swc-darwin-x64@16.3.8",
  "@next/swc-linux-arm64-gnu@16.3.8",
  "@next/swc-linux-arm64-musl@16.3.8",
  "@next/swc-linux-x64-gnu@16.3.8",
  "@next/swc-linux-x64-musl@16.3.8",
  "@next/swc-win32-arm64-msvc@16.3.8",
  "@next/swc-win32-x64-msvc@16.3.8",
  "next@16.3.8",
];

const edited = (source: string, selectors: readonly string[]) => {
  const removal = removeReleaseAgeExclusions(source, selectors);
  if (removal.result !== "edited") {
    throw new Error(`Expected an edit, got: ${removal.reason}`);
  }
  expect(
    verifyReleaseAgeExclusionRemoval(source, removal.source, selectors)
  ).toStrictEqual([]);
  return removal.source;
};

describe(removeReleaseAgeExclusions, () => {
  it("removes the Next.js block of publira/publira with its comment", () => {
    const source = fixture("publira");

    expect(edited(source, nextRelease)).toBe(
      source.replace(
        / {2}# 16\.3\.8 is the September 2026[\s\S]*? {2}- next@16\.3\.8\n/u,
        ""
      )
    );
    expect(edited(source, nextRelease))
      .toContain(`# These packages come from this organization, so there is no reason to wait out
# the window that guards against a freshly published release.
minimumReleaseAgeExclude:
  - "@publira/*"
# Swallows the deferred error`);
  });

  it("removes the Next.js block of publira/website with its comment", () => {
    expect(edited(fixture("website"), [...nextRelease, "@next/mdx@16.3.8"]))
      .toBe(`allowBuilds:
  "@parcel/watcher": false
  "@swc/core": false
  lefthook: true
  unrs-resolver: true
minimumReleaseAgeExclude:
  - "@publira/*"
`);
  });

  it("removes the Next.js block of publira/comic-viewer with its comment", () => {
    expect(edited(fixture("comic-viewer"), nextRelease)).toBe(`packages:
  - apps/*
  - e2e
  - packages/*

allowBuilds:
  sharp: true

minimumReleaseAgeExclude:
  - "@publira/*"
`);
  });

  it("removes uncommented entries one by one", () => {
    const source = `minimumReleaseAgeExclude:
  - "@publira/*"
  - next@16.3.8 # temporary
  - webpack@5.102.1
`;

    expect(edited(source, ["next@16.3.8"])).toBe(`minimumReleaseAgeExclude:
  - "@publira/*"
  - webpack@5.102.1
`);
  });

  it("keeps the comments of the entries that stay", () => {
    const source = `minimumReleaseAgeExclude:
  # Published by this organization.
  - "@publira/*"

  # The security release; drop it once it is a day old.
  - next@16.3.8

  # Pinned until the fix ships.
  - webpack@5.102.1
`;

    expect(edited(source, ["next@16.3.8"])).toBe(`minimumReleaseAgeExclude:
  # Published by this organization.
  - "@publira/*"

  # Pinned until the fix ships.
  - webpack@5.102.1
`);
  });

  it("reads a list that is not indented", () => {
    const source = `minimumReleaseAgeExclude:
- "@publira/*"
# Temporary.
- next@16.3.8
`;

    expect(edited(source, ["next@16.3.8"])).toBe(`minimumReleaseAgeExclude:
- "@publira/*"
`);
  });

  it("keeps Windows line endings", () => {
    const source =
      'minimumReleaseAgeExclude:\r\n  - "@publira/*"\r\n  - next@16.3.8\r\n';

    expect(edited(source, ["next@16.3.8"])).toBe(
      'minimumReleaseAgeExclude:\r\n  - "@publira/*"\r\n'
    );
  });

  it("leaves a commented group that only partly expires to a reader", () => {
    const source = `minimumReleaseAgeExclude:
  - "@publira/*"
  # Next.js 16.3.8 and the webpack fix it needs.
  - next@16.3.8
  - webpack@5.102.1
`;

    expect(removeReleaseAgeExclusions(source, ["next@16.3.8"])).toStrictEqual({
      block: { lines: source.split("\n").slice(0, 5), start: 0 },
      reason:
        "a comment describes entries of which only some are removed: line 3",
      result: "ambiguous",
    });
  });

  it("leaves a comment below a removed group to a reader", () => {
    const source = `minimumReleaseAgeExclude:
  - "@publira/*"
  - next@16.3.8
  # Remove next once 16.3.8 is a day old.

patchedDependencies: {}
`;

    expect(removeReleaseAgeExclusions(source, ["next@16.3.8"])).toMatchObject({
      block: { start: 0 },
      reason: "a comment follows entries that are removed: line 4",
      result: "ambiguous",
    });
  });

  it("leaves an emptied list to a reader, with the comments above it", () => {
    const source = `packages: []
# Temporary exemptions.
minimumReleaseAgeExclude:
  - next@16.3.8
`;

    expect(removeReleaseAgeExclusions(source, ["next@16.3.8"])).toStrictEqual({
      block: {
        lines: [
          "# Temporary exemptions.",
          "minimumReleaseAgeExclude:",
          "  - next@16.3.8",
        ],
        start: 1,
      },
      reason: "removing every entry leaves minimumReleaseAgeExclude empty",
      result: "ambiguous",
    });
  });

  it("leaves a flow list to a reader", () => {
    expect(
      removeReleaseAgeExclusions(
        'minimumReleaseAgeExclude: ["@publira/*", next@16.3.8]\n',
        ["next@16.3.8"]
      )
    ).toMatchObject({
      reason: "minimumReleaseAgeExclude is not written as a block list",
      result: "ambiguous",
    });
  });

  it("leaves an entry that spans lines to a reader", () => {
    expect(
      removeReleaseAgeExclusions(
        'minimumReleaseAgeExclude:\n  - "@publira/*"\n  - >-\n    next@16.3.8\n',
        ["next@16.3.8"]
      )
    ).toMatchObject({ result: "ambiguous" });
  });

  it("fails without the key", () => {
    expect(() => removeReleaseAgeExclusions("packages: []\n", [])).toThrow(
      "no top-level minimumReleaseAgeExclude key"
    );
  });
});

describe(deleteBlockLines, () => {
  it("deletes lines by their number in the block", () => {
    const source = "packages: []\nminimumReleaseAgeExclude:\n  - a\n  - b\n";
    const block = {
      lines: ["minimumReleaseAgeExclude:", "  - a", "  - b"],
      start: 1,
    };

    expect(deleteBlockLines(source, block, [2])).toBe(
      "packages: []\nminimumReleaseAgeExclude:\n  - b\n"
    );
  });

  it.each([0, 4, 1.5])("rejects line %d", (lineNumber) => {
    expect(() =>
      deleteBlockLines("a\nb\nc\n", { lines: ["a", "b", "c"], start: 0 }, [
        lineNumber,
      ])
    ).toThrow("outside the 3 lines");
  });
});

describe(verifyReleaseAgeExclusionRemoval, () => {
  const before = `minimumReleaseAge: 4320
minimumReleaseAgeExclude:
  - "@publira/*"
  - next@16.3.8
catalog:
  next: 16.3.8
`;

  it("accepts the edit", () => {
    expect(
      verifyReleaseAgeExclusionRemoval(
        before,
        before.replace("  - next@16.3.8\n", ""),
        ["next@16.3.8"]
      )
    ).toStrictEqual([]);
  });

  it("accepts an emptied list that is gone", () => {
    expect(
      verifyReleaseAgeExclusionRemoval(
        "minimumReleaseAgeExclude:\n  - next@16.3.8\n",
        "",
        ["next@16.3.8"]
      )
    ).toStrictEqual([]);
  });

  it("rejects YAML that does not parse", () => {
    expect(
      verifyReleaseAgeExclusionRemoval(before, "catalog: [\n", ["next@16.3.8"])
    ).toStrictEqual([expect.stringContaining("not valid YAML")]);
  });

  it("rejects an entry left behind", () => {
    expect(
      verifyReleaseAgeExclusionRemoval(before, before, ["next@16.3.8"])
    ).toStrictEqual([
      'minimumReleaseAgeExclude should list ["@publira/*"], not ["@publira/*","next@16.3.8"]',
    ]);
  });

  it("rejects another entry removed", () => {
    expect(
      verifyReleaseAgeExclusionRemoval(
        before,
        before.replace('  - "@publira/*"\n  - next@16.3.8\n', ""),
        ["next@16.3.8"]
      )
    ).toStrictEqual([
      'minimumReleaseAgeExclude should list ["@publira/*"], not []',
    ]);
  });

  it("rejects a change to another setting", () => {
    expect(
      verifyReleaseAgeExclusionRemoval(
        before,
        before
          .replace("  - next@16.3.8\n", "")
          .replace("minimumReleaseAge: 4320\n", ""),
        ["next@16.3.8"]
      )
    ).toStrictEqual(["minimumReleaseAge changed"]);
  });

  it("rejects an entry that was never listed", () => {
    expect(
      verifyReleaseAgeExclusionRemoval(before, before, ["webpack@5.102.1"])
    ).toStrictEqual(["webpack@5.102.1 is not in minimumReleaseAgeExclude"]);
  });
});
