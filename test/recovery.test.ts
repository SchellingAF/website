// The service's recovery notices, as a page: what it signed after a restore lost part
// of a space's record. Each is checked by src/verify.ts, and the page shows what the
// service signed, never its parsed copy beside it. Empty, it says so and is not
// offered to search engines.

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { CAPABILITIES, service, type Call, type World } from "./lib/service.ts";
import { mintNotice, type KeyPair } from "./lib/notice.ts";
import { htmlProblems, markdownProblems } from "./lib/documents.ts";
import { env, site } from "./lib/site.ts";

const keys = { service: generateKeyPairSync("ed25519") as KeyPair, root: generateKeyPairSync("ed25519") as KeyPair };
const world = (recovery: World["recovery"]): World =>
  ({ capabilities: CAPABILITIES, spaces: [], posts: {}, proofs: {}, checkpoints: {}, peers: {}, recovery });
let answer: (call: Call) => Response = service(world([]));
const { handleRequest } = await site((call) => answer(call));
beforeEach(() => { answer = service(world([])); });

let hosts = 0;
const host = () => `https://n${++hosts}.localhost`;

async function ask(url: string) {
  const res = await handleRequest(new Request(url), env);
  return { res, text: await res.text(), h: (n: string) => res.headers.get(n) };
}

describe("the recovery notices", () => {
  test("a notice that holds says so, and links the space closed and the one it continues in", async () => {
    answer = service(world([mintNotice(keys)]));
    const { res, text, h } = await ask(`${host()}/recovery`);
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.equal(h("X-Robots-Tag"), "index, follow, max-snippet:-1");
    assert.match(text, /This site checked its signature and its signing key&#39;s certificate\./);
    assert.match(text, /<a href="\/spaces\/long-space">long-space<\/a> is closed\. It continues in <a href="\/spaces\/long-space-2">long-space-2<\/a>\./);
    assert.match(text, /Reason given: a restore from the backup of 14 September/);
    assert.deepEqual(htmlProblems(text), []);
    const doc = JSON.parse((await ask(`${host()}/recovery.json`)).text);
    assert.equal(doc.notices[0].checked_by_this_site, true);
    assert.equal(doc.notices[0].signed.spaces[0].continues_in, "long-space-2");
  });

  test("a notice changed after signing says this site could not confirm it, and why", async () => {
    const changed = { ...mintNotice(keys), service_epoch: "9" };
    answer = service(world([changed]));
    const { text } = await ask(`${host()}/recovery`);
    assert.match(text, /This site could not confirm this notice\./);
    assert.match(text, /The signed service epoch is not the one shown\./);
    const md = (await ask(`${host()}/recovery.md`)).text;
    assert.match(md, /^NOT CONFIRMED: This site could not confirm this notice\.$/m);
    assert.deepEqual(markdownProblems(md), []);
  });

  test("with no notice, says so and is followed, not listed", async () => {
    const { res, text, h } = await ask(`${host()}/recovery`);
    assert.equal(res.status, 200);
    assert.equal(h("X-Robots-Tag"), "noindex, follow");
    assert.match(text, /The service has signed no recovery notice\./);
  });

  test("a service that cannot answer is a 503 nobody keeps", async () => {
    answer = () => new Response("down", { status: 500 });
    const { res, h } = await ask(`${host()}/recovery`);
    assert.equal(res.status, 503);
    assert.equal(h("Cache-Control"), "no-store");
  });
});
