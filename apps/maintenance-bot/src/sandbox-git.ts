// The Git commands the sandboxed jobs run to read back what a third-party
// command changed in a worktree.
import { parseCatFileBatch, parseRawDiff } from "./git-output.ts";
import type { GitFileChange } from "./git-output.ts";
import type { Sandbox, SandboxCommand } from "./sandbox-runner.ts";

// How much of a failed command's output a result keeps, from its end.
const OUTPUT_LIMIT = 2000;

const GIT_TIMEOUT_MS = 30_000;

/** The end of a command's output, short enough to log. */
export const tail = (output: string): string =>
  output.length > OUTPUT_LIMIT ? output.slice(-OUTPUT_LIMIT) : output;

/** Runs a command that has to succeed and returns its output. */
export const runChecked = async (
  sandbox: Sandbox,
  command: SandboxCommand
): Promise<string> => {
  const result = await sandbox.run(command);
  if (result.exitCode !== 0) {
    throw new Error(
      `${[command.cmd, ...(command.args ?? [])].join(" ")} exited with ${result.exitCode}: ${tail(result.stderr)}`
    );
  }
  return result.stdout;
};

/** Runs Git in a worktree. */
export const git = (
  sandbox: Sandbox,
  worktree: string,
  ...args: string[]
): Promise<string> =>
  runChecked(sandbox, {
    args: ["-C", worktree, ...args],
    cmd: "git",
    timeoutMs: GIT_TIMEOUT_MS,
  });

/**
 * The options that let Git read from GitHub with a token, or none for an
 * anonymous read. The token goes in a header on the command line, so it is
 * not stored in the repository's configuration, where the commands run in
 * the worktree afterwards could read it.
 */
export const readTokenOptions = (readToken: string | undefined): string[] =>
  readToken === undefined
    ? []
    : [
        "-c",
        `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${readToken}`).toString("base64")}`,
      ];

/**
 * Stages every change in the worktree and lists them against `HEAD`, with
 * their modes and blobs, symbolic links included, without reading the files.
 */
export const stageChanges = async (
  sandbox: Sandbox,
  worktree: string
): Promise<GitFileChange[]> => {
  await git(sandbox, worktree, "add", "--all");
  return parseRawDiff(
    await git(
      sandbox,
      worktree,
      "diff",
      "--cached",
      "--raw",
      "-z",
      "--no-renames",
      "--no-abbrev",
      "HEAD"
    )
  );
};

/**
 * Reads blobs by object ID. The output of a command arrives as text, so
 * binary content crosses over in Base64.
 */
export const readBlobs = async (
  sandbox: Sandbox,
  worktree: string,
  shas: readonly string[]
): Promise<Map<string, Buffer>> =>
  shas.length === 0
    ? new Map()
    : parseCatFileBatch(
        Buffer.from(
          await runChecked(sandbox, {
            args: [
              "-c",
              `printf '%s\\n' "$@" | git -C ${worktree} cat-file --batch | base64 -w 0`,
              "cat-file",
              ...new Set(shas),
            ],
            cmd: "bash",
            timeoutMs: GIT_TIMEOUT_MS,
          }),
          "base64"
        )
      );
