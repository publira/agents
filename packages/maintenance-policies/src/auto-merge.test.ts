import { describe, expect, it } from "vitest";

import { canAutoMerge } from "./auto-merge.ts";
import type { AutoMergeInput } from "./auto-merge.ts";

const HEAD = "4658aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const input = (fields: Partial<AutoMergeInput> = {}): AutoMergeInput => ({
  approval: { approvable: true, headSha: HEAD },
  approvedByBot: true,
  changesWorkflows: false,
  enabled: true,
  headSha: HEAD,
  mergeStateStatus: "CLEAN",
  repository: { autoMergeAllowed: true, mergeMethods: ["MERGE", "SQUASH"] },
  rules: {
    allowedMergeMethods: undefined,
    dismissesStaleReviewsOnPush: true,
    requiredApprovingReviewCount: 1,
  },
  ...fields,
});

describe(canAutoMerge, () => {
  it("merges an approved head by squashing when that is allowed", () => {
    expect(canAutoMerge(input())).toStrictEqual({
      mergeMethod: "SQUASH",
      result: "merge",
    });
  });

  it("takes the method both the settings and the rulesets allow", () => {
    expect(
      canAutoMerge(
        input({
          rules: {
            allowedMergeMethods: ["MERGE", "REBASE"],
            dismissesStaleReviewsOnPush: true,
            requiredApprovingReviewCount: 1,
          },
        })
      )
    ).toStrictEqual({ mergeMethod: "MERGE", result: "merge" });
  });

  it.each([
    ["it is off", { enabled: false }, "auto-merge is disabled"],
    [
      "the bot's approval does not stand",
      { approvedByBot: false },
      "the bot's approval of 4658aaa does not stand",
    ],
    [
      "the approval policy was not evaluated",
      { approval: undefined },
      "the approval policy was not evaluated again",
    ],
    [
      "the approval policy fails",
      {
        approval: {
          approvable: false as const,
          reason: "checks: failed: Test",
        },
      },
      "the approval policy does not hold: checks: failed: Test",
    ],
    [
      "the policy held on another head",
      { approval: { approvable: true as const, headSha: "c0ffee0" } },
      "the approval policy was evaluated on c0ffee0, but the head is 4658aaa",
    ],
    ["it is conflicted", { mergeStateStatus: "DIRTY" }, "it has conflicts"],
    ["it is a draft", { mergeStateStatus: "DRAFT" }, "it is a draft"],
    [
      "it changes the workflows",
      { changesWorkflows: true },
      "it changes .github/workflows/, which the App cannot merge without the Workflows permission",
    ],
    [
      "no approval is required",
      {
        rules: {
          allowedMergeMethods: undefined,
          dismissesStaleReviewsOnPush: true,
          requiredApprovingReviewCount: 0,
        },
      },
      "the base branch's rulesets do not require an approval that a push dismisses, so GitHub would not hold back a new head",
    ],
    [
      "a push keeps the approval",
      {
        rules: {
          allowedMergeMethods: undefined,
          dismissesStaleReviewsOnPush: false,
          requiredApprovingReviewCount: 1,
        },
      },
      "the base branch's rulesets do not require an approval that a push dismisses, so GitHub would not hold back a new head",
    ],
    [
      "the repository does not allow auto-merge",
      { repository: { autoMergeAllowed: false, mergeMethods: ["SQUASH"] } },
      "the repository does not allow auto-merge",
    ],
    [
      "no merge method is allowed by both",
      {
        rules: {
          allowedMergeMethods: ["REBASE"],
          dismissesStaleReviewsOnPush: true,
          requiredApprovingReviewCount: 1,
        },
      },
      "no merge method is allowed by both the repository's settings and its rulesets",
    ],
  ] as const)("declines when %s", (_, fields, reason) => {
    expect(canAutoMerge(input(fields))).toStrictEqual({
      reason,
      result: "declined",
    });
  });
});
