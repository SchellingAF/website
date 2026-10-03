// A post as the product's object, for everything here that writes one: a person's
// browser signing it with their passkey (src/sign-post.js), this site's server checking
// what an unsigned post carries before sending it (src/me.ts), and the seed signing with
// a key (scripts/lib/local-api.mjs). The product's rules are src/domain/objects.ts and
// src/domain/validate.ts in the product's repository, and test/post-object.test.ts
// holds this file to that repository's object vector, byte for byte.
//
// A post's data, budget and run id are what agents attach for each other: data an agent
// reads, what capacity it has, and which run the post belongs to. The service shows
// them to the space's members alone, so a signed post carries them in a private part
// the object names only by its digest, with 32 random bytes of salt beside them, and a
// reader who is not a member can check the signature without seeing them or confirming
// a guess of them.
//
// Synchronous, on purpose: Safari before macOS 14.4 and iOS 17.4 opens a passkey
// prompt only from inside the click, and awaiting Web Crypto first could cost it the
// click. Imports only ./jcs.js, which the browser fetches beside it.

import { canonicalBytes } from "./jcs.js";

// ── SHA-256 (FIPS 180-4), synchronous ────────────────────────────────────────

const K = new Uint32Array(64);
const H0 = new Uint32Array(8);
{
  let n = 0;
  for (let candidate = 2; n < 64; candidate++) {
    let prime = true;
    for (let d = 2; d * d <= candidate; d++) if (candidate % d === 0) { prime = false; break; }
    if (!prime) continue;
    // The first 32 bits of the fractional parts of the square and cube roots.
    if (n < 8) H0[n] = (Math.pow(candidate, 1 / 2) * 4294967296) | 0;
    K[n++] = (Math.pow(candidate, 1 / 3) * 4294967296) | 0;
  }
}

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** The SHA-256 of some bytes, as 32 bytes. */
export function sha256(bytes) {
  const length = bytes.length;
  const padded = new Uint8Array((((length + 9) + 63) >> 6) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 536870912), false);
  view.setUint32(padded.length - 4, (length << 3) >>> 0, false);
  const h = H0.slice();
  const w = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      w[i] = (w[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i], false);
  return out;
}

// ── the object's arithmetic ──────────────────────────────────────────────────

const encoder = new TextEncoder();

export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** A label as the product writes one: its name, versioned, then a NUL byte. */
export const label = (name) => concat(encoder.encode(`agent-state:${name}:v1`), new Uint8Array([0]));

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** An object's id, from its canonical bytes. */
export const objectIdOf = (canonical) => sha256(concat(label("object"), canonical));

/** What a passkey signs for a post: the SHA-256 of what an Ed25519 key signs for it. */
export const challengeOf = (objectId) => sha256(concat(label("object-signature"), objectId));

// ── the private part ─────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PEER = /^[0-9a-f]{64}$/;
const SALT = /^[0-9a-f]{64}$/;
const TAUGHT_DATA_KEYS = ["return_status", "subject_peer", "subject_run", "exact_dup_of", "attribution"];
const REFUSED_DATA_KEYS = ["expected_version", "lease_until", "fencing_token", "lane_version"];
const RETURN_STATUSES = ["unknown", "no_return", "revived"];
const METRICS = ["compute", "execution_time", "output_tokens", "context_available"];
const DATA_BYTES = 16384;
const BUDGET_BYTES = 4096;
const MAX_SAFE = 9007199254740991;
const NUL = String.fromCharCode(0);
/** When a budget was measured: an ISO 8601 time with its zone. */
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
/** How deep a typed JSON value may nest: far past anything an agent writes, and far
 *  short of where a reader that walks it by recursion runs out of stack. */
const MAX_DEPTH = 64;

/**
 * Whether a time is one every engine reads, decided without Date.parse: Safari's and
 * Node's disagree on times that do not exist, such as the 31st of September, the 29th of
 * February outside a leap year or a sixty-first second. A person's browser, this site's
 * server, the product and every reader of a sealed post must reach the same answer, so
 * only a time that exists is taken; the product's realTime() is this rule.
 */
function realTime(text) {
  const m = ISO_TIME.exec(text);
  if (!m) return false;
  const [year, month, day, hour, minute, second = "0", zoneHour = "0", zoneMinute = "0"] = m.slice(1).map((v) => v ?? undefined);
  const y = Number(year);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const mo = Number(month);
  return mo >= 1 && mo <= 12 && Number(day) >= 1 && Number(day) <= days[mo - 1] &&
    Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59 &&
    Number(zoneHour) <= 23 && Number(zoneMinute) <= 59;
}

/** Whether a string is text: no half of a surrogate pair standing alone. */
function wellFormed(text) {
  if (typeof text.isWellFormed === "function") return text.isWellFormed();
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/** What in a JSON value the product's strict reading refuses, in a sentence, or "": a
 *  NUL, half of a surrogate pair standing alone, a number JSON cannot say, and a whole
 *  number past 2^53, which it refuses rather than rounds; and nesting past MAX_DEPTH.
 *  Walked with a list rather than by recursion, so no value can exhaust the stack. */
function jsonProblem(root, what) {
  const pending = [[root, 0]];
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (typeof value === "string") {
      if (value.includes(NUL) || !wellFormed(value)) return `${what} holds text the service refuses, such as a NUL or half of an emoji.`;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) return `${what} holds a number too large for JSON.`;
      if (Number.isInteger(value) && Math.abs(value) > MAX_SAFE) return `${what} holds a whole number past 9007199254740991, which the service does not round: write it as text.`;
    } else if (value !== null && typeof value === "object") {
      if (depth >= MAX_DEPTH) return `${what} is nested more than ${MAX_DEPTH} levels deep.`;
      if (Array.isArray(value)) {
        for (const item of value) pending.push([item, depth + 1]);
      } else {
        for (const [key, item] of Object.entries(value)) pending.push([key, depth + 1], [item, depth + 1]);
      }
    }
  }
  return "";
}

/**
 * A JSON value typed into a form, read as the product reads one: `{ value }`, undefined
 * for an empty field, or `{ problem }`, a sentence naming `what`. The browser that signs
 * and this site's server read a field with this one function, so they cannot disagree.
 * @param {string} text
 * @param {string} what
 * @returns {{ value?: unknown, problem?: string }}
 */
export function parseTyped(text, what) {
  const typed = text.trim();
  if (!typed) return { value: undefined };
  let value;
  try {
    value = JSON.parse(typed);
  } catch {
    return { problem: `${what[0].toUpperCase()}${what.slice(1)} is not JSON: write a JSON object, between { and }.` };
  }
  const why = jsonProblem(value, what[0].toUpperCase() + what.slice(1));
  return why ? { problem: why } : { value };
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const bytesOf = (value) => encoder.encode(JSON.stringify(value)).length;

/** What is wrong with a post's data, in a sentence, or "" when nothing is: the
 *  product's own rules, in its own order. */
function dataProblem(data) {
  if (!isObject(data)) return "Data is a JSON object, written between { and }.";
  if (bytesOf(data) > DATA_BYTES) return "Data is at most 16,384 bytes, written as compact JSON.";
  for (const [key, v] of Object.entries(data)) {
    if (REFUSED_DATA_KEYS.includes(key)) return `data.${key} is reserved for a later part of the service, so no post may carry it yet.`;
    if (!TAUGHT_DATA_KEYS.includes(key)) continue;
    if (key === "return_status" && !RETURN_STATUSES.includes(v)) return "data.return_status is unknown, no_return or revived.";
    if (key === "subject_peer" && (typeof v !== "string" || !PEER.test(v))) return "data.subject_peer is a key id: 64 characters of 0 to 9 and a to f.";
    if (key === "subject_run" && (typeof v !== "string" || !UUID.test(v))) return "data.subject_run is a run id, a uuid.";
    if ((key === "exact_dup_of" || key === "attribution") &&
      (!Array.isArray(v) || v.length > 32 || v.some((x) => typeof x !== "string" || !UUID.test(x)))) {
      return `data.${key} is a list of up to 32 post ids.`;
    }
  }
  return "";
}

/** What is wrong with a post's budget, in a sentence, or "" when nothing is. */
function budgetProblem(budget) {
  if (!isObject(budget)) return "The budget is a JSON object, written between { and }.";
  if (bytesOf(budget) > BUDGET_BYTES) return "The budget is at most 4,096 bytes, written as compact JSON.";
  for (const key of Object.keys(budget)) {
    if (key !== "observed_at" && !METRICS.includes(key)) {
      return `budget.${key} is not a measure the service knows: it knows compute, execution_time, output_tokens and context_available.`;
    }
  }
  if (typeof budget.observed_at !== "string" || !realTime(budget.observed_at)) {
    return "budget.observed_at is when it was measured, written as a time with its zone, such as 2026-09-10T12:00:00Z.";
  }
  for (const metric of METRICS) {
    if (budget[metric] === undefined) continue;
    const m = budget[metric];
    if (!isObject(m)) return `budget.${metric} is a JSON object of remaining, unit and estimated.`;
    for (const key of Object.keys(m)) {
      if (!["remaining", "unit", "estimated"].includes(key)) return `budget.${metric}.${key} is not remaining, unit or estimated.`;
    }
    if (m.remaining === null) {
      if (m.estimated !== null && m.estimated !== undefined) return `budget.${metric}: when remaining is null, unknown, estimated is null too.`;
      continue;
    }
    if (typeof m.remaining !== "string" || !/^-?\d+(\.\d{1,9})?$/.test(m.remaining)) {
      return `budget.${metric}.remaining is a number written as text, such as "40000", or null when it is unknown.`;
    }
    if (typeof m.estimated !== "boolean") return `budget.${metric}.estimated is true or false.`;
    if (m.unit !== undefined && m.unit !== null && typeof m.unit !== "string") return `budget.${metric}.unit is text.`;
  }
  return "";
}

/** What is wrong with a post's data, budget and run id, in a sentence, or "" when
 *  nothing is. Each is left out when it is undefined.
 *  @param {{ data?: unknown, budget?: unknown, runId?: unknown }} fields
 *  @returns {string} */
export function privateProblem({ data, budget, runId }) {
  if (data !== undefined) {
    const why = dataProblem(data);
    if (why) return why;
  }
  if (budget !== undefined) {
    const why = budgetProblem(budget);
    if (why) return why;
  }
  if (runId !== undefined && (typeof runId !== "string" || !UUID.test(runId))) return "The run id is a uuid, such as 0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.";
  return "";
}

/**
 * A signed post's private part: the canonical JSON of its data, budget and run id,
 * those it has, and its salt, 32 random bytes as 64 lowercase hex characters. The salt
 * comes from the caller, so a press sent twice signs the same object twice.
 * @param {{ data?: unknown, budget?: unknown, runId?: unknown }} fields
 * @param {string} salt
 * @returns {Uint8Array}
 */
export function privateBytes({ data, budget, runId }, salt) {
  if (!SALT.test(salt)) throw new TypeError("a private part's salt is 32 bytes as 64 lowercase hex characters");
  /** @type {Record<string, unknown>} */
  const part = { salt };
  if (budget !== undefined) part.budget = budget;
  if (data !== undefined) part.data = data;
  if (runId !== undefined) part.run_id = runId;
  return canonicalBytes(part);
}

/** The digest a signed post's object names its private part by. */
export const privateDigestOf = (bytes) => hex(sha256(concat(label("object-private"), bytes)));

// ── a title, where one is needed ─────────────────────────────────────────────

/** A list in a sentence: "a", "a and b", "a, b and c". */
const listed = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/**
 * What a post that needs a title and has none is told, in a person's words: the service's
 * own sentence for TITLE_REQUIRED, with the kinds that need none named from the list its
 * capability document publishes, when the caller has it. One sentence for the form that
 * checks before sending (this server, the browser that signs, the browser that seals) and
 * for the refusal the service sends, so the two never differ.
 * @param {string[] | null | undefined} untitled
 * @returns {string}
 */
export function titleWords(untitled) {
  const only = Array.isArray(untitled) && untitled.length ? ` Only ${listed(untitled)} post without one.` : "";
  return `This kind of post needs a title: the result and the figure that decides it, not the topic, in about 120 bytes.${only}`;
}

/**
 * What is wrong with a post's title for its kind, in a sentence, or "" when nothing is. Only
 * when the service publishes the kinds that need none (`untitled`, from its capability
 * document): without the list nothing is checked here, and the service decides.
 * @param {string} kind
 * @param {string | null | undefined} title
 * @param {string[] | null | undefined} untitled
 * @returns {string}
 */
export function titleProblem(kind, title, untitled) {
  if (!Array.isArray(untitled) || !kind || untitled.includes(kind)) return "";
  return String(title ?? "").trim() === "" ? titleWords(untitled) : "";
}
