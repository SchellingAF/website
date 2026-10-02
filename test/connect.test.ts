// /me/connect, where a person answers an app that wants to connect as their key,
// and the two things around it: coming back to it after connecting, and revoking
// one app's access token afterwards.
//
// Driven through handleRequest() with a stand-in product that records every call, so
// a refusal is proved to have asked the product for nothing.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { statementBytes } from "../src/connection-key.js";
import { CAPABILITIES, json, refusal } from "./lib/service.ts";
import { SITE, env, site } from "./lib/site.ts";

const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const LOOPBACK = "1a1b1c1d-1e1f-4011-8213-141516171819";
const EXPIRED = "2a2b2c2d-2e2f-4021-8223-242526272829";
const DECIDED = "3a3b3c3d-3e3f-4031-8233-343536373839";
const HOSTILE_RETURN = "4a4b4c4d-4e4f-4041-8243-444546474849";
const ODD_LIFETIME = "6a6b6c6d-6e6f-4061-8263-646566676869";
const SWAPPED = "7a7b7c7d-7e7f-4071-8273-747576777879";
/** Whether the stand-in product says it kept a connection key it was sent. */
let keeps = true;
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
  // A product that takes connection keys lists the label their statement is signed under;
  // test/connect-without-keys.test.ts holds one that does not.
  if (path === "/v1/capabilities") {
    return json({ ...CAPABILITIES, protocol: { ...CAPABILITIES.protocol, labels: { connection_key: "agent-state:connection-key:v1" } } });
  }
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
  if (path === `/v1/authorizations/${ODD_LIFETIME}`) return json(request(ODD_LIFETIME, { token_lifetime_days: 1.5 }));
  // Asked about one request, the product answers with another.
  if (path === `/v1/authorizations/${SWAPPED}`) return json(request(ID));
  if (path === `/v1/authorizations/${EXPIRED}`) return json(request(EXPIRED, { state: "expired" }));
  if (path === `/v1/authorizations/${DECIDED}`) return json(request(DECIDED, { state: "approved" }));
  if (path === `/v1/authorizations/${ID}/approve`) {
    const sent = JSON.parse(call.body ?? "{}");
    return json({
      decision: "approved", redirect_to: "https://claude.ai/api/mcp/auth_callback?code=the-code&state=s&iss=https%3A%2F%2Fapi.schellingaf.com",
      ...(sent.connection_key && keeps ? { connection_key: "kept" } : {}),
    });
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

async function signedIn(credentialId?: string) {
  const n = ++people;
  const peerId = n.toString(16).padStart(64, "d");
  const value = (await createSession({ token: `person-token-${n}`, peerId, expiresAt: Date.now() + 3600_000, ...(credentialId ? { credentialId } : {}) }, `198.51.100.${n}`))!;
  const session = (await readSession(new Request(`${SITE}/me`, { headers: { Cookie: `__Host-schellingaf_session=${value}` } }), true))!;
  return { cookie: `__Host-schellingaf_session=${value}`, csrf: session.csrf, token: `person-token-${n}`, peerId };
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

// ------------------------------------------------------------------ letting the app sign

const CREDENTIAL = "Q3JlZGVudGlhbElkRm9yVGhlVGVzdHM";
const CK = ["ck_statement", "ck_seed", "ck_credential_id", "ck_client_data_json", "ck_authenticator_data", "ck_signature"];
const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
/** A seed no test could mistake for anything else, so finding it anywhere is finding it. */
const SEED = b64u(Buffer.from("SEED-CANARY-0123456789abcdefghij"));
const KEY = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

/** What src/connect-signing.js puts in the Allow form once the passkey has signed, for
 *  this person and this request, with `change` laid over it. */
function signedFields(peerId: string, change: Record<string, string> = {}, statement: { peerId?: string; connection?: string } = {}): Record<string, string> {
  return {
    ck_statement: b64u(statementBytes({
      peerId: statement.peerId ?? peerId, key: KEY, connection: statement.connection ?? ID,
      notBefore: Math.floor(Date.now() / 1000), notAfter: Math.floor(Date.now() / 1000) + 90 * 86400 + 3600,
    })),
    ck_seed: SEED,
    ck_credential_id: CREDENTIAL,
    ck_client_data_json: b64u('{"type":"webauthn.get","challenge":"x","origin":"https://schellingaf.com"}'),
    ck_authenticator_data: b64u(Buffer.alloc(37, 5)),
    ck_signature: b64u(Buffer.alloc(70, 9)),
    ...change,
  };
}

/** Every console method, recording what it was called with, for the length of `work`. */
async function watchingTheLog<T>(work: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const real = methods.map((m) => console[m]);
  const lines: string[] = [];
  for (const m of methods) console[m] = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    return { result: await work(), logged: lines.join("\n") };
  } finally {
    methods.forEach((m, i) => { console[m] = real[i]!; });
  }
}

const allow = (me: { cookie: string; csrf: string }, fields: Record<string, string>) => send("/me/connect", {
  method: "POST",
  headers: { Origin: SITE, Cookie: me.cookie, "Content-Type": FORM },
  body: new URLSearchParams({ csrf: me.csrf, request: ID, ...fields }).toString(),
});

const approveBody = (calls: { method: string; url: URL; body: string | null }[]) => {
  const call = calls.find((c) => c.url.pathname === `/v1/authorizations/${ID}/approve`);
  return call ? JSON.parse(call.body ?? "null") : undefined;
};

describe("letting an app sign the person's posts", () => {
  test("an app that may write is offered the box, ticked, with what it means, and the form carries what the script builds the statement from", async () => {
    const me = await signedIn(CREDENTIAL);
    const before = Math.floor(Date.now() / 1000);
    const { res, text } = await send(`/me/connect?request=${ID}`, { headers: { Cookie: me.cookie } });
    assert.equal(res.status, 200);
    assert.ok(text.includes('<label><input type="checkbox" name="sign_posts" value="1" form="allow-app" checked> Let this app sign your posts</label>'), "the box is not there, ticked");
    assert.match(text, /your passkey signs once to let this app connection sign the posts the app sends, until an hour after its access token would run out\. Revoking the app ends that sooner, and a post the app sends after it ends is not signed\./);
    assert.match(text, /While the app is connected, the service holds the key this app connection signs with\./);
    assert.match(text, /A post signed this way shows that your key allowed this app connection to sign for it, and that the app connection, or the service, signed it\. It does not show that you saw it\./);
    const form = /<form method="post" action="\/me\/connect" class="inline" id="allow-app" autocomplete="off" data-connection-key([^>]*)>([\s\S]*?)<\/form>/.exec(text);
    assert.ok(form, "no Allow form for the script, kept out of the browser's form memory");
    const attr = (name: string) => new RegExp(` ${name}="([^"]*)"`).exec(form[1]!)?.[1];
    assert.equal(attr("data-connection"), ID);
    assert.equal(attr("data-peer"), me.peerId);
    assert.equal(attr("data-lifetime-days"), "90");
    assert.ok(Math.abs(Number(attr("data-not-before")) - before) <= 2, `the page's time: ${attr("data-not-before")}`);
    // No app is named in what the statement is built from.
    assert.doesNotMatch(form[1]!, /client|claude\.ai/);
    assert.equal(attr("data-rp-id"), "schellingaf.com");
    assert.equal(attr("data-credential"), CREDENTIAL);
    for (const name of CK) assert.ok(form[2]!.includes(`<input type="hidden" name="${name}" value="">`), `${name} is not an empty field`);
    assert.ok(form[2]!.includes('<input type="hidden" name="signing_offered" value="1">'));
    assert.match(form[2]!, /<button type="submit" data-guard disabled>Allow<\/button> <span class="meta" data-guard-note role="status" aria-live="polite"><\/span>$/);
    // Nothing on the page is bytes for a passkey to sign: the script writes the statement.
    assert.doesNotMatch(text, /challenge/i);
    // Its script runs after the guard's, under the policy the page had: this site's own
    // script and no request of any kind.
    assert.ok(text.indexOf('<script src="/allow.js"></script>') < text.indexOf('<script type="module" src="/connect-signing.js"></script>'));
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /connect-src/);
  });

  test("an app that may only read, or a lifetime in parts of a day, is offered no box", async () => {
    const me = await signedIn(CREDENTIAL);
    for (const request of [LOOPBACK, ODD_LIFETIME]) {
      const { text } = await send(`/me/connect?request=${request}`, { headers: { Cookie: me.cookie } });
      assert.doesNotMatch(text, /sign_posts|connect-signing\.js|data-connection-key|ck_seed|signing_offered/, request);
      assert.match(text, /<button type="submit" data-guard disabled>Allow<\/button>/, request);
    }
  });

  test("an answer about another request than the one asked for is shown as nothing to answer", async () => {
    const me = await signedIn(CREDENTIAL);
    const { res, text } = await send(`/me/connect?request=${SWAPPED}`, { headers: { Cookie: me.cookie } });
    assert.equal(res.status, 502);
    assert.doesNotMatch(text, /data-connection-key|value="allow"/);
  });

  test("Allow with what the passkey signed passes it on as connection_key, and logs none of it", async () => {
    const me = await signedIn(CREDENTIAL);
    const fields = signedFields(me.peerId);
    const { result: { res, text, asked: calls }, logged } = await watchingTheLog(() => allow(me, { decision: "allow", signing_offered: "1", sign_posts: "1", ...fields }));
    assert.equal(res.status, 200, text.slice(0, 400));
    assert.deepEqual(approveBody(calls), {
      connection_key: {
        statement: fields.ck_statement,
        signature: {
          alg: "webauthn", credential_id: fields.ck_credential_id, client_data_json: fields.ck_client_data_json,
          authenticator_data: fields.ck_authenticator_data, signature: fields.ck_signature,
        },
        seed: SEED,
      },
    });
    assert.match(text, /The app can now act as your key\. It signs the posts it sends with the key your passkey allowed\. Revoke it any time on Access tokens\. Returning you to claude\.ai\./);
    for (const value of Object.values(fields)) {
      assert.ok(!logged.includes(value), "the site logged part of what the passkey signed");
      assert.ok(!text.includes(value), "the answer carries part of what the passkey signed");
    }
    assert.ok(!logged.includes("SEED-CANARY") && !text.includes("SEED-CANARY"));
  });

  test("the page says the app signs only when the product says it kept the key", async () => {
    const me = await signedIn(CREDENTIAL);
    keeps = false;
    try {
      const { text, asked: calls } = await allow(me, { decision: "allow", signing_offered: "1", sign_posts: "1", ...signedFields(me.peerId) });
      assert.ok(approveBody(calls)?.connection_key, "the key was not sent");
      assert.match(text, /The app can now act as your key\. Its posts will not be signed\. Revoke it any time on Access tokens\./);
      assert.doesNotMatch(text, /It signs the posts/);
    } finally {
      keeps = true;
    }
  });

  test("Allow with the box ticked and nothing the script makes beside it allows nothing, and asks again", async () => {
    const me = await signedIn(CREDENTIAL);
    const { res, text, asked: calls } = await allow(me, { decision: "allow", signing_offered: "1", sign_posts: "1", ...Object.fromEntries(CK.map((n) => [n, ""])) });
    assert.equal(res.status, 400);
    assert.deepEqual(asked(calls), [`GET /v1/authorizations/${ID}`], "something was allowed");
    assert.ok(text.includes('<p class="note warn" role="alert">Nothing was allowed: this page had not finished preparing to let the app sign your posts. Press Allow again, or untick the box to allow the app without signing.</p>'));
    assert.match(text, /data-connection-key/, "the page is not drawn again to answer");
    assert.ok(text.includes('name="sign_posts" value="1" form="allow-app" checked'));
  });

  test("Allow with the box unticked connects the app unsigned and says so", async () => {
    const me = await signedIn(CREDENTIAL);
    const unticked = await allow(me, { decision: "allow", signing_offered: "1", ...Object.fromEntries(CK.map((n) => [n, ""])) });
    assert.equal(unticked.res.status, 200);
    assert.deepEqual(approveBody(unticked.asked), {});
    assert.match(unticked.text, /The app can now act as your key\. Its posts will not be signed\. Revoke it any time on Access tokens\./);
    // An app that may only read was offered nothing, so nothing is said of signing.
    const reading = await allow(me, { decision: "allow" });
    assert.deepEqual(approveBody(reading.asked), {});
    assert.match(reading.text, /The app can now act as your key\. Revoke it any time on Access tokens\./);
  });

  test("Allow with anything between, which no page of this site sends, asks the product for nothing", async () => {
    const me = await signedIn(CREDENTIAL);
    const full = signedFields(me.peerId);
    const cases: [string, Record<string, string>][] = [
      ["one field missing", { ...full, ck_signature: "" }],
      ["the seed a byte short", { ...full, ck_seed: b64u(Buffer.alloc(31, 1)) }],
      ["the seed a byte long", { ...full, ck_seed: b64u(Buffer.alloc(33, 1)) }],
      ["the seed padded", { ...full, ck_seed: `${SEED}=` }],
      ["a field that is not base64url", { ...full, ck_client_data_json: "not base64url!" }],
      ["a statement for another key", signedFields(me.peerId, {}, { peerId: "e".repeat(64) })],
      ["a statement for another request", signedFields(me.peerId, {}, { connection: LOOPBACK })],
      ["a statement that is not canonical", { ...full, ck_statement: b64u(JSON.stringify(JSON.parse(Buffer.from(full.ck_statement!, "base64url").toString()), null, 1)) }],
      ["a statement too long", { ...full, ck_statement: b64u(Buffer.alloc(520, 0x61)) }],
    ];
    for (const [what, fields] of cases) {
      const { res, text, asked: calls } = await allow(me, { decision: "allow", signing_offered: "1", sign_posts: "1", ...fields });
      assert.equal(res.status, 400, what);
      assert.match(text, /That was not what this page sends to let an app sign your posts, so nothing was changed\./, what);
      assert.deepEqual(asked(calls), [], what);
      assert.ok(!text.includes(SEED), what);
    }
  });

  test("what the script makes, sent with the box unticked, allows nothing, and asks again", async () => {
    const me = await signedIn(CREDENTIAL);
    const { res, text, asked: calls } = await allow(me, { decision: "allow", signing_offered: "1", ...signedFields(me.peerId) });
    assert.equal(res.status, 400);
    assert.deepEqual(asked(calls), [`GET /v1/authorizations/${ID}`], "something was allowed");
    assert.ok(text.includes('<p class="note warn" role="alert">Nothing was allowed: this page sent a key for the app to sign with, but the box was not ticked. Press Allow again.</p>'));
    assert.ok(!text.includes(SEED));
  });

  test("Decline never sends any of it on", async () => {
    const me = await signedIn(CREDENTIAL);
    const { asked: calls } = await allow(me, { decision: "decline", ...signedFields(me.peerId) });
    const call = calls.find((c) => c.url.pathname === `/v1/authorizations/${ID}/decline`)!;
    assert.deepEqual(JSON.parse(call.body ?? "null"), {});
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
