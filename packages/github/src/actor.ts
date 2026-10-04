import { z } from "zod";

/** An `Actor` as GitHub's GraphQL API returns it. */
export const graphqlActor = z.object({
  __typename: z.string(),
  login: z.string(),
});

/**
 * Spells an actor's login as the REST API does: GraphQL leaves the `[bot]`
 * suffix off a bot's login.
 */
export const restLogin = ({
  __typename,
  login,
}: z.infer<typeof graphqlActor>): string =>
  __typename === "Bot" ? `${login}[bot]` : login;
