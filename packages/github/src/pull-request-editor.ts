import type { Octokit } from "@octokit/rest";
import { z } from "zod";

import { graphqlActor, restLogin } from "./actor.ts";

export interface PullRequestLocation {
  owner: string;
  repo: string;
  pullNumber: number;
}

const editorResponse = z.object({
  repository: z.object({
    pullRequest: z.object({
      editor: graphqlActor.nullable(),
    }),
  }),
});

/**
 * Returns the login of whoever last edited a pull request's body, as the REST
 * API spells it (`renovate[bot]` for a bot), or `null` when nobody edited it
 * after it was opened. Only GraphQL exposes it, so it needs a token.
 */
export const getPullRequestBodyEditor = async (
  octokit: Octokit,
  { owner, repo, pullNumber }: PullRequestLocation
): Promise<string | null> => {
  const response = await octokit.graphql(
    `query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          editor { __typename login }
        }
      }
    }`,
    { number: pullNumber, owner, repo }
  );
  const { editor } = editorResponse.parse(response).repository.pullRequest;

  return editor === null ? null : restLogin(editor);
};
