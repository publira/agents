import {
  devContainerLockFilePathOf,
  isDevContainerConfigPath,
} from "./devcontainer-lock-file.ts";
import { isLintFixRefusedPath, LINT_FIX_COMMIT_SUBJECT } from "./lint-fix.ts";
import { matchesAnyPathPattern } from "./regeneration.ts";
import { RENOVATE_LOGIN } from "./renovate-update.ts";

// The committer GitHub records, and signs for, on a commit made through its
// API, as Renovate makes them.
const GITHUB_COMMITTER = "web-flow";

export interface AccountRef {
  login: string;
  /** `Bot`, `User`, or `Organization`, as the REST API reports it. */
  type: string;
}

/** Whether an account is Renovate's, which a person cannot impersonate. */
export const isRenovate = (account: AccountRef | null | undefined): boolean =>
  account?.login === RENOVATE_LOGIN && account.type === "Bot";

export interface PullRequestCommit {
  sha: string;
  /** The GitHub account of the author, `undefined` when none matches. */
  authorLogin: string | undefined;
  committerLogin: string | undefined;
  /** Whether GitHub verified the commit's signature. */
  verified: boolean;
  /** The files the commit changes; read only for the bot's commits. */
  files?: readonly string[];
  /** The first line of the commit's message. */
  subject?: string;
}

/** What tells the bot's own commits apart. */
export interface BotCommitScope {
  /** The bot's login, which authors them. */
  botLogin: string;
  /** The files the pull request changes. */
  changedFiles: readonly string[];
  /**
   * The patterns of the generated output the repository declares on the
   * base branch, which the bot regenerates; none without a declaration.
   */
  generatedPaths?: readonly string[];
}

export type RenovateCommitsVerdict =
  | {
      result: "accepted";
      count: number;
      /** How many of them are the bot's lock file commits. */
      lockFileCommits: number;
      /** How many of them are the bot's commits of regenerated output. */
      regenerationCommits: number;
      /** How many of them are the bot's commits of automatic lint fixes. */
      lintFixCommits: number;
    }
  | { result: "no-commits" }
  | { result: "stale"; headSha: string }
  | {
      result: "foreign-commit";
      sha: string;
      problem: "author" | "committer" | "files" | "unverified";
    };

/**
 * The lock files the bot may commit to a pull request: those beside the Dev
 * Container configurations it changes.
 */
const lockFilesOf = (changedFiles: readonly string[]) =>
  new Set(
    changedFiles
      .filter(isDevContainerConfigPath)
      .map(devContainerLockFilePathOf)
  );

const COMMITTERS = new Set([RENOVATE_LOGIN, GITHUB_COMMITTER]);

/**
 * What a commit of the bot does, by its subject and the files it changes:
 * apply lint fixes, sync lock files, regenerate generated output, or
 * something the bot may not do.
 */
const botCommitKind = (
  { files = [], subject }: PullRequestCommit,
  {
    allowedLockFiles,
    generatedPaths,
  }: {
    allowedLockFiles: ReadonlySet<string>;
    generatedPaths: readonly string[];
  }
): "lint-fix" | "lock-file" | "regeneration" | undefined => {
  if (files.length === 0) {
    return undefined;
  }
  if (subject === LINT_FIX_COMMIT_SUBJECT) {
    return files.some(isLintFixRefusedPath) ? undefined : "lint-fix";
  }
  if (files.every((file) => allowedLockFiles.has(file))) {
    return "lock-file";
  }
  if (files.every((file) => matchesAnyPathPattern(generatedPaths, file))) {
    return "regeneration";
  }
  return undefined;
};

/**
 * Checks that every commit of a pull request is Renovate's: authored by it
 * and committed, signed, through GitHub's API. A commit someone pushed on top,
 * or one they rewrote, makes the pull request something other than the
 * update its metadata describes. The last commit must be the head the rest of
 * the evaluation looked at.
 *
 * With `bot`, the bot's own commits are accepted too, signed like Renovate's,
 * as long as each changes only the lock files beside the Dev Container
 * configurations the pull request changes, or only the generated output the
 * repository declares, or is its commit of automatic lint fixes, which
 * changes no lock file, `package.json`, or file under `.github/`.
 */
export const evaluateRenovateCommits = (
  commits: readonly PullRequestCommit[],
  headSha: string,
  bot?: BotCommitScope
): RenovateCommitsVerdict => {
  const last = commits.at(-1);

  if (last === undefined) {
    return { result: "no-commits" };
  }
  if (last.sha !== headSha) {
    return { headSha: last.sha, result: "stale" };
  }

  const allowedLockFiles = lockFilesOf(bot?.changedFiles ?? []);
  const generatedPaths = bot?.generatedPaths ?? [];
  let lintFixCommits = 0;
  let lockFileCommits = 0;
  let regenerationCommits = 0;

  for (const commit of commits) {
    const byBot = bot !== undefined && commit.authorLogin === bot.botLogin;
    const foreign = (
      problem: "author" | "committer" | "files" | "unverified"
    ) => ({ problem, result: "foreign-commit" as const, sha: commit.sha });

    if (commit.authorLogin !== RENOVATE_LOGIN && !byBot) {
      return foreign("author");
    }
    if (
      !COMMITTERS.has(commit.committerLogin ?? "") &&
      !(byBot && commit.committerLogin === bot.botLogin)
    ) {
      return foreign("committer");
    }
    if (!commit.verified) {
      return foreign("unverified");
    }
    if (byBot) {
      const kind = botCommitKind(commit, { allowedLockFiles, generatedPaths });
      if (kind === undefined) {
        return foreign("files");
      }
      if (kind === "lint-fix") {
        lintFixCommits += 1;
      } else if (kind === "lock-file") {
        lockFileCommits += 1;
      } else {
        regenerationCommits += 1;
      }
    }
  }

  return {
    count: commits.length,
    lintFixCommits,
    lockFileCommits,
    regenerationCommits,
    result: "accepted",
  };
};

export interface CheckRunInput {
  name: string;
  appId: number | undefined;
  status: string;
  conclusion: string | null;
}

export interface CommitStatusInput {
  context: string;
  state: string;
}

export interface RequiredCheckInput {
  context: string;
  /** The App that must report it; any App may when it is `undefined`. */
  integrationId: number | undefined;
}

export interface CommitChecksInput {
  checkRuns: readonly CheckRunInput[];
  statuses: readonly CommitStatusInput[];
  required: readonly RequiredCheckInput[];
}

export type CommitChecksVerdict =
  | { result: "passed"; count: number; required: number }
  | { result: "failed"; names: string[] }
  | { result: "pending"; names: string[] }
  | { result: "required-missing"; names: string[] }
  | { result: "no-checks" };

// The conclusions a required check accepts.
const PASSING_CONCLUSIONS = new Set(["neutral", "skipped", "success"]);

/**
 * Decides whether CI passed on a commit. Every check reported on it has to
 * pass, not only the required ones, and every required check has to be
 * reported: one that has not started yet would otherwise go unnoticed. A
 * commit without any check proves nothing and does not pass.
 */
export const evaluateCommitChecks = ({
  checkRuns,
  statuses,
  required,
}: CommitChecksInput): CommitChecksVerdict => {
  const failed = [
    ...checkRuns
      .filter(
        ({ status, conclusion }) =>
          status === "completed" &&
          (conclusion === null || !PASSING_CONCLUSIONS.has(conclusion))
      )
      .map(({ name }) => name),
    ...statuses
      .filter(({ state }) => state === "error" || state === "failure")
      .map(({ context }) => context),
  ];

  if (failed.length > 0) {
    return { names: failed, result: "failed" };
  }

  const pending = [
    ...checkRuns
      .filter(({ status }) => status !== "completed")
      .map(({ name }) => name),
    ...statuses
      .filter(({ state }) => state !== "success")
      .map(({ context }) => context),
  ];

  if (pending.length > 0) {
    return { names: pending, result: "pending" };
  }

  // A status names no App, so it satisfies only a check any App may report.
  const missing = required
    .filter(
      ({ context, integrationId }) =>
        !checkRuns.some(
          ({ name, appId }) =>
            name === context &&
            (integrationId === undefined || appId === integrationId)
        ) &&
        (integrationId !== undefined ||
          !statuses.some((status) => status.context === context))
    )
    .map(({ context }) => context);

  if (missing.length > 0) {
    return { names: missing, result: "required-missing" };
  }

  const count = checkRuns.length + statuses.length;

  return count === 0
    ? { result: "no-checks" }
    : { count, required: required.length, result: "passed" };
};

export interface PullRequestReview {
  user: AccountRef | null;
  /** `APPROVED`, `DISMISSED`, and so on. */
  state: string;
  /** The commit the review is for. */
  commitId: string | null;
  submittedAt: Date | undefined;
}

export interface MergedPullRequest {
  /** The head the pull request had when it was merged. */
  headSha: string;
  mergedAt: Date;
  reviews: readonly PullRequestReview[];
}

/**
 * Lists, in the order they reviewed, the people whose review would make a
 * merged pull request a precedent if they maintain its repository: an
 * approval, still standing, of the head that was merged, submitted before the
 * merge. A bot's approval never counts, so one automatic approval cannot vouch
 * for the next. An approval of an earlier head does not count either:
 * Renovate moves its branch to newer versions under the same pull request.
 *
 * Whether each of them maintains the repository is for
 * {@link isMaintainerPermission} to tell. A review's `author_association`
 * cannot: it depends on who reads it, and reports a member whose membership
 * is private as a `CONTRIBUTOR` to anyone outside the organization, the App
 * included.
 */
export const findPrecedentApprovers = ({
  headSha,
  mergedAt,
  reviews,
}: MergedPullRequest): string[] => {
  const approvers = reviews.flatMap(({ user, state, commitId, submittedAt }) =>
    user?.type === "User" &&
    state === "APPROVED" &&
    commitId === headSha &&
    submittedAt !== undefined &&
    submittedAt.getTime() <= mergedAt.getTime()
      ? [user.login]
      : []
  );
  return [...new Set(approvers)];
};

// The permissions that let someone push to, and merge in, a repository, as
// the REST API reports them: `maintain` reads as `write`, and a custom role as
// the role it is based on. Anyone can leave an approving review on a public
// repository.
const MAINTAINER_PERMISSIONS = new Set(["admin", "write"]);

/** Whether a repository permission makes its holder a maintainer. */
export const isMaintainerPermission = (permission: string): boolean =>
  MAINTAINER_PERMISSIONS.has(permission);
