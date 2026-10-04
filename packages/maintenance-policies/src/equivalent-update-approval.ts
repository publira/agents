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
}

export type RenovateCommitsVerdict =
  | { result: "renovate-only"; count: number }
  | { result: "no-commits" }
  | { result: "stale"; headSha: string }
  | {
      result: "foreign-commit";
      sha: string;
      problem: "author" | "committer" | "unverified";
    };

/**
 * Checks that every commit of a pull request is Renovate's: authored by it
 * and committed, signed, through GitHub's API. A commit someone pushed on top,
 * or one they rewrote, makes the pull request something other than the
 * update its metadata describes. The last commit must be the head the rest of
 * the evaluation looked at.
 */
export const evaluateRenovateCommits = (
  commits: readonly PullRequestCommit[],
  headSha: string
): RenovateCommitsVerdict => {
  const last = commits.at(-1);

  if (last === undefined) {
    return { result: "no-commits" };
  }
  if (last.sha !== headSha) {
    return { headSha: last.sha, result: "stale" };
  }

  for (const commit of commits) {
    if (commit.authorLogin !== RENOVATE_LOGIN) {
      return { problem: "author", result: "foreign-commit", sha: commit.sha };
    }
    if (
      commit.committerLogin !== RENOVATE_LOGIN &&
      commit.committerLogin !== GITHUB_COMMITTER
    ) {
      return {
        problem: "committer",
        result: "foreign-commit",
        sha: commit.sha,
      };
    }
    if (!commit.verified) {
      return {
        problem: "unverified",
        result: "foreign-commit",
        sha: commit.sha,
      };
    }
  }

  return { count: commits.length, result: "renovate-only" };
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
  /** How the reviewer relates to the repository, such as `MEMBER`. */
  authorAssociation: string;
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

// Those who can merge, or are trusted to review, in the repository. Anyone can
// leave an approving review on a public repository.
const MAINTAINER_ASSOCIATIONS = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);

/**
 * Finds the review that makes a merged pull request a precedent: a
 * maintainer's approval, still standing, of the head that was merged,
 * submitted before the merge. A bot's approval never counts, so one automatic
 * approval cannot vouch for the next. An approval of an earlier head does not
 * count either: Renovate moves its branch to newer versions under the same
 * pull request.
 */
export const findPrecedentApproval = ({
  headSha,
  mergedAt,
  reviews,
}: MergedPullRequest): PullRequestReview | undefined =>
  reviews.find(
    (review) =>
      review.state === "APPROVED" &&
      review.user?.type === "User" &&
      MAINTAINER_ASSOCIATIONS.has(review.authorAssociation) &&
      review.commitId === headSha &&
      review.submittedAt !== undefined &&
      review.submittedAt.getTime() <= mergedAt.getTime()
  );
