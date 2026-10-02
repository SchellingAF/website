// Signing through an app connection: the statement a person's passkey signs to let one
// app connection sign their posts, the script on /me/connect that makes the connection's
// key and asks the passkey, and what this site checks on the page of a post the
// connection signed.
//
// Four kinds of evidence:
//
//   1. src/connection-key.js against fixed vectors, byte for byte. The bytes and their
//      hashes were worked out by a second writer, Python's json module with sorted keys
//      and no whitespace, and hashlib, and are written here as constants; node:crypto
//      hashes them again in the test.
//   2. src/connect-signing.js run against a stand-in page and passkey, as
//      test/sign-in-challenge.test.ts runs the connecting scripts: the prompt opens inside
//      the press, signs the hash of the statement the page built itself and nothing it was
//      handed, and Allow goes unsigned when the box is unticked or the browser cannot make
//      the key.
//   3. src/verify.ts on posts made here with node:crypto keys, each correct but for ONE
//      change, which must produce exactly the refusal that names it.
//   4. A post's page, through handleRequest(), which says the post was signed through an
//      app connection and never that its author's key signed it.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { canonicalBytes } from "../src/jcs.js";
import { LABEL, STATEMENT_MAX_BYTES, notAfterOf, readStatement, signedBytes, statementBytes } from "../src/connection-key.js";
import { checkPost } from "../src/verify.ts";
import { CAPABILITIES, CATEGORIES, service, type Json, type World } from "./lib/service.ts";
import { today } from "../content/api-overview.mjs";
import { SITE, env, site } from "./lib/site.ts";

type KeyPair = { publicKey: KeyObject; privateKey: KeyObject };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const label = (name: string) => Buffer.from(`agent-state:${name}:v1\0`, "utf8");
const H = (...parts: Uint8Array[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const rawKey = (k: KeyObject) => k.export({ format: "der", type: "spki" }).subarray(-32);
const spkiOf = (k: KeyPair) => k.publicKey.export({ format: "der", type: "spki" });
const int8 = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; };
const uuid = (u: string) => Buffer.from(u.replace(/-/g, ""), "hex");
const flip = (hexText: string) => (hexText[0] === "0" ? "1" : "0") + hexText.slice(1);

// ------------------------------------------------------------------ 1. the statement

/** The inputs of the first vector. */
const VECTOR = {
  peerId: "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29",
  key: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  connection: "0f0e0d0c-0b0a-4908-8706-050403020100",
  notBefore: 1790000000,
  notAfter: 1790000000 + 90 * 86400 + 3600,
};

/** Worked out with Python: json.dumps(s, sort_keys=True, separators=(",", ":"),
 *  ensure_ascii=False).encode(), and hashlib.sha256(L("connection-key") + those bytes).
 *  The second is the widest window there is, so its numbers are written in full. */
const EXPECTED = {
  text: '{"connection":"0f0e0d0c-0b0a-4908-8706-050403020100","key":"d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a","not_after":1797779600,"not_before":1790000000,"peer_id":"3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29","v":1}',
  challenge: "bafd8f67f5541888d190e161a3522541de272e91db089b568a826efbf4cd3fab",
  widest: '{"connection":"0f0e0d0c-0b0a-4908-8706-050403020100","key":"d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a","not_after":9007199254740991,"not_before":1,"peer_id":"3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29","v":1}',
  widestChallenge: "c1401749b2758fc0c71f4a81e500472fdc57708db4f81e369fea913c21396a4b",
};

describe("the statement that lets an app connection sign", () => {
  test("is written byte for byte as a second writer writes it, and signed under its own label", () => {
    const bytes = statementBytes(VECTOR);
    assert.equal(Buffer.from(bytes).toString("utf8"), EXPECTED.text);
    assert.equal(bytes.length, 256);
    assert.equal(hex(H(Buffer.from(signedBytes(bytes)))), EXPECTED.challenge);
    // The label, written out: agent-state:connection-key:v1 and a NUL, then the bytes.
    assert.equal(LABEL, "connection-key");
    assert.deepEqual(Buffer.from(signedBytes(bytes)), Buffer.concat([label("connection-key"), Buffer.from(EXPECTED.text)]));
    assert.equal(hex(H(label("connection-key"), Buffer.from(EXPECTED.text))), EXPECTED.challenge);
  });

  test("writes the widest window in full, as JSON writes a number", () => {
    const bytes = statementBytes({ ...VECTOR, notBefore: 1, notAfter: Number.MAX_SAFE_INTEGER });
    assert.equal(Buffer.from(bytes).toString("utf8"), EXPECTED.widest);
    assert.equal(hex(H(Buffer.from(signedBytes(bytes)))), EXPECTED.widestChallenge);
  });

  test("names no app: no client_id, nor anything else that could link the keys one app connected", () => {
    assert.deepEqual(Object.keys(JSON.parse(Buffer.from(statementBytes(VECTOR)).toString("utf8"))).sort(),
      ["connection", "key", "not_after", "not_before", "peer_id", "v"]);
  });

  test("is read back to the same fields, and the site's own JSON writer agrees", () => {
    const bytes = statementBytes(VECTOR);
    assert.deepEqual(readStatement(bytes), {
      v: 1, peer_id: VECTOR.peerId, key: VECTOR.key, connection: VECTOR.connection, not_before: VECTOR.notBefore, not_after: VECTOR.notAfter,
    });
    assert.deepEqual(Buffer.from(bytes), Buffer.from(canonicalBytes(JSON.parse(EXPECTED.text))));
  });

  test("refuses to write any field out of the product's shape", () => {
    for (const [what, change] of [
      ["a peer id in capitals", { peerId: VECTOR.peerId.toUpperCase() }],
      ["a peer id a byte short", { peerId: VECTOR.peerId.slice(2) }],
      ["a key that is not hex", { key: "z" + VECTOR.key.slice(1) }],
      ["a key a byte long", { key: VECTOR.key + "00" }],
      ["a request id in capitals", { connection: VECTOR.connection.toUpperCase() }],
      ["a request id without its dashes", { connection: VECTOR.connection.replace(/-/g, "") }],
      ["a start before 1970", { notBefore: -1 }],
      ["a start at 1970 itself", { notBefore: 0 }],
      ["a start in parts of a second", { notBefore: 1.5 }],
      ["a start as text", { notBefore: "1790000000" }],
      ["an end in parts of a second", { notAfter: 1.5 }],
      ["an end past what JSON says exactly", { notAfter: Number.MAX_SAFE_INTEGER + 1 }],
      ["an end before the start", { notAfter: VECTOR.notBefore - 1 }],
    ] as [string, Json][]) {
      assert.throws(() => statementBytes({ ...VECTOR, ...change } as typeof VECTOR), TypeError, what);
    }
    // An end the very second it starts is a statement; the product decides its range.
    assert.doesNotThrow(() => statementBytes({ ...VECTOR, notAfter: VECTOR.notBefore }));
  });

  test("reads back only bytes that are canonical, of exactly its shape, and no longer than the product's 512", () => {
    const fields = JSON.parse(EXPECTED.text) as Json;
    const text = (s: string) => new TextEncoder().encode(s);
    assert.equal(STATEMENT_MAX_BYTES, 512);
    for (const [what, bytes] of [
      ["a space after a colon", text(EXPECTED.text.replace('"v":1', '"v": 1'))],
      ["its members in another order", text(JSON.stringify({ v: 1, ...fields }))],
      ["a member too many", canonicalBytes({ ...fields, extra: true })],
      ["the app's client_id beside them", canonicalBytes({ ...fields, client_id: "https://claude.ai/oauth/client.json" })],
      ["a member missing", canonicalBytes(Object.fromEntries(Object.entries(fields).filter(([name]) => name !== "not_before")))],
      ["version 2", canonicalBytes({ ...fields, v: 2 })],
      ["a member twice", text(EXPECTED.text.replace('"v":1}', '"v":1,"v":1}'))],
      ["the start as text", canonicalBytes({ ...fields, not_before: "1790000000" })],
      ["the start at 1970 itself", canonicalBytes({ ...fields, not_before: 0 })],
      ["the end written 1.0", text(EXPECTED.text.replace("1797779600", "1797779600.0"))],
      ["a key in capitals", canonicalBytes({ ...fields, key: VECTOR.key.toUpperCase() })],
      ["513 bytes", new Uint8Array(513).fill(0x20)],
      ["a list", text("[1]")],
      ["not UTF-8", new Uint8Array([0x7b, 0xff, 0x7d])],
      ["nothing", new Uint8Array(0)],
    ] as [string, Uint8Array][]) {
      assert.equal(readStatement(bytes), null, what);
    }
  });

  test("ends an hour past the token's lifetime, from the time the page was drawn", () => {
    assert.equal(notAfterOf(1_790_000_000, 90), 1_790_000_000 + 90 * 86400 + 3600);
    assert.equal(notAfterOf(1_790_000_000, 1), 1_790_000_000 + 86400 + 3600);
    for (const [now, days] of [[NaN, 90], [1_790_000_000.5, 90], [-1, 90], [0, 90], [1_790_000_000, 0], [1_790_000_000, 1.5], [1_790_000_000, 367]]) {
      assert.equal(notAfterOf(now, days), null, `${now}, ${days}`);
    }
  });
});

// ------------------------------------------------------------------ 2. the page's script

/** A browser script as the browser runs it, less its imports, which a test hands in. */
function withoutImport(file: string, line: string): string {
  const text = readFileSync(path.join(ROOT, "src", file), "utf8");
  assert.equal(text.split(`${line}\n`).length, 2, `${file} does not import as ${line}`);
  const rest = text.replace(`${line}\n`, "");
  assert.doesNotMatch(rest, /^\s*(import|export)\b/m, `${file} imports or exports something else`);
  return rest;
}
const SCRIPT = withoutImport("connect-signing.js", 'import { notAfterOf, signedBytes, statementBytes } from "/connection-key.js";');

const FIELDS = ["ck_statement", "ck_seed", "ck_credential_id", "ck_client_data_json", "ck_authenticator_data", "ck_signature"];
const PAGE_PEER = "d4".repeat(32);
const REQUEST = "0f0e0d0c-0b0a-4908-8706-050403020100";
const NOW = 1_790_000_000;
const CREDENTIAL = "Q3JlZGVudGlhbElkRm9yVGhlVGVzdHM";
/** A post's challenge, which a page that handed its passkey anything would have signed. */
const POST_CHALLENGE = hex(H(label("object-signature"), H(label("object"), Buffer.from('{"kind":"go","v":1}'))));

const bytes = (n: number, fill = 0) => new Uint8Array(n).fill(fill).buffer;
const answer = { rawId: bytes(16, 1), response: { clientDataJSON: bytes(64, 2), authenticatorData: bytes(37, 3), signature: bytes(70, 4) } };

interface PageOptions {
  attributes?: Record<string, string | null>;
  /** The browser has Ed25519 in Web Crypto. */
  ed25519?: boolean;
  /** The browser can use a passkey. */
  passkeys?: boolean;
  /** The person cancels the prompt. */
  cancel?: boolean;
  /** The person unticks the box while the prompt is open. */
  untick?: boolean;
  /** Sending the form throws, after the browser took its entries. */
  submitThrows?: boolean;
}

/** /me/connect as src/connect.ts writes it for an app that may write, with
 *  src/connect-signing.js running on it. */
function connectPage(options: PageOptions = {}) {
  const fields: Record<string, { value: string }> = Object.fromEntries(FIELDS.map((name) => [name, { value: "" }]));
  const box = { checked: true, disabled: false };
  const allowButton = { disabled: false };
  let reloaded = 0;
  const status = { textContent: "" };
  const attributes: Record<string, string | null> = {
    "data-connection": REQUEST, "data-peer": PAGE_PEER, "data-not-before": String(NOW), "data-lifetime-days": "90",
    "data-rp-id": "schellingaf.com", "data-credential": CREDENTIAL, ...options.attributes,
  };
  const listeners: ((event: Json) => void)[] = [];
  // What each sending of the form carried, taken as a browser takes a form's entries: as
  // it is sent.
  const sent: Record<string, string>[] = [];
  const form = {
    elements: { namedItem: (name: string) => (name === "sign_posts" ? box : fields[name] ?? null) },
    getAttribute: (name: string) => attributes[name] ?? null,
    querySelector: (selector: string) => (selector === "button[type=submit]" ? allowButton : null),
    addEventListener: (type: string, listener: (event: Json) => void) => { if (type === "submit") listeners.push(listener); },
    submit: () => {
      sent.push(Object.fromEntries(FIELDS.map((name) => [name, fields[name]!.value])));
      if (options.submitThrows) throw new Error("the form could not be sent");
    },
  };
  // Every promise Web Crypto hands the page, so a test can wait for it to finish making the key.
  const pending: Promise<unknown>[] = [];
  const track = <T>(p: Promise<T>): Promise<T> => { pending.push(p); return p; };
  const subtle = {
    generateKey: (...args: Parameters<SubtleCrypto["generateKey"]>) => track(options.ed25519 === false
      ? Promise.reject(Object.assign(new Error("Unrecognized name."), { name: "NotSupportedError" }))
      : crypto.subtle.generateKey(...args)),
    exportKey: (format: "jwk", key: CryptoKey) => track(crypto.subtle.exportKey(format, key)),
    digest: (algorithm: string, data: BufferSource) => track(crypto.subtle.digest(algorithm, data)),
  };
  const prompts: Json[] = [];
  const shown: ((event: Json) => void)[] = [];
  vm.runInNewContext(SCRIPT, {
    document: { querySelector: (selector: string) => (selector === "form[data-connection-key]" ? form : selector === "[data-sign-status]" ? status : null) },
    window: options.passkeys === false ? {} : {
      PublicKeyCredential: function PublicKeyCredential() {},
      addEventListener: (type: string, listener: (event: Json) => void) => { if (type === "pageshow") shown.push(listener); },
      location: { reload: () => { reloaded++; } },
    },
    navigator: {
      credentials: {
        get: (o: { publicKey: Json }) => {
          prompts.push(o.publicKey);
          if (options.untick) box.checked = false;
          return options.cancel ? Promise.reject(Object.assign(new Error("closed"), { name: "NotAllowedError" })) : Promise.resolve(answer);
        },
      },
    },
    crypto: { subtle },
    btoa, atob,
    notAfterOf, signedBytes, statementBytes,
  });
  let prevented = 0;
  return {
    prompts, fields, box, allowButton, sent, submitted: () => sent.length, prevented: () => prevented, status: () => status.textContent,
    reloaded: () => reloaded,
    /** The browser showing the page: from its history, or not. */
    show: (persisted: boolean) => { for (const listener of shown) listener({ persisted }); },
    /** Until the key is made and the statement written, or making it failed. */
    ready: async () => {
      for (let seen = -1; seen !== pending.length;) {
        seen = pending.length;
        await Promise.allSettled(pending);
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    /** A press on Allow that src/allow.js counted, or did not. */
    press: (counted = true) => {
      const event = { defaultPrevented: !counted, preventDefault() { event.defaultPrevented = true; prevented++; } };
      for (const listener of listeners) listener(event);
    },
  };
}

/** D's public key, from the 32-byte seed the page sends, by node:crypto. */
function publicOfSeed(seed: Buffer): string {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return hex(rawKey(createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }))));
}

describe("src/connect-signing.js, on /me/connect", () => {
  test("opens the passkey's prompt inside the press, over the hash of a statement it wrote itself, and sends the key it made", async () => {
    const page = connectPage();
    await page.ready();
    assert.equal(page.status(), "");
    page.press();
    // Before anything is awaited: older Safari opens a prompt only inside the click.
    assert.equal(page.prompts.length, 1);
    assert.equal(page.prevented(), 1, "the form waited for the passkey");
    const prompt = page.prompts[0]!;
    assert.equal(prompt.userVerification, "required");
    assert.equal(prompt.rpId, "schellingaf.com");
    assert.deepEqual(Buffer.from(prompt.allowCredentials[0].id), Buffer.from(CREDENTIAL, "base64url"));
    await page.ready();
    assert.equal(page.submitted(), 1);
    const form = page.sent[0]!;

    const statement = Buffer.from(form.ck_statement!, "base64url");
    const read = readStatement(new Uint8Array(statement));
    assert.ok(read, "the statement is not canonical or not of its shape");
    assert.deepEqual({ ...read, key: "" }, {
      v: 1, peer_id: PAGE_PEER, key: "", connection: REQUEST, not_before: NOW, not_after: NOW + 90 * 86400 + 3600,
    });
    // What the passkey signed is the hash of exactly that statement under its label.
    assert.deepEqual(Buffer.from(prompt.challenge), H(label("connection-key"), statement));
    // The seed is 32 bytes, and its public key is the one the statement names.
    const seed = Buffer.from(form.ck_seed!, "base64url");
    assert.equal(seed.length, 32);
    assert.equal(publicOfSeed(seed), read!.key);
    assert.equal(form.ck_credential_id, b64u(new Uint8Array(answer.rawId)));
    assert.equal(form.ck_client_data_json, b64u(new Uint8Array(answer.response.clientDataJSON)));
    assert.equal(form.ck_authenticator_data, b64u(new Uint8Array(answer.response.authenticatorData)));
    assert.equal(form.ck_signature, b64u(new Uint8Array(answer.response.signature)));
  });

  test("empties the form's fields as soon as it is sent, so no field holds the seed after", async () => {
    const page = connectPage();
    await page.ready();
    page.press();
    await page.ready();
    assert.notEqual(page.sent[0]!.ck_seed, "", "the form went without the seed");
    assert.ok(FIELDS.every((name) => page.fields[name]!.value === ""), "a field still holds what was sent");
  });

  test("never asks the passkey to sign bytes the page was handed, whatever the page carries", async () => {
    const page = connectPage({ attributes: { "data-challenge": POST_CHALLENGE } });
    await page.ready();
    page.press();
    assert.equal(page.prompts.length, 1);
    assert.notEqual(hex(page.prompts[0]!.challenge), POST_CHALLENGE);
    await page.ready();
    assert.deepEqual(Buffer.from(page.prompts[0]!.challenge), H(label("connection-key"), Buffer.from(page.sent[0]!.ck_statement!, "base64url")));
  });

  test("makes a new key for every page, so two pages never share one", async () => {
    const one = connectPage();
    const two = connectPage();
    await one.ready();
    await two.ready();
    one.press();
    two.press();
    await one.ready();
    await two.ready();
    assert.notEqual(one.sent[0]!.ck_seed, two.sent[0]!.ck_seed);
  });

  test("unticked, asks nothing and adds nothing: Allow connects the app unsigned", async () => {
    const page = connectPage();
    await page.ready();
    page.box.checked = false;
    page.press();
    assert.deepEqual(page.prompts, []);
    assert.equal(page.prevented(), 0, "the form was held");
    assert.ok(FIELDS.every((name) => page.fields[name]!.value === ""));
  });

  test("a press src/allow.js did not count asks nothing", async () => {
    const page = connectPage();
    await page.ready();
    page.press(false);
    assert.deepEqual(page.prompts, []);
    assert.ok(FIELDS.every((name) => page.fields[name]!.value === ""));
  });

  test("a browser without Ed25519 in Web Crypto, or without passkeys, turns the box off and says the app's posts will not be signed", async () => {
    for (const options of [{ ed25519: false }, { passkeys: false }] as PageOptions[]) {
      const page = connectPage(options);
      await page.ready();
      assert.equal(page.box.checked, false, JSON.stringify(options));
      assert.equal(page.box.disabled, true, JSON.stringify(options));
      assert.equal(page.status(), "This browser cannot make the key an app signs with, so the app's posts will not be signed.");
      page.press();
      assert.deepEqual(page.prompts, []);
      assert.equal(page.prevented(), 0, "Allow did not go on unsigned");
    }
  });

  test("a field the server drew out of shape makes no statement: the box goes off and Allow goes unsigned", async () => {
    for (const attributes of [
      { "data-connection": REQUEST.toUpperCase() }, { "data-connection": null }, { "data-peer": "d4".repeat(31) }, { "data-peer": null },
      { "data-lifetime-days": "0" }, { "data-lifetime-days": "ninety" }, { "data-not-before": "" }, { "data-not-before": null },
      { "data-not-before": "0" }, { "data-not-before": "1790000000.5" },
    ] as Record<string, string | null>[]) {
      const page = connectPage({ attributes });
      await page.ready();
      assert.equal(page.box.checked, false, JSON.stringify(attributes));
      assert.equal(page.box.disabled, true, JSON.stringify(attributes));
      assert.equal(page.status(), "This page could not prepare the key the app signs with, so the app's posts will not be signed.", JSON.stringify(attributes));
      page.press();
      assert.deepEqual(page.prompts, [], JSON.stringify(attributes));
    }
  });

  test("a press before the key is made waits, and says so", () => {
    const page = connectPage();
    page.press();
    assert.deepEqual(page.prompts, []);
    assert.equal(page.prevented(), 1);
    assert.equal(page.status(), "Still making the key the app signs with. Press Allow again in a moment.");
  });

  test("once sent, the box and Allow are off, nothing is ready to send again, and a page from history is drawn afresh", async () => {
    const page = connectPage();
    await page.ready();
    page.press();
    await page.ready();
    assert.equal(page.submitted(), 1);
    assert.equal(page.box.disabled, true);
    assert.equal(page.allowButton.disabled, true);
    page.press();
    assert.equal(page.prompts.length, 1, "the passkey was asked again");
    page.show(false);
    assert.equal(page.reloaded(), 0);
    page.show(true);
    assert.equal(page.reloaded(), 1);
  });

  test("a box unticked while the passkey was asked sends nothing, and says so", async () => {
    const page = connectPage({ untick: true });
    await page.ready();
    page.press();
    await page.ready();
    assert.equal(page.prompts.length, 1);
    assert.equal(page.submitted(), 0);
    assert.ok(FIELDS.every((name) => page.fields[name]!.value === ""));
    assert.equal(page.status(), "You unticked the box, so nothing was sent. Press Allow again to allow the app without signing your posts.");
  });

  test("a sending that throws leaves no field holding the seed", async () => {
    const page = connectPage({ submitThrows: true });
    await page.ready();
    page.press();
    await page.ready();
    assert.equal(page.sent.length, 1);
    assert.ok(FIELDS.every((name) => page.fields[name]!.value === ""));
  });

  test("a cancelled prompt sends nothing, keeps nothing in the form, and says how to go on", async () => {
    const page = connectPage({ cancel: true });
    await page.ready();
    page.press();
    await page.ready();
    assert.equal(page.submitted(), 0);
    assert.ok(FIELDS.every((name) => page.fields[name]!.value === ""));
    assert.equal(page.status(), "Your passkey did not sign, so nothing was sent. Press Allow to try again, or untick the box to allow the app without signing your posts.");
  });
});

// ------------------------------------------------------------------ 3. what this site checks

const SPACE = "0199aaaa-0000-7000-8000-00000000abcd";
const PASSKEYS = { rpId: "schellingaf.com", origins: ["https://schellingaf.com"] };
const NOT_BEFORE = Date.parse("2026-10-01T00:00:00.000Z") / 1000;
const NOT_AFTER = Date.parse("2027-01-01T00:00:00.000Z") / 1000;
const POSTED_AT = "2026-10-02T12:00:00.000Z";

const passkey = generateKeyPairSync("ec", { namedCurve: "P-256" }) as KeyPair;
const otherPasskey = generateKeyPairSync("ec", { namedCurve: "P-256" }) as KeyPair;
const passkeyAuthor = hex(H(label("passkey"), spkiOf(passkey)));
const otherPasskeyAuthor = hex(H(label("passkey"), spkiOf(otherPasskey)));
const agent = generateKeyPairSync("ed25519") as KeyPair;
const stranger = generateKeyPairSync("ed25519") as KeyPair;
const agentAuthor = hex(H(label("agent"), rawKey(agent.publicKey)));
const connectionKey = generateKeyPairSync("ed25519") as KeyPair;
const otherConnectionKey = generateKeyPairSync("ed25519") as KeyPair;

interface Change {
  /** The KEY the statement names as allowing. */
  peer?: string;
  /** The key the statement lets sign. */
  statementKey?: KeyPair;
  notBefore?: number;
  notAfter?: number;
  postedAt?: string;
  /** The key that signed the post, and the one the signature names. */
  signer?: KeyPair;
  namedKey?: KeyPair;
  /** The passkey that signed the statement; or, for an Ed25519 author, the key. */
  allower?: KeyPair;
  /** What the passkey's prompt carried, and where it ran. */
  challenge?: string;
  origin?: string;
  /** The statement's bytes as they travel, in place of canonical ones. */
  statementText?: string;
  /** For an author whose own key is Ed25519. */
  ed25519?: boolean;
  seq?: number;
}

/** A post an app connection signed, with its proof and the statement allowing it, as the
 *  product's proof carries them (its src/http/postview.ts): the statement and its
 *  envelope in the signature, as `delegation`, and the author's key beside them as a
 *  post's own signature carries it. Changed in one way at most. */
function connectionPost(change: Change = {}): Json {
  const author = change.ed25519 ? agentAuthor : passkeyAuthor;
  const object = { v: 1, space_id: SPACE, author_id: author, idempotency_key: "k-app", kind: "result", title: "Sent through the app", body: "Checked twice." };
  const objectBytes = Buffer.from(canonicalBytes(object));
  const objectId = H(label("object"), objectBytes);
  const statement = change.statementText !== undefined ? Buffer.from(change.statementText) : Buffer.from(statementBytes({
    peerId: change.peer ?? author, key: hex(rawKey((change.statementKey ?? connectionKey).publicKey)), connection: REQUEST,
    notBefore: change.notBefore ?? NOT_BEFORE, notAfter: change.notAfter ?? NOT_AFTER,
  }));
  const signed = Buffer.concat([label("connection-key"), statement]);
  let envelope: Json;
  let authorKey: Json;
  if (change.ed25519) {
    const allower = change.allower ?? agent;
    envelope = { alg: "ed25519", signature: hex(sign(null, signed, allower.privateKey)) };
    authorKey = { public_key: hex(rawKey(allower.publicKey)) };
  } else {
    const allower = change.allower ?? passkey;
    const client = Buffer.from(JSON.stringify({
      type: "webauthn.get", challenge: change.challenge ?? b64u(H(signed)), origin: change.origin ?? "https://schellingaf.com", crossOrigin: false,
    }));
    const auth = Buffer.concat([H(Buffer.from("schellingaf.com")), Buffer.from([0x05]), Buffer.from([0, 0, 0, 7])]);
    envelope = {
      alg: "webauthn", credential_id: "Y3JlZGVudGlhbA", client_data_json: b64u(client), authenticator_data: b64u(auth),
      signature: b64u(sign("sha256", Buffer.concat([auth, H(client)]), allower.privateKey)),
    };
    authorKey = { public_key: b64u(spkiOf(allower)), key_algorithm: "ES256" };
  }
  const value = sign(null, Buffer.concat([label("object-signature"), objectId]), (change.signer ?? connectionKey).privateKey);
  const seq = change.seq ?? 3;
  const previous = seq === 1 ? H(label("object-genesis"), uuid(SPACE)) : H(Buffer.from("the link before"));
  const admission = H(Buffer.from("an admission"));
  const connection = { alg: "connection", signature: hex(value), connection_key: hex(rawKey((change.namedKey ?? connectionKey).publicKey)) };
  return {
    space_id: SPACE, seq: String(seq), author, kind: "result", title: "Sent through the app", body: "Checked twice.", posted_at: change.postedAt ?? POSTED_AT,
    to: [], reply_to: null, supersedes: null, retracts: null, fingerprints: [], data: null, budget: null, run_id: null,
    proof: {
      object_id: hex(objectId), canonical: b64u(objectBytes),
      signature: { ...connection, ...authorKey, delegation: { statement: b64u(statement), signature: envelope } },
      chain: { seq: String(seq), admission: hex(admission), previous_hash: hex(previous), chain_hash: hex(H(label("object-chain"), uuid(SPACE), int8(seq), admission, previous, objectId)) },
    },
  };
}

/** The statement and its envelope, inside the signature. */
const delegationOf = (post: Json): Json => post.proof.signature.delegation;

async function refused(post: Json, problems: string[], passkeys: typeof PASSKEYS | null = PASSKEYS) {
  const r = await checkPost(post, passkeys, SPACE);
  assert.deepEqual(r.problems, problems);
  assert.equal(r.signature, "failed");
  assert.equal(r.connection, null);
  return r;
}

describe("a post an app connection signed", () => {
  test("holds when the author's passkey allowed the connection and the connection signed it", async () => {
    const r = await checkPost(connectionPost(), PASSKEYS, SPACE);
    assert.deepEqual(r.problems, []);
    assert.equal(r.signature, "verified");
    assert.equal(r.alg, "connection");
    assert.equal(r.chain, "holds");
    assert.deepEqual(r.connection, { connection: REQUEST, notBefore: NOT_BEFORE, notAfter: NOT_AFTER, allowedWith: "webauthn" });
  });

  test("reads the statement inside the signature alone: one beside it, or the author's key in its envelope, is not read", async () => {
    const beside = connectionPost();
    beside.proof.delegation = beside.proof.signature.delegation;
    delete beside.proof.signature.delegation;
    await refused(beside, ["The post carries no statement of its author allowing the app connection that this site can read."]);
    const keyInEnvelope = connectionPost();
    Object.assign(keyInEnvelope.proof.signature.delegation.signature, { public_key: keyInEnvelope.proof.signature.public_key, key_algorithm: "ES256" });
    delete keyInEnvelope.proof.signature.public_key;
    await refused(keyInEnvelope, ["The passkey's signature allowing the app connection is not written as a browser's prompt writes one."]);
  });

  test("holds when an agent's own Ed25519 key allowed it", async () => {
    const r = await checkPost(connectionPost({ ed25519: true }), PASSKEYS, SPACE);
    assert.deepEqual(r.problems, []);
    assert.equal(r.signature, "verified");
    assert.equal(r.connection?.allowedWith, "ed25519");
  });

  test("holds for a post sent the very second the permission starts or ends, and not a second outside it", async () => {
    for (const second of [NOT_BEFORE, NOT_AFTER]) {
      assert.deepEqual((await checkPost(connectionPost({ postedAt: new Date(second * 1000).toISOString() }), PASSKEYS, SPACE)).problems, []);
    }
    await refused(connectionPost({ postedAt: new Date(NOT_AFTER * 1000 + 1000).toISOString() }),
      ["The post was sent after its author's permission for the app connection ended."]);
    await refused(connectionPost({ postedAt: new Date(NOT_BEFORE * 1000 - 1000).toISOString() }),
      ["The post was sent before its author's key allowed the app connection to sign."]);
    const undated = connectionPost();
    undated.posted_at = "yesterday";
    await refused(undated, ["The post does not say when it was sent, so this site cannot check that the app connection could sign it then."]);
  });

  test("does not hold for a statement that names another key as allowing", async () => {
    // The author's own passkey signed it, for somebody else.
    await refused(connectionPost({ peer: otherPasskeyAuthor }), ["The statement allowing the app connection names another key than the post's author."]);
    // Somebody else's passkey, allowing for themselves, put on this author's post.
    await refused(connectionPost({ peer: otherPasskeyAuthor, allower: otherPasskey }), [
      "The statement allowing the app connection names another key than the post's author.",
      "The passkey that allowed the app connection is not the author's key.",
    ]);
  });

  test("does not hold when the key that signed is not the one allowed", async () => {
    // The statement allows another key; the connection's own key signed the post.
    await refused(connectionPost({ statementKey: otherConnectionKey }),
      ["The statement allowing the app connection names another key than the one that signed the post."]);
    // Another key signed the post and is named as the signer; the statement allows the first.
    await refused(connectionPost({ signer: otherConnectionKey, namedKey: otherConnectionKey }),
      ["The statement allowing the app connection names another key than the one that signed the post."]);
    // The right key is named, and another one signed.
    await refused(connectionPost({ signer: otherConnectionKey }), ["The app connection's signature does not verify."]);
  });

  test("does not hold with the connection's signature changed", async () => {
    const post = connectionPost();
    post.proof.signature.signature = flip(post.proof.signature.signature);
    await refused(post, ["The app connection's signature does not verify."]);
  });

  test("does not hold with the passkey's signature on the statement changed, or another passkey's", async () => {
    const post = connectionPost();
    const value = Buffer.from(delegationOf(post).signature.signature, "base64url");
    value[value.length - 1] ^= 1;
    delegationOf(post).signature.signature = b64u(value);
    await refused(post, ["The passkey's signature allowing the app connection does not verify."]);
    await refused(connectionPost({ allower: otherPasskey }), ["The passkey that allowed the app connection is not the author's key."]);
  });

  test("does not hold for a passkey that signed the statement without its label, or a post's challenge", async () => {
    const statement = Buffer.from(delegationOf(connectionPost()).statement, "base64url");
    for (const challenge of [b64u(H(statement)), b64u(H(label("object-signature"), statement))]) {
      await refused(connectionPost({ challenge }), ["The passkey allowing the app connection signed a different challenge from the statement's."]);
    }
  });

  test("does not hold for a passkey that allowed on a page the service does not accept, or with no word on where its passkeys belong", async () => {
    await refused(connectionPost({ origin: "https://evil.example" }), ["The passkey prompt allowing the app connection ran on a page the service does not accept."]);
    await refused(connectionPost(), ["The service publishes no site or pages for its passkeys, so this site cannot confirm where the passkey allowing the app connection signed."], null);
  });

  test("does not hold with an Ed25519 author's statement signed by another key, or changed", async () => {
    await refused(connectionPost({ ed25519: true, allower: stranger }), ["The key that allowed the app connection is not the author's key."]);
    const post = connectionPost({ ed25519: true });
    delegationOf(post).signature.signature = flip(delegationOf(post).signature.signature);
    await refused(post, ["The Ed25519 signature allowing the app connection does not verify."]);
  });

  test("does not hold without a statement this site can read: missing, not canonical, or of another shape", async () => {
    const NONE = ["The post carries no statement of its author allowing the app connection that this site can read."];
    const missing = connectionPost();
    delete missing.proof.signature.delegation;
    await refused(missing, NONE);
    const fields = JSON.parse(Buffer.from(delegationOf(connectionPost()).statement, "base64url").toString("utf8")) as Json;
    await refused(connectionPost({ statementText: JSON.stringify(fields, null, 1) }), NONE);
    await refused(connectionPost({ statementText: JSON.stringify({ ...fields, v: 2 }) }), NONE);
    const unsigned = connectionPost();
    delegationOf(unsigned).signature = null;
    await refused(unsigned, NONE);
    const unknown = connectionPost();
    delegationOf(unknown).signature.alg = "rsa";
    await refused(unknown, ["The statement allowing the app connection carries a signature of a kind this site does not know."]);
  });

  test("does not hold with the connection's signature or key not written as Ed25519's", async () => {
    for (const change of [
      (s: Json) => { s.signature = s.signature.slice(2); },
      (s: Json) => { s.connection_key = s.connection_key.toUpperCase(); },
      (s: Json) => { delete s.connection_key; },
      (s: Json) => { s.value = s.signature; delete s.signature; },
    ]) {
      const post = connectionPost();
      change(post.proof.signature);
      await refused(post, ["The app connection's signature or its key is not written as an Ed25519 signature is."]);
    }
  });

  test("is still the post as the page shows it: a changed title is named, and nothing is said to be allowed", async () => {
    const post = connectionPost();
    post.title = "Another title";
    await refused(post, ["What the page shows differs from the signed bytes in: title."]);
  });
});

// ------------------------------------------------------------------ 4. a post's page

const SPACE_NAME = "app-signed";
const pagePost = connectionPost({ seq: 1 });
const { proof: pageProof, ...pageFields } = pagePost;
const streamPost = { ...pageFields, post_id: "0199a1a1-0000-7000-8000-000000000001", space: SPACE_NAME, signed: true, signed_by: "connection", object_id: pageProof.object_id };
/** A post its author's own key signed, beside it in the stream: the product names no signer then. */
const keySigned = { ...pageFields, seq: "2", title: "Signed by its author", post_id: "0199a1a1-0000-7000-8000-000000000002", space: SPACE_NAME, signed: true, object_id: "ab".repeat(32) };
const world: World = {
  capabilities: CAPABILITIES,
  categories: CATEGORIES,
  spaces: [{
    name: SPACE_NAME, space_id: SPACE, title: "Signed through an app", description: "Posts an app sent.", visibility: "public", join_policy: "request",
    status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: passkeyAuthor,
    contacts: [{ peer_id: passkeyAuthor, role: "owner" }], created_at: "2026-10-01T09:00:00.000Z",
  } as Json],
  posts: { [SPACE_NAME]: [streamPost, keySigned] },
  proofs: { [`${SPACE_NAME}/1`]: { post: { ...streamPost, proof: pageProof }, leaf: "", checkpoint: null, inclusion: null } },
  checkpoints: { [SPACE_NAME]: [] },
  peers: {},
};
const { handleRequest } = await site(service(world));

async function get(address: string) {
  const res = await handleRequest(new Request(`${SITE}${address}`), env);
  return { status: res.status, text: await res.text() };
}

describe("the page of a post an app connection signed", () => {
  test("says it was signed through an app connection its author's key allowed, from when until when, and what that does not show", async () => {
    const page = await get(`/spaces/${SPACE_NAME}/1`);
    assert.equal(page.status, 200);
    assert.match(page.text, new RegExp(`<p class="note ok">Signed through an app connection: key <a href="/peers/${passkeyAuthor}">.*?</a> allowed it, with its passkey, to sign for that key from 1 Oct 2026, 00:00 UTC until 1 Jan 2027, 00:00 UTC at the latest, and the app connection, or the service, which held its key, signed this post\\. This site checked both signatures\\.</p>`));
    assert.match(page.text, /<p class="note warn">That does not show anybody saw this post\. Revoking the app ends its permission sooner, which this page cannot see\. The time it was posted is the service's own word\.<\/p>/);
    assert.doesNotMatch(page.text, /Signed by key/, "the page says the author's own key signed it");
    assert.match(page.text, /<dt>could sign<\/dt><dd>from 1 Oct 2026, 00:00 UTC until 1 Jan 2027, 00:00 UTC at the latest<\/dd>/);
    assert.match(page.text, /<dt>app connection&#39;s key<\/dt>/);
    assert.doesNotMatch(page.text, /client_id|claude\.ai/, "the page names an app the statement does not");
  });

  test("a listing says a post an app connection signed was signed through one, and a post its author's key signed is signed", async () => {
    const html = (await get(`/spaces/${SPACE_NAME}`)).text;
    assert.match(html, /<a href="\/spaces\/app-signed\/1">#1<\/a> &middot; [^<]* &middot; by <a [^>]*>.*?<\/a> &middot; signed through an app connection<\/p>/);
    assert.match(html, /<a href="\/spaces\/app-signed\/2">#2<\/a> &middot; [^<]* &middot; by <a [^>]*>.*?<\/a> &middot; signed<\/p>/);
    const md = (await get(`/spaces/${SPACE_NAME}.md`)).text;
    assert.match(md, /by [0-9a-f]{64}, signed through an app connection\n/);
    assert.match(md, /by [0-9a-f]{64}, signed\n/);
    const doc = JSON.parse((await get(`/spaces/${SPACE_NAME}.json`)).text) as Json;
    const bySeq = Object.fromEntries((doc.posts as Json[]).map((p) => [p.seq, p]));
    assert.equal(bySeq["1"].signed_by, "connection");
    assert.equal(bySeq["2"].signed, true);
    assert.equal(bySeq["2"].signed_by, null);
  });

  test("the markdown and the JSON say the same, field by field", async () => {
    const md = (await get(`/spaces/${SPACE_NAME}/1.md`)).text;
    assert.match(md, /- Signed through an app connection: key [0-9a-f]{64} allowed it, with its passkey, to sign for that key from 2026-10-01T00:00:00\.000Z until 2027-01-01T00:00:00\.000Z at the latest, and the app connection, or the service, which held its key, signed this post\./);
    assert.match(md, /- CAUTION: That does not show anybody saw this post\. Revoking the app ends its permission sooner, which this page cannot see\. The time it was posted is the service's own word\./);
    assert.match(md, /- signature: connection\n- connection_key: [0-9a-f]{64}\n- connection_not_before: 1790812800\n- connection_not_after: 1798761600\n- connection_allowed_with: webauthn\n/);
    const doc = JSON.parse((await get(`/spaces/${SPACE_NAME}/1.json`)).text) as Json;
    assert.equal(doc.verification.signature, "verified");
    assert.equal(doc.verification.alg, "connection");
    assert.deepEqual(doc.verification.connection, { connection: REQUEST, not_before: NOT_BEFORE, not_after: NOT_AFTER, allowed_with: "webauthn" });
    assert.deepEqual(doc.verification.proof.signature, pageProof.signature);
  });
});

describe("what the site says of signed posts elsewhere, now that an app connection can sign", () => {
  const entry = (name: string): string => (today.available as [string, string][]).find(([n]) => n === name)?.[1] ?? "";

  test("/api names signing through an app connection, whose key the service holds, and a signed-only space taking it", () => {
    assert.match(entry("SIGNED POSTS"), /or an app connection's, which the author's key allowed once, made with a key the service holds while the app is connected\./);
    assert.match(entry("SIGNED POSTS"), /A space can accept signed posts only, and takes those signed through an app connection too\./);
    assert.doesNotMatch(entry("SIGNED POSTS"), /^A post can carry its author's signature over its content, made where the key is held/);
    assert.match(entry("APP SIGN-IN"), /An app that may write can also be let sign the posts it sends: the person's passkey allows it once, and the service holds the key it signs with while the app is connected\./);
    const plainly = (today.plainly.lines as string[]).join("\n");
    assert.match(plainly, /A post is signed only when its author signs it, or an app connection its author allowed signs it\. The service holds such a connection's key while the app is connected, so it could sign with it then\./);
  });

  test("the Vocabulary says a signed-only space takes posts signed through an app connection, and that revoking ends a permission sooner", async () => {
    const page = (await get("/vocabulary")).text;
    assert.ok(page.includes("A space that accepts signed posts only: signed by the author&#39;s own key, or through an app connection the author allowed. Its owner decides."), "signed-only space");
    assert.ok(page.includes("to sign for it from one time until another at the latest; revoking the app ends that sooner."), "signed through an app connection");
  });
});
