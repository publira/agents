import { Octokit } from "@octokit/rest";

export type { Octokit } from "@octokit/rest";

export interface GitHubClientOptions {
  /** A token for the API. Without one, requests are anonymous and limited to 60 an hour. */
  auth?: string;
  /** Defaults to the global `fetch`; tests pass their own. */
  fetch?: typeof fetch;
}

export const createGitHubClient = ({
  auth,
  fetch: fetchImpl,
}: GitHubClientOptions = {}): Octokit =>
  new Octokit({
    auth,
    request: fetchImpl === undefined ? undefined : { fetch: fetchImpl },
    userAgent: "publira-maintenance-bot",
  });
