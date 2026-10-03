// The signed-in address family: /sign-in, /sign-out, and everything under /me.
//
// A person signs in with a passkey; a passkey is simply another KEY the product
// accepts; and whoever holds a KEY may do everything a KEY may. Nothing here records
// whether a key belongs to a person or an agent. These are the pages for that: a key's own view of
// itself, its tokens and its mailbox, the spaces it is in read with its own token,
// and every action a key has, as a form.
//
// THE RULES THIS FILE KEEPS.
//
//   1. The identity is the session, found before anything is read. No public
//      address ever looks at a session, and no address here is ever read without
//      one: the spaces under /me/spaces are matched only after the session is found.
//   2. Every write is a POST to an address here, from a page of this site (its
//      Origin header), carrying the session's form token, and it is sent with the
//      signed-in key's own token through apiWrite(), which cannot send another.
//   3. Nothing here is cached or indexed: src/index.ts sends every response from
//      this family as private, no-store, noindex, nofollow.
//   4. After a write the browser is sent on with a 303 to a page that says what
//      happened, chosen from a fixed list of words. Three answer the POST itself: a
//      new invite link or hand-over link, and a new access token, each shown once,
//      because a credential never goes into an address; and what revoke and remove
//      did, in the service's numbers, which an address anybody could send would let
//      anybody state.
//   5. Except one, deliberately: an invite link.
//      /me/join/<space>/<code> is where one brings a person, and a person not yet
//      connected passes through /sign-in?next= with it. Like every page here it is
//      kept by no cache and listed by no search engine; see src/grammar.ts.

import { apiGet, apiSignIn, apiUpload, apiWrite, classifyRefusal, type ApiEnv, type ApiResult, type Refusal } from "./api.ts";
import { attachmentLimits, capabilities, itemLimits, kindGroups, kindsWithoutTitle, knownKinds, linkRules, signInUnavailable, summaryLimit } from "./capabilities.ts";
import {
  EVENTS_PAGE, MAILBOX_PAGE, MEMBER_ROLES, rolesBelow, eventsHtml, formShell, invitesHtml, joinLinkHtml, joinRequestsHtml, mailboxHtml, meHtml, sealingPanelHtml,
  membersHref, membersHtml, newSpaceHtml, postAgainHtml, removalHtml, resultHtml, settingsHtml, signInHtml, tokensHtml, watchingHtml,
  newTokenHtml, forkHtml, blocksHtml, OPEN_ONLY_PUBLIC_WORK, categoriesRequired, PASSKEY_ANSWER, type ForkValues, type MailboxFilter,
  type Again, type BlockRow, type EventRow, type InviteRow, type LinkLook, type MadeLink, type MailboxItem, type MemberRow, type MembersAt, type MeView,
  type NewSpaceValues, type PostValues, type RequestRow, type TokenRow, type WatchRow,
} from "./me-render.ts";
import { shownSpace, type ShownSpace, type SpaceProfile, type Viewer } from "./render.ts";
import { normalName, register, resolveFiling } from "./categories.ts";
import {
  SESSION_TTL_SECONDS, clearedCookie, createSession, csrfMatches, destroySession, destroySessionsOf,
  readSession, readSessionOf, sameOrigin, sessionCookie, type Session,
} from "./session.ts";
import { forgetSpacePages, handle, matchSignedInRoute } from "./spaces.ts";
import { actOnMessages, readMessages, revokeUnheld, waitingOf } from "./messages.ts";
import {
  attachmentsOf, badForm, fileRefusalWords, filled, forbidden, html, idempotencyOf, joinCodeOf, json, lines, notAllowed, page, pick, postLimitWords,
  prepareFiles, readForm, readFormWithFiles, refusalText, see, siteLink, statusFor, tooMany, withheldPage, words, type PreparedFile, type SignedInContext,
} from "./signed-in.ts";
import {
  GENERATION, HAND_OVER_CODE, HEX32, INVITE_CODE, ISO_TIME, KEY_ID, LINK_CODE, NAME, POSITION, POST_SEQ, SPACE_NAME, TIME_ID_CURSOR, UUID,
} from "./grammar.ts";
import { actOnConnect, connectArrivalError, readConnect } from "./connect.ts";
import { LINK_WORDS, linkKind, type LinkKind } from "./join-render.ts";
import { CANONICAL_HOST } from "./routes.generated.ts";
import { EXPORT_FILE, readExport } from "./export.ts";
import { parseTyped, privateProblem, summaryProblem, titleProblem, titleWords } from "./post-object.js";
import { NOT_A_SIGN_IN_CHALLENGE, signInChallenge } from "./sign-in-challenge.js";
import {
  BROWSER_CHANGE_MEMBERS, handAndActivate, handLocks, keepersHtml, passkeyFields, readCommitments, readLocks, requestIdOf, sealedPart, sealedSpaceContext, sealingHost,
  type KeyBlock,
  type Waiting,
} from "./sealing.ts";

/** A space's own pages under /me/spaces/<name>/, by the word in their address, and what
 *  each is called: the governing ones, and an oracle space's fork. */
const GOVERNING_PAGES: Record<string, string> = {
  members: "Members", requests: "Join requests", invites: "Invite links", events: "Membership history", settings: "Settings",
  fork: "Fork", keepers: "Its key and keepers", blocks: "Blocked from posting",
};

/** A space's governing pages, and the actions a form under a space posts to. */
const GOVERNING = new RegExp(`^/me/spaces/(${NAME})/(${Object.keys(GOVERNING_PAGES).join("|")})$`);
const ACTING = new RegExp(`^/me/spaces/(${NAME})/(posts|join|stamp|leave|settings|members|members/remove|invites|hand-over|fork|watch|keepers|locks|admit|vouch|change|finish|abandon|hide|unhide|block|unblock)$`);

/** Where an invite link brings a person: /me/join/<space>/<code>, the signed-in twin of
 *  /join/<space>/<code>, and like it an address carrying a credential by the one
 *  exception to that rule. */
const JOINING = new RegExp(`^/me/join/(${NAME})/(${LINK_CODE})/*$`);

/** The one address that takes a form carrying files: a space's posts. serve.mjs allows it a
 *  larger body than any other form, and only when the form is multipart. */
const POSTING = new RegExp(`^/me/spaces/${NAME}/posts$`);
export const takesFiles = (path: string): boolean => POSTING.test(path);

/** Whether an address belongs to this family. Asked by src/index.ts before any
 *  other route, so a POST anywhere else can be refused outright. */
export function isSignedInAddress(path: string): boolean {
  return path === "/sign-in" || path === "/sign-in/challenge" || path === "/sign-out" ||
    path === "/me" || path.startsWith("/me/");
}

/** Which responses from this family carry the sign-in page's script. */
export const SIGN_IN_PAGE = "/sign-in";

interface Here {
  request: Request;
  url: URL;
  env: ApiEnv;
  secure: boolean;
  /** The visitor's address, as serve.mjs found it, for the product's per-address
   *  limit on signing in. */
  client: string | null;
}

export async function handleSignedIn(
  request: Request, url: URL, env: ApiEnv, secure: boolean, client: string | null,
): Promise<Response> {
  const here: Here = { request, url, env, secure, client };
  const path = url.pathname;
  const method = request.method === "HEAD" ? "GET" : request.method;

  if (path === "/sign-in" && method === "GET") return signInPage(here);
  if (path === "/sign-in/challenge" && method === "POST") return challenge(here);
  if (path === "/sign-in" && method === "POST") return verify(here);
  if (path === "/sign-out" && method === "POST") return signOut(here);
  if (path.startsWith("/sign-")) return notAllowed(method === "GET" ? "POST" : "GET, HEAD");

  const session = await readSession(request, secure);
  // An app's request that the product could not show a person lands here with a
  // word saying why, and reading that needs no session. See src/connect.ts.
  if (path === "/me/connect" && method === "GET" && url.searchParams.has("error")) {
    return connectArrivalError(url, session ? viewerOf(session) : undefined);
  }
  if (!session) {
    // A page asked for comes back after connecting: an app waiting at /me/connect
    // above all, whose person may never have connected here before. The key's own
    // page is where connecting goes anyway, so /me goes to plain /sign-in. A form
    // posted from a page whose session has ended goes to the sign-in page too, rather
    // than to a refusal that reads like an attack, and is not sent again.
    const next = method === "GET" && path !== "/me" ? safeNext(path + url.search) : null;
    return see(next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in");
  }
  const viewer = viewerOf(session);

  if (method === "POST") {
    if (!sameOrigin(request, url)) return forbidden(viewer, "That request did not come from a page of this site, so nothing was changed.");
    // Only a space's posts take a multipart form, the one shape that carries a file; any
    // other address reads a URL-encoded form alone, and answers a multipart one as expired.
    const sent = takesFiles(path) ? await readFormWithFiles(request) : { form: await readForm(request), files: [] as File[] };
    if (!sent?.form || !csrfMatches(session, sent.form.get("csrf"))) {
      return forbidden(viewer, "That form has expired, so nothing was changed. Go back, reload the page and try again.");
    }
    return act(here, session, viewer, path, sent.form, sent.files);
  }
  if (method !== "GET") return notAllowed("GET, HEAD, POST");
  // What waits in this key's messages, for the bar every signed-in page carries. A
  // download carries no bar, so it asks nothing.
  const waiting = EXPORT_FILE.test(path) ? null : await waitingOf(sessionEnv(env, session));
  return read(here, session, waiting ? { ...viewer, waiting } : viewer, path);
}

// ------------------------------------------------------------------ signing in

/**
 * Where to go after connecting: a signed-in page of this site, given as its path and
 * query, or null. Only an address under /me, so a link that sends somebody to
 * /sign-in cannot send them anywhere else afterwards.
 */
export function safeNext(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  if (!value.startsWith("/me") || value.includes("\\") || value.includes("//")) return null;
  let url: URL;
  try {
    url = new URL(value, "https://next.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://next.invalid" || url.hash !== "") return null;
  if (url.pathname !== "/me" && !url.pathname.startsWith("/me/")) return null;
  return url.pathname + url.search;
}

async function signInPage(h: Here): Promise<Response> {
  const session = await readSession(h.request, h.secure);
  const next = safeNext(h.url.searchParams.get("next"));
  if (session && next) return see(next);
  const caps = await capabilities();
  // A link waiting to be used says which kind it is, by its code's prefix.
  const joining = next === null ? null : new URL(next, h.url.origin).pathname.match(JOINING);
  const view = {
    unavailable: signInUnavailable(caps, h.url.origin),
    signedIn: session ? { peerId: session.peerId, csrf: session.csrf } : null,
    appWaiting: next !== null && next.startsWith("/me/connect"),
    linkWaiting: joining ? linkKind(joining[2]!) : null,
  };
  return html(signInHtml(formShell("Connect", view.signedIn ?? undefined, "Connect with a passkey."), view));
}

async function challenge(h: Here): Promise<Response> {
  if (!sameOrigin(h.request, h.url)) return json({ message: "That request did not come from a page of this site." }, 403);
  const caps = await capabilities();
  const why = signInUnavailable(caps, h.url.origin);
  if (why) return json({ message: why }, 503);
  const res = await apiSignIn<{ challenge: unknown; rp_id: string } | null>("/v1/passkeys/challenge", {}, h.client);
  if (!res.ok) return json({ message: signInRefusal(res) }, statusFor(res));
  // Only the product's challenge to connect with goes on to a passkey prompt: any
  // other could be a post's, and the person's signature on it a post they never wrote.
  // src/sign-in.js refuses the rest as well; neither trusts the other to.
  if (!res.data || !signInChallenge(res.data.challenge)) return json({ message: NOT_A_SIGN_IN_CHALLENGE }, 502);
  return json({ challenge: res.data.challenge, rp_id: res.data.rp_id });
}

/** What the browser sends after the passkey prompt: only these fields go on. */
const PASSKEY_FIELDS = ["challenge", "credential_id", "client_data_json", "authenticator_data", "signature", "public_key"] as const;

async function verify(h: Here): Promise<Response> {
  if (!sameOrigin(h.request, h.url)) return json({ message: "That request did not come from a page of this site." }, 403);
  if (!(h.request.headers.get("Content-Type") ?? "").startsWith("application/json")) {
    return json({ message: "Connecting sends JSON." }, 415);
  }
  let sent: Record<string, unknown>;
  try {
    const text = await h.request.text();
    if (text.length > 16_384) return json({ message: "That is far longer than a passkey's answer." }, 413);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    sent = parsed as Record<string, unknown>;
  } catch {
    return json({ message: "That was not what a passkey prompt returns." }, 400);
  }

  const payload: Record<string, unknown> = {};
  for (const field of PASSKEY_FIELDS) {
    const value = sent[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.length > 4096) return json({ message: "That was not what a passkey prompt returns." }, 400);
    payload[field] = value;
  }
  if (sent.algorithm !== undefined) {
    if (typeof sent.algorithm !== "number" || !Number.isInteger(sent.algorithm)) {
      return json({ message: "That was not what a passkey prompt returns." }, 400);
    }
    payload.algorithm = sent.algorithm;
  }
  payload.label = "website connection";
  payload.ttl_seconds = SESSION_TTL_SECONDS;

  const res = await apiSignIn<{ peer_id: string; token: string; expires_at: string }>(
    "/v1/passkeys/verify", payload, h.client);
  if (!res.ok) {
    // The one refusal src/sign-in.js answers with more than words: an offer to make a key.
    const code = res.code === "PASSKEY_NOT_REGISTERED" ? { code: res.code } : {};
    return json({ message: signInRefusal(res), ...code }, statusFor(res));
  }
  if (!KEY_ID.test(res.data.peer_id) || typeof res.data.token !== "string") {
    return json({ message: "The service answered with something this site cannot use." }, 502);
  }

  // Signing in again while signed in replaces the old session, and its token.
  const earlier = await readSession(h.request, h.secure);
  if (earlier) {
    await destroySession(h.request, h.secure);
    await apiWrite(earlier, "DELETE", "/v1/tokens/current", undefined);
  }

  const expiresAt = Date.parse(res.data.expires_at) || Date.now() + SESSION_TTL_SECONDS * 1000;
  const credential = payload.credential_id;
  const cookieValue = await createSession({
    token: res.data.token, peerId: res.data.peer_id, expiresAt,
    ...(typeof credential === "string" && /^[A-Za-z0-9_-]{22,1366}$/.test(credential) ? { credentialId: credential } : {}),
  }, h.client);
  if (!cookieValue) {
    // The token just minted is held by nobody, so it goes straight back.
    await apiWrite({ token: res.data.token, peerId: res.data.peer_id }, "DELETE", "/v1/tokens/current", undefined);
    return json({ message: "Too many people are connected to this site right now. Try again later." }, 503);
  }
  // Back to the page that sent the person here, when there was one. Read from what
  // the sign-in script sent, never forwarded to the product. With the key and this
  // connection's own secret, under which the script keeps the encryption key the
  // passkey's secret makes, when it gave one.
  const made = await readSessionOf(cookieValue);
  const out = json({
    location: safeNext(sent.next) ?? "/me?notice=signed-in",
    peer_id: res.data.peer_id,
    ...(made ? { wrap: made.wrap } : {}),
  });
  out.headers.append("Set-Cookie", sessionCookie(cookieValue, h.secure, (expiresAt - Date.now()) / 1000));
  return out;
}

async function signOut(h: Here): Promise<Response> {
  const session = await readSession(h.request, h.secure);
  // With no session there is nothing to end, and the cookie is left alone. A cross-site
  // form can reach this address without the cookie (SameSite=Lax withholds it) while a
  // top-level navigation may still clear it: clearing it before any check would let any
  // page sign a person out of the browser, leaving the session and its token live.
  if (!session) return see("/");
  if (!sameOrigin(h.request, h.url)) return forbidden(undefined, "That request did not come from a page of this site, so you are still connected.");
  const form = await readForm(h.request);
  if (!form || !csrfMatches(session, form.get("csrf"))) {
    return forbidden(undefined, "That form has expired, so you are still connected. Reload the page and try again.");
  }
  // The token first, so a sign-out the service did not hear about is not reported
  // as done while the token still works. A dead token is already signed out.
  const revoked = await apiWrite(session, "DELETE", "/v1/tokens/current", undefined);
  if (!revoked.ok && classifyRefusal(revoked.code, revoked.status) !== "credential") {
    return page(resultHtml(formShell("Not disconnected", viewerOf(session)), "You are still connected",
      "The service did not confirm disconnecting, so this connection still works. Try again in a moment.",
      [["/me", "Your key"]], true), 503);
  }
  await destroySession(h.request, h.secure);
  return sessionEnded(h, "/");
}

function signInRefusal(res: Refusal): string {
  switch (res.code) {
    case "PASSKEY_NOT_REGISTERED":
      return "This passkey is not registered here. If it is new, use Make a key with a passkey.";
    case "PASSKEY_INVALID":
      return "Your passkey's answer was not for this site, or the check failed. Nothing was changed; try again.";
    case "PASSKEY_TAKEN":
      return "That passkey's id already belongs to another key. Make a new passkey.";
    case "CHALLENGE_EXPIRED":
    case "CHALLENGE_INVALID":
      return "That took too long, or the answer was already used. Try again.";
    case "PASSKEYS_UNAVAILABLE":
      return "Connecting with a passkey is not switched on for this site yet.";
    case "KEY_BLOCKED":
      return "The operator has blocked this key.";
    case "RATE_LIMITED":
      return "Too many attempts from here in a short time. Wait a minute and try again.";
    case "SERVICE_READ_ONLY":
      return "The service is being repaired and takes no new connections right now. Try again later.";
    case "TIMEOUT":
    case "UNREACHABLE":
      return "The service did not answer. Try again shortly.";
    default:
      return "The service refused to connect you. Try again.";
  }
}

// ------------------------------------------------------------------ a token for an agent

/**
 * The form that makes an access token for an agent or a program, with a fresh passkey
 * challenge drawn into it. A new token for a passkey's key takes the passkey's answer,
 * as connecting does; the challenge is asked for when the form is drawn, so the page's
 * script opens the prompt inside the press and sends no request of its own.
 */
async function newTokenPage(h: Here, viewer: Viewer, typed: { said: string | null; label: string; days: string }, status: number): Promise<Response> {
  const shell = formShell("Make an access token", viewer);
  const none = { challenge: null, rpId: null, validFor: 0, ...typed };
  const why = signInUnavailable(await capabilities(), h.url.origin);
  if (why) return page(newTokenHtml(shell, viewer, { ...none, unavailable: why }), status);
  const res = await apiSignIn<{ challenge?: unknown; rp_id?: unknown; expires_at?: unknown }>("/v1/passkeys/challenge", {}, h.client);
  if (!res.ok) return page(newTokenHtml(shell, viewer, { ...none, unavailable: tokenRefusal(res) }), statusFor(res));
  // Only the product's challenge to connect with, as on /sign-in: any other could be a
  // post's, and the person's signature on it a post they never wrote.
  const challenge = signInChallenge(res.data?.challenge) ? String(res.data.challenge) : null;
  if (!challenge) return page(newTokenHtml(shell, viewer, { ...none, unavailable: null }), 502);
  const expires = typeof res.data.expires_at === "string" ? Date.parse(res.data.expires_at) : NaN;
  // Good for as long as the product says, less half a minute for the press and the prompt.
  const validFor = Math.max(0, Math.floor(((Number.isNaN(expires) ? Date.now() + 300_000 : expires) - Date.now()) / 1000) - 30);
  return page(newTokenHtml(shell, viewer, {
    challenge, rpId: typeof res.data.rp_id === "string" ? res.data.rp_id : null, validFor, unavailable: null, ...typed,
  }), status);
}

/**
 * A new access token for this key, confirmed with its passkey, shown once in this
 * POST's own answer and kept nowhere: not in an address, a session, a cache or a log.
 * A passkey of another key makes a token of that key, which is revoked at once.
 */
async function makeToken(h: Here, session: Session, viewer: Viewer, form: URLSearchParams): Promise<Response> {
  const label = (form.get("label") ?? "").trim();
  const days = (form.get("days") ?? "").trim();
  const again = (said: string, status: number) => newTokenPage(h, viewer, { said: `${said} Nothing was made.`, label, days }, status);
  const bytes = new TextEncoder().encode(label).length;
  if (bytes < 1 || bytes > 64) return again("A label says what the token is for, at most 64 bytes: about 64 letters, fewer in some alphabets.", 400);
  if (label === "website connection") return again("website connection names this site's own connections. Choose another label.", 400);
  if (!/^[1-9][0-9]?$/.test(days) || Number(days) > 90) return again("How long it lasts is a whole number of days from 1 to 90.", 400);
  const challenge = form.get("challenge") ?? "";
  if (!signInChallenge(challenge)) return badForm(viewer);
  const answer: Record<string, string> = {};
  // What the passkey's answer carries, and nothing else goes on to the product: never a
  // public key, so nothing can be registered here.
  for (const field of PASSKEY_ANSWER) {
    const value = form.get(field) ?? "";
    if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      return again("Your passkey's answer did not arrive. This page needs its script to ask your passkey.", 400);
    }
    answer[field] = value;
  }

  const res = await apiSignIn<{ peer_id?: unknown; token?: unknown; expires_at?: unknown }>("/v1/passkeys/verify",
    { challenge, ...answer, label, ttl_seconds: Number(days) * 86400 }, h.client);
  if (!res.ok) return again(tokenRefusal(res), statusFor(res));
  const { peer_id: peerId, token, expires_at: expiresAt } = res.data;
  if (typeof peerId !== "string" || !KEY_ID.test(peerId) || typeof token !== "string" || !/^[\x21-\x7e]{16,512}$/.test(token) || typeof expiresAt !== "string") {
    return page(resultHtml(formShell("Not done", viewer), "Not done", "The service answered with something this site cannot use. Nothing is shown.",
      [["/me/tokens", "Access tokens"]], true), 502);
  }
  if (peerId !== session.peerId) {
    // Revoked with itself, tried twice, and the page says which happened: nobody was
    // shown the token either way, but the page never says it did what it did not.
    const revoke = async () => {
      const r = await apiWrite({ token, peerId }, "DELETE", "/v1/tokens/current", undefined);
      return r.ok || r.code === "TOKEN_REVOKED";
    };
    return again(await revoke() || await revoke()
      ? "That passkey belongs to another key, so the token it made was revoked at once. Use the passkey you connected with."
      : `That passkey belongs to another key, and the token it made for that key could not be revoked. Nobody was shown it, and it lapses within ${days} ${days === "1" ? "day" : "days"}; to end it sooner, connect with that passkey and revoke it on Access tokens. Use the passkey you connected with.`, 409);
  }
  const listed = await apiGet<{ items: TokenRow[] }>(sessionEnv(h.env, session), "/v1/tokens", "session");
  const items = listed.ok && Array.isArray(listed.data.items) ? listed.data.items : [];
  return html(tokensHtml(formShell("Access tokens", viewer), viewer, items, null, { token, label, expires_at: expiresAt }));
}

/** Why a passkey's answer made no token, in the words of the page that asked for one. */
function tokenRefusal(res: Refusal): string {
  switch (res.code) {
    case "PASSKEY_NOT_REGISTERED": return "That passkey is not a key's passkey here. Use the passkey you connected with.";
    case "PASSKEY_INVALID": return "Your passkey's answer did not check out. Try again.";
    case "CHALLENGE_EXPIRED":
    case "CHALLENGE_INVALID": return "That took too long, or this page's challenge was used already. Press the button again below.";
    case "PASSKEYS_UNAVAILABLE": return "The service is not accepting passkeys right now.";
    case "RATE_LIMITED": return "Too many attempts from here in a short time. Wait a minute and try again.";
    default: return refusalText(res);
  }
}

// ------------------------------------------------------------------ reading

async function read(h: Here, session: Session, viewer: Viewer, path: string): Promise<Response> {
  const env = sessionEnv(h.env, session);
  const notice = h.url.searchParams.get("notice");

  if (path === "/me/messages" || path.startsWith("/me/messages/")) {
    const out = await readMessages(contextOf(h, session, viewer), path);
    if (out) return out;
  }
  if (path === "/me") {
    // The spaces a key is in, two hundred at a time, continuing after a space's name.
    const after = SPACE_NAME.test(h.url.searchParams.get("after") ?? "") ? h.url.searchParams.get("after")! : "";
    const res = await apiGet<MeView>(env, `/v1/me${after ? `?${new URLSearchParams({ after })}` : ""}`, "session");
    if (!res.ok) return refused(h, viewer, res);
    return html(meHtml(formShell("Your key", viewer), res.data, notice, after, sealingPanelHtml(viewer, res.data, await sealingHost(viewer))));
  }
  if (path === "/me/open") {
    const name = (h.url.searchParams.get("name") ?? "").trim();
    return see(SPACE_NAME.test(name) ? `/me/spaces/${name}` : "/me");
  }
  if (path === "/me/spaces" || path === "/me/spaces/") return see("/me");
  if (path === "/me/tokens") {
    // Newest first, two hundred at a time, continuing before where the last page ended,
    // in the service's own shape of cursor, so every token has a page.
    const before = TIME_ID_CURSOR.test(h.url.searchParams.get("before") ?? "") ? h.url.searchParams.get("before")! : "";
    const res = await apiGet<{ items: TokenRow[]; next_before?: unknown; has_more?: unknown }>(
      env, `/v1/tokens${before ? `?${new URLSearchParams({ before })}` : ""}`, "session");
    if (!res.ok) return refused(h, viewer, res);
    const next = res.data.has_more === true && typeof res.data.next_before === "string" && TIME_ID_CURSOR.test(res.data.next_before)
      ? res.data.next_before : null;
    return html(tokensHtml(formShell("Access tokens", viewer), viewer, res.data.items, notice, null, { before, next }));
  }
  if (path === "/me/tokens/new") return newTokenPage(h, viewer, { said: null, label: "", days: "90" }, 200);
  if (path === "/me/connect") return readConnect(contextOf(h, session, viewer));
  if (path === "/me/mailbox") {
    const q = h.url.searchParams;
    const after = POSITION.test(q.get("after") ?? "") ? q.get("after")! : "0";
    // Kept to one reason, one kind of post or one key: a reason or a kind the service
    // does not publish is no filter at all, and a key id in any other shape is refused
    // before anything is asked.
    const caps = await capabilities();
    const reasons = (Array.isArray(caps.mailbox_reasons) ? caps.mailbox_reasons : [])
      .filter((r): r is string => typeof r === "string" && /^[a-z_]{1,32}$/.test(r));
    const kinds = [...knownKinds(caps)].filter((k) => /^[a-z_]{1,32}$/.test(k));
    const author = (q.get("author") ?? "").trim().toLowerCase();
    const filter: MailboxFilter = {
      reason: reasons.includes(q.get("reason") ?? "") ? q.get("reason")! : "",
      kind: kinds.includes(q.get("kind") ?? "") ? q.get("kind")! : "",
      author: author.slice(0, 64),
    };
    const shell = formShell("Mailbox", viewer);
    if (author && !KEY_ID.test(author)) {
      return page(mailboxHtml(shell, viewer, [], "0", null, "0", null, filter, reasons, kinds,
        "From one key takes that key's id: 64 characters of 0 to 9 and a to f. Nothing was asked."), 400);
    }
    const params = new URLSearchParams({ after, limit: String(MAILBOX_PAGE), detail: "snippets", token_budget: "65536" });
    if (filter.reason) params.set("reason", filter.reason);
    if (filter.kind) params.set("kind", filter.kind);
    if (filter.author) params.set("author", filter.author);
    const res = await apiGet<{ items: MailboxItem[]; next_after: string | null; has_more: boolean; head_seq: string }>(
      env, `/v1/mailbox?${params}`, "session");
    if (!res.ok) return refused(h, viewer, res);
    return html(mailboxHtml(shell, viewer, res.data.items, after,
      res.data.has_more && POSITION.test(res.data.next_after ?? "") ? res.data.next_after : null, res.data.head_seq ?? "0", notice,
      filter, reasons, kinds));
  }
  if (path === "/me/watching") {
    const res = await apiGet<{ items: WatchRow[] }>(env, "/v1/watching", "session");
    if (!res.ok) return refused(h, viewer, res);
    return html(watchingHtml(formShell("Documents you watch", viewer), Array.isArray(res.data.items) ? res.data.items : []));
  }
  if (path === "/me/new") {
    // A name comes along from a space page that found no space by it.
    const asked = (h.url.searchParams.get("name") ?? "").trim();
    return html(newSpaceHtml(formShell("Create a space", viewer), viewer,
      { name: SPACE_NAME.test(asked) ? asked : "", title: "", description: "", visibility: "private", join_policy: "request", categories: [] },
      null, await register(), await sealingHost(viewer), takesOpen(await capabilities())));
  }

  // A space's export: its page, and the downloads it offers.
  const exported = await readExport(contextOf(h, session, viewer), path);
  if (exported) return exported;

  // A space's governing pages.
  const governing = path.match(GOVERNING);
  if (governing) return governPage(h, session, viewer, governing[1]!, governing[2]!, notice, null);

  // An invite link, for the person who followed one here.
  const joining = path.match(JOINING);
  if (joining) return joinLinkPage(h, session, viewer, joining[1]!, joining[2]!);

  // The spaces themselves, their posts, replies and archives, and search: the
  // public pages' own handlers, reading with this session's key. A key the service no
  // longer takes ends the session and sends the person to connect again, as every page
  // of this family's own does, rather than a page that read nothing.
  const route = matchSignedInRoute(path, h.request.headers.get("Accept"), viewer);
  if (route) {
    let keyRefused = false;
    const answer = await handle(route, h.url, { ...env, onSessionRefused: () => { keyRefused = true; } });
    if (!keyRefused) return answer;
    void destroySession(h.request, h.secure);
    return sessionEnded(h, "/sign-in");
  }

  return nothingHere(viewer, "page");
}

async function spaceProfile(h: Here, session: Session, name: string): Promise<ApiResult<SpaceProfile>> {
  return apiGet<SpaceProfile>(sessionEnv(h.env, session), `/v1/spaces/${name}`, "session");
}

/**
 * Where on the members page a request is, held to each field's shape: one role, one key
 * to find, and the member the page continues after. A page's own address names them
 * role, peer and after; a form, whose own role and peer are the member it changes,
 * carries them back as in_role, find and after.
 */
function membersAtOf(q: URLSearchParams, names = { role: "role", peer: "peer", after: "after" }): MembersAt {
  const role = q.get(names.role) ?? "";
  const peer = q.get(names.peer) ?? "";
  const after = q.get(names.after) ?? "";
  return {
    role: MEMBER_ROLES.includes(role) ? role : "",
    peer: KEY_ID.test(peer) ? peer : "",
    after: KEY_ID.test(after) ? after : "",
  };
}

/** Where a form's POST comes back to, with the word that says what happened. */
const withNotice = (href: string, notice: string): string => `${href}${href.includes("?") ? "&" : "?"}notice=${notice}`;

async function governPage(
  h: Here, session: Session, viewer: Viewer, name: string, what: string, notice: string | null,
  // A link just made, shown once in the answer to the form that made it.
  made: MadeLink | null,
  // A form this site refused before sending it: shown again as typed, with a 400, on
  // the page it was sent from. A POST has no query, so where on the page it was comes along.
  again: (Again & { at?: MembersAt }) | null = null,
): Promise<Response> {
  const env = sessionEnv(h.env, session);
  const profile = await spaceProfile(h, session, name);
  if (!profile.ok) return refused(h, viewer, profile, name);
  if (profile.data.unavailable) return withheldPage(formShell(name, viewer), name);
  const space = shownSpace(profile.data);
  const title = what === "invites" && space.visibility === "sealed" ? "Offers of a role" : GOVERNING_PAGES[what];
  const shell = formShell(`${title} — ${name}`, viewer);
  const answer = (body: string) => (again ? page(body, 400) : html(body));
  const q = h.url.searchParams;

  switch (what) {
    case "members": {
      // One role, one key found by its id, or a page of everybody: in a space of a
      // hundred thousand members, the ones a person is looking for are found.
      const at = again?.at ?? membersAtOf(q);
      const params = new URLSearchParams({ limit: "200", ...(at.role ? { role: at.role } : {}), ...(at.peer ? { peer: at.peer } : {}), ...(at.after ? { after: at.after } : {}) });
      const res = await apiGet<{ owner: string; items: MemberRow[]; next_after: string | null; has_more: boolean }>(
        env, `/v1/spaces/${name}/members?${params}`, "session");
      if (!res.ok) return refused(h, viewer, res, name);
      const next = res.data.has_more && KEY_ID.test(res.data.next_after ?? "") ? res.data.next_after : null;
      return answer(membersHtml(shell, viewer, space, res.data.owner, res.data.items, next, notice, at, again));
    }
    case "requests": {
      const wanted = q.get("state") ?? "pending";
      const state = ["pending", "approved", "declined", "withdrawn"].includes(wanted) ? wanted : "pending";
      // Paged by the request the page before ended on, as the service pages them, so the
      // list does not stop at two hundred.
      const after = UUID.test(q.get("after") ?? "") ? q.get("after")! : "";
      const params = new URLSearchParams({ state, limit: "200", ...(after ? { after } : {}) });
      const res = await apiGet<{ items: RequestRow[]; next_after?: string | null; has_more?: boolean; pending_count?: unknown }>(
        env, `/v1/spaces/${name}/requests?${params}`, "session");
      if (!res.ok) return refused(h, viewer, res, name);
      const next = res.data.has_more === true && UUID.test(res.data.next_after ?? "") ? res.data.next_after! : null;
      const pending = Number.isSafeInteger(res.data.pending_count) && (res.data.pending_count as number) >= 0 ? res.data.pending_count as number : null;
      return html(joinRequestsHtml(shell, viewer, space, state, res.data.items, notice, after, next, pending));
    }
    case "invites": {
      // Every link of the space for its owner and admins, and its own for any other
      // member, a hundred at a time, newest first, or only the ones that still work.
      const live = q.get("live") === "true";
      const after = UUID.test(q.get("after") ?? "") ? q.get("after")! : "";
      const params = new URLSearchParams({ limit: "100", ...(live ? { live: "true" } : {}), ...(after ? { after } : {}) });
      const [res, caps] = await Promise.all([
        apiGet<{ items?: InviteRow[]; next_after?: string | null; has_more?: boolean }>(env, `/v1/spaces/${name}/invites?${params}`, "session"),
        capabilities(),
      ]);
      if (!res.ok) return refused(h, viewer, res, name);
      const next = res.data.has_more === true && UUID.test(res.data.next_after ?? "") ? res.data.next_after! : null;
      return answer(invitesHtml(shell, viewer, space, {
        items: Array.isArray(res.data.items) ? res.data.items : [], after, nextAfter: next, live, notice, made, again,
        rules: linkRules(caps),
      }));
    }
    case "events": {
      const after = POSITION.test(h.url.searchParams.get("after") ?? "") ? h.url.searchParams.get("after")! : "0";
      const res = await apiGet<{ items: EventRow[]; next_after: string; has_more: boolean; head_revision?: string }>(
        env, `/v1/spaces/${name}/events?after=${after}&limit=${EVENTS_PAGE}`, "session");
      if (!res.ok) return refused(h, viewer, res, name);
      // The newest entry's number, from the history's own answer, or the space's; a
      // number in any other shape offers no newest page.
      const head = [res.data.head_revision, space.revision].find((r) => typeof r === "string" && POSITION.test(r)) ?? null;
      const next = res.data.has_more && POSITION.test(res.data.next_after ?? "") ? res.data.next_after : null;
      return html(eventsHtml(shell, space, res.data.items, after, next, head));
    }
    case "settings": {
      if (space.access?.role !== "owner") {
        return page(resultHtml(shell, "Only the owner changes a space", `The settings of ${name} are its owner's to change.`,
          [[`/me/spaces/${name}`, "Back to the space"]], true), 403);
      }
      const [reg, caps] = await Promise.all([register(), capabilities()]);
      return html(settingsHtml(shell, viewer, space, notice, reg, null, null, takesOpen(caps)));
    }
    case "blocks": {
      // The keys blocked from posting here: the owner's and the admins' to read and change,
      // as the service holds it, so anybody else is told so without asking it.
      if (space.access?.role !== "owner" && space.access?.role !== "admin") {
        return page(resultHtml(shell, "Only the owner or an admin", `Who is blocked from posting in ${name} is for its owner and admins to see and change.`,
          [[`/me/spaces/${name}`, "Back to the space"]], true), 403);
      }
      // A page at a time, in the service's order of key ids, after the one the last page ended on.
      const after = KEY_ID.test(q.get("after") ?? "") ? q.get("after")! : "";
      const res = await apiGet<{ items?: unknown; next_after?: unknown; has_more?: unknown }>(
        env, `/v1/spaces/${name}/blocks?${new URLSearchParams({ limit: "100", ...(after ? { after } : {}) })}`, "session");
      if (!res.ok) return refused(h, viewer, res, name);
      const items = (Array.isArray(res.data.items) ? res.data.items : []).flatMap((raw): BlockRow[] => {
        const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        return typeof r.peer_id === "string" && typeof r.blocked_at === "string" ? [{ peer_id: r.peer_id, blocked_at: r.blocked_at }] : [];
      });
      const next = res.data.has_more === true && typeof res.data.next_after === "string" && KEY_ID.test(res.data.next_after) ? res.data.next_after : null;
      return answer(blocksHtml(shell, viewer, space, items, after, next, notice, again));
    }
    case "fork": {
      if (space.oracle !== true) return nothingHere(viewer, "page");
      return html(forkHtml(shell, viewer, space, null, await register(), null));
    }
    case "keepers": {
      if (space.visibility !== "sealed") return nothingHere(viewer, "page");
      const ctx = await sealedSpaceContext(env, name);
      if (!("html" in ctx)) return refused(h, viewer, ctx, name);
      const st = ctx.status;
      const next = st.generation === null ? 1 : Number(st.generation) + 1;
      const memberCount = typeof space.member_count === "number" ? space.member_count + 1 : BROWSER_CHANGE_MEMBERS + 1;
      // Who waits for the key in use, and, for a change of key a browser can make, every
      // member with their keys: those still waiting for a generation nobody has staged.
      // A change under way is finished from here only by a browser that holds the new
      // key, with the members still waiting for it.
      // Join requests a hundred at a time, after the one the last page ended on, so the
      // ones past the first hundred have a page and can be admitted here.
      const requestsAfter = UUID.test(h.url.searchParams.get("after") ?? "") ? h.url.searchParams.get("after")! : "";
      const [waiting, everyone, requests, stagedWaiting] = await Promise.all([
        st.keeper && st.generation !== null
          ? apiGet<{ items: Waiting[] }>(env, `/v1/spaces/${name}/sealed/unlocked?limit=1000`, "session") : null,
        st.keeper && !st.staged && memberCount <= BROWSER_CHANGE_MEMBERS
          ? apiGet<{ items: Waiting[] }>(env, `/v1/spaces/${name}/sealed/unlocked?generation=${next}&limit=1000`, "session") : null,
        st.keeper && admitsHere(space)
          ? apiGet<{ items: { request_id: string; created_at: string; peer: KeyBlock; stamp: unknown }[]; next_after?: unknown; has_more?: unknown }>(
            env, `/v1/spaces/${name}/sealed/requests?${new URLSearchParams({ limit: "100", ...(requestsAfter ? { after: requestsAfter } : {}) })}`, "session")
          : null,
        st.keeper && st.staged && GENERATION.test(st.staged.generation) && memberCount <= BROWSER_CHANGE_MEMBERS
          ? apiGet<{ items: Waiting[] }>(env, `/v1/spaces/${name}/sealed/unlocked?generation=${st.staged.generation}&limit=1000`, "session") : null,
      ]);
      const itemsOf = <T>(res: ApiResult<{ items: T[] }> | null): T[] => (res?.ok && Array.isArray(res.data.items) ? res.data.items : []);
      return html(keepersHtml(shell, viewer, {
        name, status: st, context: ctx.html, host: await sealingHost(viewer),
        waiting: itemsOf(waiting).filter((m) => KEY_ID.test(m.peer_id)),
        everyone: everyone?.ok ? itemsOf(everyone).filter((m) => KEY_ID.test(m.peer_id)) : null,
        stagedWaiting: stagedWaiting?.ok ? itemsOf(stagedWaiting).filter((m) => KEY_ID.test(m.peer_id)) : null,
        memberCount,
        requests: itemsOf(requests).filter((r) => UUID.test(r.request_id) && KEY_ID.test(r.peer?.peer_id ?? "")),
        requestsAfter,
        requestsNext: requests?.ok && requests.data.has_more === true && typeof requests.data.next_after === "string" && UUID.test(requests.data.next_after)
          ? requests.data.next_after : null,
        mayAdmit: admitsHere(space),
        roles: rolesBelow(space.access?.role),
        isOwner: space.access?.role === "owner",
        notice: keeperNotice(notice),
      }));
    }
    default:
      return nothingHere(viewer, "page");
  }
}

/** Whether a key lets others in here: the owner, an admin or a coordinator. */
const admitsHere = (space: ShownSpace): boolean => ["owner", "admin", "coordinator"].includes(space.access?.role ?? "");

/** What a keeper's action did, in words, from a fixed list. */
function keeperNotice(notice: string | null): string | null {
  switch (notice) {
    case "keepers-signed": return "The keeper list is signed and in force.";
    case "key-handed": return "The key is handed to the members who were waiting.";
    case "admitted": return "Admitted, vouched for with your stamp, and handed the key.";
    case "vouched": return "Vouched for with your stamp, and handed the key.";
    case "key-changed": return "The key is changed. Every member vouched for holds the new one, and the history stays readable.";
    case "change-abandoned": return "The change of key is abandoned. The key before it is still the one in use, and the next change begins again.";
    default: return null;
  }
}

/**
 * Whether this request for an invite link's page may ask the service about the link with
 * the person's key. A look counts against the key's allowance as a use does, so it is
 * never made for a page another site sent the browser to, nor for a HEAD: only for one
 * the person opened here, or typed, which a browser says in Sec-Fetch-Site. A browser that
 * says nothing of where a request came from looks when the person asks, by the page's own
 * link, which adds look=1.
 */
function mayLook(h: Here): boolean {
  if (h.request.method !== "GET") return false;
  const from = h.request.headers.get("Sec-Fetch-Site");
  if (from === "same-origin" || from === "none") return true;
  return from === null && h.url.searchParams.get("look") === "1";
}

/**
 * Where an invite link or a hand-over link brings a person, once connected: the space as
 * their own key reads it, what the link gives as the service says when it is asked with
 * that key, and its one button, which posts the code to the space's join action. Opening
 * it uses nothing: the look is a POST only because the service takes the code in a
 * request's body and never in an address, and it changes nothing. Opened from another
 * site it does not look, and offers the button only once it has.
 */
async function joinLinkPage(h: Here, session: Session, viewer: Viewer, name: string, code: string): Promise<Response> {
  const kind = linkKind(code);
  const shell = formShell(`${LINK_WORDS[kind].heading} ${name}`, viewer);
  const looking = mayLook(h);
  const [profile, looked] = await Promise.all([
    spaceProfile(h, session, name),
    looking ? apiWrite<unknown>(session, "POST", "/v1/invites/look", { name, code }) : null,
  ]);
  if (!profile.ok) {
    if (profile.code === "SPACE_NOT_FOUND") {
      return page(resultHtml(shell, "No such space", `There is no space called ${name}, so this link leads nowhere. Nothing was joined.`,
        [["/me", "Your key"]], true), 404);
    }
    return refused(h, viewer, profile);
  }
  if (profile.data.unavailable) return withheldPage(shell, name);
  if (looked && !looked.ok) {
    if (classifyRefusal(looked.code, looked.status) === "credential") return refused(h, viewer, looked);
    if (looked.code === "INVITE_INVALID") {
      return page(resultHtml(shell, "Not a link for this space",
        `This link is not one for ${name}: it may be mistyped, or made for another space. Nothing was joined. Ask whoever gave it to you for a fresh one.`,
        [[`/me/spaces/${name}`, "The space's own page"], ["/me", "Your key"]], true), 404);
    }
  }
  const space = shownSpace(profile.data);
  // During a restore the service looks at no link and takes no join, and the page says so.
  const notLooked = looked === null ? "elsewhere" : !looked.ok && looked.code === "SERVICE_READ_ONLY" ? "repairing" : null;
  return html(joinLinkHtml(shell, viewer, space, kind, code, looked?.ok ? readableLook(looked.data, kind) : null, notLooked));
}

/** What POST /v1/invites/look answered, each field held to its shape, or null when it is
 *  not an answer about a link of this kind: the page then says the service did not say. */
function readableLook(raw: unknown, kind: LinkKind): LinkLook | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const count = (n: unknown, from: number): n is number => Number.isSafeInteger(n) && (n as number) >= from;
  if ((r.kind === "hand_over" ? "hand-over" : r.kind === "invite" ? "invite" : null) !== kind) return null;
  if (typeof r.role !== "string" || !/^[a-z]{1,16}$/.test(r.role) || !count(r.uses, 0)) return null;
  if (r.max_uses !== null && !count(r.max_uses, 1)) return null;
  if (r.expires_at !== null && (typeof r.expires_at !== "string" || !ISO_TIME.test(r.expires_at))) return null;
  return {
    kind,
    role: r.role,
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string" && /^[a-z0-9][a-z0-9_.-]{0,31}$/.test(t)).slice(0, 8) : [],
    max_uses: r.max_uses as number | null,
    uses: r.uses,
    expires_at: r.expires_at as string | null,
    state: typeof r.state === "string" ? r.state : "",
    made_by: typeof r.made_by === "string" && KEY_ID.test(r.made_by) ? r.made_by : null,
  };
}

// ------------------------------------------------------------------ acting

async function act(h: Here, session: Session, viewer: Viewer, path: string, form: URLSearchParams, files: File[] = []): Promise<Response> {
  if (path.startsWith("/me/messages/")) {
    const out = await actOnMessages(contextOf(h, session, viewer), path, form);
    if (out) return out;
  }
  if (path === "/me/new") return newSpace(h, session, viewer, form);
  if (path === "/me/encryption-key") return turnOnSealing(h, session, viewer, form);
  if (path === "/me/connect") return actOnConnect(contextOf(h, session, viewer), form);
  if (path === "/me/tokens/new") return makeToken(h, session, viewer, form);
  if (path === "/me/tokens/revoke") {
    // One token, by the id the product lists it under: how a person disconnects one
    // app, or one agent, and nothing else.
    const id = form.get("id") ?? "";
    if (!HEX32.test(id)) return badForm(viewer);
    const res = await apiWrite(session, "DELETE", `/v1/tokens/${id}`, undefined);
    if (!res.ok) return refused(h, viewer, res, undefined, [["/me/tokens", "Access tokens"]]);
    return see("/me/tokens?notice=token-revoked");
  }
  if (path === "/me/tokens/revoke-all") {
    const res = await apiWrite(session, "DELETE", "/v1/tokens", undefined);
    if (!res.ok && classifyRefusal(res.code, res.status) !== "credential") return refused(h, viewer, res);
    destroySessionsOf(session.peerId);
    return sessionEnded(h, "/sign-in");
  }

  const inSpace = path.match(ACTING);
  if (inSpace) return spaceAction(h, session, viewer, inSpace[1]!, inSpace[2]!, form, files);

  const onRequest = path.match(/^\/me\/requests\/([0-9a-f-]{36})\/(approve|decline|withdraw)$/);
  if (onRequest && UUID.test(onRequest[1]!)) {
    const space = form.get("space") ?? "";
    if (!SPACE_NAME.test(space)) return badForm(viewer);
    const [id, decision] = [onRequest[1]!, onRequest[2]!];
    let body: Record<string, unknown> = {};
    if (decision === "approve") {
      // The role, and the tags the new member carries, as a member's own row sets them.
      const tags = words(form.get("tags"));
      const over = tooMany("tags", tags.length, itemLimits(await capabilities()).tags);
      if (over) return page(resultHtml(formShell("Not approved", viewer), "Not approved", over, [[`/me/spaces/${space}/requests`, "Back to the join requests"]], true), 400);
      body = { role: pick(form.get("role"), MEMBER_ROLES, "writer"), ...(tags.length ? { tags } : {}) };
    }
    const res = await apiWrite(session, "POST", `/v1/requests/${id}/${decision}`, body);
    if (!res.ok) return refused(h, viewer, res, space);
    if (decision === "withdraw") return see(`/me/spaces/${space}?notice=withdrawn`);
    return see(`/me/spaces/${space}/requests?notice=${decision === "approve" ? "approved" : "declined"}`);
  }

  const onInvite = path.match(/^\/me\/invites\/([0-9a-f-]{36})\/(revoke|remove)$/);
  if (onInvite && UUID.test(onInvite[1]!)) {
    const space = form.get("space") ?? "";
    if (!SPACE_NAME.test(space)) return badForm(viewer);
    const links: [string, string][] = [[`/me/spaces/${space}/invites`, "Back to the links"], ["/me", "Your key"]];
    if (onInvite[2] === "revoke") {
      const res = await apiWrite(session, "DELETE", `/v1/invites/${onInvite[1]}`, undefined);
      if (!res.ok) return refused(h, viewer, res, space, links);
      return see(`/me/spaces/${space}/invites?notice=revoked`);
    }
    // REVOKE AND REMOVE, a batch at a time. How many went and how many remain are the
    // service's numbers, so they are said in the POST's own answer, with Continue while
    // any remain: an address that named them would be one anybody could send, saying
    // anything.
    const res = await apiWrite<{ removed?: unknown; remaining?: unknown }>(session, "POST", `/v1/invites/${onInvite[1]}/remove`, {});
    if (!res.ok) return refused(h, viewer, res, space, links);
    const count = (n: unknown) => (Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : 0);
    return html(removalHtml(formShell(`Revoke and remove — ${space}`, viewer), viewer, space, onInvite[1]!, count(res.data.removed), count(res.data.remaining)));
  }

  // A role offered to this key: accepted, which makes it that role and the key that
  // offered it leaves, or declined, which ends the offer.
  const onOffer = path.match(/^\/me\/hand-overs\/([0-9a-f-]{36})\/(accept|decline)$/);
  if (onOffer && UUID.test(onOffer[1]!)) {
    const space = form.get("space") ?? "";
    if (!SPACE_NAME.test(space)) return badForm(viewer);
    const back = form.get("back") === "space" ? `/me/spaces/${space}` : "/me/mailbox";
    const res = await apiWrite<{ changed?: unknown }>(session, "POST", `/v1/hand-overs/${onOffer[1]}/${onOffer[2]}`, {});
    if (!res.ok) return refused(h, viewer, res, space, [[back, back === "/me/mailbox" ? "Your mailbox" : "Back to the space"], ["/me", "Your key"]]);
    if (onOffer[2] === "decline") return see(withNotice(back, "offer-declined"));
    return see(withNotice(`/me/spaces/${space}`, res.data.changed === false ? "unchanged" : "taken-over"));
  }

  return nothingHere(viewer, "action");
}

/** A role as the service names one, or null when the value is in no such shape. */
const roleIn = (value: unknown): string | null => (typeof value === "string" && /^[a-z]{1,16}$/.test(value) ? value : null);

/** When a link just made stops working, as the service answered, or as it was asked when
 *  the answer is in no shape to show. Null is never. */
function madeUntil(value: unknown, seconds: number | null): string | null {
  if (value === null) return null;
  if (typeof value === "string" && ISO_TIME.test(value)) return value;
  return seconds === null ? null : new Date(Date.now() + seconds * 1000).toISOString();
}

/** A link the service made and answered with in no shape this site can show: a credential
 *  nobody holds, so it is revoked again, as a link a message could not carry is. */
async function unreadableLink(session: Session, viewer: Viewer, name: string, inviteId: string | undefined): Promise<Response> {
  const detail = await revokeUnheld(session, inviteId)
    ? "The service made a link but answered in a way this site cannot read, so this site revoked it again. Make another."
    : "The service made a link but answered in a way this site cannot read, and this site could not revoke it. Revoke the newest link on this page and make another.";
  return page(resultHtml(formShell("Not shown", viewer), "Not shown", detail, [[`/me/spaces/${name}/invites`, "The links"]], true), 502);
}

/** How long a link works, as a form sent it: seconds, null for never, or why not. */
function lifetimeOf(form: URLSearchParams, maxSeconds: number | null): { ok: true; seconds: number | null } | { ok: false; why: string } {
  if (form.get("lifetime") === "never") return { ok: true, seconds: null };
  const days = Number(form.get("expires_in_days") ?? "");
  if (!Number.isSafeInteger(days) || days < 1) return { ok: false, why: "How long it works is a whole number of days from 1, or never. Nothing was made." };
  if (maxSeconds !== null && days * 86400 > maxSeconds) {
    return { ok: false, why: `A link works at most ${Math.floor(maxSeconds / 86400).toLocaleString("en-US")} days. Nothing was made.` };
  }
  return { ok: true, seconds: days * 86400 };
}

/** The three category fields of a form, as typed. */
const categoryFields = (form: URLSearchParams): string[] =>
  ["category_1", "category_2", "category_3"].map((f) => (form.get(f) ?? "").slice(0, 120));

/** Whether the categories typed leave a space's filing as it was: all three empty, or
 *  the ones the form showed, which it sends back in `categories_were`. */
const categoriesUnchanged = (typed: string[], form: URLSearchParams): boolean =>
  typed.every((t) => t.trim() === "") || typed.map(normalName).filter(Boolean).join(",") === form.get("categories_were");

/** Whether the service takes posts from any key in a public work space, as its capability
 *  document's join policies say: the forms offer that choice only then. */
const takesOpen = (caps: { join_policies?: unknown }): boolean =>
  Array.isArray(caps.join_policies) && caps.join_policies.includes("open");

/** The ways in a form may send, which the service decides between; anything else is none. */
const JOIN_POLICIES = ["request", "invite", "open"];

async function newSpace(h: Here, session: Session, viewer: Viewer, form: URLSearchParams): Promise<Response> {
  const values: NewSpaceValues = {
    name: (form.get("name") ?? "").trim().slice(0, 63),
    title: (form.get("title") ?? "").slice(0, 2048),
    description: (form.get("description") ?? "").slice(0, 16384),
    visibility: pick(form.get("visibility"), ["private", "public", "sealed"], "private"),
    join_policy: pick(form.get("join_policy"), JOIN_POLICIES, "request"),
    signed_only: form.get("signed_only") === "1",
    categories: categoryFields(form),
    oracle: form.get("oracle") === "1",
  };
  const [reg, host, caps] = await Promise.all([register(), sealingHost(viewer), capabilities()]);
  const again = (why: string, status: number) =>
    page(newSpaceHtml(formShell("Create a space", viewer), viewer, values, why, reg, host, takesOpen(caps)), status);
  // Taking posts from any key is for a public work space alone, as the service holds it:
  // chosen with anything else, the form comes back as it was typed, before the oracle
  // choice makes the space public or a sealed one is made to take join requests, either
  // of which would have changed quietly what was asked for.
  if (values.join_policy === "open" && (values.oracle || values.visibility !== "public")) return again(OPEN_ONLY_PUBLIC_WORK, 400);
  // An oracle space is public, whatever the radio said: the form says so beside it.
  if (values.oracle) values.visibility = "public";
  // A new space is filed under what it names, by the service's rules, which are checked
  // here first so a person hears why in a sentence before anything is sent. A public or
  // oracle space must name one; a private or sealed space may name none, and then sends
  // no categories at all.
  const filing = resolveFiling(reg, values.categories);
  if (!filing.ok) return again(filing.why, 400);
  if (filing.ids.length === 0 && categoriesRequired(values)) return again("Choose the category the space is mostly about: it is the space's main one.", 400);
  const { signed_only: signedOnly, categories: _typed, oracle, ...text } = values;
  // A sealed space's first key, made in the person's browser by src/sealed-page.js: its
  // id, generation 1's commitment and their own lock. A sealed space admits by join
  // request alone.
  let sealedFirst: Record<string, string> | null = null;
  if (values.visibility === "sealed") {
    const spaceId = form.get("sealed_space_id") ?? "";
    const commitment = form.get("sealed_commitment") ?? "";
    const lock = form.get("sealed_lock") ?? "";
    if (!UUID.test(spaceId) || !HEX32.test(commitment) || !/^[0-9a-f]{160}$/.test(lock)) {
      return again("A sealed space's first key is made in your browser, with this page's script and your encryption key. Turn sealing on from your key's page first, and keep the page's script running. Nothing was made.", 400);
    }
    sealedFirst = { space_id: spaceId, commitment, lock };
    text.join_policy = "request";
  }
  const res = await apiWrite<{ name?: string }>(session, "POST", "/v1/spaces", {
    ...filled(text), signed_only: signedOnly, ...(filing.ids.length ? { categories: filing.ids } : {}), ...(oracle ? { oracle: true } : {}),
    ...(sealedFirst ? { sealed: sealedFirst } : {}),
  });
  if (!res.ok) {
    if (classifyRefusal(res.code, res.status) === "credential") return refused(h, viewer, res);
    return again(refusalText(res), statusFor(res));
  }
  return see(`/me/spaces/${values.name}?notice=created`);
}

/**
 * Turning sealing on: the statement the person's browser made from their passkey's
 * secret, and their passkey's signature over it, passed to the product, which checks
 * both before it keeps the key for life.
 */
async function turnOnSealing(h: Here, session: Session, viewer: Viewer, form: URLSearchParams): Promise<Response> {
  const statement = sealedPart(form.get("statement"), 700);
  const signed = passkeyFields(form);
  if (!statement || !signed) return badForm(viewer, "That was not what this page sends to turn sealing on, so nothing was changed. Reload the page and try again.");
  const res = await apiWrite(session, "PUT", "/v1/me/encryption-key", { statement, alg: "webauthn", ...signed });
  if (!res.ok) return refused(h, viewer, res);
  return see("/me?notice=sealing-on");
}

/** The keepers' page's four forms: a signed keeper list, locks for members waiting, a join
 *  request admitted with its lock, and a change of key. All four are passed on unread. */
async function keeperAction(h: Here, session: Session, viewer: Viewer, name: string, what: string, form: URLSearchParams): Promise<Response> {
  const keepers = `/me/spaces/${name}/keepers`;
  const back: [string, string][] = [[keepers, "Its key and keepers"], [`/me/spaces/${name}`, "Back to the space"]];
  const shaped = "That was not what this page sends, so nothing was changed. Reload the page and try again.";
  switch (what) {
    case "keepers": {
      const list = sealedPart(form.get("sealed_list"), 11_000);
      const signed = passkeyFields(form);
      if (!list || !signed) return badForm(viewer, shaped);
      const res = await apiWrite(session, "PUT", `/v1/spaces/${name}/sealed/keepers`, { list, alg: "webauthn", ...signed });
      if (!res.ok) return refused(h, viewer, res, name, back);
      return see(`${keepers}?notice=keepers-signed`);
    }
    case "locks": {
      const locks = readLocks(form.get("sealed_locks"));
      const commitments = readCommitments(form.get("sealed_commitments"));
      if (!locks || locks.size === 0 || !commitments) return badForm(viewer, shaped);
      const res = await handLocks(session, name, locks, commitments);
      if (!res.ok) return refused(h, viewer, res, name, back);
      return see(`${keepers}?notice=key-handed`);
    }
    case "admit":
    case "vouch": {
      // Admitting by hand, or vouching for a member nobody vouched for: the stamp this
      // person's passkey signed, put for the KEY, then its locks. A keeper hands the key
      // only to a KEY somebody the owner trusts vouched for, and here that is this keeper.
      const id = what === "admit" ? requestIdOf(form) : null;
      const stamp = sealedPart(form.get("sealed_stamp"), 1400);
      const signed = passkeyFields(form);
      const locks = readLocks(form.get("sealed_locks"));
      const commitments = readCommitments(form.get("sealed_commitments"));
      if ((what === "admit" && !id) || !stamp || !signed || !locks || locks.size === 0 || !commitments) return badForm(viewer, shaped);
      if (id) {
        const role = pick(form.get("role"), MEMBER_ROLES, "writer");
        const approved = await apiWrite(session, "POST", `/v1/requests/${id}/approve`, { role });
        if (!approved.ok) return refused(h, viewer, approved, name, back);
      }
      const stamped = await apiWrite(session, "PUT", `/v1/spaces/${name}/sealed/stamp`, { stamp, alg: "webauthn", ...signed });
      if (!stamped.ok) return refused(h, viewer, stamped, name, back);
      const res = await handLocks(session, name, locks, commitments);
      if (!res.ok) return refused(h, viewer, res, name, back);
      return see(`${keepers}?notice=${what === "admit" ? "admitted" : "vouched"}`);
    }
    case "finish": {
      const g = form.get("sealed_generation") ?? "";
      const locks = readLocks(form.get("sealed_locks"));
      const commitments = readCommitments(form.get("sealed_commitments"));
      if (!GENERATION.test(g) || !locks || !commitments) return badForm(viewer, shaped);
      const changed = await handAndActivate(session, name, g, locks, commitments);
      if (!changed.ok) return refused(h, viewer, changed, name, back);
      return see(`${keepers}?notice=key-changed`);
    }
    case "abandon": {
      const g = form.get("sealed_generation") ?? "";
      if (!GENERATION.test(g)) return badForm(viewer, shaped);
      const res = await apiWrite(session, "DELETE", `/v1/spaces/${name}/sealed/generations/${g}`, undefined);
      if (!res.ok) return refused(h, viewer, res, name, back);
      return see(`${keepers}?notice=change-abandoned`);
    }
    case "change": {
      const g = form.get("sealed_generation") ?? "";
      const commitment = form.get("sealed_commitment") ?? "";
      const backLink = form.get("sealed_back") ?? "";
      const locks = readLocks(form.get("sealed_locks"));
      if (!GENERATION.test(g) || !HEX32.test(commitment) || !(backLink === "" || /^[0-9a-f]{96}$/.test(backLink)) || !locks) {
        return badForm(viewer, shaped);
      }
      const staged = await apiWrite(session, "POST", `/v1/spaces/${name}/sealed/generations`, {
        generation: g, commitment, ...(backLink ? { back: backLink } : {}),
      });
      if (!staged.ok) return refused(h, viewer, staged, name, back);
      const changed = await handAndActivate(session, name, g, locks, new Map([[g, commitment]]));
      if (!changed.ok) return refused(h, viewer, changed, name, back);
      return see(`${keepers}?notice=key-changed`);
    }
    default:
      return nothingHere(viewer, "page");
  }
}

/** Each file to the space it will be attached in, one at a time, stopping at the first the
 *  service refuses, which is returned; null when every file is there. An upload that is
 *  sent again after a lost answer is answered the same, so a form pressed twice is safe. */
async function uploadFiles(session: Session, name: string, files: PreparedFile[]): Promise<Refusal | null> {
  for (const f of files) {
    const res = await apiUpload(session, name, f.sha256, f.bytes);
    if (!res.ok) return res;
  }
  return null;
}

/** The hashes a signed post's object names as files: the `sha256.file` fingerprints in the
 *  canonical bytes its passkey signed. Empty for anything that is not such an object. */
function signedFingerprints(canonical: string | null): Set<string> {
  try {
    const object: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob((canonical ?? "").replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
    const prints = object !== null && typeof object === "object" ? (object as { fingerprints?: unknown }).fingerprints : undefined;
    return new Set(Array.isArray(prints)
      ? prints.flatMap((f: unknown) => (f && typeof f === "object" && (f as { scheme?: unknown }).scheme === "sha256.file" && typeof (f as { value?: unknown }).value === "string" ? [(f as { value: string }).value] : []))
      : []);
  } catch {
    return new Set();
  }
}

/** Where a post sent from a form goes next: a proposal, a decision on one and an undo
 *  land on the history, which says what became of them; any other post on its own page. */
function afterPost(spaceHref: string, posted: Posted, form: URLSearchParams, base: "posted" | "posted-signed"): Response {
  if (form.get("then") === "history") return see(`${spaceHref}/history?notice=${oracleNotice(posted)}`);
  // Keys it was sent to that were not told in their mailbox, because notices to them are
  // spent for now: the post is written and they read it in the space, and the page says so.
  const notice = Array.isArray(posted.not_notified) && posted.not_notified.length > 0 ? `${base}-not-told` : base;
  return see(posted.seq && POST_SEQ.test(posted.seq) ? `${spaceHref}/${posted.seq}?notice=${notice}` : `${spaceHref}?notice=${notice}`);
}

/** The reviewer switch, sent only by an oracle space's settings, which alone show it. */
const reviewerSetting = (form: URLSearchParams): { service_reviewer?: boolean } =>
  form.get("reviewer_shown") === "1" ? { service_reviewer: form.get("service_reviewer") === "1" } : {};

async function spaceAction(
  h: Here, session: Session, viewer: Viewer, name: string, what: string, form: URLSearchParams, files: File[] = [],
): Promise<Response> {
  const spaceHref = `/me/spaces/${name}`;
  switch (what) {
    case "keepers":
    case "locks":
    case "admit":
    case "vouch":
    case "change":
    case "finish":
    case "abandon":
      return keeperAction(h, session, viewer, name, what, form);
    case "posts": {
      // A SEALED POST, sealed in the browser by src/sealed-page.js: its header and its
      // ciphertext, and nothing the person typed, which had no named field to be sent in.
      // Signed, it carries the object the passkey signed as well, which commits to both.
      if (form.get("sealed_header") || form.get("sealed_ciphertext")) {
        if (files.length) return badForm(viewer, "A sealed space takes no files, so nothing was posted.");
        const header = sealedPart(form.get("sealed_header"), 2800);
        const ciphertext = sealedPart(form.get("sealed_ciphertext"), 245_760);
        if (!header || !ciphertext) return badForm(viewer, "That sealed post was not in the shape this page seals one, so nothing was posted. Reload the page and try again.");
        const sealedParts = { header, ciphertext };
        let body: Record<string, unknown>;
        if (form.get("sig_canonical")) {
          const signed = signedPost(form);
          if (!signed) return badForm(viewer, "The signature on that post was not in the shape a passkey prompt writes, so nothing was posted. Reload the page and try again.");
          body = { ...signed, sealed: sealedParts };
        } else {
          const idem = idempotencyOf(form);
          body = { sealed: sealedParts, ...(idem ? { idempotency_key: idem } : {}) };
        }
        const res = await apiWrite<Posted>(session, "POST", `/v1/spaces/${name}/posts`, body);
        if (!res.ok) return refused(h, viewer, res, name);
        return afterPost(spaceHref, res.data, form, form.get("sig_canonical") ? "posted-signed" : "posted");
      }
      // A POST THE PERSON'S PASSKEY SIGNED, in the browser, by src/sign-post.js. Its
      // content is the canonical object and nothing else: the product derives every
      // field from those bytes and refuses a signed post that carries a field beside
      // them, so the form's own fields are not sent at all.
      if (form.get("sig_canonical")) {
        const signed = signedPost(form);
        if (!signed) {
          return page(resultHtml(formShell("Not posted", viewer), "Not posted",
            "The signature on that post was not in the shape a passkey prompt writes, so nothing was posted. Reload the page and try again.",
            [[spaceHref, "Back to the space"]], true), 400);
        }
        // The files a signed post names: each one's hash must be a sha256.file fingerprint
        // in the object the passkey signed, which the page's script put there from the file
        // chosen, so a file that is not in it would be refused by the service after it was
        // sent. They are checked here, then uploaded, then named beside the signed bytes.
        const body: Record<string, unknown> = signed;
        if (files.length) {
          const caps = await capabilities();
          const notPostedWhy = (why: string): Response =>
            page(resultHtml(formShell("Not posted", viewer), "Not posted", why, [[spaceHref, "Back to the space"]], true), 400);
          const rules = attachmentLimits(caps);
          if (!rules) return notPostedWhy("The service takes no files right now, so nothing was posted. Post it again without them, or try again later.");
          const made = await prepareFiles(files, rules);
          if (!made.ok) return notPostedWhy(`${made.why} Reload the page and try again.`);
          const covered = signedFingerprints(form.get("sig_canonical"));
          if (made.files.some((f) => !covered.has(f.sha256))) {
            return notPostedWhy("A file you chose is not one your passkey signed for, so nothing was posted. Reload the page, choose the files again and press Post.");
          }
          const up = await uploadFiles(session, name, made.files);
          if (up) return refused(h, viewer, up, name, undefined, fileRefusalWords(up, caps));
          body.attachments = attachmentsOf(made.files);
        }
        const res = await apiWrite<Posted>(session, "POST", `/v1/spaces/${name}/posts`, body);
        if (!res.ok) return refused(h, viewer, res, name, undefined, (files.length ? fileRefusalWords(res, await capabilities()) : undefined) ?? await postRefusalWords(res, form));
        return afterPost(spaceHref, res.data, form, "posted-signed");
      }
      const body: Record<string, unknown> = {
        kind: (form.get("kind") ?? "").trim(),
        body: form.get("body") ?? "",
      };
      const title = (form.get("title") ?? "").trim();
      if (title) body.title = title;
      const hidden: Record<string, string> = {};
      for (const field of ["reply_to", "supersedes", "retracts"] as const) {
        const id = form.get(field);
        if (id) {
          if (!UUID.test(id)) return badForm(viewer);
          body[field] = id;
          hidden[field] = id;
        }
      }
      if (form.get("then") === "history") hidden.then = "history";
      const idem = idempotencyOf(form);
      if (idem) body.idempotency_key = idem;
      const typedData = (form.get("data") ?? "").trim();
      const typedBudget = (form.get("budget") ?? "").trim();
      const typedRun = (form.get("run_id") ?? "").trim();

      // WHAT IS REFUSED HERE COMES BACK AS IT WAS TYPED, under the sentence that says
      // why, and nothing is sent: nothing typed is cut off without a word.
      const caps = await capabilities();
      const notPosted = (why: string): Response => {
        const typed: PostValues = {
          kind: String(body.kind), title: form.get("title") ?? "", summary: form.get("summary") ?? "", body: String(body.body),
          fingerprints: form.get("fingerprints") ?? "", to: form.get("to") ?? "", idempotencyKey: idem, hidden,
          data: typedData, budget: typedBudget, runId: typedRun,
        };
        const kinds = Object.values(kindGroups(caps)).flat().filter((k) => k !== "version" || typed.kind === "version");
        return page(postAgainHtml(formShell("Not posted", viewer), viewer, name, kinds, typed, why, files.length ? attachmentLimits(caps) : null), 400);
      };
      // A title, where the service needs one, before anything else is read: it says which
      // kinds need none, and a service that does not say is not asked to be checked.
      const noTitle = titleProblem(String(body.kind), title, kindsWithoutTitle(caps));
      if (noTitle) return notPosted(`${noTitle} Nothing was posted.`);
      // A summary only where the service states how long one may be: a form offers the field
      // on no other terms, and a service that does not state it is sent none, since it would
      // drop it or refuse it.
      const summaryMax = summaryLimit(caps);
      const summary = summaryMax === null ? "" : (form.get("summary") ?? "").trim();
      const summaryTooLong = summaryProblem(summary, summaryMax);
      if (summaryTooLong) return notPosted(`${summaryTooLong} Nothing was posted.`);
      if (summary) body.summary = summary;
      const limits = itemLimits(caps);
      const fingerprints = lines(form.get("fingerprints")).map((line) => {
        const at = line.indexOf(":");
        return at > 0 ? { scheme: line.slice(0, at).trim(), value: line.slice(at + 1).trim() } : null;
      });
      if (fingerprints.some((f) => f === null)) {
        return notPosted("A fingerprint is written scheme:value, such as git.commit:3f9a2c1e, one on each line. Nothing was posted.");
      }
      // The same fingerprint twice is one, as the service keeps it and a signed post names it.
      const distinct = [...new Map(fingerprints.map((f) => [JSON.stringify([f!.scheme, f!.value]), f!])).values()];
      // The files, held to the service's own limits and hashed before anything is sent: the
      // service adds each file's hash to the post's fingerprints, and counts them in the 32.
      let prepared: PreparedFile[] = [];
      if (files.length) {
        const rules = attachmentLimits(caps);
        if (!rules) return notPosted("The service takes no files right now, so nothing was posted. Send the post without them, or try again later.");
        const made = await prepareFiles(files, rules);
        if (!made.ok) return notPosted(`${made.why} The files you chose are not kept: choose them again.`);
        prepared = made.files;
      }
      const named = new Set(distinct.map((f) => JSON.stringify([f!.scheme, f!.value])));
      for (const f of prepared) named.add(JSON.stringify(["sha256.file", f.sha256]));
      const printsOver = tooMany("fingerprints", named.size, limits.fingerprints);
      if (printsOver) return notPosted(prepared.length ? printsOver.replace("fingerprints, and", "fingerprints, each file's hash among them, and") : printsOver);
      if (distinct.length) body.fingerprints = distinct;
      const to = [...new Set(lines(form.get("to")))];
      if (to.some((id) => !KEY_ID.test(id))) {
        return notPosted("Each line under Send it to must be a key id: 64 characters of 0 to 9 and a to f. Nothing was posted.");
      }
      const keysOver = tooMany("recipients", to.length, limits.recipients);
      if (keysOver) return notPosted(keysOver);
      if (to.length) body.to = to;
      // Data, a budget and a run id, read and checked by the product's own rules before
      // anything is sent, with src/post-object.js as the browser reads them, so a refusal
      // shows the form again as it was typed and the two never disagree.
      const data = parseTyped(typedData, "the data");
      if (data.problem) return notPosted(`${data.problem} Nothing was posted.`);
      const budget = parseTyped(typedBudget, "the budget");
      if (budget.problem) return notPosted(`${budget.problem} Nothing was posted.`);
      const why = privateProblem({ data: data.value, budget: budget.value, runId: typedRun || undefined });
      if (why) return notPosted(`${why} Nothing was posted.`);
      if (data.value !== undefined) body.data = data.value;
      if (budget.value !== undefined) body.budget = budget.value;
      if (typedRun) body.run_id = typedRun;
      // Ticked to be signed, and no signature came with it: the page's script did not run,
      // so the post is shown again rather than published unsigned for good. "Send it
      // without a signature" unticks the box, and the form this answer draws has none.
      if (form.get("sign") === "1") {
        return notPosted("This post was to be signed with your passkey, and no signature came with it, because the page's script did not run. Nothing was posted. Send it from here unsigned, or post it again from the space's page to sign it.");
      }

      // The files go first, each to this space at the address of its hash, and then the post
      // names them: the service adds their hashes to its fingerprints. A refusal of a file
      // shows the form again as typed, as the checks above do.
      if (prepared.length) {
        const up = await uploadFiles(session, name, prepared);
        if (up) {
          const said = fileRefusalWords(up, caps);
          return said && classifyRefusal(up.code, up.status) !== "credential" ? notPosted(said) : refused(h, viewer, up, name, undefined, said);
        }
        body.attachments = attachmentsOf(prepared);
      }
      const res = await apiWrite<Posted>(session, "POST", `/v1/spaces/${name}/posts`, body);
      if (!res.ok) return refused(h, viewer, res, name, undefined, (prepared.length ? fileRefusalWords(res, caps) : undefined) ?? await postRefusalWords(res, form));
      return afterPost(spaceHref, res.data, form, "posted");
    }
    case "stamp": {
      // A stamp another key's software printed for this key, put before it asks to join a
      // sealed space. Passed on as it was printed, checked only for its shape: the service
      // reads it and checks its signature, and a keeper reads it before letting the key in.
      let stamp: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse((form.get("stamp") ?? "").trim());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stamp = parsed as Record<string, unknown>;
      } catch {
        stamp = null;
      }
      const fields = ["stamp", "alg", "signature", "credential_id", "client_data_json", "authenticator_data"];
      if (!stamp || typeof stamp.stamp !== "string" || typeof stamp.alg !== "string" || typeof stamp.signature !== "string" ||
          Object.entries(stamp).some(([k, v]) => !fields.includes(k) || typeof v !== "string" || v.length > 6000)) {
        return badForm(viewer, `A stamp is the one line its maker's software printed, such as {"stamp":"…","alg":"ed25519","signature":"…"}. Nothing was put.`);
      }
      const res = await apiWrite(session, "PUT", `/v1/spaces/${name}/sealed/stamp`, stamp);
      if (!res.ok) return refused(h, viewer, res, name);
      return see(`${spaceHref}?notice=stamp-put`);
    }
    case "join": {
      // An invite code, a hand-over code, or an invite link carrying either, as the box
      // on a space's page and the button an invite link leads to send them: only the
      // code goes on. Anything else is refused here, before the service is asked and
      // a failed try is counted against this key's allowance for codes.
      const typed = (form.get("code") ?? "").trim();
      let payload: Record<string, unknown>;
      let handOver = false;
      if (typed) {
        const found = joinCodeOf(typed, name, [`https://${CANONICAL_HOST}`, h.url.origin]);
        if (!found.ok) {
          return page(resultHtml(formShell("Not joined", viewer), "Not joined", found.why, [[spaceHref, "Back to the space"]], true), 400);
        }
        payload = { code: found.code };
        handOver = HAND_OVER_CODE.test(found.code);
      } else {
        payload = filled({ message: (form.get("message") ?? "").trim() });
      }
      const res = await apiWrite<{ state?: string; request_id?: string; changed?: unknown }>(session, "POST", `/v1/spaces/${name}/join`, payload);
      if (!res.ok) return refused(h, viewer, res, name);
      if (res.data.state === "pending") return see(`${spaceHref}?notice=asked`);
      // A work space any key posts in has nothing to join: the service made nobody a
      // member, and the page says so above its post form.
      if (res.data.state === "open") return see(`${spaceHref}?notice=no-joining`);
      // A key already at the link's role or above uses nothing, and is told so.
      if (payload.code && res.data.changed === false) return see(`${spaceHref}?notice=unchanged`);
      return see(`${spaceHref}?notice=${handOver ? "taken-over" : "joined"}`);
    }
    case "hand-over": {
      // Your role passed to one successor: by a link that works once, shown once in this
      // answer, or as an offer to one key, which reaches its mailbox to accept. You leave
      // when the successor takes it. An owner's role is the whole space.
      // A label either way, for its maker's own list; and how long it lasts, an offer's
      // too, rather than the service's default unasked.
      const label = (form.get("label") ?? "").trim();
      const labelled = label ? { label } : {};
      const rules = linkRules(await capabilities());
      if (form.get("how") === "offer") {
        const to = (form.get("to") ?? "").trim();
        if (!KEY_ID.test(to)) return badForm(viewer, "A key id is 64 characters of 0 to 9 and a to f. Nothing was offered.");
        if (to === session.peerId) return badForm(viewer, "That is your own key: your role is yours already. Nothing was offered.");
        const life = form.get("lifetime") === null ? null : lifetimeOf(form, rules?.maxSeconds ?? null);
        if (life && !life.ok) return page(resultHtml(formShell("Not offered", viewer), "Not offered", life.why.replace("Nothing was made.", "Nothing was offered."), [[spaceHref, "Back to the space"]], true), 400);
        const res = await apiWrite(session, "POST", `/v1/spaces/${name}/hand-over`, {
          to, ...(life ? { expires_in_seconds: life.seconds } : {}), ...labelled,
        });
        if (!res.ok) {
          // An offer reaches only a key that knows its maker; the way on is a hand-over
          // link, which the maker gives its successor itself, except in a sealed space,
          // which takes none: there the successor is let in first.
          if (res.code === "HAND_OVER_UNREACHABLE" && form.get("sealed") === "1") {
            return refused(h, viewer, res, name, [[spaceHref, "Back to the space"]],
              "An offer reaches only a key that knows you, one you share a space or a conversation with, and that does not block you. Nothing was offered. A sealed space takes no hand-over link: let the key in first, then offer it your role.");
          }
          const instead: [string, string][] = [[`${spaceHref}#hand-over`, "Make a hand-over link instead"], [spaceHref, "Back to the space"]];
          return refused(h, viewer, res, name, res.code === "HAND_OVER_UNREACHABLE" ? instead : undefined);
        }
        return see(`${spaceHref}?notice=offer-made`);
      }
      if (form.get("how") !== "link") return badForm(viewer);
      const life = lifetimeOf(form, rules?.maxSeconds ?? null);
      if (!life.ok) return page(resultHtml(formShell("Not made", viewer), "Not made", life.why, [[spaceHref, "Back to the space"]], true), 400);
      const res = await apiWrite<{ code?: string; link?: unknown; role?: unknown; expires_at?: unknown; invite_id?: string }>(
        session, "POST", `/v1/spaces/${name}/hand-over`, { expires_in_seconds: life.seconds, ...labelled });
      if (!res.ok) return refused(h, viewer, res, name);
      const code = res.data.code ?? "";
      if (!HAND_OVER_CODE.test(code)) return unreadableLink(session, viewer, name, res.data.invite_id);
      return governPage(h, session, viewer, name, "invites", null, {
        kind: "hand_over", link: siteLink(h.url.origin, name, code, res.data.link), code,
        role: roleIn(res.data.role) ?? "", max_uses: 1, expires_at: madeUntil(res.data.expires_at, life.seconds),
      });
    }
    case "leave": {
      const res = await apiWrite(session, "DELETE", `/v1/spaces/${name}/members/${session.peerId}`, undefined);
      if (!res.ok) return refused(h, viewer, res, name);
      return see("/me?notice=left");
    }
    case "settings": {
      // The categories are sent only when they changed: three fields left as the form
      // showed them, which it sends back beside them, or left empty, change nothing, so a
      // space filed under a category that has since been retired can still have its
      // title changed, and saving reads nothing first.
      const typed = categoryFields(form);
      const unchanged = categoriesUnchanged(typed, form);
      let categories: string[] | null = null;
      if (!unchanged) {
        const reg = await register();
        const filing = resolveFiling(reg, typed);
        if (!filing.ok) {
          const profile = await spaceProfile(h, session, name);
          if (!profile.ok) return refused(h, viewer, profile, name);
          // Shown again with everything the owner typed, not what is stored: a title
          // changed beside a mistyped category is still there to send.
          const space: ShownSpace = {
            ...profile.data,
            title: (form.get("title") ?? profile.data.title ?? "").slice(0, 2048),
            description: (form.get("description") ?? profile.data.description ?? "").slice(0, 16384),
            join_policy: pick(form.get("join_policy"), JOIN_POLICIES, profile.data.join_policy),
            signed_only: form.get("signed_only") === "1",
            ...reviewerSetting(form),
          };
          return page(settingsHtml(formShell(`${GOVERNING_PAGES.settings} — ${name}`, viewer), viewer, space, null,
            reg, filing.why, typed, takesOpen(await capabilities())), 400);
        }
        categories = filing.ids;
      }
      const res = await apiWrite(session, "PATCH", `/v1/spaces/${name}`, {
        ...filled({
          title: form.get("title") ?? "",
          description: form.get("description") ?? "",
          // Only the way in the form had ticked, and none when it had none ticked: a
          // setting saved never changes how others join unless the owner chose to.
          join_policy: pick(form.get("join_policy"), JOIN_POLICIES, ""),
        }),
        // A checkbox left clear sends nothing, which here means off.
        signed_only: form.get("signed_only") === "1",
        ...(categories ? { categories } : {}),
        ...reviewerSetting(form),
      });
      if (!res.ok) return refused(h, viewer, res, name);
      return see(`${spaceHref}/settings?notice=updated`);
    }
    case "members": {
      const peer = form.get("peer") ?? "";
      if (!KEY_ID.test(peer)) return badForm(viewer, "A key id is 64 characters of 0 to 9 and a to f. Nothing was changed.");
      // Back to the view Set was pressed on, its role, its key and its page, rather than
      // the first page of everybody.
      const at = membersAtOf(form, { role: "in_role", peer: "find", after: "after" });
      const role = pick(form.get("role"), MEMBER_ROLES, "writer");
      const tags = words(form.get("tags"));
      const over = tooMany("tags", tags.length, itemLimits(await capabilities()).tags);
      if (over) {
        return governPage(h, session, viewer, name, "members", null, null,
          { refusal: over, values: { peer, role, tags: form.get("tags") ?? "" }, at });
      }
      const res = await apiWrite(session, "PUT", `/v1/spaces/${name}/members/${peer}`, { role, tags });
      if (!res.ok) return refused(h, viewer, res, name);
      return see(withNotice(membersHref(name, at), "admitted"));
    }
    case "members/remove": {
      const peer = form.get("peer") ?? "";
      if (!KEY_ID.test(peer) || peer === session.peerId) return badForm(viewer);
      const at = membersAtOf(form, { role: "in_role", peer: "find", after: "after" });
      const res = await apiWrite(session, "DELETE", `/v1/spaces/${name}/members/${peer}`, undefined);
      if (!res.ok) return refused(h, viewer, res, name);
      return see(withNotice(membersHref(name, at), "removed"));
    }
    case "fork": {
      // A new oracle space from this one's current text. What is left as the form showed
      // it is not sent, so the service titles, describes and files it as this one is; the
      // categories go only when they changed, by the rule the settings keep. How others
      // join goes whenever the form says, and a refusal shows the form again as typed.
      const values: ForkValues = {
        name: (form.get("name") ?? "").trim().slice(0, 63),
        title: (form.get("title") ?? "").slice(0, 2048),
        description: (form.get("description") ?? "").slice(0, 16384),
        join_policy: pick(form.get("join_policy"), ["request", "invite"], ""),
        categories: categoryFields(form),
      };
      const reg = await register();
      const again = async (why: string, status: number): Promise<Response> => {
        const profile = await spaceProfile(h, session, name);
        if (!profile.ok) return refused(h, viewer, profile, name);
        if (profile.data.oracle !== true) return page(resultHtml(formShell("Not forked", viewer), "Not forked", why, [[spaceHref, "Back to the space"]], true), status);
        const space = shownSpace(profile.data);
        return page(forkHtml(formShell(`${GOVERNING_PAGES.fork} — ${name}`, viewer), viewer, space, values, reg, why), status);
      };
      if (!SPACE_NAME.test(values.name)) return again("A name is lowercase letters, digits and hyphens, 3 to 63 characters. Nothing was made.", 400);
      const unchanged = categoriesUnchanged(values.categories, form);
      let categories: string[] | null = null;
      if (!unchanged) {
        const filing = resolveFiling(reg, values.categories);
        if (!filing.ok) return again(filing.why, 400);
        categories = filing.ids;
      }
      const res = await apiWrite(session, "POST", `/v1/spaces/${name}/fork`, {
        name: values.name,
        ...filled({ title: values.title.trim(), description: values.description.trim() }),
        ...(values.join_policy ? { join_policy: values.join_policy } : {}),
        ...(categories ? { categories } : {}),
      });
      if (!res.ok) {
        if (classifyRefusal(res.code, res.status) === "credential") return refused(h, viewer, res, name);
        return again(refusalText(res), statusFor(res));
      }
      return see(`/me/spaces/${values.name}?notice=forked`);
    }
    case "hide":
    case "unhide": {
      // A post hidden by the owner or an admin, or shown again: by its id, which the
      // service takes, and its number, which the page it came from has, each in its shape.
      const post = form.get("post") ?? "";
      const seq = form.get("seq") ?? "";
      if (!UUID.test(post) || !POST_SEQ.test(seq)) return badForm(viewer);
      const hide = what === "hide";
      const res = await apiWrite<{ name?: unknown; changed?: unknown }>(session, hide ? "PUT" : "DELETE", `/v1/posts/${post}/hidden`, undefined);
      if (!res.ok) return refused(h, viewer, res, name, [[`${spaceHref}/${seq}`, "Back to the post"], [spaceHref, "Back to the space"]], moderationWords(res, "hide"));
      // The public pages of the space the service names stop showing its words now, not
      // when their copies lapse: only when it says something changed, and only when it
      // names the space this address named, since each forget costs the service reads.
      if (res.data.changed === true && res.data.name === name) forgetSpacePages(h.url.origin, name);
      return see(`${spaceHref}/${seq}?notice=${hide ? "post-hidden" : "post-shown"}`);
    }
    case "block":
    case "unblock": {
      // A key blocked from posting here, or let post again: from a post's page, which sends
      // the post's number to come back to, or from the page of keys blocked here.
      const peer = (form.get("peer") ?? "").trim();
      const seq = form.get("seq") ?? "";
      const blocks = `${spaceHref}/blocks`;
      const back = POST_SEQ.test(seq) ? `${spaceHref}/${seq}` : blocks;
      const block = what === "block";
      if (!KEY_ID.test(peer)) {
        return block && back === blocks
          ? governPage(h, session, viewer, name, "blocks", null, null, { refusal: "A key id is 64 characters of 0 to 9 and a to f. Nothing was changed.", values: { peer } })
          : badForm(viewer, "A key id is 64 characters of 0 to 9 and a to f. Nothing was changed.");
      }
      if (block && peer === session.peerId) return badForm(viewer, "That is your own key, which cannot be blocked from posting. Nothing was changed.");
      const res = await apiWrite(session, block ? "PUT" : "DELETE", `/v1/spaces/${name}/blocks/${peer}`, undefined);
      if (!res.ok) return refused(h, viewer, res, name, [[back, back === blocks ? "Back to the keys blocked here" : "Back to the post"], [spaceHref, "Back to the space"]], moderationWords(res, "block"));
      // A block changes no public page, so nothing held is forgotten.
      return see(`${back}?notice=${block ? "posting-blocked" : "posting-unblocked"}`);
    }
    case "watch": {
      const on = form.get("on") === "1";
      const res = await apiWrite(session, on ? "PUT" : "DELETE", `/v1/spaces/${name}/watch`, undefined);
      if (!res.ok) return refused(h, viewer, res, name);
      return see(`${spaceHref}?notice=${on ? "watching" : "unwatched"}`);
    }
    case "invites": {
      // An invite link: its role, how many keys may use it or no limit, how long it works
      // or never, a label and tags. What a link may be is the service's own document's.
      const typed = Object.fromEntries(
        ["role", "uses", "max_uses", "lifetime", "expires_in_days", "label", "tags"].map((f) => [f, form.get(f) ?? ""]));
      const caps = await capabilities();
      const rules = linkRules(caps);
      const notMade = (refusal: string) => governPage(h, session, viewer, name, "invites", null, null, { refusal, values: typed });
      if (!rules) return notMade("The service is not answering just now, so no link was made. Try again shortly.");
      let maxUses: number | null = null;
      if (form.get("uses") !== "none") {
        const n = Number(form.get("max_uses") ?? "");
        if (!Number.isSafeInteger(n) || n < 1) return notMade("How many keys may use it is a whole number from 1, or no limit. Nothing was made.");
        if (rules.maxUses !== null && n > rules.maxUses) {
          return notMade(`A link lets in at most ${rules.maxUses.toLocaleString("en-US")} keys, or has no limit. Nothing was made.`);
        }
        maxUses = n;
      }
      const life = lifetimeOf(form, rules.maxSeconds);
      if (!life.ok) return notMade(life.why);
      const label = (form.get("label") ?? "").trim();
      const tags = words(form.get("tags"));
      const over = tooMany("tags", tags.length, itemLimits(caps).tags);
      if (over) return notMade(over);
      const role = pick(form.get("role"), rules.roles, rules.defaults.role);
      const res = await apiWrite<{ code?: string; link?: unknown; role?: unknown; max_uses?: unknown; expires_at?: unknown; invite_id?: string }>(
        session, "POST", `/v1/spaces/${name}/invites`, {
          role,
          max_uses: maxUses,
          expires_in_seconds: life.seconds,
          ...(label ? { label } : {}),
          ...(tags.length ? { tags } : {}),
        });
      if (!res.ok) return refused(h, viewer, res, name);
      const code = res.data.code ?? "";
      if (!INVITE_CODE.test(code)) return unreadableLink(session, viewer, name, res.data.invite_id);
      // What the link is, as the service answered, and as it was asked where the answer
      // is in no shape to show.
      return governPage(h, session, viewer, name, "invites", null, {
        kind: "invite", link: siteLink(h.url.origin, name, code, res.data.link), code,
        role: roleIn(res.data.role) ?? role,
        max_uses: res.data.max_uses === null || Number.isSafeInteger(res.data.max_uses) ? res.data.max_uses as number | null : maxUses,
        expires_at: madeUntil(res.data.expires_at, life.seconds),
      });
    }
    default:
      return nothingHere(viewer, "action");
  }
}

// ------------------------------------------------------------------ refusals

/** A refusal from the service, in a person's words. A dead sign-in goes back to
 *  the sign-in page instead of explaining itself. */
function refused(h: Here, viewer: Viewer, res: Refusal, spaceHref?: string, back?: [string, string][], words?: string): Response {
  if (classifyRefusal(res.code, res.status) === "credential") {
    void destroySession(h.request, h.secure);
    return sessionEnded(h, "/sign-in");
  }
  const links: [string, string][] = back ?? (spaceHref ? [[`/me/spaces/${spaceHref}`, "Back to the space"], ["/me", "Your key"]] : [["/me", "Your key"]]);
  return page(resultHtml(formShell("Not done", viewer), "Not done", words ?? refusalText(res), links, true), statusFor(res));
}

/** A post refused because it would have decided a proposal its key may not decide, in
 *  those words rather than the ones for governing a space's members. */
const decisionWords = (res: Refusal, form: URLSearchParams): string | undefined =>
  res.code === "CONTROL_DENIED" && form.get("reply_to") && ["go", "veto"].includes(form.get("kind") ?? "")
    ? "Only the owner, an admin or the service's reviewer approves or declines a proposal, so nothing was posted. A remark on it belongs in the discussion, as another kind of post."
    : undefined;

/** A post refused for how often it came, with the service's own numbers for a key and for
 *  a key with no role, which the refusal alone does not tell apart; the words for a
 *  decision a key may not make; and for a post with no title where its kind needs one,
 *  naming the kinds that need none as the service lists them. */
async function postRefusalWords(res: Refusal, form: URLSearchParams): Promise<string | undefined> {
  if (res.code === "TITLE_REQUIRED") return `${titleWords(kindsWithoutTitle(await capabilities()))} Nothing was posted.`;
  return decisionWords(res, form) ?? (res.code === "RATE_LIMITED" ? postLimitWords(await capabilities()) : undefined);
}

/** Hiding a post or blocking a key, refused, in those words rather than the ones for
 *  governing a space's members; anything else in refusalText's. */
function moderationWords(res: Refusal, what: "hide" | "block"): string | undefined {
  if (res.code === "CONTROL_DENIED") {
    return what === "hide"
      ? "Only the owner or an admin of this space hides a post or shows it again, and only one whose author ranks below them: never the owner's, and never their own. Nothing was changed."
      : "Only the owner or an admin of this space blocks a key from posting, and only a key ranked below them: never the owner, and never their own. Nothing was changed.";
  }
  if (res.code === "PEER_NOT_REGISTERED") return "That key has never registered here, so there is nothing to block. Nothing was changed.";
  return undefined;
}

/** What src/messages.ts, src/export.ts and src/connect.ts need from this file: the
 *  session's reads, and a refusal that can end the session behind a dead token. */
function contextOf(h: Here, session: Session, viewer: Viewer): SignedInContext {
  return {
    url: h.url,
    env: sessionEnv(h.env, session),
    session,
    viewer,
    refused: (res, links) => refused(h, viewer, res, undefined, links),
  };
}

/** An address with nothing at it: no page for a GET, no action for a POST. */
function nothingHere(viewer: Viewer, what: "page" | "action"): Response {
  return page(resultHtml(formShell("Not found", viewer), "Nothing is here",
    what === "page" ? "There is no signed-in page at this address." : "There is no action at this address.",
    [["/me", "Your key"]]), 404);
}

/** On to the next page with the cookie cleared, once the session behind it has ended. */
function sessionEnded(h: Here, location: string): Response {
  const out = see(location);
  out.headers.append("Set-Cookie", clearedCookie(h.secure));
  // And what this site kept in the browser: the encryption key, which the connection's
  // own secret locked and which opens nothing without it now, goes too.
  out.headers.set("Clear-Site-Data", '"storage"');
  return out;
}

// ------------------------------------------------------------------ plumbing

/** The request's own environment, with this session's token added for the one
 *  identity that reads with it. A copy: the server's environment never holds a
 *  person's token. */
function sessionEnv(env: ApiEnv, session: Session): ApiEnv {
  return { ...env, SESSION_TOKEN: session.token };
}

const viewerOf = (s: Session): Viewer => ({
  peerId: s.peerId, csrf: s.csrf, wrap: s.wrap, ...(s.credentialId ? { passkey: s.credentialId } : {}),
});

/** What src/sign-post.js puts in a form once the passkey has signed: each field
 *  unpadded base64url within the bounds the product sets, or nothing at all. The
 *  canonical object may be the product's whole signed_object_bytes, 180 KiB, which is
 *  245,760 characters of base64url. */
const SIGNED_FIELDS = [
  ["sig_canonical", "canonical", 245_760],
  ["sig_credential_id", "credential_id", 1_366],
  ["sig_client_data_json", "client_data_json", 5_462],
  ["sig_authenticator_data", "authenticator_data", 5_462],
  ["sig_signature", "signature", 1_366],
] as const;

function signedPost(form: URLSearchParams): Record<string, string> | null {
  if (form.get("sig_alg") !== "webauthn") return null;
  const out: Record<string, string> = { alg: "webauthn" };
  for (const [field, name, max] of SIGNED_FIELDS) {
    const value = form.get(field) ?? "";
    if (!value || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    out[name] = value;
  }
  // The private part a post with data, a budget or a run id carries, which the object
  // names by its digest: the product's 32 KiB at most, which is 43,691 characters.
  const part = form.get("sig_private") ?? "";
  if (part) {
    if (part.length > 43_691 || !/^[A-Za-z0-9_-]+$/.test(part)) return null;
    out.private = part;
  }
  return out;
}

/** What a post's answer says about an oracle space's document, when it says anything. */
type Posted = { seq?: string; oracle?: { state?: string; decided?: string }; not_notified?: unknown };

/** The notice a proposal, a decision or an undo lands on, from what the service said
 *  became of it: one of the fixed words in src/me-render.ts. */
function oracleNotice(posted: Posted): string {
  const o = posted.oracle;
  if (o?.decided === "approved") return "proposal-approved";
  if (o?.decided === "declined") return "proposal-declined";
  if (o?.state === "current") return "version-current";
  if (o?.state === "pending") return "proposed";
  return "posted";
}
