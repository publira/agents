import type { Octokit } from "@octokit/rest";
import { z } from "zod";

export interface RepositoryPermissionLocation {
  owner: string;
  repo: string;
  username: string;
}

const failure = z.object({
  response: z
    .object({
      headers: z.looseObject({
        "retry-after": z.string().optional(),
        "x-ratelimit-remaining": z.string().optional(),
      }),
    })
    .optional(),
  status: z.number(),
});

// The token cannot read the repository's collaborators, as an App's cannot on
// a repository it is not installed on, or the user does not exist. A 403 can
// also be a rate limit, which the request policy already waited out.
const isUnreadable = ({ status, response }: z.infer<typeof failure>) =>
  status === 404 ||
  (status === 403 &&
    response?.headers["retry-after"] === undefined &&
    response?.headers["x-ratelimit-remaining"] !== "0");

/**
 * Returns a user's permission on a repository as the REST API reports it:
 * `admin`, `write`, `read`, or `none`, with `maintain` read as `write` and
 * `triage` as `read`. It counts every grant, through the organization and
 * teams too, and does not depend on who asks, unlike a review's
 * `author_association`. Returns `undefined` when the token cannot read it.
 * It needs a token with the Metadata permission on the repository.
 */
export const getRepositoryPermission = async (
  octokit: Octokit,
  { owner, repo, username }: RepositoryPermissionLocation
): Promise<string | undefined> => {
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });
    return data.permission;
  } catch (error) {
    const failed = failure.safeParse(error).data;
    if (failed !== undefined && isUnreadable(failed)) {
      return undefined;
    }
    throw error;
  }
};
