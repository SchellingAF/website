// Where a replaced space's recovery notice is, said truly for a space that is not public.
//
// The service signs one notice for the public spaces a restore closed, which anybody
// reads at GET /v1/recovery, and a notice of its own for each space that is not public,
// which it gives only to a key that reads that space. This site's /recovery reads with no
// key, so it holds the public notice alone, and that notice names no space at all when
// the restore closed only spaces that are not public. A replaced private space's page
// therefore must not send its reader to /recovery for its notice, and /recovery must say
// what it does not hold.

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { CAPABILITIES, json, refusal, service, type Call, type Json, type World } from "./lib/service.ts";
import { mintNotice, type KeyPair } from "./lib/notice.ts";
import { htmlProblems, markdownProblems } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "e5f6".repeat(16);
const replaced = (name: string, visibility: string): Json => ({
  name, space_id: "0199cccc-0000-7000-8000-00000000000" + (visibility === "public" ? "1" : "2"),
  title: `The space ${name}`, description: "", visibility, join_policy: "request", status: "closed",
  signed_only: false, oracle: false, categories: ["general"], owner: OWNER,
  contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-18T10:00:00.000Z",
  replaced_by: { space_id: "0199cccc-0000-7000-8000-0000000000ff", name: `${name}-2` },
});
const keys = { service: generateKeyPairSync("ed25519") as KeyPair, root: generateKeyPairSync("ed25519") as KeyPair };
const world = (recovery: World["recovery"]): World => ({
  capabilities: CAPABILITIES, spaces: [replaced("gone-public", "public"), replaced("gone-private", "private")],
  posts: { "gone-public": [] }, proofs: {}, checkpoints: {}, peers: {}, recovery,
});
let answer: (call: Call) => Response = service(world([]));
const { fake, handleRequest } = await site((call) => answer(call));
beforeEach(() => { answer = service(world([])); });

// TWO PEOPLE SIGNED IN: a member of gone-private, and a key that holds no role in it.
const MEMBER = "a1a1".repeat(16);
const STRANGER = "b2b2".repeat(16);
const member = await signedIn(MEMBER, "member-token", "192.0.2.171");
const stranger = await signedIn(STRANGER, "stranger-token", "192.0.2.172");
const PRIVATE_ID = "0199cccc-0000-7000-8000-000000000002";
const PUBLIC_ID = "0199cccc-0000-7000-8000-000000000001";
const entry = (spaceId: string, name: string) => ({
  space_id: spaceId, name,
  signed: [{ stream: "posts", last: "40", ending_hash: "e".repeat(64), checkpoint_id: "c".repeat(64), found: "short" }],
  recovered: { posts: { last: "37", chain_hash: "d".repeat(64) }, events: { last: "3", chain_hash: null } },
  replacement: { space_id: "0199cccc-0000-7000-8000-0000000000ff", name: `${name}-2` },
});
/** As the product answers since it split the notices: the public spaces' notice to
 *  everybody, and a space's own notice only to a key that reads that space. */
function splitService(): (call: Call) => Response {
  const notices = [
    { raw: mintNotice(keys, { spaces: [entry(PUBLIC_ID, "gone-public")], reason: "the public notice" }), readers: null },
    { raw: mintNotice(keys, { spaces: [entry(PRIVATE_ID, "gone-private")], spaceId: PRIVATE_ID, reason: "gone-private's own notice" }), readers: "member-token" },
  ];
  const base = service(world([]));
  return (call) => {
    const token = call.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
    const p = call.url.pathname;
    if (p === "/v1/recovery") {
      const items = notices.filter((n) => n.readers === null || n.readers === token).map((n) => n.raw);
      return json({ items, has_more: false, next_before: null });
    }
    if (p === "/v1/spaces/gone-private") {
      const s = world([]).spaces.find((x) => x.name === "gone-private")!;
      return json({ ...s, linked_from: 0, access: token === "member-token" ? { role: "writer", tags: [], read: true, post: false } : { role: null, tags: [], read: false, post: false } });
    }
    if (p.startsWith("/v1/spaces/gone-private/") && token !== "member-token") return refusal(403, "READ_DENIED");
    return base(call);
  };
}
const asPerson = async (path: string, cookie: string) => {
  const res = await handleRequest(new Request(`${SITE}${path}`, { headers: { Cookie: cookie } }), env);
  return { status: res.status, text: await res.text() };
};

let hosts = 0;
const host = () => `https://r${++hosts}.localhost`;
const ask = async (path: string) => {
  const res = await handleRequest(new Request(`${host()}${path}`), env);
  return { status: res.status, text: await res.text() };
};

describe("a replaced space's recovery notice", () => {
  test("a public space's page links /recovery, where its notice is", async () => {
    const { status, text } = await ask("/spaces/gone-public");
    assert.equal(status, 200, text.slice(0, 300));
    assert.match(text, /<a href="\/recovery">The service's signed notice<\/a> says what it found\./);
    assert.deepEqual(htmlProblems(text), []);
    const md = (await ask("/spaces/gone-public.md")).text;
    assert.match(md, /the service's signed notice: \/recovery\.md\)$/m);
  });

  test("a private space's page says its notice is given only to a key that reads it, and sends nobody to /recovery for it", async () => {
    const { status, text } = await ask("/spaces/gone-private");
    assert.equal(status, 200, text.slice(0, 300));
    assert.match(text, /It continues in <a href="\/spaces\/gone-private-2">gone-private-2<\/a>\./);
    assert.doesNotMatch(text, /<a href="\/recovery">The service's signed notice<\/a>/);
    assert.match(text, /The service gives its signed notice only to a key that reads this space, at GET \/v1\/recovery\./);
    assert.deepEqual(htmlProblems(text), []);
    const md = (await ask("/spaces/gone-private.md")).text;
    assert.doesNotMatch(md, /recovery\.md/);
    assert.match(md, /^- replaced_by: \/spaces\/gone-private-2\.md \(a restore lost part of this space's record; the service gives its signed notice only to a key that reads this space, at GET \/v1\/recovery\)$/m);
    assert.deepEqual(markdownProblems(md), []);
  });

  test("/recovery says it holds the public spaces' notices, and a notice that names no space says why", async () => {
    answer = service(world([mintNotice(keys, { spaces: [] })]));
    const { status, text } = await ask("/recovery");
    assert.equal(status, 200, text.slice(0, 300));
    assert.match(text, /This site checked its signature and its signing key&#39;s certificate\./);
    assert.match(text, /A space that is not public is named in a notice of its own, which the service gives only to a key that reads that space; this page reads with no key\./);
    assert.match(text, /This notice names no public space\. Any other space the restore closed is named in a notice of its own\./);
    assert.deepEqual(htmlProblems(text), []);
    const md = (await ask("/recovery.md")).text;
    assert.match(md, /^This notice names no public space\. Any other space the restore closed is named in a notice of its own\.$/m);
    assert.deepEqual(markdownProblems(md), []);
    const doc = JSON.parse((await ask("/recovery.json")).text);
    assert.deepEqual(doc.notices[0].signed.spaces, []);
  });

  test("a notice that names a space shows no such sentence", async () => {
    answer = service(world([mintNotice(keys)]));
    const { text } = await ask("/recovery");
    assert.doesNotMatch(text, /This notice names no public space/);
  });
});

describe("a member of a replaced space that is not public reads its notice signed in", () => {
  test("the member's own page of the space shows the notice the service gave the member's key, in three formats", async () => {
    answer = splitService();
    fake.calls.length = 0;
    const { status, text } = await asPerson("/me/spaces/gone-private", member.cookie);
    assert.equal(status, 200, text.slice(0, 300));
    assert.match(text, /The service's signed notice, read with your key, is under Recovery notice below\./);
    assert.match(text, /<h2>Recovery notice<\/h2>/);
    assert.match(text, /The service gives this notice only to a key that reads this space, and this page read it with yours\./);
    assert.match(text, /This site checked its signature and its signing key&#39;s certificate\./);
    assert.match(text, /Reason given: gone-private&#39;s own notice/);
    assert.doesNotMatch(text, /the public notice/, "a notice that does not name this space is not shown");
    assert.deepEqual(htmlProblems(text), []);
    // Read with the member's own token, never the site's key and never with none.
    const reads = fake.calls.filter((c) => c.url.pathname === "/v1/recovery");
    assert.equal(reads.length, 1);
    assert.equal(reads[0]!.headers.get("authorization"), "Bearer member-token");
    const md = (await asPerson("/me/spaces/gone-private.md", member.cookie)).text;
    assert.match(md, /^- replaced_by: \/me\/spaces\/gone-private-2\.md \(a restore lost part of this space's record; the service's signed notice, read with your key, is under Recovery notice below\)$/m);
    assert.match(md, /^## Recovery notice$/m);
    assert.match(md, /^### Notice signed /m);
    assert.match(md, /^- reason: `gone-private's own notice`$/m);
    assert.deepEqual(markdownProblems(md), []);
    const doc = JSON.parse((await asPerson("/me/spaces/gone-private.json", member.cookie)).text);
    assert.equal(doc.recovery_notices.length, 1);
    assert.equal(doc.recovery_notices[0].checked_by_this_site, true);
    assert.equal(doc.recovery_notices[0].signed.spaces[0].name, "gone-private");
  });

  test("a key that does not read the space is given no notice naming it, and its page says so", async () => {
    answer = splitService();
    const { status, text } = await asPerson("/me/spaces/gone-private", stranger.cookie);
    assert.equal(status, 200, text.slice(0, 300));
    assert.match(text, /None of the recovery notices the service gave your key names this space\./);
    assert.doesNotMatch(text, /gone-private&#39;s own notice/);
    assert.doesNotMatch(text, /the public notice/);
    assert.doesNotMatch(text, /Signed /);
    const doc = JSON.parse((await asPerson("/me/spaces/gone-private.json", stranger.cookie)).text);
    assert.deepEqual(doc.recovery_notices, []);
  });

  test("a read that fails says so, and the public page of the space reads no notice at all", async () => {
    const split = splitService();
    answer = (call) => call.url.pathname === "/v1/recovery" ? new Response("down", { status: 500 }) : split(call);
    const { status, text } = await asPerson("/me/spaces/gone-private", member.cookie);
    assert.equal(status, 200, text.slice(0, 300));
    assert.match(text, /This site could not read the service&#39;s recovery notices just now\./);
    answer = splitService();
    fake.calls.length = 0;
    const pub = await ask("/spaces/gone-private");
    assert.match(pub.text, /The service gives its signed notice only to a key that reads this space, at GET \/v1\/recovery\./);
    assert.equal(fake.calls.filter((c) => c.url.pathname === "/v1/recovery").length, 0);
  });

  test("a replaced public space's signed-in page links /recovery and reads nothing more", async () => {
    answer = splitService();
    fake.calls.length = 0;
    const { text } = await asPerson("/me/spaces/gone-public", member.cookie);
    assert.match(text, /<a href="\/recovery">The service's signed notice<\/a> says what it found\./);
    assert.equal(fake.calls.filter((c) => c.url.pathname === "/v1/recovery").length, 0);
  });
});

describe("the other pages say /recovery holds the public spaces' notices", () => {
  test("the Vocabulary and /api say so, and none says every notice is there", async () => {
    const vocab = (await ask("/vocabulary")).text;
    assert.match(vocab, /<a href="\/recovery">The public spaces(&#39;|')s? recovery notices<\/a>/);
    assert.doesNotMatch(vocab, /Every recovery notice/);
    assert.match(vocab, /A space that is not public is named in a notice of its own, which the service gives only to a key that reads that space\./);
    const AP = await import("../content/api-overview.mjs") as Json;
    const ledger = JSON.stringify(AP);
    assert.match(ledger, /\/recovery shows the public spaces' notices/);
    assert.match(ledger, /Each public space's notice in words on this site/);
    assert.match(ledger, /A space that is not public is named only to a key that reads it\./);
    assert.doesNotMatch(ledger, /a replaced space's page links them/);
  });
});
