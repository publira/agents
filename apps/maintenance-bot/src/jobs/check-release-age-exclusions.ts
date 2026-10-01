import { readRepositoryFile } from "@publira/github";
import type { Octokit } from "@publira/github";
import { evaluateReleaseAgeExclusion } from "@publira/maintenance-policies";
import type { ReleaseAgeExclusionVerdict } from "@publira/maintenance-policies";
import { fetchPublishTimes } from "@publira/npm-registry";
import type { RegistryOptions } from "@publira/npm-registry";
import {
  parsePackageSelector,
  parseWorkspaceManifest,
} from "@publira/pnpm-workspace";

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
  const manifest = parseWorkspaceManifest(
    await readRepositoryFile(octokit, {
      owner,
      path: "pnpm-workspace.yaml",
      ref,
      repo,
    })
  );
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
    manifest.minimumReleaseAgeExclude.map(async (selector) => {
      const { name, versions } = parsePackageSelector(selector);
      // An entry without versions is kept whatever the registry says.
      const publishTimes =
        versions.length === 0 ? new Map() : await getPublishTimes(name);

      return {
        selector,
        verdict: evaluateReleaseAgeExclusion({
          minimumReleaseAge: manifest.minimumReleaseAge,
          now,
          publishTimes,
          versions,
        }),
      };
    })
  );
};
