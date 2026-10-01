import { createGitHubClient, parseRepositoryName } from "@publira/github";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { checkReleaseAgeExclusions } from "../../src/jobs/check-release-age-exclusions.ts";

export default defineTool({
  description:
    "Check which minimumReleaseAgeExclude entries in a repository's pnpm-workspace.yaml are still needed. An entry is expired once every version it pins is older than the workspace's minimumReleaseAge, waiting while one is not, and kept when it pins no version.",
  execute({ ref, repository }) {
    return checkReleaseAgeExclusions({
      ...parseRepositoryName(repository),
      // Anonymous until the bot authenticates as the GitHub App (#3).
      octokit: createGitHubClient(),
      ref,
    });
  },
  inputSchema: z.object({
    ref: z
      .string()
      .optional()
      .describe("A branch, tag, or commit. Defaults to the default branch."),
    repository: z
      .string()
      .describe("A public repository as owner/repo, such as publira/publira."),
  }),
});
