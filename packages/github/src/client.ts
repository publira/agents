import { Octokit } from "@octokit/rest";

import { applyRequestPolicy } from "./request-policy.ts";
import type { RequestPolicy } from "./request-policy.ts";

export type { Octokit } from "@octokit/rest";

export interface GitHubClientOptions {
  /** A token for the API. Without one, requests are anonymous and limited to 60 an hour. */
  auth?: string;
  /** Defaults to the global `fetch`; tests pass their own. */
  fetch?: typeof fetch;
  /** Overrides the timeout and retries of `DEFAULT_REQUEST_POLICY`. */
  requestPolicy?: Partial<RequestPolicy>;
}

export const createGitHubClient = ({
  auth,
  fetch: fetchImpl,
  requestPolicy,
}: GitHubClientOptions = {}): Octokit =>
  applyRequestPolicy(
    new Octokit({
      auth,
      request: fetchImpl === undefined ? undefined : { fetch: fetchImpl },
      userAgent: "publira-maintenance-bot",
    }),
    requestPolicy
  );
