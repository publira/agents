import { describe, expect, it } from "vitest";

import { evaluateParentIssue } from "./parent-issue-completion.ts";

const closed = { state: "closed" };
const open = { state: "open" };

describe(evaluateParentIssue, () => {
  it("closes an open issue whose sub-issues are all closed", () => {
    expect(
      evaluateParentIssue({
        closedByBot: false,
        state: "open",
        subIssues: [closed, closed],
      })
    ).toStrictEqual({ action: "close" });
  });

  it("makes sure the bot's own close has its comment", () => {
    expect(
      evaluateParentIssue({ closedByBot: true, state: "closed", subIssues: [] })
    ).toStrictEqual({ action: "comment" });
  });

  it.each([
    [
      "an issue that is already closed",
      { state: "closed", subIssues: [] },
      "it is already closed",
    ],
    [
      "an issue without sub-issues",
      { state: "open", subIssues: [] },
      "it has no sub-issues",
    ],
    [
      "an issue with an open sub-issue",
      { state: "open", subIssues: [closed, open, closed] },
      "1 of its 3 sub-issues is open",
    ],
    [
      "an issue with open sub-issues",
      { state: "open", subIssues: [open, open, closed] },
      "2 of its 3 sub-issues are open",
    ],
  ])("leaves %s", (_, input, reason) => {
    expect(evaluateParentIssue({ ...input, closedByBot: false })).toStrictEqual(
      {
        action: "leave",
        reason,
      }
    );
  });
});
