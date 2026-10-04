const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * Why an entry is kept without asking the registry:
 *
 * - `unpinned`: the entry exempts every version, a pattern of packages, or a
 *   range or tag rather than exact versions. That is a standing decision,
 *   not a temporary one, or one the registry cannot settle.
 * - `other-registry`: the package installs from a registry other than the
 *   public npm registry, whose publish times the bot does not read.
 */
export type ReleaseAgeExclusionKeepReason = "other-registry" | "unpinned";

/**
 * What to do with a `minimumReleaseAgeExclude` entry:
 *
 * - `keep`: the entry is not a temporary exemption of exact versions that the
 *   public npm registry can date; see {@link ReleaseAgeExclusionKeepReason}.
 * - `waiting`: a pinned version is still inside the release age window, so
 *   installing it still needs the exemption.
 * - `expired`: every pinned version is past the window. pnpm would install
 *   them without the entry, so it can be removed.
 * - `unknown`: a pinned version is not in the registry, so its age cannot be
 *   judged.
 */
export type ReleaseAgeExclusionVerdict =
  | { action: "keep"; reason: ReleaseAgeExclusionKeepReason }
  | { action: "waiting"; availableAt: Date }
  | { action: "expired"; availableAt: Date }
  | { action: "unknown"; missingVersions: string[] };

export interface ReleaseAgeExclusionTarget {
  /** The package name, or a pattern such as `@publira/*`. */
  name: string;
  /** The versions the entry pins. Empty when it exempts every version. */
  versions: readonly string[];
  /** The registry the package installs from. */
  registryUrl: string;
}

// A package name as the npm registry accepts it, which rules out patterns.
const PACKAGE_NAME =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u;

// An exact version, as semver defines it, rather than a range or a tag.
const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const isPublicNpmRegistry = (registryUrl: string): boolean => {
  try {
    const url = new URL(registryUrl);
    return (
      url.protocol === "https:" &&
      url.host === "registry.npmjs.org" &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
};

/**
 * Tells why an entry is kept whatever the registry says, or returns
 * `undefined` when the public npm registry can tell whether it expired.
 */
export const findReleaseAgeExclusionKeepReason = ({
  name,
  versions,
  registryUrl,
}: ReleaseAgeExclusionTarget): ReleaseAgeExclusionKeepReason | undefined => {
  if (
    !PACKAGE_NAME.test(name) ||
    versions.length === 0 ||
    !versions.every((version) => EXACT_VERSION.test(version))
  ) {
    return "unpinned";
  }
  if (!isPublicNpmRegistry(registryUrl)) {
    return "other-registry";
  }
  return undefined;
};

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
    return { action: "keep", reason: "unpinned" };
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

  return {
    action: availableAt <= now.getTime() ? "expired" : "waiting",
    availableAt: new Date(availableAt),
  };
};
