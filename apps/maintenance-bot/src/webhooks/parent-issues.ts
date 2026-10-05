import { getParentIssue, issueLocationOf } from "@publira/github";
import type { IssueLocation, Octokit, RepositoryName } from "@publira/github";
import { z } from "zod";

import {
  closeCompletedParentIssue,
  summarizeCloseCompletedParentIssueResult,
} from "../jobs/close-completed-parent-issue.ts";
import { loggableFailure, withFields } from "../log.ts";
import { readSettings } from "../settings.ts";
import type { WebhookHandler } from "./receive-webhook.ts";

const repository = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
});

const issue = z.object({ number: z.number(), repository_url: z.string() });

const issuesEvent = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
  issue,
});

const subIssuesEvent = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
  parent_issue: issue,
  repository: repository.optional(),
  sub_issue: issue,
});

const formatIssue = ({ owner, repo, issueNumber }: IssueLocation) =>
  `${owner}/${repo}#${issueNumber}`;

// GitHub's answer when the App is not installed on a repository.
const notInstalled = z.object({ status: z.literal(404) });

export interface ParentIssueHandlerOptions {
  close: typeof closeCompletedParentIssue;
  /** Reads the settings for each delivery. */
  readSettings: typeof readSettings;
}

/**
 * The handlers that close an issue as completed once all of its sub-issues
 * are closed, as the settings allow, by event name:
 *
 * - `issues` evaluates the parent of an issue that was closed. The bot's own
 *   close of a parent is delivered too, so its parent is evaluated in turn.
 * - `sub_issues` evaluates a parent whose sub-issue was removed, which may
 *   have been the last one open.
 *
 * Tests replace the job.
 */
export const createParentIssueHandlers = ({
  close = closeCompletedParentIssue,
  readSettings: read = readSettings,
}: Partial<ParentIssueHandlerOptions> = {}): Record<
  "issues" | "sub_issues",
  WebhookHandler
> => {
  const evaluate = async (
    {
      dryRun,
      installationId,
      deliveredTo,
      parent,
      subIssue,
    }: {
      dryRun: boolean;
      installationId: number;
      /** Where the event was delivered, which the installation covers. */
      deliveredTo: RepositoryName;
      parent: IssueLocation;
      subIssue: IssueLocation;
    },
    { app, log }: Parameters<WebhookHandler>[1]
  ) => {
    const jobLog = withFields(log, {
      dryRun,
      installation: installationId,
      issue: parent.issueNumber,
      job: "close-completed-parent-issue",
      owner: parent.owner,
      repo: parent.repo,
      subIssue: formatIssue(subIssue),
    });

    try {
      let octokit: Octokit;
      if (
        parent.owner === deliveredTo.owner &&
        parent.repo === deliveredTo.repo
      ) {
        octokit = await app.getInstallationOctokit(installationId);
      } else {
        try {
          octokit = await app.getRepositoryOctokit(parent);
        } catch (error) {
          if (!notInstalled.safeParse(error).success) {
            throw error;
          }
          jobLog(
            "info",
            "Parent issue left: the App is not installed on its repository",
            { modelInvoked: false, status: "left" }
          );
          return;
        }
      }

      const result = await close({
        ...parent,
        author: await app.getBotLogin(),
        dryRun,
        octokit,
      });
      jobLog(
        "info",
        "Parent issue evaluated",
        summarizeCloseCompletedParentIssueResult(result)
      );
    } catch (error) {
      jobLog(
        "error",
        "Parent issue evaluation failed",
        loggableFailure.safeParse(error).data
      );
    }
  };

  return {
    async issues(delivery, context) {
      const payload = issuesEvent.parse(delivery.payload);

      if (payload.action !== "closed") {
        return;
      }
      const { dryRun, parentIssueClosing } = read(context.log);
      if (!parentIssueClosing) {
        return;
      }

      const subIssue = issueLocationOf(payload.issue);
      const parent = await getParentIssue(
        await context.app.getInstallationOctokit(payload.installation.id),
        subIssue
      );

      if (parent === undefined) {
        return;
      }

      await evaluate(
        {
          deliveredTo: subIssue,
          dryRun,
          installationId: payload.installation.id,
          parent,
          subIssue,
        },
        context
      );
    },

    async sub_issues(delivery, context) {
      const payload = subIssuesEvent.parse(delivery.payload);

      if (payload.action !== "sub_issue_removed") {
        return;
      }
      const { dryRun, parentIssueClosing } = read(context.log);
      if (!parentIssueClosing) {
        return;
      }

      const parent = issueLocationOf(payload.parent_issue);

      await evaluate(
        {
          deliveredTo:
            payload.repository === undefined
              ? parent
              : {
                  owner: payload.repository.owner.login,
                  repo: payload.repository.name,
                },
          dryRun,
          installationId: payload.installation.id,
          parent,
          subIssue: issueLocationOf(payload.sub_issue),
        },
        context
      );
    },
  };
};
