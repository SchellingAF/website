// The categories this site reads from the product: what it keeps of the list, how a
// name a person types becomes a category, the rules a form's three fields are held to
// before the product is asked, and how the two reads are held.
//
// The list and its counts are read in this process and held, so each test here that
// reads them through the network does it in order, with the clock under its control.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { API, CATEGORIES, json, refusal, stubFetch, type Json } from "./lib/service.ts";

process.env.API_ORIGIN = API;
let answer: (path: string) => Response | Promise<Response> = () => json({ categories: CATEGORIES });
const fake = stubFetch((call) => answer(call.url.pathname + call.url.search));
after(() => fake.restore());
const C = await import("../src/categories.ts");

const reg = C.readableRegister({ version: "2026-09-18", categories: CATEGORIES })!;

describe("the list as this site keeps it", () => {
  test("keeps every entry it can use, in the service's order, and counts each one's depth from its parents", () => {
    assert.deepEqual(reg.list.map((c) => c.id), CATEGORIES.map((c) => c.id));
    assert.deepEqual(reg.list.map((c) => c.depth), [1, 2, 3, 4, 4, 2, 3, 3, 1]);
    assert.deepEqual((reg.children.get(null) ?? []).map((c) => c.id), ["artificial-intelligence", "general"]);
    assert.deepEqual(C.pathOf(reg, "vllm").map((c) => c.id), ["artificial-intelligence", "agents", "coding-agents", "vllm"]);
    assert.ok(C.isWithin(reg, "vllm", "agents"));
    assert.ok(!C.isWithin(reg, "agents", "vllm"));
  });

  test("drops what it cannot use: a bad id, a repeat, a missing parent and all below it, a loop, an unknown status", () => {
    const got = C.readableRegister({
      categories: [
        { id: "top", label: "Top", parent: null, status: "active" },
        { id: "Top", label: "Capital", parent: null, status: "active" },
        { id: "top", label: "Again", parent: null, status: "active" },
        { id: "under-nothing", label: "Lost", parent: "gone", status: "active" },
        { id: "below-lost", label: "Lost too", parent: "under-nothing", status: "active" },
        { id: "loop-a", label: "A", parent: "loop-b", status: "active" },
        { id: "loop-b", label: "B", parent: "loop-a", status: "active" },
        { id: "odd", label: "Odd", parent: "top", status: "open" },
        { id: "nameless", label: "  ", parent: "top", status: "active" },
        "not an object",
        { id: "kept", label: "Kept", parent: "top", status: "retired", replaced_by: "nowhere", wikidata: "Q1 <b>", homepage: "http://plain.example" },
      ],
    })!;
    assert.deepEqual(got.list.map((c) => c.id), ["top", "kept"]);
    const kept = got.byId.get("kept")!;
    assert.equal(kept.replacedBy, null, "a successor this site does not hold is none");
    assert.equal(kept.wikidata, null);
    assert.equal(kept.homepage, null, "only https");
    assert.equal(got.byId.get("top")!.label, "Top");
  });

  test("finds each depth from the parents whatever order they come in, nine levels at most", () => {
    const chain = Array.from({ length: 10 }, (_, i) => ({ id: `level-${i + 1}`, label: `Level ${i + 1}`, parent: i ? `level-${i}` : null, status: "active" }));
    const got = C.readableRegister({ categories: [...chain].reverse() })!;
    assert.deepEqual(got.list.map((c) => c.id), chain.slice(0, 9).map((c) => c.id).reverse(), "kept in the service's order");
    assert.deepEqual(got.list.map((c) => c.depth), [9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  test("reads at most five thousand, and nothing usable is no list at all", () => {
    const many = Array.from({ length: 6000 }, (_, i) => ({ id: `c${i}`, label: `C ${i}`, parent: null, status: "active" }));
    assert.equal(C.readableRegister({ categories: many })!.list.length, C.MOST_CATEGORIES);
    assert.equal(C.readableRegister({ categories: [] }), null);
    assert.equal(C.readableRegister({ categories: "no" }), null);
    assert.equal(C.readableRegister(null), null);
  });

  test("counts only whole numbers of spaces, by ids in the right shape", () => {
    const counts = C.readableCounts({ counted_at: "2026-09-18T12:00:00.000Z", categories: [
      { id: "general", spaces: 3 }, { id: "agents", spaces: -1 }, { id: "vllm", spaces: 1.5 }, { id: "Bad", spaces: 2 },
    ] })!;
    assert.deepEqual([...counts.spaces], [["general", 3]]);
    assert.equal(counts.at, "2026-09-18T12:00:00.000Z");
    assert.equal(C.readableCounts({ counted_at: "<b>", categories: [] })!.at, "");
  });

  test("puts the categories holding a space busiest first, a tie in the service's order, and none that is empty", () => {
    assert.deepEqual(C.busiest({ at: "", spaces: new Map([["general", 1], ["artificial-intelligence", 4], ["labs", 0], ["agents", 1]]) }, reg.list)
      .map((c) => c.id), ["artificial-intelligence", "agents", "general"]);
  });

  test("says where a category sits by the names above it", () => {
    assert.equal(C.placeOf(reg, "vllm"), "Artificial intelligence › Agents › Coding agents");
    assert.equal(C.placeOf(reg, "general"), "");
  });
});

describe("a name a person types", () => {
  test("is an id, a name or another name, with case and spacing ignored and nothing looser", () => {
    const one = (typed: string) => {
      const r = C.resolveCategory(reg, typed);
      return r.kind === "one" ? r.category.id : r.kind;
    };
    assert.equal(one("vllm"), "vllm");
    assert.equal(one("  VLLM "), "vllm");
    assert.equal(one("vLLM"), "vllm");
    assert.equal(one("vllm  engine"), "vllm", "another name");
    assert.equal(one("Coding   Agents"), "coding-agents");
    assert.equal(one("coding agent"), "none", "a near miss is no match here; the lookup box ranks those");
    assert.equal(one("vll"), "none");
    assert.equal(one(""), "none");
  });

  test("names both categories when two share a name", () => {
    const r = C.resolveCategory(reg, "DeepSeek");
    assert.equal(r.kind, "several");
    assert.deepEqual(r.kind === "several" ? r.categories.map((c) => c.id).sort() : [], ["deepseek-lab", "deepseek-models"]);
  });
});

describe("a form's three category fields", () => {
  const file = (...fields: string[]) => C.resolveFiling(reg, fields);
  test("are filed in order, the main one first, by id or by name", () => {
    assert.deepEqual(file("vllm", "", ""), { ok: true, ids: ["vllm"] });
    assert.deepEqual(file("Coding agents", "general", "labs"), { ok: true, ids: ["coding-agents", "general", "labs"] });
    assert.deepEqual(file("", "", ""), { ok: true, ids: [] }, "nothing typed is nothing filed; the form decides what that means");
  });

  test("are refused, each in one sentence, by the service's rules", () => {
    const why = (...fields: string[]) => {
      const r = C.resolveFiling(reg, fields);
      assert.equal(r.ok, false, fields.join("|"));
      return r.ok ? "" : r.why;
    };
    assert.match(why("", "vllm", ""), /main one: fill it in first/);
    assert.match(why("no such thing", "", ""), /No category is called no such thing/);
    assert.match(why("DeepSeek", "", ""), /names more than one category: DeepSeek \(deepseek-lab\), DeepSeek \(deepseek-models\)/);
    assert.match(why("roo-code", "", ""), /Roo Code \(roo-code\) is retired.*File this one under vLLM \(vllm\) instead/);
    assert.match(why("vllm", "VLLM", ""), /vLLM \(vllm\) is listed twice/);
    assert.match(why("agents", "vllm", ""), /vLLM \(vllm\) is inside Agents \(agents\)\. List only vLLM/);
    assert.match(why("vllm", "agents", ""), /vLLM \(vllm\) is inside Agents \(agents\)/, "whichever comes first");
    assert.match(why(`${"x".repeat(200)}`, "", ""), /No category is called x{63}…\./, "a long name is quoted short");
  });

  test("send on an id the list in hand does not hold, which a newer list may, for the service to judge", () => {
    assert.deepEqual(file("brand-new-category", "vllm", ""), { ok: true, ids: ["brand-new-category", "vllm"] });
    assert.deepEqual(file("Brand-New-Category", "", ""), { ok: true, ids: ["brand-new-category"] });
  });

  test("without the list, take ids as typed and leave the rest to the service", () => {
    assert.deepEqual(C.resolveFiling(null, ["VLLM", "general", ""]), { ok: true, ids: ["vllm", "general"] });
    const r = C.resolveFiling(null, ["Coding agents", "", ""]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /not a category id, and the list of categories cannot be read just now/);
  });
});

describe("how the two reads are held", () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  after(() => { Date.now = realNow; });
  const asked = (path: string) => fake.calls.filter((c) => c.url.pathname + c.url.search === path).length;
  const LIST = "/v1/categories?depth=4&detail=full";

  test("before the first good read there is nothing, and a failed read is tried again after a minute, not before", async () => {
    answer = () => refusal(503, "BUSY");
    assert.equal(await C.register(), null);
    assert.equal(await C.register(), null);
    assert.equal(asked(LIST), 1, "the second page did not ask again within the minute");
    now += 61_000;
    answer = () => json({ version: "v1", categories: CATEGORIES });
    assert.equal((await C.register())?.version, "v1");
    assert.equal(asked(LIST), 2);
  });

  test("a copy in hand answers for an hour without asking", async () => {
    const before = asked(LIST);
    now += 59 * 60_000;
    assert.equal((await C.register())?.version, "v1");
    assert.equal(asked(LIST), before);
  });

  test("past the hour a page is answered at once from the copy while one read fetches a fresh one", async () => {
    now += 2 * 60_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    answer = () => gate.then(() => json({ version: "v2", categories: CATEGORIES }));
    const before = asked(LIST);
    const [a, b] = await Promise.all([C.register(), C.register()]);
    assert.equal(a?.version, "v1", "the page did not wait for the fresh read");
    assert.equal(b?.version, "v1");
    assert.equal(asked(LIST), before + 1, "one read at a time");
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await C.register())?.version, "v2");
  });

  test("a read that fails keeps the last good copy, and is tried again at most once a minute", async () => {
    now += 61 * 60_000;
    answer = () => { throw new Error("down"); };
    const before = asked(LIST);
    assert.equal((await C.register())?.version, "v2");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await C.register())?.version, "v2");
    assert.equal(asked(LIST), before + 1);
    now += 61_000;
    answer = () => json({ version: "v3", categories: CATEGORIES });
    await C.register();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await C.register())?.version, "v3");
  });

  test("an id the copy lacks has the list read again within a minute, not the hour", async () => {
    answer = () => json({ version: "v4", categories: CATEGORIES });
    const before = asked(LIST);
    C.unknownId("Not An Id");
    now += 61_000;
    await C.register();
    assert.equal(asked(LIST), before, "a value in no id's shape asks for nothing");
    C.unknownId("brand-new-category");
    await C.register();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await C.register())?.version, "v4");
    assert.equal(asked(LIST), before + 1);
  });

  test("the counts are their own read, held ten minutes", async () => {
    const COUNTS = "/v1/categories?depth=4&counts=true";
    answer = () => json({ counted_at: "2026-09-18T12:00:00.000Z", categories: [{ id: "general", spaces: 2 } as Json] });
    assert.equal((await C.categoryCounts())?.spaces.get("general"), 2);
    now += 9 * 60_000;
    await C.categoryCounts();
    assert.equal(asked(COUNTS), 1);
  });
});
