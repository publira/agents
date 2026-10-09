import { isUtf8 } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";

import type { Octokit } from "@octokit/rest";

import { requestFailure } from "./request-error.ts";

/**
 * A file's mode in a Git tree: a regular file, an executable, or a symbolic
 * link, whose content is the path it points to.
 */
export type FileMode = "100644" | "100755" | "120000";

export interface CommitToBranchOptions {
  owner: string;
  repo: string;
  /** The branch to create or move, without `refs/heads/`. */
  branch: string;
  /** The commit the change applies to. */
  baseSha: string;
  message: string;
  /**
   * New contents by path, as text or as bytes, which need not be UTF-8;
   * `null` deletes the file.
   */
  files: Readonly<Record<string, string | Uint8Array | null>>;
  /** The mode of each file by path. A file without one is regular. */
  modes?: Readonly<Record<string, FileMode>>;
}

export interface CommitToBranchResult {
  /** The commit the branch now points to. */
  sha: string;
  /** `false` when the branch already held this change on this base. */
  created: boolean;
}

const getBranchSha = async (
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string
): Promise<string | undefined> => {
  try {
    const { data } = await octokit.rest.git.getRef({
      owner,
      ref: `heads/${branch}`,
      repo,
    });
    return data.object.sha;
  } catch (error) {
    if (requestFailure.safeParse(error).data?.status === 404) {
      return undefined;
    }
    throw error;
  }
};

/**
 * How long to wait between blob uploads. GitHub asks for writes one at a
 * time, at least a second apart, to stay within its secondary rate limits,
 * and a write that fails is not tried again.
 */
const BLOB_UPLOAD_INTERVAL_MS = 1000;

interface TreeEntriesOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  files: Readonly<Record<string, string | Uint8Array | null>>;
  modes: Readonly<Record<string, FileMode>>;
}

// A tree entry takes text inline. Other bytes go up as a blob first, which
// costs a write per file, so only the files that are not UTF-8 do, one after
// another.
const treeEntriesOf = async ({
  octokit,
  owner,
  repo,
  files,
  modes,
}: TreeEntriesOptions) => {
  const entries = [];
  let uploaded = false;

  for (const [path, content] of Object.entries(files)) {
    const mode = modes[path] ?? "100644";

    if (content === null) {
      entries.push({ mode, path, sha: null, type: "blob" as const });
    } else if (!(content instanceof Uint8Array)) {
      entries.push({ content, mode, path, type: "blob" as const });
    } else if (isUtf8(content)) {
      entries.push({
        content: Buffer.from(content).toString("utf-8"),
        mode,
        path,
        type: "blob" as const,
      });
    } else {
      if (uploaded) {
        // oxlint-disable-next-line no-await-in-loop -- one write at a time
        await sleep(BLOB_UPLOAD_INTERVAL_MS);
      }
      // oxlint-disable-next-line no-await-in-loop -- one write at a time
      const { data: blob } = await octokit.rest.git.createBlob({
        content: Buffer.from(content).toString("base64"),
        encoding: "base64",
        owner,
        repo,
      });
      uploaded = true;
      entries.push({ mode, path, sha: blob.sha, type: "blob" as const });
    }
  }

  return entries;
};

/**
 * Commits a change on top of `baseSha` and points `branch` at the commit,
 * creating the branch if needed. The branch belongs to the caller: whatever
 * else it holds is replaced.
 *
 * Running it again with the same arguments changes nothing, so a retried job
 * does not stack up commits.
 */
export const commitToBranch = async (
  octokit: Octokit,
  {
    owner,
    repo,
    branch,
    baseSha,
    message,
    files,
    modes = {},
  }: CommitToBranchOptions
): Promise<CommitToBranchResult> => {
  const { data: baseCommit } = await octokit.rest.git.getCommit({
    commit_sha: baseSha,
    owner,
    repo,
  });
  // Git objects are content-addressed, so the same change on the same base
  // always yields the same tree.
  const { data: tree } = await octokit.rest.git.createTree({
    base_tree: baseCommit.tree.sha,
    owner,
    repo,
    tree: await treeEntriesOf({ files, modes, octokit, owner, repo }),
  });

  if (tree.sha === baseCommit.tree.sha) {
    throw new Error(`The change leaves ${owner}/${repo}@${baseSha} as it is`);
  }

  const branchSha = await getBranchSha(octokit, owner, repo, branch);

  if (branchSha !== undefined) {
    const { data: branchCommit } = await octokit.rest.git.getCommit({
      commit_sha: branchSha,
      owner,
      repo,
    });
    if (
      branchCommit.tree.sha === tree.sha &&
      branchCommit.parents.length === 1 &&
      branchCommit.parents[0]?.sha === baseSha
    ) {
      return { created: false, sha: branchSha };
    }
  }

  // Without an author or committer, GitHub signs the commit as the App.
  const { data: commit } = await octokit.rest.git.createCommit({
    message,
    owner,
    parents: [baseSha],
    repo,
    tree: tree.sha,
  });

  const moveBranch = () =>
    octokit.rest.git.updateRef({
      force: true,
      owner,
      ref: `heads/${branch}`,
      repo,
      sha: commit.sha,
    });

  if (branchSha === undefined) {
    try {
      await octokit.rest.git.createRef({
        owner,
        ref: `refs/heads/${branch}`,
        repo,
        sha: commit.sha,
      });
    } catch (error) {
      // A concurrent run created the branch first.
      if (requestFailure.safeParse(error).data?.status !== 422) {
        throw error;
      }
      await moveBranch();
    }
  } else {
    await moveBranch();
  }

  return { created: true, sha: commit.sha };
};

export interface AddCommitToBranchOptions {
  owner: string;
  repo: string;
  /** A branch someone else owns, without `refs/heads/`. */
  branch: string;
  /** The commit the branch must still point to; the change goes on top. */
  headSha: string;
  message: string;
  /** New contents of regular files by path. */
  files: Readonly<Record<string, string>>;
}

export type AddCommitToBranchResult =
  | { status: "committed"; sha: string }
  /** The branch no longer points to `headSha`, and was left as it is. */
  | { status: "moved" };

/**
 * Commits a change on top of `headSha` and moves `branch` to the commit, but
 * only as a fast-forward: when the branch moved meanwhile, such as by a push
 * of its owner, nothing is overwritten, and the commit is left unreferenced.
 * The caller tells whether the branch already holds the change; a change that
 * leaves the files as they are is refused.
 */
export const addCommitToBranch = async (
  octokit: Octokit,
  { owner, repo, branch, headSha, message, files }: AddCommitToBranchOptions
): Promise<AddCommitToBranchResult> => {
  const { data: headCommit } = await octokit.rest.git.getCommit({
    commit_sha: headSha,
    owner,
    repo,
  });
  const { data: tree } = await octokit.rest.git.createTree({
    base_tree: headCommit.tree.sha,
    owner,
    repo,
    tree: Object.entries(files).map(([path, content]) => ({
      content,
      mode: "100644" as const,
      path,
      type: "blob" as const,
    })),
  });

  if (tree.sha === headCommit.tree.sha) {
    throw new Error(`The change leaves ${owner}/${repo}@${headSha} as it is`);
  }

  // Without an author or committer, GitHub signs the commit as the App.
  const { data: commit } = await octokit.rest.git.createCommit({
    message,
    owner,
    parents: [headSha],
    repo,
    tree: tree.sha,
  });

  try {
    await octokit.rest.git.updateRef({
      force: false,
      owner,
      ref: `heads/${branch}`,
      repo,
      sha: commit.sha,
    });
  } catch (error) {
    // Not a fast-forward, or the branch is gone.
    if (requestFailure.safeParse(error).data?.status === 422) {
      return { status: "moved" };
    }
    throw error;
  }

  return { sha: commit.sha, status: "committed" };
};
