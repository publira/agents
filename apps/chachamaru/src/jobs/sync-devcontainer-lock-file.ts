import {
  formatLockFile,
  parseFeatureReferences,
  parseLockFile,
  resolveFeature,
} from "@publira/devcontainer";
import type { RegistryOptions } from "@publira/devcontainer";
import { addCommitToBranch, readOptionalRepositoryFile } from "@publira/github";
import type { Octokit } from "@publira/github";
import {
  devContainerLockFilePathOf,
  findFeatureBumps,
  isDevContainerConfigPath,
  isRenovate,
  syncLockFileEntries,
} from "@publira/maintenance-policies";
import type {
  FeatureBump,
  ResolvedFeature,
} from "@publira/maintenance-policies";

import type { LogFields } from "../log.ts";

export type SyncDevContainerLockFileResult =
  | { status: "skipped"; headSha: string; reason: string }
  | { status: "in-sync"; headSha: string; lockFiles: string[] }
  | {
      status: "would-commit";
      headSha: string;
      lockFiles: string[];
      message: string;
      /** The regenerated lock files by path. */
      files: Record<string, string>;
    }
  | {
      status: "committed";
      headSha: string;
      lockFiles: string[];
      message: string;
      commitSha: string;
    }
  | {
      /** The branch moved while the job looked; its push is evaluated anew. */
      status: "head-moved";
      headSha: string;
      lockFiles: string[];
    };

export interface SyncDevContainerLockFileOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  /** Evaluates the pull request without committing. */
  dryRun?: boolean;
  /** Replaced in tests. */
  registry?: RegistryOptions;
}

/** A lock file to sync, beside a configuration the pull request changed. */
interface LockFileTarget {
  path: string;
  text: string;
  bumps: FeatureBump[];
}

interface Skip {
  reason: string;
}

interface Regenerated {
  /** The regenerated lock files that differ, by path. */
  files: Record<string, string>;
  /** The references whose entries changed. */
  synced: Set<string>;
}

const isSkip = <
  T extends LockFileTarget[] | Map<string, ResolvedFeature> | Regenerated,
>(
  value: T | Skip
): value is Skip => "reason" in value;

const featureName = (repository: string) =>
  repository.slice(repository.lastIndexOf("/") + 1);

/**
 * Reads, for each configuration the pull request changed that has a lock
 * file beside it, which Features it bumped since the merge base.
 */
const findTargets = async (
  { octokit, owner, repo }: SyncDevContainerLockFileOptions,
  {
    mergeBase,
    headSha,
    changed,
  }: {
    mergeBase: string;
    headSha: string;
    changed: readonly string[];
  }
): Promise<LockFileTarget[] | Skip> => {
  const read = (path: string, ref: string) =>
    readOptionalRepositoryFile(octokit, { owner, path, ref, repo });
  const targets: LockFileTarget[] = [];

  for (const configPath of changed.filter(isDevContainerConfigPath)) {
    const path = devContainerLockFilePathOf(configPath);
    // oxlint-disable-next-line no-await-in-loop -- a pull request changes one or two
    const [text, before, after] = await Promise.all([
      read(path, headSha),
      read(configPath, mergeBase),
      read(configPath, headSha),
    ]);

    if (text === undefined) {
      continue;
    }
    if (after === undefined) {
      return { reason: `the pull request deletes ${configPath}` };
    }

    // A configuration the pull request added had no Features before it.
    const parsedBefore = parseFeatureReferences(before ?? "{}");
    if (parsedBefore.result === "invalid") {
      return {
        reason: `${configPath} at the merge base: ${parsedBefore.reason}`,
      };
    }
    const parsedAfter = parseFeatureReferences(after);
    if (parsedAfter.result === "invalid") {
      return { reason: `${configPath} at the head: ${parsedAfter.reason}` };
    }

    const verdict = findFeatureBumps(
      parsedBefore.references,
      parsedAfter.references
    );
    if (verdict.result === "unsupported") {
      return { reason: `${configPath}: ${verdict.reason}` };
    }
    if (verdict.result === "bumped") {
      targets.push({ bumps: verdict.bumps, path, text });
    }
  }

  return targets;
};

/** Resolves every bumped Feature's new tag, or tells why it could not. */
const resolveBumps = async (
  targets: readonly LockFileTarget[],
  registry: RegistryOptions | undefined
): Promise<Map<string, ResolvedFeature> | Skip> => {
  const references = new Map(
    targets.flatMap(({ bumps }) => bumps.map(({ to }) => [to.reference, to]))
  );
  try {
    return new Map(
      await Promise.all(
        [...references.values()].map(
          async (to) =>
            [to.reference, await resolveFeature(to, registry)] as const
        )
      )
    );
  } catch (error) {
    return {
      reason: `the registry could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/** Regenerates each lock file; only those that change are returned. */
const regenerate = (
  targets: readonly LockFileTarget[],
  resolved: ReadonlyMap<string, ResolvedFeature>
): Regenerated | Skip => {
  const files: Record<string, string> = {};
  const synced = new Set<string>();

  for (const { path, text, bumps } of targets) {
    const lockFile = parseLockFile(text);
    if (lockFile.result === "invalid") {
      return { reason: `${path}: ${lockFile.reason}` };
    }

    const verdict = syncLockFileEntries({
      bumps,
      entries: lockFile.entries,
      resolved,
    });
    if (verdict.result === "unsupported") {
      return { reason: `${path}: ${verdict.reason}` };
    }
    if (verdict.result === "sync") {
      const regenerated = formatLockFile(verdict.entries, lockFile.format);
      if (regenerated !== text) {
        files[path] = regenerated;
        for (const reference of verdict.changed) {
          synced.add(reference);
        }
      }
    }
  }

  return { files, synced };
};

/** Such as `chore(devcontainer): sync the lock file with docker-in-docker 4.1.3`. */
const commitMessage = (
  paths: readonly string[],
  synced: ReadonlySet<string>,
  targets: readonly LockFileTarget[],
  resolved: ReadonlyMap<string, ResolvedFeature>
) => {
  const features = [
    ...new Set(
      targets.flatMap(({ bumps }) =>
        bumps
          .filter(({ to }) => synced.has(to.reference))
          .map(
            ({ to }) =>
              `${featureName(to.repository)} ${resolved.get(to.reference)?.version ?? to.tag}`
          )
      )
    ),
  ];
  const listed =
    features.length <= 1
      ? (features[0] ?? "")
      : `${features.slice(0, -1).join(", ")} and ${features.at(-1)}`;
  return `chore(devcontainer): sync the ${paths.length === 1 ? "lock file" : "lock files"} with ${listed}`;
};

/**
 * Commits the regenerated `devcontainer-lock.json` to a Renovate pull request
 * that bumps a Dev Container Feature. Renovate's devcontainer manager rewrites
 * the reference in `devcontainer.json` but leaves the lock file on the old
 * version, which the Dev Container CLI then rewrites on every build.
 *
 * Each bumped Feature's entry gets what `devcontainer upgrade` writes, read
 * from the Feature's registry, without the CLI or a sandbox; the other
 * entries, their order, and the file's formatting stay. A Feature added or
 * removed, a registry that cannot be read, or a lock file the CLI would not
 * write as it is leaves the pull request alone. No model is asked.
 *
 * It commits only when a lock file differs from the head's, on top of the
 * head and only as a fast-forward, so a redelivery or a push that leaves the
 * lock files in step adds nothing. Renovate may discard the commit when it
 * rewrites its branch; the push that does so brings the job back.
 */
export const syncDevContainerLockFile = async (
  options: SyncDevContainerLockFileOptions
): Promise<SyncDevContainerLockFileResult> => {
  const { octokit, owner, repo, pullNumber, dryRun = false } = options;

  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner,
    pull_number: pullNumber,
    repo,
  });
  const headSha = pullRequest.head.sha;
  const skip = (reason: string) =>
    ({ headSha, reason, status: "skipped" }) as const;

  if (!isRenovate(pullRequest.user)) {
    return skip("Renovate did not open the pull request");
  }
  if (pullRequest.state !== "open") {
    return skip("the pull request is closed");
  }
  if (pullRequest.head.repo?.full_name !== pullRequest.base.repo.full_name) {
    return skip("its branch is in another repository");
  }

  const { data: comparison } =
    await octokit.rest.repos.compareCommitsWithBasehead({
      basehead: `${pullRequest.base.sha}...${headSha}`,
      owner,
      repo,
    });
  const changed = (comparison.files ?? []).map(({ filename }) => filename);

  if (!changed.some(isDevContainerConfigPath)) {
    return skip("the pull request changes no Dev Container configuration");
  }

  const targets = await findTargets(options, {
    changed,
    headSha,
    mergeBase: comparison.merge_base_commit.sha,
  });
  if (isSkip(targets)) {
    return skip(targets.reason);
  }
  if (targets.length === 0) {
    return skip(
      "the pull request bumps no Feature of a configuration with a lock file"
    );
  }

  const resolved = await resolveBumps(targets, options.registry);
  if (isSkip(resolved)) {
    return skip(resolved.reason);
  }

  const regenerated = regenerate(targets, resolved);
  if (isSkip(regenerated)) {
    return skip(regenerated.reason);
  }

  const { files, synced } = regenerated;
  const lockFiles = Object.keys(files);

  if (lockFiles.length === 0) {
    return {
      headSha,
      lockFiles: targets.map(({ path }) => path),
      status: "in-sync",
    };
  }

  const message = commitMessage(lockFiles, synced, targets, resolved);

  if (dryRun) {
    return { files, headSha, lockFiles, message, status: "would-commit" };
  }

  const commit = await addCommitToBranch(octokit, {
    branch: pullRequest.head.ref,
    files,
    headSha,
    message,
    owner,
    repo,
  });

  return commit.status === "moved"
    ? { headSha, lockFiles, status: "head-moved" }
    : {
        commitSha: commit.sha,
        headSha,
        lockFiles,
        message,
        status: "committed",
      };
};

/** The fields of a result to log, without the files' contents. */
export const summarizeLockFileSyncResult = (
  result: SyncDevContainerLockFileResult
): LogFields => ({
  commit: "commitSha" in result ? result.commitSha : undefined,
  headSha: result.headSha,
  lockFiles: "lockFiles" in result ? result.lockFiles : undefined,
  modelInvoked: false,
  reason: "reason" in result ? result.reason : undefined,
  status: result.status,
});
