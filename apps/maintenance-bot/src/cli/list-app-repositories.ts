// Lists the repositories the GitHub App is installed on, with the GITHUB_APP_*
// variables of a development App in .env.local:
//
//   pnpm --filter @publira/maintenance-bot list-app-repositories
//
// A quick check that the App's credentials work: it signs a JWT, then gets a
// token for each installation.
import { listAppRepositories } from "@publira/github";

import { getGitHubApp } from "../github-app.ts";

const app = getGitHubApp();

if (app === undefined) {
  console.error(
    "Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_WEBHOOK_SECRET, such as in .env.local."
  );
  process.exit(2);
}

console.log(`Authenticated as ${await app.getBotLogin()}.`);

for (const {
  archived,
  installationId,
  owner,
  repo,
} of await listAppRepositories(app)) {
  console.log(
    `${owner}/${repo} (installation ${installationId}${archived ? ", archived" : ""})`
  );
}
