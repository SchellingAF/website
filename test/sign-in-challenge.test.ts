// A passkey here signs the product's challenge to connect with, and nothing else, on
// both pages that hand it one this site did not make: Connect, on /sign-in, and the
// page that makes an access token, /me/tokens/new.
//
// A passkey signs whatever challenge its prompt carries, and its signature on a post
// is the same kind of statement as its signature on connecting, so a service that
// answered with a post's challenge would get back the person's signature on a post
// they never wrote. src/sign-in-challenge.js is the one rule, and it is asked three
// ways here: directly; through handleRequest(), where this site's server hands the
// product's challenge on or draws it into a page, with a stand-in product that answers
// anything; and in src/sign-in.js and src/new-token.js themselves, each run against a
// stand-in page and passkey, which must never open a prompt for anything else and
// never send anything after refusing.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { CAPABILITIES, json, refusal, signInChallengeHex } from "./lib/service.ts";
import { NOT_A_SIGN_IN_CHALLENGE, signInChallenge } from "../src/sign-in-challenge.js";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sha256 = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
const label = (name: string) => Buffer.from(`agent-state:${name}:v1\0`, "utf8");
const seconds = (iso: string) => Date.parse(iso) / 1000;

// The stand-in product and a connected person, before any test is registered: a file
// that awaits after registering one can see the runner finish, and put the real fetch
// back, before the rest are registered.
let answer: unknown = null;
const { fake, handleRequest } = await site((call) => {
  const p = call.url.pathname;
  if (p === "/v1/capabilities") return json(CAPABILITIES);
  if (p === "/v1/passkeys/challenge") return json(answer);
  if (p === "/v1/conversations") return json({ items: [], requests_waiting: 0, has_more: false, next_before: null });
  return refusal(404, "NOT_ANSWERED");
});
const asked = (pathname: string) => fake.calls.filter((c) => c.url.pathname === pathname).length;
const CREDENTIAL = "Q3JlZGVudGlhbElkRm9yVGhlVGVzdHM";
const { cookie, csrf } = await signedIn("d4".repeat(32), "challenge-test-token", "192.0.2.77", CREDENTIAL);

/** A post's challenge, as the product derives it (passkeyChallengeOf in its
 *  src/domain/objects.ts): the SHA-256 of the object-signature label and the post's id. */
const POST_CHALLENGE = sha256(label("object-signature"), sha256(label("object"), Buffer.from('{"kind":"go","v":1}'))).toString("hex");

/** Answers the product might give in place of a challenge to connect with, each refused. */
const NOT_ONE: [string, unknown][] = [
  ["a post's challenge, 32 bytes", POST_CHALLENGE],
  ["a post's challenge, padded out to 56 bytes", POST_CHALLENGE + "00".repeat(24)],
  ["56 bytes of zeros", "00".repeat(56)],
  ["56 bytes of ff", "ff".repeat(56)],
  ["an expiry a second before 14 September 2026", signInChallengeHex(seconds("2026-09-14T00:00:00Z") - 1)],
  ["an expiry in 2106, once the first four bytes are not zero", signInChallengeHex(2 ** 32)],
  ["one byte short", signInChallengeHex().slice(0, 110)],
  ["one byte long", signInChallengeHex() + "00"],
  ["one hex digit short", signInChallengeHex().slice(0, 111)],
  ["capitals, which the product never writes and refuses", signInChallengeHex().toUpperCase()],
  ["a letter that is not hex", signInChallengeHex().slice(0, 111) + "g"],
  ["a line break after it", signInChallengeHex() + "\n"],
  ["spaces around it", ` ${signInChallengeHex()} `],
  ["a 0x in front", "0x" + signInChallengeHex().slice(2)],
  ["the empty string", ""],
  ["nothing", undefined],
  ["null", null],
  ["a number", 56],
  ["its bytes", Array.from(Buffer.from(signInChallengeHex(), "hex"))],
  ["an object that writes itself as one", { toString: () => signInChallengeHex() }],
];
/** Those a page's form field could hold, which is text. */
const NOT_ONE_TEXT = NOT_ONE.filter((c): c is [string, string] => typeof c[1] === "string");

describe("what a challenge to connect with is", () => {
  test("the product's: 56 bytes, given as 112 lowercase hex characters, the bytes themselves handed back", () => {
    const hex = signInChallengeHex();
    assert.deepEqual(Buffer.from(signInChallenge(hex)!), Buffer.from(hex, "hex"));
    for (const at of [seconds("2026-09-14T00:00:00Z"), 2 ** 32 - 1, seconds("2030-01-01T00:00:00Z")]) {
      assert.notEqual(signInChallenge(signInChallengeHex(at)), null, new Date(at * 1000).toISOString());
    }
  });

  test("nothing else, whatever its shape", () => {
    for (const [what, value] of NOT_ONE) assert.equal(signInChallenge(value), null, what);
  });

  test("never by this device's clock: an expiry long gone, or years ahead, is still one", () => {
    // The product decides whether a challenge is still good. A device whose clock is
    // wrong must still be able to connect.
    for (const at of ["2026-09-15T00:00:00Z", "2099-01-01T00:00:00Z"]) {
      assert.notEqual(signInChallenge(signInChallengeHex(seconds(at))), null, at);
    }
  });
});

// ------------------------------------------------------------------ the server

async function askForChallenge(product: unknown) {
  answer = product;
  const res = await handleRequest(new Request(`${SITE}/sign-in/challenge`, {
    method: "POST", headers: { Origin: SITE, "Content-Type": "application/json" }, body: "{}",
  }), env);
  return { res, text: await res.text() };
}

describe("this site's server, handing the product's challenge on to Connect", () => {
  test("hands on a challenge to connect with, exactly as the product wrote it", async () => {
    const challenge = signInChallengeHex();
    const { res, text } = await askForChallenge({ challenge, rp_id: "schellingaf.com", origins: [SITE] });
    assert.equal(res.status, 200, text);
    assert.deepEqual(JSON.parse(text), { challenge, rp_id: "schellingaf.com" });
  });

  test("refuses anything else, says so in the page's own words, and hands on none of it", async () => {
    for (const [what, challenge] of NOT_ONE) {
      const { res, text } = await askForChallenge({ challenge, rp_id: "schellingaf.com" });
      assert.equal(res.status, 502, what);
      assert.deepEqual(JSON.parse(text), { message: NOT_A_SIGN_IN_CHALLENGE }, what);
      assert.equal(res.headers.get("Cache-Control"), "private, no-store", what);
    }
    for (const product of [null, [], "a challenge", { rp_id: "schellingaf.com" }]) {
      const { res, text } = await askForChallenge(product);
      assert.equal(res.status, 502, JSON.stringify(product));
      assert.deepEqual(JSON.parse(text), { message: NOT_A_SIGN_IN_CHALLENGE }, JSON.stringify(product));
    }
  });
});

describe("this site's server, drawing the product's challenge into the page that makes an access token", () => {
  async function tokenPage(product: unknown) {
    answer = product;
    const res = await handleRequest(new Request(`${SITE}/me/tokens/new`, { headers: { Cookie: cookie } }), env);
    return { res, text: await res.text() };
  }

  test("draws a challenge to connect with into its form", async () => {
    const challenge = signInChallengeHex();
    const { res, text } = await tokenPage({ challenge, rp_id: "schellingaf.com", expires_at: new Date(Date.now() + 300_000).toISOString() });
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.ok(text.includes(`<input type="hidden" name="challenge" value="${challenge}">`));
    assert.equal(text.split('<script type="module" src="/new-token.js"></script>').length, 2);
  });

  test("draws no form for anything else, and puts none of it on the page", async () => {
    for (const [what, challenge] of [...NOT_ONE, ["no answer at all", null] as [string, unknown]]) {
      const { res, text } = await tokenPage(challenge === null ? null : { challenge, rp_id: "schellingaf.com" });
      assert.equal(res.status, 502, what);
      assert.doesNotMatch(text, /data-new-token|name="challenge"|new-token\.js/, what);
      assert.match(text, /did not give this page a passkey challenge/, what);
      if (typeof challenge === "string" && challenge.trim().length > 8) assert.ok(!text.includes(challenge.trim()), `${what}: it reached the page`);
    }
  });

  test("sends the product no answer to anything else the form came back with", async () => {
    const before = asked("/v1/passkeys/verify");
    for (const [what, challenge] of NOT_ONE_TEXT) {
      const res = await handleRequest(new Request(`${SITE}/me/tokens/new`, {
        method: "POST",
        headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          csrf, challenge, label: "an agent", days: "30",
          credential_id: CREDENTIAL, client_data_json: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0", authenticator_data: "AAAA", signature: "MEUCIQ",
        }).toString(),
      }), env);
      assert.equal(res.status, 400, what);
      assert.match(await res.text(), /That form was not one this site sent/, what);
    }
    assert.equal(asked("/v1/passkeys/verify"), before);
  });
});

// ------------------------------------------------------------------ the pages' scripts

/** A browser script as the browser runs it, less its imports, which a test hands in:
 *  Node cannot fetch /sign-in-challenge.js by the address a browser does. */
function withoutImport(file: string, ...lines: string[]): string {
  let rest = readFileSync(path.join(ROOT, "src", file), "utf8");
  for (const line of lines) {
    assert.equal(rest.split(`${line}\n`).length, 2, `${file} does not import as ${line}`);
    rest = rest.replace(`${line}\n`, "");
  }
  assert.doesNotMatch(rest, /^\s*(import|export)\b/m, `${file} imports or exports something else`);
  return rest;
}

const SIGN_IN = withoutImport("sign-in.js",
  'import { NOT_A_SIGN_IN_CHALLENGE, signInChallenge } from "/sign-in-challenge.js";',
  'import { PRF_INPUT, keepKey, keepNoKey, keyFromPrf } from "/sealed-store.js";');
/** The PRF input the page asks a passkey for: content/sealed.md, section 1. */
const PRF_INPUT = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("agent-state:passkey-prf:v1\u0000")));
const NEW_TOKEN = withoutImport("new-token.js", 'import { signInChallenge } from "/sign-in-challenge.js";');

const bytes = (n: number) => new Uint8Array(n).buffer;
/** What a passkey that agrees to everything answers with. */
const credential = {
  rawId: bytes(32),
  response: {
    clientDataJSON: bytes(64), authenticatorData: bytes(37), signature: bytes(70),
    getPublicKey: () => bytes(91), getPublicKeyAlgorithm: () => -7,
  },
};

/** Until every promise a page is waiting on has settled. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

interface PageElement {
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  listeners: Record<string, (() => void)[]>;
  addEventListener(type: string, listener: () => void): void;
  querySelectorAll?(selector: string): PageElement[];
}

/** What a site answers /sign-in/challenge with: a challenge, or a refusal. */
type Answer = { challenge: unknown } | { refused: string };

/**
 * The sign-in page as src/me-render.ts writes it, with src/sign-in.js running on it.
 * The site answers each request for a challenge with the next of `answers`, and the
 * last one ever after.
 */
function signInPage(answers: Answer[], secret: ArrayBuffer | null = null, connect: { fails?: string; refused?: string } = {}) {
  const element = (): PageElement => {
    const listeners: PageElement["listeners"] = {};
    return { textContent: "", hidden: false, disabled: false, value: "", listeners,
      addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener); } };
  };
  const ids = ["passkey", "passkey-status", "passkey-confirm-row", "passkey-sign-in", "passkey-create", "passkey-confirm", "passkey-name", "passkey-none", "passkey-none-why", "passkey-offer-create"];
  const el: Record<string, PageElement> = Object.fromEntries(ids.map((id) => [id, element()]));
  el["passkey-confirm-row"]!.hidden = true;
  el["passkey-none"]!.hidden = true;
  el.passkey!.querySelectorAll = () => [el["passkey-sign-in"]!, el["passkey-create"]!, el["passkey-confirm"]!];

  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const prompts: { how: "get" | "create"; challenge: Uint8Array; extensions?: any }[] = [];
  const kept: unknown[][] = [];
  let n = 0;
  const fetch = async (to: string, init: { body: string }) => {
    sent.push({ path: to, body: JSON.parse(init.body) });
    if (to === "/sign-in" && connect.refused) return { ok: false, json: async () => ({ message: "Not registered.", code: connect.refused }) };
    if (to !== "/sign-in/challenge") return { ok: true, json: async () => ({ location: "/me", peer_id: "ab".repeat(32), wrap: "w".repeat(43) }) };
    const a = answers[Math.min(n++, answers.length - 1)]!;
    return "refused" in a ? { ok: false, json: async () => ({ message: a.refused }) } : { ok: true, json: async () => ({ ...a, rp_id: "schellingaf.com" }) };
  };
  const passkey = (how: "get" | "create") => (options: { publicKey: { challenge: Uint8Array; extensions?: any } }) => {
    prompts.push({ how, challenge: options.publicKey.challenge, extensions: options.publicKey.extensions });
    if (how === "get" && connect.fails) return Promise.reject(Object.assign(new Error("no passkey"), { name: connect.fails }));
    const results = secret && how === "get" ? { prf: { results: { first: secret } } } : {};
    return Promise.resolve({ ...credential, getClientExtensionResults: () => results });
  };
  vm.runInNewContext(SIGN_IN, {
    document: { getElementById: (id: string) => el[id] ?? null, addEventListener: () => {}, visibilityState: "visible" },
    window: { PublicKeyCredential: function PublicKeyCredential() {}, location: { search: "", assign: () => {} } },
    navigator: { credentials: { get: passkey("get"), create: passkey("create") } },
    fetch, btoa, crypto, URLSearchParams,
    NOT_A_SIGN_IN_CHALLENGE, signInChallenge,
    PRF_INPUT,
    keyFromPrf: async (first: ArrayBuffer, peer: string) => ({ from: new Uint8Array(first), peer }),
    keepKey: async (...args: unknown[]) => { kept.push(["key", ...args]); },
    keepNoKey: async (...args: unknown[]) => { kept.push(["none", ...args]); },
  });
  return {
    sent, prompts, kept,
    press: (id: string) => { for (const listener of el[id]!.listeners.click ?? []) listener(); },
    status: () => el["passkey-status"]!.textContent,
    confirmShown: () => !el["passkey-confirm-row"]!.hidden,
    offer: () => (el["passkey-none"]!.hidden ? null : el["passkey-none-why"]!.textContent),
    anyDisabled: () => el.passkey!.querySelectorAll!("button").some((b) => b.disabled),
    signedIn: () => sent.filter((s) => s.path !== "/sign-in/challenge"),
  };
}

describe("src/sign-in.js", () => {
  test("opens the prompt inside the click with a challenge to connect with, and signs exactly its bytes", async () => {
    const challenge = signInChallengeHex();
    const page = signInPage([{ challenge }, { challenge: signInChallengeHex() }]);
    await settle();
    page.press("passkey-sign-in");
    // Before anything is awaited: Safari before macOS 14.4 and iOS 17.4 opens a prompt
    // only inside the click.
    assert.deepEqual(page.prompts.map((p) => p.how), ["get"]);
    assert.deepEqual(Buffer.from(page.prompts[0]!.challenge), Buffer.from(challenge, "hex"));
    await settle();
    assert.deepEqual(page.signedIn().map((s) => [s.path, s.body.challenge]), [["/sign-in", challenge]]);
  });

  test("asks the passkey for the secret sealing needs in the same prompt, and keeps the key it makes under the connection's secret", async () => {
    const secret = new Uint8Array(32).fill(7).buffer;
    const page = signInPage([{ challenge: signInChallengeHex() }, { challenge: signInChallengeHex() }], secret);
    await settle();
    page.press("passkey-sign-in");
    assert.deepEqual(Buffer.from(page.prompts[0]!.extensions.prf.eval.first), Buffer.from(PRF_INPUT));
    await settle();
    await settle();
    assert.equal(page.kept.length, 1);
    const [what, peer, wrap, pair] = page.kept[0] as [string, string, string, { from: Uint8Array; peer: string }];
    assert.deepEqual([what, peer, wrap], ["key", "ab".repeat(32), "w".repeat(43)]);
    assert.deepEqual(Buffer.from(pair.from), Buffer.from(new Uint8Array(32).fill(7)));
    // What the page sent the site is the passkey's answer and nothing of the secret.
    assert.doesNotMatch(JSON.stringify(page.signedIn()), /BwcHBwcH|0707070707/);
  });

  test("a passkey that gives no secret still connects, and the page remembers that sealing is not possible here", async () => {
    const page = signInPage([{ challenge: signInChallengeHex() }, { challenge: signInChallengeHex() }]);
    await settle();
    page.press("passkey-sign-in");
    await settle();
    await settle();
    assert.equal(page.signedIn().length, 1);
    assert.deepEqual(page.kept, [["none", "ab".repeat(32)]]);
  });

  test("Connect that finds no passkey offers to make a key under the button, and the offer makes one inside its click", async () => {
    const page = signInPage([{ challenge: signInChallengeHex() }, { challenge: signInChallengeHex() }], null, { fails: "NotAllowedError" });
    await settle();
    page.press("passkey-sign-in");
    await settle();
    assert.match(page.offer() ?? "", /^No passkey for this site was found/);
    assert.equal(page.anyDisabled(), false);
    page.press("passkey-offer-create");
    assert.deepEqual(page.prompts.map((p) => p.how), ["get", "create"]);
    assert.equal(page.offer(), null, "the offer gives way to the steps of making a key");
  });

  test("Connect with a passkey the service does not know offers the same", async () => {
    const page = signInPage([{ challenge: signInChallengeHex() }, { challenge: signInChallengeHex() }], null, { refused: "PASSKEY_NOT_REGISTERED" });
    await settle();
    page.press("passkey-sign-in");
    await settle();
    await settle();
    assert.match(page.offer() ?? "", /^This passkey is not registered here/);
  });

  test("Connect with anything else held: no prompt, nothing sent, and the page says why", async () => {
    for (const [what, challenge] of NOT_ONE) {
      const page = signInPage([{ challenge }]);
      await settle();
      page.press("passkey-sign-in");
      await settle();
      assert.deepEqual(page.prompts, [], what);
      assert.deepEqual(page.signedIn(), [], what);
      assert.equal(page.status(), NOT_A_SIGN_IN_CHALLENGE, what);
      assert.equal(page.anyDisabled(), false, `${what}: the buttons stayed off`);
    }
  });

  test("Connect with none held, fetching one on the click: the same", async () => {
    const page = signInPage([{ refused: "Too many requests." }, { challenge: POST_CHALLENGE }]);
    await settle();
    page.press("passkey-sign-in");
    await settle();
    assert.deepEqual(page.prompts, []);
    assert.deepEqual(page.signedIn(), []);
    assert.equal(page.status(), NOT_A_SIGN_IN_CHALLENGE);
  });

  test("making a key: anything else is never made a passkey with", async () => {
    const page = signInPage([{ challenge: POST_CHALLENGE }]);
    await settle();
    page.press("passkey-create");
    await settle();
    assert.deepEqual(page.prompts, []);
    assert.deepEqual(page.signedIn(), []);
    assert.equal(page.status(), NOT_A_SIGN_IN_CHALLENGE);
  });

  test("and the new passkey's confirmation, once and after Confirm, never signs anything else", async () => {
    const page = signInPage([{ challenge: signInChallengeHex() }, { challenge: POST_CHALLENGE }]);
    await settle();
    page.press("passkey-create");
    await settle();
    assert.deepEqual(page.prompts.map((p) => p.how), ["create"], "the passkey was made, and asked nothing more");
    assert.deepEqual(page.signedIn(), []);
    assert.ok(page.confirmShown(), "Confirm is offered");
    assert.ok(page.status().startsWith(`${NOT_A_SIGN_IN_CHALLENGE} Your new passkey is made but not registered yet.`), page.status());

    page.press("passkey-confirm");
    await settle();
    assert.deepEqual(page.prompts.map((p) => p.how), ["create"]);
    assert.deepEqual(page.signedIn(), []);
    assert.ok(page.status().startsWith(NOT_A_SIGN_IN_CHALLENGE), page.status());
  });
});

/** The page that makes an access token, as src/me-render.ts writes it with `challenge`
 *  in its form, with src/new-token.js running on it. */
function newTokenPage(challenge: string) {
  const fields: Record<string, { value: string }> = Object.fromEntries(
    ["challenge", "credential_id", "client_data_json", "authenticator_data", "signature", "label", "days"].map((n) => [n, { value: "" }]));
  fields.challenge!.value = challenge;
  const status = { textContent: "" };
  const attributes: Record<string, string> = { "data-valid-for": "270", "data-rp-id": "schellingaf.com", "data-credential": CREDENTIAL };
  const listeners: ((event: { preventDefault(): void }) => void)[] = [];
  let submitted = 0;
  const form = {
    elements: { namedItem: (name: string) => fields[name] ?? null },
    querySelector: (selector: string) => (selector === "[data-token-status]" ? status : selector === "button[type=submit]" ? { disabled: false } : null),
    getAttribute: (name: string) => attributes[name] ?? null,
    addEventListener: (type: string, listener: (event: { preventDefault(): void }) => void) => { if (type === "submit") listeners.push(listener); },
    submit: () => { submitted++; },
  };
  const prompts: Uint8Array[] = [];
  vm.runInNewContext(NEW_TOKEN, {
    document: { querySelector: (selector: string) => (selector === "form[data-new-token]" ? form : null) },
    window: { PublicKeyCredential: function PublicKeyCredential() {} },
    navigator: { credentials: { get: (options: { publicKey: { challenge: Uint8Array } }) => { prompts.push(options.publicKey.challenge); return Promise.resolve(credential); } } },
    btoa, atob, signInChallenge,
  });
  let prevented = 0;
  return {
    prompts, fields,
    press: () => { for (const listener of listeners) listener({ preventDefault: () => { prevented++; } }); },
    status: () => status.textContent,
    submitted: () => submitted,
    prevented: () => prevented,
  };
}

describe("src/new-token.js", () => {
  test("opens the prompt inside the press with a challenge to connect with, signs exactly its bytes, and sends the form", async () => {
    const challenge = signInChallengeHex();
    const page = newTokenPage(challenge);
    page.press();
    assert.equal(page.prompts.length, 1);
    assert.deepEqual(Buffer.from(page.prompts[0]!), Buffer.from(challenge, "hex"));
    await settle();
    assert.equal(page.submitted(), 1);
    assert.notEqual(page.fields.signature!.value, "");
  });

  test("with anything else in the form: no prompt, the form not sent, and the page says why", async () => {
    for (const [what, challenge] of NOT_ONE_TEXT) {
      const page = newTokenPage(challenge);
      page.press();
      await settle();
      assert.deepEqual(page.prompts, [], what);
      assert.equal(page.submitted(), 0, what);
      assert.equal(page.prevented(), 1, `${what}: the browser sent the form itself`);
      assert.match(page.status(), /^The service asked for a signature on something other than this access token, so your passkey was not asked to sign it\. Nothing was made\.$/, what);
    }
  });
});
