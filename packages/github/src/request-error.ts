import { z } from "zod";

/** The part of a failed Octokit request that tells what went wrong. */
export const requestFailure = z.object({ status: z.number() });
