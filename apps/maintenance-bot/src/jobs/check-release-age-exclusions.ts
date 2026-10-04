import {
  readOptionalRepositoryFile,
  readRepositoryFile,
} from "@publira/github";
import type { Octokit } from "@publira/github";
import {
  evaluateReleaseAgeExclusion,
  findReleaseAgeExclusionKeepReason,
} from "@publira/maintenance-policies";
import type { ReleaseAgeExclusionVerdict } from "@publira/maintenance-policies";
import { fetchPublishTimes } from "@publira/npm-registry";
import type { RegistryOptions } from "@publira/npm-registry";
import {
  parsePackageSelector,
  parseWorkspaceManifest,
  resolvePackageRegistry,
} from "@publira/pnpm-workspace";
import type { WorkspaceManifest } from "@publira/pnpm-workspace";

export interface CheckReleaseAgeExclusionsOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  /** A branch, tag, or commit. Defaults to the default branch. */
  ref?: string;
  registry?: RegistryOptions;
  now?: Date;
}

export interface ReleaseAgeExclusionReport {
  /** The entry as `minimumReleaseAgeExclude` lists it. */
  selector: string;
  verdict: ReleaseAgeExclusionVerdict;
}

export interface JudgeReleaseAgeExclusionsOptions {
  manifest: WorkspaceManifest;
  /** The repository's `.npmrc`, which can send a scope to another registry. */
  npmrc: string | undefined;
  registry?: RegistryOptions;
  now: Date;
}

const selectorOf = (selector: string) => {
  try {
    return parsePackageSelector(selector);
  } catch {
    // pnpm would reject it; it is no temporary exemption either way.
    return { name: selector, versions: [] };
  }
};

/**
 * Judges every `minimumReleaseAgeExclude` entry of a workspace manifest. Only
 * the entries that pin exact versions of packages from the public npm
 * registry are looked up there.
 */
export const judgeReleaseAgeExclusions = ({
  manifest,
  npmrc,
  registry,
  now,
}: JudgeReleaseAgeExclusionsOptions): Promise<ReleaseAgeExclusionReport[]> => {
  // Several entries can pin versions of the same package.
  const publishTimesByName = new Map<string, Promise<Map<string, Date>>>();
  const getPublishTimes = (name: string) => {
    let publishTimes = publishTimesByName.get(name);
    if (publishTimes === undefined) {
      publishTimes = fetchPublishTimes(name, registry);
      publishTimesByName.set(name, publishTimes);
    }
    return publishTimes;
  };

  return Promise.all(
    manifest.minimumReleaseAgeExclude.map(
      async (selector): Promise<ReleaseAgeExclusionReport> => {
        const { name, versions } = selectorOf(selector);
        const reason = findReleaseAgeExclusionKeepReason({
          name,
          registryUrl: resolvePackageRegistry(name, { manifest, npmrc }),
          versions,
        });

        if (reason !== undefined) {
          return { selector, verdict: { action: "keep", reason } };
        }

        return {
          selector,
          verdict: evaluateReleaseAgeExclusion({
            minimumReleaseAge: manifest.minimumReleaseAge,
            now,
            publishTimes: await getPublishTimes(name),
            versions,
          }),
        };
      }
    )
  );
};

/**
 * Reports which `minimumReleaseAgeExclude` entries in a repository's
 * `pnpm-workspace.yaml` are still needed. It only reads: the repository is
 * left unchanged.
 */
export const checkReleaseAgeExclusions = async ({
  octokit,
  owner,
  repo,
  ref,
  registry,
  now = new Date(),
}: CheckReleaseAgeExclusionsOptions): Promise<ReleaseAgeExclusionReport[]> => {
  const [manifest, npmrc] = await Promise.all([
    readRepositoryFile(octokit, {
      owner,
      path: "pnpm-workspace.yaml",
      ref,
      repo,
    }),
    readOptionalRepositoryFile(octokit, { owner, path: ".npmrc", ref, repo }),
  ]);

  return judgeReleaseAgeExclusions({
    manifest: parseWorkspaceManifest(manifest),
    now,
    npmrc,
    registry,
  });
};
