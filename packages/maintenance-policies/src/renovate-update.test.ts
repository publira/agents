import { describe, expect, it } from "vitest";

import {
  fingerprintRenovateUpdates,
  formatRenovateUpdate,
  parseRenovateUpdates,
} from "./renovate-update.ts";
import type { RenovateUpdate } from "./renovate-update.ts";

// The comment the preset's prHeader writes for one update.
const marker = (fields: Readonly<Record<string, string | null | undefined>>) =>
  `<!-- publira-renovate-update ${Buffer.from(JSON.stringify(fields)).toString("base64")} -->`;

const turbo = {
  currentVersion: "2.11.5",
  datasource: "npm",
  depName: "turbo",
  manager: "npm",
  newVersion: "2.11.6",
  packageName: "turbo",
  updateType: "patch",
} as const;

// Renovate writes no newVersion for a digest update of the current tag.
const baseImage = {
  currentDigest: "sha256:0a1b2c3d4e5f",
  currentVersion: "2026.10.04",
  datasource: "docker",
  depName: "ghcr.io/publira/base-images/publira-dev",
  manager: "devcontainer",
  newDigest: "sha256:3aeffdc00000",
  packageName: "ghcr.io/publira/base-images/publira-dev",
  updateType: "digest",
} as const;

// The header of publira/publira#3642, a digest update of the same image.
const capturedDigestHeader =
  "<!-- publira-renovate-update eyJtYW5hZ2VyIjoiZG9ja2VyLWNvbXBvc2UiLCJkYXRhc291cmNlIjoiZG9ja2VyIiwiZGVwTmFtZSI6ImdoY3IuaW8vcHVibGlyYS9iYXNlLWltYWdlcy9wdWJsaXJhLWRldiIsInBhY2thZ2VOYW1lIjoiZ2hjci5pby9wdWJsaXJhL2Jhc2UtaW1hZ2VzL3B1YmxpcmEtZGV2IiwiY3VycmVudFZlcnNpb24iOiIyMDI2LjEwLjA0IiwiY3VycmVudERpZ2VzdCI6InNoYTI1NjozYWVmZmRjZmU1NTBhNTNhZDljNTdjMGM4NmU3ZGVkMjVhNGM1MDQ0MzRmYTkyMThmMDY5MjRmYjc2NmZlMTJhIiwibmV3RGlnZXN0Ijoic2hhMjU2OjNmNjA5ZGVhYjc4ODYxMTEyOGQxZmJjMTRlNTdkZjhkM2U4MjBhZmVhZTRlNzdhNDdiMDg3YmJiOTFjNDFhNmQiLCJ1cGRhdGVUeXBlIjoiZGlnZXN0In0= -->";

// The start of a Renovate pull request body after the header.
const renovateBody = `This PR contains the following updates:

| Package | Change |
|---|---|
| turbo | \`2.11.5\` → \`2.11.6\` |
`;

const parsed = (updates: RenovateUpdate[]) => ({ result: "parsed", updates });

describe(parseRenovateUpdates, () => {
  it("reads the updates from the header", () => {
    expect(
      parseRenovateUpdates(`${marker(turbo)}\n\n${renovateBody}`)
    ).toStrictEqual(parsed([turbo]));
  });

  it("reads every update of a group, once each", () => {
    const turboWindows = {
      ...turbo,
      depName: "@turbo/windows-64",
      packageName: "@turbo/windows-64",
    };

    expect(
      parseRenovateUpdates(
        [
          marker(turbo),
          marker(turboWindows),
          marker(turbo),
          "",
          renovateBody,
        ].join("\n")
      )
    ).toStrictEqual(parsed([turboWindows, turbo]));
  });

  it("keeps digests, and drops fields Renovate left empty", () => {
    expect(
      parseRenovateUpdates(
        `${marker(baseImage)}\n${marker({ ...turbo, currentDigest: null })}\n`
      )
    ).toStrictEqual(
      parsed([baseImage, { ...turbo, currentDigest: undefined }])
    );
  });

  it("reads a digest update as Renovate writes it, without newVersion", () => {
    expect(
      parseRenovateUpdates(`${capturedDigestHeader}\n\n${renovateBody}`)
    ).toStrictEqual(
      parsed([
        {
          currentDigest:
            "sha256:3aeffdcfe550a53ad9c57c0c86e7ded25a4c504434fa9218f06924fb766fe12a",
          currentVersion: "2026.10.04",
          datasource: "docker",
          depName: "ghcr.io/publira/base-images/publira-dev",
          manager: "docker-compose",
          newDigest:
            "sha256:3f609deab788611128d1fbc14e57df8d3e820afeae4e77a47b087bbb91c41a6d",
          packageName: "ghcr.io/publira/base-images/publira-dev",
          updateType: "digest",
        },
      ])
    );
  });

  it("reads a digest pin, which has no digest to move from", () => {
    const pin = {
      currentVersion: "2026.10.04",
      datasource: "docker",
      depName: "ghcr.io/publira/base-images/publira-dev",
      manager: "devcontainer",
      newDigest: "sha256:3aeffdc00000",
      packageName: "ghcr.io/publira/base-images/publira-dev",
      updateType: "pinDigest",
    } as const;

    expect(parseRenovateUpdates(marker(pin))).toStrictEqual(parsed([pin]));
  });

  it("finds nothing in a body without the header", () => {
    expect(parseRenovateUpdates(renovateBody)).toStrictEqual({
      reason: "the body carries no update metadata",
      result: "invalid",
    });
  });

  it("refuses metadata below the header, as release notes could carry", () => {
    expect(
      parseRenovateUpdates(
        `${marker(turbo)}\n\n${renovateBody}\n${marker({ ...turbo, newVersion: "3.0.0" })}\n`
      )
    ).toMatchObject({ result: "invalid" });
    expect(
      parseRenovateUpdates(`${renovateBody}\n${marker(turbo)}\n`)
    ).toMatchObject({ result: "invalid" });
  });

  it.each([
    ["a missing field", { ...turbo, manager: undefined }],
    ["an unknown field", { ...turbo, newName: "turbo-next" }],
    ["an empty field", { ...turbo, currentVersion: "" }],
    ["an unsupported update type", { ...turbo, updateType: "replacement" }],
    ["a version update without newVersion", { ...turbo, newVersion: null }],
    [
      "a digest update without the digest it moves from",
      { ...baseImage, currentDigest: undefined },
    ],
    [
      "a digest update without the digest it moves to",
      { ...baseImage, newDigest: null },
    ],
    [
      "a digest pin without its digest",
      {
        ...baseImage,
        currentDigest: undefined,
        newDigest: undefined,
        updateType: "pinDigest",
      },
    ],
    [
      "lock file maintenance",
      { manager: "npm", updateType: "lockFileMaintenance" },
    ],
  ])("refuses %s", (_, fields) => {
    expect(parseRenovateUpdates(marker(fields))).toMatchObject({
      result: "invalid",
    });
  });

  it("refuses a payload that is not JSON", () => {
    expect(
      parseRenovateUpdates(
        `<!-- publira-renovate-update ${Buffer.from("turbo").toString("base64")} -->`
      )
    ).toMatchObject({ result: "invalid" });
  });
});

describe(fingerprintRenovateUpdates, () => {
  it("matches the same updates in any order", () => {
    expect(fingerprintRenovateUpdates([turbo, baseImage])).toBe(
      fingerprintRenovateUpdates([baseImage, turbo, turbo])
    );
  });

  it.each([
    ["from-version", { currentVersion: "2.11.4" }],
    ["target version", { newVersion: "2.11.7" }],
    ["manager", { manager: "bun" }],
    ["datasource", { datasource: "github-releases" }],
    ["update type", { updateType: "minor" }],
    ["package name", { packageName: "@vercel/turbo" }],
    ["digest", { newDigest: "sha256:ffff" }],
  ] as const)("tells apart a different %s", (_, change) => {
    expect(fingerprintRenovateUpdates([{ ...turbo, ...change }])).not.toBe(
      fingerprintRenovateUpdates([turbo])
    );
  });

  it("tells apart a digest update without newVersion from one with it", () => {
    expect(
      fingerprintRenovateUpdates([
        { ...baseImage, newVersion: baseImage.currentVersion },
      ])
    ).not.toBe(fingerprintRenovateUpdates([baseImage]));
  });

  it("tells apart a group from one of its updates", () => {
    expect(fingerprintRenovateUpdates([turbo, baseImage])).not.toBe(
      fingerprintRenovateUpdates([turbo])
    );
  });

  it("does not run fields together", () => {
    expect(
      fingerprintRenovateUpdates([{ ...turbo, depName: "a:b", manager: "npm" }])
    ).not.toBe(
      fingerprintRenovateUpdates([{ ...turbo, depName: "b", manager: "npm:a" }])
    );
  });
});

describe(formatRenovateUpdate, () => {
  it("describes a version update", () => {
    expect(formatRenovateUpdate(turbo)).toBe(
      "npm:npm:turbo:2.11.5->2.11.6:patch"
    );
  });

  it("describes a digest update", () => {
    expect(formatRenovateUpdate(baseImage)).toBe(
      "devcontainer:docker:ghcr.io/publira/base-images/publira-dev:2026.10.04->@0a1b2c3->3aeffdc:digest"
    );
  });

  it("names the package looked up when it differs", () => {
    expect(
      formatRenovateUpdate({
        ...turbo,
        depName: "node",
        packageName: "nodejs/node",
      })
    ).toBe("npm:npm:node(nodejs/node):2.11.5->2.11.6:patch");
  });
});
