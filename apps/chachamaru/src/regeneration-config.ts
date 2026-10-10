import { readOptionalRepositoryFile } from "@publira/github";
import type { Octokit } from "@publira/github";
import {
  LEGACY_REGENERATION_CONFIG_PATH,
  parseRegenerationConfig,
  REGENERATION_CONFIG_PATH,
} from "@publira/maintenance-policies";
import type { RegenerationConfigParseResult } from "@publira/maintenance-policies";

export interface RegenerationConfigLocation {
  owner: string;
  repo: string;
  /** The commit to read the declaration at. */
  ref: string;
}

/**
 * Reads a repository's regeneration declaration at a commit from
 * {@link REGENERATION_CONFIG_PATH}, or from
 * {@link LEGACY_REGENERATION_CONFIG_PATH} when the repository has not moved
 * it yet. Returns `undefined` when it has neither.
 */
export const readRegenerationConfig = async (
  octokit: Octokit,
  { owner, repo, ref }: RegenerationConfigLocation
): Promise<RegenerationConfigParseResult | undefined> => {
  const source = await readOptionalRepositoryFile(octokit, {
    owner,
    path: REGENERATION_CONFIG_PATH,
    ref,
    repo,
  });
  if (source !== undefined) {
    return parseRegenerationConfig(source);
  }
  const legacySource = await readOptionalRepositoryFile(octokit, {
    owner,
    path: LEGACY_REGENERATION_CONFIG_PATH,
    ref,
    repo,
  });
  return legacySource === undefined
    ? undefined
    : parseRegenerationConfig(legacySource, LEGACY_REGENERATION_CONFIG_PATH);
};
