import { createAppAuth } from "@octokit/auth-app";
import type { StrategyOptions } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

import type { RepositoryName } from "./repository-name.ts";

const userAgent = "publira-maintenance-bot";

export interface GitHubAppCredentials {
  appId: number | string;
  /** The App's private key, in PEM. */
  privateKey: string;
}

export interface GitHubAppOptions extends GitHubAppCredentials {
  /** Defaults to the global `fetch`; tests pass their own. */
  fetch?: typeof fetch;
}

export interface GitHubApp {
  /** Authenticates as the App itself, with a JWT, for the `/app` endpoints. */
  readonly octokit: Octokit;
  /**
   * Returns a client that authenticates as an installation. It requests an
   * installation token on first use and a new one before it expires; the
   * tokens are cached across the clients of this App.
   */
  getInstallationOctokit: (installationId: number) => Promise<Octokit>;
  /** Returns a client for the installation that covers a repository. */
  getRepositoryOctokit: (repository: RepositoryName) => Promise<Octokit>;
  /** The login the App acts under, such as `publira-maintenance[bot]`. */
  getBotLogin: () => Promise<string>;
}

export const createGitHubApp = ({
  appId,
  privateKey,
  fetch: fetchImpl,
}: GitHubAppOptions): GitHubApp => {
  const request = fetchImpl === undefined ? undefined : { fetch: fetchImpl };
  const octokit = new Octokit({
    auth: { appId, privateKey },
    authStrategy: createAppAuth,
    request,
    userAgent,
  });
  let botLogin: Promise<string> | undefined;

  const getInstallationOctokit = (installationId: number) =>
    // SAFETY: with a factory, `auth` resolves to what the factory returns.
    octokit.auth({
      // The factory hands the new client this App's token cache.
      factory: (auth: StrategyOptions) =>
        new Octokit({ auth, authStrategy: createAppAuth, request, userAgent }),
      installationId,
      type: "installation",
    }) as Promise<Octokit>;

  const fetchBotLogin = async () => {
    try {
      const { data } = await octokit.rest.apps.getAuthenticated();
      if (data?.slug === undefined) {
        throw new Error("GitHub did not return the App's slug");
      }
      return `${data.slug}[bot]`;
    } catch (error) {
      // Ask again next time rather than keep the failure.
      botLogin = undefined;
      throw error;
    }
  };

  return {
    getBotLogin: () => {
      botLogin ??= fetchBotLogin();
      return botLogin;
    },
    getInstallationOctokit,
    async getRepositoryOctokit({ owner, repo }) {
      const { data } = await octokit.rest.apps.getRepoInstallation({
        owner,
        repo,
      });
      return getInstallationOctokit(data.id);
    },
    octokit,
  };
};
