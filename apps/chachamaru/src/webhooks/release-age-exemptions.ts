import { RENOVATE_LOGIN } from "@publira/maintenance-policies";
import { z } from "zod";

import {
  approveReleaseAgeExemption,
  summarizeReleaseAgeExemptionResult,
} from "#jobs/exempt-release-age-violations.ts";
import { loggableFailure, withFields } from "#runtime/log.ts";
import { readSettings } from "#runtime/settings.ts";

import type { WebhookHandler } from "./receive-webhook.ts";

const issueCommentEvent = z.object({
  action: z.string(),
  comment: z.object({
    body: z.string().nullable(),
    html_url: z.string(),
    id: z.number(),
    user: z.object({ login: z.string() }).nullable(),
  }),
  installation: z.object({ id: z.number() }),
  issue: z.object({
    number: z.number(),
    // Only a pull request's comments carry it.
    pull_request: z.looseObject({}).optional(),
    user: z.object({ login: z.string() }).nullable(),
  }),
  repository: z.object({
    name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
});

export interface ReleaseAgeExemptionHandlerOptions {
  approve: typeof approveReleaseAgeExemption;
  /** Reads the settings for each delivery. */
  readSettings: typeof readSettings;
}

/**
 * The handler that takes a new comment on a Renovate pull request as a
 * maintainer's approval of the bot's question whether to exempt versions
 * from `minimumReleaseAge`, and commits the entries, by event name. The job
 * decides whether the comment counts. Tests replace it.
 */
export const createReleaseAgeExemptionHandlers = ({
  approve = approveReleaseAgeExemption,
  readSettings: read = readSettings,
}: Partial<ReleaseAgeExemptionHandlerOptions> = {}): Record<
  "issue_comment",
  WebhookHandler
> => ({
  async issue_comment(delivery, { app, log }) {
    const payload = issueCommentEvent.parse(delivery.payload);
    const { comment, issue } = payload;

    if (
      payload.action !== "created" ||
      issue.pull_request === undefined ||
      issue.user?.login !== RENOVATE_LOGIN ||
      comment.user === null
    ) {
      return;
    }

    const { dryRun } = read(log);

    const location = {
      owner: payload.repository.owner.login,
      pullNumber: issue.number,
      repo: payload.repository.name,
    };

    const jobLog = withFields(log, {
      dryRun,
      installation: payload.installation.id,
      job: "exempt-release-age-violations",
      owner: location.owner,
      pullRequest: location.pullNumber,
      repo: location.repo,
      requestAuthor: comment.user.login,
      requestComment: comment.id,
    });

    try {
      const [octokit, botLogin] = await Promise.all([
        app.getInstallationOctokit(payload.installation.id),
        app.getBotLogin(),
      ]);

      const result = await approve({
        ...location,
        botLogin,
        comment: {
          author: comment.user.login,
          body: comment.body ?? "",
          id: comment.id,
          url: comment.html_url,
        },
        dryRun,
        octokit,
      });

      jobLog(
        result.status === "refused" ? "warn" : "info",
        "Release age exemption approval evaluated",
        summarizeReleaseAgeExemptionResult(result)
      );
    } catch (error) {
      jobLog("error", "Release age exemption approval failed", {
        ...loggableFailure.safeParse(error).data,
        modelInvoked: false,
      });
    }
  },
});
