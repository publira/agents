import { parse } from "yaml";
import { z } from "zod";

/**
 * Where a repository declares how its generated output is regenerated. A
 * repository without it is left alone.
 */
export const REGENERATION_CONFIG_PATH = ".chachamaru/regenerate.yml";

// The App cannot write here: that needs the Workflows permission.
const WORKFLOWS_DIRECTORY = ".github/workflows/";

const DIRECTORY_SUFFIX = "/**";

/**
 * Where {@link REGENERATION_CONFIG_JSON_SCHEMA} is served, from the bot's own
 * deployment, and the schema's `$id`. `v1` is its major version, raised only
 * for a change that makes a valid declaration invalid.
 */
export const REGENERATION_CONFIG_SCHEMA_URL =
  "https://chachamaru.publira.dev/schemas/regenerate/v1.json";

// The descriptions become the JSON Schema's, which an editor shows on hover.
// The refinements have no JSON Schema form, so the descriptions state them.
const pathPattern = z
  .string()
  .min(1)
  .describe(
    "A path from the repository's root, or a directory and everything under it with a trailing `/**`. `*` is allowed only in that suffix, and no segment may be empty, `.`, or `..`."
  )
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

/**
 * Whether a pattern matches a path under the workflows directory: a path
 * there, or the directory itself, under it, or above it, such as `.github/**`.
 */
const reachesWorkflows = (pattern: string) => {
  if (!pattern.endsWith(DIRECTORY_SUFFIX)) {
    return pattern.startsWith(WORKFLOWS_DIRECTORY);
  }
  const directory = pattern.slice(0, -DIRECTORY_SUFFIX.length + 1);
  return (
    directory.startsWith(WORKFLOWS_DIRECTORY) ||
    WORKFLOWS_DIRECTORY.startsWith(directory)
  );
};

const regenerationConfig = z
  .strictObject({
    command: z
      .string()
      .min(1)
      .describe(
        "The command that regenerates the output, run by Bash at the repository's root."
      ),
    paths: z
      .array(
        pathPattern.refine((pattern) => !reachesWorkflows(pattern), {
          message: `must not match anything under ${WORKFLOWS_DIRECTORY}`,
        })
      )
      .min(1)
      .describe(
        `The generated output: the only paths the bot commits. None may match anything under \`${WORKFLOWS_DIRECTORY}\`, which the bot cannot write, so \`.github/**\` is refused too.`
      ),
    setup: z
      .array(z.string().min(1))
      .default([])
      .describe(
        "Commands that install the generators, run by Bash before `command`. `~/.local/bin` is on the PATH."
      ),
    triggers: z
      .array(pathPattern)
      .min(1)
      .describe("The files whose change by Renovate calls for a regeneration."),
    workflowEnv: pathPattern
      .optional()
      .describe(
        "The path from the repository's root of a workflow whose top-level `env` block, at the pull request's head, is passed to `setup` and `command`, so the generators are the versions CI verifies the output with."
      ),
  })
  .meta({
    description: `How Chachamaru regenerates a repository's generated output on a Renovate pull request, read from \`${REGENERATION_CONFIG_PATH}\` on the base branch.`,
    title: "Chachamaru regeneration",
  });

const { $schema, ...jsonSchema } = z.toJSONSchema(regenerationConfig, {
  // What a repository writes, so `setup`, which has a default, is optional.
  io: "input",
  // Editors and validators that predate draft 2020-12 read draft-07, and the
  // schema uses no keyword whose meaning differs between the two.
  target: "draft-07",
});

/**
 * {@link REGENERATION_CONFIG_PATH}'s JSON Schema, for editors and other
 * validators. It cannot express the refinements of the path patterns, so
 * {@link parseRegenerationConfig} remains the authority.
 */
export const REGENERATION_CONFIG_JSON_SCHEMA = {
  $id: REGENERATION_CONFIG_SCHEMA_URL,
  $schema,
  ...jsonSchema,
};

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
