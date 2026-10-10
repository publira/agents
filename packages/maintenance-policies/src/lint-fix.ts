import { z } from "zod";

/** The subject of the bot's commit of the automatic lint fixes. */
export const LINT_FIX_COMMIT_SUBJECT =
  "chore(lint): apply automatic fixes for the updated lint tools";

/** The package managers whose commands the bot runs the lint tools with. */
export type LintPackageManager = "npm" | "pnpm";

const isLintPackageManager = (
  name: string | undefined
): name is LintPackageManager => name === "npm" || name === "pnpm";

// The linter whose `check` and `fix` the bot runs.
const ULTRACITE = "ultracite";

const packageJson = z.looseObject({
  dependencies: z.record(z.string(), z.unknown()).optional(),
  devDependencies: z.record(z.string(), z.unknown()).optional(),
  packageManager: z.string().optional(),
});

export type LintSetupVerdict =
  | { result: "ultracite"; packageManager: LintPackageManager }
  | { result: "skipped"; reason: string };

/**
 * Reads how a repository lints from its root `package.json`: whether it
 * depends on ultracite, and which package manager `packageManager` names,
 * which installs it and runs it.
 */
export const readLintSetup = (source: string): LintSetupVerdict => {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { reason: "the root package.json is not JSON", result: "skipped" };
  }

  const parsed = packageJson.safeParse(value);
  if (!parsed.success) {
    return {
      reason: "the root package.json is not a package manifest",
      result: "skipped",
    };
  }

  const {
    dependencies = {},
    devDependencies = {},
    packageManager,
  } = parsed.data;
  if (!(ULTRACITE in dependencies || ULTRACITE in devDependencies)) {
    return {
      reason: "the root package.json does not depend on ultracite",
      result: "skipped",
    };
  }

  const name = packageManager?.split("@", 1)[0];
  if (!isLintPackageManager(name)) {
    return {
      reason:
        packageManager === undefined
          ? "the root package.json names no packageManager"
          : `packageManager names ${packageManager}, neither pnpm nor npm`,
      result: "skipped",
    };
  }

  return { packageManager: name, result: "ultracite" };
};

// The files a lint fix has no reason to change, by name in any directory.
const REFUSED_FILE_NAMES = new Set([
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
]);

const GITHUB_DIRECTORY = ".github/";

/**
 * Whether a lint fix may not change a path: a lock file, a `package.json`,
 * or anything under `.github/`.
 */
export const isLintFixRefusedPath = (path: string): boolean =>
  path.startsWith(GITHUB_DIRECTORY) ||
  REFUSED_FILE_NAMES.has(path.slice(path.lastIndexOf("/") + 1));
