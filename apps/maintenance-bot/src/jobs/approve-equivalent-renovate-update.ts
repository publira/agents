import {
  ensureReview,
  getCommitChecks,
  getPullRequestBodyEditor,
  getRequiredStatusChecks,
  listAppRepositories,
} from "@publira/github";
import type { GitHubApp, Octokit } from "@publira/github";
import {
  evaluateCommitChecks,
  evaluateRenovateCommits,
  findPrecedentApproval,
  fingerprintRenovateUpdates,
  formatRenovateUpdate,
  isRenovate,
  parseRenovateUpdates,
  RENOVATE_LOGIN,
} from "@publira/maintenance-policies";
import type {
  CommitChecksVerdict,
  PullRequestReview,
  RenovateCommitsVerdict,
  RenovateUpdate,
} from "@publira/maintenance-policies";
import { z } from "zod";

import { loggableFailure } from "../log.ts";
import type { Log, LogFields } from "../log.ts";

/**
 * What the job checks, in order:
 *
 * - `author`: Renovate opened the pull request.
 * - `reviewable`: it is open, not a draft, not locked, from a branch of the
 *   same repository, and not conflicted.
 * - `metadata`: its body opens with the update metadata the organization's
 *   Renovate preset writes, and the metadata parses.
 * - `description`: nobody but Renovate edited the body since.
 * - `commits`: every commit is Renovate's.
 * - `checks`: every check on the head passed, the required ones included.
 * - `precedent`: a merged pull request of the same owner made the same
 *   updates, and a maintainer approved its merged head.
 * - `head`: the head did not move while the job looked.
 */
export type ApprovalCondition =
  | "author"
  | "checks"
  | "commits"
  | "description"
  | "head"
  | "metadata"
  | "precedent"
  | "reviewable";

export interface ConditionResult {
  condition: ApprovalCondition;
  passed: boolean;
  detail: string;
}

export interface Precedent {
  owner: string;
  repo: string;
  number: number;
  url: string;
  /** The maintainer whose approval makes it a precedent. */
  approvedBy: string;
  mergedAt: Date;
}

export type ApproveEquivalentRenovateUpdateResult =
  | { status: "skipped"; headSha: string; conditions: ConditionResult[] }
  | {
      /** The bot already approved this head, or someone dismissed it. */
      status: "already-reviewed";
      headSha: string;
      reviewId: number;
    }
  | {
      status: "would-approve";
      headSha: string;
      conditions: ConditionResult[];
      precedent: Precedent;
      body: string;
    }
  | {
      status: "approved";
      headSha: string;
      conditions: ConditionResult[];
      precedent: Precedent;
      /** `created` is `false` when a concurrent run submitted it. */
      review: { id: number; created: boolean };
    }
  | {
      /** The head moved while the approval was submitted, which was dismissed. */
      status: "withdrawn";
      headSha: string;
      newHeadSha: string;
      conditions: ConditionResult[];
      precedent: Precedent;
      review: { id: number };
    };

export interface ApproveEquivalentRenovateUpdateOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  /** The login the review is submitted under. A dry run needs none. */
  reviewer?: string;
  /** Evaluates the pull request without submitting a review. */
  dryRun?: boolean;
  /** Shares the scan for precedents with the other evaluations of a run. */
  precedentScanCache?: PrecedentScanCache;
}

const shortSha = (sha: string) => sha.slice(0, 7);

// The part of a failed Octokit request that tells what went wrong.
const requestFailure = z.object({ status: z.number() });

const describeCommits = (verdict: RenovateCommitsVerdict): string => {
  switch (verdict.result) {
    case "renovate-only": {
      return `Renovate made all ${verdict.count} commit(s), signed by GitHub`;
    }
    case "no-commits": {
      return "the pull request has no commits";
    }
    case "stale": {
      return `the commits end at ${shortSha(verdict.headSha)}, not at the head`;
    }
    case "foreign-commit": {
      const problems = {
        author: "was not authored by Renovate",
        committer: "was committed by someone other than Renovate or GitHub",
        unverified: "has no verified signature",
      };
      return `commit ${shortSha(verdict.sha)} ${problems[verdict.problem]}`;
    }
    default: {
      return "unknown";
    }
  }
};

const describeChecks = (verdict: CommitChecksVerdict): string => {
  switch (verdict.result) {
    case "passed": {
      return `all ${verdict.count} check(s) passed, ${verdict.required} of them required`;
    }
    case "failed": {
      return `failed: ${verdict.names.join(", ")}`;
    }
    case "pending": {
      return `still running: ${verdict.names.join(", ")}`;
    }
    case "required-missing": {
      return `required but not reported yet: ${verdict.names.join(", ")}`;
    }
    case "no-checks": {
      return "no check reported on the head";
    }
    default: {
      return "unknown";
    }
  }
};

const toReview = (review: {
  user: { login: string; type: string } | null;
  state: string;
  author_association: string;
  commit_id: string | null;
  submitted_at?: string;
}): PullRequestReview => ({
  authorAssociation: review.author_association,
  commitId: review.commit_id,
  state: review.state,
  submittedAt:
    review.submitted_at === undefined
      ? undefined
      : new Date(review.submitted_at),
  user: review.user,
});

interface ScanOptions {
  octokit: Octokit;
  owner: string;
  ownerType: string;
  /** The branch Renovate raises the update from. */
  headRef: string;
}

const listOwnerRepositories = async ({
  octokit,
  owner,
  ownerType,
}: ScanOptions) => {
  const repositories =
    ownerType === "Organization"
      ? await octokit.paginate(octokit.rest.repos.listForOrg, {
          org: owner,
          per_page: 100,
          type: "all",
        })
      : await octokit.paginate(octokit.rest.repos.listForUser, {
          per_page: 100,
          type: "owner",
          username: owner,
        });
  return repositories.map(({ name }) => name);
};

/** Lists the closed pull requests from a branch in every given repository. */
const listClosedFromBranch = async (
  { octokit, owner, headRef }: ScanOptions,
  repositories: readonly string[]
) => {
  const closed = await Promise.all(
    repositories.map(async (repo) => {
      const pulls = await octokit.paginate(octokit.rest.pulls.list, {
        head: `${owner}:${headRef}`,
        owner,
        per_page: 100,
        repo,
        state: "closed",
      });
      return pulls.map((pull) => ({ ...pull, repo }));
    })
  );
  return closed.flat();
};

type ClosedPullRequest = Awaited<
  ReturnType<typeof listClosedFromBranch>
>[number];

/**
 * Shares the scan for precedents between the evaluations of one run, such as
 * the hourly sweep: the owner's repositories are listed once, and each
 * branch's closed pull requests are listed once across them. Create one per
 * run, so that a later run sees pull requests merged since.
 */
export interface PrecedentScanCache {
  repositories: Map<string, Promise<string[]>>;
  closedPullRequests: Map<string, Promise<ClosedPullRequest[]>>;
}

export const createPrecedentScanCache = (): PrecedentScanCache => ({
  closedPullRequests: new Map(),
  repositories: new Map(),
});

// A failed scan is forgotten, so the next evaluation tries it again.
const memoize = <T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>
): Promise<T> => {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const loaded = (async () => {
    try {
      return await load();
    } catch (error) {
      // `load` returns a promise, so this runs after the `set` below.
      cache.delete(key);
      throw error;
    }
  })();
  cache.set(key, loaded);
  return loaded;
};

const scanClosedFromBranch = (
  options: ScanOptions,
  cache: PrecedentScanCache = createPrecedentScanCache()
) =>
  memoize(
    cache.closedPullRequests,
    `${options.owner}\0${options.headRef}`,
    async () =>
      listClosedFromBranch(
        options,
        await memoize(cache.repositories, options.owner, () =>
          listOwnerRepositories(options)
        )
      )
  );

interface FindPrecedentOptions extends ScanOptions {
  fingerprint: string;
  /** The pull request being evaluated, which cannot be its own precedent. */
  current: { repo: string; number: number };
  cache: PrecedentScanCache | undefined;
}

/**
 * Looks for a precedent among the merged pull requests from the same branch
 * in every repository of the owner the token can read. The organization's
 * Renovate preset names a branch after its dependency or group, so the same
 * update comes from the same branch everywhere; one from a branch of another
 * name is not found, and the update is not approved.
 */
const findPrecedent = async ({
  fingerprint,
  current,
  cache,
  ...scan
}: FindPrecedentOptions): Promise<
  { precedent: Precedent } | { reasons: string[] }
> => {
  const { octokit, owner, headRef } = scan;
  const closed = await scanClosedFromBranch(scan, cache);
  const candidates = closed
    .flatMap((pull) => {
      if (
        pull.merged_at === null ||
        !isRenovate(pull.user) ||
        (pull.repo === current.repo && pull.number === current.number)
      ) {
        return [];
      }
      const parsed = parseRenovateUpdates(pull.body ?? "");
      return parsed.result === "parsed" &&
        fingerprintRenovateUpdates(parsed.updates) === fingerprint
        ? [{ ...pull, mergedAt: new Date(pull.merged_at) }]
        : [];
    })
    // The latest first.
    .toSorted((a, b) => b.mergedAt.getTime() - a.mergedAt.getTime());

  if (candidates.length === 0) {
    return {
      reasons: [
        `no merged pull request from ${headRef} in ${owner}'s repositories made the same updates`,
      ],
    };
  }

  const reasons: string[] = [];

  for (const candidate of candidates) {
    const name = `${owner}/${candidate.repo}#${candidate.number}`;
    const location = {
      owner,
      pullNumber: candidate.number,
      repo: candidate.repo,
    };
    // oxlint-disable-next-line no-await-in-loop -- the first precedent ends the search
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      per_page: 100,
      pull_number: candidate.number,
      repo: candidate.repo,
    });
    const approval = findPrecedentApproval({
      headSha: candidate.head.sha,
      mergedAt: candidate.mergedAt,
      reviews: reviews.map(toReview),
    });

    if (approval?.user === null || approval?.user === undefined) {
      reasons.push(
        `${name} made the same updates, but no maintainer approved the head it was merged at`
      );
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- the first precedent ends the search
    const editor = await getPullRequestBodyEditor(octokit, location);

    if (editor !== null && editor !== RENOVATE_LOGIN) {
      reasons.push(
        `${name} made the same updates, but ${editor} edited its description, so its metadata is not Renovate's`
      );
      continue;
    }

    return {
      precedent: {
        approvedBy: approval.user.login,
        mergedAt: candidate.mergedAt,
        number: candidate.number,
        owner,
        repo: candidate.repo,
        url: candidate.html_url,
      },
    };
  }

  return { reasons };
};

const reviewBody = (
  updates: readonly RenovateUpdate[],
  precedent: Precedent,
  conditions: readonly ConditionResult[]
) => {
  const detail = (condition: ApprovalCondition) =>
    conditions.find((result) => result.condition === condition)?.detail ?? "";

  return [
    `Approved as the same update a maintainer approved in ${precedent.owner}/${precedent.repo}#${precedent.number}, merged ${precedent.mergedAt.toISOString()}:`,
    "",
    ...updates.map((update) => `- \`${formatRenovateUpdate(update)}\``),
    "",
    "The maintenance bot checked, by fixed rules and without a model, that:",
    "",
    "- Renovate opened this pull request, wrote its update metadata, and made every commit.",
    `- Checks: ${detail("checks")}.`,
    `- Precedent: ${detail("precedent")}.`,
  ].join("\n");
};

type PullRequestData = Awaited<
  ReturnType<Octokit["rest"]["pulls"]["get"]>
>["data"];

interface Verdict {
  passed: boolean;
  detail: string;
}

interface PullRequestContext {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  pullRequest: PullRequestData;
  precedentScanCache: PrecedentScanCache | undefined;
}

const checkAuthor = ({ user }: PullRequestData): Verdict =>
  isRenovate(user)
    ? { detail: `opened by ${RENOVATE_LOGIN}`, passed: true }
    : {
        detail: `opened by ${user?.login ?? "a deleted account"}, not ${RENOVATE_LOGIN}`,
        passed: false,
      };

const unreviewableReason = (
  pullRequest: PullRequestData
): string | undefined => {
  if (pullRequest.state !== "open") {
    return "it is closed";
  }
  if (pullRequest.draft === true) {
    return "it is a draft";
  }
  if (pullRequest.locked) {
    return "it is locked";
  }
  if (pullRequest.head.repo?.full_name !== pullRequest.base.repo.full_name) {
    return "its branch is in another repository";
  }
  if (pullRequest.mergeable === false) {
    return "it has conflicts";
  }
};

const checkReviewable = (pullRequest: PullRequestData): Verdict => {
  const reason = unreviewableReason(pullRequest);
  return reason === undefined
    ? { detail: "open, ready for review, and without conflicts", passed: true }
    : { detail: reason, passed: false };
};

const checkDescription = async ({
  octokit,
  owner,
  repo,
  pullNumber,
}: PullRequestContext): Promise<Verdict> => {
  const editor = await getPullRequestBodyEditor(octokit, {
    owner,
    pullNumber,
    repo,
  });

  return editor === null || editor === RENOVATE_LOGIN
    ? { detail: "only Renovate wrote the description", passed: true }
    : {
        detail: `${editor} edited the description last; Renovate rewrites it on its next run`,
        passed: false,
      };
};

const checkCommits = async ({
  octokit,
  owner,
  repo,
  pullNumber,
  pullRequest,
}: PullRequestContext): Promise<Verdict> => {
  const commits = await octokit.paginate(octokit.rest.pulls.listCommits, {
    owner,
    per_page: 100,
    pull_number: pullNumber,
    repo,
  });
  const verdict = evaluateRenovateCommits(
    commits.map((commit) => ({
      authorLogin: commit.author?.login,
      committerLogin: commit.committer?.login,
      sha: commit.sha,
      verified: commit.commit.verification?.verified === true,
    })),
    pullRequest.head.sha
  );

  return {
    detail: describeCommits(verdict),
    passed: verdict.result === "renovate-only",
  };
};

const checkCI = async ({
  octokit,
  owner,
  repo,
  pullRequest,
}: PullRequestContext): Promise<Verdict> => {
  const [checks, required] = await Promise.all([
    getCommitChecks(octokit, { owner, ref: pullRequest.head.sha, repo }),
    getRequiredStatusChecks(octokit, {
      branch: pullRequest.base.ref,
      owner,
      repo,
    }),
  ]);
  const verdict = evaluateCommitChecks({ ...checks, required });

  return verdict.result === "passed"
    ? {
        detail: `on ${shortSha(pullRequest.head.sha)}, ${describeChecks(verdict)}`,
        passed: true,
      }
    : { detail: describeChecks(verdict), passed: false };
};

const checkHead = (latest: PullRequestData, headSha: string): Verdict => {
  if (latest.head.sha !== headSha) {
    return {
      detail: `the head moved to ${shortSha(latest.head.sha)} meanwhile`,
      passed: false,
    };
  }
  if (latest.state !== "open" || latest.draft === true) {
    return {
      detail: "the pull request was closed or turned into a draft meanwhile",
      passed: false,
    };
  }
  return { detail: `still ${shortSha(headSha)}`, passed: true };
};

interface Evaluation {
  conditions: ConditionResult[];
  /** Both set once every condition up to the precedent passed. */
  updates?: RenovateUpdate[];
  precedent?: Precedent;
}

/** Checks the conditions up to the precedent, and stops at the first that fails. */
const evaluateConditions = async (
  context: PullRequestContext
): Promise<Evaluation> => {
  const { pullRequest } = context;
  const conditions: ConditionResult[] = [];
  const record = (condition: ApprovalCondition, verdict: Verdict) => {
    conditions.push({ condition, ...verdict });
    return verdict.passed;
  };

  if (
    !record("author", checkAuthor(pullRequest)) ||
    !record("reviewable", checkReviewable(pullRequest))
  ) {
    return { conditions };
  }

  const parsed = parseRenovateUpdates(pullRequest.body ?? "");

  if (parsed.result === "invalid") {
    record("metadata", { detail: parsed.reason, passed: false });
    return { conditions };
  }
  record("metadata", {
    detail: parsed.updates.map(formatRenovateUpdate).join(", "),
    passed: true,
  });

  const checks = [
    ["description", checkDescription],
    ["commits", checkCommits],
    ["checks", checkCI],
  ] as const;

  for (const [condition, check] of checks) {
    // oxlint-disable-next-line no-await-in-loop -- each runs only if the last passed
    if (!record(condition, await check(context))) {
      return { conditions };
    }
  }

  const found = await findPrecedent({
    cache: context.precedentScanCache,
    current: { number: context.pullNumber, repo: context.repo },
    fingerprint: fingerprintRenovateUpdates(parsed.updates),
    headRef: pullRequest.head.ref,
    octokit: context.octokit,
    owner: context.owner,
    ownerType: pullRequest.base.repo.owner.type,
  });

  if ("reasons" in found) {
    record("precedent", { detail: found.reasons.join("; "), passed: false });
    return { conditions };
  }

  const { precedent } = found;
  record("precedent", {
    detail: `${precedent.owner}/${precedent.repo}#${precedent.number} made the same updates, and ${precedent.approvedBy} approved the head it was merged at`,
    passed: true,
  });
  return { conditions, precedent, updates: parsed.updates };
};

/**
 * Approves a Renovate pull request when a maintainer already approved the
 * same update elsewhere in the organization and that pull request was merged.
 *
 * The update is what the organization's Renovate preset writes at the top of
 * the body: manager, datasource, dependency, both versions and digests, and
 * update type. Every one of them has to match the precedent's, which a
 * maintainer approved at the head that was merged; a bot's approval never
 * counts. The pull request must also hold only Renovate's commits and have
 * passed CI on its head. Fixed rules decide all of it; no model is asked.
 *
 * The head is read again just before the review is submitted, and the review
 * is for that commit only. If the head moved during the submission, the
 * approval is dismissed. Running it again on the same head submits nothing.
 */
export const approveEquivalentRenovateUpdate = async ({
  octokit,
  owner,
  repo,
  pullNumber,
  reviewer,
  dryRun = false,
  precedentScanCache,
}: ApproveEquivalentRenovateUpdateOptions): Promise<ApproveEquivalentRenovateUpdateResult> => {
  const location = { owner, pull_number: pullNumber, repo };
  const readPullRequest = async () => {
    const response = await octokit.rest.pulls.get(location);
    return response.data;
  };
  const pullRequest = await readPullRequest();
  const headSha = pullRequest.head.sha;

  // Most deliveries for a pull request come after the bot approved it.
  if (!dryRun && reviewer !== undefined && isRenovate(pullRequest.user)) {
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      ...location,
      per_page: 100,
    });
    const own = reviews.find(
      (review) =>
        review.user?.login === reviewer &&
        review.commit_id === headSha &&
        (review.state === "APPROVED" || review.state === "DISMISSED")
    );
    if (own !== undefined) {
      return { headSha, reviewId: own.id, status: "already-reviewed" };
    }
  }

  const { conditions, precedent, updates } = await evaluateConditions({
    octokit,
    owner,
    precedentScanCache,
    pullNumber,
    pullRequest,
    repo,
  });

  if (precedent === undefined || updates === undefined) {
    return { conditions, headSha, status: "skipped" };
  }

  // Everything above was read for `headSha`; a push since would change it.
  const latest = await readPullRequest();
  const head = checkHead(latest, headSha);
  conditions.push({ condition: "head", ...head });

  if (!head.passed) {
    return { conditions, headSha, status: "skipped" };
  }

  const body = reviewBody(updates, precedent, conditions);

  if (dryRun) {
    return { body, conditions, headSha, precedent, status: "would-approve" };
  }
  if (reviewer === undefined) {
    throw new Error("Approving a pull request needs the reviewer's login");
  }

  const review = await ensureReview(octokit, {
    body,
    commitId: headSha,
    event: "APPROVE",
    owner,
    pullNumber,
    repo,
    reviewer,
  });
  // A push between the check above and the submission leaves an approval of
  // a commit that is no longer the head, which could still count. Read the
  // head again even when a concurrent run submitted the review: that run may
  // fail before it checks.
  const after = await readPullRequest();

  if (after.head.sha !== headSha) {
    try {
      await octokit.rest.pulls.dismissReview({
        ...location,
        message: `The head moved to ${after.head.sha} while this approval of ${headSha} was submitted. The maintenance bot evaluates the new head on its own.`,
        review_id: review.id,
      });
    } catch (error) {
      // Someone, or a concurrent run, dismissed it first.
      if (requestFailure.safeParse(error).data?.status !== 422) {
        throw error;
      }
    }
    return {
      conditions,
      headSha,
      newHeadSha: after.head.sha,
      precedent,
      review: { id: review.id },
      status: "withdrawn",
    };
  }

  return { conditions, headSha, precedent, review, status: "approved" };
};

/** The fields of a result to log, without the review body. */
export const summarizeApprovalResult = (
  result: ApproveEquivalentRenovateUpdateResult
): LogFields => {
  const failed =
    result.status === "skipped"
      ? result.conditions.find(({ passed }) => !passed)
      : undefined;
  const precedent =
    result.status === "skipped" || result.status === "already-reviewed"
      ? undefined
      : result.precedent;

  return {
    condition: failed?.condition,
    detail: failed?.detail,
    headSha: result.headSha,
    precedent:
      precedent === undefined
        ? undefined
        : `${precedent.owner}/${precedent.repo}#${precedent.number}`,
    status: result.status,
  };
};

export interface ApproveEquivalentRenovateUpdatesEverywhereOptions {
  app: GitHubApp;
  log: Log;
  /** Only the pull requests from this branch, such as after a precedent merged. */
  headRef?: string;
  /** Replaced in tests. */
  job?: typeof approveEquivalentRenovateUpdate;
}

/**
 * Runs {@link approveEquivalentRenovateUpdate} on every open Renovate pull
 * request in the unarchived repositories the App is installed on. A pull
 * request that fails is logged, and the others still run.
 */
export const approveEquivalentRenovateUpdatesEverywhere = async ({
  app,
  log,
  headRef,
  job = approveEquivalentRenovateUpdate,
}: ApproveEquivalentRenovateUpdatesEverywhereOptions): Promise<void> => {
  const [repositories, reviewer] = await Promise.all([
    listAppRepositories(app),
    app.getBotLogin(),
  ]);
  const precedentScanCache = createPrecedentScanCache();

  await Promise.all(
    repositories
      .filter(({ archived }) => !archived)
      .map(async ({ installationId, owner, repo }) => {
        try {
          const octokit = await app.getInstallationOctokit(installationId);
          const pulls = await octokit.paginate(octokit.rest.pulls.list, {
            head: headRef === undefined ? undefined : `${owner}:${headRef}`,
            owner,
            per_page: 100,
            repo,
            state: "open",
          });

          // One at a time, so a repository with many updates does not burst.
          for (const pull of pulls.filter(({ user }) => isRenovate(user))) {
            const fields = { owner, pullRequest: pull.number, repo };
            try {
              // oxlint-disable-next-line no-await-in-loop -- see above
              const result = await job({
                octokit,
                owner,
                precedentScanCache,
                pullNumber: pull.number,
                repo,
                reviewer,
              });
              log("info", "Renovate update evaluated", {
                ...fields,
                ...summarizeApprovalResult(result),
              });
            } catch (error) {
              log("error", "Renovate update approval failed", {
                ...fields,
                ...loggableFailure.safeParse(error).data,
              });
            }
          }
        } catch (error) {
          log("error", "Renovate update approval failed", {
            owner,
            repo,
            ...loggableFailure.safeParse(error).data,
          });
        }
      })
  );
};
