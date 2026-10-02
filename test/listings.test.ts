// The two kinds of space, each its own list:
// the work spaces at /spaces, with their letters, their ways in, their search and their
// newest first, and the oracle spaces at /spaces/by/oracle, with their own search and
// their own newest first. A switch at the top of each goes to the other. Every listing
// address answers in all three formats.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { service } from "./lib/service.ts";
import { hostileWorld } from "./lib/world.ts";
import { htmlProblems, markdownProblems } from "./lib/documents.ts";
import { env, site } from "./lib/site.ts";

const { fake, handleRequest } = await site(service(hostileWorld()));

let hosts = 0;
const host = () => `https://b${++hosts}.localhost`;
const lists = () => fake.calls.filter((c) => c.url.pathname === "/v1/spaces");

async function ask(url: string) {
  const res = await handleRequest(new Request(url), env);
  return { res, text: await res.text(), h: (n: string) => res.headers.get(n) };
}

type Row = { name: string; oracle?: boolean };
const names = (text: string): string[] => (JSON.parse(text).items as Row[]).map((s) => s.name);

describe("the work spaces", () => {
  test("every listing of them asks the service for work spaces alone, and shows no oracle space", async () => {
    for (const path of ["/spaces", "/spaces/h", "/spaces/by/entry/request", "/spaces/by/entry/invite", "/spaces/by/recent"]) {
      const { res, text } = await ask(`${host()}${path}.json`);
      assert.equal(res.status, 200, `${path}: ${text.slice(0, 200)}`);
      assert.equal(lists().at(-1)?.url.searchParams.get("oracle"), "false", path);
      assert.ok(!names(text).includes("hostile-oracle"), `${path} lists an oracle space`);
      assert.equal(JSON.parse(text).shows, "work spaces", path);
    }
  });

  test("a search of them is kept to work spaces", async () => {
    const { text } = await ask(`${host()}/spaces.json?q=hostile`);
    assert.equal(lists().at(-1)?.url.searchParams.get("oracle"), "false");
    assert.equal(lists().at(-1)?.url.searchParams.get("q"), "hostile");
    assert.ok(names(text).length > 0 && !names(text).includes("hostile-oracle"));
  });

  test("the page says what a work space is, and each row says it is one and how it takes members", async () => {
    const { text } = await ask(`${host()}/spaces`);
    assert.deepEqual(htmlProblems(text), []);
    assert.match(text, /<h1>Work spaces<\/h1>\n<p class="lead">A work space is a conversation of posts/);
    assert.match(text, /<span class="tag">work space<\/span><span class="tag">(ask to join|invite link only)<\/span>/);
    assert.doesNotMatch(text, /<span class="tag on">oracle space<\/span>/);
    assert.match(text, /<button type="submit">Find a work space<\/button>/);
  });

  test("its views are the oracle spaces' three, and how to join is a row of its own, and never the oracle spaces", async () => {
    const { text } = await ask(`${host()}/spaces`);
    const strip = text.slice(text.indexOf('<nav class="strip"'), text.indexOf("</nav>", text.indexOf('<nav class="strip"')));
    assert.match(strip, /aria-label="Browse work spaces"/);
    const rows = strip.split("\n").filter((l) => l.startsWith('<p class="tags">'));
    // The views first, the same three as the oracle spaces', by name lit on the directory.
    assert.equal(rows[0], '<p class="tags"><span class="tag on" aria-current="page">by name</span><a class="tag" href="/spaces/by/category">by category</a><a class="tag" href="/spaces/by/recent">newest first</a></p>');
    // Then how to join, labelled, and nothing else in its row.
    assert.equal(rows[1], '<p class="tags"><span class="meta">How to join:</span> <a class="tag" href="/spaces/by/entry/invite">invite link only</a><a class="tag" href="/spaces/by/entry/request">ask to join</a></p>');
    // Then the letters.
    assert.match(rows[2]!, /^<p class="tags"><a class="tag" href="\/spaces\/0">0<\/a>/);
    assert.doesNotMatch(strip, /by\/oracle/, "the oracle spaces are the switch, not a filter");
    const facet = (await ask(`${host()}/spaces/by/entry/invite`)).text;
    assert.match(facet, /<span class="tag on" aria-current="page">invite link only<\/span>/);
    assert.match(facet, /<a class="tag" href="\/spaces">by name<\/a>/);
    const search = (await ask(`${host()}/spaces?q=hostile`)).text;
    assert.doesNotMatch(search, /<span class="tag on" aria-current="page">by name<\/span>/, "a search lights no filter");
    // The oracle spaces' views are the same three, pointing at their own list.
    const oracle = (await ask(`${host()}/spaces/by/oracle`)).text;
    assert.match(oracle, /<p class="tags"><span class="tag on" aria-current="page">by name<\/span><a class="tag" href="\/spaces\/by\/category">by category<\/a><a class="tag" href="\/spaces\/by\/oracle\/recent">newest first<\/a><\/p>/);
    assert.doesNotMatch(oracle, /How to join:/);
  });

  test("newest first asks for the service's newest-first order and walks its cursor", async () => {
    const at = host();
    const { res, text } = await ask(`${at}/spaces/by/recent.json`);
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.equal(lists().at(-1)?.url.searchParams.get("order"), "recent");
    const doc = JSON.parse(text);
    assert.equal(doc.order, "recent");
    assert.ok("next_before" in doc && !("next_after" in doc));
    const before = "1757851200000000~hostile-public";
    await ask(`${at}/spaces/by/recent.json?before=${encodeURIComponent(before)}`);
    assert.equal(lists().at(-1)?.url.searchParams.get("before"), before);
  });

  test("newest first drops a cursor in any other shape, and is the same page as none", async () => {
    const at = host();
    await ask(`${at}/spaces/by/recent`);
    const n = lists().length;
    const { res } = await ask(`${at}/spaces/by/recent?before=${encodeURIComponent("<script>")}`);
    assert.equal(res.status, 200);
    assert.equal(lists().length, n, "answered from the page already held");
  });

  test("newest first's markdown keeps what the service wrote out of the structure", async () => {
    const { text } = await ask(`${host()}/spaces/by/recent.md`);
    assert.deepEqual(markdownProblems(text), []);
  });

  test("its categories count work spaces alone, and the oracle spaces' categories oracle spaces alone", async () => {
    // general holds hostile-public and hostile-content, work spaces, and hostile-oracle.
    const work = await ask(`${host()}/spaces`);
    assert.match(work.text, /A category holds the work spaces filed under it and under every category inside it\./);
    assert.doesNotMatch(work.text, /takes in its oracle spaces/);
    assert.match(work.text, /<a class="tag" href="\/spaces\/by\/category\/general">General &middot; 2<\/a>/);
    const oracle = await ask(`${host()}/spaces/by/oracle`);
    assert.match(oracle.text, /A category holds the oracle spaces filed under it and under every category inside it\./);
    assert.match(oracle.text, /<a class="tag" href="\/spaces\/by\/category\/general#oracle-spaces">General &middot; 1<\/a>/);
    assert.doesNotMatch(oracle.text, /artificial-intelligence/, "a category holding no oracle space is not offered");
    const md = (await ask(`${host()}/spaces/by/oracle.md`)).text;
    assert.match(md, /^- general \(General\): 1 oracle space, \/spaces\/by\/category\/general\.md$/m);
    const doc = JSON.parse((await ask(`${host()}/spaces/by/oracle.json`)).text);
    assert.equal(doc.categories_count, "A category holds the oracle spaces filed under it and under every category inside it.");
    // A search of the oracle spaces, and their newest first, offer no categories.
    assert.equal(JSON.parse((await ask(`${host()}/spaces/by/oracle.json?q=hostile`)).text).categories, undefined);
    assert.equal(JSON.parse((await ask(`${host()}/spaces/by/oracle/recent.json`)).text).categories, undefined);
  });
});

describe("the oracle spaces", () => {
  test("asks the service for oracle spaces alone, and lists only them", async () => {
    const { res, text } = await ask(`${host()}/spaces/by/oracle.json`);
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.equal(lists().at(-1)?.url.searchParams.get("oracle"), "true");
    const doc = JSON.parse(text);
    assert.deepEqual(names(text), ["hostile-oracle"]);
    assert.equal(doc.listing, "oracles");
    assert.equal(doc.shows, "oracle spaces");
    assert.equal(doc.browse.newest_first, "/spaces/by/oracle/recent");
  });

  test("is listed, as the one enumeration of its kind, and held ten minutes", async () => {
    const { h, text } = await ask(`${host()}/spaces/by/oracle`);
    assert.equal(h("X-Robots-Tag"), "index, follow, max-snippet:-1");
    assert.equal(h("Cache-Control"), "public, max-age=600, stale-while-revalidate=60");
    assert.match(h("Link") ?? "", /rel="canonical"/);
    assert.deepEqual(htmlProblems(text), []);
    assert.match(text, /<h1>Oracle spaces<\/h1>\n<p class="lead">An oracle space is one public document\./);
    assert.match(text, /<span class="tag on" aria-current="page">by name<\/span>/);
  });

  test("has no letters and no ways in, since any key proposes without joining", async () => {
    const { text } = await ask(`${host()}/spaces/by/oracle`);
    assert.doesNotMatch(text, /href="\/spaces\/by\/entry\//);
    assert.doesNotMatch(text, /<a class="tag" href="\/spaces\/a">/);
    assert.match(text, /<a class="tag" href="\/spaces\/by\/category">by category<\/a>/);
    assert.match(text, /<a class="tag" href="\/spaces\/by\/oracle\/recent">newest first<\/a>/);
  });

  test("searches oracle spaces alone, from its own box, and a search is not listed", async () => {
    const page = await ask(`${host()}/spaces/by/oracle`);
    assert.match(page.text, /<form method="get" action="\/spaces\/by\/oracle">/);
    assert.match(page.text, /<button type="submit">Find an oracle space<\/button>/);
    const { h, text } = await ask(`${host()}/spaces/by/oracle.json?q=hostile`);
    assert.equal(lists().at(-1)?.url.searchParams.get("oracle"), "true");
    assert.equal(lists().at(-1)?.url.searchParams.get("q"), "hostile");
    assert.deepEqual(names(text), ["hostile-oracle"]);
    assert.equal(h("X-Robots-Tag"), "noindex, follow");
    const md = await ask(`${host()}/spaces/by/oracle.md?q=${encodeURIComponent("[x](https://e.example) <b>")}`);
    assert.deepEqual(markdownProblems(md.text), []);
    assert.match(md.text, /^# Oracle spaces matching your search$/m);
  });

  test("a search of them is its own page, and a parameter it does not read is not", async () => {
    const at = host();
    await ask(`${at}/spaces/by/oracle`);
    const n = lists().length;
    await ask(`${at}/spaces/by/oracle?x=1&q=%20`);
    assert.equal(lists().length, n, "a blank search and an unread parameter are the page already held");
    await ask(`${at}/spaces/by/oracle?q=runner`);
    await ask(`${at}/spaces/by/oracle?q=hostile`);
    assert.equal(lists().length, n + 2, "each search is read once");
  });

  test("newest first asks for oracle spaces in the service's newest-first order, and is not listed", async () => {
    const { h, text } = await ask(`${host()}/spaces/by/oracle/recent.json`);
    const call = lists().at(-1)!.url.searchParams;
    assert.equal(call.get("oracle"), "true");
    assert.equal(call.get("order"), "recent");
    assert.deepEqual(names(text), ["hostile-oracle"]);
    assert.ok("next_before" in JSON.parse(text));
    assert.equal(h("X-Robots-Tag"), "noindex, follow");
  });
});

describe("the switch between the two", () => {
  test("is on every listing of either kind, above its filters, with the page's own kind lit", async () => {
    const work = ["/spaces", "/spaces/k", "/spaces/by/entry/invite", "/spaces/by/recent", "/spaces?q=hostile"];
    const oracle = ["/spaces/by/oracle", "/spaces/by/oracle/recent", "/spaces/by/oracle?q=hostile"];
    for (const path of [...work, ...oracle]) {
      const { text } = await ask(`${host()}${path}`);
      const at = text.indexOf('<nav class="switch" aria-label="Which kind of space">');
      assert.ok(at > 0, `${path} has no switch`);
      assert.ok(at < text.indexOf("<h1>"), `${path}: the switch comes before the heading`);
      const lit = work.includes(path) ? "Work spaces" : "Oracle spaces";
      const other = work.includes(path) ? ["/spaces/by/oracle", "Oracle spaces"] : ["/spaces", "Work spaces"];
      assert.ok(text.includes(`aria-current="page">${lit}</a>`), `${path} lights ${lit}`);
      assert.ok(text.includes(`<a href="${other[0]}">${other[1]}</a>`), `${path} links ${other[1]}`);
    }
  });

  test("the markdown and JSON of each name the other", async () => {
    assert.match((await ask(`${host()}/spaces.md`)).text, /^Work spaces\. The oracle spaces are listed apart: \/spaces\/by\/oracle\.md$/m);
    assert.match((await ask(`${host()}/spaces/by/oracle.md`)).text, /^Oracle spaces\. The work spaces are listed apart: \/spaces\.md$/m);
    for (const path of ["/spaces.json", "/spaces/by/oracle.json"]) {
      const doc = JSON.parse((await ask(`${host()}${path}`)).text);
      assert.deepEqual(doc.kinds_of_space, { work_spaces: "/spaces", oracle_spaces: "/spaces/by/oracle" }, path);
    }
  });

  test("the reader's own view has neither the switch nor any browse address", async () => {
    for (const path of ["/inspect/by/oracle", "/inspect/by/recent", "/inspect/by/oracle/recent"]) {
      assert.equal((await ask(`${host()}${path}`)).res.status, 404, path);
    }
  });
});

describe("every listing address", () => {
  test("still answers, in all three formats", async () => {
    const old = ["/spaces", "/spaces/h", "/spaces/0", "/spaces/by/entry/invite", "/spaces/by/entry/request", "/spaces/by/recent",
      "/spaces/by/oracle", "/spaces/by/category", "/spaces/by/category/general", "/spaces/hostile-oracle", "/spaces/hostile-public"];
    for (const path of old) {
      for (const f of ["", ".md", ".json"]) {
        const { res } = await ask(`${host()}${path}${f}`);
        assert.equal(res.status, 200, `${path}${f}`);
      }
    }
    assert.equal((await ask(`${host()}/spaces/by`)).res.status, 301);
  });

  test("a category's page still lists both kinds, each under its own heading", async () => {
    const { text } = await ask(`${host()}/spaces/by/category/general`);
    assert.match(text, /<h3 class="group" id="work-spaces">Work spaces<\/h3>/);
    assert.match(text, /<h3 class="group" id="oracle-spaces">Oracle spaces<\/h3>/);
    const md = (await ask(`${host()}/spaces/by/category/general.md`)).text;
    assert.match(md, /^### Work spaces$/m);
    assert.deepEqual(markdownProblems(md), []);
  });

  test("a category's page, and every category, say how many of each kind a category holds", async () => {
    const { text } = await ask(`${host()}/spaces/by/category/general`);
    assert.match(text, /3 spaces filed here or in a category inside it: 2 work spaces, 1 oracle space\./);
    // hostile-words, inside general, holds a work space and no oracle space: the kind with none is not named.
    assert.match(text, /<li><a href="\/spaces\/by\/category\/hostile-words">[^<]*<\/a> <span class="meta">1 work space<\/span><\/li>/);
    const md = (await ask(`${host()}/spaces/by/category/general.md`)).text;
    assert.match(md, /^- spaces: 3\n- work_spaces: 2\n- oracle_spaces: 1$/m);
    const doc = JSON.parse((await ask(`${host()}/spaces/by/category/general.json`)).text);
    assert.deepEqual([doc.category.spaces, doc.category.work_spaces, doc.category.oracle_spaces], [3, 2, 1]);
    const every = await ask(`${host()}/spaces/by/category`);
    assert.match(every.text, /<a href="\/spaces\/by\/category\/general">General<\/a> <span class="meta">2 work spaces, 1 oracle space<\/span>/);
    const list = JSON.parse((await ask(`${host()}/spaces/by/category.json`)).text);
    const general = list.categories.find((c: { id: string }) => c.id === "general");
    assert.deepEqual([general.spaces, general.work_spaces, general.oracle_spaces], [3, 2, 1]);
  });
});
