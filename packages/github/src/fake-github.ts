// A stand-in for the GitHub API in tests: it answers the routes it is given
// and 404 for the rest, and records every request.
import { vi } from "vitest";

export type Json =
  | boolean
  | number
  | string
  | null
  | readonly Json[]
  | { readonly [key: string]: Json | undefined };

export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: Json | undefined;
}

class DynamicRoute {
  readonly respond: (request: FakeRequest) => Response | Json;

  constructor(respond: (request: FakeRequest) => Response | Json) {
    this.respond = respond;
  }
}

/** A route that answers each request as `respond` decides. */
export const dynamic = (respond: (request: FakeRequest) => Response | Json) =>
  new DynamicRoute(respond);

/** A response, a JSON body, or a {@link dynamic} route. */
export type FakeRoute = Response | Json | DynamicRoute;

// Octokit escapes the slashes in a parameter such as `heads/main`.
const routeOf = ({ method, url }: FakeRequest) =>
  `${method} ${decodeURIComponent(url.pathname)}`;

const respond = (route: FakeRoute | undefined, request: FakeRequest) => {
  if (route === undefined) {
    return Response.json({ message: "Not Found" }, { status: 404 });
  }
  const result = route instanceof DynamicRoute ? route.respond(request) : route;
  return result instanceof Response ? result : Response.json(result);
};

export const fakeGitHub = (routes: Readonly<Record<string, FakeRoute>>) => {
  const requests: FakeRequest[] = [];
  const fetchImpl = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(String(input));
    const request: FakeRequest = {
      // Octokit sends JSON bodies as strings.
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: new Headers(init?.headers),
      method: init?.method ?? "GET",
      url,
    };
    requests.push(request);

    const response = respond(routes[routeOf(request)], request);
    // A fetched response knows its URL; the pagination plugin reads it.
    Object.defineProperty(response, "url", { value: url.href });
    return Promise.resolve(response);
  });

  return {
    fetch: fetchImpl,
    requests,
    /** `METHOD /path` of every request, in order. */
    get routes() {
      return requests.map(routeOf);
    },
  };
};
