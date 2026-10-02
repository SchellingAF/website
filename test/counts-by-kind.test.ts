// A product that counts a category's spaces without their kind: its counts carry no
// oracle_spaces. The site falls back to whole counts. The work
// spaces' list counts every space and says its counts take in the oracle spaces, the
// oracle spaces' list offers no categories, and a category's page says how many spaces
// it holds, of both kinds. A file of its own, because the counts are held in memory for
// ten minutes once read.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { service } from "./lib/service.ts";
import { hostileWorld } from "./lib/world.ts";
import { htmlProblems, markdownProblems } from "./lib/documents.ts";
import { env, site } from "./lib/site.ts";

const { handleRequest } = await site(service({ ...hostileWorld(), wholeCounts: true }));
const { readableCounts, kindCountOf, busiest } = await import("../src/categories.ts");

let hosts = 0;
const host = () => `https://w${++hosts}.localhost`;

async function ask(url: string) {
  const res = await handleRequest(new Request(url), env);
  return { res, text: await res.text() };
}

describe("counts that do not say which kind", () => {
  test("are read as whole counts, and no kind is counted from them", () => {
    const whole = readableCounts({ categories: [{ id: "general", spaces: 3 }] })!;
    assert.equal(whole.oracles, null);
    assert.equal(kindCountOf(whole, "general", "work"), null);
    const split = readableCounts({ categories: [{ id: "general", spaces: 3, oracle_spaces: 1 }, { id: "labs", spaces: 2, oracle_spaces: 9 }] })!;
    assert.equal(kindCountOf(split, "general", "work"), 2);
    assert.equal(kindCountOf(split, "general", "oracle"), 1);
    // Never more oracle spaces than spaces, whatever the answer says.
    assert.equal(kindCountOf(split, "labs", "oracle"), 2);
    assert.equal(kindCountOf(split, "labs", "work"), 0);
    // A category with no work space is not among the busiest work categories.
    const reg = [{ id: "general" }, { id: "labs" }] as never[];
    assert.deepEqual(busiest(split, reg, "work").map((c: { id: string }) => c.id), ["general"]);
    assert.deepEqual(busiest(split, reg, "oracle").map((c: { id: string }) => c.id), ["labs", "general"]);
    assert.deepEqual(busiest(split, reg).map((c: { id: string }) => c.id), ["general", "labs"]);
  });

  test("leave the work spaces' list counting every space, and saying so", async () => {
    const { res, text } = await ask(`${host()}/spaces`);
    assert.equal(res.status, 200);
    assert.deepEqual(htmlProblems(text), []);
    assert.match(text, /its count takes in its oracle spaces too/);
    assert.match(text, /<a class="tag" href="\/spaces\/by\/category\/general">General &middot; 3<\/a>/);
    const doc = JSON.parse((await ask(`${host()}/spaces.json`)).text);
    assert.deepEqual(doc.categories.map((c: { id: string; spaces: number }) => [c.id, c.spaces]), [["general", 3], ["artificial-intelligence", 1]]);
    assert.deepEqual(markdownProblems((await ask(`${host()}/spaces.md`)).text), []);
  });

  test("leave the oracle spaces' list with no categories to offer", async () => {
    const { res, text } = await ask(`${host()}/spaces/by/oracle`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(text, /By category, busiest first/);
    assert.equal(JSON.parse((await ask(`${host()}/spaces/by/oracle.json`)).text).categories, undefined);
  });

  test("leave a category's page and every category saying how many spaces, of both kinds", async () => {
    const { text } = await ask(`${host()}/spaces/by/category/general`);
    assert.match(text, /3 spaces filed here or in a category inside it, work spaces and oracle spaces both\./);
    assert.match(text, /<a href="\/spaces\/by\/category\/hostile-words">[^<]*<\/a> <span class="meta">1 space<\/span>/);
    const doc = JSON.parse((await ask(`${host()}/spaces/by/category/general.json`)).text);
    assert.equal(doc.category.spaces, 3);
    assert.ok(!("work_spaces" in doc.category) && !("oracle_spaces" in doc.category));
    const every = await ask(`${host()}/spaces/by/category`);
    assert.match(every.text, /<a href="\/spaces\/by\/category\/general">General<\/a> <span class="meta">3 spaces<\/span>/);
  });
});
