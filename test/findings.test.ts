// A work space's findings on its page, read-only: one row for each finding with its number,
// status, confidence, claim, author, a link to its post, how many posts cite it and a mark
// when a source it rests on was withdrawn; the sentence for a space with none; nothing on an
// oracle space; a finding's own post page; and the same facts in the markdown and JSON twins.
//
// Driven through handleRequest() against a stand-in for the product that answers a space's
// findings as the product's `GET /v1/spaces/{name}/findings` does: newest number first,
// every field of a finding. The tasks module is available too, so the order of the two
// reads can be held.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, CATEGORIES, json, refusal, service, unanswered, type Json, type World } from "./lib/service.ts";
import { htmlProblems, markdownProblems, tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const WRITER = "c3d4".repeat(16);
const SPACE_ID = "0199a0a0-0000-7000-8000-000000000001";
const id = (n: number) => `0199a1a1-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = (n: number) => `2026-10-01T10:${String(n).padStart(2, "0")}:00.000Z`;
const hex = (b: string) => b.repeat(32);

const space = (name: string, fields: Json = {}): Json => ({
  name, space_id: SPACE_ID, title: `The ${name}`, description: "Research to be done.", visibility: "public", join_policy: "request",
  status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: OWNER,
  contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-10-01T09:00:00.000Z",
  ...fields,
});
const post = (n: number, fields: Json = {}, name = "findings-board"): Json => ({
  post_id: id(n), space: name, seq: String(n), kind: "result", author: WRITER, posted_at: at(n), title: `Result ${n}`, body: `The words of result ${n}.`,
  to: [], reply_to: null, supersedes: null, retracts: null, fingerprints: [], signed: false, space_id: SPACE_ID, object_id: hex(`0${n}`),
  ...fields,
});
/** A finding as the product lists one: every field, so a field the page loses shows. */
const finding = (number: number, fields: Json = {}): Json => ({
  number, post_id: id(100 + number), claim: `Claim ${number}`, status: "proposed", confidence: "low", author: WRITER,
  seq: String(100 + number), posted_at: at(number), sources: [], cited_by: 0, source_withdrawn: false, supersedes: null, superseded_by: null, retracted_by: null,
  ...fields,
});

/** The one of each state a person can meet. */
const BOARD: Json[] = [
  // One with no position given, which the page then links by the post's id.
  (({ seq: _seq, ...rest }) => rest)(finding(1, { claim: "The cipher is a Vigenere", sources: [id(1)] })),
  finding(2, { claim: "The key is four letters long", status: "supported", confidence: "high", sources: [id(1), id(2)], cited_by: 3, seq: "12" }),
  finding(3, { claim: "The second letter is a forgery", status: "disputed", confidence: "medium", cited_by: 1, source_withdrawn: true, post_id: id(2), seq: "2", sources: [id(3)] }),
  finding(4, { claim: "The margin note is modern", status: "withdrawn", retracted_by: id(130) }),
  finding(5, { claim: "The paper is rag", status: "supported", confidence: "medium", sources: [id(1)], superseded_by: id(131), author: OWNER }),
  finding(6, { claim: "Nothing cited for this one", sources: [] }),
];

const CHECKER = "e5f6".repeat(16);
const XSS = "<script>alert(7)</script>";
/** Findings the service marked contested, each cause as its spec writes it, and one with causes in no shape. */
const CONTESTED: Json[] = [
  finding(1, { claim: "Rests on a rejected result", seq: "31", sources: [id(1)], contested: [{ cause: "rejected", on: "30", task: 7, by: CHECKER, post: "36" }] }),
  finding(2, { claim: "Is itself the rejected result", seq: "32", contested: [{ cause: "rejected", on: "32", task: 4, by: CHECKER }] }),
  finding(3, { claim: "Cited by a warn", seq: "33", contested: [
    { cause: "warn", on: "33", by: CHECKER, post: "13", title: `Sum is wrong ${XSS}` },
    { cause: "fail", on: "4", by: CHECKER, post: "14" }] }),
  finding(4, { claim: "Causes in no shape", seq: "34", contested: [
    { cause: "judged", on: "30", by: CHECKER }, { cause: "rejected", on: "30", task: 0, by: CHECKER }, { cause: "warn", on: "x", by: CHECKER },
    { cause: "fail", on: "5", by: "not a key" }, { cause: "warn", on: "5", by: CHECKER, post: "<b>" }, "text", null] }),
  finding(5, { claim: "Unmarked beside them", seq: "35" }),
];

const MANY: Json[] = Array.from({ length: 60 }, (_, i) => finding(i + 1, { claim: `Page ${i + 1}` }));

const world: World = {
  capabilities: { ...CAPABILITIES, modules: { ...CAPABILITIES.modules, tasks: { status: "available" }, findings: { status: "available" } } },
  categories: CATEGORIES,
  spaces: [
    space("findings-board"),
    space("empty-board"),
    space("quiet-board", { visibility: "private" }),
    space("wide-board"),
    space("busy-board"),
    space("contested-board"),
    space("refused-board"),
    space("broken-board"),
    space("shaped-board"),
    space("odd-board"),
    space("finding-oracle", { oracle: true, service_reviewer: false, forked_from: null }),
  ],
  posts: {
    "findings-board": [post(1), post(2), post(3)],
    "empty-board": [], "quiet-board": [], "wide-board": [], "busy-board": [], "contested-board": [], "refused-board": [], "broken-board": [], "shaped-board": [], "odd-board": [], "finding-oracle": [],
  },
  findings: {
    "findings-board": BOARD, "quiet-board": [finding(1, { claim: "A private claim" })], "wide-board": MANY,
    "busy-board": [finding(1, { claim: "Busy claim" })], "contested-board": CONTESTED,
    "odd-board": [
      finding(1, {
        x_secret: "SENTINEL-FINDING-FIELD", author: "not a key", posted_at: "yesterday", sources: [id(1), "not an id"],
        status: "not a word!", confidence: "<b>high</b>", cited_by: -3, source_withdrawn: "yes",
      }),
    ],
  },
  versions: { "finding-oracle": [] },
  proofs: {}, checkpoints: { "findings-board": [] }, peers: {},
};
const base = service(world);
/** How many of one space's three reads were open at once, and the order they started in: each is
 *  held open for a moment, so reads beside one another overlap. */
const open = { now: 0, most: 0, started: [] as string[] };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const { fake, handleRequest } = await site(async (call) => {
  const watched = /^\/v1\/spaces\/busy-board\/(posts|tasks|findings)$/.exec(call.url.pathname);
  if (watched) {
    open.now += 1;
    open.most = Math.max(open.most, open.now);
    open.started.push(watched[1]!);
    await sleep(15);
    open.now -= 1;
  }
  if (call.url.pathname === "/v1/spaces/refused-board/tasks") await sleep(15);
  if (call.url.pathname === "/v1/spaces/refused-board/posts") return refusal(500, "INTERNAL", "the service is unwell");
  if (call.url.pathname === "/v1/mailbox") return json({ items: [], next_after: null, has_more: false, head_seq: "0" });
  if (call.url.pathname === "/v1/spaces/broken-board/findings") return refusal(500, "INTERNAL", "the service is unwell");
  if (call.url.pathname === "/v1/spaces/shaped-board/findings") return json({ notice: "no list here" });
  if (call.url.pathname === "/v1/spaces/finding-oracle/document") return json({ space: "finding-oracle", title: "A document", version: null, text: null, sections: [], references: [], pending: 0 });
  return base(call);
});

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await handleRequest(new Request(`${SITE}${path}`, { headers }), { ...env, SITE_TOKEN: "site-token-for-tests" });
  return { status: res.status, text: await res.text(), headers: res.headers };
}
const findingCalls = (name: string) => fake.calls.filter((c) => c.url.pathname === `/v1/spaces/${name}/findings`);
/** The page between its Findings heading and the next one. */
const section = (html: string): string => /<h2 id="findings">[\s\S]*?(?=<h2)/.exec(html)?.[0] ?? "";
/** One finding's row: its status and number above its claim, its sentences below. */
const rowOf = (text: string, n: number): string => text.split('<div class="item">').find((r) => r.includes(`<h3 id="finding-${n}">`)) ?? "";

describe("a work space's page lists its findings", () => {
  test("after its tasks and before its stream, one row for each, with its number, status, confidence and claim", async () => {
    const page = await get("/spaces/findings-board");
    assert.equal(page.status, 200);
    assert.deepEqual(htmlProblems(page.text), []);
    const text = section(page.text);
    assert.ok(text.length > 0, "no Findings section");
    assert.ok(page.text.indexOf('<h2 id="tasks">') < page.text.indexOf('<h2 id="findings">'), "the findings come after the tasks");
    assert.ok(page.text.indexOf('<h2 id="findings">') < page.text.indexOf("<h2>Latest posts</h2>"), "the findings come before the stream");
    assert.equal((text.match(/<div class="item">/g) ?? []).length, BOARD.length);
    for (const f of BOARD) {
      assert.ok(text.includes(`<h3 id="finding-${f.number}">${f.claim}</h3>`), `finding ${f.number} is listed by its claim`);
      assert.ok(text.includes(`<a href="#finding-${f.number}">Finding ${f.number}</a>`), `finding ${f.number} has its number`);
      assert.ok(rowOf(text, f.number).includes(`<span class="tag">${f.status}</span>`), `finding ${f.number} has its status`);
      assert.ok(rowOf(text, f.number).includes(`confidence ${f.confidence}`), `finding ${f.number} has its confidence`);
    }
    // Newest number first, as the service lists them.
    assert.ok(text.indexOf('id="finding-6"') < text.indexOf('id="finding-1"'));
  });

  test("every status the service has is shown as the word it sent", async () => {
    const text = section((await get("/spaces/findings-board")).text);
    for (const status of ["proposed", "supported", "disputed", "withdrawn"]) {
      assert.ok(text.includes(`<span class="tag">${status}</span>`), status);
    }
  });

  test("each says who wrote it and when, and links its post: by its number, by the page it is on, or by its id", async () => {
    const text = section((await get("/spaces/findings-board")).text);
    assert.match(rowOf(text, 2), new RegExp(`by <a href="/peers/${WRITER}"><code title="${WRITER}">`));
    assert.match(rowOf(text, 2), /1 Oct 2026, 10:02 UTC/);
    assert.match(rowOf(text, 5), new RegExp(`by <a href="/peers/${OWNER}">`));
    assert.match(rowOf(text, 2), /<a href="\/spaces\/findings-board\/12">its post<\/a>/, "the number the service gives");
    assert.match(rowOf(text, 3), /<a href="\/spaces\/findings-board\/2">its post<\/a>/, "a post that is on the page");
    assert.match(rowOf(text, 1), new RegExp(`<a href="/posts/${id(101)}">its post</a>`), "a post off the page, by the id's redirect");
  });

  test("how many posts cite it, how many it cites, and the mark when a source was withdrawn", async () => {
    const text = section((await get("/spaces/findings-board")).text);
    assert.match(rowOf(text, 2), /Cited by 3 posts\. Rests on 2 posts\./);
    assert.match(rowOf(text, 3), /Cited by 1 post\. Rests on 1 post\. A post it rests on was replaced or retracted\./);
    assert.match(rowOf(text, 1), /Cited by 0 posts\. Rests on 1 post\.<\/p>/);
    assert.match(rowOf(text, 6), /Cites no sources\./);
    for (const n of [1, 2, 4, 5, 6]) assert.doesNotMatch(rowOf(text, n), /replaced or retracted/, `finding ${n}`);
  });

  test("a finding replaced or retracted says so", async () => {
    const text = section((await get("/spaces/findings-board")).text);
    assert.match(rowOf(text, 5), /Replaced by a later finding\./);
    assert.match(rowOf(text, 4), /Withdrawn by its author\./);
  });

  test("a space with no findings says so in one sentence", async () => {
    const page = await get("/spaces/empty-board");
    assert.equal(page.status, 200);
    assert.match(section(page.text), /<p>This space has no findings\.<\/p>/);
    assert.equal((section(page.text).match(/<div class="item">/g) ?? []).length, 0);
    assert.match((await get("/spaces/empty-board.md")).text, /\n## Findings\n[\s\S]*\nThis space has no findings\.\n/);
    assert.deepEqual((JSON.parse((await get("/spaces/empty-board.json")).text) as Json).findings, { items: [], has_more: false });
  });

  test("an oracle space has no section in any format, and the service is not asked", async () => {
    const page = await get("/spaces/finding-oracle");
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /id="findings"|has no findings/);
    assert.doesNotMatch((await get("/spaces/finding-oracle.md")).text, /## Findings/);
    assert.ok(!("findings" in (JSON.parse((await get("/spaces/finding-oracle.json")).text) as Json)));
    assert.deepEqual(findingCalls("finding-oracle"), []);
  });

  test("a space whose stream is not readable has no section, and its findings are not shown", async () => {
    const page = await get("/spaces/quiet-board");
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /id="findings"|A private claim/);
    assert.deepEqual(findingCalls("quiet-board"), []);
  });

  test("a list that could not be read is said so, never as a list with nothing in it", async () => {
    for (const name of ["broken-board", "shaped-board"]) {
      const page = await get(`/spaces/${name}`);
      assert.equal(page.status, 200, name);
      assert.match(section(page.text), /This site could not read the space(?:'|&#39;)s findings just now\./, name);
      assert.doesNotMatch(section(page.text), /has no findings/, name);
      assert.match((await get(`/spaces/${name}.md`)).text, /This site could not read the space's findings just now\./);
      assert.equal((JSON.parse((await get(`/spaces/${name}.json`)).text) as Json).findings, null);
      assert.equal((JSON.parse((await get(`/spaces/${name}.json`)).text) as Json).findings_unreadable, true);
    }
  });

  test("more than the page shows is said, and the newest are the ones shown", async () => {
    const page = await get("/spaces/wide-board");
    const text = section(page.text);
    assert.match(text, /Showing the newest 50 findings\. The service holds more\./);
    assert.equal((text.match(/<div class="item">/g) ?? []).length, 50);
    assert.ok(text.includes('<h3 id="finding-60">Page 60</h3>') && !text.includes("Page 10<"));
    assert.equal(findingCalls("wide-board")[0]!.url.searchParams.get("limit"), "50");
  });

  test("it carries no form of its own, and the whole page offers nothing that writes", async () => {
    const page = await get("/spaces/findings-board");
    assert.doesNotMatch(section(page.text), /<form|<button|<input/);
    for (const t of tags(page.text).filter((x) => x.name === "form")) {
      assert.notEqual((t.attributes.find(([n]) => n === "method")?.[1] ?? "get").toLowerCase(), "post");
    }
  });
});

describe("the findings are read like the rest of the page, and held with it", () => {
  test("with the site's own key, and once for everybody until the page is let go", async () => {
    await get("/spaces/findings-board");
    const calls = findingCalls("findings-board");
    assert.ok(calls.length >= 1);
    const stream = fake.calls.find((c) => c.url.pathname === "/v1/spaces/findings-board/posts")!;
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers.get("authorization"), "Bearer site-token-for-tests");
    assert.equal(calls[0]!.headers.get("authorization"), stream.headers.get("authorization"));
    const held = fake.calls.length;
    await get("/spaces/findings-board");
    await get("/spaces/findings-board");
    assert.equal(fake.calls.length, held, "a second visitor is served from the page the first was");
  });

  test("a signed-in person's page reads them with that person's own key, and links no post it cannot name", async () => {
    const { cookie } = await signedIn(WRITER, "writer-token", "192.0.2.71");
    const before = findingCalls("findings-board").length;
    const page = await get("/me/spaces/findings-board", { Cookie: cookie });
    assert.equal(page.status, 200);
    assert.match(section(page.text), /The key is four letters long/);
    const mine = findingCalls("findings-board").slice(before);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.headers.get("authorization"), "Bearer writer-token");
    assert.doesNotMatch(section(page.text), /<form|<button|<input/, "nothing here changes a finding");
    assert.doesNotMatch(rowOf(section(page.text), 1), /\/posts\//, "the id's redirect is a public address's");
    assert.match(rowOf(section(page.text), 2), /<a href="\/me\/spaces\/findings-board\/12">its post<\/a>/);
  });

  test("after the tasks, never beside them: a caller with no key never has three reads open at once", async () => {
    const page = await get("/spaces/busy-board");
    assert.equal(page.status, 200);
    assert.match(section(page.text), /Busy claim/);
    assert.ok(open.most <= 2, `${open.most} reads were open at once`);
    assert.equal(open.started.at(-1), "findings", "the findings are asked for last");
    assert.deepEqual([...open.started].sort(), ["findings", "posts", "tasks"]);
  });

  test("a page whose stream is refused does not ask for the findings at all", async () => {
    const before = findingCalls("refused-board").length;
    const page = await get("/spaces/refused-board");
    assert.notEqual(page.status, 200, "the stream was refused, so the page is a refusal");
    assert.equal(findingCalls("refused-board").length, before, "no findings read for a page that cannot be drawn");
  });
});

describe("the markdown twin lists them", () => {
  test("a heading for each, in the service's order, then what the page says", async () => {
    const md = (await get("/spaces/findings-board.md")).text;
    assert.deepEqual(markdownProblems(md), []);
    assert.ok(md.indexOf("## Findings") > md.indexOf("## Tasks") && md.indexOf("## Findings") < md.indexOf("## Latest posts"));
    const headings = [...md.matchAll(/^### Finding (\d+) (\w+)$/gm)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(headings, ["6 proposed", "5 supported", "4 withdrawn", "3 disputed", "2 supported", "1 proposed"]);
    assert.match(md, /claim: `The cipher is a Vigenere`\n\nconfidence: low\n\nauthor: [0-9a-f]{64}\n\nposted: 2026-10-01T10:01:00.000Z\n\npost: \/posts\/[0-9a-f-]{36}\.md\n\nCited by 0 posts\. Rests on 1 post\./);
    assert.match(md, /post: \/spaces\/findings-board\/12\.md/);
    assert.match(md, /post: \/spaces\/findings-board\/2\.md\n\nCited by 1 post\. Rests on 1 post\. A post it rests on was replaced or retracted\./);
    assert.match(md, /Replaced by a later finding\./);
    assert.match(md, /Withdrawn by its author\./);
    assert.match(md, /Cites no sources\./);
  });
});

describe("the JSON twin carries the service's fields unchanged", () => {
  test("each finding is what the service sent, field for field, and a field it did not name is not forwarded", async () => {
    const doc = JSON.parse((await get("/spaces/findings-board.json")).text) as Json;
    const sent = [...BOARD].sort((a, b) => b.number - a.number);
    assert.deepEqual(doc.findings.items, sent);
    assert.equal(doc.findings.has_more, false);
    assert.deepEqual(Object.keys(doc.findings), ["items", "has_more"]);
  });

  test("a field the service adds is dropped, and one in a shape it does not write is left out", async () => {
    const doc = JSON.parse((await get("/spaces/odd-board.json")).text) as Json;
    const [row] = doc.findings.items;
    assert.ok(!("x_secret" in row));
    assert.ok(!("author" in row) && !("posted_at" in row) && !("cited_by" in row) && !("source_withdrawn" in row));
    assert.equal(row.status, "unknown");
    assert.equal(row.confidence, "unknown");
    assert.deepEqual(row.sources, [id(1)]);
    assert.doesNotMatch(JSON.stringify(doc), /SENTINEL-FINDING-FIELD/);
  });
});

describe("a finding the service marked contested says what contests it", () => {
  const KEY = `<a href="/peers/${CHECKER}"><code title="${CHECKER}">e5f6e5f6…e5f6</code></a>`;

  test("each cause is one sentence in the row, the posts and the key linked", async () => {
    const text = section((await get("/spaces/contested-board")).text);
    assert.ok(rowOf(text, 1).includes(`A check by ${KEY} rejected post <a href="/spaces/contested-board/30">30</a> as the result of task 7. This finding rests on it.`));
    assert.ok(rowOf(text, 2).includes(`A check by ${KEY} rejected this finding as the result of task 4.`));
    assert.ok(rowOf(text, 3).includes(`A member&#39;s warn, post <a href="/spaces/contested-board/13">13</a>, cites this finding.`) ||
      rowOf(text, 3).includes(`A member's warn, post <a href="/spaces/contested-board/13">13</a>, cites this finding.`), rowOf(text, 3));
    assert.ok(/A member.s fail, post <a href="\/spaces\/contested-board\/14">14<\/a>, cites post <a href="\/spaces\/contested-board\/4">4<\/a>\. This finding rests on it\./.test(rowOf(text, 3)));
  });

  test("a warn's title is text in a block of its own, never markup", async () => {
    const page = (await get("/spaces/contested-board")).text;
    assert.deepEqual(htmlProblems(page), []);
    assert.ok(rowOf(section(page), 3).includes("<pre>Sum is wrong &lt;script&gt;alert(7)&lt;/script&gt;</pre>"));
    assert.ok(!tags(page).some((t) => t.name === "script"), "the title became a script");
  });

  test("a cause in no shape is dropped, and a finding with none left reads as it did", async () => {
    const text = section((await get("/spaces/contested-board")).text);
    assert.doesNotMatch(rowOf(text, 4), /A check|A member|rests on it|<pre>/);
    assert.match(rowOf(text, 4), /<p class="meta">Cited by 0 posts\. Cites no sources\.<\/p>\n<\/div>/);
    assert.doesNotMatch(rowOf(text, 5), /A check|A member|rests on it/);
  });

  test("the markdown says the same, the title fenced", async () => {
    const md = (await get("/spaces/contested-board.md")).text;
    assert.deepEqual(markdownProblems(md), []);
    assert.ok(md.includes(`A check by ${CHECKER} rejected post 30 as the result of task 7. This finding rests on it.`));
    assert.ok(md.includes(`A check by ${CHECKER} rejected this finding as the result of task 4.`));
    assert.ok(md.includes(`A member's warn, post 13, cites this finding. A member's fail, post 14, cites post 4. This finding rests on it.`));
    assert.ok(md.includes("```\nSum is wrong <script>alert(7)</script>\n```"), "the title is not in a fence");
    assert.doesNotMatch(md, /judged/);
  });

  test("the JSON keeps each cause as the service wrote it, those in no shape dropped", async () => {
    const doc = JSON.parse((await get("/spaces/contested-board.json")).text) as Json;
    const row = (n: number) => doc.findings.items.find((r: Json) => r.number === n);
    assert.deepEqual(row(1).contested, CONTESTED[0]!.contested);
    assert.deepEqual(row(3).contested, CONTESTED[2]!.contested);
    assert.ok(!("contested" in row(4)), "a list with nothing left is left out");
    assert.ok(!("contested" in row(5)));
  });
});

describe("the stand-in service was asked for nothing it does not answer", () => {
  test("every address the pages read was answered", () => {
    assert.deepEqual(unanswered, []);
  });
});
