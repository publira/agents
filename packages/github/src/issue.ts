import type { Octokit } from "@octokit/rest";

import { requestFailure } from "./request-error.ts";

export interface IssueLocation {
  owner: string;
  repo: string;
  issueNumber: number;
}

// `https://api.github.com/repos/{owner}/{repo}`, as an issue's
// `repository_url` names its repository.
const REPOSITORY_URL = /\/repos\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/u;

/** Where an issue as the REST API returns it lives. */
export const issueLocationOf = ({
  number,
  repository_url: repositoryUrl,
}: {
  number: number;
  repository_url: string;
}): IssueLocation => {
  const { owner, repo } = REPOSITORY_URL.exec(repositoryUrl)?.groups ?? {};

  if (owner === undefined || repo === undefined) {
    throw new Error(
      `Expected a repository API URL, got ${JSON.stringify(repositoryUrl)}`
    );
  }
  return { issueNumber: number, owner, repo };
};

/**
 * Returns where an issue's parent lives, which may be another repository, or
 * `undefined` when it has none or the token cannot see it.
 */
export const getParentIssue = async (
  octokit: Octokit,
  { owner, repo, issueNumber }: IssueLocation
): Promise<IssueLocation | undefined> => {
  try {
    const { data } = await octokit.rest.issues.getParent({
      issue_number: issueNumber,
      owner,
      repo,
    });
    return issueLocationOf(data);
  } catch (error) {
    if (requestFailure.safeParse(error).data?.status === 404) {
      return undefined;
    }
    throw error;
  }
};

export interface EnsureIssueCommentOptions extends IssueLocation {
  body: string;
  /** The login the comment is posted under, such as the App's bot login. */
  author: string;
  /**
   * Only comments posted at or after this time count, such as since the
   * issue was closed, so that a comment from an earlier close does not.
   */
  since: Date;
}

export interface EnsureIssueCommentResult {
  id: number;
  /** `false` when the author had already posted the comment. */
  created: boolean;
}

/**
 * Posts a comment on an issue, unless the author already posted the same one
 * since `since`.
 *
 * Concurrent runs leave one comment between them. GitHub has no way to post
 * a comment only if there is none, so each run posts its own, then looks
 * again, and the run whose comment is not the earliest deletes it.
 */
export const ensureIssueComment = async (
  octokit: Octokit,
  { owner, repo, issueNumber, body, author, since }: EnsureIssueCommentOptions
): Promise<EnsureIssueCommentResult> => {
  const issue = { issue_number: issueNumber, owner, repo };
  const findEarliest = async () => {
    // `since` filters by the time a comment was last updated.
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      ...issue,
      per_page: 100,
      since: since.toISOString(),
    });
    const same = comments.filter(
      (comment) =>
        comment.user?.login === author &&
        comment.body === body &&
        new Date(comment.created_at).getTime() >= since.getTime()
    );
    return same.toSorted((a, b) => a.id - b.id)[0];
  };

  const existing = await findEarliest();
  if (existing !== undefined) {
    return { created: false, id: existing.id };
  }

  const { data: posted } = await octokit.rest.issues.createComment({
    ...issue,
    body,
  });
  const earliest = await findEarliest();

  if (earliest === undefined || earliest.id === posted.id) {
    return { created: true, id: posted.id };
  }

  try {
    await octokit.rest.issues.deleteComment({
      comment_id: posted.id,
      owner,
      repo,
    });
  } catch (error) {
    // Deleted already, such as by someone reading the duplicate.
    if (requestFailure.safeParse(error).data?.status !== 404) {
      throw error;
    }
  }
  return { created: false, id: earliest.id };
};
