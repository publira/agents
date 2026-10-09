import { hasRepositoryLabel, removeIssueLabel } from "@publira/github";
import type { Octokit } from "@publira/github";
import {
  AI_ASSISTED_LABEL,
  evaluateAgentAssistanceLabel,
} from "@publira/maintenance-policies";

import type { LogFields } from "../log.ts";

export type LabelAgentAssistedPullRequestResult = { commits: number } & (
  | { status: "left"; reason: string }
  | { status: "would-add" | "added" | "would-remove" | "removed" }
);

export interface LabelAgentAssistedPullRequestOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  /** Decides without changing anything. */
  dryRun?: boolean;
}

/**
 * Adds the `ai-assisted` label to a pull request when one of its commits has
 * an `Assisted-by:` trailer, and takes it off when none does, as
 * `evaluateAgentAssistanceLabel` decides. No model is asked.
 *
 * The labels are read from the API rather than from an event, whose list is
 * a snapshot of the moment it fired. Adding a label the pull request already
 * carries, or removing one it no longer does, changes nothing, so a
 * redelivered event is harmless.
 */
export const labelAgentAssistedPullRequest = async ({
  octokit,
  owner,
  repo,
  pullNumber,
  dryRun = false,
}: LabelAgentAssistedPullRequestOptions): Promise<LabelAgentAssistedPullRequestResult> => {
  const pull = { owner, pull_number: pullNumber, repo };
  const [{ data }, commits, labelDefined] = await Promise.all([
    octokit.rest.pulls.get(pull),
    octokit.paginate(octokit.rest.pulls.listCommits, {
      ...pull,
      per_page: 100,
    }),
    hasRepositoryLabel(octokit, { name: AI_ASSISTED_LABEL, owner, repo }),
  ]);
  const verdict = evaluateAgentAssistanceLabel({
    commitCount: data.commits,
    commitMessages: commits.map(({ commit }) => commit.message),
    draft: data.draft === true,
    labelDefined,
    labels: data.labels.map(({ name }) => name),
  });
  const counted = { commits: commits.length };

  if (verdict.action === "leave") {
    return { ...counted, reason: verdict.reason, status: "left" };
  }
  if (verdict.action === "add") {
    if (dryRun) {
      return { ...counted, status: "would-add" };
    }
    await octokit.rest.issues.addLabels({
      issue_number: pullNumber,
      labels: [AI_ASSISTED_LABEL],
      owner,
      repo,
    });
    return { ...counted, status: "added" };
  }

  if (dryRun) {
    return { ...counted, status: "would-remove" };
  }
  const removed = await removeIssueLabel(octokit, {
    issueNumber: pullNumber,
    name: AI_ASSISTED_LABEL,
    owner,
    repo,
  });
  return removed
    ? { ...counted, status: "removed" }
    : { ...counted, reason: "the label is already gone", status: "left" };
};

/** The fields of a result to log. */
export const summarizeLabelAgentAssistedPullRequestResult = (
  result: LabelAgentAssistedPullRequestResult
): LogFields => ({
  commits: result.commits,
  modelInvoked: false,
  reason: "reason" in result ? result.reason : undefined,
  status: result.status,
});
