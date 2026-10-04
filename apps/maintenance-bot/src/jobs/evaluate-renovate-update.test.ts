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
    run: (autoMergeEnabled = true) =>
      evaluateRenovateUpdate({
        autoMerge: autoMergeEnabled,
        jobs: { approve, autoMerge },
        log,
        octokit: createGitHubClient(),
        owner: "publira",
        pullNumber: 31,
        repo: "agents",
        reviewer: BOT,
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

    await run(true);

    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ pullNumber: 31, reviewer: BOT })
    );
    expect(autoMerge).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, pullNumber: 31, reviewer: BOT })
    );
    expect(log).toHaveBeenLastCalledWith(
      "info",
      "Renovate update auto-merge evaluated",
      expect.objectContaining({ autoMerge: "enabled", mergeMethod: "SQUASH" })
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

    await run(false);

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

    await run(false);

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

    await evaluateRenovateUpdatesEverywhere({
      app,
      autoMerge: true,
      evaluate,
      headRef: "renovate/turbo-monorepo",
      log: vi.fn<Log>(),
    });

    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
      autoMerge: true,
      owner: "publira",
      precedentScanCache: expect.any(Object),
      pullNumber: 31,
      repo: "agents",
      reviewer: BOT,
    });
    expect(requests).toContain(
      "/repos/publira/agents/pulls?head=publira%3Arenovate%2Fturbo-monorepo&per_page=100&state=open"
    );
  });
});
