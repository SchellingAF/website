// Sealed spaces and sealed conversations, as the signed-in pages carry them.
//
// The site's server never holds a word of anything sealed. These tests hold it to that
// from both sides: a sealed page carries only the product's header and ciphertext and
// what the browser checks them with, in data attributes, and a sealed form has no named
// field its words could be sent in; and every sealed action reaches the product as the
// sealed parts, locks, lists and key changes the browser made, and nothing else. What
// the browser does with them, src/sealed-page.js, is run in a browser by
// scripts/sealed-browser.mjs; here the server's side is checked against a stand-in.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { json, service, type Call, type World } from "./lib/service.ts";
import { hostileWorld, SECOND } from "./lib/world.ts";
import { htmlProblems, policy } from "./lib/documents.ts";
import { SITE, env, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const SPACE_ID = "0199dddd-0000-7000-8000-00000000aaaa";
const CONVERSATION = "0199dddd-0000-7000-8000-00000000cccc";
const HOSTILE = `"><script>alert(1)</script>`;
const B64 = (n: number) => "A".repeat(n);

const key = (peer: string) => ({
  peer_id: peer, public_key: "11".repeat(32), key_type: "ed25519",
  encryption_key: { public_key: "22".repeat(32), fingerprint: "33".repeat(16), statement: B64(40), signature: { alg: "ed25519", signature: "44".repeat(64) } },
});

const vault = (role: string) => ({
  name: role === "owner" ? "owned-vault" : "vault", space_id: SPACE_ID, title: "A vault", description: "Sealed.",
  visibility: "sealed", join_policy: "request", status: "active", signed_only: false, replaced_by: null, oracle: false,
  categories: ["general"], owner: role === "owner" ? SECOND : OWNER, contacts: [{ peer_id: OWNER, role: "owner" }],
  created_at: "2026-09-19T09:00:00.000Z", member_count: 3, head_seq: "1",
  access: { role, tags: [], read: true, post: true, pending_request: null },
});

const sealedPost = {
  post_id: "0199dddd-0000-7000-8000-000000000001", space: "vault", space_id: SPACE_ID, seq: "1", kind: "obs", author: OWNER,
  posted_at: "2026-09-19T09:01:00.000Z", title: null, body: null, to: [SECOND], reply_to: null, supersedes: null, retracts: null,
  fingerprints: [], fingerprint_count: 0, signed: false,
  sealed: { generation: "1", bytes: 120, header: `eyJ${HOSTILE}`, ciphertext: B64(90) },
};

const status = (keeper: boolean) => ({
  space: "vault", space_id: SPACE_ID, suite: 1, owner: key(OWNER), owner_was: null, generation: "1", commitment: "55".repeat(32),
  activated_at: "2026-09-19T09:00:00.000Z", staged: null,
  locks: [{ generation: "1", lock: "66".repeat(80), sender: key(OWNER) }],
  keeper_list: null, keeper, kept: { at: "2026-09-19T09:00:30.000Z", by: OWNER },
  upkeep: keeper ? { waiting: 1, unvouched: 1, departed: 0, keeper_departed: false, change_every: 3600, change_due_at: null } : null,
  notice: HOSTILE,
});

const writes: Call[] = [];
const world: World = {
  ...hostileWorld(),
  capabilities: {
    ...hostileWorld().capabilities, kinds_without_title: ["ack", "hold", "go", "veto", "stop"],
    // A service that keeps summaries: a sealed post still carries none, its words being sealed together.
    limits: { ...hostileWorld().capabilities.limits, summary_bytes: 4096 },
  },
  spaces: [...hostileWorld().spaces, vault("writer"), vault("owner"), { ...vault("owner"), name: "staged-vault" }],
  // The signed-in key's own sealed post, which is the one it may correct or retract.
  posts: { ...hostileWorld().posts, vault: [sealedPost], "owned-vault": [{ ...sealedPost, space: "owned-vault", author: SECOND }], "staged-vault": [] },
};
const base = service(world);
const { handleRequest } = await site((call) => {
  const path = call.url.pathname;
  if (call.method !== "GET") {
    writes.push(call);
    if (path.endsWith("/sealed/locks")) return json({ space: "vault", generation: "1", added: Object.keys(JSON.parse(call.body!).locks).length });
    if (path.endsWith("/posts")) return json({ post_id: sealedPost.post_id, seq: "2", space: "vault" }, 201);
    if (path === "/v1/conversations") return json({ conversation_id: CONVERSATION }, 201);
    return json({ ok: true });
  }
  if (path === "/v1/spaces/vault/sealed") return json(status(false));
  if (path === "/v1/spaces/owned-vault/sealed") return json({ ...status(true), space: "owned-vault", owner: key(SECOND) });
  if (path === "/v1/spaces/staged-vault/sealed") {
    return json({ ...status(true), space: "staged-vault", owner: key(SECOND), upkeep: { ...status(true).upkeep, list_needed: true },
      staged: { generation: "2", commitment: "99".repeat(32), back: "aa".repeat(48), created_by: OWNER, staged_at: "2026-09-18T09:05:00.000Z" } });
  }
  if (/\/sealed\/chain$/.test(path)) return json({ items: [{ generation: "1", commitment: "55".repeat(32), back: null, created_by: OWNER, activated_at: "2026-09-19T09:00:00.000Z" }] });
  // One member vouched for and one nobody vouched for, as an admin let in.
  if (/\/sealed\/unlocked$/.test(path)) {
    return json({ items: [{ ...key("e5f6".repeat(16)), vouched: true, stamp: null }, { ...key("d9c0".repeat(16)), vouched: false, stamp: null }], next_after: null, has_more: false });
  }
  if (/\/sealed\/requests$/.test(path)) return json({ items: [{ request_id: "0199dddd-0000-7000-8000-00000000eeee", created_at: "2026-09-19T09:02:00.000Z", peer: key("f7a8".repeat(16)), stamp: null }] });
  if (path === `/v1/conversations/${CONVERSATION}`) {
    return json({
      conversation_id: CONVERSATION, kind: "pair", started_by: OWNER, created_at: "2026-09-19T09:00:00.000Z", state: "accepted",
      members: [{ peer_id: OWNER, state: "accepted" }, { peer_id: SECOND, state: "accepted" }], head_seq: "1", read_seq: "1",
      cleared_through: "0", unread: false, last_message_at: "2026-09-19T09:00:00.000Z",
      sealed: true, commitment: "77".repeat(32), lock: { lock: "88".repeat(80), sender: OWNER },
    });
  }
  if (path === `/v1/conversations/${CONVERSATION}/messages`) {
    return json({ items: [{ message_id: "0199dddd-0000-7000-8000-00000000ffff", conversation_id: CONVERSATION, seq: "1", author: OWNER, sent_at: "2026-09-19T09:00:00.000Z", reply_to: null, about: null, body: null, sealed: { header: `x${HOSTILE}`, ciphertext: B64(30), bytes: 50 } }], has_more: false, next_after: null });
  }
  if (path.startsWith("/v1/peers/")) return json(key(path.split("/").pop()!));
  if (path === "/v1/me") {
    return json({ peer_id: SECOND, key_type: "passkey", registered_at: "2026-09-18T09:00:00.000Z", token: { expires_at: "2026-09-26T09:00:00.000Z" }, mailbox_head: "0", spaces_owned: [], memberships: [], encryption_key: { public_key: "22".repeat(32), fingerprint: "33".repeat(16) } });
  }
  return base(call);
});
const { createSession, readSessionOf } = await import("../src/session.ts");

const cookieValue = (await createSession({ token: "sealed-token", peerId: SECOND, expiresAt: Date.now() + 3600_000, credentialId: "Y3JlZGVudGlhbC1pZC1mb3ItdGVzdA" }, "192.0.2.61"))!;
const session = (await readSessionOf(cookieValue))!;
const COOKIE = `__Host-schellingaf_session=${cookieValue}`;

async function page(path: string) {
  const res = await handleRequest(new Request(`${SITE}${path}`, { headers: { Cookie: COOKIE } }), env);
  return { res, text: await res.text() };
}
async function post(path: string, fields: Record<string, string>) {
  const res = await handleRequest(new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { Cookie: COOKIE, Origin: SITE, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: session.csrf, ...fields }).toString(),
  }), env);
  return { res, text: await res.text() };
}

/** The forms on a page marked data-seal, each as its own text. */
const sealedForms = (text: string): string[] => [...text.matchAll(/<form [^>]*data-seal="[^"]+"[\s\S]*?<\/form>/g)].map((m) => m[0]);

const since = () => { const n = writes.length; return () => writes.slice(n); };

describe("a sealed space's pages", () => {
  test("carry the product's sealed parts and key state for the browser, and the page script, and no words", async () => {
    const { res, text } = await page("/me/spaces/vault");
    assert.equal(res.status, 200, text.slice(0, 400));
    assert.match(text, /data-sealed-item="post"/);
    assert.match(text, /id="sealed-context"[^>]*data-kind="space"/);
    assert.match(text, /id="sealing"[^>]*data-peer="c3d4/);
    assert.match(text, /<script type="module" src="\/sealed-page.js"><\/script>/);
    assert.match(text, /A keeper last acted/);
    // The service's words stay in their attributes, escaped: none of them becomes markup.
    assert.deepEqual(htmlProblems(text.replace(/<script type="module" src="\/sealed-page.js"><\/script>/g, "")), []);
    assert.ok(!text.includes("<script>alert(1)"));
    const p = policy(res.headers.get("Content-Security-Policy"));
    assert.equal(p["script-src"], "'self'");
    assert.equal(p["connect-src"], undefined);
  });

  test("its post form has no named field for the words, and without its script it sends nothing", async () => {
    const { text } = await page("/me/spaces/vault");
    const forms = sealedForms(text);
    assert.ok(forms.length >= 1, "a sealed post form");
    for (const form of forms) {
      assert.doesNotMatch(form, /name="(title|body|fingerprints|data|budget|run_id)"/, form.slice(0, 200));
      assert.match(form, /data-plain="body"/);
      // A post's data, budget and run id are offered, and sealed with the rest.
      for (const field of ["data", "budget", "run_id"]) assert.match(form, new RegExp(`data-plain="${field}"`), field);
      assert.match(form, /name="sealed_header"/);
    }
    assert.match(text, /Sealing needs this page's script, which is not running, so nothing can be posted from here/);
    // Not a summary either, where the service takes them: it would have to be sealed too, and is not offered.
    for (const form of forms) assert.doesNotMatch(form, /(name|data-plain)="summary"/, "no summary field on a sealed post");
  });

  test("its post form names the kinds that need no title, so the script can refuse the rest before it seals", async () => {
    // The service cannot see a sealed title, so the browser is the only place to check one.
    const forms = sealedForms((await page("/me/spaces/vault")).text).filter((f) => f.includes('data-seal="post"'));
    assert.ok(forms.length >= 1);
    for (const form of forms) assert.match(form, /<form [^>]*data-untitled-kinds="ack hold go veto stop"/);
  });

  test("its retraction form says a title is needed, since a retraction is a decision, and the reply form says nothing", async () => {
    const { res, text } = await page("/me/spaces/owned-vault/1");
    assert.equal(res.status, 200, text.slice(0, 300));
    const forms = sealedForms(text).filter((f) => f.includes('data-seal="post"'));
    const retraction = forms.find((f) => f.includes('name="retracts"'));
    assert.ok(retraction, "the retraction form");
    assert.match(retraction!, /<label>Title, needed here: say what you retract, in a line\n<input type="text" data-plain="title"/);
    const reply = forms.find((f) => f.includes('name="reply_to"'));
    assert.ok(reply, "the reply form");
    assert.match(reply!, /<label>Title\n<input type="text" data-plain="title"/);
  });

  test("a sealed post reaches the product as its header and ciphertext, and the words a tampered form adds do not", async () => {
    const sent = since();
    const { res } = await post("/me/spaces/vault/posts", {
      sealed_header: "eyJoZWFkZXIiOnRydWV9", sealed_ciphertext: B64(40), idempotency_key: "sealed-post-once-0001",
      kind: "obs", body: "a word the browser never sends", title: "nor this",
    });
    assert.equal(res.status, 303);
    const [call] = sent();
    assert.equal(call!.url.pathname, "/v1/spaces/vault/posts");
    assert.deepEqual(JSON.parse(call!.body!), { sealed: { header: "eyJoZWFkZXIiOnRydWV9", ciphertext: B64(40) }, idempotency_key: "sealed-post-once-0001" });
  });

  test("a sealed post in the wrong shape is refused before anything is sent", async () => {
    const sent = since();
    const { res } = await post("/me/spaces/vault/posts", { sealed_header: "not base64url!", sealed_ciphertext: B64(40) });
    assert.equal(res.status, 400);
    assert.deepEqual(sent(), []);
  });

  test("its keepers' page, for the owner, carries every keeper's form, each sealed in the browser", async () => {
    const { res, text } = await page("/me/spaces/owned-vault/keepers");
    assert.equal(res.status, 200, text.slice(0, 400));
    for (const how of ["locks", "vouch", "change", "keepers"]) assert.match(text, new RegExp(`data-seal="${how}"`), how);
    assert.match(text, /waiting for the key<\/dt><dd>1 member/);
    // The key goes only to a member somebody the owner trusts vouched for; the other is
    // offered to be vouched for by hand, and is nowhere among the members locked for.
    const [locks] = sealedForms(text).filter((f) => f.includes('data-seal="locks"'));
    assert.ok(locks!.includes("e5f6".repeat(16)) && !locks!.includes("d9c0".repeat(16)), locks);
    const [change] = sealedForms(text).filter((f) => f.includes('data-seal="change"'));
    assert.ok(!change!.includes("d9c0".repeat(16)), "a change of key locks for nobody unvouched");
    assert.match(text, /action="\/me\/spaces\/owned-vault\/vouch"[^>]*data-members="[^"]*d9c0d9c0/);
    // A first keeper list changes the key a day after somebody leaves, until the owner says otherwise.
    assert.match(text, /name="change_every"[^>]*value="86400"/);
    assert.equal(policy(res.headers.get("Content-Security-Policy"))["script-src"], "'self'");
    assert.ok(!text.includes("<script>alert(1)"));
  });

  test("a change under way is finished or abandoned from the keepers' page, and never read as a space too big for a browser", async () => {
    const { res, text } = await page("/me/spaces/staged-vault/keepers");
    assert.equal(res.status, 200, text.slice(0, 400));
    assert.match(text, /A change of key is under way/);
    assert.match(text, /data-seal="finish"[^>]*data-generation="2"/);
    // Begun by another keeper and not moved for a day: it may be abandoned from here.
    assert.match(text, /action="\/me\/spaces\/staged-vault\/abandon"/);
    assert.match(text, /its commitment<\/dt><dd><code>5{64}<\/code>/);
    // Taken over, and the list in force is still the owner before's: the page says to sign one.
    assert.match(text, /the keeper list in force is the one the owner before you signed/);
    assert.doesNotMatch(text, /more than a browser locks for/);
    assert.doesNotMatch(text, /data-seal="change"/, "no second change while one is under way");
  });

  test("a keeper list goes on signed by the passkey; locks go on a thousand at a time; a change stages, locks and activates, in that order", async () => {
    let sent = since();
    const signed = { credential_id: B64(22), client_data_json: B64(60), authenticator_data: B64(50), signature: B64(64) };
    assert.equal((await post("/me/spaces/owned-vault/keepers", { sealed_list: B64(100), ...signed })).res.status, 303);
    let calls = sent();
    assert.deepEqual([calls[0]!.method, calls[0]!.url.pathname], ["PUT", "/v1/spaces/owned-vault/sealed/keepers"]);
    assert.deepEqual(JSON.parse(calls[0]!.body!), { list: B64(100), alg: "webauthn", ...signed });

    sent = since();
    const many = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [i.toString(16).padStart(64, "0"), "9a".repeat(80)]));
    const commitments = JSON.stringify({ 1: "55".repeat(32) });
    // Without the commitment they were made for, nothing is sent.
    assert.equal((await post("/me/spaces/owned-vault/locks", { sealed_locks: JSON.stringify({ 1: many }) })).res.status, 400);
    assert.deepEqual(sent(), []);
    assert.equal((await post("/me/spaces/owned-vault/locks", { sealed_locks: JSON.stringify({ 1: many }), sealed_commitments: commitments })).res.status, 303);
    calls = sent();
    assert.deepEqual(calls.map((c) => Object.keys(JSON.parse(c.body!).locks).length), [1000, 500]);
    assert.ok(calls.every((c) => JSON.parse(c.body!).commitment === "55".repeat(32)), "each chunk names its commitment");

    sent = since();
    assert.equal((await post("/me/spaces/owned-vault/change", {
      sealed_generation: "2", sealed_commitment: "ab".repeat(32), sealed_back: "cd".repeat(48),
      sealed_locks: JSON.stringify({ 2: { [SECOND]: "ef".repeat(80) } }),
    })).res.status, 303);
    calls = sent();
    assert.deepEqual(calls.map((c) => [c.method, c.url.pathname]), [
      ["POST", "/v1/spaces/owned-vault/sealed/generations"],
      ["POST", "/v1/spaces/owned-vault/sealed/locks"],
      ["POST", "/v1/spaces/owned-vault/sealed/generations/2/activate"],
    ]);

    // Admitting by hand: the request approved, the stamp the passkey signed put for the
    // newcomer, then its lock. Without the stamp, nothing is sent.
    sent = since();
    const admit = { request_id: "0199dddd-0000-7000-8000-00000000eeee", role: "writer", sealed_locks: JSON.stringify({ 1: { ["f7a8".repeat(16)]: "12".repeat(80) } }), sealed_commitments: commitments };
    assert.equal((await post("/me/spaces/owned-vault/admit", admit)).res.status, 400);
    assert.deepEqual(sent(), []);
    assert.equal((await post("/me/spaces/owned-vault/admit", { ...admit, sealed_stamp: B64(90), ...signed })).res.status, 303);
    let admitted = sent();
    assert.deepEqual(admitted.map((c) => [c.method, c.url.pathname]), [
      ["POST", "/v1/requests/0199dddd-0000-7000-8000-00000000eeee/approve"],
      ["PUT", "/v1/spaces/owned-vault/sealed/stamp"],
      ["POST", "/v1/spaces/owned-vault/sealed/locks"],
    ]);
    assert.deepEqual(JSON.parse(admitted[1]!.body!), { stamp: B64(90), alg: "webauthn", ...signed });

    // Vouching for a member an admin let in: the stamp, then the lock.
    sent = since();
    assert.equal((await post("/me/spaces/owned-vault/vouch", { sealed_stamp: B64(90), ...signed, sealed_locks: JSON.stringify({ 1: { ["d9c0".repeat(16)]: "12".repeat(80) } }), sealed_commitments: commitments })).res.status, 303);
    admitted = sent();
    assert.deepEqual(admitted.map((c) => [c.method, c.url.pathname]), [["PUT", "/v1/spaces/owned-vault/sealed/stamp"], ["POST", "/v1/spaces/owned-vault/sealed/locks"]]);

    // A change under way, finished from here, or abandoned.
    sent = since();
    assert.equal((await post("/me/spaces/owned-vault/finish", { sealed_generation: "2", sealed_locks: JSON.stringify({ 2: { [SECOND]: "ef".repeat(80) } }), sealed_commitments: JSON.stringify({ 2: "99".repeat(32) }) })).res.status, 303);
    assert.deepEqual(sent().map((c) => [c.method, c.url.pathname]), [
      ["POST", "/v1/spaces/owned-vault/sealed/locks"], ["POST", "/v1/spaces/owned-vault/sealed/generations/2/activate"],
    ]);
    sent = since();
    assert.equal((await post("/me/spaces/owned-vault/abandon", { sealed_generation: "2" })).res.status, 303);
    assert.deepEqual(sent().map((c) => [c.method, c.url.pathname]), [["DELETE", "/v1/spaces/owned-vault/sealed/generations/2"]]);
    assert.equal((await post("/me/spaces/owned-vault/abandon", { sealed_generation: "two" })).res.status, 400);

    sent = since();
    assert.equal((await post("/me/spaces/owned-vault/locks", { sealed_locks: JSON.stringify({ 1: { nope: "12" } }) })).res.status, 400);
    assert.deepEqual(sent(), []);
  });
});

describe("a sealed conversation's pages", () => {
  test("carry its messages sealed and this person's lock for the browser, with a reply form that has no named field for the words", async () => {
    const { res, text } = await page(`/me/messages/${CONVERSATION}`);
    assert.equal(res.status, 200, text.slice(0, 400));
    assert.match(text, /data-sealed-item="message"/);
    assert.match(text, /id="sealed-context"[^>]*data-kind="pair"/);
    assert.match(text, /Sealed conversation/);
    for (const form of sealedForms(text)) assert.doesNotMatch(form, /name="body"/);
    assert.doesNotMatch(text, /Send an invite link/);
    assert.ok(!text.includes("<script>alert(1)"));
    assert.equal(policy(res.headers.get("Content-Security-Policy"))["script-src"], "'self'");
  });

  test("a sealed reply reaches the product as its sealed parts", async () => {
    const sent = since();
    await post(`/me/messages/${CONVERSATION}/send`, { sealed_header: "eyJt", sealed_ciphertext: B64(30), body: "never" });
    assert.deepEqual(JSON.parse(sent()[0]!.body!), { sealed: { header: "eyJt", ciphertext: B64(30) } });
  });

  test("starting one takes the key first, then carries its encryption key for the browser to lock the secret to", async () => {
    const other = "e5f6".repeat(16);
    const { text } = await page(`/me/messages/new?sealed=1&to=${other}`);
    assert.match(text, /data-seal="start"/);
    assert.match(text, new RegExp(`data-recipient="[^"]*${other}`));
    const sent = since();
    await post("/me/messages/new", {
      sealed: "1", to: other, sealed_commitment: "ab".repeat(32),
      sealed_locks: JSON.stringify({ [SECOND]: "cd".repeat(80), [other]: "ef".repeat(80) }),
      sealed_header: "eyJo", sealed_ciphertext: B64(30), body: "never",
    });
    const body = JSON.parse(sent()[0]!.body!);
    assert.deepEqual(body, { to: [other], sealed: { commitment: "ab".repeat(32), locks: { [SECOND]: "cd".repeat(80), [other]: "ef".repeat(80) }, header: "eyJo", ciphertext: B64(30) } });
  });
});

describe("the key's own page, a new space, and Disconnect", () => {
  test("the key's page carries the sealing panel with its published key, and the script that says what this browser holds", async () => {
    const { text } = await page("/me");
    assert.match(text, /id="sealing-panel" data-published="2222/);
    assert.match(text, /3333 3333 3333/);
    assert.match(text, /data-turn-on/);
  });

  test("turning sealing on passes the statement and the passkey's signature on, and nothing without them", async () => {
    let sent = since();
    const signed = { credential_id: B64(22), client_data_json: B64(60), authenticator_data: B64(50), signature: B64(64) };
    assert.equal((await post("/me/encryption-key", { statement: B64(80), ...signed })).res.status, 303);
    assert.deepEqual(JSON.parse(sent()[0]!.body!), { statement: B64(80), alg: "webauthn", ...signed });
    sent = since();
    assert.equal((await post("/me/encryption-key", { statement: B64(80) })).res.status, 400);
    assert.deepEqual(sent(), []);
  });

  test("a new sealed space goes with the first key the browser made, and admits by join request; without that key, nothing is made", async () => {
    let sent = since();
    const fields = { name: "new-vault", title: "New", visibility: "sealed", join_policy: "invite", category_1: "general" };
    const refused = await post("/me/new", fields);
    assert.equal(refused.res.status, 400);
    assert.match(refused.text, /first key is made in your browser/);
    assert.deepEqual(sent(), []);
    sent = since();
    const made = await post("/me/new", { ...fields, sealed_space_id: SPACE_ID, sealed_commitment: "ab".repeat(32), sealed_lock: "cd".repeat(80) });
    assert.equal(made.res.status, 303, made.text.slice(0, 400));
    const body = JSON.parse(sent()[0]!.body!);
    assert.equal(body.visibility, "sealed");
    assert.equal(body.join_policy, "request");
    assert.deepEqual(body.sealed, { space_id: SPACE_ID, commitment: "ab".repeat(32), lock: "cd".repeat(80) });
  });

  test("Disconnect clears what this site kept in the browser", async () => {
    const value = (await createSession({ token: "leaving-token", peerId: SECOND, expiresAt: Date.now() + 3600_000 }, "192.0.2.62"))!;
    const leaving = (await readSessionOf(value))!;
    const res = await handleRequest(new Request(`${SITE}/sign-out`, {
      method: "POST",
      headers: { Cookie: `__Host-schellingaf_session=${value}`, Origin: SITE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: leaving.csrf }).toString(),
    }), env);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Clear-Site-Data"), '"storage"');
  });
});

// A sealed space is not private, so a check written `=== "private"` treats it as public.
// Every access check is written `!== "public"`, nothing in src/ compares a visibility with
// "private", and a page that puts one into words looks it up (whoCanRead).
test("no code compares a visibility with private: an access check is written !== \"public\"", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const found: string[] = [];
  for (const file of readdirSync(new URL("../src/", import.meta.url))) {
    if (!/\.(ts|js)$/.test(file)) continue;
    const text = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    text.split("\n").forEach((line: string, i: number) => {
      if (/[!=]==?\s*["']private["']|["']private["']\s*[!=]==?/.test(line)) found.push(`src/${file}:${i + 1}`);
    });
  }
  assert.deepEqual(found, []);
});
