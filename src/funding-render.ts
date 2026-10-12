// A space's funding, drawn: the section on its page and the page at /spaces/<name>/funding
// with its twin under /me. Every value came from the service, so every one goes through
// esc() in the page and a code span in the markdown. The words are this site's own, and the
// statements are the list in src/funding-section.ts, said whole on every funding page.

import { API_ORIGIN } from "./routes.generated.ts";
import { codeSpan, csrfField, esc, htmlPage, spaceTrail, when, type Shell, type Viewer } from "./render.ts";
import {
  CLOSED, MEMBERS_ONLY, NOT_AVAILABLE, OLDER_WALLET, closedStatements, entryLabel, money, statementParts, statements,
  type FundingAddress, type FundingCoin, type FundingHistory, type FundingRead, type FundingSection,
} from "./funding-section.ts";

// ------------------------------------------------------------ on a space's page

const MAKE_ADDRESS = "Send credit to this space";
const SEE_FUNDING = "See the funding page";

/** The section as the page, the markdown and the JSON carry it: one content, three shapes. */
export interface SectionParts { html: string; md: string[]; json: Record<string, unknown> }

export function sectionParts(s: FundingSection, spaceHref: string): SectionParts {
  const page = `${spaceHref}/funding`;
  const facts = [s.balance, s.incoming, s.held].filter((x): x is string => x !== null);
  const addresses = s.addresses;
  const html: string[] = [`<section id="funding">`, `<h2>Funding</h2>`];
  if (s.storage) html.push(`<p class="meta">${esc(s.storage)}</p>`);
  if (facts.length) html.push(`<p>${facts.map(esc).join(" ")}</p>`);
  const base = spaceHref.slice(0, spaceHref.lastIndexOf("/"));
  if (addresses !== null && s.creditedTo) html.push(`<p>Deposits to these addresses credit <a href="${esc(`${base}/${s.creditedTo}`)}">${esc(s.creditedTo)}</a>.</p>`);
  if (addresses !== null) {
    if (!s.depositsOpen) html.push(`<p>${esc(CLOSED)}</p>`);
    else if (addresses.length > 0) {
      html.push(`<h3>Deposit addresses</h3>`, `<ul>`);
      for (const a of addresses) {
        html.push(`<li>${esc(a.symbol ?? a.coin)}${a.network === null ? "" : ` on ${esc(a.network)}`}: <code>${esc(a.address)}</code>${a.minimum === null ? "" : `, minimum ${esc(a.minimum)}${a.symbol === null ? "" : ` ${esc(a.symbol)}`}`}${a.older ? ` <span class="meta">(${esc(OLDER_WALLET)})</span>` : ""}</li>`);
      }
      html.push(`</ul>`);
    }
    html.push(`<p><a href="${esc(page)}">${esc(s.depositsOpen ? MAKE_ADDRESS : SEE_FUNDING)}</a></p>`);
    if (s.membersOnly) html.push(`<p class="meta">${esc(MEMBERS_ONLY)}</p>`);
  }
  html.push(`</section>`);

  const md: string[] = [];
  if (facts.length) md.push(`- funding: ${facts.join(" ")}`);
  if (addresses !== null && s.creditedTo) md.push(`- funding: deposits to these addresses credit ${codeSpan(s.creditedTo)}: ${base}/${s.creditedTo}.md`);
  if (addresses !== null) {
    if (!s.depositsOpen) md.push(`- funding: ${CLOSED}`);
    else for (const a of addresses) {
      md.push(`- deposit address: ${codeSpan(a.symbol ?? a.coin)}${a.network === null ? "" : ` on ${codeSpan(a.network)}`}: ${codeSpan(a.address)}${a.minimum === null ? "" : `, minimum ${codeSpan(a.minimum)}`}${a.older ? ` (${OLDER_WALLET})` : ""}`);
    }
    md.push(`- funding page: ${page}.md`);
    if (s.membersOnly) md.push(`- funding: ${MEMBERS_ONLY}`);
  }

  const json: Record<string, unknown> = {
    ...(s.balance ? { balance: s.balance } : {}),
    ...(s.incoming ? { incoming: s.incoming } : {}),
    ...(s.held ? { held: s.held } : {}),
    ...(addresses !== null ? {
      deposits_open: s.depositsOpen,
      addresses: addresses.map((a) => ({ coin: a.coin, symbol: a.symbol, network: a.network, address: a.address, minimum: a.minimum, older_wallet: a.older })),
      page,
      ...(s.creditedTo ? { credited_to: { name: s.creditedTo, page: `${base}/${s.creditedTo}` } } : {}),
      ...(s.membersOnly ? { members_only: MEMBERS_ONLY } : {}),
    } : {}),
  };
  return { html: html.join("\n"), md, json };
}

// ------------------------------------------------------------------- the page

/** One of the ready coins on the page: the coin, and its current address, or why there is none. */
export interface ReadySlot { coin: FundingCoin; address: FundingAddress | null; why: string | null }

export interface FundingPageView {
  read: FundingRead;
  /** The ready coins in the service's order, each with its address, made while the page was
   *  drawn when it had none, or the reason it has none. */
  ready: ReadySlot[];
  /** The credit history: null where the reader does not see it, "unreadable" when it was asked for and not read. */
  history: FundingHistory | "unreadable" | null;
  before: string;
  basePath: string;
  spaceHref: string;
  pagePath: string;
  /** Present on the signed-in page, whose forms carry the session's token. */
  viewer: Viewer | null;
  readAs: string;
}

const LEAD = "Credit for this space: send a coin to an address below. No key or sign-in is needed.";
/** The lead while deposits are not open: there is no address to send to. */
const LEAD_CLOSED = "Credit for this space: what is credited, and how storage is billed.";
const leadOf = (open: boolean): string => (open ? LEAD : LEAD_CLOSED);
export const API_MAKE = (name: string): string => `POST ${API_ORIGIN}/v1/spaces/${name}/funding/addresses with {"coin": "<ticker>"} (no key needed)`;

interface Network { name: string; coins: FundingCoin[]; cheap: boolean }

/** The coins grouped by network: networks where every coin is cheap first, then by name; a
 *  network's coins by symbol. */
export function networksOf(coins: FundingCoin[]): Network[] {
  const by = new Map<string, FundingCoin[]>();
  for (const c of coins) by.set(c.network, [...(by.get(c.network) ?? []), c]);
  const nets = [...by].map(([name, list]) => ({ name, coins: [...list].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.coin.localeCompare(b.coin)), cheap: list.every((c) => c.cheap) }));
  return nets.sort((a, b) => Number(b.cheap) - Number(a.cheap) || a.name.localeCompare(b.name));
}

const notes = (c: FundingCoin): string => [c.cheap ? "cheap network" : "", c.stable ? "one for one" : ""].filter(Boolean).join(", ");

/** The anchor of a coin on the page, which a "Show address" press comes back to. */
export const coinAnchor = (ticker: string): string => `coin-${ticker.replaceAll("/", "-")}`;

/** The current address of each coin, and every other address made: an older wallet's, or a coin the table dropped. */
function addressesOf(v: FundingPageView): { current: Map<string, FundingAddress>; others: FundingAddress[] } {
  const current = new Map<string, FundingAddress>();
  for (const slot of v.ready) if (slot.address) current.set(slot.coin.coin, slot.address);
  for (const a of v.read.addresses ?? []) if (a.current && !current.has(a.coin)) current.set(a.coin, a);
  const shown = new Set(current.values());
  return { current, others: (v.read.addresses ?? []).filter((a) => !shown.has(a)) };
}

/** The coins below the ready ones: every coin the service takes, less those shown above. */
const otherCoins = (v: FundingPageView): FundingCoin[] => {
  const ready = new Set(v.ready.map((r) => r.coin.coin));
  return v.read.coins.filter((c) => !ready.has(c.coin));
};

/** The form that asks for a coin's address: one button, no session. A signed-in page's carries the form token. */
function showForm(v: FundingPageView, ticker: string): string {
  return `<form method="post" action="${esc(`${v.spaceHref}/funding`)}" class="inline">${v.viewer ? csrfField(v.viewer) : ""}<input type="hidden" name="coin" value="${esc(ticker)}"><button type="submit">Show address</button></form>`;
}

/** A coin's name as the page says it: its symbol and its network. */
const coinName = (c: { symbol: string | null; coin: string; network: string | null }): string => `${c.symbol ?? c.coin}${c.network === null ? "" : ` on ${c.network}`}`;

function readyHtml(v: FundingPageView): string {
  if (!v.ready.length) return "";
  const slots = v.ready.map(({ coin, address, why }) => `<div class="pay" id="${esc(coinAnchor(coin.coin))}">
<h3>${esc(coinName(coin))}</h3>
<p class="meta">${coin.name === coin.symbol ? "" : `${esc(coin.name)}. `}Minimum ${esc(coin.minimum)} ${esc(coin.symbol)}${coin.stable ? ". Counted one for one." : "."}</p>
${address ? `<code class="address">${esc(address.address)}</code>` : `<p class="note warn">${esc(why ?? NOT_AVAILABLE)}</p>`}
</div>`);
  return `<h2 id="send">Send to this space</h2>\n${slots.join("\n")}`;
}

function rulesHtml(pay: string[]): string {
  return `<ul>\n${pay.map((s) => `<li>${esc(s)}</li>`).join("\n")}\n</ul>`;
}

function depositsHtml(v: FundingPageView): string {
  const b = v.read.balance;
  if (!b) return "";
  const list = (title: string, rows: string[]) => rows.length ? `<h3>${esc(title)}</h3>\n<ul>\n${rows.join("\n")}\n</ul>` : "";
  const pending = b.pending.map((d) => `<li>${esc(d.coin)}: ${d.value_coin === null ? "amount not yet known" : esc(d.value_coin)}, transaction <code>${esc(d.txid_in)}</code>, seen ${esc(when(d.seen_at))}</li>`);
  const held = b.held.map((d) => `<li>${esc(d.coin)}: ${d.value_forwarded_coin === null ? "amount not known" : esc(d.value_forwarded_coin)}${d.usd_micro === null ? "" : `, worth ${esc(money(d.usd_micro))}`}, transaction <code>${esc(d.txid_in)}</code>, seen ${esc(when(d.seen_at))}. ${esc(d.reason)}</li>`);
  const rejected = b.rejected.map((d) => `<li>${esc(d.coin)}: transaction <code>${esc(d.txid_in)}</code>, seen ${esc(when(d.seen_at))}. ${esc(d.reason)}</li>`);
  return [
    `<h2 id="balance">Balance and deposits</h2>`,
    `<p>Balance: ${esc(money(b.micro))}. ${esc(`${b.counts.credited.toLocaleString("en-US")} deposits credited.`)}</p>`,
    list(`Incoming, not yet credited (${b.counts.pending})`, pending),
    list(`Held, not credited (${b.counts.held})`, held),
    list(`Not credited (${b.counts.rejected})`, rejected),
  ].filter(Boolean).join("\n");
}

function historyHtml(v: FundingPageView): string {
  if (v.history === null) return "";
  if (v.history === "unreadable") return `<h2 id="history">Credit history</h2>\n<p>The credit history could not be read just now. Reload the page to try again.</p>`;
  const h = v.history;
  const rows = h.entries.map((e) => `<tr><td>${esc(when(e.at))}</td><td>${esc(entryLabel(e, v.read.space))}</td><td>${esc(money(e.amount_micro_usd))}</td><td>${esc(money(e.balance_after_micro_usd))}</td><td>${e.deposit ? `${esc(e.deposit.coin)} ${e.deposit.value_forwarded_coin === null ? "not sent" : esc(e.deposit.value_forwarded_coin)}, <code>${esc(e.deposit.txid_in)}</code>` : ""}</td></tr>`);
  return `<h2 id="history">Credit history</h2>
${rows.length ? `<div class="wide"><table>
<tr><th scope="col">When</th><th scope="col">Entry</th><th scope="col">Amount</th><th scope="col">Balance after</th><th scope="col">Deposit</th></tr>
${rows.join("\n")}
</table></div>` : "<p>No credit entries yet.</p>"}
${h.hasMore && h.nextBefore ? `<p class="meta"><a href="${esc(`${v.pagePath}?${new URLSearchParams({ before: h.nextBefore })}`)}">Earlier entries</a></p>` : ""}`;
}

/** Every address made that the coin list above does not show: from an earlier wallet, still credited, or of a coin the table dropped. */
function othersHtml(others: FundingAddress[]): string {
  if (!others.length) return "";
  return `<h3>Other addresses made for this space</h3>
<ul>
${others.map((a) => `<li>${esc(coinName(a))}: <code>${esc(a.address)}</code>${a.minimum === null ? "" : `, minimum ${esc(a.minimum)}${a.symbol === null ? "" : ` ${esc(a.symbol)}`}`}${a.current ? "" : ` <span class="meta">(${esc(OLDER_WALLET)})</span>`}</li>`).join("\n")}
</ul>`;
}

function coinsHtml(v: FundingPageView): string {
  const nets = networksOf(otherCoins(v));
  const { current, others } = addressesOf(v);
  const makeable = v.read.creditedTo === null;
  if (!nets.length && !others.length) return "";
  return `<h2 id="coins">Other coins</h2>
${nets.length ? `<p class="meta">Press Show address for a coin. No key is needed. Minimums as of ${esc(v.read.minimumsAsOf)}.</p>` : ""}
${nets.map((n) => `<h3>${esc(n.name)}</h3>
<div class="wide"><table>
<tr><th scope="col">Coin</th><th scope="col">Minimum</th><th scope="col"></th><th scope="col">Address</th></tr>
${n.coins.map((c) => {
    const a = current.get(c.coin);
    return `<tr id="${esc(coinAnchor(c.coin))}"><th scope="row">${esc(c.symbol)}</th><td>${esc(c.minimum)}</td><td>${esc(notes(c))}</td><td>${a ? `<code class="address">${esc(a.address)}</code>` : makeable ? showForm(v, c.coin) : ""}</td></tr>`;
  }).join("\n")}
</table></div>`).join("\n")}
${othersHtml(others)}`;
}

export function fundingHtml(shell: Shell, v: FundingPageView): string {
  const r = v.read;
  const nonPublic = r.visibility !== "public";
  const open = r.depositsOpen;
  const closed = closedStatements(nonPublic, r.creditedTo, r.billing);
  const { pay, more } = statementParts(r.minimumsAsOf, nonPublic, r.creditedTo, r.billing);
  return htmlPage(shell, `${spaceTrail(v.basePath, v.spaceHref, r.space, "funding")}
<h1>Funding for ${esc(r.space)}</h1>
<p class="lead">${esc(leadOf(open))} The space: <a href="${esc(v.spaceHref)}">${esc(r.space)}</a>.</p>
${open ? `${readyHtml(v)}
${rulesHtml(pay)}` : rulesHtml(closed)}
${r.creditedTo ? `<p>The space that receives these deposits: <a href="${esc(`${v.basePath}/${r.creditedTo}`)}">${esc(r.creditedTo)}</a>.</p>` : ""}
${r.storage ? `<p class="meta">${esc(r.storage)}</p>` : ""}
${r.membersOnly ? `<p class="meta">${esc(MEMBERS_ONLY)}</p>` : ""}
${depositsHtml(v)}
${historyHtml(v)}
${open ? `<h2 id="more">More about credit</h2>\n${rulesHtml(more)}` : ""}
${open ? coinsHtml(v) : ""}`);
}

const addressJson = (a: FundingAddress): Record<string, unknown> => ({
  coin: a.coin, symbol: a.symbol, network: a.network, address: a.address, minimum: a.minimum, cheap: a.cheap, stable: a.stable, older_wallet: !a.current, created_at: a.created_at,
});

export function fundingMarkdown(v: FundingPageView): string {
  const r = v.read;
  const nonPublic = r.visibility !== "public";
  const open = r.depositsOpen;
  const L: string[] = [`# Funding for ${codeSpan(r.space)}`, "", leadOf(open), "", `- space: ${v.spaceHref}.md`];
  if (open) {
    L.push("", "## Send to this space", "");
    for (const { coin, address, why } of v.ready) {
      L.push(`- ${codeSpan(coinName(coin))}, minimum ${codeSpan(coin.minimum)}${coin.stable ? ", one for one" : ""}: ${address ? codeSpan(address.address) : (why ?? NOT_AVAILABLE)}`);
    }
    L.push("");
    const { pay, more } = statementParts(r.minimumsAsOf, nonPublic, r.creditedTo, r.billing);
    L.push(...pay.map((s) => `- ${s}`), "");
    if (r.creditedTo) L.push(`- credited to: ${v.basePath}/${r.creditedTo}.md`, "");
    if (r.storage) L.push(r.storage, "");
    if (r.membersOnly) L.push(MEMBERS_ONLY, "");
    pendingAndHistory(L, v);
    L.push("## More about credit", "", ...more.map((s) => `- ${s}`), "");
  } else {
    L.push("", ...closedStatements(nonPublic, r.creditedTo, r.billing).map((s) => `- ${s}`), "");
    if (r.creditedTo) L.push(`- credited to: ${v.basePath}/${r.creditedTo}.md`, "");
    if (r.storage) L.push(r.storage, "");
    if (r.membersOnly) L.push(MEMBERS_ONLY, "");
    pendingAndHistory(L, v);
  }
  if (open) {
    const { current, others } = addressesOf(v);
    const nets = networksOf(otherCoins(v));
    if (nets.length || others.length) L.push("## Other coins", "");
    if (nets.length) L.push(`Minimums as of ${r.minimumsAsOf}. Ask for an address: ${API_MAKE(r.space)}.`, "");
    for (const n of nets) {
      L.push(`### ${n.name}`, "");
      for (const c of n.coins) {
        const a = current.get(c.coin);
        L.push(`- ${codeSpan(c.symbol)} (${codeSpan(c.coin)}): minimum ${codeSpan(c.minimum)}${notes(c) ? `, ${notes(c)}` : ""}${a ? `: ${codeSpan(a.address)}` : ""}`);
      }
      L.push("");
    }
    if (others.length) {
      L.push("### Other addresses made for this space", "");
      for (const a of others) L.push(`- ${codeSpan(coinName(a))}: ${codeSpan(a.address)}${a.current ? "" : ` (${OLDER_WALLET})`}`);
      L.push("");
    }
  }
  return L.join("\n");
}

/** The balance, the deposits not yet credited and the credit history, in the markdown. */
function pendingAndHistory(L: string[], v: FundingPageView): void {
  const b = v.read.balance;
  if (b) {
    L.push("## Balance and deposits", "", `- balance: ${money(b.micro)}`, `- deposits credited: ${b.counts.credited}`);
    for (const d of b.pending) L.push(`- incoming, not yet credited: ${codeSpan(d.coin)} ${d.value_coin === null ? "amount not yet known" : codeSpan(d.value_coin)}, transaction ${codeSpan(d.txid_in)}, seen ${d.seen_at}`);
    for (const d of b.held) L.push(`- held, not credited: ${codeSpan(d.coin)} ${d.value_forwarded_coin === null ? "amount not known" : codeSpan(d.value_forwarded_coin)}, transaction ${codeSpan(d.txid_in)}, seen ${d.seen_at}, ${codeSpan(d.reason)}`);
    for (const d of b.rejected) L.push(`- not credited: ${codeSpan(d.coin)}, transaction ${codeSpan(d.txid_in)}, seen ${d.seen_at}, ${codeSpan(d.reason)}`);
    L.push("");
  }
  if (v.history === "unreadable") L.push("## Credit history", "", "The credit history could not be read just now.", "");
  else if (v.history) {
    L.push("## Credit history", "");
    if (!v.history.entries.length) L.push("No credit entries yet.");
    for (const e of v.history.entries) {
      L.push(`- ${e.at}: ${codeSpan(entryLabel(e, v.read.space))} ${money(e.amount_micro_usd)}, balance after ${money(e.balance_after_micro_usd)}${e.deposit ? `, ${codeSpan(e.deposit.coin)} ${e.deposit.value_forwarded_coin === null ? "not sent" : codeSpan(e.deposit.value_forwarded_coin)}, transaction ${codeSpan(e.deposit.txid_in)}` : ""}`);
    }
    if (v.history.hasMore && v.history.nextBefore) L.push("", `- earlier entries: ${v.pagePath}.md?${new URLSearchParams({ before: v.history.nextBefore })}`);
    L.push("");
  }
}

export function fundingJson(v: FundingPageView, canonical: string): unknown {
  const r = v.read;
  const nonPublic = r.visibility !== "public";
  const open = r.depositsOpen;
  const b = r.balance;
  const { current } = addressesOf(v);
  return {
    title: `Funding for ${r.space}`,
    url: canonical,
    about: leadOf(open),
    read_as: v.readAs,
    space: { name: r.space, page: v.spaceHref },
    deposits_open: open,
    statements: open ? statements(r.minimumsAsOf, nonPublic, r.creditedTo, r.billing) : closedStatements(nonPublic, r.creditedTo, r.billing),
    minimums_as_of: open ? r.minimumsAsOf : null,
    ...(r.creditedTo ? { credited_to: { name: r.creditedTo, page: `${v.basePath}/${r.creditedTo}` } } : {}),
    ...(r.storage ? { storage: r.storage } : {}),
    // The coins ready to pay: each with its address, or null and why there is none.
    ready: open ? v.ready.map(({ coin, address, why }) => ({
      coin: coin.coin, symbol: coin.symbol, network: coin.network, minimum: coin.minimum, stable: coin.stable,
      address: address ? address.address : null, ...(address ? {} : { not_available: why ?? NOT_AVAILABLE }),
    })) : [],
    addresses: open ? [...current.values(), ...addressesOf(v).others].map(addressJson) : [],
    ...(open ? { make_address: API_MAKE(r.space) } : {}),
    ...(r.membersOnly ? { members_only: MEMBERS_ONLY } : {}),
    ...(b ? {
      balance: money(b.micro),
      balance_micro_usd: b.micro,
      deposits: {
        pending: b.pending, held: b.held, rejected: b.rejected,
        pending_count: b.counts.pending, held_count: b.counts.held, rejected_count: b.counts.rejected, credited_count: b.counts.credited,
      },
    } : {}),
    ...(v.history && v.history !== "unreadable" ? {
      history: { entries: v.history.entries.map((e) => ({ ...e, label: entryLabel(e, v.read.space) })), has_more: v.history.hasMore, next_before: v.history.nextBefore },
    } : {}),
    ...(v.history === "unreadable" ? { history: "could not be read just now" } : {}),
    coins: open ? networksOf(r.coins).map((n) => ({ network: n.name, coins: n.coins.map((c) => ({ coin: c.coin, symbol: c.symbol, minimum: c.minimum, cheap: c.cheap, stable: c.stable, address: current.get(c.coin)?.address ?? null })) })) : [],
  };
}
