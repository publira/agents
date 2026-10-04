import { isDeepStrictEqual } from "node:util";

import { parse, parseDocument } from "yaml";
import { z } from "zod";

const KEY = "minimumReleaseAgeExclude";

/**
 * The lines of `pnpm-workspace.yaml` that hold `minimumReleaseAgeExclude`:
 * the key, its list, and the comments between the entries.
 */
export interface ExcludeBlock {
  /** The index of the block's first line in the file. */
  start: number;
  lines: string[];
}

export type ExcludeRemoval =
  | { result: "edited"; source: string }
  /**
   * The rules cannot tell which comments go with the removed entries; a
   * reader has to choose the lines of `block` to delete.
   */
  | { result: "ambiguous"; reason: string; block: ExcludeBlock };

type BlockLine =
  | { kind: "blank" }
  | { kind: "comment" }
  | { kind: "item"; value: string }
  | { kind: "other" };

const isBlank = (line: string | undefined) => line?.trim() === "";
const isComment = (line: string | undefined) =>
  line?.trimStart().startsWith("#") ?? false;
const indentOf = (line: string) => line.length - line.trimStart().length;

const splitLines = (source: string) => {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return { eol, lines: source.split(eol) };
};

const singleItemSchema = z.tuple([z.string()]);

// A list item on one line, such as `  - "@next/env@16.3.8" # temporary`.
const readItem = (line: string): string | undefined => {
  if (!/^\s*- /u.test(line)) {
    return undefined;
  }
  try {
    return singleItemSchema.safeParse(parse(line.trim())).data?.[0];
  } catch {
    return undefined;
  }
};

const classify = (line: string): BlockLine => {
  if (isBlank(line)) {
    return { kind: "blank" };
  }
  if (isComment(line)) {
    return { kind: "comment" };
  }
  const value = readItem(line);
  return value === undefined ? { kind: "other" } : { kind: "item", value };
};

// The key's line and the lines up to the next top-level key. Trailing blank
// lines and unindented comments belong to what follows.
const findBlockEnd = (lines: readonly string[], keyIndex: number): number => {
  let end = keyIndex + 1;
  while (
    end < lines.length &&
    !/^[^\s#-]|^-{3}|^\.{3}/u.test(lines[end] ?? "")
  ) {
    end += 1;
  }
  while (
    end > keyIndex + 1 &&
    (isBlank(lines[end - 1]) || lines[end - 1]?.startsWith("#"))
  ) {
    end -= 1;
  }
  return end;
};

const listSchema = z.object({ [KEY]: z.array(z.string()) });

/**
 * Reads the list line by line, or returns `undefined` when an entry does not
 * sit on a line of its own. Checking the entries read this way against the
 * parsed list catches the forms this reading does not understand.
 */
const readList = (
  source: string,
  lines: readonly string[],
  keyIndex: number,
  end: number
): Map<number, BlockLine> | undefined => {
  const list = new Map<number, BlockLine>();
  for (let index = keyIndex + 1; index < end; index += 1) {
    list.set(index, classify(lines[index] ?? ""));
  }

  const items = [...list].flatMap(([index, line]) =>
    line.kind === "item" ? [{ index, value: line.value }] : []
  );
  const listed = listSchema.safeParse(parse(source)).data?.[KEY];

  return [...list.values()].some(({ kind }) => kind === "other") ||
    new Set(items.map(({ index }) => indentOf(lines[index] ?? ""))).size > 1 ||
    !isDeepStrictEqual(
      items.map(({ value }) => value),
      listed
    )
    ? undefined
    : list;
};

/** Consecutive entries and the comments directly above them. */
interface Run {
  comments: number[];
  items: number[];
  /** Comments right below the run that no entry follows. */
  trailingComments: number[];
}

const findRuns = (list: ReadonlyMap<number, BlockLine>): Run[] => {
  const runs: Run[] = [];
  let comments: number[] = [];
  let current: Run | undefined;

  // Comments followed by a blank line or the end of the list go with neither
  // neighbor, but they may still describe the entries just above.
  const closeComments = () => {
    const previous = runs.at(-1);
    if (
      previous !== undefined &&
      comments[0] === (previous.items.at(-1) ?? 0) + 1
    ) {
      previous.trailingComments = comments;
    }
    comments = [];
  };

  for (const [index, { kind }] of list) {
    if (kind === "item") {
      if (current === undefined) {
        current = { comments, items: [], trailingComments: [] };
        runs.push(current);
      }
      current.items.push(index);
      comments = [];
    } else {
      current = undefined;
      if (kind === "comment") {
        comments.push(index);
      } else {
        closeComments();
      }
    }
  }
  closeComments();

  return runs;
};

/**
 * The lines to delete with the removed entries, or why the rules cannot
 * choose them.
 */
const planDeletions = (
  runs: readonly Run[],
  isTarget: (index: number) => boolean
): { deleted: Set<number> } | { reason: string } => {
  const deleted = new Set<number>();

  for (const run of runs) {
    const removed = run.items.filter(isTarget);
    const whole = removed.length === run.items.length;

    if (removed.length > 0 && run.trailingComments.length > 0) {
      return {
        reason: `a comment follows entries that are removed: line ${(run.trailingComments[0] ?? 0) + 1}`,
      };
    }
    if (removed.length > 0 && !whole && run.comments.length > 0) {
      return {
        reason: `a comment describes entries of which only some are removed: line ${(run.comments[0] ?? 0) + 1}`,
      };
    }
    for (const index of whole ? [...run.comments, ...removed] : removed) {
      deleted.add(index);
    }
  }

  return { deleted };
};

// A removed group between blank lines takes one of them along.
const deleteSurroundingBlank = (
  lines: readonly string[],
  deleted: Set<number>
) => {
  for (const index of [...deleted].toSorted((a, b) => a - b)) {
    let spanEnd = index;
    while (deleted.has(spanEnd + 1)) {
      spanEnd += 1;
    }
    if (
      !deleted.has(index - 1) &&
      isBlank(lines[index - 1]) &&
      (spanEnd + 1 >= lines.length || isBlank(lines[spanEnd + 1]))
    ) {
      deleted.add(index - 1);
    }
  }
};

/**
 * Removes entries from `minimumReleaseAgeExclude`, with the comments that
 * describe only them. A comment directly above a group of consecutive entries
 * goes when the whole group goes. When only part of a commented group goes,
 * or a comment follows a removed group, or the list would be left empty, the
 * edit is ambiguous and the function leaves it to a reader.
 *
 * Every other line is left as it is, so the rest of the file keeps its
 * formatting and comments.
 */
export const removeReleaseAgeExclusions = (
  source: string,
  selectors: readonly string[]
): ExcludeRemoval => {
  const { eol, lines } = splitLines(source);
  const keyIndex = lines.findIndex((line) => line.startsWith(`${KEY}:`));

  if (keyIndex === -1) {
    throw new Error(`pnpm-workspace.yaml has no top-level ${KEY} key to edit`);
  }

  const end = findBlockEnd(lines, keyIndex);
  const ambiguous = (reason: string, start = keyIndex): ExcludeRemoval => ({
    block: { lines: lines.slice(start, end), start },
    reason,
    result: "ambiguous",
  });

  if (!/^[^:]+:\s*(?:#.*)?$/u.test(lines[keyIndex] ?? "")) {
    return ambiguous(`${KEY} is not written as a block list`);
  }

  const list = readList(source, lines, keyIndex, end);

  if (list === undefined) {
    return ambiguous(`${KEY} has entries that do not each sit on one line`);
  }

  const targets = new Set(selectors);
  const isTarget = (index: number) => {
    const line = list.get(index);
    return line?.kind === "item" && targets.has(line.value);
  };

  if (
    [...list].every(([index, { kind }]) => kind !== "item" || isTarget(index))
  ) {
    // The comments above the key may describe the setting as a whole.
    let start = keyIndex;
    while (start > 0 && isComment(lines[start - 1])) {
      start -= 1;
    }
    return ambiguous(`removing every entry leaves ${KEY} empty`, start);
  }

  const plan = planDeletions(findRuns(list), isTarget);

  if ("reason" in plan) {
    return ambiguous(plan.reason);
  }

  deleteSurroundingBlank(lines, plan.deleted);

  return {
    result: "edited",
    source: lines.filter((_, index) => !plan.deleted.has(index)).join(eol),
  };
};

/**
 * Deletes lines of a block from the file, by their 1-based number within the
 * block. Deleting is the only edit a reader can make, so no line is ever
 * added or rewritten.
 */
export const deleteBlockLines = (
  source: string,
  block: ExcludeBlock,
  lineNumbers: readonly number[]
): string => {
  const { eol, lines } = splitLines(source);
  const deleted = new Set<number>();

  for (const lineNumber of lineNumbers) {
    if (
      !Number.isInteger(lineNumber) ||
      lineNumber < 1 ||
      lineNumber > block.lines.length
    ) {
      throw new Error(
        `Line ${lineNumber} is outside the ${block.lines.length} lines of the block`
      );
    }
    deleted.add(block.start + lineNumber - 1);
  }

  return lines.filter((_, index) => !deleted.has(index)).join(eol);
};

const manifestSchema = z.record(z.string(), z.unknown());

/**
 * Checks that `after` is `before` with exactly `selectors` removed from
 * `minimumReleaseAgeExclude`, whoever edited it: the file still parses, every
 * other entry is still listed in the same order, and every other setting,
 * `minimumReleaseAge` included, has the same value. Returns the problems
 * found, none when the edit is correct.
 */
export const verifyReleaseAgeExclusionRemoval = (
  before: string,
  after: string,
  selectors: readonly string[]
): string[] => {
  const document = parseDocument(after);

  if (document.errors.length > 0) {
    return [`The result is not valid YAML: ${document.errors[0]?.message}`];
  }

  const original = manifestSchema.parse(parse(before) ?? {});
  const edited = manifestSchema.safeParse(document.toJS() ?? {});

  if (!edited.success) {
    return ["The result is not a mapping of settings"];
  }

  const problems: string[] = [];
  const listed = z.array(z.string()).parse(original[KEY] ?? []);
  const targets = new Set(selectors);

  for (const selector of targets) {
    if (!listed.includes(selector)) {
      problems.push(`${selector} is not in ${KEY}`);
    }
  }

  const expected = listed.filter((selector) => !targets.has(selector));
  const remaining = edited.data[KEY] ?? [];

  if (!isDeepStrictEqual(remaining, expected)) {
    problems.push(
      `${KEY} should list ${JSON.stringify(expected)}, not ${JSON.stringify(remaining)}`
    );
  }

  const keys = new Set([...Object.keys(original), ...Object.keys(edited.data)]);
  keys.delete(KEY);

  for (const key of keys) {
    if (!isDeepStrictEqual(original[key], edited.data[key])) {
      problems.push(`${key} changed`);
    }
  }

  return problems;
};
