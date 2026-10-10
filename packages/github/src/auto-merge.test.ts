import { describe, expect, it } from "vitest";

import {
  disablePullRequestAutoMerge,
  enablePullRequestAutoMerge,
  getBranchMergeRules,
  getPullRequestMergeState,
  graphqlRequestFailure,
} from "./auto-merge.ts";
import { createGitHubClient } from "./client.ts";
import { dynamic, fakeGitHub } from "./fake-github.ts";

const location = { owner: "publira", pullNumber: 31, repo: "agents" };

describe(getPullRequestMergeState, () => {
  it("reads the merge state with REST-style logins", async () => {
    const github = fakeGitHub({
      "POST /graphql": {
        data: {
          repository: {
            autoMergeAllowed: true,
            mergeCommitAllowed: false,
            pullRequest: {
              autoMergeRequest: {
                enabledAt: "2026-10-04T06:00:01Z",
                enabledBy: { __typename: "Bot", login: "chachamaru-bot" },
              },
              baseRefName: "main",
              headRefOid: "head",
              id: "PR_1",
              mergeQueueEntry: null,
              mergeStateStatus: "BLOCKED",
              state: "OPEN",
            },
            rebaseMergeAllowed: true,
            squashMergeAllowed: true,
          },
        },
      },
    });

    await expect(
      getPullRequestMergeState(
        createGitHubClient({ fetch: github.fetch }),
        location
      )
    ).resolves.toStrictEqual({
      autoMerge: {
        enabledAt: new Date("2026-10-04T06:00:01Z"),
        enabledBy: "chachamaru-bot[bot]",
      },
      baseRef: "main",
      headSha: "head",
      id: "PR_1",
      mergeQueueEntry: null,
      mergeStateStatus: "BLOCKED",
      repository: {
        autoMergeAllowed: true,
        mergeMethods: ["REBASE", "SQUASH"],
      },
      state: "OPEN",
    });
    expect(github.requests[0]?.body).toMatchObject({
      variables: { number: 31, owner: "publira", repo: "agents" },
    });
  });
});

describe(enablePullRequestAutoMerge, () => {
  const options = {
    expectedHeadSha: "head",
    mergeMethod: "SQUASH" as const,
    pullRequestId: "PR_1",
  };

  it("enables auto-merge for the expected head", async () => {
    const github = fakeGitHub({
      "POST /graphql": {
        data: { enablePullRequestAutoMerge: { clientMutationId: null } },
      },
    });

    await expect(
      enablePullRequestAutoMerge(
        createGitHubClient({ fetch: github.fetch }),
        options
      )
    ).resolves.toBe("enabled");
    expect(github.requests[0]?.body).toMatchObject({
      variables: {
        expectedHeadOid: "head",
        mergeMethod: "SQUASH",
        pullRequestId: "PR_1",
      },
    });
  });

  it("tells a pull request GitHub can merge already", async () => {
    const github = fakeGitHub({
      "POST /graphql": {
        data: null,
        errors: [{ message: "Pull request Pull request is in clean status" }],
      },
    });

    await expect(
      enablePullRequestAutoMerge(
        createGitHubClient({ fetch: github.fetch }),
        options
      )
    ).resolves.toBe("already-mergeable");
  });

  it("throws any other refusal, with its messages", async () => {
    const github = fakeGitHub({
      "POST /graphql": {
        data: null,
        errors: [{ message: "Head sha didn't match expected head sha" }],
      },
    });

    await expect(
      enablePullRequestAutoMerge(
        createGitHubClient({ fetch: github.fetch }),
        options
      )
    ).rejects.toMatchObject({
      errors: [{ message: "Head sha didn't match expected head sha" }],
    });
  });
});

describe(disablePullRequestAutoMerge, () => {
  it("disables auto-merge on the pull request", async () => {
    const github = fakeGitHub({
      "POST /graphql": dynamic(() => ({
        data: { disablePullRequestAutoMerge: { clientMutationId: null } },
      })),
    });

    await disablePullRequestAutoMerge(
      createGitHubClient({ fetch: github.fetch }),
      "PR_1"
    );

    expect(github.requests[0]?.body).toMatchObject({
      query: expect.stringContaining("disablePullRequestAutoMerge"),
      variables: { pullRequestId: "PR_1" },
    });
  });
});

describe("a failed GraphQL request", () => {
  it("parses its messages", () => {
    expect(
      graphqlRequestFailure.parse({ errors: [{ message: "Not allowed" }] })
    ).toStrictEqual(["Not allowed"]);
  });

  it("refuses another error", () => {
    expect(
      graphqlRequestFailure.safeParse(new Error("socket hang up")).success
    ).toBeFalsy();
  });
});

const rulesOf = (rules: Parameters<typeof fakeGitHub>[0][string]) =>
  getBranchMergeRules(
    createGitHubClient({
      fetch: fakeGitHub({
        "GET /repos/publira/agents/rules/branches/main": rules,
      }).fetch,
    }),
    { branch: "main", owner: "publira", repo: "agents" }
  );

describe(getBranchMergeRules, () => {
  it("takes the strictest value of every ruleset", async () => {
    await expect(
      rulesOf([
        { type: "deletion" },
        {
          parameters: {
            allowed_merge_methods: ["merge", "squash"],
            dismiss_stale_reviews_on_push: true,
            required_approving_review_count: 1,
          },
          type: "pull_request",
        },
        {
          parameters: {
            allowed_merge_methods: ["squash", "rebase"],
            dismiss_stale_reviews_on_push: false,
            required_approving_review_count: 2,
          },
          type: "pull_request",
        },
        { parameters: { merge_method: "SQUASH" }, type: "merge_queue" },
      ])
    ).resolves.toStrictEqual({
      allowedMergeMethods: ["SQUASH"],
      dismissesStaleReviewsOnPush: true,
      mergeQueue: true,
      requiredApprovingReviewCount: 2,
    });
  });

  it("requires nothing without a ruleset", async () => {
    await expect(rulesOf([])).resolves.toStrictEqual({
      allowedMergeMethods: undefined,
      dismissesStaleReviewsOnPush: false,
      mergeQueue: false,
      requiredApprovingReviewCount: 0,
    });
  });
});
