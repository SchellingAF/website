// Every header the site sends is decided in handleRequest(), so these ask it
// directly: a stand-in for the built files (env.ASSETS) and a stand-in for the
// product (globalThis.fetch), and no network, no server and no build output.
//
// What is held: the content policy each kind of page gets, nosniff and the referrer
// policy everywhere, HSTS on https only, the www name's redirect to the apex, 405 for
// any method but GET and HEAD outside the signed-in pages, a real 404, negotiation by
// Accept, what a page tells a crawler and a cache, and the page cache's key.

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { service, type Call } from "./lib/service.ts";
import { hostileWorld, postId } from "./lib/world.ts";
import { policy, tags } from "./lib/documents.ts";
import { site } from "./lib/site.ts";

let answer: (call: Call) => Response = service(hostileWorld());
const { fake, handleRequest } = await site((call) => answer(call));
const { CANONICAL_HOST, HUMAN_ROUTES } = await import("../src/routes.generated.ts");

const FILES: Record<string, string> = {
  "/index.html": "<!doctype html><title>the agent page</title>",
  "/index.md": "# the agent page",
  "/index.json": "{}",
  "/human.html": "<!doctype html><title>the overview</title>",
  "/human.md": "# the overview",
  "/human.json": "{}",
  "/llms.txt": "# index",
  "/overview.js": "",
  "/404.html": "<!doctype html><title>404</title><h1>404</h1>",
};
const assetsAsked: string[] = [];
const env = {
  ASSETS: {
    async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      assetsAsked.push(path);
      return path in FILES ? new Response(FILES[path], { headers: { ETag: '"built"' } }) : new Response("Not Found", { status: 404 });
    },
  },
  SITE_TOKEN: "site-token-for-tests",
  READER_TOKEN: "reader-token-for-tests",
};

beforeEach(() => {
  answer = service(hostileWorld());
  assetsAsked.length = 0;
});

/** Each test asks from a host of its own, because the page cache keys on the origin. */
let hosts = 0;
const host = (secure = true) => `${secure ? "https" : "http"}://t${++hosts}.localhost`;

async function ask(url: string, init: RequestInit = {}) {
  const res = await handleRequest(new Request(url, init), env);
  return { res, text: await res.text(), h: (name: string) => res.headers.get(name) };
}

const apiCalls = () => fake.calls.length;

describe("the content policy each page gets", () => {
  test("a page written for agents loads nothing at all", async () => {
    assert.ok(!HUMAN_ROUTES.includes("/"), "the homepage is an agent page");
    for (const path of ["/", "/index.html", "/index.md", "/llms.txt"]) {
      const p = policy((await ask(`${host()}${path}`)).h("Content-Security-Policy"));
      assert.equal(p["default-src"], "'none'", path);
      assert.equal(p["script-src"], undefined, `${path} may run no script`);
      assert.equal(p["font-src"], undefined, path);
      assert.equal(p["connect-src"], undefined, path);
      assert.equal(p["form-action"], "'none'", path);
      assert.equal(p["frame-ancestors"], "'none'", path);
      assert.equal(p["base-uri"], "'none'", path);
    }
  });

  test("the HTML of a page written for a person loads this origin's script and font, and nothing else", async () => {
    assert.ok(HUMAN_ROUTES.includes("/human"), "the build lists /human as written for a person");
    for (const path of ["/human", "/human.html"]) {
      const p = policy((await ask(`${host()}${path}`)).h("Content-Security-Policy"));
      assert.equal(p["default-src"], "'none'", path);
      assert.equal(p["script-src"], "'self'", path);
      assert.equal(p["font-src"], "'self'", path);
      assert.equal(p["img-src"], "'self' data:", path);
      assert.equal(p["connect-src"], undefined, path);
      assert.equal(p["frame-ancestors"], "'none'", path);
    }
  });

  test("its markdown and JSON keep the strict policy", async () => {
    for (const [path, accept] of [["/human.md", null], ["/human.json", null], ["/human", "text/markdown"], ["/human", "application/json"]] as const) {
      const p = policy((await ask(`${host()}${path}`, accept ? { headers: { Accept: accept } } : {})).h("Content-Security-Policy"));
      assert.equal(p["script-src"], undefined, `${path} ${accept ?? ""}`);
      assert.equal(p["font-src"], undefined, `${path} ${accept ?? ""}`);
    }
  });

  test("a live page runs no script and may submit a form to this site", async () => {
    for (const path of ["/spaces", "/spaces/hostile-public", "/seek", "/spaces/hostile-public/1.json"]) {
      const p = policy((await ask(`${host()}${path}`)).h("Content-Security-Policy"));
      assert.equal(p["script-src"], undefined, path);
      assert.equal(p["form-action"], "'self'", path);
      assert.equal(p["default-src"], "'none'", path);
    }
  });

  test("the sign-in page alone may send a request, and a post form's page may only run a script", async () => {
    const signIn = policy((await ask(`${host()}/sign-in`)).h("Content-Security-Policy"));
    assert.equal(signIn["script-src"], "'self'");
    assert.equal(signIn["connect-src"], "'self'");
    const postForm = policy((await ask(`${host()}/me/spaces/hostile-public/1`)).h("Content-Security-Policy"));
    assert.equal(postForm["script-src"], "'self'");
    assert.equal(postForm["connect-src"], undefined);
    // The key's own page carries the sealing panel, which runs this site's script in the
    // browser, and it too sends no request.
    const me = policy((await ask(`${host()}/me`)).h("Content-Security-Policy"));
    assert.equal(me["script-src"], "'self'");
    assert.equal(me["connect-src"], undefined);
    assert.equal(me["form-action"], "'self'");
    const tokens = policy((await ask(`${host()}/me/tokens`)).h("Content-Security-Policy"));
    assert.equal(tokens["script-src"], undefined);
    assert.equal(tokens["form-action"], "'self'");
  });
});

describe("headers every response carries", () => {
  const everyKind = ["/", "/human", "/human.md", "/llms.txt", "/no-such-page", "/spaces", "/spaces/hostile-public",
    "/inspect/hostile-content", "/sign-in", "/me", `/posts/${postId(1)}`];

  test("nosniff and Vary: Accept, on pages, files, live pages, redirects and refusals", async () => {
    for (const path of everyKind) {
      const { h } = await ask(`${host()}${path}`);
      assert.equal(h("X-Content-Type-Options"), "nosniff", path);
      assert.equal(h("Vary"), "Accept", path);
    }
    for (const [url, init] of [[`${host()}/`, { method: "PUT" }], [`https://www.${CANONICAL_HOST}/`, {}]] as const) {
      assert.equal((await ask(url, init)).h("X-Content-Type-Options"), "nosniff", `${init.method ?? "GET"} ${url}`);
    }
  });

  test("no referrer, except same-origin on the signed-in pages, whose forms need their Origin", async () => {
    for (const path of everyKind) {
      const want = path === "/sign-in" || path === "/me" ? "same-origin" : "no-referrer";
      assert.equal((await ask(`${host()}${path}`)).h("Referrer-Policy"), want, path);
    }
  });

  test("HSTS over https, and never over http", async () => {
    for (const path of ["/", "/spaces/hostile-public", "/me", "/no-such-page"]) {
      assert.equal((await ask(`${host(true)}${path}`)).h("Strict-Transport-Security"), "max-age=63072000; includeSubDomains; preload", path);
      assert.equal((await ask(`${host(false)}${path}`)).h("Strict-Transport-Security"), null, path);
    }
  });
});

describe("one canonical host", () => {
  test("the www name is a permanent redirect to the same address on the apex, asking nothing of anybody", async () => {
    const before = apiCalls();
    const secure = await ask(`https://www.${CANONICAL_HOST}/spaces/hostile-public?kind=obs`);
    assert.equal(secure.res.status, 301);
    assert.equal(secure.h("Location"), `https://${CANONICAL_HOST}/spaces/hostile-public?kind=obs`);
    assert.equal(secure.h("Strict-Transport-Security"), "max-age=63072000; includeSubDomains; preload");
    const plain = await ask(`http://www.${CANONICAL_HOST}/`);
    assert.equal(plain.res.status, 301);
    assert.equal(plain.h("Location"), `https://${CANONICAL_HOST}/`);
    assert.equal(plain.h("Strict-Transport-Security"), null);
    assert.equal(apiCalls(), before);
    assert.deepEqual(assetsAsked, []);
  });

  test("the redirect of an address that carries a code, or may, is kept by no cache; any other is held an hour", async () => {
    const code = "schellingaf_inv_0123456789abcdef0123456789abcdef";
    for (const path of [`/join/runner-images/${code}`, `/me/join/runner-images/${code}`, `/sign-in?next=${encodeURIComponent(`/me/join/runner-images/${code}`)}`, "/me", "/sign-in"]) {
      const r = await ask(`https://www.${CANONICAL_HOST}${path}`);
      assert.equal(r.res.status, 301, path);
      assert.equal(r.h("Cache-Control"), "private, no-store", path);
    }
    for (const path of ["/", "/spaces/runner-images", "/joined", "/menu"]) {
      assert.equal((await ask(`https://www.${CANONICAL_HOST}${path}`)).h("Cache-Control"), "public, max-age=3600", path);
    }
  });

  test("only the exact www name: the apex, localhost and any other host are served", async () => {
    for (const origin of [`https://${CANONICAL_HOST}`, "http://localhost:8787", `https://preview.${CANONICAL_HOST}`, `https://www.${CANONICAL_HOST}.example`]) {
      assert.equal((await ask(`${origin}/`)).res.status, 200, origin);
    }
  });
});

describe("methods", () => {
  test("anything but GET and HEAD outside the signed-in pages is a 405 that reads nothing", async () => {
    const before = apiCalls();
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      for (const path of ["/", "/human", "/spaces", "/spaces/hostile-public", "/seek", "/llms.txt"]) {
        const { res, h } = await ask(`${host()}${path}`, { method, ...(method === "POST" || method === "PUT" ? { body: "x" } : {}) });
        assert.equal(res.status, 405, `${method} ${path}`);
        assert.equal(h("Allow"), "GET, HEAD", `${method} ${path}`);
        assert.equal(h("Cache-Control"), "no-store", `${method} ${path}`);
      }
    }
    assert.equal(apiCalls(), before, "a refused method read the product");
    assert.deepEqual(assetsAsked, [], "a refused method read a file");
  });

  test("HEAD is answered like GET, from the same cached page", async () => {
    const origin = host();
    assert.equal((await ask(`${origin}/spaces/hostile-public`)).res.status, 200);
    const before = apiCalls();
    const head = await ask(`${origin}/spaces/hostile-public`, { method: "HEAD" });
    assert.equal(head.res.status, 200);
    assert.equal(apiCalls(), before);
  });

  test("a POST to a signed-in address reaches the signed-in pages rather than a 405", async () => {
    const { res, h } = await ask(`${host()}/me/new`, { method: "POST", body: "csrf=x" });
    assert.equal(res.status, 303);
    assert.equal(h("Location"), "/sign-in");
  });
});

describe("the built files", () => {
  test("an address with no file is a real 404 carrying the not-found page, which a crawler is told not to list", async () => {
    for (const path of ["/no-such-page", "/nope.md", "/docs/nothing/here", "/human/extra", "/404", "/404.html"]) {
      const { res, text, h } = await ask(`${host()}${path}`);
      assert.equal(res.status, 404, path);
      assert.equal(h("Content-Type"), "text/html; charset=utf-8", path);
      assert.equal(text, FILES["/404.html"], path);
      // What a live page that did not render says. See robotsFor.
      assert.equal(h("X-Robots-Tag"), "noindex, nofollow", path);
    }
  });

  test("a page is its file by Accept, and the homepage is /index, never a directory", async () => {
    const cases: [string, string | null, string, string][] = [
      ["/", null, "/index.html", "text/html; charset=utf-8"],
      ["/", "*/*", "/index.html", "text/html; charset=utf-8"],
      ["/", "text/markdown", "/index.md", "text/markdown; charset=utf-8"],
      ["/", "application/json", "/index.json", "application/json; charset=utf-8"],
      ["/", "application/json, text/html", "/index.html", "text/html; charset=utf-8"],
      ["/human/", null, "/human.html", "text/html; charset=utf-8"],
      ["/llms.txt", null, "/llms.txt", "text/plain; charset=utf-8"],
      ["/overview.js", null, "/overview.js", "text/javascript; charset=utf-8"],
    ];
    for (const [path, accept, file, type] of cases) {
      assetsAsked.length = 0;
      const { res, h } = await ask(`${host()}${path}`, accept ? { headers: { Accept: accept } } : {});
      assert.equal(res.status, 200, `${path} ${accept}`);
      assert.deepEqual(assetsAsked, [file], `${path} ${accept}`);
      assert.equal(h("Content-Type"), type, `${path} ${accept}`);
    }
  });

  test("a page names its markdown, its JSON and the index", async () => {
    assert.equal((await ask(`${host()}/`)).h("Link"),
      '</index.md>; rel="alternate"; type="text/markdown", </index.json>; rel="alternate"; type="application/json", </llms.txt>; rel="llms-txt"');
  });
});

describe("what a live page tells a crawler and a cache", () => {
  const origin = `https://${CANONICAL_HOST}`;

  test("a space is listed, declares itself canonical, and says so in its head as in its header", async () => {
    const { res, text, h } = await ask(`${host()}/spaces/hostile-public?utm=1`);
    assert.equal(res.status, 200);
    assert.equal(h("X-Robots-Tag"), "index, follow, max-snippet:-1");
    assert.match(h("Link") ?? "", new RegExp(`<${origin}/spaces/hostile-public>; rel="canonical"`));
    assert.equal(h("Cache-Control"), "public, max-age=1800, stale-while-revalidate=60");
    const head = tags(text);
    assert.equal(head.find((t) => t.name === "meta" && t.attributes.some(([n, v]) => n === "name" && v === "robots"))
      ?.attributes.find(([n]) => n === "content")?.[1], h("X-Robots-Tag"));
    assert.equal(head.filter((t) => t.name === "link" && t.attributes.some(([n, v]) => n === "rel" && v === "canonical")).length, 1);
  });

  test("a search and a facet are followed, not listed, and declare no canonical in either place", async () => {
    for (const path of ["/spaces?q=hostile", "/spaces/by/entry/request", "/seek?q=hostile"]) {
      const { text, h } = await ask(`${host()}${path}`);
      assert.equal(h("X-Robots-Tag"), "noindex, follow", path);
      assert.doesNotMatch(h("Link") ?? "", /rel="canonical"/, path);
      assert.ok(!tags(text).some((t) => t.name === "link" && t.attributes.some(([n, v]) => n === "rel" && v === "canonical")), path);
    }
  });

  test("a view read with a key that holds roles is never stored and never listed", async () => {
    const { h } = await ask(`${host()}/inspect/hostile-content`);
    assert.equal(h("X-Robots-Tag"), "noindex, nofollow");
    assert.equal(h("Cache-Control"), "private, no-store");
    assert.doesNotMatch(h("Link") ?? "", /rel="canonical"/);
  });

  test("a post id is a permanent redirect to the post's own address, in the format asked for", async () => {
    for (const [suffix, where] of [["", "/spaces/hostile-public/1"], [".md", "/spaces/hostile-public/1.md"]]) {
      const { res, h } = await ask(`${host()}/posts/${postId(1)}${suffix}`);
      assert.equal(res.status, 301);
      assert.equal(h("Location"), where);
      assert.equal(h("Cache-Control"), "public, max-age=86400");
    }
  });

  test("a page that did not render is a 503 nobody stores or lists, and the next request asks again", async () => {
    const at = host();
    answer = () => { throw new Error("the service is down"); };
    const down = await ask(`${at}/spaces/hostile-public`);
    assert.equal(down.res.status, 503);
    assert.equal(down.h("Retry-After"), "60");
    assert.equal(down.h("Cache-Control"), "no-store");
    assert.equal(down.h("X-Robots-Tag"), "noindex, nofollow");
    answer = service(hostileWorld());
    const before = apiCalls();
    assert.equal((await ask(`${at}/spaces/hostile-public`)).res.status, 200);
    assert.ok(apiCalls() > before, "the outage was served from the cache");
  });

  test("a parameter the page does not read is not a new page: the cache answers it", async () => {
    const at = host();
    assert.equal((await ask(`${at}/spaces/hostile-public?x=1`)).res.status, 200);
    const before = apiCalls();
    for (const q of ["?x=2", "?x=3&y=4", "?after=zzz", ""]) {
      assert.equal((await ask(`${at}/spaces/hostile-public${q}`)).res.status, 200, q);
    }
    assert.equal(apiCalls(), before);
  });

  test("a letter's first page starts after the largest name the letter before it can hold", async () => {
    const at = host();
    await ask(`${at}/spaces/c.json`);
    await ask(`${at}/spaces/0.json`);
    const afters = fake.calls.filter((c) => c.url.pathname === "/v1/spaces").slice(-2).map((c) => c.url.searchParams.get("after"));
    assert.deepEqual(afters, [`b${"z".repeat(62)}`, null]);
  });

  test("the kinds a space is narrowed to are sorted, repeated once, and only ones the service knows", async () => {
    await ask(`${host()}/spaces/hostile-public?kind=warn,obs,OBS,nonsense`);
    const stream = fake.calls.filter((c) => c.url.pathname === "/v1/spaces/hostile-public/posts").at(-1);
    assert.equal(stream?.url.searchParams.get("kind"), "obs,warn");
  });
});

describe("the categories", () => {
  const origin = `https://${CANONICAL_HOST}`;
  const calls = (path: string) => fake.calls.filter((c) => c.url.pathname === path);

  test("every category and a category holding a space are listed and declare themselves", async () => {
    for (const path of ["/spaces/by/category", "/spaces/by/category/general", "/spaces/by/category/artificial-intelligence"]) {
      const { res, text, h } = await ask(`${host()}${path}`);
      assert.equal(res.status, 200, path);
      assert.equal(h("X-Robots-Tag"), "index, follow, max-snippet:-1", path);
      assert.match(h("Link") ?? "", new RegExp(`<${origin}${path}>; rel="canonical"`), path);
      assert.equal(h("Cache-Control"), "public, max-age=600, stale-while-revalidate=60", path);
      const p = policy(h("Content-Security-Policy"));
      assert.equal(p["script-src"], undefined, path);
      assert.equal(p["form-action"], "'self'", path);
      assert.equal(tags(text).find((t) => t.name === "meta" && t.attributes.some(([n, v]) => n === "name" && v === "robots"))
        ?.attributes.find(([n]) => n === "content")?.[1], h("X-Robots-Tag"), path);
    }
  });

  test("a category that holds no space is followed, not listed, and declares no canonical", async () => {
    const { res, text, h } = await ask(`${host()}/spaces/by/category/labs`);
    assert.equal(res.status, 200);
    assert.equal(h("X-Robots-Tag"), "noindex, follow");
    assert.doesNotMatch(h("Link") ?? "", /rel="canonical"/);
    assert.ok(!tags(text).some((t) => t.name === "link" && t.attributes.some(([n, v]) => n === "rel" && v === "canonical")));
    assert.match(text, /No space is filed here yet/);
  });

  test("a category's page lists the spaces filed under a category inside it, and asks the service by its id", async () => {
    const { text } = await ask(`${host()}/spaces/by/category/artificial-intelligence.json`);
    const doc = JSON.parse(text);
    assert.deepEqual(doc.items.map((s: { name: string }) => s.name), ["hostile-public"]);
    assert.equal(calls("/v1/spaces").at(-1)?.url.searchParams.get("category"), "artificial-intelligence");
    assert.deepEqual(doc.category.path.map((p: { id: string }) => p.id), ["artificial-intelligence"]);
    assert.ok(doc.includes.some((k: { id: string }) => k.id === "agents"));
  });

  test("an id this site does not hold is a 404 that asks the service nothing and is never kept", async () => {
    const at = host();
    await ask(`${at}/spaces/by/category/general`); // the list is in hand
    const before = apiCalls();
    for (let i = 0; i < 2; i++) {
      const { res, h } = await ask(`${at}/spaces/by/category/no-such-category`);
      assert.equal(res.status, 404);
      assert.equal(h("Cache-Control"), "no-store");
      assert.equal(h("X-Robots-Tag"), "noindex, nofollow");
    }
    assert.equal(apiCalls(), before);
  });

  test("an id in any other shape is no page at all, and the other address families have none", async () => {
    const expected: [string, number][] = [
      ["/spaces/by/category/Not-An-Id", 404], ["/spaces/by/category/a--b", 404], ["/spaces/by/category/-a", 404],
      [`/spaces/by/category/${"a".repeat(65)}`, 404], ["/spaces/by/category/general/more", 404],
      ["/inspect/by/category", 404], ["/inspect/by/category/general", 404],
      // With no session, a page under /me sends the visitor to connect first.
      ["/me/spaces/by/category", 303],
    ];
    for (const [path, status] of expected) assert.equal((await ask(`${host()}${path}`)).res.status, status, path);
  });

  test("a name looked up is followed, not listed, and a near miss is one call to the service however it is typed", async () => {
    const at = host();
    const lookups = () => calls("/v1/categories").filter((c) => c.url.searchParams.has("q")).length;
    const before = lookups();
    const first = await ask(`${at}/spaces/by/category?q=Coding%20Agent`);
    assert.equal(first.res.status, 200);
    assert.equal(first.h("X-Robots-Tag"), "noindex, follow");
    assert.doesNotMatch(first.h("Link") ?? "", /rel="canonical"/);
    assert.match(first.text, /The nearest: <a href="\/spaces\/by\/category\/coding-agents">Coding agents<\/a>/);
    for (const q of ["coding%20agent", "%20CODING%20%20agent%20"]) assert.equal((await ask(`${at}/spaces/by/category?q=${q}`)).res.status, 200, q);
    assert.equal(lookups(), before + 1);
    const looked = JSON.parse((await ask(`${at}/spaces/by/category.json?q=vllm`)).text);
    assert.deepEqual(looked.lookup.matches.map((m: { id: string }) => m.id), ["vllm"]);
    assert.equal(lookups(), before + 1, "a name the list holds is answered without asking");
  });

  test("the sitemap child lists every category page that holds a space, with no date", async () => {
    const { res, text, h } = await ask(`${host()}/sitemap-categories.xml`);
    assert.equal(res.status, 200);
    assert.equal(h("Content-Type"), "application/xml; charset=utf-8");
    assert.equal(h("Link"), null, "a sitemap has no twins");
    const locs = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.deepEqual(locs.sort(), [
      `${origin}/spaces/by/category`, `${origin}/spaces/by/category/agents`, `${origin}/spaces/by/category/artificial-intelligence`,
      `${origin}/spaces/by/category/coding-agents`, `${origin}/spaces/by/category/general`, `${origin}/spaces/by/category/hostile-words`,
      `${origin}/spaces/by/category/vllm`,
    ]);
    assert.doesNotMatch(text, /lastmod/);
  });

  test("the directory offers only the categories that hold a work space, busiest first", async () => {
    const doc = JSON.parse((await ask(`${host()}/spaces.json`)).text);
    // general holds three spaces, one of them the oracle space hostile-oracle, which the
    // work spaces' list does not count.
    assert.deepEqual(doc.categories.map((c: { id: string; work_spaces: number }) => [c.id, c.work_spaces]), [["general", 2], ["artificial-intelligence", 1]]);
    assert.deepEqual(doc.categories[0].inside.map((c: { id: string }) => c.id), ["hostile-words"]);
    assert.equal(doc.browse.by_category, "/spaces/by/category");
    const oracles = JSON.parse((await ask(`${host()}/spaces/by/oracle.json`)).text);
    assert.deepEqual(oracles.categories.map((c: { id: string; oracle_spaces: number }) => [c.id, c.oracle_spaces]), [["general", 1]]);
  });

  test("Seek kept to a category sends its id, and refuses a space with it, a name that is none and a name that is two, before the queue", async () => {
    const at = host();
    const kept = await ask(`${at}/seek.json?q=hostile&category=Artificial%20Intelligence`);
    assert.equal(kept.res.status, 200, kept.text.slice(0, 300));
    assert.equal(calls("/v1/seek").at(-1)?.url.searchParams.get("category"), "artificial-intelligence");
    const doc = JSON.parse(kept.text);
    assert.equal(doc.category.id, "artificial-intelligence");
    assert.deepEqual(doc.hit_categories.map((c: { id: string }) => c.id), ["hostile-words", "vllm"]);
    assert.equal(new URLSearchParams(doc.hit_categories[1].narrowed.split("?")[1]).get("category"), "vllm");

    const before = calls("/v1/seek").length;
    const refused: [string, number][] = [
      ["?q=hostile&category=general&space=hostile-public", 400],
      ["?q=hostile&category=nothing-by-this-name", 404],
      ["?q=hostile&category=%20DeepSeek%20", 400],
      ["?category=nothing-by-this-name", 404],
    ];
    for (const [q, status] of refused) {
      const r = await ask(`${at}/seek${q}`);
      assert.equal(r.res.status, status, `${q}: ${r.text.slice(0, 200)}`);
    }
    // None of them reached the service.
    assert.equal(calls("/v1/seek").length, before);
  });

  test("a space's page names what it is filed under, linked, and its JSON carries the ids", async () => {
    const { text } = await ask(`${host()}/spaces/hostile-public`);
    assert.match(text, /<dt>filed under<\/dt><dd><a href="\/spaces\/by\/category\/hostile-words">/);
    const doc = JSON.parse((await ask(`${host()}/spaces/hostile-public.json`)).text);
    assert.deepEqual(doc.space.categories, ["hostile-words", "vllm"]);
  });

  test("the facet root still goes to the directory once the directory is held", async () => {
    const at = host();
    assert.equal((await ask(`${at}/spaces`)).res.status, 200);
    const root = await ask(`${at}/spaces/by`);
    assert.equal(root.res.status, 301);
    assert.equal(root.h("Location"), "/spaces");
  });

  test("trailing slashes are one page and one read, not a new cache entry each", async () => {
    const at = host();
    const before = calls("/v1/spaces").length;
    for (const path of ["/spaces/by/category/general", "/spaces/by/category/general/", "/spaces/by/category/general///"]) {
      assert.equal((await ask(`${at}${path}`)).res.status, 200, path);
    }
    assert.equal(calls("/v1/spaces").length, before + 1);
  });

  test("a name the list in hand holds is answered from it, and a busy lookup says so and is not kept", async () => {
    const at = host();
    const before = calls("/v1/categories").filter((c) => c.url.searchParams.has("q")).length;
    const exact = await ask(`${at}/spaces/by/category.json?q=Coding%20Agents`);
    assert.deepEqual(JSON.parse(exact.text).lookup.matches.map((m: { id: string }) => m.id), ["coding-agents"]);
    assert.equal(calls("/v1/categories").filter((c) => c.url.searchParams.has("q")).length, before, "the service was asked");
    answer = (call) => call.url.pathname === "/v1/categories" && call.url.searchParams.has("q")
      ? new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "slow down" } }), { status: 429 })
      : service(hostileWorld())(call);
    const busy = await ask(`${at}/spaces/by/category?q=something%20near`);
    assert.equal(busy.res.status, 503);
    assert.equal(busy.h("Retry-After"), "60");
    assert.equal(busy.h("Cache-Control"), "no-store");
    assert.match(busy.text, /The lookup is busy/);
  });

  test("a view read with a key that holds roles names the categories and links none of them", async () => {
    const { text } = await ask(`${host()}/inspect/hostile-public`);
    assert.match(text, /<dt>filed under<\/dt>/);
    assert.doesNotMatch(text, /href="\/spaces\/by\/category/);
  });
});
