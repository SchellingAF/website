// Every module in src/ loads.
//
// npm run build never loads src/, so a syntax error there would pass the build and the
// Docker image and meet the first request after a deploy. Each server
// module is imported here as serve.mjs would import it, with fetch refusing every
// request, because a module that talks to the product while it loads is a defect
// of its own. The scripts written for the browser cannot run in Node: they
// reach for document, window and navigator as they load -- copy.js asks the page
// for its blocks on the last line it runs -- and sign-post.js imports
// /jcs.js and /post-object.js, and sign-in.js and new-token.js /sign-in-challenge.js,
// by the address the browser fetches it from. Node reads each of those for its syntax instead, without
// running it; test/sign-in-challenge.test.ts runs sign-in.js and new-token.js
// against a stand-in page. sealed-store.js and sealed-page.js import /sealed.js by that
// address too, and are read the same way; sealed.js itself, the product's module byte
// for byte, loads in Node and test/sealed.test.ts runs it.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { API, stubFetch } from "./lib/service.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const BROWSER_ONLY = new Set(["sign-in.js", "sign-post.js", "overview.js", "copy.js", "allow.js", "new-token.js", "sealed-store.js", "sealed-page.js"]);
const modules = readdirSync(SRC).filter((f) => /\.(ts|js)$/.test(f)).sort();

test("the build has written src/routes.generated.ts, which the handler imports", () => {
  assert.ok(existsSync(path.join(SRC, "routes.generated.ts")), "run node build.mjs first; npm test does");
});

test("the browser scripts are still where the build copies them from", () => {
  assert.deepEqual([...BROWSER_ONLY].filter((f) => !modules.includes(f)), []);
});

process.env.API_ORIGIN = API;
const fake = stubFetch(() => { throw new Error("a module asked the product for something while it loaded"); });
after(() => fake.restore());

for (const file of modules.filter((f) => !BROWSER_ONLY.has(f))) {
  test(`src/${file} loads, and asks the product for nothing while it does`, async () => {
    await import(pathToFileURL(path.join(SRC, file)).href);
    assert.deepEqual(fake.calls.map((c) => c.url.pathname), []);
  });
}

for (const file of [...BROWSER_ONLY].filter((f) => modules.includes(f))) {
  test(`src/${file}, a browser script, is valid JavaScript`, () => {
    const check = spawnSync(process.execPath, ["--check", path.join(SRC, file)], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  });
}
