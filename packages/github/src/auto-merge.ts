import type { Octokit } from "@octokit/rest";
import { z } from "zod";

import { graphqlActor, restLogin } from "./actor.ts";
import type { BranchLocation } from "./checks.ts";
import type { PullRequestLocation } from "./pull-request-editor.ts";

export type MergeMethod = "MERGE" | "REBASE" | "SQUASH";

export interface PullRequestMergeState {
  /** The pull request's node ID, which the GraphQL mutations take. */
  id: string;
  /** `OPEN`, `CLOSED`, or `MERGED`. */
  state: string;
  /** The branch it merges into. */
  baseRef: string;
  headSha: string;
  /**
   * How GitHub sees the merge, such as `CLEAN`, `BLOCKED`, or `DIRTY` for a
   * conflict. `UNKNOWN` while GitHub computes it.
   */
  mergeStateStatus: string;
  /** Auto-merge as enabled, `null` when it is not. */
  autoMerge: {
    /** The REST-style login of who enabled it; `null` for a deleted account. */
    enabledBy: string | null;
    enabledAt: Date;
  } | null;
  /** The pull request's entry in the merge queue, `null` outside it. */
  mergeQueueEntry: {
    /** The REST-style login of who queued it; `null` for a deleted account. */
    enqueuedBy: string | null;
    enqueuedAt: Date;
  } | null;
  repository: {
    autoMergeAllowed: boolean;
    /** The merge methods the repository's settings allow. */
    mergeMethods: MergeMethod[];
  };
}

const mergeStateResponse = z.object({
  repository: z.object({
    autoMergeAllowed: z.boolean(),
    mergeCommitAllowed: z.boolean(),
    pullRequest: z.object({
      autoMergeRequest: z
        .object({
          enabledAt: z.iso.datetime(),
          enabledBy: graphqlActor.nullable(),
        })
        .nullable(),
      baseRefName: z.string(),
      headRefOid: z.string(),
      id: z.string(),
      mergeQueueEntry: z
        .object({
          enqueuedAt: z.iso.datetime(),
          enqueuer: graphqlActor.nullable(),
        })
        .nullable(),
      mergeStateStatus: z.string(),
      state: z.string(),
    }),
    rebaseMergeAllowed: z.boolean(),
    squashMergeAllowed: z.boolean(),
  }),
});

/**
 * Reads what decides how a pull request can be merged: its head, how GitHub
 * sees the merge, whether auto-merge is on or it is queued and by whom, and
 * the repository's merge settings. Only GraphQL exposes all of it.
 */
export const getPullRequestMergeState = async (
  octokit: Octokit,
  { owner, repo, pullNumber }: PullRequestLocation
): Promise<PullRequestMergeState> => {
  const response = await octokit.graphql(
    `query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        autoMergeAllowed
        mergeCommitAllowed
        rebaseMergeAllowed
        squashMergeAllowed
        pullRequest(number: $number) {
          id
          state
          baseRefName
          headRefOid
          mergeStateStatus
          autoMergeRequest {
            enabledAt
            enabledBy { __typename login }
          }
          mergeQueueEntry {
            enqueuedAt
            enqueuer { __typename login }
          }
        }
      }
    }`,
    { number: pullNumber, owner, repo }
  );
  const { repository } = mergeStateResponse.parse(response);
  const { pullRequest } = repository;
  const allowed: [MergeMethod, boolean][] = [
    ["MERGE", repository.mergeCommitAllowed],
    ["REBASE", repository.rebaseMergeAllowed],
    ["SQUASH", repository.squashMergeAllowed],
  ];

  return {
    autoMerge:
      pullRequest.autoMergeRequest === null
        ? null
        : {
            enabledAt: new Date(pullRequest.autoMergeRequest.enabledAt),
            enabledBy:
              pullRequest.autoMergeRequest.enabledBy === null
                ? null
                : restLogin(pullRequest.autoMergeRequest.enabledBy),
          },
    baseRef: pullRequest.baseRefName,
    headSha: pullRequest.headRefOid,
    id: pullRequest.id,
    mergeQueueEntry:
      pullRequest.mergeQueueEntry === null
        ? null
        : {
            enqueuedAt: new Date(pullRequest.mergeQueueEntry.enqueuedAt),
            enqueuedBy:
              pullRequest.mergeQueueEntry.enqueuer === null
                ? null
                : restLogin(pullRequest.mergeQueueEntry.enqueuer),
          },
    mergeStateStatus: pullRequest.mergeStateStatus,
    repository: {
      autoMergeAllowed: repository.autoMergeAllowed,
      mergeMethods: allowed
        .filter(([, isAllowed]) => isAllowed)
        .map(([method]) => method),
    },
    state: pullRequest.state,
  };
};

/** Parses the messages out of the error a failed GraphQL request throws. */
export const graphqlRequestFailure = z
  .object({ errors: z.array(z.object({ message: z.string() })) })
  .transform(({ errors }) => errors.map(({ message }) => message));

// GitHub refuses to enable auto-merge on a pull request that can be merged
// already, with "Pull request is in clean status".
const CLEAN_STATUS = /\bclean status\b/iu;

export interface EnablePullRequestAutoMergeOptions {
  pullRequestId: string;
  /** The head the decision was made for. GitHub refuses any other. */
  expectedHeadSha: string;
  /** Ignored when the base branch merges through a merge queue. */
  mergeMethod: MergeMethod;
}

/**
 * Enables GitHub's auto-merge on a pull request, for the expected head only.
 * GitHub then merges it, or adds it to the merge queue, once the branch's
 * rules are satisfied. Returns `already-mergeable` when GitHub refuses
 * because nothing is left to wait for, which it does not take auto-merge for.
 */
export const enablePullRequestAutoMerge = async (
  octokit: Octokit,
  {
    pullRequestId,
    expectedHeadSha,
    mergeMethod,
  }: EnablePullRequestAutoMergeOptions
): Promise<"already-mergeable" | "enabled"> => {
  try {
    await octokit.graphql(
      `mutation ($pullRequestId: ID!, $expectedHeadOid: GitObjectID!, $mergeMethod: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $pullRequestId
          expectedHeadOid: $expectedHeadOid
          mergeMethod: $mergeMethod
        }) { clientMutationId }
      }`,
      { expectedHeadOid: expectedHeadSha, mergeMethod, pullRequestId }
    );
    return "enabled";
  } catch (error) {
    const messages = graphqlRequestFailure.safeParse(error).data ?? [];

    if (messages.some((message) => CLEAN_STATUS.test(message))) {
      return "already-mergeable";
    }
    throw error;
  }
};

/** Disables auto-merge on a pull request. */
export const disablePullRequestAutoMerge = async (
  octokit: Octokit,
  pullRequestId: string
): Promise<void> => {
  await octokit.graphql(
    `mutation ($pullRequestId: ID!) {
      disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
        clientMutationId
      }
    }`,
    { pullRequestId }
  );
};

export interface EnqueuePullRequestOptions {
  pullRequestId: string;
  /** The head the decision was made for. GitHub refuses any other. */
  expectedHeadSha: string;
}

/** Adds a pull request to the back of the merge queue, for the expected head only. */
export const enqueuePullRequest = async (
  octokit: Octokit,
  { pullRequestId, expectedHeadSha }: EnqueuePullRequestOptions
): Promise<void> => {
  await octokit.graphql(
    `mutation ($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
      enqueuePullRequest(input: {
        pullRequestId: $pullRequestId
        expectedHeadOid: $expectedHeadOid
      }) { clientMutationId }
    }`,
    { expectedHeadOid: expectedHeadSha, pullRequestId }
  );
};

/** Removes a pull request from the merge queue. */
export const dequeuePullRequest = async (
  octokit: Octokit,
  pullRequestId: string
): Promise<void> => {
  await octokit.graphql(
    `mutation ($pullRequestId: ID!) {
      dequeuePullRequest(input: { id: $pullRequestId }) { clientMutationId }
    }`,
    { pullRequestId }
  );
};

export interface BranchMergeRules {
  /** The most approving reviews any ruleset requires; 0 when none does. */
  requiredApprovingReviewCount: number;
  /** Whether a push dismisses the approvals given before it. */
  dismissesStaleReviewsOnPush: boolean;
  /**
   * The merge methods every ruleset allows, `undefined` when none restricts
   * them.
   */
  allowedMergeMethods: MergeMethod[] | undefined;
  /** Whether the branch merges through a merge queue. */
  mergeQueue: boolean;
}

const MERGE_METHODS = {
  merge: "MERGE",
  rebase: "REBASE",
  squash: "SQUASH",
} as const satisfies Record<string, MergeMethod>;

/**
 * Reads the rules the repository's and organization's rulesets set on merging
 * into a branch. Where several rulesets apply, the strictest value of each
 * holds, as GitHub enforces them. Classic branch protection is not read: it needs the
 * Administration permission.
 */
export const getBranchMergeRules = async (
  octokit: Octokit,
  { owner, repo, branch }: BranchLocation
): Promise<BranchMergeRules> => {
  const rules = await octokit.paginate(octokit.rest.repos.getBranchRules, {
    branch,
    owner,
    per_page: 100,
    repo,
  });
  const merged: BranchMergeRules = {
    allowedMergeMethods: undefined,
    dismissesStaleReviewsOnPush: false,
    mergeQueue: false,
    requiredApprovingReviewCount: 0,
  };

  for (const rule of rules) {
    if (rule.type === "merge_queue") {
      merged.mergeQueue = true;
    } else if (rule.type === "pull_request" && rule.parameters !== undefined) {
      const {
        allowed_merge_methods: methods,
        dismiss_stale_reviews_on_push: dismisses,
        required_approving_review_count: count,
      } = rule.parameters;

      merged.requiredApprovingReviewCount = Math.max(
        merged.requiredApprovingReviewCount,
        count
      );
      merged.dismissesStaleReviewsOnPush ||= dismisses;
      if (methods !== undefined) {
        const allowed = methods.map((method) => MERGE_METHODS[method]);
        merged.allowedMergeMethods =
          merged.allowedMergeMethods?.filter((method) =>
            allowed.includes(method)
          ) ?? allowed;
      }
    }
  }

  return merged;
};
