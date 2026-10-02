// Every page the ledger names is reached by following links and GET forms, as a
// person does: from the menu for a visitor, from /me for a connected person.
// scripts/lib/reach.mjs is the crawl, which scripts/verify.sh and the signed-in probe
// run against a real product; here it is held to what it decides, and a visitor's crawl
// is run against the site's own handler and the hostile stand-in, so a public page that
// loses its only link fails here before any stack is started. The pages under /me need
// a product that answers for a key, and are the probe's.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { API, service, stubFetch } from "./lib/service.ts";
import { hostileWorld } from "./lib/world.ts";
import { compile, formReaches, isSearch, linkReaches, linksOf, menuOf, OUTSIDE, reach, shapeOf } from "../scripts/lib/reach.mjs";
import { operationPages } from "../content/api-overview.mjs";

process.env.API_ORIGIN = API;
const SITE = "https://schellingaf.com";
const fake = stubFetch(service(hostileWorld()));
const stubbed = globalThis.fetch;
const { handleRequest } = await import("../src/index.ts");
const env = {
  ASSETS: { fetch: async () => new Response("Not Found", { status: 404 }) },
  SITE_TOKEN: "site-token-for-tests",
  READER_TOKEN: "reader-token-for-tests",
};
// A site of four pages, one of which is too busy to answer.
const BUSY_SITE = "https://busy.localhost";
const PAGES: Record<string, string> = {
  "/": `<a href="/a">a</a> <a href="/b">b</a>`,
  "/b": `<a href="/c">c</a>`,
};
function busySite(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (path === "/a") return new Response("busy", { status: 503, headers: { "Retry-After": "60" } });
  const body = PAGES[path];
  return body === undefined ? new Response("", { status: 404 }) : new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// The crawl asks the site; the site asks the stand-in.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const origin = new URL(request.url).origin;
  return origin === SITE ? handleRequest(request, env) : origin === BUSY_SITE ? busySite(request) : stubbed(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = stubbed;
  fake.restore();
});

const LEDGER: string[] = [...new Set(Object.values(operationPages as Record<string, { pages?: string[] }>).flatMap((e) => e.pages ?? []))];
const url = (address: string) => new URL(address, SITE);
const form = (action: string, fields: Record<string, string[]>) => ({ action: url(action), fields: new Map(Object.entries(fields)) });

describe("what the crawl counts as reaching a page", () => {
  test("every page the ledger names is one the check can read, and a placeholder it does not know fails, naming it", () => {
    for (const page of LEDGER) assert.doesNotThrow(() => compile(page), page);
    assert.throws(() => compile("/spaces/<name>/<shelf>"), /<shelf> is no placeholder/);
  });

  test("a link reaches a page when its path has the page's shape and it carries each parameter the page names", () => {
    const post = compile("/spaces/<name>/<number>");
    assert.ok(linkReaches(post, url("/spaces/runner-images/12")));
    for (const no of ["/spaces/runner-images/0", "/spaces/runner-images/12/replies", "/spaces/AB/1", "/spaces/runner-images/01"]) {
      assert.ok(!linkReaches(post, url(no)), no);
    }
    const kind = compile("/spaces/<name>?kind=<kind>");
    assert.ok(linkReaches(kind, url("/spaces/runner-images?kind=obs")));
    assert.ok(!linkReaches(kind, url("/spaces/runner-images")));
    const latest = compile("/spaces/<name>/standing?kind=dossier");
    assert.ok(linkReaches(latest, url("/spaces/runner-images/standing?kind=dossier")));
    assert.ok(!linkReaches(latest, url("/spaces/runner-images/standing?kind=obs")), "a value the ledger writes out is that value");
    assert.ok(linkReaches(compile("/spaces/<name>/compare?from=<a>&to=<b>"), url("/spaces/runner-images/compare?to=4&from=1")));
    // Each way into a work space has a facet, posting without joining too, and nothing else is one.
    const facet = compile("/spaces/by/entry/<policy>");
    for (const policy of ["invite", "request", "open"]) assert.ok(linkReaches(facet, url(`/spaces/by/entry/${policy}`)), policy);
    assert.ok(!linkReaches(facet, url("/spaces/by/entry/opened")));
    // The page of keys blocked from posting in a space is one the ledger names, under /me.
    assert.ok(linkReaches(compile("/me/spaces/<name>/blocks"), url("/me/spaces/runner-images/blocks")));
  });

  test("a GET form reaches a page when it sends there with a field for each parameter, holding a value the ledger writes out", () => {
    const compare = compile("/spaces/<name>/compare?from=<a>&to=<b>");
    assert.ok(formReaches(compare, form("/spaces/runner-images/compare", { from: ["3"], to: ["4"] })));
    assert.ok(!formReaches(compare, form("/spaces/runner-images/compare", { from: ["3"] })));
    const latest = compile("/spaces/<name>/standing?kind=dossier");
    assert.ok(formReaches(latest, form("/spaces/runner-images/standing", { kind: ["", "obs", "dossier"] })));
    assert.ok(!formReaches(latest, form("/spaces/runner-images/standing", { kind: ["", "obs"] })));
  });

  test("a page's links and GET forms are its own site's, with their fields and choices; a POST form is not a way anywhere", () => {
    const { links, forms } = linksOf(`
      <a href="/spaces/a-space?kind=obs&amp;after=3">a</a> <a href="https://elsewhere.example/spaces/x">b</a> <a>no address</a>
      <form method="get" action="/spaces/a-space/compare"><input name="from" value="2"><select name="to"><option value="3">3</option><option value="4">4</option></select><textarea name="note"></textarea></form>
      <form method="post" action="/me/spaces/a-space"><input name="body"></form>`, url("/spaces/a-space"));
    assert.deepEqual(links.map((u: URL) => `${u.pathname}${u.search}`), ["/spaces/a-space?kind=obs&after=3"]);
    assert.equal(forms.length, 1);
    assert.equal(forms[0].action.pathname, "/spaces/a-space/compare");
    assert.deepEqual(Object.fromEntries(forms[0].fields), { from: ["2"], to: ["", "3", "4"], note: [""] });
  });

  test("an address is reduced to its kind, which is what bounds the crawl", () => {
    assert.equal(shapeOf(url("/spaces/runner-images/12?kind=obs&after=3")), "/spaces/NAME/#?after,kind");
    assert.equal(shapeOf(url(`/peers/${"ab".repeat(32)}`)), "/peers/KEY");
    assert.equal(shapeOf(url("/spaces/q")), "/spaces/C");
    assert.equal(shapeOf(url("/me/spaces/runner-images/history")), "/me/spaces/NAME/history");
  });

  test("a page the site answers busy is counted, so what only it leads to is known to be unread rather than unlinked", async () => {
    const { missing, busy, fetched } = await reach({ site: BUSY_SITE, pages: ["/c", "/d"], start: ["/"], fetchable: () => true, pause: 1 });
    assert.deepEqual(missing, ["/d"]);
    assert.equal(busy, 1);
    assert.equal(fetched, 4, "the menu page, the busy one, and the two it could read");
  });

  test("a search is noted where it is linked and never fetched", () => {
    for (const s of ["/seek?fingerprint=abc", "/me/seek?q=x", "/spaces?q=words", "/spaces/by/category?q=ai"]) assert.ok(isSearch(url(s)), s);
    for (const s of ["/seek", "/me/seek", "/spaces/runner-images?kind=obs"]) assert.ok(!isSearch(url(s)), s);
  });
});

describe("every page is reached, on the site's own pages", () => {
  test("a visitor reaches every page the ledger names from the menu, but the ones entered from outside and one only built files link", async () => {
    const seek = await handleRequest(new Request(`${SITE}/seek`), env);
    const start = menuOf(await seek.text(), url("/seek"));
    assert.deepEqual(start, ["/human", "/spaces", "/seek", "/vocabulary", "/", "/api", "/sign-in"]);
    const pages = LEDGER.filter((p) => !p.startsWith("/me") && !OUTSIDE.has(p));
    const { missing, fetched } = await reach({
      site: SITE, pages, start,
      fetchable: (u: URL) => !u.pathname.startsWith("/inspect") && !u.pathname.startsWith("/me") && u.pathname !== "/sign-out",
    });
    // The built pages are files, which this handler is given none of, and /llms.txt is
    // linked from them alone.
    assert.deepEqual(missing, ["/llms.txt"], `fetched ${fetched}`);
  });

  test("a page that loses its only link is named", async () => {
    const seek = await handleRequest(new Request(`${SITE}/seek`), env);
    const start = menuOf(await seek.text(), url("/seek")).filter((p: string) => p !== "/vocabulary");
    const { missing } = await reach({
      site: SITE, pages: ["/reviewer-rules", "/recovery", "/spaces/<name>/standing"], start,
      fetchable: (u: URL) => !u.pathname.startsWith("/inspect") && !u.pathname.startsWith("/me") && u.pathname !== "/vocabulary",
    });
    assert.deepEqual(missing, ["/recovery"], "the reviewer's rules are linked from an oracle space's pages too");
  });
});
