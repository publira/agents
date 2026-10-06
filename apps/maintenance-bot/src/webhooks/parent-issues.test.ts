import { createGitHubClient } from "@publira/github";
import type { GitHubApp, WebhookDelivery } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import type { closeCompletedParentIssue } from "../jobs/close-completed-parent-issue.ts";
import type { Log } from "../log.ts";
import type { Settings } from "../settings.ts";
import { createParentIssueHandlers } from "./parent-issues.ts";

const BOT = "publira-maintenance[bot]";

type Json =
  | boolean
  | number
  | string
  | null
  | readonly Json[]
  | { readonly [key: string]: Json | undefined };

// publira/agents#52 is a sub-issue of publira/publira#3408, and #53 has no
// parent.
const installationOctokit = createGitHubClient({
  fetch: (input) =>
    Promise.resolve(
      new URL(String(input)).pathname ===
        "/repos/publira/agents/issues/52/parent"
        ? Response.json({
            number: 3408,
            repository_url: "https://api.github.com/repos/publira/publira",
          })
        : Response.json({ message: "Not Found" }, { status: 404 })
    ),
});
const repositoryOctokit = createGitHubClient();

const issue = (repo: string, number: number) => ({
  number,
  repository_url: `https://api.github.com/repos/publira/${repo}`,
});

const setup = ({
  installed = true,
  settings = {},
}: { installed?: boolean; settings?: Partial<Settings> } = {}) => {
  const close = vi.fn<typeof closeCompletedParentIssue>(() =>
    Promise.resolve({ reason: "it has no sub-issues", status: "left" })
  );
  const app: GitHubApp = {
    getBotLogin: () => Promise.resolve(BOT),
    getInstallationOctokit: () => Promise.resolve(installationOctokit),
    getRepositoryOctokit: () =>
      installed
        ? Promise.resolve(repositoryOctokit)
        : Promise.reject(
            Object.assign(new Error("Not Found"), { status: 404 })
          ),
    octokit: createGitHubClient(),
  };

  return {
    close,
    context: { app, log: vi.fn<Log>() },
    handlers: createParentIssueHandlers({
      close,
      readSettings: () => ({
        dryRun: false,
        renovateAutoMerge: false,
        ...settings,
      }),
    }),
  };
};

const delivery = (
  name: string,
  payload: Readonly<Record<string, Json>>
): WebhookDelivery => ({
  id: "delivery-1",
  name,
  payload: {
    installation: { id: 42 },
    repository: { name: "agents", owner: { login: "publira" } },
    ...payload,
  },
});

describe("issues", () => {
  it("evaluates the parent of a closed issue, in its own repository", async () => {
    const { close, context, handlers } = setup({ settings: { dryRun: true } });

    await handlers.issues(
      delivery("issues", { action: "closed", issue: issue("agents", 52) }),
      context
    );

    expect(close).toHaveBeenCalledWith({
      author: BOT,
      dryRun: true,
      issueNumber: 3408,
      octokit: repositoryOctokit,
      owner: "publira",
      repo: "publira",
    });
    expect(context.log).toHaveBeenCalledWith(
      "info",
      "Parent issue evaluated",
      expect.objectContaining({
        installation: 42,
        issue: 3408,
        job: "close-completed-parent-issue",
        modelInvoked: false,
        owner: "publira",
        repo: "publira",
        status: "left",
        subIssue: "publira/agents#52",
      })
    );
  });

  it("leaves a parent in a repository the App is not installed on", async () => {
    const { close, context, handlers } = setup({ installed: false });

    await handlers.issues(
      delivery("issues", { action: "closed", issue: issue("agents", 52) }),
      context
    );

    expect(close).not.toHaveBeenCalled();
    expect(context.log).toHaveBeenCalledWith(
      "info",
      "Parent issue left: the App is not installed on its repository",
      expect.objectContaining({ issue: 3408, status: "left" })
    );
  });

  it.each([
    ["an issue without a parent", "closed", 53],
    ["an issue that was reopened", "reopened", 52],
  ])("ignores %s", async (_, action, number) => {
    const { close, context, handlers } = setup();

    await handlers.issues(
      delivery("issues", { action, issue: issue("agents", number) }),
      context
    );

    expect(close).not.toHaveBeenCalled();
  });

  it("logs a failed evaluation", async () => {
    const { close, context, handlers } = setup();
    close.mockRejectedValue(
      Object.assign(new Error("Server Error"), { status: 500 })
    );

    await handlers.issues(
      delivery("issues", { action: "closed", issue: issue("agents", 52) }),
      context
    );

    expect(context.log).toHaveBeenCalledWith(
      "error",
      "Parent issue evaluation failed",
      expect.objectContaining({
        error: "Server Error",
        issue: 3408,
        status: 500,
      })
    );
  });
});

describe("sub_issues", () => {
  it("evaluates a parent whose sub-issue was removed", async () => {
    const { close, context, handlers } = setup();

    await handlers.sub_issues(
      delivery("sub_issues", {
        action: "sub_issue_removed",
        parent_issue: issue("agents", 51),
        sub_issue: issue("publira", 3500),
      }),
      context
    );

    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 51,
        octokit: installationOctokit,
        owner: "publira",
        repo: "agents",
      })
    );
  });

  it("ignores a sub-issue that was added", async () => {
    const { close, context, handlers } = setup();

    await handlers.sub_issues(
      delivery("sub_issues", {
        action: "sub_issue_added",
        parent_issue: issue("agents", 51),
        sub_issue: issue("agents", 52),
      }),
      context
    );

    expect(close).not.toHaveBeenCalled();
  });
});
