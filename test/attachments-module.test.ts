// A service that does not take files yet: the post form is the plain one it was, with no
// file field and no word about files, and a form that arrives carrying a file is refused
// in the site's own words with nothing sent. Its own file, because the site holds the
// service's capabilities for the life of the process.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, json, service, type Call, type Json, type World } from "./lib/service.ts";
import { tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const WRITER = "c3d4".repeat(16);
const world: World = {
  capabilities: { ...CAPABILITIES, modules: { ...CAPABILITIES.modules, attachments: { status: "planned" } } },
  spaces: [{
    name: "no-files", space_id: "0199c0c0-0000-7000-8000-000000000001", title: "The no-files", description: "No files yet.", visibility: "public", join_policy: "request",
    status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: OWNER,
    contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-10-02T09:00:00.000Z", access: { tags: [], read: true, post: true, role: "writer" },
  } as Json],
  posts: { "no-files": [] }, versions: {}, proofs: {}, checkpoints: { "no-files": [] }, peers: {},
} as World;
const base = service(world);
const { fake, handleRequest } = await site((call: Call) => {
  if (call.method === "POST" && call.url.pathname === "/v1/spaces/no-files/posts") return json({ post_id: "0199c0c0-0000-7000-8000-0000000000aa", seq: "1" }, 201);
  return base(call);
});
const { cookie, csrf } = await signedIn(WRITER, "writer-token", "192.0.2.143");

describe("a service that takes no files", () => {
  test("the post form is the plain one: no file field, no multipart, no word about files", async () => {
    const html = await (await handleRequest(new Request(`${SITE}/me/spaces/no-files`, { headers: { Cookie: cookie } }), env)).text();
    assert.deepEqual(tags(html).filter((t) => t.name === "input" && t.attributes.some(([k, v]) => k === "type" && v === "file")), []);
    assert.doesNotMatch(html, /enctype=|data-max-file|each at most|uploaded to this space/);
  });

  test("a form that carries a file is refused with nothing sent, and a form that does not is posted", async () => {
    fake.calls.length = 0;
    const data = new FormData();
    for (const [k, v] of Object.entries({ csrf, kind: "result", title: "T", body: "Kept words." })) data.set(k, v);
    data.append("file1", new File(["a"], "a.txt", { type: "text/plain" }));
    const res = await handleRequest(new Request(`${SITE}/me/spaces/no-files/posts`, { method: "POST", headers: { Origin: SITE, Cookie: cookie }, body: data }), env);
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.match(text, /The service takes no files right now, so nothing was posted\./);
    assert.match(text, /Kept words\./);
    assert.equal(fake.calls.filter((c) => c.method === "PUT" || (c.method === "POST" && c.url.pathname.endsWith("/posts"))).length, 0);

    const plain = await handleRequest(new Request(`${SITE}/me/spaces/no-files/posts`, {
      method: "POST", headers: { Origin: SITE, Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, kind: "result", title: "T", body: "Plain." }),
    }), env);
    assert.equal(plain.status, 303);
  });
});
