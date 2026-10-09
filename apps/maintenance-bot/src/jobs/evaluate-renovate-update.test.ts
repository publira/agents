import { createGitHubClient } from "@publira/github";
import type { GitHubApp } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import type { Log } from "../log.ts";
import type { SandboxRunner } from "../sandbox-runner.ts";
import type { approveEquivalentRenovateUpdate } from "./approve-equivalent-renovate-update.ts";
import type { autoMergeRenovateUpdate } from "./auto-merge-renovate-update.ts";
import {
  evaluateRenovateUpdate,
  evaluateRenovateUpdatesEverywhere,
} from "./evaluate-renovate-update.ts";
import type {
  Regeneration,
  RenovateUpdateSettings,
} from "./evaluate-renovate-update.ts";
import type { regenerateGeneratedOutput } from "./regenerate-generated-output.ts";
import type { syncDevContainerLockFile } from "./sync-devcontainer-lock-file.ts";

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
  sync = () =>
    Promise.resolve({
      headSha: HEAD,
      reason: "the pull request changes no Dev Container configuration",
      status: "skipped" as const,
    }),
  regeneration = () =>
    Promise.resolve({
      headSha: HEAD,
      reason: "the base branch has no .github/maintenance-bot/regenerate.yml",
      status: "skipped" as const,
    }),
  sandbox,
}: {
  approval?: typeof approveEquivalentRenovateUpdate;
  merge?: typeof autoMergeRenovateUpdate;
  sync?: typeof syncDevContainerLockFile;
  regeneration?: typeof regenerateGeneratedOutput;
  /** Lets the evaluation regenerate. */
  sandbox?: Regeneration;
} = {}) => {
  const syncLockFile = vi.fn<typeof syncDevContainerLockFile>(sync);
  const regenerate = vi.fn<typeof regenerateGeneratedOutput>(regeneration);
  const approve = vi.fn<typeof approveEquivalentRenovateUpdate>(approval);
  const autoMerge = vi.fn<typeof autoMergeRenovateUpdate>(merge);
  const log = vi.fn<Log>();

  return {
    approve,
    autoMerge,
    log,
    regenerate,
    run: (settings: Partial<RenovateUpdateSettings> = {}) =>
      evaluateRenovateUpdate({
        jobs: { approve, autoMerge, regenerate, syncLockFile },
        log,
        octokit: createGitHubClient(),
        owner: "publira",
        pullNumber: 31,
        regeneration: sandbox,
        repo: "agents",
        reviewer: BOT,
        settings: {
          dryRun: false,
          renovateAutoMerge: true,
          ...settings,
        },
      }),
    syncLockFile,
  };
};

const regeneration: Regeneration = {
  createReadToken: () => Promise.resolve("read-token"),
  sandbox: () => Promise.reject(new Error("The job is replaced")),
};

describe(evaluateRenovateUpdate, () => {
  it("syncs the Dev Container lock files before it approves", async () => {
    const { approve, log, run, syncLockFile } = setup();

    await run();

    expect(syncLockFile).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false, pullNumber: 31 })
    );
    expect(log).toHaveBeenCalledWith(
      "info",
      "Dev Container lock file sync evaluated",
      expect.objectContaining({
        evaluationDeferred: false,
        job: "sync-devcontainer-lock-file",
        modelInvoked: false,
        status: "skipped",
      })
    );
    expect(approve).toHaveBeenCalledOnce();
  });

  it.each([
    {
      commitSha: "lock",
      headSha: HEAD,
      lockFiles: [".devcontainer/devcontainer-lock.json"],
      message:
        "chore(devcontainer): sync the lock file with docker-in-docker 4.1.3",
      status: "committed" as const,
    },
    {
      files: { ".devcontainer/devcontainer-lock.json": "{}" },
      headSha: HEAD,
      lockFiles: [".devcontainer/devcontainer-lock.json"],
      message:
        "chore(devcontainer): sync the lock file with docker-in-docker 4.1.3",
      status: "would-commit" as const,
    },
    {
      headSha: HEAD,
      lockFiles: [".devcontainer/devcontainer-lock.json"],
      status: "head-moved" as const,
    },
  ])("leaves a head the lock file sync $status to the push", async (result) => {
    const { approve, autoMerge, log, run } = setup({
      sync: () => Promise.resolve(result),
    });

    await run({ dryRun: result.status === "would-commit" });

    expect(log).toHaveBeenCalledWith(
      "info",
      "Dev Container lock file sync evaluated",
      expect.objectContaining({
        evaluationDeferred: true,
        status: result.status,
      })
    );
    expect(approve).not.toHaveBeenCalled();
    expect(autoMerge).not.toHaveBeenCalled();
  });

  it("still evaluates when the lock file sync failed", async () => {
    const { approve, autoMerge, log, run } = setup({
      sync: () => Promise.reject(new Error("Server Error")),
    });

    await run();

    expect(log).toHaveBeenCalledWith(
      "error",
      "Dev Container lock file sync failed",
      expect.objectContaining({ error: "Server Error" })
    );
    expect(approve).toHaveBeenCalledOnce();
    expect(autoMerge).toHaveBeenCalledOnce();
  });

  it("leaves the generated output alone without a sandbox", async () => {
    const { approve, regenerate, run } = setup();

    await run();

    expect(regenerate).not.toHaveBeenCalled();
    expect(approve).toHaveBeenCalledOnce();
  });

  it("regenerates the generated output before it approves", async () => {
    const { approve, log, regenerate, run } = setup({ sandbox: regeneration });

    await run({ dryRun: true });

    expect(regenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        ...regeneration,
        botLogin: BOT,
        dryRun: true,
        pullNumber: 31,
      })
    );
    expect(log).toHaveBeenCalledWith(
      "info",
      "Generated output regeneration evaluated",
      expect.objectContaining({
        evaluationDeferred: false,
        job: "regenerate-generated-output",
        modelInvoked: false,
        status: "skipped",
      })
    );
    expect(approve).toHaveBeenCalledOnce();
  });

  it.each([
    {
      commitSha: "regenerated",
      headSha: HEAD,
      ignoredPaths: [],
      paths: ["gen/api.pb.go"],
      status: "committed" as const,
    },
    {
      headSha: HEAD,
      ignoredPaths: [],
      paths: ["gen/api.pb.go"],
      status: "would-commit" as const,
    },
    {
      headSha: HEAD,
      ignoredPaths: [],
      paths: ["gen/api.pb.go"],
      status: "head-moved" as const,
    },
  ])("leaves a head the regeneration $status to the push", async (result) => {
    const { approve, autoMerge, log, run } = setup({
      regeneration: () => Promise.resolve(result),
      sandbox: regeneration,
    });

    await run();

    expect(log).toHaveBeenCalledWith(
      "info",
      "Generated output regeneration evaluated",
      expect.objectContaining({
        evaluationDeferred: true,
        paths: ["gen/api.pb.go"],
        status: result.status,
      })
    );
    expect(approve).not.toHaveBeenCalled();
    expect(autoMerge).not.toHaveBeenCalled();
  });

  it("does not regenerate a head the lock file sync commits to", async () => {
    const { regenerate, run } = setup({
      sandbox: regeneration,
      sync: () =>
        Promise.resolve({
          headSha: HEAD,
          lockFiles: [".devcontainer/devcontainer-lock.json"],
          status: "head-moved" as const,
        }),
    });

    await run();

    expect(regenerate).not.toHaveBeenCalled();
  });

  it("warns of a failed regeneration and still evaluates", async () => {
    const { approve, log, run } = setup({
      regeneration: () =>
        Promise.resolve({
          exitCode: 1,
          headSha: HEAD,
          output: "buf: plugin not found",
          status: "failed" as const,
          step: "command" as const,
        }),
      sandbox: regeneration,
    });

    await run();

    expect(log).toHaveBeenCalledWith(
      "warn",
      "Generated output regeneration evaluated",
      expect.objectContaining({
        evaluationDeferred: false,
        output: "buf: plugin not found",
        step: "command",
      })
    );
    expect(approve).toHaveBeenCalledOnce();
  });

  it("logs a regeneration that threw and still evaluates", async () => {
    const { approve, log, run } = setup({
      regeneration: () => Promise.reject(new Error("Sandbox quota exceeded")),
      sandbox: regeneration,
    });

    await run();

    expect(log).toHaveBeenCalledWith(
      "error",
      "Generated output regeneration failed",
      expect.objectContaining({ error: "Sandbox quota exceeded" })
    );
    expect(approve).toHaveBeenCalledOnce();
  });

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
            updates: [],
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

  it("logs that auto-merge is off when it left nothing to take back", async () => {
    const { log, run } = setup();

    await run({ renovateAutoMerge: false });

    expect(log).toHaveBeenLastCalledWith(
      "info",
      "Renovate update auto-merge evaluated",
      expect.objectContaining({
        autoMerge: "disabled",
        job: "auto-merge-renovate-update",
      })
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

const sandbox: SandboxRunner = () =>
  Promise.reject(new Error("The evaluation is replaced"));

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
      renovateAutoMerge: true,
    };
    const log = vi.fn<Log>();

    await evaluateRenovateUpdatesEverywhere({
      app,
      evaluate,
      headRef: "renovate/turbo-monorepo",
      log,
      sandbox,
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
      regeneration: { createReadToken: expect.any(Function), sandbox },
      repo: "agents",
      reviewer: BOT,
      settings,
    });
    expect(requests).toContain(
      "/repos/publira/agents/pulls?head=publira%3Arenovate%2Fturbo-monorepo&per_page=100&state=open"
    );
  });
});
