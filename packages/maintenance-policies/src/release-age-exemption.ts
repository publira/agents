import { isExactVersion, isPackageName } from "./release-age-exclusion.ts";

const MILLISECONDS_PER_MINUTE = 60_000;

/** A version that pnpm refuses to install because it is too new. */
export interface ReleaseAgeViolation {
  name: string;
  version: string;
  publishedAt: Date;
}

/**
 * What a failed install's output says about `minimumReleaseAge`:
 *
 * - `none`: the install failed for another reason.
 * - `violations`: every entry pnpm rejected is a version inside the window.
 * - `unreadable`: pnpm rejected entries for the release age, but the output
 *   does not name them all as the rules read it, or it rejected others for
 *   another policy, which an exemption does not cure.
 */
export type ReleaseAgeViolationsReading =
  | { result: "none" }
  | { result: "unreadable"; reason: string }
  | { result: "violations"; violations: ReleaseAgeViolation[] };

/** The error code of pnpm's release age check of the lockfile. */
export const RELEASE_AGE_VIOLATION_CODE =
  "ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION";

// `3 lockfile entries failed verification:` heads the list.
const FAILED_COUNT =
  /(?<count>\d+) lockfile entr(?:y|ies) failed verification:/u;

// `is-odd@3.0.1 was published at 2018-05-31T20:04:53.306Z, within the
// minimumReleaseAge cutoff (...)`, one for each entry. pnpm wraps the lines
// at the terminal's width, so the output is read with its whitespace
// collapsed.
const VIOLATION =
  /(?<selector>\S+) was published at (?<time>[^\s,]+), within the minimumReleaseAge cutoff/gu;

/**
 * Reads the versions that pnpm's `install --frozen-lockfile` refused for
 * `minimumReleaseAge` from its output, with their publish times.
 */
export const readReleaseAgeViolations = (
  output: string
): ReleaseAgeViolationsReading => {
  if (!output.includes(RELEASE_AGE_VIOLATION_CODE)) {
    return { result: "none" };
  }

  const text = output.replaceAll(/\s+/gu, " ");
  const count = FAILED_COUNT.exec(text)?.groups?.count;

  if (count === undefined) {
    return {
      reason: "the output does not say how many lockfile entries failed",
      result: "unreadable",
    };
  }

  const violations = new Map<string, ReleaseAgeViolation>();
  let matched = 0;

  for (const { groups } of text.matchAll(VIOLATION)) {
    const selector = groups?.selector ?? "";
    // A scope's leading `@` is part of the name.
    const separator = selector.lastIndexOf("@");
    const name = selector.slice(0, separator);
    const version = selector.slice(separator + 1);
    const publishedAt = new Date(groups?.time ?? "");

    if (
      separator < 1 ||
      !isPackageName(name) ||
      !isExactVersion(version) ||
      Number.isNaN(publishedAt.getTime())
    ) {
      return {
        reason: `the output names an entry the rules cannot read: ${JSON.stringify(selector)}`,
        result: "unreadable",
      };
    }

    matched += 1;
    violations.set(selector, { name, publishedAt, version });
  }

  if (matched !== Number(count)) {
    return {
      reason: `${count} lockfile entries failed verification, ${matched} of them for minimumReleaseAge`,
      result: "unreadable",
    };
  }

  return {
    result: "violations",
    violations: [...violations.values()],
  };
};

/**
 * A `minimumReleaseAgeExclude` entry that exempts one version, and when
 * pnpm would install the version without it.
 */
export interface ReleaseAgeExemptionEntry {
  /** The exact-version selector, such as `playwright@1.64.0`. */
  selector: string;
  availableAt: Date;
}

export interface ReleaseAgeExemptionEntriesInput {
  violations: readonly ReleaseAgeViolation[];
  /** The workspace's `minimumReleaseAge`, in minutes. */
  minimumReleaseAge: number;
  now: Date;
}

/**
 * The entries that would let pnpm install the refused versions now, sorted
 * by selector. A version whose window has passed by now needs none.
 */
export const releaseAgeExemptionEntries = ({
  violations,
  minimumReleaseAge,
  now,
}: ReleaseAgeExemptionEntriesInput): ReleaseAgeExemptionEntry[] =>
  violations
    .map(({ name, version, publishedAt }) => ({
      availableAt: new Date(
        publishedAt.getTime() + minimumReleaseAge * MILLISECONDS_PER_MINUTE
      ),
      selector: `${name}@${version}`,
    }))
    .filter(({ availableAt }) => availableAt.getTime() > now.getTime())
    .toSorted((a, b) => a.selector.localeCompare(b.selector));

/**
 * The start of the hidden mark of every question the bot asks on a pull
 * request, whatever its head.
 */
export const RELEASE_AGE_EXEMPTION_MARKER_START =
  "<!-- chachamaru-release-age-exemption head=";

/** The start of the question's mark for one head, which ends in its entries. */
export const releaseAgeExemptionHeadMarker = (headSha: string): string =>
  `${RELEASE_AGE_EXEMPTION_MARKER_START}${headSha} `;

/**
 * The hidden mark of the question for a head: the head and each entry it
 * asks for, with when the version leaves the window.
 */
export const formatReleaseAgeExemptionMarker = (
  headSha: string,
  entries: readonly ReleaseAgeExemptionEntry[]
): string =>
  `${releaseAgeExemptionHeadMarker(headSha)}${entries
    .map(
      ({ selector, availableAt }) =>
        `entry=${selector},${availableAt.toISOString()} `
    )
    .join("")}-->`;

// The hidden mark that the bot adds to its question once a maintainer
// approved it, with the approving comment.
const APPROVAL_MARKER_START = "<!-- chachamaru-release-age-exemption-approval ";

/** The hidden mark of a maintainer's approval of a question. */
export const formatReleaseAgeExemptionApprovalMarker = (url: string): string =>
  `${APPROVAL_MARKER_START}url=${url} -->`;

const QUESTION_MARKER =
  /<!-- chachamaru-release-age-exemption head=(?<head>[0-9a-f]+) (?<entries>(?:entry=\S+ )*)-->/u;

const APPROVAL_MARKER =
  /<!-- chachamaru-release-age-exemption-approval url=(?<url>\S+) -->/u;

/** A question the bot asked, as its marks record it. */
export interface ReleaseAgeExemptionQuestion {
  headSha: string;
  entries: ReleaseAgeExemptionEntry[];
  /** The comment that approved it, once a maintainer did. */
  approvedIn?: string;
}

/**
 * Reads the bot's question from a comment's body, or returns `undefined`
 * when the body holds none.
 */
export const parseReleaseAgeExemptionQuestion = (
  body: string
): ReleaseAgeExemptionQuestion | undefined => {
  const groups = QUESTION_MARKER.exec(body)?.groups;

  if (groups?.head === undefined) {
    return undefined;
  }

  const entries = (groups.entries ?? "")
    .split(" ")
    .filter((field) => field !== "")
    .map((field) => {
      const [selector = "", time = ""] = field
        .slice("entry=".length)
        .split(",");

      return { availableAt: new Date(time), selector };
    });

  if (entries.some(({ availableAt }) => Number.isNaN(availableAt.getTime()))) {
    return undefined;
  }

  const approvedIn = APPROVAL_MARKER.exec(body)?.groups?.url;

  return {
    entries,
    headSha: groups.head,
    ...(approvedIn !== undefined && { approvedIn }),
  };
};

/**
 * The entries of a question that are still needed: those the workspace does
 * not list yet and whose versions are still inside the window.
 */
export const pendingReleaseAgeExemptionEntries = (
  entries: readonly ReleaseAgeExemptionEntry[],
  { excluded, now }: { excluded: readonly string[]; now: Date }
): ReleaseAgeExemptionEntry[] =>
  entries.filter(
    ({ selector, availableAt }) =>
      !excluded.includes(selector) && availableAt.getTime() > now.getTime()
  );

/**
 * Finds the approved question that covers every selector, so that a new head
 * with the same versions gets the entries again without asking: the
 * maintainer's approval holds for the pull request.
 */
export const findApprovedReleaseAgeExemption = (
  questions: readonly ReleaseAgeExemptionQuestion[],
  selectors: readonly string[]
): ReleaseAgeExemptionQuestion | undefined =>
  questions.findLast(
    ({ approvedIn, entries }) =>
      approvedIn !== undefined &&
      selectors.every((selector) =>
        entries.some((entry) => entry.selector === selector)
      )
  );

const escapeRegExp = (text: string) =>
  text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, "\\$&");

/**
 * Whether a comment asks the bot to add the entries: outside quoted lines,
 * it mentions the bot and says `add`. Nothing else in it is read, and a
 * quote of the bot's question, which shows how to answer, does not count.
 */
export const requestsReleaseAgeExemption = (
  body: string,
  botLogin: string
): boolean => {
  const slug = botLogin.replace(/\[bot\]$/u, "");

  const mention = new RegExp(
    `(?<![\\w@/.-])@${escapeRegExp(slug)}(?![\\w/-])`,
    "iu"
  );

  const text = body
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");

  return mention.test(text) && /\badd\b/iu.test(text);
};
