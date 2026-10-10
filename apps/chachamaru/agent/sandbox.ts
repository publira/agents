import { defineSandbox } from "eve/sandbox";
import { defineSandboxProvider } from "eve/sandbox/provider";

const refuse = () =>
  Promise.reject(
    new Error("Chachamaru has no sandbox; its tools run without one")
  );

// The agent has none of eve's sandbox tools (`defaultTools: false`), so no
// session needs a sandbox. eve's default one would still have every Vercel
// build prepare a Vercel Sandbox snapshot. This provider prepares nothing and
// refuses to start, so eve creates no sandbox.
//
// The skills update job does run in a Vercel Sandbox, but not in this one:
// eve opens a sandbox only for an agent session, and a schedule handler that
// calls a job directly starts none. The job creates its own through
// `src/sandbox-runner.ts`.
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
