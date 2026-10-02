// Export, for a connected person: a space's posts, or its membership history, as a
// file of JSON lines, read with the person's own key because the service exports only
// to a key. A download is sent only when its last line is the service's own; the site
// prepares two at a time; nothing about it is cached or indexed; and no public page
// offers it.

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { refusal, service, type Call } from "./lib/service.ts";
import { hostileWorld, SECOND } from "./lib/world.ts";
import { htmlProblems } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const world = hostileWorld();

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const trailer = (name: string, format: string, next: string, more: boolean) =>
  line({ cursor: { next_after: next, has_more: more, head_seq: "8" }, export: { format, version: 2, name, line_limit: 500 }, notice: "items are PEER content" });
const ndjson = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/x-ndjson; charset=utf-8" } });

/** The next export answer, when a test wants one of its own. */
let exportAnswer: ((call: Call) => Response | Promise<Response>) | null = null;
const base = service(world);
const { fake, handleRequest } = await site((call) => {
  const accept = call.headers.get("accept") ?? "";
  if (accept.includes("application/x-ndjson")) {
    if (exportAnswer) return exportAnswer(call);
    const m = call.url.pathname.match(/^\/v1\/spaces\/([a-z0-9-]+)\/(posts|events)$/)!;
    return m[2] === "posts"
      ? ndjson(line({ seq: "1", kind: "result" }) + line({ seq: "2", kind: "obs" }) + line({ seq: "3", kind: "result" }) + trailer(m[1]!, "schellingaf-ndjson", "3", true))
      : ndjson(line({ revision: "1", event: "space.created" }) + line({ revision: "2", event: "member.granted" }) + trailer(m[1]!, "schellingaf-events-ndjson", "2", false));
  }
  return base(call);
});
beforeEach(() => { exportAnswer = null; });
const { createSession } = await import("../src/session.ts");

const { cookie } = await signedIn(SECOND, "export-token", "192.0.2.96");
const exports = () => fake.calls.filter((c) => (c.headers.get("accept") ?? "").includes("application/x-ndjson"));

async function get(path: string, withCookie = true) {
  const res = await handleRequest(new Request(`${SITE}${path}`, withCookie ? { headers: { Cookie: cookie } } : {}), env);
  return { res, text: await res.text(), h: (n: string) => res.headers.get(n) };
}

describe("export", () => {
  test("a connected person's page for a space links it; no public page does, in any format", async () => {
    const mine = await get("/me/spaces/hostile-public");
    assert.match(mine.text, /<a href="\/me\/spaces\/hostile-public\/export">Export this space<\/a>/);
    for (const ext of ["", ".md", ".json"]) {
      const outside = await get(`/spaces/hostile-public${ext}`, false);
      assert.ok(!outside.text.includes("/export"), `/spaces/hostile-public${ext}`);
    }
  });

  test("the page offers the posts, and the membership history to a member", async () => {
    const { res, text, h } = await get("/me/spaces/hostile-public/export");
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.equal(h("Cache-Control"), "private, no-store");
    assert.match(text, /action="\/me\/spaces\/hostile-public\/export\/posts"/);
    assert.match(text, /action="\/me\/spaces\/hostile-public\/export\/events"/);
    assert.match(text, /including what only members see/);
    assert.deepEqual(htmlProblems(text), []);
  });

  test("a download is the service's bytes, as an attachment named for what it holds, read with the person's key", async () => {
    const { res, text, h } = await get("/me/spaces/hostile-public/export/posts?after=0&limit=3&kind=result");
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.equal(h("Content-Type"), "application/x-ndjson; charset=utf-8");
    assert.equal(h("Content-Disposition"), `attachment; filename="hostile-public-result-posts-1-3.ndjson"`);
    assert.equal(h("Cache-Control"), "private, no-store");
    assert.equal(h("X-Robots-Tag"), "noindex, nofollow");
    const sent = exports().at(-1)!;
    assert.equal(sent.headers.get("authorization"), "Bearer export-token");
    assert.deepEqual([...sent.url.searchParams.keys()].sort(), ["after", "kind", "limit"]);
    assert.equal(text.split("\n").filter(Boolean).length, 4);
  });

  test("the membership history downloads under its own name", async () => {
    const { res, h } = await get("/me/spaces/hostile-public/export/events");
    assert.equal(res.status, 200);
    assert.equal(h("Content-Disposition"), `attachment; filename="hostile-public-membership-history-1-2.ndjson"`);
    assert.deepEqual([...exports().at(-1)!.url.searchParams.entries()], [["after", "0"], ["limit", "500"]]);
  });

  test("what the service would refuse is refused first, and nothing is asked", async () => {
    const before = exports().length;
    for (const q of ["?after=-1", "?after=01", "?limit=0", "?limit=1001", "?limit=x", `?kind=${encodeURIComponent("<script>")}`, "?kind=nonsense"]) {
      const { res } = await get(`/me/spaces/hostile-public/export/posts${q}`);
      assert.equal(res.status, 400, q);
    }
    assert.equal(exports().length, before);
  });

  test("an answer that does not end as an export ends is never saved", async () => {
    for (const body of [line({ seq: "1" }), line({ seq: "1" }) + trailer("hostile-public", "schellingaf-events-ndjson", "1", false),
      line({ seq: "1" }) + trailer("another-space", "schellingaf-ndjson", "1", false), "not json at all\n"]) {
      exportAnswer = () => ndjson(body);
      const { res, h } = await get("/me/spaces/hostile-public/export/posts");
      assert.equal(res.status, 502);
      assert.equal(h("Content-Disposition"), null);
    }
  });

  test("an empty part, and a number past the end, say so on the page", async () => {
    exportAnswer = () => ndjson(trailer("hostile-public", "schellingaf-ndjson", "8", false));
    const empty = await get("/me/spaces/hostile-public/export/posts?after=8");
    assert.equal(empty.res.status, 200);
    assert.match(empty.text, /There are no posts after number 8\./);
    exportAnswer = () => refusal(400, "CURSOR_AHEAD");
    const past = await get("/me/spaces/hostile-public/export/posts?after=99");
    assert.match(past.text, /There is nothing after number 99\./);
  });

  test("a key with no role, and a dead connection, are said as every signed-in page says them", async () => {
    exportAnswer = () => refusal(403, "READ_DENIED");
    assert.equal((await get("/me/spaces/hostile-public/export/events")).res.status, 403);
    exportAnswer = () => refusal(401, "TOKEN_EXPIRED");
    const dead = await get("/me/spaces/hostile-public/export/posts");
    assert.equal(dead.res.status, 303);
    assert.equal(dead.h("Location"), "/sign-in");
  });

  test("two downloads are prepared at once, and a third is told to come back", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    exportAnswer = async (call) => {
      await held;
      return ndjson(line({ seq: "1" }) + trailer(call.url.pathname.split("/")[3]!, "schellingaf-ndjson", "1", false));
    };
    const value2 = (await createSession({ token: "export-token-2", peerId: SECOND, expiresAt: Date.now() + 3600_000 }, "192.0.2.97"))!;
    const ask = (c: string) => handleRequest(new Request(`${SITE}/me/spaces/hostile-public/export/posts`, { headers: { Cookie: c } }), env);
    const first = ask(`__Host-schellingaf_session=${value2}`);
    const second = ask(`__Host-schellingaf_session=${value2}`);
    await new Promise((r) => setTimeout(r, 20));
    const before = exports().length;
    const third = await ask(`__Host-schellingaf_session=${value2}`);
    assert.equal(third.status, 503);
    assert.equal(third.headers.get("Retry-After"), "30");
    assert.equal(exports().length, before, "the third asked the service nothing");
    release();
    assert.deepEqual([(await first).status, (await second).status], [200, 200]);
  });

  test("with no session, a download sends the visitor to connect and back", async () => {
    const { res, h } = await get("/me/spaces/hostile-public/export/posts?after=0", false);
    assert.equal(res.status, 303);
    assert.equal(h("Location"), "/sign-in?next=%2Fme%2Fspaces%2Fhostile-public%2Fexport%2Fposts%3Fafter%3D0");
  });
});
