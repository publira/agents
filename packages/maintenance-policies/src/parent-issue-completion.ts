export interface ParentIssueInput {
  /** The issue's state as the REST API reports it: `open` or `closed`. */
  state: string;
  /** Whether the bot closed it as completed, which its comment explains. */
  closedByBot: boolean;
  /**
   * The states of all of its sub-issues, in any repository. Not read once
   * the issue is closed.
   */
  subIssues: readonly { state: string }[];
}

export type ParentIssueVerdict =
  | { action: "close" }
  | {
      /**
       * The bot closed it, and its comment may be missing: a close is not
       * tried again when it fails, and the comment comes after the close.
       */
      action: "comment";
    }
  | { action: "leave"; reason: string };

const leave = (reason: string): ParentIssueVerdict => ({
  action: "leave",
  reason,
});

/**
 * Decides whether an issue is complete because its sub-issues are: it is
 * closed as completed when it is open, has at least one sub-issue, and all of
 * them are closed, whatever their reason. The decision rests on the sub-issue
 * structure alone, not on labels. A closed issue is left as it is, so that
 * one closed or reopened by hand stays that way, except that the bot's own
 * close gets its comment.
 */
export const evaluateParentIssue = ({
  state,
  closedByBot,
  subIssues,
}: ParentIssueInput): ParentIssueVerdict => {
  if (state !== "open") {
    return closedByBot ? { action: "comment" } : leave("it is already closed");
  }
  if (subIssues.length === 0) {
    return leave("it has no sub-issues");
  }

  const open = subIssues.filter((subIssue) => subIssue.state === "open");

  if (open.length > 0) {
    return leave(
      `${open.length} of its ${subIssues.length} sub-issues ${open.length === 1 ? "is" : "are"} open`
    );
  }
  return { action: "close" };
};
