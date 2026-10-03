// Every read of a space's posts asks for the old versions of a document too.
//
// The product leaves a replaced, declined or out-of-date version out of `GET .../posts`
// unless asked (`old_versions=true`), and four pages here show posts by their number: a
// space's page, a post's own page, its replies and the archive. Each names the parameter,
// so a version that is no longer the document's is still on its address. A product that
// does not know the name ignores it, which the stand-in does. The standing read, which
// has no versions, and the export, which the product refuses it on, never carry it.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { service } from "./lib/service.ts";
import { hostileWorld } from "./lib/world.ts";
import { env, site } from "./lib/site.ts";

const { fake, handleRequest } = await site(service(hostileWorld()));

let hosts = 0;
const host = () => `https://v${++hosts}.localhost`;
const postReads = () => fake.calls.filter((c) => /^\/v1\/spaces\/[^/]+\/posts$/.test(c.url.pathname));

async function ask(path: string) {
  const before = postReads().length;
  const res = await handleRequest(new Request(`${host()}${path}`), env);
  await res.text();
  return { res, reads: postReads().slice(before) };
}

describe("old versions of a document", () => {
  for (const [what, path] of [
    ["a space's page", "/spaces/hostile-public"],
    ["a post's own page", "/spaces/hostile-public/3"],
    ["a post's replies", "/spaces/hostile-public/2/replies"],
    ["the archive", "/spaces/hostile-public/all"],
    ["the archive kept to a kind", "/spaces/hostile-public/all?kind=result"],
  ] as const) {
    test(`${what} asks for them on every read of the posts`, async () => {
      const { res, reads } = await ask(path);
      assert.equal(res.status, 200);
      assert.ok(reads.length >= 1, "the posts were read");
      for (const read of reads) assert.equal(read.url.searchParams.get("old_versions"), "true", read.url.href);
    });
  }

  test("the other reads of the service carry no such name", async () => {
    await ask("/spaces/hostile-public/standing");
    await ask("/spaces/hostile-public");
    const others = fake.calls.filter((c) => !/^\/v1\/spaces\/[^/]+\/posts$/.test(c.url.pathname));
    assert.ok(others.some((c) => /\/standing$/.test(c.url.pathname)), "the standing read was made");
    for (const call of others) assert.equal(call.url.searchParams.has("old_versions"), false, call.url.href);
  });
});
