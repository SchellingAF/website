// A form that sends more than the service takes is refused with a sentence and shown
// again as it was typed, never cut to fit without a word.
//
// Driven through handleRequest() with a stand-in product whose limits are smaller than
// the ones the site falls back on, so a test that passes proves the site read them
// from the service. Every refusal is proved to have sent the product nothing.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, json } from "./lib/service.ts";
import { decode, htmlProblems, tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const KEY = (n: number) => n.toString(16).padStart(64, "e");
const SPACE_ID = "0199eeee-0000-7000-8000-000000000001";
const LIMITS = { fingerprints_per_post: 3, recipients_per_post: 2, tags_per_member: 2 };

const profile = {
  name: "notes", space_id: SPACE_ID, title: "Notes", description: "Where notes go.", visibility: "private",
  join_policy: "request", status: "active", signed_only: false, replaced_by: null, categories: ["general"],
  owner: OWNER, contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-18T09:00:00.000Z",
  access: { role: "owner", tags: [], read: true, post: true },
};

const { fake, handleRequest } = await site((call) => {
  const where = `${call.method} ${call.url.pathname}`;
  switch (where) {
    case "GET /v1/capabilities": return json({ ...CAPABILITIES, limits: { ...CAPABILITIES.limits, ...LIMITS } });
    case "GET /v1/conversations": return json({ items: [], unread_conversations: 0, requests_waiting: 0 });
    case "GET /v1/spaces/notes": return json(profile);
    case "GET /v1/spaces/notes/posts": return json({ items: [], next_after: null, has_more: false, head_seq: "0" });
    case "GET /v1/spaces/notes/checkpoints": return json({ items: [] });
    case "GET /v1/spaces/notes/members": return json({ owner: OWNER, items: [], next_after: null, has_more: false });
    case "GET /v1/spaces/notes/invites": return json({ items: [] });
    case "GET /v1/categories": return json({ categories: [] });
    case "POST /v1/spaces/notes/posts": return json({ post_id: "0199eeee-0000-7000-8000-000000000009", seq: "9" }, 201);
    case "PATCH /v1/spaces/notes": return json({ name: "notes" });
    case "POST /v1/spaces/notes/invites": return json({ code: `schellingaf_inv_${"0".repeat(32)}`, role: "writer", expires_at: "2026-09-25T09:00:00.000Z", invite_id: "0199eeee-0000-7000-8000-000000000010" }, 201);
  }
  if (call.method === "PUT" && call.url.pathname.startsWith("/v1/spaces/notes/members/")) return json({ name: "notes" });
  if (call.method === "DELETE" && call.url.pathname.startsWith("/v1/spaces/notes/members/")) return json({ name: "notes" });
  return json({ error: { code: "NOT_ANSWERED", message: where } }, 404);
});

const { lines, words, refusalText } = await import("../src/signed-in.ts");

const { cookie, csrf } = await signedIn(OWNER, "forms-token", "192.0.2.61");

async function send(path: string, fields: Record<string, string>) {
  const before = fake.calls.length;
  const res = await handleRequest(new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, ...fields }).toString(),
  }), env);
  const writes = fake.calls.slice(before).filter((c) => c.method !== "GET");
  return { status: res.status, text: await res.text(), location: res.headers.get("Location"), writes };
}

/** The value a form's field holds as the page is read: an input's value, a textarea's text. */
function fieldValue(html: string, name: string): string | null {
  const input = tags(html).find((t) => t.name === "input" && t.attributes.some(([n, v]) => n === "name" && v === name));
  if (input) return decode(input.attributes.find(([n]) => n === "value")?.[1] ?? "");
  const m = html.match(new RegExp(`<textarea name="${name}"[^>]*>([\\s\\S]*?)</textarea>`));
  return m ? decode(m[1]!.replace(/^\n/, "")) : null;
}

describe("the lines and words a form sends", () => {
  test("are every one of them, never cut", () => {
    const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\r\n");
    assert.equal(lines(many).length, 100);
    assert.deepEqual(lines(" a \n\n\tb\r\n"), ["a", "b"]);
    assert.equal(words(Array.from({ length: 20 }, (_, i) => `t${i}`).join(", ")).length, 20);
  });

  test("a tag the service refuses is said in words, not as its code", () => {
    for (const code of ["INVALID_TAGS", "TAG_RESERVED"]) {
      assert.match(refusalText({ ok: false, status: 400, code, message: code }), /One of those tags is not allowed/);
    }
  });
});

describe("a post", () => {
  const post = (fields: Record<string, string>) =>
    send("/me/spaces/notes/posts", { kind: "obs", title: "A <b>title</b>", body: "\nText <script>alert(1)</script>", idempotency_key: "k".repeat(20), ...fields });

  test("naming more fingerprints than the service takes is refused before anything is sent, and comes back as typed", async () => {
    const prints = "git.commit:1\nfile.sha256:2\nurl:https://x.example/3\nissue:4";
    const replyTo = "0199eeee-0000-7000-8000-000000000002";
    const r = await post({ fingerprints: prints, to: KEY(1), reply_to: replyTo });
    assert.equal(r.status, 400);
    assert.deepEqual(r.writes, [], "a refused post reached the product");
    assert.match(r.text, /A post carries at most 3 fingerprints, and this one has 4\. Nothing was posted\./);
    assert.equal(fieldValue(r.text, "fingerprints"), prints);
    assert.equal(fieldValue(r.text, "to"), KEY(1));
    assert.equal(fieldValue(r.text, "title"), "A <b>title</b>");
    assert.equal(fieldValue(r.text, "body"), "\nText <script>alert(1)</script>", "the body, its first line break included");
    assert.equal(fieldValue(r.text, "reply_to"), replyTo);
    assert.equal(fieldValue(r.text, "idempotency_key"), "k".repeat(20), "the form keeps its own key, since nothing was sent");
    assert.ok(tags(r.text).some((t) => t.name === "form" && t.attributes.some(([n, v]) => n === "action" && v === "/me/spaces/notes/posts")));
    assert.deepEqual(htmlProblems(r.text), []);
  });

  test("the same fingerprint twice is one, as the service keeps it", async () => {
    const r = await post({ fingerprints: "git.commit:1\ngit.commit:1\nissue:4\nissue:5" });
    assert.equal(r.status, 303);
    assert.deepEqual(JSON.parse(r.writes[0]!.body!).fingerprints, [
      { scheme: "git.commit", value: "1" }, { scheme: "issue", value: "4" }, { scheme: "issue", value: "5" },
    ]);
  });

  test("sent to more keys than the service takes is refused, and a key named twice is one", async () => {
    const three = [KEY(1), KEY(2), KEY(3)].join("\n");
    const r = await post({ to: three });
    assert.equal(r.status, 400);
    assert.deepEqual(r.writes, []);
    assert.match(r.text, /A post goes to at most 2 keys&#39; mailboxes, and this one names 3\./);
    assert.equal(fieldValue(r.text, "to"), three);
    const twice = await post({ to: [KEY(1), KEY(2), KEY(1)].join("\n") });
    assert.equal(twice.status, 303);
    assert.deepEqual(JSON.parse(twice.writes[0]!.body!).to, [KEY(1), KEY(2)]);
  });

  test("a fingerprint or a key in the wrong shape comes back as typed too", async () => {
    const r = await post({ fingerprints: "no colon here" });
    assert.equal(r.status, 400);
    assert.match(r.text, /A fingerprint is written scheme:value/);
    assert.equal(fieldValue(r.text, "fingerprints"), "no colon here");
    const k = await post({ to: "not a key" });
    assert.equal(k.status, 400);
    assert.match(k.text, /Each line under Send it to must be a key id/);
    assert.deepEqual([...r.writes, ...k.writes], []);
  });

  test("the form a passkey signs carries the service's limits, for its script to say so before signing", async () => {
    const res = await handleRequest(new Request(`${SITE}/me/spaces/notes`, { headers: { Cookie: cookie } }), env);
    const text = await res.text();
    const form = tags(text).find((t) => t.name === "form" && t.attributes.some(([n]) => n === "data-sign"));
    assert.ok(form, "no form to sign");
    assert.equal(form.attributes.find(([n]) => n === "data-max-fingerprints")?.[1], "3");
    assert.equal(form.attributes.find(([n]) => n === "data-max-recipients")?.[1], "2");
  });
});

describe("a space's settings", () => {
  test("tick only the way in the space has, and saving without one sends none, so nothing changes it unasked", async () => {
    const res = await handleRequest(new Request(`${SITE}/me/spaces/notes/settings`, { headers: { Cookie: cookie } }), env);
    const text = await res.text();
    const ticked = tags(text).filter((t) => t.name === "input" && t.attributes.some(([n, v]) => n === "name" && v === "join_policy") && t.attributes.some(([n]) => n === "checked"));
    assert.deepEqual(ticked.map((t) => t.attributes.find(([n]) => n === "value")?.[1]), ["request"]);
    assert.doesNotMatch(text, /value="open"/, "a private space, and a service that does not take it");
    const none = await send("/me/spaces/notes/settings", { title: "Notes", description: "" });
    assert.equal(none.status, 303);
    assert.equal("join_policy" in JSON.parse(none.writes[0]!.body!), false);
    const chosen = await send("/me/spaces/notes/settings", { title: "Notes", description: "", join_policy: "invite" });
    assert.equal(JSON.parse(chosen.writes[0]!.body!).join_policy, "invite");
  });
});

describe("a member's tags", () => {
  /** The panel that admits a key or sets a member's role and tags: the members page also
   *  carries a box that finds a member by its key, named peer too. */
  const admitPanel = (html: string) => html.slice(html.indexOf("<h2>Admit a key"));

  test("more than the service takes are refused, and the members page comes back with the form as typed", async () => {
    const r = await send("/me/spaces/notes/members", { peer: KEY(7), role: "reader", tags: "one two three", after: KEY(5), in_role: "reader" });
    assert.equal(r.status, 400);
    assert.deepEqual(r.writes, []);
    assert.match(r.text, /A member carries at most 2 tags, and these are 3\. Nothing was changed\./);
    assert.equal(fieldValue(admitPanel(r.text), "tags"), "one two three");
    assert.equal(fieldValue(admitPanel(r.text), "peer"), KEY(7));
    assert.match(admitPanel(r.text), /<option value="reader" selected>reader<\/option>/);
    // The view it was pressed on, which a POST's own address does not carry.
    const members = fake.calls.filter((c) => c.url.pathname === "/v1/spaces/notes/members").at(-1)!;
    assert.equal(members.url.searchParams.get("after"), KEY(5));
    assert.equal(members.url.searchParams.get("role"), "reader");
  });

  test("as many as it takes are sent, and Set and Remove come back to the view they were pressed on", async () => {
    const set = await send("/me/spaces/notes/members", { peer: KEY(7), role: "writer", tags: "one, two", after: KEY(5) });
    assert.equal(set.status, 303);
    assert.equal(set.location, `/me/spaces/notes/members?after=${KEY(5)}&notice=admitted`);
    assert.deepEqual(JSON.parse(set.writes[0]!.body!), { role: "writer", tags: ["one", "two"] });
    const removed = await send("/me/spaces/notes/members/remove", { peer: KEY(7), after: KEY(5), in_role: "writer", find: KEY(7) });
    assert.equal(removed.location, `/me/spaces/notes/members?role=writer&peer=${KEY(7)}&after=${KEY(5)}&notice=removed`);
    // A view that is not one is the first page of everybody.
    const junk = await send("/me/spaces/notes/members/remove", { peer: KEY(7), after: "../x", in_role: "owner", find: "x" });
    assert.equal(junk.location, "/me/spaces/notes/members?notice=removed");
  });

  test("an invite link's tags are held to the same limit, and its form comes back as typed", async () => {
    const r = await send("/me/spaces/notes/invites", {
      role: "reader", uses: "limit", max_uses: "5", lifetime: "days", expires_in_days: "3", label: "for <b>the</b> build", tags: "a b c",
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.writes, []);
    assert.match(r.text, /A member carries at most 2 tags, and these are 3/);
    for (const [name, want] of [["max_uses", "5"], ["expires_in_days", "3"], ["label", "for <b>the</b> build"], ["tags", "a b c"]]) {
      assert.equal(fieldValue(r.text, name!), want, name);
    }
    assert.match(r.text, /<option value="reader" selected>reader<\/option>/);
    assert.deepEqual(htmlProblems(r.text), []);
  });
});
