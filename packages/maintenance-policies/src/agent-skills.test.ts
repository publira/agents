import { describe, expect, it } from "vitest";

import { diffSkillsLocks, isAgentSkillsPath } from "./agent-skills.ts";

describe(isAgentSkillsPath, () => {
  it.each([
    "skills-lock.json",
    ".agents/skills/ultracite/SKILL.md",
    ".agents/skills/coding-standards",
    ".claude/skills/ultracite",
  ])("accepts %s", (path) => {
    expect(isAgentSkillsPath(path)).toBeTruthy();
  });

  it.each([
    "apps/web/skills-lock.json",
    ".agents/skills",
    ".agents/AGENTS.md",
    ".claude/settings.json",
    "skills/ultracite/SKILL.md",
    ".github/workflows/skills-update.yml",
  ])("rejects %s", (path) => {
    expect(isAgentSkillsPath(path)).toBeFalsy();
  });
});

// Entries of publira/publira's skills-lock.json.
const entry = (source: string, hash: string) => ({
  computedHash: hash,
  skillPath: "SKILL.md",
  source,
  sourceType: "github",
});

const lock = (skills: Record<string, ReturnType<typeof entry>>) =>
  `${JSON.stringify({ skills, version: 1 }, null, 2)}\n`;

describe(diffSkillsLocks, () => {
  it("lists the skills that were added, updated, and removed", () => {
    const before = lock({
      "gh-stack": entry("github/gh-stack", "6a52"),
      ultracite: entry("haydenbleasel/ultracite", "7660"),
      "web-design-guidelines": entry("vercel-labs/agent-skills", "1f2e"),
    });
    const after = lock({
      "frontend-design": entry("anthropics/skills", "8949"),
      "gh-stack": entry("github/gh-stack", "6a52"),
      ultracite: entry("haydenbleasel/ultracite", "9d01"),
    });

    expect(diffSkillsLocks(before, after)).toStrictEqual([
      { change: "added", name: "frontend-design", source: "anthropics/skills" },
      {
        change: "updated",
        name: "ultracite",
        source: "haydenbleasel/ultracite",
      },
      {
        change: "removed",
        name: "web-design-guidelines",
        source: "vercel-labs/agent-skills",
      },
    ]);
  });

  it("ignores the order of the fields", () => {
    const reordered =
      '{"version":1,"skills":{"gh-stack":{"source":"github/gh-stack","sourceType":"github","skillPath":"SKILL.md","computedHash":"6a52"}}}';

    expect(
      diffSkillsLocks(
        lock({ "gh-stack": entry("github/gh-stack", "6a52") }),
        reordered
      )
    ).toStrictEqual([]);
  });

  it("reads a missing lock file as one without skills", () => {
    expect(
      diffSkillsLocks(
        undefined,
        lock({ "gh-stack": entry("github/gh-stack", "6a52") })
      )
    ).toStrictEqual([
      { change: "added", name: "gh-stack", source: "github/gh-stack" },
    ]);
  });

  it("refuses a file that is not a skills lock file", () => {
    expect(() => diffSkillsLocks("{}", lock({}))).toThrow(
      "skills-lock.json is not a skills lock file"
    );
  });
});
