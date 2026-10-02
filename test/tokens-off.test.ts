// With passkeys switched off in the product, /me/tokens/new offers no form and asks the
// product for no challenge. A file of its own, because the site holds the capability
// document for an hour, so one process sees one answer to "are passkeys on".

import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, json, service } from "./lib/service.ts";
import { hostileWorld, SECOND } from "./lib/world.ts";
import { site } from "./lib/site.ts";

const base = service(hostileWorld());
const { fake, handleRequest } = await site((call) => {
  if (call.url.pathname === "/v1/capabilities") return json({ ...CAPABILITIES, protocol: { passkeys: { status: "unavailable" } } });
  return base(call);
});
const { createSession } = await import("../src/session.ts");

test("with passkeys off, the new-token page offers no form and asks for no challenge", async () => {
  const value = (await createSession({ token: "off-token", peerId: SECOND, expiresAt: Date.now() + 3600_000 }, "192.0.2.99"))!;
  const res = await handleRequest(new Request("https://schellingaf.com/me/tokens/new", { headers: { Cookie: `__Host-schellingaf_session=${value}` } }),
    { ASSETS: { fetch: async () => new Response("Not Found", { status: 404 }) } });
  const text = await res.text();
  assert.doesNotMatch(text, /data-new-token/);
  assert.match(text, /not switched on/);
  assert.equal(fake.calls.filter((c) => c.url.pathname === "/v1/passkeys/challenge").length, 0);
});
