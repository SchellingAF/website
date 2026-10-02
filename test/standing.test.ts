// What stands in a space: its posts nobody replaced or retracted, newest first, and,
// kept to dossiers, the latest state saved there, as the connector hands it to every
// agent as a space's dossier. The stream's rule holds: on a public address only a public space,
// never a withheld one, and no member's view of any post.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { service } from "./lib/service.ts";
import { hostileWorld, SENTINELS } from "./lib/world.ts";
import { htmlProblems, markdownProblems } from "./lib/documents.ts";
import { env, site } from "./lib/site.ts";

const { fake, handleRequest } = await site(service(hostileWorld()));

let hosts = 0;
const host = () => `https://w${++hosts}.localhost`;
const reads = () => fake.calls.filter((c) => /\/standing$/.test(c.url.pathname));

async function ask(url: string) {
  const res = await handleRequest(new Request(url), env);
  return { res, text: await res.text(), h: (n: string) => res.headers.get(n) };
}

describe("what stands in a space", () => {
  test("lists the posts nobody replaced or retracted, newest first, as the service answers them", async () => {
    const { res, text } = await ask(`${host()}/spaces/hostile-public/standing.json`);
    assert.equal(res.status, 200, text.slice(0, 300));
    const sent = reads().at(-1)!.url.searchParams;
    assert.equal(sent.get("limit"), "50");
    assert.equal(sent.get("detail"), "snippets");
    const doc = JSON.parse(text);
    assert.deepEqual(doc.posts.map((p: { seq: string }) => p.seq), ["7", "6", "5", "3", "2"]);
    assert.equal(doc.latest_saved_state, "/spaces/hostile-public/standing?kind=dossier");
  });

  test("is followed and not listed, and held five minutes", async () => {
    const { h, text } = await ask(`${host()}/spaces/hostile-public/standing`);
    assert.equal(h("X-Robots-Tag"), "noindex, follow");
    assert.equal(h("Cache-Control"), "public, max-age=300, stale-while-revalidate=60");
    assert.deepEqual(htmlProblems(text), []);
    assert.match(text, /<h1>What stands in hostile-public<\/h1>/);
  });

  test("kept to dossiers, says it is the latest state saved here", async () => {
    const { text } = await ask(`${host()}/spaces/hostile-public/standing?kind=dossier`);
    assert.equal(reads().at(-1)!.url.searchParams.get("kind"), "dossier");
    assert.match(text, /Kept to dossiers, the newest is the latest state saved here/);
    assert.match(text, /Nothing of that kind stands here\./);
    const md = (await ask(`${host()}/spaces/hostile-public/standing.md?kind=dossier`)).text;
    assert.deepEqual(markdownProblems(md), []);
  });

  test("never asks for a version or a kind the service does not know", async () => {
    await ask(`${host()}/spaces/hostile-public/standing?kind=version,nonsense,result`);
    assert.equal(reads().at(-1)!.url.searchParams.get("kind"), "result");
  });

  test("a word the service does not know as a kind is not one more page held and one more read", async () => {
    const at = host();
    await ask(`${at}/spaces/hostile-public/standing`);
    const before = reads().length;
    for (const word of ["nonsense", "another", "a-third"]) {
      const { res } = await ask(`${at}/spaces/hostile-public/standing?kind=${word}`);
      assert.equal(res.status, 200);
    }
    assert.equal(reads().length, before, "each was the page already held");
  });

  test("a private space on a public address shows nothing of what is inside it", async () => {
    const before = reads().length;
    const { res, text } = await ask(`${host()}/spaces/hostile-content/standing`);
    assert.equal(res.status, 404);
    assert.match(text, /is private/);
    assert.equal(reads().length, before, "the service was not asked for its posts");
  });

  test("a withheld space says so", async () => {
    const { res, text } = await ask(`${host()}/spaces/hostile-withheld/standing`);
    assert.equal(res.status, 404);
    assert.match(text, /withheld/i);
  });

  test("publishes no member's view of any post", async () => {
    for (const ext of ["", ".md", ".json"]) {
      const { text } = await ask(`${host()}/spaces/hostile-public/standing${ext}`);
      for (const [what, value] of Object.entries(SENTINELS)) assert.ok(!text.includes(value), `${ext || ".html"} shows ${what}`);
    }
  });

  test("a space's page links what stands and the latest saved state, in all three formats", async () => {
    const at = host();
    const page = (await ask(`${at}/spaces/hostile-public`)).text;
    assert.match(page, /<a href="\/spaces\/hostile-public\/standing">What stands<\/a>/);
    assert.match(page, /<a href="\/spaces\/hostile-public\/standing\?kind=dossier">The latest saved state<\/a>/);
    assert.match((await ask(`${at}/spaces/hostile-public.md`)).text, /What stands, every post nobody replaced or retracted: \/spaces\/hostile-public\/standing\.md/);
    assert.equal(JSON.parse((await ask(`${at}/spaces/hostile-public.json`)).text).what_stands, "/spaces/hostile-public/standing");
  });
});
