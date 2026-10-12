// The one form on a public page that writes: "Show address" on a space's funding page.
//
// POST /spaces/<name>/funding with a coin asks the product for that coin's deposit address
// with NO key and no session, and sends the person back to the funding page at that coin. An
// address is public and pays only into the space, and the product makes it for anyone, so the
// form needs nothing a person would have to sign in for. It is the only address outside the
// signed-in family that takes a POST; serve.mjs and src/index.ts both ask isFundingForm()
// and nothing else. A POST must come from a page of this site (Origin, as every form here),
// and its body is one short field. What it sends on is a ticker's shape and a space's name,
// nothing the visitor typed freely.

import { apiMakeAddress, type Refusal } from "./api.ts";
import { NAME } from "./grammar.ts";
import { formShell, resultHtml } from "./me-render.ts";
import { sameOrigin } from "./session.ts";
import { addressOf } from "./funding-section.ts";
import { coinAnchor } from "./funding-render.ts";
import { forgetFundingSection } from "./spaces.ts";

const FUNDING_FORM = new RegExp(`^/spaces/(${NAME})/funding/?$`);

/** The most a funding form's body may be: one coin. */
export const FUNDING_FORM_BYTES = 1024;

/** Whether an address is a space's funding page, the one public address that takes a POST. */
export const isFundingForm = (path: string): boolean => FUNDING_FORM.test(path);

const TICKER = /^[a-z0-9][a-z0-9./_-]{0,63}$/;

const html = (body: string, status: number): Response =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/** A form that did not go through, in a person's words, with the way back. */
function notDone(name: string, status: number, detail: string): Response {
  return html(resultHtml(formShell("Not done", undefined), "Not done", detail, [[`/spaces/${name}/funding`, "Back to the funding page"], [`/spaces/${name}`, "Back to the space"]], true), status);
}

/** The service's refusal of an address, in the form's own words. */
function refusalWords(res: Refusal): string {
  switch (res.code) {
    case "COIN_NOT_OFFERED":
      return "That coin is not one this space takes on this server. Choose one from the list on the funding page. Nothing was made.";
    case "SPACE_CLOSED":
      return "This space no longer takes new deposit addresses. Nothing was made.";
    case "FUNDING_UNAVAILABLE":
      return "Deposit addresses cannot be made just now: deposits are not open on this server, or the provider did not answer. Nothing was made. Try again later.";
    case "RATE_LIMITED":
      return res.retryAfter
        ? `Too many deposit addresses were made in a short time. Wait ${res.retryAfter} ${res.retryAfter === 1 ? "second" : "seconds"} and try again. Nothing was made.`
        : "Too many deposit addresses were made in a short time. Wait a minute and try again. Nothing was made.";
    default:
      return "The service did not make the address. Nothing was made. Try again later.";
  }
}

/**
 * Makes the address of the coin the form names and goes back to the funding page at that
 * coin. The page is forgotten first, so what it shows next includes the address.
 */
export async function handleFundingForm(request: Request, url: URL): Promise<Response> {
  const name = url.pathname.match(FUNDING_FORM)![1]!;
  if (!sameOrigin(request, url)) {
    return notDone(name, 403, "That form was not sent from a page of this site. Nothing was made.");
  }
  const form = new URLSearchParams(await request.text().catch(() => ""));
  const coin = (form.get("coin") ?? "").trim();
  if (!TICKER.test(coin)) return notDone(name, 400, "Choose a coin from the list. Nothing was made.");

  const res = await apiMakeAddress<{ address?: unknown }>(name, coin);
  if (!res.ok) {
    const status = res.status >= 400 && res.status < 500 ? res.status : 503;
    return notDone(name, res.code === "SPACE_NOT_FOUND" ? 404 : status, res.code === "SPACE_NOT_FOUND" ? `There is no space called ${name}. Nothing was made.` : refusalWords(res));
  }
  if (!addressOf(res.data?.address)) return notDone(name, 502, "The service answered with something this page cannot read. Nothing was made. Try again later.");
  forgetFundingSection(url.origin, name);
  return new Response(null, {
    status: 303,
    headers: { Location: `/spaces/${name}/funding#${coinAnchor(coin)}`, "Cache-Control": "no-store" },
  });
}
