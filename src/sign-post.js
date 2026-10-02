// A person's post, signed with their passkey, in their browser.
//
// On the two signed-in pages that carry a post form, and nowhere else. A passkey
// signs only what a browser's prompt wraps around a challenge, so this script
// writes the post as the product's canonical object, takes that object's id, and
// makes the challenge the SHA-256 of exactly what an Ed25519 key signs for the
// same post: the object-signature label, a NUL byte and the object id. The
// product rebuilds all of it from the bytes it is sent and checks the passkey's
// answer the way it checks one at sign-in, so a post signed here can be checked by
// anybody, with nothing from this site.
//
// It sends nothing. The page carries the space's id, the key's id and which
// passkey to ask for, and the page's policy permits this script and no request.
// The answer goes into hidden fields of the form, which the form then submits.
//
// The hashing is synchronous, in src/post-object.js, on purpose. Safari before macOS
// 14.4 and iOS 17.4 opens a passkey prompt only from inside the click, and awaiting
// Web Crypto first could cost it the click.
//
// A post's data, budget and run id, when the form carries any, go in a private part the
// object names only by its digest, with 32 random bytes of salt beside them, drawn once
// for the page so that a press sent twice signs the same object twice.

import { canonicalBytes } from "/jcs.js";
import { challengeOf, hex, objectIdOf, parseTyped, privateBytes, privateDigestOf, privateProblem } from "/post-object.js";

// ── the post as the product's object ─────────────────────────────────────────

function b64u(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (let i = 0; i < view.length; i++) text += String.fromCharCode(view[i]);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64u(text) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/** Code point order, which is UTF-8 byte order, which is how the product sorts. */
function codePoints(a, b) {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PEER = /^[0-9a-f]{64}$/;

/**
 * A post's data, budget and run id as the form holds them, each undefined when its
 * field is empty or missing, read and checked with src/post-object.js as src/me.ts reads
 * and checks them, or `{ problem }`, a sentence saying what is wrong with one.
 */
function privateFieldsOf(form) {
  const value = (name) => {
    const el = form.elements.namedItem(name);
    return el && typeof el.value === "string" ? el.value.trim() : "";
  };
  const data = parseTyped(value("data"), "the data");
  if (data.problem) return { problem: data.problem };
  const budget = parseTyped(value("budget"), "the budget");
  if (budget.problem) return { problem: budget.problem };
  const fields = { data: data.value, budget: budget.value, runId: value("run_id") || undefined };
  const why = privateProblem(fields);
  return why ? { problem: why } : { fields };
}

/**
 * The object for what the form holds, read as src/me.ts reads the same form for an
 * unsigned post, or null when a field is one that page would refuse by the same shape:
 * the form then goes unsigned, and its answer names the field. With data, a budget or a
 * run id, the private part too, which the object names by its digest; and one of those
 * three that is wrong is `{ problem }`, said here and never sent unsigned, because a
 * reading of JSON or of a time can differ between this browser and the server.
 */
function objectOf(form, salt) {
  const value = (name) => {
    const el = form.elements.namedItem(name);
    return el && typeof el.value === "string" ? el.value : "";
  };
  // Every line: more than the service takes is said below, before signing, never cut.
  const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const o = {
    v: 1,
    space_id: form.dataset.spaceId,
    author_id: form.dataset.author,
    idempotency_key: value("idempotency_key"),
    kind: value("kind").trim(),
  };
  if (!UUID.test(o.space_id || "") || !PEER.test(o.author_id || "") || !o.idempotency_key || !o.kind) return null;
  const title = value("title").trim();
  if (title) o.title = title;
  const body = value("body");
  if (body) o.body = body;
  const to = [...new Set(lines(value("to")))];
  if (to.some((id) => !PEER.test(id))) return null;
  if (to.length) o.to = to.sort();
  for (const field of ["reply_to", "supersedes", "retracts"]) {
    const id = value(field);
    if (id) {
      if (!UUID.test(id)) return null;
      o[field] = id;
    }
  }
  const seen = new Map();
  for (const line of lines(value("fingerprints"))) {
    const at = line.indexOf(":");
    if (at <= 0) return null;
    const f = { scheme: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
    seen.set(JSON.stringify([f.scheme, f.value]), f);
  }
  if (seen.size) o.fingerprints = [...seen.values()].sort((a, b) => codePoints(a.scheme, b.scheme) || codePoints(a.value, b.value));
  const read = privateFieldsOf(form);
  if (read.problem) return { problem: read.problem };
  const fields = read.fields;
  let part = null;
  if (fields.data !== undefined || fields.budget !== undefined || fields.runId !== undefined) {
    part = privateBytes(fields, salt);
    o.private_digest = privateDigestOf(part);
  }
  return { object: o, part };
}

/**
 * More fingerprints or keys than one post takes, in words, or "" when there are not.
 * The page names the service's limits on the form; a form naming none is not checked
 * here, and the service refuses what it will not take.
 */
function tooMany(form, o) {
  const max = (name) => (/^[1-9][0-9]{0,5}$/.test(form.dataset[name] || "") ? Number(form.dataset[name]) : Infinity);
  const prints = (o.fingerprints || []).length;
  const keys = (o.to || []).length;
  if (prints > max("maxFingerprints")) {
    return `A post carries at most ${max("maxFingerprints")} fingerprints, and this one has ${prints}. Nothing was sent. Remove some and press Post again.`;
  }
  if (keys > max("maxRecipients")) {
    return `A post goes to at most ${max("maxRecipients")} keys' mailboxes, and this one names ${keys}. Nothing was sent. Remove some and press Post again.`;
  }
  return "";
}

// ── the forms ────────────────────────────────────────────────────────────────

const SIGNATURE_FIELDS = ["sig_alg", "sig_canonical", "sig_private", "sig_credential_id", "sig_client_data_json", "sig_authenticator_data", "sig_signature"];

function setup(form) {
  // Once for the page: a press sent twice then signs the same private part twice.
  const salt = hex(crypto.getRandomValues(new Uint8Array(32)));
  const status = form.querySelector("[data-sign-status]");
  const choice = form.querySelector("input[name=sign]");
  const unsigned = form.querySelector("[data-post-unsigned]");
  const required = form.dataset.signedOnly === "1";
  const say = (text) => { if (status) status.textContent = text; };
  const field = (name) => form.elements.namedItem(name);
  const clear = () => { for (const name of SIGNATURE_FIELDS) if (field(name)) field(name).value = ""; };

  if (!window.PublicKeyCredential || !navigator.credentials) {
    if (choice) { choice.checked = false; choice.disabled = true; }
    say(required
      ? "This browser cannot use a passkey, and this space accepts signed posts only."
      : "This browser cannot use a passkey, so a post from here is sent unsigned.");
    return;
  }
  if (unsigned) {
    unsigned.addEventListener("click", () => {
      clear();
      if (choice) choice.checked = false;
      unsigned.hidden = true;
      form.submit();
    });
  }

  form.addEventListener("submit", (event) => {
    // Every press signs what the form holds now. A signature left from a press whose
    // sending never finished would otherwise go out with text edited since. The
    // form's own submit() below sends without coming back through here.
    clear();
    if (!required && choice && !choice.checked) return;
    let made;
    try {
      made = objectOf(form, salt);
    } catch {
      made = { problem: "The data or the budget holds text a signature cannot cover, such as half of an emoji." };
    }
    // A field src/me.ts refuses by the same shape: sent unsigned, so its answer says which.
    if (made === null) return;
    event.preventDefault();
    // The data, the budget or the run id: said here, and never sent unsigned in place of
    // the signed post the person asked for.
    if (made.problem) {
      say(`${made.problem} Nothing was sent.`);
      return;
    }
    const { object, part } = made;
    // More than the service takes: said here, with the form as it was typed, before the
    // passkey is asked to sign something that would be refused.
    const over = tooMany(form, object);
    if (over) {
      say(over);
      return;
    }

    let bytes;
    try {
      bytes = canonicalBytes(object);
    } catch {
      say("The post holds text a signature cannot cover, such as half of an emoji. Remove it and press Post again.");
      return;
    }
    const challenge = challengeOf(objectIdOf(bytes));
    const allow = form.dataset.credential ? [{ type: "public-key", id: fromB64u(form.dataset.credential) }] : [];
    say("Your browser is asking for your passkey to sign the post.");
    navigator.credentials.get({
      publicKey: {
        challenge,
        ...(form.dataset.rpId ? { rpId: form.dataset.rpId } : {}),
        allowCredentials: allow,
        userVerification: "required",
        timeout: 120000,
      },
    }).then((credential) => {
      if (!credential || !credential.response || !credential.response.signature) throw new Error("no answer");
      field("sig_alg").value = "webauthn";
      field("sig_canonical").value = b64u(bytes);
      if (field("sig_private")) field("sig_private").value = part ? b64u(part) : "";
      field("sig_credential_id").value = b64u(credential.rawId);
      field("sig_client_data_json").value = b64u(credential.response.clientDataJSON);
      field("sig_authenticator_data").value = b64u(credential.response.authenticatorData);
      field("sig_signature").value = b64u(credential.response.signature);
      say("Signed. Sending the post.");
      form.submit();
    }, () => {
      clear();
      if (required) {
        say("Your passkey did not sign the post, so nothing was sent. This space accepts signed posts only: press Post to try again.");
      } else {
        say("Your passkey did not sign the post, so nothing was sent. Press Post to try again, or send it without a signature.");
        if (unsigned) unsigned.hidden = false;
      }
    });
  });
}

for (const form of document.querySelectorAll("form[data-sign]")) setup(form);
