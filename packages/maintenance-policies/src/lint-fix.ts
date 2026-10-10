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

/**
 * The subject of the bot's commit of the fixes a model made to the findings
 * the automatic fix leaves.
 */
export const LINT_FINDINGS_FIX_COMMIT_SUBJECT =
  "chore(lint): fix findings for the updated lint tools";

// The lint configuration, by file name in any directory. A model that
// changes it turns a rule off rather than fixing what the rule finds.
const LINT_CONFIGURATION_FILE_NAMES = [
  /^oxlint\.config\./u,
  /^oxfmt\.config\./u,
  /^\.oxlintrc/u,
  /^\.oxfmtrc/u,
  /^\.prettierignore$/u,
];

/**
 * Whether a model's fix of the findings may not change a path: one that
 * {@link isLintFixRefusedPath} refuses, or the lint configuration.
 */
export const isLintFindingsFixRefusedPath = (path: string): boolean => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    isLintFixRefusedPath(path) ||
    LINT_CONFIGURATION_FILE_NAMES.some((pattern) => pattern.test(name))
  );
};

// The comments that turn a finding off instead of fixing it.
const SUPPRESSIONS = [
  "eslint-disable",
  "oxlint-disable",
  "oxfmt-ignore",
  "prettier-ignore",
  "biome-ignore",
  "@ts-ignore",
  "@ts-expect-error",
  "@ts-nocheck",
];

/** A line a fix adds to a file. */
export interface AddedLine {
  path: string;
  /** Its number in the fixed file, from 1. */
  lineNumber: number;
  text: string;
}

export interface LintFindingsFixInput {
  /** Whether `ultracite check` passes after the fix. */
  checkPassed: boolean;
  /** The files the fix changes against the head. */
  paths: readonly string[];
  /** The lines the fix adds against the head. */
  addedLines: readonly AddedLine[];
}

export type LintFindingsFixVerdict =
  | { result: "accepted" }
  | {
      result: "refused";
      reason: string;
      /** The files the fix may not change. */
      refusedPaths: string[];
      /** The added lines that turn a finding off. */
      suppressions: AddedLine[];
    };

/**
 * Decides whether the bot commits a model's fix of the findings the automatic
 * fix leaves: it changes something, leaves alone the files a lint fix has no
 * reason to change and the lint configuration, adds no comment that turns a
 * finding off, and `ultracite check` passes after it.
 */
export const evaluateLintFindingsFix = ({
  checkPassed,
  paths,
  addedLines,
}: LintFindingsFixInput): LintFindingsFixVerdict => {
  const refusedPaths = paths.filter(isLintFindingsFixRefusedPath);
  const suppressions = addedLines.filter(({ text }) =>
    SUPPRESSIONS.some((suppression) => text.includes(suppression))
  );
  const refuse = (reason: string): LintFindingsFixVerdict => ({
    reason,
    refusedPaths,
    result: "refused",
    suppressions,
  });

  if (paths.length === 0) {
    return refuse("the model changed nothing");
  }
  if (refusedPaths.length > 0) {
    return refuse(
      "the model changed a lock file, a package.json, a file under .github, or the lint configuration"
    );
  }
  if (suppressions.length > 0) {
    return refuse("the model added comments that turn findings off");
  }
  if (!checkPassed) {
    return refuse("`ultracite check` still fails after the model's changes");
  }
  return { result: "accepted" };
};
