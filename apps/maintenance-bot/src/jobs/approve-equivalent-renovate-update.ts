import {
  ensureReview,
  getCommitChecks,
  getPullRequestBodyEditor,
  getRepositoryPermission,
  getRequiredStatusChecks,
  minimizeOutdatedReviews,
  readOptionalRepositoryFile,
} from "@publira/github";
import type { Octokit } from "@publira/github";
import {
  evaluateCommitChecks,
  evaluateRenovateCommits,
  findPrecedentApprovers,
  fingerprintRenovateUpdates,
  formatRenovateUpdate,
  isMaintainerPermission,
  isRenovate,
  parseRegenerationConfig,
  parseRenovateUpdates,
  REGENERATION_CONFIG_PATH,
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
import type { LogFields } from "../log.ts";

/**
 * What the job checks, in order:
 *
 * - `author`: Renovate opened the pull request.
 * - `reviewable`: it is open, not a draft, not locked, from a branch of the
 *   same repository, and not conflicted.
 * - `metadata`: its body opens with the update metadata the organization's
 *   Renovate preset writes, and the metadata parses.
 * - `description`: nobody but Renovate edited the body since.
 * - `commits`: every commit is Renovate's, but for the bot's own commits of
 *   the Dev Container lock files beside the configurations it changes, and
 *   of the generated output the repository declares.
 * - `checks`: every check on the head passed, the required ones included.
 * - `precedent`: a merged pull request of the same owner made the same
 *   updates, and a maintainer approved its merged head: someone who can write
 *   to that repository.
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
  /** Its updates, whose managers may differ from the evaluated ones'. */
  updates: RenovateUpdate[];
}

/**
 * How many of the bot's reviews submitted before its approval it minimized
 * as outdated, or why it could not.
 */
export type OutdatedReviews =
  | { minimized: number }
  | { error: string; status?: number };

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
      /** Unset when a concurrent run submitted the review. */
      outdatedReviews?: OutdatedReviews;
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
  /**
   * The login the review is submitted under. A dry run needs none, but
   * without it the bot's own commits count as foreign.
   */
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
    case "accepted": {
      const { count, lockFileCommits, regenerationCommits } = verdict;
      const botCommits = [
        ...(lockFileCommits === 0
          ? []
          : [`${lockFileCommits} syncing the Dev Container lock files`]),
        ...(regenerationCommits === 0
          ? []
          : [`${regenerationCommits} regenerating the generated output`]),
      ];
      return botCommits.length === 0
        ? `Renovate made all ${count} commit(s), signed by GitHub`
        : `Renovate made ${count - lockFileCommits - regenerationCommits} commit(s), and the maintenance bot ${botCommits.join(" and ")}, all signed by GitHub`;
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
        committer: "was committed by someone other than its author or GitHub",
        files:
          "changes more than either the Dev Container lock files beside the configurations the pull request changes or the generated output the repository declares",
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
  commit_id: string | null;
  submitted_at?: string;
}): PullRequestReview => ({
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
 * the hourly sweep: the owner's repositories are listed once, each branch's
 * closed pull requests are listed once across them, and each reviewer's
 * permission on a repository is read once. Create one per run, so that a
 * later run sees pull requests merged and permissions changed since.
 */
export interface PrecedentScanCache {
  repositories: Map<string, Promise<string[]>>;
  closedPullRequests: Map<string, Promise<ClosedPullRequest[]>>;
  permissions: Map<string, Promise<string | undefined>>;
}

export const createPrecedentScanCache = (): PrecedentScanCache => ({
  closedPullRequests: new Map(),
  permissions: new Map(),
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

interface FindMaintainerOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  approvers: readonly string[];
  permissions: PrecedentScanCache["permissions"];
}

/**
 * Finds the first approver who can write to the repository, from their
 * permission on it, which reads the same to every token. Also returns those
 * whose permission the token could not read.
 */
const findMaintainer = async ({
  octokit,
  owner,
  repo,
  approvers,
  permissions,
}: FindMaintainerOptions): Promise<{
  maintainer: string | undefined;
  unreadable: string[];
}> => {
  const unreadable: string[] = [];

  for (const username of approvers) {
    // oxlint-disable-next-line no-await-in-loop -- the first maintainer ends the search
    const permission = await memoize(
      permissions,
      `${owner}/${repo}\0${username}`,
      () => getRepositoryPermission(octokit, { owner, repo, username })
    );
    if (permission === undefined) {
      unreadable.push(username);
    } else if (isMaintainerPermission(permission)) {
      return { maintainer: username, unreadable };
    }
  }

  return { maintainer: undefined, unreadable };
};

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
  const permissions = cache?.permissions ?? new Map();
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
        ? [
            {
              ...pull,
              mergedAt: new Date(pull.merged_at),
              updates: parsed.updates,
            },
          ]
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
    // oxlint-disable-next-line no-await-in-loop -- the first precedent ends the search
    const { maintainer, unreadable } = await findMaintainer({
      approvers: findPrecedentApprovers({
        headSha: candidate.head.sha,
        mergedAt: candidate.mergedAt,
        reviews: reviews.map(toReview),
      }),
      octokit,
      owner,
      permissions,
      repo: candidate.repo,
    });

    if (maintainer === undefined) {
      reasons.push(
        unreadable.length === 0
          ? `${name} made the same updates, but no maintainer approved the head it was merged at`
          : `${name} made the same updates, but the bot cannot read whether ${unreadable.join(", ")}, who approved the head it was merged at, can write to ${owner}/${candidate.repo}`
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
        approvedBy: maintainer,
        mergedAt: candidate.mergedAt,
        number: candidate.number,
        owner,
        repo: candidate.repo,
        updates: candidate.updates,
        url: candidate.html_url,
      },
    };
  }

  return { reasons };
};

const listUpdates = (updates: readonly RenovateUpdate[]) =>
  updates.map((update) => `- \`${formatRenovateUpdate(update)}\``);

const reviewBody = (
  updates: readonly RenovateUpdate[],
  precedent: Precedent,
  conditions: readonly ConditionResult[]
) => {
  const detail = (condition: ApprovalCondition) =>
    conditions.find((result) => result.condition === condition)?.detail ?? "";
  const name = `${precedent.owner}/${precedent.repo}#${precedent.number}`;
  const listed = listUpdates(updates);
  const precedentListed = listUpdates(precedent.updates);
  // The fingerprints match, so the lists can differ only in the managers.
  const managersDiffer = precedentListed.join("\n") !== listed.join("\n");

  return [
    `Approved as the same update a maintainer approved in ${name}, merged ${precedent.mergedAt.toISOString()}:`,
    "",
    ...listed,
    "",
    ...(managersDiffer
      ? [`${name} made it through another manager:`, "", ...precedentListed, ""]
      : []),
    "The maintenance bot checked, by fixed rules and without a model, that:",
    "",
    "- Renovate opened this pull request and wrote its update metadata.",
    `- Commits: ${detail("commits")}.`,
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
  /** The bot's login, whose lock file commits are accepted. */
  reviewer: string | undefined;
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

// GitHub lists a commit's files in pages, of at most 300 files in all.
const FILES_PER_PAGE = 100;

// Every file a commit changes, from all of its pages. The pagination plugin
// does not follow a commit's files.
const listCommitFiles = async (
  context: PullRequestContext,
  sha: string,
  page = 1
): Promise<string[]> => {
  const { octokit, owner, repo } = context;
  const { data } = await octokit.rest.repos.getCommit({
    owner,
    page,
    per_page: FILES_PER_PAGE,
    ref: sha,
    repo,
  });
  const files = (data.files ?? []).map(({ filename }) => filename);
  return files.length < FILES_PER_PAGE
    ? files
    : [...files, ...(await listCommitFiles(context, sha, page + 1))];
};

// The generated output the repository declares on the base branch, which
// the bot may commit; none without a valid declaration.
const readGeneratedPaths = async ({
  octokit,
  owner,
  repo,
  pullRequest,
}: PullRequestContext) => {
  const source = await readOptionalRepositoryFile(octokit, {
    owner,
    path: REGENERATION_CONFIG_PATH,
    ref: pullRequest.base.sha,
    repo,
  });
  if (source === undefined) {
    return [];
  }
  const parsed = parseRegenerationConfig(source);
  return parsed.result === "valid" ? parsed.config.paths : [];
};

// The files each of the bot's commits changes, and those the pull request
// does and the generated output, which tell whether the bot may have made
// them. Read only when the bot made a commit.
const readBotCommitScope = async (
  context: PullRequestContext,
  botShas: readonly string[]
) => {
  const { octokit, owner, repo, pullNumber, reviewer } = context;
  if (reviewer === undefined || botShas.length === 0) {
    return { files: new Map<string, string[]>(), scope: undefined };
  }
  const [changed, files, generatedPaths] = await Promise.all([
    octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      per_page: 100,
      pull_number: pullNumber,
      repo,
    }),
    Promise.all(
      botShas.map(
        async (sha) => [sha, await listCommitFiles(context, sha)] as const
      )
    ),
    readGeneratedPaths(context),
  ]);
  return {
    files: new Map(files),
    scope: {
      botLogin: reviewer,
      changedFiles: changed.map(({ filename }) => filename),
      generatedPaths,
    },
  };
};

const checkCommits = async (context: PullRequestContext): Promise<Verdict> => {
  const { octokit, owner, repo, pullNumber, pullRequest, reviewer } = context;
  const commits = await octokit.paginate(octokit.rest.pulls.listCommits, {
    owner,
    per_page: 100,
    pull_number: pullNumber,
    repo,
  });
  const { files, scope } = await readBotCommitScope(
    context,
    commits
      .filter(
        ({ author }) => reviewer !== undefined && author?.login === reviewer
      )
      .map(({ sha }) => sha)
  );
  const verdict = evaluateRenovateCommits(
    commits.map((commit) => ({
      authorLogin: commit.author?.login,
      committerLogin: commit.committer?.login,
      files: files.get(commit.sha),
      sha: commit.sha,
      verified: commit.commit.verification?.verified === true,
    })),
    pullRequest.head.sha,
    scope
  );

  return {
    detail: describeCommits(verdict),
    passed: verdict.result === "accepted",
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
 * update type. Every one of them but the manager has to match the
 * precedent's, which a maintainer approved at the head that was merged; a
 * bot's approval never counts. The manager names the kind of file Renovate
 * rewrote, not what the update pulls in, and the review names both pull
 * requests' managers when they differ. The pull request must also hold only
 * Renovate's commits and have passed CI on its head. Fixed rules decide all of
 * it; no model is asked.
 *
 * The head is read again just before the review is submitted, and the review
 * is for that commit only. If the head moved during the submission, the
 * approval is dismissed. Running it again on the same head submits nothing.
 * Once it submitted the approval of a head, it minimizes its own reviews
 * submitted before it as outdated, so that only the latest shows in full;
 * a failure to do so leaves the approval as it is.
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
    reviewer,
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

  if (!review.created) {
    return { conditions, headSha, precedent, review, status: "approved" };
  }

  let outdatedReviews: OutdatedReviews;
  try {
    outdatedReviews = {
      minimized: await minimizeOutdatedReviews(octokit, {
        owner,
        pullNumber,
        repo,
        reviewId: review.id,
        reviewer,
      }),
    };
  } catch (error) {
    // The approval stands; the earlier reviews only stay expanded.
    outdatedReviews = loggableFailure.safeParse(error).data ?? {
      error: "unknown",
    };
  }

  return {
    conditions,
    headSha,
    outdatedReviews,
    precedent,
    review,
    status: "approved",
  };
};

/**
 * The fields of a result to log, without the review body: why it was
 * skipped, or which precedent and whose approval of it led to the approval,
 * and the review. No model takes part in the decision.
 */
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
  let review: { id: number; created?: boolean } | undefined;
  const outdated =
    result.status === "approved" ? result.outdatedReviews : undefined;
  const minimizeFailure =
    outdated !== undefined && "error" in outdated ? outdated : undefined;

  if (result.status === "already-reviewed") {
    review = { created: false, id: result.reviewId };
  } else if (result.status === "approved" || result.status === "withdrawn") {
    ({ review } = result);
  }

  return {
    condition: failed?.condition,
    detail: failed?.detail,
    headSha: result.headSha,
    minimizeError: minimizeFailure?.error,
    minimizeErrorStatus: minimizeFailure?.status,
    minimizedReviews:
      outdated !== undefined && "minimized" in outdated
        ? outdated.minimized
        : undefined,
    modelInvoked: false,
    precedent:
      precedent === undefined
        ? undefined
        : `${precedent.owner}/${precedent.repo}#${precedent.number}`,
    precedentApprovedBy: precedent?.approvedBy,
    review: review?.id,
    reviewCreated: review?.created,
    status: result.status,
  };
};
