import {
  REGENERATION_CONFIG_JSON_SCHEMA,
  REGENERATION_CONFIG_SCHEMA_URL,
} from "@publira/maintenance-policies";
import { defineChannel, GET } from "eve/channels";

const SCHEMAS = new Map([
  [
    new URL(REGENERATION_CONFIG_SCHEMA_URL).pathname,
    REGENERATION_CONFIG_JSON_SCHEMA,
  ],
]);

// The JSON Schemas of the files under `.chachamaru/` that the bot reads, for
// editors in the repositories that write them. A schema is a public document
// and the route reaches neither the agent nor GitHub, so it takes no
// authenticator. The file name is a parameter because eve names a route's
// module after its path, and the build parses a module ending in `.json` as
// JSON.
export default defineChannel({
  routes: [
    GET("/schemas/:name/:file", (request) => {
      const schema = SCHEMAS.get(new URL(request.url).pathname);
      return Promise.resolve(
        schema === undefined
          ? new Response("Not Found", { status: 404 })
          : Response.json(schema, {
              headers: { "cache-control": "public, max-age=3600" },
            })
      );
    }),
  ],
});
