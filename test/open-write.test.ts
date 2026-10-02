// Open write, on the site: a public work space any key posts in without joining, the mark
// on a post whose author held no role in its space, a post the owner or an admin hid, and
// a key they blocked from posting.
//
// Driven through handleRequest() against a stand-in for the product whose capability
// document lists the join policy open. One public work space, open-notes: #1 by its owner,
// #2 by a key with no role, #3 hidden, and #4 the owner's reply to #3. The stand-in
// DELIBERATELY still sends #3's words, fingerprint, data and signed bytes, as a broken or
// hostile service might: the site must show none of them, on any page, in any format.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CAPABILITIES, CATEGORIES, json, refusal, service, type Json, type World } from "./lib/service.ts";
import { signedInProblems, tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const STRANGER = "5e5e".repeat(16);
const BLOCKED = "b10c".repeat(16);
const OPEN_ID = "0199f0f0-0000-7000-8000-000000000001";
const DOC_ID = "0199f0f0-0000-7000-8000-000000000002";
const id = (n: number) => `0199f1f1-0000-7000-8000-${String(n).padStart(12, "0")}`;
const docId = (n: number) => `0199f2f2-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = (n: number) => `2026-09-19T10:0${n}:00.000Z`;
const hex = (b: string) => b.repeat(32);
const b64u = (text: string) => Buffer.from(text, "utf8").toString("base64url");

/** What the hidden post carries as the stand-in sends it, each of which must reach no page. */
const CANARY = "CANARY-OPEN-WRITE-7f3a";
const CANARY_PRINT = "canary-print-91c4";
const CANARY_SIGNATURE = "c0de".repeat(32);
const CANARY_PRIVATE = b64u(`private ${CANARY}`);
const CANARY_CANONICAL = b64u(JSON.stringify({ v: 1, title: `Hidden ${CANARY}` }));
/** A key it was sent to, a run it belongs to, and the sealed parts a broken service sent. */
const CANARY_TO = "ca11".repeat(16);
const CANARY_RUN = "0199ca11-0000-7000-8000-00000000ca11";
const CANARY_SEALED = b64u(`sealed ${CANARY}`);
/** What a hidden version of an oracle space carries as the stand-in sends it. */
const CANARY_VERSION = "CANARY-HIDDEN-VERSION-44e1";
const CANARIES = [CANARY, CANARY_PRINT, CANARY_SIGNATURE, CANARY_PRIVATE, CANARY_CANONICAL, CANARY_TO, CANARY_RUN, CANARY_SEALED, CANARY_VERSION];
const REVIEWER = CAPABILITIES.modules.oracle_spaces.service_reviewer as string;

/** A capability document that takes posts from any key in a public work space, with the
 *  numbers the product publishes for it. */
const OPEN_CAPABILITIES: Json = {
  ...CAPABILITIES,
  join_policies: ["invite", "request", "open"],
  modules: {
    ...CAPABILITIES.modules,
    open_write: {
      status: "available",
      post: "POST /v1/spaces/{name}/posts in a public work space with join_policy open, without joining",
      mark: "a POST from a KEY with no role in its SPACE carries no_role: true, here and in an oracle space",
      govern: "its owner or an admin blocks a KEY from posting and hides a POST",
    },
  },
  rate_limits: {
    writes_per_peer: { per_minute: 30, burst: 60 },
    open_posts_per_peer: { per_day: 60, first_day: 10 },
    open_posts_per_space: { per_day: 10000 },
  },
};

const space = (name: string, fields: Json = {}): Json => ({
  name, space_id: OPEN_ID, title: "Open notes", description: "Notes any key posts.", visibility: "public", join_policy: "open",
  status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: OWNER,
  contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-19T09:00:00.000Z",
  ...fields,
});
const post = (seq: number, fields: Json): Json => ({
  post_id: id(seq), space: "open-notes", seq: String(seq), author: OWNER, posted_at: at(seq), title: null,
  to: [], reply_to: null, supersedes: null, retracts: null, fingerprints: [], signed: false, space_id: OPEN_ID, object_id: hex(`0${seq}`),
  ...fields,
});
const docPost = (seq: number, fields: Json): Json => ({
  ...post(seq, fields), post_id: docId(seq), space: "notes-doc", space_id: DOC_ID, object_id: hex(`a${seq}`), ...fields,
});

const openPosts = [
  post(1, { kind: "obs", title: "The owner's first note", body: "Arm64 builds need the full image." }),
  post(2, { kind: "result", author: STRANGER, title: "A stranger's result", body: "It built on arm64 with slim.", no_role: true }),
  post(3, {
    kind: "obs", author: STRANGER, title: `Hidden ${CANARY}`, body: `The zebras ${CANARY} body.`,
    fingerprints: [{ scheme: "canary", value: CANARY_PRINT }], data: { x_canary: CANARY }, no_role: true,
    to: [CANARY_TO], budget: { observed_at: "2026-09-19T10:00:00Z", x_canary: CANARY }, run_id: CANARY_RUN,
    sealed: { generation: "1", bytes: 99, header: CANARY_SEALED, ciphertext: CANARY_SEALED },
    unavailable: { state: "hidden", since: "2026-09-19T12:00:00.000Z" },
  }),
  post(4, { kind: "obs", title: "An answer to the hidden one", body: "Noted.", reply_to: id(3) }),
];

/** A post's link in its space's chain, by the formula src/verify.ts checks: so a hidden
 *  post's link is shown to be checked, and to hold, with its words gone. */
const label = (name: string) => Buffer.concat([Buffer.from(`agent-state:${name}:v1`), Buffer.from([0])]);
const int8 = (n: string) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; };
const linkOf = (p: Json): string => createHash("sha256").update(Buffer.concat([
  label("object-chain"), Buffer.from(String(p.space_id).replace(/-/g, ""), "hex"), int8(p.seq),
  Buffer.from(hex("ad"), "hex"), Buffer.from(hex("9e"), "hex"), Buffer.from(p.object_id, "hex"),
])).digest("hex");

/** A post's proof as the service answers it: unsigned, and its object not checking out,
 *  but its link in the chain the formula's. */
const proofOf = (p: Json, over: Json = {}): Json => ({
  post: {
    ...p,
    proof: {
      object_id: p.object_id, canonical: b64u(JSON.stringify({ v: 1, title: p.title })), signature: null,
      chain: { seq: p.seq, admission: hex("ad"), previous_hash: hex("9e"), chain_hash: linkOf(p) },
      ...over,
    },
  },
  leaf: hex("1e"), checkpoint: null, inclusion: null,
});

const world: World = {
  capabilities: OPEN_CAPABILITIES,
  categories: CATEGORIES,
  spaces: [
    space("open-notes"),
    space("ask-notes", { space_id: "0199f0f0-0000-7000-8000-000000000003", title: "Ask notes", join_policy: "request" }),
    space("quiet-notes", { space_id: "0199f0f0-0000-7000-8000-000000000004", title: "Quiet notes", visibility: "private", join_policy: "request" }),
    space("odd-notes", { space_id: "0199f0f0-0000-7000-8000-000000000005", title: "Odd notes", join_policy: "zzz" }),
    space("notes-doc", { space_id: DOC_ID, title: "Notes document", join_policy: "request", oracle: true, service_reviewer: true, forked_from: null }),
    // Beside open-notes, and a name open-notes is the start of, so a forget that took every
    // address beginning /spaces/open-notes would take this one's too.
    space("open-notes-2", { space_id: "0199f0f0-0000-7000-8000-000000000006", title: "More open notes" }),
    // An oracle space whose document stands at a version the stand-in says is hidden,
    // still carrying its words: the service never hides a version, and a page must not
    // take that for granted.
    space("hidden-doc", { space_id: "0199f0f0-0000-7000-8000-000000000007", title: "A hidden version", join_policy: "request", oracle: true, service_reviewer: false, forked_from: null }),
  ],
  posts: {
    "open-notes": openPosts,
    "ask-notes": [], "quiet-notes": [], "odd-notes": [],
    "notes-doc": [
      docPost(1, { kind: "version", author: STRANGER, title: "First text", body: "# Notes\n\nUse slim.", no_role: true }),
      docPost(2, { kind: "obs", author: STRANGER, title: "A remark", body: "Slim breaks on arm64.", no_role: true }),
      docPost(3, { kind: "go", author: OWNER, body: "Fine.", reply_to: docId(1) }),
      // A remark from the service's own reviewer, whose key is never offered to be blocked.
      docPost(4, { kind: "obs", author: REVIEWER, title: "A note from the reviewer", body: "Kept." }),
    ],
    "open-notes-2": [
      { ...post(1, { kind: "obs", title: "A neighbour's note", body: "Held apart." }), post_id: "0199f4f4-0000-7000-8000-000000000001", space: "open-notes-2", space_id: "0199f0f0-0000-7000-8000-000000000006" },
    ],
    "hidden-doc": [{
      ...post(1, { kind: "version", author: STRANGER, title: `Summary ${CANARY_VERSION}`, body: `# Text\n\n${CANARY_VERSION}`, no_role: true,
        unavailable: { state: "hidden", since: "2026-09-19T12:00:00.000Z" } }),
      post_id: "0199f3f3-0000-7000-8000-000000000001", space: "hidden-doc", space_id: "0199f0f0-0000-7000-8000-000000000007",
    }],
  },
  versions: {
    "notes-doc": [{
      post_id: docId(1), seq: "1", author: STRANGER, posted_at: at(1), summary: "First text", signed: false, no_role: true,
      state: "current", edits: null, same_text_as: null,
      decision: { post_id: docId(3), seq: "3", kind: "go", author: OWNER, reason: "Fine.", at: at(3) },
    }],
    "hidden-doc": [{
      post_id: "0199f3f3-0000-7000-8000-000000000001", seq: "1", author: STRANGER, posted_at: at(1), summary: `Summary ${CANARY_VERSION}`,
      signed: false, no_role: true, state: "current", edits: null, same_text_as: null, decision: null,
      unavailable: { state: "hidden", since: "2026-09-19T12:00:00.000Z" },
    }],
  },
  proofs: {
    "open-notes/1": proofOf(openPosts[0]!),
    "open-notes/2": proofOf(openPosts[1]!),
    "open-notes/3": proofOf(openPosts[2]!, {
      canonical: CANARY_CANONICAL, private: CANARY_PRIVATE,
      signature: { alg: "ed25519", value: CANARY_SIGNATURE, public_key: hex("ab") },
    }),
    "open-notes/4": proofOf(openPosts[3]!),
  },
  checkpoints: { "open-notes": [] },
  peers: {},
  blocks: {
    "open-notes": [
      { peer_id: BLOCKED, blocked_at: "2026-09-19T11:00:00.000Z" },
      // A key in no shape the service writes one, which gets no button.
      { peer_id: "<script>alert(1)</script>", blocked_at: "not a time <b>bold</b>" },
    ],
  },
};

// ── the stand-in, which answers each signed-in key's own access to a space ──────────

/** Each session's token, its key, and what the service says that key may do in any space. */
const TOKENS: Record<string, { peer: string; access: Json }> = {
  "Bearer owner-token": { peer: OWNER, access: { role: "owner", tags: [], read: true, post: true, pending_request: null } },
  "Bearer stranger-token": { peer: STRANGER, access: { role: null, tags: [], read: true, post: true, pending_request: null } },
  "Bearer blocked-token": { peer: BLOCKED, access: { role: null, tags: [], read: true, post: false, blocked: true, pending_request: null } },
};
/** Whether the stand-in refuses a post for how often it came. */
let RATE_LIMITED = false;
/** What hiding or showing a post answers, by its id, over the stand-in's own: whether it
 *  changed anything, and the space it names. */
const HIDE_ANSWERS: Record<string, Json> = {
  [id(4)]: { changed: false },
  [id(5)]: { name: "open-notes-2" },
};
/** A read the stand-in holds back until the test lets it go, by its path. */
const GATES = new Map<string, Promise<void>>();

const base = service(world);
const { fake, handleRequest } = await site(async (call) => {
  const who = TOKENS[call.headers.get("authorization") ?? ""];
  const path = call.url.pathname;
  const where = `${call.method} ${path}`;
  let m: RegExpMatchArray | null;
  if (GATES.has(path)) await GATES.get(path);
  if (path === "/v1/conversations") return json({ items: [], unread_conversations: 0, requests_waiting: 0 });
  if (path === "/v1/mailbox") return json({ items: [], next_after: null, has_more: false, head_seq: "0" });
  if (call.method === "GET" && /^\/v1\/spaces\/[a-z0-9-]+$/.test(path) && who) {
    const res = base(call);
    if (!res.ok) return res;
    const body = await res.json();
    return json({ ...body, access: { ...(body.access ?? {}), ...who.access, ...(body.oracle === true ? { decide: who.access.role === "owner" } : {}) } });
  }
  if (where === "POST /v1/spaces/open-notes/posts") {
    if (who?.access.blocked) return refusal(403, "WRITE_BLOCKED");
    if (RATE_LIMITED) return refusal(429, "RATE_LIMITED");
    return json({ post_id: id(9), seq: "9" }, 201);
  }
  if (where === "POST /v1/spaces/open-notes/join") {
    return json({ state: "open", name: "open-notes", notice: "Nothing to join here: POST. A POST from a KEY with no role here carries no_role: true." });
  }
  if ((m = path.match(/^\/v1\/posts\/([0-9a-f-]{36})\/hidden$/))) {
    if (m[1] === id(1)) return refusal(403, "CONTROL_DENIED");
    if (m[1] === docId(1)) return refusal(400, "INVALID_REQUEST", "INVALID_REQUEST", "every version and every decision of an oracle space stays in public");
    return json({ space_id: OPEN_ID, name: "open-notes", post_id: m[1], seq: "2", hidden: call.method === "PUT", revision: "9", changed: true, ...HIDE_ANSWERS[m[1]!] });
  }
  if ((m = path.match(/^\/v1\/spaces\/open-notes\/blocks\/([0-9a-f]{64})$/)) && call.method !== "GET") {
    return json({ space_id: OPEN_ID, name: "open-notes", peer_id: m[1], blocked: call.method === "PUT", revision: "10", changed: true });
  }
  if (where === "POST /v1/spaces") return json({ name: JSON.parse(call.body ?? "{}").name }, 201);
  if (call.method === "PATCH") return json({});
  return base(call);
});

const { entryPoliciesOf } = await import("../src/spaces.ts");
const { refusalText, postLimitWords } = await import("../src/signed-in.ts");
const { blocksHtml, eventsHtml, formShell, mailboxHtml, BLOCKED_WORDS, NO_ROLE_ORACLE_WORDS, NO_ROLE_POST_WORDS, NO_ROLE_REPLY_WORDS, OPEN_ONLY_PUBLIC_WORK } =
  await import("../src/me-render.ts");
const { operationPages, today } = await import("../content/api-overview.mjs");

async function sessionOf(token: string, peerId: string, ip: string) {
  const { cookie, csrf } = await signedIn(peerId, token, ip);
  return { cookie, csrf, peerId };
}
const owner = await sessionOf("owner-token", OWNER, "192.0.2.201");
const stranger = await sessionOf("stranger-token", STRANGER, "192.0.2.202");
const blocked = await sessionOf("blocked-token", BLOCKED, "192.0.2.203");
type Who = typeof owner;

async function get(path: string, who?: Who) {
  const res = await handleRequest(new Request(`${SITE}${path}`, who ? { headers: { Cookie: who.cookie } } : {}), env);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

async function send(who: Who, path: string, fields: Record<string, string>) {
  const before = fake.calls.length;
  const res = await handleRequest(new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { Origin: SITE, Cookie: who.cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: who.csrf, ...fields }).toString(),
  }), env);
  const writes = fake.calls.slice(before).filter((c) => c.method !== "GET");
  return { status: res.status, text: await res.text(), location: res.headers.get("Location"), writes };
}

const radios = (html: string, name: string) =>
  tags(html).filter((t) => t.name === "input" && t.attributes.some(([n, v]) => n === "name" && v === name));
const valueOf = (t: { attributes: [string, string | null][] }) => t.attributes.find(([n]) => n === "value")?.[1];
const isChecked = (t: { attributes: [string, string | null][] }) => t.attributes.some(([n]) => n === "checked");
const checkedValues = (html: string, name: string) => radios(html, name).filter(isChecked).map(valueOf);
const formsTo = (html: string, action: string) =>
  tags(html).filter((t) => t.name === "form" && t.attributes.some(([n, v]) => n === "action" && v === action));

// ── the words, in all three formats ─────────────────────────────────────────────────

describe("a work space any key posts in, on the public pages", () => {
  test("the lists offer its way in only when the capability document names it", () => {
    assert.deepEqual(entryPoliciesOf(OPEN_CAPABILITIES), ["invite", "request", "open"]);
    assert.deepEqual(entryPoliciesOf(CAPABILITIES), ["invite", "request"], "a capability document that does not list it");
    assert.deepEqual(entryPoliciesOf({}), ["invite", "request"], "the fallback, which names none");
    assert.deepEqual(entryPoliciesOf({ join_policies: ["open\n# injected"] }), ["invite", "request"]);
  });

  test("the work spaces' list names the way in, and its facet, in all three formats", async () => {
    const html = (await get("/spaces")).text;
    assert.match(html, /<a class="tag" href="\/spaces\/by\/entry\/open">post without joining<\/a>/);
    assert.match(html, /<span class="tag">post without joining<\/span>/, "the row of the space that takes posts this way");
    const md = (await get("/spaces.md")).text;
    assert.match(md, /How to join: invite link only, \/spaces\/by\/entry\/invite\.md; ask to join, \/spaces\/by\/entry\/request\.md; post without joining, \/spaces\/by\/entry\/open\.md/);
    assert.match(md, /- join_policy: open/);
    const doc = JSON.parse((await get("/spaces.json")).text);
    assert.ok(doc.browse.by_entry.includes("/spaces/by/entry/open"));
  });

  test("its facet lists the work spaces any key posts in, followed and never listed", async () => {
    const page = await get("/spaces/by/entry/open");
    assert.equal(page.status, 200);
    assert.match(page.text, /<h1>Work spaces you post in without joining<\/h1>/);
    assert.match(page.text, /href="\/spaces\/open-notes">Open notes<\/a>/);
    assert.doesNotMatch(page.text, /href="\/spaces\/ask-notes"/);
    assert.match(page.text, /<meta name="robots" content="noindex, follow">/);
    assert.match((await get("/spaces/by/entry/open.md")).text, /^# Work spaces you post in without joining/);
    assert.equal(JSON.parse((await get("/spaces/by/entry/open.json")).text).title, "Work spaces you post in without joining");
  });

  test("the space's own page says who can write, links the others that take posts so, and offers to post with a key", async () => {
    const html = (await get("/spaces/open-notes")).text;
    assert.match(html, /<dt>who can write<\/dt><dd>any key, without joining: a post goes in at once, is marked not a member, and does not make its author a member\. The owner or an admin can block a key from posting and hide a post\.<\/dd>/);
    assert.match(html, /<a href="\/spaces\/by\/entry\/open">work spaces you post in without joining<\/a>/);
    assert.match(html, /Open this space with your key<\/a> to post in it without joining, or to reply to a post\./);
    const md = (await get("/spaces/open-notes.md")).text;
    assert.match(md, /- who can write: any key, without joining: .* A post from a key with no role here carries no_role: true\./);
    const doc = JSON.parse((await get("/spaces/open-notes.json")).text);
    assert.match(doc.who_can_write, /^any key, without joining/);
    assert.equal(doc.space.join_policy, "open");
  });

  test("a way in this site has no words for is said as such, never as asking to join", async () => {
    const html = (await get("/spaces/odd-notes")).text;
    assert.match(html, /<dt>how to join<\/dt><dd>in a way this site has no words for<\/dd>/);
    assert.doesNotMatch(html, /ask to join; the owner/);
    assert.match((await get("/spaces")).text, /<span class="tag">joins in a way this site has no words for<\/span>/);
    assert.match(html, /Open this space with your key<\/a> to see what your key may do in it\./);
    assert.doesNotMatch(html, /to ask to join it/);
  });

  test("the Vocabulary page explains the new words and the limits, from the capability document", async () => {
    const doc = JSON.parse((await get("/vocabulary.json")).text);
    const word = (w: string) => doc.words.find((x: { word: string }) => x.word === w)?.meaning as string;
    assert.match(word("post without joining"), /any key posts in it at once, without asking and without becoming a member/);
    assert.match(word("not a member"), /held no role in its space when it was posted/);
    assert.match(word("blocked from posting"), /Not the same as a block, which stops a key messaging you\./);
    assert.match(word("hidden"), /keeps its number and its place in the chain, and nothing is deleted/);
    assert.match(word("hidden"), /Seek does not find it/);
    assert.match(word("hidden"), /the service shows its words to no reader, members included/);
    assert.match(word("hidden"), /This site's public pages stop showing them within half an hour\./);
    assert.doesNotMatch(word("hidden"), /nobody reads/);
    assert.equal(word("withheld"), "Kept from every reader by the operator, members included. Nothing is deleted.");
    assert.match(word("block"), /are not shown to you/);
    const open = doc.join_policies.find((p: { name: string }) => p.name === "open");
    assert.match(open.meaning, /^post without joining: any key posts at once without becoming a member/);
    const limits = doc.limits.map((l: { meaning: string }) => l.meaning);
    for (const line of [
      "One key posts at most 60 times a day where it holds no role: in work spaces anyone posts in, and in oracle spaces' discussions.",
      "A key posts at most 10 times on its first day where it holds no role.",
      "A work space any key posts in takes at most 10,000 posts a day from keys that hold no role in it.",
    ]) assert.ok(limits.includes(line), line);
    const html = (await get("/vocabulary")).text;
    assert.doesNotMatch(html, /Hidden by the operator/);
    assert.match(html, /<dt>post without joining<\/dt>/);
  });
});

describe("the mark on a post whose author held no role", () => {
  test("is beside its author in the stream, the archive and its own page, in all three formats, and on no other post", async () => {
    const stream = (await get("/spaces/open-notes")).text;
    assert.match(stream, /#2<\/a> &middot; [^<]+ &middot; by <a href="\/peers\/5e5e[0-9a-f]+"><code[^>]*>[^<]+<\/code><\/a> &middot; not a member/);
    assert.equal(stream.split("&middot; not a member").length - 1, 2, "#2 and the hidden #3, which keeps its mark; never #1 or #4");
    assert.match((await get("/spaces/open-notes.md")).text, /posted 2026-09-19T10:02:00\.000Z by 5e5e[0-9a-f]+, not a member/);
    const posts = JSON.parse((await get("/spaces/open-notes.json")).text).posts;
    assert.equal(posts.find((p: Json) => p.seq === "2").no_role, true);
    assert.equal("no_role" in posts.find((p: Json) => p.seq === "1"), false, "absent, not false, as the service sends it");
    assert.match((await get("/spaces/open-notes/all")).text, /&middot; not a member/);
    assert.match((await get("/spaces/open-notes/all.md")).text, /- not a member: its author held no role in this space when it was posted/);
    const page = await get("/spaces/open-notes/2");
    assert.match(page.text, /by <a href="\/peers\/5e5e[0-9a-f]+"><code[^>]*>[^<]+<\/code><\/a> &middot; not a member/);
    assert.match((await get("/spaces/open-notes/2.md")).text, /- not a member: its author held no role in this space when it was posted/);
    assert.equal(JSON.parse((await get("/spaces/open-notes/2.json")).text).post.no_role, true);
    assert.doesNotMatch((await get("/spaces/open-notes/1")).text, /not a member/);
  });

  test("is on an oracle space's version and its discussion too", async () => {
    const history = await get("/spaces/notes-doc/history");
    assert.match(history.text, /&middot; not a member/);
    assert.match((await get("/spaces/notes-doc/history.md")).text, /- not a member: its author held no role in this space when it was posted/);
    assert.equal(JSON.parse((await get("/spaces/notes-doc/history.json")).text).versions[0].no_role, true);
    const page = (await get("/spaces/notes-doc")).text;
    assert.match(page, /Version <a href="\/spaces\/notes-doc\/1">#1<\/a>, by [^\n]+ &middot; not a member\./, "the document's own version");
    assert.match(page, /#2<\/a> &middot; [^<]+ &middot; by <a[^>]+><code[^>]*>[^<]+<\/code><\/a> &middot; not a member/, "the discussion");
  });
});

// ── a hidden post, whose words the stand-in still sends ─────────────────────────────

describe("a hidden post", () => {
  const pages = [
    "/spaces/open-notes", "/spaces/open-notes/all", "/spaces/open-notes/3", "/spaces/open-notes/3/replies",
    "/spaces/open-notes/4", "/spaces/open-notes/standing", "/seek?q=zebras",
  ];

  for (const path of pages) {
    test(`shows none of its words on ${path}, in all three formats`, async () => {
      const [p, q] = path.split("?") as [string, string | undefined];
      for (const address of [path, `${p}.md${q ? `?${q}` : ""}`, `${p}.json${q ? `?${q}` : ""}`]) {
        const { status, text } = await get(address);
        assert.equal(status, 200, `${address}: ${text.slice(0, 200)}`);
        for (const canary of CANARIES) assert.ok(!text.includes(canary), `${address} carries ${canary.slice(0, 24)}`);
      }
    });
  }

  test("shows none of its words to a signed-in owner either, whose pages the service answers as a member's", async () => {
    for (const path of ["/me/spaces/open-notes", "/me/spaces/open-notes/3", "/me/spaces/open-notes/all", "/me/spaces/open-notes/4", "/me/seek?q=zebras"]) {
      const { status, text } = await get(path, owner);
      assert.equal(status, 200, path);
      for (const canary of CANARIES) assert.ok(!text.includes(canary), `${path} carries ${canary.slice(0, 24)}`);
    }
  });

  test("keeps its place, says who hid it, and its page is followed and never listed", async () => {
    const stream = (await get("/spaces/open-notes")).text;
    assert.match(stream, /This post is hidden by the owner or an admin of its space\. Its place is kept; its words are not shown\./);
    const page = await get("/spaces/open-notes/3");
    assert.match(page.text, /<h1>Post 3<\/h1>/);
    assert.match(page.text, /This post is hidden by the owner or an admin of its space\./);
    assert.match(page.text, /<meta name="robots" content="noindex, follow">/);
    assert.equal(page.headers.get("X-Robots-Tag"), "noindex, follow");
    assert.match(page.text, /The owner or an admin of its space hid this post, so its signed bytes are not shown and this site could not check them\./);
    const doc = JSON.parse((await get("/spaces/open-notes/3.json")).text);
    assert.equal(doc.post.title, null);
    assert.equal(doc.post.body, null);
    assert.deepEqual(doc.post.fingerprints, []);
    assert.deepEqual(doc.post.unavailable, { state: "hidden", since: "2026-09-19T12:00:00.000Z" });
    assert.equal(doc.post.no_role, true, "the mark stays on a hidden post");
    assert.equal(doc.verification.signature, "hidden");
    assert.equal(doc.verification.proof.canonical, null);
    assert.equal(doc.verification.proof.signature, null);
    assert.equal(doc.verification.chain, "holds", "its link in the chain is still checked");
    assert.match((await get("/spaces/open-notes/3.md")).text, /This post is hidden by the owner or an admin of its space\. Its place is kept\./);
  });

  test("is left out of Seek, which the service would never return it from", async () => {
    const { text } = await get("/seek?q=zebras");
    assert.doesNotMatch(text, /href="\/spaces\/open-notes\/3"/);
    assert.match(text, /No post in a public space matches\./);
    assert.deepEqual(JSON.parse((await get("/seek.json?q=zebras")).text).items, []);
  });

  test("an oracle space's version the service calls hidden keeps none of its words, its summary included, and says so", async () => {
    for (const path of ["/spaces/hidden-doc", "/spaces/hidden-doc/history", "/spaces/hidden-doc/1", "/spaces/hidden-doc/all"]) {
      for (const f of ["", ".md", ".json"]) {
        const { status, text } = await get(`${path}${f}`);
        assert.equal(status, 200, `${path}${f}: ${text.slice(0, 200)}`);
        assert.ok(!text.includes(CANARY_VERSION), `${path}${f} carries the hidden version's words`);
      }
    }
    assert.match((await get("/spaces/hidden-doc")).text, /This version is hidden by the owner or an admin of its space\. Its place in the history is kept; its text is not shown\./);
    assert.doesNotMatch((await get("/spaces/hidden-doc")).text, /withheld by the operator/);
    assert.match((await get("/spaces/hidden-doc/history")).text, /This version is hidden by the owner or an admin of its space\. Its place is kept; its text is not shown\./);
    assert.match((await get("/spaces/hidden-doc/history.md")).text, /- hidden by the owner or an admin of its space: its text is not shown/);
    const row = JSON.parse((await get("/spaces/hidden-doc/history.json")).text).versions[0];
    assert.equal(row.summary, null);
    assert.equal(row.snippet, null);
  });

  test("in a mailbox is said to be hidden, with none of its words, and a post with no role is marked", () => {
    const viewer = { peerId: OWNER, csrf: "c".repeat(43) };
    const html = mailboxHtml(formShell("Mailbox", viewer), viewer, [
      { mailbox_seq: "1", reason: "reply", post: { ...openPosts[2], snippet: `A ${CANARY} snippet` } as any },
      { mailbox_seq: "2", reason: "to", post: { ...openPosts[1], snippet: "It built." } as any },
    ], "0", null, "2");
    for (const canary of CANARIES) assert.ok(!html.includes(canary), canary);
    assert.match(html, /This post is hidden by the owner or an admin of its space\./);
    assert.equal(html.split("&middot; not a member").length - 1, 2);
  });
});

// ── a key with no role, signed in ───────────────────────────────────────────────────

describe("a key with no role, in a work space any key posts in", () => {
  test("is offered the post form, told how its posts are marked, and not asked to join", async () => {
    const { status, text } = await get("/me/spaces/open-notes", stranger);
    assert.equal(status, 200);
    assert.ok(text.includes(NO_ROLE_POST_WORDS.replace(/'/g, "&#39;")), "the line above the form");
    assert.equal(formsTo(text, "/me/spaces/open-notes/posts").length, 1);
    assert.doesNotMatch(text, /Ask to join<\/button>/);
    assert.doesNotMatch(text, /Ask for an invite link/);
    assert.match(text, /<script type="module" src="\/sign-post\.js"><\/script>/, "a passkey may sign it");
    assert.deepEqual(signedInProblems(text), []);
  });

  test("posts, and a reply is marked the same way", async () => {
    const r = await send(stranger, "/me/spaces/open-notes/posts", { kind: "obs", body: "From outside.", idempotency_key: "s".repeat(24) });
    assert.equal(r.status, 303);
    assert.equal(r.location, "/me/spaces/open-notes/9?notice=posted");
    assert.equal(r.writes.length, 1);
    const reply = (await get("/me/spaces/open-notes/1", stranger)).text;
    assert.ok(reply.includes(NO_ROLE_REPLY_WORDS));
    assert.doesNotMatch(reply, /id="moderate"/, "nothing to hide or block for a key with no role");
  });

  test("that asks to join is told there is nothing to join", async () => {
    const r = await send(stranger, "/me/spaces/open-notes/join", { message: "May I?" });
    assert.equal(r.location, "/me/spaces/open-notes?notice=no-joining");
    assert.match((await get(r.location!, stranger)).text, /This space takes posts from any key without joining, so there was nothing to join\./);
  });

  test("blocked from posting is told so, is offered no form, and a post is refused in words", async () => {
    const { text } = await get("/me/spaces/open-notes", blocked);
    assert.ok(text.includes(BLOCKED_WORDS));
    assert.equal(formsTo(text, "/me/spaces/open-notes/posts").length, 0);
    assert.ok((await get("/me/spaces/open-notes/1", blocked)).text.includes(BLOCKED_WORDS));
    const r = await send(blocked, "/me/spaces/open-notes/posts", { kind: "obs", body: "Again.", idempotency_key: "b".repeat(24) });
    assert.equal(r.status, 403);
    assert.match(r.text, /has blocked your key from posting in it, and from asking to join it\. Nothing was sent\. You can still read it\./);
    // A block refuses a join request too, so a space people ask to join offers it none;
    // an invite link still lets a key in, and the block still stops it posting.
    const ask = (await get("/me/spaces/ask-notes", blocked)).text;
    assert.ok(ask.includes(BLOCKED_WORDS));
    assert.doesNotMatch(ask, /Ask to join<\/button>/);
    assert.match(ask, /Join with an invite code or link/);
    assert.match((await get("/me/spaces/ask-notes", stranger)).text, /Ask to join<\/button>/, "a key nobody blocked is offered it");
  });

  test("posting too often is told the service's own numbers", async () => {
    RATE_LIMITED = true;
    try {
      const r = await send(stranger, "/me/spaces/open-notes/posts", { kind: "obs", body: "Once more.", idempotency_key: "r".repeat(24) });
      assert.equal(r.status, 429);
      assert.match(r.text, /Where it holds no role, it posts at most 60 times a day, and 10 on its first day\./);
      assert.match(r.text, /A work space any key posts in takes at most 10,000 posts a day from keys that hold no role in it\./);
    } finally {
      RATE_LIMITED = false;
    }
    assert.equal(postLimitWords({}), "Too many posts in a short time, so nothing was posted. Wait, and try again later.", "no number it was not given");
  });

  test("in an oracle space is told what it proposes or posts is marked", async () => {
    const { text } = await get("/me/spaces/notes-doc", stranger);
    assert.ok(text.includes(NO_ROLE_ORACLE_WORDS));
  });
});

// ── the owner or an admin ───────────────────────────────────────────────────────────

describe("the owner or an admin", () => {
  test("is offered Hide and Block on another key's post, guarded, and nothing on their own", async () => {
    const { text } = await get("/me/spaces/open-notes/2", owner);
    assert.match(text, /<button type="submit" data-guard disabled>Hide this post<\/button>/);
    assert.match(text, /<button type="submit" data-guard disabled>Block its author from posting here<\/button>/);
    const hide = formsTo(text, "/me/spaces/open-notes/hide");
    assert.equal(hide.length, 1);
    assert.match(text, new RegExp(`name="post" value="${id(2)}"`));
    assert.match(text, /<script src="\/allow\.js"><\/script>/);
    assert.deepEqual(signedInProblems(text), []);
    assert.match(text, /<h2>Hide this post, or block its author from posting<\/h2>/);
    assert.match(text, /This site(?:'|&#39;)s public pages stop showing them within half an hour\./);
    assert.doesNotMatch(text, /nobody reads/);
    assert.doesNotMatch((await get("/me/spaces/open-notes/1", owner)).text, /id="moderate"/, "the owner's own post");
    assert.doesNotMatch((await get("/spaces/open-notes/2")).text, /Hide this post|method="post"/, "never on a public page");
  });

  test("is offered to show a hidden post again, guarded as well, since its author would steer a click onto it", async () => {
    const { text } = await get("/me/spaces/open-notes/3", owner);
    assert.match(text, /<button type="submit" data-guard disabled>Show this post again<\/button>/);
    assert.equal(formsTo(text, "/me/spaces/open-notes/unhide").length, 1);
    assert.doesNotMatch(text, />Hide this post</);
    assert.doesNotMatch(text, /needs no script/);
    assert.match(text, /<script src="\/allow\.js"><\/script>/);
  });

  test("is never offered to block the service's own reviewer from posting", async () => {
    const { text } = await get("/me/spaces/notes-doc/4", owner);
    assert.match(text, />Hide this post</);
    assert.doesNotMatch(text, /Block its author from posting here/);
  });

  test("is never offered to hide an oracle space's version, and the service's refusal is said in words", async () => {
    const { text } = await get("/me/spaces/notes-doc/1", owner);
    assert.doesNotMatch(text, />Hide this post</);
    assert.match(text, />Block its author from posting here</);
    const r = await send(owner, "/me/spaces/notes-doc/hide", { post: docId(1), seq: "1" });
    assert.equal(r.status, 400);
    assert.match(r.text, /Every version of an oracle space(?:'|&#39;)s document, and every decision on one, stays readable, so nothing was hidden\./);
  });

  // What reading these pages costs the service now, with no key: nothing when every one
  // of them is held by the page cache.
  const OPEN_PAGES = ["/spaces/open-notes", "/spaces/open-notes.md", "/spaces/open-notes.json", "/spaces/open-notes/2",
    "/spaces/open-notes/2.json", "/spaces/open-notes/3/replies", "/spaces/open-notes/3/replies.md"];
  const NEIGHBOUR_PAGES = ["/spaces/open-notes-2", "/spaces/open-notes-2.md", "/spaces/open-notes-2/1"];
  async function readsFor(path: string): Promise<number> {
    const before = fake.calls.length;
    const { status } = await get(path);
    assert.equal(status, 200, path);
    return fake.calls.slice(before).filter((c) => !c.headers.get("authorization")).length;
  }
  async function warm(paths: string[]): Promise<void> {
    for (const path of paths) await get(path);
    for (const path of paths) assert.equal(await readsFor(path), 0, `${path} is held by the page cache`);
  }

  test("hides a post and shows it again, and the space's held pages, every format, its posts and replies, are read again", async () => {
    await warm([...OPEN_PAGES, ...NEIGHBOUR_PAGES]);
    const r = await send(owner, "/me/spaces/open-notes/hide", { post: id(2), seq: "2" });
    assert.equal(r.status, 303);
    assert.equal(r.location, "/me/spaces/open-notes/2?notice=post-hidden");
    assert.equal(r.writes.length, 1);
    assert.equal(r.writes[0]!.method, "PUT");
    assert.equal(r.writes[0]!.url.pathname, `/v1/posts/${id(2)}/hidden`);
    for (const path of OPEN_PAGES) assert.ok(await readsFor(path) > 0, `${path} is read again after the hide`);
    for (const path of NEIGHBOUR_PAGES) assert.equal(await readsFor(path), 0, `${path}, a neighbour whose name open-notes begins, keeps its copy`);
    const notice = (await get(r.location!, owner)).text;
    assert.match(notice, /Hidden\. The post keeps its number and its place in the chain, and nothing is deleted; the service shows its words to no reader, members included, until it is shown again\. This site(?:'|&#39;)s public pages stop showing them within half an hour\./);
    const shown = await send(owner, "/me/spaces/open-notes/unhide", { post: id(2), seq: "2" });
    assert.equal(shown.location, "/me/spaces/open-notes/2?notice=post-shown");
    assert.equal(shown.writes[0]!.method, "DELETE");
    assert.ok(await readsFor("/spaces/open-notes") > 0, "read again after it is shown");
  });

  test("forgets nothing when the service says the hide changed nothing, or names another space, and never Seek", async () => {
    await warm([...OPEN_PAGES, "/seek?q=arm64"]);
    const same = await send(owner, "/me/spaces/open-notes/hide", { post: id(4), seq: "4" });
    assert.equal(same.location, "/me/spaces/open-notes/4?notice=post-hidden");
    const elsewhere = await send(owner, "/me/spaces/open-notes/hide", { post: id(5), seq: "5" });
    assert.equal(elsewhere.status, 303);
    for (const path of OPEN_PAGES) assert.equal(await readsFor(path), 0, `${path} kept after a hide that changed nothing here`);
    await send(owner, "/me/spaces/open-notes/hide", { post: id(2), seq: "2" });
    assert.equal(await readsFor("/seek?q=arm64"), 0, "a search keeps its copy after a hide that did change something");
  });

  test("blocking a key from posting, or letting it post again, forgets no page", async () => {
    await warm([...OPEN_PAGES, "/seek?q=arm64"]);
    await send(owner, "/me/spaces/open-notes/block", { peer: STRANGER, seq: "2" });
    await send(owner, "/me/spaces/open-notes/unblock", { peer: STRANGER });
    for (const path of [...OPEN_PAGES, "/seek?q=arm64"]) assert.equal(await readsFor(path), 0, `${path} kept after a block`);
  });

  test("a page that read the space before a hide and finished after it is not kept", async () => {
    // Forget first, so the page is not held, then let one request start, hide while it
    // waits on the service, and let it finish.
    await send(owner, "/me/spaces/open-notes/hide", { post: id(2), seq: "2" });
    let release!: () => void;
    GATES.set("/v1/spaces/open-notes/posts/1/proof", new Promise<void>((resolve) => { release = resolve; }));
    const slow = get("/spaces/open-notes/1.md");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await send(owner, "/me/spaces/open-notes/hide", { post: id(2), seq: "2" });
    GATES.delete("/v1/spaces/open-notes/posts/1/proof");
    release();
    assert.equal((await slow).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(await readsFor("/spaces/open-notes/1.md") > 0, "the page rendered across the hide was not stored");
    assert.equal(await readsFor("/spaces/open-notes/1.md"), 0, "the page rendered after it is");
  });

  test("a hide the service refuses, or one in no shape, is said and sends nothing further", async () => {
    const denied = await send(owner, "/me/spaces/open-notes/hide", { post: id(1), seq: "1" });
    assert.equal(denied.status, 403);
    assert.match(denied.text, /Only the owner or an admin of this space hides a post or shows it again/);
    const junk = await send(owner, "/me/spaces/open-notes/hide", { post: "not-an-id", seq: "2" });
    assert.equal(junk.status, 400);
    assert.deepEqual(junk.writes, []);
    const noSeq = await send(owner, "/me/spaces/open-notes/unhide", { post: id(2), seq: "02" });
    assert.equal(noSeq.status, 400);
    assert.deepEqual(noSeq.writes, []);
  });

  test("blocks a post's author from posting, comes back to the post, and never blocks their own key", async () => {
    const r = await send(owner, "/me/spaces/open-notes/block", { peer: STRANGER, seq: "2" });
    assert.equal(r.location, "/me/spaces/open-notes/2?notice=posting-blocked");
    assert.equal(r.writes[0]!.method, "PUT");
    assert.equal(r.writes[0]!.url.pathname, `/v1/spaces/open-notes/blocks/${STRANGER}`);
    const own = await send(owner, "/me/spaces/open-notes/block", { peer: OWNER, seq: "2" });
    assert.equal(own.status, 400);
    assert.deepEqual(own.writes, []);
  });

  test("reads who is blocked from posting on a page of its own, with Let it post again, guarded, and a form to block by key", async () => {
    const home = (await get("/me/spaces/open-notes", owner)).text;
    assert.match(home, /<a href="\/me\/spaces\/open-notes\/blocks">Blocked from posting<\/a>/);
    const { status, text } = await get("/me/spaces/open-notes/blocks", owner);
    assert.equal(status, 200);
    assert.match(text, /<h1>Blocked from posting in open-notes<\/h1>/);
    const unblock = formsTo(text, "/me/spaces/open-notes/unblock");
    assert.equal(unblock.length, 1, "the key in no shape gets no button");
    assert.match(text, new RegExp(`name="peer" value="${BLOCKED}"`));
    assert.match(text, /<button type="submit" data-guard disabled>Let it post again<\/button>/);
    assert.doesNotMatch(text, />Unblock</);
    assert.match(text, /Blocking a key from posting by its id needs no script\./);
    assert.equal(formsTo(text, "/me/spaces/open-notes/block").length, 1);
    assert.deepEqual(signedInProblems(text), []);
    const res = await handleRequest(new Request(`${SITE}/me/spaces/open-notes/blocks`, { headers: { Cookie: owner.cookie } }), env);
    assert.match(res.headers.get("Content-Security-Policy") ?? "", /script-src 'self'/, "the page may run its own guard script");
    assert.doesNotMatch(res.headers.get("Content-Security-Policy") ?? "", /connect-src/);
    assert.equal((await get("/me/spaces/open-notes/blocks", stranger)).status, 403, "a key with no role there");
  });

  test("unblocks from that page and comes back to it, and a key typed in no shape comes back as typed", async () => {
    const r = await send(owner, "/me/spaces/open-notes/unblock", { peer: BLOCKED });
    assert.equal(r.location, "/me/spaces/open-notes/blocks?notice=posting-unblocked");
    assert.equal(r.writes[0]!.method, "DELETE");
    assert.equal(r.writes[0]!.url.pathname, `/v1/spaces/open-notes/blocks/${BLOCKED}`);
    const typed = await send(owner, "/me/spaces/open-notes/block", { peer: "not a key <b>" });
    assert.equal(typed.status, 400);
    assert.deepEqual(typed.writes, []);
    assert.match(typed.text, /value="not a key &lt;b&gt;"/);
    assert.match(typed.text, /A key id is 64 characters of 0 to 9 and a to f\. Nothing was changed\./);
    assert.match(typed.text, /<script src="\/allow\.js"><\/script>/, "the page drawn again keeps its guard");
    assert.match((await get(`${r.location}`, owner)).text, /That key may post here again\./);
  });

  test("the page of blocked keys goes on past its first page, in the service's cursor", () => {
    const viewer = { peerId: OWNER, csrf: "c".repeat(43) };
    const s: any = { ...space("open-notes"), title: "Open notes", description: "" };
    const next = blocksHtml(formShell("Blocked from posting", viewer), viewer, s, [{ peer_id: BLOCKED, blocked_at: at(1) }], "", STRANGER, null);
    assert.ok(next.includes(`/me/spaces/open-notes/blocks?after=${STRANGER}`));
    const later = blocksHtml(formShell("Blocked from posting", viewer), viewer, s, [], STRANGER, null, null);
    assert.match(later, /From the first/);
    assert.match(later, /No more keys are blocked from posting here\./);
  });

  test("the membership history says a key was blocked and a post hidden, in words", () => {
    const s: any = { ...space("open-notes"), title: "Open notes", description: "" };
    const html = eventsHtml(formShell("Membership history", undefined), s, [
      { revision: "5", event: "peer.blocked", actor: OWNER, payload: { peer_id: STRANGER, role: null }, at: at(5) },
      { revision: "6", event: "peer.unblocked", actor: OWNER, payload: { peer_id: STRANGER }, at: at(6) },
      { revision: "7", event: "post.hidden", actor: OWNER, payload: { post_id: id(3), seq: "3", author: STRANGER }, at: at(7) },
      { revision: "8", event: "post.unhidden", actor: OWNER, payload: { post_id: id(3), seq: "3" }, at: at(8) },
    ], "0", null);
    for (const words of ["key blocked from posting", "key may post again", "post hidden", "post shown again"]) assert.ok(html.includes(`<td>${words}</td>`), words);
  });
});

// ── making a space, and its settings ───────────────────────────────────────────────

describe("choosing how others join", () => {
  test("a new space offers taking posts from any key, where the service takes it", async () => {
    const { text } = await get("/me/new", owner);
    assert.deepEqual(radios(text, "join_policy").map(valueOf), ["request", "invite", "open"]);
    assert.deepEqual(checkedValues(text, "join_policy"), ["request"]);
    assert.match(text, /Any key posts in it without joining, and posting does not make it a member; each such post is marked not a member\./);
  });

  const made = { name: "my-open-notes", title: "Mine", description: "", category_1: "general", join_policy: "open" };

  test("a public work space is made to take posts from any key", async () => {
    const r = await send(owner, "/me/new", { ...made, visibility: "public" });
    assert.equal(r.status, 303, r.text.slice(0, 300));
    assert.equal(JSON.parse(r.writes[0]!.body!).join_policy, "open");
  });

  for (const [what, fields] of [
    ["private", { visibility: "private" }],
    ["sealed", { visibility: "sealed", sealed_space_id: "0199f0f0-0000-7000-8000-00000000000a", sealed_commitment: "a".repeat(64), sealed_lock: "b".repeat(160) }],
    ["an oracle space", { visibility: "public", oracle: "1" }],
  ] as [string, Record<string, string>][]) {
    test(`chosen for ${what}, it comes back as typed with one sentence, and nothing is sent`, async () => {
      const r = await send(owner, "/me/new", { ...made, ...fields });
      assert.equal(r.status, 400);
      assert.deepEqual(r.writes, [], "never made as asking to join instead");
      assert.ok(r.text.includes(OPEN_ONLY_PUBLIC_WORK), r.text.slice(0, 300));
      assert.deepEqual(checkedValues(r.text, "join_policy"), ["open"]);
      assert.deepEqual(checkedValues(r.text, "visibility"), [fields.visibility]);
    });
  }

  test("a space's settings tick only the way in it has, and offer taking posts from any key only to a public work space", async () => {
    const open = (await get("/me/spaces/open-notes/settings", owner)).text;
    assert.deepEqual(checkedValues(open, "join_policy"), ["open"], "the page ticks the way in the space has, never ask to join");
    const ask = (await get("/me/spaces/ask-notes/settings", owner)).text;
    assert.deepEqual(radios(ask, "join_policy").map(valueOf), ["request", "invite", "open"]);
    assert.deepEqual(checkedValues(ask, "join_policy"), ["request"]);
    const quiet = (await get("/me/spaces/quiet-notes/settings", owner)).text;
    assert.deepEqual(radios(quiet, "join_policy").map(valueOf), ["request", "invite"], "a private space");
    const doc = (await get("/me/spaces/notes-doc/settings", owner)).text;
    assert.deepEqual(radios(doc, "join_policy").map(valueOf), ["request", "invite"], "an oracle space");
    const odd = (await get("/me/spaces/odd-notes/settings", owner)).text;
    assert.deepEqual(checkedValues(odd, "join_policy"), [], "a way in this site has no words for ticks nothing");
    assert.match(odd, /takes others in a way this site has no words for\. Choosing one below changes it; choosing none keeps it\./);
  });

  test("saving settings sends only the way in the form had ticked, and none when none was", async () => {
    const kept = await send(owner, "/me/spaces/open-notes/settings", { title: "Open notes", description: "", join_policy: "open" });
    assert.equal(JSON.parse(kept.writes[0]!.body!).join_policy, "open");
    const none = await send(owner, "/me/spaces/odd-notes/settings", { title: "Odd notes", description: "" });
    assert.equal("join_policy" in JSON.parse(none.writes[0]!.body!), false, "an unknown way in is kept, never made asking to join");
    const junk = await send(owner, "/me/spaces/open-notes/settings", { title: "Open notes", description: "", join_policy: "everyone" });
    assert.equal("join_policy" in JSON.parse(junk.writes[0]!.body!), false);
  });

  test("an oracle space's fork never offers taking posts from any key", async () => {
    const { text } = await get("/me/spaces/notes-doc/fork", owner);
    assert.deepEqual(radios(text, "join_policy").map(valueOf), ["request", "invite"]);
  });

  test("the service's refusal of it is said in a person's words", () => {
    assert.equal(refusalText({ ok: false, status: 400, code: "INVALID_REQUEST", message: "", detail: "join_policy open is for a public work space" } as any),
      "Only a public work space takes posts from any key without joining, so nothing was changed.");
    assert.match(refusalText({ ok: false, status: 403, code: "WRITE_BLOCKED", message: "" } as any), /^The owner or an admin of this space has blocked your key from posting in it/);
  });
});

describe("the API page", () => {
  test("calls open write available, and gives each of its five operations a page", () => {
    const terms = (list: [string, string][]) => list.map(([term]) => term);
    assert.ok(terms(today.available).includes("OPEN WRITE"));
    assert.ok(!terms(today.planned).includes("OPEN WRITE"));
    const want: Record<string, string[]> = {
      "space_blocks.list": ["/me/spaces/<name>/blocks"],
      "space_blocks.set": ["/me/spaces/<name>/blocks", "/me/spaces/<name>/<number>"],
      "space_blocks.remove": ["/me/spaces/<name>/blocks"],
      "posts.hide": ["/me/spaces/<name>/<number>"],
      "posts.unhide": ["/me/spaces/<name>/<number>"],
    };
    for (const [op, pages] of Object.entries(want)) {
      assert.equal(operationPages[op]?.on_site, "page", op);
      assert.deepEqual(operationPages[op].pages, pages, op);
    }
  });
});
