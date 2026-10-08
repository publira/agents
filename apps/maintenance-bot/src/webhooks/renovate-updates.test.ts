import { createGitHubClient } from "@publira/github";
import type { GitHubApp, WebhookDelivery } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import type {
  evaluateRenovateUpdate,
  evaluateRenovateUpdatesEverywhere,
} from "../jobs/evaluate-renovate-update.ts";
import type {
  SyncDevContainerLockFileResult,
  syncDevContainerLockFile,
} from "../jobs/sync-devcontainer-lock-file.ts";
import type { Log } from "../log.ts";
import { createRenovateUpdateHandlers } from "./renovate-updates.ts";

const BOT = "publira-maintenance[bot]";

type Json =
  | boolean
  | number
  | string
  | null
  | readonly Json[]
  | { readonly [key: string]: Json | undefined };

// Answers the commit's pull requests for the status handler.
const octokit = createGitHubClient({
  fetch: (input) =>
    Promise.resolve(
      Response.json(
        new URL(String(input)).pathname ===
          "/repos/publira/agents/commits/head/pulls"
          ? [
              { number: 31, state: "open", user: { login: "renovate[bot]" } },
              { number: 30, state: "closed", user: { login: "renovate[bot]" } },
              { number: 29, state: "open", user: { login: "ykzts" } },
            ]
          : []
      )
    ),
});

const app: GitHubApp = {
  getBotLogin: () => Promise.resolve(BOT),
  getInstallationOctokit: () => Promise.resolve(octokit),
  getRepositoryOctokit: () => Promise.reject(new Error("unused")),
  octokit: createGitHubClient(),
};

const setup = ({
  autoMerge = false,
  synced = Promise.resolve<SyncDevContainerLockFileResult>({
    headSha: "head",
    reason: "the pull request changes no Dev Container configuration",
    status: "skipped",
  }),
}: {
  autoMerge?: boolean;
  synced?: Promise<SyncDevContainerLockFileResult>;
} = {}) => {
  const evaluate = vi.fn<typeof evaluateRenovateUpdate>(() =>
    Promise.resolve()
  );
  const syncLockFile = vi.fn<typeof syncDevContainerLockFile>(() => synced);
  const evaluateEverywhere = vi.fn<typeof evaluateRenovateUpdatesEverywhere>(
    () => Promise.resolve()
  );

  return {
    context: { app, log: vi.fn<Log>() },
    evaluate,
    evaluateEverywhere,
    /** The pull requests evaluated one by one. */
    evaluated: () => evaluate.mock.calls.map(([options]) => options.pullNumber),
    handlers: createRenovateUpdateHandlers({
      evaluate,
      evaluateEverywhere,
      readSettings: () => ({
        dryRun: false,
        renovateAutoMerge: autoMerge,
      }),
      syncLockFile,
    }),
    syncLockFile,
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

const pullRequest = (fields: Readonly<Record<string, Json>> = {}) => ({
  head: { ref: "renovate/turbo-monorepo" },
  merged: false,
  number: 31,
  user: { login: "renovate[bot]" },
  ...fields,
});

const checkSuite = (fields: Readonly<Record<string, Json>> = {}) => ({
  conclusion: "success",
  head_branch: "renovate/turbo-monorepo",
  pull_requests: [{ number: 31 }],
  ...fields,
});

const status = (fields: Readonly<Record<string, Json>> = {}) =>
  delivery("status", {
    branches: [{ name: "renovate/turbo-monorepo" }],
    sha: "head",
    state: "success",
    ...fields,
  });

describe("pull_request", () => {
  it("evaluates a Renovate pull request that changed", async () => {
    const { context, evaluate, evaluated, handlers } = setup({
      autoMerge: true,
    });

    await handlers.pull_request(
      delivery("pull_request", {
        action: "synchronize",
        pull_request: pullRequest(),
      }),
      context
    );

    expect(evaluated()).toStrictEqual([31]);
    const [options] = evaluate.mock.calls[0] ?? [];
    expect(options).toMatchObject({
      owner: "publira",
      repo: "agents",
      reviewer: BOT,
      settings: { renovateAutoMerge: true },
    });
    options?.log("info", "line");
    expect(context.log).toHaveBeenCalledWith("info", "line", {
      installation: 42,
    });
  });

  it.each(["opened", "synchronize"])(
    "syncs the lock files of a pull request %s, then evaluates it",
    async (action) => {
      const { context, evaluated, handlers, syncLockFile } = setup();

      await handlers.pull_request(
        delivery("pull_request", { action, pull_request: pullRequest() }),
        context
      );

      expect(syncLockFile).toHaveBeenCalledWith(
        expect.objectContaining({
          dryRun: false,
          owner: "publira",
          pullNumber: 31,
          repo: "agents",
        })
      );
      expect(context.log).toHaveBeenCalledWith(
        "info",
        "Dev Container lock file sync evaluated",
        expect.objectContaining({
          installation: 42,
          job: "sync-devcontainer-lock-file",
          modelInvoked: false,
          pullRequest: 31,
          status: "skipped",
        })
      );
      expect(evaluated()).toStrictEqual([31]);
    }
  );

  it("leaves the evaluation to the push of its lock file commit", async () => {
    const { context, evaluated, handlers } = setup({
      synced: Promise.resolve({
        commitSha: "lock",
        headSha: "head",
        lockFiles: [".devcontainer/devcontainer-lock.json"],
        message:
          "chore(devcontainer): sync the lock file with docker-in-docker 4.1.3",
        status: "committed",
      }),
    });

    await handlers.pull_request(
      delivery("pull_request", {
        action: "synchronize",
        pull_request: pullRequest(),
      }),
      context
    );

    expect(evaluated()).toStrictEqual([]);
  });

  it("evaluates a pull request whose lock file sync failed", async () => {
    const { context, evaluated, handlers } = setup({
      synced: Promise.reject(
        Object.assign(new Error("Server Error"), { status: 502 })
      ),
    });

    await handlers.pull_request(
      delivery("pull_request", {
        action: "synchronize",
        pull_request: pullRequest(),
      }),
      context
    );

    expect(context.log).toHaveBeenCalledWith(
      "error",
      "Dev Container lock file sync failed",
      expect.objectContaining({ error: "Server Error", status: 502 })
    );
    expect(evaluated()).toStrictEqual([31]);
  });

  it("does not sync the lock files after an edit of the description", async () => {
    const { context, evaluated, handlers, syncLockFile } = setup();

    await handlers.pull_request(
      delivery("pull_request", {
        action: "edited",
        pull_request: pullRequest(),
      }),
      context
    );

    expect(syncLockFile).not.toHaveBeenCalled();
    expect(evaluated()).toStrictEqual([31]);
  });

  it("evaluates the open pull requests from the branch of a merged one", async () => {
    const { context, evaluateEverywhere, evaluated, handlers } = setup();

    await handlers.pull_request(
      delivery("pull_request", {
        action: "closed",
        pull_request: pullRequest({ merged: true }),
      }),
      context
    );

    expect(evaluateEverywhere).toHaveBeenCalledWith(
      expect.objectContaining({
        headRef: "renovate/turbo-monorepo",
        settings: expect.objectContaining({ renovateAutoMerge: false }),
      })
    );
    expect(evaluated()).toStrictEqual([]);
  });

  it("ignores a pull request someone else opened", async () => {
    const { context, evaluated, handlers, syncLockFile } = setup();

    await handlers.pull_request(
      delivery("pull_request", {
        action: "opened",
        pull_request: pullRequest({ user: { login: "ykzts" } }),
      }),
      context
    );

    expect(evaluated()).toStrictEqual([]);
    expect(syncLockFile).not.toHaveBeenCalled();
  });

  it("ignores a pull request closed without merging", async () => {
    const { context, evaluateEverywhere, evaluated, handlers } = setup();

    await handlers.pull_request(
      delivery("pull_request", {
        action: "closed",
        pull_request: pullRequest(),
      }),
      context
    );

    expect(evaluated()).toStrictEqual([]);
    expect(evaluateEverywhere).not.toHaveBeenCalled();
  });
});

describe("check_suite", () => {
  it("evaluates the pull requests of a suite that passed", async () => {
    const { context, evaluated, handlers } = setup();

    await handlers.check_suite(
      delivery("check_suite", {
        action: "completed",
        check_suite: checkSuite(),
      }),
      context
    );

    expect(evaluated()).toStrictEqual([31]);
  });

  it.each([
    ["a failed suite", { conclusion: "failure" }],
    ["another branch", { head_branch: "main" }],
  ])("ignores %s", async (_, fields) => {
    const { context, evaluated, handlers } = setup();

    await handlers.check_suite(
      delivery("check_suite", {
        action: "completed",
        check_suite: checkSuite(fields),
      }),
      context
    );

    expect(evaluated()).toStrictEqual([]);
  });
});

describe("status", () => {
  it("evaluates the open Renovate pull requests of the commit", async () => {
    const { context, evaluated, handlers } = setup();

    await handlers.status(status(), context);

    expect(evaluated()).toStrictEqual([31]);
  });

  it.each([
    ["a pending status", { state: "pending" }],
    ["another branch", { branches: [{ name: "main" }] }],
  ])("ignores %s", async (_, fields) => {
    const { context, evaluated, handlers } = setup();

    await handlers.status(status(fields), context);

    expect(evaluated()).toStrictEqual([]);
  });
});
