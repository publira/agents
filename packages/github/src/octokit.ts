import { Octokit } from "@octokit/rest";

import { applyRequestPolicy } from "./request-policy.ts";
import type { RequestPolicy } from "./request-policy.ts";

type OctokitOptions = NonNullable<ConstructorParameters<typeof Octokit>[0]>;

const noop = () => {
  // Nothing is written.
};

// Octokit's request log plugin writes every failed request to `log.error`,
// which defaults to `console.error`, before the error reaches the caller:
// also a 404 that `readOptionalRepositoryFile` or `getParentIssue` answers
// with `undefined`. The callers log the failures they do not handle, with
// their own fields, so the client logs none. Octokit's warnings, such as
// about a deprecated endpoint, still go to the console.
const log: OctokitOptions["log"] = {
  debug: noop,
  error: noop,
  info: noop,
  warn: console.warn.bind(console),
};

/**
 * A client with the timeouts and retries of the request policy, which logs
 * no request of its own.
 */
export const createOctokit = (
  options: Pick<OctokitOptions, "auth" | "authStrategy" | "request">,
  requestPolicy?: Partial<RequestPolicy>
): Octokit =>
  applyRequestPolicy(
    new Octokit({ ...options, log, userAgent: "Chachamaru" }),
    requestPolicy
  );
