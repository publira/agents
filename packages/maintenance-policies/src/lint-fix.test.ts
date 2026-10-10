import { describe, expect, it } from "vitest";

import { isLintFixRefusedPath, readLintSetup } from "./lint-fix.ts";

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
