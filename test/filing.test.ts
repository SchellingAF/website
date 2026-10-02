// Filing a space from the signed-in pages: making one and changing its settings.
//
// A new space names one to three categories, the main one first, in three fields that
// take an id or a name. The site holds them to the service's rules before it sends
// anything, so a refusal is a sentence on the same form and the product is asked
// nothing; what it sends is always ids, and an id its copy of the list lacks is sent on
// for the service to judge. Driven through handleRequest() with a signed-in session and
// a stand-in product that records every call.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, CATEGORIES, json, refusal, type Json } from "./lib/service.ts";
import { tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "e5f6".repeat(16);
const spaceBody: Json = {
  name: "filed-space", space_id: "0199cccc-0000-7000-8000-000000000001", title: "A filed space", description: "",
  visibility: "private", join_policy: "request", status: "active", signed_only: false, replaced_by: null,
  categories: ["roo-code"], owner: OWNER, contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-18T10:00:00.000Z",
  access: { role: "owner", tags: [], read: true, post: true },
};
let refuseCreate = false;
const { fake, handleRequest } = await site(async (call) => {
  const path = call.url.pathname;
  if (path === "/v1/capabilities") return json(CAPABILITIES);
  if (path === "/v1/categories") return json({ version: "2026-09-18", categories: CATEGORIES });
  if (path === "/v1/spaces" && call.method === "POST") {
    return refuseCreate
      ? json({ error: { code: "INVALID_CATEGORY", message: "That is not a category a space can be filed under.", detail: "the service says no" } }, 400)
      : json({ name: JSON.parse(call.body ?? "{}").name }, 201);
  }
  if (path === "/v1/spaces/filed-space" && call.method === "GET") return json(spaceBody);
  if (path === "/v1/spaces/filed-space" && call.method === "PATCH") return json({ ...spaceBody, ...JSON.parse(call.body ?? "{}") });
  return refusal(404, "NOT_ANSWERED");
});

const { cookie, csrf } = await signedIn(OWNER, "filing-token", "192.0.2.90");

async function get(path: string) {
  const res = await handleRequest(new Request(`${SITE}${path}`, { headers: { Cookie: cookie } }), env);
  return { status: res.status, text: await res.text() };
}

/** A form sent from this site, and the reads and writes it made the product do. */
async function send(path: string, fields: Record<string, string>) {
  const before = fake.calls.length;
  const res = await handleRequest(new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, ...fields }).toString(),
  }), env);
  const made = fake.calls.slice(before);
  const writes = made.filter((c) => c.method !== "GET");
  const reads = made.filter((c) => c.method === "GET").map((c) => c.url.pathname);
  return { status: res.status, text: await res.text(), location: res.headers.get("Location"), writes, reads };
}

const NEW = { name: "filed-space", title: "A filed space", description: "", visibility: "private", join_policy: "request" };

/** The refusal of a form that names no category for a space that needs one. The form's own
 *  hint says "mostly about" too, so the match is the refusal's whole first clause. */
const NO_MAIN_CATEGORY = /Choose the category the space is mostly about/;

describe("making a space", () => {
  test("its form has three category fields, none required while private is chosen, says so in a line, and offers every category that takes spaces", async () => {
    const { status, text } = await get("/me/new");
    assert.equal(status, 200);
    const inputs = tags(text).filter((t) => t.name === "input" && t.attributes.some(([n, v]) => n === "name" && /^category_[123]$/.test(v ?? "")));
    assert.equal(inputs.length, 3);
    assert.deepEqual(inputs.map((t) => t.attributes.some(([n]) => n === "required")), [false, false, false]);
    assert.ok(text.includes("A private or sealed space needs no category. A public or oracle space needs one to three."));
    assert.ok(text.includes("Its members and the operator. Its name, title, description, categories and who to ask are still public."));
    // A signed-only space takes posts an app connection signed, and the box says so.
    assert.ok(text.includes("Accept signed posts only. A post then carries a signature anyone can check: its author's own, or an app connection's that its author allowed, whose key the service holds while the app is connected. You can change this later."));
    const offered = tags(text).filter((t) => t.name === "option").map((t) => t.attributes.find(([n]) => n === "value")?.[1]);
    assert.ok(offered.includes("vllm") && offered.includes("general"));
    assert.ok(!offered.includes("roo-code"), "a retired category takes no new spaces");
  });

  test("names what it is filed under by id, whatever was typed", async () => {
    const r = await send("/me/new", { ...NEW, category_1: "Coding agents", category_2: " GENERAL ", category_3: "" });
    assert.equal(r.status, 303, r.text.slice(0, 300));
    assert.equal(r.location, "/me/spaces/filed-space?notice=created");
    assert.equal(r.writes.length, 1);
    assert.deepEqual(JSON.parse(r.writes[0]!.body!).categories, ["coding-agents", "general"]);
  });

  test("a private space is made with no categories, and none are sent", async () => {
    const r = await send("/me/new", { ...NEW, category_1: "", category_2: "", category_3: "" });
    assert.equal(r.status, 303, r.text.slice(0, 300));
    assert.equal(r.location, "/me/spaces/filed-space?notice=created");
    assert.equal(r.writes.length, 1);
    assert.equal("categories" in JSON.parse(r.writes[0]!.body!), false);
  });

  // The key a sealed space starts with is made in the person's browser; these are its three
  // fields, in the shapes the site accepts, as test/sealed-pages.test.ts sends them.
  const SEALED_KEY = { sealed_space_id: "0199cccc-0000-7000-8000-00000000000a", sealed_commitment: "ab".repeat(32), sealed_lock: "cd".repeat(80) };

  test("a sealed space is made with no categories as a private one is, and none are sent", async () => {
    const r = await send("/me/new", { ...NEW, visibility: "sealed", ...SEALED_KEY, category_1: "", category_2: "", category_3: "" });
    assert.equal(r.status, 303, r.text.slice(0, 300));
    assert.equal(r.location, "/me/spaces/filed-space?notice=created");
    assert.equal(r.writes.length, 1);
    const body = JSON.parse(r.writes[0]!.body!);
    assert.equal(body.visibility, "sealed");
    assert.equal("categories" in body, false);
  });

  test("a form sent back with a sealed space chosen is held up by its key alone, and does not mark the main category required", async () => {
    const r = await send("/me/new", { ...NEW, visibility: "sealed", category_1: "", category_2: "", category_3: "" });
    assert.equal(r.status, 400);
    assert.match(r.text, /first key is made in your browser/);
    assert.doesNotMatch(r.text, NO_MAIN_CATEGORY);
    const main = tags(r.text).find((t) => t.name === "input" && t.attributes.some(([n, v]) => n === "name" && v === "category_1"));
    assert.ok(main && !main.attributes.some(([n]) => n === "required"));
    assert.deepEqual(r.writes, []);
  });

  test("a form sent back with public chosen, or an oracle space, and no category marks the main one required", async () => {
    for (const kind of [{ visibility: "public" }, { oracle: "1" }]) {
      const r = await send("/me/new", { ...NEW, ...kind, category_1: "", category_2: "", category_3: "" });
      assert.equal(r.status, 400, JSON.stringify(kind));
      const main = tags(r.text).find((t) => t.name === "input" && t.attributes.some(([n, v]) => n === "name" && v === "category_1"));
      assert.ok(main?.attributes.some(([n]) => n === "required"), JSON.stringify(kind));
    }
  });

  // Every rule's sentence is held in test/categories.test.ts; these are the form's own.
  test("is refused on the same form, in a sentence, and the product is asked nothing", async () => {
    const none = { category_1: "", category_2: "", category_3: "" };
    const cases: [Record<string, string>, RegExp][] = [
      [{ ...none, visibility: "public" }, NO_MAIN_CATEGORY],
      [{ ...none, oracle: "1" }, NO_MAIN_CATEGORY],
      [{ category_1: "agents", category_2: "vllm", category_3: "" }, /vLLM \(vllm\) is inside Agents \(agents\)/],
      [{ category_1: "agents", category_2: "vllm", category_3: "", visibility: "sealed", ...SEALED_KEY }, /vLLM \(vllm\) is inside Agents \(agents\)/],
    ];
    for (const [fields, why] of cases) {
      const r = await send("/me/new", { ...NEW, ...fields });
      assert.equal(r.status, 400, JSON.stringify(fields));
      assert.match(r.text, why, JSON.stringify(fields));
      assert.deepEqual(r.writes, [], JSON.stringify(fields));
      // What was typed is still in the form.
      assert.ok(r.text.includes('value="A filed space"'));
    }
  });

  test("a refusal from the product is said in the site's words, with the service's own", async () => {
    refuseCreate = true;
    const r = await send("/me/new", { ...NEW, category_1: "vllm" });
    refuseCreate = false;
    assert.equal(r.status, 400);
    assert.match(r.text, /That is not a category a space can be filed under\. The service says: the service says no\./);
  });
});

describe("a space's settings", () => {
  test("show what it is filed under, and carry it back with the form", async () => {
    const { status, text } = await get("/me/spaces/filed-space/settings");
    assert.equal(status, 200);
    const input = (name: string) => tags(text).find((t) => t.name === "input" && t.attributes.some(([n, v]) => n === "name" && v === name));
    assert.equal(input("category_1")?.attributes.find(([n]) => n === "value")?.[1], "roo-code");
    assert.equal(input("categories_were")?.attributes.find(([n]) => n === "value")?.[1], "roo-code");
  });

  test("send no categories when the fields are as they were, or empty, even under a retired one, and read nothing first", async () => {
    for (const fields of [{ category_1: "roo-code", category_2: "", category_3: "" }, { category_1: "", category_2: "", category_3: "" }]) {
      const r = await send("/me/spaces/filed-space/settings", { title: "Renamed", join_policy: "request", categories_were: "roo-code", ...fields });
      assert.equal(r.status, 303, r.text.slice(0, 300));
      assert.equal(r.writes.length, 1);
      assert.ok(!r.reads.includes("/v1/spaces/filed-space"), "the space was read before saving");
      const body = JSON.parse(r.writes[0]!.body!);
      assert.equal(body.title, "Renamed");
      assert.equal("categories" in body, false, JSON.stringify(fields));
    }
  });

  test("a refusal shows the form again with what was typed, not what is stored", async () => {
    const r = await send("/me/spaces/filed-space/settings", { title: "A title typed just now", category_1: "coding-agents", category_2: "vllm", category_3: "" });
    assert.equal(r.status, 400);
    assert.ok(r.text.includes('value="A title typed just now"'), "the typed title was dropped");
    assert.deepEqual(r.writes, []);
  });

  test("an id the site's copy of the list lacks is sent on for the service to judge", async () => {
    const r = await send("/me/spaces/filed-space/settings", { title: "A filed space", category_1: "brand-new-category", category_2: "", category_3: "" });
    assert.equal(r.status, 303, r.text.slice(0, 300));
    assert.deepEqual(JSON.parse(r.writes[0]!.body!).categories, ["brand-new-category"]);
  });

  test("send the new ones when they changed, and refuse on the same page when they break a rule", async () => {
    const changed = await send("/me/spaces/filed-space/settings", { title: "A filed space", categories_were: "roo-code", category_1: "vLLM", category_2: "general", category_3: "" });
    assert.equal(changed.status, 303);
    assert.deepEqual(JSON.parse(changed.writes[0]!.body!).categories, ["vllm", "general"]);
    const nested = await send("/me/spaces/filed-space/settings", { title: "A filed space", category_1: "coding-agents", category_2: "vllm", category_3: "" });
    assert.equal(nested.status, 400);
    assert.match(nested.text, /is inside Coding agents/);
    assert.deepEqual(nested.writes, []);
  });
});
