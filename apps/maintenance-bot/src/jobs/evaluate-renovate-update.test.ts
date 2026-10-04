import { createGitHubClient } from "@publira/github";
import type { GitHubApp } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import type { Log } from "../log.ts";
import type { approveEquivalentRenovateUpdate } from "./approve-equivalent-renovate-update.ts";
import type { autoMergeRenovateUpdate } from "./auto-merge-renovate-update.ts";
import {
  evaluateRenovateUpdate,
  evaluateRenovateUpdatesEverywhere,
} from "./evaluate-renovate-update.ts";
import type { RenovateUpdateSettings } from "./evaluate-renovate-update.ts";

const BOT = "publira-maintenance[bot]";
const HEAD = "4658aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const renovate = { login: "renovate[bot]", type: "Bot" };
const maintainer = { login: "ykzts", type: "User" };

const setup = ({
  approval = () =>
    Promise.resolve({
      conditions: [],
      headSha: HEAD,
      status: "skipped" as const,
    }),
  merge = () => Promise.resolve({ headSha: HEAD, status: "disabled" as const }),
}: {
  approval?: typeof approveEquivalentRenovateUpdate;
  merge?: typeof autoMergeRenovateUpdate;
} = {}) => {
  const approve = vi.fn<typeof approveEquivalentRenovateUpdate>(approval);
  const autoMerge = vi.fn<typeof autoMergeRenovateUpdate>(merge);
  const log = vi.fn<Log>();

  return {
    approve,
    autoMerge,
    log,
    run: (settings: Partial<RenovateUpdateSettings> = {}) =>
      evaluateRenovateUpdate({
        jobs: { approve, autoMerge },
        log,
        octokit: createGitHubClient(),
        owner: "publira",
        pullNumber: 31,
        repo: "agents",
        reviewer: BOT,
        settings: {
          dryRun: false,
          renovateApproval: true,
          renovateAutoMerge: true,
          ...settings,
        },
      }),
  };
};

describe(evaluateRenovateUpdate, () => {
  it("approves, then decides on auto-merge as configured", async () => {
    const { approve, autoMerge, log, run } = setup({
      merge: () =>
        Promise.resolve({
          headSha: HEAD,
          mergeMethod: "SQUASH" as const,
          status: "enabled" as const,
        }),
    });

    await run();

    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false, pullNumber: 31, reviewer: BOT })
    );
    expect(autoMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: false,
        enabled: true,
        pullNumber: 31,
        reviewer: BOT,
      })
    );
    expect(log).toHaveBeenCalledWith(
      "info",
      "Renovate update evaluated",
      expect.objectContaining({
        job: "approve-equivalent-renovate-update",
        modelInvoked: false,
        pullRequest: 31,
        status: "skipped",
      })
    );
    expect(log).toHaveBeenLastCalledWith(
      "info",
      "Renovate update auto-merge evaluated",
      expect.objectContaining({
        autoMerge: "enabled",
        job: "auto-merge-renovate-update",
        mergeMethod: "SQUASH",
      })
    );
  });

  it("logs the precedent, its approver, and the review of an approval", async () => {
    const { log, run } = setup({
      approval: () =>
        Promise.resolve({
          conditions: [],
          headSha: HEAD,
          precedent: {
            approvedBy: "ykzts",
            mergedAt: new Date("2026-10-01T00:00:00Z"),
            number: 12,
            owner: "publira",
            repo: "publira",
            url: "https://github.com/publira/publira/pull/12",
          },
          review: { created: true, id: 80 },
          status: "approved" as const,
        }),
    });

    await run();

    expect(log).toHaveBeenCalledWith(
      "info",
      "Renovate update evaluated",
      expect.objectContaining({
        precedent: "publira/publira#12",
        precedentApprovedBy: "ykzts",
        review: 80,
        reviewCreated: true,
        status: "approved",
      })
    );
  });

  it("passes a dry run to both jobs", async () => {
    const { approve, autoMerge, run } = setup();

    await run({ dryRun: true });

    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true })
    );
    expect(autoMerge).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true })
    );
  });

  it("does not approve while approval is off, but still decides on auto-merge", async () => {
    const { approve, autoMerge, run } = setup();

    await run({ renovateApproval: false });

    expect(approve).not.toHaveBeenCalled();
    expect(autoMerge).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true })
    );
  });

  it("records the reason auto-merge was declined", async () => {
    const { log, run } = setup({
      merge: () =>
        Promise.resolve({
          headSha: HEAD,
          reason: "it has conflicts",
          status: "declined" as const,
        }),
    });

    await run();

    expect(log).toHaveBeenLastCalledWith(
      "info",
      "Renovate update auto-merge evaluated",
      expect.objectContaining({
        autoMerge: "declined",
        autoMergeReason: "it has conflicts",
        pullRequest: 31,
      })
    );
  });

  it("still decides on auto-merge when the approval failed", async () => {
    const { autoMerge, log, run } = setup({
      approval: () => Promise.reject(new Error("Bad credentials")),
    });

    await run({ renovateAutoMerge: false });

    expect(log).toHaveBeenCalledWith(
      "error",
      "Renovate update approval failed",
      expect.objectContaining({ error: "Bad credentials" })
    );
    expect(autoMerge).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });

  it("logs nothing about auto-merge while it is off and left nothing", async () => {
    const { log, run } = setup();

    await run({ renovateAutoMerge: false });

    expect(log).toHaveBeenCalledExactlyOnceWith(
      "info",
      "Renovate update evaluated",
      expect.any(Object)
    );
  });

  it("logs a failed auto-merge without throwing", async () => {
    const { log, run } = setup({
      merge: () => Promise.reject(new Error("Server Error")),
    });

    await expect(run()).resolves.toBeUndefined();
    expect(log).toHaveBeenLastCalledWith(
      "error",
      "Renovate update auto-merge failed",
      expect.objectContaining({ error: "Server Error" })
    );
  });
});

describe(evaluateRenovateUpdatesEverywhere, () => {
  it("evaluates the open Renovate pull requests from the branch", async () => {
    const requests: string[] = [];
    const octokit = createGitHubClient({
      fetch: (input) => {
        const url = new URL(String(input));
        requests.push(`${url.pathname}${url.search}`);
        const response = Response.json(
          url.pathname === "/installation/repositories"
            ? {
                repositories: [
                  {
                    archived: false,
                    default_branch: "main",
                    name: "agents",
                    owner: { login: "publira" },
                  },
                ],
                total_count: 1,
              }
            : [
                { number: 31, user: renovate },
                { number: 32, user: maintainer },
              ]
        );
        Object.defineProperty(response, "url", { value: url.href });
        return Promise.resolve(response);
      },
    });
    const app: GitHubApp = {
      getBotLogin: () => Promise.resolve(BOT),
      getInstallationOctokit: () => Promise.resolve(octokit),
      getRepositoryOctokit: () => Promise.reject(new Error("unused")),
      octokit: createGitHubClient({
        fetch: (input) => {
          const url = new URL(String(input));
          const response = Response.json(
            url.pathname === "/app/installations"
              ? [{ id: 1, suspended_at: null }]
              : { message: "Not Found" },
            { status: url.pathname === "/app/installations" ? 200 : 404 }
          );
          Object.defineProperty(response, "url", { value: url.href });
          return Promise.resolve(response);
        },
      }),
    };
    const evaluate = vi.fn<typeof evaluateRenovateUpdate>(() =>
      Promise.resolve()
    );

    const settings = {
      dryRun: false,
      renovateApproval: true,
      renovateAutoMerge: true,
    };
    const log = vi.fn<Log>();

    await evaluateRenovateUpdatesEverywhere({
      app,
      evaluate,
      headRef: "renovate/turbo-monorepo",
      log,
      settings,
    });

    expect(evaluate).toHaveBeenCalledOnce();
    const [options] = evaluate.mock.calls[0] ?? [];
    options?.log("info", "line");
    expect(log).toHaveBeenCalledWith("info", "line", { installation: 1 });
    expect(options).toMatchObject({
      owner: "publira",
      precedentScanCache: expect.any(Object),
      pullNumber: 31,
      repo: "agents",
      reviewer: BOT,
      settings,
    });
    expect(requests).toContain(
      "/repos/publira/agents/pulls?head=publira%3Arenovate%2Fturbo-monorepo&per_page=100&state=open"
    );
  });
});
