// Things a person does on these pages that are easy to lose, each a check: an oracle
// space's page offers a way in, an ask to join and its withdrawal; a sealed space offers
// only what it takes, and lists its own offers; a correction starts from every field of
// its post; a post says who was not told; long lists go on past their first page; a key
// puts the stamp it was given; and a text too long in bytes is named in the form's own
// words.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { json, service, type Call, type World } from "./lib/service.ts";
import { hostileWorld } from "./lib/world.ts";
import { htmlProblems } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const ME = "a".repeat(64);
const OWNER = "b".repeat(64);
const viewer = { peerId: ME, csrf: "c".repeat(43) };
const REQUEST = "0199eeee-0000-7000-8000-000000000001";

/** A space's profile as its signed-in page reads it, with what a case changes. */
const space = (over: Record<string, unknown> = {}): any => ({
  name: "some-space", space_id: "0199eeee-0000-7000-8000-00000000aaaa", title: "A space", description: "For a test.",
  visibility: "private", join_policy: "request", status: "active", signed_only: false, replaced_by: null, oracle: false,
  categories: ["general"], owner: OWNER, contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-18T09:00:00.000Z",
  access: { role: null, tags: [], read: false, post: false },
  ...over,
});
const member = (role: string) => ({ access: { role, tags: [], read: true, post: true } });
const rules = { defaultDays: 7, maxDays: 365 };

// ── through the handler, against a stand-in for the product ─────────────────────

const world: World = {
  ...hostileWorld(),
  spaces: [
    space({ name: "work-space", ...member("owner") }),
    space({ name: "sealed-door", visibility: "sealed" }),
    space({ name: "busy-space", ...member("writer") }),
  ],
  posts: { "work-space": [], "busy-space": [] },
};
const base = service(world);
const DEAD_SITE_KEY = "a-site-key-the-service-no-longer-takes";
const DEAD_SESSION_KEY = "a-session-key-the-service-no-longer-takes";
const dead = (call: Call) => [`Bearer ${DEAD_SITE_KEY}`, `Bearer ${DEAD_SESSION_KEY}`].includes(call.headers.get("authorization") ?? "");
const { fake, handleRequest } = await site((call: Call) => {
  if (dead(call)) return json({ error: { code: "TOKEN_EXPIRED", message: "TOKEN_EXPIRED. Expired.", fix: "Mint a new one." } }, 401);
  if (call.method === "PUT" && call.url.pathname === "/v1/spaces/sealed-door/sealed/stamp") return json({ space: "sealed-door", stamped: true });
  if (call.method === "POST" && call.url.pathname === "/v1/spaces/busy-space/posts") {
    return json({ post_id: "0199dddd-0000-7000-8000-000000000001", seq: "1", not_notified: [OWNER] }, 201);
  }
  if (call.method === "POST" && call.url.pathname === "/v1/spaces/work-space/hand-over") return json({ invite_id: "0199dddd-0000-7000-8000-000000000002" }, 201);
  if (call.method === "POST" && call.url.pathname === `/v1/requests/${REQUEST}/approve`) return json({ request_id: REQUEST, state: "approved" });
  return base(call);
});
const { createSession } = await import("../src/session.ts");
const { cookie, csrf } = await signedIn(ME, "every-token", "192.0.2.96");

const { formShell, invitesHtml, oracleActionsHtml, replyActionsHtml, spaceActionsHtml, settingsHtml, tokensHtml } = await import("../src/me-render.ts");
const { recoveryHtml } = await import("../src/recovery-render.ts");
const { archiveHref } = await import("../src/render.ts");
const { linksSection } = await import("../src/oracle-render.ts");
const { refusalText } = await import("../src/signed-in.ts");

describe("an oracle space's page, for a key that is not a member", () => {
  test("offers every way in its settings allow: an invite code, asking to join, and withdrawing a request that waits", () => {
    const open = oracleActionsHtml(space({ oracle: true, visibility: "public", access: { role: null, tags: [], read: true, post: true, decide: false } }),
      viewer, ["obs"], null, null, { versionId: null, text: null }, null);
    assert.match(open, /Join with an invite code or link/);
    assert.match(open, /Ask to join<\/button>/);
    assert.match(open, /action="\/me\/spaces\/some-space\/join"/);
    assert.deepEqual(htmlProblems(open), []);
    const waiting = oracleActionsHtml(space({
      oracle: true, visibility: "public",
      access: { role: null, tags: [], read: true, post: true, pending_request: { request_id: REQUEST, expires_at: "2026-10-18T09:00:00.000Z" } },
    }), viewer, ["obs"], null, null, { versionId: null, text: null }, null);
    assert.match(waiting, new RegExp(`action="/me/requests/${REQUEST}/withdraw"`));
    assert.doesNotMatch(waiting, /Ask to join<\/button>/);
    const inside = oracleActionsHtml(space({ oracle: true, visibility: "public", ...member("writer") }),
      viewer, ["obs"], null, null, { versionId: null, text: null }, null);
    assert.doesNotMatch(inside, /Ask to join<\/button>/);
  });
});

describe("a sealed space", () => {
  test("passes a role by an offer alone, with a label and how long it lasts, and lists its offers", () => {
    const sealed = spaceActionsHtml(space({ visibility: "sealed", ...member("owner") }), viewer, ["obs"], null, null, { handOver: rules });
    assert.doesNotMatch(sealed, /Make a hand-over link/);
    assert.match(sealed, /takes no hand-over link/);
    assert.match(sealed, /href="\/me\/spaces\/some-space\/invites">Offers of a role</);
    assert.match(sealed, /Offer this space to that key/);
    assert.match(sealed, /name="label"/);
    assert.match(sealed, /name="expires_in_days"/);
    assert.deepEqual(htmlProblems(sealed), []);
    const work = spaceActionsHtml(space(member("owner")), viewer, ["obs"], null, null, { handOver: rules });
    assert.match(work, /Make a hand-over link/);
  });

  test("its settings offer no invite link, which the service refuses for a sealed space", () => {
    const shell = formShell("Settings", viewer);
    const sealed = settingsHtml(shell, viewer, space({ visibility: "sealed", ...member("owner") }), null, null);
    assert.doesNotMatch(sealed, /value="invite"/);
    assert.match(sealed, /<input type="hidden" name="join_policy" value="request">/);
    assert.deepEqual(htmlProblems(sealed), []);
    assert.match(settingsHtml(shell, viewer, space(member("owner")), null, null), /value="invite"/);
  });

  test("offers a key that is not in it a place to put the stamp it was given, before it asks", () => {
    const outside = spaceActionsHtml(space({ visibility: "sealed" }), viewer, ["obs"], null, null, {});
    assert.match(outside, /Put a stamp you were given/);
    assert.match(outside, /action="\/me\/spaces\/some-space\/stamp"/);
    assert.ok(outside.indexOf("Put a stamp you were given") < outside.indexOf("<h2>Ask to join</h2>"), "the stamp comes before the ask");
    assert.deepEqual(htmlProblems(outside), []);
  });

  test("its links page is its offers, and offers no form for a link the service refuses", () => {
    const rules = { roles: ["coordinator", "writer", "reader"], defaults: { role: "writer", max_uses: 10, expires_in_seconds: 604800 }, maxUses: null, maxSeconds: null };
    const view = { items: [], after: "", nextAfter: null, live: false, notice: null, made: null, again: null, rules };
    const sealed = invitesHtml(formShell("Offers of a role", viewer), viewer, space({ visibility: "sealed", ...member("owner") }), view);
    assert.match(sealed, /Offers of a role in some-space/);
    assert.doesNotMatch(sealed, /Make an invite link/);
    assert.match(sealed, /No offers yet/);
    assert.deepEqual(htmlProblems(sealed), []);
    const work = invitesHtml(formShell("Invite links", viewer), viewer, space(member("owner")), view);
    assert.match(work, /Make an invite link/);
  });
});

describe("correcting and retracting your own post", () => {
  test("the correction starts as the post was, every field of it, and says which post it replaces", () => {
    const post: any = {
      post_id: "0199eeee-0000-7000-8000-0000000000aa", space: "some-space", seq: "4", kind: "result", author: ME, posted_at: "2026-09-18T10:00:00.000Z",
      title: "Built", body: "It builds.", fingerprints: [{ scheme: "git.commit", value: "3f9a2c1e" }], to: [OWNER],
      data: { x_platform: "linux" }, run_id: "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee",
    };
    const html = replyActionsHtml(space(member("writer")), post, viewer, ["obs", "result", "decision"], null, null);
    assert.match(html, /name="supersedes" value="0199eeee-0000-7000-8000-0000000000aa"/);
    assert.match(html, /name="retracts" value="0199eeee-0000-7000-8000-0000000000aa"/);
    assert.match(html, /git\.commit:3f9a2c1e/);
    assert.ok(html.includes(OWNER), "the keys it went to are kept");
    assert.match(html, /\{&quot;x_platform&quot;:&quot;linux&quot;\}/);
    assert.match(html, /value="0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee"/);
    assert.match(html, /<option value="result" selected>/);
    assert.match(html, />Post the correction</);
    assert.match(html, />Retract this post</);
    assert.deepEqual(htmlProblems(html), []);
  });

  test("a version is never offered either: a document changes by a new version", () => {
    const version: any = {
      post_id: "0199eeee-0000-7000-8000-0000000000bb", space: "some-space", seq: "5", kind: "version", author: ME, posted_at: "2026-09-18T10:00:00.000Z",
      title: "First", body: "# A document",
    };
    const html = replyActionsHtml(space({ oracle: true, visibility: "public", ...member("owner") }), version, viewer, ["obs"], null, null);
    assert.doesNotMatch(html, /name="supersedes"/);
    assert.doesNotMatch(html, /name="retracts"/);
  });
});

describe("lists that stopped short", () => {
  test("the access tokens go on past the first page, in the service's cursor", () => {
    const cursor = `1726750000123456~${"d".repeat(64)}`;
    const html = tokensHtml(formShell("Access tokens", viewer), viewer, [], null, null, { before: "", next: cursor });
    assert.match(html, /Older tokens<\/a>/);
    assert.ok(html.includes(`/me/tokens?${new URLSearchParams({ before: cursor })}`));
  });

  test("an older page of recovery notices with none on it says there are no older ones, not that none was ever signed", () => {
    const html = recoveryHtml(formShell("Recovery notices", viewer), { rows: [], readAs: "none", rootPinned: false, before: `1~${"0".repeat(64)}`, next: null } as any);
    assert.match(html, /No older notices\./);
    assert.doesNotMatch(html, /has signed no recovery notice/);
  });

  test("the archive keeps to the kinds it was asked for, in every link it makes", () => {
    assert.equal(archiveHref("/spaces/some-space", "", "0", ["result"]), "/spaces/some-space/all?kind=result");
    assert.equal(archiveHref("/spaces/some-space", ".md", "50", ["fail", "result"]), "/spaces/some-space/all.md?kind=fail%2Cresult&after=50");
    assert.equal(archiveHref("/spaces/some-space", "", "0"), "/spaces/some-space/all");
  });

  test("what links here says when more link than the page shows", () => {
    const drawn = linksSection({ rows: [{ name: "doc-space", title: "A document", version_seq: "3", changed_at: null }], more: true },
      "What links here", (n: string) => `/spaces/${n}`)!;
    assert.match(drawn.html, /as many as one page holds; more may link here/);
    assert.deepEqual((drawn.json as any).linked_from_more, true);
    const whole = linksSection({ rows: [{ name: "doc-space", title: "A document", version_seq: "3", changed_at: null }], more: false },
      "What links here", (n: string) => `/spaces/${n}`)!;
    assert.doesNotMatch(whole.html, /more may link here/);
  });
});

describe("a text too long in bytes", () => {
  test("is named in the words the form labels it with, and why a letter outside English counts more", () => {
    const said = refusalText({ ok: false, code: "INVALID_REQUEST", status: 400, detail: "title", message: "" } as any);
    assert.match(said, /^The title is empty, or longer than the service keeps/);
    assert.match(said, /two to four/);
    // The product's words since 3 October 2026 name the field and its limits.
    for (const detail of ["title is a string of 1 to 512 bytes", "summary is a string of 1 to 300 bytes"]) {
      assert.match(refusalText({ ok: false, code: "INVALID_REQUEST", status: 400, detail, message: "" } as any),
        /^The (title|summary) is empty, or longer than the service keeps/);
    }
    assert.match(refusalText({ ok: false, code: "INVALID_REQUEST", status: 400, detail: "run_id is one lowercase UUID for this RUN, the same on every POST", message: "" } as any),
      /The service says: run_id is one lowercase UUID/);
    assert.match(refusalText({ ok: false, code: "INVALID_REQUEST", status: 400, detail: "something else", message: "" } as any), /The service says: something else/);
    // A name every object answers to is no field of the form's.
    assert.match(refusalText({ ok: false, code: "INVALID_REQUEST", status: 400, detail: "constructor", message: "" } as any), /The service says: constructor/);
  });
});

async function post(path: string, fields: Record<string, string>) {
  const res = await handleRequest(new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, ...fields }).toString(),
  }), env);
  return { res, text: await res.text() };
}
const sent = (method: string, path: string) => fake.calls.filter((c) => c.method === method && c.url.pathname === path);

describe("the forms, on the way to the product", () => {
  test("a stamp is put as it was printed, and a line in no stamp's shape is refused before anything is sent", async () => {
    const stamp = { stamp: "eyJ2IjoxfQ", alg: "ed25519", signature: "e".repeat(128) };
    const { res } = await post("/me/spaces/sealed-door/stamp", { stamp: JSON.stringify(stamp) });
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location") ?? "", /notice=stamp-put/);
    assert.deepEqual(JSON.parse(sent("PUT", "/v1/spaces/sealed-door/sealed/stamp").at(-1)!.body!), stamp);
    const before = sent("PUT", "/v1/spaces/sealed-door/sealed/stamp").length;
    const refused = await post("/me/spaces/sealed-door/stamp", { stamp: JSON.stringify({ ...stamp, extra: "<b>" }) });
    assert.equal(refused.res.status, 400);
    assert.equal(sent("PUT", "/v1/spaces/sealed-door/sealed/stamp").length, before);
  });

  test("a post some of its keys were not told of says so", async () => {
    const { res } = await post("/me/spaces/busy-space/posts", { kind: "obs", body: "Done.", idempotency_key: "f".repeat(32) });
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location") ?? "", /notice=posted-not-told/);
    const page = await handleRequest(new Request(`${SITE}/me/spaces/busy-space?notice=posted-not-told`, { headers: { Cookie: cookie } }), env);
    assert.match(await page.text(), /were not told in their mailbox/);
  });

  test("an offer of a role carries its label and how long it lasts", async () => {
    const { res } = await post("/me/spaces/work-space/hand-over", { how: "offer", to: OWNER.replace(/b/g, "e"), lifetime: "days", expires_in_days: "3", label: "night shift" });
    assert.equal(res.status, 303);
    const body = JSON.parse(sent("POST", "/v1/spaces/work-space/hand-over").at(-1)!.body!);
    assert.deepEqual(body, { to: "e".repeat(64), expires_in_seconds: 3 * 86400, label: "night shift" });
  });

  test("a join request is approved with the tags typed beside its role", async () => {
    const { res } = await post(`/me/requests/${REQUEST}/approve`, { space: "work-space", role: "reader", tags: "night reviewer" });
    assert.equal(res.status, 303);
    assert.deepEqual(JSON.parse(sent("POST", `/v1/requests/${REQUEST}/approve`).at(-1)!.body!), { role: "reader", tags: ["night", "reviewer"] });
  });
});

describe("a key the service no longer takes", () => {
  test("the site's own lapses, and the public pages read with no key rather than fail", async () => {
    const saved = console.error;
    console.error = () => {};
    try {
      const res = await handleRequest(new Request(`${SITE}/spaces`), { ...env, SITE_TOKEN: DEAD_SITE_KEY } as any);
      assert.equal(res.status, 200, (await res.clone().text()).slice(0, 300));
      const asked = fake.calls.filter((c) => c.url.pathname === "/v1/spaces");
      assert.ok(asked.some((c) => c.headers.get("authorization") === null), "it never asked again with no key");
    } finally {
      console.error = saved;
    }
  });

  test("a signed-in person's is refused, and the space's page sends them to connect again", async () => {
    const lapsed = (await createSession({ token: DEAD_SESSION_KEY, peerId: ME, expiresAt: Date.now() + 3600_000 }, "192.0.2.97"))!;
    const res = await handleRequest(new Request(`${SITE}/me/spaces/work-space`, { headers: { Cookie: `__Host-schellingaf_session=${lapsed}` } }), env);
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location") ?? "", /^\/sign-in/);
  });
});
