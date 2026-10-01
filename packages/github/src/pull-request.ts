import type { Octokit } from "@octokit/rest";

import { requestFailure } from "./request-error.ts";

export interface EnsurePullRequestOptions {
  owner: string;
  repo: string;
  /** The branch with the change, in the same repository. */
  head: string;
  /** The branch to merge into. */
  base: string;
  title: string;
  body: string;
}

export interface EnsurePullRequestResult {
  number: number;
  url: string;
  /** `false` when an open pull request from `head` was already there. */
  created: boolean;
}

/**
 * Opens a pull request from `head` into `base`, unless one is already open.
 * An open one gets the title and body, so running it again changes nothing.
 */
export const ensurePullRequest = async (
  octokit: Octokit,
  { owner, repo, head, base, title, body }: EnsurePullRequestOptions
): Promise<EnsurePullRequestResult> => {
  const findOpen = async () => {
    const { data } = await octokit.rest.pulls.list({
      base,
      head: `${owner}:${head}`,
      owner,
      repo,
      state: "open",
    });
    return data[0];
  };

  let pullRequest = await findOpen();

  if (pullRequest === undefined) {
    try {
      const { data } = await octokit.rest.pulls.create({
        base,
        body,
        head,
        owner,
        repo,
        title,
      });
      return { created: true, number: data.number, url: data.html_url };
    } catch (error) {
      // A concurrent run opened it first.
      if (requestFailure.safeParse(error).data?.status !== 422) {
        throw error;
      }
      pullRequest = await findOpen();
      if (pullRequest === undefined) {
        throw error;
      }
    }
  }

  if (pullRequest.title !== title || pullRequest.body !== body) {
    await octokit.rest.pulls.update({
      body,
      owner,
      pull_number: pullRequest.number,
      repo,
      title,
    });
  }

  return {
    created: false,
    number: pullRequest.number,
    url: pullRequest.html_url,
  };
};
