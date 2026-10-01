import type { Octokit } from "@octokit/rest";

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

/**
 * Submits a review of one commit of a pull request, unless the reviewer has
 * already submitted one with the same outcome for that commit. A dismissed
 * review counts too: someone took it back on purpose, and a redelivered event
 * must not submit it again.
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
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    per_page: 100,
    pull_number: pullNumber,
    repo,
  });
  const existing = reviews.find(
    (review) =>
      review.user?.login === reviewer &&
      review.commit_id === commitId &&
      (review.state === reviewStates[event] || review.state === "DISMISSED")
  );

  if (existing !== undefined) {
    return { created: false, id: existing.id };
  }

  const { data } = await octokit.rest.pulls.createReview({
    body,
    commit_id: commitId,
    event,
    owner,
    pull_number: pullNumber,
    repo,
  });

  return { created: true, id: data.id };
};
