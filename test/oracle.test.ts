// An oracle space on the site: its document on its page, its history, two versions
// compared, what became of one version, what links to a space and a post, and the
// forms a signed-in key proposes, decides, undoes, forks and watches with.
//
// Driven through handleRequest() against the stand-in service with an honest world:
// test/escaping.test.ts holds the same pages to the escaping rules with a hostile one.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, CATEGORIES, json, refusal, service, type Call, type Json, type World } from "./lib/service.ts";
import { htmlProblems, markdownProblems, signedInProblems, tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

/** How many times a page carries the site's own script that signs with a passkey. */
const signingScripts = (html: string) => html.split(`<script type="module" src="/sign-post.js"></script>`).length - 1;

const OWNER = "a1b2".repeat(16);
const ALICE = "c3d4".repeat(16);
const REVIEWER = "e7e7".repeat(16);
const SPACE_ID = "0199dddd-0000-7000-8000-00000000aaaa";
const id = (n: number) => `0199dddd-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = (n: number) => `2026-09-18T10:0${n}:00.000Z`;

const FIRST = "Lead.\n\n## Images\n\nUse slim.";
const SECOND = "Lead.\n\n## Images\n\nUse slim; arm64 needs full. [[build-notes/1|the failure]] [[git.commit:abc123]] [[https://example.com/a]]";

const space = (name: string, fields: Json): Json => ({
  name, space_id: SPACE_ID, title: "Runner images", description: "Which image to use.",
  visibility: "public", join_policy: "request", status: "active", signed_only: false, replaced_by: null,
  categories: ["general"], owner: OWNER, contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-18T09:00:00.000Z",
  access: { role: "owner", tags: [], read: true, post: true, decide: true },
  ...fields,
});
const post = (space: string, seq: number, fields: Json): Json => ({
  post_id: id(seq + (space === "build-notes" ? 100 : 0)), space, seq: String(seq), author: ALICE, posted_at: at(seq),
  title: null, to: [], reply_to: null, supersedes: null, retracts: null, fingerprints: [], signed: false, space_id: SPACE_ID,
  ...fields,
});
const version = (seq: number, state: string, fields: Json = {}): Json => ({
  post_id: id(seq), seq: String(seq), author: ALICE, posted_at: at(seq), summary: null, signed: false,
  state, edits: null, same_text_as: null, decision: null, ...fields,
});

const world: World = {
  capabilities: CAPABILITIES,
  categories: CATEGORIES,
  spaces: [
    space("runner-images", {
      oracle: true, service_reviewer: true, forked_from: "older-images",
      document: { version: { post_id: id(3), seq: "3" }, pending: 1 },
    }),
    space("build-notes", { title: "Build notes", description: "Where the builds are argued about.", oracle: false, created_at: "2026-09-18T08:00:00.000Z" }),
  ],
  posts: {
    "runner-images": [
      post("runner-images", 1, { kind: "version", author: OWNER, title: "First", body: FIRST }),
      post("runner-images", 2, { kind: "obs", title: "slim breaks on arm64", body: "It fails to start." }),
      post("runner-images", 3, { kind: "version", title: "An arm64 note", body: SECOND, supersedes: id(1) }),
      post("runner-images", 4, { kind: "go", author: REVIEWER, body: "Adds a sourced note.", reply_to: id(3) }),
      post("runner-images", 5, { kind: "version", title: "Rewrite it all", body: "Nothing.", supersedes: id(3) }),
      post("runner-images", 6, { kind: "veto", author: REVIEWER, body: "Rule 4. It deletes the document without a reason.", reply_to: id(5) }),
      post("runner-images", 7, { kind: "version", title: "More", body: `${SECOND}\n\nMore.`, supersedes: id(3) }),
    ],
    "build-notes": [post("build-notes", 1, { kind: "fail", title: "slim on arm64", body: "exit 139" })],
  },
  versions: {
    "runner-images": [
      version(1, "replaced", { author: OWNER, summary: "First" }),
      // Signed through an app connection its author's key allowed.
      version(3, "current", {
        summary: "An arm64 note", edits: "1", signed: true, signed_by: "connection",
        decision: { post_id: id(4), seq: "4", kind: "go", author: REVIEWER, reason: "Adds a sourced note.", at: at(4) },
      }),
      version(5, "declined", {
        summary: "Rewrite it all", edits: "3",
        decision: { post_id: id(6), seq: "6", kind: "veto", author: REVIEWER, reason: "Rule 4. It deletes the document without a reason.", at: at(6) },
      }),
      // Signed by its author's own key: the product names no signer then.
      version(7, "pending", { summary: "More", edits: "3", signed: true }),
    ],
  },
  links: {
    "build-notes": [{ name: "runner-images", title: "Runner images", version_seq: "3", changed_at: at(4) }],
    "build-notes/1": [{ name: "runner-images", title: "Runner images", version_seq: "3", changed_at: at(4) }],
  },
  watching: [],
  proofs: {},
  checkpoints: {},
  peers: {},
};

/** Whether the stand-in refuses a decision, as the product does from a key that may not make one. */
let DENY_DECISIONS = false;

/** What a write answers with, by address. */
const WRITES: Record<string, (call: Call) => Response> = {
  "POST /v1/spaces/runner-images/posts": (call) => {
    const body = JSON.parse(call.body ?? "{}");
    if (DENY_DECISIONS && (body.kind === "go" || body.kind === "veto")) return refusal(403, "CONTROL_DENIED");
    return json({
      post_id: id(8), seq: "8",
      oracle: body.kind === "version" ? { state: "pending" } : body.kind === "go" ? { decided: "approved", version: id(7) } : body.kind === "veto" ? { decided: "declined", version: id(7) } : undefined,
    }, 201);
  },
  "POST /v1/spaces/runner-images/fork": (call) => JSON.parse(call.body ?? "{}").name === "taken-images"
    ? refusal(409, "SPACE_EXISTS")
    : json({ name: "my-images", oracle: true, forked_from: "runner-images" }, 201),
  "PUT /v1/spaces/runner-images/watch": () => json({ space: "runner-images", watching: true }),
  "DELETE /v1/spaces/runner-images/watch": () => json({ space: "runner-images", watching: false }),
  "POST /v1/spaces": () => json({ name: "a-new-oracle" }, 201),
  "PATCH /v1/spaces/runner-images": () => json({}),
  "PATCH /v1/spaces/build-notes": () => json({}),
};
const answer = service(world);
const { fake, handleRequest } = await site((call) => {
  const write = WRITES[`${call.method} ${call.url.pathname}`];
  if (write) return write(call);
  if (call.url.pathname === "/v1/mailbox") {
    return json({
      items: [{ mailbox_seq: "1", reason: "proposal", post: { ...world.posts["runner-images"]![6], snippet: "Lead." } }],
      next_after: "1", has_more: false, head_seq: "1",
    });
  }
  return answer(call);
});
const { esc } = await import("../src/render.ts");

const { cookie, csrf } = await signedIn(OWNER, "oracle-token", "192.0.2.91");

async function get(path: string, withCookie = false) {
  const res = await handleRequest(new Request(`${SITE}${path}`, withCookie ? { headers: { Cookie: cookie } } : {}), env);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

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

const field = (html: string, name: string) =>
  tags(html).filter((t) => (t.name === "input" || t.name === "textarea") && t.attributes.some(([n, v]) => n === "name" && v === name));
const attr = (t: { attributes: [string, string | null][] } | undefined, name: string) => t?.attributes.find(([n]) => n === name)?.[1];

describe("an oracle space's page", () => {
  test("shows its current version as a document, with its references, and says an approval is not truth", async () => {
    const { status, text } = await get("/spaces/runner-images");
    assert.equal(status, 200);
    assert.deepEqual(htmlProblems(text), []);
    assert.match(text, /<h2>The document<\/h2>/);
    assert.match(text, /An approval says a proposal was accepted, not that it is true\./);
    assert.match(text, /<h3 id="section-images">Images<\/h3>/);
    assert.match(text, /<a href="\/spaces\/build-notes\/1" dir="auto">the failure<\/a>/);
    assert.match(text, /<a href="\/seek\?fingerprint=git\.commit%3Aabc123"><code>git\.commit:abc123<\/code><\/a>/);
    assert.match(text, /<a href="https:\/\/example\.com\/a" rel="nofollow ugc noopener noreferrer" dir="ltr">https:\/\/example\.com\/a<\/a>/);
    assert.match(text, /<h3>References<\/h3>/);
    assert.match(text, /Approved in <a href="\/spaces\/runner-images\/4">#4<\/a> by /);
    assert.match(text, /Forked from <a href="\/spaces\/older-images">older-images<\/a>/);
    assert.match(text, /1 proposal is waiting for a decision\./);
    assert.match(text, /<h2>Discussion<\/h2>/);
    assert.match(text, /<a href="\/spaces\/runner-images\/compare\?from=1&amp;to=3">what it changed<\/a>/, "the version it edits, from the document's own answer");
  });

  test("its discussion leaves the versions out, and asks the service for every other kind", async () => {
    const before = fake.calls.length;
    const { text } = await get("/spaces/runner-images.json");
    const stream = fake.calls.slice(before).find((c) => c.url.pathname === "/v1/spaces/runner-images/posts");
    const asked = stream?.url.searchParams.get("kind")?.split(",") ?? [];
    assert.ok(asked.includes("obs") && asked.includes("go") && !asked.includes("version"), asked.join(","));
    const doc = JSON.parse(text);
    assert.deepEqual(doc.posts.map((p: Json) => p.kind), ["veto", "go", "obs"]);
    assert.equal(doc.document.version.seq, "3");
    assert.equal(doc.document.text, SECOND);
    assert.deepEqual(doc.document.parsed.references.map((r: Json) => r.kind), ["post", "identifier", "web"]);
    assert.equal(doc.document.service_reviewer, true);
    assert.equal(doc.space.oracle, true);
    assert.equal(doc.space.forked_from, "older-images");
  });

  test("its markdown is the document's own text in a fence, with its references in code spans", async () => {
    const { text } = await get("/spaces/runner-images.md");
    assert.deepEqual(markdownProblems(text), []);
    assert.match(text, /^## The document$/m);
    assert.ok(text.includes("```\nLead.\n\n## Images\n\nUse slim; arm64 needs full."), "the text, fenced as it was written");
    assert.match(text, /^- identifier: `git\.commit:abc123`$/m);
    assert.match(text, /^- history: \/spaces\/runner-images\/history\.md$/m);
    assert.match(text, /^## Discussion$/m);
  });

  test("a space an oracle space links to says so, and so does the post it cites", async () => {
    const space = await get("/spaces/build-notes");
    assert.match(space.text, /<h2>What links here<\/h2>/);
    assert.match(space.text, /<a href="\/spaces\/runner-images">Runner images<\/a>/);
    assert.doesNotMatch(space.text, /The document/);
    const cited = await get("/spaces/build-notes/1");
    assert.match(cited.text, /<h2>Cited in these oracle spaces<\/h2>/);
    const md = await get("/spaces/build-notes/1.md");
    assert.match(md.text, /^- runner-images: `Runner images`, \/spaces\/runner-images\.md$/m);
  });

  test("the oracle spaces' list marks an oracle space as one, and a letter of work spaces leaves it out", async () => {
    const { text } = await get("/spaces/by/oracle");
    assert.match(text, /<span class="tag on">oracle space<\/span>/);
    const doc = JSON.parse((await get("/spaces/by/oracle.json")).text);
    assert.equal(doc.items.find((s: Json) => s.name === "runner-images")?.oracle, true);
    const letter = JSON.parse((await get("/spaces/r.json")).text);
    assert.ok(!letter.items.some((s: Json) => s.name === "runner-images"), "an oracle space is on no letter of work spaces");
  });

  test("a space's page says which kind it is, and leads to others of its kind", async () => {
    const oracle = await get("/spaces/runner-images");
    assert.match(oracle.text, /<dt>what it is<\/dt><dd>an oracle space: one public document, not a conversation<\/dd>/);
    assert.match(oracle.text, /<a href="\/spaces\/by\/oracle">every oracle space<\/a>/);
    assert.doesNotMatch(oracle.text, /names beginning with r/, "a letter holds work spaces alone");
    const work = await get("/spaces/build-notes");
    assert.match(work.text, /<dt>what it is<\/dt><dd>a work space: a conversation of posts<\/dd>/);
    assert.match(work.text, /<a href="\/spaces">work spaces<\/a> \/ build-notes/);
    assert.match((await get("/spaces/build-notes.md")).text, /^- oracle: false \(a work space: a conversation of posts\)$/m);
  });
});

describe("an oracle space's history", () => {
  test("lists every version newest first, with what became of each and why, and is followed but not listed", async () => {
    const { status, text, headers } = await get("/spaces/runner-images/history");
    assert.equal(status, 200);
    assert.equal(headers.get("X-Robots-Tag"), "noindex, follow");
    assert.deepEqual(htmlProblems(text), []);
    const order = [...text.matchAll(/<span class="tag(?: on)?">([^<]+)<\/span><a href="\/spaces\/runner-images\/(\d+)">/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(order, [["waiting", "7"], ["declined", "5"], ["the document now", "3"], ["replaced", "1"]]);
    assert.match(text, /Declined in <a href="\/spaces\/runner-images\/6">#6<\/a> by .*:<\/p><pre>Rule 4\. It deletes the document without a reason\.<\/pre>/);
    assert.match(text, /<a href="\/spaces\/runner-images\/compare\?from=1&amp;to=3">what it changes<\/a>/);
    const md = await get("/spaces/runner-images/history.md");
    assert.deepEqual(markdownProblems(md.text), []);
    assert.match(md.text, /^## #5 declined$/m);
    assert.match(md.text, /^- reason: `Rule 4\. It deletes the document without a reason\.`$/m);
    const doc = JSON.parse((await get("/spaces/runner-images/history.json")).text);
    assert.deepEqual(doc.versions.map((v: Json) => v.state), ["pending", "declined", "current", "replaced"]);
  });

  test("calls a version's title \"What changed\", so \"summary\" names a post's summary and the kind alone, and keeps the service's field in the JSON", async () => {
    const md = await get("/spaces/runner-images/history.md");
    assert.match(md.text, /^- what changed: `Rewrite it all`$/m);
    assert.doesNotMatch(md.text, /^- summary:/m);
    const doc = JSON.parse((await get("/spaces/runner-images/history.json")).text);
    assert.deepEqual(doc.versions.map((v: Json) => v.summary), ["More", "Rewrite it all", "An arm64 note", "First"], "the product's field name stays");
    const space = await get("/spaces/runner-images");
    assert.match(space.text, /<p class="meta">What changed: <span dir="auto">An arm64 note<\/span><\/p>/);
    assert.doesNotMatch(space.text, /Its author's summary/);
    const spaceMd = await get("/spaces/runner-images.md");
    assert.match(spaceMd.text, /^- what changed: `An arm64 note`$/m);
    assert.doesNotMatch(spaceMd.text, /^- summary:/m);
    assert.equal(JSON.parse((await get("/spaces/runner-images.json")).text).document.version.summary, "An arm64 note");
  });

  test("says which versions an app connection signed, and never only \"signed\" for those", async () => {
    const { text } = await get("/spaces/runner-images/history");
    assert.match(text, /<a href="\/spaces\/runner-images\/3">#3<\/a> &middot; [^<]* &middot; by <a [^>]*>.*?<\/a> &middot; signed through an app connection/);
    assert.match(text, /<a href="\/spaces\/runner-images\/7">#7<\/a> &middot; [^<]* &middot; by <a [^>]*>.*?<\/a> &middot; signed &middot;/);
    const md = (await get("/spaces/runner-images/history.md")).text;
    assert.match(md, /## #3 [\s\S]*?- signed: through an app connection, checked on its own page/);
    assert.match(md, /## #7 [\s\S]*?- signed: yes, checked on its own page/);
    const doc = JSON.parse((await get("/spaces/runner-images/history.json")).text);
    assert.deepEqual(doc.versions.map((v: Json) => [v.seq, v.signed, v.signed_by]), [["7", true, null], ["5", false, null], ["3", true, "connection"], ["1", false, null]]);
    // The document as it stands, on the space's own page.
    assert.match((await get("/spaces/runner-images")).text, /Version <a href="\/spaces\/runner-images\/3">#3<\/a>, by .*?, [^<]*? &middot; signed through an app connection\./);
  });

  test("a work space has none, and says why", async () => {
    const { status, text } = await get("/spaces/build-notes/history");
    assert.equal(status, 404);
    assert.match(text, /Not an oracle space/);
  });

  test("can be kept to one state, which the service is asked for and every format says", async () => {
    const calls = () => fake.calls.filter((c) => c.url.pathname === "/v1/spaces/runner-images/versions");
    const { status, text } = await get("/spaces/runner-images/history?state=declined");
    assert.equal(status, 200);
    assert.equal(calls().at(-1)?.url.searchParams.get("state"), "declined");
    const shown = [...text.matchAll(/<span class="tag(?: on)?">([^<]+)<\/span><a href="\/spaces\/runner-images\/(\d+)">/g)].map((m) => m[2]);
    assert.deepEqual(shown, ["5"]);
    assert.match(text, /<a class="tag on" href="\/spaces\/runner-images\/history\?state=declined" aria-current="true">declined<\/a>/);
    assert.match(text, /<a class="tag" href="\/spaces\/runner-images\/history">every version<\/a>/);
    assert.deepEqual(htmlProblems(text), []);
    const md = await get("/spaces/runner-images/history.md?state=declined");
    assert.match(md.text, /^- only: declined; every version: \/spaces\/runner-images\/history\.md$/m);
    assert.deepEqual(markdownProblems(md.text), []);
    assert.equal(JSON.parse((await get("/spaces/runner-images/history.json?state=declined")).text).state, "declined");
    const none = await get("/spaces/runner-images/history?state=out_of_date");
    assert.match(none.text, /No version of this document is in that state\./);
  });

  test("a state the service does not name is ignored, and is the same page as none", async () => {
    await get("/spaces/runner-images/history");
    const before = fake.calls.length;
    const { status } = await get("/spaces/runner-images/history?state=%3Cscript%3E");
    assert.equal(status, 200);
    assert.equal(fake.calls.length, before, "answered from the page already held");
  });

  test("offers to compare any two versions, starting with the document and the version it edits", async () => {
    const { text } = await get("/spaces/runner-images/history");
    const form = tags(text).find((t) => t.name === "form" && attr(t, "action") === "/spaces/runner-images/compare");
    assert.ok(form, "the history carries the comparison form");
    const number = (name: string) => tags(text).find((t) => t.name === "input" && attr(t, "name") === name && attr(t, "type") === "number");
    assert.equal(attr(number("from"), "value"), "1");
    assert.equal(attr(number("to"), "value"), "3");
    assert.match(text, /<datalist id="version-numbers"><option value="7"><option value="5"><option value="3"><option value="1"><\/datalist>/);
    const compared = await get("/spaces/runner-images/compare?from=1&to=7");
    assert.equal(compared.status, 200);
    const again = (name: string) => tags(compared.text).find((t) => t.name === "input" && attr(t, "name") === name && attr(t, "type") === "number");
    assert.deepEqual([attr(again("from"), "value"), attr(again("to"), "value")], ["1", "7"]);
  });
});

describe("two versions compared", () => {
  test("marks the lines one lost and the other added", async () => {
    const { status, text, headers } = await get("/spaces/runner-images/compare?from=1&to=3");
    assert.equal(status, 200);
    assert.equal(headers.get("X-Robots-Tag"), "noindex, follow");
    assert.deepEqual(htmlProblems(text), []);
    assert.match(text, /<del>- Use slim\.<\/del>/);
    assert.match(text, /<ins>\+ Use slim; arm64 needs full\./);
    const md = await get("/spaces/runner-images/compare.md?from=1&to=3");
    assert.deepEqual(markdownProblems(md.text), []);
    const doc = JSON.parse((await get("/spaces/runner-images/compare.json?from=1&to=3")).text);
    assert.deepEqual(doc.lines.filter((l: Json) => l.t !== "same").map((l: Json) => l.t), ["del", "add"]);
  });

  test("needs two numbers, and says so when one is not a version", async () => {
    assert.equal((await get("/spaces/runner-images/compare")).status, 400);
    assert.equal((await get("/spaces/runner-images/compare?from=1&to=99")).status, 404);
  });
});

describe("a version's own page", () => {
  test("a version that was never the document says what became of it, and is not listed", async () => {
    const declined = await get("/spaces/runner-images/5");
    assert.equal(declined.status, 200);
    assert.equal(declined.headers.get("X-Robots-Tag"), "noindex, follow");
    assert.match(declined.text, /It was declined, so it was never the document\. It was declined in <a href="\/spaces\/runner-images\/6">#6<\/a>/);
    assert.match(declined.text, /edits <a href="\/spaces\/runner-images\/3">#3<\/a>/);
  });

  test("the document now is listed, and a later proposal that edits it is never its author replacing it", async () => {
    const current = await get("/spaces/runner-images/3");
    assert.equal(current.status, 200);
    assert.doesNotMatch(current.headers.get("X-Robots-Tag") ?? "", /noindex/);
    assert.match(current.text, /It is the document now\./);
    assert.doesNotMatch(current.text, /Its author replaced this post/);
  });
});

describe("what a listed page and a reply form may carry", () => {
  test("an oracle space's all-posts page lists a version by its number, never a proposal's words", async () => {
    const { status, text, headers } = await get("/spaces/runner-images/all");
    assert.equal(status, 200);
    assert.doesNotMatch(headers.get("X-Robots-Tag") ?? "", /noindex/);
    assert.doesNotMatch(text, /Rewrite it all|An arm64 note|Nothing\./, "a version's summary or text");
    assert.match(text, /slim breaks on arm64/, "the discussion's own posts are listed as ever");
    assert.match(text, /<a href="\/spaces\/runner-images\/5">#5<\/a>/, "every version still has its link");
    const doc = JSON.parse((await get("/spaces/runner-images/all.json")).text);
    assert.ok(doc.posts.filter((p: Json) => p.kind === "version").every((p: Json) => p.title === null));
  });

  test("a version waiting is decided in its own panel, never by the reply form, and a refused decision says why", async () => {
    const offered = (html: string) => tags(html).filter((t) => t.name === "option").map((t) => attr(t, "value"));
    const decider = await get("/me/spaces/runner-images/7", true);
    assert.ok(!offered(decider.text).includes("go") && !offered(decider.text).includes("veto"), "the reply form never decides");
    assert.ok(offered(decider.text).includes("obs"));
    assert.match(decider.text, /<h3>Decide this proposal<\/h3>/, "the owner may decide");
    assert.deepEqual(signedInProblems(decider.text), []);
    assert.equal(signingScripts(decider.text), 1);
    world.spaces[0]!.access = { role: null, tags: [], read: true, post: true, decide: false };
    try {
      const stranger = await get("/me/spaces/runner-images/7", true);
      assert.doesNotMatch(stranger.text, /Decide this proposal/, "a key that may not decide");
      assert.ok(!offered(stranger.text).includes("go") && !offered(stranger.text).includes("veto"));
    } finally {
      world.spaces[0]!.access = { role: "owner", tags: [], read: true, post: true, decide: true };
    }
    DENY_DECISIONS = true;
    try {
      const refusedOne = await send("/me/spaces/runner-images/posts", { kind: "go", reply_to: id(7), body: "Mine.", then: "history", idempotency_key: "c".repeat(32) });
      assert.equal(refusedOne.status, 403);
      assert.match(refusedOne.text, /does not decide a version here, so nothing was posted/);
    } finally {
      DENY_DECISIONS = false;
    }
  });

  test("an oracle space narrowed to its versions, which shows proposals in full, is not listed", async () => {
    const { status, headers } = await get("/spaces/runner-images?kind=version");
    assert.equal(status, 200);
    assert.equal(headers.get("X-Robots-Tag"), "noindex, follow");
  });
});

describe("Seek and oracle spaces", () => {
  test("finds a document as it stands now, marked as a document and linked to its oracle space", async () => {
    const both = JSON.parse((await get("/seek.json?q=arm64")).text);
    assert.deepEqual(both.items.map((h: Json) => [h.space, h.seq, h.document ?? false]),
      [["runner-images", "2", false], ["runner-images", "3", true], ["build-notes", "1", false]], "a proposal waiting is never found");
    const before = fake.calls.length;
    const { text } = await get("/seek?q=arm64&oracle=true");
    assert.equal(fake.calls.slice(before).find((c) => c.url.pathname === "/v1/seek")?.url.searchParams.get("oracle"), "true");
    assert.match(text, /<span class="tag on">document<\/span><span class="tag">text match<\/span><a href="\/spaces\/runner-images">the document in runner-images<\/a>, version <a href="\/spaces\/runner-images\/3">#3<\/a>/);
    assert.doesNotMatch(text, /slim breaks on arm64/);
    const none = JSON.parse((await get("/seek.json?q=arm64&oracle=false")).text);
    assert.deepEqual(none.items.map((h: Json) => `${h.space}/${h.seq}`), ["runner-images/2", "build-notes/1"]);
    assert.equal(none.query.oracle, false);
  });
});

describe("a category lists its spaces newest first", () => {
  test("asks the service for them newest first, and pages with the cursor it hands back", async () => {
    const before = fake.calls.length;
    const { text } = await get("/spaces/by/category/general");
    const listed = fake.calls.slice(before).find((c) => c.url.pathname === "/v1/spaces");
    assert.equal(listed?.url.searchParams.get("order"), "recent");
    const doc = JSON.parse((await get("/spaces/by/category/general.json")).text);
    const names = doc.items.map((s: Json) => s.name);
    assert.ok(names.indexOf("runner-images") < names.indexOf("build-notes"), "the newer first");
    assert.match(text, /Newest first: a public space by when it was last written in/);
    // The page shows the two kinds apart, work spaces first, each under its own heading.
    const work = text.indexOf('<h3 class="group" id="work-spaces">Work spaces</h3>');
    const oracle = text.indexOf('<h3 class="group" id="oracle-spaces">Oracle spaces</h3>');
    assert.ok(work > 0 && work < text.indexOf("build-notes"));
    assert.ok(text.indexOf("build-notes") < oracle);
    assert.ok(oracle < text.indexOf('href="/spaces/runner-images"'));
    const cursor = `${Date.parse("2026-09-18T09:00:00.000Z") * 1000}~runner-images`;
    const page = JSON.parse((await get(`/spaces/by/category/general.json?before=${cursor}`)).text);
    assert.deepEqual(page.items.map((s: Json) => s.name), ["build-notes"]);
    // A cursor in any other shape is read as none.
    const after = fake.calls.length;
    await get("/spaces/by/category/general?before=<script>");
    assert.equal(fake.calls.slice(after).find((c) => c.url.pathname === "/v1/spaces")?.url.searchParams.get("before") ?? null, null);
  });
});

describe("signed in, in an oracle space", () => {
  test("its page offers to propose a change to the whole text, to discuss, to watch and to fork", async () => {
    const { status, text } = await get("/me/spaces/runner-images", true);
    assert.equal(status, 200);
    // The one script is the site's own, which signs a post with a passkey, once.
    assert.deepEqual(signedInProblems(text), []);
    assert.equal(signingScripts(text), 1);
    const kind = field(text, "kind").find((t) => attr(t, "value") === "version");
    assert.ok(kind, "a form whose kind is version");
    assert.equal(attr(field(text, "supersedes")[0], "value"), id(3));
    assert.ok(text.includes(`>${esc(SECOND)}</textarea>`), "the current text, to change");
    assert.match(text, /Make it the document/, "an owner's own version goes straight in");
    assert.match(text, /Say something in the discussion/);
    assert.match(text, /action="\/me\/spaces\/runner-images\/watch"/);
    assert.match(text, /<a href="\/me\/spaces\/runner-images\/fork">Fork this oracle space<\/a>/, "the fork has a page of its own");
    const discussionKinds = tags(text).filter((t) => t.name === "option").map((t) => attr(t, "value"));
    assert.ok(!discussionKinds.includes("version"), "a version is proposed with its own form");
  });

  test("a proposal is posted as a version of the current one, and lands on the history", async () => {
    const r = await send("/me/spaces/runner-images/posts", {
      kind: "version", supersedes: id(3), title: "A change", body: "Lead, changed.", then: "history", idempotency_key: "a".repeat(32),
    });
    assert.equal(r.status, 303, r.text.slice(0, 300));
    assert.equal(r.location, "/me/spaces/runner-images/history?notice=proposed");
    const sent = JSON.parse(r.writes[0]!.body!);
    assert.equal(sent.kind, "version");
    assert.equal(sent.supersedes, id(3));
    assert.equal(sent.title, "A change");
  });

  test("the history offers Approve and Decline on what waits, Undo on the document, and a passkey may sign them", async () => {
    const { status, text, headers } = await get("/me/spaces/runner-images/history", true);
    assert.equal(status, 200);
    assert.match(headers.get("Content-Security-Policy") ?? "", /script-src 'self'/);
    const replies = field(text, "reply_to").map((t) => attr(t, "value"));
    assert.deepEqual(replies, [id(7), id(7)], "one Approve and one Decline, for the proposal that waits");
    assert.ok(field(text, "kind").some((t) => attr(t, "value") === "go") && field(text, "kind").some((t) => attr(t, "value") === "veto"));
    assert.match(text, /Undo the last change/);
    assert.deepEqual(signedInProblems(text), []);
    assert.equal(signingScripts(text), 1, "the signing script once, however many forms it signs");
    assert.ok(text.includes(`<textarea name="body" hidden readonly>Lead.\n\n## Images\n\nUse slim.</textarea>`), "the text of the version the document replaced");
    const decline = await send("/me/spaces/runner-images/posts", { kind: "veto", reply_to: id(7), body: "Not sourced.", then: "history", idempotency_key: "b".repeat(32) });
    assert.equal(decline.location, "/me/spaces/runner-images/history?notice=proposal-declined");
    const page = await get(`${decline.location}`, true);
    assert.match(page.text, /Declined\. The proposal stays in the history, with your reason\./);
  });

  test("forking makes a new oracle space and goes to it, and watching is a toggle", async () => {
    const fork = await send("/me/spaces/runner-images/fork", { name: "my-images", title: "" });
    assert.equal(fork.location, "/me/spaces/my-images?notice=forked");
    assert.deepEqual(JSON.parse(fork.writes[0]!.body!), { name: "my-images" });
    const badName = await send("/me/spaces/runner-images/fork", { name: "No Good" });
    assert.equal(badName.status, 400);
    assert.deepEqual(badName.writes, []);
    const watch = await send("/me/spaces/runner-images/watch", { on: "1" });
    assert.equal(watch.writes[0]!.method, "PUT");
    assert.equal(watch.location, "/me/spaces/runner-images?notice=watching");
    const stop = await send("/me/spaces/runner-images/watch", { on: "0" });
    assert.equal(stop.writes[0]!.method, "DELETE");
  });

  test("the fork's own page files it as this one is, and starts how others join as this one does", async () => {
    const { status, text } = await get("/me/spaces/runner-images/fork", true);
    assert.equal(status, 200, text.slice(0, 300));
    assert.match(text, /action="\/me\/spaces\/runner-images\/fork"/);
    assert.equal(attr(field(text, "category_1")[0], "value"), "general");
    assert.equal(attr(field(text, "categories_were")[0], "value"), "general");
    const chosen = field(text, "join_policy").find((t) => t.attributes.some(([n]) => n === "checked"));
    assert.equal(attr(chosen, "value"), "request");
    // An oracle space never takes posts from any key as a work space may: the service
    // refuses it for one, so the fork never offers it (test/open-write.test.ts, where the
    // service does take it elsewhere, holds the same).
    assert.deepEqual(field(text, "join_policy").map((t) => attr(t, "value")), ["request", "invite"]);
    assert.deepEqual(signedInProblems(text), []);
    assert.equal(signingScripts(text), 0);
    assert.equal((await get("/me/spaces/build-notes/fork", true)).status, 404, "a space that is not an oracle space has no fork");
  });

  test("a fork sends what the person changed, how others join, and its categories only when they changed", async () => {
    const same = await send("/me/spaces/runner-images/fork", {
      name: "my-images", title: "", description: "Mine now.", category_1: "general", category_2: "", category_3: "",
      categories_were: "general", join_policy: "invite",
    });
    assert.equal(same.location, "/me/spaces/my-images?notice=forked");
    assert.deepEqual(JSON.parse(same.writes[0]!.body!), { name: "my-images", description: "Mine now.", join_policy: "invite" });
    const refiled = await send("/me/spaces/runner-images/fork", { name: "my-images", category_1: "vLLM", categories_were: "general", join_policy: "request" });
    assert.deepEqual(JSON.parse(refiled.writes[0]!.body!), { name: "my-images", join_policy: "request", categories: ["vllm"] });
  });

  test("a fork the site or the service refuses shows its form again as it was typed", async () => {
    const mixed = await send("/me/spaces/runner-images/fork", { name: "my-images", category_1: "agents", category_2: "coding-agents", categories_were: "general" });
    assert.equal(mixed.status, 400);
    assert.deepEqual(mixed.writes, [], "nothing was sent");
    assert.equal(attr(field(mixed.text, "name")[0], "value"), "my-images");
    const taken = await send("/me/spaces/runner-images/fork", { name: "taken-images", title: "Kept <b>as typed</b>", join_policy: "invite" });
    assert.equal(taken.status, 409);
    assert.equal(attr(field(taken.text, "name")[0], "value"), "taken-images");
    assert.match(taken.text, /value="Kept &lt;b&gt;as typed&lt;\/b&gt;"/);
    const chosen = field(taken.text, "join_policy").find((t) => t.attributes.some(([n]) => n === "checked"));
    assert.equal(attr(chosen, "value"), "invite");
  });

  test("a new space can be an oracle space, which is always public", async () => {
    const form = await get("/me/new", true);
    assert.ok(field(form.text, "oracle").length === 2);
    const r = await send("/me/new", { name: "a-new-oracle", title: "A new oracle", description: "", visibility: "private", join_policy: "request", category_1: "general", oracle: "1" });
    assert.equal(r.status, 303, r.text.slice(0, 300));
    const sent = JSON.parse(r.writes[0]!.body!);
    assert.equal(sent.oracle, true);
    assert.equal(sent.visibility, "public");
  });

  test("an oracle space's settings switch the service's reviewer, and only an oracle space's send it", async () => {
    const page = await get("/me/spaces/runner-images/settings", true);
    assert.ok(field(page.text, "service_reviewer")[0]?.attributes.some(([n]) => n === "checked"), "on, as the service says it is");
    const off = await send("/me/spaces/runner-images/settings", { title: "Runner images", description: "", join_policy: "request", reviewer_shown: "1" });
    assert.equal(JSON.parse(off.writes[0]!.body!).service_reviewer, false);
    const plain = await send("/me/spaces/build-notes/settings", { title: "Build notes", description: "", join_policy: "request" });
    assert.equal("service_reviewer" in JSON.parse(plain.writes[0]!.body!), false);
  });

  test("the mailbox says a proposal waits for a decision, and where to decide it", async () => {
    const { text } = await get("/me/mailbox", true);
    assert.match(text, /a proposal waiting for your decision/);
    assert.match(text, /<a href="\/me\/spaces\/runner-images\/history">Decide it in the history<\/a>/);
  });

  test("the documents a key watches have a page", async () => {
    const { status, text } = await get("/me/watching", true);
    assert.equal(status, 200);
    assert.match(text, /Documents you watch/);
  });
});
