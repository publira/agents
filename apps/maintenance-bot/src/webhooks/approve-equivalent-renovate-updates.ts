import { RENOVATE_LOGIN } from "@publira/maintenance-policies";
import { z } from "zod";

import {
  approveEquivalentRenovateUpdate,
  approveEquivalentRenovateUpdatesEverywhere,
  summarizeApprovalResult,
} from "../jobs/approve-equivalent-renovate-update.ts";
import type { WebhookHandler } from "./receive-webhook.ts";

// Renovate's default branch prefix, which the organization's preset keeps.
// It only spares the API calls for events of other branches; the job decides
// on the pull request itself.
const RENOVATE_BRANCH_PREFIX = "renovate/";

// The conclusions of a suite that can be what makes CI pass.
const PASSING_CONCLUSIONS = new Set(["neutral", "skipped", "success"]);

const repositoryEvent = z.object({
  installation: z.object({ id: z.number() }),
  repository: z.object({
    name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
});

const pullRequestEvent = repositoryEvent.extend({
  action: z.string(),
  pull_request: z.object({
    head: z.object({ ref: z.string() }),
    merged: z.boolean().nullish(),
    number: z.number(),
    user: z.object({ login: z.string() }).nullable(),
  }),
});

const checkSuiteEvent = repositoryEvent.extend({
  action: z.string(),
  check_suite: z.object({
    conclusion: z.string().nullable(),
    head_branch: z.string().nullable(),
    pull_requests: z.array(z.object({ number: z.number() })),
  }),
});

const statusEvent = repositoryEvent.extend({
  branches: z.array(z.object({ name: z.string() })),
  sha: z.string(),
  state: z.string(),
});

// The actions after which an open pull request may have become approvable.
const EVALUATED_ACTIONS = new Set([
  "edited",
  "opened",
  "ready_for_review",
  "reopened",
  "synchronize",
]);

type Payload = z.infer<typeof repositoryEvent>;

export interface RenovateApprovalJobs {
  approve: typeof approveEquivalentRenovateUpdate;
  approveEverywhere: typeof approveEquivalentRenovateUpdatesEverywhere;
}

/**
 * The handlers that approve equivalent Renovate updates, by event name:
 *
 * - `pull_request` evaluates a Renovate pull request when it opens or
 *   changes. When one merges, it may be the precedent that the open pull
 *   requests from the same branch in other repositories wait for, so those
 *   are evaluated.
 * - `check_suite` evaluates the Renovate pull requests of a suite that passed.
 * - `status` evaluates the Renovate pull requests of a commit once one of its
 *   statuses, such as `renovate/stability-days`, succeeds.
 *
 * Tests replace the jobs.
 */
export const createRenovateApprovalHandlers = ({
  approve = approveEquivalentRenovateUpdate,
  approveEverywhere = approveEquivalentRenovateUpdatesEverywhere,
}: Partial<RenovateApprovalJobs> = {}): Record<
  "check_suite" | "pull_request" | "status",
  WebhookHandler
> => {
  const evaluate = async (
    payload: Payload,
    pullNumbers: readonly number[],
    { app, log }: Parameters<WebhookHandler>[1]
  ) => {
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const [octokit, reviewer] = await Promise.all([
      app.getInstallationOctokit(payload.installation.id),
      app.getBotLogin(),
    ]);

    for (const pullNumber of new Set(pullNumbers)) {
      // oxlint-disable-next-line no-await-in-loop -- one pull request at a time
      const result = await approve({
        octokit,
        owner,
        pullNumber,
        repo,
        reviewer,
      });
      log("info", "Renovate update evaluated", {
        owner,
        pullRequest: pullNumber,
        repo,
        ...summarizeApprovalResult(result),
      });
    }
  };

  return {
    async check_suite(delivery, context) {
      const payload = checkSuiteEvent.parse(delivery.payload);
      const { action, check_suite: suite } = payload;

      if (
        action !== "completed" ||
        !PASSING_CONCLUSIONS.has(suite.conclusion ?? "") ||
        !(suite.head_branch ?? "").startsWith(RENOVATE_BRANCH_PREFIX)
      ) {
        return;
      }

      await evaluate(
        payload,
        suite.pull_requests.map(({ number }) => number),
        context
      );
    },

    async pull_request(delivery, context) {
      const payload = pullRequestEvent.parse(delivery.payload);
      const { action, pull_request: pullRequest } = payload;

      if (pullRequest.user?.login !== RENOVATE_LOGIN) {
        return;
      }

      if (action === "closed" && pullRequest.merged === true) {
        await approveEverywhere({ ...context, headRef: pullRequest.head.ref });
      } else if (EVALUATED_ACTIONS.has(action)) {
        await evaluate(payload, [pullRequest.number], context);
      }
    },

    async status(delivery, context) {
      const payload = statusEvent.parse(delivery.payload);

      if (
        payload.state !== "success" ||
        !payload.branches.some(({ name }) =>
          name.startsWith(RENOVATE_BRANCH_PREFIX)
        )
      ) {
        return;
      }

      const octokit = await context.app.getInstallationOctokit(
        payload.installation.id
      );
      const { data: pulls } =
        await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
          commit_sha: payload.sha,
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
        });

      await evaluate(
        payload,
        pulls
          .filter(
            (pull) =>
              pull.state === "open" && pull.user?.login === RENOVATE_LOGIN
          )
          .map(({ number }) => number),
        context
      );
    },
  };
};
