import type { GitHubApp } from "./app.ts";

export interface RepositoryReadTokenOptions {
  installationId: number;
  /** The repository's name, without its owner. */
  repo: string;
}

/**
 * Creates an installation token that can only read the contents of one
 * repository, for a place that must not hold the App's write access, such as
 * a sandbox that clones the repository. It expires after an hour.
 */
export const createRepositoryReadToken = async (
  app: GitHubApp,
  { installationId, repo }: RepositoryReadTokenOptions
): Promise<string> => {
  const { data } = await app.octokit.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
    permissions: { contents: "read" },
    repositories: [repo],
  });
  return data.token;
};
