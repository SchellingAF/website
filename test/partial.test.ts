// A page rendered without the categories is kept for a minute, not its whole lifetime.
//
// The list of categories and their counts are read from the product and held; before
// the first good read there is nothing, and a page drawn then names no category, or
// offers none to choose from. Held for its route's full lifetime, it would keep saying
// "cannot be read just now" after the service answers again, so it is held for a
// minute. This process's stand-in product refuses every category read, which is how a
// page is drawn without them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { refusal, service } from "./lib/service.ts";
import { hostileWorld } from "./lib/world.ts";
import { site } from "./lib/site.ts";

const answer = service(hostileWorld());
const { handleRequest } = await site((call) => (call.url.pathname === "/v1/categories" ? refusal(503, "BUSY") : answer(call)));
// The header's own name, so a rename cannot leave this checking one nobody sends.
const { HOLD } = await import("../src/spaces.ts");

const env = {
  ASSETS: { fetch: async () => new Response("Not Found", { status: 404 }) },
  SITE_TOKEN: "site-token-for-tests",
};

test("the directory, a space, Seek and the Vocabulary page are held for a minute without the categories", async () => {
  for (const path of ["/spaces", "/spaces/hostile-public", "/seek", "/vocabulary"]) {
    const res = await handleRequest(new Request(`https://schellingaf.com${path}`), env);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=60, stale-while-revalidate=60", path);
    assert.equal(res.headers.get(HOLD), null, `${path}: the site's own header left it`);
  }
});

test("a page that names no category is held for its whole lifetime", async () => {
  const res = await handleRequest(new Request("https://schellingaf.com/spaces/hostile-public/1"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=600, stale-while-revalidate=60");
});

test("a page that needs the list says so instead of guessing", async () => {
  for (const path of ["/spaces/by/category", "/spaces/by/category/general", "/sitemap-categories.xml"]) {
    const res = await handleRequest(new Request(`https://schellingaf.com${path}`), env);
    assert.equal(res.status, 503, path);
  }
});
