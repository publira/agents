import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";

import type {
  ExclusionEditor,
  ExclusionEditRequest,
} from "./jobs/remove-expired-release-age-exclusions.ts";

// The agent's model, as agent/agent.ts selects it. On Vercel, AI Gateway
// authenticates the deployment through its OIDC token; elsewhere it needs
// AI_GATEWAY_API_KEY.
const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

// How long the call may take, its retries included. A cleanup that runs out
// of time fails, and the next day's run tries it again.
const TIMEOUT_MS = 120_000;

const instructions = `You edit the minimumReleaseAgeExclude list in a pnpm-workspace.yaml file. Some entries have expired and are being removed. Which ones has already been decided from the npm registry; do not judge it.

Choose the lines of the block to delete:

- Delete the line of every entry you are given, and of no other entry.
- Delete a comment that describes only entries being removed, such as a note that they are temporary or a link to the release they were added for.
- Keep a comment that also describes an entry that stays, or the setting as a whole.
- Delete a blank line only when it would otherwise leave two blank lines together.
- When no entries remain, delete the minimumReleaseAgeExclude line as well, with the comments above it that describe only the list.

You can only delete lines; you cannot rewrite one. The file is checked after your edit, and an edit that changes anything else is rejected.`;

const prompt = ({ lines, selectors, reason }: ExclusionEditRequest) =>
  [
    "Remove these entries:",
    "",
    ...selectors.map((selector) => `- ${selector}`),
    "",
    `The fixed rules could not make this edit: ${reason}.`,
    "",
    "The block, with line numbers:",
    "",
    ...lines.map((line, index) => `${index + 1}: ${line}`),
  ].join("\n");

const outputSchema = z.object({
  deleteLines: z
    .array(z.number().int().positive())
    .describe("The numbers of the lines to delete."),
});

/**
 * An {@link ExclusionEditor} that asks a model which lines to delete. It sees
 * only the `minimumReleaseAgeExclude` block, not the rest of the file.
 */
export const createModelExclusionEditor =
  (model: LanguageModel = DEFAULT_MODEL): ExclusionEditor =>
  async (request) => {
    const { output, response } = await generateText({
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      instructions,
      model,
      output: Output.object({ name: "edit", schema: outputSchema }),
      prompt: prompt(request),
    });
    // The model that answered, for the Assisted-by trailer.
    return { lineNumbers: output.deleteLines, model: response.modelId };
  };
