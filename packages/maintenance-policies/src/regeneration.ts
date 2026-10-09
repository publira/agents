import { parse } from "yaml";
import { z } from "zod";

/**
 * Where a repository declares how its generated output is regenerated. A
 * repository without it is left alone.
 */
export const REGENERATION_CONFIG_PATH =
  ".github/maintenance-bot/regenerate.yml";

// The App cannot write here: that needs the Workflows permission.
const WORKFLOWS_DIRECTORY = ".github/workflows/";

const DIRECTORY_SUFFIX = "/**";

/**
 * A path relative to the repository's root, or a directory and everything
 * under it, written with a trailing `/**`.
 */
const pathPattern = z
  .string()
  .min(1)
  .refine(
    (pattern) => {
      const path = pattern.endsWith(DIRECTORY_SUFFIX)
        ? pattern.slice(0, -DIRECTORY_SUFFIX.length)
        : pattern;
      return (
        path !== "" &&
        !path.includes("*") &&
        path
          .split("/")
          .every(
            (segment) => segment !== "" && segment !== "." && segment !== ".."
          )
      );
    },
    { message: "must be a path from the root, or a directory ending in /**" }
  );

const regenerationConfig = z.strictObject({
  /** The command that regenerates the output, run by Bash at the root. */
  command: z.string().min(1),
  /** The generated output: the only paths the bot commits. */
  paths: z
    .array(
      pathPattern.refine(
        (pattern) => !pattern.startsWith(WORKFLOWS_DIRECTORY),
        { message: `must not be under ${WORKFLOWS_DIRECTORY}` }
      )
    )
    .min(1),
  /** Commands that install the generators, run by Bash before `command`. */
  setup: z.array(z.string().min(1)).default([]),
  /** The files whose change by Renovate calls for a regeneration. */
  triggers: z.array(pathPattern).min(1),
  /**
   * A workflow whose top-level `env` block, at the pull request's head, is
   * passed to `setup` and `command`, so the generators are the versions CI
   * verifies the output with.
   */
  workflowEnv: pathPattern.optional(),
});

export type RegenerationConfig = z.infer<typeof regenerationConfig>;

export type RegenerationConfigParseResult =
  | { result: "valid"; config: RegenerationConfig }
  | { result: "invalid"; reason: string };

/** Reads {@link REGENERATION_CONFIG_PATH}. */
export const parseRegenerationConfig = (
  source: string
): RegenerationConfigParseResult => {
  let value: unknown;
  try {
    value = parse(source);
  } catch (error) {
    return {
      reason: `${REGENERATION_CONFIG_PATH} is not YAML: ${error instanceof Error ? error.message : String(error)}`,
      result: "invalid",
    };
  }

  const parsed = regenerationConfig.safeParse(value);
  return parsed.success
    ? { config: parsed.data, result: "valid" }
    : {
        reason: `${REGENERATION_CONFIG_PATH}: ${z.prettifyError(parsed.error).replaceAll("\n", " ")}`,
        result: "invalid",
      };
};

/** Whether a path is one a pattern of the configuration names. */
export const matchesPathPattern = (pattern: string, path: string): boolean =>
  pattern.endsWith(DIRECTORY_SUFFIX)
    ? path.startsWith(pattern.slice(0, -DIRECTORY_SUFFIX.length + 1))
    : path === pattern;

/** Whether a path is one any of the patterns names. */
export const matchesAnyPathPattern = (
  patterns: readonly string[],
  path: string
): boolean => patterns.some((pattern) => matchesPathPattern(pattern, path));

const workflow = z.looseObject({
  env: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});

/**
 * Reads the top-level `env` block of a GitHub Actions workflow, as the
 * values every job of it sees, such as the versions of the tools it
 * installs. A workflow without one has none.
 */
export const readWorkflowEnv = (source: string): Record<string, string> => {
  const parsed = workflow.safeParse(parse(source));
  if (!parsed.success) {
    throw new Error(
      `The workflow's env block is not a map of values: ${z.prettifyError(parsed.error)}`
    );
  }
  return Object.fromEntries(
    Object.entries(parsed.data.env ?? {}).map(([name, value]) => [
      name,
      String(value),
    ])
  );
};
