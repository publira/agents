import { createGitHubApp } from "@publira/github";
import type { GitHubApp } from "@publira/github";
import { z } from "zod";

export interface GitHubAppConfig {
  appId: string;
  /** The App's private key, in PEM. */
  privateKey: string;
  webhookSecret: string;
}

const configSchema = z.object({
  GITHUB_APP_ID: z.string().regex(/^\d+$/u, "must be the App's numeric ID"),
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    // A key pasted on one line keeps its line breaks as `\n`.
    .transform((key) => key.replaceAll(String.raw`\n`, "\n"))
    .pipe(z.string().includes("PRIVATE KEY", { error: "must be a PEM key" })),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
});

const names = Object.keys(configSchema.shape);

/**
 * Reads the App's credentials from the environment. Without any of the
 * variables, the bot runs without the App and returns `undefined`; with only
 * some of them, the configuration is broken and it throws.
 */
export const readGitHubAppConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env
): GitHubAppConfig | undefined => {
  if (names.every((name) => (env[name] ?? "") === "")) {
    return undefined;
  }

  const result = configSchema.safeParse(env);

  if (!result.success) {
    // The issues name the variables, not their values.
    const problems = result.error.issues.map(
      ({ message, path }) => `${path.join(".")} ${message}`
    );
    throw new Error(`The GitHub App is misconfigured: ${problems.join("; ")}`);
  }

  return {
    appId: result.data.GITHUB_APP_ID,
    privateKey: result.data.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: result.data.GITHUB_WEBHOOK_SECRET,
  };
};

let app: GitHubApp | null | undefined;

/**
 * The App as the environment configures it, or `undefined` without one. The
 * instance lives as long as the process, so its installation tokens are
 * reused across requests.
 */
export const getGitHubApp = (): GitHubApp | undefined => {
  if (app === undefined) {
    const config = readGitHubAppConfig();
    app = config === undefined ? null : createGitHubApp(config);
  }
  return app ?? undefined;
};
