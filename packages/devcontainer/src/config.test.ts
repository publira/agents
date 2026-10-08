import { describe, expect, it } from "vitest";

import { parseFeatureReferences } from "./config.ts";

describe(parseFeatureReferences, () => {
  it("lists the Features of a configuration with comments", () => {
    expect(
      parseFeatureReferences(`{
  "features": {
    "ghcr.io/anthropics/devcontainer-features/claude-code:1.0.5": {},
    // eve runs sandboxes in a local Docker daemon.
    "ghcr.io/devcontainers/features/docker-in-docker:4.1.2": {
      "moby": false,
    },
  },
  "image": "mcr.microsoft.com/devcontainers/base:debian",
}
`)
    ).toStrictEqual({
      references: [
        "ghcr.io/anthropics/devcontainer-features/claude-code:1.0.5",
        "ghcr.io/devcontainers/features/docker-in-docker:4.1.2",
      ],
      result: "parsed",
    });
  });

  it("lists none for a configuration without Features", () => {
    expect(parseFeatureReferences('{ "image": "debian" }')).toStrictEqual({
      references: [],
      result: "parsed",
    });
  });

  it("refuses a file that does not parse", () => {
    expect(parseFeatureReferences('{ "features": ')).toMatchObject({
      result: "invalid",
    });
  });

  it("refuses Features that are not an object", () => {
    expect(parseFeatureReferences('{ "features": [] }')).toStrictEqual({
      reason: "its features are not an object",
      result: "invalid",
    });
  });
});
