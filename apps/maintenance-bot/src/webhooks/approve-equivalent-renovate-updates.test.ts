import { createGitHubClient } from "@publira/github";
import type { GitHubApp, WebhookDelivery } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import type {
  approveEquivalentRenovateUpdate,
  approveEquivalentRenovateUpdatesEverywhere,
} from "../jobs/approve-equivalent-renovate-update.ts";
import type { Log } from "../log.ts";
import { createRenovateApprovalHandlers } from "./approve-equivalent-renovate-updates.ts";

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

const setup = () => {
  const approve = vi.fn<typeof approveEquivalentRenovateUpdate>(() =>
    Promise.resolve({ conditions: [], headSha: "head", status: "skipped" })
  );
  const approveEverywhere = vi.fn<
    typeof approveEquivalentRenovateUpdatesEverywhere
  >(() => Promise.resolve());

  return {
    approve,
    approveEverywhere,
    context: { app, log: vi.fn<Log>() },
    /** The pull requests evaluated one by one. */
    evaluated: () => approve.mock.calls.map(([options]) => options.pullNumber),
    handlers: createRenovateApprovalHandlers({ approve, approveEverywhere }),
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
    const { approve, context, evaluated, handlers } = setup();

    await handlers.pull_request(
      delivery("pull_request", {
        action: "synchronize",
        pull_request: pullRequest(),
      }),
      context
    );

    expect(evaluated()).toStrictEqual([31]);
    expect(approve.mock.calls[0]?.[0]).toMatchObject({
      owner: "publira",
      repo: "agents",
      reviewer: BOT,
    });
  });

  it("evaluates the open pull requests from the branch of a merged one", async () => {
    const { approveEverywhere, context, evaluated, handlers } = setup();

    await handlers.pull_request(
      delivery("pull_request", {
        action: "closed",
        pull_request: pullRequest({ merged: true }),
      }),
      context
    );

    expect(approveEverywhere).toHaveBeenCalledWith(
      expect.objectContaining({ headRef: "renovate/turbo-monorepo" })
    );
    expect(evaluated()).toStrictEqual([]);
  });

  it("ignores a pull request someone else opened", async () => {
    const { context, evaluated, handlers } = setup();

    await handlers.pull_request(
      delivery("pull_request", {
        action: "opened",
        pull_request: pullRequest({ user: { login: "ykzts" } }),
      }),
      context
    );

    expect(evaluated()).toStrictEqual([]);
  });

  it("ignores a pull request closed without merging", async () => {
    const { approveEverywhere, context, evaluated, handlers } = setup();

    await handlers.pull_request(
      delivery("pull_request", {
        action: "closed",
        pull_request: pullRequest(),
      }),
      context
    );

    expect(evaluated()).toStrictEqual([]);
    expect(approveEverywhere).not.toHaveBeenCalled();
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
