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

const baseImage = {
  currentDigest: "sha256:0a1b2c3d4e5f",
  currentVersion: "2026.10.04",
  datasource: "docker",
  depName: "ghcr.io/publira/base-images/publira-dev",
  manager: "devcontainer",
  newDigest: "sha256:3aeffdc00000",
  newVersion: "2026.10.04",
  packageName: "ghcr.io/publira/base-images/publira-dev",
  updateType: "digest",
} as const;

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
      "devcontainer:docker:ghcr.io/publira/base-images/publira-dev:2026.10.04->2026.10.04@0a1b2c3->3aeffdc:digest"
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
