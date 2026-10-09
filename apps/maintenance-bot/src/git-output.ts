// Parsers for the machine-readable output of the Git commands the skills
// update runs in its sandbox.
import type { FileMode } from "@publira/github";

/** A file as an index or a tree holds it. */
export interface GitFile {
  mode: FileMode;
  /** The blob's object ID. */
  sha: string;
}

/** A path a change added, changed, or deleted. */
export interface GitFileChange {
  path: string;
  /** `undefined` when the change added the file. */
  before: GitFile | undefined;
  /** `undefined` when the change deleted the file. */
  after: GitFile | undefined;
}

const NO_FILE = "000000";

const fileOf = (mode: string, sha: string, path: string) => {
  if (mode === NO_FILE) {
    return;
  }
  if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
    throw new Error(`${path} has mode ${mode}, which is not a file's`);
  }
  return { mode, sha } satisfies GitFile;
};

const RAW_DIFF_ENTRY =
  /^:(?<oldMode>\d{6}) (?<newMode>\d{6}) (?<oldSha>[\da-f]{40}) (?<newSha>[\da-f]{40}) [A-Z]$/u;

/**
 * Reads `git diff --raw -z --no-renames --no-abbrev`: one entry per path,
 * each its metadata and its path, ended by NUL.
 */
export const parseRawDiff = (output: string): GitFileChange[] => {
  const fields = output.split("\0");
  const changes: GitFileChange[] = [];

  // The output ends with a NUL, which leaves an empty last field.
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const groups = RAW_DIFF_ENTRY.exec(fields[index] ?? "")?.groups;
    const path = fields[index + 1];

    if (
      groups?.oldMode === undefined ||
      groups.newMode === undefined ||
      groups.oldSha === undefined ||
      groups.newSha === undefined ||
      path === undefined
    ) {
      throw new Error(`Unexpected git diff output: ${fields[index]}`);
    }

    changes.push({
      after: fileOf(groups.newMode, groups.newSha, path),
      before: fileOf(groups.oldMode, groups.oldSha, path),
      path,
    });
  }

  return changes;
};

const STAGED_ENTRY =
  /^(?<mode>\d{6}) (?<sha>[\da-f]{40}) (?<stage>\d)\t(?<path>.+)$/su;

/**
 * Reads `git ls-files --stage -z` into each file's mode and blob, by path.
 * A submodule is left out.
 */
export const parseStagedFiles = (output: string): Map<string, GitFile> => {
  const files = new Map<string, GitFile>();

  for (const entry of output.split("\0")) {
    if (entry === "") {
      continue;
    }
    const groups = STAGED_ENTRY.exec(entry)?.groups;
    if (
      groups?.mode === undefined ||
      groups.sha === undefined ||
      groups.stage !== "0" ||
      groups.path === undefined
    ) {
      throw new Error(`Unexpected git ls-files output: ${entry}`);
    }
    if (groups.mode !== "160000") {
      const file = fileOf(groups.mode, groups.sha, groups.path);
      if (file !== undefined) {
        files.set(groups.path, file);
      }
    }
  }

  return files;
};

const BATCH_HEADER = /^(?<sha>[\da-f]{40}) (?<type>[a-z]+) (?<size>\d+)$/u;

/**
 * Reads `git cat-file --batch` into each object's bytes, by object ID: a
 * header line of the ID, the type, and the size, then the content and a
 * newline.
 */
export const parseCatFileBatch = (output: Uint8Array): Map<string, Buffer> => {
  const bytes = Buffer.from(output);
  const objects = new Map<string, Buffer>();
  let offset = 0;

  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    const header = bytes.toString(
      "utf-8",
      offset,
      newline === -1 ? bytes.length : newline
    );
    const groups = BATCH_HEADER.exec(header)?.groups;

    if (
      newline === -1 ||
      groups?.sha === undefined ||
      groups.size === undefined
    ) {
      throw new Error(`Unexpected git cat-file output: ${header}`);
    }

    const start = newline + 1;
    const end = start + Number(groups.size);

    if (end >= bytes.length || bytes[end] !== 0x0a) {
      throw new Error(`git cat-file cut ${groups.sha} short`);
    }

    objects.set(groups.sha, bytes.subarray(start, end));
    offset = end + 1;
  }

  return objects;
};
