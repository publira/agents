import type { Octokit } from "@octokit/rest";
import { z } from "zod";

import type { IssueLocation } from "./issue.ts";
import type { RepositoryName } from "./repository-name.ts";
import { requestFailure } from "./request-error.ts";

/**
 * Whether a repository's label can be added to an issue or a pull request:
 * `active` when it can, `archived` when the repository archived it, which
 * GitHub refuses to add, and `missing` when the repository does not define
 * it.
 */
export type RepositoryLabelState = "active" | "archived" | "missing";

// The REST API returns `archived_at` for a label, which Octokit's types do
// not describe yet.
const archivedLabel = z.object({ archived_at: z.string().nullish() });

/** Tells whether a repository's label can be added; see {@link RepositoryLabelState}. */
export const getRepositoryLabelState = async (
  octokit: Octokit,
  { owner, repo, name }: RepositoryName & { name: string }
): Promise<RepositoryLabelState> => {
  try {
    const { data } = await octokit.rest.issues.getLabel({ name, owner, repo });
    return archivedLabel.safeParse(data).data?.archived_at
      ? "archived"
      : "active";
  } catch (error) {
    if (requestFailure.safeParse(error).data?.status === 404) {
      return "missing";
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
