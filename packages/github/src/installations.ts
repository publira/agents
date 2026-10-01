import type { Octokit } from "@octokit/rest";

import type { GitHubApp } from "./app.ts";

export interface InstallationRepository {
  installationId: number;
  owner: string;
  repo: string;
  defaultBranch: string;
  archived: boolean;
}

/** Lists the repositories one installation of the App can access. */
export const listInstallationRepositories = async (
  installationOctokit: Octokit,
  installationId: number
): Promise<InstallationRepository[]> => {
  const repositories = await installationOctokit.paginate(
    installationOctokit.rest.apps.listReposAccessibleToInstallation,
    { per_page: 100 }
  );

  return repositories.map((repository) => ({
    archived: repository.archived,
    defaultBranch: repository.default_branch,
    installationId,
    owner: repository.owner.login,
    repo: repository.name,
  }));
};

/** Lists the repositories of every installation of the App. */
export const listAppRepositories = async (
  app: GitHubApp
): Promise<InstallationRepository[]> => {
  const installations = await app.octokit.paginate(
    app.octokit.rest.apps.listInstallations,
    { per_page: 100 }
  );
  // A suspended installation cannot get a token.
  const repositories = await Promise.all(
    installations
      .filter((installation) => installation.suspended_at === null)
      .map(async (installation) =>
        listInstallationRepositories(
          await app.getInstallationOctokit(installation.id),
          installation.id
        )
      )
  );

  return repositories.flat();
};
