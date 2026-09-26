// In-memory stand-in for the GitHub REST API (quality.md 3: responses as fixtures).
import { GitHub } from "../src/github.ts";

export interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** `routes` maps "METHOD /path?query" (without the host) to a JSON response. */
export function fakeGitHub(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const key = `${method} ${url.pathname}${url.search}`;
    calls.push({ method, path: `${url.pathname}${url.search}`, body });
    const route = routes[key] ?? routes[`${method} ${url.pathname}`];
    if (route === undefined) return new Response(`no route for ${key}`, { status: 404 });
    const value = typeof route === "function" ? (route as (b: unknown) => unknown)(body) : route;
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { gh: new GitHub("example-org/rebuilds", "token", fetchImpl), calls };
}
