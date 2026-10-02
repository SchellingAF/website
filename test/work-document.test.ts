// A work space's living document on its page: the current version between the findings and the
// stream, its history and two versions compared, under the space's own visibility, the mark when
// a post a section cites was replaced or retracted, the form that proposes a change, and the
// sentences that say a work space may keep one.
//
// Driven through handleRequest() against the stand-in service, which answers a work space's
// document and versions as the product's `GET /v1/spaces/{name}/document` and `/versions` do
// for a space whose profile has `document`, and refuses one that has none. An oracle space's
// own pages are test/oracle.test.ts's.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, CATEGORIES, json, refusal, service, type Json, type World } from "./lib/service.ts";
import { htmlProblems, markdownProblems, signedInProblems, tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";
import * as H from "./fixtures/hostile.ts";
import { parseDocument } from "../src/document.ts";

const AP = await import("../content/api-overview.mjs");

const OWNER = "a1b2".repeat(16);
const ALICE = "c3d4".repeat(16);
const SPACE_ID = "0199e0e0-0000-7000-8000-00000000aaaa";
/** A post's id, by the space it is in and its number. */
const id = (space: number, n: number) => `0199e1e1-0000-7000-8${space}00-${String(n).padStart(12, "0")}`;
const at = (n: number) => `2026-10-01T10:0${n}:00.000Z`;

const FIRST = "Lead.\n\n## Images\n\nUse slim.\n\n## Notes\n\nNothing yet.";
const SECOND = "Lead.\n\n## Images\n\nUse slim; arm64 needs full. [[field-notes/2|the failure]] [[git.commit:abc123]]\n\n## Notes\n\nNothing yet.";

const ACCESS = {
  owner: { role: "owner", tags: [], read: true, post: true, decide: true },
  writer: { role: "writer", tags: [], read: true, post: true, decide: false },
  coordinator: { role: "coordinator", tags: [], read: true, post: true, decide: true },
  reader: { role: "reader", tags: [], read: true, post: false, decide: false },
  stranger: { role: null, tags: [], read: true, post: true, decide: false },
};

const space = (name: string, fields: Json = {}): Json => ({
  name, space_id: SPACE_ID, title: `The ${name}`, description: "A work space with a document.", visibility: "public", join_policy: "request",
  status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: OWNER,
  contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-10-01T09:00:00.000Z", access: ACCESS.owner,
  ...fields,
});
const post = (n: number, name: string, index: number, fields: Json): Json => ({
  post_id: id(index, n), space: name, seq: String(n), author: ALICE, posted_at: at(n), title: null, to: [], reply_to: null,
  supersedes: null, retracts: null, fingerprints: [], signed: false, space_id: SPACE_ID, ...fields,
});
const version = (n: number, index: number, state: string, fields: Json = {}): Json => ({
  post_id: id(index, n), seq: String(n), author: ALICE, posted_at: at(n), summary: null, signed: false, state, edits: null,
  same_text_as: null, decision: null, ...fields,
});

/** The record of a document with a replaced first version, a current one, a declined one and one waiting. */
function record(name: string, index: number) {
  const p = (n: number, fields: Json) => post(n, name, index, fields);
  return {
    posts: [
      p(1, { kind: "version", author: OWNER, title: "First", body: FIRST }),
      p(2, { kind: "obs", title: "slim breaks on arm64", body: "It fails to start." }),
      p(3, { kind: "version", title: "An arm64 note", body: SECOND, supersedes: id(index, 1) }),
      p(4, { kind: "go", author: OWNER, body: "Adds a sourced note.", reply_to: id(index, 3) }),
      p(5, { kind: "version", title: "Rewrite it all", body: "Nothing.", supersedes: id(index, 3) }),
      p(6, { kind: "veto", author: OWNER, body: "It deletes the document without a reason.", reply_to: id(index, 5) }),
      p(7, { kind: "version", title: "More", body: `${SECOND}\n\nMore.`, supersedes: id(index, 3) }),
      p(8, { kind: "result", title: "arm64 full works", body: "It starts." }),
    ],
    versions: (current: Json = {}) => [
      version(1, index, "replaced", { author: OWNER, summary: "First" }),
      version(3, index, "current", {
        summary: "An arm64 note", edits: "1",
        decision: { post_id: id(index, 4), seq: "4", kind: "go", author: OWNER, reason: "Adds a sourced note.", at: at(4) },
        ...current,
      }),
      version(5, index, "declined", {
        summary: "Rewrite it all", edits: "3",
        decision: { post_id: id(index, 6), seq: "6", kind: "veto", author: OWNER, reason: "It deletes the document without a reason.", at: at(6) },
      }),
      version(7, index, "pending", { summary: "More", edits: "3" }),
    ],
  };
}
const field = record("field-notes", 1);
const plain = record("plain-notes", 2);
const team = record("team-notes", 3);
const writer = record("writer-notes", 4);
const coordinator = record("coord-notes", 5);
const stranger = record("open-notes", 6);
const reader = record("reader-notes", 7);
const busy = record("busy-notes", 8);
const shut = record("shut-notes", 9);
// A work space whose document, summaries, decline reason and section marks are all hostile.
const hostile = (() => {
  const p = (n: number, fields: Json) => post(n, "hostile-doc", 0, { ...fields });
  return {
    posts: [
      p(1, { kind: "version", title: H.PROPOSAL_SUMMARY, body: H.ORACLE_DOCUMENT }),
      p(2, { kind: "version", title: H.PROPOSAL_SUMMARY, body: `${H.ORACLE_DOCUMENT}\n\n${H.XSS}`, supersedes: id(0, 1) }),
      p(3, { kind: "veto", title: null, body: H.DECLINE_REASON, reply_to: id(0, 2) }),
      p(4, { kind: "obs", title: `A hostile observation ${H.XSS}`, body: H.XSS }),
    ],
    versions: [
      version(1, 0, "current", { summary: H.PROPOSAL_SUMMARY, source_withdrawn: true }),
      version(2, 0, "declined", {
        summary: H.PROPOSAL_SUMMARY, edits: "1",
        decision: { post_id: id(0, 3), seq: "3", kind: "veto", author: ALICE, reason: H.DECLINE_REASON, at: at(3) },
      }),
    ],
    // The second section of the text, marked by the service, and a section the service names that the text has not.
    sections: [
      { id: parseDocument(H.ORACLE_DOCUMENT).sections[2]!.id, level: 2, heading: "x", source_withdrawn: true },
      { id: `<script>alert(91)</script>`, level: 2, heading: "y", source_withdrawn: true },
    ],
  };
})();

const document = (index: number) => ({ version: { post_id: id(index, 3), seq: "3" }, pending: 1 });

/** A finding as the product lists one, and a task, so the order of the reads beside the stream can be held. */
const finding = { number: 1, post_id: id(1, 8), claim: "Slim fails on arm64", status: "supported", confidence: "high", author: ALICE, seq: "8", posted_at: at(8), sources: [id(1, 2)], cited_by: 0, source_withdrawn: false, supersedes: null, superseded_by: null, retracted_by: null };

const world: World = {
  capabilities: { ...CAPABILITIES, modules: { ...CAPABILITIES.modules, tasks: { status: "available" }, findings: { status: "available" } } },
  categories: CATEGORIES,
  spaces: [
    space("field-notes", { document: document(1) }),
    space("plain-notes", { document: document(2) }),
    space("blank-notes", { document: { version: null, pending: 0 } }),
    space("quiet-notes"),
    space("team-notes", { visibility: "private", document: document(3) }),
    space("writer-notes", { document: document(4), access: ACCESS.writer }),
    space("coord-notes", { document: document(5), access: ACCESS.coordinator }),
    space("open-notes", { document: document(6), join_policy: "open", access: ACCESS.stranger }),
    space("reader-notes", { document: document(7), access: ACCESS.reader }),
    space("busy-notes", { document: document(8) }),
    space("shut-notes", { document: document(9) }),
    space("closed-notes", { visibility: "private", document: null }),
    space("hostile-doc", { title: `A hostile work space ${H.XSS}`, description: `Hostile ${H.ATTRIBUTE_BREAKOUT}`, document: { version: { post_id: id(0, 1), seq: "1" }, pending: 1 } }),
    space("oracle-doc", { oracle: true, service_reviewer: true, forked_from: null, document: document(1) }),
  ],
  posts: {
    "field-notes": field.posts, "plain-notes": plain.posts, "blank-notes": [], "quiet-notes": [post(1, "quiet-notes", 0, { kind: "obs", title: "Hello", body: "Hi." })],
    "team-notes": team.posts, "writer-notes": writer.posts, "coord-notes": coordinator.posts, "open-notes": stranger.posts,
    "reader-notes": reader.posts, "busy-notes": busy.posts, "shut-notes": shut.posts, "closed-notes": [], "oracle-doc": [], "hostile-doc": hostile.posts,
  },
  versions: {
    // The service marks the current version and the section it cites a replaced post in.
    "field-notes": field.versions({ source_withdrawn: true }),
    "plain-notes": plain.versions(), "team-notes": team.versions(), "writer-notes": writer.versions(),
    "coord-notes": coordinator.versions(), "open-notes": stranger.versions(), "reader-notes": reader.versions(),
    "busy-notes": busy.versions(), "shut-notes": shut.versions(), "oracle-doc": [], "hostile-doc": hostile.versions,
  },
  documentFields: {
    "field-notes": {
      sections: [
        { id: "lead", level: 0, heading: "", source_withdrawn: false },
        { id: "images", level: 2, heading: "Images", source_withdrawn: true },
        { id: "notes", level: 2, heading: "Notes", source_withdrawn: false },
      ],
    },
    // A service that names a section the text has not is not believed.
    "plain-notes": { sections: [{ id: "invented", level: 2, heading: "Invented", source_withdrawn: true }] },
    "team-notes": { sections: [{ id: "lead", level: 0, heading: "", source_withdrawn: true }] },
    "hostile-doc": { sections: hostile.sections },
  },
  findings: { "field-notes": [finding], "busy-notes": [finding] },
  tasks: { "busy-notes": [] },
  proofs: {}, checkpoints: {}, peers: {},
};
const base = service(world);
const open = { now: 0, most: 0, started: [] as string[] };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const { fake, handleRequest } = await site(async (call) => {
  const watched = /^\/v1\/spaces\/busy-notes\/(posts|tasks|findings|document)$/.exec(call.url.pathname);
  if (watched) {
    open.now += 1;
    open.most = Math.max(open.most, open.now);
    open.started.push(watched[1]!);
    await sleep(15);
    open.now -= 1;
  }
  if (call.url.pathname === "/v1/spaces/shut-notes/document") return refusal(500, "INTERNAL", "the service is unwell");
  if (call.url.pathname === "/v1/mailbox") return json({ items: [], next_after: null, has_more: false, head_seq: "0" });
  if (call.method === "POST" && /^\/v1\/spaces\/[a-z-]+\/posts$/.test(call.url.pathname)) {
    const body = JSON.parse(call.body ?? "{}");
    return json({ post_id: id(1, 9), seq: "9", ...(body.kind === "version" ? { oracle: { state: "pending" } } : {}) }, 201);
  }
  return base(call);
});

const TOKEN = "work-document-token";
const { cookie, csrf } = await signedIn(OWNER, TOKEN, "192.0.2.93");

async function get(path: string, withCookie = false) {
  const res = await handleRequest(new Request(`${SITE}${path}`, withCookie ? { headers: { Cookie: cookie } } : {}), { ...env, SITE_TOKEN: "site-token-for-tests" });
  return { status: res.status, text: await res.text(), headers: res.headers };
}
async function send(path: string, fields: Record<string, string>) {
  const before = fake.calls.length;
  const res = await handleRequest(new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, ...fields }).toString(),
  }), env);
  return { status: res.status, location: res.headers.get("Location"), writes: fake.calls.slice(before).filter((c) => c.method !== "GET") };
}
const callsTo = (path: string) => fake.calls.filter((c) => c.url.pathname === path);
const attr = (t: { attributes: [string, string | null][] } | undefined, name: string) => t?.attributes.find(([n]) => n === name)?.[1];
const inputs = (html: string, name: string) =>
  tags(html).filter((t) => (t.name === "input" || t.name === "textarea") && t.attributes.some(([n, v]) => n === "name" && v === name));

const MARK = "A post it rests on was replaced or retracted.";

describe("a work space that keeps a document, on its public page", () => {
  test("shows the current version between the findings and the stream, in the words of a work space", async () => {
    const { status, text } = await get("/spaces/field-notes");
    assert.equal(status, 200);
    assert.deepEqual(htmlProblems(text), []);
    const at = (needle: string) => text.indexOf(needle);
    assert.ok(at('<h2 id="findings">') > 0 && at('<h2 id="findings">') < at('<h2 id="document">'), "the document comes after the findings");
    assert.ok(at('<h2 id="document">') < at("<h2>Latest posts</h2>"), "and before the stream");
    assert.match(text, /<h2 id="document">The document<\/h2>/);
    assert.match(text, /This work space keeps one document\. Whoever may post here may propose a change to it/);
    assert.match(text, /An approval says a proposal was accepted, not that it is true\./);
    assert.match(text, /Its owner, its admins and its coordinators approve or decline each proposal\./);
    assert.match(text, /<h3 id="section-images">Images<\/h3>/);
    assert.match(text, /<a href="\/spaces\/field-notes\/2" dir="auto">the failure<\/a>/);
    assert.match(text, /Approved in <a href="\/spaces\/field-notes\/4">#4<\/a> by /);
    assert.match(text, /<a href="\/spaces\/field-notes\/compare\?from=1&amp;to=3">what it changed<\/a>/);
    assert.match(text, /1 proposal is waiting for a decision\./);
    assert.match(text, /<a href="\/spaces\/field-notes\/history">Every version and proposal<\/a>/);
    assert.match(text, /<dt>what it is<\/dt><dd>a work space: a conversation of posts, with one document<\/dd>/);
  });

  test("says nothing of a reviewer or a fork, which a work space has neither of", async () => {
    const { text } = await get("/spaces/field-notes");
    assert.doesNotMatch(text, /reviewer/i);
    assert.doesNotMatch(text, /Forked from/);
    assert.doesNotMatch(text, /oracle space/);
    const md = (await get("/spaces/field-notes.md")).text;
    assert.doesNotMatch(md, /reviewer/i);
  });

  test("marks the version, and the section the service marks, with the mark the findings use, and no other", async () => {
    const { text } = await get("/spaces/field-notes");
    assert.equal(text.split(MARK).length - 1, 2, "the version and the one section, and no finding's row, whose source stands");
    assert.match(text, /<h3 id="section-images">Images<\/h3>\n<p class="meta">A post it rests on was replaced or retracted\.<\/p>\n<p>Use slim; arm64 needs full\./);
    assert.doesNotMatch(text, /<h3 id="section-notes">Notes<\/h3>\n<p class="meta">A post it rests/);
    const version = /<p class="meta">Version [\s\S]*?<\/p>\n<p class="meta">([^<]*)<\/p>/.exec(text);
    assert.equal(version?.[1], MARK, "the version's own mark follows its line");
  });

  test("believes no section the text does not have, and marks nothing when the service marks nothing", async () => {
    const odd = (await get("/spaces/plain-notes")).text;
    assert.equal(odd.split(MARK).length - 1, 0);
    assert.doesNotMatch(odd, /invented/i);
    const md = (await get("/spaces/plain-notes.md")).text;
    assert.doesNotMatch(md, /A post it rests on was replaced or retracted/);
    assert.equal(JSON.stringify(JSON.parse((await get("/spaces/plain-notes.json")).text).document.parsed.sections).includes("source_withdrawn"), false);
  });

  test("marks the lead of a document when the service marks it", async () => {
    const { text } = await get("/me/spaces/team-notes", true);
    assert.match(text, /<div class="document">\n<p class="meta">A post it rests on was replaced or retracted\.<\/p>\n<p>Lead\.<\/p>/);
  });

  test("leaves the versions out of the stream, as an oracle space's discussion does, and asks for no version", async () => {
    const before = fake.calls.length;
    const { text } = await get("/spaces/field-notes.json");
    const stream = fake.calls.slice(before).find((c) => c.url.pathname === "/v1/spaces/field-notes/posts");
    const asked = stream?.url.searchParams.get("kind")?.split(",") ?? [];
    assert.ok(asked.includes("obs") && asked.includes("go") && !asked.includes("version"), asked.join(","));
    assert.match(text, /slim breaks on arm64/);
    assert.doesNotMatch(text, /Rewrite it all/, "a declined proposal's words are on no listed page");
    assert.match((await get("/spaces/field-notes")).text, /<h2>Latest posts<\/h2>/);
  });

  test("a page narrowed to its versions is followed and not listed, as an oracle space's is", async () => {
    const narrowed = await get("/spaces/field-notes?kind=version");
    assert.equal(narrowed.headers.get("X-Robots-Tag"), "noindex, follow");
    assert.match(narrowed.text, /Rewrite it all/);
    assert.notEqual((await get("/spaces/field-notes")).headers.get("X-Robots-Tag"), "noindex, follow");
  });

  test("its markdown is the document in a fence, between the findings and the posts, with the marks", async () => {
    const { text } = await get("/spaces/field-notes.md");
    assert.deepEqual(markdownProblems(text), []);
    const at = (needle: string) => text.indexOf(needle);
    assert.ok(at("## Findings") > 0 && at("## Findings") < at("## The document") && at("## The document") < at("## Latest posts"));
    assert.ok(text.includes("```\nLead.\n\n## Images\n\nUse slim; arm64 needs full."), "the text as it was written");
    assert.match(text, /^- history: \/spaces\/field-notes\/history\.md$/m);
    assert.match(text, /^- pending proposals: 1$/m);
    assert.match(text, /^- A post it rests on was replaced or retracted\.$/m);
    assert.match(text, /^- section `images`: A post it rests on was replaced or retracted\.$/m);
    assert.doesNotMatch(text, /^- section `notes`/m);
    assert.match(text, /^- oracle: false \(a work space: a conversation of posts, with one document\)$/m);
  });

  test("its JSON names the parse, the marks and the space's setting, and nothing of a reviewer", async () => {
    const doc = JSON.parse((await get("/spaces/field-notes.json")).text);
    assert.equal(doc.space.document, true);
    assert.equal(doc.space.oracle, false);
    assert.equal(doc.document.version.seq, "3");
    assert.equal(doc.document.version.source_withdrawn, true);
    assert.equal(doc.document.text, SECOND);
    assert.equal(doc.document.pending, 1);
    assert.equal(doc.document.history, "/spaces/field-notes/history");
    assert.deepEqual(doc.document.parsed.sections.filter((s: Json) => s.source_withdrawn).map((s: Json) => s.id), ["images"]);
    assert.ok(!("service_reviewer" in doc.document) && !("reviewer_rules" in doc.document) && !("forked_from" in doc.document));
    assert.deepEqual(doc.posts.map((p: Json) => p.kind), ["result", "veto", "go", "obs"], "every kind but a version");
  });

  test("a document with no version says that any who may post may propose the first", async () => {
    const { text } = await get("/spaces/blank-notes");
    assert.match(text, /Nothing is written in this document yet\. Whoever may post here may propose its first version\./);
    assert.match((await get("/spaces/blank-notes.md")).text, /Whoever may post here may propose its first version\./);
  });

  test("a work space that keeps none has no section and is asked for no document", async () => {
    const before = fake.calls.length;
    const { text } = await get("/spaces/quiet-notes");
    assert.doesNotMatch(text, /The document/);
    assert.doesNotMatch(text, /with one document/);
    assert.equal(fake.calls.slice(before).filter((c) => c.url.pathname.endsWith("/document")).length, 0);
    assert.equal(JSON.parse((await get("/spaces/quiet-notes.json")).text).space.document, undefined);
  });

  test("a document the service could not answer is said so, and the rest of the page stands", async () => {
    const { status, text } = await get("/spaces/shut-notes");
    assert.equal(status, 200);
    assert.deepEqual(htmlProblems(text), []);
    assert.match(text, /<h2 id="document">The document<\/h2>\n<p class="note warn">This site could not read the space&#39;s document just now\.<\/p>/);
    assert.match(text, /slim breaks on arm64/);
    const doc = JSON.parse((await get("/spaces/shut-notes.json")).text);
    assert.equal(doc.document, null);
    assert.equal(doc.document_unreadable, true);
    assert.match((await get("/spaces/shut-notes.md")).text, /^This site could not read the space's document just now\.$/m);
  });

  test("is read after the findings, never beside them: a caller with no key never has three reads open at once", async () => {
    open.most = 0; open.started.length = 0;
    const { text } = await get("/spaces/busy-notes");
    assert.match(text, /<h2 id="document">/);
    assert.ok(open.most <= 2, `${open.most} reads were open at once`);
    assert.equal(open.started.at(-1), "document", "the document is asked for last");
    assert.deepEqual([...open.started].sort(), ["document", "findings", "posts", "tasks"]);
  });

  test("is read as the stream is, with the site's own key", async () => {
    await get("/spaces/plain-notes");
    const mine = fake.calls.filter((c) => c.url.pathname === "/v1/spaces/plain-notes/document");
    assert.ok(mine.length >= 1);
    for (const call of mine) assert.equal(call.headers.get("authorization"), "Bearer site-token-for-tests");
  });

  test("an oracle space's page keeps its own words: no mark, its reviewer", async () => {
    const { text } = await get("/spaces/oracle-doc");
    assert.match(text, /<h2>The document<\/h2>/);
    assert.match(text, /An oracle space is one public document\./);
    assert.match(text, /The rules the reviewer applies/);
  });
});

describe("a work space's document, under the space's visibility", () => {
  test("a private space's public address shows no document and asks for none", async () => {
    const before = fake.calls.length;
    const { text } = await get("/spaces/team-notes");
    assert.doesNotMatch(text, /The document/);
    assert.doesNotMatch(text, /arm64 needs full/);
    assert.equal(fake.calls.slice(before).filter((c) => c.url.pathname.endsWith("/document") || c.url.pathname.endsWith("/versions")).length, 0);
    assert.doesNotMatch((await get("/spaces/team-notes.md")).text, /arm64 needs full/);
    assert.doesNotMatch((await get("/spaces/team-notes.json")).text, /arm64 needs full/);
  });

  test("a private space's history and comparison on the public address are refused, and read nothing", async () => {
    const before = fake.calls.length;
    const history = await get("/spaces/team-notes/history");
    const compare = await get("/spaces/team-notes/compare?from=1&to=3");
    for (const page of [history, compare]) {
      assert.doesNotMatch(page.text, /arm64 needs full|An arm64 note/);
      assert.match(page.text, /private/);
    }
    assert.equal(fake.calls.slice(before).filter((c) => /\/(versions|document)$/.test(c.url.pathname)).length, 0);
  });

  test("the signed-in person's own view of a private space shows it, read as that person and kept from every cache", async () => {
    const before = fake.calls.length;
    const { status, text, headers } = await get("/me/spaces/team-notes", true);
    assert.equal(status, 200);
    assert.deepEqual(signedInProblems(text), []);
    assert.match(text, /<h2 id="document">The document<\/h2>/);
    assert.match(text, /<h3 id="section-images">Images<\/h3>/);
    assert.equal(headers.get("Cache-Control"), "private, no-store");
    const reads = fake.calls.slice(before).filter((c) => c.url.pathname === "/v1/spaces/team-notes/document");
    assert.equal(reads.length, 1);
    assert.equal(reads[0]!.headers.get("authorization"), `Bearer ${TOKEN}`);
  });

  test("its history and comparison, read as the signed-in person, work", async () => {
    const history = await get("/me/spaces/team-notes/history", true);
    assert.equal(history.status, 200);
    assert.deepEqual(signedInProblems(history.text), []);
    assert.equal(history.headers.get("Cache-Control"), "private, no-store");
    const compare = await get("/me/spaces/team-notes/compare?from=1&to=3", true);
    assert.equal(compare.status, 200);
    assert.match(compare.text, /arm64 needs full/);
    const reads = fake.calls.filter((c) => c.url.pathname === "/v1/spaces/team-notes/versions").at(-1);
    assert.equal(reads?.headers.get("authorization"), `Bearer ${TOKEN}`);
  });

  test("a space whose document its profile hides from the reader has no section and is asked for none", async () => {
    const before = fake.calls.length;
    const { text } = await get("/me/spaces/closed-notes", true);
    assert.doesNotMatch(text, /The document/);
    assert.equal(fake.calls.slice(before).filter((c) => c.url.pathname.endsWith("/document")).length, 0);
  });
});

describe("its history and what two versions changed", () => {
  test("the history lists every version newest first, in a work space's words, with no reviewer", async () => {
    const { status, text, headers } = await get("/spaces/field-notes/history");
    assert.equal(status, 200);
    assert.equal(headers.get("X-Robots-Tag"), "noindex, follow");
    assert.deepEqual(htmlProblems(text), []);
    const order = [...text.matchAll(/<span class="tag(?: on)?">([^<]+)<\/span><a href="\/spaces\/field-notes\/(\d+)">/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(order, [["waiting", "7"], ["declined", "5"], ["the document now", "3"], ["replaced", "1"]]);
    assert.match(text, /This work space keeps one document\./);
    assert.doesNotMatch(text, /reviewer/i);
    assert.doesNotMatch(text, /oracle space/);
    assert.match(text, /Every version of the document in the work space field-notes/, "the description says which kind of space");
    assert.match(text, /<a href="\/spaces\/field-notes\/compare\?from=1&amp;to=3">what it changes<\/a>/);
    const md = await get("/spaces/field-notes/history.md");
    assert.deepEqual(markdownProblems(md.text), []);
    assert.match(md.text, /^## #5 declined$/m);
    assert.doesNotMatch(md.text, /reviewer/i);
    const doc = JSON.parse((await get("/spaces/field-notes/history.json")).text);
    assert.deepEqual(doc.versions.map((v: Json) => v.state), ["pending", "declined", "current", "replaced"]);
    assert.ok(!("reviewer_rules" in doc));
    assert.match(doc.about, /^This work space keeps one document\./);
  });

  test("two versions are compared line by line, and the description names the work space", async () => {
    const { status, text } = await get("/spaces/field-notes/compare?from=1&to=3");
    assert.equal(status, 200);
    assert.deepEqual(htmlProblems(text), []);
    assert.match(text, /Two versions of the document in the work space field-notes/);
    assert.match(text, /arm64 needs full/);
    const md = await get("/spaces/field-notes/compare.md?from=1&to=3");
    assert.deepEqual(markdownProblems(md.text), []);
    assert.match(md.text, /^- history: \/spaces\/field-notes\/history\.md$/m);
    const doc = JSON.parse((await get("/spaces/field-notes/compare.json?from=1&to=3")).text);
    assert.ok(doc.lines.some((l: Json) => l.t === "add" || l.t === "+" || typeof l.line === "string"));
  });

  test("a work space that keeps no document has neither, and says a work space may keep one", async () => {
    for (const path of ["/spaces/quiet-notes/history", "/spaces/quiet-notes/compare?from=1&to=2"]) {
      const { status, text } = await get(path);
      assert.equal(status, 404, path);
      assert.match(text, /Not an oracle space/);
      assert.match(text, /A work space may keep one document, if its owner turns that on\./);
    }
  });

  test("a version's own page says which document it belongs to, and what became of it", async () => {
    const waiting = await get("/spaces/field-notes/7");
    assert.equal(waiting.status, 200);
    assert.match(waiting.text, /A version of this work space's document\. It is a proposal, waiting for the owner, an admin or a coordinator to approve or decline it\./);
    assert.equal(waiting.headers.get("X-Robots-Tag"), "noindex, follow", "a proposal nobody decided is nobody's document");
    const current = await get("/spaces/field-notes/3");
    assert.match(current.text, /A version of this work space's document\. It is the document now\./);
    assert.notEqual(current.headers.get("X-Robots-Tag"), "noindex, follow");
    const md = await get("/spaces/field-notes/7.md");
    assert.match(md.text, /A version of this work space's document\./);
    assert.equal(JSON.parse((await get("/spaces/field-notes/3.json")).text).version.state, "current");
  });

  test("the list of every post gives a version by its number alone", async () => {
    const { text } = await get("/spaces/field-notes/all");
    assert.match(text, /slim breaks on arm64/);
    assert.doesNotMatch(text, /Rewrite it all|An arm64 note/, "no proposal's title on a listed page");
    const doc = JSON.parse((await get("/spaces/field-notes/all.json")).text);
    for (const p of doc.posts.filter((p: Json) => p.kind === "version")) assert.ok(!p.title && !p.snippet, `version ${p.seq}`);
  });
});

describe("proposing a version from the site", () => {
  const formOf = (html: string) => /<h2>(?:Propose a change|Write the first version)<\/h2>[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";

  test("the owner, an admin or a coordinator may approve their own, and is told so", async () => {
    for (const name of ["field-notes", "coord-notes"]) {
      const { text } = await get(`/me/spaces/${name}`, true);
      const form = formOf(text);
      assert.ok(form, `${name}: no form`);
      assert.match(form, /You may approve your own, so it becomes the document at once\./);
      assert.match(form, /<button type="submit">Make it the document<\/button>/);
      assert.match(form, /Every version stays in the history, a declined one too, with who declined it and why\. Whoever reads this space reads them\./);
      assert.doesNotMatch(form, /Cite public posts|stays public/);
      assert.equal(attr(inputs(form, "kind")[0], "value"), "version");
      assert.equal(attr(inputs(form, "then")[0], "value"), "history");
      assert.equal(attr(inputs(form, "supersedes")[0], "value"), id(name === "field-notes" ? 1 : 5, 3), "it replaces the version that stands");
      assert.ok(/<textarea[^>]*name="body"[^>]*>Lead\./.test(form), "starting from the whole text now");
    }
  });

  test("a writer proposes, and the sentence names who decides in a work space", async () => {
    const { text } = await get("/me/spaces/writer-notes", true);
    const form = formOf(text);
    assert.match(form, /It waits until the owner, an admin or a coordinator approves or declines it, and the decision reaches your mailbox\./);
    assert.doesNotMatch(form, /reviewer/);
    assert.match(form, /<button type="submit">Propose it<\/button>/);
  });

  test("a key with no role in a work space anyone posts in proposes too", async () => {
    const { text } = await get("/me/spaces/open-notes", true);
    const form = formOf(text);
    assert.ok(form, "no form");
    assert.match(form, /<button type="submit">Propose it<\/button>/);
    assert.ok(text.indexOf(form) < text.indexOf("Post in this space"), "the form before the plain post form");
    assert.equal(inputs(text, "kind").filter((t) => attr(t, "value") === "version").length, 1, "one version form");
  });

  test("a reader, and a space with no document, are offered no form, and the plain post form leaves out the version kind", async () => {
    assert.equal(formOf((await get("/me/spaces/reader-notes", true)).text), "");
    assert.equal(formOf((await get("/me/spaces/quiet-notes", true)).text), "");
    const owner = (await get("/me/spaces/field-notes", true)).text;
    const kinds = tags(owner).filter((t) => t.name === "option").map((t) => attr(t, "value"));
    assert.ok(!kinds.includes("version"), "version is not in the kind list");
    assert.ok(!/Fork this oracle space|Watch this document/.test(owner), "no fork and no watch: those are an oracle space's");
  });

  test("the first version of an empty document is offered as such, replacing nothing", async () => {
    const form = formOf((await get("/me/spaces/blank-notes", true)).text);
    assert.match(form, /<h2>Write the first version<\/h2>/);
    assert.deepEqual(inputs(form, "supersedes"), []);
  });

  test("sends it as a post of the kind version and lands on the history, which says it is waiting", async () => {
    const r = await send("/me/spaces/writer-notes/posts", { kind: "version", then: "history", supersedes: id(4, 3), title: "More", body: `${SECOND}\n\nMore.` });
    assert.equal(r.status, 303);
    assert.equal(r.location, "/me/spaces/writer-notes/history?notice=proposed");
    assert.equal(r.writes.length, 1);
    const body = JSON.parse(r.writes[0]!.body ?? "{}");
    assert.equal(body.kind, "version");
    assert.equal(body.supersedes, id(4, 3));
  });

  test("the history carries Approve and Decline on a waiting proposal for a key that may decide, and for none that may not", async () => {
    const owner = (await get("/me/spaces/field-notes/history", true)).text;
    assert.match(owner, /<button[^>]*>Approve/);
    assert.match(owner, /<button[^>]*>Decline/);
    const writerView = (await get("/me/spaces/writer-notes/history", true)).text;
    assert.doesNotMatch(writerView, /<button[^>]*>Approve/);
  });

  test("a version's page offers a decider the panel that decides, and no reply form with go or veto", async () => {
    const { text } = await get("/me/spaces/field-notes/7", true);
    assert.match(text, /<button[^>]*>Approve/);
    const values = tags(text).filter((t) => t.name === "option").map((t) => attr(t, "value"));
    assert.ok(!values.includes("go") && !values.includes("veto"), "a decision is the panel's, not a reply's");
  });
});

describe("a hostile work space's document is text, never structure", () => {
  const PAGES = ["/spaces/hostile-doc", "/spaces/hostile-doc/history", "/spaces/hostile-doc/compare?from=1&to=2", "/spaces/hostile-doc/2"];
  for (const path of PAGES) {
    const [bare, query = ""] = path.split("?");
    const twin = (ext: string) => `${bare}${ext}${query ? `?${query}` : ""}`;
    test(`${path}: HTML, markdown and JSON`, async () => {
      const html = await get(path);
      assert.equal(html.status, 200, html.text.slice(0, 300));
      assert.deepEqual(htmlProblems(html.text), []);
      assert.match(html.text, /&lt;script&gt;alert\(\d+\)&lt;\/script&gt;/);
      const md = await get(twin(".md"));
      assert.equal(md.status, 200);
      assert.deepEqual(markdownProblems(md.text), []);
      assert.ok(md.text.includes("<script>alert("));
      const doc = await get(twin(".json"));
      assert.equal(doc.status, 200);
      assert.ok(JSON.stringify(JSON.parse(doc.text)).includes("<script>alert("));
    });
  }

  test("the mark goes only under a heading the text has, and a service's section id is never a tag, a name or an address", async () => {
    const { text } = await get("/spaces/hostile-doc");
    const marked = text.split(MARK).length - 1;
    assert.equal(marked, 2, "the version and the one real section");
    assert.doesNotMatch(text, /alert\(91\)/, "the invented section's id appears nowhere");
    const md = (await get("/spaces/hostile-doc.md")).text;
    assert.doesNotMatch(md, /alert\(91\)/);
    assert.equal((md.match(/^- section `/gm) ?? []).length, 1);
    assert.doesNotMatch((await get("/spaces/hostile-doc.json")).text, /alert\(91\)/);
  });
});

describe("what a person reads about it elsewhere", () => {
  test("the Vocabulary says a work space may keep a document, and who decides there", async () => {
    const { text } = await get("/vocabulary");
    assert.match(text, /A work space may also keep one document, which whoever may post there proposes changes to\./);
    assert.match(text, /The text of an oracle space, or of a work space that keeps one: its newest approved version\./);
    assert.match(text, /A declined one stays in the history, with who declined it and why, for whoever reads the space\./);
    assert.match(text, /or in a work space a coordinator, each with a reason whoever reads the space can read\./);
    assert.match(text, /The versions of a document, an oracle space&#39;s or a work space&#39;s, each one proposed and then approved or declined\./);
    assert.match(text, /a whole new text for the document of an oracle space or a work space, proposed until it is approved or declined/);
  });

  test("/api names the module's work-space sentence, and the ledger the pages that show a work space's document", async () => {
    const entries = (AP.today as { entries?: [string, string][]; terms?: [string, string][] });
    const text = JSON.stringify(AP.today);
    assert.ok(entries, "the page's list of what the service does today");
    assert.match(text, /A work space may keep one document as well, read by whoever reads the space: whoever may post there proposes a version, and its owner, an admin or a coordinator decides, never the reviewer\./);
    assert.match(text, /version for the text of a document, an oracle space's or a work space's\./);
    const ledger = (AP.operationPages as Record<string, { pages?: string[]; note?: string }>)["oracle.document"]!;
    assert.match(ledger.note ?? "", /the page of an oracle space, or of a work space that keeps a document, shows it/);
    assert.ok(ledger.pages?.includes("/spaces/<name>") && ledger.pages.includes("/me/spaces/<name>"));
  });

  test("a page that shows a work space's document leads to its history and to a version's comparison", async () => {
    const { text } = await get("/spaces/field-notes");
    const links = tags(text).filter((t) => t.name === "a").map((t) => attr(t, "href")?.replace(/&amp;/g, "&"));
    assert.ok(links.includes("/spaces/field-notes/history"));
    assert.ok(links.includes("/spaces/field-notes/compare?from=1&to=3"), links.join(" "));
    const history = await get("/spaces/field-notes/history");
    const form = tags(history.text).find((t) => t.name === "form" && attr(t, "action") === "/spaces/field-notes/compare");
    assert.ok(form, "the history's comparison form");
  });
});
