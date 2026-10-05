import { ensureIssueComment } from "@publira/github";
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
    };

export interface CloseCompletedParentIssueOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  /** The issue to close, the parent of the sub-issues. */
  issueNumber: number;
  /** The App's bot login, which comments. Only a dry run goes without. */
  author: string | undefined;
  /** Decides without changing anything. */
  dryRun?: boolean;
}

/**
 * Closes an issue as completed, and says why in a comment, when
 * `evaluateParentIssue` finds all of its sub-issues closed. No model is
 * asked.
 *
 * A closed issue is left as it is, so a redelivered event changes nothing.
 * Two runs that find the issue open at once both close it, and leave one
 * comment between them.
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
  const verdict = evaluateParentIssue({ state: data.state, subIssues });

  if (verdict.action === "leave") {
    return { reason: verdict.reason, status: "left" };
  }
  if (dryRun) {
    return { status: "would-close", subIssues: subIssues.length };
  }
  if (author === undefined) {
    throw new Error("Closing an issue needs the login that comments on it");
  }

  const { data: closed } = await octokit.rest.issues.update({
    ...issue,
    state: "closed",
    state_reason: "completed",
  });
  const comment = await ensureIssueComment(octokit, {
    author,
    body: COMPLETED_PARENT_COMMENT,
    issueNumber,
    owner,
    repo,
    since: new Date(closed.closed_at ?? closed.updated_at),
  });

  return { comment, status: "closed", subIssues: subIssues.length };
};

/** The fields of a result to log. */
export const summarizeCloseCompletedParentIssueResult = (
  result: CloseCompletedParentIssueResult
): LogFields => ({
  comment: result.status === "closed" ? result.comment.id : undefined,
  commentCreated:
    result.status === "closed" ? result.comment.created : undefined,
  modelInvoked: false,
  reason: result.status === "left" ? result.reason : undefined,
  status: result.status,
  subIssues: result.status === "left" ? undefined : result.subIssues,
});
