import { describe, expect, it } from "vitest";

import {
  evaluateCommitChecks,
  evaluateRenovateCommits,
  findPrecedentApproval,
  isRenovate,
} from "./equivalent-update-approval.ts";
import type { PullRequestReview } from "./equivalent-update-approval.ts";

describe(isRenovate, () => {
  it("accepts Renovate's bot account", () => {
    expect(isRenovate({ login: "renovate[bot]", type: "Bot" })).toBeTruthy();
  });

  it.each([
    { login: "renovate", type: "User" },
    { login: "dependabot[bot]", type: "Bot" },
    { login: "renovate[bot]", type: "User" },
  ])("refuses $login ($type)", (account) => {
    expect(isRenovate(account)).toBeFalsy();
  });

  it("refuses a deleted account", () => {
    expect(isRenovate(null)).toBeFalsy();
  });
});

const renovateCommit = (sha: string) => ({
  authorLogin: "renovate[bot]",
  committerLogin: "web-flow",
  sha,
  verified: true,
});

describe(evaluateRenovateCommits, () => {
  it("accepts commits Renovate made through GitHub's API", () => {
    expect(
      evaluateRenovateCommits([renovateCommit("a"), renovateCommit("b")], "b")
    ).toStrictEqual({ count: 2, result: "renovate-only" });
  });

  it("accepts commits Renovate committed itself", () => {
    expect(
      evaluateRenovateCommits(
        [{ ...renovateCommit("a"), committerLogin: "renovate[bot]" }],
        "a"
      )
    ).toStrictEqual({ count: 1, result: "renovate-only" });
  });

  it("refuses a commit someone pushed on top", () => {
    expect(
      evaluateRenovateCommits(
        [
          renovateCommit("a"),
          {
            ...renovateCommit("b"),
            authorLogin: "ykzts",
            committerLogin: "ykzts",
          },
        ],
        "b"
      )
    ).toStrictEqual({ problem: "author", result: "foreign-commit", sha: "b" });
  });

  it("refuses a Renovate commit someone else committed", () => {
    expect(
      evaluateRenovateCommits(
        [{ ...renovateCommit("a"), committerLogin: "ykzts" }],
        "a"
      )
    ).toStrictEqual({
      problem: "committer",
      result: "foreign-commit",
      sha: "a",
    });
  });

  it("refuses an unsigned commit", () => {
    expect(
      evaluateRenovateCommits(
        [{ ...renovateCommit("a"), verified: false }],
        "a"
      )
    ).toStrictEqual({
      problem: "unverified",
      result: "foreign-commit",
      sha: "a",
    });
  });

  it("refuses commits that end before the head", () => {
    expect(evaluateRenovateCommits([renovateCommit("a")], "b")).toStrictEqual({
      headSha: "a",
      result: "stale",
    });
  });

  it("refuses a pull request without commits", () => {
    expect(evaluateRenovateCommits([], "a")).toStrictEqual({
      result: "no-commits",
    });
  });
});

const ACTIONS = 15_368;

const run = (name: string, conclusion: string | null = "success") => ({
  appId: ACTIONS,
  conclusion,
  name,
  status: conclusion === null ? "in_progress" : "completed",
});

describe(evaluateCommitChecks, () => {
  it("passes when every check passed and the required ones are there", () => {
    expect(
      evaluateCommitChecks({
        checkRuns: [run("Lint"), run("Test"), run("Docs", "skipped")],
        required: [
          { context: "Lint", integrationId: ACTIONS },
          { context: "renovate/stability-days", integrationId: undefined },
        ],
        statuses: [{ context: "renovate/stability-days", state: "success" }],
      })
    ).toStrictEqual({ count: 4, required: 2, result: "passed" });
  });

  it("fails when any check failed, required or not", () => {
    expect(
      evaluateCommitChecks({
        checkRuns: [run("Lint"), run("Preview", "failure")],
        required: [{ context: "Lint", integrationId: ACTIONS }],
        statuses: [{ context: "vercel", state: "error" }],
      })
    ).toStrictEqual({ names: ["Preview", "vercel"], result: "failed" });
  });

  it("waits for checks still running", () => {
    expect(
      evaluateCommitChecks({
        checkRuns: [run("Lint"), run("Test", null)],
        required: [],
        statuses: [{ context: "renovate/stability-days", state: "pending" }],
      })
    ).toStrictEqual({
      names: ["Test", "renovate/stability-days"],
      result: "pending",
    });
  });

  it("waits for a required check nobody reported yet", () => {
    expect(
      evaluateCommitChecks({
        checkRuns: [run("Lint")],
        required: [
          { context: "Lint", integrationId: ACTIONS },
          { context: "Build", integrationId: ACTIONS },
        ],
        statuses: [],
      })
    ).toStrictEqual({ names: ["Build"], result: "required-missing" });
  });

  it("requires a check from the App the rule names", () => {
    expect(
      evaluateCommitChecks({
        checkRuns: [{ ...run("Lint"), appId: 1 }],
        required: [{ context: "Lint", integrationId: ACTIONS }],
        statuses: [{ context: "Lint", state: "success" }],
      })
    ).toStrictEqual({ names: ["Lint"], result: "required-missing" });
  });

  it("does not pass a commit without checks", () => {
    expect(
      evaluateCommitChecks({ checkRuns: [], required: [], statuses: [] })
    ).toStrictEqual({ result: "no-checks" });
  });
});

const MERGED_AT = new Date("2026-10-04T05:47:28Z");

const approval: PullRequestReview = {
  authorAssociation: "MEMBER",
  commitId: "head",
  state: "APPROVED",
  submittedAt: new Date("2026-10-04T05:45:44Z"),
  user: { login: "ykzts", type: "User" },
};

describe(findPrecedentApproval, () => {
  it("finds a maintainer's approval of the merged head", () => {
    expect(
      findPrecedentApproval({
        headSha: "head",
        mergedAt: MERGED_AT,
        reviews: [
          {
            ...approval,
            state: "COMMENTED",
            user: { login: "a", type: "User" },
          },
          approval,
        ],
      })
    ).toBe(approval);
  });

  it.each([
    [
      "a bot's approval",
      { user: { login: "publira-maintenance[bot]", type: "Bot" } },
    ],
    [
      "an approval by someone outside the repository",
      { authorAssociation: "NONE" },
    ],
    ["an approval of an earlier head", { commitId: "earlier" }],
    ["a dismissed approval", { state: "DISMISSED" }],
    [
      "an approval after the merge",
      { submittedAt: new Date("2026-10-04T06:00:00Z") },
    ],
    ["a review asking for changes", { state: "CHANGES_REQUESTED" }],
  ] as const)("does not count %s", (_, change) => {
    expect(
      findPrecedentApproval({
        headSha: "head",
        mergedAt: MERGED_AT,
        reviews: [{ ...approval, ...change }],
      })
    ).toBeUndefined();
  });
});
