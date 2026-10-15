import type { Octokit } from "@octokit/rest";

import type { BranchLocation } from "./checks.ts";
import { requestFailure } from "./request-error.ts";

/**
 * Reads the commit a branch points to, or returns `undefined` when the
 * branch does not exist. An empty repository names a default branch that has
 * no commit yet, and the API answers 404 for it as for any missing branch.
 */
export const getBranchHeadSha = async (
  octokit: Octokit,
  { owner, repo, branch }: BranchLocation
): Promise<string | undefined> => {
  try {
    const { data } = await octokit.rest.repos.getBranch({
      branch,
      owner,
      repo,
    });
    return data.commit.sha;
  } catch (error) {
    if (requestFailure.safeParse(error).data?.status === 404) {
      return undefined;
    }
    throw error;
  }
};
