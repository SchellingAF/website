// Two one-click buttons that let another key into a space count only a press made on
// purpose, as Allow, Join, Take over and Accept do: "Send an invite link" in a
// conversation, which sends a link to whoever is in it, and "Approve" on a space's join
// requests. Another site can send a signed-in browser to either page and steer a double
// click onto the button; a stranger who asked to join, or who named the space in a
// message request, is exactly who would. Each is sent switched off for src/allow.js to
// switch on, the page runs that script once, and its content policy admits it.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, json, refusal } from "./lib/service.ts";
import { tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const STRANGER = "c3d4".repeat(16);
const CONVERSATION = "0199eeee-0000-7000-8000-00000000c0c0";
const MESSAGE = "0199eeee-0000-7000-8000-000000000001";
const REQUEST = "0199eeee-0000-7000-8000-000000000009";

const profile = {
  name: "crew", space_id: "0199eeee-0000-7000-8000-00000000c0de", title: "Crew", description: "A private space.",
  visibility: "private", join_policy: "request", status: "active", signed_only: false, replaced_by: null, categories: ["general"],
  owner: OWNER, contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-18T09:00:00.000Z",
  access: { role: "owner", tags: [], read: true, post: true },
};

const { fake, handleRequest } = await site((call) => {
  const p = call.url.pathname;
  if (p === "/v1/capabilities") return json(CAPABILITIES);
  if (p === "/v1/conversations") return json({ items: [], unread_conversations: 0, requests_waiting: 1 });
  // A stranger's first message, a message request waiting for the owner, naming the space.
  if (p === `/v1/conversations/${CONVERSATION}`) {
    return json({
      conversation_id: CONVERSATION, kind: "pair", started_by: STRANGER, created_at: "2026-09-18T09:00:00.000Z", state: "requested",
      members: [{ peer_id: OWNER, state: "requested" }, { peer_id: STRANGER, state: "accepted" }], head_seq: "1", read_seq: "0",
      cleared_through: "0", unread: true, last_message_at: "2026-09-18T09:00:00.000Z",
    });
  }
  if (p === `/v1/conversations/${CONVERSATION}/messages` && call.method === "GET") {
    return json({
      items: [{ message_id: MESSAGE, conversation_id: CONVERSATION, seq: "1", author: STRANGER, sent_at: "2026-09-18T09:00:00.000Z", reply_to: null, about: "crew", body: "May I join crew?" }],
      next_after: null, has_more: false,
    });
  }
  if (p === "/v1/spaces/crew") return json(profile);
  if (p === "/v1/spaces/crew/requests") {
    if (call.url.searchParams.get("state") !== "pending") return json({ items: [], next_after: null, has_more: false, pending_count: 1 });
    return json({
      items: [{ request_id: REQUEST, requester: STRANGER, message: "Let me in.", state: "pending", created_at: "2026-09-18T09:00:00.000Z", expires_at: "2026-09-25T09:00:00.000Z", decided_at: null, decided_by: null, decided_role: null }],
      next_after: null, has_more: false, pending_count: 1,
    });
  }
  if (p === `/v1/requests/${REQUEST}/approve` && call.method === "POST") return json({ state: "approved", role: "writer" });
  return refusal(404, "NOT_ANSWERED");
});

const { cookie, csrf } = await signedIn(OWNER, "owner-token", "192.0.2.230");

async function get(path: string) {
  const res = await handleRequest(new Request(`${SITE}${path}`, { headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" } }), env);
  return { res, text: await res.text() };
}

/** The button of the form that posts to `action`, as its tag reads. */
function buttonOf(html: string, action: string): string {
  const at = html.indexOf(`action="${action}"`);
  assert.ok(at >= 0, `no form posts to ${action}`);
  const button = /<button[^>]*>/.exec(html.slice(at))?.[0];
  assert.ok(button, `the form posting to ${action} has no button`);
  return button;
}

const GUARD = '<script src="/allow.js"></script>';

describe("a button that lets another key in counts only a press made on purpose", () => {
  test("Send an invite link, in a stranger's message request that names a space the key runs", async () => {
    const { res, text } = await get(`/me/messages/${CONVERSATION}`);
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.ok(text.includes("Send an invite link for crew"), "the page offers the invite link");
    assert.equal(buttonOf(text, `/me/messages/${CONVERSATION}/invite`), '<button type="submit" data-guard disabled>');
    assert.equal(text.split(GUARD).length - 1, 1, "the guard's script, once");
    assert.match(res.headers.get("Content-Security-Policy") ?? "", /script-src 'self'/, "the page's policy admits the guard's script");
    // The buttons that let nobody in are left as they were.
    assert.equal(buttonOf(text, `/me/messages/${CONVERSATION}/decline`), '<button type="submit">');
  });

  test("Approve, on a space's join requests", async () => {
    const { res, text } = await get("/me/spaces/crew/requests");
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.equal(buttonOf(text, `/me/requests/${REQUEST}/approve`), '<button type="submit" data-guard disabled>');
    assert.equal(buttonOf(text, `/me/requests/${REQUEST}/decline`), '<button type="submit">', "Decline needs no guard");
    assert.equal(text.split(GUARD).length - 1, 1, "the guard's script, once");
    assert.match(res.headers.get("Content-Security-Policy") ?? "", /script-src 'self'/, "the page's policy admits the guard's script");
    // The form still carries the role and the tags, and its note says why a press was not counted.
    const form = text.slice(text.indexOf(`action="/me/requests/${REQUEST}/approve"`));
    const fields = tags(form.slice(0, form.indexOf("</form>"))).filter((t) => ["select", "input"].includes(t.name))
      .flatMap((t) => t.attributes.filter(([n]) => n === "name").map(([, v]) => v));
    assert.deepEqual(fields, ["csrf", "space", "role", "tags"]);
    assert.ok(form.slice(0, form.indexOf("</form>")).includes("data-guard-note"));
  });

  test("a requests page with nothing waiting carries no guard's script", async () => {
    const { text } = await get("/me/spaces/crew/requests?state=approved");
    assert.ok(!text.includes(GUARD));
  });

  test("a press that reaches the site approves as before", async () => {
    const before = fake.calls.length;
    const res = await handleRequest(new Request(`${SITE}/me/requests/${REQUEST}/approve`, {
      method: "POST",
      headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, space: "crew", role: "writer", tags: "" }).toString(),
    }), env);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), "/me/spaces/crew/requests?notice=approved");
    const sent = fake.calls.slice(before).filter((c) => c.method === "POST");
    assert.deepEqual(sent.map((c) => [c.url.pathname, JSON.parse(c.body ?? "{}")]), [[`/v1/requests/${REQUEST}/approve`, { role: "writer" }]]);
  });
});
