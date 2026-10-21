import type { Octokit } from "@octokit/rest";
import { z } from "zod";

import { graphqlActor, restLogin } from "./actor.ts";
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
   * Without it, every comment counts.
   */
  since?: Date;
  /**
   * A comment counts as the same when its body contains this, such as a
   * hidden HTML comment naming what it reports on, rather than only when its
   * body equals `body`: for a body that differs between runs.
   */
  marker?: string;
}

export interface EnsureIssueCommentResult {
  id: number;
  /** `false` when the author had already posted the comment. */
  created: boolean;
}

/**
 * Returns the earliest comment the author posted with the body, or with the
 * marker, since `since`, or `undefined` when there is none.
 */
export const findIssueComment = async (
  octokit: Octokit,
  {
    owner,
    repo,
    issueNumber,
    body,
    author,
    since,
    marker,
  }: EnsureIssueCommentOptions
): Promise<{ id: number } | undefined> => {
  // `since` filters by the time a comment was last updated.
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    issue_number: issueNumber,
    owner,
    per_page: 100,
    repo,
    since: since?.toISOString(),
  });

  const same = comments.filter(
    (comment) =>
      comment.user?.login === author &&
      (marker === undefined
        ? comment.body === body
        : (comment.body ?? "").includes(marker)) &&
      (since === undefined ||
        new Date(comment.created_at).getTime() >= since.getTime())
  );

  const [earliest] = same.toSorted((a, b) => a.id - b.id);

  return earliest === undefined ? undefined : { id: earliest.id };
};

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
  options: EnsureIssueCommentOptions
): Promise<EnsureIssueCommentResult> => {
  const { owner, repo, issueNumber, body } = options;
  const existing = await findIssueComment(octokit, options);

  if (existing !== undefined) {
    return { created: false, id: existing.id };
  }

  const { data: posted } = await octokit.rest.issues.createComment({
    body,
    issue_number: issueNumber,
    owner,
    repo,
  });

  const earliest = await findIssueComment(octokit, options);

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

export interface MinimizeOutdatedIssueCommentsOptions extends IssueLocation {
  /** The login whose comments are minimized, such as the App's bot login. */
  author: string;
  /**
   * Only comments whose body contains this are minimized, such as the start
   * of a hidden HTML comment that marks what kind of report they are.
   */
  marker: string;
  /**
   * The comment the author just posted. Only its earlier comments are
   * minimized, so a later one, such as on a newer head, stays as it is.
   * Without it, every comment with the marker is.
   */
  commentId?: number;
}

const commentNodes = z.object({
  nodes: z.array(
    z.object({
      author: graphqlActor.nullable(),
      body: z.string(),
      fullDatabaseId: z.string().nullable(),
      id: z.string(),
      isMinimized: z.boolean(),
    })
  ),
  pageInfo: z.object({
    endCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  }),
});

const commentsResponse = z.object({
  repository: z.object({
    issueOrPullRequest: z.object({ comments: commentNodes }),
  }),
});

type CommentNode = z.infer<typeof commentNodes>["nodes"][number];

const listCommentNodes = async (
  octokit: Octokit,
  location: IssueLocation,
  after: string | null = null
): Promise<CommentNode[]> => {
  const { owner, repo, issueNumber } = location;

  const response = await octokit.graphql(
    `query ($owner: String!, $repo: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $repo) {
        issueOrPullRequest(number: $number) {
          ... on Issue { comments(first: 100, after: $after) { ...page } }
          ... on PullRequest { comments(first: 100, after: $after) { ...page } }
        }
      }
    }
    fragment page on IssueCommentConnection {
      nodes {
        id
        fullDatabaseId
        body
        isMinimized
        author { __typename login }
      }
      pageInfo { hasNextPage endCursor }
    }`,
    { after, number: issueNumber, owner, repo }
  );

  const { nodes, pageInfo } =
    commentsResponse.parse(response).repository.issueOrPullRequest.comments;

  return pageInfo.hasNextPage
    ? [
        ...nodes,
        ...(await listCommentNodes(octokit, location, pageInfo.endCursor)),
      ]
    : nodes;
};

/**
 * Minimizes, as outdated, the author's comments on an issue or a pull
 * request that contain the marker, posted before the given one, or all of
 * them without one. A minimized comment stays readable when expanded.
 * Comments already minimized, later ones, and those of other users are left
 * as they are. Returns how many it minimized.
 */
export const minimizeOutdatedIssueComments = async (
  octokit: Octokit,
  options: MinimizeOutdatedIssueCommentsOptions
): Promise<number> => {
  const { author, marker, commentId } = options;
  const comments = await listCommentNodes(octokit, options);

  const outdated = comments.filter(
    (comment) =>
      comment.author !== null &&
      restLogin(comment.author) === author &&
      comment.body.includes(marker) &&
      !comment.isMinimized &&
      // Comment IDs grow with each comment posted.
      (commentId === undefined ||
        (comment.fullDatabaseId !== null &&
          BigInt(comment.fullDatabaseId) < BigInt(commentId)))
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
