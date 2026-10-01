import { describe, expect, it } from "vitest";

import { createGitHubClient } from "./client.ts";
import { fakeGitHub } from "./fake-github.ts";
import { ensureReview } from "./review.ts";

const reviews = "/repos/publira/agents/pulls/7/reviews";

const options = {
  body: "Same update as publira/publira#3408.",
  commitId: "head",
  event: "APPROVE" as const,
  owner: "publira",
  pullNumber: 7,
  repo: "agents",
  reviewer: "publira-maintenance[bot]",
};

interface Review {
  commit_id: string;
  id: number;
  state: string;
  user: { login: string };
}

const review = (overrides: Partial<Review>) => ({
  commit_id: "head",
  id: 1,
  state: "APPROVED",
  user: { login: "publira-maintenance[bot]" },
  ...overrides,
});

describe(ensureReview, () => {
  it("submits a review of the commit", async () => {
    const github = fakeGitHub({
      [`GET ${reviews}`]: [],
      [`POST ${reviews}`]: { id: 9 },
    });

    await expect(
      ensureReview(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: true, id: 9 });
    expect(github.requests.at(-1)?.body).toStrictEqual({
      body: "Same update as publira/publira#3408.",
      commit_id: "head",
      event: "APPROVE",
    });
  });

  it("leaves a review the reviewer already submitted", async () => {
    const github = fakeGitHub({ [`GET ${reviews}`]: [review({ id: 5 })] });

    await expect(
      ensureReview(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: false, id: 5 });
    expect(github.routes).toStrictEqual([`GET ${reviews}`]);
  });

  it("does not submit a review again after it was dismissed", async () => {
    const github = fakeGitHub({
      [`GET ${reviews}`]: [review({ id: 5, state: "DISMISSED" })],
    });

    await expect(
      ensureReview(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: false, id: 5 });
  });

  it.each([
    ["another reviewer", { user: { login: "yykamei" } }],
    ["another commit", { commit_id: "old-head" }],
    ["another outcome", { state: "COMMENTED" }],
  ])("does not count a review by %s", async (_label, overrides) => {
    const github = fakeGitHub({
      [`GET ${reviews}`]: [review(overrides)],
      [`POST ${reviews}`]: { id: 9 },
    });

    await expect(
      ensureReview(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: true, id: 9 });
  });
});
