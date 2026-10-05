export interface ParentIssueInput {
  /** The issue's state as the REST API reports it: `open` or `closed`. */
  state: string;
  /**
   * The states of all of its sub-issues, in any repository. Not read once
   * the issue is closed.
   */
  subIssues: readonly { state: string }[];
}

export type ParentIssueVerdict =
  | { action: "close" }
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
 * one closed or reopened by hand stays that way.
 */
export const evaluateParentIssue = ({
  state,
  subIssues,
}: ParentIssueInput): ParentIssueVerdict => {
  if (state !== "open") {
    return leave("it is already closed");
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
