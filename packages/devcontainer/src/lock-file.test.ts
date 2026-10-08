import { describe, expect, it } from "vitest";

import { formatLockFile, parseLockFile } from "./lock-file.ts";

const DIND = "ghcr.io/devcontainers/features/docker-in-docker";
const DIGEST =
  "sha256:ad3d6d36d95ee7f880f61f98862257f3e70253d3faef09f86af42fb87ee60429";

// As the Dev Container CLI writes it.
const lockFile = `{
  "features": {
    "${DIND}:4.1.2": {
      "version": "4.1.2",
      "resolved": "${DIND}@${DIGEST}",
      "integrity": "${DIGEST}"
    },
    "ghcr.io/devcontainers/features/node:1": {
      "version": "1.6.3",
      "resolved": "ghcr.io/devcontainers/features/node@sha256:abc",
      "integrity": "sha256:abc",
      "dependsOn": [
        "ghcr.io/devcontainers/features/common-utils:2"
      ]
    }
  }
}`;

describe(parseLockFile, () => {
  it("reads the entries in the file's order", () => {
    expect(parseLockFile(lockFile)).toStrictEqual({
      entries: [
        [
          `${DIND}:4.1.2`,
          {
            integrity: DIGEST,
            resolved: `${DIND}@${DIGEST}`,
            version: "4.1.2",
          },
        ],
        [
          "ghcr.io/devcontainers/features/node:1",
          {
            dependsOn: ["ghcr.io/devcontainers/features/common-utils:2"],
            integrity: "sha256:abc",
            resolved: "ghcr.io/devcontainers/features/node@sha256:abc",
            version: "1.6.3",
          },
        ],
      ],
      format: { finalNewline: false, indent: "  " },
      result: "parsed",
    });
  });

  it("keeps a final newline and another indent", () => {
    const text = `${lockFile.replaceAll("  ", "\t")}\n`;
    const parsed = parseLockFile(text);

    expect(parsed).toMatchObject({
      format: { finalNewline: true, indent: "\t" },
      result: "parsed",
    });
    expect(
      parsed.result === "parsed"
        ? formatLockFile(parsed.entries, parsed.format)
        : undefined
    ).toBe(text);
  });

  it("refuses a file formatted otherwise", () => {
    expect(parseLockFile(JSON.stringify(JSON.parse(lockFile)))).toStrictEqual({
      reason: "it is not formatted as the Dev Container CLI writes it",
      result: "invalid",
    });
  });

  it("refuses a field it does not know", () => {
    expect(
      parseLockFile(
        lockFile.replace('"version": "4.1.2"', '"version": "4.1.2", "x": 1')
      )
    ).toStrictEqual({
      reason: "it holds more or other than the Features' entries",
      result: "invalid",
    });
  });

  it("refuses a file that is not JSON", () => {
    expect(parseLockFile("{")).toStrictEqual({
      reason: "it is not JSON",
      result: "invalid",
    });
  });
});

describe(formatLockFile, () => {
  it("writes each entry's fields in the CLI's order", () => {
    expect(
      formatLockFile(
        [
          [
            `${DIND}:4.1.3`,
            {
              integrity: "sha256:new",
              resolved: `${DIND}@sha256:new`,
              version: "4.1.3",
            },
          ],
        ],
        { finalNewline: true, indent: "  " }
      )
    ).toBe(`{
  "features": {
    "${DIND}:4.1.3": {
      "version": "4.1.3",
      "resolved": "${DIND}@sha256:new",
      "integrity": "sha256:new"
    }
  }
}
`);
  });
});
