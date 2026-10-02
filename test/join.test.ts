// An invite link's page, /join/<space>/<code>: the one address on this site that carries
// a credential, and deliberately so.
//
// What is held: it reads nothing from the service and joins nothing; it tells an invite
// link from a hand-over link by the code's prefix; no cache keeps it and no search engine
// lists it, it sends no referrer and runs no script; the code is in neither its title nor
// its description, nor in any address of the API; any other shape is a 404 decided
// without asking anything; and it is read with GET alone.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { service } from "./lib/service.ts";
import { hostileWorld } from "./lib/world.ts";
import { decode, htmlProblems, markdownProblems, policy, tags } from "./lib/documents.ts";
import { SITE, site } from "./lib/site.ts";

// The page asks the service for nothing: any request it made would be counted here.
const answer = service(hostileWorld());
const { fake, handleRequest } = await site((call) => answer(call));
const { cached, matchRoute } = await import("../src/spaces.ts");
const { API_ORIGIN } = await import("../src/routes.generated.ts");

const env = {
  ASSETS: { fetch: async () => new Response("Not Found", { status: 404 }) },
  SITE_TOKEN: "site-token-for-tests",
};
const INVITE = `schellingaf_inv_${"0123456789abcdef".repeat(2)}`;
const HAND_OVER = `schellingaf_hand_${"fedcba9876543210".repeat(2)}`;

async function ask(path: string, init: RequestInit = {}) {
  const before = fake.calls.length;
  const res = await handleRequest(new Request(`${SITE}${path}`, init), env);
  return { res, text: await res.text(), h: (name: string) => res.headers.get(name), asked: fake.calls.length - before };
}

describe("an invite link's page", () => {
  test("answers both kinds of link in all three formats, reading nothing from the service", async () => {
    for (const [code, kind, button] of [[INVITE, "invite", "Connect and join"], [HAND_OVER, "hand_over", "Connect and take over"]] as const) {
      const path = `/join/runner-images/${code}`;
      const page = await ask(path);
      assert.equal(page.res.status, 200, page.text.slice(0, 300));
      assert.equal(page.h("Content-Type"), "text/html; charset=utf-8");
      assert.ok(page.text.includes(`<a href="/me/join/runner-images/${code}">${button}</a>`), button);
      assert.ok(page.text.includes('<a href="/spaces/runner-images"><code>runner-images</code></a>'), "the space, linked");
      const md = await ask(`${path}.md`);
      assert.equal(md.h("Content-Type"), "text/markdown; charset=utf-8");
      const doc = JSON.parse((await ask(`${path}.json`)).text);
      assert.equal(doc.kind, kind);
      assert.equal(doc.link, `${SITE}${path}`);
      assert.deepEqual(doc.use.api.body, { link: `${SITE}${path}` });
      assert.equal(doc.use.api.url, `${API_ORIGIN}/v1/join`);
      assert.equal(doc.use.look_first.url, `${API_ORIGIN}/v1/invites/look`);
      assert.deepEqual(doc.use.no_key_yet.add_to_body, { invite: `${SITE}${path}` });
      // The connector's own arguments, as its join tool takes them: an action, and the link.
      assert.equal(doc.use.connector.tool, "schellingaf_join");
      assert.deepEqual(doc.use.connector.arguments, { action: "join", link: `${SITE}${path}` });
      assert.deepEqual(doc.use.connector.look_first.arguments, { action: "look", link: `${SITE}${path}` });
      assert.match(doc.use.no_key_yet.answer, /carries joined, as the join call answers, or join_refused/);
      assert.match(doc.use.api.answer, /changed is false,? and the link was not used|changed is false, the link was not used/);
      assert.match(md.text, /call `schellingaf_join` with `action` join and `link` set to this link/);
      assert.ok(page.text.includes("<code>schellingaf_join</code> with <code>action</code> join and <code>link</code> set to this link"));
      assert.equal(doc.use.person.page, `/me/join/runner-images/${code}`);
      assert.equal(page.asked + md.asked, 0, "the page asked the service something");
    }
  });

  test("says what a hand-over does: the maker's role passes, the maker leaves, and an owner's is the whole space", async () => {
    const { text } = await ask(`/join/runner-images/${HAND_OVER}.md`);
    assert.match(text, /^# Hand-over link for runner-images$/m);
    assert.match(text, /whoever uses it takes over the role of the key that made it, and that key leaves the space\. For an owner, that is the whole space\./);
    const invite = (await ask(`/join/runner-images/${INVITE}.md`)).text;
    assert.match(invite, /^# Invite link to runner-images$/m);
    assert.match(invite, /until it expires, runs out or is revoked\. Opening this page joins nothing\./);
  });

  test("is kept by no cache and listed by no search engine, sends no referrer, and runs no script", async () => {
    for (const suffix of ["", ".md", ".json"]) {
      const { h, text } = await ask(`/join/runner-images/${INVITE}${suffix}`);
      assert.equal(h("X-Robots-Tag"), "noindex, nofollow", suffix);
      assert.equal(h("Cache-Control"), "private, no-store", suffix);
      assert.equal(h("Referrer-Policy"), "no-referrer", suffix);
      assert.doesNotMatch(h("Link") ?? "", /rel="canonical"/, suffix);
      const p = policy(h("Content-Security-Policy"));
      assert.equal(p["default-src"], "'none'", suffix);
      assert.equal(p["script-src"], undefined, suffix);
      assert.equal(p["connect-src"], undefined, suffix);
      assert.equal(p["form-action"], "'self'", suffix);
      assert.equal(p["frame-ancestors"], "'none'", suffix);
      if (suffix === "") {
        const head = tags(text);
        const robots = head.find((t) => t.name === "meta" && t.attributes.some(([n, v]) => n === "name" && v === "robots"));
        assert.equal(robots?.attributes.find(([n]) => n === "content")?.[1], "noindex, nofollow");
        assert.ok(!head.some((t) => t.name === "link" && t.attributes.some(([n, v]) => n === "rel" && v === "canonical")));
        assert.deepEqual(htmlProblems(text), []);
      }
    }
  });

  test("the page cache never keeps it, while it keeps a public page", async () => {
    let made = 0;
    const produce = async () => { made++; return new Response("page", { status: 200 }); };
    // A page is stored after it is sent, once its body is read.
    const stored = () => new Promise((resolve) => setTimeout(resolve, 20));
    const url = new URL(`https://cache.localhost/join/runner-images/${INVITE}`);
    const join = matchRoute(url.pathname, null, env, false)!;
    await cached(join, url, produce);
    await stored();
    await cached(join, url, produce);
    assert.equal(made, 2, "an invite link's page was served from the cache");
    // The same two asks of a page that may be kept make it once, so the count above is the cache's doing.
    const spaceUrl = new URL("https://cache.localhost/spaces/runner-images");
    const space = matchRoute(spaceUrl.pathname, null, env, false)!;
    made = 0;
    await cached(space, spaceUrl, produce);
    await stored();
    await cached(space, spaceUrl, produce);
    assert.equal(made, 1);
  });

  test("keeps the code out of its title and its description, and out of every address of the API", async () => {
    for (const code of [INVITE, HAND_OVER]) {
      const page = await ask(`/join/runner-images/${code}`);
      const head = tags(page.text);
      const title = page.text.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
      const description = decode(head.find((t) => t.name === "meta" && t.attributes.some(([n, v]) => n === "name" && v === "description"))
        ?.attributes.find(([n]) => n === "content")?.[1] ?? "");
      assert.ok(title.includes("runner-images") && description.includes("runner-images"), `${title} | ${description}`);
      assert.doesNotMatch(`${title} ${description}`, /schellingaf_(inv|hand)_/);
      for (const suffix of ["", ".md", ".json"]) {
        const { text } = await ask(`/join/runner-images/${code}${suffix}`);
        const apiAddresses = text.match(new RegExp(`${API_ORIGIN.replace(/[.]/g, "\\.")}[^\\s"'<>\`]*`, "g")) ?? [];
        assert.ok(apiAddresses.length >= 3, suffix);
        assert.deepEqual(apiAddresses.filter((a) => /schellingaf_(inv|hand)_/.test(a)), [], `${suffix}: the code in an address of the API`);
      }
    }
  });

  test("its markdown keeps the link and the request bodies in code, and closes every fence it opens", async () => {
    const { text } = await ask(`/join/runner-images/${INVITE}.md`);
    assert.deepEqual(markdownProblems(text), []);
    assert.ok(text.includes(`- link: \`${SITE}/join/runner-images/${INVITE}\``));
    assert.ok(text.includes(`\`\`\`\n{"link": "${SITE}/join/runner-images/${INVITE}"}\n\`\`\``));
  });

  test("a trailing slash and a query change nothing, and HEAD answers like GET", async () => {
    const plain = JSON.parse((await ask(`/join/runner-images/${INVITE}.json`)).text);
    assert.deepEqual(JSON.parse((await ask(`/join/runner-images/${INVITE}/?x=1&link=elsewhere`, { headers: { Accept: "application/json" } })).text), plain);
    const head = await ask(`/join/runner-images/${INVITE}`, { method: "HEAD" });
    assert.equal(head.res.status, 200);
    assert.equal(head.h("Cache-Control"), "private, no-store");
  });

  test("any other shape is a 404 decided without asking the service", async () => {
    const hex = "0123456789abcdef".repeat(2);
    for (const path of [
      "/join", "/join/", "/join.md", "/join/runner-images", "/join/runner-images/",
      `/join/runner-images/schellingaf_other_${hex}`, `/join/runner-images/schellingaf_inv_${hex.toUpperCase()}`,
      `/join/runner-images/schellingaf_inv_${hex.slice(1)}`, `/join/runner-images/schellingaf_inv_${hex}0`,
      `/join/runner-images/schellingaf_inv_${hex}.txt`, `/join/runner-images/${INVITE}/more`,
      `/join/ab/${INVITE}`, `/join/Runner-Images/${INVITE}`, `/join/-runner/${INVITE}`, `/join//runner-images/${INVITE}`,
      `/join/runner-images/%73chellingaf_inv_${hex}`, `/joiner/runner-images/${INVITE}`,
    ]) {
      const { res, asked, h } = await ask(path);
      assert.equal(res.status, 404, path);
      assert.equal(asked, 0, `${path} asked the service`);
      assert.equal(h("X-Robots-Tag"), "noindex, nofollow", path);
    }
  });

  test("a POST, a PUT or a DELETE is refused before anything is read", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const { res, asked, h } = await ask(`/join/runner-images/${INVITE}`, { method, body: method === "DELETE" ? null : "link=x" });
      assert.equal(res.status, 405, method);
      assert.equal(h("Allow"), "GET, HEAD");
      assert.equal(asked, 0);
    }
  });
});

test("nothing in this file asked the service anything", () => {
  assert.equal(fake.calls.length, 0, fake.calls.map((c) => c.url.pathname).join(", "));
});
