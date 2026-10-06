import type { Log } from "./log.ts";

/** What the deployment's environment lets the bot do. */
export interface Settings {
  /**
   * Every job evaluates and logs what it would do, but writes nothing to
   * GitHub.
   */
  dryRun: boolean;
  /**
   * Has GitHub merge the Renovate pull requests the bot approved. Off, the
   * bot still takes back an auto-merge it enabled before.
   */
  renovateAutoMerge: boolean;
}

interface Switch {
  variable: string;
  /** The value without the variable, or with it empty. */
  unset: boolean;
  /** The value when the variable holds neither `true` nor `false`. */
  invalid: boolean;
}

// An invalid value takes the safe side: dry run on, auto-merge off.
const switches: Readonly<Record<keyof Settings, Switch>> = {
  dryRun: { invalid: true, unset: false, variable: "DRY_RUN" },
  renovateAutoMerge: {
    invalid: false,
    unset: false,
    variable: "RENOVATE_AUTO_MERGE",
  },
};

/**
 * Reads the settings from the environment. Each variable is `true` or
 * `false`; without one, or with it empty, its default applies. Any other
 * value is logged as an error and read as the safe side, so a typo does not
 * pass for a decision: dry run on, auto-merge off.
 */
export const readSettings = (
  log: Log,
  env: Readonly<Record<string, string | undefined>> = process.env
): Settings => {
  const read = ({ variable, unset, invalid }: Switch) => {
    const value = env[variable] ?? "";

    if (value === "") {
      return unset;
    }
    if (value === "true" || value === "false") {
      return value === "true";
    }
    log("error", "Setting is invalid; using the safe value", {
      setting: variable,
      value: invalid,
    });
    return invalid;
  };

  return {
    dryRun: read(switches.dryRun),
    renovateAutoMerge: read(switches.renovateAutoMerge),
  };
};
