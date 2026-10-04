import {
  dequeuePullRequest,
  disablePullRequestAutoMerge,
  enablePullRequestAutoMerge,
  enqueuePullRequest,
  getBranchMergeRules,
  getPullRequestMergeState,
  graphqlRequestFailure,
} from "@publira/github";
import type { Octokit, PullRequestMergeState } from "@publira/github";
import { canAutoMerge } from "@publira/maintenance-policies";
import type {
  ApprovalPolicyVerdict,
  MergeMethod,
} from "@publira/maintenance-policies";
import { z } from "zod";

import type { LogFields } from "../log.ts";
import { approveEquivalentRenovateUpdate } from "./approve-equivalent-renovate-update.ts";
import type {
  ApproveEquivalentRenovateUpdateResult,
  PrecedentScanCache,
} from "./approve-equivalent-renovate-update.ts";

/** What became of the pull request. */
export type AutoMergeOutcome =
  | {
      /** The pull request is not open. */
      status: "closed";
    }
  | {
      /** Auto-merge is off, and the bot had nothing to take back. */
      status: "disabled";
    }
  | {
      /** Auto-merge is off, and the bot took back what it had enabled. */
      status: "withdrawn";
      reason: string;
    }
  | {
      /**
       * The bot's auto-merge or queue entry for this head stands, and the
       * decision, made again, still holds.
       */
      status: "pending";
    }
  | { status: "declined"; reason: string }
  | {
      /** GitHub refused to merge, enable auto-merge, or queue it. */
      status: "refused";
      reason: string;
    }
  | { status: "would-merge"; mergeMethod: MergeMethod; mergeQueue: boolean }
  | { status: "enabled" | "enqueued" | "merged"; mergeMethod: MergeMethod };

export type AutoMergeRenovateUpdateResult = {
  headSha: string;
  /**
   * Why the bot took back its auto-merge or queue entry of an earlier
   * decision before it decided again; a dry run only tells it.
   */
  withdrew?: string;
} & AutoMergeOutcome;

export interface AutoMergeRenovateUpdateOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  /** The bot's login, which approves and merges. */
  reviewer: string | undefined;
  /** Whether auto-merge is on; see `readRenovateAutoMerge`. */
  enabled: boolean;
  /** Decides without changing anything. */
  dryRun?: boolean;
  precedentScanCache?: PrecedentScanCache;
  /** Replaced in tests. */
  approve?: typeof approveEquivalentRenovateUpdate;
}

const shortSha = (sha: string) => sha.slice(0, 7);

const REST_MERGE_METHODS = {
  MERGE: "merge",
  REBASE: "rebase",
  SQUASH: "squash",
} as const satisfies Record<MergeMethod, string>;

const WORKFLOWS_DIRECTORY = ".github/workflows/";

// The REST merge's refusals: not mergeable, head moved, or a rule in the way.
const REFUSED_STATUSES = new Set([405, 409, 422]);

// GitHub's reason for refusing to merge, to enable auto-merge, or to queue.
const refusal = z.union([
  graphqlRequestFailure.transform((messages) => messages.join("; ")),
  z
    .object({ message: z.string(), status: z.number() })
    .refine(({ status }) => REFUSED_STATUSES.has(status))
    .transform(({ message }) => message),
]);

const describeApproval = (
  result: ApproveEquivalentRenovateUpdateResult
): ApprovalPolicyVerdict => {
  if (result.status === "would-approve") {
    return { approvable: true, headSha: result.headSha };
  }
  const failed =
    result.status === "skipped"
      ? result.conditions.find(({ passed }) => !passed)
      : undefined;

  return {
    approvable: false,
    reason:
      failed === undefined
        ? result.status
        : `${failed.condition}: ${failed.detail}`,
  };
};

/**
 * When the bot's approval of the head was submitted, if it stands. The bot
 * submits one approval per head, so there is at most one.
 */
const findOwnApproval = async (
  { octokit, owner, repo, pullNumber }: AutoMergeRenovateUpdateOptions,
  reviewer: string | undefined,
  headSha: string
): Promise<Date | undefined> => {
  if (reviewer === undefined) {
    return undefined;
  }
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    per_page: 100,
    pull_number: pullNumber,
    repo,
  });
  const approval = reviews.find(
    (review) =>
      review.user?.login === reviewer &&
      review.commit_id === headSha &&
      review.state === "APPROVED" &&
      review.submitted_at !== undefined
  );

  return approval?.submitted_at === undefined
    ? undefined
    : new Date(approval.submitted_at);
};

interface OwnRequest {
  kind: "auto-merge" | "merge-queue";
  /** When the bot enabled auto-merge or queued the pull request. */
  since: Date;
}

const findOwnRequest = (
  state: PullRequestMergeState,
  reviewer: string | undefined
): OwnRequest | undefined => {
  if (reviewer === undefined) {
    return undefined;
  }
  if (state.autoMerge?.enabledBy === reviewer) {
    return {
      kind: "auto-merge",
      since: state.autoMerge.enabledAt,
    };
  }
  if (state.mergeQueueEntry?.enqueuedBy === reviewer) {
    return {
      kind: "merge-queue",
      since: state.mergeQueueEntry.enqueuedAt,
    };
  }
  return undefined;
};

/**
 * Why the bot's earlier decision no longer holds for the head, or
 * `undefined` when it does. The bot approves a head before it enables
 * auto-merge for it, so a decision made before the approval of the current
 * head was made for an earlier one. GitHub also drops a pull request from the
 * merge queue when its head moves.
 */
const staleReason = (
  request: OwnRequest,
  headSha: string,
  approvedAt: Date | undefined
): string | undefined => {
  if (approvedAt === undefined) {
    return `the bot's approval of the head ${shortSha(headSha)} does not stand`;
  }
  if (approvedAt.getTime() > request.since.getTime()) {
    return `it was decided for an earlier head than ${shortSha(headSha)}`;
  }
  return undefined;
};

const withdraw = async (
  options: AutoMergeRenovateUpdateOptions,
  state: PullRequestMergeState,
  request: OwnRequest
) => {
  const { octokit } = options;

  try {
    await (request.kind === "auto-merge"
      ? disablePullRequestAutoMerge(octokit, state.id)
      : dequeuePullRequest(octokit, state.id));
  } catch (error) {
    // A concurrent run, someone, or a push may have taken it back first.
    const latest = await getPullRequestMergeState(octokit, options);
    if (findOwnRequest(latest, options.reviewer) !== undefined) {
      throw error;
    }
  }
};

const changesWorkflows = async ({
  octokit,
  owner,
  repo,
  pullNumber,
}: AutoMergeRenovateUpdateOptions): Promise<boolean> => {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    per_page: 100,
    pull_number: pullNumber,
    repo,
  });

  return files.some(
    ({ filename, previous_filename: previous }) =>
      filename.startsWith(WORKFLOWS_DIRECTORY) ||
      (previous?.startsWith(WORKFLOWS_DIRECTORY) ?? false)
  );
};

/**
 * Settles an auto-merge or queue entry that is already there. Returns the
 * outcome when there is nothing more to decide, the bot's own request when it
 * was made for this head, and otherwise why the bot took back its earlier
 * decision, if it did.
 */
const reconsider = async (
  options: AutoMergeRenovateUpdateOptions,
  state: PullRequestMergeState,
  approvedAt: Date | undefined
): Promise<
  | { outcome: AutoMergeOutcome }
  | { standing: OwnRequest }
  | { withdrew: string | undefined }
> => {
  const { enabled, dryRun = false, reviewer } = options;
  const request = findOwnRequest(state, reviewer);

  if (request === undefined) {
    if (state.autoMerge !== null) {
      return {
        outcome: {
          reason: `${state.autoMerge.enabledBy ?? "a deleted account"} already enabled auto-merge`,
          status: "declined",
        },
      };
    }
    if (state.mergeQueueEntry !== null) {
      return {
        outcome: {
          reason: `${state.mergeQueueEntry.enqueuedBy ?? "a deleted account"} already queued it`,
          status: "declined",
        },
      };
    }
    return { withdrew: undefined };
  }

  const withdrew = enabled
    ? staleReason(request, state.headSha, approvedAt)
    : "auto-merge is disabled";

  if (withdrew === undefined) {
    return { standing: request };
  }
  if (!dryRun) {
    await withdraw(options, state, request);
  }
  return enabled
    ? { withdrew }
    : { outcome: { reason: withdrew, status: "withdrawn" } };
};

/** Gathers what `canAutoMerge` decides on, and asks it. */
const decide = async (
  options: AutoMergeRenovateUpdateOptions,
  state: PullRequestMergeState,
  approvedAt: Date | undefined
) => {
  const {
    octokit,
    owner,
    repo,
    pullNumber,
    precedentScanCache,
    approve = approveEquivalentRenovateUpdate,
  } = options;
  const approvedByBot = approvedAt !== undefined;
  // The rest is read only when the bot's approval stands.
  const [approval, workflows, rules] = approvedByBot
    ? await Promise.all([
        approve({
          dryRun: true,
          octokit,
          owner,
          precedentScanCache,
          pullNumber,
          repo,
        }),
        changesWorkflows(options),
        getBranchMergeRules(octokit, { branch: state.baseRef, owner, repo }),
      ])
    : [];
  const verdict = canAutoMerge({
    approval: approval === undefined ? undefined : describeApproval(approval),
    approvedByBot,
    changesWorkflows: workflows ?? false,
    enabled: options.enabled,
    headSha: state.headSha,
    mergeStateStatus: state.mergeStateStatus,
    repository: state.repository,
    rules: rules ?? {
      allowedMergeMethods: undefined,
      dismissesStaleReviewsOnPush: false,
      requiredApprovingReviewCount: 0,
    },
  });

  return { mergeQueue: rules?.mergeQueue ?? false, verdict };
};

/**
 * Has GitHub merge the head: enables auto-merge, or, when GitHub answers
 * that nothing is left to wait for, queues it or merges it. GitHub refuses
 * each of them for any head but the one decided on.
 */
const merge = async (
  { octokit, owner, repo, pullNumber }: AutoMergeRenovateUpdateOptions,
  state: PullRequestMergeState,
  mergeMethod: MergeMethod,
  mergeQueue: boolean
): Promise<AutoMergeOutcome> => {
  const { headSha, id: pullRequestId } = state;

  try {
    const enabled = await enablePullRequestAutoMerge(octokit, {
      expectedHeadSha: headSha,
      mergeMethod,
      pullRequestId,
    });

    if (enabled === "enabled") {
      return { mergeMethod, status: "enabled" };
    }
    if (mergeQueue) {
      await enqueuePullRequest(octokit, {
        expectedHeadSha: headSha,
        pullRequestId,
      });
      return { mergeMethod, status: "enqueued" };
    }
    await octokit.rest.pulls.merge({
      merge_method: REST_MERGE_METHODS[mergeMethod],
      owner,
      pull_number: pullNumber,
      repo,
      sha: headSha,
    });
    return { mergeMethod, status: "merged" };
  } catch (error) {
    const reason = refusal.safeParse(error).data;
    if (reason === undefined) {
      throw error;
    }
    return { reason, status: "refused" };
  }
};

/**
 * Has GitHub merge a Renovate pull request the bot approved, when
 * `canAutoMerge` allows it. No model is asked.
 *
 * The decision is made afresh for the current head: the bot's approval of it
 * has to stand, and the approval policy has to hold on it again. The bot then
 * enables GitHub's auto-merge for that head only, so that GitHub merges it, or
 * queues it, once the branch's rules are satisfied. When GitHub answers that
 * nothing is left to wait for, the bot queues it, or merges it at that head,
 * through the same rules.
 *
 * A decision lasts for one head, and only while it holds: every evaluation
 * makes it again. When the head moves, the bot's approval of it is dismissed,
 * or the decision no longer holds, the bot takes back the auto-merge or the
 * queue entry it made. With auto-merge off, it only takes back its own.
 * Someone else's auto-merge or queue entry is left as it is.
 */
export const autoMergeRenovateUpdate = async (
  options: AutoMergeRenovateUpdateOptions
): Promise<AutoMergeRenovateUpdateResult> => {
  const { octokit, reviewer, enabled, dryRun = false } = options;
  const state = await getPullRequestMergeState(octokit, options);
  const { headSha } = state;

  if (state.state !== "OPEN") {
    return { headSha, status: "closed" };
  }
  if (!enabled && findOwnRequest(state, reviewer) === undefined) {
    return { headSha, status: "disabled" };
  }

  const approvedAt = await findOwnApproval(options, reviewer, headSha);
  const settled = await reconsider(options, state, approvedAt);

  if ("outcome" in settled) {
    return { headSha, ...settled.outcome };
  }

  const { mergeQueue, verdict } = await decide(options, state, approvedAt);

  // The bot's request for this head stands only while the decision does:
  // GitHub does not enforce the approval policy, such as who edited the
  // description or a check no ruleset requires.
  if ("standing" in settled) {
    if (verdict.result === "merge") {
      return { headSha, status: "pending" };
    }
    if (!dryRun) {
      await withdraw(options, state, settled.standing);
    }
    return {
      headSha,
      reason: verdict.reason,
      status: "declined",
      withdrew: `the decision no longer holds: ${verdict.reason}`,
    };
  }

  const decided = { headSha, withdrew: settled.withdrew };

  if (verdict.result === "declined") {
    return { ...decided, reason: verdict.reason, status: "declined" };
  }

  const { mergeMethod } = verdict;

  if (dryRun) {
    return { ...decided, mergeMethod, mergeQueue, status: "would-merge" };
  }
  return {
    ...decided,
    ...(await merge(options, state, mergeMethod, mergeQueue)),
  };
};

/** The fields of a result to log. */
export const summarizeAutoMergeResult = (
  result: AutoMergeRenovateUpdateResult
): LogFields => ({
  autoMerge: result.status,
  autoMergeReason: "reason" in result ? result.reason : undefined,
  autoMergeWithdrew: result.withdrew,
  headSha: result.headSha,
  mergeMethod: "mergeMethod" in result ? result.mergeMethod : undefined,
});
