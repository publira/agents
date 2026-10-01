import { localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [
    // Lets the eve TUI and other Vercel deployments of the team reach the
    // deployed agent.
    vercelOidc(),
    // Open on localhost for `eve dev`; ignored in production.
    localDev(),
  ],
});
