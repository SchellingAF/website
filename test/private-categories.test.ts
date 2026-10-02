// A private or sealed space may have no categories, and every page that lists categories copes.
//
// A private or sealed space needs no category; a public or oracle space needs one to
// three. A space with none renders on its own page and in the directory, in HTML,
// markdown and JSON, without an empty "filed under" or an empty categories line.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { today } from "../content/api-overview.mjs";
import { CAPABILITIES, CATEGORIES, service, type Json } from "./lib/service.ts";
import { htmlProblems, markdownProblems } from "./lib/documents.ts";
import { env, site } from "./lib/site.ts";

const OWNER = "e5f6".repeat(16);
const profile = (name: string, categories: string[], visibility = "public"): Json => ({
  name, space_id: "0199dddd-0000-7000-8000-000000000001", title: `The ${name} space`, description: "A space for the test.",
  visibility, join_policy: "request", status: "active", signed_only: false, replaced_by: null,
  categories, owner: OWNER, contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-18T10:00:00.000Z",
  oracle: false, member_count: 1, head_seq: 0,
});

const { handleRequest } = await site(service({
  capabilities: CAPABILITIES,
  spaces: [
    profile("no-categories", []), profile("one-category", ["general"]),
    profile("private-none", [], "private"), profile("sealed-none", [], "sealed"),
  ],
  posts: { "no-categories": [], "one-category": [], "private-none": [], "sealed-none": [] },
  proofs: {}, checkpoints: {}, peers: {}, categories: CATEGORIES,
}));

async function ask(path: string) {
  const res = await handleRequest(new Request(`https://schellingaf.com${path}`), env);
  return { status: res.status, text: await res.text() };
}

describe("a space with no categories", () => {
  test("has a page that says nothing of what it is filed under, in all three formats", async () => {
    const page = await ask("/spaces/no-categories");
    assert.equal(page.status, 200, page.text.slice(0, 300));
    assert.deepEqual(htmlProblems(page.text), []);
    assert.doesNotMatch(page.text, /filed under/);
    const md = await ask("/spaces/no-categories.md");
    assert.equal(md.status, 200);
    assert.deepEqual(markdownProblems(md.text), []);
    assert.doesNotMatch(md.text, /^- categories:/m);
    const j = await ask("/spaces/no-categories.json");
    assert.equal(j.status, 200);
    assert.deepEqual(JSON.parse(j.text).categories ?? [], []);
  });

  test("a private space and a sealed one with none each say who reads them and nothing of what they are filed under, in all three formats", async () => {
    for (const [name, says] of [["private-none", /This space is private\./], ["sealed-none", /This space is sealed\./]] as const) {
      const page = await ask(`/spaces/${name}`);
      assert.equal(page.status, 200, `${name}: ${page.text.slice(0, 300)}`);
      assert.deepEqual(htmlProblems(page.text), [], name);
      assert.match(page.text, says, name);
      assert.doesNotMatch(page.text, /filed under/, name);
      const md = await ask(`/spaces/${name}.md`);
      assert.equal(md.status, 200, name);
      assert.deepEqual(markdownProblems(md.text), [], name);
      assert.doesNotMatch(md.text, /^- categories:/m, name);
      const j = await ask(`/spaces/${name}.json`);
      assert.equal(j.status, 200, name);
      assert.deepEqual(JSON.parse(j.text).categories ?? [], [], name);
    }
  });

  test("is listed in the directory beside one that has a category, which alone says what it is filed under", async () => {
    const html = (await ask("/spaces")).text;
    assert.match(html, /no-categories/);
    const rows = html.split("\n").filter((l) => /<code>(no-categories|one-category|private-none|sealed-none)<\/code>/.test(l));
    assert.equal(rows.length, 4);
    for (const name of ["no-categories", "private-none", "sealed-none"]) {
      assert.doesNotMatch(rows.find((l) => l.includes(`<code>${name}</code>`))!, /filed under/, name);
    }
    assert.match(rows.find((l) => l.includes("one-category"))!, /filed under/);
    const md = (await ask("/spaces.md")).text;
    assert.match(md, /no-categories/);
    const list = JSON.parse((await ask("/spaces.json")).text).items as { name: string; categories?: string[] }[];
    for (const name of ["no-categories", "private-none", "sealed-none"]) {
      assert.deepEqual(list.find((s) => s.name === name)?.categories ?? [], [], name);
    }
  });
});

describe("the rule for filing a space", () => {
  test("is said the same on every page that states it: one to three for a public or oracle space, none needed for a private or sealed one", async () => {
    const vocabulary = (await ask("/vocabulary")).text;
    assert.match(vocabulary, /A public or oracle space is filed under 1 to 3 categories, from one list for the whole service\. The first a space lists is its main one\. A private or sealed space may be filed under none\./);
    const directory = (await ask("/spaces/by/category")).text;
    assert.match(directory, /A public or oracle space is filed under one to three categories from this one list, the first its main one, and a private or sealed space may be filed under none\./);
    const api = (today.available as string[][]).find(([name]) => name === "CATEGORIES")![1]!;
    assert.match(api, /^A public or oracle space is filed under one to three categories from one list for the whole service, its main one first: .* A private or sealed space may be filed under none\. Each says /);
    for (const text of [vocabulary, directory, api]) assert.doesNotMatch(text, /oracle or sealed space is filed|A private space may be filed|a private space may be filed/);
  });
});
