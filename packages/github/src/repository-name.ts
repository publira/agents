export interface RepositoryName {
  owner: string;
  repo: string;
}

/** Splits an `owner/repo` name. */
export const parseRepositoryName = (name: string): RepositoryName => {
  const [owner, repo, ...rest] = name.split("/");

  if (
    owner === undefined ||
    owner === "" ||
    repo === undefined ||
    repo === "" ||
    rest.length > 0
  ) {
    throw new Error(
      `Expected a repository as owner/repo, got ${JSON.stringify(name)}`
    );
  }

  return { owner, repo };
};
