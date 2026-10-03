// Finished spaces: every list of spaces leaves out the spaces whose stage the service calls
// finished (merged, declined, done, closed), asks for that with finished=false, and offers one
// plain link that shows them and, there, one that hides them again. Each space shows its
// stage word when it has one. The stand-in service honours `finished` as the product does.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { service } from "./lib/service.ts";
import { hostileWorld, OWNER } from "./lib/world.ts";
import { htmlProblems, markdownProblems } from "./lib/documents.ts";
import { env, site } from "./lib/site.ts";

const stage = (word: string) => ({ word, note: null, post_id: "0199dddd-0000-7000-8000-000000000001", set_by: OWNER, set_at: "2026-10-02T12:00:00.000Z" });
const space = (name: string, fields: Record<string, unknown> = {}) => ({
  name, space_id: `0199eeee-0000-7000-8000-${String(name.length).padStart(12, "0")}`,
  title: `Title of ${name}`, description: `About ${name}.`, visibility: "public", join_policy: "request",
  status: "active", signed_only: false, replaced_by: null, categories: ["general"], owner: OWNER,
  contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-10-01T12:00:00.000Z", ...fields,
});

const world = hostileWorld();
// A category whose one space is finished, one with none, and a letter whose one space is finished.
const category = (id: string, label: string) => ({ id, label, parent: "general", depth: 2, status: "active", children: 0,
  description: "", elsewhere: "", examples: [], aliases: [] });
world.categories!.push(category("finished-only", "Finished only"), category("nothing-filed", "Nothing filed"));
world.spaces.push(
  space("zipped-up", { stage: stage("done"), categories: ["finished-only"] }),
  space("wrapped-up", { stage: stage("merged") }),
  space("wip-under-way", { stage: stage("in-progress") }),
  space("oracle-wrapped", { oracle: true, stage: stage("declined") }),
  space("wodd-stage", { stage: { word: "<script>alert(1)</script>", set_by: OWNER } }),
);

const { fake, handleRequest } = await site(service(world));

let hosts = 0;
const host = () => `https://f${++hosts}.localhost`;
const lists = () => fake.calls.filter((c) => c.url.pathname === "/v1/spaces");
async function ask(url: string) {
  const res = await handleRequest(new Request(url), env);
  return { res, text: await res.text(), h: (n: string) => res.headers.get(n) };
}
const names = (text: string): string[] => (JSON.parse(text).items as { name: string }[]).map((s) => s.name);

describe("a list of spaces leaves finished ones out", () => {
  test("by default it asks for finished=false and a merged space is not listed", async () => {
    const { res, text } = await ask(`${host()}/spaces.json`);
    assert.equal(res.status, 200);
    assert.equal(lists().at(-1)?.url.searchParams.get("finished"), "false");
    assert.ok(!names(text).includes("wrapped-up"));
    assert.ok(names(text).includes("wip-under-way"), "a space at another stage stays");
    assert.ok(names(text).includes("hostile-public"), "a space with no stage stays");
  });

  test("?finished=all sends no finished filter and lists the merged space", async () => {
    const { text } = await ask(`${host()}/spaces.json?finished=all`);
    assert.equal(lists().at(-1)?.url.searchParams.get("finished"), null);
    assert.ok(names(text).includes("wrapped-up"));
  });

  test("any other value of the parameter is the default view", async () => {
    const { text } = await ask(`${host()}/spaces.json?finished=true`);
    assert.equal(lists().at(-1)?.url.searchParams.get("finished"), "false");
    assert.ok(!names(text).includes("wrapped-up"));
  });

  test("every list of spaces does the same: letters, ways in, newest first, the oracle spaces and a category", async () => {
    for (const path of ["/spaces/w", "/spaces/by/entry/request", "/spaces/by/recent", "/spaces/by/oracle", "/spaces/by/oracle/recent", "/spaces/by/category/general"]) {
      const hidden = await ask(`${host()}${path}.json`);
      assert.equal(hidden.res.status, 200, path);
      assert.equal(lists().at(-1)?.url.searchParams.get("finished"), "false", path);
      assert.ok(!names(hidden.text).some((n) => n === "wrapped-up" || n === "oracle-wrapped"), `${path} lists a finished space`);
      const shown = await ask(`${host()}${path}.json?finished=all`);
      assert.equal(lists().at(-1)?.url.searchParams.get("finished"), null, path);
      assert.ok(names(shown.text).some((n) => n === "wrapped-up" || n === "oracle-wrapped"), `${path}?finished=all lists none`);
    }
  });

  test("a search is kept to unfinished spaces too, and the sitemap and the proposals page still list every space", async () => {
    await ask(`${host()}/spaces.json?q=about`);
    assert.equal(lists().at(-1)?.url.searchParams.get("finished"), "false");
    await ask(`${host()}/sitemap-spaces-w.xml`);
    assert.equal(lists().at(-1)?.url.searchParams.get("finished"), null);
    await ask(`${host()}/proposals.json`);
    assert.equal(lists().at(-1)?.url.searchParams.get("finished"), null);
  });
});

describe("the link", () => {
  const link = (text: string, words: string): string | undefined =>
    text.match(new RegExp(`<a href="([^"]*)">${words}</a>`))?.[1];

  test("the page says finished spaces are not listed and links to the view that shows them", async () => {
    const { text } = await ask(`${host()}/spaces`);
    assert.deepEqual(htmlProblems(text), []);
    assert.match(text, /<p class="meta">Finished spaces are not listed\. <a href="\/spaces\?finished=all">Show finished spaces<\/a><\/p>/);
    assert.equal(link(text, "Hide finished spaces"), undefined);
  });

  test("on that view the link reads Hide finished spaces and goes back", async () => {
    const { text } = await ask(`${host()}/spaces?finished=all`);
    assert.deepEqual(htmlProblems(text), []);
    assert.match(text, /Finished spaces are listed\. <a href="\/spaces">Hide finished spaces<\/a>/);
    assert.equal(link(text, "Show finished spaces"), undefined);
  });

  test("both links keep the search, the cursor, the letter and the category", async () => {
    let { text } = await ask(`${host()}/spaces?q=about&after=alpha-one`);
    assert.equal(link(text, "Show finished spaces"), "/spaces?q=about&amp;after=alpha-one&amp;finished=all");
    ({ text } = await ask(`${host()}/spaces?q=about&after=alpha-one&finished=all`));
    assert.equal(link(text, "Hide finished spaces"), "/spaces?q=about&amp;after=alpha-one");
    ({ text } = await ask(`${host()}/spaces/h?after=hostile-content`));
    assert.equal(link(text, "Show finished spaces"), "/spaces/h?after=hostile-content&amp;finished=all");
    ({ text } = await ask(`${host()}/spaces/by/recent?finished=all&before=1~x`));
    assert.equal(link(text, "Hide finished spaces"), "/spaces/by/recent", "a cursor that is not the service's shape is dropped, as it always was");
    ({ text } = await ask(`${host()}/spaces/by/category/general?before=1790856000000000~wrapped-up`));
    assert.equal(link(text, "Show finished spaces"), "/spaces/by/category/general?before=1790856000000000%7Ewrapped-up&amp;finished=all");
    ({ text } = await ask(`${host()}/spaces/by/category/general?before=1790856000000000~wrapped-up&finished=all`));
    assert.equal(link(text, "Hide finished spaces"), "/spaces/by/category/general?before=1790856000000000%7Ewrapped-up");
    ({ text } = await ask(`${host()}/spaces/by/oracle?q=about&finished=all`));
    assert.equal(link(text, "Hide finished spaces"), "/spaces/by/oracle?q=about");
  });

  test("the markdown and the JSON say the same, with the other view's address", async () => {
    let r = await ask(`${host()}/spaces.md?q=about`);
    assert.deepEqual(markdownProblems(r.text), []);
    assert.match(r.text, /Finished spaces are not listed\. Show them: \/spaces\.md\?q=about&finished=all/);
    r = await ask(`${host()}/spaces.md?q=about&finished=all`);
    assert.match(r.text, /Finished spaces are listed\. Hide them: \/spaces\.md\?q=about\n/);
    r = await ask(`${host()}/spaces.json?q=about`);
    assert.deepEqual(JSON.parse(r.text).finished_spaces, { shown: false, show: "/spaces.json?q=about&finished=all" });
    r = await ask(`${host()}/spaces.json?finished=all`);
    assert.deepEqual(JSON.parse(r.text).finished_spaces, { shown: true, hide: "/spaces.json" });
  });

  test("the view with finished spaces is followed, not listed, and carries no canonical", async () => {
    const plain = await ask(`${host()}/spaces`);
    assert.match(plain.h("X-Robots-Tag") ?? "", /index, follow/);
    assert.match(plain.h("Link") ?? "", /<https:\/\/schellingaf\.com\/spaces>; rel="canonical"/, "the default view names itself canonical");
    const all = await ask(`${host()}/spaces?finished=all`);
    assert.match(all.h("X-Robots-Tag") ?? "", /^noindex, follow/);
    assert.match(all.text, /<meta name="robots" content="noindex, follow">/);
    assert.doesNotMatch(all.h("Link") ?? "", /rel="canonical"/);
    assert.doesNotMatch(all.text, /<link rel="canonical"/);
  });
});

describe("a list left empty by its finished spaces", () => {
  test("a category whose spaces are all finished says so, keeps the link and stays listed, as its sitemap lists it", async () => {
    const page = await ask(`${host()}/spaces/by/category/finished-only`);
    assert.equal(page.res.status, 200);
    assert.deepEqual(htmlProblems(page.text), []);
    assert.match(page.text, /<p>Every space filed here is finished\.<\/p>/);
    assert.doesNotMatch(page.text, /No space is filed here yet/);
    assert.match(page.text, /<a href="\/spaces\/by\/category\/finished-only\?finished=all">Show finished spaces<\/a>/);
    assert.match(page.h("X-Robots-Tag") ?? "", /^index, follow/);
    const md = await ask(`${host()}/spaces/by/category/finished-only.md`);
    assert.match(md.text, /^Every space filed here is finished\.$/m);
    const sitemap = await ask(`${host()}/sitemap-categories.xml`);
    assert.match(sitemap.text, /<loc>https:\/\/schellingaf\.com\/spaces\/by\/category\/finished-only<\/loc>/);
    const all = await ask(`${host()}/spaces/by/category/finished-only?finished=all`);
    assert.match(all.text, /<code>zipped-up<\/code>/);
    assert.match(all.h("X-Robots-Tag") ?? "", /^noindex, follow/);
  });

  test("a category holding no space at all still says none is filed there, and is not listed", async () => {
    const page = await ask(`${host()}/spaces/by/category/nothing-filed`);
    assert.match(page.text, /<p>No space is filed here yet\.<\/p>/);
    assert.match(page.h("X-Robots-Tag") ?? "", /^noindex/);
  });

  test("a letter empty in the default view says only that no unfinished space is there", async () => {
    const page = await ask(`${host()}/spaces/z`);
    assert.deepEqual(htmlProblems(page.text), []);
    assert.match(page.text, /<p>No unfinished work space has a name beginning with z\.<\/p>/);
    assert.match(page.text, /Show finished spaces<\/a>/);
    const all = await ask(`${host()}/spaces/z?finished=all`);
    assert.match(all.text, /<code>zipped-up<\/code>/);
    const none = await ask(`${host()}/spaces/q?finished=all`);
    assert.match(none.text, /<p>No work space has a name beginning with q yet\.<\/p>/);
  });
});

describe("the stage a space shows", () => {
  test("a list shows the stage word as a tag beside the others, and a space with none shows none", async () => {
    const { text } = await ask(`${host()}/spaces?finished=all`);
    assert.match(text, /<code>wrapped-up<\/code> &middot; <span class="tag">work space<\/span><span class="tag">public<\/span><span class="tag">ask to join<\/span><span class="tag">merged<\/span>created /);
    assert.match(text, /<span class="tag">in-progress<\/span>created /);
    const row = text.slice(text.indexOf("<code>hostile-public</code>"), text.indexOf("created", text.indexOf("<code>hostile-public</code>")));
    assert.doesNotMatch(row, /merged|in-progress|declined/);
  });

  test("an oracle space shows its stage too", async () => {
    const { text } = await ask(`${host()}/spaces/by/oracle?finished=all`);
    assert.match(text, /<span class="tag on">oracle space<\/span><span class="tag">declined<\/span>created /);
  });

  test("the markdown and the JSON carry it, with whether it is finished", async () => {
    const md = await ask(`${host()}/spaces.md?finished=all`);
    assert.match(md.text, /^- stage: merged \(finished: true\)$/m);
    assert.match(md.text, /^- stage: in-progress \(finished: false\)$/m);
    const json = await ask(`${host()}/spaces.json?finished=all`);
    const items = JSON.parse(json.text).items as { name: string; stage?: unknown }[];
    assert.deepEqual(items.find((s) => s.name === "wrapped-up")?.stage, { word: "merged", finished: true });
    assert.deepEqual(items.find((s) => s.name === "wip-under-way")?.stage, { word: "in-progress", finished: false });
    assert.equal(items.find((s) => s.name === "hostile-public")?.stage, undefined);
  });

  test("a stage word in any shape but the service's is not shown", async () => {
    const { text } = await ask(`${host()}/spaces/w?finished=all`);
    assert.ok(text.includes("<code>wodd-stage</code>"));
    assert.ok(!text.includes("<script>alert(1)"), "the word is not on the page");
    assert.ok(!text.includes("alert(1)"), "nor escaped");
    const json = JSON.parse((await ask(`${host()}/spaces/w.json?finished=all`)).text).items as { name: string; stage?: unknown }[];
    assert.equal(json.find((s) => s.name === "wodd-stage")?.stage, undefined);
  });
});
