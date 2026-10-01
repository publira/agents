import { describe, expect, it } from "vitest";

import { parseRepositoryName } from "./repository-name.ts";

describe(parseRepositoryName, () => {
  it("splits the owner and the repository", () => {
    expect(parseRepositoryName("publira/agents")).toStrictEqual({
      owner: "publira",
      repo: "agents",
    });
  });

  it.each(["publira", "publira/", "/agents", "publira/agents/main"])(
    "rejects %j",
    (name) => {
      expect(() => parseRepositoryName(name)).toThrow(
        "Expected a repository as owner/repo"
      );
    }
  );
});
