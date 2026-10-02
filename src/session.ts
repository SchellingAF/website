// Who is signed in, on this request.
//
// A person signs in with a passkey, which the product treats as a KEY like any
// other, and the product answers with a token. That token is what every signed-in
// page reads and writes with, and it NEVER reaches the browser: the browser gets a
// cookie holding a random session id, and the token stays here, in this process's
// memory, against a hash of that id.
//
// WHY MEMORY AND NOT A DATABASE. The site has no dependencies, and a database
// client is one. In memory, a restart signs everybody out, which costs each person
// one passkey prompt, and a session cannot outlive the process that holds it. The
// token each session holds is minted to live seven days, so a session lost to a
// restart leaves behind a token nobody holds, which expires on its own and which
// the person can revoke from their tokens page in the meantime.
//
// WHAT A SESSION DEFENDS AGAINST, and how:
//
//   A stolen cookie       HttpOnly, so no script reads it; Secure and __Host- on
//                         https, so it is never sent in the clear or scoped wider.
//   A forged request      Every POST must carry an Origin header naming this site,
//                         and every form a per-session token; the cookie is
//                         SameSite=Lax as well. Any one of the three would do
//                         today; all three are here so no single browser quirk
//                         undoes it.
//   A leaked session id   It is 256 random bits, looked up by its hash, so the map
//                         holds nothing that could be replayed as a cookie.
//
// Web Crypto rather than node:crypto, like the rest of the handler, which uses
// only what every JavaScript runtime has.

import type { SignedIn } from "./api.ts";

export interface Session extends SignedIn {
  /** When the token, and so the session, stops. Milliseconds since the epoch. */
  readonly expiresAt: number;
  /** Sent back in every form, and compared on every POST. */
  readonly csrf: string;
  /** The network the session was made from, for the limit below. */
  readonly group: string;
  /** The credential id, unpadded base64url, of the passkey that connected: the one
   *  a post form asks to sign. Not a secret; the browser sends it with every prompt. */
  readonly credentialId?: string;
  /** 32 random bytes, unpadded base64url, that lock this person's encryption key in
   *  their browser for as long as this connection lasts: the browser keeps the key
   *  only under this, and this is kept only here, so a copy left behind in the
   *  browser after Disconnect opens nothing. Handed to the browser's own pages, never
   *  to the product. */
  readonly wrap: string;
}

/** How long a token minted for a session lives, which is how long the session does. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// HOW MANY SESSIONS, AND WHO LOSES ONE WHEN THERE ARE TOO MANY.
//
// A sign-in costs a software passkey nothing but the product's allowance for one
// address, so a table that dropped the oldest session when full would let a few dozen
// IPv6 networks sign every real person out, again and again. So a session only ever
// pushes out another session of the same key, or one made from the same network, and a
// full table refuses the newcomer instead of evicting anybody. Filling it means
// 1,563 separate networks and a hundred thousand registrations, which the product's
// own daily cap on tokens notices first.
const MAX_SESSIONS = 100_000;
const MAX_PER_KEY = 16;
const MAX_PER_GROUP = 64;

const sessions = new Map<string, Session>();
const byKey = new Map<string, Set<string>>();
const byGroup = new Map<string, Set<string>>();

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const random = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

async function hashOf(cookieValue: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cookieValue));
  return base64url(new Uint8Array(digest));
}

/** The cookie's name. __Host- requires Secure, a Path of / and no Domain, which
 *  pins the cookie to exactly this host over https. Plain http is only ever this
 *  machine, where a browser refuses a __Host- cookie it cannot send securely. */
const cookieName = (secure: boolean): string =>
  secure ? "__Host-schellingaf_session" : "schellingaf_session";

/**
 * The network a visitor's address belongs to, for counting sessions: an IPv4
 * address itself, and for IPv6 its /48, the block one customer is usually given,
 * so that the sixty-five thousand /64s inside it count as one.
 */
function addressGroup(address: string | null): string {
  if (!address) return "unknown";
  let a = address.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (a.startsWith("::ffff:") && a.includes(".")) a = a.slice(7);
  if (!a.includes(":")) return /^\d{1,3}(\.\d{1,3}){3}$/.test(a) ? a : "unknown";
  if (a.split("::").length > 2) return "unknown";
  const [head, tail = ""] = a.split("::");
  const front = head ? head.split(":") : [];
  const back = a.includes("::") && tail ? tail.split(":") : [];
  if (front.length + back.length > 8 || [...front, ...back].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return "unknown";
  const groups = a.includes("::") ? [...front, ...Array(8 - front.length - back.length).fill("0"), ...back] : front;
  if (groups.length !== 8) return "unknown";
  return groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/48";
}

function add(hash: string, session: Session): void {
  sessions.set(hash, session);
  for (const [index, name] of [[byKey, session.peerId], [byGroup, session.group]] as const) {
    const set = index.get(name) ?? new Set<string>();
    set.add(hash);
    index.set(name, set);
  }
}

function remove(hash: string): void {
  const session = sessions.get(hash);
  if (!session) return;
  sessions.delete(hash);
  for (const [index, name] of [[byKey, session.peerId], [byGroup, session.group]] as const) {
    const set = index.get(name);
    set?.delete(hash);
    if (set && set.size === 0) index.delete(name);
  }
}

/** Drop the oldest of one key's or one network's sessions until `keep` are left.
 *  A Set iterates in insertion order, so its first entries are its oldest. */
function trim(set: Set<string> | undefined, keep: number): void {
  if (!set) return;
  for (const hash of [...set]) {
    if (set.size <= keep) break;
    remove(hash);
  }
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [hash, s] of sessions) if (s.expiresAt <= now) remove(hash);
}

/** A new session's cookie value, or null when the table is full, which is said to
 *  the person rather than taken out of somebody else's session. */
export async function createSession(
  signedIn: { token: string; peerId: string; expiresAt: number; credentialId?: string },
  clientAddress: string | null,
): Promise<string | null> {
  const cookieValue = random();
  const hash = await hashOf(cookieValue);
  // Nothing is awaited from here until the session is added: an await between the
  // limits and the add would let sign-ins finishing at once all pass the limits before
  // any of them counted, and together go past every one.
  const group = addressGroup(clientAddress);
  trim(byKey.get(signedIn.peerId), MAX_PER_KEY - 1);
  trim(byGroup.get(group), MAX_PER_GROUP - 1);
  if (sessions.size >= MAX_SESSIONS) sweepExpired();
  if (sessions.size >= MAX_SESSIONS) return null;
  add(hash, { ...signedIn, csrf: random(), group, wrap: random() });
  return cookieValue;
}

/** The session this request's cookie names, when it names a live one. */
export async function readSession(request: Request, secure: boolean): Promise<Session | null> {
  const value = readCookie(request.headers.get("Cookie"), cookieName(secure));
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const hash = await hashOf(value);
  const session = sessions.get(hash);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    remove(hash);
    return null;
  }
  return session;
}

/** The session a cookie value names, as it was just made: for the answer to connecting. */
export async function readSessionOf(cookieValue: string): Promise<Session | null> {
  return sessions.get(await hashOf(cookieValue)) ?? null;
}

export async function destroySession(request: Request, secure: boolean): Promise<void> {
  const value = readCookie(request.headers.get("Cookie"), cookieName(secure));
  if (value) remove(await hashOf(value));
}

/** Every session one key holds here, ended: what revoking all of a key's tokens
 *  means on this site. */
export function destroySessionsOf(peerId: string): void {
  for (const hash of [...(byKey.get(peerId) ?? [])]) remove(hash);
}

export function sessionCookie(value: string, secure: boolean, maxAgeSeconds: number): string {
  return [
    `${cookieName(secure)}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearedCookie(secure: boolean): string {
  return sessionCookie("", secure, 0);
}

/**
 * A POST that came from a page of this site.
 *
 * Its Origin header names this site. A browser sends one on every POST, and a page
 * elsewhere cannot set it. The one browser-set alternative accepted is an Origin of
 * "null" or none at all together with Sec-Fetch-Site: same-origin, which no page
 * elsewhere can set either: a browser or an extension that withholds the origin
 * still says where the request came from. Anything else is refused rather than
 * trusted, and every form also needs the session's own token.
 */
export function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  if (origin === url.origin) return true;
  return (origin === null || origin === "null") && request.headers.get("Sec-Fetch-Site") === "same-origin";
}

/** The form's token, compared without stopping at the first difference. */
export function csrfMatches(session: Session, sent: string | null): boolean {
  if (!sent || sent.length !== session.csrf.length) return false;
  let diff = 0;
  for (let i = 0; i < sent.length; i++) diff |= sent.charCodeAt(i) ^ session.csrf.charCodeAt(i);
  return diff === 0;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}
