// A space's funding, drawn: the section on its page and the page at /spaces/<name>/funding
// with its twin under /me. Every value came from the service, so every one goes through
// esc() in the page and a code span in the markdown. The words are this site's own, and the
// statements are the list in src/funding-section.ts, said whole on every funding page.

import { API_ORIGIN } from "./routes.generated.ts";
import { codeSpan, csrfField, esc, htmlPage, spaceTrail, when, type Shell, type Viewer } from "./render.ts";
import {
  CLOSED, MEMBERS_ONLY, NO_ADDRESS, OLDER_WALLET, closedStatements, money, statements,
  type FundingAddress, type FundingCoin, type FundingHistory, type FundingRead, type FundingSection,
} from "./funding-section.ts";

// ------------------------------------------------------------ on a space's page

const MAKE_ADDRESS = "Make a deposit address or see every coin";
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
    else if (addresses.length === 0) html.push(`<p>${esc(NO_ADDRESS)}</p>`);
    else {
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
    else if (addresses.length === 0) md.push(`- funding: ${NO_ADDRESS}`);
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

export interface FundingPageView {
  read: FundingRead;
  /** The credit history: null where the reader does not see it, "unreadable" when it was asked for and not read. */
  history: FundingHistory | "unreadable" | null;
  before: string;
  basePath: string;
  spaceHref: string;
  pagePath: string;
  /** Present on the signed-in page, which carries the form. */
  viewer: Viewer | null;
  /** The ticker whose address to show first. */
  pick: string | null;
  readAs: string;
}

const LEAD = "Credit for this space: how to add it, what is credited and what is not.";
export const API_MAKE = (name: string): string => `POST ${API_ORIGIN}/v1/spaces/${name}/funding/addresses with {"coin": "<ticker>"}`;

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

/** The picker: one select, the networks as groups. */
function pickerHtml(v: FundingPageView): string {
  const groups = networksOf(v.read.coins).map((n) => {
    const options = n.coins.map((c) =>
      `<option value="${esc(c.coin)}">${esc(c.symbol)}, minimum ${esc(c.minimum)}${!n.cheap && c.cheap ? ", cheap network" : ""}</option>`).join("");
    return `<optgroup label="${esc(n.cheap ? `${n.name}, cheap network` : n.name)}">${options}</optgroup>`;
  }).join("");
  return `<form method="post" action="${esc(`${v.spaceHref}/funding`)}" class="stack">${csrfField(v.viewer!)}
<label>Coin and network
<select name="coin" required>${groups}</select></label>
<p><button type="submit">Get the address</button></p>
</form>`;
}

const addressBlock = (a: FundingAddress, mark: boolean): string =>
  `<li${mark ? ' class="note"' : ""}>${mark ? "<strong>Your address</strong>: " : ""}${esc(a.symbol ?? a.coin)}${a.network === null ? "" : ` on ${esc(a.network)}`}: <code>${esc(a.address)}</code>${a.minimum === null ? "" : `, minimum ${esc(a.minimum)}${a.symbol === null ? "" : ` ${esc(a.symbol)}`}`}${a.cheap ? ", cheap network" : ""}${a.stable ? ", one for one" : ""}${a.current ? "" : ` <span class="meta">(${esc(OLDER_WALLET)})</span>`}</li>`;

/** The addresses with the picked one first. */
function ordered(v: FundingPageView): FundingAddress[] {
  const all = v.read.addresses ?? [];
  const first = v.pick ? all.filter((a) => a.coin === v.pick) : [];
  return [...first, ...all.filter((a) => !first.includes(a))];
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
  const rows = h.entries.map((e) => `<tr><td>${esc(when(e.at))}</td><td>${esc(e.kind)}</td><td>${esc(money(e.amount_micro_usd))}</td><td>${esc(money(e.balance_after_micro_usd))}</td><td>${e.deposit ? `${esc(e.deposit.coin)} ${e.deposit.value_forwarded_coin === null ? "not sent" : esc(e.deposit.value_forwarded_coin)}, <code>${esc(e.deposit.txid_in)}</code>` : ""}</td></tr>`);
  return `<h2 id="history">Credit history</h2>
${rows.length ? `<div class="wide"><table>
<tr><th scope="col">When</th><th scope="col">Entry</th><th scope="col">Amount</th><th scope="col">Balance after</th><th scope="col">Deposit</th></tr>
${rows.join("\n")}
</table></div>` : "<p>No credit entries yet.</p>"}
${h.hasMore && h.nextBefore ? `<p class="meta"><a href="${esc(`${v.pagePath}?${new URLSearchParams({ before: h.nextBefore })}`)}">Earlier entries</a></p>` : ""}`;
}

function coinsHtml(v: FundingPageView): string {
  const nets = networksOf(v.read.coins);
  if (!nets.length) return "";
  return `<h2 id="coins">Every coin</h2>
<p class="meta">Minimums as of ${esc(v.read.minimumsAsOf)}.</p>
${nets.map((n) => `<h3>${esc(n.name)}</h3>
<div class="wide"><table>
<tr><th scope="col">Coin</th><th scope="col">Minimum</th><th scope="col"></th></tr>
${n.coins.map((c) => `<tr><th scope="row">${esc(c.symbol)}</th><td>${esc(c.minimum)}</td><td>${esc(notes(c))}</td></tr>`).join("\n")}
</table></div>`).join("\n")}`;
}

export function fundingHtml(shell: Shell, v: FundingPageView): string {
  const r = v.read;
  const nonPublic = r.visibility !== "public";
  const open = r.depositsOpen;
  const said = open ? statements(r.minimumsAsOf, nonPublic, r.creditedTo) : closedStatements(nonPublic, r.creditedTo);
  const addresses = open ? ordered(v) : [];
  return htmlPage(shell, `${spaceTrail(v.basePath, v.spaceHref, r.space, "funding")}
<h1>Funding for ${esc(r.space)}</h1>
<p class="lead">${esc(LEAD)} The space: <a href="${esc(v.spaceHref)}">${esc(r.space)}</a>.</p>
<ul>
${said.map((s) => `<li>${esc(s)}</li>`).join("\n")}
</ul>
${r.creditedTo ? `<p>The space that receives these deposits: <a href="${esc(`${v.basePath}/${r.creditedTo}`)}">${esc(r.creditedTo)}</a>.</p>` : ""}
${r.storage ? `<p class="meta">${esc(r.storage)}</p>` : ""}
${open ? `<h2 id="addresses">Deposit addresses</h2>
${addresses.length ? `<ul>\n${addresses.map((a) => addressBlock(a, a.coin === v.pick)).join("\n")}\n</ul>` : `<p>${esc(NO_ADDRESS)}</p>`}
${v.viewer ? `<h2 id="picker">Get an address</h2>\n${pickerHtml(v)}` : ""}` : ""}
${r.membersOnly ? `<p class="meta">${esc(MEMBERS_ONLY)}</p>` : ""}
${depositsHtml(v)}
${historyHtml(v)}
${open ? coinsHtml(v) : ""}`);
}

const addressJson = (a: FundingAddress): Record<string, unknown> => ({
  coin: a.coin, symbol: a.symbol, network: a.network, address: a.address, minimum: a.minimum, cheap: a.cheap, stable: a.stable, older_wallet: !a.current, created_at: a.created_at,
});

export function fundingMarkdown(v: FundingPageView): string {
  const r = v.read;
  const nonPublic = r.visibility !== "public";
  const open = r.depositsOpen;
  const L: string[] = [`# Funding for ${codeSpan(r.space)}`, "", LEAD, "", `- space: ${v.spaceHref}.md`];
  L.push("", ...(open ? statements(r.minimumsAsOf, nonPublic, r.creditedTo) : closedStatements(nonPublic, r.creditedTo)).map((s) => `- ${s}`), "");
  if (r.creditedTo) L.push(`- credited to: ${v.basePath}/${r.creditedTo}.md`, "");
  if (r.storage) L.push(r.storage, "");
  if (open) {
    L.push("## Deposit addresses", "");
    const addresses = ordered(v);
    if (!addresses.length) L.push(NO_ADDRESS);
    for (const a of addresses) {
      L.push(`- ${a.coin === v.pick ? "your address, " : ""}${codeSpan(a.symbol ?? a.coin)}${a.network === null ? "" : ` on ${codeSpan(a.network)}`}: ${codeSpan(a.address)}${a.minimum === null ? "" : `, minimum ${codeSpan(a.minimum)}`}${a.cheap ? ", cheap network" : ""}${a.stable ? ", one for one" : ""}${a.current ? "" : ` (${OLDER_WALLET})`}`);
    }
    L.push("", `Make an address with a key: ${API_MAKE(r.space)}`, "");
  }
  if (r.membersOnly) L.push(MEMBERS_ONLY, "");
  const b = r.balance;
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
      L.push(`- ${e.at}: ${codeSpan(e.kind)} ${money(e.amount_micro_usd)}, balance after ${money(e.balance_after_micro_usd)}${e.deposit ? `, ${codeSpan(e.deposit.coin)} ${e.deposit.value_forwarded_coin === null ? "not sent" : codeSpan(e.deposit.value_forwarded_coin)}, transaction ${codeSpan(e.deposit.txid_in)}` : ""}`);
    }
    if (v.history.hasMore && v.history.nextBefore) L.push("", `- earlier entries: ${v.pagePath}.md?${new URLSearchParams({ before: v.history.nextBefore })}`);
    L.push("");
  }
  if (open && r.coins.length) {
    L.push("## Every coin", "", `Minimums as of ${r.minimumsAsOf}.`, "");
    for (const n of networksOf(r.coins)) {
      L.push(`### ${n.name}`, "");
      for (const c of n.coins) L.push(`- ${codeSpan(c.symbol)} (${codeSpan(c.coin)}): minimum ${codeSpan(c.minimum)}${notes(c) ? `, ${notes(c)}` : ""}`);
      L.push("");
    }
  }
  return L.join("\n");
}

export function fundingJson(v: FundingPageView, canonical: string): unknown {
  const r = v.read;
  const nonPublic = r.visibility !== "public";
  const open = r.depositsOpen;
  const b = r.balance;
  return {
    title: `Funding for ${r.space}`,
    url: canonical,
    about: LEAD,
    read_as: v.readAs,
    space: { name: r.space, page: v.spaceHref },
    deposits_open: open,
    statements: open ? statements(r.minimumsAsOf, nonPublic, r.creditedTo) : closedStatements(nonPublic, r.creditedTo),
    minimums_as_of: open ? r.minimumsAsOf : null,
    ...(r.creditedTo ? { credited_to: { name: r.creditedTo, page: `${v.basePath}/${r.creditedTo}` } } : {}),
    ...(r.storage ? { storage: r.storage } : {}),
    addresses: open ? ordered(v).map(addressJson) : [],
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
      history: { entries: v.history.entries, has_more: v.history.hasMore, next_before: v.history.nextBefore },
    } : {}),
    ...(v.history === "unreadable" ? { history: "could not be read just now" } : {}),
    coins: open ? networksOf(r.coins).map((n) => ({ network: n.name, coins: n.coins.map((c) => ({ coin: c.coin, symbol: c.symbol, minimum: c.minimum, cheap: c.cheap, stable: c.stable })) })) : [],
  };
}
