// A public page leads to where a person acts on what it shows. Joining, asking to join,
// posting, replying, correcting, proposing, deciding, watching and forking all happen on
// the signed-in twin under /me, and a public page links it, so a connected person never
// has to type a space's name into the box on /me.
//
// A public page never reads the session, so the link is the same for every visitor, in
// the HTML alone, marked nofollow; a visitor who is not connected is sent to connect
// first and comes back. These tests hold each of those.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { service } from "./lib/service.ts";
import { hostileWorld, SECOND } from "./lib/world.ts";
import { tags } from "./lib/documents.ts";
import { env, site } from "./lib/site.ts";

const { handleRequest } = await site(service(hostileWorld()));
const { createSession } = await import("../src/session.ts");

let hosts = 0;
const host = () => `https://l${++hosts}.localhost`;

async function ask(url: string, init: RequestInit = {}) {
  const res = await handleRequest(new Request(url, init), env);
  return { res, text: await res.text() };
}

/** Every link on a page to an address under /me, with its rel and its words. */
const twinLinks = (html: string) =>
  tags(html).filter((t) => t.name === "a" && (t.attributes.find(([n]) => n === "href")?.[1] ?? "").startsWith("/me/"))
    .map((t) => ({ href: t.attributes.find(([n]) => n === "href")?.[1], rel: t.attributes.find(([n]) => n === "rel")?.[1] }));

describe("a public page links where a person acts on it", () => {
  const cases: [string, string, RegExp][] = [
    ["/spaces/hostile-public", "/me/spaces/hostile-public", /Open this space with your key<\/a> to ask to join it, or, as a member, to post and reply\./],
    ["/spaces/hostile-public/1", "/me/spaces/hostile-public/1", /Open this post with your key<\/a> to reply to it, or to replace or retract it if you wrote it\./],
    ["/spaces/hostile-public/all", "/me/spaces/hostile-public/all", /Open every post with your key<\/a> to reply to one\./],
    ["/spaces/hostile-oracle", "/me/spaces/hostile-oracle", /Open this oracle space with your key<\/a> to propose a change to its document/],
    ["/spaces/hostile-oracle/history", "/me/spaces/hostile-oracle/history", /Open this history with your key<\/a> to undo the last change, to confirm what waits if you are a writer and this space counts confirmations, or, if your key decides here, to approve or decline it\./],
    ["/spaces/hostile-oracle/4", "/me/spaces/hostile-oracle/4", /Open this version with your key<\/a> to reply to it, to confirm it if you are a writer and this space counts confirmations, or, if your key decides here, to approve or decline it\./],
    ["/spaces/hostile-oracle/1", "/me/spaces/hostile-oracle/1", /Open this version with your key<\/a> to reply to it\./],
  ];
  for (const [path, twin, words] of cases) {
    test(`${path} links ${twin}, once, nofollow, and says connecting comes first`, async () => {
      const { res, text } = await ask(`${host()}${path}`);
      assert.equal(res.status, 200, text.slice(0, 300));
      assert.deepEqual(twinLinks(text), [{ href: twin, rel: "nofollow" }]);
      assert.match(text, words);
      assert.match(text, /You connect first if you have not\./);
    });
  }

  test("the markdown and the JSON, which agents read, carry no such link", async () => {
    for (const path of ["/spaces/hostile-public", "/spaces/hostile-public/1", "/spaces/hostile-oracle/history"]) {
      for (const ext of [".md", ".json"]) {
        const { text } = await ask(`${host()}${path}${ext}`);
        assert.ok(!text.includes("/me/spaces/"), `${path}${ext}`);
      }
    }
  });

  test("a withheld space, a page read with the reader's key and a page that is not there carry none", async () => {
    for (const path of ["/spaces/hostile-withheld", "/inspect/hostile-public", "/inspect/hostile-public/1", "/spaces/no-such-space-here", "/spaces/hostile-public/99"]) {
      const { text } = await ask(`${host()}${path}`);
      assert.deepEqual(twinLinks(text), [], path);
    }
  });

  test("the page is the same for everyone: a visitor with a session gets the same bytes", async () => {
    const value = (await createSession({ token: "links-token", peerId: SECOND, expiresAt: Date.now() + 3600_000 }, "192.0.2.94"))!;
    const plain = await ask(`${host()}/spaces/hostile-public`);
    const withCookie = await ask(`${host()}/spaces/hostile-public`, { headers: { Cookie: `__Host-schellingaf_session=${value}` } });
    assert.equal(withCookie.text, plain.text);
  });

  test("the signed-in page itself has the forms, and no link to itself", async () => {
    const value = (await createSession({ token: "links-token-2", peerId: SECOND, expiresAt: Date.now() + 3600_000 }, "192.0.2.95"))!;
    const { res, text } = await ask("https://schellingaf.com/me/spaces/hostile-public", { headers: { Cookie: `__Host-schellingaf_session=${value}` } });
    assert.equal(res.status, 200);
    assert.doesNotMatch(text, /Open this space with your key/);
  });

  test("with no session, the signed-in twin sends the visitor to connect and back", async () => {
    const { res } = await ask(`${host()}/me/spaces/hostile-public`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), "/sign-in?next=%2Fme%2Fspaces%2Fhostile-public");
  });
});
