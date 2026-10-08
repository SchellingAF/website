// What a space's funding answer says, read field by field, and the model of the funding
// section on a space's page. GET /v1/spaces/{name}/funding and its history are the service's
// words and this file reads only the shapes it names: a field out of shape makes the whole
// answer unreadable, and the page then leaves the funding out and says nothing. Plain text:
// the renderers escape it. The storage line (src/storage-line.ts) stays the one rule for
// byte figures.

import { ISO_TIME } from "./grammar.ts";
import { dollars, storageLine } from "./storage-line.ts";

// ------------------------------------------------------------------ shapes

export interface FundingCoin {
  coin: string;
  symbol: string;
  name: string;
  network: string;
  family: string;
  minimum: string;
  cheap: boolean;
  stable: boolean;
}

export interface FundingAddress {
  coin: string;
  /** Null for an address of a coin the table no longer lists: the fields of the table's entry are then left out. */
  symbol: string | null;
  network: string | null;
  family: string;
  address: string;
  minimum: string | null;
  cheap: boolean;
  stable: boolean;
  /** False for an address made under a wallet that is no longer the current one. */
  current: boolean;
  created_at: string;
}

export interface PendingDeposit { coin: string; txid_in: string; value_coin: string | null; seen_at: string }
export interface HeldDeposit { coin: string; txid_in: string; value_forwarded_coin: string | null; usd_micro: number | null; reason: string; seen_at: string }
export interface RejectedDeposit { coin: string; txid_in: string; reason: string; seen_at: string }

export interface FundingBalance {
  micro: number;
  daysLeft: number | null;
  pending: PendingDeposit[];
  held: HeldDeposit[];
  rejected: RejectedDeposit[];
  counts: { pending: number; held: number; rejected: number; credited: number };
}

/** The answer, as far as this site reads it. `addresses` is null for a service that
 *  answers only what a space stores (an older one): the page then shows the storage line
 *  and nothing about deposits. */
export interface FundingRead {
  space: string;
  visibility: string;
  depositsOpen: boolean;
  storage: string | null;
  addresses: FundingAddress[] | null;
  coins: FundingCoin[];
  minimumsAsOf: string;
  /** True when the answer is the addresses alone: this reader is not a member of a
   *  private or sealed space. */
  membersOnly: boolean;
  /** The name of the space whose credit these deposits go to, for a replaced space; else null. */
  creditedTo: string | null;
  /** The balance and the deposits: present only for a reader who sees everything. */
  balance: FundingBalance | null;
}

// ----------------------------------------------------------------- reading

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const TICKER = /^[a-z0-9][a-z0-9./_-]{0,63}$/;
// Printable text in any script ("USD₮0"): no control, format, surrogate or line-separator
// character. Every use goes through an escape.
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}\p{S}\p{P} ]{0,63}$/u;
const FAMILY = /^[a-z]{2,16}$/;
const DECIMAL = /^[0-9]{1,30}(\.[0-9]{1,30})?([eE][+-]?[0-9]{1,3})?$/;
const ADDRESS = /^[A-Za-z0-9]{20,128}$/;
// A deposit's coin and transaction as the provider spelled them: printable ASCII, 64 and 200 at most.
const DEPOSIT_COIN = /^[\x20-\x7e]{1,64}$/;
const TXID = /^[\x20-\x7e]{1,200}$/;
const AS_OF = /^\d{4}-\d{2}-\d{2}$/;
const REASON = /^[^\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]{1,160}$/u;
const SPACE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VISIBILITY = /^(public|private|sealed)$/;

const text = (v: unknown, shape: RegExp): string | null => (typeof v === "string" && shape.test(v) ? v : null);
const time = (v: unknown): string | null => (typeof v === "string" && ISO_TIME.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);

function coinOf(v: unknown): FundingCoin | null {
  if (!isObject(v)) return null;
  const coin = text(own(v, "coin"), TICKER), symbol = text(own(v, "symbol"), LABEL), name = text(own(v, "name"), LABEL);
  const network = text(own(v, "network"), LABEL), family = text(own(v, "family"), FAMILY), minimum = text(own(v, "minimum"), DECIMAL);
  const cheap = own(v, "cheap"), stable = own(v, "stable");
  if (!coin || !symbol || !name || !network || !family || !minimum || typeof cheap !== "boolean" || typeof stable !== "boolean") return null;
  return { coin, symbol, name, network, family, minimum, cheap, stable };
}

/** One address object, as funding.address answers it and funding.get lists it. */
export function addressOf(v: unknown): FundingAddress | null {
  if (!isObject(v)) return null;
  const coin = text(own(v, "coin"), TICKER), family = text(own(v, "family"), FAMILY);
  const address = text(own(v, "address"), ADDRESS), created = time(own(v, "created_at"));
  const current = own(v, "current"), cheap = own(v, "cheap"), stable = own(v, "stable");
  if (!coin || !family || !address || !created || typeof current !== "boolean" || typeof cheap !== "boolean" || typeof stable !== "boolean") return null;
  // A coin the table dropped later has no symbol, network or minimum: they are left out.
  return { coin, symbol: text(own(v, "symbol"), LABEL), network: text(own(v, "network"), LABEL), family, address, minimum: text(own(v, "minimum"), DECIMAL), cheap, stable, current, created_at: created };
}


/** A list read item by item: an item out of shape is skipped, never the whole list. Only a
 *  list that is not an array, or longer than the product sends, is refused. */
function listOf<T>(v: unknown, one: (x: unknown) => T | null, max: number): T[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: T[] = [];
  for (const x of v) {
    const r = one(x);
    if (r !== null) out.push(r);
  }
  return out;
}

function pendingOf(v: unknown): PendingDeposit | null {
  if (!isObject(v)) return null;
  const coin = text(own(v, "coin"), DEPOSIT_COIN), txid = text(own(v, "txid_in"), TXID), seen = time(own(v, "seen_at"));
  const raw = own(v, "value_coin");
  const value = raw === null ? null : text(raw, DECIMAL);
  if (!coin || !txid || !seen || (raw !== null && value === null)) return null;
  return { coin, txid_in: txid, value_coin: value, seen_at: seen };
}

function heldOf(v: unknown): HeldDeposit | null {
  if (!isObject(v)) return null;
  const coin = text(own(v, "coin"), DEPOSIT_COIN), txid = text(own(v, "txid_in"), TXID), seen = time(own(v, "seen_at"));
  const rawForwarded = own(v, "value_forwarded_coin"), forwarded = rawForwarded === null ? null : text(rawForwarded, DECIMAL), reason = text(own(v, "reason"), REASON);
  const usd = own(v, "usd_micro");
  if (!coin || !txid || !seen || (rawForwarded !== null && forwarded === null) || !reason || !(usd === null || whole(usd))) return null;
  return { coin, txid_in: txid, value_forwarded_coin: forwarded, usd_micro: usd, reason, seen_at: seen };
}

function rejectedOf(v: unknown): RejectedDeposit | null {
  if (!isObject(v)) return null;
  const coin = text(own(v, "coin"), DEPOSIT_COIN), txid = text(own(v, "txid_in"), TXID), seen = time(own(v, "seen_at")), reason = text(own(v, "reason"), REASON);
  if (!coin || !txid || !seen || !reason) return null;
  return { coin, txid_in: txid, reason, seen_at: seen };
}

function balanceOf(f: Record<string, unknown>): FundingBalance | null {
  const micro = own(f, "balance_micro_usd");
  const days = own(f, "days_left");
  const d = own(f, "deposits");
  if (!whole(micro) || !(days === null || days === undefined || whole(days)) || !isObject(d)) return null;
  const pending = listOf(own(d, "pending"), pendingOf, 20), held = listOf(own(d, "held"), heldOf, 20), rejected = listOf(own(d, "rejected"), rejectedOf, 20);
  const counts = { pending: own(d, "pending_count"), held: own(d, "held_count"), rejected: own(d, "rejected_count"), credited: own(d, "credited_count") };
  if (!pending || !held || !rejected || !whole(counts.pending) || !whole(counts.held) || !whole(counts.rejected) || !whole(counts.credited)) return null;
  return { micro, daysLeft: whole(days) ? days : null, pending, held, rejected, counts: counts as FundingBalance["counts"] };
}

/**
 * The funding answer, read exactly, or null when it is not one this reads. An answer with
 * no `addresses` is an older service's, which says what a space stores and nothing about
 * deposits: it reads as storage alone. An answer with `addresses` must carry the coins, the
 * date of the minimums and whether deposits are open, and either every figure of a full
 * answer or the members-only marker of an addresses-only one.
 */
export function readFunding(answer: unknown): FundingRead | null {
  if (!isObject(answer)) return null;
  const visibility = text(own(answer, "visibility"), VISIBILITY);
  const space = text(own(answer, "space"), SPACE_NAME);
  if (!visibility || !space || own(answer, "billing") !== "not_started") return null;
  const hasBytes = own(answer, "bytes") !== undefined;
  const storage = hasBytes ? storageLine(answer) : null;
  if (hasBytes && storage === null) return null;

  if (own(answer, "addresses") === undefined) {
    return storage === null ? null
      : { space, visibility, depositsOpen: false, storage, addresses: null, coins: [], minimumsAsOf: "", membersOnly: false, creditedTo: null, balance: null };
  }
  const open = own(answer, "deposits_open");
  // The coins and the day of their minimums come only when asked for (?coins=true): an answer
  // has both or neither.
  const hasCoins = own(answer, "coins") !== undefined || own(answer, "minimums_as_of") !== undefined;
  const asOf = hasCoins ? text(own(answer, "minimums_as_of"), AS_OF) : "";
  const addresses = listOf(own(answer, "addresses"), addressOf, 400);
  const coins = hasCoins ? listOf(own(answer, "coins"), coinOf, 400) : [];
  if (typeof open !== "boolean" || asOf === null || !addresses || !coins) return null;
  const rawCredited = own(answer, "credited_to");
  let creditedTo: string | null = null;
  if (rawCredited !== undefined && rawCredited !== null) {
    creditedTo = isObject(rawCredited) ? text(own(rawCredited, "name"), SPACE_NAME) : null;
    if (creditedTo === null) return null;
  }

  const members = own(answer, "members_only");
  if (members !== undefined) {
    // The addresses alone: no byte figure, no balance, no deposits.
    if (!Array.isArray(members) || hasBytes || own(answer, "balance_micro_usd") !== undefined || own(answer, "deposits") !== undefined) return null;
    return { space, visibility, depositsOpen: open, storage: null, addresses, coins, minimumsAsOf: asOf, membersOnly: true, creditedTo, balance: null };
  }
  const balance = balanceOf(answer);
  if (!hasBytes || !balance) return null;
  return { space, visibility, depositsOpen: open, storage, addresses, coins, minimumsAsOf: asOf, membersOnly: false, creditedTo, balance };
}

// -------------------------------------------------------------------- history

export interface HistoryEntry {
  entry_id: string;
  kind: string;
  amount_micro_usd: number;
  balance_after_micro_usd: number;
  at: string;
  deposit: { coin: string; network: string | null; txid_in: string; value_forwarded_coin: string | null; address: string } | null;
}

export interface FundingHistory {
  entries: HistoryEntry[];
  hasMore: boolean;
  nextBefore: string | null;
}

const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
const ENTRY_ID = /^[1-9][0-9]{0,18}$/;

function entryOf(v: unknown): HistoryEntry | null {
  if (!isObject(v)) return null;
  const rawId = own(v, "entry_id");
  const id = typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId > 0 ? String(rawId) : text(rawId, ENTRY_ID);
  const kind = text(own(v, "kind"), /^[a-z][a-z_]{0,31}$/), at = time(own(v, "at"));
  const amount = own(v, "amount_micro_usd"), after = own(v, "balance_after_micro_usd");
  if (!id || !kind || !at || !integer(amount) || !integer(after)) return null;
  const d = own(v, "deposit");
  if (d === null) return { entry_id: id, kind, amount_micro_usd: amount, balance_after_micro_usd: after, at, deposit: null };
  if (!isObject(d)) return null;
  const coin = text(own(d, "coin"), DEPOSIT_COIN), txid = text(own(d, "txid_in"), TXID), rawForwarded = own(d, "value_forwarded_coin"), forwarded = rawForwarded === null ? null : text(rawForwarded, DECIMAL);
  const address = text(own(d, "address"), ADDRESS);
  const rawNet = own(d, "network");
  const network = rawNet === null || rawNet === undefined ? null : text(rawNet, LABEL);
  if (!coin || !txid || !address || (rawForwarded !== null && forwarded === null) || (rawNet != null && network === null)) return null;
  return { entry_id: id, kind, amount_micro_usd: amount, balance_after_micro_usd: after, at, deposit: { coin, network, txid_in: txid, value_forwarded_coin: forwarded, address } };
}

/** The history answer, or null when it is not the one the contract describes. */
export function readHistory(answer: unknown): FundingHistory | null {
  if (!isObject(answer)) return null;
  const entries = listOf(own(answer, "entries"), entryOf, 200);
  const more = own(answer, "has_more");
  const next = own(answer, "next_before");
  const rawNext = typeof next === "number" && Number.isSafeInteger(next) && next > 0 ? String(next) : next === null ? null : text(next, ENTRY_ID);
  if (!entries || typeof more !== "boolean" || (next !== null && rawNext === null)) return null;
  return { entries, hasMore: more && rawNext !== null, nextBefore: more ? rawNext : null };
}

// ---------------------------------------------------------------------- words

/** Dollars from millionths, signed: a debit shows its minus once billing starts. */
export const money = (micro: number): string => (micro < 0 ? `-${dollars(-micro)}` : dollars(micro));

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** What happens to the credit: it stays with this space, or, for a replaced space, it goes to the successor. */
export const creditLine = (creditedTo: string | null): string => creditedTo === null
  ? "Credit belongs to this space. It is not refundable and cannot move to another space."
  : `This space was replaced. Deposits to these addresses credit the space ${creditedTo}. Credit is not refundable.`;

/** The statements every funding page makes, and only these. The last is for a private or
 *  sealed space alone. */
export function statements(asOf: string, nonPublic: boolean, creditedTo: string | null = null): string[] {
  const list = [
    "Anyone can add credit to this space by sending a coin to one of its deposit addresses. Making an address needs a key.",
    "Deposits are visible on a public blockchain: anyone can see the address, the amount and the transaction.",
    "Each address belongs to one coin on one network. A coin sent to it on any other network is not credited, even when this space has an address on that network. A network not listed here is not offered.",
    `A deposit below the minimum shown is not credited. The minimums and the cheap marks are CryptAPI's on ${asOf} and can change.`,
    "A token not in this list is not credited, even on the right network.",
    "Credit is kept in US dollars, rounded down to a millionth of a dollar. USDT, USDC, USDC.e, USDT0, DAI and PYUSD count one for one. Any other coin counts at CryptAPI's US dollar price when the deposit is confirmed. Both are counted after CryptAPI's fee and the network's fee.",
    "A deposit shows as incoming until it is confirmed, and is credited only then. Some deposits are held for review and are not credited.",
    creditLine(creditedTo),
    "Billing has not started: nothing is taken from the balance.",
  ];
  if (nonPublic) list.push("The balance and deposits are shown to members only. The deposit addresses are public, and deposits to them are visible on a public blockchain.");
  return list;
}

/** What a page says while deposits are closed: the statements that stay true. */
export function closedStatements(nonPublic: boolean, creditedTo: string | null = null): string[] {
  const list = [
    "Deposits are not open on this server.",
    creditLine(creditedTo),
    "Billing has not started: nothing is taken from the balance.",
  ];
  if (nonPublic) list.push("The balance and deposits are shown to members only.");
  return list;
}

export const CLOSED = "Deposits are not open on this server.";
export const MEMBERS_ONLY = "This space's balance and deposits are shown to its members only.";
export const NO_ADDRESS = "No deposit address has been made yet.";
export const OLDER_WALLET = "older wallet, still credited";

// -------------------------------------------------------------- the section

export interface SectionAddress { coin: string; symbol: string | null; network: string | null; address: string; minimum: string | null; older: boolean }

/** The funding section of a space's page. */
export interface FundingSection {
  space: string;
  storage: string | null;
  balance: string | null;
  incoming: string | null;
  held: string | null;
  /** Null when the service said nothing about deposits (an older one). */
  addresses: SectionAddress[] | null;
  depositsOpen: boolean;
  membersOnly: boolean;
  /** The space that receives the deposits of a replaced space. */
  creditedTo: string | null;
}

/** The section for a space's page, or null when the answer is not one this reads exactly. */
export function fundingSection(answer: unknown): FundingSection | null {
  const f = readFunding(answer);
  if (!f) return null;
  const b = f.balance;
  return {
    space: f.space,
    storage: f.storage,
    balance: b ? `Balance: ${money(b.micro)}.` : null,
    incoming: b && b.counts.pending > 0 ? `${plural(b.counts.pending, "deposit", "deposits")} incoming, not yet credited.` : null,
    held: b && b.counts.held > 0 ? `${plural(b.counts.held, "deposit", "deposits")} held, not credited.` : null,
    addresses: f.addresses === null ? null
      : f.addresses.map((a) => ({ coin: a.coin, symbol: a.symbol, network: a.network, address: a.address, minimum: a.minimum, older: !a.current })),
    depositsOpen: f.depositsOpen,
    membersOnly: f.membersOnly,
    creditedTo: f.creditedTo,
  };
}
