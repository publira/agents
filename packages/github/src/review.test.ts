import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createGitHubClient } from "./client.ts";
import { dynamic, fakeGitHub } from "./fake-github.ts";
import { ensureReview } from "./review.ts";

const reviews = "/repos/publira/agents/pulls/7/reviews";
const bot = "publira-maintenance[bot]";

const options = {
  body: "Same update as publira/publira#3408.",
  commitId: "head",
  event: "APPROVE" as const,
  owner: "publira",
  pullNumber: 7,
  repo: "agents",
  reviewer: bot,
};

interface Review {
  body: string;
  commit_id: string;
  id: number;
  state: string;
  user: { login: string };
}

const createReviewBody = z.object({ body: z.string(), commit_id: z.string() });
const reviewStates = {
  APPROVE: "APPROVED",
  COMMENT: "COMMENTED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
};
const submitReviewBody = z.object({
  event: z.enum(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
});

const unprocessable = (message: string) =>
  Response.json({ message }, { status: 422 });

/**
 * The reviews of pull request 7, kept as GitHub keeps them: one pending
 * review per user, and only a pending review can be submitted or deleted.
 */
const reviewStore = (initial: Partial<Review>[] = []) => {
  let nextId = 100;
  const store: Review[] = initial.map((review, index) => ({
    body: "",
    commit_id: "head",
    id: index + 1,
    state: "APPROVED",
    user: { login: bot },
    ...review,
  }));
  const pendingReview = (id: number) =>
    store.find((review) => review.id === id && review.state === "PENDING");
  const createReview = dynamic(({ body }) => {
    if (
      store.some(({ state, user }) => state === "PENDING" && user.login === bot)
    ) {
      return unprocessable(
        "User can only have one pending review per pull request"
      );
    }
    const { body: text, commit_id: commitId } = createReviewBody.parse(body);
    const review = {
      body: text,
      commit_id: commitId,
      id: nextId,
      state: "PENDING",
      user: { login: bot },
    };
    nextId += 1;
    store.push(review);
    return { ...review };
  });
  const submitReview = (id: number) =>
    dynamic(({ body }) => {
      const review = pendingReview(id);
      if (review === undefined) {
        return unprocessable("Can not submit a non-pending review");
      }
      review.state = reviewStates[submitReviewBody.parse(body).event];
      return { ...review };
    });
  const deleteReview = (id: number) =>
    dynamic(() => {
      const review = pendingReview(id);
      if (review === undefined) {
        return unprocessable("Can not delete a non-pending review");
      }
      store.splice(store.indexOf(review), 1);
      return { ...review };
    });
  const routes = Object.fromEntries([
    [`GET ${reviews}`, dynamic(() => store.map((review) => ({ ...review })))],
    [`POST ${reviews}`, createReview],
    ...[1, 2, 100, 101].flatMap((id) => [
      [`POST ${reviews}/${id}/events`, submitReview(id)],
      [`DELETE ${reviews}/${id}`, deleteReview(id)],
    ]),
  ]);

  return { github: fakeGitHub(routes), store };
};

describe(ensureReview, () => {
  it("submits a review of the commit", async () => {
    const { github, store } = reviewStore();

    await expect(
      ensureReview(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: true, id: 100 });
    expect(store).toStrictEqual([
      {
        body: "Same update as publira/publira#3408.",
        commit_id: "head",
        id: 100,
        state: "APPROVED",
        user: { login: bot },
      },
    ]);
    expect(github.requests.at(-1)?.body).toStrictEqual({
      body: "Same update as publira/publira#3408.",
      event: "APPROVE",
    });
  });

  it("leaves a review the reviewer already submitted", async () => {
    const { github } = reviewStore([{ id: 5 }]);

    await expect(
      ensureReview(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: false, id: 5 });
    expect(github.routes).toStrictEqual([`GET ${reviews}`]);
  });

  it("does not submit a review again after it was dismissed", async () => {
    const { github } = reviewStore([{ id: 5, state: "DISMISSED" }]);

    await expect(
      ensureReview(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: false, id: 5 });
  });

  it.each([
    ["another reviewer", { user: { login: "yykamei" } }],
    ["another commit", { commit_id: "old-head" }],
    ["another outcome", { state: "COMMENTED" }],
  ])("does not count a review by %s", async (_label, overrides) => {
    const { github } = reviewStore([overrides]);

    await expect(
      ensureReview(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: true, id: 100 });
  });

  it("submits one review between concurrent runs", async () => {
    const { github, store } = reviewStore();
    const octokit = createGitHubClient({ fetch: github.fetch });

    const results = await Promise.all([
      ensureReview(octokit, options),
      ensureReview(octokit, options),
    ]);

    expect(store.map(({ id, state }) => ({ id, state }))).toStrictEqual([
      { id: 100, state: "APPROVED" },
    ]);
    expect(results.map(({ created }) => created).toSorted()).toStrictEqual([
      false,
      true,
    ]);
    expect(results.map(({ id }) => id)).toStrictEqual([100, 100]);
    expect(github.routes).not.toContain(`DELETE ${reviews}/100`);
  });

  it("does not submit another run's pending review of another commit", async () => {
    const { github, store } = reviewStore();
    const octokit = createGitHubClient({ fetch: github.fetch });

    const results = await Promise.allSettled([
      ensureReview(octokit, { ...options, commitId: "old-head" }),
      ensureReview(octokit, options),
    ]);

    expect(results.map(({ status }) => status)).toStrictEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      store.map(({ commit_id: commit, state }) => ({ commit, state }))
    ).toStrictEqual([{ commit: "old-head", state: "APPROVED" }]);
  });

  it("submits a pending review a failed run left for the commit", async () => {
    const { github, store } = reviewStore([{ id: 2, state: "PENDING" }]);

    await expect(
      ensureReview(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: true, id: 2 });
    expect(store.map(({ id, state }) => ({ id, state }))).toStrictEqual([
      { id: 2, state: "APPROVED" },
    ]);
  });

  it("replaces a pending review a failed run left for another commit", async () => {
    const { github, store } = reviewStore([
      { commit_id: "old-head", id: 2, state: "PENDING" },
    ]);

    await expect(
      ensureReview(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: true, id: 100 });
    expect(
      store.map(({ commit_id: commit, id, state }) => ({ commit, id, state }))
    ).toStrictEqual([{ commit: "head", id: 100, state: "APPROVED" }]);
  });
});
