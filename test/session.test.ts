// Who is signed in, and what a request must carry before anything is done for them.
//
// src/session.ts's own functions are asked directly: the cookie, the limits on how
// many sessions one key and one network may hold, the form token and the Origin
// check. What the signed-in pages refuse before they ask the product for anything
// is asked through handleRequest(), with a stand-in product that records every call,
// so "refused" means nothing reached the product, not just an unhappy status.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { refusal } from "./lib/service.ts";
import { SITE, site } from "./lib/site.ts";

const { fake, handleRequest } = await site((call) =>
  call.method === "DELETE" && call.url.pathname === "/v1/tokens" ? new Response(null, { status: 204 }) : refusal(404, "NOT_ANSWERED"));
const {
  SESSION_TTL_SECONDS, clearedCookie, createSession, csrfMatches, destroySession, destroySessionsOf,
  readSession, sameOrigin, sessionCookie,
} = await import("../src/session.ts");

const key = (n: number) => n.toString(16).padStart(64, "0");
const later = () => Date.now() + 3600_000;
const cookieRequest = (value: string, secure = true) =>
  new Request(`${secure ? "https" : "http"}://schellingaf.com/me`, { headers: { Cookie: `${secure ? "__Host-" : ""}schellingaf_session=${value}` } });
const alive = async (value: string, secure = true) => (await readSession(cookieRequest(value, secure), secure)) !== null;

describe("the cookie", () => {
  test("names a session this process holds, and nothing else", async () => {
    const value = (await createSession({ token: "tok", peerId: key(1), expiresAt: later() }, "192.0.2.1"))!;
    assert.match(value, /^[A-Za-z0-9_-]{43}$/, "256 random bits, unpadded base64url");
    const session = await readSession(cookieRequest(value), true);
    assert.equal(session?.peerId, key(1));
    assert.equal(session?.token, "tok");
    assert.match(session!.csrf, /^[A-Za-z0-9_-]{43}$/);

    // Over https only the __Host- name is read, and over http only the plain one.
    assert.equal(await readSession(new Request(`${SITE}/me`, { headers: { Cookie: `schellingaf_session=${value}` } }), true), null);
    assert.equal(await readSession(new Request("http://localhost/me", { headers: { Cookie: `__Host-schellingaf_session=${value}` } }), false), null);
    for (const bad of ["", "short", `${value}x`, value.slice(0, 42) + "!", "A".repeat(43)]) {
      assert.equal(await readSession(cookieRequest(bad), true), null, JSON.stringify(bad));
    }
    const among = await readSession(new Request(`${SITE}/me`, { headers: { Cookie: `other=1; __Host-schellingaf_session=${value}; x=y` } }), true);
    assert.equal(among?.peerId, key(1), "found among other cookies");
  });

  test("an expired session is no session, and is forgotten", async () => {
    const value = (await createSession({ token: "tok", peerId: key(2), expiresAt: Date.now() - 1 }, "192.0.2.2"))!;
    assert.equal(await alive(value), false);
  });

  test("is HttpOnly, SameSite=Lax and Path=/, and Secure with the __Host- prefix only on https", () => {
    assert.equal(sessionCookie("v", true, 60.9), "__Host-schellingaf_session=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure");
    assert.equal(sessionCookie("v", false, 60), "schellingaf_session=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60");
    assert.equal(sessionCookie("v", true, -5), "__Host-schellingaf_session=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
    assert.equal(clearedCookie(true), "__Host-schellingaf_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
    assert.equal(SESSION_TTL_SECONDS, 7 * 24 * 60 * 60);
  });

  test("signing out ends one session, and revoking a key's tokens ends all of its sessions", async () => {
    const a = (await createSession({ token: "t", peerId: key(3), expiresAt: later() }, "192.0.2.3"))!;
    const b = (await createSession({ token: "t", peerId: key(3), expiresAt: later() }, "192.0.2.4"))!;
    const other = (await createSession({ token: "t", peerId: key(4), expiresAt: later() }, "192.0.2.3"))!;
    await destroySession(cookieRequest(a), true);
    assert.deepEqual([await alive(a), await alive(b), await alive(other)], [false, true, true]);
    destroySessionsOf(key(3));
    assert.deepEqual([await alive(b), await alive(other)], [false, true]);
  });
});

describe("how many sessions, and who loses one", () => {
  /** Makes n sessions and says which of them are still alive. */
  const make = async (n: number, peer: (i: number) => string, address: (i: number) => string | null) => {
    const values: string[] = [];
    for (let i = 0; i < n; i++) values.push((await createSession({ token: "t", peerId: peer(i), expiresAt: later() }, address(i)))!);
    return Promise.all(values.map((v) => alive(v)));
  };
  const firstGone = (states: boolean[]) => states[0] === false && states.slice(1).every(Boolean);

  test("one key holds sixteen: the seventeenth pushes out its own oldest", async () => {
    assert.ok(firstGone(await make(17, () => key(100), (i) => `198.51.100.${i}`)));
  });

  test("one IPv4 address holds sixty-four, whatever keys they are", async () => {
    assert.ok(firstGone(await make(65, (i) => key(200 + i), () => "203.0.113.7")));
  });

  test("an IPv6 /48 counts as one network, however its addresses are written", async () => {
    const forms = (i: number) => [
      `2001:db8:1:${i.toString(16)}::1`, `[2001:db8:1:${i.toString(16)}::2]`, `2001:0db8:0001:${i.toString(16)}::3%en0`,
      `2001:DB8:1:${i.toString(16)}:0:0:0:4`,
    ][i % 4]!;
    assert.ok(firstGone(await make(65, (i) => key(300 + i), forms)));
  });

  test("a mapped IPv4 address is that IPv4 address", async () => {
    assert.ok(firstGone(await make(65, (i) => key(400 + i), (i) => (i % 2 ? "::ffff:203.0.113.99" : "203.0.113.99"))));
  });

  test("different /48s do not push each other out", async () => {
    assert.ok((await make(65, (i) => key(500 + i), (i) => `2001:db8:${(i + 16).toString(16)}::1`)).every(Boolean));
  });

  test("an address that cannot be read shares one group with every other", async () => {
    const unreadable = [null, "", "not an address", "1.2.3", "2001:db8::1::2", "gggg::1", "1:2:3:4:5:6:7:8:9"];
    assert.ok(firstGone(await make(65, (i) => key(600 + i), (i) => unreadable[i % unreadable.length]!)));
  });

  test("sign-ins that finish at once hold to the same limits", async () => {
    /** Makes n sessions at once and says how many are still alive. */
    const atOnce = async (n: number, peer: (i: number) => string, address: (i: number) => string) => {
      const values = await Promise.all(Array.from({ length: n }, (_, i) => createSession({ token: "t", peerId: peer(i), expiresAt: later() }, address(i))));
      return (await Promise.all(values.map((v) => alive(v!)))).filter(Boolean).length;
    };
    assert.equal(await atOnce(20, () => key(0x2000), (i) => `198.18.0.${i}`), 16, "one key");
    assert.equal(await atOnce(70, (i) => key(0x3000 + i), () => "198.18.1.1"), 64, "one network");
  });
});

describe("what a POST must carry", () => {
  const post = (headers: Record<string, string>) => new Request(`${SITE}/me/new`, { method: "POST", headers });
  const url = new URL(`${SITE}/me/new`);

  test("an Origin naming this site, or a null one the browser marks same-origin", () => {
    const cases: [Record<string, string>, boolean][] = [
      [{ Origin: SITE }, true],
      [{ Origin: "null", "Sec-Fetch-Site": "same-origin" }, true],
      [{ "Sec-Fetch-Site": "same-origin" }, true],
      [{ Origin: "https://evil.example" }, false],
      [{ Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" }, false],
      [{ Origin: "http://schellingaf.com" }, false],
      [{ Origin: "https://www.schellingaf.com" }, false],
      [{ Origin: `${SITE}.evil.example` }, false],
      [{ Origin: "null", "Sec-Fetch-Site": "cross-site" }, false],
      [{ Origin: "null", "Sec-Fetch-Site": "same-site" }, false],
      [{ Origin: "null" }, false],
      [{}, false],
    ];
    for (const [headers, want] of cases) assert.equal(sameOrigin(post(headers), url), want, JSON.stringify(headers));
  });

  test("the session's own form token, compared in full", async () => {
    const value = (await createSession({ token: "t", peerId: key(700), expiresAt: later() }, "192.0.2.70"))!;
    const session = (await readSession(cookieRequest(value), true))!;
    const flipped = (session.csrf[0] === "A" ? "B" : "A") + session.csrf.slice(1);
    assert.equal(csrfMatches(session, session.csrf), true);
    for (const bad of [null, "", flipped, session.csrf.slice(0, -1), `${session.csrf}A`, session.csrf.toLowerCase() === session.csrf ? session.csrf.toUpperCase() : session.csrf.toLowerCase()]) {
      assert.equal(csrfMatches(session, bad), false, JSON.stringify(bad));
    }
  });
});

describe("the signed-in pages refuse before they ask the product for anything", () => {
  const env = {
    ASSETS: { fetch: async () => new Response("Not Found", { status: 404 }) },
    SITE_TOKEN: "site-token-for-tests",
  };
  const signedIn = async (n: number) => {
    const value = (await createSession({ token: `session-token-${n}`, peerId: key(800 + n), expiresAt: later() }, `192.0.2.${n}`))!;
    return { value, cookie: `__Host-schellingaf_session=${value}`, csrf: (await readSession(cookieRequest(value), true))!.csrf };
  };
  const send = async (path: string, init: RequestInit) => {
    const before = fake.calls.length;
    const res = await handleRequest(new Request(`${SITE}${path}`, init), env);
    return { res, text: await res.text(), asked: fake.calls.slice(before) };
  };
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  const FORM = "application/x-www-form-urlencoded";

  test("no session: a page sends the reader to connect", async () => {
    for (const [path, method] of [["/me", "GET"], ["/me/tokens", "GET"], ["/me/new", "POST"]] as const) {
      const { res, asked } = await send(path, { method, ...(method === "POST" ? { body: "csrf=x", headers: { Origin: SITE, "Content-Type": FORM } } : {}) });
      assert.equal(res.status, 303, `${method} ${path}`);
      // A page comes back after connecting; a form is not sent again, and the key's own
      // page is where connecting goes anyway.
      assert.equal(res.headers.get("Location"), method === "GET" && path !== "/me" ? `/sign-in?next=${encodeURIComponent(path)}` : "/sign-in");
      assert.equal(res.headers.get("Cache-Control"), "private, no-store");
      assert.equal(res.headers.get("X-Robots-Tag"), "noindex, nofollow");
      assert.deepEqual(asked, []);
    }
  });

  test("a form from another site, or with no origin to say where it came from, changes nothing", async () => {
    const me = await signedIn(1);
    for (const headers of [
      { Origin: "https://evil.example" },
      { Origin: "null", "Sec-Fetch-Site": "cross-site" },
      {},
    ]) {
      const { res, text, asked } = await send("/me/tokens/revoke-all", {
        method: "POST", headers: { ...headers, Cookie: me.cookie, "Content-Type": FORM }, body: form({ csrf: me.csrf }),
      });
      assert.equal(res.status, 403, JSON.stringify(headers));
      assert.ok(text.includes("did not come from a page of this site"), text.slice(0, 300));
      assert.deepEqual(asked, []);
    }
    assert.equal(await alive(me.value), true);
  });

  test("a form without the session's token, or that is not a form, changes nothing", async () => {
    const me = await signedIn(2);
    for (const [type, body] of [[FORM, form({ csrf: "wrong" })], [FORM, form({})], ["application/json", JSON.stringify({ csrf: me.csrf })], ["text/plain", `csrf=${me.csrf}`]]) {
      const { res, text, asked } = await send("/me/tokens/revoke-all", {
        method: "POST", headers: { Origin: SITE, Cookie: me.cookie, "Content-Type": type! }, body,
      });
      assert.equal(res.status, 403, `${type} ${body}`);
      assert.ok(text.includes("That form has expired"), text.slice(0, 300));
      assert.deepEqual(asked, []);
    }
    assert.equal(await alive(me.value), true);
  });

  test("signing out takes the session's own form: without it, or from elsewhere, the cookie stays", async () => {
    const nobody = await send("/sign-out", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": FORM }, body: "" });
    assert.equal(nobody.res.status, 303);
    assert.equal(nobody.res.headers.get("Location"), "/");
    assert.equal(nobody.res.headers.get("Set-Cookie"), null, "a sign-out that found no session touched the cookie");
    const me = await signedIn(3);
    for (const [origin, csrf] of [["https://evil.example", me.csrf], [SITE, "wrong"]]) {
      const { res, asked } = await send("/sign-out", {
        method: "POST", headers: { Origin: origin!, Cookie: me.cookie, "Content-Type": FORM }, body: form({ csrf: csrf! }),
      });
      assert.equal(res.status, 403, origin);
      assert.equal(res.headers.get("Set-Cookie"), null, origin);
      assert.deepEqual(asked, []);
    }
    assert.equal(await alive(me.value), true);
  });

  test("connecting refuses another site, anything but JSON, and an answer far longer than a passkey's", async () => {
    const cases: [string, Record<string, string>, string, number][] = [
      ["/sign-in/challenge", { Origin: "https://evil.example" }, "", 403],
      ["/sign-in", { Origin: "https://evil.example", "Content-Type": "application/json" }, "{}", 403],
      ["/sign-in", { Origin: SITE, "Content-Type": "text/plain" }, "{}", 415],
      ["/sign-in", { Origin: SITE, "Content-Type": "application/json" }, JSON.stringify({ signature: "x".repeat(17_000) }), 413],
      ["/sign-in", { Origin: SITE, "Content-Type": "application/json" }, "[1]", 400],
      ["/sign-in", { Origin: SITE, "Content-Type": "application/json" }, JSON.stringify({ signature: 5 }), 400],
    ];
    for (const [path, headers, body, status] of cases) {
      const { res, asked } = await send(path, { method: "POST", headers, body });
      assert.equal(res.status, status, `${path} ${JSON.stringify(headers)} ${body.slice(0, 30)}`);
      assert.deepEqual(asked, []);
    }
  });

  test("the wrong method on a signed-in address is a 405 that says which it takes", async () => {
    const cases: [string, string, string][] = [["/sign-out", "GET", "POST"], ["/sign-in/challenge", "GET", "POST"], ["/sign-in", "PUT", "GET, HEAD"]];
    for (const [path, method, allow] of cases) {
      const { res, asked } = await send(path, { method });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get("Allow"), allow);
      assert.deepEqual(asked, []);
    }
  });

  test("and a form that carries both reaches the product, with the session's own token and no other", async () => {
    for (const [n, headers] of [[4, { Origin: SITE }], [5, { Origin: "null", "Sec-Fetch-Site": "same-origin" }]] as const) {
      const me = await signedIn(n);
      const { res, asked } = await send("/me/tokens/revoke-all", {
        method: "POST", headers: { ...headers, Cookie: me.cookie, "Content-Type": FORM }, body: form({ csrf: me.csrf }),
      });
      assert.equal(res.status, 303, JSON.stringify(headers));
      assert.equal(res.headers.get("Location"), "/sign-in");
      assert.match(res.headers.get("Set-Cookie") ?? "", /^__Host-schellingaf_session=; .*Max-Age=0/);
      assert.deepEqual(asked.map((c) => [c.method, c.url.pathname, c.headers.get("authorization")]), [["DELETE", "/v1/tokens", `Bearer session-token-${n}`]]);
      assert.equal(await alive(me.value), false);
    }
  });
});

// Last, because it fills the one table this process holds, and empties it again.
describe("a full table", () => {
  test("refuses a newcomer rather than evicting anybody, and makes space only by forgetting expired sessions", async () => {
    const kept = (await createSession({ token: "t", peerId: key(0xfff01), expiresAt: later() }, "10.255.255.253"))!;
    const peers = new Set<string>();
    // The i-th session: sixteen to a key and sixty-four to a network, so no limit but
    // the table's own ever pushes anybody out.
    const nth = (i: number, expiresAt = later()) => {
      const peerId = key(0x100000 + (i >> 4));
      peers.add(peerId);
      return createSession({ token: "t", peerId, expiresAt }, `10.${(i >> 14) & 255}.${(i >> 6) & 255}.1`);
    };

    // Most of the way in batches, which is quick, and the rest one at a time, until the
    // table refuses one.
    let i = 0;
    for (; i < 99_000; i += 64) await Promise.all(Array.from({ length: 64 }, (_, k) => nth(i + k)));
    while (i < 101_000 && (await nth(i)) !== null) i++;
    assert.ok(i < 101_000, "a table of a hundred thousand sessions and more never refused one");
    assert.equal(await nth(i + 1), null, "a full table took a newcomer");
    assert.equal(await alive(kept), true, "somebody was evicted to make space");

    // Space for sixteen, and sixty-four sign-ins finishing at once, each its own key on
    // its own network: sixteen are let in and the rest refused. They all passed the
    // size check before any was added, and overfilled the table by forty-eight.
    destroySessionsOf(key(0x100001));
    const together = await Promise.all(Array.from({ length: 64 }, (_, k) =>
      createSession({ token: "t", peerId: key(0xfff10 + k), expiresAt: later() }, `10.254.${k}.1`)));
    assert.equal(together.filter((v) => v !== null).length, 16, "sign-ins at once overfilled the table");

    // Space for sixteen, filled with sessions that have already expired: the table is
    // full again, and only forgetting those makes space.
    destroySessionsOf(key(0x100000));
    const expired = async () => createSession({ token: "t", peerId: key(0xfff03), expiresAt: Date.now() - 1 }, "10.255.255.252");
    for (let k = 0; k < 16; k++) assert.notEqual(await expired(), null, `the freed space took only ${k} sessions`);
    assert.notEqual(await createSession({ token: "t", peerId: key(0xfff04), expiresAt: later() }, "10.255.255.251"), null,
      "the expired sessions were not forgotten to make space");
    assert.equal(await alive(kept), true);

    for (const p of peers) destroySessionsOf(p);
    for (const n of [0xfff01, 0xfff03, 0xfff04]) destroySessionsOf(key(n));
    for (let k = 0; k < 64; k++) destroySessionsOf(key(0xfff10 + k));
  });
});
