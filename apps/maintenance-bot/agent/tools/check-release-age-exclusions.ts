import { createGitHubClient, parseRepositoryName } from "@publira/github";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getGitHubApp } from "../../src/github-app.ts";
import { checkReleaseAgeExclusions } from "../../src/jobs/check-release-age-exclusions.ts";

export default defineTool({
  description:
    "Check which minimumReleaseAgeExclude entries in a repository's pnpm-workspace.yaml are still needed. An entry is expired once every version it pins is older than the workspace's minimumReleaseAge, waiting while one is not, and kept when it pins no version.",
  async execute({ ref, repository }) {
    const name = parseRepositoryName(repository);
    const app = getGitHubApp();

    return checkReleaseAgeExclusions({
      ...name,
      // Without the App, as in a local `eve dev`, only public repositories
      // can be read, anonymously.
      octokit:
        app === undefined
          ? createGitHubClient()
          : await app.getRepositoryOctokit(name),
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
      .describe(
        "A repository the GitHub App is installed on, as owner/repo, such as publira/publira."
      ),
  }),
});
