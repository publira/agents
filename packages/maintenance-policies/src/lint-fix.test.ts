import { describe, expect, it } from "vitest";

import {
  evaluateLintFindingsFix,
  isLintFindingsFixRefusedPath,
  isLintFixRefusedPath,
  readLintSetup,
} from "./lint-fix.ts";

interface Manifest {
  dependencies?: Readonly<Record<string, string>>;
  devDependencies?: Readonly<Record<string, string>>;
  packageManager?: string;
}

const manifest = (fields: Manifest) =>
  JSON.stringify({ name: "repository", private: true, ...fields });

describe(readLintSetup, () => {
  it.each([
    ["pnpm", "pnpm@12.10.1"],
    ["pnpm", "pnpm@12.10.1+sha512.abcdef"],
    ["npm", "npm@12.2.0"],
  ] as const)("reads %s from %s", (packageManager, field) => {
    expect(
      readLintSetup(
        manifest({
          devDependencies: { ultracite: "7.12.4" },
          packageManager: field,
        })
      )
    ).toStrictEqual({ packageManager, result: "ultracite" });
  });

  it("reads ultracite from the dependencies too", () => {
    expect(
      readLintSetup(
        manifest({
          dependencies: { ultracite: "7.12.4" },
          packageManager: "pnpm@12.10.1",
        })
      )
    ).toStrictEqual({ packageManager: "pnpm", result: "ultracite" });
  });

  it.each([
    ["the root package.json is not JSON", "{"],
    ["the root package.json is not a package manifest", "[]"],
    [
      "the root package.json does not depend on ultracite",
      manifest({
        devDependencies: { oxlint: "1.87.0" },
        packageManager: "pnpm@12.10.1",
      }),
    ],
    [
      "the root package.json names no packageManager",
      manifest({ devDependencies: { ultracite: "7.12.4" } }),
    ],
    [
      "packageManager names yarn@4.9.0, neither pnpm nor npm",
      manifest({
        devDependencies: { ultracite: "7.12.4" },
        packageManager: "yarn@4.9.0",
      }),
    ],
  ])("skips when %s", (reason, source) => {
    expect(readLintSetup(source)).toStrictEqual({ reason, result: "skipped" });
  });
});

describe(isLintFixRefusedPath, () => {
  it.each([
    "pnpm-lock.yaml",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "package.json",
    "packages/github/package.json",
    "apps/web/pnpm-lock.yaml",
    ".github/renovate.json5",
    ".github/workflows/ci.yml",
  ])("refuses %s", (path) => {
    expect(isLintFixRefusedPath(path)).toBeTruthy();
  });

  it.each([
    "README.md",
    "packages/github/src/index.ts",
    "pnpm-workspace.yaml",
    "docs/.github/notes.md",
    "my-package.json",
  ])("allows %s", (path) => {
    expect(isLintFixRefusedPath(path)).toBeFalsy();
  });
});

describe(isLintFindingsFixRefusedPath, () => {
  it.each([
    "pnpm-lock.yaml",
    "packages/github/package.json",
    ".github/workflows/ci.yml",
    "oxlint.config.ts",
    "oxfmt.config.ts",
    "packages/web/.oxlintrc.json",
    ".oxfmtrc.jsonc",
    ".prettierignore",
  ])("refuses %s", (path) => {
    expect(isLintFindingsFixRefusedPath(path)).toBeTruthy();
  });

  it.each([
    "README.md",
    "src/oxlint.ts",
    "docs/oxlint.config.md.txt.bak/notes.md",
    ".prettierrc",
  ])("allows %s", (path) => {
    expect(isLintFindingsFixRefusedPath(path)).toBeFalsy();
  });
});

describe(evaluateLintFindingsFix, () => {
  const fix = {
    addedLines: [
      { lineNumber: 2, path: "src/index.ts", text: "  return value;" },
    ],
    checkPassed: true,
    paths: ["src/index.ts"],
  };

  it("accepts a fix that passes the check", () => {
    expect(evaluateLintFindingsFix(fix)).toStrictEqual({ result: "accepted" });
  });

  it.each([
    "// eslint-disable-next-line no-debugger",
    "/* oxlint-disable */",
    "// oxfmt-ignore",
    "<!-- prettier-ignore -->",
    "// biome-ignore lint: later",
    "// @ts-ignore",
    "// @ts-expect-error",
    "// @ts-nocheck",
  ])("refuses a fix that adds %s", (text) => {
    const suppression = { lineNumber: 1, path: "src/index.ts", text };
    expect(
      evaluateLintFindingsFix({
        ...fix,
        addedLines: [...fix.addedLines, suppression],
      })
    ).toStrictEqual({
      reason: "the model added comments that turn findings off",
      refusedPaths: [],
      result: "refused",
      suppressions: [suppression],
    });
  });

  it("refuses a fix that changes the lint configuration", () => {
    expect(
      evaluateLintFindingsFix({
        ...fix,
        paths: [...fix.paths, "oxlint.config.ts"],
      })
    ).toStrictEqual({
      reason:
        "the model changed a lock file, a package.json, a file under .github, or the lint configuration",
      refusedPaths: ["oxlint.config.ts"],
      result: "refused",
      suppressions: [],
    });
  });

  it("refuses a fix after which the check fails", () => {
    expect(
      evaluateLintFindingsFix({ ...fix, checkPassed: false })
    ).toMatchObject({
      reason: "`ultracite check` still fails after the model's changes",
      result: "refused",
    });
  });

  it("refuses a fix that changes nothing", () => {
    expect(
      evaluateLintFindingsFix({ addedLines: [], checkPassed: true, paths: [] })
    ).toMatchObject({ reason: "the model changed nothing", result: "refused" });
  });
});
