// A finding's own post page: its status, confidence, claim and sources, and what cites it,
// where the service's post answer carries them, in all three formats. Beside the post
// the service may give a `finding`; a member alone is given the post's `data`, which holds
// the same fields, and a public address never shows `data`. A hidden finding shows none.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, CATEGORIES, json, service, unanswered, type Json, type World } from "./lib/service.ts";
import { htmlProblems, markdownProblems } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const WRITER = "c3d4".repeat(16);
const SPACE_ID = "0199a0a0-0000-7000-8000-000000000001";
const id = (n: number) => `0199a1a1-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = (n: number) => `2026-10-01T10:${String(n).padStart(2, "0")}:00.000Z`;
const hex = (b: string) => b.repeat(32);
const XSS = "<script>alert(1)</script>";

const post = (n: number, fields: Json = {}): Json => ({
  post_id: id(n), space: "findings-board", seq: String(n), kind: "result", author: WRITER, posted_at: at(n), title: `Post ${n}`, body: `The words of post ${n}.`,
  to: [], reply_to: null, supersedes: null, retracts: null, fingerprints: [], signed: false, space_id: SPACE_ID, object_id: hex(`0${n}`),
  ...fields,
});
/** A finding as the product's own answer shows it: every field. */
const finding = (n: number, f: Json): Json => ({
  number: n, post_id: id(n), seq: String(n), author: WRITER, posted_at: at(n), supersedes: null, superseded_by: null, retracted_by: null, ...f,
});
const fields = (claim: string, extra: Json = {}): Json => ({
  claim, status: "supported", confidence: "high", sources: [id(1), id(2)], cited_by: 3, source_withdrawn: true, ...extra,
});

const world: World = {
  capabilities: {
    ...CAPABILITIES,
    kinds: [...CAPABILITIES.kinds, "finding"],
    kind_groups: { ...CAPABILITIES.kind_groups, knowledge: [...CAPABILITIES.kind_groups.knowledge, "finding"] },
  },
  categories: CATEGORIES,
  spaces: [{
    name: "findings-board", space_id: SPACE_ID, title: "The findings-board", description: "Research to be done.", visibility: "public", join_policy: "request",
    status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: OWNER,
    contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-10-01T09:00:00.000Z",
  } as Json],
  posts: {
    "findings-board": [
      post(1), post(2),
      // Three: the service answers the finding at GET /v1/posts/{id}/finding (below).
      post(3, { kind: "finding", title: "A claim", body: "The longer account." }),
      // Four: the post's own data holds the same fields, which the page never reads as the finding.
      post(4, { kind: "finding", data: fields("The member-only claim", { sources: [id(1)], cited_by: undefined, source_withdrawn: false }) }),
      // Five: every word of it is the author's, and hostile.
      post(5, { kind: "finding" }),
      // Six: hidden by the owner, so its claim is shown to nobody.
      post(6, { kind: "finding", unavailable: { state: "hidden" } }),
      // Seven: the service's own words in a shape it does not write.
      post(7, { kind: "finding" }),
      // Eight: a result that cites sources, which is not a finding and shows no section.
      post(8, { data: { sources: [id(1)] } }),
    ],
  },
  postFindings: {
    [id(3)]: finding(3, fields("The key is four letters long")),
    [id(5)]: finding(5, fields(`${XSS}\n# not a heading ${"`".repeat(3)}`, { status: "supported", sources: [id(1)] })),
    [id(6)]: finding(6, fields("A claim that was hidden")),
    [id(7)]: { claim: "Odd fields", status: "<b>high</b>", confidence: "x y", sources: ["not an id", id(2)], cited_by: "3", source_withdrawn: "yes", x_secret: "SENTINEL-POST-FINDING" },
  },
  versions: {}, proofs: {}, checkpoints: { "findings-board": [] }, peers: {},
};
const base = service(world);
const { fake, handleRequest } = await site((call) => {
  if (call.url.pathname === "/v1/mailbox") return json({ items: [], next_after: null, has_more: false, head_seq: "0" });
  return base(call);
});

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await handleRequest(new Request(`${SITE}${path}`, { headers }), { ...env, SITE_TOKEN: "site-token-for-tests" });
  return { status: res.status, text: await res.text() };
}
/** The page between its Finding heading and the next block. */
const block = (html: string): string => /<h2 id="finding">[\s\S]*?(?=\n<(?:div|pre|details|p class="meta">No|p class="meta">This)|$)/.exec(html)?.[0] ?? "";

describe("a finding's post page", () => {
  test("shows its status, confidence, claim, what cites it and each source, linked by id on a public address", async () => {
    const page = await get("/spaces/findings-board/3");
    assert.equal(page.status, 200);
    assert.deepEqual(htmlProblems(page.text), []);
    const text = block(page.text);
    assert.ok(text.length > 0, "no Finding block");
    assert.match(text, /status supported &middot; confidence high/);
    assert.match(text, /<p>The key is four letters long<\/p>/);
    assert.match(text, /Cited by 3 posts\. A post it rests on was replaced or retracted\./);
    assert.match(text, new RegExp(`Sources: <a href="/posts/${id(1)}"><code>${id(1)}</code></a>, <a href="/posts/${id(2)}"><code>${id(2)}</code></a>\\.`));
    assert.ok(page.text.indexOf('id="finding"') < page.text.indexOf("<pre>The longer account."), "the finding comes before the body");
  });

  test("the markdown names the same fields", async () => {
    const md = (await get("/spaces/findings-board/3.md")).text;
    assert.deepEqual(markdownProblems(md), []);
    assert.match(md, /## Finding\n\n- status: supported\n- confidence: high\n- claim: `The key is four letters long`\n- Cited by 3 posts\. A post it rests on was replaced or retracted\.\n/);
    assert.match(md, new RegExp(`- source: ${id(1)}, /posts/${id(1)}\\.md\\n- source: ${id(2)}, /posts/${id(2)}\\.md`));
  });

  test("the JSON carries the fields the service gave, under their own names", async () => {
    const doc = JSON.parse((await get("/spaces/findings-board/3.json")).text) as Json;
    assert.deepEqual(doc.post.finding, fields("The key is four letters long"));
  });

  test("fields the post carries as its own data are not the finding: the block comes from the service's finding read alone", async () => {
    const page = await get("/spaces/findings-board/4");
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /id="finding"/);
    assert.doesNotMatch((await get("/spaces/findings-board/4.md")).text, /## Finding/);
    assert.ok(!("finding" in (JSON.parse((await get("/spaces/findings-board/4.json")).text) as Json).post));
    const { cookie } = await signedIn(WRITER, "writer-token", "192.0.2.72");
    const mine = await get("/me/spaces/findings-board/4", { Cookie: cookie });
    assert.doesNotMatch(mine.text, /id="finding"|The member-only claim<\/p>/);
  });

  test("a signed-in member's page reads the finding with the member's key, and names a source by its id alone", async () => {
    const { cookie } = await signedIn(WRITER, "writer-token", "192.0.2.72");
    const page = await get("/me/spaces/findings-board/3", { Cookie: cookie });
    assert.equal(page.status, 200);
    const text = block(page.text);
    assert.match(text, /<p>The key is four letters long<\/p>/);
    assert.match(text, new RegExp(`Sources: <code>${id(1)}</code>, <code>${id(2)}</code>\\.`));
    assert.doesNotMatch(text, /\/posts\//, "the id's redirect is a public address's");
    const read = fake.calls.filter((c) => c.url.pathname === `/v1/posts/${id(3)}/finding`).at(-1);
    assert.equal(read?.headers.get("authorization"), "Bearer writer-token");
  });

  test("a post of another kind is not asked about, and the read is the product's address with the site's key", async () => {
    await get("/spaces/findings-board/8");
    assert.ok(!fake.calls.some((c) => c.url.pathname === `/v1/posts/${id(8)}/finding`));
    await get("/spaces/findings-board/3");
    const reads = fake.calls.filter((c) => c.url.pathname === `/v1/posts/${id(3)}/finding`);
    assert.ok(reads.some((c) => c.headers.get("authorization") === "Bearer site-token-for-tests"), "the public page reads with the site's key");
  });

  test("an author's words stay text in all three formats", async () => {
    const page = await get("/spaces/findings-board/5");
    assert.deepEqual(htmlProblems(page.text), []);
    assert.match(block(page.text), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    const md = (await get("/spaces/findings-board/5.md")).text;
    assert.deepEqual(markdownProblems(md), []);
    assert.match(md, /- claim: ```` <script>alert\(1\)<\/script> # not a heading ``` ````\n/);
    const doc = JSON.parse((await get("/spaces/findings-board/5.json")).text) as Json;
    assert.equal(doc.post.finding.claim, `${XSS}\n# not a heading ${"`".repeat(3)}`);
  });

  test("a hidden finding shows no claim, in any format", async () => {
    for (const ext of ["", ".md", ".json"]) {
      const page = await get(`/spaces/findings-board/6${ext}`);
      assert.equal(page.status, 200, ext);
      assert.doesNotMatch(page.text, /A claim that was hidden|id="finding"|## Finding/, ext);
    }
  });

  test("a field in a shape the service does not write is left out, and one it did not name is not forwarded", async () => {
    const page = await get("/spaces/findings-board/7");
    const text = block(page.text);
    assert.match(text, /<p>Odd fields<\/p>/);
    assert.doesNotMatch(text, /status|confidence|Cited by|replaced or retracted/);
    assert.match(text, new RegExp(`Sources: <a href="/posts/${id(2)}">`));
    const doc = JSON.parse((await get("/spaces/findings-board/7.json")).text) as Json;
    assert.deepEqual(doc.post.finding, { claim: "Odd fields", sources: [id(2)] });
    assert.doesNotMatch(JSON.stringify(doc), /SENTINEL-POST-FINDING/);
  });

  test("a post that is not a finding, and carries only sources, shows no Finding block", async () => {
    const page = await get("/spaces/findings-board/8");
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /id="finding"/);
  });

  test("a finding in a space's stream carries no finding fields: only its own page reads them", async () => {
    const doc = JSON.parse((await get("/spaces/findings-board.json")).text) as Json;
    for (const p of doc.posts) assert.ok(!("finding" in p), `post ${p.seq}`);
  });
});

describe("the Vocabulary page explains a finding", () => {
  const WORDS = ["finding", "finding status", "confidence", "sources", "label"];

  test("each word is an entry, in the page and in its markdown and JSON twins", async () => {
    const html = (await get("/vocabulary")).text;
    const md = (await get("/vocabulary.md")).text;
    const doc = JSON.parse((await get("/vocabulary.json")).text) as { words: { word: string; meaning: string }[] };
    for (const w of WORDS) {
      assert.ok(html.includes(`<dt>${w}</dt>`), `${w} in the page`);
      assert.ok(md.includes(`- ${w}: `), `${w} in the markdown`);
      assert.ok(doc.words.some((x) => x.word === w && x.meaning.length > 40), `${w} in the JSON`);
    }
  });

  test("the four status words and the three confidence words are said, and a finding is not called true", async () => {
    const doc = JSON.parse((await get("/vocabulary.json")).text) as { words: { word: string; meaning: string }[] };
    const meaning = (w: string) => doc.words.find((x) => x.word === w)!.meaning;
    for (const s of ["proposed", "supported", "disputed", "withdrawn"]) assert.match(meaning("finding status"), new RegExp(s));
    for (const c of ["low", "medium", "high"]) assert.match(meaning("confidence"), new RegExp(c));
    assert.match(meaning("finding"), /not shown to be true/);
    assert.match(meaning("label"), /subject:/);
    assert.match(meaning("label"), /source:/);
  });

  test("the kind finding is listed with its meaning where the service lists it", async () => {
    assert.match((await get("/vocabulary")).text, /<dt id="kind-finding">finding<\/dt><dd>a claim with its status, its confidence and the posts it rests on/);
  });
});

describe("a service that only lists the finding kind has a section on a work space's page", () => {
  test("the kind alone is enough to ask for the list", async () => {
    await get("/spaces/findings-board");
    assert.ok(fake.calls.some((c) => c.url.pathname === "/v1/spaces/findings-board/findings"), "the findings were asked for");
  });
});

describe("the stand-in service was asked for nothing it does not answer", () => {
  test("every address the pages read was answered", () => {
    assert.deepEqual(unanswered, []);
  });
});
