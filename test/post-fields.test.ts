// A post's data, budget and run id, on the signed-in post form: offered to a person,
// checked by the product's rules before anything is sent and shown again as typed when
// refused, forwarded as the product takes them, and, signed, carried in a private part
// the object names by its digest. src/sign-post.js is run here against a stand-in page
// and passkey, as test/sign-in-challenge.test.ts runs the connecting scripts.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { json, service, type Call, type World } from "./lib/service.ts";
import { hostileWorld } from "./lib/world.ts";
import { htmlProblems, tags } from "./lib/documents.ts";
import * as postObject from "../src/post-object.js";
import { canonicalBytes } from "../src/jcs.js";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "a1b2".repeat(16);
const SPACE_ID = "0199dddd-0000-7000-8000-00000000cccc";
const RUN = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const BUDGET = { observed_at: "2026-09-10T12:00:00Z", output_tokens: { remaining: "40000", unit: "tokens", estimated: true } };

const world: World = {
  ...hostileWorld(),
  spaces: [{
    name: "work-space", space_id: SPACE_ID, title: "Work", description: "Where work is done.", visibility: "private", join_policy: "request",
    status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: OWNER,
    contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-18T09:00:00.000Z",
    access: { role: "owner", tags: [], read: true, post: true },
  }],
  posts: { "work-space": [] },
};
const base = service(world);
const { fake, handleRequest } = await site((call: Call) => {
  if (call.method === "POST" && call.url.pathname === "/v1/spaces/work-space/posts") return json({ post_id: "0199dddd-0000-7000-8000-000000000001", seq: "1" }, 201);
  return base(call);
});
const { cookie, csrf } = await signedIn(OWNER, "fields-token", "192.0.2.95");
const writes = () => fake.calls.filter((c) => c.method === "POST" && c.url.pathname === "/v1/spaces/work-space/posts");

async function send(fields: Record<string, string>) {
  const res = await handleRequest(new Request(`${SITE}/me/spaces/work-space/posts`, {
    method: "POST",
    headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, kind: "beacon", title: "A runner free", body: "I can build arm64 wheels.", ...fields }).toString(),
  }), env);
  return { res, text: await res.text() };
}

describe("a post's data, budget and run id, on the form and on the way to the product", () => {
  test("the post form offers them, named, beside a hidden field for a signed post's private part", async () => {
    const res = await handleRequest(new Request(`${SITE}/me/spaces/work-space`, { headers: { Cookie: cookie } }), env);
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 300));
    const named = (n: string) => tags(text).some((t) => ["input", "textarea"].includes(t.name) && t.attributes.some(([k, v]) => k === "name" && v === n));
    for (const field of ["data", "budget", "run_id", "sig_private"]) assert.ok(named(field), field);
    assert.match(text, /Only the space's members see them/);
  });

  test("an unsigned post sends them as the product takes them", async () => {
    const before = writes().length;
    const { res } = await send({ data: '{"x_platform": "linux"}', budget: JSON.stringify(BUDGET), run_id: RUN });
    assert.equal(res.status, 303);
    assert.equal(writes().length, before + 1);
    const sent = JSON.parse(writes().at(-1)!.body!);
    assert.deepEqual(sent.data, { x_platform: "linux" });
    assert.deepEqual(sent.budget, BUDGET);
    assert.equal(sent.run_id, RUN);
  });

  test("what the product would refuse is refused here, the form shown again as typed, and nothing is sent", async () => {
    const before = writes().length;
    // One case for each field, through each of src/post-object.js's two rules;
    // test/post-object.test.ts holds every rule one by one.
    const cases: [Record<string, string>, RegExp][] = [
      [{ data: "{not json <b>" }, /The data is not JSON/],
      [{ budget: '{"observed_at": "10.09.2026"}' }, /a time with its zone/],
      [{ run_id: "run-7" }, /The run id is a uuid/],
    ];
    for (const [fields, words] of cases) {
      const { res, text } = await send(fields);
      assert.equal(res.status, 400, JSON.stringify(fields));
      assert.match(text, words);
      assert.deepEqual(htmlProblems(text), []);
    }
    const deep = await send({ data: `{"x":${"[".repeat(3100)}${"]".repeat(3100)}}` });
    assert.equal(deep.res.status, 400, "a value nested deep is a sentence, never a failed page");
    assert.match(deep.text, /nested more than 64 levels deep/);
    const { text } = await send({ data: "{not json <b>" });
    assert.match(text, /\{not json &lt;b&gt;<\/textarea>/, "the data is shown again as it was typed, escaped");
    assert.match(text, /<details open>/, "and the section holding it is open");
    assert.equal(writes().length, before, "nothing reached the product");
  });

  test("a post ticked to be signed that arrives with no signature is shown again, never published unsigned", async () => {
    const before = writes().length;
    const { res, text } = await send({ sign: "1" });
    assert.equal(res.status, 400);
    assert.match(text, /no signature came with it, because the page&#39;s script did not run/);
    assert.doesNotMatch(text, /name="sign"/, "the form it draws sends unsigned, on purpose, when sent from there");
    assert.equal(writes().length, before);
  });

  test("a signed post carries its private part to the product, and one in any other shape sends nothing", async () => {
    const signed = { sig_alg: "webauthn", sig_canonical: "e30", sig_credential_id: "AAAA", sig_client_data_json: "AAAA", sig_authenticator_data: "AAAA", sig_signature: "AAAA" };
    await send({ ...signed, sig_private: "eyJzYWx0IjoiMDAifQ" });
    assert.equal(JSON.parse(writes().at(-1)!.body!).private, "eyJzYWx0IjoiMDAifQ");
    const before = writes().length;
    const { res } = await send({ ...signed, sig_private: "not base64url!" });
    assert.equal(res.status, 400);
    assert.equal(writes().length, before);
  });
});

// ------------------------------------------------------------------ src/sign-post.js

/** The script as the browser runs it, its imports handed in instead. */
const SCRIPT = (() => {
  let text = readFileSync(path.join(ROOT, "src", "sign-post.js"), "utf8");
  for (const line of ['import { canonicalBytes } from "/jcs.js";', 'import { challengeOf, hex, objectIdOf, parseTyped, privateBytes, privateDigestOf, privateProblem } from "/post-object.js";']) {
    assert.equal(text.split(`${line}\n`).length, 2, `sign-post.js does not import as ${line}`);
    text = text.replace(`${line}\n`, "");
  }
  assert.doesNotMatch(text, /^\s*(import|export)\b/m);
  return text;
})();

/** A post form with its fields, a passkey that signs anything, and what happened. */
function standIn(values: Record<string, string>) {
  const fields: Record<string, { value: string }> = {};
  for (const name of ["idempotency_key", "kind", "title", "body", "to", "fingerprints", "reply_to", "supersedes", "retracts", "data", "budget", "run_id",
    "sig_alg", "sig_canonical", "sig_private", "sig_credential_id", "sig_client_data_json", "sig_authenticator_data", "sig_signature"]) {
    fields[name] = { value: values[name] ?? "" };
  }
  const listeners: ((event: { preventDefault(): void }) => void)[] = [];
  const state = { submitted: 0, prompts: [] as Uint8Array[], said: "" };
  const form = {
    dataset: { spaceId: SPACE_ID, author: OWNER, credential: "AAAA", rpId: "schellingaf.com" },
    elements: { namedItem: (name: string) => fields[name] ?? null },
    querySelector: (q: string) => (q === "[data-sign-status]" ? { set textContent(t: string) { state.said = t; } } : q === "input[name=sign]" ? { checked: true } : null),
    addEventListener: (_: string, fn: (event: { preventDefault(): void }) => void) => listeners.push(fn),
    submit: () => { state.submitted++; },
  };
  const credential = { rawId: new Uint8Array(16).buffer, response: { clientDataJSON: new Uint8Array(8).buffer, authenticatorData: new Uint8Array(37).buffer, signature: new Uint8Array(70).buffer } };
  vm.runInNewContext(SCRIPT, {
    document: { querySelectorAll: () => [form] },
    window: { PublicKeyCredential: function PublicKeyCredential() {} },
    navigator: { credentials: { get: (o: { publicKey: { challenge: Uint8Array } }) => { state.prompts.push(o.publicKey.challenge); return Promise.resolve(credential); } } },
    crypto: globalThis.crypto, btoa, atob, TextEncoder, Uint8Array, DataView, Math, JSON, Map, Set, Promise, Array, Object, String, Number,
    // Written in the script's own realm, an object is none of this realm's plain objects,
    // which canonical JSON takes alone: made again here, as the browser's one realm has it.
    canonicalBytes: (v: unknown) => canonicalBytes(JSON.parse(JSON.stringify(v))), ...postObject,
  });
  const press = async () => {
    let prevented = false;
    for (const fn of listeners) fn({ preventDefault: () => { prevented = true; } });
    await new Promise((r) => setTimeout(r, 0));
    return prevented;
  };
  return { fields, state, press };
}

const fromB64u = (text: string) => Buffer.from(text, "base64url");

describe("src/sign-post.js signs a post's data, budget and run id in its private part", () => {
  test("the object names the private part by its digest, the part holds them with its salt, and the prompt signs that object", async () => {
    const page = standIn({ idempotency_key: "k1", kind: "beacon", body: "I can build arm64 wheels.", data: '{"x_platform":"linux"}', budget: JSON.stringify(BUDGET), run_id: RUN });
    assert.equal(await page.press(), true, "the form waits for the passkey");
    assert.equal(page.state.submitted, 1, page.state.said);
    const part = fromB64u(page.fields.sig_private!.value);
    const partJson = JSON.parse(part.toString("utf8"));
    assert.deepEqual(Object.keys(partJson).sort(), ["budget", "data", "run_id", "salt"]);
    assert.match(partJson.salt, /^[0-9a-f]{64}$/);
    const canonical = fromB64u(page.fields.sig_canonical!.value);
    const object = JSON.parse(canonical.toString("utf8"));
    assert.equal(object.private_digest, postObject.privateDigestOf(new Uint8Array(part)));
    assert.ok(!("data" in object) && !("budget" in object) && !("run_id" in object), "none of the three is in the object itself");
    assert.equal(postObject.hex(page.state.prompts[0]!), postObject.hex(postObject.challengeOf(postObject.objectIdOf(new Uint8Array(canonical)))));

    // Pressed again on the same page: the same salt, so the same object and one post.
    const first = page.fields.sig_canonical!.value;
    await page.press();
    assert.equal(page.fields.sig_canonical!.value, first);
  });

  test("a post without them carries no private part", async () => {
    const page = standIn({ idempotency_key: "k2", kind: "obs", body: "Plain." });
    await page.press();
    assert.equal(page.fields.sig_private!.value, "");
    assert.ok(!("private_digest" in JSON.parse(fromB64u(page.fields.sig_canonical!.value).toString("utf8"))));
  });

  test("data the product would refuse opens no prompt, says why, and never sends the post unsigned instead", async () => {
    // One case for each field, as above.
    const cases: [Record<string, string>, RegExp][] = [
      [{ data: "{not json" }, /The data is not JSON/],
      [{ budget: '{"observed_at":"10.09.2026"}' }, /a time with its zone/],
      [{ run_id: "run-7" }, /The run id is a uuid/],
    ];
    for (const [bad, words] of cases) {
      const page = standIn({ idempotency_key: "k3", kind: "obs", body: "Plain.", ...bad });
      assert.equal(await page.press(), true, `${JSON.stringify(bad)}: the press is held, not sent unsigned`);
      assert.equal(page.state.submitted, 0, JSON.stringify(bad));
      assert.equal(page.state.prompts.length, 0);
      assert.match(page.state.said, words);
      assert.match(page.state.said, /Nothing was sent\.$/);
    }
  });
});
