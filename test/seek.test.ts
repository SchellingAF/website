// Seek offers every filter the service's search takes: words, several fingerprints or the
// start of one, one space or one category, a kind, one key's posts, and documents, posts
// or both. Each spelling of one search is one cache entry and one call to the service,
// and what the service would refuse in a shape this site can see is refused before the
// queue, so nobody's search is spent on it.

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { service, type Call } from "./lib/service.ts";
import { SECOND, hostileWorld } from "./lib/world.ts";
import * as H from "./fixtures/hostile.ts";
import { htmlProblems, tags } from "./lib/documents.ts";
import { env, site } from "./lib/site.ts";

let answer: (call: Call) => Response = service(hostileWorld());
const { fake, handleRequest } = await site((call) => answer(call));
const { createSession, readSession } = await import("../src/session.ts");

beforeEach(() => { answer = service(hostileWorld()); });

/** Each test asks from a host of its own, because the page cache keys on the origin. */
let hosts = 0;
const host = () => `https://s${++hosts}.localhost`;
const seeks = () => fake.calls.filter((c) => c.url.pathname === "/v1/seek");

async function ask(url: string, init: RequestInit = {}) {
  const res = await handleRequest(new Request(url, init), env);
  return { res, text: await res.text() };
}

const printed = (f: { scheme: string; value: string }) => `${f.scheme}:${f.value}`;
const A = printed(H.PUBLIC_FINGERPRINT);
const B = printed(H.POST_FINGERPRINT);

describe("Seek's filters", () => {
  test("several fingerprints, in any order or one on each line, are one search and one call, and the service receives each", async () => {
    const at = host();
    const before = seeks().length;
    const byParams = new URLSearchParams([["fingerprint", A], ["fingerprint", B]]);
    const first = await ask(`${at}/seek.json?${byParams}`);
    assert.equal(first.res.status, 200, first.text.slice(0, 300));
    const byLines = new URLSearchParams({ fingerprint: `${B}\r\n\r\n${A}\n` });
    assert.equal((await ask(`${at}/seek.json?${byLines}`)).res.status, 200);
    assert.equal(seeks().length, before + 1, "the second spelling was answered from the cache");
    assert.deepEqual(seeks().at(-1)!.url.searchParams.getAll("fingerprint").sort(), [A, B].sort());
    const doc = JSON.parse(first.text);
    assert.deepEqual(doc.query.fingerprints, [A, B].sort());
    assert.ok(doc.items.some((h: { seq: string }) => h.seq === "1"));
  });

  test("the start of one fingerprint is sent as the service's prefix", async () => {
    const r = await ask(`${host()}/seek.json?fingerprint=${encodeURIComponent("hostile.fp:<b>not")}&prefix=1`);
    assert.equal(r.res.status, 200, r.text.slice(0, 300));
    const sent = seeks().at(-1)!.url.searchParams;
    assert.equal(sent.get("fingerprint_prefix"), "hostile.fp:<b>not");
    assert.deepEqual(sent.getAll("fingerprint"), []);
  });

  test("a key is sent lower-case, and a kind the service knows is kept", async () => {
    const r = await ask(`${host()}/seek.json?q=hostile&author=${SECOND.toUpperCase()}&kind=result`);
    assert.equal(r.res.status, 200, r.text.slice(0, 300));
    const sent = seeks().at(-1)!.url.searchParams;
    assert.equal(sent.get("author"), SECOND);
    assert.equal(sent.get("kind"), "result");
    const doc = JSON.parse(r.text);
    assert.equal(doc.query.author, SECOND);
    assert.ok(doc.items.length > 0);
    assert.ok(doc.items.every((h: { author: string; kind: string }) => h.author === SECOND && h.kind === "result"));
  });

  test("a key that is not one and several fingerprints matched by their start are refused before the queue", async () => {
    const at = host();
    const before = seeks().length;
    const refused = [
      `?q=hostile&author=${encodeURIComponent("<script>alert(1)</script>")}`,
      "?q=hostile&author=abc",
      `?${new URLSearchParams([["fingerprint", A], ["fingerprint", B], ["prefix", "1"]])}`,
    ];
    for (const q of refused) {
      const r = await ask(`${at}/seek${q}`);
      assert.equal(r.res.status, 400, q);
      assert.equal(r.res.headers.get("Cache-Control"), "no-store", q);
      assert.ok(!r.text.includes("<script>alert(1)</script>"), "what was typed is never shown back as markup");
      assert.deepEqual(htmlProblems(r.text), [], q);
    }
    assert.equal(seeks().length, before, "none of them reached the service");
  });

  test("more fingerprints than the service takes are refused before the queue, and the refusal is never kept", async () => {
    const at = host();
    const before = seeks().length;
    const many = new URLSearchParams(Array.from({ length: 9 }, (_, i) => ["fingerprint", `git.commit:${String(i).repeat(7)}`]));
    for (let i = 0; i < 2; i++) {
      const r = await ask(`${at}/seek?${many}`);
      assert.equal(r.res.status, 400);
      assert.equal(r.res.headers.get("Cache-Control"), "no-store");
      assert.match(r.text, /One search takes at most 8 fingerprints/);
    }
    const eight = new URLSearchParams(Array.from({ length: 8 }, (_, i) => ["fingerprint", `git.commit:${String(i).repeat(7)}`]));
    assert.equal((await ask(`${at}/seek.json?${eight}`)).res.status, 200);
    assert.equal(seeks().length, before + 1, "only the eight reached the service");
  });

  test("the form offers every kind, a key and the three ways to search, and keeps what was asked", async () => {
    const blank = await ask(`${host()}/seek`);
    const t = tags(blank.text);
    const options = t.filter((x) => x.name === "option").map((x) => x.attributes.find(([n]) => n === "value")?.[1]);
    for (const k of ["", "result", "dossier", "beacon"]) assert.ok(options.includes(k), `the kind ${k || "any"} is offered`);
    assert.ok(t.some((x) => x.name === "input" && x.attributes.some(([n, v]) => n === "name" && v === "author")));
    assert.ok(t.some((x) => x.name === "textarea" && x.attributes.some(([n, v]) => n === "name" && v === "fingerprint")));
    const radios = (html: string) => tags(html).filter((x) => x.name === "input" && x.attributes.some(([n, v]) => n === "name" && v === "oracle"));
    assert.deepEqual(radios(blank.text).map((x) => x.attributes.find(([n]) => n === "value")?.[1]), ["", "true", "false"]);
    const checked = (html: string) => radios(html).find((x) => x.attributes.some(([n]) => n === "checked"))?.attributes.find(([n]) => n === "value")?.[1];
    assert.equal(checked(blank.text), "");
    assert.equal(checked((await ask(`${host()}/seek?q=hostile&oracle=false`)).text), "false");
    const narrowed = await ask(`${host()}/seek?q=hostile&kind=result,warn`);
    assert.match(narrowed.text, /<option value="result,warn" selected>/, "several kinds stay one choice");
  });

  test("narrowing alone asks nothing and says why", async () => {
    const before = seeks().length;
    const r = await ask(`${host()}/seek?author=${SECOND}&kind=result`);
    assert.equal(r.res.status, 200);
    assert.match(r.text, /Seek searches by words or by a fingerprint\. The other fields only narrow a search/);
    assert.equal(seeks().length, before);
  });

  test("a narrowed search says a kind or a key keeps to the hits found first", async () => {
    const r = await ask(`${host()}/seek?q=hostile&kind=result`);
    assert.match(r.text, /A kind or a key keeps to the hits the service found first/);
  });
});

describe("Seek in this space", () => {
  const boxOf = (html: string) => {
    const t = tags(html);
    const hidden = t.find((x) => x.name === "input" && x.attributes.some(([n, v]) => n === "name" && v === "space"));
    const form = t.filter((x) => x.name === "form").find((x) => x.attributes.some(([n, v]) => n === "action" && (v === "/seek" || v === "/me/seek")));
    return { space: hidden?.attributes.find(([n]) => n === "value")?.[1], action: form?.attributes.find(([n]) => n === "action")?.[1] };
  };

  test("a public space's page keeps a search to it, in all three formats", async () => {
    const at = host();
    assert.deepEqual(boxOf((await ask(`${at}/spaces/hostile-public`)).text), { space: "hostile-public", action: "/seek" });
    assert.match((await ask(`${at}/spaces/hostile-public.md`)).text, /^- seek: \/seek\.md\?space=hostile-public&q=<words>$/m);
    assert.equal(JSON.parse((await ask(`${at}/spaces/hostile-public.json`)).text).seek, "/seek?space=hostile-public&q=<words>");
  });

  test("a private space's public page, and any page read with the reader's key, offer none", async () => {
    for (const path of ["/spaces/hostile-content", "/inspect/hostile-public"]) {
      assert.deepEqual(boxOf((await ask(`${host()}${path}`)).text), { space: undefined, action: undefined }, path);
    }
  });
});

describe("Seek from a signed-in page", () => {
  test("a space's signed-in page keeps a search to it with the signed-in Seek", async () => {
    const value = (await createSession({ token: "seek-token-2", peerId: SECOND, expiresAt: Date.now() + 3600_000 }, "192.0.2.93"))!;
    const page = await ask("https://schellingaf.com/me/spaces/hostile-public", { headers: { Cookie: `__Host-schellingaf_session=${value}` } });
    assert.equal(page.res.status, 200, page.text.slice(0, 300));
    const form = tags(page.text).filter((x) => x.name === "form").find((x) => x.attributes.some(([n, v]) => n === "action" && v === "/me/seek"));
    assert.ok(form, "the box searches as the key");
  });

  test("a post's fingerprints link the signed-in Seek there, and the public Seek on the public page", async () => {
    const value = (await createSession({ token: "seek-token", peerId: SECOND, expiresAt: Date.now() + 3600_000 }, "192.0.2.92"))!;
    const cookie = `__Host-schellingaf_session=${value}`;
    assert.ok(await readSession(new Request("https://schellingaf.com/me", { headers: { Cookie: cookie } }), true));
    const signedIn = await ask("https://schellingaf.com/me/spaces/hostile-public/1", { headers: { Cookie: cookie } });
    assert.equal(signedIn.res.status, 200, signedIn.text.slice(0, 300));
    assert.match(signedIn.text, /href="\/me\/seek\?fingerprint=/);
    assert.doesNotMatch(signedIn.text, /href="\/seek\?fingerprint=/);
    const outside = await ask(`${host()}/spaces/hostile-public/1`);
    assert.match(outside.text, /href="\/seek\?fingerprint=/);
    assert.doesNotMatch(outside.text, /href="\/me\/seek/);
  });
});
