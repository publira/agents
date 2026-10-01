import type { Octokit } from "@octokit/rest";

export interface RepositoryFileLocation {
  owner: string;
  repo: string;
  path: string;
  /** A branch, tag, or commit. Defaults to the default branch. */
  ref?: string;
}

/** Reads a text file from a repository. */
export const readRepositoryFile = async (
  octokit: Octokit,
  { owner, repo, path, ref }: RepositoryFileLocation
): Promise<string> => {
  const { data } = await octokit.rest.repos.getContent({
    owner,
    path,
    ref,
    repo,
  });
  const location = `${owner}/${repo}/${path}`;

  if (Array.isArray(data) || data.type !== "file") {
    throw new Error(`${location} is not a file`);
  }

  // The contents API leaves `content` empty for a file over 1 MB.
  if (data.encoding !== "base64") {
    throw new Error(
      `${location} is too large to read through the contents API`
    );
  }

  return Buffer.from(data.content, "base64").toString("utf-8");
};
