// Codex's patch format, in which the lint findings model edits files: Codex
// models run `apply_patch` in bash with such a patch, even with a tool that
// writes files at hand.
//
//   *** Begin Patch
//   *** Update File: src/index.ts
//   @@ export const lockFilesOf = (changedFiles: readonly string[]) =>
//    a line that stays
//   -a line to remove
//   +a line to add
//   *** End Patch

/** One run of changed lines, with the lines that locate it. */
export interface PatchHunk {
  /** A line before the hunk, which `@@` names to locate it. */
  anchor: string | undefined;
  /** The lines the hunk replaces, the ones that stay included. */
  oldLines: string[];
  /** The lines that replace them. */
  newLines: string[];
  /** Whether the hunk ends at the end of the file. */
  endOfFile: boolean;
}

/** The hunks of one file of a patch. */
export interface FilePatch {
  path: string;
  hunks: PatchHunk[];
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const UPDATE = "*** Update File: ";
const END_OF_FILE = "*** End of File";

// The operations of the format that change which files exist, which the
// lint findings model may not do.
const REFUSED = [
  ["*** Add File: ", "adds a file"],
  ["*** Delete File: ", "deletes a file"],
  ["*** Move to: ", "renames a file"],
] as const;

const emptyHunk = (anchor?: string): PatchHunk => ({
  anchor,
  endOfFile: false,
  newLines: [],
  oldLines: [],
});

const hasChanges = ({ oldLines, newLines }: PatchHunk) =>
  oldLines.length !== newLines.length ||
  oldLines.some((line, index) => line !== newLines[index]);

// Adds a line of a hunk to it.
const addHunkLine = (hunk: PatchHunk, line: string) => {
  const text = line.slice(1);
  switch (line[0]) {
    // An empty line stands for an empty line that stays.
    case undefined:
    case " ": {
      hunk.oldLines.push(text);
      hunk.newLines.push(text);
      break;
    }
    case "-": {
      hunk.oldLines.push(text);
      break;
    }
    case "+": {
      hunk.newLines.push(text);
      break;
    }
    default: {
      throw new Error(
        `A line of a hunk has to start with " ", "-", or "+", found: ${line}`
      );
    }
  }
};

const refuseFileOperation = (line: string) => {
  const refused = REFUSED.find(([marker]) => line.startsWith(marker));
  if (refused !== undefined) {
    throw new Error(
      `The patch ${refused[1]} (${line}), which is not allowed: only update files`
    );
  }
};

/**
 * Reads a patch that only updates files. It throws on a malformed patch and
 * on one that adds, deletes, or renames a file.
 */
export const parsePatch = (patch: string): FilePatch[] => {
  const lines = patch.trim().split(/\r?\n/u);
  if (lines[0]?.trim() !== BEGIN || lines.at(-1)?.trim() !== END) {
    throw new Error(
      `The patch has to start with "${BEGIN}" and end with "${END}"`
    );
  }

  const files: FilePatch[] = [];
  let file: FilePatch | undefined;
  let hunk: PatchHunk | undefined;

  for (const line of lines.slice(1, -1)) {
    // Models sometimes give one patch per file, one after the other.
    if (line.trim() === END || line.trim() === BEGIN) {
      continue;
    }
    refuseFileOperation(line);
    if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length).trim();
      // A file the patch names twice gets the hunks of both, in order.
      file = files.find((named) => named.path === path);
      if (file === undefined) {
        file = { hunks: [], path };
        files.push(file);
      }
      hunk = undefined;
      continue;
    }
    if (file === undefined) {
      throw new Error(`Expected "${UPDATE}<path>", found: ${line}`);
    }
    if (line === "@@" || line.startsWith("@@ ")) {
      hunk = emptyHunk(line === "@@" ? undefined : line.slice(3));
      file.hunks.push(hunk);
      continue;
    }
    if (line.trim() === END_OF_FILE) {
      if (hunk === undefined) {
        throw new Error(`"${END_OF_FILE}" has to end a hunk`);
      }
      hunk.endOfFile = true;
      continue;
    }
    if (hunk === undefined) {
      // The first hunk of a file may leave out its `@@` line.
      hunk = emptyHunk();
      file.hunks.push(hunk);
    }
    addHunkLine(hunk, line);
  }

  if (files.length === 0) {
    throw new Error("The patch updates no file");
  }
  for (const { path, hunks } of files) {
    if (!hunks.some(hasChanges)) {
      throw new Error(`The patch changes nothing in ${path}`);
    }
  }
  return files;
};

// Each comparison is looser than the one before it: models often get the
// whitespace at the end or the start of a line wrong.
const COMPARISONS = [
  (line: string) => line,
  (line: string) => line.trimEnd(),
  (line: string) => line.trim(),
];

const matchesAt = (
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  normalize: (line: string) => string
) =>
  pattern.every(
    (line, offset) => normalize(lines[start + offset] ?? "") === normalize(line)
  );

/**
 * Where `pattern` first appears in `lines` from `from` on, or at the end of
 * them for a hunk that ends the file; -1 for nowhere.
 */
const find = (
  lines: readonly string[],
  pattern: readonly string[],
  from: number,
  endOfFile: boolean
) => {
  const last = lines.length - pattern.length;
  for (const normalize of COMPARISONS) {
    if (endOfFile) {
      if (last >= from && matchesAt(lines, pattern, last, normalize)) {
        return last;
      }
      continue;
    }
    for (let start = from; start <= last; start += 1) {
      if (matchesAt(lines, pattern, start, normalize)) {
        return start;
      }
    }
  }
  return -1;
};

const quote = (lines: readonly string[]) =>
  lines.map((line) => `  ${line}`).join("\n");

/**
 * Applies the hunks of one file to its content, in order: each hunk is
 * looked for after the one before it. It throws when a hunk does not match.
 */
export const applyHunks = (
  content: string,
  hunks: readonly PatchHunk[]
): string => {
  const endsWithNewline = content.endsWith("\n");
  const lines = (endsWithNewline ? content.slice(0, -1) : content).split("\n");
  let cursor = 0;

  for (const { anchor, oldLines, newLines, endOfFile } of hunks) {
    if (anchor !== undefined) {
      const at = find(lines, [anchor], cursor, false);
      if (at === -1) {
        throw new Error(`Cannot find the line of "@@ ${anchor}"`);
      }
      cursor = at + 1;
    }
    // A hunk that only adds lines goes after its anchor, or at the end of
    // the file without one.
    const insertAt = anchor === undefined ? lines.length : cursor;
    const at =
      oldLines.length === 0
        ? insertAt
        : find(lines, oldLines, cursor, endOfFile);
    if (at === -1) {
      throw new Error(`Cannot find these lines:\n${quote(oldLines)}`);
    }
    lines.splice(at, oldLines.length, ...newLines);
    cursor = at + newLines.length;
  }

  return `${lines.join("\n")}${endsWithNewline ? "\n" : ""}`;
};

/** An `apply_patch` command that bash cannot run. */
export interface ApplyPatchCommand {
  /** The directory the command changes to first, if any. */
  directory: string | undefined;
  patch: string;
}

const APPLY_PATCH_COMMAND =
  /^\s*(?:cd\s+(?<directory>"[^"]*"|'[^']*'|[^\s"';&|]+)\s*&&\s*)?apply_patch\s*<<\s*(?<quote>['"]?)(?<delimiter>\w+)\k<quote>[ \t]*\n(?<patch>[\s\S]*?)\n\k<delimiter>\s*$/u;

/**
 * Reads a bash command that runs `apply_patch` with the patch in a
 * here-document, optionally after `cd <directory> &&`, as Codex models run
 * it; `undefined` for any other command.
 */
export const readApplyPatchCommand = (
  command: string
): ApplyPatchCommand | undefined => {
  const groups = APPLY_PATCH_COMMAND.exec(command)?.groups;
  if (groups?.patch === undefined) {
    return;
  }
  const directory = groups.directory?.replace(
    /^(?<quote>["'])(?<path>.*)\k<quote>$/u,
    "$<path>"
  );
  return { directory, patch: groups.patch };
};
