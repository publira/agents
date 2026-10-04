import type { Log } from "./log.ts";

const VARIABLE = "RENOVATE_AUTO_MERGE";

/**
 * Reads whether the bot may auto-merge the Renovate pull requests it
 * approved, from `RENOVATE_AUTO_MERGE`: `true` turns it on, and `false` or no
 * value leaves it off. Approval does not depend on it. Any other value throws,
 * so a typo does not pass for a decision.
 */
export const readRenovateAutoMerge = (
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean => {
  const value = env[VARIABLE] ?? "";

  if (value === "true") {
    return true;
  }
  if (value === "false" || value === "") {
    return false;
  }
  throw new Error(`${VARIABLE} must be true or false`);
};

/**
 * {@link readRenovateAutoMerge}, with a misconfiguration logged and taken as
 * off, so that approval goes on without it.
 */
export const renovateAutoMergeEnabled = (
  log: Log,
  env?: Readonly<Record<string, string | undefined>>
): boolean => {
  try {
    return readRenovateAutoMerge(env);
  } catch (error) {
    log("error", "Renovate auto-merge is off: its setting is invalid", {
      error: error instanceof Error ? error.message : undefined,
    });
    return false;
  }
};
