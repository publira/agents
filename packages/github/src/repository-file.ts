import type { Octokit } from "@octokit/rest";

import { requestFailure } from "./request-error.ts";

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

/**
 * Reads a text file from a repository, or returns `undefined` when the
 * repository has no file at that path.
 */
export const readOptionalRepositoryFile = async (
  octokit: Octokit,
  location: RepositoryFileLocation
): Promise<string | undefined> => {
  try {
    return await readRepositoryFile(octokit, location);
  } catch (error) {
    if (requestFailure.safeParse(error).data?.status === 404) {
      return undefined;
    }
    throw error;
  }
};
