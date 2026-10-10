import { describe, expect, it } from "vitest";

import {
  parseAddedLines,
  parseCatFileBatch,
  parseRawDiff,
  parseStagedFiles,
} from "./git-output.ts";

const sha = (digit: string) => digit.repeat(40);
const zero = sha("0");

describe(parseRawDiff, () => {
  it("reads added, changed, and deleted paths with their modes", () => {
    const output = [
      `:000000 100755 ${zero} ${sha("a")} A`,
      ".agents/skills/canvas/render.sh",
      `:100644 100644 ${sha("b")} ${sha("c")} M`,
      "skills-lock.json",
      `:120000 000000 ${sha("d")} ${zero} D`,
      ".claude/skills/old skill",
      "",
    ].join("\0");

    expect(parseRawDiff(output)).toStrictEqual([
      {
        after: { mode: "100755", sha: sha("a") },
        before: undefined,
        path: ".agents/skills/canvas/render.sh",
      },
      {
        after: { mode: "100644", sha: sha("c") },
        before: { mode: "100644", sha: sha("b") },
        path: "skills-lock.json",
      },
      {
        after: undefined,
        before: { mode: "120000", sha: sha("d") },
        path: ".claude/skills/old skill",
      },
    ]);
  });

  it("reads no output as no change", () => {
    expect(parseRawDiff("")).toStrictEqual([]);
  });

  it("refuses a mode that is not a file's", () => {
    expect(() =>
      parseRawDiff(`:000000 160000 ${zero} ${sha("e")} A\0vendor/lib\0`)
    ).toThrow("vendor/lib has mode 160000");
  });
});

describe(parseStagedFiles, () => {
  it("reads each file's mode and blob, and leaves out submodules", () => {
    const output = [
      `100644 ${sha("a")} 0\tskills-lock.json`,
      `120000 ${sha("b")} 0\t.claude/skills/ultracite`,
      `160000 ${sha("c")} 0\tvendor/lib`,
      "",
    ].join("\0");

    expect(parseStagedFiles(output)).toStrictEqual(
      new Map([
        ["skills-lock.json", { mode: "100644", sha: sha("a") }],
        [".claude/skills/ultracite", { mode: "120000", sha: sha("b") }],
      ])
    );
  });

  it("refuses an unmerged path", () => {
    expect(() =>
      parseStagedFiles(`100644 ${sha("a")} 2\tskills-lock.json\0`)
    ).toThrow("Unexpected git ls-files output");
  });
});

describe(parseAddedLines, () => {
  it("reads the added lines with their paths and line numbers", () => {
    const output = [
      "diff --git a/src/index.ts b/src/index.ts",
      "index 1111111..2222222 100644",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -2 +2,2 @@ export const read = () => {",
      "-  debugger;",
      "+  return 1;",
      "+++counter;",
      "@@ -9,0 +11 @@",
      "+// eslint-disable-next-line",
      "\\ No newline at end of file",
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export {};",
      'diff --git "a/docs/tab\\there.md" "b/docs/tab\\there.md"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/docs/tab\\there.md"',
      "@@ -0,0 +1 @@",
      "+# Notes",
      "",
    ].join("\n");

    expect(parseAddedLines(output)).toStrictEqual([
      { lineNumber: 2, path: "src/index.ts", text: "  return 1;" },
      { lineNumber: 3, path: "src/index.ts", text: "++counter;" },
      {
        lineNumber: 11,
        path: "src/index.ts",
        text: "// eslint-disable-next-line",
      },
      { lineNumber: 1, path: "docs/tab\there.md", text: "# Notes" },
    ]);
  });

  it("reads no lines from an empty diff", () => {
    expect(parseAddedLines("")).toStrictEqual([]);
  });
});

describe(parseCatFileBatch, () => {
  it("reads each object's bytes, binary ones included", () => {
    const binary = Buffer.from([0x00, 0xff, 0x0a, 0x0a]);
    const output = Buffer.concat([
      Buffer.from(`${sha("a")} blob 4\n`),
      binary,
      Buffer.from(`\n${sha("b")} blob 6\nskills\n`),
    ]);

    expect(parseCatFileBatch(output)).toStrictEqual(
      new Map([
        [sha("a"), binary],
        [sha("b"), Buffer.from("skills")],
      ])
    );
  });

  it("refuses a missing object", () => {
    expect(() =>
      parseCatFileBatch(Buffer.from(`${sha("a")} missing\n`))
    ).toThrow("Unexpected git cat-file output");
  });

  it("refuses output cut short", () => {
    expect(() =>
      parseCatFileBatch(Buffer.from(`${sha("a")} blob 10\nshort\n`))
    ).toThrow("cut");
  });
});
