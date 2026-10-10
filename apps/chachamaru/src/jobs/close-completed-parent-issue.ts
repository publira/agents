import { ensureIssueComment, findIssueComment } from "@publira/github";
import type { EnsureIssueCommentResult, Octokit } from "@publira/github";
import { evaluateParentIssue } from "@publira/maintenance-policies";

import type { LogFields } from "../log.ts";

// The comment publira/publira's `Close completed epics` workflow job posts.
export const COMPLETED_PARENT_COMMENT =
  "Closing this Epic because all of its sub-issues are closed.";

export type CloseCompletedParentIssueResult =
  | { status: "left"; reason: string }
  | { status: "would-close"; subIssues: number }
  | {
      status: "closed";
      subIssues: number;
      comment: EnsureIssueCommentResult;
    }
  | {
      /** The bot closed it before, and its comment is missing. */
      status: "would-comment";
    }
  | {
      /**
       * The bot closed it before. `comment.created` tells that its comment
       * was missing and is posted now.
       */
      status: "already-closed";
      comment: EnsureIssueCommentResult;
    };

export interface CloseCompletedParentIssueOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  /** The issue to close, the parent of the sub-issues. */
  issueNumber: number;
  /** The App's bot login, which comments. */
  author: string;
  /** Decides without changing anything. */
  dryRun?: boolean;
}

/**
 * Closes an issue as completed, and says why in a comment, when
 * `evaluateParentIssue` finds all of its sub-issues closed. No model is
 * asked.
 *
 * A closed issue is left as it is, so a redelivered event changes nothing,
 * except that the bot's own close gets its comment when that is missing, such
 * as after the comment failed. Two runs that find the issue open at once both
 * close it, and leave one comment between them.
 */
export const closeCompletedParentIssue = async ({
  octokit,
  owner,
  repo,
  issueNumber,
  author,
  dryRun = false,
}: CloseCompletedParentIssueOptions): Promise<CloseCompletedParentIssueResult> => {
  const issue = { issue_number: issueNumber, owner, repo };
  const { data } = await octokit.rest.issues.get(issue);
  // Listed only for an open issue, whose verdict depends on them.
  const subIssues =
    data.state === "open"
      ? await octokit.paginate(octokit.rest.issues.listSubIssues, {
          ...issue,
          per_page: 100,
        })
      : [];
  const verdict = evaluateParentIssue({
    closedByBot:
      data.closed_by?.login === author && data.state_reason === "completed",
    state: data.state,
    subIssues,
  });

  if (verdict.action === "leave") {
    return { reason: verdict.reason, status: "left" };
  }
  if (verdict.action === "close" && dryRun) {
    return { status: "would-close", subIssues: subIssues.length };
  }
  // The comment counts from the close it explains.
  const comment = (closedAt: string | null, updatedAt: string) => ({
    author,
    body: COMPLETED_PARENT_COMMENT,
    issueNumber,
    owner,
    repo,
    since: new Date(closedAt ?? updatedAt),
  });

  if (verdict.action === "comment") {
    const options = comment(data.closed_at, data.updated_at);

    if (dryRun) {
      const existing = await findIssueComment(octokit, options);
      return existing === undefined
        ? { status: "would-comment" }
        : {
            comment: { created: false, id: existing.id },
            status: "already-closed",
          };
    }
    return {
      comment: await ensureIssueComment(octokit, options),
      status: "already-closed",
    };
  }

  const { data: closed } = await octokit.rest.issues.update({
    ...issue,
    state: "closed",
    state_reason: "completed",
  });

  return {
    comment: await ensureIssueComment(
      octokit,
      comment(closed.closed_at, closed.updated_at)
    ),
    status: "closed",
    subIssues: subIssues.length,
  };
};

/** The fields of a result to log. */
export const summarizeCloseCompletedParentIssueResult = (
  result: CloseCompletedParentIssueResult
): LogFields => ({
  comment: "comment" in result ? result.comment.id : undefined,
  commentCreated: "comment" in result ? result.comment.created : undefined,
  modelInvoked: false,
  reason: "reason" in result ? result.reason : undefined,
  status: result.status,
  subIssues: "subIssues" in result ? result.subIssues : undefined,
});
