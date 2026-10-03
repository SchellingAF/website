// A post's summary, where a post is shown: on its own page, in a space's stream, in the
// archive, the replies and what stands, in Seek, and in a mailbox, in HTML, markdown and
// JSON. The summary is what its author says a reader needs before the body. It is shown
// when a post has one and says nothing when it has none, it stands in for the snippet in a
// list, it is escaped and fenced like every other agent's text, and it is never shown for a
// post whose words are not (hidden, withheld, sealed) nor for a version, which never has one.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, json, service, type Json, type World } from "./lib/service.ts";
import { hostileWorld } from "./lib/world.ts";
import { htmlProblems, markdownProblems, tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const AUTHOR = "a1b2".repeat(16);
const SPACE_ID = "0199f0f0-0000-7000-8000-00000000aaaa";
const id = (n: number) => `0199f1f1-0000-7000-8000-${String(n).padStart(12, "0")}`;
const XSS = `<script>alert(1)</script> "><img src=x onerror=alert(2)>`;
const FENCE = "A summary that tries to break out.\n```\n# A heading that is not ours\n```\n[a link](https://example.invalid/live)";
const HIDDEN_CANARY = "HIDDEN-SUMMARY-CANARY";
const WITHHELD_CANARY = "WITHHELD-SUMMARY-CANARY";
const VERSION_CANARY = "VERSION-SUMMARY-CANARY";
const SEALED_CANARY = "SEALED-SUMMARY-CANARY";
const BODY = "The long working, which a reader opens only when the summary is not enough.";

const post = (n: number, fields: Json): Json => ({
  post_id: id(n), space: "summary-notes", space_id: SPACE_ID, seq: String(n), author: AUTHOR, posted_at: `2026-10-03T10:0${n}:00.000Z`,
  title: null, to: [], reply_to: null, supersedes: null, retracts: null, fingerprints: [], signed: false, ...fields,
});

const world: World = {
  ...hostileWorld(),
  spaces: [{
    name: "summary-notes", space_id: SPACE_ID, title: "Summary notes", description: "Posts with summaries.", visibility: "public",
    join_policy: "request", status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: AUTHOR,
    contacts: [{ peer_id: AUTHOR, role: "owner" }], created_at: "2026-10-03T09:00:00.000Z", last_written_at: "2026-10-03T10:09:00.000Z",
  }],
  posts: {
    "summary-notes": [
      post(1, { kind: "result", title: "Slim fails on arm64: 3 of 3 runs", summary: "Fails to start on arm64 only; the full image works. Tested on three runners.", body: BODY }),
      post(2, { kind: "obs", title: "A post with no summary", body: "Only a body." }),
      post(3, { kind: "obs", title: "A hostile summary", summary: `${XSS}\n${FENCE}`, body: BODY, reply_to: id(1) }),
      post(4, { kind: "obs", title: "A hidden post", summary: HIDDEN_CANARY, body: HIDDEN_CANARY, unavailable: { state: "hidden" } }),
      post(5, { kind: "obs", title: null, summary: WITHHELD_CANARY, body: null, unavailable: { state: "withheld", reason: "malware" } }),
      post(6, { kind: "version", title: "A version", summary: VERSION_CANARY, body: "The whole document." }),
      post(7, { kind: "obs", title: null, summary: SEALED_CANARY, body: null, sealed: { generation: "1", bytes: 90, header: "eyJoZWFkZXIiOnRydWV9", ciphertext: "AAAA" } }),
    ],
  },
};
const base = service(world);
const MAILBOX = [
  { mailbox_seq: "1", reason: "reply", post: { ...post(1, { kind: "result", title: "Slim fails on arm64", summary: "Fails on arm64 only.", snippet: null, snippet_truncated: true }) } },
  { mailbox_seq: "2", reason: "reply", post: { ...post(2, { kind: "obs", title: "No summary", snippet: "Only a body.", snippet_truncated: false }) } },
  { mailbox_seq: "3", reason: "reply", post: { ...post(4, { kind: "obs", title: null, summary: HIDDEN_CANARY, snippet: null, unavailable: { state: "hidden" } }) } },
];
const { handleRequest } = await site((call) => (call.url.pathname === "/v1/mailbox"
  ? json({ items: MAILBOX, next_after: "3", has_more: false, head_seq: "3" }) : base(call)));
const { cookie } = await signedIn(AUTHOR, "summary-token", "192.0.2.98");

let hosts = 0;
const host = () => `https://m${++hosts}.localhost`;
async function ask(path: string, accept = "text/html") {
  const res = await handleRequest(new Request(`${host()}${path}`, { headers: { Accept: accept } }), env);
  return { res, text: await res.text() };
}
const SUMMARY = "Fails to start on arm64 only; the full image works. Tested on three runners.";

describe("a post's page", () => {
  test("shows its summary under its title and above its body, in all three formats", async () => {
    const html = await ask("/spaces/summary-notes/1");
    assert.equal(html.res.status, 200, html.text.slice(0, 300));
    assert.match(html.text, new RegExp(`<p class="meta">Summary</p>\\s*<pre>${SUMMARY.replace(/[.;]/g, "\\$&")}</pre>`));
    const page = html.text.slice(html.text.indexOf("<h1>"));
    assert.ok(page.indexOf(SUMMARY) > 0 && page.indexOf(SUMMARY) < page.indexOf(BODY), "the summary comes before the body");
    assert.deepEqual(htmlProblems(html.text), []);
    const md = await ask("/spaces/summary-notes/1.md", "text/markdown");
    assert.match(md.text, /summary:\n\n```\nFails to start on arm64 only; the full image works\. Tested on three runners\.\n```\n/);
    assert.ok(md.text.lastIndexOf(SUMMARY) < md.text.lastIndexOf(BODY), "and in markdown");
    assert.deepEqual(markdownProblems(md.text), []);
    const doc = JSON.parse((await ask("/spaces/summary-notes/1.json", "application/json")).text);
    assert.equal(doc.post.summary, SUMMARY);
    assert.equal(doc.post.body, BODY);
    assert.deepEqual(Object.keys(doc.post).slice(0, 8), ["post_id", "space_id", "seq", "kind", "author", "posted_at", "title", "summary"]);
  });

  test("a post with none shows no label and no key, as before", async () => {
    const html = (await ask("/spaces/summary-notes/2")).text;
    assert.ok(!html.includes(">Summary<"));
    assert.ok(!(await ask("/spaces/summary-notes/2.md", "text/markdown")).text.includes("summary:"));
    assert.ok(!("summary" in JSON.parse((await ask("/spaces/summary-notes/2.json", "application/json")).text).post));
  });
});

describe("a space's stream", () => {
  test("shows a summary beside its body, and none under a post that has none", async () => {
    const { text } = await ask("/spaces/summary-notes");
    assert.equal(text.split(">Summary<").length - 1, 2, "the first post's and the hostile one's");
    // Newest first, so the first post's is the last item.
    const first = text.slice(text.indexOf("Slim fails on arm64: 3 of 3 runs"));
    assert.ok(first.indexOf(SUMMARY) > 0 && first.indexOf(SUMMARY) < first.indexOf(BODY));
    const md = (await ask("/spaces/summary-notes.md", "text/markdown")).text;
    assert.ok(md.includes(`summary:\n\n\`\`\`\n${SUMMARY}\n\`\`\``));
    const items = JSON.parse((await ask("/spaces/summary-notes.json", "application/json")).text).posts as Json[];
    assert.equal(items.find((p) => p.seq === "1")!.summary, SUMMARY);
    assert.ok(!("summary" in items.find((p) => p.seq === "2")!));
  });

  test("is text and never structure, in every format", async () => {
    const html = (await ask("/spaces/summary-notes")).text;
    assert.deepEqual(htmlProblems(html), []);
    assert.ok(!html.includes("<script>alert(1)"), "no raw script tag");
    assert.ok(!tags(html).some((t) => t.name === "img" && t.attributes.some(([k]) => k === "onerror")), "no image with a handler");
    assert.deepEqual(markdownProblems((await ask("/spaces/summary-notes.md", "text/markdown")).text), []);
    const doc = JSON.parse((await ask("/spaces/summary-notes.json", "application/json")).text);
    assert.ok((doc.posts as Json[]).some((p) => p.summary === `${XSS}\n${FENCE}`), "the JSON keeps it as sent, and still parses");
  });

  test("shows no summary of a hidden post, a withheld one, a version or a sealed one, whatever the service sent", async () => {
    for (const [path, accept] of [["/spaces/summary-notes", "text/html"], ["/spaces/summary-notes.md", "text/markdown"], ["/spaces/summary-notes.json", "application/json"],
      ["/spaces/summary-notes/4", "text/html"], ["/spaces/summary-notes/4.json", "application/json"], ["/spaces/summary-notes/5", "text/html"], ["/spaces/summary-notes/5.json", "application/json"],
      ["/spaces/summary-notes/6", "text/html"], ["/spaces/summary-notes/6.json", "application/json"],
      ["/spaces/summary-notes/7", "text/html"], ["/spaces/summary-notes/7.json", "application/json"],
      ["/spaces/summary-notes/all", "text/html"], ["/spaces/summary-notes/all.json", "application/json"]] as const) {
      const { text } = await ask(path, accept);
      for (const canary of [HIDDEN_CANARY, WITHHELD_CANARY, VERSION_CANARY, SEALED_CANARY]) assert.ok(!text.includes(canary), `${path} shows ${canary}`);
    }
  });
});

describe("a list of posts", () => {
  test("shows the summary where it would show the snippet, in the archive, the replies and what stands", async () => {
    for (const path of ["/spaces/summary-notes/all", "/spaces/summary-notes/1/replies", "/spaces/summary-notes/standing"]) {
      const html = (await ask(path)).text;
      assert.match(html, /<p class="meta">Summary<\/p>\s*<pre>/, `${path} shows a summary`);
      assert.deepEqual(htmlProblems(html), [], path);
      const md = (await ask(`${path}.md`, "text/markdown")).text;
      assert.match(md, /summary:\n\n`{3,}\n/, path);
      assert.deepEqual(markdownProblems(md), [], path);
      const doc = JSON.parse((await ask(`${path}.json`, "application/json")).text);
      const rows = (doc.posts ?? doc.replies) as Json[];
      assert.ok(rows.some((p) => typeof p.summary === "string"), `${path} carries one`);
      assert.ok(rows.every((p) => !("summary" in p) || typeof p.summary === "string"));
    }
  });

  test("the archive shows the first post's summary and not the snippet of its body", async () => {
    const html = (await ask("/spaces/summary-notes/all")).text;
    const first = html.slice(html.indexOf("Slim fails on arm64"), html.indexOf("A post with no summary"));
    assert.ok(first.includes(SUMMARY));
    assert.ok(!first.includes("The long working"), "a list gives the summary in place of the start of the body");
    const second = html.slice(html.indexOf("A post with no summary"), html.indexOf("A hostile summary"));
    assert.ok(second.includes("Only a body."), "a post with none still shows its snippet");
  });
});

describe("Seek", () => {
  test("shows a hit's summary where it would show the snippet, in all three formats", async () => {
    const q = "q=arm64";
    const html = (await ask(`/seek?${q}`)).text;
    assert.match(html, /<p class="meta">Summary<\/p>\s*<pre>Fails to start on arm64 only/);
    assert.deepEqual(htmlProblems(html), []);
    const md = (await ask(`/seek.md?${q}`, "text/markdown")).text;
    assert.ok(md.includes(`summary:\n\n\`\`\`\n${SUMMARY}\n\`\`\``));
    assert.deepEqual(markdownProblems(md), []);
    const hits = JSON.parse((await ask(`/seek.json?${q}`, "application/json")).text).items as Json[];
    assert.equal(hits.find((h) => h.seq === "1")!.summary, SUMMARY);
  });
});

describe("a mailbox", () => {
  test("shows a post's summary where it would show the snippet, and none of a hidden post's", async () => {
    const res = await handleRequest(new Request(`${SITE}/me/mailbox`, { headers: { Cookie: cookie } }), env);
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.match(text, /<h3>Slim fails on arm64<\/h3><p class="meta">Summary<\/p>\s*<pre>Fails on arm64 only\.<\/pre>/);
    assert.match(text, /<h3>No summary<\/h3><pre>Only a body\.<\/pre>/, "a post with none shows its snippet as before");
    assert.ok(!text.includes(HIDDEN_CANARY));
  });
});
