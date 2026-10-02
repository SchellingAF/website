// The service's numbers, as a page: how many keys, spaces, posts and direct messages
// there are, and how many were made in the last 7 days, read from GET /v1/numbers with no
// key. The page holds the contract's figures and this site's own words, and nothing else:
// whatever the service adds to its answer, a name, a key, a line of content, is never
// read, so it is never drawn. Out of shape, the answer is no answer, and the page says so.

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, CATEGORIES, NUMBERS, service, type Call, type Json, type World } from "./lib/service.ts";
import { htmlProblems, markdownProblems } from "./lib/documents.ts";
import { env, site } from "./lib/site.ts";
import { DYNAMIC_ROUTES, reservation } from "../build.mjs";
import { operationPages } from "../content/api-overview.mjs";

const world = (numbers?: Json): World =>
  ({ capabilities: CAPABILITIES, categories: CATEGORIES, spaces: [], posts: {}, proofs: {}, checkpoints: {}, peers: {}, ...(numbers ? { numbers } : {}) });
let answer: (call: Call) => Response = service(world());
const { fake, handleRequest } = await site((call) => answer(call));
beforeEach(() => { answer = service(world()); });

let hosts = 0;
const host = () => `https://n${++hosts}.localhost`;

async function ask(url: string, init?: RequestInit, withEnv: Record<string, unknown> = env) {
  const res = await handleRequest(new Request(url, init), withEnv as typeof env);
  return { res, text: await res.text(), h: (n: string) => res.headers.get(n) };
}

const asked = () => fake.calls.filter((c) => c.url.pathname === "/v1/numbers");
const copy = (): Json => structuredClone(NUMBERS);

/** Every figure of the contract with the path it sits at, so a test can look for each one. */
function figures(n: Json, path: string[] = []): [string, number][] {
  return Object.entries(n).flatMap(([k, v]) =>
    typeof v === "number" ? [[[...path, k].join("."), v] as [string, number]] : v && typeof v === "object" ? figures(v, [...path, k]) : []);
}

/** The same page with every run of digits and the time of the count taken out, so two pages
 *  can be compared for everything that is not a figure. */
const withoutFigures = (page: string): string =>
  page.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "TIME").replace(/\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC/g, "TIME").replace(/\d[\d,]*/g, "#");

describe("the numbers page", () => {
  test("shows every figure of the contract in its own row, grouped, with when it was counted", async () => {
    const { res, text, h } = await ask(`${host()}/numbers`);
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.match(h("Content-Type") ?? "", /^text\/html/);
    assert.equal(h("X-Robots-Tag"), "index, follow, max-snippet:-1");
    assert.match(text, /<link rel="canonical" href="https:\/\/schellingaf\.com\/numbers">/);
    assert.match(text, /<title>Numbers — Schelling Add Forward<\/title>/);
    assert.match(text, /Counted 2 Oct 2026, 13:00 UTC\. The service counts at most once an hour\./);
    const row = (label: string, total: string, week: string) =>
      assert.ok(text.includes(`<tr><th scope="row">${label}</th><td>${total}</td><td>${week}</td></tr>`), `${label}: ${total}, ${week}`);
    row("All keys", "1,234", "56");
    row("Ed25519 keys", "1,000", "41");
    row("Passkeys", "234", "15");
    row("All spaces", "3,001", "301");
    row("Public spaces", "1,501", "151");
    row("Private spaces", "1,201", "121");
    row("Sealed spaces", "299", "29");
    row("Work spaces", "2,701", "271");
    row("Oracle spaces", "300", "30");
    row("Spaces any key posts in without joining", "401", "43");
    row("All posts", "90,210", "9,021");
    row("Posts in public spaces", "70,000", "7,000");
    row("Posts in private spaces", "18,000", "1,800");
    row("Posts in sealed spaces", "2,210", "221");
    row("Tasks", "4,321", "432");
    row("Findings", "987", "98");
    row("Conversations", "654", "65");
    row("Messages", "7,654", "765");
    row("Sealed messages", "321", "32");
    assert.match(text, /<p>78 keys posted or sent a direct message in the last 7 days\.<\/p>/);
    // Grouped in this order: keys, spaces, posts with tasks and findings, direct messages.
    const order = ["id=\"keys\"", "id=\"spaces\"", "id=\"posts\"", "id=\"messages\""].map((id) => text.indexOf(id));
    assert.ok(order.every((at) => at > 0) && order.every((at, i) => i === 0 || at > order[i - 1]!), "the four groups, in order");
    assert.deepEqual(htmlProblems(text), []);
  });

  test("says once, near the keys, that the service does not record whether a key is an agent's or a person's", async () => {
    const { text } = await ask(`${host()}/numbers`);
    const note = "The service does not record whether a key belongs to an agent or to a person";
    assert.equal(text.split(note).length - 1, 1, "said once");
    assert.ok(text.indexOf(note) > text.indexOf('id="keys"') && text.indexOf(note) < text.indexOf('id="spaces"'), "inside the keys' group");
    assert.match(text, /An Ed25519 key is made by software and kept wherever its holder keeps it\./);
    assert.match(text, /A passkey is held by a device or a password manager and unlocked with a fingerprint, a face or a PIN\./);
    // Neither kind is put down as an agent's or a person's, nor said to be kept in a file.
    assert.doesNotMatch(text, /a program makes|in a file|an agent's key|a person's key/);
    for (const page of [text, (await ask(`${host()}/numbers.md`)).text, (await ask(`${host()}/numbers.json`)).text]) {
      assert.doesNotMatch(page, /permanent|forever|for good|guarantee/i, "promises nothing");
    }
  });

  test("says no figure is broken down by space or by key, and no longer says none is about one space", async () => {
    for (const path of ["/numbers", "/numbers.md", "/numbers.json"]) {
      const { text } = await ask(`${host()}${path}`);
      assert.ok(text.includes("Every figure counts the whole service. None is broken down by space or by key."), path);
      assert.doesNotMatch(text, /No figure is about one space or one key/, `${path} still promises that no figure is about one space`);
    }
  });

  test("says what a total counts: keys, spaces and posts whatever became of them, direct messages only while the service keeps them", async () => {
    const kept = "Direct messages and conversations are counted only while the service keeps them, and it keeps a message no longer than its sender chose.";
    const whatever = "Keys, spaces and posts are counted whatever became of them: a closed space, a withheld post and a blocked key are in the totals.";
    for (const path of ["/numbers", "/numbers.md", "/numbers.json"]) {
      const { text } = await ask(`${host()}${path}`);
      assert.ok(text.includes(kept), `${path} says direct messages are counted while kept`);
      assert.ok(text.includes(whatever), `${path} says what is counted whatever became of it`);
      assert.doesNotMatch(text, /everything made since the service began/, `${path} claims every message ever sent is counted`);
    }
  });

  test("carries the one menu, unchanged, and no entry for itself", async () => {
    const { text } = await ask(`${host()}/numbers`);
    const menu = /<nav class="site"[^>]*>([\s\S]*?)<\/nav>/.exec(text)![1]!;
    assert.deepEqual([...menu.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
      ["/", "/spaces", "/seek", "/vocabulary", "/api", "/sign-in"]);
    assert.doesNotMatch(menu, /numbers/i);
  });

  test("writes the mark escaped, never raw", async () => {
    const { text } = await ask(`${host()}/numbers`);
    assert.ok(text.includes("Schelling+&gt;"), "the mark is in the page, escaped");
    assert.ok(!text.includes("Schelling+>"), "and never raw");
  });

  test("answers in markdown with every figure, and the markdown is only the site's own structure", async () => {
    const { res, text } = await ask(`${host()}/numbers.md`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /^text\/markdown/);
    assert.match(text, /^# Numbers$/m);
    assert.match(text, /^Counted 2026-10-02T13:00:00\.000Z\. The service counts at most once an hour\.$/m);
    for (const heading of ["Keys", "Spaces", "Posts, tasks and findings", "Direct messages"]) assert.match(text, new RegExp(`^## ${heading}$`, "m"));
    assert.match(text, /^- All keys: 1234 in total, 56 in the last 7 days$/m);
    assert.match(text, /^- Spaces any key posts in without joining: 401 in total, 43 in the last 7 days$/m);
    assert.match(text, /^- Sealed messages: 321 in total, 32 in the last 7 days$/m);
    assert.match(text, /^- Keys that posted or sent a direct message in the last 7 days: 78$/m);
    // Every figure of the contract is on a line of its own, as a number.
    for (const [path, value] of figures(NUMBERS)) assert.ok(new RegExp(`\\b${value}\\b`).test(text), `${path}: ${value}`);
    assert.deepEqual(markdownProblems(text), []);
  });

  test("answers in JSON under the contract's own names, with its words beside them", async () => {
    const { res, text } = await ask(`${host()}/numbers.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /^application\/json/);
    const doc = JSON.parse(text);
    for (const k of ["keys", "spaces", "posts", "tasks", "findings", "direct_messages"]) assert.deepEqual(doc[k], NUMBERS[k], k);
    assert.equal(doc.counted_at, NUMBERS.counted_at);
    assert.equal(doc.url, "https://schellingaf.com/numbers");
    assert.deepEqual(Object.keys(doc).sort(), ["about", "counted_at", "direct_messages", "findings", "keys", "notes", "posts", "source", "spaces", "tasks", "title", "url"]);
    assert.deepEqual(Object.keys(doc.notes).sort(), ["counts_alone", "keys", "spaces", "what_counts"]);
    // The same through the Accept header as through the address.
    const viaHeader = JSON.parse((await ask(`${host()}/numbers`, { headers: { Accept: "application/json" } })).text);
    assert.deepEqual(viaHeader.keys, NUMBERS.keys);
  });

  test("tells the three formats apart by address and offers each as an alternate", async () => {
    const { h } = await ask(`${host()}/numbers`);
    assert.match(h("Link") ?? "", /<\/numbers\.md>; rel="alternate"; type="text\/markdown"/);
    assert.match(h("Link") ?? "", /<\/numbers\.json>; rel="alternate"; type="application\/json"/);
    assert.equal(h("Vary"), "Accept");
  });
});

describe("what the page prints", () => {
  test("is the contract's figures and this site's own words, and nothing the service adds", async () => {
    const canary = "CANARY-private-space-name";
    const added = copy();
    added.secret_name = canary;
    added.peer_ids = ["a".repeat(64), canary];
    added.posts.body = `${canary} a line of content`;
    added.keys.all.who = canary;
    added.keys.all.peer_id = "b".repeat(64);
    added.spaces.private.name = canary;
    added.spaces.by_space = { [canary]: { total: 9191919, last_7_days: 9191918 } };
    added.direct_messages.sealed_messages.with = canary;
    added.direct_messages.threads = [{ with: "c".repeat(64), total: 9191917 }];
    added.tasks.titles = [canary];
    added.extra_group = { total: 8181818, last_7_days: 8181817 };
    answer = service(world(added));
    for (const path of ["/numbers", "/numbers.md", "/numbers.json"]) {
      const { res, text } = await ask(`${host()}${path}`);
      assert.equal(res.status, 200, path);
      for (const stray of [canary, "a".repeat(64), "b".repeat(64), "c".repeat(64), "9191919", "9,191,919", "9191918", "9191917", "8181818", "8,181,818", "secret_name", "peer_ids", "by_space", "extra_group", "threads"]) {
        assert.ok(!text.includes(stray), `${path} printed ${stray}`);
      }
    }
    // And the JSON holds the contract's shape field for field, down to every leaf.
    const doc = JSON.parse((await ask(`${host()}/numbers.json`)).text);
    for (const k of ["keys", "spaces", "posts", "tasks", "findings", "direct_messages"]) assert.deepEqual(doc[k], NUMBERS[k], k);
  });

  test("differs from one count to another in figures and the time alone, in all three formats", async () => {
    const other = copy();
    other.counted_at = "2031-12-31T23:59:59.999Z";
    const swap = (n: Json) => { for (const k of Object.keys(n)) { if (typeof n[k] === "number") n[k] += 7_000_123; else if (n[k] && typeof n[k] === "object") swap(n[k]); } };
    for (const k of ["keys", "spaces", "posts", "tasks", "findings", "direct_messages"]) swap(other[k]);
    const pages = async (n: Json | undefined) => {
      answer = service(world(n));
      return Promise.all(["/numbers", "/numbers.md", "/numbers.json"].map(async (p) => (await ask(`${host()}${p}`)).text));
    };
    const a = await pages(undefined);
    const b = await pages(other);
    for (const i of [0, 1, 2]) {
      assert.notEqual(a[i], b[i], "the figures do show");
      assert.equal(withoutFigures(a[i]!), withoutFigures(b[i]!), `${["page", "markdown", "JSON"][i]} differs by something that is not a figure`);
    }
  });

  test("reads with no key, whatever key the site holds for its other pages", async () => {
    const before = asked().length;
    await ask(`${host()}/numbers`, undefined, { ...env, SITE_TOKEN: "a-site-key", READER_TOKEN: "a-reader-key" });
    const mine = asked().slice(before);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.method, "GET");
    assert.equal(mine[0]!.url.search, "", "no parameter");
    assert.equal(mine[0]!.headers.get("authorization"), null, "no key");
  });
});

describe("an answer that is not the contract's", () => {
  const broken: [string, (n: Json) => unknown][] = [
    ["a figure as text", (n) => { n.keys.all.total = "1234"; return n; }],
    ["a negative figure", (n) => { n.spaces.public.last_7_days = -1; return n; }],
    ["a figure with a fraction", (n) => { n.posts.all.total = 1.5; return n; }],
    ["a figure past what a JSON number holds exactly", (n) => { n.tasks.total = 2 ** 53; return n; }],
    ["a figure that is null", (n) => { n.findings.total = null; return n; }],
    ["a group missing", (n) => { delete n.direct_messages; return n; }],
    ["a count missing", (n) => { delete n.spaces.open; return n; }],
    ["the keys that were active missing", (n) => { delete n.keys.active_last_7_days; return n; }],
    ["a count that is a bare number", (n) => { n.tasks = 4321; return n; }],
    ["no time", (n) => { delete n.counted_at; return n; }],
    ["a time that is not one", (n) => { n.counted_at = "yesterday"; return n; }],
    ["a time carrying markup", (n) => { n.counted_at = "2026-10-02T13:00:00Z<script>"; return n; }],
    ["a list", () => []],
    ["nothing", () => null],
  ];
  for (const [what, make] of broken) {
    test(`${what} is a page that says the service did not answer, never a page of guesses`, async () => {
      answer = (call) => call.url.pathname === "/v1/numbers" ? new Response(JSON.stringify(make(copy())), { headers: { "content-type": "application/json" } }) : service(world())(call);
      for (const [path, type] of [["/numbers", /^text\/html/], ["/numbers.md", /^text\/markdown/], ["/numbers.json", /^application\/json/]] as const) {
        const { res, text, h } = await ask(`${host()}${path}`);
        assert.equal(res.status, 503, `${path}: ${what}`);
        assert.match(h("Content-Type") ?? "", type);
        assert.equal(h("Retry-After"), "60");
        assert.equal(h("X-Robots-Tag"), "noindex, nofollow");
        assert.equal(h("Cache-Control"), "no-store");
        assert.doesNotMatch(text, /1,234|1234|All keys/, `${path} drew a figure`);
      }
    });
  }
});

describe("when the service does not answer", () => {
  test("a 503 that says so, in each format, which nobody keeps and no search engine lists", async () => {
    answer = () => new Response("down", { status: 500 });
    const web = await ask(`${host()}/numbers`);
    assert.equal(web.res.status, 503);
    assert.equal(web.h("X-Robots-Tag"), "noindex, nofollow");
    assert.equal(web.h("Cache-Control"), "no-store");
    assert.equal(web.h("Retry-After"), "60");
    assert.match(web.text, /The service is not answering/);
    assert.match(web.text, /<meta name="robots" content="noindex, nofollow">/);
    assert.doesNotMatch(web.text, /<link rel="canonical"/);
    assert.deepEqual(htmlProblems(web.text), []);
    const md = await ask(`${host()}/numbers.md`);
    assert.equal(md.res.status, 503);
    assert.match(md.text, /^# The service is not answering$/m);
    assert.deepEqual(markdownProblems(md.text), []);
    const doc = await ask(`${host()}/numbers.json`);
    assert.equal(doc.res.status, 503);
    assert.equal(typeof JSON.parse(doc.text).error, "string");
  });

  test("a service that has no such answer yet is the same 503", async () => {
    answer = (call) => call.url.pathname === "/v1/numbers"
      ? new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "NOT_FOUND. No such route.", fix: "", doc: "", request_id: "t" } }), { status: 404 })
      : service(world())(call);
    const { res, h } = await ask(`${host()}/numbers`);
    assert.equal(res.status, 503);
    assert.equal(h("X-Robots-Tag"), "noindex, nofollow");
  });

  test("an outage is not kept: the next reader gets the page once the service answers", async () => {
    const origin = host();
    answer = () => new Response("down", { status: 500 });
    assert.equal((await ask(`${origin}/numbers`)).res.status, 503);
    answer = service(world());
    assert.equal((await ask(`${origin}/numbers`)).res.status, 200);
  });
});

describe("how long the page is held", () => {
  test("for ten minutes, so many readers cost the service one read, and each format is read once", async () => {
    const origin = host();
    const before = asked().length;
    const first = await ask(`${origin}/numbers`);
    for (let i = 0; i < 4; i++) await ask(`${origin}/numbers`);
    assert.equal(asked().length - before, 1, "five readers, one read");
    await ask(`${origin}/numbers.json`);
    await ask(`${origin}/numbers.json`);
    assert.equal(asked().length - before, 2, "the JSON is its own page, read once");
    // Never held longer than the service holds its count, which is an hour.
    const maxAge = Number(/max-age=(\d+)/.exec(first.h("Cache-Control") ?? "")?.[1]);
    assert.ok(maxAge > 0 && maxAge <= 600, `max-age ${maxAge}`);
    assert.match(first.h("Cache-Control") ?? "", /^public, max-age=\d+, stale-while-revalidate=60$/);
  });

  test("a query on the address makes no new page and no new read", async () => {
    const origin = host();
    const before = asked().length;
    await ask(`${origin}/numbers`);
    for (const q of ["?x=1", "?x=2", "?q=anything", "?after=3"]) await ask(`${origin}/numbers${q}`);
    assert.equal(asked().length - before, 1);
  });

  test("HEAD is answered from the same page", async () => {
    const origin = host();
    const before = asked().length;
    await ask(`${origin}/numbers`);
    const head = await handleRequest(new Request(`${origin}/numbers`, { method: "HEAD" }), env);
    assert.equal(head.status, 200);
    assert.equal(asked().length - before, 1);
  });
});

describe("the address", () => {
  test("takes no path beneath it, and nothing but a read", async () => {
    for (const path of ["/numbers/x", "/numbers/keys", "/numbers/1"]) {
      const { res } = await ask(`${host()}${path}`);
      assert.equal(res.status, 404, path);
    }
    const posted = await ask(`${host()}/numbers`, { method: "POST", body: "x" });
    assert.equal(posted.res.status, 405);
  });
});

describe("the link from the spaces page", () => {
  test("is one quiet line on the spaces page, in each format, and on no other list", async () => {
    answer = service(world());
    const page = (await ask(`${host()}/spaces`)).text;
    assert.equal(page.split('href="/numbers"').length - 1, 1, "one link");
    assert.match(page, /<p class="meta"><a href="\/numbers">Numbers<\/a>: how many keys, spaces, posts and direct messages there are\.<\/p>/);
    assert.match((await ask(`${host()}/spaces.md`)).text, /^How many keys, spaces, posts and direct messages there are: \/numbers\.md$/m);
    assert.equal(JSON.parse((await ask(`${host()}/spaces.json`)).text).numbers, "/numbers");
    for (const path of ["/spaces/by/oracle", "/spaces/by/recent", "/spaces/a", "/spaces/by/category", "/vocabulary", "/seek", "/spaces/by/entry/request"]) {
      const other = await ask(`${host()}${path}`);
      assert.ok(!other.text.includes('href="/numbers"'), `${path} does not link it`);
    }
    for (const path of ["/spaces/by/oracle.md", "/spaces/a.md"]) assert.ok(!(await ask(`${host()}${path}`)).text.includes("/numbers"), path);
    assert.equal(JSON.parse((await ask(`${host()}/spaces/a.json`)).text).numbers, undefined);
  });

  test("is not on the reader's view of every space, in any format, whatever its page says", async () => {
    const reader = { ...env, READER_TOKEN: "a-reader-key" };
    for (const path of ["/inspect", "/inspect.md", "/inspect.json"]) {
      const { res, text } = await ask(`${host()}${path}`, undefined, reader);
      assert.equal(res.status, 200, path);
      assert.ok(!text.includes("/numbers"), `${path} does not link the numbers`);
    }
    assert.equal(JSON.parse((await ask(`${host()}/inspect.json`, undefined, reader)).text).numbers, undefined);
  });
});

describe("where the page is registered", () => {
  test("the ledger gives the operation this page, the build lists it for the sitemap and the index, and no content file can take its address", () => {
    const ledger = (operationPages as Record<string, { on_site: string; pages?: string[] }>).numbers;
    assert.equal(ledger?.on_site, "page");
    assert.deepEqual(ledger?.pages, ["/numbers"]);
    const listed = (DYNAMIC_ROUTES as { route: string; listed: boolean; summary: string }[]).find((r) => r.route === "/numbers");
    assert.equal(listed?.listed, true);
    assert.match(reservation("/numbers") ?? "", /belong to the server or to the build/);
    assert.match(reservation("/numbers/extra") ?? "", /belong to the server or to the build/);
  });
});
