import { defineSandbox } from "eve/sandbox";
import { defineSandboxProvider } from "eve/sandbox/provider";

const refuse = () =>
  Promise.reject(
    new Error("The maintenance bot has no sandbox; its tools run without one")
  );

// The jobs and the agent's tool call the GitHub API and the npm registry
// from the app runtime, and the agent has none of eve's sandbox tools
// (`defaultTools: false`), so nothing needs a sandbox. eve's default one
// would still have every Vercel build prepare a Vercel Sandbox snapshot. This
// provider prepares nothing and refuses to start, so no sandbox is created.
const NoSandbox = defineSandboxProvider({
  environment: () => ({
    prepare: () => Promise.resolve({}),
    resume: refuse,
    start: refuse,
  }),
  name: "none",
});

export const environment = NoSandbox.environment();

export default defineSandbox(() => environment.open());
