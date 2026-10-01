import { parse } from "yaml";
import { z } from "zod";

/**
 * pnpm's default for `minimumReleaseAge`: a version becomes installable one
 * day after it is published. https://pnpm.io/settings#minimumreleaseage
 */
export const DEFAULT_MINIMUM_RELEASE_AGE_MINUTES = 1440;

const manifestSchema = z.looseObject({
  minimumReleaseAge: z.number().int().nonnegative().optional(),
  minimumReleaseAgeExclude: z.array(z.string()).optional(),
  packages: z.array(z.string()).optional(),
});

/** The fields of `pnpm-workspace.yaml` that the maintenance jobs read. */
export interface WorkspaceManifest {
  /** Minutes a version must have been published before pnpm installs it. */
  minimumReleaseAge: number;
  /** Package selectors that skip the `minimumReleaseAge` check. */
  minimumReleaseAgeExclude: string[];
  /** Globs of the directories that hold workspace packages. */
  packages: string[];
}

/**
 * Parses the contents of a `pnpm-workspace.yaml` file. Settings it leaves out
 * take pnpm's defaults; an empty file is a valid manifest.
 */
export const parseWorkspaceManifest = (source: string): WorkspaceManifest => {
  const manifest = manifestSchema.parse(parse(source) ?? {});

  return {
    minimumReleaseAge:
      manifest.minimumReleaseAge ?? DEFAULT_MINIMUM_RELEASE_AGE_MINUTES,
    minimumReleaseAgeExclude: manifest.minimumReleaseAgeExclude ?? [],
    packages: manifest.packages ?? [],
  };
};
