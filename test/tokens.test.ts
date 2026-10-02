// An access token for an agent or a program, made on /me/tokens/new and confirmed with
// the passkey the person connected with. The page carries its challenge and its own
// script, which sends no request; the token comes back only in the answer to the form,
// shown once and kept nowhere; nothing a public key could register is ever sent; and a
// passkey of another key makes a token that is revoked at once.

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { json, refusal, service, signInChallengeHex, type Call } from "./lib/service.ts";
import { hostileWorld, SECOND } from "./lib/world.ts";
import { htmlProblems, policy, tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const CHALLENGE = signInChallengeHex();
const TOKEN = `schellingaf_${"7".repeat(64)}`;
const OTHER = "e5e5".repeat(16);

let verifyAnswer: (call: Call) => Response = () => json({ peer_id: SECOND, token: TOKEN, expires_at: "2026-12-17T12:00:00.000Z" });
let revokeAnswer: () => Response = () => new Response(null, { status: 204 });
const base = service(hostileWorld());
const { fake, handleRequest } = await site((call) => {
  const p = call.url.pathname;
  if (p === "/v1/passkeys/challenge") return json({ challenge: CHALLENGE, rp_id: "schellingaf.com", expires_at: new Date(Date.now() + 300_000).toISOString() });
  if (p === "/v1/passkeys/verify") return verifyAnswer(call);
  if (p === "/v1/tokens" && call.method === "GET") {
    return json({ items: [{ id: "c".repeat(64), hash_prefix: "cccc", label: "website connection", created_at: "2026-09-18T10:00:00.000Z", last_used_at: null, expires_at: "2026-09-25T10:00:00.000Z", revoked: false, current: true, app: null }] });
  }
  if (p === "/v1/tokens/current" && call.method === "DELETE") return revokeAnswer();
  return base(call);
});
beforeEach(() => {
  verifyAnswer = () => json({ peer_id: SECOND, token: TOKEN, expires_at: "2026-12-17T12:00:00.000Z" });
  revokeAnswer = () => new Response(null, { status: 204 });
});

const CREDENTIAL = "Q3JlZGVudGlhbElkRm9yVGhlVGVzdHM";
const { cookie, csrf } = await signedIn(SECOND, "tokens-token", "192.0.2.98", CREDENTIAL);
const calls = (path: string) => fake.calls.filter((c) => c.url.pathname === path);

async function get(path: string) {
  const res = await handleRequest(new Request(`${SITE}${path}`, { headers: { Cookie: cookie, "x-schellingaf-client": "198.51.100.7" } }), env);
  return { res, text: await res.text(), h: (n: string) => res.headers.get(n) };
}

async function send(fields: Record<string, string>) {
  const res = await handleRequest(new Request(`${SITE}/me/tokens/new`, {
    method: "POST",
    headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", "x-schellingaf-client": "198.51.100.7" },
    body: new URLSearchParams({ csrf, ...fields }).toString(),
  }), env);
  return { res, text: await res.text(), h: (n: string) => res.headers.get(n) };
}

const answer = { challenge: CHALLENGE, credential_id: CREDENTIAL, client_data_json: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0", authenticator_data: "AAAA", signature: "MEUCIQ" };

describe("an access token for an agent or a program", () => {
  test("the access tokens page offers one, and runs no script", async () => {
    const before = calls("/v1/passkeys/challenge").length;
    const { res, text, h } = await get("/me/tokens");
    assert.equal(res.status, 200);
    assert.match(text, /<a href="\/me\/tokens\/new">Make an access token<\/a>/);
    assert.equal(policy(h("Content-Security-Policy"))["script-src"], undefined);
    assert.equal(calls("/v1/passkeys/challenge").length, before, "no challenge is asked for until the form is");
  });

  test("the form carries a fresh challenge, asks the passkey the person connected with, and runs its one script under a policy that sends nothing", async () => {
    const { res, text, h } = await get("/me/tokens/new");
    assert.equal(res.status, 200, text.slice(0, 300));
    const p = policy(h("Content-Security-Policy"));
    assert.equal(p["script-src"], "'self'");
    assert.equal(p["connect-src"], undefined);
    assert.equal(h("Cache-Control"), "private, no-store");
    const form = tags(text).find((t) => t.name === "form" && t.attributes.some(([n]) => n === "data-new-token"))!;
    assert.equal(form.attributes.find(([n]) => n === "data-credential")?.[1], CREDENTIAL);
    assert.equal(form.attributes.find(([n]) => n === "data-rp-id")?.[1], "schellingaf.com");
    assert.match(text, new RegExp(`name="challenge" value="${CHALLENGE}"`));
    assert.equal(text.split('<script type="module" src="/new-token.js"></script>').length, 2);
    const asked = calls("/v1/passkeys/challenge").at(-1)!;
    assert.equal(asked.headers.get("x-forwarded-for"), "198.51.100.7");
    assert.equal(asked.headers.get("authorization"), null);
    assert.deepEqual(htmlProblems(text.replace('<script type="module" src="/new-token.js"></script>', "")).filter((x) => !/noscript/.test(x)), []);
  });

  test("made, the token is shown once in the form's own answer, and the product is sent the answer and nothing else", async () => {
    const { res, text, h } = await send({ ...answer, label: "Claude Code on my laptop", days: "30" });
    assert.equal(res.status, 200, text.slice(0, 400));
    assert.equal(h("Location"), null);
    assert.equal(text.split(TOKEN).length, 2, "the token is on the page exactly once");
    assert.match(text, new RegExp(`<pre>${TOKEN}</pre>`));
    for (const [, v] of (res.headers as unknown as Iterable<[string, string]>)) assert.ok(!v.includes(TOKEN));
    const sent = JSON.parse(calls("/v1/passkeys/verify").at(-1)!.body!);
    assert.deepEqual(Object.keys(sent).sort(), ["authenticator_data", "challenge", "client_data_json", "credential_id", "label", "signature", "ttl_seconds"]);
    assert.equal(sent.ttl_seconds, 30 * 86400);
    assert.equal(sent.label, "Claude Code on my laptop");
  });

  test("what the product would refuse is refused first, the form drawn again as typed, and nothing is sent", async () => {
    const before = calls("/v1/passkeys/verify").length;
    const cases: [Record<string, string>, RegExp][] = [
      [{ ...answer, label: "", days: "30" }, /at most 64 bytes/],
      [{ ...answer, label: "é".repeat(33), days: "30" }, /at most 64 bytes/],
      [{ ...answer, label: "website connection", days: "30" }, /names this site&#39;s own connections/],
      [{ ...answer, label: "fine", days: "91" }, /from 1 to 90/],
      [{ ...answer, label: "fine", days: "0" }, /from 1 to 90/],
      [{ ...answer, signature: "", label: "fine", days: "30" }, /did not arrive/],
    ];
    for (const [fields, words] of cases) {
      const { res, text } = await send(fields);
      assert.equal(res.status, 400, JSON.stringify(fields));
      assert.match(text, words);
      assert.match(text, /data-new-token/, "the form is drawn again");
    }
    assert.equal(calls("/v1/passkeys/verify").length, before);
  });

  test("a passkey of another key makes a token that is revoked at once, and shown nowhere", async () => {
    verifyAnswer = () => json({ peer_id: OTHER, token: TOKEN, expires_at: "2026-12-17T12:00:00.000Z" });
    const { res, text } = await send({ ...answer, label: "the wrong passkey", days: "1" });
    assert.equal(res.status, 409);
    assert.ok(!text.includes(TOKEN));
    const revoked = calls("/v1/tokens/current").at(-1)!;
    assert.equal(revoked.method, "DELETE");
    assert.equal(revoked.headers.get("authorization"), `Bearer ${TOKEN}`);
    assert.match(text, /was revoked at once/);
  });

  test("a revoke that fails is tried again, and when it fails twice the page says so rather than that it was revoked", async () => {
    verifyAnswer = () => json({ peer_id: OTHER, token: TOKEN, expires_at: "2026-12-17T12:00:00.000Z" });
    revokeAnswer = () => refusal(503, "UNAVAILABLE");
    const before = calls("/v1/tokens/current").length;
    const { res, text } = await send({ ...answer, label: "the wrong passkey", days: "3" });
    assert.equal(res.status, 409);
    assert.ok(!text.includes(TOKEN));
    assert.equal(calls("/v1/tokens/current").length, before + 2);
    assert.doesNotMatch(text, /was revoked at once/);
    assert.match(text, /could not be revoked\. Nobody was shown it, and it lapses within 3 days/);
  });

  test("a challenge that ran out draws the form again with a new one", async () => {
    verifyAnswer = () => refusal(400, "CHALLENGE_EXPIRED");
    const before = calls("/v1/passkeys/challenge").length;
    const { res, text } = await send({ ...answer, label: "late", days: "1" });
    assert.equal(res.status, 400);
    assert.match(text, /That took too long/);
    assert.equal(calls("/v1/passkeys/challenge").length, before + 1);
  });
});
