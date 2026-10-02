// The statement a person's passkey signs to let one app connection sign their posts,
// written and read here for the browser and for this site's server alike.
//
// An app that connects by sign-in gets an access token and nothing else, so its posts
// would go out unsigned. On Allow, /me/connect can make the connection a key of its
// own, D, an Ed25519 key pair made in the person's browser, and the person's passkey
// signs once a statement saying that D may sign for their key on this one connection,
// for a while:
//
//     statement = canonical({"connection","key","not_after","not_before","peer_id","v":1})
//     signed    = L("connection-key") ‖ statement
//
// where `key` is D's public key, `connection` the app's request to connect, and
// `not_before` and `not_after` when the permission starts and ends, in whole seconds
// since 1970. It names no app: an app's registration is shared by everybody who connects
// it, and naming it would link in public the keys that connected through one. A passkey
// signs H(signed). The format is the product's; the product checks the statement before it
// keeps D, and every reader checks it with each post D signs (src/verify.ts).
//
// It is canonical JSON as RFC 8785 writes it, with this site's writer, src/jcs.js, which
// is held to the product's vectors. The import is relative so that the same file loads
// in the browser, beside /jcs.js, and in Node.
//
// No passkey is ever handed bytes from here that the page did not build itself: the
// browser writes the statement from the fields the server drew for this request and from
// a key it made, and the label sets it apart from a post's challenge, a hash under
// L("object-signature"), and from the product's challenge to connect with, 56 bytes.

import { canonicalBytes } from "./jcs.js";

/** The label the statement is signed under: L("connection-key"). */
export const LABEL = "connection-key";

/** The fields of a statement, in the order canonical JSON writes them. */
const FIELDS = ["connection", "key", "not_after", "not_before", "peer_id", "v"];

const PEER = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The most bytes a statement may be, as the product reads one. */
export const STATEMENT_MAX_BYTES = 512;

/** An hour, in seconds: how far past the token's lifetime the permission may run. */
const HOUR = 3600;

const isSeconds = (v) => Number.isSafeInteger(v) && v > 0;

/**
 * When the permission ends, in whole seconds since 1970: `notBefore`, when it starts, and
 * the token's lifetime in days, plus one hour. `notBefore` is the time the page was drawn,
 * by this site's server's clock, never the browser's, which may be wrong by any amount;
 * the product allows for a little difference between its clock and this site's. Null for
 * anything out of shape.
 */
export function notAfterOf(notBefore, lifetimeDays) {
  if (!isSeconds(notBefore) || !Number.isSafeInteger(lifetimeDays) || lifetimeDays < 1 || lifetimeDays > 366) return null;
  return notBefore + lifetimeDays * 86400 + HOUR;
}

/**
 * The statement's bytes, for a passkey to sign under the label. Throws a TypeError on any
 * field out of the shape the product reads, rather than write a statement it refuses.
 */
export function statementBytes({ peerId, key, connection, notBefore, notAfter }) {
  if (typeof peerId !== "string" || !PEER.test(peerId)) throw new TypeError("peer_id is 64 lowercase hex characters");
  if (typeof key !== "string" || !PEER.test(key)) throw new TypeError("key is an Ed25519 public key, 64 lowercase hex characters");
  if (typeof connection !== "string" || !UUID.test(connection)) throw new TypeError("connection is a request id, a lowercase uuid");
  if (!isSeconds(notBefore)) throw new TypeError("not_before is whole seconds since 1970");
  if (!isSeconds(notAfter) || notAfter < notBefore) throw new TypeError("not_after is whole seconds since 1970, not before not_before");
  const bytes = canonicalBytes({ connection, key, not_after: notAfter, not_before: notBefore, peer_id: peerId, v: 1 });
  if (bytes.length > STATEMENT_MAX_BYTES) throw new TypeError(`a statement is at most ${STATEMENT_MAX_BYTES} bytes`);
  return bytes;
}

const strict = new TextDecoder("utf-8", { fatal: true });

/**
 * A statement read back strictly: canonical, and of exactly this shape. Returns its
 * fields, or null for bytes that are anything else.
 */
export function readStatement(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > STATEMENT_MAX_BYTES) return null;
  let s;
  try {
    s = JSON.parse(strict.decode(bytes));
  } catch {
    return null;
  }
  if (!s || typeof s !== "object" || Array.isArray(s) || Object.getPrototypeOf(s) !== Object.prototype) return null;
  const names = Object.keys(s).sort();
  if (names.length !== FIELDS.length || names.some((name, i) => name !== FIELDS[i])) return null;
  if (s.v !== 1 || typeof s.peer_id !== "string" || !PEER.test(s.peer_id) || typeof s.key !== "string" || !PEER.test(s.key) ||
      typeof s.connection !== "string" || !UUID.test(s.connection) || !isSeconds(s.not_before) || !isSeconds(s.not_after)) {
    return null;
  }
  const again = canonicalBytes(s);
  if (again.length !== bytes.length || again.some((b, i) => b !== bytes[i])) return null;
  return { v: 1, peer_id: s.peer_id, key: s.key, connection: s.connection, not_before: s.not_before, not_after: s.not_after };
}

/** What the person's key signs: L("connection-key") ‖ statement. */
export function signedBytes(statement) {
  const head = new TextEncoder().encode(`agent-state:${LABEL}:v1\u0000`);
  const out = new Uint8Array(head.length + statement.length);
  out.set(head, 0);
  out.set(statement, head.length);
  return out;
}
