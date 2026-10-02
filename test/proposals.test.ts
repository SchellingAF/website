// The proposals, as a page: every request to change the service, newest first, each with its
// title linked to its space, its status and the date it was opened, in HTML, markdown and JSON.
//
// A proposal is a public work space named proposal-<name>, filed under the category this-service.
// The list is the service's own, read by name through the proposals' run of names and kept to
// the spaces that are one, and the status of each is what the first words of the Status section of
// its document say. Driven through handleRequest() against the stand-in service, which answers a
// work space's document as the product does and refuses a space that keeps none. What a service
// does not give, a page does not guess: a space with no document says so, and a document read
// that failed says so on its own row and holds the page for a minute only.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { json, refusal, service, type Call, type Json } from "./lib/service.ts";
import { otherSpace, proposalText, proposalWorld, type Proposal } from "./lib/proposals.ts";
import { htmlProblems, markdownProblems } from "./lib/documents.ts";
import { env, site } from "./lib/site.ts";
import * as H from "./fixtures/hostile.ts";
import { DYNAMIC_ROUTES, reservation } from "../build.mjs";

let answer: (call: Call) => Response | Promise<Response> = service(proposalWorld([]));
const { fake, handleRequest } = await site((call) => answer(call));

let hosts = 0;
const host = () => `https://p${++hosts}.localhost`;

async function ask(url: string, init?: RequestInit, withEnv: Record<string, unknown> = env) {
  const res = await handleRequest(new Request(url, init), withEnv as typeof env);
  return { res, text: await res.text(), h: (n: string) => res.headers.get(n) };
}

const listReads = () => fake.calls.filter((c) => c.url.pathname === "/v1/spaces");
const documentReads = () => fake.calls.filter((c) => /^\/v1\/spaces\/[^/]+\/document$/.test(c.url.pathname));
/** The names of the spaces whose documents were read since `from` calls had been made. */
const documentsSince = (from: number) => documentReads().filter((c) => fake.calls.indexOf(c) >= from).map((c) => c.url.pathname.split("/")[3]!);

/** A page's rows, as the page writes them, and what each says. */
const rows = (html: string): string[] => html.split('<div class="item">').slice(1).map((r) => r.split("</div>")[0]!);
const nameOf = (row: string): string => /href="\/spaces\/([^"]+)"/.exec(row)![1]!;
const statusOf = (row: string): string => /<span class="tag">([^<]*)<\/span>/.exec(row)![1]!;
const rowFor = (html: string, name: string): string => rows(html).find((r) => nameOf(r) === name)!;

const at = (day: number, hour = 9) => `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const withStatus = (name: string, status: string | null, created = at(1), fields: Json = {}): Proposal =>
  ({ name, created, document: proposalText(`About ${name}`, status), ...(Object.keys(fields).length ? { fields } : {}) });

const LEAD_HTML = 'A proposal is a request to change the service, kept in a public work space whose name starts with <code>proposal-</code> and that is filed under the category <a href="/spaces/by/category/this-service">this-service</a>. To open one, start with the space <a href="/spaces/proposals">proposals</a>.';
const LEAD_TEXT = "A proposal is a request to change the service, kept in a public work space whose name starts with proposal- and that is filed under the category this-service. To open one, start with the space proposals.";
const LEAD_MARKDOWN = "A proposal is a request to change the service, kept in a public work space whose name starts with `proposal-` and that is filed under the category [this-service](/spaces/by/category/this-service.md). To open one, start with the space [proposals](/spaces/proposals.md).";
const STATUS_NOTE = "A proposal's status is the first words of the Status section of its document.";
const MORE = "More proposals exist than this page lists.";

describe("the list", () => {
  const set = [
    // By name these are alpha, beta, gamma; by when they were opened, beta, alpha, gamma; and by activity, gamma first.
    withStatus("proposal-alpha", "merged on 1 October 2026 in commit abc123.", at(1)),
    withStatus("proposal-beta", "proposed; the owner decides", at(2)),
    withStatus("proposal-gamma", "in progress: a pull request is open", at(1, 3), { last_written_at: "2026-10-09T00:00:00.000Z" }),
  ];

  test("is every proposal, newest first by when it was opened, each title linked to its space, with its status and the date", async () => {
    answer = service(proposalWorld(set));
    const { res, text, h } = await ask(`${host()}/proposals`);
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.match(h("Content-Type") ?? "", /^text\/html/);
    assert.equal(h("X-Robots-Tag"), "index, follow, max-snippet:-1");
    assert.match(text, /<link rel="canonical" href="https:\/\/schellingaf\.com\/proposals">/);
    assert.match(text, /<title>Proposals — Schelling Add Forward<\/title>/);
    assert.deepEqual(rows(text).map(nameOf), ["proposal-beta", "proposal-alpha", "proposal-gamma"]);
    assert.ok(text.includes('<h3><a href="/spaces/proposal-beta">Title of proposal-beta</a></h3>'));
    assert.ok(text.includes('<h3><a href="/spaces/proposal-alpha">Title of proposal-alpha</a></h3>'));
    assert.equal(statusOf(rowFor(text, "proposal-beta")), "proposed");
    assert.equal(statusOf(rowFor(text, "proposal-alpha")), "merged");
    assert.equal(statusOf(rowFor(text, "proposal-gamma")), "in progress");
    assert.match(rowFor(text, "proposal-beta"), /opened 2 Oct 2026/);
    assert.match(rowFor(text, "proposal-alpha"), /opened 1 Oct 2026/);
    assert.ok(!text.includes(MORE), "three proposals are all there are");
    assert.deepEqual(htmlProblems(text), []);
  });

  test("says what a proposal is and how one is opened, in a line, and where a status comes from", async () => {
    answer = service(proposalWorld(set));
    const { text } = await ask(`${host()}/proposals`);
    assert.ok(text.includes(`<p class="lead">${LEAD_HTML}</p>`), "the line at the top");
    assert.ok(text.includes(`<p class="meta">${STATUS_NOTE}</p>`.replace("'", "&#39;")));
    const md = (await ask(`${host()}/proposals.md`)).text;
    assert.ok(md.includes(`\n${LEAD_MARKDOWN}\n`));
    assert.ok(md.includes(`\n${STATUS_NOTE}\n`));
    const doc = JSON.parse((await ask(`${host()}/proposals.json`)).text);
    assert.equal(doc.about, LEAD_TEXT);
    assert.equal(doc.status_means, STATUS_NOTE);
    assert.equal(doc.space, "/spaces/proposals");
    assert.equal(doc.category, "/spaces/by/category/this-service");
    // It points at the space and says nothing the service does not do.
    for (const page of [text, md, JSON.stringify(doc)]) {
      assert.doesNotMatch(page, /permanent|forever|guarantee|will be built|promise|always/i);
    }
  });

  test("leaves out everything that is not a proposal, and reads no document it does not list", async () => {
    answer = service(proposalWorld(
      [
        withStatus("proposal-listed", "proposed", at(2)),
        withStatus("proposal-private", "proposed", at(3), { visibility: "private" }),
        withStatus("proposal-oracle", "proposed", at(4), { oracle: true }),
        { name: "proposal-elsewhere", created: at(5), document: proposalText("x", "proposed"), fields: { categories: ["general"] } },
      ],
      [otherSpace("proposals"), otherSpace("how-to-use"), otherSpace("guide-start-here", { oracle: true }), otherSpace("proposalx")],
    ));
    const before = fake.calls.length;
    const { text } = await ask(`${host()}/proposals`);
    assert.deepEqual(rows(text).map(nameOf), ["proposal-listed"]);
    assert.deepEqual(documentsSince(before), ["proposal-listed"]);
    for (const left of ["proposal-private", "proposal-oracle", "proposal-elsewhere", "/spaces/proposals\"", "how-to-use", "guide-start-here", "proposalx"]) {
      assert.ok(!rows(text).join("").includes(left), left);
    }
    const md = (await ask(`${host()}/proposals.md`)).text;
    assert.equal(md.match(/^## /gm)?.length, 1);
  });

  test("asks for the work spaces filed under the category, from the first proposal, as many as the service gives at once", async () => {
    answer = service(proposalWorld(set));
    const before = fake.calls.length;
    await ask(`${host()}/proposals`);
    const mine = listReads().filter((c) => fake.calls.indexOf(c) >= before);
    assert.equal(mine.length, 1, "three proposals are one page");
    const q = mine[0]!.url.searchParams;
    assert.equal(q.get("category"), "this-service");
    assert.equal(q.get("oracle"), "false");
    assert.equal(q.get("limit"), "200");
    assert.equal(q.get("after"), "proposal");
    assert.equal(q.get("q"), null);
  });

  test("with none is a page that says so, listed all the same", async () => {
    answer = service(proposalWorld([], [otherSpace("proposals")]));
    for (const [path, want] of [["/proposals", /<p>No proposal has been opened yet\.<\/p>/], ["/proposals.md", /^No proposal has been opened yet\.$/m]] as const) {
      const { res, text } = await ask(`${host()}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(text, want, path);
    }
    const doc = JSON.parse((await ask(`${host()}/proposals.json`)).text);
    assert.deepEqual(doc.items, []);
    assert.equal(doc.has_more, false);
  });

  test("a title with nothing in it is the space's name, and a long one is cut at a word the same way in every format", async () => {
    const long = `${"word ".repeat(80)}end`;
    answer = service(proposalWorld([
      { name: "proposal-untitled", title: "", created: at(2), document: proposalText("x", "proposed") },
      { name: "proposal-long", title: long, created: at(1), document: proposalText("x", "proposed") },
    ]));
    const html = (await ask(`${host()}/proposals`)).text;
    assert.ok(html.includes('<h3><a href="/spaces/proposal-untitled">proposal-untitled</a></h3>'));
    const cut = JSON.parse((await ask(`${host()}/proposals.json`)).text).items.find((i: Json) => i.name === "proposal-long").title as string;
    assert.ok(cut.endsWith("…") && cut.length <= 301 && cut.length < long.length, cut.length.toString());
    assert.ok(html.includes(`>${cut}</a>`), "the page carries the same cut");
    assert.ok((await ask(`${host()}/proposals.md`)).text.includes(`- title: \`${cut}\``), "so does the markdown");
  });
});

describe("the status", () => {
  const words: [string, string, string][] = [
    ["proposed", "proposed; the owner decides; discussion and tasks below", "proposed"],
    ["discussing", "discussing: two agents disagree on the limit", "discussing"],
    ["accepted", "accepted on 2 October 2026: the owner decided, with all four choices.", "accepted"],
    ["in progress", "in progress: a pull request is open", "in progress"],
    ["merged", "merged on 2 October 2026 in commit 6114009e9a8c; the specification as built is [[proposal-seq-in-sources/3]].", "merged"],
    ["declined", "declined on 3 October 2026: it repeats proposal-routine.", "declined"],
    // In any capitals, and whole words only.
    ["capitals", "Merged.", "merged"],
    ["all capitals", "IN PROGRESS", "in progress"],
    ["a word alone", "declined", "declined"],
  ];
  const world = proposalWorld(words.map(([name, status], i) => withStatus(`proposal-${name.replace(/ /g, "-")}`, status, at(1 + i % 9, i))));

  test("each of the six is said as the one word, whatever capitals the document used", async () => {
    answer = service(world);
    const { text } = await ask(`${host()}/proposals`);
    for (const [name, , want] of words) assert.equal(statusOf(rowFor(text, `proposal-${name.replace(/ /g, "-")}`)), want, name);
    const doc = JSON.parse((await ask(`${host()}/proposals.json`)).text);
    for (const [name, , want] of words) assert.equal(doc.items.find((i: Json) => i.name === `proposal-${name.replace(/ /g, "-")}`).status, want, name);
    const md = (await ask(`${host()}/proposals.md`)).text;
    for (const [name, , want] of words) {
      const part = md.split(/^## /m).find((p) => p.startsWith(`proposal-${name.replace(/ /g, "-")}\n`))!;
      assert.match(part, new RegExp(`^- status: ${want}$`, "m"), name);
    }
  });

  test("is the first words of the Status section and nothing else of the document", async () => {
    answer = service(proposalWorld([
      // Words of the other sections, and a later sentence of the section, are not the status.
      { name: "proposal-others", created: at(2), document: "# T\n\n## Problem\nmerged everywhere.\n\n## Status\nproposed; it was merged before.\n\n## Notes\ndeclined.\n" },
      { name: "proposal-first", created: at(1), document: "# T\n\n## Status\n\nIt was proposed, then merged.\n" },
    ]));
    const { text } = await ask(`${host()}/proposals`);
    assert.equal(statusOf(rowFor(text, "proposal-others")), "proposed");
    assert.equal(statusOf(rowFor(text, "proposal-first")), "no status yet", "a section that does not begin with one of the six says no more");
  });

  test("a declined proposal carries its reason, in every format, and no other proposal does", async () => {
    answer = service(world);
    const html = (await ask(`${host()}/proposals`)).text;
    assert.ok(rowFor(html, "proposal-declined").includes("<p>Reason: on 3 October 2026: it repeats proposal-routine.</p>"));
    assert.ok(!rowFor(html, "proposal-a-word-alone").includes("Reason"), "a decline that gives none shows none");
    assert.equal(html.split("Reason:").length - 1, 1, "one reason on the page");
    const md = (await ask(`${host()}/proposals.md`)).text;
    assert.ok(md.includes("- reason: `on 3 October 2026: it repeats proposal-routine.`"));
    assert.equal(md.split("- reason:").length - 1, 1);
    const doc = JSON.parse((await ask(`${host()}/proposals.json`)).text);
    assert.equal(doc.items.find((i: Json) => i.name === "proposal-declined").reason, "on 3 October 2026: it repeats proposal-routine.");
    assert.equal(doc.items.filter((i: Json) => "reason" in i).length, 1);
  });

  test("a long reason is cut at a word, the same in every format", async () => {
    const reason = `${"because ".repeat(60)}end`;
    answer = service(proposalWorld([withStatus("proposal-wordy", `declined: ${reason}`)]));
    const html = (await ask(`${host()}/proposals`)).text;
    const shown = /<p>Reason: ([^<]*)<\/p>/.exec(html)![1]!;
    assert.ok(shown.endsWith("…") && shown.length <= 301, shown.length.toString());
    const doc = JSON.parse((await ask(`${host()}/proposals.json`)).text);
    assert.equal(doc.items[0].reason, shown);
    assert.ok((await ask(`${host()}/proposals.md`)).text.includes(`- reason: \`${shown}\``));
  });

  test("no document, no Status section and an empty one say no document yet; a section of other words says no status yet", async () => {
    answer = service(proposalWorld([
      { name: "proposal-nothing", created: at(9) },
      { name: "proposal-unversioned", created: at(8), document: null },
      withStatus("proposal-no-section", null, at(7)),
      withStatus("proposal-empty", "", at(6)),
      withStatus("proposal-other-words", "waiting for the owner", at(5)),
      withStatus("proposal-glued", "mergedxyz", at(4)),
      withStatus("proposal-hyphen", "merged-ish", at(3)),
      // Another level of heading, and no section at all named for it.
      { name: "proposal-deeper", created: at(2), document: "# T\n\n### Status\nmerged\n" },
      { name: "proposal-renamed", created: at(1), document: "# T\n\n## State\nmerged\n" },
    ]));
    const before = fake.calls.length;
    const { res, text } = await ask(`${host()}/proposals`);
    assert.equal(res.status, 200);
    const want: Record<string, string> = {
      "proposal-nothing": "no document yet", "proposal-unversioned": "no document yet", "proposal-no-section": "no document yet",
      "proposal-empty": "no document yet", "proposal-other-words": "no status yet", "proposal-glued": "no status yet",
      "proposal-hyphen": "no status yet", "proposal-deeper": "merged", "proposal-renamed": "no document yet",
    };
    for (const [name, status] of Object.entries(want)) assert.equal(statusOf(rowFor(text, name)), status, name);
    assert.equal(documentsSince(before).length, 9, "every listed space's document is asked for, and the one that keeps none is the answer");
    const doc = JSON.parse((await ask(`${host()}/proposals.json`)).text);
    const nothing = doc.items.find((i: Json) => i.name === "proposal-nothing");
    assert.equal(nothing.status, null);
    assert.equal(nothing.status_note, "no document yet");
    assert.equal(doc.items.find((i: Json) => i.name === "proposal-glued").status_note, "no status yet");
    const md = (await ask(`${host()}/proposals.md`)).text;
    assert.match(md.split(/^## /m).find((p) => p.startsWith("proposal-nothing\n"))!, /^- status: no document yet$/m);
  });
});

describe("a document that could not be read", () => {
  const set = [
    withStatus("proposal-a", "merged", at(5)),
    withStatus("proposal-b", "proposed", at(4)),
    withStatus("proposal-c", "accepted", at(3)),
    withStatus("proposal-d", "declined: no", at(2)),
  ];
  const failing = (broken: (name: string) => Response | null) => {
    const base = service(proposalWorld(set));
    return (call: Call) => {
      const m = /^\/v1\/spaces\/([^/]+)\/document$/.exec(call.url.pathname);
      return (m && broken(m[1]!)) || base(call);
    };
  };

  test("says so on its own row alone, and holds the page for a minute only", async () => {
    answer = failing((name) => (name === "proposal-b" ? new Response("down", { status: 500 }) : null));
    const { res, text, h } = await ask(`${host()}/proposals`);
    assert.equal(res.status, 200);
    assert.equal(statusOf(rowFor(text, "proposal-b")), "status could not be read just now");
    assert.equal(statusOf(rowFor(text, "proposal-a")), "merged");
    assert.equal(statusOf(rowFor(text, "proposal-c")), "accepted");
    assert.equal(statusOf(rowFor(text, "proposal-d")), "declined");
    const maxAge = Number(/max-age=(\d+)/.exec(h("Cache-Control") ?? "")?.[1]);
    assert.ok(maxAge > 0 && maxAge <= 60, `held ${maxAge} seconds`);
    const doc = JSON.parse((await ask(`${host()}/proposals.json`)).text);
    assert.equal(doc.items.find((i: Json) => i.name === "proposal-b").status_note, "status could not be read just now");
  });

  test("a refusal that is not 'this space keeps no document' is not read as one", async () => {
    answer = failing((name) => (name === "proposal-a" ? refusal(403, "READ_DENIED") : name === "proposal-b" ? refusal(404, "SPACE_NOT_FOUND") : null));
    const { text } = await ask(`${host()}/proposals`);
    assert.equal(statusOf(rowFor(text, "proposal-a")), "status could not be read just now");
    assert.equal(statusOf(rowFor(text, "proposal-b")), "status could not be read just now");
  });

  test("an answer that is not a document is no document either", async () => {
    answer = failing((name) => (name === "proposal-a" ? new Response("not json", { status: 200 }) : name === "proposal-b" ? json("a string") : null));
    const { res, text } = await ask(`${host()}/proposals`);
    assert.equal(res.status, 200);
    assert.equal(statusOf(rowFor(text, "proposal-a")), "status could not be read just now");
    assert.equal(statusOf(rowFor(text, "proposal-b")), "no document yet");
  });

  test("a refusal to slow down stops the reads: the rest are not asked for, and each says so", async () => {
    const calls: string[] = [];
    answer = failing((name) => { calls.push(name); return refusal(429, "RATE_LIMITED"); });
    const { res, text } = await ask(`${host()}/proposals`);
    assert.equal(res.status, 200);
    assert.ok(calls.length <= 2, `${calls.length} documents were asked for after the service said to slow down`);
    for (const name of ["proposal-a", "proposal-b", "proposal-c", "proposal-d"]) assert.equal(statusOf(rowFor(text, name)), "status could not be read just now", name);
  });

  test("every row is still there, and the next reader is not given the failure for ten minutes", async () => {
    const origin = host();
    answer = failing(() => new Response("down", { status: 500 }));
    const first = await ask(`${origin}/proposals`);
    assert.deepEqual(rows(first.text).map(nameOf), ["proposal-a", "proposal-b", "proposal-c", "proposal-d"]);
    assert.match(first.h("Cache-Control") ?? "", /^public, max-age=([1-9]|[1-5][0-9]|60), stale-while-revalidate=60$/);
  });
});

describe("paging and the most that is read", () => {
  const many = (count: number): Proposal[] => Array.from({ length: count }, (_, i) =>
    withStatus(`proposal-p${String(i).padStart(3, "0")}`, "proposed", new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString()));
  const after = [otherSpace("proposals"), otherSpace("quiet-notes"), otherSpace("zeta-notes")];

  test("goes on to the next page while the service says there is more, and stops at the first name that is no proposal's", async () => {
    answer = service(proposalWorld(many(205), after));
    const before = fake.calls.length;
    const { text } = await ask(`${host()}/proposals`);
    const mine = listReads().filter((c) => fake.calls.indexOf(c) >= before);
    assert.equal(mine.length, 2, "two hundred and five proposals are two pages");
    assert.deepEqual(mine.map((c) => c.url.searchParams.get("after")), ["proposal", "proposal-p199"]);
    for (const c of mine) assert.equal(c.url.searchParams.get("limit"), "200");
    // The newest is on the second page by name, and is first because the pages were joined and sorted.
    assert.equal(nameOf(rows(text)[0]!), "proposal-p204");
    assert.ok(!rows(text).map(nameOf).some((n) => !/^proposal-p\d{3}$/.test(n)), "no space past the run is listed");
  });

  test("reads nothing past the proposals, however many spaces in the category come after them", async () => {
    const crowd = Array.from({ length: 450 }, (_, i) => otherSpace(`zz-notes-${String(i).padStart(3, "0")}`));
    answer = service(proposalWorld(many(3), [otherSpace("proposals"), ...crowd]));
    const before = fake.calls.length;
    const { text } = await ask(`${host()}/proposals`);
    assert.equal(listReads().filter((c) => fake.calls.indexOf(c) >= before).length, 1, "the first page ends in spaces that are not proposals, and the walk ends there");
    assert.equal(rows(text).length, 3);
    assert.ok(!text.includes(MORE), "nothing is left unread of the proposals");
  });

  test("reads the documents of the newest hundred only, and says there are more", async () => {
    answer = service(proposalWorld(many(205), after));
    const before = fake.calls.length;
    const { text } = await ask(`${host()}/proposals`);
    const read = documentsSince(before);
    assert.equal(read.length, 100);
    assert.deepEqual([...read].sort(), many(205).slice(105).map((p) => p.name));
    assert.equal(rows(text).length, 100);
    assert.equal(nameOf(rows(text).at(-1)!), "proposal-p105");
    assert.equal(text.split(MORE).length - 1, 1);
    assert.ok((await ask(`${host()}/proposals.md`)).text.includes(`\n${MORE}\n`));
    const doc = JSON.parse((await ask(`${host()}/proposals.json`)).text);
    assert.equal(doc.has_more, true);
    assert.equal(doc.more_means, MORE);
    assert.equal(doc.items.length, 100);
  });

  test("exactly a hundred is not more", async () => {
    answer = service(proposalWorld(many(100), after));
    const { text } = await ask(`${host()}/proposals`);
    assert.equal(rows(text).length, 100);
    assert.ok(!text.includes(MORE));
  });

  test("a service whose cursor does not move on is read once, and the page says there are more", async () => {
    const base = service(proposalWorld(many(3)));
    answer = async (call) => {
      const res = base(call);
      return call.url.pathname === "/v1/spaces" ? json({ ...(await res.json()), next_after: "proposal", has_more: true }) : res;
    };
    const before = fake.calls.length;
    const { res, text } = await ask(`${host()}/proposals`);
    assert.equal(res.status, 200);
    assert.equal(listReads().filter((c) => fake.calls.indexOf(c) >= before).length, 1);
    assert.equal(rows(text).length, 3);
    assert.ok(text.includes(MORE));
  });

  test("a page of the list that fails is a page that says the service did not answer, never a shorter list", async () => {
    const base = service(proposalWorld(many(205), after));
    answer = (call) => (call.url.pathname === "/v1/spaces" && call.url.searchParams.get("after") !== "proposal" ? new Response("down", { status: 500 }) : base(call));
    const { res, text, h } = await ask(`${host()}/proposals`);
    assert.equal(res.status, 503);
    assert.equal(h("Retry-After"), "60");
    assert.doesNotMatch(text, /proposal-p0/);
  });

  test("never reads more pages of the list than a walk is allowed", async () => {
    // A service that always says there is more, with a cursor that moves on: the walk ends by itself.
    let n = 0;
    answer = (call) => {
      if (call.url.pathname !== "/v1/spaces") return refusal(404, "SPACE_NOT_FOUND");
      n++;
      return json({ items: [], next_after: `proposal-z${String(n).padStart(3, "0")}`, has_more: true });
    };
    const { res, text } = await ask(`${host()}/proposals`);
    assert.equal(res.status, 200);
    assert.equal(n, 10, "ten pages and no more");
    assert.ok(text.includes(MORE));
  });
});

describe("what a proposal's words are made of", () => {
  const hostile: Proposal[] = [
    {
      name: "proposal-hostile-title", title: `Hostile ${H.XSS}\n## a heading after the break`, created: at(9),
      document: proposalText("x", "declined: line one <script>alert(77)</script>\nline two [[proposal-routine]] `code` [a link](https://x.invalid)"),
    },
    { name: "proposal-backticks", title: H.BACKTICK_TITLE, created: at(8), document: proposalText("x", "merged") },
    { name: "proposal-attribute", title: H.ATTRIBUTE_BREAKOUT, created: at(7), document: proposalText("x", `merged" onmouseover="alert(31)`) },
    { name: "proposal-status-markup", title: "Markup as a status", created: at(6), document: proposalText("x", "<script>alert(21)</script> merged") },
    { name: "proposal-bad-time", title: "A time that is not one", created: at(5), fields: { created_at: "2026-10-02T09:00:00.000Z<script>alert(41)</script>" }, document: proposalText("x", "proposed") },
    { name: "proposal-newline", title: H.NEWLINE_TITLE, created: at(4), document: proposalText("x", "proposed") },
    // Names that are not a space's name are not listed, whatever else they carry.
    { name: "proposal-<img src=x onerror=alert(9)>", title: "A name that is markup", created: at(3), document: proposalText("x", "proposed") },
    { name: "proposal-UPPER", title: "A name in capitals", created: at(2), document: proposalText("x", "proposed") },
    { name: "proposal-with space", title: "A name with a space", created: at(1), document: proposalText("x", "proposed") },
  ];

  test("a title and a reason are text in HTML, markdown and JSON, and never structure", async () => {
    answer = service(proposalWorld(hostile));
    const html = (await ask(`${host()}/proposals`)).text;
    assert.deepEqual(htmlProblems(html), []);
    assert.ok(!html.includes("<script>alert"), "no raw script");
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "the title is there, escaped");
    assert.ok(html.includes("&lt;script&gt;alert(77)&lt;/script&gt; line two"), "so is the reason, on one line");
    assert.ok(!html.includes('onmouseover="'), "a quote did not end an attribute");
    const md = (await ask(`${host()}/proposals.md`)).text;
    assert.deepEqual(markdownProblems(md), []);
    assert.ok(!/^## (?!`?proposal-)/m.test(md), "a title never became a heading");
    assert.ok(md.includes("- title: ``` ``a title`` that ends in ` a backtick` ```"), "the backticks are inside a longer code span");
    const text = (await ask(`${host()}/proposals.json`)).text;
    const doc = JSON.parse(text);
    assert.equal(doc.items.length, 6, "the three names that are not a space's are not listed");
    assert.deepEqual(doc.items.map((i: Json) => i.name), ["proposal-hostile-title", "proposal-backticks", "proposal-attribute", "proposal-status-markup", "proposal-newline", "proposal-bad-time"]);
    assert.ok(doc.items[0].title.startsWith("Hostile <script>alert(1)</script>"));
    assert.ok(doc.items[0].title.includes(" ## a heading after the break"), "a title is one line in every format");
    assert.equal(doc.items[0].reason, "line one <script>alert(77)</script> line two [[proposal-routine]] `code` [a link](https://x.invalid)");
  });

  test("a status is one of the six words however the document spells it, and markup in its place says no status", async () => {
    answer = service(proposalWorld(hostile));
    const html = (await ask(`${host()}/proposals`)).text;
    assert.equal(statusOf(rowFor(html, "proposal-attribute")), "merged");
    assert.equal(statusOf(rowFor(html, "proposal-status-markup")), "no status yet");
    assert.ok(!html.includes("alert(21)"), "the markup that stood where the status should be is not shown");
    assert.ok(!html.includes("alert(31)"), "nor what followed a status word");
  });

  test("a time that is not the service's shape is no date, in every format", async () => {
    answer = service(proposalWorld(hostile));
    const html = (await ask(`${host()}/proposals`)).text;
    assert.ok(!/opened/.test(rowFor(html, "proposal-bad-time")), "no date for it on the page");
    for (const page of [html, (await ask(`${host()}/proposals.md`)).text, (await ask(`${host()}/proposals.json`)).text]) assert.ok(!page.includes("alert(41)"), "the time is in no format");
    const doc = JSON.parse((await ask(`${host()}/proposals.json`)).text);
    assert.equal(doc.items.find((i: Json) => i.name === "proposal-bad-time").created_at, null);
    const md = (await ask(`${host()}/proposals.md`)).text;
    assert.ok(!md.split(/^## /m).find((p) => p.startsWith("proposal-bad-time\n"))!.includes("opened"));
    // And it is last: a proposal with no date is the oldest.
    assert.equal(doc.items.at(-1).name, "proposal-bad-time");
  });
});

describe("the reads", () => {
  const set = [withStatus("proposal-a", "merged", at(4)), withStatus("proposal-b", "proposed", at(3)), withStatus("proposal-c", "accepted", at(2)), withStatus("proposal-d", "discussing", at(1))];

  test("read with no key when the site holds none, and with the site's key when it does, the list and each document", async () => {
    answer = service(proposalWorld(set));
    const none = fake.calls.length;
    await ask(`${host()}/proposals`);
    const keyless = fake.calls.slice(none).filter((c) => c.url.pathname.startsWith("/v1/spaces"));
    assert.equal(keyless.length, 5);
    for (const c of keyless) assert.equal(c.headers.get("authorization"), null, c.url.pathname);
    const keyed = fake.calls.length;
    await ask(`${host()}/proposals`, undefined, { ...env, SITE_TOKEN: "a-site-key", READER_TOKEN: "a-reader-key" });
    const mine = fake.calls.slice(keyed).filter((c) => c.url.pathname.startsWith("/v1/spaces"));
    assert.equal(mine.length, 5);
    for (const c of mine) assert.equal(c.headers.get("authorization"), "Bearer a-site-key", c.url.pathname);
    assert.ok(!fake.calls.slice(keyed).some((c) => c.headers.get("authorization") === "Bearer a-reader-key"), "never the reader's key");
  });

  test("makes one document read for each proposal, two at a time at most", async () => {
    const base = service(proposalWorld([...set, withStatus("proposal-e", "merged", at(1, 1)), withStatus("proposal-f", "merged", at(1, 2))]));
    const open = { now: 0, most: 0 };
    answer = async (call) => {
      if (!/\/document$/.test(call.url.pathname)) return base(call);
      open.now++;
      open.most = Math.max(open.most, open.now);
      await new Promise((r) => setTimeout(r, 5));
      open.now--;
      return base(call);
    };
    const before = fake.calls.length;
    const { res, text } = await ask(`${host()}/proposals`);
    assert.equal(res.status, 200);
    assert.equal(documentsSince(before).length, 6, "one each");
    assert.equal(open.most, 2, `${open.most} reads were open at once`);
    assert.equal(rows(text).length, 6);
  });

  test("a crowd that arrives together, and the three formats at once, are one build and one set of reads", async () => {
    answer = service(proposalWorld(set));
    const origin = host();
    const before = fake.calls.length;
    const together = await Promise.all([
      ask(`${origin}/proposals`), ask(`${origin}/proposals`), ask(`${origin}/proposals.md`), ask(`${origin}/proposals.json`), ask(`${origin}/proposals`),
    ]);
    for (const t of together) assert.equal(t.res.status, 200);
    assert.equal(listReads().filter((c) => fake.calls.indexOf(c) >= before).length, 1, "one read of the list");
    assert.equal(documentsSince(before).length, 4, "one read of each document");
    assert.ok(together[0]!.text.includes("proposal-b") && together[2]!.text.includes("proposal-b") && together[3]!.text.includes("proposal-b"));
  });

  test("once a build has ended it is not remembered: another format is its own build", async () => {
    const origin = host();
    answer = service(proposalWorld(set));
    await ask(`${origin}/proposals.json`);
    const before = fake.calls.length;
    await ask(`${origin}/proposals.md`);
    assert.equal(documentsSince(before).length, 4, "each format is its own page, built once");
  });
});

describe("when the service does not answer", () => {
  test("a 503 that says so, in each format, which nobody keeps and no search engine lists", async () => {
    answer = () => new Response("down", { status: 500 });
    const web = await ask(`${host()}/proposals`);
    assert.equal(web.res.status, 503);
    assert.equal(web.h("X-Robots-Tag"), "noindex, nofollow");
    assert.equal(web.h("Cache-Control"), "no-store");
    assert.equal(web.h("Retry-After"), "60");
    assert.match(web.text, /The service is not answering/);
    assert.doesNotMatch(web.text, /<link rel="canonical"/);
    assert.deepEqual(htmlProblems(web.text), []);
    const md = await ask(`${host()}/proposals.md`);
    assert.equal(md.res.status, 503);
    assert.match(md.text, /^# The service is not answering$/m);
    assert.deepEqual(markdownProblems(md.text), []);
    const doc = await ask(`${host()}/proposals.json`);
    assert.equal(doc.res.status, 503);
    assert.equal(typeof JSON.parse(doc.text).error, "string");
  });

  test("an answer that is not a list is the same 503, and so is a service that does not know the category", async () => {
    answer = (call) => (call.url.pathname === "/v1/spaces" ? json({ spaces: [] }) : new Response("", { status: 404 }));
    assert.equal((await ask(`${host()}/proposals`)).res.status, 503);
    answer = (call) => (call.url.pathname === "/v1/spaces" ? refusal(400, "INVALID_CATEGORY") : new Response("", { status: 404 }));
    const { res, h } = await ask(`${host()}/proposals`);
    assert.equal(res.status, 503);
    assert.equal(h("X-Robots-Tag"), "noindex, nofollow");
  });

  test("an outage is not kept: the next reader gets the page once the service answers", async () => {
    const origin = host();
    answer = () => new Response("down", { status: 500 });
    assert.equal((await ask(`${origin}/proposals`)).res.status, 503);
    answer = service(proposalWorld([withStatus("proposal-a", "merged")]));
    assert.equal((await ask(`${origin}/proposals`)).res.status, 200);
  });
});

describe("how long the page is held", () => {
  const set = [withStatus("proposal-a", "merged", at(3)), withStatus("proposal-b", "proposed", at(2)), withStatus("proposal-c", "declined: no", at(1))];

  test("for ten minutes, so many readers cost one build, and each format is read once", async () => {
    answer = service(proposalWorld(set));
    const origin = host();
    const before = fake.calls.length;
    const first = await ask(`${origin}/proposals`);
    for (let i = 0; i < 4; i++) await ask(`${origin}/proposals`);
    assert.equal(fake.calls.length - before, 4, "five readers: one read of the list and one of each document");
    await ask(`${origin}/proposals.json`);
    await ask(`${origin}/proposals.json`);
    assert.equal(fake.calls.length - before, 8, "the JSON is its own page, built once");
    const maxAge = Number(/max-age=(\d+)/.exec(first.h("Cache-Control") ?? "")?.[1]);
    assert.ok(maxAge > 0 && maxAge <= 600, `max-age ${maxAge}`);
    assert.match(first.h("Cache-Control") ?? "", /^public, max-age=\d+, stale-while-revalidate=60$/);
  });

  test("a query on the address makes no new page and no new read", async () => {
    answer = service(proposalWorld(set));
    const origin = host();
    const before = fake.calls.length;
    await ask(`${origin}/proposals`);
    const first = fake.calls.length - before;
    for (const q of ["?x=1", "?x=2", "?q=anything", "?after=proposal-b", "?before=1~proposal-a"]) await ask(`${origin}/proposals${q}`);
    assert.equal(fake.calls.length - before, first);
  });

  test("HEAD is answered from the same page", async () => {
    answer = service(proposalWorld(set));
    const origin = host();
    const before = fake.calls.length;
    await ask(`${origin}/proposals`);
    const first = fake.calls.length - before;
    const head = await handleRequest(new Request(`${origin}/proposals`, { method: "HEAD" }), env);
    assert.equal(head.status, 200);
    assert.equal(fake.calls.length - before, first);
  });
});

describe("the address", () => {
  test("is answered in each format by extension and by Accept, and offers each as an alternate", async () => {
    answer = service(proposalWorld([withStatus("proposal-a", "merged")]));
    const origin = host();
    const md = await ask(`${origin}/proposals.md`);
    assert.match(md.h("Content-Type") ?? "", /^text\/markdown/);
    assert.match(md.text, /^# Proposals$/m);
    const doc = await ask(`${origin}/proposals.json`);
    assert.match(doc.h("Content-Type") ?? "", /^application\/json/);
    assert.equal(JSON.parse(doc.text).url, "https://schellingaf.com/proposals");
    assert.deepEqual(Object.keys(JSON.parse(doc.text)).sort(),
      ["about", "category", "has_more", "items", "notice", "space", "status_means", "title", "url"]);
    assert.deepEqual(Object.keys(JSON.parse(doc.text).items[0]).sort(), ["created_at", "name", "page", "status", "title"]);
    const viaHeader = JSON.parse((await ask(`${origin}/proposals`, { headers: { Accept: "application/json" } })).text);
    assert.equal(viaHeader.items[0].name, "proposal-a");
    const page = await ask(`${origin}/proposals`);
    assert.match(page.h("Link") ?? "", /<\/proposals\.md>; rel="alternate"; type="text\/markdown"/);
    assert.match(page.h("Link") ?? "", /<\/proposals\.json>; rel="alternate"; type="application\/json"/);
    assert.equal(page.h("Vary"), "Accept");
  });

  test("takes no path beneath it, and nothing but a read", async () => {
    for (const path of ["/proposals/x", "/proposals/proposal-a", "/proposals/1", "/proposalsx", "/proposals.md.json"]) {
      const { res } = await ask(`${host()}${path}`);
      assert.equal(res.status, 404, path);
    }
    assert.equal((await ask(`${host()}/proposals`, { method: "POST", body: "x" })).res.status, 405);
  });

  test("carries the one menu, unchanged, and no entry for itself, and writes the mark escaped", async () => {
    answer = service(proposalWorld([withStatus("proposal-a", "merged")]));
    const { text } = await ask(`${host()}/proposals`);
    const menu = /<nav class="site"[^>]*>([\s\S]*?)<\/nav>/.exec(text)![1]!;
    assert.deepEqual([...menu.matchAll(/href="([^"]*)"/g)].map((m) => m[1]), ["/human", "/spaces", "/seek", "/vocabulary", "/", "/api", "/sign-in"]);
    assert.doesNotMatch(menu, /proposals/i);
    assert.ok(text.includes("Schelling+&gt;") && !text.includes("Schelling+>"));
  });

  test("shows the proposals and their status as the notice that everything below was written by a key", async () => {
    answer = service(proposalWorld([withStatus("proposal-a", "merged")]));
    const { text } = await ask(`${host()}/proposals`);
    assert.match(text, /<p class="note ">Everything below was written by whoever holds a key here/);
    assert.match((await ask(`${host()}/proposals.md`)).text, /^> Everything below was written by whoever holds a key here/m);
    assert.match(JSON.parse((await ask(`${host()}/proposals.json`)).text).notice, /^Everything below was written by whoever holds a key here/);
  });
});

describe("the link from the spaces page", () => {
  test("is one quiet line on the spaces page, in each format, and on no other list", async () => {
    answer = service(proposalWorld([withStatus("proposal-a", "merged")]));
    const page = (await ask(`${host()}/spaces`)).text;
    assert.equal(page.split('href="/proposals"').length - 1, 1, "one link");
    assert.match(page, /<p class="meta"><a href="\/proposals">Proposals<\/a>: requests to change the service, and their status\.<\/p>/);
    assert.match((await ask(`${host()}/spaces.md`)).text, /^Requests to change the service, and their status: \/proposals\.md$/m);
    assert.equal(JSON.parse((await ask(`${host()}/spaces.json`)).text).proposals, "/proposals");
    for (const path of ["/spaces/by/oracle", "/spaces/by/recent", "/spaces/a", "/spaces/by/category", "/vocabulary", "/seek", "/spaces/by/entry/request"]) {
      assert.ok(!(await ask(`${host()}${path}`)).text.includes('href="/proposals"'), `${path} does not link it`);
    }
    for (const path of ["/spaces/by/oracle.md", "/spaces/a.md"]) assert.ok(!(await ask(`${host()}${path}`)).text.includes("/proposals"), path);
    assert.equal(JSON.parse((await ask(`${host()}/spaces/a.json`)).text).proposals, undefined);
  });

  test("is not on the reader's view of every space, in any format", async () => {
    answer = service(proposalWorld([withStatus("proposal-a", "merged")]));
    const reader = { ...env, READER_TOKEN: "a-reader-key" };
    for (const path of ["/inspect", "/inspect.md", "/inspect.json"]) {
      const { res, text } = await ask(`${host()}${path}`, undefined, reader);
      assert.equal(res.status, 200, path);
      assert.ok(!text.includes("/proposals"), `${path} does not link the proposals`);
    }
  });

  test("changes nothing else about the spaces page: the numbers keep their line", async () => {
    answer = service(proposalWorld([]));
    const page = (await ask(`${host()}/spaces`)).text;
    assert.match(page, /<p class="meta"><a href="\/numbers">Numbers<\/a>: how many keys, spaces, posts and direct messages there are\.<\/p>/);
  });
});

describe("where the page is registered", () => {
  test("the build lists it for the sitemap and the index, and no content file can take its address", () => {
    const listed = (DYNAMIC_ROUTES as { route: string; title: string; listed: boolean; summary: string }[]).find((r) => r.route === "/proposals");
    assert.equal(listed?.listed, true);
    assert.equal(listed?.title, "Proposals");
    assert.equal(listed?.summary, "Every request to change the service, newest first, each with its status and the date it was opened. Rendered live from the API.");
    assert.match(reservation("/proposals") ?? "", /belong to the server or to the build/);
    assert.match(reservation("/proposals/extra") ?? "", /belong to the server or to the build/);
  });
});
