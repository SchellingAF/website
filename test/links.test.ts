// Invite links, the coordinator and handing over, on the signed-in pages: the links page
// for every member, making a link and a hand-over link and showing each once, revoke and
// remove, an offer of a role on the space's page and in the mailbox, the members and join
// requests pages as a coordinator reads them, a link sent in a conversation, and what a
// link gives, looked at with a person's own key.
//
// Driven through handleRequest() with a stand-in product that answers each key by its
// own access token, and records every call, so a refusal is proved to have sent the
// product nothing and a write is proved to have sent exactly what the form said.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as H from "./fixtures/hostile.ts";
import { CAPABILITIES, json, refusal, type Call } from "./lib/service.ts";
import { decode, signedInProblems, tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const ADMIN = "b2c3".repeat(16);
const COORD = "c3d4".repeat(16);
const WRITER = "d4e5".repeat(16);
const STRANGER = "e5f6".repeat(16);
const OTHER = (n: number) => n.toString(16).padStart(64, "9");
const SPACE_ID = "0199eeee-0000-7000-8000-00000000c0de";
const ID = (n: number) => `0199eeee-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const CODE = (c: string) => `schellingaf_inv_${c.repeat(32)}`;
const HAND = (c: string) => `schellingaf_hand_${c.repeat(32)}`;
const LINK = (code: string) => `${SITE}/join/crew/${code}`;

/** Which key each access token is, and its role in the space crew. */
const KEYS: Record<string, { peer: string; role: string | null }> = {
  "owner-token": { peer: OWNER, role: "owner" },
  "admin-token": { peer: ADMIN, role: "admin" },
  "coord-token": { peer: COORD, role: "coordinator" },
  "writer-token": { peer: WRITER, role: "writer" },
  "stranger-token": { peer: STRANGER, role: null },
};
const caller = (call: Call) => KEYS[(call.headers.get("Authorization") ?? "").replace(/^Bearer /, "")] ?? { peer: "", role: null };

const profile = (role: string | null) => ({
  name: "crew", space_id: SPACE_ID, title: `${H.SPACE_TITLE} ${H.ATTRIBUTE_BREAKOUT}`, description: H.SPACE_DESCRIPTION,
  visibility: "private", join_policy: "invite", status: "active", signed_only: false, replaced_by: null, categories: ["general"],
  owner: OWNER, contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-18T09:00:00.000Z",
  access: { role, tags: [], read: role !== null, post: role !== null && role !== "reader" },
});

/** The links of crew, as the service lists them: one of every kind, a dead one among them,
 *  and a label and tags written to break the page. */
const LINKS = [
  { invite_id: ID(1), kind: "invite", role: "writer", tags: ["build<b>er</b>"], label: `for the build ${H.XSS}`, max_uses: null, uses: 3,
    created_by: COORD, expires_at: null, active: true },
  { invite_id: ID(2), kind: "hand_over", role: "owner", tags: [], label: null, max_uses: 1, uses: 0,
    created_by: OWNER, expires_at: "2026-09-25T09:00:00.000Z", active: true },
  { invite_id: ID(3), kind: "offer", role: "admin", tags: [], label: null, max_uses: 1, uses: 0, created_by: ADMIN, to: STRANGER,
    expires_at: "2026-09-25T09:00:00.000Z", active: true },
  { invite_id: ID(4), kind: "invite", role: "reader", tags: [], label: "spent", max_uses: 2, uses: 2,
    created_by: OWNER, expires_at: "2026-09-25T09:00:00.000Z", active: false, inactive_reason: "exhausted" },
  { invite_id: ID(5), kind: "invite", role: "writer", tags: [], label: null, max_uses: 10, uses: 0,
    created_by: COORD, expires_at: "2026-09-19T09:00:00.000Z", active: false, inactive_reason: "creator_no_longer_governs" },
  // A hand-over whose role changed after it was made: it passes the role as it was, or nothing.
  { invite_id: ID(6), kind: "hand_over", role: "admin", tags: [], label: null, max_uses: 1, uses: 0,
    created_by: ADMIN, expires_at: null, active: false, inactive_reason: "creator_no_longer_governs" },
];

/** What POST /v1/invites/look answers for each code. */
const LOOKS: Record<string, unknown> = {
  [CODE("1")]: { name: "crew", kind: "invite", role: "writer", tags: ["builder"], max_uses: 10, uses: 3, expires_at: "2026-09-25T09:00:00.000Z", state: "live", made_by: null },
  [CODE("2")]: { name: "crew", kind: "invite", role: "reader", tags: [], max_uses: null, uses: 7, expires_at: null, state: "live", made_by: null },
  [CODE("3")]: { name: "crew", kind: "invite", role: "writer", tags: [], max_uses: 10, uses: 1, expires_at: null, state: "revoked", made_by: null },
  [CODE("4")]: { name: "crew", kind: "invite", role: "writer", tags: [], max_uses: 10, uses: 1, expires_at: "2026-09-10T09:00:00.000Z", state: "expired", made_by: null },
  [CODE("5")]: { name: "crew", kind: "invite", role: "writer", tags: [], max_uses: 2, uses: 2, expires_at: null, state: "exhausted", made_by: null },
  [HAND("a")]: { name: "crew", kind: "hand_over", role: "owner", tags: [], max_uses: 1, uses: 0, expires_at: null, state: "live", made_by: OWNER },
  [HAND("b")]: { name: "crew", kind: "hand_over", role: "writer", tags: [], max_uses: 1, uses: 0, expires_at: null, state: "live", made_by: WRITER },
  [HAND("d")]: { name: "crew", kind: "hand_over", role: "admin", tags: [], max_uses: 1, uses: 0, expires_at: null, state: "creator_no_longer_governs", made_by: ADMIN },
  // A role in no shape the service writes: the page says the service did not say.
  [CODE("6")]: { name: "crew", kind: "invite", role: H.XSS, tags: [], max_uses: 10, uses: 0, expires_at: null, state: "live", made_by: null },
};

/** Conversations: two keys, a group of four of whom one left, and one whose messages fail. */
const CONVERSATIONS: Record<string, { kind: string; members: { peer_id: string; state: string }[] }> = {
  [ID(100)]: { kind: "pair", members: [{ peer_id: OWNER, state: "accepted" }, { peer_id: STRANGER, state: "accepted" }] },
  [ID(101)]: { kind: "group", members: [OWNER, OTHER(1), OTHER(2), OTHER(3)].map((peer_id, i) => ({ peer_id, state: i === 3 ? "left" : "accepted" })) },
  [ID(102)]: { kind: "pair", members: [{ peer_id: OWNER, state: "accepted" }, { peer_id: OTHER(4), state: "accepted" }] },
};

let removals = 0;

const { fake, handleRequest } = await site((call) => {
  const path = call.url.pathname;
  const me = caller(call);
  const body = call.body ? JSON.parse(call.body) : {};
  if (path === "/v1/capabilities") {
    return json({ ...CAPABILITIES, limits: { ...CAPABILITIES.limits, live_links_per_maker: 1000, coordinators_per_space: 5000,
      waiting_proposals_per_key_per_space: 3, waiting_proposals_per_space: 100, watched_documents_per_key: 200, watchers_per_document: 10000 } });
  }
  if (path === "/v1/conversations" && call.method === "GET") return json({ items: [], unread_conversations: 0, requests_waiting: 0 });
  if (path === "/v1/categories") return json({ categories: [] });
  if (path === "/v1/spaces/crew" && call.method === "GET") return json(profile(me.role));
  if (path === "/v1/spaces/crew/posts" && call.method === "GET") {
    return me.role ? json({ items: [], next_after: null, has_more: false, head_seq: "0" }) : refusal(403, "READ_DENIED");
  }
  if (path === "/v1/spaces/crew/checkpoints") return json({ items: [] });
  if (path === "/v1/spaces/crew/members") {
    return json({
      owner: OWNER,
      items: [
        { peer_id: ADMIN, role: "admin", tags: [], via: "grant", granted_by: OWNER, granted_at: "2026-09-18T09:00:00.000Z", managed_by: OWNER, invite_id: null },
        { peer_id: COORD, role: "coordinator", tags: [], via: "grant", granted_by: ADMIN, granted_at: "2026-09-18T09:00:00.000Z", managed_by: ADMIN, invite_id: null },
        { peer_id: WRITER, role: "writer", tags: ["builder"], via: "invite", granted_by: COORD, granted_at: "2026-09-18T09:00:00.000Z", managed_by: COORD, invite_id: ID(1) },
        // Once nobody sits in the seat that last decided a membership, nobody manages it.
        { peer_id: OTHER(9), role: "reader", tags: [], via: "request", granted_by: ADMIN, granted_at: "2026-09-18T09:00:00.000Z", managed_by: null, invite_id: null },
      ],
      next_after: OTHER(9), has_more: true,
    });
  }
  if (path === "/v1/spaces/crew/requests") {
    return json({
      items: [{ request_id: ID(50), requester: STRANGER, message: `let me in ${H.XSS}`, state: "pending", created_at: "2026-09-18T09:00:00.000Z",
        expires_at: "2026-09-25T09:00:00.000Z", decided_at: null, decided_by: null, decided_role: null }],
      next_after: null, has_more: false, pending_count: 3,
    });
  }
  if (path === "/v1/spaces/crew/invites" && call.method === "GET") {
    if (me.role === null) return refusal(403, "CONTROL_DENIED");
    const governs = me.role === "owner" || me.role === "admin";
    const items = LINKS.filter((l) => governs || l.created_by === me.peer).filter((l) => call.url.searchParams.get("live") !== "true" || l.active);
    return json({ items, next_after: ID(5), has_more: governs });
  }
  if (path === "/v1/spaces/crew/invites" && call.method === "POST") {
    const code = body.label === "bad-answer" ? "schellingaf_inv_NOT-A-CODE" : CODE("7");
    return json({
      invite_id: ID(60), role: body.role, tags: body.tags ?? [], max_uses: body.max_uses,
      expires_at: body.expires_in_seconds === null ? null : "2026-09-21T09:00:00.000Z",
      label: body.label ?? null, code,
      // The service's own link is never what the site shows or sends: here it names
      // another host, or no link at all, as a service that names no website does.
      link: body.label === "odd-link" || body.label === "sent in a group" ? `https://elsewhere.example/join/crew/${code}`
        : body.label === "no-link" ? null : LINK(code),
      notice: "Whoever holds this link or its code can use it until it expires, runs out or is revoked.",
    }, 201);
  }
  if (path === "/v1/spaces/crew/hand-over" && call.method === "POST") {
    // A key that shares nothing with the maker is not reached, and the refusal does not say why.
    if (body.to === OTHER(5)) return refusal(403, "HAND_OVER_UNREACHABLE");
    if (body.to) return json({ invite_id: ID(61), offer_id: ID(61), role: me.role, max_uses: 1, expires_at: null }, 201);
    return json({ invite_id: ID(62), role: me.role, max_uses: 1, expires_at: body.expires_in_seconds === null ? null : "2026-09-25T09:00:00.000Z",
      code: HAND("c"), link: LINK(HAND("c")) }, 201);
  }
  const invite = path.match(/^\/v1\/invites\/([0-9a-f-]{36})(\/remove)?$/);
  if (invite && call.method === "DELETE") return json({ invite_id: invite[1], name: "crew", changed: true });
  if (invite?.[2] && call.method === "POST") {
    // The service counts what remains up to ten thousand, and says ten thousand past it.
    if (invite[1] === ID(9)) return json({ invite_id: invite[1], name: "crew", removed: 500, remaining: 10000 });
    removals += 1;
    return json(removals % 2 === 1 ? { invite_id: invite[1], name: "crew", removed: 500, remaining: 20 } : { invite_id: invite[1], name: "crew", removed: 20, remaining: 0 });
  }
  if (path === "/v1/invites/look" && call.method === "POST") {
    // During a restore the service looks at no link.
    if (body.code === CODE("9")) return refusal(503, "SERVICE_READ_ONLY");
    return Object.hasOwn(LOOKS, body.code) ? json(LOOKS[body.code]) : refusal(404, "INVITE_INVALID");
  }
  const offer = path.match(/^\/v1\/hand-overs\/([0-9a-f-]{36})\/(accept|decline)$/);
  if (offer && call.method === "POST") {
    if (offer[2] === "decline") return json({ invite_id: offer[1], name: "crew", changed: true });
    return json({ state: "member", name: "crew", role: "admin", tags: [], changed: offer[1] !== ID(71), revision: "9" });
  }
  if (path === "/v1/mailbox") {
    const offerItem = (seq: string, id: string, space: string, state: string) =>
      ({ mailbox_seq: seq, reason: "hand_over", offer: { offer_id: id, space, from: OWNER, role: "owner", expires_at: "2026-09-25T09:00:00.000Z", state } });
    return json({
      items: [
        offerItem("1", ID(70), "crew", "waiting"),
        offerItem("2", ID(72), "elsewhere", "waiting"),
        offerItem("3", ID(73), "crew", "accepted"),
      ],
      next_after: "3", has_more: false, head_seq: "3",
    });
  }
  const conversation = path.match(/^\/v1\/conversations\/([0-9a-f-]{36})(\/messages)?$/);
  if (conversation && Object.hasOwn(CONVERSATIONS, conversation[1]!)) {
    const c = CONVERSATIONS[conversation[1]!]!;
    if (!conversation[2]) {
      return json({ conversation_id: conversation[1], kind: c.kind, started_by: OWNER, created_at: "2026-09-18T09:00:00.000Z", state: "accepted",
        members: c.members, head_seq: "1", read_seq: "1", cleared_through: "0", unread: false, last_message_at: "2026-09-18T09:00:00.000Z" });
    }
    if (call.method === "GET") {
      return json({ items: [{ message_id: ID(90), conversation_id: conversation[1], seq: "1", author: c.members[1]!.peer_id, sent_at: "2026-09-18T09:00:00.000Z",
        about: "crew", body: "May I join crew?" }], next_after: null, has_more: false });
    }
    return conversation[1] === ID(102) ? refusal(403, "MESSAGES_NOT_ACCEPTED") : json({ message_id: ID(91), seq: "2" }, 201);
  }
  return refusal(404, "NOT_ANSWERED");
});

/** A connected browser for each key: its cookie and its form token. */
const people: Record<string, { cookie: string; csrf: string }> = {};
let address = 100;
for (const [token, { peer }] of Object.entries(KEYS)) {
  const { cookie, csrf } = await signedIn(peer, token, `192.0.2.${address++}`);
  people[peer] = { cookie, csrf };
}

/** A page as a browser asks for it from a page of this site, which it says it is. */
async function get(as: string, path: string) {
  const before = fake.calls.length;
  const res = await handleRequest(new Request(`${SITE}${path}`, { headers: { Cookie: people[as]!.cookie, "Sec-Fetch-Site": "same-origin" } }), env);
  return { res, status: res.status, text: await res.text(), asked: fake.calls.slice(before) };
}

async function post(as: string, path: string, fields: Record<string, string>) {
  const before = fake.calls.length;
  const res = await handleRequest(new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { Origin: SITE, Cookie: people[as]!.cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: people[as]!.csrf, ...fields }).toString(),
  }), env);
  const calls = fake.calls.slice(before);
  return { res, status: res.status, text: await res.text(), location: res.headers.get("Location"), writes: calls.filter((c) => c.method !== "GET"), calls };
}

/** The options of the select named `name` inside `html`, in order, and which is chosen. */
function options(html: string, name: string): { values: string[]; selected: string | null } {
  const m = html.match(new RegExp(`<select name="${name}"[^>]*>([\\s\\S]*?)</select>`));
  const found = [...(m?.[1] ?? "").matchAll(/<option value="([^"]*)"( selected)?>/g)];
  return { values: found.map((o) => o[1]!), selected: found.find((o) => o[2])?.[1] ?? null };
}

/** The value an input named `name` holds as the page is read. */
const inputValue = (html: string, name: string): string | null => {
  const input = tags(html).find((t) => t.name === "input" && t.attributes.some(([n, v]) => n === "name" && v === name));
  return input ? decode(input.attributes.find(([n]) => n === "value")?.[1] ?? "") : null;
};

/** Whether a form posting to `action` is on the page. */
const formTo = (html: string, action: string): boolean =>
  tags(html).some((t) => t.name === "form" && t.attributes.some(([n, v]) => n === "action" && v === action));

describe("the links page", () => {
  test("the owner's lists every link, what each is and whether it works, and pages to older ones", async () => {
    const { status, text, asked } = await get(OWNER, "/me/spaces/crew/invites");
    assert.equal(status, 200);
    assert.deepEqual(signedInProblems(text), [], "a label or a tag reached the page as markup");
    assert.match(text, /<h1>Invite links for crew<\/h1>/);
    for (const words of ["invite link", "hand-over link", "offer", "3 so far, no limit", "2 of 2", "used up", "its maker can no longer let anybody in with it", "never", "working"]) {
      assert.ok(text.includes(words), words);
    }
    assert.doesNotMatch(text, /creator_no_longer_governs|exhausted/, "a raw product value reached the page");
    assert.ok(text.includes("the role it passes is no longer held as it was"), "a dead hand-over said in an invite link's words");
    // Revoke on the working links, Withdraw on the offer, and Revoke and remove on invite links alone.
    assert.ok(formTo(text, `/me/invites/${ID(1)}/revoke`) && formTo(text, `/me/invites/${ID(2)}/revoke`) && formTo(text, `/me/invites/${ID(3)}/revoke`));
    assert.match(text, /<button type="submit">Withdraw<\/button>/);
    assert.ok(!formTo(text, `/me/invites/${ID(4)}/revoke`), "a used-up link offered for revoking");
    assert.ok(formTo(text, `/me/invites/${ID(1)}/remove`) && formTo(text, `/me/invites/${ID(4)}/remove`));
    assert.ok(!formTo(text, `/me/invites/${ID(2)}/remove`) && !formTo(text, `/me/invites/${ID(3)}/remove`), "a hand-over offered for removing");
    assert.ok(text.includes(`href="/me/spaces/crew/invites?after=${ID(5)}"`), "no way to the older links");
    assert.ok(text.includes('href="/me/spaces/crew/invites?live=true"'));
    assert.equal(asked.find((c) => c.url.pathname === "/v1/spaces/crew/invites")!.url.searchParams.get("limit"), "100");
    // A link passes with the role it was made from, so the list names who holds it now.
    assert.match(text, /<th>held by<\/th>/);
    assert.match(text, /so it is held by whoever holds that role now\./);
  });

  test("the working links alone are asked of the service, and the older ones keep to them", async () => {
    const { text, asked } = await get(OWNER, `/me/spaces/crew/invites?live=true&after=${ID(3)}`);
    const read = asked.find((c) => c.url.pathname === "/v1/spaces/crew/invites")!;
    assert.equal(read.url.searchParams.get("live"), "true");
    assert.equal(read.url.searchParams.get("after"), ID(3));
    assert.ok(text.includes(`href="/me/spaces/crew/invites?live=true&amp;after=${ID(5)}"`));
    assert.ok(text.includes('href="/me/spaces/crew/invites?live=true"'), "no way back to the newest");
    assert.doesNotMatch(text, /used up/);
  });

  test("the owner's form offers every role a link may give, and the service's defaults", async () => {
    const { text } = await get(OWNER, "/me/spaces/crew/invites");
    assert.deepEqual(options(text, "role"), { values: ["coordinator", "writer", "reader"], selected: "writer" });
    assert.equal(inputValue(text, "max_uses"), "10");
    assert.equal(inputValue(text, "expires_in_days"), "7");
    assert.match(text, /<input type="radio" name="uses" value="none"> No limit/);
    assert.match(text, /<input type="radio" name="lifetime" value="never"> It never expires/);
    assert.match(text, /<button type="submit">Make the invite link<\/button>/);
  });

  test("a coordinator's gives writer or reader, lists its own links, and takes back only its own", async () => {
    const { text } = await get(COORD, "/me/spaces/crew/invites");
    assert.deepEqual(options(text, "role").values, ["writer", "reader"]);
    assert.match(text, /<h1>Your links in crew<\/h1>/);
    assert.ok(formTo(text, `/me/invites/${ID(1)}/remove`));
    assert.ok(!text.includes(ID(2)), "a link it did not make");
  });

  test("a writer's has no form, and says where its hand-over is made", async () => {
    const { status, text } = await get(WRITER, "/me/spaces/crew/invites");
    assert.equal(status, 200);
    assert.ok(!formTo(text, "/me/spaces/crew/invites"));
    assert.match(text, /A writer or a reader makes no invite links\. Your hand-over link and your offers/);
  });
});

describe("making a link", () => {
  test("sends what the form says, and shows the link once, prominently, with its warning", async () => {
    const r = await post(OWNER, "/me/spaces/crew/invites", {
      role: "coordinator", uses: "limit", max_uses: "25", lifetime: "days", expires_in_days: "3", label: "for the <b>build</b>", tags: "builder, night",
    });
    assert.equal(r.status, 200);
    assert.equal(r.res.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(JSON.parse(r.writes[0]!.body!), {
      role: "coordinator", max_uses: 25, expires_in_seconds: 259200, label: "for the <b>build</b>", tags: ["builder", "night"],
    });
    assert.ok(r.text.includes(`<code class="secret">${LINK(CODE("7"))}</code>`), "the link is not shown");
    assert.ok(r.text.includes(`<code>${CODE("7")}</code>`), "the code is not shown");
    assert.match(r.text, /It is shown once, here, and never again\. Whoever holds it can use it until it expires, runs out or is revoked/);
    assert.match(r.text, /It lets in up to 25 keys as coordinator, until /);
    assert.deepEqual(signedInProblems(r.text), []);
  });

  test("no limit and never are sent as null, and said so", async () => {
    const r = await post(OWNER, "/me/spaces/crew/invites", { role: "reader", uses: "none", max_uses: "10", lifetime: "never", expires_in_days: "7" });
    assert.deepEqual(JSON.parse(r.writes[0]!.body!), { role: "reader", max_uses: null, expires_in_seconds: null });
    assert.match(r.text, /It lets in any number of keys as reader, and never expires\./);
  });

  test("how many keys or how many days in no shape is refused with a sentence, the form as typed, and nothing sent", async () => {
    for (const [fields, words] of [
      [{ uses: "limit", max_uses: "0", lifetime: "days", expires_in_days: "7" }, /How many keys may use it is a whole number from 1, or no limit\. Nothing was made\./],
      [{ uses: "limit", max_uses: "10", lifetime: "days", expires_in_days: "a week" }, /How long it works is a whole number of days from 1, or never\. Nothing was made\./],
    ] as const) {
      const r = await post(OWNER, "/me/spaces/crew/invites", { role: "writer", label: "typed", ...fields });
      assert.equal(r.status, 400);
      assert.deepEqual(r.writes, []);
      assert.match(r.text, words);
      assert.equal(inputValue(r.text, "label"), "typed");
    }
  });

  test("a code in no shape this site can show is revoked again, and the link shown is always this site's own", async () => {
    const bad = await post(OWNER, "/me/spaces/crew/invites", { role: "writer", uses: "limit", max_uses: "1", lifetime: "days", expires_in_days: "1", label: "bad-answer" });
    assert.equal(bad.status, 502);
    assert.ok(bad.writes.some((c) => c.method === "DELETE" && c.url.pathname === `/v1/invites/${ID(60)}`), "not revoked");
    assert.match(bad.text, /so this site revoked it again/);
    assert.doesNotMatch(bad.text, /NOT-A-CODE/);
    const odd = await post(OWNER, "/me/spaces/crew/invites", { role: "writer", uses: "limit", max_uses: "1", lifetime: "days", expires_in_days: "1", label: "odd-link" });
    assert.equal(odd.status, 200);
    assert.doesNotMatch(odd.text, /elsewhere\.example/, "the service's own host was shown");
    assert.ok(odd.text.includes(`<code class="secret">${LINK(CODE("7"))}</code>`), "not this site's own link");
    const none = await post(OWNER, "/me/spaces/crew/invites", { role: "writer", uses: "limit", max_uses: "1", lifetime: "days", expires_in_days: "1", label: "no-link" });
    assert.match(none.text, /The service reads no invite link, so give the space(?:'|&#39;)s name and the code below instead\./);
    assert.ok(!none.text.includes("/join/crew/"), "a link the service cannot read was shown");
    assert.ok(none.text.includes(`<code>${CODE("7")}</code>`), "the code is not shown");
  });
});

describe("taking a link back", () => {
  test("revoke goes back to the links with a word", async () => {
    const r = await post(OWNER, `/me/invites/${ID(1)}/revoke`, { space: "crew" });
    assert.equal(r.status, 303);
    assert.equal(r.location, "/me/spaces/crew/invites?notice=revoked");
    assert.equal(r.writes[0]!.method, "DELETE");
  });

  test("revoke and remove says how many went and how many remain, with Continue until none do", async () => {
    const first = await post(OWNER, `/me/invites/${ID(1)}/remove`, { space: "crew" });
    assert.equal(first.status, 200);
    assert.equal(first.writes[0]!.url.pathname, `/v1/invites/${ID(1)}/remove`);
    assert.match(first.text, /This step removed 500 keys it let in, with whoever those let in after them, and 20 keys remain\. Continue until none remain\./);
    assert.ok(formTo(first.text, `/me/invites/${ID(1)}/remove`), "no Continue");
    const last = await post(OWNER, `/me/invites/${ID(1)}/remove`, { space: "crew" });
    assert.match(last.text, /removed 20 keys it let in, with whoever those let in after them, and none remain\./);
    assert.ok(!formTo(last.text, `/me/invites/${ID(1)}/remove`));
  });

  test("a removal with more left than the service counts says so", async () => {
    const r = await post(OWNER, `/me/invites/${ID(9)}/remove`, { space: "crew" });
    assert.match(r.text, /This step removed 500 keys it let in, with whoever those let in after them, and 10,000 or more keys remain\. Continue until none remain\./);
  });

  test("an id or a space in no shape is refused before anything is sent", async () => {
    const r = await post(OWNER, `/me/invites/${ID(1)}/remove`, { space: "../x" });
    assert.equal(r.status, 400);
    assert.deepEqual(r.writes, []);
  });
});

describe("handing over", () => {
  test("a member's space page offers a hand-over link or an offer to a key, and the owner's says it hands over the space", async () => {
    const writer = await get(WRITER, "/me/spaces/crew");
    assert.match(writer.text, /<h2>Hand over your role<\/h2>/);
    assert.match(writer.text, /Pass your role here, writer, and its tags to one successor\. When the successor takes it, you leave the space\. Your working links, and the keys you brought in, pass with it\./);
    assert.match(writer.text, /One at a time: a new hand-over link or offer replaces the one before\./);
    assert.ok(formTo(writer.text, "/me/spaces/crew/hand-over"));
    assert.equal(inputValue(writer.text, "expires_in_days"), "7");
    assert.ok(writer.asked.some((c) => c.url.pathname === "/v1/mailbox" && c.url.searchParams.get("reason") === "hand_over"));
    const owner = await get(OWNER, "/me/spaces/crew");
    assert.match(owner.text, /<h2>Hand over this space<\/h2>/);
    assert.match(owner.text, /handing it over hands over the whole space: whoever takes it owns the space/);
    assert.match(owner.text, /Offer this space to that key/);
    assert.ok(!owner.asked.some((c) => c.url.pathname === "/v1/mailbox"), "the owner's page read its mailbox for offers");
  });

  test("a hand-over link is shown once, with its warning, and never expires when asked", async () => {
    const r = await post(OWNER, "/me/spaces/crew/hand-over", { how: "link", lifetime: "never", expires_in_days: "7" });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.writes[0]!.body!), { expires_in_seconds: null });
    assert.ok(r.text.includes(`<code class="secret">${LINK(HAND("c"))}</code>`));
    assert.match(r.text, /Whoever uses it first takes your role, once, and you leave the space\. Give it only to your successor, and keep it nowhere else\. It is the owner(?:'|&#39;)s: whoever uses it owns the space\./);
    assert.match(r.text, /It passes the space, once, and never expires\./);
    const days = await post(WRITER, "/me/spaces/crew/hand-over", { how: "link", lifetime: "days", expires_in_days: "2" });
    assert.deepEqual(JSON.parse(days.writes[0]!.body!), { expires_in_seconds: 172800 });
    assert.match(days.text, /It passes the role writer, once, until /);
  });

  test("an offer goes to one key and comes back with a word; your own key or one in no shape is refused before anything is sent", async () => {
    const r = await post(WRITER, "/me/spaces/crew/hand-over", { how: "offer", to: STRANGER });
    assert.equal(r.status, 303);
    assert.equal(r.location, "/me/spaces/crew?notice=offer-made");
    assert.deepEqual(JSON.parse(r.writes[0]!.body!), { to: STRANGER });
    const unreachable = await post(WRITER, "/me/spaces/crew/hand-over", { how: "offer", to: OTHER(5) });
    assert.equal(unreachable.status, 403);
    assert.ok(unreachable.text.includes('<a href="/me/spaces/crew#hand-over">Make a hand-over link instead</a>'), "no way to the hand-over link");
    assert.match(unreachable.text, /An offer reaches only a key that knows you, one you share a space or a conversation with, and that does not block you\. Nothing was offered\. Make a hand-over link instead/);
    for (const to of [WRITER, "not a key", STRANGER.toUpperCase()]) {
      const refused = await post(WRITER, "/me/spaces/crew/hand-over", { how: "offer", to });
      assert.equal(refused.status, 400, to);
      assert.deepEqual(refused.writes, [], to);
    }
  });

  test("an offer waiting for this key is on the space's page, with Accept and Decline, and only that space's and only while it waits", async () => {
    const { text } = await get(STRANGER, "/me/spaces/crew");
    assert.match(text, /<h2>This space is offered to you<\/h2>/);
    assert.match(text, /offers you the space <a href="\/me\/spaces\/crew"><code>crew<\/code><\/a>: accepting makes you its owner, and that key leaves it\./);
    assert.ok(formTo(text, `/me/hand-overs/${ID(70)}/accept`) && formTo(text, `/me/hand-overs/${ID(70)}/decline`));
    assert.ok(!text.includes(ID(72)) && !text.includes(ID(73)), "an offer for another space, or one not waiting, on this page");
    assert.equal(inputValue(text, "back"), "space");
  });

  test("Accept counts only a press made on purpose: sent switched off, switched on by this site's script, which the space's page runs beside the passkey's", async () => {
    const { res, text } = await get(WRITER, "/me/spaces/crew");
    assert.match(text, new RegExp(`action="/me/hand-overs/${ID(70)}/accept"[^>]*>.*?<button type="submit" data-guard disabled>Accept</button> <span class="meta" data-guard-note role="status" aria-live="polite"></span></form>`));
    assert.match(text, new RegExp(`action="/me/hand-overs/${ID(70)}/decline"[^>]*>.*?<button type="submit">Decline</button></form>`), "Decline needs no guard");
    assert.equal(text.split('<script src="/allow.js"></script>').length - 1, 1, "the guard's script, once");
    assert.ok(text.includes('<script type="module" src="/sign-post.js"></script>'), "the passkey's script is gone");
    assert.match(text, /<noscript><p class="note">Accept works only with this page(?:'|&#39;)s script, which makes sure it was you who pressed it and not a click another page steered here\. Decline needs no script\.<\/p><\/noscript>/);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /connect-src/);
    assert.deepEqual(signedInProblems(text), []);
  });

  test("the mailbox runs the same guard, once, under a policy that admits this site's script and sends no request", async () => {
    const { res, text } = await get(STRANGER, "/me/mailbox");
    assert.match(text, /<button type="submit" data-guard disabled>Accept<\/button>/);
    assert.equal(text.split('<script src="/allow.js"></script>').length - 1, 1, "the guard's script, once, for two offers");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /connect-src/);
    // A signed-in page with nothing to guard still runs no script.
    assert.doesNotMatch((await get(OWNER, "/me/spaces/crew/members")).res.headers.get("Content-Security-Policy") ?? "", /script-src/);
  });

  test("the mailbox shows every offer, and Accept and Decline on the one that waits", async () => {
    const { text } = await get(STRANGER, "/me/mailbox");
    assert.match(text, /a role offered to you/);
    assert.ok(formTo(text, `/me/hand-overs/${ID(70)}/accept`) && formTo(text, `/me/hand-overs/${ID(72)}/accept`));
    assert.ok(!formTo(text, `/me/hand-overs/${ID(73)}/accept`));
    assert.match(text, /The space was offered to you\. You accepted it\./);
  });

  test("Accept goes to the space with a word, an accept that changed nothing says so, and Decline goes back where it was pressed", async () => {
    const accepted = await post(STRANGER, `/me/hand-overs/${ID(70)}/accept`, { space: "crew", back: "mailbox" });
    assert.equal(accepted.location, "/me/spaces/crew?notice=taken-over");
    const same = await post(STRANGER, `/me/hand-overs/${ID(71)}/accept`, { space: "crew", back: "space" });
    assert.equal(same.location, "/me/spaces/crew?notice=unchanged");
    const fromMailbox = await post(STRANGER, `/me/hand-overs/${ID(70)}/decline`, { space: "crew", back: "mailbox" });
    assert.equal(fromMailbox.location, "/me/mailbox?notice=offer-declined");
    const fromSpace = await post(STRANGER, `/me/hand-overs/${ID(70)}/decline`, { space: "crew", back: "space" });
    assert.equal(fromSpace.location, "/me/spaces/crew?notice=offer-declined");
    const landed = await get(STRANGER, "/me/mailbox?notice=offer-declined");
    assert.match(landed.text, /Declined\. The key that offered it keeps its role\./);
  });
});

describe("members and join requests", () => {
  test("the members page finds by role and key, keeps them on the next page, and says who came in by a link", async () => {
    const { text, asked } = await get(OWNER, `/me/spaces/crew/members?role=writer&peer=${WRITER}&after=${ADMIN}`);
    const read = asked.find((c) => c.url.pathname === "/v1/spaces/crew/members")!;
    assert.equal(read.url.searchParams.get("role"), "writer");
    assert.equal(read.url.searchParams.get("peer"), WRITER);
    assert.equal(read.url.searchParams.get("after"), ADMIN);
    assert.ok(text.includes(`href="/me/spaces/crew/members?role=writer&amp;peer=${WRITER}&amp;after=${OTHER(9)}"`), "More members lost the view");
    assert.match(text, /came in by a link/);
    assert.equal(options(text, "role").selected, "writer");
    // Set and Remove carry the view back with them.
    assert.ok(text.includes(`<input type="hidden" name="in_role" value="writer">`) && text.includes(`<input type="hidden" name="find" value="${WRITER}">`));
    const junk = await get(OWNER, "/me/spaces/crew/members?role=king&peer=nobody&after=x");
    const plain = junk.asked.find((c) => c.url.pathname === "/v1/spaces/crew/members")!;
    assert.deepEqual([...plain.url.searchParams.keys()], ["limit"]);
  });

  test("an admin gives coordinator, writer or reader; a coordinator writer or reader, and changes only the keys it brought in", async () => {
    const admin = await get(ADMIN, "/me/spaces/crew/members");
    const panel = (html: string) => html.slice(html.indexOf("<h2>Admit a key"));
    assert.deepEqual(options(panel(admin.text), "role").values, ["coordinator", "writer", "reader"]);
    const coord = await get(COORD, "/me/spaces/crew/members");
    assert.deepEqual(options(panel(coord.text), "role").values, ["writer", "reader"]);
    assert.match(coord.text, /You change and remove only the keys you brought in\./);
    const setForms = tags(coord.text).filter((t) => t.name === "input" && t.attributes.some(([n, v]) => n === "name" && v === "peer") &&
      t.attributes.some(([n]) => n === "type") && t.attributes.find(([n]) => n === "type")?.[1] === "hidden").map((t) => t.attributes.find(([n]) => n === "value")?.[1]);
    assert.deepEqual([...new Set(setForms)], [WRITER], "a coordinator offered to change a key it did not bring in");
  });

  test("the join requests page is open to a coordinator, says how many wait, and approves writers and readers", async () => {
    const { status, text } = await get(COORD, "/me/spaces/crew/requests");
    assert.equal(status, 200);
    assert.match(text, /3 join requests wait for a decision\./);
    assert.deepEqual(options(text, "role").values, ["writer", "reader"]);
    assert.match(text, /A coordinator approves writers and readers\./);
    assert.deepEqual(signedInProblems(text), []);
    assert.match((await get(COORD, "/me/spaces/crew")).text, /href="\/me\/spaces\/crew\/requests">Join requests<\/a>/);
    assert.doesNotMatch((await get(WRITER, "/me/spaces/crew")).text, /href="\/me\/spaces\/crew\/requests"/);
  });
});

describe("an invite link sent in a conversation", () => {
  test("is offered where a message named a space this key lets writers into, in a group too, and says the operator can read it", async () => {
    const { text } = await get(OWNER, `/me/messages/${ID(101)}`);
    assert.match(text, /<h2>Send an invite link<\/h2>/);
    assert.match(text, /lets up to 2 keys join it as writers, within seven days\./);
    assert.match(text, /The keys in this conversation and the operator can read it, so the operator can read the link too\./);
    assert.ok(text.includes("Send an invite link for crew"));
    const writer = await get(WRITER, `/me/messages/${ID(101)}`);
    assert.doesNotMatch(writer.text, /Send an invite link/, "offered to a key that lets nobody in");
  });

  test("between two keys it lets in one key, in a group as many as the others still in it, and the message names the link and schellingaf_join", async () => {
    const pair = await post(OWNER, `/me/messages/${ID(100)}/invite`, { space: "crew" });
    assert.equal(pair.location, `/me/messages/${ID(100)}?notice=invite-sent`);
    const [made, sent] = pair.writes;
    assert.deepEqual(JSON.parse(made!.body!), { role: "writer", max_uses: 1, expires_in_seconds: 604800, label: "sent in a message" });
    const message = JSON.parse(sent!.body!);
    assert.equal(message.about, "crew");
    assert.ok(message.body.includes(LINK(CODE("7"))), "the message does not carry the link");
    assert.match(message.body, /It lets one key join as a writer, within seven days\. Whoever holds it can use it\./);
    assert.match(message.body, /give it to the schellingaf_join tool with action join and this link/);
    const group = await post(OWNER, `/me/messages/${ID(101)}/invite`, { space: "crew" });
    assert.equal(JSON.parse(group.writes[0]!.body!).max_uses, 2);
    assert.match(JSON.parse(group.writes[1]!.body!).body, /It lets up to 2 keys join as writers/);
    // The link the message carries is this site's own, whatever host the service named.
    assert.ok(JSON.parse(group.writes[1]!.body!).body.includes(LINK(CODE("7"))));
    assert.doesNotMatch(group.writes[1]!.body!, /elsewhere\.example/);
  });

  test("a message that cannot be sent takes its link back", async () => {
    const r = await post(OWNER, `/me/messages/${ID(102)}/invite`, { space: "crew" });
    assert.equal(r.status, 403);
    assert.ok(r.writes.some((c) => c.method === "DELETE" && c.url.pathname === `/v1/invites/${ID(60)}`), "the link was left working");
  });
});

describe("looking at a link, signed in", () => {
  test("says what an invite link gives, how often and how long, and whether it still works, and asks with the code in the body", async () => {
    const { status, text, asked } = await get(STRANGER, `/me/join/crew/${CODE("1")}`);
    assert.equal(status, 200);
    assert.match(text, /It lets you into <a href="\/me\/spaces\/crew"><code>crew<\/code><\/a> as a writer, with the tags <span class="tag">builder<\/span>\./);
    assert.match(text, /It has been used 3 of 10 times\./);
    assert.match(text, /It works until /);
    assert.match(text, /It still works\./);
    assert.match(text, /<button type="submit" data-guard disabled>Join<\/button>/);
    const look = asked.find((c) => c.url.pathname === "/v1/invites/look")!;
    assert.deepEqual(JSON.parse(look.body!), { name: "crew", code: CODE("1") });
    assert.ok(asked.every((c) => !c.url.href.includes(CODE("1"))), "the code went into an address of the service");
    const open = await get(STRANGER, `/me/join/crew/${CODE("2")}`);
    assert.match(open.text, /It has been used 7 times, and has no limit\./);
    assert.match(open.text, /It never expires\./);
  });

  test("a revoked, expired or used-up link says so, and offers no button", async () => {
    for (const [c, words] of [["3", /It was revoked, so it no longer works\./], ["4", /It has expired, so it no longer works\./],
      ["5", /It has been used as many times as it may be, so it no longer works\./]] as const) {
      const { status, text } = await get(STRANGER, `/me/join/crew/${CODE(c)}`);
      assert.equal(status, 200, c);
      assert.match(text, words, c);
      assert.ok(!formTo(text, "/me/spaces/crew/join"), `a button on a dead link (${c})`);
    }
  });

  test("while the service is being repaired, a link's page says it can neither be looked at nor used, and offers no button", async () => {
    const { status, text } = await get(STRANGER, `/me/join/crew/${CODE("9")}`);
    assert.equal(status, 200);
    assert.match(text, /The service is being repaired, so it cannot say what this link gives, and nothing can be joined until it is back\./);
    assert.ok(!formTo(text, "/me/spaces/crew/join"));
  });

  test("a hand-over link whose role is no longer held as it was says so, and offers no button", async () => {
    const { text } = await get(STRANGER, `/me/join/crew/${HAND("d")}`);
    assert.match(text, /The role it passes is no longer held as it was when the link was made, so it no longer works\./);
    assert.ok(!formTo(text, "/me/spaces/crew/join"));
  });

  test("an owner's hand-over link says the whole space passes, and a key's own offers it no button", async () => {
    const owners = await get(STRANGER, `/me/join/crew/${HAND("a")}`);
    assert.match(owners.text, /It is the owner(?:'|&#39;)s own hand-over link, made by .*Taking it makes you the owner of .*the whole space passes to you, and that key leaves it\./);
    assert.match(owners.text, /<button type="submit" data-guard disabled>Take over<\/button>/);
    const own = await get(WRITER, `/me/join/crew/${HAND("b")}`);
    assert.match(own.text, /It is your own: another key takes your role with it, and you cannot use it yourself\./);
    assert.ok(!formTo(own.text, "/me/spaces/crew/join"));
  });

  test("a code the service does not know for this space is a 404 that says so, and an answer in no shape says the service did not say", async () => {
    const unknown = await get(STRANGER, `/me/join/crew/${CODE("8")}`);
    assert.equal(unknown.status, 404);
    assert.match(unknown.text, /This link is not one for crew: it may be mistyped, or made for another space\. Nothing was joined\./);
    const odd = await get(STRANGER, `/me/join/crew/${CODE("6")}`);
    assert.equal(odd.status, 200);
    assert.match(odd.text, /The service did not say what this link gives just now\./);
    assert.deepEqual(signedInProblems(odd.text), []);
  });
});

describe("the words", () => {
  test("the Vocabulary page says how a space that takes invite links only is joined, and the limits on links", async () => {
    const doc = JSON.parse(await (await handleRequest(new Request(`${SITE}/vocabulary.json`), env)).text());
    const policy = doc.join_policies.find((p: { name: string }) => p.name === "invite");
    assert.match(policy.meaning, /^invite link only: a key joins with an invite link, or the code at its end, from the owner, an admin or a coordinator$/);
    const meanings = doc.limits.map((l: { meaning: string }) => l.meaning);
    assert.ok(meanings.includes("One key has at most 1,000 working links in each space. One link lets in any number of keys."), meanings.join(" | "));
    assert.ok(meanings.includes("A space has at most 5,000 coordinators."));
    const owner = doc.roles.find((r: { name: string }) => r.name === "owner");
    assert.match(owner.meaning, /leaves only by handing the space over/);
  });

  test("the Vocabulary page gives an oracle space's limits from the capability document, and says only the owner makes a space signed-only", async () => {
    const doc = JSON.parse(await (await handleRequest(new Request(`${SITE}/vocabulary.json`), env)).text());
    const meanings = doc.limits.map((l: { meaning: string }) => l.meaning);
    for (const line of [
      "One key has at most 3 proposals waiting in one oracle space.",
      "An oracle space has at most 100 proposals waiting.",
      "One key watches at most 200 documents.",
      "A document has at most 10,000 watchers.",
    ]) assert.ok(meanings.includes(line), line);
    const signedOnly = doc.words.find((w: { word: string }) => w.word === "signed-only space");
    assert.match(signedOnly.meaning, /Its owner decides\.$/);
  });

  test("the API page gives every operation of links and handing over a place, and calls ownership transfer available", async () => {
    const { operationPages, today, moduleKeys } = await import("../content/api-overview.mjs");
    for (const op of ["join.link", "invites.look", "invites.remove", "hand_over.create", "hand_over.accept", "hand_over.decline"]) {
      assert.equal(operationPages[op]?.on_site, "page", op);
      assert.ok(operationPages[op].pages.length > 0, op);
    }
    const terms = (list: [string, string][]) => list.map(([term]) => term);
    assert.ok(terms(today.available).includes("OWNERSHIP TRANSFER"));
    assert.ok(!terms(today.planned).includes("OWNERSHIP TRANSFER"));
    assert.equal(moduleKeys["OWNERSHIP TRANSFER"], "ownership_transfer");
    const roles = today.available.find(([term]: [string, string]) => term === "ROLES")![1];
    assert.match(roles, /One owner, plus admin, coordinator, writer and reader\./);
  });
});
