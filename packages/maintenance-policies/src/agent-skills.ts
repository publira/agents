import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

/** Where the skills CLI records the vendored skills and their sources. */
export const SKILLS_LOCK_FILE = "skills-lock.json";

const SKILL_DIRECTORIES = [".agents/skills/", ".claude/skills/"] as const;

/**
 * Whether a skills update may change a path: the lock file at the
 * repository's root, or a path under `.agents/skills/` or `.claude/skills/`,
 * where the skills CLI installs project skills. Any other path the update
 * touches is left out of its commit.
 */
export const isAgentSkillsPath = (path: string): boolean =>
  path === SKILLS_LOCK_FILE ||
  SKILL_DIRECTORIES.some((directory) => path.startsWith(directory));

const skillsLock = z.looseObject({
  skills: z.record(
    z.string(),
    z.looseObject({ computedHash: z.string(), source: z.string() })
  ),
});

/** A skill that a skills update added, updated, or removed. */
export interface SkillChange {
  name: string;
  /** Where the skill comes from, such as `anthropics/skills`. */
  source: string;
  change: "added" | "removed" | "updated";
}

const parseSkillsLock = (source: string | undefined) => {
  if (source === undefined) {
    return {};
  }
  const result = skillsLock.safeParse(JSON.parse(source));
  if (!result.success) {
    throw new Error(`${SKILLS_LOCK_FILE} is not a skills lock file`);
  }
  return result.data.skills;
};

/**
 * Compares two versions of `skills-lock.json`, `undefined` for one that does
 * not exist, and lists the skills whose entries differ, by name. A skill is
 * updated when anything in its entry changed, such as the hash of its files.
 */
export const diffSkillsLocks = (
  before: string | undefined,
  after: string | undefined
): SkillChange[] => {
  const old = new Map(Object.entries(parseSkillsLock(before)));
  const current = new Map(Object.entries(parseSkillsLock(after)));
  const names = [...new Set([...old.keys(), ...current.keys()])].toSorted();

  return names.flatMap((name): SkillChange[] => {
    const was = old.get(name);
    const is = current.get(name);

    if (is === undefined) {
      return was === undefined
        ? []
        : [{ change: "removed", name, source: was.source }];
    }
    if (was === undefined) {
      return [{ change: "added", name, source: is.source }];
    }
    return isDeepStrictEqual(was, is)
      ? []
      : [{ change: "updated", name, source: is.source }];
  });
};
