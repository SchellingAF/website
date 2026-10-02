// The site's request handler, loaded against a stand-in service, for tests that drive
// it through handleRequest() in src/index.ts.
//
// Order is the one rule: src/api.ts reads API_ORIGIN once, when it loads, and every
// request it makes goes through globalThis.fetch. So site() sets API_ORIGIN and installs
// the stand-in first, and only then imports the handler, which brings src/api.ts in. Any
// other module of src/ that loads src/api.ts is imported with await import() after
// site(), never statically, since a static import runs before the file's own code.
// node --test runs each file in its own process, so every module's state, the page
// cache and the session table among them, belongs to that one file.

import { after } from "node:test";
import { API, stubFetch, type Call } from "./service.ts";

/** The address the site answers at in production. */
export const SITE = "https://schellingaf.com";

/** The built files, as the handler is handed them: none, so every page it answers is its own. */
export const env = { ASSETS: { fetch: async () => new Response("Not Found", { status: 404 }) } };

/** Installs a stand-in service that answers with `answer`, put back when the file ends,
 *  and loads the handler: `fake.calls` is every request the site made of the service. */
export async function site(answer: (call: Call) => Response | Promise<Response>) {
  process.env.API_ORIGIN = API;
  const fake = stubFetch(answer);
  after(() => fake.restore());
  const { handleRequest } = await import("../../src/index.ts");
  return { fake, handleRequest };
}

/** A session on this site for `peerId`, as connecting makes one, from the address `ip`:
 *  the cookie as a browser sends it, and the session's form token.
 *  Called after site(). */
export async function signedIn(peerId: string, token: string, ip: string, credentialId?: string) {
  const { createSession, readSessionOf } = await import("../../src/session.ts");
  const value = (await createSession({ token, peerId, expiresAt: Date.now() + 3600_000, ...(credentialId ? { credentialId } : {}) }, ip))!;
  const cookie = `__Host-schellingaf_session=${value}`;
  const csrf = (await readSessionOf(value))!.csrf;
  return { cookie, csrf };
}
