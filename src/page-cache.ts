// Rendered pages, held in this process's memory.
//
// src/spaces.ts builds the key, decides what may be stored and never stores a page
// read with somebody's key. This only keeps what it is given, for as long as it is
// told, and forgets the least recently read pages when it holds too much. A restart
// empties it, which costs a few reads of the API.

const CACHE_BYTES = 64 * 1024 * 1024;

interface Entry {
  status: number;
  headers: [string, string][];
  body: Uint8Array<ArrayBuffer>;
  stored: number;
  maxAge: number;
}

const entries = new Map<string, Entry>();
let bytes = 0;

function drop(key: string, entry: Entry): void {
  entries.delete(key);
  bytes -= entry.body.byteLength;
}

/** The page held under this key, with the Age it has been held for, or nothing. */
export function cacheGet(key: string): Response | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  const age = Math.floor((Date.now() - entry.stored) / 1000);
  if (age >= entry.maxAge) {
    drop(key, entry);
    return undefined;
  }
  // Most recently read goes to the back, so the front is what to forget first.
  entries.delete(key);
  entries.set(key, entry);
  // Age is how src/index.ts knows how much of the lifetime is left, so a copy held
  // for four minutes of ten is handed on with six.
  const headers = new Headers(entry.headers);
  headers.set("Age", String(age));
  return new Response(entry.body, { status: entry.status, headers });
}

/**
 * How many forgets there have been, and which one last forgot each prefix, with when,
 * oldest first. A page whose request started before its prefix was last forgotten is not
 * stored when it finishes: it may have read the service before the change that made the
 * site forget, and storing it would put back what was just dropped. Counted rather than
 * timed, so a request that starts in the same millisecond as a forget, after it, is still
 * stored. Kept for as long as a request can take, and no longer.
 */
let forgets = 0;
const forgotten = new Map<string, { n: number; at: number }>();
const FORGET_WINDOW_MS = 5 * 60 * 1000;
const FORGET_KEPT = 10_000;

function pruneForgotten(now: number): void {
  for (const [prefix, { at }] of forgotten) {
    if (now - at < FORGET_WINDOW_MS && forgotten.size <= FORGET_KEPT) break;
    forgotten.delete(prefix);
  }
}

/** Where the forgets stand now: what a request takes when it starts, for cachePut(). */
export const cacheEpoch = (): number => forgets;

/** Forgets every page held under a key that starts with `prefix`, and says how many:
 *  for a change the site made itself, such as a post hidden from a signed-in page, which
 *  the public pages stop showing now rather than when their copies lapse. A page being
 *  rendered for a request that started before this is not stored either. */
export function cacheForget(prefix: string): number {
  const now = Date.now();
  forgets++;
  forgotten.delete(prefix);
  forgotten.set(prefix, { n: forgets, at: now });
  pruneForgotten(now);
  let dropped = 0;
  for (const [key, entry] of entries) {
    if (!key.startsWith(prefix)) continue;
    drop(key, entry);
    dropped++;
  }
  return dropped;
}

/** Whether a prefix of this key was forgotten after the epoch a request started at. */
function forgottenSince(key: string, startedAt: number): boolean {
  for (const [prefix, { n }] of forgotten) {
    if (n > startedAt && key.startsWith(prefix)) return true;
  }
  return false;
}

/** Holds a response for maxAge seconds. Reads the body, so pass a copy of a
 *  response that is also being sent. `startedAt` is cacheEpoch() when the request that
 *  rendered it started: a page whose prefix was forgotten since is not stored. */
export async function cachePut(key: string, response: Response, maxAge: number, startedAt = forgets): Promise<void> {
  const body = new Uint8Array(await response.arrayBuffer());
  // One page may not take more than a sixteenth of the store.
  if (maxAge <= 0 || body.byteLength > CACHE_BYTES / 16) return;
  // Asked after the body is read, since a forget can come while it is.
  if (forgottenSince(key, startedAt)) return;
  const old = entries.get(key);
  if (old) drop(key, old);
  entries.set(key, { status: response.status, headers: [...response.headers], body, stored: Date.now(), maxAge });
  bytes += body.byteLength;
  for (const [k, e] of entries) {
    if (bytes <= CACHE_BYTES) break;
    drop(k, e);
  }
}
