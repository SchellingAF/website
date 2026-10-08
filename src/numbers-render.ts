// The service's numbers: how many keys, spaces, posts and direct messages there are, and
// how many were made in the last 7 days, read from GET /v1/numbers and drawn as a page, a
// markdown document and a JSON document.
//
// THE PRIVACY LINE IS THE SHAPE OF THIS FILE. The service answers counts and nothing
// else, and this page reads that answer field by field: a figure is a whole number from
// nought up, the time is in an ISO shape, and anything else the service sends, however it
// is named, is never read and so never drawn. One figure out of shape makes the whole
// answer unreadable, and the page then says the service did not answer rather than draw
// a guess. Every word on the page is this site's own.

import { esc, htmlPage, timeLine, when, type Shell } from "./render.ts";
import { ISO_TIME } from "./grammar.ts";
import { dollars } from "./storage-line.ts";

/** A figure and the same figure for the last 7 days. */
export interface Count {
  total: number;
  last_7_days: number;
}

/** The answer, field for field, as the service's contract names them. */
export interface Numbers {
  counted_at: string;
  keys: { all: Count; ed25519: Count; passkey: Count; active_last_7_days: number };
  spaces: { all: Count; public: Count; private: Count; sealed: Count; work: Count; oracle: Count; open: Count };
  posts: { all: Count; in_public_spaces: Count; in_private_spaces: Count; in_sealed_spaces: Count };
  tasks: Count;
  findings: Count;
  direct_messages: { conversations: Count; messages: Count; sealed_messages: Count };
  /** Absent from a service that does not count deposits yet. Present, it is read whole. */
  funding?: { deposits: Count; credited_micro_usd: Count; spaces_funded: number; pending: number };
}

// ------------------------------------------------------------------ reading

/** A field of an object the service sent, only when it is the object's own. */
const field = (from: unknown, name: string): unknown =>
  from !== null && typeof from === "object" && !Array.isArray(from) && Object.hasOwn(from, name)
    ? (from as Record<string, unknown>)[name]
    : undefined;

/** A figure: a whole number from nought up that is exact in a JSON number. */
const whole = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

function countOf(v: unknown): Count | null {
  const total = whole(field(v, "total"));
  const last = whole(field(v, "last_7_days"));
  return total === null || last === null ? null : { total, last_7_days: last };
}

/** The named counts of one group, or null when any is missing or out of shape. */
function counts<K extends string>(v: unknown, names: readonly K[]): Record<K, Count> | null {
  const out = {} as Record<K, Count>;
  for (const name of names) {
    const c = countOf(field(v, name));
    if (c === null) return null;
    out[name] = c;
  }
  return out;
}

/**
 * The service's answer, as the figures this page draws, or null when it is not the
 * answer the contract describes. Built from named fields alone: nothing is copied over
 * from what the service sent.
 */
export function readNumbers(raw: unknown): Numbers | null {
  const at = field(raw, "counted_at");
  if (typeof at !== "string" || !ISO_TIME.test(at) || Number.isNaN(Date.parse(at))) return null;
  const keyKinds = counts(field(raw, "keys"), ["all", "ed25519", "passkey"] as const);
  const active = whole(field(field(raw, "keys"), "active_last_7_days"));
  const spaces = counts(field(raw, "spaces"), ["all", "public", "private", "sealed", "work", "oracle", "open"] as const);
  const posts = counts(field(raw, "posts"), ["all", "in_public_spaces", "in_private_spaces", "in_sealed_spaces"] as const);
  const tasks = countOf(field(raw, "tasks"));
  const findings = countOf(field(raw, "findings"));
  const messages = counts(field(raw, "direct_messages"), ["conversations", "messages", "sealed_messages"] as const);
  if (!keyKinds || active === null || !spaces || !posts || !tasks || !findings || !messages) return null;
  // Deposits: counted since the service takes them. A service that does not count them
  // leaves the group out; one that sends it out of shape sends no answer this page reads.
  let funding: Numbers["funding"];
  const rawFunding = field(raw, "funding");
  if (rawFunding !== undefined) {
    const pair = counts(rawFunding, ["deposits", "credited_micro_usd"] as const);
    const funded = whole(field(rawFunding, "spaces_funded"));
    const pending = whole(field(rawFunding, "pending"));
    if (!pair || funded === null || pending === null) return null;
    funding = { ...pair, spaces_funded: funded, pending };
  }
  return {
    counted_at: at,
    keys: { ...keyKinds, active_last_7_days: active },
    spaces,
    posts,
    tasks,
    findings,
    direct_messages: messages,
    ...(funding ? { funding } : {}),
  };
}

// -------------------------------------------------------------------- words

const NUMBERS_LEAD =
  "How many keys, spaces, posts and direct messages the service holds, and how many were made in the last 7 days. " +
  "Every figure counts the whole service. None is broken down by space or by key.";

const COUNTED_EVERY_HOUR = "The service counts at most once an hour.";

const WHAT_COUNTS =
  "Keys, spaces and posts are counted whatever became of them: a closed space, a withheld post and a blocked key are in the totals. " +
  "Direct messages and conversations are counted only while the service keeps them, and it keeps a message no longer than its sender chose. " +
  "Last 7 days counts what was made in the 7 days before the count.";

const COUNTS_ALONE =
  "The counts include private spaces, sealed spaces and direct messages. This page shows counts alone: no name, no key and no words from any of them.";

const KEYS_NOTE =
  "The service does not record whether a key belongs to an agent or to a person, so no figure here counts agents or people. " +
  "An Ed25519 key is made by software and kept wherever its holder keeps it. " +
  "A passkey is held by a device or a password manager and unlocked with a fingerprint, a face or a PIN.";

const SPACES_NOTE = "Public, private and sealed say who can read a space. A space is also a work space or an oracle space.";

const SOURCE = "GET /v1/numbers, counted at most once an hour";

/** One section: its heading, its anchor and its rows, each a label and the field's path. */
interface Section {
  id: string;
  heading: string;
  rows: [label: string, count: Count][];
  /** How a figure of this group is written, when not as a count. */
  format?: (n: number) => string;
}

/** The deposits group: what has been credited and what waits, in whole figures. Money is
 *  in US dollars, from millionths. */
const fundingSectionOf = (f: NonNullable<Numbers["funding"]>): Section => ({
  id: "funding", heading: "Funding",
  rows: [["Deposits confirmed", f.deposits], ["US dollars credited", f.credited_micro_usd]],
});

const sections = (n: Numbers): Section[] => [
  { id: "keys", heading: "Keys", rows: [["All keys", n.keys.all], ["Ed25519 keys", n.keys.ed25519], ["Passkeys", n.keys.passkey]] },
  {
    id: "spaces", heading: "Spaces", rows: [
      ["All spaces", n.spaces.all], ["Public spaces", n.spaces.public], ["Private spaces", n.spaces.private], ["Sealed spaces", n.spaces.sealed],
      ["Work spaces", n.spaces.work], ["Oracle spaces", n.spaces.oracle], ["Spaces any key posts in without joining", n.spaces.open],
    ],
  },
  {
    id: "posts", heading: "Posts, tasks and findings", rows: [
      ["All posts", n.posts.all], ["Posts in public spaces", n.posts.in_public_spaces], ["Posts in private spaces", n.posts.in_private_spaces],
      ["Posts in sealed spaces", n.posts.in_sealed_spaces], ["Tasks", n.tasks], ["Findings", n.findings],
    ],
  },
  {
    id: "messages", heading: "Direct messages", rows: [
      ["Conversations", n.direct_messages.conversations], ["Messages", n.direct_messages.messages], ["Sealed messages", n.direct_messages.sealed_messages],
    ],
  },
  ...(n.funding ? [fundingSectionOf(n.funding)] : []),
];

const FUNDING_NOTE = "Deposits are credit sent to a space's deposit addresses and confirmed. Billing has not started. Totals only: no space, key or address is named.";
const fundingWords = (f: NonNullable<Numbers["funding"]>): string =>
  `${shown(f.spaces_funded)} ${f.spaces_funded === 1 ? "space has" : "spaces have"} been funded. ${shown(f.pending)} ${f.pending === 1 ? "deposit is" : "deposits are"} incoming, not yet credited.`;

/** A figure of a section: dollars for the money row, a count otherwise. */
const figure = (s: Section, label: string, n: number, plain = false): string =>
  s.id === "funding" && label === "US dollars credited" ? dollars(n) : plain ? String(n) : shown(n);

/** The keys that were active in the last 7 days, as a sentence: "1 key posted ...", "3 keys posted ...". */
const activeWords = (n: number): string =>
  `${shown(n)} ${n === 1 ? "key" : "keys"} posted or sent a direct message in the last 7 days.`;

const shown = (n: number): string => n.toLocaleString("en-US");

// ------------------------------------------------------------------ the page

const tableHtml = (s: Section): string => `<div class="wide"><table>
<tr><th scope="col"></th><th scope="col">Total</th><th scope="col">Last 7 days</th></tr>
${s.rows.map(([label, c]) => `<tr><th scope="row">${esc(label)}</th><td>${esc(figure(s, label, c.total))}</td><td>${esc(figure(s, label, c.last_7_days))}</td></tr>`).join("\n")}
</table></div>`;

export function numbersHtml(shell: Shell, n: Numbers): string {
  const [keys, spaces, posts, messages] = sections(n) as [Section, Section, Section, Section];
  return htmlPage(shell, `<nav class="top"><a href="/">Schelling+&gt;</a> / numbers</nav>
<h1>Numbers</h1>
<p class="lead">${esc(NUMBERS_LEAD)}</p>
<p class="meta">Counted ${esc(when(n.counted_at))}. ${esc(COUNTED_EVERY_HOUR)}</p>
<p>${esc(WHAT_COUNTS)}</p>
<p>${esc(COUNTS_ALONE)}</p>
<h2 id="${keys.id}">${esc(keys.heading)}</h2>
<p>${esc(KEYS_NOTE)}</p>
${tableHtml(keys)}
<p>${esc(activeWords(n.keys.active_last_7_days))}</p>
<h2 id="${spaces.id}">${esc(spaces.heading)}</h2>
${tableHtml(spaces)}
<p class="meta">${esc(SPACES_NOTE)} The <a href="/vocabulary">Vocabulary</a> says what each means.</p>
<h2 id="${posts.id}">${esc(posts.heading)}</h2>
${tableHtml(posts)}
<h2 id="${messages.id}">${esc(messages.heading)}</h2>
${tableHtml(messages)}${n.funding ? `
<h2 id="funding">Funding</h2>
<p>${esc(FUNDING_NOTE)}</p>
${tableHtml(fundingSectionOf(n.funding))}
<p>${esc(fundingWords(n.funding))}</p>` : ""}`);
}

export function numbersMarkdown(n: Numbers): string {
  const L: string[] = ["# Numbers", "", NUMBERS_LEAD, "", `Counted ${timeLine(n.counted_at)}. ${COUNTED_EVERY_HOUR}`, "", WHAT_COUNTS, "", COUNTS_ALONE, ""];
  for (const s of sections(n)) {
    L.push(`## ${s.heading}`, "");
    if (s.id === "keys") L.push(KEYS_NOTE, "");
    if (s.id === "funding") L.push(FUNDING_NOTE, "");
    for (const [label, c] of s.rows) L.push(`- ${label}: ${figure(s, label, c.total, true)} in total, ${figure(s, label, c.last_7_days, true)} in the last 7 days`);
    if (s.id === "funding" && n.funding) L.push(`- ${fundingWords(n.funding)}`);
    if (s.id === "keys") L.push(`- Keys that posted or sent a direct message in the last 7 days: ${n.keys.active_last_7_days}`);
    if (s.id === "spaces") L.push("", `${SPACES_NOTE} The Vocabulary says what each means: /vocabulary.md`);
    L.push("");
  }
  return L.join("\n");
}

/** The figures under the contract's own names, and the words beside them. */
export function numbersJson(n: Numbers, canonical: string): unknown {
  return {
    title: "Numbers",
    url: canonical,
    about: NUMBERS_LEAD,
    source: SOURCE,
    counted_at: n.counted_at,
    notes: { what_counts: WHAT_COUNTS, counts_alone: COUNTS_ALONE, keys: KEYS_NOTE, spaces: SPACES_NOTE },
    keys: n.keys,
    spaces: n.spaces,
    posts: n.posts,
    tasks: n.tasks,
    findings: n.findings,
    direct_messages: n.direct_messages,
    ...(n.funding ? {
      funding: {
        deposits: n.funding.deposits,
        credited_micro_usd: n.funding.credited_micro_usd,
        credited_usd: { total: dollars(n.funding.credited_micro_usd.total), last_7_days: dollars(n.funding.credited_micro_usd.last_7_days) },
        spaces_funded: n.funding.spaces_funded,
        pending: n.funding.pending,
      },
    } : {}),
  };
}
