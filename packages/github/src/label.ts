import type { Octokit } from "@octokit/rest";

import type { IssueLocation } from "./issue.ts";
import type { RepositoryName } from "./repository-name.ts";
import { requestFailure } from "./request-error.ts";

/** Whether a repository defines a label. */
export const hasRepositoryLabel = async (
  octokit: Octokit,
  { owner, repo, name }: RepositoryName & { name: string }
): Promise<boolean> => {
  try {
    await octokit.rest.issues.getLabel({ name, owner, repo });
    return true;
  } catch (error) {
    if (requestFailure.safeParse(error).data?.status === 404) {
      return false;
    }
    throw error;
  }
};

/**
 * Takes a label off an issue or a pull request. Returns `false` when it did
 * not carry the label, such as when someone took it off a moment before,
 * which is the state asked for.
 */
export const removeIssueLabel = async (
  octokit: Octokit,
  { owner, repo, issueNumber, name }: IssueLocation & { name: string }
): Promise<boolean> => {
  try {
    await octokit.rest.issues.removeLabel({
      issue_number: issueNumber,
      name,
      owner,
      repo,
    });
    return true;
  } catch (error) {
    if (requestFailure.safeParse(error).data?.status === 404) {
      return false;
    }
    throw error;
  }
};
