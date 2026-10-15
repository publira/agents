import type { Octokit } from "@octokit/rest";

import type { CommitFilesLocation } from "./tree.ts";

// GitHub lists a commit's files in pages, of at most 300 files in all.
const FILES_PER_PAGE = 100;

/**
 * Lists the paths a commit changes against its parent, from all of the
 * pages GitHub lists them in. The pagination plugin does not follow a
 * commit's files.
 */
export const listChangedFiles = async (
  octokit: Octokit,
  { owner, repo, sha }: CommitFilesLocation,
  page = 1
): Promise<string[]> => {
  const { data } = await octokit.rest.repos.getCommit({
    owner,
    page,
    per_page: FILES_PER_PAGE,
    ref: sha,
    repo,
  });
  const files = (data.files ?? []).map(({ filename }) => filename);
  return files.length < FILES_PER_PAGE
    ? files
    : [
        ...files,
        ...(await listChangedFiles(octokit, { owner, repo, sha }, page + 1)),
      ];
};
