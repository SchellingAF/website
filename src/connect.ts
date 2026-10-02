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

import { apiGet, apiWrite, type Refusal } from "./api.ts";
import { buttonForm, formShell, guardScript, guardedButtonForm, resultHtml } from "./me-render.ts";
import { esc, htmlPage, shortKey, when, type Viewer } from "./render.ts";
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

function consentHtml(ctx: SignedInContext, a: Authorization): string {
  const name = a.client.name ? `“<bdi>${esc(a.client.name)}</bdi>”` : "an app that gave no name";
  const who = a.client.kind === "metadata_document" && a.client.publisher
    ? `<dt>its description is published at</dt><dd><code>${esc(a.client.publisher)}</code>. The name above is what that description says, and anybody who can put a file on that host could have written it.</dd>`
    : `<dt>who vouches for it</dt><dd>Nobody. It registered itself with the service, so its name is only its own word.</dd>`;
  const loopback = a.redirect.only_loopback
    ? `<p class="note warn">It returns you to a program on this computer, not to a website. Allow it only if you started connecting from a program here yourself, just now, such as Claude Code.</p>`
    : "";
  const answer = (decision: "allow" | "decline") => ({ request: a.request_id, decision });
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
<p>${guardedButtonForm(ctx.viewer, "/me/connect", "Allow", answer("allow"))} ${buttonForm(ctx.viewer, "/me/connect", "Decline", answer("decline"))}</p>
${guardScript("Allow", "Decline needs no script.")}`);
}

export async function readConnect(ctx: SignedInContext): Promise<Response> {
  const id = ctx.url.searchParams.get("request") ?? "";
  if (!UUID.test(id)) return connectArrivalError(ctx.url, ctx.viewer);
  const res = await apiGet<unknown>({ ...ctx.env }, `/v1/authorizations/${id}`, "session");
  if (!res.ok) return answered(ctx, res);
  const a = shape(res.data);
  if (!a) {
    return page(resultHtml(formShell("Connect an app", ctx.viewer), "Not shown",
      "The service answered with something this site cannot show, so nothing was asked of you.", [["/me", "Your key"]], true), 502);
  }
  if (a.state === "expired") return expired(ctx.viewer);
  if (a.state !== "pending") {
    return page(resultHtml(formShell("Connect an app", ctx.viewer), "Already answered",
      "This request to connect was already allowed or declined. To connect the app again, start again from the app.", [["/me/tokens", "Access tokens"], ["/me", "Your key"]]), 409);
  }
  return html(consentHtml(ctx, a));
}

export async function actOnConnect(ctx: SignedInContext, form: URLSearchParams): Promise<Response> {
  const id = form.get("request") ?? "";
  const decision = form.get("decision");
  if (!UUID.test(id) || (decision !== "allow" && decision !== "decline")) {
    return badForm(ctx.viewer);
  }
  const res = await apiWrite<{ redirect_to?: unknown }>(ctx.session, "POST",
    `/v1/authorizations/${id}/${decision === "allow" ? "approve" : "decline"}`, {});
  if (!res.ok) return answered(ctx, res);
  const to = returnAddress(res.data.redirect_to);
  if (to === null) {
    return page(resultHtml(formShell("Connect an app", ctx.viewer), "Not sent on",
      "The service answered with an address this site will not send you to. Your answer was recorded; close this page and start again from the app.", [["/me", "Your key"]], true), 502);
  }
  const host = new URL(to).host || new URL(to).protocol.replace(/:$/, "");
  const heading = decision === "allow" ? "Allowed" : "Declined";
  const detail = decision === "allow"
    ? `The app can now act as your key. Revoke it any time on Access tokens. Returning you to ${host}.`
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
