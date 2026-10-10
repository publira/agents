import type { Octokit } from "@octokit/rest";
import { z } from "zod";

import { graphqlActor, restLogin } from "./actor.ts";
import type { PullRequestLocation } from "./pull-request-editor.ts";
import { requestFailure } from "./request-error.ts";

export type ReviewEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

const reviewStates: Record<ReviewEvent, string> = {
  APPROVE: "APPROVED",
  COMMENT: "COMMENTED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
};

export interface EnsureReviewOptions {
  owner: string;
  repo: string;
  pullNumber: number;
  /** The head commit the review is for. */
  commitId: string;
  event: ReviewEvent;
  body: string;
  /** The login the reviews are submitted under, such as the App's bot login. */
  reviewer: string;
}

export interface EnsureReviewResult {
  id: number;
  /** `false` when the reviewer had already reviewed the commit this way. */
  created: boolean;
}

// A pending review another run submitted or deleted first.
const goneStatuses = new Set([404, 422]);

/**
 * Submits a review of one commit of a pull request, unless the reviewer has
 * already submitted one with the same outcome for that commit. A dismissed
 * review counts too: someone took it back on purpose, and a redelivered event
 * must not submit it again.
 *
 * Concurrent runs submit one review between them. GitHub lets a user hold one
 * pending review per pull request, so each run first takes that pending
 * review, creating it or adopting the one another run created, checks again
 * that no review is there, and only then submits it; only one submission of a
 * pending review succeeds.
 */
export const ensureReview = async (
  octokit: Octokit,
  {
    owner,
    repo,
    pullNumber,
    commitId,
    event,
    body,
    reviewer,
  }: EnsureReviewOptions
): Promise<EnsureReviewResult> => {
  const pullRequest = { owner, pull_number: pullNumber, repo };
  const listOwnReviews = async () => {
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      ...pullRequest,
      per_page: 100,
    });
    return reviews.filter((review) => review.user?.login === reviewer);
  };
  const findSubmitted = async () => {
    const reviews = await listOwnReviews();
    return reviews.find(
      (review) =>
        review.commit_id === commitId &&
        (review.state === reviewStates[event] || review.state === "DISMISSED")
    );
  };
  const findPending = async () => {
    const reviews = await listOwnReviews();
    return reviews.find((review) => review.state === "PENDING");
  };

  // Creates the reviewer's pending review, or adopts the one a concurrent run
  // created for the same commit.
  const takePendingReview = async () => {
    const leftover = await findPending();

    if (leftover?.commit_id === commitId) {
      return leftover;
    }
    // A pending review for another commit was left by a run that failed.
    if (leftover !== undefined) {
      await octokit.rest.pulls.deletePendingReview({
        ...pullRequest,
        review_id: leftover.id,
      });
    }

    try {
      // Without an event, the review stays pending.
      const { data } = await octokit.rest.pulls.createReview({
        ...pullRequest,
        body,
        commit_id: commitId,
      });
      return data;
    } catch (error) {
      // A concurrent run holds the pending review.
      if (requestFailure.safeParse(error).data?.status !== 422) {
        throw error;
      }
      const other = await findPending();
      // Submitting another run's review of another commit would put this
      // outcome on that commit.
      if (other === undefined || other.commit_id !== commitId) {
        throw error;
      }
      return other;
    }
  };

  const submitted = await findSubmitted();
  if (submitted !== undefined) {
    return { created: false, id: submitted.id };
  }

  const pending = await takePendingReview();

  // A concurrent run may have submitted its review before this one took the
  // pending review.
  const submittedMeanwhile = await findSubmitted();
  if (submittedMeanwhile !== undefined) {
    // Unless the run whose pending review this one adopted submitted it.
    if (submittedMeanwhile.id !== pending.id) {
      try {
        await octokit.rest.pulls.deletePendingReview({
          ...pullRequest,
          review_id: pending.id,
        });
      } catch (error) {
        if (
          !goneStatuses.has(requestFailure.safeParse(error).data?.status ?? 0)
        ) {
          throw error;
        }
      }
    }
    return { created: false, id: submittedMeanwhile.id };
  }

  try {
    await octokit.rest.pulls.submitReview({
      ...pullRequest,
      body,
      event,
      review_id: pending.id,
    });
  } catch (error) {
    if (!goneStatuses.has(requestFailure.safeParse(error).data?.status ?? 0)) {
      throw error;
    }
    const submittedByOther = await findSubmitted();
    if (submittedByOther === undefined) {
      throw error;
    }
    return { created: false, id: submittedByOther.id };
  }

  return { created: true, id: pending.id };
};

export interface MinimizeOutdatedReviewsOptions extends PullRequestLocation {
  /** The head commit whose reviews stay as they are. */
  commitId: string;
  /** The login whose reviews are minimized, such as the App's bot login. */
  reviewer: string;
}

const reviewsResponse = z.object({
  repository: z.object({
    pullRequest: z.object({
      reviews: z.object({
        nodes: z.array(
          z.object({
            author: graphqlActor.nullable(),
            commit: z.object({ oid: z.string() }).nullable(),
            id: z.string(),
            isMinimized: z.boolean(),
            state: z.string(),
          })
        ),
        pageInfo: z.object({
          endCursor: z.string().nullable(),
          hasNextPage: z.boolean(),
        }),
      }),
    }),
  }),
});

type ReviewNode = z.infer<
  typeof reviewsResponse
>["repository"]["pullRequest"]["reviews"]["nodes"][number];

const listReviewNodes = async (
  octokit: Octokit,
  location: PullRequestLocation,
  after: string | null = null
): Promise<ReviewNode[]> => {
  const { owner, repo, pullNumber } = location;
  const response = await octokit.graphql(
    `query ($owner: String!, $repo: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviews(first: 100, after: $after) {
            nodes {
              id
              state
              isMinimized
              author { __typename login }
              commit { oid }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`,
    { after, number: pullNumber, owner, repo }
  );
  const { nodes, pageInfo } =
    reviewsResponse.parse(response).repository.pullRequest.reviews;

  return pageInfo.hasNextPage
    ? [
        ...nodes,
        ...(await listReviewNodes(octokit, location, pageInfo.endCursor)),
      ]
    : nodes;
};

/**
 * Minimizes, as outdated, the reviewer's submitted reviews of a pull request
 * for commits other than the given one, so that the timeline shows the
 * review of the head in full. A minimized review keeps its state and stays
 * readable when expanded. Reviews already minimized, and those of other
 * users, are left as they are. Returns how many it minimized.
 */
export const minimizeOutdatedReviews = async (
  octokit: Octokit,
  options: MinimizeOutdatedReviewsOptions
): Promise<number> => {
  const reviews = await listReviewNodes(octokit, options);
  const outdated = reviews.filter(
    ({ author, commit, isMinimized, state }) =>
      author !== null &&
      restLogin(author) === options.reviewer &&
      state !== "PENDING" &&
      commit?.oid !== options.commitId &&
      !isMinimized
  );

  for (const { id } of outdated) {
    // oxlint-disable-next-line no-await-in-loop -- GitHub asks for writes one at a time
    await octokit.graphql(
      `mutation ($id: ID!) {
        minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) {
          clientMutationId
        }
      }`,
      { id }
    );
  }

  return outdated.length;
};
