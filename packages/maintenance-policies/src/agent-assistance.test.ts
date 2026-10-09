import { describe, expect, it } from "vitest";

import {
  AI_ASSISTED_LABEL,
  disclosesAgentAssistance,
  evaluateAgentAssistanceLabel,
} from "./agent-assistance.ts";

const assisted =
  "feat: add a maintenance policy\n\nAssisted-by: Claude Code:claude-opus-5-5\n";
const unassisted = "fix: handle a missing label\n\nSigned-off-by: A Person\n";

describe(disclosesAgentAssistance, () => {
  it.each([
    ["the trailer", assisted],
    ["the trailer in lower case", "fix: x\n\nassisted-by: Codex:gpt-5\n"],
    ["the trailer in upper case", "fix: x\n\nASSISTED-BY: Codex:gpt-5"],
    ["the trailer after a tab", "fix: x\n\nAssisted-by:\tCodex:gpt-5"],
  ])("finds %s", (_, message) => {
    expect(disclosesAgentAssistance(message)).toBeTruthy();
  });

  it.each([
    ["a message without it", unassisted],
    ["the token without a value", "fix: x\n\nAssisted-by:\n"],
    ["the token inside a line", "fix: drop the Assisted-by: trailer check"],
    ["a co-author trailer", "fix: x\n\nCo-authored-by: A <a@example.com>"],
  ])("ignores %s", (_, message) => {
    expect(disclosesAgentAssistance(message)).toBeFalsy();
  });
});

describe(evaluateAgentAssistanceLabel, () => {
  const input = {
    commitCount: 2,
    commitMessages: [unassisted, assisted],
    draft: false,
    labelDefined: true,
    labels: [],
  };

  it("adds the label when a commit discloses an agent", () => {
    expect(evaluateAgentAssistanceLabel(input)).toStrictEqual({
      action: "add",
    });
  });

  it("removes the label when no commit discloses an agent", () => {
    expect(
      evaluateAgentAssistanceLabel({
        ...input,
        commitCount: 1,
        commitMessages: [unassisted],
        labels: ["dependencies", AI_ASSISTED_LABEL],
      })
    ).toStrictEqual({ action: "remove" });
  });

  it.each([
    ["a draft", { draft: true }, "it is a draft"],
    [
      "a pull request that is already labelled",
      { labels: [AI_ASSISTED_LABEL] },
      "it is already labelled",
    ],
    [
      "a pull request without an agent or the label",
      { commitMessages: [unassisted] },
      "no commit discloses an agent, and it is not labelled",
    ],
    [
      "the label of a pull request whose commits GitHub lists in part",
      {
        commitCount: 300,
        commitMessages: Array.from({ length: 250 }, () => unassisted),
        labels: [AI_ASSISTED_LABEL],
      },
      "GitHub lists only 250 of its 300 commits",
    ],
    [
      "a pull request in a repository without the label",
      { labelDefined: false },
      "the repository does not define the ai-assisted label",
    ],
  ])("leaves %s", (_, overrides, reason) => {
    expect(
      evaluateAgentAssistanceLabel({ ...input, ...overrides })
    ).toStrictEqual({ action: "leave", reason });
  });
});
