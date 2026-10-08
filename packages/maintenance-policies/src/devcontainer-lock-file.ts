import { isDeepStrictEqual } from "node:util";

/**
 * Whether a path is a Dev Container configuration whose Features the Dev
 * Container CLI locks: `.devcontainer/devcontainer.json`,
 * `.devcontainer/<name>/devcontainer.json`, or `.devcontainer.json`.
 */
export const isDevContainerConfigPath = (path: string): boolean =>
  /^(?:\.devcontainer\/(?:[^/]+\/)?devcontainer\.json|\.devcontainer\.json)$/u.test(
    path
  );

/**
 * The lock file the Dev Container CLI keeps beside a configuration:
 * `devcontainer-lock.json`, or `.devcontainer-lock.json` beside
 * `.devcontainer.json`.
 */
export const devContainerLockFilePathOf = (configPath: string): string => {
  const slash = configPath.lastIndexOf("/");
  const directory = configPath.slice(0, slash + 1);
  const name = configPath.slice(slash + 1);
  return `${directory}${name.startsWith(".") ? "." : ""}devcontainer-lock.json`;
};

/** A Feature published to an OCI registry, referenced by a tag. */
export interface FeatureReference {
  /** The reference as the configuration writes it, which keys the lock file. */
  reference: string;
  /** Such as `ghcr.io`. */
  registry: string;
  /** Such as `devcontainers/features/docker-in-docker`. */
  repository: string;
  /** Such as `4.1.3`. */
  tag: string;
}

// `registry/namespace/name:tag`, as the Dev Container CLI reads an OCI
// reference. A reference by digest, a local Feature, and a tarball URL do not
// match.
const FEATURE_REFERENCE =
  /^(?<registry>[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?)\/(?<repository>[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+):(?<tag>\w[\w.-]{0,127})$/u;

/** Reads a Feature reference, or returns `undefined` for one not by tag. */
export const parseFeatureReference = (
  reference: string
): FeatureReference | undefined => {
  const groups = FEATURE_REFERENCE.exec(reference)?.groups;
  return groups?.registry === undefined ||
    groups.repository === undefined ||
    groups.tag === undefined
    ? undefined
    : {
        reference,
        registry: groups.registry,
        repository: groups.repository,
        tag: groups.tag,
      };
};

/** A Feature whose reference moved from one tag to another. */
export interface FeatureBump {
  from: FeatureReference;
  to: FeatureReference;
}

export type FeatureBumpsVerdict =
  | { result: "bumped"; bumps: FeatureBump[] }
  | { result: "unchanged" }
  | { result: "unsupported"; reason: string };

/**
 * Pairs the Feature references of a configuration before and after a pull
 * request: a reference that changed only its tag is a bump. A Feature added
 * or removed, or a changed reference that is not an OCI one with a tag, is
 * left to a maintainer, since the lock file then needs more than its entry
 * replaced.
 */
export const findFeatureBumps = (
  before: readonly string[],
  after: readonly string[]
): FeatureBumpsVerdict => {
  const removed = before.filter((reference) => !after.includes(reference));
  const added = after.filter((reference) => !before.includes(reference));

  if (removed.length === 0 && added.length === 0) {
    return { result: "unchanged" };
  }

  const byFeature = new Map<
    string,
    { from: FeatureReference[]; to: FeatureReference[] }
  >();

  for (const [side, references] of [
    ["from", removed],
    ["to", added],
  ] as const) {
    for (const reference of references) {
      const parsed = parseFeatureReference(reference);
      if (parsed === undefined) {
        return {
          reason: `${reference} is not a Feature in an OCI registry referenced by a tag`,
          result: "unsupported",
        };
      }
      const feature = `${parsed.registry}/${parsed.repository}`;
      const sides = byFeature.get(feature) ?? { from: [], to: [] };
      sides[side].push(parsed);
      byFeature.set(feature, sides);
    }
  }

  const bumps: FeatureBump[] = [];

  for (const [feature, { from, to }] of byFeature) {
    const [fromReference] = from;
    const [toReference] = to;

    if (
      from.length !== 1 ||
      to.length !== 1 ||
      fromReference === undefined ||
      toReference === undefined
    ) {
      let change = "changed more than one reference of";
      if (from.length === 0) {
        change = "added";
      } else if (to.length === 0) {
        change = "removed";
      }
      return {
        reason: `the pull request ${change} ${feature}`,
        result: "unsupported",
      };
    }
    bumps.push({ from: fromReference, to: toReference });
  }

  return { bumps, result: "bumped" };
};

/** An entry of `devcontainer-lock.json`. */
export interface LockedFeature {
  version: string;
  /** `registry/repository@digest` for an OCI Feature. */
  resolved: string;
  integrity: string;
  /** The references of the Features it depends on, if it does. */
  dependsOn?: readonly string[];
}

/** What a Feature's tag resolves to in its registry. */
export interface ResolvedFeature {
  /** The digest of the Feature's OCI manifest, `sha256:...`. */
  digest: string;
  /** The version its metadata declares. */
  version: string;
  /** The references its metadata depends on. */
  dependsOn: readonly string[];
}

export interface LockFileSyncInput {
  /** The lock file's entries by Feature reference, in the file's order. */
  entries: readonly (readonly [string, LockedFeature])[];
  bumps: readonly FeatureBump[];
  /** Each bumped Feature's new reference, resolved. */
  resolved: ReadonlyMap<string, ResolvedFeature>;
}

export type LockFileSyncVerdict =
  | { result: "in-sync" }
  | {
      result: "sync";
      entries: [string, LockedFeature][];
      /** The references whose entries changed. */
      changed: string[];
    }
  | { result: "unsupported"; reason: string };

const sameReferences = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined
) => isDeepStrictEqual(a ?? [], b ?? []);

/**
 * Replaces the lock file entry of each bumped Feature with what
 * `devcontainer upgrade` writes: the new reference as its key, the version
 * its metadata declares, and the digest of its manifest. The other entries
 * and their order stay as they are, so the file changes only where the pull
 * request did.
 *
 * A Feature whose dependencies changed is left to a maintainer, because the
 * CLI also locks what it depends on. So is one the lock file has no entry
 * for.
 */
export const syncLockFileEntries = ({
  entries,
  bumps,
  resolved,
}: LockFileSyncInput): LockFileSyncVerdict => {
  let synced: [string, LockedFeature][] = entries.map(([key, entry]) => [
    key,
    entry,
  ]);
  const changed: string[] = [];

  for (const { from, to } of bumps) {
    const feature = resolved.get(to.reference);
    if (feature === undefined) {
      return {
        reason: `${to.reference} was not resolved`,
        result: "unsupported",
      };
    }

    const index = synced.findIndex(([key]) => key === to.reference);
    const fromIndex = synced.findIndex(([key]) => key === from.reference);
    const current = synced[index === -1 ? fromIndex : index];

    if (current === undefined) {
      return {
        reason: `the lock file has no entry for ${from.reference} or ${to.reference}`,
        result: "unsupported",
      };
    }
    if (!sameReferences(current[1].dependsOn, feature.dependsOn)) {
      return {
        reason: `${to.reference} depends on other Features than ${current[0]}`,
        result: "unsupported",
      };
    }

    const entry: LockedFeature = {
      integrity: feature.digest,
      resolved: `${to.registry}/${to.repository}@${feature.digest}`,
      version: feature.version,
    };
    if (feature.dependsOn.length > 0) {
      entry.dependsOn = [...feature.dependsOn];
    }

    if (
      index !== -1 &&
      fromIndex === -1 &&
      isDeepStrictEqual(current[1], entry)
    ) {
      continue;
    }

    // The entry keeps its place, under its new key; a stale entry for the old
    // reference beside an up-to-date one goes.
    const position = index === -1 ? fromIndex : index;
    synced = synced.flatMap((pair, at) => {
      if (at === position) {
        return [[to.reference, entry]];
      }
      return pair[0] === from.reference ? [] : [pair];
    });
    changed.push(to.reference);
  }

  return changed.length === 0
    ? { result: "in-sync" }
    : { changed, entries: synced, result: "sync" };
};
