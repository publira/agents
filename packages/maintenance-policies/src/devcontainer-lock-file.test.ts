import { describe, expect, it } from "vitest";

import {
  devContainerLockFilePathOf,
  findFeatureBumps,
  isDevContainerConfigPath,
  parseFeatureReference,
  syncLockFileEntries,
} from "./devcontainer-lock-file.ts";
import type { LockedFeature } from "./devcontainer-lock-file.ts";

const DIND = "ghcr.io/devcontainers/features/docker-in-docker";
const GH_CLI = "ghcr.io/devcontainers/features/github-cli";
const OLD_DIGEST =
  "sha256:ad3d6d36d95ee7f880f61f98862257f3e70253d3faef09f86af42fb87ee60429";
const NEW_DIGEST =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const GH_CLI_DIGEST =
  "sha256:bd7ab48a832228f633239277552c30b353867fef2e5b037e064b4e64f0b843f2";

describe(isDevContainerConfigPath, () => {
  it.each([
    ".devcontainer/devcontainer.json",
    ".devcontainer/python/devcontainer.json",
    ".devcontainer.json",
  ])("accepts %s", (path) => {
    expect(isDevContainerConfigPath(path)).toBeTruthy();
  });

  it.each([
    "devcontainer.json",
    ".devcontainer/devcontainer-lock.json",
    ".devcontainer/a/b/devcontainer.json",
    "apps/web/.devcontainer/devcontainer.json",
  ])("refuses %s", (path) => {
    expect(isDevContainerConfigPath(path)).toBeFalsy();
  });
});

describe(devContainerLockFilePathOf, () => {
  it.each([
    [".devcontainer/devcontainer.json", ".devcontainer/devcontainer-lock.json"],
    [
      ".devcontainer/python/devcontainer.json",
      ".devcontainer/python/devcontainer-lock.json",
    ],
    [".devcontainer.json", ".devcontainer-lock.json"],
  ])("puts the lock file of %s at %s", (config, lockFile) => {
    expect(devContainerLockFilePathOf(config)).toBe(lockFile);
  });
});

describe(parseFeatureReference, () => {
  it("reads a reference by tag", () => {
    expect(parseFeatureReference(`${DIND}:4.1.3`)).toStrictEqual({
      reference: `${DIND}:4.1.3`,
      registry: "ghcr.io",
      repository: "devcontainers/features/docker-in-docker",
      tag: "4.1.3",
    });
  });

  it("reads a registry with a port", () => {
    expect(
      parseFeatureReference("registry.example.com:5000/team/feature:1")
    ).toMatchObject({ registry: "registry.example.com:5000", tag: "1" });
  });

  it.each([
    `${DIND}`,
    `${DIND}@${OLD_DIGEST}`,
    "./local-feature",
    "https://example.com/feature.tgz",
    "docker-in-docker:4",
  ])("refuses %s", (reference) => {
    expect(parseFeatureReference(reference)).toBeUndefined();
  });
});

describe(findFeatureBumps, () => {
  it("pairs a reference whose tag changed", () => {
    expect(
      findFeatureBumps(
        [`${GH_CLI}:1.1.3`, `${DIND}:4.1.2`],
        [`${GH_CLI}:1.1.3`, `${DIND}:4.1.3`]
      )
    ).toStrictEqual({
      bumps: [
        {
          from: parseFeatureReference(`${DIND}:4.1.2`),
          to: parseFeatureReference(`${DIND}:4.1.3`),
        },
      ],
      result: "bumped",
    });
  });

  it("finds nothing when the references stay", () => {
    expect(
      findFeatureBumps([`${DIND}:4.1.2`], [`${DIND}:4.1.2`])
    ).toStrictEqual({ result: "unchanged" });
  });

  it("leaves a Feature that was added", () => {
    expect(
      findFeatureBumps([`${DIND}:4.1.2`], [`${DIND}:4.1.2`, `${GH_CLI}:1.1.3`])
    ).toStrictEqual({
      reason: `the pull request added ${GH_CLI}`,
      result: "unsupported",
    });
  });

  it("leaves a Feature that was removed", () => {
    expect(
      findFeatureBumps([`${DIND}:4.1.2`, `${GH_CLI}:1.1.3`], [`${DIND}:4.1.2`])
    ).toStrictEqual({
      reason: `the pull request removed ${GH_CLI}`,
      result: "unsupported",
    });
  });

  it("leaves a reference that is not by tag", () => {
    expect(
      findFeatureBumps([`${DIND}:4.1.2`], [`${DIND}@${NEW_DIGEST}`])
    ).toStrictEqual({
      reason: `${DIND}@${NEW_DIGEST} is not a Feature in an OCI registry referenced by a tag`,
      result: "unsupported",
    });
  });
});

const lockedDind: LockedFeature = {
  integrity: OLD_DIGEST,
  resolved: `${DIND}@${OLD_DIGEST}`,
  version: "4.1.2",
};
const lockedGhCli: LockedFeature = {
  integrity: GH_CLI_DIGEST,
  resolved: `${GH_CLI}@${GH_CLI_DIGEST}`,
  version: "1.1.3",
};
const syncedDind: LockedFeature = {
  integrity: NEW_DIGEST,
  resolved: `${DIND}@${NEW_DIGEST}`,
  version: "4.1.3",
};

const dindBump = findFeatureBumps([`${DIND}:4.1.2`], [`${DIND}:4.1.3`]);
const bumps = dindBump.result === "bumped" ? dindBump.bumps : [];
const resolved = new Map([
  [`${DIND}:4.1.3`, { dependsOn: [], digest: NEW_DIGEST, version: "4.1.3" }],
]);

describe(syncLockFileEntries, () => {
  it("replaces the bumped entry in place", () => {
    expect(
      syncLockFileEntries({
        bumps,
        entries: [
          [
            "ghcr.io/anthropics/devcontainer-features/claude-code:1.0.5",
            {
              integrity: "sha256:c",
              resolved:
                "ghcr.io/anthropics/devcontainer-features/claude-code@sha256:c",
              version: "1.0.5",
            },
          ],
          [`${DIND}:4.1.2`, lockedDind],
          [`${GH_CLI}:1.1.3`, lockedGhCli],
        ],
        resolved,
      })
    ).toStrictEqual({
      changed: [`${DIND}:4.1.3`],
      entries: [
        [
          "ghcr.io/anthropics/devcontainer-features/claude-code:1.0.5",
          {
            integrity: "sha256:c",
            resolved:
              "ghcr.io/anthropics/devcontainer-features/claude-code@sha256:c",
            version: "1.0.5",
          },
        ],
        [`${DIND}:4.1.3`, syncedDind],
        [`${GH_CLI}:1.1.3`, lockedGhCli],
      ],
      result: "sync",
    });
  });

  it("finds an entry that is already up to date in sync", () => {
    expect(
      syncLockFileEntries({
        bumps,
        entries: [
          [`${DIND}:4.1.3`, syncedDind],
          [`${GH_CLI}:1.1.3`, lockedGhCli],
        ],
        resolved,
      })
    ).toStrictEqual({ result: "in-sync" });
  });

  it("corrects an entry under the new reference whose digest differs", () => {
    expect(
      syncLockFileEntries({
        bumps,
        entries: [[`${DIND}:4.1.3`, { ...syncedDind, integrity: OLD_DIGEST }]],
        resolved,
      })
    ).toStrictEqual({
      changed: [`${DIND}:4.1.3`],
      entries: [[`${DIND}:4.1.3`, syncedDind]],
      result: "sync",
    });
  });

  it("drops a stale entry beside the new one", () => {
    expect(
      syncLockFileEntries({
        bumps,
        entries: [
          [`${DIND}:4.1.2`, lockedDind],
          [`${DIND}:4.1.3`, syncedDind],
        ],
        resolved,
      })
    ).toStrictEqual({
      changed: [`${DIND}:4.1.3`],
      entries: [[`${DIND}:4.1.3`, syncedDind]],
      result: "sync",
    });
  });

  it("keeps the dependencies of a Feature", () => {
    const dependsOn = ["ghcr.io/devcontainers/features/common-utils:2"];

    expect(
      syncLockFileEntries({
        bumps,
        entries: [[`${DIND}:4.1.2`, { ...lockedDind, dependsOn }]],
        resolved: new Map([
          [
            `${DIND}:4.1.3`,
            { dependsOn, digest: NEW_DIGEST, version: "4.1.3" },
          ],
        ]),
      })
    ).toStrictEqual({
      changed: [`${DIND}:4.1.3`],
      entries: [[`${DIND}:4.1.3`, { ...syncedDind, dependsOn }]],
      result: "sync",
    });
  });

  it("leaves a Feature whose dependencies changed", () => {
    expect(
      syncLockFileEntries({
        bumps,
        entries: [[`${DIND}:4.1.2`, lockedDind]],
        resolved: new Map([
          [
            `${DIND}:4.1.3`,
            {
              dependsOn: ["ghcr.io/devcontainers/features/common-utils:2"],
              digest: NEW_DIGEST,
              version: "4.1.3",
            },
          ],
        ]),
      })
    ).toStrictEqual({
      reason: `${DIND}:4.1.3 depends on other Features than ${DIND}:4.1.2`,
      result: "unsupported",
    });
  });

  it("leaves a lock file without the Feature", () => {
    expect(
      syncLockFileEntries({
        bumps,
        entries: [[`${GH_CLI}:1.1.3`, lockedGhCli]],
        resolved,
      })
    ).toStrictEqual({
      reason: `the lock file has no entry for ${DIND}:4.1.2 or ${DIND}:4.1.3`,
      result: "unsupported",
    });
  });
});
