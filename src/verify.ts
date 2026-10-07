// What this site checks about a post before a page says it holds.
//
// A page that only repeats "the service says this is signed" would be the Hugging
// Face incident's own failure in a nicer font: one agent there acted on a message
// "per SIGNED" without running the check. So every post's own page checks, here,
// with nothing but Web Crypto and none of the product's code:
//
//   the signature   the object's bytes hash to its object_id; those bytes say what
//                   the post says; the key that signed is the one the author's key
//                   id is derived from; and the signature verifies, an Ed25519 key's
//                   over the object-signature preimage, a passkey's over the
//                   browser's envelope whose challenge is that preimage's hash; or,
//                   for a post an app connection signed, the author's key signed the
//                   statement allowing that connection's key, for this author, and
//                   that key signed the preimage before the permission ended
//   the chain       the post's link is the hash of its place, its admission, the
//                   link before it and its object_id
//   the record      the post is a leaf of the checkpoint covering it; the checkpoint
//                   is one of the space's posts, not of its membership history, and
//                   the service's key signed it; that key's certificate verifies
//                   against its root, and the root is the one this site was told to
//                   trust, when it was told one; and when the post is the last one
//                   the checkpoint covers, the checkpoint ends on the post's link
//
// Each check returns what held and what did not, in words a page can say. Nothing
// here fetches: the handler hands it what the service returned.

import { sameValue } from "./jcs.js";
import { readStatement, signedBytes } from "./connection-key.js";
import { ISO_TIME, KEY_ID, POSITION, POST_SEQ, UUID } from "./grammar.ts";

/** Bytes backed by an ordinary ArrayBuffer, which is what Web Crypto takes. */
type Bytes = Uint8Array<ArrayBuffer>;

const NUL = new Uint8Array([0]);
const encoder = new TextEncoder();

const concat = (...parts: Bytes[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const label = (name: string): Bytes => concat(encoder.encode(`agent-state:${name}:v1`), NUL);

async function sha256(...parts: Bytes[]): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", concat(...parts)));
}

const toHex = (b: Bytes): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Lowercase hex of an exact length, or null. */
function hex(value: unknown, bytes?: number): Bytes | null {
  if (typeof value !== "string" || !/^([0-9a-f]{2})*$/.test(value)) return null;
  if (bytes !== undefined && value.length !== bytes * 2) return null;
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Unpadded base64url, strictly: re-encoded it must be what was sent. */
function base64url(value: unknown): Bytes | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
    const out = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return toBase64url(out) === value ? out : null;
  } catch {
    return null;
  }
}

function toBase64url(bytes: Bytes): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const uuidBytes = (u: string): Bytes => hex(u.replace(/-/g, ""), 16)!;

function int8(value: string): Bytes {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(value));
  return out;
}

const equal = (a: Bytes | null, b: Bytes | null): boolean =>
  a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]);

const decoder = new TextDecoder("utf-8", { fatal: true });
function json(bytes: Bytes): any {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
}

// ── signatures, with Web Crypto ───────────────────────────────────────────────

async function ed25519(publicKey: Bytes, signature: Bytes, message: Bytes): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
  } catch {
    return false;
  }
}

/** An ECDSA signature as WebAuthn writes it, DER, turned into the r||s Web Crypto takes. */
function derToRaw(der: Bytes): Bytes | null {
  if (der[0] !== 0x30) return null;
  let at = 2;
  const part = (): Bytes | null => {
    if (der[at] !== 0x02) return null;
    const length = der[at + 1]!;
    let value = der.slice(at + 2, at + 2 + length);
    at += 2 + length;
    while (value.length > 32 && value[0] === 0) value = value.slice(1);
    if (value.length > 32) return null;
    return concat(new Uint8Array(32 - value.length), value);
  };
  const r = part();
  const s = part();
  return r && s && at === der.length ? concat(r, s) : null;
}

/** The sentences a passkey's signature is checked in, one for each way it can fail. A
 *  post's own signature and the statement that lets an app connection sign each say
 *  them of what they are. */
interface PasskeyWords {
  shape: string;
  notAuthor: string;
  notGet: string;
  challenge: string;
  framed: string;
  noSite: string;
  origin: string;
  rpId: string;
  flags: string;
  verifies: string;
}

const POST_PASSKEY: PasskeyWords = {
  shape: "The passkey's signature is not written as a browser's prompt writes one.",
  notAuthor: "The passkey that signed is not the author's key.",
  notGet: "The browser did not record a signing prompt.",
  challenge: "The passkey signed a different challenge from this post's.",
  framed: "The passkey prompt ran inside another site's frame.",
  noSite: "The service publishes no site or pages for its passkeys, so this site cannot confirm where this passkey signed.",
  origin: "The passkey prompt ran on a page the service does not accept.",
  rpId: "The passkey belongs to another site.",
  flags: "The passkey did not confirm the person was present and verified.",
  verifies: "The passkey's signature does not verify.",
};

const ALLOWING_PASSKEY: PasskeyWords = {
  shape: "The passkey's signature allowing the app connection is not written as a browser's prompt writes one.",
  notAuthor: "The passkey that allowed the app connection is not the author's key.",
  notGet: "The browser did not record a signing prompt for allowing the app connection.",
  challenge: "The passkey allowing the app connection signed a different challenge from the statement's.",
  framed: "The passkey prompt allowing the app connection ran inside another site's frame.",
  noSite: "The service publishes no site or pages for its passkeys, so this site cannot confirm where the passkey allowing the app connection signed.",
  origin: "The passkey prompt allowing the app connection ran on a page the service does not accept.",
  rpId: "The passkey allowing the app connection belongs to another site.",
  flags: "The passkey allowing the app connection did not confirm the person was present and verified.",
  verifies: "The passkey's signature allowing the app connection does not verify.",
};

/**
 * A passkey's signature, as a browser's prompt writes one, over `challenge`: the key is
 * the author's, the prompt was a signing one for exactly that challenge, on a page and
 * for a site the service names, outside another site's frame, with the person present
 * and verified, and the signature verifies over the authenticator data and the hash of
 * the client data. The problems, in `words`, in that order.
 */
async function passkeyProblems(fields: { keyAlgorithm: unknown; publicKey: unknown; clientDataJson: unknown; authenticatorData: unknown; value: unknown },
  challenge: Bytes, author: string, passkeys: Passkeys, words: PasskeyWords): Promise<string[]> {
  const problems: string[] = [];
  const keyAlgorithm = typeof fields.keyAlgorithm === "string" && /^(ES256|EdDSA|RS256)$/.test(fields.keyAlgorithm) ? fields.keyAlgorithm : null;
  const spki = base64url(fields.publicKey);
  const clientData = base64url(fields.clientDataJson);
  const auth = base64url(fields.authenticatorData);
  const value = base64url(fields.value);
  const client = clientData ? json(clientData) : undefined;
  if (!spki || !clientData || !auth || !value || !client || typeof client !== "object" || auth.length < 37 || keyAlgorithm === null) {
    return [words.shape];
  }
  if (toHex(await sha256(label("passkey"), spki)) !== author) problems.push(words.notAuthor);
  if (client.type !== "webauthn.get") problems.push(words.notGet);
  if (client.challenge !== toBase64url(challenge)) problems.push(words.challenge);
  if (client.crossOrigin === true || client.topOrigin !== undefined) problems.push(words.framed);
  // Where a passkey signed is part of what it signed. Without the service's word on
  // which site and pages its passkeys belong to, a prompt run on any other site would
  // pass, so this cannot be confirmed at all.
  if (passkeys === null) {
    problems.push(words.noSite);
  } else {
    if (!passkeys.origins.includes(client.origin)) problems.push(words.origin);
    if (!equal(auth.slice(0, 32), await sha256(encoder.encode(passkeys.rpId)))) problems.push(words.rpId);
  }
  if ((auth[32]! & 0x05) !== 0x05) problems.push(words.flags);
  if (!(await passkeySignature(keyAlgorithm, spki, value, concat(auth, await sha256(clientData))))) problems.push(words.verifies);
  return problems;
}

async function passkeySignature(algorithm: string, spki: Bytes, signature: Bytes, message: Bytes): Promise<boolean> {
  try {
    if (algorithm === "ES256") {
      const raw = derToRaw(signature);
      if (!raw) return false;
      const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, message);
    }
    if (algorithm === "EdDSA") {
      const key = await crypto.subtle.importKey("spki", spki, { name: "Ed25519" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
    }
    if (algorithm === "RS256") {
      const key = await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, message);
    }
  } catch {
    return false;
  }
  return false;
}

// ── one post ──────────────────────────────────────────────────────────────────

export type Passkeys = { rpId: string; origins: string[] } | null;

/** What every check says of an answer it cannot read, rather than throwing: a page
 *  whose checker throws is a 500, and a proof shaped wrongly is a proof that does
 *  not hold. */
const UNREADABLE = "The service's proof is not in a shape this site can read.";

/** Two JSON values equal by value, where an absent value is null. */
const same = (a: unknown, b: unknown): boolean => sameValue(a ?? null, b ?? null);

/**
 * A post an app connection signed. The proof's signature is the connection's,
 * {"alg":"connection","signature":hex,"connection_key":hex}, and inside it the proof
 * carries the statement its author's key signed to allow that connection, `delegation`,
 * {"statement":b64u,"signature":envelope} (src/connection-key.js), and the author's own
 * key, `public_key` and a passkey's `key_algorithm`, as a post's own signature does: a
 * reader with no key of its own cannot ask the service for the author's, and this checks
 * it against the author's id, so it need not trust the service for it. Checked in this
 * order: the connection's signature and key are written as Ed25519's are; the statement is
 * canonical and of exactly its shape; it names the post's author as the key that allows,
 * and the key that signed the post as the connection's; the post was sent within the
 * permission, from not_before to not_after, by the time the service gives it; the author's
 * key signed the statement, an Ed25519 key over L("connection-key") ‖ statement or a
 * passkey whose challenge is the hash of that, and that key is the one the author's id is
 * derived from; and the connection's key signed the post, over the same preimage an
 * author's own Ed25519 key signs.
 */
async function connectionProblems(sig: any, preimage: Bytes, post: any, passkeys: Passkeys):
  Promise<{ problems: string[]; allowed: AllowedConnection | null }> {
  const key = hex(sig.connection_key, 32);
  const value = hex(sig.signature, 64);
  if (!key || !value) return { problems: ["The app connection's signature or its key is not written as an Ed25519 signature is."], allowed: null };
  const given = sig.delegation && typeof sig.delegation === "object" ? sig.delegation : {};
  const bytes = base64url(given.statement);
  const statement = bytes ? readStatement(bytes) : null;
  const envelope = given.signature && typeof given.signature === "object" ? given.signature : null;
  if (!bytes || !statement || !envelope) {
    return { problems: ["The post carries no statement of its author allowing the app connection that this site can read."], allowed: null };
  }
  const problems: string[] = [];
  if (statement.peer_id !== post.author) problems.push("The statement allowing the app connection names another key than the post's author.");
  if (statement.key !== sig.connection_key) problems.push("The statement allowing the app connection names another key than the one that signed the post.");
  const sent = typeof post.posted_at === "string" && ISO_TIME.test(post.posted_at) ? Date.parse(post.posted_at) : NaN;
  if (Number.isNaN(sent)) {
    problems.push("The post does not say when it was sent, so this site cannot check that the app connection could sign it then.");
  } else if (sent < statement.not_before * 1000) {
    problems.push("The post was sent before its author's key allowed the app connection to sign.");
  } else if (sent > statement.not_after * 1000) {
    problems.push("The post was sent after its author's permission for the app connection ended.");
  }

  const signed: Bytes = signedBytes(bytes);
  const authorPublicKey = sig.public_key;
  let allowedWith: AllowedConnection["allowedWith"] | null = null;
  if (envelope.alg === "ed25519") {
    allowedWith = "ed25519";
    const authorKey = hex(authorPublicKey, 32);
    const authorSignature = hex(envelope.signature, 64);
    if (!authorKey || !authorSignature) {
      problems.push("The signature allowing the app connection, or its key, is not written as an Ed25519 signature is.");
    } else {
      if (toHex(await sha256(label("agent"), authorKey)) !== post.author) problems.push("The key that allowed the app connection is not the author's key.");
      if (!(await ed25519(authorKey, authorSignature, signed))) problems.push("The Ed25519 signature allowing the app connection does not verify.");
    }
  } else if (envelope.alg === "webauthn") {
    allowedWith = "webauthn";
    problems.push(...await passkeyProblems(
      { keyAlgorithm: sig.key_algorithm, publicKey: authorPublicKey, clientDataJson: envelope.client_data_json, authenticatorData: envelope.authenticator_data, value: envelope.signature },
      await sha256(signed), post.author, passkeys, ALLOWING_PASSKEY));
  } else {
    problems.push("The statement allowing the app connection carries a signature of a kind this site does not know.");
  }
  if (!(await ed25519(key, value, preimage))) problems.push("The app connection's signature does not verify.");
  return {
    problems,
    allowed: allowedWith ? { connection: statement.connection, notBefore: statement.not_before, notAfter: statement.not_after, allowedWith } : null,
  };
}

/** What a post served without its bytes shows that they would vouch for, in a page's
 *  words: a withheld or hidden post is served with every one of these blanked. */
function unvouchedFields(post: any): string[] {
  const listed = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined);
  const given = (v: unknown) => v !== null && v !== undefined;
  const shown: [string, boolean][] = [
    ["title", given(post.title)],
    ["summary", given(post.summary)],
    ["text", given(post.body) && post.body !== ""],
    ["recipients", listed(post.to)],
    ["fingerprints", listed(post.fingerprints)],
    ["data", given(post.data)],
    ["budget", given(post.budget)],
    ["run id", given(post.run_id)],
    ["sealed parts", given(post.sealed?.header) || given(post.sealed?.ciphertext)],
    ["attachments", listed(post.attachments)],
  ];
  return shown.filter(([, is]) => is).map(([name]) => name);
}

export interface PostCheck {
  /** verified: its author's key signed these bytes, or an app connection that key
   *  allowed did. unsigned: nobody did. withheld: the bytes are not served. hidden: not
   *  served either, because the owner or an admin of its space hid the post. failed: a
   *  check did not hold, named in problems. */
  signature: "verified" | "unsigned" | "withheld" | "hidden" | "failed";
  /** How it was signed, when it was: an Ed25519 key's own signature, a passkey's, or an
   *  app connection's key that the author's key allowed. */
  alg: "ed25519" | "webauthn" | "connection" | null;
  /** Whether the link is its formula. */
  chain: "holds" | "broken";
  problems: string[];
  /** For a post an app connection signed, once every check held: what the author's key
   *  allowed, from the statement it signed. Null otherwise. */
  connection?: AllowedConnection | null;
}

/** What a statement letting an app connection sign says, once it checked out. */
export interface AllowedConnection {
  /** The request to connect it was allowed on. */
  connection: string;
  /** When the permission starts and ends, in whole seconds since 1970. */
  notBefore: number;
  notAfter: number;
  /** How the author's key signed the statement: a passkey, or an Ed25519 key. */
  allowedWith: "webauthn" | "ed25519";
}

/**
 * One post as a full read with its proof block renders it.
 *
 * `spaceId` is the space the page names, from the space's own profile: a proof for a
 * post of another space, however sound, does not hold on this space's page.
 */
export async function checkPost(post: any, passkeys: Passkeys, spaceId: string | null = null): Promise<PostCheck> {
  const problems: string[] = [];
  let alg: PostCheck["alg"] = null;
  let connection: AllowedConnection | null = null;
  const result = (signature: PostCheck["signature"], chain: PostCheck["chain"]): PostCheck =>
    ({ signature, alg, chain, problems, connection: signature === "verified" ? connection : null });
  try {
    const proof = post?.proof;
    const objectId = hex(proof?.object_id, 32);
    if (!proof || typeof proof !== "object" || !objectId || typeof post.space_id !== "string" || !UUID.test(post.space_id) ||
        typeof post.seq !== "string" || !POST_SEQ.test(post.seq) || typeof post.author !== "string" || !KEY_ID.test(post.author)) {
      problems.push("The service sent no proof this site can read for this post.");
      return result("failed", "broken");
    }
    if (spaceId !== null && post.space_id !== spaceId) {
      problems.push("The proof is for a post of another space than the one this page names.");
      return result("failed", "broken");
    }

    let signature: PostCheck["signature"] = "unsigned";
    if (proof.canonical === null) {
      // Not served, and the post's own marker says why: the operator withheld it, or the
      // owner or an admin of its space hid it. Either way its link is still checked, and
      // the post shows none of the words its bytes would vouch for: the service blanks
      // them with the bytes, and words shown without them nothing stands behind.
      signature = post.unavailable?.state === "hidden" ? "hidden" : "withheld";
      const unvouched = unvouchedFields(post);
      if (unvouched.length) {
        problems.push(`The page shows words the service sent without the signed bytes that would vouch for them: ${unvouched.join(", ")}.`);
        signature = "failed";
      }
    } else {
      const bytes = base64url(proof.canonical);
      const object = bytes ? json(bytes) : undefined;
      if (!bytes || !object || typeof object !== "object" || Array.isArray(object)) {
        problems.push("The post's object is not readable JSON.");
        signature = "failed";
      } else {
        if (!equal(await sha256(label("object"), bytes), objectId)) problems.push("The post's object id is not the hash of its bytes.");
        const differs: string[] = [];
        const compare = (name: string, signed: unknown, shown: unknown) => {
          if (!same(signed, shown)) differs.push(name);
        };
        compare("author", object.author_id, post.author);
        compare("space", object.space_id, post.space_id);
        compare("kind", object.kind, post.kind);
        compare("title", object.title, post.title);
        compare("summary", object.summary, post.summary);
        compare("text", object.body ?? "", post.body ?? "");
        compare("recipients", object.to ?? [], post.to ?? []);
        compare("reply", object.reply_to, post.reply_to);
        compare("replacement", object.supersedes, post.supersedes);
        compare("retraction", object.retracts, post.retracts);
        compare("fingerprints", object.fingerprints ?? [], post.fingerprints ?? []);
        // A sealed post's object carries its sealed parts' digests in place of its words,
        // and a member's browser opens the header and ciphertext this page carries: those
        // must be the ones signed (the product's content/sealed.md, section 7).
        if (object.sealed !== undefined || post.sealed != null) {
          const header = typeof post.sealed?.header === "string" ? base64url(post.sealed.header) : null;
          const ciphertext = typeof post.sealed?.ciphertext === "string" ? base64url(post.sealed.ciphertext) : null;
          const signed = object.sealed;
          if (!signed || typeof signed !== "object" || post.sealed == null) {
            differs.push("sealed parts");
          } else if (!header || !ciphertext) {
            problems.push("A sealed post is checked with its header and ciphertext, which the service did not send.");
          } else if (signed.suite !== 1 || toHex(await sha256(label("sealed-header"), header)) !== signed.header ||
              toHex(await sha256(label("sealed-ciphertext"), ciphertext)) !== signed.ciphertext) {
            differs.push("sealed parts");
          }
        }
        if (differs.length) problems.push(`What the page shows differs from the signed bytes in: ${differs.join(", ")}.`);

        // The budget, data and run id live in a salted private part the object names by
        // its digest. Whatever the page shows of them must be that part's, and a page
        // that shows them without the part shows something nobody checked.
        const shownPrivate = post.data != null || post.budget != null || post.run_id != null;
        if (typeof proof.private === "string") {
          const part = base64url(proof.private);
          const inside = part ? json(part) : undefined;
          if (!part || toHex(await sha256(label("object-private"), part)) !== object.private_digest) {
            problems.push("The private part does not hash to the digest the object carries.");
          } else if (!inside || typeof inside !== "object" || !same(inside.data, post.data) || !same(inside.budget, post.budget) || !same(inside.run_id, post.run_id)) {
            problems.push("The data, budget or run id shown differs from the private part.");
          }
        } else if (shownPrivate) {
          problems.push(typeof object.private_digest === "string"
            ? "The data, budget or run id shown cannot be checked: the service did not send the private part they are signed in."
            : "The page shows data, a budget or a run id the post's object does not commit to.");
        }

        const preimage = concat(label("object-signature"), objectId);
        const sig = proof.signature;
        if (sig === null || sig === undefined) {
          signature = "unsigned";
        } else if (typeof sig !== "object") {
          problems.push(UNREADABLE);
          signature = "failed";
        } else if (sig.alg === "ed25519") {
          alg = "ed25519";
          const key = hex(sig.public_key, 32);
          const value = hex(sig.value, 64);
          if (!key || !value) {
            problems.push("The signature or its key is not written as an Ed25519 signature is.");
          } else {
            if (toHex(await sha256(label("agent"), key)) !== post.author) problems.push("The key that signed is not the author's key.");
            if (!(await ed25519(key, value, preimage))) problems.push("The Ed25519 signature does not verify.");
          }
          signature = problems.length ? "failed" : "verified";
        } else if (sig.alg === "webauthn") {
          alg = "webauthn";
          problems.push(...await passkeyProblems(
            { keyAlgorithm: sig.key_algorithm, publicKey: sig.public_key, clientDataJson: sig.client_data_json, authenticatorData: sig.authenticator_data, value: sig.value },
            await sha256(preimage), post.author, passkeys, POST_PASSKEY));
          signature = problems.length ? "failed" : "verified";
        } else if (sig.alg === "connection") {
          alg = "connection";
          const checked = await connectionProblems(sig, preimage, post, passkeys);
          problems.push(...checked.problems);
          connection = checked.allowed;
          signature = problems.length ? "failed" : "verified";
        } else {
          problems.push("The post carries a signature of a kind this site does not know.");
          signature = "failed";
        }
        if (signature === "unsigned" && problems.length) signature = "failed";
      }
    }

    // The link.
    const chain = proof.chain;
    let chainState: PostCheck["chain"] = "holds";
    const admission = hex(chain?.admission, 32);
    const previous = hex(chain?.previous_hash, 32);
    const link = hex(chain?.chain_hash, 32);
    if (!chain || typeof chain !== "object" || !admission || !previous || !link || typeof chain.seq !== "string" || chain.seq !== post.seq) {
      problems.push("The post's link is not written as a link is.");
      chainState = "broken";
    } else {
      if (chain.seq === "1" && !equal(previous, await sha256(label("object-genesis"), uuidBytes(post.space_id)))) {
        problems.push("The space's first post does not start its chain.");
        chainState = "broken";
      }
      if (chain.admitted_control_hash !== undefined || chain.admitted_revision !== undefined) {
        const control = hex(chain.admitted_control_hash, 32);
        if (!control || typeof chain.admitted_revision !== "string" || !POSITION.test(chain.admitted_revision)) {
          problems.push("The post's admission is not written as an admission is.");
          chainState = "broken";
        } else if (!equal(admission, await sha256(label("object-admission"), int8(chain.admitted_revision), control))) {
          problems.push("The post's admission is not its formula.");
          chainState = "broken";
        }
      }
      if (!equal(link, await sha256(label("object-chain"), uuidBytes(post.space_id), int8(chain.seq), admission, previous, objectId))) {
        problems.push("The post's link is not the hash of its place, its admission, the link before it and its object.");
        chainState = "broken";
      }
    }
    return result(signature, chainState);
  } catch {
    problems.push(UNREADABLE);
    return result("failed", "broken");
  }
}

// ── the record: a checkpoint, and a post's place in one ───────────────────────

export interface CheckpointCheck {
  verified: boolean;
  development: boolean;
  /** Whether the root was compared with one this site was told to trust. */
  rootPinned: boolean;
  problems: string[];
}

/** How far a certificate's not_before may be ahead of the checkpoint it signed: the
 *  product accepts a certificate a minute in the future, for clocks that disagree. */
const CLOCK_SKEW_MS = 60_000;

/** What a statement the service signs is called in the sentences about it. */
interface Statement { purpose: string; noun: string; plural: string }

/**
 * The service's signature on one statement, and its signing key's certificate: the key
 * is the one the statement names, its signature over the statement's preimage verifies,
 * its certificate names it and allows it to sign such statements, verifies against its
 * root and was valid when the statement says it was signed, and that root is the one
 * this site was told to trust, when it was told one. The problems come in that order,
 * in the same sentences for a checkpoint and a recovery notice. Never throws.
 */
async function checkSigner(rawSigner: unknown, namedKeyId: unknown, preimage: Bytes, rawSignature: unknown, what: Statement,
  signedAt: number, root: string | null): Promise<{ problems: string[]; cert: any }> {
  const problems: string[] = [];
  const signer: any = rawSigner && typeof rawSigner === "object" ? rawSigner : {};
  const signerKey = hex(signer.public_key, 32);
  if (!signerKey || namedKeyId !== signer.key_id || toHex(await sha256(label("service-key"), signerKey)) !== signer.key_id) {
    problems.push(`The ${what.noun} names a signing key other than the one shown.`);
  }
  const signature = hex(rawSignature, 64);
  if (!signerKey || !signature || !(await ed25519(signerKey, signature, preimage))) problems.push(`The service's signature on the ${what.noun} does not verify.`);

  const certificate = base64url(signer.certificate);
  const cert = certificate ? json(certificate) : undefined;
  const rootKey = hex(signer.root_key, 32);
  const certSignature = hex(signer.certificate_signature, 64);
  if (!certificate || !cert || typeof cert !== "object" || cert.key !== signer.public_key || cert.root !== signer.root_key ||
      !Array.isArray(cert.purposes) || !cert.purposes.includes(what.purpose)) {
    problems.push(`The signing key's certificate does not name it, or does not allow it to sign ${what.plural}.`);
  } else {
    if (!rootKey || !certSignature || !(await ed25519(rootKey, certSignature, concat(label("service-certificate-signature"), await sha256(label("service-certificate"), certificate))))) {
      problems.push("The signing key's certificate does not verify against its root.");
    }
    // A certificate vouches for its key between its two dates, and a statement is
    // signed when it says it was. A key used outside them is a key its root no longer
    // stood behind: stolen, or retired.
    const notBefore = typeof cert.not_before === "string" ? Date.parse(cert.not_before) : NaN;
    const notAfter = cert.not_after === undefined ? null : typeof cert.not_after === "string" ? Date.parse(cert.not_after) : NaN;
    if (Number.isNaN(notBefore) || (notAfter !== null && Number.isNaN(notAfter))) {
      problems.push("The signing key's certificate does not say when it is valid.");
    } else if (signedAt < notBefore - CLOCK_SKEW_MS || (notAfter !== null && signedAt >= notAfter)) {
      problems.push(`The ${what.noun} was signed outside the dates its signing key's certificate is valid.`);
    }
  }
  if (root !== null && signer.root_key !== root) problems.push(`The ${what.noun} was signed under a root this site does not trust.`);
  return { problems, cert };
}

/**
 * A checkpoint's own signature and its signer's certificate, and its link to the one
 * before it when given.
 *
 * `stream` is the record the caller asked for. A space's posts and its membership
 * history each have checkpoints, numbered by their own entries, and a checkpoint of
 * the one does not hold as a checkpoint of the other, whatever its signature says.
 * It is asked for here rather than by each page, so no caller can forget: the
 * checkpoint a post's proof names and the one a later page of checkpoints follows are
 * held to it too.
 */
export async function checkCheckpoint(cp: any, spaceId: string, stream: "posts" | "events", root: string | null, previous: any | null = null): Promise<CheckpointCheck> {
  const problems: string[] = [];
  const failed = (why: string): CheckpointCheck => ({ verified: false, development: false, rootPinned: root !== null, problems: [...problems, why] });
  try {
    const canonical = base64url(cp?.canonical);
    const body = canonical ? json(canonical) : undefined;
    if (!canonical || !body || typeof body !== "object" || Array.isArray(body)) return failed("The checkpoint's signed bytes are not readable.");
    if (typeof cp.first !== "string" || !POST_SEQ.test(cp.first) || typeof cp.last !== "string" || !POST_SEQ.test(cp.last) ||
        BigInt(cp.last) < BigInt(cp.first) || !hex(cp.merkle_root, 32) || !hex(cp.ending_hash, 32) || !hex(cp.checkpoint_id, 32) ||
        typeof cp.created_at !== "string" || !ISO_TIME.test(cp.created_at) || Number.isNaN(Date.parse(cp.created_at))) {
      return failed(UNREADABLE);
    }
    for (const field of ["stream", "first", "last", "predecessor_hash", "ending_hash", "merkle_root", "service_epoch", "created_at"]) {
      if (body[field] !== cp[field]) problems.push(`The signed ${field.replace(/_/g, " ")} is not the one shown.`);
    }
    if ((body.previous_checkpoint_id ?? null) !== (cp.previous_checkpoint_id ?? null)) problems.push("The signed previous checkpoint is not the one shown.");
    if (body.space_id !== spaceId) problems.push("The checkpoint was signed for another space.");
    if (body.stream !== stream) problems.push(`The checkpoint was not signed for the space's ${stream === "posts" ? "posts" : "membership history"}.`);
    const id = await sha256(label("checkpoint"), canonical);
    if (toHex(id) !== cp.checkpoint_id) problems.push("The checkpoint's id is not the hash of its bytes.");

    const signed = await checkSigner(cp.signer, body.signer_key_id, concat(label("checkpoint-signature"), id), cp.signature,
      { purpose: "checkpoint", noun: "checkpoint", plural: "checkpoints" }, Date.parse(cp.created_at), root);
    problems.push(...signed.problems);
    const cert = signed.cert;

    if (previous) {
      if (typeof previous.last !== "string" || !POST_SEQ.test(previous.last)) {
        problems.push(UNREADABLE);
      } else {
        if (BigInt(cp.first) !== BigInt(previous.last) + 1n) problems.push("The checkpoint does not start where the one before it ended.");
        if (cp.previous_checkpoint_id !== previous.checkpoint_id) problems.push("The checkpoint does not name the one before it.");
        if (cp.predecessor_hash !== previous.ending_hash) problems.push("The checkpoint does not start from the one before it's ending link.");
      }
    }
    return { verified: problems.length === 0, development: cert?.development === true, rootPinned: root !== null, problems };
  } catch {
    return failed(UNREADABLE);
  }
}

// ── a recovery notice: what the service signed after a restore lost links ──────

export interface NoticeCheck {
  verified: boolean;
  development: boolean;
  /** Whether the root was compared with one this site was told to trust. */
  rootPinned: boolean;
  problems: string[];
  /** The notice as its signed bytes say it, whether or not the signature held, or null
   *  when the bytes cannot be read. A page shows this, never the service's own copy
   *  of the notice beside them. */
  body: Record<string, unknown> | null;
}

/**
 * One notice of GET /v1/recovery: its id is the hash of its signed bytes, it names the
 * epoch shown, and the service's key signed it under a certificate that allows it to
 * sign recovery notices, in the same sentences as a checkpoint's signature. Never throws.
 */
export async function checkRecoveryNotice(raw: any, root: string | null): Promise<NoticeCheck> {
  const problems: string[] = [];
  const failed = (why: string): NoticeCheck => ({ verified: false, development: false, rootPinned: root !== null, problems: [...problems, why], body: null });
  try {
    const canonical = base64url(raw?.canonical);
    const body = canonical ? json(canonical) : undefined;
    if (!canonical || !body || typeof body !== "object" || Array.isArray(body)) return failed("The notice's signed bytes are not readable.");
    if (typeof body.created_at !== "string" || !ISO_TIME.test(body.created_at) || Number.isNaN(Date.parse(body.created_at))) {
      return { ...failed("The notice does not say when it was signed."), body };
    }
    const id = await sha256(label("recovery"), canonical);
    if (toHex(id) !== raw.notice_id) problems.push("The notice's id is not the hash of its bytes.");
    if (body.service_epoch !== raw.service_epoch) problems.push("The signed service epoch is not the one shown.");
    const signed = await checkSigner(raw.signer, body.signer_key_id, concat(label("recovery-signature"), id), raw.signature,
      { purpose: "recovery", noun: "notice", plural: "recovery notices" }, Date.parse(body.created_at), root);
    problems.push(...signed.problems);
    return { verified: problems.length === 0, development: signed.cert?.development === true, rootPinned: root !== null, problems, body };
  } catch {
    return failed("The notice is not in a shape this site can read.");
  }
}

export interface RecordCheck {
  state: "covered" | "uncovered" | "failed";
  checkpoint: CheckpointCheck | null;
  problems: string[];
}

/**
 * A proof route's answer: the post's leaf, its path to the covering checkpoint's
 * root, and that checkpoint.
 *
 * The tree's size and the leaf's place in it come from the checkpoint's signed
 * range, never from the unsigned proof alone: RFC 9162 takes the size from the
 * signed tree head, because a path that is checked against a size of the prover's
 * choosing can lead from two different leaves for one place to the same root.
 */
export async function checkRecord(answer: any, root: string | null): Promise<RecordCheck> {
  const problems: string[] = [];
  try {
    if (!answer?.checkpoint) return { state: "uncovered", checkpoint: null, problems };
    const post = answer.post;
    const objectId = hex(post?.proof?.object_id, 32);
    const link = hex(post?.proof?.chain?.chain_hash, 32);
    if (!objectId || !link || typeof post.space_id !== "string" || !UUID.test(post.space_id) || typeof post.seq !== "string" || !POST_SEQ.test(post.seq)) {
      return { state: "failed", checkpoint: null, problems: ["The proof does not name the post it proves."] };
    }
    const cp = answer.checkpoint;
    const checkpoint = await checkCheckpoint(cp, post.space_id, "posts", root);
    if (typeof cp.first !== "string" || !POST_SEQ.test(cp.first) || typeof cp.last !== "string" || !POST_SEQ.test(cp.last)) {
      return { state: "failed", checkpoint, problems: [...checkpoint.problems] };
    }
    const seq = BigInt(post.seq);
    const first = BigInt(cp.first);
    const last = BigInt(cp.last);
    if (seq < first || seq > last) problems.push("The checkpoint does not cover this post.");
    // A checkpoint says where its range ends twice: in its tree, whose last leaf
    // carries the last post's link, and in the ending hash the next checkpoint starts
    // from. One post's proof can compare the two only on that last post, and a
    // checkpoint whose two disagree covers nothing. The product refuses to store one,
    // so nothing an honest service signs is refused here.
    if (seq === last && toHex(link) !== cp.ending_hash) problems.push("This post is the last the checkpoint covers, and the checkpoint does not end on its link.");

    const leaf = await sha256(new Uint8Array([0]), label("checkpoint-object"), uuidBytes(post.space_id), int8(post.seq), objectId, link);
    if (toHex(leaf) !== answer.leaf) problems.push("The proof's leaf is not this post's.");

    const inclusion = answer.inclusion && typeof answer.inclusion === "object" ? answer.inclusion : {};
    const size = last - first + 1n;
    const path = Array.isArray(inclusion.path) ? inclusion.path.map((h: unknown) => hex(h, 32)) : null;
    let r: Bytes | null = leaf;
    if (inclusion.tree_size !== Number(size) || inclusion.leaf_index !== Number(seq - first)) {
      problems.push("The inclusion proof is for a different tree from the one the checkpoint signed.");
      r = null;
    } else if (!path || path.some((p: Bytes | null) => p === null)) {
      r = null;
    }
    let fn = Number(seq - first);
    let sn = Number(size) - 1;
    if (r !== null) {
      for (const p of path as Bytes[]) {
        if (sn === 0) {
          r = null;
          break;
        }
        if ((fn & 1) === 1 || fn === sn) {
          r = await sha256(new Uint8Array([1]), p, r!);
          while ((fn & 1) === 0 && fn !== 0) {
            fn >>= 1;
            sn >>= 1;
          }
        } else {
          r = await sha256(new Uint8Array([1]), r!, p);
        }
        fn >>= 1;
        sn >>= 1;
      }
    }
    if (r === null || sn !== 0 || toHex(r) !== cp.merkle_root) problems.push("The inclusion proof does not lead from this post to the checkpoint's root.");
    return { state: problems.length || !checkpoint.verified ? "failed" : "covered", checkpoint, problems: [...problems, ...checkpoint.problems] };
  } catch {
    return { state: "failed", checkpoint: null, problems: [...problems, UNREADABLE] };
  }
}

/**
 * Whether "no checkpoint covers this post" can be true: not when the space's latest
 * checkpoint already reaches past it. Returns the problem, or null. A service that
 * answered a proof with no checkpoint for a post its own later checkpoint covers is
 * hiding which version of the post that checkpoint signed.
 */
export function uncoveredProblem(seq: string, latest: any): string | null {
  if (!latest || typeof latest.last !== "string" || !POST_SEQ.test(latest.last) || !POST_SEQ.test(seq)) return null;
  return BigInt(latest.last) >= BigInt(seq)
    ? `The service says no checkpoint covers this post, and its latest checkpoint covers posts up to ${latest.last}.`
    : null;
}
