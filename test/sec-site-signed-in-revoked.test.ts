// A session on this site ends at the first page that finds the service refusing its
// token, whichever page that is. A token can be revoked, or its key blocked, outside this
// site: from the connector, the API, or Access tokens in another browser. The session
// behind it holds the secret that unlocks the person's encryption key in this browser
// (Session.wrap in src/session.ts), so a page drawn for a session whose token is dead must
// not hand it out. Every signed-in page reads the conversation counts for its bar; that
// read is where the refusal shows, on pages that read nothing else first, such as the form
// that creates a space.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, json, refusal } from "./lib/service.ts";
import { SITE, env, site } from "./lib/site.ts";

const LIVE = "a1b2".repeat(16);
const DEAD = "c3d4".repeat(16);

const { fake, handleRequest } = await site((call) => {
  const p = call.url.pathname;
  if (p === "/v1/capabilities") return json(CAPABILITIES);
  if (p === "/v1/categories") return json({ categories: [] });
  // The dead token is refused on every call, as the service refuses a revoked one.
  if (call.headers.get("authorization") === "Bearer dead-token") return refusal(401, "TOKEN_REVOKED");
  // A token revoked between the bar's read and the page's own: the space's read is refused.
  if (call.headers.get("authorization") === "Bearer dying-token" && p.startsWith("/v1/spaces/")) return refusal(401, "TOKEN_REVOKED");
  // Answers about the service, not the token, to the bar's read: none of them ends a session.
  if (p === "/v1/conversations") {
    const token = call.headers.get("authorization");
    if (token === "Bearer slow-token") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (token === "Bearer busy-token") return refusal(429, "RATE_LIMITED");
    if (token === "Bearer denied-token") return refusal(403, "READ_DENIED");
    if (token === "Bearer down-token") return refusal(503, "UNAVAILABLE");
  }
  if (p === "/v1/conversations") return json({ items: [], unread_conversations: 0, requests_waiting: 0 });
  return refusal(404, "NOT_ANSWERED");
});

const { createSession, readSessionOf } = await import("../src/session.ts");

async function session(peerId: string, token: string, ip: string) {
  const value = (await createSession({ token, peerId, expiresAt: Date.now() + 3600_000 }, ip))!;
  const s = (await readSessionOf(value))!;
  return { value, cookie: `__Host-schellingaf_session=${value}`, csrf: s.csrf, wrap: s.wrap };
}

async function get(cookie: string, path: string) {
  const res = await handleRequest(new Request(`${SITE}${path}`, { headers: { Cookie: cookie } }), env);
  return { res, text: await res.text() };
}

async function post(me: { cookie: string; csrf: string }, path: string, fields: Record<string, string>) {
  const res = await handleRequest(new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { Origin: SITE, Cookie: me.cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: me.csrf, ...fields }).toString(),
  }), env);
  return { res, text: await res.text() };
}

/** Ended: sent to connect again, coming back to `next` afterwards when it is given, the
 *  cookie and the browser's storage cleared, the secret nowhere on the answer, and the
 *  session gone from this site. */
async function ended(me: { value: string; wrap: string }, r: { res: Response; text: string }, next?: string) {
  assert.equal(r.res.status, 303, r.text.slice(0, 300));
  assert.equal(r.res.headers.get("Location"), next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in");
  assert.match(r.res.headers.get("Set-Cookie") ?? "", /^__Host-schellingaf_session=; .*Max-Age=0/);
  assert.equal(r.res.headers.get("Clear-Site-Data"), '"storage"');
  assert.ok(!r.text.includes(me.wrap), "the session's secret went out with a dead token");
  assert.equal(await readSessionOf(me.value), null, "the session outlived its token");
}

/** A space's form, as the site refuses it before sending anything: a way in that only a
 *  public work space takes, chosen for a private space. */
const REFUSED_SPACE = { name: "new-notes", title: "Notes", description: "", visibility: "private", join_policy: "open", oracle: "0", category_1: "" };

describe("a session whose token the service refuses", () => {
  test("a live session is drawn the form to create a space, with its secret for the browser, as before", async () => {
    const me = await session(LIVE, "live-token", "192.0.2.240");
    const page = await get(me.cookie, "/me/new");
    assert.equal(page.res.status, 200);
    assert.ok(page.text.includes(`data-wrap="${me.wrap}"`));
    const again = await post(me, "/me/new", REFUSED_SPACE);
    assert.equal(again.res.status, 400, "a form the site refuses is shown again");
    assert.ok(again.text.includes(`data-wrap="${me.wrap}"`));
    assert.notEqual(await readSessionOf(me.value), null);
  });

  test("ends at a page that reads nothing else, and hands out nothing", async () => {
    const me = await session(DEAD, "dead-token", "192.0.2.241");
    await ended(me, await get(me.cookie, "/me/new"), "/me/new");
  });

  test("ends at a form the site refuses before sending it, and hands out nothing", async () => {
    const me = await session(DEAD, "dead-token", "192.0.2.242");
    const before = fake.calls.length;
    await ended(me, await post(me, "/me/new", REFUSED_SPACE));
    assert.ok(!fake.calls.slice(before).some((c) => c.method === "POST"), "the refused form was sent");
  });

  test("ends at a space's page when its token is refused there, after the bar's read", async () => {
    const me = await session(DEAD, "dying-token", "192.0.2.244");
    await ended(me, await get(me.cookie, "/me/spaces/crew"), "/me/spaces/crew");
  });

  test("comes back after connecting again to the page it was opened at, an app's request or an invite link above all", async () => {
    const pages = [
      "/me/connect?request=0199eeee-0000-7000-8000-00000000000a",
      `/me/join/crew/schellingaf_inv_${"ab".repeat(16)}`,
      "/me/tokens/new",
      "/me/messages?filter=requests",
    ];
    for (const [i, path] of pages.entries()) {
      const me = await session(DEAD, "dead-token", `192.0.2.${230 + i}`);
      await ended(me, await get(me.cookie, path), path);
    }
    // The key's own page is where connecting goes anyway, as for a visitor with no session.
    const me = await session(DEAD, "dead-token", "192.0.2.235");
    await ended(me, await get(me.cookie, "/me"));
  });

  test("a service that is slow, busy, down or refusing one read ends nobody's session", async () => {
    for (const [i, token] of ["slow-token", "busy-token", "down-token", "denied-token"].entries()) {
      const me = await session(LIVE, token, `192.0.2.${245 + i}`);
      const page = await get(me.cookie, "/me/new");
      assert.equal(page.res.status, 200, `${token}: ${page.text.slice(0, 300)}`);
      assert.ok(page.text.includes(`data-wrap="${me.wrap}"`), token);
      assert.equal(page.res.headers.get("Set-Cookie"), null, token);
      assert.notEqual(await readSessionOf(me.value), null, `${token} ended the session`);
    }
  });
});
