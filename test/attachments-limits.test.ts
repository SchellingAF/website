// The limits on a post's files are the service's own, read from its capability document:
// the fields on the form, the sentence beside them, the attributes src/sign-post.js holds a
// file to, and what the site refuses before it uploads anything. Its own file, because the
// site holds the service's capabilities for the life of the process; the other cases are in
// attachments-form.test.ts.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, json, service, type Call, type Json, type World } from "./lib/service.ts";
import { tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const WRITER = "c3d4".repeat(16);
const LIMITS = { file_bytes: 1000, per_post: 2, bytes_per_post: 2000, name_bytes: 255, media_type_bytes: 127, pending_hours: 24, bytes_per_key_per_day: 8388608, bytes_per_key_first_day: 2097152, attached_bytes_per_space: 268435456 };
const world: World = {
  capabilities: { ...CAPABILITIES, modules: { ...CAPABILITIES.modules, attachments: { status: "available" } }, limits: { ...CAPABILITIES.limits, attachments: LIMITS } },
  spaces: [{
    name: "small-files", space_id: "0199c0c0-0000-7000-8000-000000000001", title: "The small-files", description: "Small files.", visibility: "public", join_policy: "request",
    status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: OWNER,
    contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-10-02T09:00:00.000Z", access: { tags: [], read: true, post: true, role: "writer" },
  } as Json],
  posts: { "small-files": [] }, versions: {}, proofs: {}, checkpoints: { "small-files": [] }, peers: {},
} as World;
const base = service(world);
const { fake, handleRequest } = await site((call: Call) => {
  if (call.method === "PUT") return json({ space: "small-files", sha256: call.url.pathname.split("/").pop(), bytes: 1, pending_until: "x" }, 201);
  if (call.method === "POST" && call.url.pathname === "/v1/spaces/small-files/posts") return json({ post_id: "0199c0c0-0000-7000-8000-0000000000aa", seq: "1" }, 201);
  return base(call);
});
const { cookie, csrf } = await signedIn(WRITER, "writer-token", "192.0.2.142");
const { attachmentLimits } = await import("../src/capabilities.ts");

async function send(files: [string, File][]) {
  const data = new FormData();
  for (const [k, v] of Object.entries({ csrf, kind: "result", title: "T", body: "B" })) data.set(k, v);
  for (const [field, f] of files) data.append(field, f);
  const res = await handleRequest(new Request(`${SITE}/me/spaces/small-files/posts`, { method: "POST", headers: { Origin: SITE, Cookie: cookie }, body: data }), env);
  return { res, text: await res.text() };
}
const file = (name: string, size: number) => new File([new Uint8Array(size).fill(97)], name, { type: "text/plain" });

describe("a service that takes two files of a thousand bytes", () => {
  test("the form has two file fields and says the limits in the service's numbers", async () => {
    const html = await (await handleRequest(new Request(`${SITE}/me/spaces/small-files`, { headers: { Cookie: cookie } }), env)).text();
    const inputs = tags(html).filter((t) => t.name === "input" && t.attributes.some(([k, v]) => k === "type" && v === "file"));
    assert.deepEqual(inputs.map((t) => t.attributes.find(([k]) => k === "name")![1]), ["file1", "file2"]);
    const form = tags(html).find((t) => t.name === "form" && t.attributes.some(([k]) => k === "data-sign"))!;
    assert.ok(form.attributes.some(([k, v]) => k === "data-max-files" && v === "2"));
    assert.ok(form.attributes.some(([k, v]) => k === "data-max-file-bytes" && v === "1000"));
    assert.match(html, /Up to 2 files, each at most 1,000 bytes, are uploaded to this space with the post\./);
  });

  test("the site refuses what is over those numbers before it uploads anything", async () => {
    fake.calls.length = 0;
    const big = await send([["file1", file("big.txt", 1001)]]);
    assert.equal(big.res.status, 400);
    assert.match(big.text, /The file big\.txt is 1,001 bytes, and a file is at most 1,000\. Nothing was posted\./);
    const three = await send([["file1", file("a.txt", 1)], ["file2", file("b.txt", 2)], ["file3", file("c.txt", 3)]]);
    assert.equal(three.res.status, 400);
    assert.match(three.text, /A post carries at most 2 files, and this one has 3\. Nothing was posted\./);
    assert.equal(fake.calls.filter((c) => c.method === "PUT" || (c.method === "POST" && c.url.pathname.endsWith("/posts"))).length, 0);
    const fits = await send([["file1", file("a.txt", 1000)], ["file2", file("b.txt", 999)]]);
    assert.equal(fits.res.status, 303);
    assert.equal(fake.calls.filter((c) => c.method === "PUT").length, 2);
  });
});

describe("what the site takes from a capability document", () => {
  const caps = (modules: Json, limits: Json) => ({ ...CAPABILITIES, modules: { ...CAPABILITIES.modules, ...modules }, limits: { ...CAPABILITIES.limits, ...limits } }) as never;
  test("limits only when the module is available, and sane limits at that", () => {
    assert.deepEqual(attachmentLimits(caps({ attachments: { status: "available" } }, { attachments: LIMITS })), { perPost: 2, fileBytes: 1000 });
    assert.equal(attachmentLimits(caps({ attachments: { status: "planned" } }, { attachments: LIMITS })), null);
    assert.equal(attachmentLimits(caps({ attachments: { status: "available" } }, { attachments: null })), null);
    assert.equal(attachmentLimits(caps({}, {})), null, "a document with neither: no guess");
    for (const bad of [{ ...LIMITS, per_post: 0 }, { ...LIMITS, per_post: 33 }, { ...LIMITS, per_post: 1.5 }, { ...LIMITS, file_bytes: "1000" }, { ...LIMITS, file_bytes: 1_048_577 }, { ...LIMITS, file_bytes: -1 }]) {
      assert.equal(attachmentLimits(caps({ attachments: { status: "available" } }, { attachments: bad })), null, JSON.stringify(bad));
    }
  });
});
