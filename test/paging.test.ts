// Every list pages through any size, and from either end: a space's stream to the posts
// just before it, its archive back a page and on to its latest, its checkpoints newest
// first, the sitemap past a thousand spaces with every archive page of a public space,
// and, signed in, join requests, membership history and the mailbox.
//
// Driven through handleRequest() against the stand-in service. Numbers in a space, in a
// membership history and in a mailbox are gap-free, so every link here is arithmetic on
// them and asks the service for nothing new.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, CATEGORIES, json, service, type Json, type World } from "./lib/service.ts";
import { htmlProblems, markdownProblems, tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const SPACE_ID = "0199ffff-0000-7000-8000-000000000001";
const postId = (n: number) => `0199ffff-0000-7000-8000-${String(n).padStart(12, "0")}`;
const requestId = (n: number) => `0199fffe-0000-7000-8000-${String(n).padStart(12, "0")}`;
const hex = (byte: string) => byte.repeat(32);

const space = (name: string, fields: Json = {}): Json => ({
  name, space_id: SPACE_ID, title: `The space ${name}`, description: "Findings.", visibility: "public",
  join_policy: "request", status: "active", signed_only: false, replaced_by: null, categories: ["general"],
  owner: OWNER, contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-18T09:00:00.000Z",
  access: { role: "owner", tags: [], read: true, post: true }, revision: "250",
  ...fields,
});
const posts = (name: string, n: number): Json[] => Array.from({ length: n }, (_, i) => ({
  post_id: postId(i + 1), space: name, seq: String(i + 1), kind: i % 2 ? "obs" : "result", author: OWNER,
  posted_at: "2026-09-18T10:00:00.000Z", title: `Post ${i + 1}`, body: "A finding.", to: [], reply_to: null,
  supersedes: null, retracts: null, fingerprints: [], signed: false, space_id: SPACE_ID,
}));
/** Checkpoints over ten posts each, each naming the one before it; the one numbered
 *  `broken` names another. Three unless told, the middle one's link broken when asked. */
const checkpoints = (broken: boolean | number = false, count = 3): Json[] => Array.from({ length: count }, (_, i) => i + 1).map((n) => {
  const id = (k: number) => k.toString(16).padStart(64, "c");
  const end = (k: number) => k.toString(16).padStart(64, "e");
  const wrong = broken === true ? n === 2 : broken === n;
  return {
    checkpoint_id: id(n), stream: "posts", first: String((n - 1) * 10 + 1), last: String(n * 10),
    previous_checkpoint_id: n === 1 ? null : wrong ? hex("99") : id(n - 1),
    predecessor_hash: n === 1 ? hex("00") : end(n - 1), ending_hash: end(n), merkle_root: hex("f1"),
    service_epoch: "1", created_at: "2026-09-18T11:00:00.000Z", canonical: "e30", signature: "5a".repeat(64),
    signer: { key_id: hex("b1"), public_key: hex("b2"), root_key: hex("b3"), certificate: "e30", certificate_signature: "5b".repeat(64), development: false },
  };
});

// Thirteen hundred spaces under one letter, more than five directory pages, so a letter's
// sitemap must go on past them; one of them public with a hundred and thirty posts.
const many = Array.from({ length: 1300 }, (_, i) => space(`s${String(i).padStart(4, "0")}-space`, { visibility: "private" }));
const world: World = {
  capabilities: CAPABILITIES,
  categories: CATEGORIES,
  spaces: [
    space("long-findings", { head_seq: "130" }),
    space("short-findings", { head_seq: "20" }),
    space("broken-chain"),
    space("long-chain"),
    space("headless-chain"),
    space("vast-findings", { head_seq: "9999999" }),
    ...many,
    space("s0500-public", { head_seq: "130" }),
  ],
  posts: {
    "long-findings": posts("long-findings", 130),
    "short-findings": posts("short-findings", 20),
    "s0500-public": posts("s0500-public", 130),
  },
  proofs: {},
  // Fifty-two checkpoints, more than the newest-first page shows, the third naming a
  // checkpoint that is not the second; and three whose first the service lost.
  checkpoints: {
    "long-findings": checkpoints(), "broken-chain": checkpoints(true),
    "long-chain": checkpoints(3, 52), "headless-chain": checkpoints(false, 4).slice(1),
  },
  peers: {},
};
world.spaces.sort((a, b) => (a.name < b.name ? -1 : 1));

const answer = service(world);
const { fake, handleRequest } = await site((call) => {
  const path = call.url.pathname;
  const q = call.url.searchParams;
  if (path === "/v1/conversations") return json({ items: [], unread_conversations: 0, requests_waiting: 0 });
  if (path === "/v1/spaces/long-findings/requests") {
    // Four hundred and ten waiting, two hundred to a page, ordered by id as the service does.
    const from = q.get("after") ? Number(q.get("after")!.slice(-12)) : 0;
    const limit = Number(q.get("limit") ?? "50");
    const items = Array.from({ length: Math.max(0, Math.min(limit, 410 - from)) }, (_, i) => ({
      request_id: requestId(from + i + 1), requester: "c3d4".repeat(16), message: "Let me in.", state: q.get("state"),
      created_at: "2026-09-18T10:00:00.000Z", expires_at: "2026-09-25T10:00:00.000Z", decided_at: null, decided_by: null, decided_role: null,
    }));
    return json({ items, next_after: items.at(-1)?.request_id ?? q.get("after"), has_more: items.length === limit });
  }
  if (path === "/v1/spaces/long-findings/events") {
    const from = Number(q.get("after") ?? "0");
    const items = Array.from({ length: Math.max(0, Math.min(Number(q.get("limit")), 250 - from)) }, (_, i) => ({
      revision: String(from + i + 1), event: "member.granted", actor: OWNER, payload: {}, at: "2026-09-18T10:00:00.000Z",
    }));
    return json({ items, next_after: items.at(-1)?.revision ?? "250", has_more: from + items.length < 250, head_revision: "250" });
  }
  if (path === "/v1/mailbox") {
    const from = Number(q.get("after") ?? "0");
    const items = Array.from({ length: Math.max(0, Math.min(50, 120 - from)) }, (_, i) => ({ mailbox_seq: String(from + i + 1), reason: "to" }));
    return json({ items, next_after: items.at(-1)?.mailbox_seq ?? "120", has_more: from + items.length < 120, head_seq: "120" });
  }
  return answer(call);
});

const { cookie } = await signedIn(OWNER, "paging-token", "192.0.2.71");

let hosts = 0;
async function get(path: string, withCookie = false) {
  const res = await handleRequest(new Request(`https://p${++hosts}.localhost${path}`, withCookie ? { headers: { Cookie: cookie } } : {}), env);
  return { status: res.status, text: await res.text(), h: (name: string) => res.headers.get(name) };
}
const hrefs = (html: string) => tags(html).flatMap((t) => (t.name === "a" ? t.attributes.filter(([n]) => n === "href").map(([, v]) => v!.replace(/&amp;/g, "&")) : []));
const linked = (html: string, label: string) => html.match(new RegExp(`<a href="([^"]*)">${label}</a>`))?.[1]?.replace(/&amp;/g, "&") ?? null;

describe("a space's stream", () => {
  test("links the archive page holding the fifty posts just before its newest twenty-five, in all three formats", async () => {
    const page = await get("/spaces/long-findings");
    // The newest twenty-five are 106 to 130, so the fifty before them are 56 to 105.
    assert.equal(linked(page.text, "Earlier posts"), "/spaces/long-findings/all?after=55");
    assert.match((await get("/spaces/long-findings.md")).text, /^Earlier posts, the fifty before these: \/spaces\/long-findings\/all\.md\?after=55$/m);
    assert.equal(JSON.parse((await get("/spaces/long-findings.json")).text).earlier_posts, "/spaces/long-findings/all?after=55");
    const archive = JSON.parse((await get("/spaces/long-findings/all.json?after=55")).text);
    assert.deepEqual([archive.posts[0].seq, archive.posts.at(-1).seq], ["56", "105"]);
  });

  test("offers none when every post is on it, or when it is narrowed to some kinds and so not one run of numbers", async () => {
    assert.equal(linked((await get("/spaces/short-findings")).text, "Earlier posts"), null);
    assert.equal(linked((await get("/spaces/long-findings?kind=obs")).text, "Earlier posts"), null);
    assert.equal(JSON.parse((await get("/spaces/long-findings.json?kind=obs")).text).earlier_posts, null);
  });

  test("signed in, the same link stays under the signed-in address", async () => {
    assert.equal(linked((await get("/me/spaces/long-findings", true)).text, "Earlier posts"), "/me/spaces/long-findings/all?after=55");
  });
});

describe("a space's archive", () => {
  test("goes back a page and on to the latest posts in one step", async () => {
    const mid = await get("/spaces/long-findings/all?after=55");
    assert.equal(linked(mid.text, "Previous posts"), "/spaces/long-findings/all?after=5");
    assert.equal(linked(mid.text, "Latest posts"), "/spaces/long-findings/all?after=80");
    const doc = JSON.parse((await get("/spaces/long-findings/all.json?after=55")).text);
    assert.equal(doc.previous, "/spaces/long-findings/all?after=5");
    assert.equal(doc.latest, "/spaces/long-findings/all?after=80");
    const md = (await get("/spaces/long-findings/all.md?after=55")).text;
    assert.match(md, /^- previous: \/spaces\/long-findings\/all\.md\?after=5$/m);
    assert.match(md, /^- latest: \/spaces\/long-findings\/all\.md\?after=80$/m);
    assert.deepEqual(markdownProblems(md), []);
    assert.deepEqual(htmlProblems(mid.text), []);
  });

  test("offers no page before the first, which has its own link, and no latest page on the latest", async () => {
    const second = await get("/spaces/long-findings/all?after=50");
    assert.equal(linked(second.text, "Previous posts"), null);
    assert.equal(linked(second.text, "From the first post"), "/spaces/long-findings/all");
    const last = await get("/spaces/long-findings/all?after=100");
    assert.equal(linked(last.text, "Latest posts"), null);
    assert.equal(linked(last.text, "Previous posts"), "/spaces/long-findings/all?after=50");
    const first = await get("/spaces/long-findings/all");
    assert.equal(linked(first.text, "Latest posts"), "/spaces/long-findings/all?after=80");
  });

  test("is listed on the grid of fifties the next links walk and the sitemap names, and followed off it", async () => {
    for (const after of ["", "?after=50", "?after=100"]) {
      assert.equal((await get(`/spaces/long-findings/all${after}`)).h("X-Robots-Tag"), "index, follow, max-snippet:-1", after);
    }
    for (const after of ["?after=55", "?after=80", "?after=5"]) {
      const page = await get(`/spaces/long-findings/all${after}`);
      assert.equal(page.h("X-Robots-Tag"), "noindex, follow", after);
      assert.doesNotMatch(page.h("Link") ?? "", /rel="canonical"/, after);
      assert.match(page.text, /<meta name="robots" content="noindex, follow">/, after);
    }
  });
});

describe("a space's checkpoints", () => {
  test("read newest first, each checked against the one before it, with the whole walk oldest first a link away", async () => {
    const doc = JSON.parse((await get("/spaces/long-findings/checkpoints.json?order=desc")).text);
    assert.equal(doc.order, "newest first");
    assert.deepEqual(doc.checkpoints.map((c: Json) => c.last), ["30", "20", "10"]);
    const chain = /does not (start where|name the one before it|start from the one before)/;
    assert.deepEqual(doc.checkpoints.flatMap((c: Json) => c.problems).filter((p: string) => chain.test(p)), []);
    assert.equal(doc.next, null, "the service's newest page has no page past it");
    assert.equal(doc.oldest_first, "/spaces/long-findings/checkpoints");
    const asked = fake.calls.filter((c) => c.url.pathname === "/v1/spaces/long-findings/checkpoints").at(-1)!;
    assert.equal(asked.url.searchParams.get("order"), "desc");
    assert.equal(asked.url.searchParams.get("after"), null);
    const page = await get("/spaces/long-findings/checkpoints?order=desc");
    assert.equal(linked(page.text, "Every checkpoint, oldest first"), "/spaces/long-findings/checkpoints");
    assert.match((await get("/spaces/long-findings/checkpoints.md?order=desc")).text, /^# Checkpoints of long-findings, newest first$/m);
  });

  test("a broken link is found reading newest first, on the checkpoint that makes it", async () => {
    const doc = JSON.parse((await get("/spaces/broken-chain/checkpoints.json?order=desc")).text);
    const named = (last: string) => doc.checkpoints.find((c: Json) => c.last === last).problems as string[];
    assert.ok(named("20").includes("The checkpoint does not name the one before it."), JSON.stringify(named("20")));
    assert.ok(!named("30").includes("The checkpoint does not name the one before it."));
  });

  test("newest first, the oldest shown is checked against the checkpoint before it, which the page names", async () => {
    const doc = JSON.parse((await get("/spaces/long-chain/checkpoints.json?order=desc")).text);
    assert.equal(doc.checkpoints.length, 50);
    assert.equal(doc.checkpoints.at(-1).last, "30", "the oldest shown");
    assert.ok(doc.checkpoints.at(-1).problems.includes("The checkpoint does not name the one before it."), JSON.stringify(doc.checkpoints.at(-1).problems));
    assert.equal(doc.follows?.last, "20", "the one before the oldest shown is not named");
    const asked = fake.calls.filter((c) => c.url.pathname === "/v1/spaces/long-chain/checkpoints").at(-1)!;
    assert.equal(asked.url.searchParams.get("limit"), "51", "one more than the page shows");
    const html = (await get("/spaces/long-chain/checkpoints?order=desc")).text;
    // The stand-in's signatures are made up, so this site confirms none of them, and says so of this one too.
    assert.match(html, /This site could not confirm checkpoint <code title="c{63}2">[^<]*<\/code>, the one before the oldest here\./);
    assert.match((await get("/spaces/long-chain/checkpoints.md?order=desc")).text, /^- follows: .*, the checkpoint before the oldest here, checked by this site: /m);
    // The whole walk oldest first finds the same link broken.
    const oldest = JSON.parse((await get("/spaces/long-chain/checkpoints.json")).text);
    assert.ok(oldest.checkpoints.find((c: Json) => c.last === "30").problems.includes("The checkpoint does not name the one before it."));
  });

  test("newest first, a record whose first checkpoint is missing says so, and a whole short one names none before it", async () => {
    const doc = JSON.parse((await get("/spaces/headless-chain/checkpoints.json?order=desc")).text);
    assert.equal(doc.follows, null);
    assert.ok(doc.checkpoints.at(-1).problems.includes("The checkpoint before this one is not in the record."), JSON.stringify(doc.checkpoints.at(-1).problems));
    const whole = JSON.parse((await get("/spaces/long-findings/checkpoints.json?order=desc")).text);
    assert.equal(whole.follows, null);
    assert.deepEqual(whole.checkpoints.flatMap((c: Json) => c.problems).filter((p: string) => /not in the record/.test(p)), []);
  });

  test("oldest first links newest first, and a cursor on the newest page is not a new page", async () => {
    const page = await get("/spaces/long-findings/checkpoints");
    assert.equal(linked(page.text, "Newest first"), "/spaces/long-findings/checkpoints?order=desc");
    const before = fake.calls.length;
    const again = await get("/spaces/long-findings/checkpoints.json?order=desc&after=10");
    assert.equal(JSON.parse(again.text).order, "newest first");
    assert.ok(fake.calls.slice(before).every((c) => c.url.searchParams.get("after") === null));
  });
});

describe("a letter's sitemap", () => {
  const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);

  test("walks past a thousand spaces, and names every page of a public space's archive", async () => {
    const { status, text } = await get("/sitemap-spaces-s.xml");
    assert.equal(status, 200);
    const all = locs(text);
    assert.equal(all.filter((l) => /\/spaces\/s\d{4}-space$/.test(l)).length, 1300);
    assert.deepEqual(all.filter((l) => l.includes("/s0500-public/all")), [
      `${SITE}/spaces/s0500-public/all`, `${SITE}/spaces/s0500-public/all?after=50`, `${SITE}/spaces/s0500-public/all?after=100`,
    ]);
    assert.doesNotMatch(text, /capped/);
    assert.equal(new Set(all).size, all.length, "an address twice");
  });

  test("stops at the fifty thousand addresses one sitemap may list, and says so", async () => {
    const { text } = await get("/sitemap-spaces-v.xml");
    assert.equal(locs(text).length, 50_000);
    assert.match(text, /<!-- capped at 50000 addresses, the most one sitemap file may list; the rest are reachable from \/spaces\/v -->/);
  });

  test("names a private space and not its archive", async () => {
    const all = locs((await get("/sitemap-spaces-s.xml")).text);
    assert.ok(all.includes(`${SITE}/spaces/s0001-space`));
    assert.ok(!all.some((l) => l.startsWith(`${SITE}/spaces/s0001-space/`)));
  });
});

describe("signed in, from either end", () => {
  test("join requests page on past two hundred, keeping which state they are in", async () => {
    const first = await get("/me/spaces/long-findings/requests", true);
    assert.equal(first.status, 200);
    assert.equal(linked(first.text, "More requests"), `/me/spaces/long-findings/requests?state=pending&after=${requestId(200)}`);
    const second = await get(`/me/spaces/long-findings/requests?state=pending&after=${requestId(200)}`, true);
    const asked = fake.calls.filter((c) => c.url.pathname === "/v1/spaces/long-findings/requests").at(-1)!;
    assert.equal(asked.url.searchParams.get("after"), requestId(200));
    assert.equal(linked(second.text, "More requests"), `/me/spaces/long-findings/requests?state=pending&after=${requestId(400)}`);
    assert.equal(linked(second.text, "From the first"), "/me/spaces/long-findings/requests?state=pending");
    const last = await get(`/me/spaces/long-findings/requests?state=pending&after=${requestId(400)}`, true);
    assert.equal(linked(last.text, "More requests"), null);
    // A cursor in another shape is the first page.
    await get("/me/spaces/long-findings/requests?after=../x", true);
    assert.equal(fake.calls.filter((c) => c.url.pathname === "/v1/spaces/long-findings/requests").at(-1)!.url.searchParams.get("after"), null);
  });

  test("the membership history reaches its newest entries in one step, and goes back a page from there", async () => {
    const start = await get("/me/spaces/long-findings/events", true);
    assert.equal(linked(start.text, "Newest entries"), "/me/spaces/long-findings/events?after=150");
    const newest = await get("/me/spaces/long-findings/events?after=150", true);
    assert.equal(linked(newest.text, "Newest entries"), null, "this page holds the newest");
    assert.equal(linked(newest.text, "Earlier entries"), "/me/spaces/long-findings/events?after=50");
    assert.equal(linked(newest.text, "From the start"), "/me/spaces/long-findings/events");
    assert.ok(hrefs(newest.text).every((h) => !h.includes("after=250")), "a page past the end");
  });

  test("the mailbox reaches its newest items in one step, and goes back a page from there", async () => {
    const start = await get("/me/mailbox", true);
    assert.equal(linked(start.text, "Newest items"), "/me/mailbox?after=70");
    const newest = await get("/me/mailbox?after=70", true);
    assert.equal(linked(newest.text, "Newest items"), null);
    assert.equal(linked(newest.text, "Earlier items"), "/me/mailbox?after=20");
    assert.equal(linked(newest.text, "From the first"), "/me/mailbox");
  });
});
