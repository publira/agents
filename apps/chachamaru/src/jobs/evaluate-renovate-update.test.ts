import { setTimeout as sleep } from "node:timers/promises";

import { createGitHubClient } from "@publira/github";
import type { GitHubApp } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import type { Log } from "#runtime/log.ts";
import type { SandboxRunner } from "#sandbox/runner.ts";

import type { applyLintFixes } from "./apply-lint-fixes.ts";
import type { approveEquivalentRenovateUpdate } from "./approve-equivalent-renovate-update.ts";
import type { autoMergeRenovateUpdate } from "./auto-merge-renovate-update.ts";
import {
  evaluateRenovateUpdate,
  evaluateRenovateUpdatesEverywhere,
  fixLintAndLog,
  SWEEP_SANDBOX_CONCURRENCY,
} from "./evaluate-renovate-update.ts";
import type {
  RepositorySandbox,
  RenovateUpdateSettings,
} from "./evaluate-renovate-update.ts";
import type {
  askReleaseAgeExemption,
  minimizeOutdatedReleaseAgeQuestions,
} from "./exempt-release-age-violations.ts";
import type { regenerateGeneratedOutput } from "./regenerate-generated-output.ts";
import type { syncDevContainerLockFile } from "./sync-devcontainer-lock-file.ts";

const BOT = "chachamaru-bot[bot]";
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
      reason: "the base branch has no .chachamaru/regenerate.yml",
      status: "skipped" as const,
    }),
  minimize = () => Promise.resolve(0),
  sandbox,
}: {
  minimize?: typeof minimizeOutdatedReleaseAgeQuestions;
  approval?: typeof approveEquivalentRenovateUpdate;
  merge?: typeof autoMergeRenovateUpdate;
  sync?: typeof syncDevContainerLockFile;
  regeneration?: typeof regenerateGeneratedOutput;
  /** Lets the evaluation regenerate. */
  sandbox?: RepositorySandbox;
} = {}) => {
  const minimizeOutdatedQuestions =
    vi.fn<typeof minimizeOutdatedReleaseAgeQuestions>(minimize);

  const syncLockFile = vi.fn<typeof syncDevContainerLockFile>(sync);
  const regenerate = vi.fn<typeof regenerateGeneratedOutput>(regeneration);
  const approve = vi.fn<typeof approveEquivalentRenovateUpdate>(approval);
  const autoMerge = vi.fn<typeof autoMergeRenovateUpdate>(merge);
  const log = vi.fn<Log>();

  return {
    approve,
    autoMerge,
    log,
    minimizeOutdatedQuestions,
    regenerate,
    run: (settings: Partial<RenovateUpdateSettings> = {}) =>
      evaluateRenovateUpdate({
        jobs: {
          approve,
          autoMerge,
          minimizeOutdatedQuestions,
          regenerate,
          syncLockFile,
        },
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

const regeneration: RepositorySandbox = {
  createReadToken: () => Promise.resolve("read-token"),
  sandbox: () => Promise.reject(new Error("The job is replaced")),
};

describe(evaluateRenovateUpdate, () => {
  it("minimizes the release age questions that no longer ask for anything", async () => {
    const { approve, log, minimizeOutdatedQuestions, run } = setup({
      minimize: () => Promise.resolve(2),
    });

    await run();

    expect(minimizeOutdatedQuestions).toHaveBeenCalledWith(
      expect.objectContaining({ botLogin: BOT, pullNumber: 31 })
    );
    expect(log).toHaveBeenCalledWith(
      "info",
      "Outdated release age questions minimized",
      expect.objectContaining({
        job: "exempt-release-age-violations",
        minimizedComments: 2,
      })
    );
    expect(approve).toHaveBeenCalledOnce();
  });

  it("logs nothing of the questions when none was minimized", async () => {
    const { log, run } = setup();

    await run();

    expect(log).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("release age"),
      expect.anything()
    );
  });

  it("minimizes no question in a dry run", async () => {
    const { minimizeOutdatedQuestions, run } = setup();

    await run({ dryRun: true });

    expect(minimizeOutdatedQuestions).not.toHaveBeenCalled();
  });

  it("warns when the questions could not be minimized and still evaluates", async () => {
    const { approve, log, run } = setup({
      minimize: () => Promise.reject(new Error("Server Error")),
    });

    await run();

    expect(log).toHaveBeenCalledWith(
      "warn",
      "Outdated release age questions not minimized",
      expect.objectContaining({ error: "Server Error" })
    );
    expect(approve).toHaveBeenCalledOnce();
  });

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
      ignoredPaths: [],
      paths: ["gen/api.pb.go"],
      status: "committed" as const,
      target: "codegen",
    },
    {
      ignoredPaths: [],
      paths: ["gen/api.pb.go"],
      status: "would-commit" as const,
      target: "codegen",
    },
    {
      ignoredPaths: [],
      paths: ["gen/api.pb.go"],
      status: "head-moved" as const,
      target: "codegen",
    },
  ])("leaves a head the regeneration $status to the push", async (target) => {
    const { approve, autoMerge, log, run } = setup({
      regeneration: () =>
        Promise.resolve({
          headSha: HEAD,
          status: "evaluated" as const,
          targets: [target],
        }),
      sandbox: regeneration,
    });

    await run();

    expect(log).toHaveBeenCalledWith(
      "info",
      "Generated output regeneration evaluated",
      expect.objectContaining({
        evaluationDeferred: true,
        paths: ["gen/api.pb.go"],
        status: target.status,
        target: "codegen",
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
          headSha: HEAD,
          status: "evaluated" as const,
          targets: [
            {
              exitCode: 1,
              output: "buf: plugin not found",
              status: "failed" as const,
              step: "command" as const,
              target: "codegen",
            },
          ],
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
        target: "codegen",
      })
    );
    expect(approve).toHaveBeenCalledOnce();
  });

  it("logs each target, and waits for the commit of one beside another's failure", async () => {
    const { approve, log, run } = setup({
      regeneration: () =>
        Promise.resolve({
          headSha: HEAD,
          status: "evaluated" as const,
          targets: [
            {
              commitSha: "regenerated",
              ignoredPaths: [],
              paths: ["gen/api.pb.go"],
              status: "committed" as const,
              target: "codegen",
            },
            {
              error: "Sandbox quota exceeded",
              status: "error" as const,
              target: "ios-packages",
            },
          ],
        }),
      sandbox: regeneration,
    });

    await run();

    expect(log).toHaveBeenCalledWith(
      "info",
      "Generated output regeneration evaluated",
      expect.objectContaining({
        commit: "regenerated",
        evaluationDeferred: true,
        status: "committed",
        target: "codegen",
      })
    );
    expect(log).toHaveBeenCalledWith(
      "error",
      "Generated output regeneration failed",
      expect.objectContaining({
        error: "Sandbox quota exceeded",
        evaluationDeferred: true,
        status: "error",
        target: "ios-packages",
      })
    );
    expect(approve).not.toHaveBeenCalled();
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
          outdatedReviews: { minimized: 1 },
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
        minimizedReviews: 1,
        precedent: "publira/publira#12",
        precedentApprovedBy: "ykzts",
        review: 80,
        reviewCreated: true,
        status: "approved",
      })
    );
  });

  it("warns when the earlier reviews could not be minimized", async () => {
    const { log, run } = setup({
      approval: () =>
        Promise.resolve({
          conditions: [],
          headSha: HEAD,
          outdatedReviews: {
            error: "Resource not accessible by integration",
          },
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
      "warn",
      "Renovate update evaluated",
      expect.objectContaining({
        minimizeError: "Resource not accessible by integration",
        review: 80,
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

// Applies the lint fixes with `fix` in place of the job.
const fixWith = async (
  fix: typeof applyLintFixes,
  exempt: typeof askReleaseAgeExemption = () =>
    Promise.reject(new Error("unused"))
) => {
  const log = vi.fn<Log>();

  const deferred = await fixLintAndLog({
    dryRun: true,
    exempt,
    fix,
    lintFix: regeneration,
    log,
    octokit: createGitHubClient(),
    owner: "publira",
    pullNumber: 31,
    repo: "agents",
    reviewer: BOT,
  });

  return { deferred, log };
};

describe(fixLintAndLog, () => {
  it("defers the evaluation to the push of a commit it would make", async () => {
    const { deferred, log } = await fixWith(() =>
      Promise.resolve({
        checkPassed: true,
        headSha: HEAD,
        output: undefined,
        paths: ["README.md"],
        status: "would-commit" as const,
      })
    );

    expect(deferred).toBeTruthy();
    expect(log).toHaveBeenCalledWith(
      "info",
      "Lint fix evaluated",
      expect.objectContaining({
        dryRun: true,
        evaluationDeferred: true,
        job: "apply-lint-fixes",
        paths: ["README.md"],
        pullRequest: 31,
        status: "would-commit",
      })
    );
  });

  it("warns of a refused fix", async () => {
    const { deferred, log } = await fixWith(() =>
      Promise.resolve({
        headSha: HEAD,
        paths: ["pnpm-lock.yaml"],
        reason: "the fix changed files it has no reason to change",
        refusedPaths: ["pnpm-lock.yaml"],
        status: "refused" as const,
      })
    );

    expect(deferred).toBeFalsy();
    expect(log).toHaveBeenCalledWith(
      "warn",
      "Lint fix evaluated",
      expect.objectContaining({
        evaluationDeferred: false,
        refusedPaths: ["pnpm-lock.yaml"],
      })
    );
  });

  it("asks for exemptions when pnpm refused to install for the release age", async () => {
    const reading = {
      result: "violations" as const,
      violations: [
        {
          name: "playwright",
          publishedAt: new Date("2026-10-07T18:01:58.238Z"),
          version: "1.64.0",
        },
      ],
    };

    const exempt = vi.fn<typeof askReleaseAgeExemption>(() =>
      Promise.resolve({
        entries: ["playwright@1.64.0"],
        headSha: HEAD,
        status: "would-ask" as const,
      })
    );

    const { deferred, log } = await fixWith(
      () =>
        Promise.resolve({
          exitCode: 1,
          headSha: HEAD,
          output: "Error: ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION",
          releaseAge: reading,
          status: "failed" as const,
          step: "install" as const,
        }),
      exempt
    );

    expect(exempt).toHaveBeenCalledWith(
      expect.objectContaining({
        botLogin: BOT,
        dryRun: true,
        headSha: HEAD,
        reading,
      })
    );
    expect(deferred).toBeFalsy();
    expect(log).toHaveBeenCalledWith(
      "info",
      "Release age exemption evaluated",
      expect.objectContaining({
        entries: ["playwright@1.64.0"],
        evaluationDeferred: false,
        job: "exempt-release-age-violations",
        modelInvoked: false,
        status: "would-ask",
      })
    );
  });

  it("defers the evaluation to the push of the exemption it would commit", async () => {
    const { deferred, log } = await fixWith(
      () =>
        Promise.resolve({
          exitCode: 1,
          headSha: HEAD,
          output: "Error: ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION",
          releaseAge: { reason: "unreadable", result: "unreadable" as const },
          status: "failed" as const,
          step: "install" as const,
        }),
      () =>
        Promise.resolve({
          approvedIn:
            "https://github.com/publira/agents/pull/31#issuecomment-1",
          entries: ["playwright@1.64.0"],
          headSha: HEAD,
          status: "would-commit" as const,
          subject: "chore(deps): exempt playwright from minimumReleaseAge",
        })
    );

    expect(deferred).toBeTruthy();
    expect(log).toHaveBeenCalledWith(
      "info",
      "Release age exemption evaluated",
      expect.objectContaining({ evaluationDeferred: true })
    );
  });

  it("logs an exemption that threw", async () => {
    const { deferred, log } = await fixWith(
      () =>
        Promise.resolve({
          exitCode: 1,
          headSha: HEAD,
          output: "Error: ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION",
          releaseAge: { reason: "unreadable", result: "unreadable" as const },
          status: "failed" as const,
          step: "install" as const,
        }),
      () => Promise.reject(new Error("Server Error"))
    );

    expect(deferred).toBeFalsy();
    expect(log).toHaveBeenCalledWith(
      "error",
      "Release age exemption failed",
      expect.objectContaining({ error: "Server Error" })
    );
  });

  it("logs a fix that threw", async () => {
    const { deferred, log } = await fixWith(() =>
      Promise.reject(new Error("Server Error"))
    );

    expect(deferred).toBeFalsy();
    expect(log).toHaveBeenCalledWith(
      "error",
      "Lint fix failed",
      expect.objectContaining({ error: "Server Error" })
    );
  });
});

const sandbox: SandboxRunner = () =>
  Promise.reject(new Error("The evaluation is replaced"));

// An App installed on publira/agents, whose open pull requests are `pulls`.
const fakeApp = (pulls: readonly { number: number; user: object }[]) => {
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
          : pulls
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

  return { app, requests };
};

const settings = { dryRun: false, renovateAutoMerge: true };

// Regenerates nothing but #33, which it commits to, after a moment.
const regenerateSlowly = (state: { running: number; mostRunning: number }) =>
  vi.fn<typeof regenerateGeneratedOutput>(async ({ pullNumber }) => {
    state.running += 1;
    state.mostRunning = Math.max(state.mostRunning, state.running);
    await sleep(5);
    state.running -= 1;

    return pullNumber === 33
      ? {
          headSha: HEAD,
          status: "evaluated" as const,
          targets: [
            {
              commitSha: "regenerated",
              ignoredPaths: [],
              paths: ["gen/api.pb.go"],
              status: "committed" as const,
              target: "default",
            },
          ],
        }
      : {
          headSha: HEAD,
          reason:
            "Renovate's commits change no file that calls for a regeneration",
          status: "skipped" as const,
        };
  });

const pullNumbers = [31, 32, 33, 34, 35, 36];

const sweepWithSandbox = async () => {
  const { app } = fakeApp([
    ...pullNumbers.map((number) => ({ number, user: renovate })),
    { number: 40, user: maintainer },
  ]);

  const state = { mostRunning: 0, running: 0 };
  const regenerate = regenerateSlowly(state);

  // Fixes the lint of #35 only.
  const fixLint = vi.fn<typeof applyLintFixes>(({ pullNumber }) =>
    Promise.resolve(
      pullNumber === 35
        ? {
            checkPassed: true,
            commitSha: "fixed",
            headSha: HEAD,
            output: undefined,
            paths: ["README.md"],
            status: "committed" as const,
          }
        : {
            headSha: HEAD,
            reason: "no check on the head failed",
            status: "skipped" as const,
          }
    )
  );

  const evaluate = vi.fn<typeof evaluateRenovateUpdate>(() =>
    Promise.resolve()
  );

  const log = vi.fn<Log>();

  await evaluateRenovateUpdatesEverywhere({
    app,
    evaluate,
    fixLint,
    log,
    regenerate,
    sandbox,
    settings,
  });

  return { evaluate, fixLint, log, regenerate, state };
};

describe(evaluateRenovateUpdatesEverywhere, () => {
  it("applies the lint fixes to the heads the regeneration did not move", async () => {
    const { fixLint, log } = await sweepWithSandbox();

    expect(
      fixLint.mock.calls.map(([options]) => options.pullNumber)
    ).toStrictEqual([31, 32, 34, 35, 36]);
    expect(fixLint).toHaveBeenCalledWith(
      expect.objectContaining({
        botLogin: BOT,
        createReadToken: expect.any(Function),
        dryRun: false,
        owner: "publira",
        repo: "agents",
        sandbox,
      })
    );
    expect(log).toHaveBeenCalledWith(
      "info",
      "Lint fix evaluated",
      expect.objectContaining({
        commit: "fixed",
        evaluationDeferred: true,
        installation: 1,
        job: "apply-lint-fixes",
        modelInvoked: false,
        pullRequest: 35,
      })
    );
  });

  it("evaluates the open Renovate pull requests from the branch", async () => {
    const { app, requests } = fakeApp([
      { number: 31, user: renovate },
      { number: 32, user: maintainer },
    ]);

    const evaluate = vi.fn<typeof evaluateRenovateUpdate>(() =>
      Promise.resolve()
    );

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

  it("leaves the generated output alone without a sandbox", async () => {
    const { app } = fakeApp([{ number: 31, user: renovate }]);

    const evaluate = vi.fn<typeof evaluateRenovateUpdate>(() =>
      Promise.resolve()
    );

    const regenerate = vi.fn<typeof regenerateGeneratedOutput>();
    const fixLint = vi.fn<typeof applyLintFixes>();

    await evaluateRenovateUpdatesEverywhere({
      app,
      evaluate,
      fixLint,
      log: vi.fn<Log>(),
      regenerate,
      settings,
    });

    expect(regenerate).not.toHaveBeenCalled();
    expect(fixLint).not.toHaveBeenCalled();
    expect(evaluate.mock.calls[0]?.[0].regeneration).toBeUndefined();
  });

  it("regenerates a few pull requests of a repository at a time", async () => {
    const { regenerate, state } = await sweepWithSandbox();

    expect(
      regenerate.mock.calls.map(([options]) => options.pullNumber)
    ).toStrictEqual(pullNumbers);
    expect(regenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        botLogin: BOT,
        createReadToken: expect.any(Function),
        dryRun: false,
        owner: "publira",
        repo: "agents",
        sandbox,
      })
    );
    expect(state.mostRunning).toBe(SWEEP_SANDBOX_CONCURRENCY);
  });

  it("then evaluates the pull requests the regeneration did not move", async () => {
    const { evaluate, log } = await sweepWithSandbox();

    expect(log).toHaveBeenCalledWith(
      "info",
      "Generated output regeneration evaluated",
      expect.objectContaining({
        evaluationDeferred: true,
        installation: 1,
        job: "regenerate-generated-output",
        pullRequest: 33,
      })
    );
    // The bot's commits moved the heads of #33 and #35; their pushes are
    // evaluated.
    expect(
      evaluate.mock.calls.map(([options]) => options.pullNumber)
    ).toStrictEqual([31, 32, 34, 36]);
    expect(
      evaluate.mock.calls.every(
        ([options]) => options.regeneration === undefined
      )
    ).toBeTruthy();
  });
});
