import path from "node:path";

import { Sandbox as VercelSandbox } from "@vercel/sandbox";

import { loggableFailure } from "./log.ts";
import type { Log } from "./log.ts";

export interface SandboxCommand {
  cmd: string;
  args?: readonly string[];
  /** An absolute path. */
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  /** Kills the command once it has run this long. */
  timeoutMs: number;
}

export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A Linux machine, isolated from the app runtime, that runs commands. */
export interface Sandbox {
  run: (command: SandboxCommand) => Promise<SandboxCommandResult>;
  /** Writes a file, creating its directory; `file` is an absolute path. */
  writeFile: (file: string, content: string) => Promise<void>;
  /** Cuts the sandbox off from the network for the rest of its life. */
  denyNetwork: () => Promise<void>;
}

/**
 * Starts a new sandbox, runs `task` in it, and discards the sandbox once the
 * task settles. Nothing of the app runtime reaches the sandbox, its
 * environment variables and credentials included, unless `task` passes it.
 */
export type SandboxRunner = <T>(
  task: (sandbox: Sandbox) => Promise<T>
) => Promise<T>;

export interface VercelSandboxRunnerOptions {
  /**
   * How long a sandbox may live. Vercel stops it then, even when the task
   * never settles, such as when the function running it times out.
   */
  timeoutMs: number;
  log: Log;
}

/**
 * Runs each task in a new Vercel Sandbox, with Vercel's default image and
 * two vCPUs. The SDK authenticates with the Vercel project's OIDC token: on
 * Vercel without setup, and locally from `VERCEL_OIDC_TOKEN`, which
 * `vercel env pull` writes.
 */
export const createVercelSandboxRunner =
  ({ timeoutMs, log }: VercelSandboxRunnerOptions): SandboxRunner =>
  async (task) => {
    // A sandbox that is not persistent keeps nothing once it stops.
    const sandbox = await VercelSandbox.create({
      persistent: false,
      resources: { vcpus: 2 },
      timeout: timeoutMs,
    });

    try {
      return await task({
        async denyNetwork() {
          await sandbox.update({ networkPolicy: "deny-all" });
        },
        async run({ cmd, args = [], cwd, env, timeoutMs: commandTimeoutMs }) {
          const command = await sandbox.runCommand({
            args: [...args],
            cmd,
            cwd,
            env: { ...env },
            timeoutMs: commandTimeoutMs,
          });
          const [stdout, stderr] = await Promise.all([
            command.stdout(),
            command.stderr(),
          ]);
          return { exitCode: command.exitCode, stderr, stdout };
        },
        async writeFile(file, content) {
          await sandbox.fs.mkdir(path.posix.dirname(file), { recursive: true });
          await sandbox.fs.writeFile(file, content);
        },
      });
    } finally {
      // The sandbox stops at its timeout anyway, so a failed delete is
      // logged rather than hide how the task went.
      try {
        await sandbox.delete();
      } catch (error) {
        log("warn", "Sandbox not deleted; it stops at its timeout", {
          ...loggableFailure.safeParse(error).data,
          sandbox: sandbox.name,
        });
      }
    }
  };
