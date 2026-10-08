import { z } from "zod";

/** An entry of `devcontainer-lock.json`. */
export interface LockFileFeature {
  version: string;
  /** `registry/repository@digest` for a Feature in an OCI registry. */
  resolved: string;
  integrity: string;
  /** The references of the Features it depends on, if it does. */
  dependsOn?: readonly string[];
}

/** How a lock file is written, so that an edit keeps it. */
export interface LockFileFormat {
  indent: string;
  finalNewline: boolean;
}

export type LockFileParseResult =
  | {
      result: "parsed";
      /** The entries by Feature reference, in the file's order. */
      entries: [string, LockFileFeature][];
      format: LockFileFormat;
    }
  | { result: "invalid"; reason: string };

// Strict: an edit that dropped a field would change more than the entry.
const lockFileSchema = z.strictObject({
  features: z.record(
    z.string(),
    z.strictObject({
      dependsOn: z.array(z.string()).optional(),
      integrity: z.string(),
      resolved: z.string(),
      version: z.string(),
    })
  ),
});

/**
 * Writes a lock file as the Dev Container CLI does, `JSON.stringify` with
 * each entry's fields in its order, in the given format.
 */
export const formatLockFile = (
  entries: readonly (readonly [string, LockFileFeature])[],
  { indent, finalNewline }: LockFileFormat
): string => {
  const features = Object.fromEntries(
    entries.map(([reference, { version, resolved, integrity, dependsOn }]) => [
      reference,
      // oxlint-disable-next-line sort-keys -- the order the CLI writes them in
      { version, resolved, integrity, dependsOn },
    ])
  );
  return `${JSON.stringify({ features }, null, indent)}${finalNewline ? "\n" : ""}`;
};

/**
 * Reads a `devcontainer-lock.json`. Only a file that {@link formatLockFile}
 * writes back unchanged parses, so that an edit changes nothing but the
 * entries it replaces.
 */
export const parseLockFile = (text: string): LockFileParseResult => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { reason: "it is not JSON", result: "invalid" };
  }

  const parsed = lockFileSchema.safeParse(json);
  if (!parsed.success) {
    return {
      reason: "it holds more or other than the Features' entries",
      result: "invalid",
    };
  }

  const entries = Object.entries(parsed.data.features);
  const format = {
    finalNewline: text.endsWith("\n"),
    indent: /^\{\n(?<indent>[ \t]+)"/u.exec(text)?.groups?.indent ?? "  ",
  };

  return formatLockFile(entries, format) === text
    ? { entries, format, result: "parsed" }
    : {
        reason: "it is not formatted as the Dev Container CLI writes it",
        result: "invalid",
      };
};
