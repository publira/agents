import { parse, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import { z } from "zod";

export type FeatureReferencesParseResult =
  | { result: "parsed"; references: string[] }
  | { result: "invalid"; reason: string };

const configSchema = z.looseObject({
  features: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Reads the Feature references of a `devcontainer.json`, in the order it
 * lists them. The file is JSON with comments and trailing commas, as the Dev
 * Container CLI reads it.
 */
export const parseFeatureReferences = (
  text: string
): FeatureReferencesParseResult => {
  const errors: ParseError[] = [];
  const config: unknown = parse(text, errors, {
    allowTrailingComma: true,
  });

  if (errors.length > 0) {
    return {
      reason: `it does not parse: ${errors
        .map(
          ({ error, offset }) => `${printParseErrorCode(error)} at ${offset}`
        )
        .join(", ")}`,
      result: "invalid",
    };
  }

  const parsed = configSchema.safeParse(config);

  return parsed.success
    ? { references: Object.keys(parsed.data.features ?? {}), result: "parsed" }
    : { reason: "its features are not an object", result: "invalid" };
};
