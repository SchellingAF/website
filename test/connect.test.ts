// /me/connect, where a person answers an app that wants to connect as their key,
// and the two things around it: coming back to it after connecting, and revoking
// one app's access token afterwards.
//
// Driven through handleRequest() with a stand-in product that records every call, so
// a refusal is proved to have asked the product for nothing.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, json, refusal } from "./lib/service.ts";
import { SITE, env, site } from "./lib/site.ts";

const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const LOOPBACK = "1a1b1c1d-1e1f-4011-8213-141516171819";
const EXPIRED = "2a2b2c2d-2e2f-4021-8223-242526272829";
const DECIDED = "3a3b3c3d-3e3f-4031-8233-343536373839";
const HOSTILE_RETURN = "4a4b4c4d-4e4f-4041-8243-444546474849";
const APP_TOKEN = "a".repeat(64);

const request = (id: string, over: Record<string, unknown> = {}) => ({
  request_id: id,
  state: "pending",
  client: { id: "https://claude.ai/oauth/client.json", kind: "metadata_document", name: "Claude <img src=x onerror=alert(1)>", publisher: "claude.ai" },
  redirect: { host: "claude.ai", uri: "https://claude.ai/api/mcp/auth_callback", loopback: false, only_loopback: false },
  scope: ["read", "write"],
  resource: "https://api.schellingaf.com/mcp/connect",
  expires_at: new Date(Date.now() + 600_000).toISOString(),
  token_lifetime_days: 90,
  ...over,
});

const { fake, handleRequest } = await site((call) => {
  const path = call.url.pathname;
  if (path === "/v1/capabilities") return json(CAPABILITIES);
  if (path === "/v1/conversations") return json({ items: [], unread_conversations: 0, requests_waiting: 0 });
  if (path === "/v1/passkeys/verify") {
    return json({ peer_id: "c".repeat(64), token: "session-token-new", expires_at: new Date(Date.now() + 3600_000).toISOString() });
  }
  if (path === `/v1/authorizations/${ID}`) return json(request(ID));
  if (path === `/v1/authorizations/${LOOPBACK}`) {
    return json(request(LOOPBACK, {
      client: { id: "schellingaf_client_" + "0".repeat(32), kind: "registered", name: "Claude Code", publisher: null },
      redirect: { host: "localhost:5123", uri: "http://localhost:5123/callback", loopback: true, only_loopback: true },
      scope: ["read"],
    }));
  }
  if (path === `/v1/authorizations/${EXPIRED}`) return json(request(EXPIRED, { state: "expired" }));
  if (path === `/v1/authorizations/${DECIDED}`) return json(request(DECIDED, { state: "approved" }));
  if (path === `/v1/authorizations/${ID}/approve`) {
    return json({ decision: "approved", redirect_to: "https://claude.ai/api/mcp/auth_callback?code=the-code&state=s&iss=https%3A%2F%2Fapi.schellingaf.com" });
  }
  if (path === `/v1/authorizations/${ID}/decline`) {
    return json({ decision: "declined", redirect_to: "https://claude.ai/api/mcp/auth_callback?error=access_denied&state=s" });
  }
  if (path === `/v1/authorizations/${HOSTILE_RETURN}/approve`) return json({ decision: "approved", redirect_to: "javascript:alert(document.cookie)" });
  if (path === `/v1/authorizations/${EXPIRED}/approve`) return refusal(410, "AUTHORIZATION_EXPIRED");
  if (path === "/v1/tokens" && call.method === "GET") {
    return json({
      items: [
        { id: "b".repeat(64), hash_prefix: "bbbbbbbb", label: "website connection", created_at: new Date().toISOString(), last_used_at: null,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(), revoked: false, current: true, app: null },
        { id: APP_TOKEN, hash_prefix: "aaaaaaaa", label: "ChatGPT", created_at: new Date().toISOString(), last_used_at: null,
          expires_at: new Date(Date.now() + 86_400_000 * 90).toISOString(), revoked: false, current: false,
          app: { client_id: "https://chatgpt.com/oauth/x/client.json", scope: ["read"] } },
      ],
    });
  }
  if (path === `/v1/tokens/${APP_TOKEN}` && call.method === "DELETE") return new Response(null, { status: 204 });
  return refusal(404, "NOT_ANSWERED");
});

const { createSession, readSession } = await import("../src/session.ts");
const { safeNext } = await import("../src/me.ts");

const FORM = "application/x-www-form-urlencoded";
let people = 0;

async function signedIn() {
  const n = ++people;
  const value = (await createSession({ token: `person-token-${n}`, peerId: n.toString(16).padStart(64, "d"), expiresAt: Date.now() + 3600_000 }, `198.51.100.${n}`))!;
  const session = (await readSession(new Request(`${SITE}/me`, { headers: { Cookie: `__Host-schellingaf_session=${value}` } }), true))!;
  return { cookie: `__Host-schellingaf_session=${value}`, csrf: session.csrf, token: `person-token-${n}` };
}

async function send(path: string, init: RequestInit = {}) {
  const before = fake.calls.length;
  const res = await handleRequest(new Request(`${SITE}${path}`, init), env);
  return { res, text: await res.text(), asked: fake.calls.slice(before) };
}

const asked = (calls: { method: string; url: URL }[]) =>
  calls.filter((c) => c.url.pathname.startsWith("/v1/authorizations") || c.url.pathname.startsWith("/v1/tokens")).map((c) => `${c.method} ${c.url.pathname}`);

describe("an app's request to connect", () => {
  test("a person with no session is sent to connect, and back here after", async () => {
    const { res, asked: calls } = await send(`/me/connect?request=${ID}`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), `/sign-in?next=${encodeURIComponent(`/me/connect?request=${ID}`)}`);
    assert.deepEqual(calls, []);
    const signIn = await send(`/sign-in?next=${encodeURIComponent(`/me/connect?request=${ID}`)}`);
    assert.match(signIn.text, /An app asked to connect as your key/);
  });

  test("connecting sends the person back to the page that asked, and never anywhere else", async () => {
    const answer = async (next: unknown) => {
      const { text } = await send("/sign-in", {
        method: "POST",
        headers: { Origin: SITE, "Content-Type": "application/json" },
        body: JSON.stringify({ challenge: "ab", credential_id: "Y3JlZGVudGlhbC1pZC0xMjM0NTY", client_data_json: "e30", authenticator_data: "AAAA", signature: "AA", next }),
      });
      return JSON.parse(text).location;
    };
    assert.equal(await answer(`/me/connect?request=${ID}`), `/me/connect?request=${ID}`);
    for (const bad of ["https://evil.example/", "//evil.example/me", "/me/../sign-out", "/meeting", "/\\evil.example", "/me\\@evil.example", 7]) {
      assert.equal(await answer(bad), "/me?notice=signed-in", String(bad));
    }
    assert.equal(safeNext("/me/tokens?notice=x"), "/me/tokens?notice=x");
    assert.equal(safeNext("/me#frag"), null);
  });

  test("a person already connected goes straight on from the passkey page", async () => {
    const me = await signedIn();
    const { res } = await send(`/sign-in?next=${encodeURIComponent(`/me/connect?request=${ID}`)}`, { headers: { Cookie: me.cookie } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), `/me/connect?request=${ID}`);
  });

  test("the page says who is asking, who published it, where the person returns and what the app may do, escaped", async () => {
    const me = await signedIn();
    const { res, text } = await send(`/me/connect?request=${ID}`, { headers: { Cookie: me.cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.equal(res.headers.get("X-Robots-Tag"), "noindex, nofollow");
    assert.match(text, /An app wants to connect as your key/);
    assert.ok(text.includes("<bdi>Claude &lt;img src=x onerror=alert(1)&gt;</bdi>"), "the app's name was not escaped and set apart");
    assert.doesNotMatch(text, /<img src=x/);
    // Where the description was found, never somebody vouching: a host that serves
    // anybody's files serves an app's description too.
    assert.match(text, /published at<\/dt><dd><code>claude\.ai<\/code>\. The name above is what that description says, and anybody who can put a file on that host could have written it/);
    assert.doesNotMatch(text, /vouches for the name/);
    assert.match(text, /after you answer, you go to<\/dt><dd><code>claude\.ai<\/code>/);
    assert.match(text, /read and write/);
    assert.ok(text.includes(`name="csrf" value="${me.csrf}"`));
    assert.match(text, /value="allow"/);
    assert.match(text, /value="decline"/);
  });

  test("Allow is sent switched off, for the page's own script to switch on, and the page may run that script and send nothing", async () => {
    const me = await signedIn();
    const { res, text } = await send(`/me/connect?request=${ID}`, { headers: { Cookie: me.cookie } });
    assert.match(text, /<button type="submit" data-guard disabled>Allow<\/button> <span class="meta" data-guard-note role="status" aria-live="polite"><\/span><\/form>/,
      "Allow is not sent switched off with a place to say why a press did not count");
    assert.match(text, /<button type="submit">Decline<\/button>/, "Decline needs no guard");
    assert.ok(text.includes('<script src="/allow.js"></script>'));
    assert.match(text, /<noscript><p class="note">Allow works only with this page&#39;s script, which makes sure it was you who pressed it and not a click another page steered here\. Decline needs no script\.<\/p><\/noscript>/);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /connect-src/);
    assert.match(csp, /frame-ancestors 'none'/);
    // Only this page: every other signed-in page stays without script.
    const tokens = await send("/me/tokens", { headers: { Cookie: me.cookie } });
    assert.doesNotMatch(tokens.res.headers.get("Content-Security-Policy") ?? "", /script-src/);
  });

  test("an app that registered itself and returns to this computer is shown as nobody's word, with a warning", async () => {
    const me = await signedIn();
    const { text } = await send(`/me/connect?request=${LOOPBACK}`, { headers: { Cookie: me.cookie } });
    assert.match(text, /Nobody\. It registered itself/);
    assert.match(text, /returns you to a program on this computer/);
    assert.match(text, /read only/);
  });

  test("an expired or answered request is said to be one, with nothing to press", async () => {
    const me = await signedIn();
    const expired = await send(`/me/connect?request=${EXPIRED}`, { headers: { Cookie: me.cookie } });
    assert.equal(expired.res.status, 410);
    assert.doesNotMatch(expired.text, /value="allow"/);
    const decided = await send(`/me/connect?request=${DECIDED}`, { headers: { Cookie: me.cookie } });
    assert.equal(decided.res.status, 409);
    assert.doesNotMatch(decided.text, /value="allow"/);
  });

  test("allowing sends the person back by a refresh, from this answer alone, with the session's own token", async () => {
    const me = await signedIn();
    const { res, text, asked: calls } = await send("/me/connect", {
      method: "POST",
      headers: { Origin: SITE, Cookie: me.cookie, "Content-Type": FORM },
      body: new URLSearchParams({ csrf: me.csrf, request: ID, decision: "allow" }).toString(),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Location"), null, "the code went into a redirect");
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    const to = "https://claude.ai/api/mcp/auth_callback?code=the-code&amp;state=s&amp;iss=https%3A%2F%2Fapi.schellingaf.com";
    assert.ok(text.includes(`<meta http-equiv="refresh" content="0; url=${to}">`), text.slice(0, 600));
    assert.ok(text.includes(`<a href="${to}">Continue to claude.ai</a>`));
    const approve = calls.find((c) => c.url.pathname === `/v1/authorizations/${ID}/approve`)!;
    assert.equal(approve.method, "POST");
    assert.equal(approve.headers.get("authorization"), `Bearer ${me.token}`);
  });

  test("declining sends the person back too, saying nothing was connected", async () => {
    const me = await signedIn();
    const { text, asked: calls } = await send("/me/connect", {
      method: "POST",
      headers: { Origin: SITE, Cookie: me.cookie, "Content-Type": FORM },
      body: new URLSearchParams({ csrf: me.csrf, request: ID, decision: "decline" }).toString(),
    });
    assert.match(text, /<h1>Declined<\/h1>/);
    assert.deepEqual(asked(calls), [`POST /v1/authorizations/${ID}/decline`]);
  });

  test("an address the service answers that could run or read something is never written into the page", async () => {
    const me = await signedIn();
    const { res, text } = await send("/me/connect", {
      method: "POST",
      headers: { Origin: SITE, Cookie: me.cookie, "Content-Type": FORM },
      body: new URLSearchParams({ csrf: me.csrf, request: HOSTILE_RETURN, decision: "allow" }).toString(),
    });
    assert.equal(res.status, 502);
    assert.doesNotMatch(text, /javascript:/);
    assert.doesNotMatch(text, /http-equiv="refresh"/);
  });

  test("a form from another site, without its token, or that names no request, asks the product for nothing", async () => {
    const me = await signedIn();
    for (const [headers, fields] of [
      [{ Origin: "https://evil.example" }, { csrf: me.csrf, request: ID, decision: "allow" }],
      [{ Origin: SITE }, { csrf: "wrong", request: ID, decision: "allow" }],
      [{ Origin: SITE }, { csrf: me.csrf, request: "not-a-request", decision: "allow" }],
      [{ Origin: SITE }, { csrf: me.csrf, request: ID, decision: "maybe" }],
    ] as [Record<string, string>, Record<string, string>][]) {
      const { res, asked: calls } = await send("/me/connect", {
        method: "POST",
        headers: { ...headers, Cookie: me.cookie, "Content-Type": FORM },
        body: new URLSearchParams(fields).toString(),
      });
      assert.ok(res.status === 403 || res.status === 400, `${res.status} for ${JSON.stringify(fields)}`);
      assert.deepEqual(asked(calls), []);
    }
  });

  test("a request the service calls expired is said to be, not reported as an outage", async () => {
    const me = await signedIn();
    const { res, text } = await send("/me/connect", {
      method: "POST",
      headers: { Origin: SITE, Cookie: me.cookie, "Content-Type": FORM },
      body: new URLSearchParams({ csrf: me.csrf, request: EXPIRED, decision: "allow" }).toString(),
    });
    assert.equal(res.status, 410);
    assert.match(text, /lasts ten minutes/);
  });

  test("an app the service could not show is explained without a session and without asking the product", async () => {
    for (const [word, sentence] of [
      ["unknown_app", /not one the service knows/], ["wrong_return_address", /did not register/], ["malformed", /not well formed/],
      ["busy", /Too many requests to connect/], ["unavailable", /being repaired/], ["other", /Nothing to connect/],
    ] as [string, RegExp][]) {
      const { res, text, asked: calls } = await send(`/me/connect?error=${word}`);
      assert.equal(res.status, 400, word);
      assert.match(text, sentence);
      assert.deepEqual(calls, []);
      assert.equal(res.headers.get("X-Robots-Tag"), "noindex, nofollow");
      assert.equal(res.headers.get("Cache-Control"), "private, no-store", word);
    }
  });
});

describe("an app's access token, afterwards", () => {
  test("is listed as an app with what it may do, and revoking it asks the product to revoke that one alone", async () => {
    const me = await signedIn();
    const page = await send("/me/tokens", { headers: { Cookie: me.cookie } });
    // With where its name came from, which the name alone cannot say.
    assert.match(page.text, /<bdi>ChatGPT<\/bdi><br><span class="meta">reads only; description at chatgpt\.com<\/span>/);
    assert.match(page.text, /<span class="tag">app<\/span>/);
    assert.ok(page.text.includes(`name="id" value="${APP_TOKEN}"`), "no revoke button for the app's token");
    assert.ok(!page.text.includes(`name="id" value="${"b".repeat(64)}"`), "a revoke button for this very connection");
    const { res, asked: calls } = await send("/me/tokens/revoke", {
      method: "POST",
      headers: { Origin: SITE, Cookie: me.cookie, "Content-Type": FORM },
      body: new URLSearchParams({ csrf: me.csrf, id: APP_TOKEN }).toString(),
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), "/me/tokens?notice=token-revoked");
    assert.deepEqual(asked(calls), [`DELETE /v1/tokens/${APP_TOKEN}`]);
    const bad = await send("/me/tokens/revoke", {
      method: "POST",
      headers: { Origin: SITE, Cookie: me.cookie, "Content-Type": FORM },
      body: new URLSearchParams({ csrf: me.csrf, id: "../current" }).toString(),
    });
    assert.equal(bad.res.status, 400);
    assert.deepEqual(asked(bad.asked), []);
  });
});
