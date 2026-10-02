// The one place this site talks to the product.
//
// Every live page is rendered HERE, on this site's server, from the API's JSON --
// never in the browser. Three reasons:
//
//   1. The API serves no HTML and no CORS headers, on purpose. A browser cannot
//      call it and is not meant to.
//   2. A token must never reach a browser. The site's own tokens live in its
//      environment, and a signed-in person's in src/session.ts, in memory.
//   3. A crawler must see the finished page. A page that fetches its own content
//      is an empty page to everything that does not run scripts.
//
// The one script that sends a request, on /sign-in, sends it to this site, which
// sends it on: the browser still never talks to the API.
//
// THE READ IDENTITY IS AN ARGUMENT, NEVER A DEFAULT.
//
// The API attributes every read to a KEY, and rations reads per KEY -- or per
// network address when there is no token, which for this site means one shared
// bucket for every visitor to it. So the site reads as a KEY, and WHICH
// key decides what comes back. There are four, and they must never meet:
//
//   "site"    a registered KEY that is a member of nothing. It sees what any
//             registered stranger sees: every space's profile, and the contents
//             of the spaces marked public. Everything it renders is safe to index.
//   "reader"  a KEY somebody holds a role with. It sees that space's posts.
//             Nothing it renders may ever be cached publicly or indexed.
//   "none"    no token at all. What an anonymous caller sees: the same public
//             content as "site", on the smaller anonymous read allowance. The
//             public pages read this way whenever SITE_TOKEN is not set, and the
//             capability document is always read this way.
//
//   "session" the KEY of the person signed in on this request, whose token the
//             site holds in its own memory and never hands to the browser. Only
//             the signed-in address family reads this way, and nothing it
//             renders is ever cached or indexed.
//
// Passing the wrong one is how private content ends up in a search result, so
// the identity is named at every call site and the renderers are told which one
// they were given.

import { API_ORIGIN } from "./routes.generated.ts";

export type ReadAs = "site" | "reader" | "none" | "session";

/** Where the product answers, read once: API_ORIGIN from the server's environment
 *  when it is set, such as a private network address or a local product, and
 *  otherwise the public origin the build wrote from the copy that owns the name. An
 *  empty value is no value. The handler is written against Web APIs alone and needs
 *  no Node type definitions, so Node's environment is reached through a plain type
 *  here. */
const serverEnv = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const ORIGIN = (serverEnv.API_ORIGIN || API_ORIGIN).replace(/\/+$/, "");

export interface ApiEnv {
  /** The site's own KEY. Member of nothing. Public pages only. A secret, set in
   *  the server's environment, never in a file that is committed. */
  SITE_TOKEN?: string;
  /** A KEY with real memberships. /inspect only. Never a public page.
   *  The signed-in pages read with the signed-in key's own token instead. */
  READER_TOKEN?: string;
  /** The service's root public key, 64 hex characters, from its owner's key
   *  ceremony. Set, a checkpoint signed under any other root does not hold on this
   *  site's pages; unset, the pages say they checked against the root the service
   *  names. Public, not a secret. */
  SERVICE_ROOT_KEY?: string;
  /** The signed-in person's token, for one request. Never set on the server's
   *  environment: sessionEnv() in src/me.ts puts it on a copy of the environment
   *  made for a request on a signed-in address, after the session is found, and
   *  nowhere else. */
  SESSION_TOKEN?: string;
  /** Told when the service refuses SESSION_TOKEN on a read, so the signed-in page that
   *  read with it can end the session and send the person to connect again, rather than
   *  show a page that read nothing. Set only with SESSION_TOKEN, by src/me.ts. */
  onSessionRefused?: () => void;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false; status: number; code: string; message: string;
      /** The service's own word on what was wrong with the request, when it sends
       *  one: "q is at most 16 terms". It is a bounded token or sentence the
       *  service chose, never an echo of the caller's input, so a page may show it. */
      detail?: string;
    };

/** Wall-clock ceiling on one call to the API. A page that waits on the product
 *  indefinitely takes this site down with it. */
const TIMEOUT_MS = 6000;

function tokenFor(env: ApiEnv, as: ReadAs): string | undefined {
  if (as === "site") return env.SITE_TOKEN;
  if (as === "reader") return env.READER_TOKEN;
  if (as === "session") return env.SESSION_TOKEN;
  return undefined;
}

/** True when a read identity has a token configured. A page can then say
 *  honestly that it looked, rather than that there was nothing. */
export function haveToken(env: ApiEnv, as: ReadAs): boolean {
  return Boolean(tokenFor(env, as));
}

/**
 * One GET against the API, as the named identity.
 *
 * Reads. Writes are apiWrite() below, which takes a signed-in session rather
 * than an identity, so no public page can reach one by passing the wrong word.
 */
export async function apiGet<T>(env: ApiEnv, path: string, as: ReadAs): Promise<ApiResult<T>> {
  const token = tokenFor(env, as);
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await send<T>(path, { headers });
  if (res.ok || !token || !DEAD_KEY_CODES.has(res.code)) return res;
  // THE SITE'S OWN KEY, lapsed, revoked or blocked. A public page reads only what anyone
  // may, so it reads it with no key rather than failing, and the operator hears of it
  // in the log, at most once a minute. The service refuses a token that is no good on
  // every read that answers anyone, the directory and a space's profile included.
  if (as === "site") {
    if (Date.now() - siteKeyWarnedAt > 60_000) {
      siteKeyWarnedAt = Date.now();
      console.error(`SITE_TOKEN refused by the service (${res.code}): public pages read with no key until it is replaced`);
    }
    return send<T>(path, { headers: { accept: "application/json" } });
  }
  if (as === "session") env.onSessionRefused?.();
  return res;
}

/** How many of a work space's tasks its page reads: the newest by number. */
export const TASKS_SHOWN = 50;

/**
 * A work space's task list, newest number first, read as the identity the page reads
 * its stream with: whoever may read the space may read its tasks, so on a public
 * address that is the site's key or none. The one read the page makes for them.
 */
export const apiTasks = (env: ApiEnv, name: string, as: ReadAs): Promise<ApiResult<unknown>> =>
  apiGet<unknown>(env, `/v1/spaces/${name}/tasks?${new URLSearchParams({ limit: String(TASKS_SHOWN) })}`, as);

/** How many of a work space's findings its page reads: the newest. */
export const FINDINGS_SHOWN = 50;

/**
 * A work space's findings, newest first, read as the identity the page reads its stream
 * with: whoever may read the space may read its findings. Read after the tasks, never
 * beside them, so a caller with no key has two reads in flight at most.
 */
export const apiFindings = (env: ApiEnv, name: string, as: ReadAs): Promise<ApiResult<unknown>> =>
  apiGet<unknown>(env, `/v1/spaces/${name}/findings?${new URLSearchParams({ limit: String(FINDINGS_SHOWN) })}`, as);

/**
 * One post's finding, with what it cites and what cites it, read as the identity the post
 * was read with. The post's own answer carries none of it.
 */
export const apiPostFinding = (env: ApiEnv, id: string, as: ReadAs): Promise<ApiResult<unknown>> =>
  apiGet<unknown>(env, `/v1/posts/${id}/finding`, as);

/** The refusals that say a token presented is no good, as opposed to missing. */
const DEAD_KEY_CODES = new Set(["TOKEN_INVALID", "TOKEN_EXPIRED", "TOKEN_REVOKED", "KEY_BLOCKED"]);
/** When the log last said the site's own key was refused. */
let siteKeyWarnedAt = 0;

/**
 * WRITES, AND ONLY FROM A SIGNED-IN PAGE.
 *
 * A person signed in with a passkey does everything a KEY does, which means writing.
 * So the one write function there is takes a session -- the object src/session.ts
 * hands out for a request whose cookie it found -- and sends that session's own token
 * and no other. It cannot be called with SITE_TOKEN or READER_TOKEN, because it never
 * reads the environment.
 */
export interface SignedIn {
  readonly token: string;
  readonly peerId: string;
}

export async function apiWrite<T>(
  session: SignedIn,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${session.token}`,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return send<T>(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/**
 * The two calls that make a session, which carry no token because there is none
 * yet: a passkey challenge and a passkey's answer to it.
 *
 * The visitor's own address goes with them. The service rations these calls per
 * address, and every visitor to this site reaches it from the site's one address,
 * so without it one person pressing the button often enough would lock everyone
 * out of signing in. It goes as X-Forwarded-For, one entry, and as X-Real-IP, so the
 * service reads the same address whichever header its CLIENT_ADDRESS_FROM names, and
 * the site should reach it over a private network, where nothing else can.
 */
export async function apiSignIn<T>(
  path: "/v1/passkeys/challenge" | "/v1/passkeys/verify",
  body: unknown,
  clientAddress: string | null,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  if (clientAddress) {
    headers["x-forwarded-for"] = clientAddress;
    headers["x-real-ip"] = clientAddress;
  }
  return send<T>(path, { method: "POST", headers, body: JSON.stringify(body) });
}

/** The most a document read as text may be: the reviewer's rules are a few kilobytes. */
const TEXT_MAX_BYTES = 256 * 1024;

/**
 * A response's body, read no further than `max` bytes: null past that, when the rest
 * is not read at all. A page holds what it read in memory, so nothing the service
 * answers is ever taken whole on trust.
 */
async function boundedBytes(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A request the service did not answer: too slow, or not reached. The code and the
 *  message, never the request: an error carrying the URL is one step from an error
 *  carrying the header that went with it. */
const unanswered = (e: unknown): Refusal => ({
  ok: false,
  status: 504,
  code: e instanceof Error && e.name === "TimeoutError" ? "TIMEOUT" : "UNREACHABLE",
  message: "the service did not answer",
});

/**
 * A document the service publishes as text rather than JSON, read with no key: the
 * rules its reviewer applies, which a page shows as they are. Only an answer the
 * service marks as text, and no larger than a document of rules could be.
 */
export async function apiText(path: "/reviewer-rules.md"): Promise<ApiResult<string>> {
  let res: Response;
  try {
    res = await fetch(ORIGIN + path, { headers: { accept: "text/markdown, text/plain" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return unanswered(e);
  }
  if (!res.ok) {
    await res.body?.cancel();
    return { ok: false, status: res.status, code: `HTTP_${res.status}`, message: "the service refused the request" };
  }
  if (!/^text\//i.test(res.headers.get("content-type") ?? "")) {
    await res.body?.cancel();
    return { ok: false, status: 502, code: "NOT_TEXT", message: "the service answered with something that is not text" };
  }
  const bytes = await boundedBytes(res, TEXT_MAX_BYTES);
  if (bytes === null) return { ok: false, status: 502, code: "TOO_LARGE", message: "the service answered with more than a document of rules" };
  return { ok: true, data: new TextDecoder().decode(bytes) };
}

async function send<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(ORIGIN + path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return unanswered(e);
  }

  if (res.ok) {
    // A 204 is a success with nothing to say: revoking a token answers one.
    if (res.status === 204) return { ok: true, data: null as T };
    try {
      return { ok: true, data: (await res.json()) as T };
    } catch {
      return { ok: false, status: 502, code: "BAD_JSON", message: "the service answered with something that is not JSON" };
    }
  }

  return refusalOf(res);
}

/** A refusal, read from the API's error envelope, {error:{code,message,fix,detail?,doc,
 *  request_id}}. Its codes are the vocabulary the pages reason about: classifyRefusal
 *  below tells a dead credential from a space that is not readable with a live one. */
async function refusalOf(res: Response): Promise<Refusal> {
  let code = `HTTP_${res.status}`;
  let message = "the service refused the request";
  let detail: string | undefined;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; detail?: unknown } };
    if (body?.error?.code) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
    if (typeof body?.error?.detail === "string") detail = body.error.detail.slice(0, 300);
  } catch {
    /* an error body that is not JSON tells us nothing we do not already have */
  }
  return { ok: false, status: res.status, code, message, ...(detail ? { detail } : {}) };
}

/** How long one part of an export may take: up to eight mebibytes, which the service
 *  fetches fifty rows at a time, where a page is given six seconds. */
const EXPORT_TIMEOUT_MS = 30_000;

/** The most one part of an export may be. The service stops before eight mebibytes,
 *  except that its first line always goes in, and one post with its proof can run
 *  past a mebibyte; past this, the answer is not an export. */
const EXPORT_MAX_BYTES = 12 * 1024 * 1024;

/**
 * One part of an export, with the signed-in person's own key: a space's posts, or its
 * membership history, as JSON lines. It takes a session, never an identity, as a write
 * does, so no public page can ask for one. The bytes come back as the service sent
 * them, only when it said they are JSON lines, and never past EXPORT_MAX_BYTES.
 */
export async function apiExport(session: SignedIn, path: string): Promise<ApiResult<Uint8Array<ArrayBuffer>>> {
  let res: Response;
  try {
    res = await fetch(ORIGIN + path, {
      headers: { accept: "application/x-ndjson", authorization: `Bearer ${session.token}` },
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    });
  } catch (e) {
    return unanswered(e);
  }
  if (!res.ok) return refusalOf(res);
  if (!(res.headers.get("content-type") ?? "").startsWith("application/x-ndjson")) {
    await res.body?.cancel();
    return { ok: false, status: 502, code: "BAD_EXPORT", message: "the service answered with something that is not an export" };
  }
  try {
    const bytes = await boundedBytes(res, EXPORT_MAX_BYTES);
    return bytes === null
      ? { ok: false, status: 502, code: "EXPORT_TOO_LARGE", message: "the service answered with more than one part of an export can be" }
      : { ok: true, data: bytes };
  } catch (e) {
    const why = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "TIMEOUT" : "UNREACHABLE";
    return { ok: false, status: 504, code: why, message: "the service stopped answering" };
  }
}

/**
 * Why a read was refused, in the only three flavours a page needs to tell apart.
 *
 * Never one boolean: folding "the token you are reading with is dead" together with
 * "this key is genuinely not a member" tells a reader with an expired token that they
 * are not a member of a space they are in fact in, and sends them looking for the wrong
 * problem. Every token this site reads with meets this sooner or later, because a token
 * expires after ninety days on its own and can be revoked at any time.
 *
 *   "credential"  the KEY or its token is the problem. The reader can fix this.
 *   "access"      the credential is fine; this space is not readable with it.
 *   "service"     neither. Something is wrong at the product, or in between.
 *
 * The codes come from the API's own error table (src/db/errors.ts there) and are
 * matched by name rather than by status, because the status alone cannot tell
 * these apart: a dead token and a space you may not read are both a 4xx.
 */
type RefusalKind = "credential" | "access" | "service";

/** A refusal, as every page that words one receives it. */
export type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

const CREDENTIAL_CODES = new Set([
  "TOKEN_MISSING", "TOKEN_INVALID", "TOKEN_EXPIRED", "TOKEN_REVOKED", "KEY_BLOCKED",
]);
const ACCESS_CODES = new Set([
  "READ_DENIED", "NOT_A_MEMBER", "SPACE_CLOSED",
]);

export function classifyRefusal(code: string, status: number): RefusalKind {
  if (CREDENTIAL_CODES.has(code)) return "credential";
  if (ACCESS_CODES.has(code)) return "access";
  // Fall back on the status only when the code is one this site has never seen.
  // The API's codes are additive by contract, so an unknown one is expected
  // rather than exceptional, and 401 means the credential while 403 means the
  // space -- which is the same split, one level cruder.
  if (status === 401) return "credential";
  if (status === 403) return "access";
  return "service";
}
