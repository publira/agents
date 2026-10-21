import { describe, expect, it } from "vitest";

import {
  applyHunks,
  parsePatch,
  readApplyPatchCommand,
} from "./apply-patch.ts";

const patch = (...lines: string[]) =>
  ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

const source = [
  "const lockFilesOf = (changedFiles: readonly string[]) =>",
  "  new Set(",
  "    changedFiles",
  "      .filter(isDevContainerConfigPath)",
  "      .map(devContainerLockFilePathOf)",
  "  );",
  "",
].join("\n");

const apply = (content: string, text: string) => {
  const [file] = parsePatch(text);

  return applyHunks(content, file?.hunks ?? []);
};

describe(parsePatch, () => {
  it("reads the hunks of each file", () => {
    expect(
      parsePatch(
        patch(
          "*** Update File: a.ts",
          "@@ const a = () =>",
          " stays",
          "-removed",
          "+added",
          "*** Update File: b.ts",
          "-old",
          "+new",
          "*** End of File"
        )
      )
    ).toStrictEqual([
      {
        hunks: [
          {
            anchor: "const a = () =>",
            endOfFile: false,
            newLines: ["stays", "added"],
            oldLines: ["stays", "removed"],
          },
        ],
        path: "a.ts",
      },
      {
        hunks: [
          {
            anchor: undefined,
            endOfFile: true,
            newLines: ["new"],
            oldLines: ["old"],
          },
        ],
        path: "b.ts",
      },
    ]);
  });

  it("reads an empty line in a hunk as an empty line that stays", () => {
    const [file] = parsePatch(
      patch("*** Update File: a.ts", "@@", "-a", "", "+b")
    );

    expect(file?.hunks[0]).toMatchObject({
      newLines: ["", "b"],
      oldLines: ["a", ""],
    });
  });

  it("reads one patch per file, one after the other", () => {
    const text = [
      patch("*** Update File: a.ts", "-a", "+b"),
      patch("*** Update File: b.ts", "-a", "+b"),
    ].join("\n");

    expect(parsePatch(text).map(({ path }) => path)).toStrictEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("keeps two updates of one file apart", () => {
    const updates = parsePatch(
      patch(
        "*** Update File: a.ts",
        "-x",
        "+y",
        "*** Update File: a.ts",
        "-y",
        "+z"
      )
    );

    expect(
      updates.map(({ path, hunks }) => [path, hunks.length])
    ).toStrictEqual([
      ["a.ts", 1],
      ["a.ts", 1],
    ]);
  });

  it.each([
    ["*** Add File: a.ts", "adds a file"],
    ["*** Delete File: a.ts", "deletes a file"],
    ["*** Move to: b.ts", "renames a file"],
  ])("refuses a patch with %s", (line, reason) => {
    expect(() =>
      parsePatch(patch("*** Update File: a.ts", line, "-a", "+b"))
    ).toThrow(reason);
  });

  it.each([
    ["without its markers", "*** Update File: a.ts\n-a\n+b"],
    ["without a file", patch("-a", "+b")],
    ["with a line of no kind", patch("*** Update File: a.ts", "*a")],
    ["that changes nothing", patch("*** Update File: a.ts", " a")],
    ["that updates no file", patch()],
  ])("refuses a patch %s", (_, text) => {
    expect(() => parsePatch(text)).toThrow(Error);
  });
});

describe(applyHunks, () => {
  it("replaces the lines a hunk matches", () => {
    expect(
      apply(
        source,
        patch(
          "*** Update File: a.ts",
          "@@",
          "   new Set(",
          "-    changedFiles",
          "-      .filter(isDevContainerConfigPath)",
          "-      .map(devContainerLockFilePathOf)",
          "+    changedFiles.flatMap((file) =>",
          "+      isDevContainerConfigPath(file) ? [devContainerLockFilePathOf(file)] : []",
          "+    )",
          "   );"
        )
      )
    ).toBe(
      [
        "const lockFilesOf = (changedFiles: readonly string[]) =>",
        "  new Set(",
        "    changedFiles.flatMap((file) =>",
        "      isDevContainerConfigPath(file) ? [devContainerLockFilePathOf(file)] : []",
        "    )",
        "  );",
        "",
      ].join("\n")
    );
  });

  it("matches lines whose indentation the hunk gets wrong", () => {
    expect(
      apply(
        "a\n    b\nc\n",
        patch("*** Update File: a.ts", " a", "-  b", "+  d", " c")
      )
    ).toBe("a\n  d\nc\n");
  });

  it("looks for a hunk after the line its anchor names", () => {
    expect(
      apply(
        "const a = 1;\nx\nconst b = 2;\nx\n",
        patch("*** Update File: a.ts", "@@ const b = 2;", "-x", "+y")
      )
    ).toBe("const a = 1;\nx\nconst b = 2;\ny\n");
  });

  it("looks for each hunk after the one before it", () => {
    expect(
      apply(
        "x\nx\n",
        patch("*** Update File: a.ts", "@@", "-x", "+y", "@@", "-x", "+z")
      )
    ).toBe("y\nz\n");
  });

  it("matches a hunk that ends the file at the end only", () => {
    expect(
      apply(
        "x\ny\nx\n",
        patch("*** Update File: a.ts", "-x", "+z", "*** End of File")
      )
    ).toBe("x\ny\nz\n");
  });

  it("adds lines after the anchor, or at the end without one", () => {
    expect(apply("a\nb\n", patch("*** Update File: a.ts", "@@ a", "+c"))).toBe(
      "a\nc\nb\n"
    );
    expect(apply("a\nb\n", patch("*** Update File: a.ts", "+c"))).toBe(
      "a\nb\nc\n"
    );
  });

  it("keeps a file without a newline at its end so", () => {
    expect(apply("a\nb", patch("*** Update File: a.ts", "-b", "+c"))).toBe(
      "a\nc"
    );
  });

  it("throws when a hunk does not match", () => {
    expect(() =>
      apply(source, patch("*** Update File: a.ts", "-  .reduce()", "+  x"))
    ).toThrow("Cannot find these lines:\n    .reduce()");
  });

  it("throws when the anchor is not in the file", () => {
    expect(() =>
      apply(source, patch("*** Update File: a.ts", "@@ const b", "-a", "+b"))
    ).toThrow('Cannot find the line of "@@ const b"');
  });
});

describe(readApplyPatchCommand, () => {
  const body = patch("*** Update File: a.ts", "-a", "+b");

  it("reads the patch of a here-document", () => {
    expect(
      readApplyPatchCommand(`apply_patch <<'PATCH'\n${body}\nPATCH`)
    ).toStrictEqual({ directory: undefined, patch: body });
    expect(
      readApplyPatchCommand(`apply_patch <<EOF\n${body}\nEOF\n`)
    ).toStrictEqual({ directory: undefined, patch: body });
  });

  it("reads the directory it changes to first", () => {
    expect(
      readApplyPatchCommand(
        `cd "/tmp/repository" && apply_patch <<"PATCH"\n${body}\nPATCH`
      )
    ).toStrictEqual({ directory: "/tmp/repository", patch: body });
  });

  it.each([
    ["another command", "pnpm exec ultracite check"],
    ["a patch for GNU patch", `patch -p1 <<'PATCH'\n${body}\nPATCH`],
    [
      "more after the here-document",
      `apply_patch <<'PATCH'\n${body}\nPATCH\npnpm exec ultracite check`,
    ],
    ["a here-document left open", `apply_patch <<'PATCH'\n${body}`],
  ])("reads nothing from %s", (_, command) => {
    expect(readApplyPatchCommand(command)).toBeUndefined();
  });
});
