import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createGitHubClient } from "./client.ts";
import { dynamic, fakeGitHub } from "./fake-github.ts";
import { ensureReview, minimizeOutdatedReviews } from "./review.ts";

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

interface ReviewNode {
  id: string;
  fullDatabaseId: string | null;
  state: string;
  isMinimized: boolean;
  author: { __typename: string; login: string } | null;
}

const graphqlRequest = z.object({
  query: z.string(),
  variables: z.record(z.string(), z.unknown()),
});

/**
 * The reviews of pull request 7 as GitHub's GraphQL API lists them, oldest
 * first and `perPage` at a time, and minimizes them. Review `n` has the
 * database ID `n`.
 */
const reviewNodeStore = (initial: Partial<ReviewNode>[], perPage = 100) => {
  const store: ReviewNode[] = initial.map((review, index) => ({
    author: { __typename: "Bot", login: "publira-maintenance" },
    fullDatabaseId: String(index + 1),
    id: `PRR_${index + 1}`,
    isMinimized: false,
    state: "APPROVED",
    ...review,
  }));
  const graphql = dynamic(({ body }) => {
    const { query, variables } = graphqlRequest.parse(body);

    if (query.includes("minimizeComment")) {
      const review = store.find(({ id }) => id === variables.id);
      if (review === undefined) {
        return { data: null, errors: [{ message: "Could not resolve" }] };
      }
      review.isMinimized = true;
      return { data: { minimizeComment: { clientMutationId: null } } };
    }

    const start = variables.after === null ? 0 : Number(variables.after);
    const end = start + perPage;
    return {
      data: {
        repository: {
          pullRequest: {
            reviews: {
              nodes: store.slice(start, end).map((review) => ({ ...review })),
              pageInfo: {
                endCursor: String(end),
                hasNextPage: end < store.length,
              },
            },
          },
        },
      },
    };
  });

  return { github: fakeGitHub({ "POST /graphql": graphql }), store };
};

const minimized = (requests: { body: unknown }[]) =>
  requests.flatMap(({ body }) => {
    const { query, variables } = graphqlRequest.parse(body);
    return query.includes("minimizeComment") ? [variables.id] : [];
  });

describe(minimizeOutdatedReviews, () => {
  // The reviewer just submitted review 3.
  const location = {
    owner: "publira",
    pullNumber: 7,
    repo: "agents",
    reviewId: 3,
    reviewer: bot,
  };

  it("minimizes the reviewer's earlier reviews as outdated", async () => {
    const { github, store } = reviewNodeStore([
      { state: "DISMISSED" },
      { state: "APPROVED" },
      { state: "APPROVED" },
    ]);

    await expect(
      minimizeOutdatedReviews(
        createGitHubClient({ fetch: github.fetch }),
        location
      )
    ).resolves.toBe(2);
    expect(store.map(({ isMinimized }) => isMinimized)).toStrictEqual([
      true,
      true,
      false,
    ]);
    expect(github.requests.at(-1)?.body).toMatchObject({
      query: expect.stringContaining("classifier: OUTDATED"),
      variables: { id: "PRR_2" },
    });
  });

  it("leaves a review submitted after the given one, such as of a newer head", async () => {
    const { github } = reviewNodeStore([{}, {}, {}, {}]);

    await expect(
      minimizeOutdatedReviews(
        createGitHubClient({ fetch: github.fetch }),
        location
      )
    ).resolves.toBe(2);
    expect(minimized(github.requests)).toStrictEqual(["PRR_1", "PRR_2"]);
  });

  it("compares review IDs as numbers", async () => {
    const { github } = reviewNodeStore([
      { fullDatabaseId: "9" },
      { fullDatabaseId: "12345678901234567890" },
    ]);

    await minimizeOutdatedReviews(createGitHubClient({ fetch: github.fetch }), {
      ...location,
      reviewId: 10,
    });

    expect(minimized(github.requests)).toStrictEqual(["PRR_1"]);
  });

  it.each([
    ["another user", { author: { __typename: "User", login: "ykzts" } }],
    ["another bot", { author: { __typename: "Bot", login: "renovate" } }],
    ["a deleted account", { author: null }],
    ["the reviewer, already minimized", { isMinimized: true }],
    ["the reviewer, still pending", { state: "PENDING" }],
    ["the reviewer, without an ID", { fullDatabaseId: null }],
  ])("leaves a review by %s", async (_label, overrides) => {
    const { github } = reviewNodeStore([overrides]);

    await expect(
      minimizeOutdatedReviews(
        createGitHubClient({ fetch: github.fetch }),
        location
      )
    ).resolves.toBe(0);
    expect(minimized(github.requests)).toStrictEqual([]);
  });

  it("reads every page of the reviews", async () => {
    const { github } = reviewNodeStore([{}, {}, {}], 2);

    await expect(
      minimizeOutdatedReviews(
        createGitHubClient({ fetch: github.fetch }),
        location
      )
    ).resolves.toBe(2);
    expect(minimized(github.requests)).toStrictEqual(["PRR_1", "PRR_2"]);
  });

  it("changes nothing when run again", async () => {
    const { github } = reviewNodeStore([{}, {}, {}]);
    const octokit = createGitHubClient({ fetch: github.fetch });

    await minimizeOutdatedReviews(octokit, location);

    await expect(minimizeOutdatedReviews(octokit, location)).resolves.toBe(0);
    expect(minimized(github.requests)).toStrictEqual(["PRR_1", "PRR_2"]);
  });
});
