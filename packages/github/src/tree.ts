import type { Octokit } from "@octokit/rest";

import type { FileMode } from "./commit.ts";

export interface CommitFilesLocation {
  owner: string;
  repo: string;
  /** The commit whose files to list. */
  sha: string;
}

/** A file in a commit's tree. */
export interface TreeFile {
  path: string;
  mode: FileMode;
  /** The blob's object ID. */
  sha: string;
}

const isFileMode = (mode: string | undefined): mode is FileMode =>
  mode === "100644" || mode === "100755" || mode === "120000";

/**
 * Lists every file of a commit, with its mode and blob, without reading the
 * contents. Directories and submodules are left out. GitHub cuts a tree of
 * more than 100,000 entries or 7 MB short, which this refuses rather than
 * return part of it.
 */
export const listCommitFiles = async (
  octokit: Octokit,
  { owner, repo, sha }: CommitFilesLocation
): Promise<TreeFile[]> => {
  const { data: commit } = await octokit.rest.git.getCommit({
    commit_sha: sha,
    owner,
    repo,
  });
  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    recursive: "true",
    repo,
    tree_sha: commit.tree.sha,
  });

  if (tree.truncated) {
    throw new Error(`The tree of ${owner}/${repo}@${sha} is too large to list`);
  }

  return tree.tree.flatMap(({ mode, path, sha: blob, type }) =>
    type === "blob" &&
    isFileMode(mode) &&
    path !== undefined &&
    blob !== undefined
      ? [{ mode, path, sha: blob }]
      : []
  );
};
