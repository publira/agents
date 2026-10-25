import {
  findBlockEnd,
  indentOf,
  KEY,
  readList,
  splitLines,
  verifyReleaseAgeExclusionRemoval,
} from "./exclude-removal.ts";

export type ExcludeAddition =
  | { result: "edited"; source: string }
  /** The list is not written in a form the rules can add to. */
  | { result: "refused"; reason: string };

// The indentation of a new list's entries, as pnpm and the formatters write it.
const DEFAULT_INDENT = 2;

// A selector as a list item. A plain scalar cannot start with `@`, which
// starts every scoped name.
const itemOf = (selector: string) =>
  /^[0-9a-z]/iu.test(selector) ? selector : JSON.stringify(selector);

/**
 * Adds entries to the end of `minimumReleaseAgeExclude`, with the comment
 * lines directly above them, so that the comment describes only them and
 * goes with them when `removeReleaseAgeExclusions` removes them all. A file
 * without the key gets it at its end.
 *
 * Every other line is left as it is. A list that is not a block of entries
 * on lines of their own is refused, and so is a result that does not parse
 * to the same settings with exactly the selectors added.
 */
export const addReleaseAgeExclusions = (
  source: string,
  selectors: readonly string[],
  comment: readonly string[]
): ExcludeAddition => {
  const { eol, lines } = splitLines(source);
  const keyIndex = lines.findIndex((line) => line.startsWith(`${KEY}:`));

  const entriesAt = (indent: number) => {
    const pad = " ".repeat(indent);

    return [
      ...comment.map((line) => `${pad}# ${line}`),
      ...selectors.map((selector) => `${pad}- ${itemOf(selector)}`),
    ];
  };

  let edited: string[];

  if (keyIndex === -1) {
    // Before the empty line that a final line break leaves.
    const end = lines.at(-1) === "" ? lines.length - 1 : lines.length;

    edited = [
      ...lines.slice(0, end),
      `${KEY}:`,
      ...entriesAt(DEFAULT_INDENT),
      ...lines.slice(end),
    ];
  } else {
    if (!/^[^:]+:\s*(?:#.*)?$/u.test(lines[keyIndex] ?? "")) {
      return {
        reason: `${KEY} is not written as a block list`,
        result: "refused",
      };
    }

    const end = findBlockEnd(lines, keyIndex);
    const list = readList(source, lines, keyIndex, end);

    if (list === undefined) {
      return {
        reason: `${KEY} has entries that do not each sit on one line`,
        result: "refused",
      };
    }

    const [firstItem] = [...list].flatMap(([index, { kind }]) =>
      kind === "item" ? [index] : []
    );

    edited = [
      ...lines.slice(0, end),
      ...entriesAt(
        firstItem === undefined
          ? DEFAULT_INDENT
          : indentOf(lines[firstItem] ?? "")
      ),
      ...lines.slice(end),
    ];
  }

  const result = edited.join(eol);

  // Removing the selectors from the result has to give the file back.
  const problems = verifyReleaseAgeExclusionRemoval(result, source, selectors);

  return problems.length === 0
    ? { result: "edited", source: result }
    : { reason: problems.join("; "), result: "refused" };
};
