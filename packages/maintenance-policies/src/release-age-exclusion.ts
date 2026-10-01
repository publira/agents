const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * What to do with a `minimumReleaseAgeExclude` entry:
 *
 * - `keep`: the entry exempts every version of a package or a pattern, which
 *   is a standing decision rather than a temporary one.
 * - `waiting`: a pinned version is still inside the release age window, so
 *   installing it still needs the exemption.
 * - `expired`: every pinned version is past the window. pnpm would install
 *   them without the entry, so it can be removed.
 * - `unknown`: a pinned version is not in the registry, so its age cannot be
 *   judged.
 */
export type ReleaseAgeExclusionVerdict =
  | { action: "keep" }
  | { action: "waiting"; availableAt: Date }
  | { action: "expired" }
  | { action: "unknown"; missingVersions: string[] };

export interface ReleaseAgeExclusionInput {
  /** The versions the entry pins. Empty when it exempts every version. */
  versions: readonly string[];
  /** When each version of the package was published. */
  publishTimes: ReadonlyMap<string, Date>;
  /** The workspace's `minimumReleaseAge`, in minutes. */
  minimumReleaseAge: number;
  now: Date;
}

export const evaluateReleaseAgeExclusion = ({
  versions,
  publishTimes,
  minimumReleaseAge,
  now,
}: ReleaseAgeExclusionInput): ReleaseAgeExclusionVerdict => {
  if (versions.length === 0) {
    return { action: "keep" };
  }

  const publishedAt: number[] = [];
  const missingVersions: string[] = [];

  for (const version of versions) {
    const time = publishTimes.get(version);
    if (time === undefined) {
      missingVersions.push(version);
    } else {
      publishedAt.push(time.getTime());
    }
  }

  if (missingVersions.length > 0) {
    return { action: "unknown", missingVersions };
  }

  // The newest pinned version is the last to leave the window.
  const availableAt =
    Math.max(...publishedAt) + minimumReleaseAge * MILLISECONDS_PER_MINUTE;

  return availableAt <= now.getTime()
    ? { action: "expired" }
    : { action: "waiting", availableAt: new Date(availableAt) };
};
