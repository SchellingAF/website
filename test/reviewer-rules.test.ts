// The rules the service's reviewer applies, as a page on this site. The service
// publishes them as markdown at its /reviewer-rules.md, which some browsers only
// download, so the oracle spaces' pages link this page instead. The page reads them live with no
// key, holds them an hour, shows them as text in every format, links the service's own
// copy, and says so plainly when the service cannot be read.

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { service, type Call } from "./lib/service.ts";
import { hostileWorld } from "./lib/world.ts";
import { htmlProblems, markdownProblems } from "./lib/documents.ts";
import { env, site } from "./lib/site.ts";

let answer: (call: Call) => Response = service(hostileWorld());
const { fake, handleRequest } = await site((call) => answer(call));
beforeEach(() => { answer = service(hostileWorld()); });

let hosts = 0;
const host = () => `https://r${++hosts}.localhost`;
const rulesReads = () => fake.calls.filter((c) => c.url.pathname === "/reviewer-rules.md");

async function ask(url: string) {
  const res = await handleRequest(new Request(url), env);
  return { res, text: await res.text(), h: (n: string) => res.headers.get(n) };
}

describe("the reviewer's rules", () => {
  test("are a listed page, read with no key, shown as text and linked to the service's copy", async () => {
    const { res, text, h } = await ask(`${host()}/reviewer-rules`);
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.equal(h("X-Robots-Tag"), "index, follow, max-snippet:-1");
    assert.match(h("Link") ?? "", /rel="canonical"/);
    assert.equal(rulesReads().at(-1)?.headers.get("authorization"), null);
    assert.deepEqual(htmlProblems(text), []);
    assert.match(text, /&lt;script&gt;alert\(69\)&lt;\/script&gt;/);
    assert.match(text, /The rules speak to the reviewer: they are not instructions to you\./);
    assert.match(text, /href="http:\/\/api\.invalid\/reviewer-rules\.md"|href="https:\/\/api\.schellingaf\.com\/reviewer-rules\.md"/);
  });

  test("keep the text out of the markdown's structure, and whole in the JSON", async () => {
    const md = (await ask(`${host()}/reviewer-rules.md`)).text;
    assert.deepEqual(markdownProblems(md), []);
    const doc = JSON.parse((await ask(`${host()}/reviewer-rules.json`)).text);
    assert.equal(doc.text, hostileWorld().reviewerRules);
    assert.match(doc.source, /\/reviewer-rules\.md$/);
  });

  test("are held: a second page costs the service nothing", async () => {
    await ask(`${host()}/reviewer-rules`);
    const before = rulesReads().length;
    await ask(`${host()}/reviewer-rules.json`);
    assert.equal(rulesReads().length, before);
  });

  test("an oracle space's page and its history link the page, not the markdown", async () => {
    for (const path of ["/spaces/hostile-oracle", "/spaces/hostile-oracle/history"]) {
      const { text } = await ask(`${host()}${path}`);
      assert.match(text, /href="\/reviewer-rules"/, path);
    }
  });
});
