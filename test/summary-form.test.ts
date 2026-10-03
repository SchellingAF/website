// A summary in the post form, offered only where the service says how long one may be.
//
// The service publishes `limits.summary_bytes` once it keeps summaries, and a summary sent to
// one that does not would be dropped or refused, so the site offers the field on no other
// terms: a site deployed first shows none. Where it is offered it is on the plain post form and
// the form a passkey signs, which puts it in the signed object; never on a sealed post, whose
// words are sealed together, and never on a version, whose title says what changed. A service
// that publishes no limit is test/title-required-absent.test.ts's, in a file of its own because
// the site holds the capability document for the whole process.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, json, service, type Call, type Json, type World } from "./lib/service.ts";
import { hostileWorld } from "./lib/world.ts";
import { signedInProblems, tags } from "./lib/documents.ts";
import { summaryProblem } from "../src/post-object.js";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const SPACE_ID = "0199dddd-0000-7000-8000-00000000cccc";
const POST_ID = "0199dddd-0000-7000-8000-0000000000a1";

const world: World = {
  ...hostileWorld(),
  capabilities: { ...CAPABILITIES, limits: { ...CAPABILITIES.limits, summary_bytes: 4096 } },
  spaces: [{
    name: "work-space", space_id: SPACE_ID, title: "Work", description: "Where work is done.", visibility: "private", join_policy: "request",
    status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: OWNER,
    contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-18T09:00:00.000Z",
    access: { role: "owner", tags: [], read: true, post: true },
  }],
  posts: {
    "work-space": [{
      post_id: POST_ID, space: "work-space", space_id: SPACE_ID, seq: "1", kind: "result", author: OWNER, posted_at: "2026-10-03T10:00:00.000Z",
      title: "Slim fails on arm64: 3 of 3 runs", summary: "Fails on arm64 only.", body: "The long working.", to: [], reply_to: null,
      supersedes: null, retracts: null, fingerprints: [], signed: false,
    }],
  },
};
const base = service(world);
const { fake, handleRequest } = await site((call: Call) =>
  call.method === "POST" && call.url.pathname === "/v1/spaces/work-space/posts"
    ? json({ post_id: "0199dddd-0000-7000-8000-000000000002", seq: "2" }, 201) : base(call));
const { cookie, csrf } = await signedIn(OWNER, "summary-form-token", "192.0.2.99");
const writes = () => fake.calls.filter((c) => c.method === "POST" && c.url.pathname === "/v1/spaces/work-space/posts");

async function page(path: string) {
  const res = await handleRequest(new Request(`${SITE}${path}`, { headers: { Cookie: cookie } }), env);
  return { res, text: await res.text() };
}
async function send(fields: Record<string, string>) {
  const res = await handleRequest(new Request(`${SITE}/me/spaces/work-space/posts`, {
    method: "POST",
    headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, kind: "result", title: "Slim fails on arm64: 3 of 3", body: "The long working.", ...fields }).toString(),
  }), env);
  return { res, text: await res.text() };
}
const summaryFields = (html: string) => tags(html).filter((t) => t.name === "textarea" && t.attributes.some(([k, v]) => k === "name" && v === "summary"));
const sentBody = () => JSON.parse(writes().at(-1)!.body!) as Json;

describe("the post form, where the service takes a summary", () => {
  test("offers it, with the service's own limit, on the post form and tells the script that signs", async () => {
    const { res, text } = await page("/me/spaces/work-space");
    assert.equal(res.status, 200, text.slice(0, 300));
    const fields = summaryFields(text);
    assert.ok(fields.length >= 1, "a summary field");
    for (const f of fields) assert.deepEqual(f.attributes.find(([k]) => k === "maxlength"), ["maxlength", "4096"]);
    assert.match(text, /Summary, if you give one: what a reader needs before the text, in a few sentences\. At most 4,096 bytes\./);
    assert.deepEqual(signedInProblems(text), []);
    const signed = tags(text).filter((t) => t.name === "form" && t.attributes.some(([k]) => k === "data-sign"));
    assert.ok(signed.length >= 1);
    for (const form of signed) assert.deepEqual(form.attributes.find(([k]) => k === "data-max-summary-bytes"), ["data-max-summary-bytes", "4096"]);
  });

  test("starts a correction as the post was, summary included", async () => {
    const { text } = await page("/me/spaces/work-space/1");
    const correction = /<h2>Correct your post: what replaces it<\/h2>[\s\S]*?<\/form>/.exec(text)?.[0] ?? "";
    assert.ok(correction, "the correction form");
    assert.match(correction, /<textarea name="summary"[^>]*>Fails on arm64 only\.<\/textarea>/);
    const retraction = /<h2>Retract this post, saying why<\/h2>[\s\S]*?<\/form>/.exec(text)?.[0] ?? "";
    assert.match(retraction, /<textarea name="summary"[^>]*><\/textarea>/, "a retraction starts with none");
  });

  test("sends what was typed, trimmed, and nothing when nothing was typed", async () => {
    const before = writes().length;
    assert.equal((await send({ summary: "  Fails on arm64 only.\nThe full image works.  " })).res.status, 303);
    assert.equal(sentBody().summary, "Fails on arm64 only.\nThe full image works.");
    assert.equal((await send({ summary: "   " })).res.status, 303);
    assert.ok(!("summary" in sentBody()));
    assert.equal((await send({})).res.status, 303);
    assert.ok(!("summary" in sentBody()));
    assert.equal(writes().length, before + 3);
  });

  test("a summary over the limit, counted in bytes, is refused here and shown again as typed", async () => {
    const before = writes().length;
    // 2,100 letters of two bytes each: fewer characters than the field's maxlength, more bytes than the service takes.
    const long = "é".repeat(2100);
    const { res, text } = await send({ summary: long });
    assert.equal(res.status, 400);
    assert.match(text, /The summary is 4,200 bytes, and a summary is at most 4,096\. A letter outside English takes two to four of them\. Nothing was posted\./);
    assert.ok(text.includes(`>${long}</textarea>`), "what was typed is shown again");
    assert.equal(writes().length, before, "nothing reached the service");
    assert.equal((await send({ summary: "é".repeat(2048) })).res.status, 303, "4,096 bytes exactly is within it");
  });

  test("is not on the plain form when it shows a version again", async () => {
    // A proposal is a version, and its title says what changed: a summary field has no place on it.
    const res = await handleRequest(new Request(`${SITE}/me/spaces/work-space/posts`, {
      method: "POST",
      headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, kind: "version", title: "x", body: "A document.\n```", fingerprints: "not a fingerprint" }).toString(),
    }), env);
    const again = await res.text();
    assert.equal(res.status, 400);
    assert.equal(summaryFields(again).length, 0, "a version shown again has no summary field");
  });
});

describe("the words and the rule, which the server and the script that signs share", () => {
  test("a summary is too long by its bytes, and only where a limit is stated", () => {
    assert.equal(summaryProblem("a".repeat(4096), 4096), "");
    assert.match(summaryProblem("a".repeat(4097), 4096), /^The summary is 4,097 bytes, and a summary is at most 4,096\./);
    assert.match(summaryProblem("é".repeat(2049), 4096), /4,098 bytes/);
    assert.equal(summaryProblem(`  ${"a".repeat(4096)}  `, 4096), "", "the ends are trimmed, as they are when sent");
    assert.equal(summaryProblem("a".repeat(10_000), null), "");
    assert.equal(summaryProblem("a".repeat(10_000), undefined), "");
    assert.equal(summaryProblem(undefined, 4096), "");
  });
});
