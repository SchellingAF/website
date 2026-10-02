// A key's own join request, while it waits, is offered back on the space's signed-in page
// from what the service's profile says, access.pending_request, never from the
// session's memory: a person who connects again, or asked from another
// device, can still withdraw it. The id goes into the address the button posts to, so
// only an id in the service's own shape gets a button.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { service, type World } from "./lib/service.ts";
import { hostileWorld, SECOND } from "./lib/world.ts";
import { htmlProblems } from "./lib/documents.ts";
import { SITE, env, site } from "./lib/site.ts";

const REQUEST = "0199eeee-0000-7000-8000-000000000001";
const OWNER = "a1b2".repeat(16);

const door = (name: string, pending: unknown) => ({
  name, space_id: "0199eeee-0000-7000-8000-00000000aaaa", title: "A door", description: "Asked into.",
  visibility: "private", join_policy: "request", status: "active", signed_only: false, replaced_by: null, oracle: false,
  categories: ["general"], owner: OWNER, contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-18T09:00:00.000Z",
  access: { role: null, tags: [], read: false, post: false, pending_request: pending },
});
const world: World = {
  ...hostileWorld(),
  spaces: [
    door("waiting-door", { request_id: REQUEST, expires_at: "2026-10-18T09:00:00.000Z" }),
    door("open-door", null),
    door("hostile-door", { request_id: "../../me/tokens/revoke-all", expires_at: "<script>alert(3)</script>" }),
  ],
};
const { handleRequest } = await site(service(world));
const { createSession } = await import("../src/session.ts");

/** A new connection of the same key: nothing in it remembers asking. */
async function connect() {
  const value = (await createSession({ token: "join-token", peerId: SECOND, expiresAt: Date.now() + 3600_000 }, "192.0.2.94"))!;
  return `__Host-schellingaf_session=${value}`;
}
async function page(path: string, cookie: string) {
  const res = await handleRequest(new Request(`${SITE}${path}`, { headers: { Cookie: cookie } }), env);
  return { res, text: await res.text() };
}

describe("a key's own join request, while it waits", () => {
  test("is offered back to a connection that never asked, with Withdraw and when it lapses, and no second ask", async () => {
    const { res, text } = await page("/me/spaces/waiting-door", await connect());
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.match(text, /Your join request is waiting/);
    assert.match(text, new RegExp(`action="/me/requests/${REQUEST}/withdraw"`));
    assert.match(text, /If nobody decides it, it lapses 18 Oct 2026/);
    assert.doesNotMatch(text, /Ask to join<\/button>/);
    assert.deepEqual(htmlProblems(text), []);
  });

  test("none waiting offers to ask", async () => {
    const { text } = await page("/me/spaces/open-door", await connect());
    assert.doesNotMatch(text, /Your join request is waiting/);
    assert.match(text, /Ask to join<\/button>/);
  });

  test("an id in no shape the service writes gets no button, and its time no place on the page", async () => {
    const { text } = await page("/me/spaces/hostile-door", await connect());
    assert.doesNotMatch(text, /Your join request is waiting/);
    assert.ok(!text.includes("revoke-all") && !text.includes("<script>alert(3)"));
    assert.deepEqual(htmlProblems(text), []);
  });
});
