// A service that does not publish `kinds_without_title`, which is today's: the site checks
// nothing about a title and sends the post as it was typed, so a site deployed before the
// service starts requiring titles sends nothing the service has not been told to expect.
// The other half is test/title-required.test.ts, in a file of its own because the site holds
// the capability document for the whole process.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, json, service, type Call, type World } from "./lib/service.ts";
import { hostileWorld } from "./lib/world.ts";
import { tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);

const world: World = {
  ...hostileWorld(),
  capabilities: CAPABILITIES,
  spaces: [{
    name: "work-space", space_id: "0199dddd-0000-7000-8000-00000000cccc", title: "Work", description: "Where work is done.", visibility: "private",
    join_policy: "request", status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: OWNER,
    contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-18T09:00:00.000Z",
    access: { role: "owner", tags: [], read: true, post: true },
  }],
  posts: {
    "work-space": [{
      post_id: "0199dddd-0000-7000-8000-0000000000a1", space: "work-space", space_id: "0199dddd-0000-7000-8000-00000000cccc", seq: "1", kind: "result", author: OWNER,
      posted_at: "2026-10-03T10:00:00.000Z", title: "Slim fails on arm64: 3 of 3 runs", body: "The long working.", to: [], reply_to: null,
      supersedes: null, retracts: null, fingerprints: [], signed: false,
    }],
  },
};
const base = service(world);
const { fake, handleRequest } = await site((call: Call) =>
  call.method === "POST" && call.url.pathname === "/v1/spaces/work-space/posts"
    ? json({ post_id: "0199dddd-0000-7000-8000-000000000001", seq: "1" }, 201) : base(call));
const { cookie, csrf } = await signedIn(OWNER, "absent-token", "192.0.2.97");

describe("a service that publishes no kinds without a title", () => {
  test("is sent an untitled post as it was typed, and the form tells the scripts nothing to check", async () => {
    const res = await handleRequest(new Request(`${SITE}/me/spaces/work-space/posts`, {
      method: "POST",
      headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, kind: "obs", title: "", body: "No title." }).toString(),
    }), env);
    assert.equal(res.status, 303, await res.text());
    const sent = fake.calls.filter((c) => c.method === "POST" && c.url.pathname === "/v1/spaces/work-space/posts");
    assert.equal(sent.length, 1);
    assert.ok(!("title" in JSON.parse(sent[0]!.body!)));

    const page = await handleRequest(new Request(`${SITE}/me/spaces/work-space`, { headers: { Cookie: cookie } }), env);
    const text = await page.text();
    const forms = tags(text).filter((t) => t.name === "form" && t.attributes.some(([k]) => k === "data-sign"));
    assert.ok(forms.length >= 1);
    for (const form of forms) assert.ok(!form.attributes.some(([k]) => k === "data-untitled-kinds"), "no list, no check in the browser");
    for (const form of forms) assert.ok(!form.attributes.some(([k]) => k === "data-max-summary-bytes"));
    assert.ok(!tags(text).some((t) => t.attributes.some(([k, v]) => k === "name" && v === "summary")), "no summary field before the service states a limit");
  });

  test("is offered a retraction form that says nothing of a title, since it does not ask for one", async () => {
    const res = await handleRequest(new Request(`${SITE}/me/spaces/work-space/1`, { headers: { Cookie: cookie } }), env);
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 300));
    const retraction = /<h2>Retract this post, saying why<\/h2>[\s\S]*?<\/form>/.exec(text)?.[0] ?? "";
    assert.match(retraction, /<label>Title\n<input type="text" name="title"/);
    assert.doesNotMatch(retraction, /needed here/);
  });

  test("is sent no summary, even from a form that carries one, since it would drop it or refuse it", async () => {
    const res = await handleRequest(new Request(`${SITE}/me/spaces/work-space/posts`, {
      method: "POST",
      headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, kind: "obs", title: "A title", summary: "A summary nobody offered.", body: "Text." }).toString(),
    }), env);
    assert.equal(res.status, 303, await res.text());
    const sent = fake.calls.filter((c) => c.method === "POST" && c.url.pathname === "/v1/spaces/work-space/posts");
    assert.ok(!("summary" in JSON.parse(sent.at(-1)!.body!)));
  });
});
