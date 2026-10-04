import { z } from "zod";

/** The login Renovate, the Mend-hosted GitHub App, opens pull requests as. */
export const RENOVATE_LOGIN = "renovate[bot]";

/**
 * The comment the organization's Renovate preset writes at the top of a pull
 * request body for each update, through `prHeader`:
 *
 * ```text
 * <!-- publira-renovate-update eyJtYW5hZ2VyIjoibnBtIiwi... -->
 * ```
 *
 * The payload is the update's fields as JSON, in Base64 so that no markdown
 * or emoji processing can change it.
 */
export const RENOVATE_UPDATE_MARKER = "publira-renovate-update";

const MARKER_LINE = new RegExp(
  `^<!-- ${RENOVATE_UPDATE_MARKER} (?<payload>[A-Za-z0-9+/]+={0,2}) -->$`,
  "u"
);

/**
 * The update types an equivalent update can be approved for. A replacement
 * changes the dependency's name, which the metadata does not record, and lock
 * file maintenance updates no dependency in particular.
 */
const SUPPORTED_UPDATE_TYPES = [
  "bump",
  "digest",
  "major",
  "minor",
  "patch",
  "pin",
  "pinDigest",
  "rollback",
] as const;

type UpdateType = (typeof SUPPORTED_UPDATE_TYPES)[number];

/** One dependency update of a Renovate pull request. */
export interface RenovateUpdate {
  manager: string;
  datasource: string;
  depName: string;
  /** The name the datasource looks the dependency up under. */
  packageName?: string;
  currentVersion: string;
  newVersion: string;
  currentDigest?: string;
  newDigest?: string;
  updateType: UpdateType;
}

export type RenovateUpdatesParseResult =
  | { result: "parsed"; updates: RenovateUpdate[] }
  | { result: "invalid"; reason: string };

// Renovate may write `null` for a field the update does not have, such as a
// digest; it means the same as leaving the field out.
const optionalField = z
  .string()
  .min(1)
  .nullish()
  .transform((value) => value ?? undefined);

// Strict: a field this schema does not know could tell two updates apart.
const renovateUpdateSchema = z.strictObject({
  currentDigest: optionalField,
  currentVersion: z.string().min(1),
  datasource: z.string().min(1),
  depName: z.string().min(1),
  manager: z.string().min(1),
  newDigest: optionalField,
  newVersion: z.string().min(1),
  packageName: optionalField,
  updateType: z.enum(SUPPORTED_UPDATE_TYPES),
});

// A marker's payload: Base64 of the update's JSON.
const payloadSchema = z
  .base64()
  .transform((payload, context) => {
    try {
      return JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
    } catch {
      context.issues.push({
        code: "custom",
        input: payload,
        message: "is not JSON",
      });
      return z.NEVER;
    }
  })
  .pipe(renovateUpdateSchema);

// Every field, in a fixed order; JSON keeps a separator in a value from
// running two fields together.
const updateKey = (update: RenovateUpdate): string =>
  JSON.stringify([
    update.manager,
    update.datasource,
    update.depName,
    update.packageName ?? null,
    update.currentVersion,
    update.newVersion,
    update.currentDigest ?? null,
    update.newDigest ?? null,
    update.updateType,
  ]);

/**
 * Reads the updates of a Renovate pull request from the comments at the top
 * of its body. Only a block of them that opens the body counts: what follows,
 * such as release notes, comes from the dependency's authors. A marker
 * anywhere else, a comment that does not parse, or a field that is missing or
 * unknown makes the metadata ambiguous, and nothing is returned.
 */
export const parseRenovateUpdates = (
  body: string
): RenovateUpdatesParseResult => {
  const lines = body.replaceAll("\r\n", "\n").trimStart().split("\n");
  const headerLength = lines.findIndex((line) => !MARKER_LINE.test(line));
  const header = headerLength === -1 ? lines : lines.slice(0, headerLength);

  if (header.length === 0) {
    return { reason: "the body carries no update metadata", result: "invalid" };
  }

  if (
    lines
      .slice(header.length)
      .some((line) => line.includes(RENOVATE_UPDATE_MARKER))
  ) {
    return {
      reason: "update metadata appears below the header as well",
      result: "invalid",
    };
  }

  const updates = new Map<string, RenovateUpdate>();

  for (const line of header) {
    const payload = MARKER_LINE.exec(line)?.groups?.payload ?? "";
    const parsed = payloadSchema.safeParse(payload);

    if (!parsed.success) {
      return {
        reason: `update metadata does not parse: ${parsed.error.issues
          .map(({ message, path }) =>
            path.length === 0 ? message : `${path.join(".")} ${message}`
          )
          .join("; ")}`,
        result: "invalid",
      };
    }
    // A dependency declared in several package files repeats its update.
    updates.set(updateKey(parsed.data), parsed.data);
  }

  return {
    result: "parsed",
    updates: [...updates.values()].toSorted((a, b) =>
      updateKey(a).localeCompare(updateKey(b))
    ),
  };
};

/**
 * Identifies the updates of a pull request: two pull requests have the same
 * fingerprint only when they make the same set of updates, every field
 * included.
 */
export const fingerprintRenovateUpdates = (
  updates: readonly RenovateUpdate[]
): string => [...new Set(updates.map(updateKey))].toSorted().join("\n");

const shortDigest = (digest: string) =>
  digest.replace(/^sha256:/u, "").slice(0, 7);

/**
 * Describes an update for people, such as
 * `npm:npm:next:16.3.6->16.3.8:patch`: manager, datasource, name, versions,
 * and update type. Digests follow the versions when the update has them.
 */
export const formatRenovateUpdate = (update: RenovateUpdate): string => {
  const digests =
    update.currentDigest === undefined && update.newDigest === undefined
      ? ""
      : `@${update.currentDigest === undefined ? "" : shortDigest(update.currentDigest)}->${update.newDigest === undefined ? "" : shortDigest(update.newDigest)}`;
  const name =
    update.packageName === undefined || update.packageName === update.depName
      ? update.depName
      : `${update.depName}(${update.packageName})`;

  return `${update.manager}:${update.datasource}:${name}:${update.currentVersion}->${update.newVersion}${digests}:${update.updateType}`;
};
