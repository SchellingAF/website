// /me/connect: where a person says yes, or no, to an app that wants to connect as
// their key.
//
// An app such as claude.ai, Claude Desktop or ChatGPT has no field for a token, so it
// signs its person in instead: it sends their browser to the product's /oauth/authorize,
// and the product, which serves no page, sends the browser here with the request's
// id. This page is the person's only view of what they are agreeing to, so it says
// four things plainly: what the app calls itself (its own claim), who published it
// or that nobody vouches for it, where the browser goes afterwards, and what the app
// may then do as their key.
//
// THE RULES THIS FILE KEEPS, on top of every signed-in page's.
//
//   1. Everything about the app is shown as the app's claim, escaped: its name, and
//      the hosts. The host the browser returns to is shown on its own, because it is
//      the part a person can check and the part a code goes to.
//   2. A person who is not connected goes through /sign-in and comes back here; see
//      safeNext() in src/me.ts.
//   3. Allowing and declining are forms, with the session's form token and Origin,
//      like every other change. The product's answer is where to send the browser:
//      back to the app with a code, or with access_denied. That address carries a
//      credential, so it is written into this POST's own answer and nowhere else:
//      never into an address of this site, and never into a redirect a form policy
//      could refuse. A browser leaves on its own, by a refresh, and the link beside
//      it is there for a browser that asks first, as one does for a program's own
//      scheme.
//   4. The address the product returns is checked again before it is written into
//      the page: an absolute URI whose scheme cannot run or read anything.
//   5. Allow is sent switched off, and src/allow.js switches it on and counts a
//      press only when the page has been in front for most of a second and the
//      press was deliberate: the pointer really moved, and no other click came just
//      before; or Enter on Allow itself. A double click stolen by another site, or a
//      stream of clicks this page is swapped in under, never counts. The page may run
//      this site's own scripts and send no request (CSP_PRESS in src/index.ts). Join,
//      Take over and Accept are guarded the same way, by guardedButtonForm().
//   6. The app's name is set apart from the sentence around it (<bdi>), and a
//      publisher is said to be where a document was found, not somebody vouching:
//      a host that serves anybody's files serves the document too.
//   7. An app that may write is offered signing: a box, ticked, "Let this app sign
//      your posts". With it ticked, src/connect-signing.js makes the connection a key
//      of its own in the browser, the person's passkey signs once the statement that
//      lets that key sign for theirs (src/connection-key.js), and the statement, the
//      passkey's answer and the key's seed come back with Allow. They go on to the
//      product as connection_key and nowhere else: never logged, never stored here,
//      never written into a page. Unticked, Allow connects the app unsigned as before.
//      Ticked with nothing beside it, because the script never handled the press,
//      nothing is connected and the page is shown again, so a ticked box never becomes
//      an unsigned connection by itself; and what the script makes, sent with the box
//      unticked, is shown again the same way. The box is offered only when the
//      product's capability document lists the label the statement is signed under, so
//      a site deployed before its product never offers it. The page after Allow says the app signs only
//      when the product says it kept the key. The page carries what the script builds the
//      statement from, and never bytes for a passkey to sign.

import { apiGet, apiWrite, type Refusal } from "./api.ts";
import { capabilities, passkeySite, takesConnectionKeys, type Capabilities } from "./capabilities.ts";
import { notAfterOf, readStatement, statementBytes } from "./connection-key.js";
import { buttonForm, emptyFields, formShell, guardScript, guardedButtonForm, hiddenFields, refusalAlert, resultHtml } from "./me-render.ts";
import { csrfField, esc, htmlPage, shortKey, when, type Viewer } from "./render.ts";
import { badForm, html, page, type SignedInContext } from "./signed-in.ts";
import { UUID } from "./grammar.ts";

/** What the product says about a request to connect. */
interface Authorization {
  request_id: string;
  state: string;
  client: { id: string; kind: string; name: string | null; publisher: string | null };
  redirect: { host: string; uri: string; loopback: boolean; only_loopback: boolean };
  scope: string[];
  expires_at: string;
  token_lifetime_days: number;
}

/** Why the product sent a browser here with no request to show, in a person's words. */
const ARRIVAL_ERRORS: Record<string, [string, string]> = {
  unknown_app: [
    "This app is not one the service knows",
    "The app that sent you here named itself in a way the service could not find or check, so nothing was asked of you and nothing was changed. Start connecting again from the app; if this keeps happening, the app cannot connect to this service yet.",
  ],
  wrong_return_address: [
    "This app asked to send you somewhere it did not register",
    "The address the app wanted you returned to is not one it registered, so the service stopped here rather than send you on. Nothing was changed. Start connecting again from the app itself, not from a link somebody sent you.",
  ],
  malformed: [
    "This request to connect was not well formed",
    "The request the app sent was not one the service accepts, so it stopped here rather than guess, and sent nothing back to the app. Nothing was changed. Start connecting again from the app; if this keeps happening, the app cannot connect to this service yet.",
  ],
  busy: [
    "Too many requests to connect right now",
    "The service is taking no more requests to connect for the moment, from here or from everywhere. Nothing was changed. Wait a minute, then start connecting again from the app.",
  ],
  unavailable: [
    "Apps cannot connect for the moment",
    "The service is being repaired and connects no app now. Nothing was changed. Start connecting again from the app later.",
  ],
};

/** Schemes a person is never sent to, whatever the service answers. */
const NEVER = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "filesystem:", "view-source:"]);

/** The address the service says to send the browser to, if it is one a page may. */
function returnAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (NEVER.has(url.protocol)) return null;
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function shape(data: unknown): Authorization | null {
  const d = data as Authorization | null;
  if (!d || typeof d !== "object" || typeof d.request_id !== "string" || !UUID.test(d.request_id)) return null;
  if (typeof d.state !== "string" || !d.client || typeof d.client.kind !== "string") return null;
  if (!d.redirect || typeof d.redirect.host !== "string" || !Array.isArray(d.scope)) return null;
  return d;
}

/** The page a browser lands on when the product could not show it a request. It
 *  needs no session: nothing on it is anybody's, and signing in to read that an app
 *  was not recognised would be a passkey prompt for nothing. */
export function connectArrivalError(url: URL, viewer: Viewer | undefined): Response {
  const code = url.searchParams.get("error") ?? "";
  const [heading, detail] = Object.hasOwn(ARRIVAL_ERRORS, code)
    ? ARRIVAL_ERRORS[code]!
    : ["Nothing to connect", "This address carries no request to connect an app. Start connecting from the app itself."];
  return page(resultHtml(formShell("Connect an app", viewer), heading, detail, viewer ? [["/me", "Your key"]] : [["/api", "How apps connect"]], true), 400);
}

/** What an app may do as the key, in a sentence, from the scopes it was given. */
function mayDo(scope: string[]): string {
  return scope.includes("write")
    ? "read everything your key can read, and act as your key: post, create and run spaces, answer join requests and send messages. Whatever it does is done by your key, and its posts carry your key's id."
    : "read everything your key can read, in every space your key is in, including private ones, and nothing else: it cannot post or change anything.";
}

/** The fields src/connect-signing.js fills once the passkey has signed, each going on to
 *  the product under connection_key, with the most characters of unpadded base64url each
 *  may hold: a statement of the product's 512 bytes, D's 32-byte seed exactly, and a
 *  passkey's answer within the bounds src/me.ts holds a signed post's to. */
const CONNECTION_KEY_FIELDS = [
  ["ck_statement", 683],
  ["ck_seed", 43],
  ["ck_credential_id", 1_366],
  ["ck_client_data_json", 5_462],
  ["ck_authenticator_data", 5_462],
  ["ck_signature", 1_366],
] as const;

/** What a person reads beside the box. OURS, for the owner's approval. */
const SIGNING_LABEL = "Let this app sign your posts";
const SIGNING_NOTE =
  "When you press Allow, your passkey signs once to let this app connection sign the posts the app sends, until an hour after its access token would run out. " +
  "Revoking the app ends that sooner, and a post the app sends after it ends is not signed. " +
  "While the app is connected, the service holds the key this app connection signs with. " +
  "A post signed this way shows that your key allowed this app connection to sign for it, and that the app connection, or the service, signed it. " +
  "It does not show that you saw it. " +
  "Untick the box to allow the app without signing: a space that accepts signed posts only then refuses its posts.";

/** What the page says when Allow arrived with the box ticked and nothing beside it. OURS. */
const NOT_PREPARED =
  "Nothing was allowed: this page had not finished preparing to let the app sign your posts. Press Allow again, or untick the box to allow the app without signing.";

/** What the page says when Allow arrived with a key for signing and the box unticked. OURS. */
const NOT_TICKED =
  "Nothing was allowed: this page sent a key for the app to sign with, but the box was not ticked. Press Allow again.";

/** What the browser builds the statement from, beside the request's id and the key's. */
interface Signing { days: number }

/** Now, in whole seconds, by this site's server's clock. */
const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * What the browser builds the statement from, when this request can have one: a service
 * that takes connection keys, an app that may write, and a lifetime in whole days that
 * makes a statement the statement's own writer takes, with this key and request. Null
 * otherwise, and the page offers no box.
 */
function signingFor(a: Authorization, peerId: string, caps: Capabilities): Signing | null {
  if (!takesConnectionKeys(caps) || !a.scope.includes("write")) return null;
  const days = a.token_lifetime_days;
  const notBefore = nowSeconds();
  const notAfter = notAfterOf(notBefore, days);
  if (notAfter === null) return null;
  try {
    statementBytes({ peerId, key: "0".repeat(64), connection: a.request_id, notBefore, notAfter });
  } catch {
    return null;
  }
  return { days };
}

/**
 * Allow, for an app that may be let sign: the box, what it means, and the form that
 * carries what src/connect-signing.js builds the statement from. The box sits outside the
 * form and belongs to it by its form attribute, so Allow and Decline keep one line.
 */
function allowWithSigning(ctx: SignedInContext, a: Authorization, signing: Signing, rpId: string | null): string {
  const viewer = ctx.viewer;
  const attributes = [
    ["data-connection", a.request_id],
    ["data-peer", viewer.peerId],
    ["data-lifetime-days", String(signing.days)],
    // When the permission starts: the time the page is drawn, by this site's server's
    // clock, never the browser's, which may be wrong by any amount. The product checks it
    // against its own clock, allowing for a little difference between the two.
    ["data-not-before", String(nowSeconds())],
    ...(rpId ? [["data-rp-id", rpId]] : []),
    ...(viewer.passkey ? [["data-credential", viewer.passkey]] : []),
  ].map(([name, value]) => ` ${name}="${esc(value!)}"`).join("");
  return `<div class="connection-key">
<p><label><input type="checkbox" name="sign_posts" value="1" form="allow-app" checked> ${esc(SIGNING_LABEL)}</label></p>
<p class="meta">${esc(SIGNING_NOTE)}</p>
<p class="meta" data-sign-status role="status" aria-live="polite"></p>
</div>
<p><form method="post" action="/me/connect" class="inline" id="allow-app" autocomplete="off" data-connection-key${attributes}>${csrfField(viewer)}${
    hiddenFields({ request: a.request_id, decision: "allow", signing_offered: "1" })}${emptyFields(CONNECTION_KEY_FIELDS.map(([name]) => name))}<button type="submit" data-guard disabled>Allow</button> <span class="meta" data-guard-note role="status" aria-live="polite"></span></form> ${
    buttonForm(viewer, "/me/connect", "Decline", { request: a.request_id, decision: "decline" })}</p>`;
}

function consentHtml(ctx: SignedInContext, a: Authorization, signing: Signing | null, rpId: string | null, said: string | null): string {
  const name = a.client.name ? `“<bdi>${esc(a.client.name)}</bdi>”` : "an app that gave no name";
  const who = a.client.kind === "metadata_document" && a.client.publisher
    ? `<dt>its description is published at</dt><dd><code>${esc(a.client.publisher)}</code>. The name above is what that description says, and anybody who can put a file on that host could have written it.</dd>`
    : `<dt>who vouches for it</dt><dd>Nobody. It registered itself with the service, so its name is only its own word.</dd>`;
  const loopback = a.redirect.only_loopback
    ? `<p class="note warn">It returns you to a program on this computer, not to a website. Allow it only if you started connecting from a program here yourself, just now, such as Claude Code.</p>`
    : "";
  const answer = (decision: "allow" | "decline") => ({ request: a.request_id, decision });
  const buttons = signing
    ? allowWithSigning(ctx, a, signing, rpId)
    : `<p>${guardedButtonForm(ctx.viewer, "/me/connect", "Allow", answer("allow"))} ${buttonForm(ctx.viewer, "/me/connect", "Decline", answer("decline"))}</p>`;
  // The module runs once the page is read, so after src/allow.js, whose press check
  // then comes first on every Allow.
  const scripts = `${guardScript("Allow", "Decline needs no script.")}${signing ? `\n<script type="module" src="/connect-signing.js"></script>` : ""}`;
  return htmlPage(formShell("Connect an app", ctx.viewer), `<h1>An app wants to connect as your key</h1>
<p class="lead">If you allow it, ${name} can ${esc(mayDo(a.scope))}</p>
<dl>
<dt>the app calls itself</dt><dd>${a.client.name ? `<strong><bdi>${esc(a.client.name)}</bdi></strong> <span class="meta">its own name for itself</span>` : '<span class="meta">no name</span>'}</dd>
${who}
<dt>after you answer, you go to</dt><dd><code>${esc(a.redirect.host)}</code></dd>
<dt>it may</dt><dd>${a.scope.includes("write") ? "read and write" : "read only"}</dd>
<dt>your key</dt><dd><code title="${esc(ctx.viewer.peerId)}">${esc(shortKey(ctx.viewer.peerId))}</code></dd>
<dt>for</dt><dd>${esc(String(a.token_lifetime_days))} days, or until you revoke it on <a href="/me/tokens">Access tokens</a></dd>
<dt>answer by</dt><dd>${esc(when(a.expires_at))}</dd>
</dl>
${loopback}<p class="note">Allow only an app you started connecting yourself, just now. Nothing here can check what the app will do; what it does as your key is done by your key.</p>
${refusalAlert(said)}${buttons}
${scripts}`);
}

export async function readConnect(ctx: SignedInContext): Promise<Response> {
  const id = ctx.url.searchParams.get("request") ?? "";
  if (!UUID.test(id)) return connectArrivalError(ctx.url, ctx.viewer);
  return consentPage(ctx, id, null);
}

/** The page that asks the person about request `id`, with `said` above its buttons when
 *  a press of Allow came back. */
async function consentPage(ctx: SignedInContext, id: string, said: string | null): Promise<Response> {
  const res = await apiGet<unknown>({ ...ctx.env }, `/v1/authorizations/${id}`, "session");
  if (!res.ok) return answered(ctx, res);
  const a = shape(res.data);
  // The request asked about, and no other: its id goes into the statement the passkey signs.
  if (!a || a.request_id !== id) {
    return page(resultHtml(formShell("Connect an app", ctx.viewer), "Not shown",
      "The service answered with something this site cannot show, so nothing was asked of you.", [["/me", "Your key"]], true), 502);
  }
  if (a.state === "expired") return expired(ctx.viewer);
  if (a.state !== "pending") {
    return page(resultHtml(formShell("Connect an app", ctx.viewer), "Already answered",
      "This request to connect was already allowed or declined. To connect the app again, start again from the app.", [["/me/tokens", "Access tokens"], ["/me", "Your key"]]), 409);
  }
  const caps = await capabilities();
  const signing = signingFor(a, ctx.viewer.peerId, caps);
  const site = signing ? passkeySite(caps) : null;
  return page(consentHtml(ctx, a, signing, site?.rpId ?? null, said), said ? 400 : 200);
}

/** Unpadded base64url, strictly: re-encoded it must be what was sent. */
function base64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const again = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return again === value ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * What an Allow form carries for the product's connection_key: every field filled by
 * src/connect-signing.js in its shape, a statement of exactly its shape for this key and
 * this request, and a seed of 32 bytes. "none" when the form carries none of them, which
 * is Allow unticked, or ticked in a page whose script never handled the press; null for
 * anything between, which no page of this site sends.
 *
 * The product checks the statement whole, its signature and that `key` is the seed's
 * own; this checks only what this site can, so a form that could never be accepted is
 * refused here with nothing sent.
 */
function connectionKeyOf(form: URLSearchParams, requestId: string, peerId: string): Record<string, unknown> | "none" | null {
  const values = CONNECTION_KEY_FIELDS.map(([name, max]) => [form.get(name) ?? "", max] as const);
  if (values.every(([value]) => value === "")) return "none";
  if (values.some(([value, max]) => value === "" || value.length > max || base64url(value) === null)) return null;
  const [statement, seed, credentialId, clientData, authenticatorData, signature] = values.map(([value]) => value) as string[];
  const read = readStatement(base64url(statement!));
  if (!read || read.peer_id !== peerId || read.connection !== requestId || base64url(seed!)!.length !== 32) return null;
  return {
    statement,
    signature: { alg: "webauthn", credential_id: credentialId, client_data_json: clientData, authenticator_data: authenticatorData, signature },
    seed,
  };
}

export async function actOnConnect(ctx: SignedInContext, form: URLSearchParams): Promise<Response> {
  const id = form.get("request") ?? "";
  const decision = form.get("decision");
  if (!UUID.test(id) || (decision !== "allow" && decision !== "decline")) {
    return badForm(ctx.viewer);
  }
  // Read only for Allow: a decline sends nothing of it anywhere.
  const key = decision === "allow" ? connectionKeyOf(form, id, ctx.viewer.peerId) : "none";
  if (key === null) {
    return badForm(ctx.viewer, "That was not what this page sends to let an app sign your posts, so nothing was changed. Go back, reload the page and press Allow again.");
  }
  // The box ticked, and nothing the script makes beside it: the press reached here before
  // the script handled it, or without it. Or what the script makes, with the box unticked.
  // Either way the form does not say what it sends: nothing is allowed, and the person is
  // asked again.
  const ticked = form.get("sign_posts") === "1";
  if (decision === "allow" && key === "none" && ticked) return consentPage(ctx, id, NOT_PREPARED);
  if (decision === "allow" && key !== "none" && !ticked) return consentPage(ctx, id, NOT_TICKED);
  const res = await apiWrite<{ redirect_to?: unknown; connection_key?: unknown }>(ctx.session, "POST",
    `/v1/authorizations/${id}/${decision === "allow" ? "approve" : "decline"}`, key === "none" ? {} : { connection_key: key });
  if (!res.ok) return answered(ctx, res);
  const to = returnAddress(res.data.redirect_to);
  if (to === null) {
    return page(resultHtml(formShell("Connect an app", ctx.viewer), "Not sent on",
      "The service answered with an address this site will not send you to. Your answer was recorded; close this page and start again from the app.", [["/me", "Your key"]], true), 502);
  }
  const host = new URL(to).host || new URL(to).protocol.replace(/:$/, "");
  const heading = decision === "allow" ? "Allowed" : "Declined";
  // Whether its posts are signed, said only where the page offered the box: an app that
  // may only read posts nothing. Signed only on the product's word that it kept the key.
  const signing = key !== "none" && res.data.connection_key === "kept"
    ? " It signs the posts it sends with the key your passkey allowed."
    : key !== "none" || form.get("signing_offered") === "1" ? " Its posts will not be signed." : "";
  const detail = decision === "allow"
    ? `The app can now act as your key.${signing} Revoke it any time on Access tokens. Returning you to ${host}.`
    : `The app was told you declined, and nothing was connected. Returning you to ${host}.`;
  // The address carries the app's code, so this answer is never stored and never
  // indexed (src/index.ts sends every signed-in response private, no-store), and it
  // leaves by a refresh rather than a redirect.
  return html(htmlPage(formShell("Connect an app", ctx.viewer), `<meta http-equiv="refresh" content="0; url=${esc(to)}">
<h1>${esc(heading)}</h1>
<p class="lead">${esc(detail)}</p>
<p><a href="${esc(to)}">Continue to ${esc(host)}</a></p>`));
}

/** A request to connect that has run out. */
function expired(viewer: Viewer): Response {
  return page(resultHtml(formShell("Connect an app", viewer), "This request has expired",
    "An app's request to connect lasts ten minutes. Start connecting again from the app.", [["/me", "Your key"]], true), 410);
}

/** A refusal about a request to connect, in a person's words. */
function answered(ctx: SignedInContext, res: Refusal): Response {
  const shell = formShell("Connect an app", ctx.viewer);
  switch (res.code) {
    case "AUTHORIZATION_NOT_FOUND":
      return page(resultHtml(shell, "No such request", "There is no request to connect at this address, or it is more than a day old. Start connecting again from the app.", [["/me", "Your key"]], true), 404);
    case "AUTHORIZATION_EXPIRED":
      return expired(ctx.viewer);
    case "AUTHORIZATION_DECIDED":
      return page(resultHtml(shell, "Already answered", "This request to connect was already allowed or declined. To connect the app again, start again from the app.", [["/me/tokens", "Access tokens"]]), 409);
    case "OAUTH_UNAVAILABLE":
      return page(resultHtml(shell, "Apps cannot connect here yet", "This service is not set up for apps to connect. Nothing was changed.", [["/me", "Your key"]], true), 503);
    default:
      return ctx.refused(res, [["/me", "Your key"]]);
  }
}
