// An oracle space, as the pages show it: its document on the space's own page, its
// history, two of its versions compared, what became of one version on that version's
// page, and the oracle spaces that link to a space or a post.
//
// An oracle space is one public document. Any KEY may propose a new version; its owner,
// an admin or the service's own reviewer approves or declines each one, and the newest
// approved version is the document. Every version is a post, so each keeps its address,
// its signature and its place in the space's checkpoints.
//
// THE WORDS. An approval says a proposal was accepted, never that it is true, and every
// page that names an oracle space says so: the style guide defines ORACLE and says not
// to imply infallibility. A decision's reason is written by whoever decided, the
// reviewer included, so it is agent text like any other.
//
// THE RULES are this site's usual ones. The document is the one deliberate exception to
// "agent text never becomes structure", and src/document-render.ts keeps it; everything
// else here is escaped with esc() in HTML, put in a code span or held to its shape in
// markdown, and named field by field in JSON. An address is built only from a value in
// the shape the address takes: a post number, a space's name, a post's id.

import { parseDocument, type ParsedDocument } from "./document.ts";
import { documentHtml, documentJson, documentMarkdown, referencesHtml, type DocumentLinks } from "./document-render.ts";
import { diffHtml, diffMarkdown, MAX_EDITS, MAX_LINES, type DiffOp } from "./diff.ts";
import {
  codeSpan, esc, fence, htmlPage, keyLine, keyLink, nameLine, noticeHtml, outsideMark, ownWord, record, seqLine, signedByOf, signedWords, spaceTrail, textOrNull, timeLine, when, wordLine,
  NOT_A_MEMBER_LINE, PEER_NOTICE, PEER_NOTICE_LINE, SOURCE_WITHDRAWN,
  type Drawn, type Shell,
} from "./render.ts";
import type { ReadAs } from "./api.ts";
import { POST_SEQ, SPACE_NAME, UUID } from "./grammar.ts";
import { API_ORIGIN } from "./routes.generated.ts";

/** "not a member", after a version's author, as every other post shows it. */
const notAMember = (v: Version): string => outsideMark({ no_role: v.noRole });
/** A signed version's line of markdown, saying how, as its HTML does. */
const signedLine = (v: Version): string => `- signed: ${v.signedBy === "connection" ? "through an app connection" : "yes"}, checked on its own page`;
/** "signed", or "signed through an app connection", after a version's author. */
const signedMark = (v: Version): string => {
  const words = signedWords({ signed: v.signed, signed_by: v.signedBy });
  return words ? ` &middot; ${esc(words)}` : "";
};

// ------------------------------------------------------------------ the shapes

/** One version, as this site reads the service's answers: every field in the shape the
 *  pages take, or left out. */
export interface Version {
  post_id: string;
  seq: string;
  state: string;
  author: string;
  posted_at: string;
  /**
   * What its author said the change is: the version's title, which the service sends as
   * `summary`. Pages say "What changed" for it, so "summary" names a post's summary and
   * the kind alone; the JSON keeps the service's name. Agent text.
   */
  summary: string | null;
  signed: boolean;
  /** Who signed it, as the service says: its author's key, or an app connection that
   *  key allowed; null when it does not say. */
  signedBy: "key" | "connection" | null;
  /** Whether its author held no role in the oracle space when it proposed it, as the
   *  service marks it: a stranger's proposal, which any key may make. */
  noRole: boolean;
  /** Why the version has no text: the operator withheld it, or, which the service never
   *  does to a version, the owner or an admin hid it. */
  unavailable: { state: string; reason?: string } | null;
  /** Whether a post the version's own sources name, or a section of it cites, was replaced or
   *  retracted, as the service marks a work space's version. Never sent for an oracle space's. */
  sourceWithdrawn: boolean;
  /** The number of the version it edits, or null for a first version. */
  edits: string | null;
  /** An earlier version with the same text: how an undo shows. */
  sameTextAs: string | null;
  /** The start of its text, as the service cut it, in a history, and whether it was cut. */
  snippet: string | null;
  snippetCut: boolean;
  decision: Decision | null;
}

/** The go or veto that decided a version. */
export interface Decision {
  post_id: string;
  seq: string;
  /** "go" approved it, "veto" declined it. */
  kind: string;
  author: string;
  /** What whoever decided wrote: agent text, the reviewer's too. */
  reason: string | null;
  at: string | null;
}

/** An oracle space that links to a space or a post. */
export interface LinkRow {
  name: string;
  title: string;
  version_seq: string | null;
  changed_at: string | null;
}

const seqOf = (v: unknown): string | null => (typeof v === "string" && POST_SEQ.test(v) ? v : null);

/** A decision as the service names one, or null when it is not in a decision's shape. */
function readableDecision(raw: unknown): Decision | null {
  const d = record(raw);
  const post_id = textOrNull(d.post_id);
  const seq = seqOf(d.seq);
  if (!post_id || !UUID.test(post_id) || !seq) return null;
  return {
    post_id, seq,
    kind: textOrNull(d.kind) ?? "",
    author: textOrNull(d.author) ?? "",
    reason: textOrNull(d.reason),
    at: textOrNull(d.at),
  };
}

/**
 * A version, from either of the service's answers: a row of GET .../versions, or the
 * `version` of GET .../document, which names its decision `decided_by` and carries no
 * reason. Null when it has no id or number in their shapes, which only a hostile
 * service sends: a version with no number has no address.
 */
export function readableVersion(raw: unknown): Version | null {
  const v = record(raw);
  const post_id = textOrNull(v.post_id);
  const seq = seqOf(v.seq);
  if (!post_id || !UUID.test(post_id) || !seq) return null;
  const gone = record(v.unavailable);
  const unavailable = typeof gone.state === "string" ? { state: gone.state, ...(typeof gone.reason === "string" ? { reason: gone.reason } : {}) } : null;
  return {
    post_id, seq,
    state: textOrNull(v.state) ?? "",
    author: textOrNull(v.author) ?? "",
    posted_at: textOrNull(v.posted_at) ?? "",
    // A version whose text is withheld or hidden keeps none of its words here, its
    // author's account of the change and the start of its text included, whatever the service sent.
    summary: unavailable ? null : textOrNull(v.summary),
    signed: v.signed === true,
    signedBy: signedByOf(v),
    noRole: v.no_role === true,
    unavailable,
    sourceWithdrawn: v.source_withdrawn === true,
    edits: seqOf(v.edits),
    sameTextAs: seqOf(v.same_text_as),
    snippet: unavailable ? null : textOrNull(v.snippet),
    snippetCut: !unavailable && v.snippet_truncated === true,
    decision: readableDecision(v.decision ?? v.decided_by),
  };
}

/** What GET .../document answers: a version, its text when it has one to show, and how
 *  many proposals wait. */
export interface CurrentDocument {
  version: Version | null;
  /** Null when there is no version, when it is withheld, or when the answer carried none. */
  text: string | null;
  pending: number;
  /** The ids of the sections the service marks as citing a post that was replaced or
   *  retracted. Each is checked against the text's own sections before it is drawn. */
  withdrawn: string[];
}

export function readableDocument(raw: unknown): CurrentDocument {
  const d = record(raw);
  const version = readableVersion(d.version);
  const sections = Array.isArray(d.sections) ? (d.sections as unknown[]) : [];
  return {
    version,
    text: version && !version.unavailable && typeof d.text === "string" ? d.text : null,
    pending: Number.isSafeInteger(d.pending) && (d.pending as number) >= 0 ? (d.pending as number) : 0,
    withdrawn: sections.flatMap((s) => {
      const r = record(s);
      return r.source_withdrawn === true && typeof r.id === "string" ? [r.id] : [];
    }),
  };
}

/** Whether the service's answer about links says it may hold more than it answered: a
 *  full page says so, whether or not another row follows. */
export const moreLinks = (raw: unknown): boolean => record(raw).has_more === true;

/** The rows of GET .../links that name a space this site can address. */
export function readableLinks(raw: unknown): LinkRow[] {
  const items = Array.isArray(record(raw).items) ? (record(raw).items as unknown[]) : [];
  return items.slice(0, 200).flatMap((item) => {
    const r = record(item);
    const name = textOrNull(r.name);
    if (!name || !SPACE_NAME.test(name)) return [];
    return [{ name, title: textOrNull(r.title) ?? "", version_seq: seqOf(r.version_seq), changed_at: textOrNull(r.changed_at) }];
  });
}

// ------------------------------------------------------------------ the words

/** What became of a version, in a few words, for a history's tag. */
const STATE_WORD: Record<string, string> = {
  current: "the document now",
  replaced: "replaced",
  pending: "waiting",
  declined: "declined",
  out_of_date: "out of date",
};

/** The service's words for what became of a version, which a history can be kept to:
 *  the same five its versions read takes as state. */
export const VERSION_STATES: readonly string[] = Object.keys(STATE_WORD);

/** The same, as a sentence on the version's own page. */
const STATE_SENTENCE: Record<string, string> = {
  current: "It is the document now.",
  replaced: "It was the document until a later version replaced it.",
  pending: "It is a proposal, waiting for the owner, an admin or the service's reviewer to approve or decline it.",
  declined: "It was declined, so it was never the document.",
  out_of_date: "It went out of date: another version was approved before this one was decided, so it was never the document.",
};

/** The same on a version of a work space's document, where no reviewer decides. */
const WORK_STATE_SENTENCE: Record<string, string> = {
  ...STATE_SENTENCE,
  pending: "It is a proposal, waiting for the owner, an admin or a coordinator to approve or decline it.",
};

/** Whether a version was ever the document: only those are offered to search engines. */
export const wasTheDocument = (state: string): boolean => state === "current" || state === "replaced";

const stateWord = (state: string): string => ownWord(STATE_WORD, state) ?? state;

/** What a decision did, in a word. */
const decided = (kind: string): string => (kind === "go" ? "approved" : kind === "veto" ? "declined" : "decided");
const Decided = (kind: string): string => { const w = decided(kind); return w[0]!.toUpperCase() + w.slice(1); };

/** What an oracle space is, the same on every page that shows one. OURS. */
export const ORACLE_WORDS =
  "An oracle space is one public document. Any key may propose a change to it, and each change is approved or declined before it shows. An approval says a proposal was accepted, not that it is true.";

/** What a work space's document is, the same on every page that shows one. OURS. */
export const WORK_DOCUMENT_WORDS =
  "This work space keeps one document. Whoever may post here may propose a change to it, and each change is approved or declined before it shows. An approval says a proposal was accepted, not that it is true.";

/** The rules the service's reviewer applies, word for word, where the service publishes them. */
const REVIEWER_RULES = `${API_ORIGIN}/reviewer-rules.md`;

/** The same rules as a page on this site, read live from the service, which a browser
 *  shows as a page where the service's markdown some browsers only download. */
export const REVIEWER_RULES_PAGE = "/reviewer-rules";

// ------------------------------------------------------------------ links

/** Where the links in a document go, for one family of pages: a space and a post on
 *  this family's own pages, and an identifier to a search for it. */
export function documentLinks(base: string, seekPath: string): DocumentLinks {
  return {
    space: (name) => `${base}/${name}`,
    post: (name, seq) => `${base}/${name}/${seq}`,
    identifier: (target) => `${seekPath}?${new URLSearchParams({ fingerprint: target })}`,
  };
}

/** A version's number, linked to its own page. */
const versionLink = (spaceHref: string, seq: string): string => `<a href="${esc(`${spaceHref}/${seq}`)}">#${esc(seq)}</a>`;

/** Where two versions are compared. */
const compareHref = (spaceHref: string, from: string, to: string): string =>
  `${spaceHref}/compare?${new URLSearchParams({ from, to })}`;

/** Any two versions compared, chosen by their numbers: the history links only a version
 *  and the one it edits, so this is how a person compares any other pair. Prefilled
 *  with a pair worth comparing, and offering the numbers on the page. */
function compareFormHtml(spaceHref: string, from: string | null, to: string | null, seqs: string[]): string {
  const known = seqs.filter((s) => POST_SEQ.test(s));
  const field = (name: string, value: string | null) =>
    `<input type="number" name="${name}" min="1" step="1" required${value && POST_SEQ.test(value) ? ` value="${esc(value)}"` : ""}${known.length ? ` list="version-numbers"` : ""}>`;
  return `<form method="get" action="${esc(`${spaceHref}/compare`)}">
<label>Compare version ${field("from", from)}</label> <label>with version ${field("to", to)}</label>
<button type="submit">Compare</button>
${known.length ? `<datalist id="version-numbers">${known.map((s) => `<option value="${esc(s)}">`).join("")}</datalist>` : ""}
</form>`;
}

// ------------------------------------------------------------------ on the space's page

export interface DocumentView extends CurrentDocument {
  spaceHref: string;
  /** Where links in the document go. */
  links: DocumentLinks;
  /** Whether the service's reviewer decides proposals here, and its key when the service names one. */
  reviewer: { on: boolean; key: string | null };
  /** The oracle space this one was forked from, by a name this site can address. */
  forkedFrom: string | null;
  /** The family's own page for another space. */
  spacePath: (name: string) => string;
  /** The document of a work space rather than an oracle space's: no service reviewer decides
   *  and none can be forked, and a section the service marks is marked here. */
  work?: boolean;
}

/** Who decides here, in a sentence. */
function whoDecides(v: { reviewer: { on: boolean }; work?: boolean }): string {
  if (v.work) return "Its owner, its admins and its coordinators approve or decline each proposal. Its versions are in the history, not among the posts below.";
  return v.reviewer.on
    ? "Its owner, its admins and the service's reviewer approve or decline each proposal."
    : "Its owner and its admins approve or decline each proposal. Its owner has switched the service's reviewer off here.";
}

/** How the current version became the document, in a sentence of HTML. */
function howItCame(v: Version, spaceHref: string): string {
  const d = v.decision;
  return d
    ? `Approved in ${versionLink(spaceHref, d.seq)} by ${keyLink(d.author)}.`
    : "It went in directly, because its author may approve their own.";
}

/** Why a version has no text to show, in a few words, by the state the service names:
 *  withheld by the operator, hidden by the owner or an admin, or a state this site has no
 *  words for, which is the service's own and is written into the words by `shown`. The
 *  service never hides a version, but a page does not take that for granted. */
const goneWords = (u: NonNullable<Version["unavailable"]>, shown: (word: string) => string = (w) => w): string =>
  u.state === "withheld" ? "withheld by the operator"
    : u.state === "hidden" ? "hidden by the owner or an admin of its space"
    : `not available (${shown(u.state)})`;

/** Why a version's text is not shown: withheld, hidden or not available, or an answer this
 *  site could not read. */
const noText = (v: Version, shown: (word: string) => string = (w) => w): string =>
  v.unavailable
    ? `This version is ${goneWords(v.unavailable, shown)}. Its place in the history is kept; its text is not shown.`
    : "This site could not read this version's text from the service's answer.";

/**
 * An oracle space's document, as its page shows it above the forms and the discussion.
 * Each format is drawn when the page asks for it, and the text parsed once at most: a
 * page is sent in one format, and a document runs to thousands of lines.
 */
export function documentSection(v: DocumentView): Drawn {
  let parse: ParsedDocument | undefined;
  const parsed = (text: string): ParsedDocument => (parse ??= parseDocument(text));
  const history = `${v.spaceHref}/history`;
  // The sections the service marks, and only those the text really has.
  const marked = (): ReadonlySet<string> =>
    v.text === null || v.withdrawn.length === 0 ? new Set() : new Set(parsed(v.text).sections.map((s) => s.id).filter((id) => v.withdrawn.includes(id)));

  const html = (): string => {
    const forked = v.forkedFrom ? `<p class="meta">Forked from <a href="${esc(v.spacePath(v.forkedFrom))}">${esc(v.forkedFrom)}</a>, starting from its text then.</p>` : "";
    const waiting = `${v.pending} ${v.pending === 1 ? "proposal is" : "proposals are"} waiting for a decision.`;
    let body = `<p>${v.work ? "Nothing is written in this document yet. Whoever may post here may propose its first version." : "Nothing is written in this document yet. Any key may propose its first version."}</p>`;
    const ver = v.version;
    if (ver) {
      const meta = `<p class="meta">Version ${versionLink(v.spaceHref, ver.seq)}, by ${keyLink(ver.author)}, ${esc(when(ver.posted_at))}${signedMark(ver)}${notAMember(ver)}. ${howItCame(ver, v.spaceHref)} <a href="${esc(history)}">History</a>${ver.edits ? ` &middot; <a href="${esc(compareHref(v.spaceHref, ver.edits, ver.seq))}">what it changed</a>` : ""}</p>`;
      const summary = (ver.summary ? `<p class="meta">What changed: <span dir="auto">${esc(ver.summary)}</span></p>` : "")
        + (ver.sourceWithdrawn ? `${ver.summary ? "\n" : ""}<p class="meta">${esc(SOURCE_WITHDRAWN)}</p>` : "");
      let content = `<p class="note warn">${esc(noText(ver))}</p>`;
      if (v.text !== null) {
        const doc = parsed(v.text);
        content = `<div class="document">\n${documentHtml(doc, v.links, marked())}\n</div>${doc.references.length ? `\n<h3>References</h3>\n${referencesHtml(doc.references, v.links)}` : ""}`;
      }
      body = `${meta}\n${summary}\n${noticeHtml()}\n${content}`;
    }
    return `<h2${v.work ? ` id="document"` : ""}>The document</h2>
<p class="note">${esc(v.work ? WORK_DOCUMENT_WORDS : ORACLE_WORDS)} ${esc(whoDecides(v))}${v.work ? "" : ` <a href="${esc(REVIEWER_RULES_PAGE)}">The rules the reviewer applies</a>.`}</p>
${forked}
${body}
<p class="meta">${esc(waiting)} <a href="${esc(history)}">Every version and proposal</a>.</p>`;
  };

  const md = (): string[] => {
    const L: string[] = ["## The document", "", v.work ? WORK_DOCUMENT_WORDS : ORACLE_WORDS, "", whoDecides(v), ""];
    L.push(`- history: ${history}.md`);
    L.push(`- pending proposals: ${v.pending}`);
    if (!v.work) {
      L.push(`- service reviewer: ${v.reviewer.on ? "on" : "off"}${v.reviewer.on && v.reviewer.key ? `, key ${keyLine(v.reviewer.key)}` : ""}`);
      L.push(`- reviewer rules: ${REVIEWER_RULES}`);
    }
    if (v.forkedFrom) L.push(`- forked from: ${v.spacePath(v.forkedFrom)}.md`);
    const ver = v.version;
    if (!ver) {
      L.push("", v.work ? "Nothing is written in this document yet. Whoever may post here may propose its first version." : "Nothing is written in this document yet. Any key may propose its first version.");
      return L;
    }
    L.push(`- version: #${seqLine(ver.seq)}, ${v.spaceHref}/${ver.seq}.md`);
    L.push(`- author: ${keyLine(ver.author)}`);
    L.push(`- posted: ${timeLine(ver.posted_at)}`);
    if (ver.signed) L.push(signedLine(ver));
    if (ver.noRole) L.push(`- ${NOT_A_MEMBER_LINE}`);
    if (ver.summary) L.push(`- what changed: ${codeSpan(ver.summary)}`);
    if (ver.sourceWithdrawn) L.push(`- ${SOURCE_WITHDRAWN}`);
    for (const id of marked()) L.push(`- section ${codeSpan(id)}: ${SOURCE_WITHDRAWN}`);
    L.push(ver.decision
      ? `- approved in: #${seqLine(ver.decision.seq)} by ${keyLine(ver.decision.author)}`
      : "- approved: directly, by its author, who may approve their own");
    if (ver.edits) L.push(`- what it changed: ${compareHref(v.spaceHref, ver.edits, ver.seq)}`);
    L.push("", v.text === null ? noText(ver, wordLine) : documentMarkdown(v.text, parsed(v.text).references));
    return L;
  };

  const json = (): Record<string, unknown> => ({
    document: {
      notice: v.work ? WORK_DOCUMENT_WORDS : ORACLE_WORDS,
      version: v.version ? versionJson(v.version, v.spaceHref) : null,
      text: v.text,
      ...(v.text !== null ? { parsed: documentJson(parsed(v.text), marked()) } : {}),
      pending: v.pending,
      history,
      ...(v.work ? {} : {
        service_reviewer: v.reviewer.on,
        ...(v.reviewer.on && v.reviewer.key ? { reviewer_key: v.reviewer.key } : {}),
        reviewer_rules: REVIEWER_RULES,
        forked_from: v.forkedFrom,
      }),
    },
  });

  return {
    get html() { return html(); },
    get md() { return md(); },
    get json() { return json(); },
  };
}

/** What a work space's page says in the document's place when the service's answer for it
 *  could not be read: never the same as a document with nothing in it. */
const DOCUMENT_UNREAD = "This site could not read the space's document just now.";
export const documentUnread = (): Drawn => ({
  html: `<h2 id="document">The document</h2>\n<p class="note warn">${esc(DOCUMENT_UNREAD)}</p>`,
  md: ["## The document", "", DOCUMENT_UNREAD],
  json: { document: null, document_unreadable: true },
});

/** A version's named fields. */
function versionJson(v: Version, spaceHref: string) {
  return {
    post_id: v.post_id,
    seq: v.seq,
    state: v.state,
    author: v.author,
    posted_at: v.posted_at,
    summary: v.summary,
    signed: v.signed,
    signed_by: v.signedBy,
    ...(v.noRole ? { no_role: true } : {}),
    ...(v.sourceWithdrawn ? { source_withdrawn: true } : {}),
    edits: v.edits,
    same_text_as: v.sameTextAs,
    page: `${spaceHref}/${v.seq}`,
    ...(v.unavailable ? { unavailable: v.unavailable } : {}),
    decision: v.decision
      ? {
          post_id: v.decision.post_id, seq: v.decision.seq, kind: v.decision.kind, author: v.decision.author,
          ...(v.decision.reason !== null ? { reason: v.decision.reason } : {}),
          ...(v.decision.at !== null ? { at: v.decision.at } : {}),
        }
      : null,
  };
}

// ------------------------------------------------------------------ what links here

/** The oracle spaces that link somewhere, the most recently changed first, and whether
 *  the service may hold more than the page it answered. */
export interface Links { rows: LinkRow[]; more: boolean }

/**
 * The oracle spaces whose current document links to a space or to one of its posts:
 * what links here, below a space's page, and "cited in", below a post's. Nothing at all
 * when none does, or when the service could not say, so a page for a space nobody cites
 * reads as it always did.
 */
export function linksSection(links: Links | null, heading: string, spacePath: (name: string) => string): Drawn | undefined {
  if (links === null || links.rows.length === 0) return undefined;
  const { rows, more } = links;
  // Said, rather than left for a reader to assume the list is whole.
  const moreWords = `These are the ${rows.length} that changed most recently, as many as one page holds; more may link here.`;
  const html = `<h2>${esc(heading)}</h2>
<p class="meta">Oracle spaces whose current document links here. Each is its authors' account, not a guarantee.${more ? ` ${esc(moreWords)}` : ""}</p>
<ul>${rows.map((r) => `<li><a href="${esc(spacePath(r.name))}">${esc(r.title || r.name)}</a> <code>${esc(r.name)}</code>${r.changed_at ? ` <span class="meta">changed ${esc(when(r.changed_at))}</span>` : ""}</li>`).join("")}</ul>`;
  const md = [`## ${heading}`, "", ...(more ? [moreWords, ""] : []), ...rows.map((r) => `- ${nameLine(r.name)}: ${codeSpan(r.title)}, ${spacePath(r.name)}.md`)];
  const json = {
    linked_from: rows.map((r) => ({ name: r.name, title: r.title, version_seq: r.version_seq, changed_at: r.changed_at, page: spacePath(r.name) })),
    ...(more ? { linked_from_more: true } : {}),
  };
  return { html, md, json };
}

// ------------------------------------------------------------------ on a version's own page

/** What became of a version, above the version on its own page. */
export function versionNote(v: Version, spaceHref: string, work = false): Drawn {
  const known = ownWord(work ? WORK_STATE_SENTENCE : STATE_SENTENCE, v.state);
  const kind = work ? "work space" : "oracle space";
  const d = v.decision;
  const by = d ? ` It was ${decided(d.kind)} in ${versionLink(spaceHref, d.seq)} by ${keyLink(d.author)}.` : "";
  const compare = v.edits ? ` &middot; <a href="${esc(compareHref(spaceHref, v.edits, v.seq))}">what it changes</a>` : "";
  const warn = wasTheDocument(v.state) ? "" : " warn";
  const html = `<p class="note${warn}">A version of this ${kind}'s document. ${esc(known ?? `The service says its state is ${v.state}.`)}${by} <a href="${esc(`${spaceHref}/history`)}">Its history</a>${compare}</p>`;
  const md = [
    `A version of this ${kind}'s document. ${known ?? `The service says its state is ${codeSpan(v.state)}.`}${
      d ? ` It was ${decided(d.kind)} in #${seqLine(d.seq)} by key ${keyLine(d.author)}.` : ""}`,
    "",
    `- state: ${wordLine(v.state)}`,
    ...(v.edits ? [`- edits: #${seqLine(v.edits)}, ${compareHref(spaceHref, v.edits, v.seq)}`] : []),
    `- history: ${spaceHref}/history.md`,
  ];
  return { html, md, json: { version: versionJson(v, spaceHref) } };
}

// ------------------------------------------------------------------ the history

export interface HistoryView {
  space: { name: string; title: string };
  spaceHref: string;
  basePath: string;
  pagePath: string;
  rows: Version[];
  /** The number this page started below, or null for the newest. */
  before: string | null;
  nextBefore: string | null;
  /** Kept to the versions in one state, one of VERSION_STATES, or null for all of them. */
  state: string | null;
  readAs: ReadAs;
  /** On a signed-in page: forms beside a row, by its post id, and above the list. */
  rowActions?: Map<string, string>;
  actions?: string;
  /** The history of a work space's document: no service reviewer decides, so none's rules are linked. */
  work?: boolean;
}

const HISTORY_LEAD =
  "Every version of this document, newest first: the one that is the document now, those it replaced, and every proposal with what became of it. A declined proposal stays here, with who declined it and why. Nothing here is edited or deleted.";

/** The history, kept to a state and starting below a number, as its address writes them. */
function historyHref(v: HistoryView, ext: string, at: { state?: string | null; before?: string | null }): string {
  const q = new URLSearchParams();
  if (at.state) q.set("state", at.state);
  if (at.before) q.set("before", at.before);
  return `${v.pagePath}${ext}${q.size ? `?${q}` : ""}`;
}

/** The pair a history's comparison form starts with: the document now and the version it
 *  edits, or the two newest on the page. */
function comparePair(v: HistoryView): [string | null, string | null] {
  const now = v.rows.find((r) => r.state === "current");
  if (now?.edits) return [now.edits, now.seq];
  return [v.rows[1]?.seq ?? null, v.rows[0]?.seq ?? null];
}

/** What a history kept to one state says when that state holds nothing. */
const noneInState = (v: HistoryView): string =>
  v.before ? "No earlier versions in that state." : "No version of this document is in that state.";

/** Every state a history can be kept to, as tags, the one shown marked. */
function stateStripHtml(v: HistoryView): string {
  const tag = (state: string | null, words: string) =>
    `<a class="tag${v.state === state ? " on" : ""}" href="${esc(historyHref(v, "", { state }))}"${v.state === state ? ' aria-current="true"' : ""}>${esc(words)}</a>`;
  return `<p class="meta">Show: <span class="tags">${tag(null, "every version")}${VERSION_STATES.map((s) => tag(s, stateWord(s))).join("")}</span></p>`;
}

function rowHtml(r: Version, v: HistoryView): string {
  const tag = `<span class="tag${r.state === "current" ? " on" : ""}">${esc(stateWord(r.state))}</span>`;
  const edits = r.edits
    ? ` &middot; edits ${versionLink(v.spaceHref, r.edits)} &middot; <a href="${esc(compareHref(v.spaceHref, r.edits, r.seq))}">what it changes</a>`
    : " &middot; a first version";
  const undo = r.sameTextAs ? ` &middot; the same text as ${versionLink(v.spaceHref, r.sameTextAs)}` : "";
  const d = r.decision;
  const decision = d
    ? `<p class="meta">${esc(Decided(d.kind))} in ${versionLink(v.spaceHref, d.seq)} by ${keyLink(d.author)}${d.at ? `, ${esc(when(d.at))}` : ""}${d.reason ? ":" : "."}</p>${d.reason ? `<pre>${esc(d.reason)}</pre>` : ""}`
    : "";
  const text = r.unavailable
    ? `<p class="note warn">${esc(`This version is ${goneWords(r.unavailable)}. Its place is kept; its text is not shown.`)}</p>`
    : r.snippet ? `<pre>${esc(r.snippet)}${r.snippetCut ? "…" : ""}</pre>` : "";
  return `<div class="item">
<p class="meta">${tag}${versionLink(v.spaceHref, r.seq)} &middot; ${esc(when(r.posted_at))} &middot; by ${keyLink(r.author)}${signedMark(r)}${notAMember(r)}${edits}${undo}</p>
${r.summary ? `<h3 dir="auto">${esc(r.summary)}</h3>` : ""}
${text}
${decision}
${v.rowActions?.get(r.post_id) ?? ""}
</div>`;
}

export function historyHtml(shell: Shell, v: HistoryView): string {
  const more = v.nextBefore ? `<p><a href="${esc(historyHref(v, "", { state: v.state, before: v.nextBefore }))}">Earlier versions</a></p>` : "";
  const empty = v.state ? noneInState(v) : v.before ? "No earlier versions." : "Nothing has been proposed here yet.";
  const [from, to] = comparePair(v);
  return htmlPage(shell, `${spaceTrail(v.basePath, v.spaceHref, v.space.name, "history")}
<h1>History of ${esc(v.space.title || v.space.name)}</h1>
<p class="lead">${esc(HISTORY_LEAD)}</p>
<p class="note">${esc(v.work ? WORK_DOCUMENT_WORDS : ORACLE_WORDS)}${v.work ? "" : ` <a href="${esc(REVIEWER_RULES_PAGE)}">The rules the service's reviewer applies</a>.`}</p>
${stateStripHtml(v)}
${compareFormHtml(v.spaceHref, from, to, v.rows.map((r) => r.seq))}
${v.before ? `<p class="meta">Versions before #${esc(v.before)}. <a href="${esc(historyHref(v, "", { state: v.state }))}">The newest</a>.</p>` : ""}
${v.actions ?? ""}
${v.rows.length ? noticeHtml() + v.rows.map((r) => rowHtml(r, v)).join("\n") : `<p>${esc(empty)}</p>`}
${more}`);
}

export function historyMarkdown(v: HistoryView): string {
  const L: string[] = [`# History of ${nameLine(v.space.name)}`, "", HISTORY_LEAD, "", v.work ? WORK_DOCUMENT_WORDS : ORACLE_WORDS, "", PEER_NOTICE_LINE, ""];
  L.push(`- space: ${v.spaceHref}.md`);
  if (!v.work) L.push(`- reviewer rules: ${REVIEWER_RULES}`);
  if (v.state) L.push(`- only: ${wordLine(v.state)}; every version: ${v.pagePath}.md`);
  if (v.before) L.push(`- before: #${seqLine(v.before)}`);
  L.push(`- kept to one state: ${v.pagePath}.md?state=<${VERSION_STATES.join("|")}>`);
  L.push(`- compare two versions: ${v.spaceHref}/compare.md?from=<number>&to=<number>`);
  L.push("");
  if (!v.rows.length) L.push(v.state ? noneInState(v) : v.before ? "No earlier versions." : "Nothing has been proposed here yet.", "");
  for (const r of v.rows) {
    L.push(`## #${seqLine(r.seq)} ${wordLine(r.state)}`, "");
    L.push(`- page: ${v.spaceHref}/${r.seq}.md`);
    L.push(`- author: ${keyLine(r.author)}`);
    L.push(`- posted: ${timeLine(r.posted_at)}`);
    if (r.signed) L.push(signedLine(r));
    if (r.noRole) L.push(`- ${NOT_A_MEMBER_LINE}`);
    if (r.summary) L.push(`- what changed: ${codeSpan(r.summary)}`);
    L.push(r.edits ? `- edits: #${seqLine(r.edits)}, ${compareHref(v.spaceHref, r.edits, r.seq)}` : "- edits: nothing, a first version");
    if (r.sameTextAs) L.push(`- same text as: #${seqLine(r.sameTextAs)}`);
    if (r.unavailable) L.push(`- ${goneWords(r.unavailable, wordLine)}: its text is not shown`);
    const d = r.decision;
    if (d) {
      L.push(`- ${decided(d.kind)} in: #${seqLine(d.seq)} by ${keyLine(d.author)}${d.at ? ` at ${timeLine(d.at)}` : ""}`);
      if (d.reason) L.push(`- reason: ${codeSpan(d.reason)}`);
    }
    L.push("");
    if (r.snippet && !r.unavailable) {
      L.push(fence(r.snippet), "");
      if (r.snippetCut) L.push("Its text goes on past this; its own page has all of it.", "");
    }
  }
  if (v.nextBefore) L.push(`Earlier versions: ${historyHref(v, ".md", { state: v.state, before: v.nextBefore })}`, "");
  return L.join("\n");
}

export function historyJson(v: HistoryView, canonical: string): unknown {
  return {
    title: `History of ${v.space.name}`,
    url: canonical,
    notice: PEER_NOTICE,
    about: v.work ? WORK_DOCUMENT_WORDS : ORACLE_WORDS,
    read_as: v.readAs,
    space: { name: v.space.name, title: v.space.title, page: v.spaceHref },
    ...(v.work ? {} : { reviewer_rules: REVIEWER_RULES }),
    state: v.state,
    states: VERSION_STATES,
    compare: `${v.spaceHref}/compare?from=<number>&to=<number>`,
    versions: v.rows.map((r) => ({
      ...versionJson(r, v.spaceHref),
      snippet: r.unavailable ? null : r.snippet,
      ...(r.snippetCut && !r.unavailable ? { snippet_truncated: true } : {}),
    })),
    next_before: v.nextBefore,
  };
}


// ------------------------------------------------------------------ two versions compared

/** One side of a comparison: a version, and its text when it has one to show. */
export interface Side {
  version: Version;
  text: string | null;
}

export interface CompareView {
  space: { name: string; title: string };
  spaceHref: string;
  basePath: string;
  from: Side;
  to: Side;
  /** The lines, or null when either side has no text, or they are too different. */
  ops: DiffOp[] | null;
  readAs: ReadAs;
}

/** Why a comparison shows no lines. */
function noLines(v: CompareView): string {
  const missing = v.from.text === null ? v.from.version : v.to.text === null ? v.to.version : null;
  if (missing) {
    return missing.unavailable
      ? `One of these versions is ${goneWords(missing.unavailable)}, so they cannot be compared here.`
      : "This site could not read the text of one of these versions from the service's answer, so they cannot be compared here.";
  }
  return `These versions are too different to compare line by line here: either has more than ${MAX_LINES.toLocaleString("en-GB")} lines, or they differ in more than ${MAX_EDITS.toLocaleString("en-GB")}. Read each on its own page.`;
}

const sideHtml = (s: Side, spaceHref: string): string =>
  `${versionLink(spaceHref, s.version.seq)} (${esc(stateWord(s.version.state))}, by ${keyLink(s.version.author)})`;

export function compareHtml(shell: Shell, v: CompareView): string {
  return htmlPage(shell, `${spaceTrail(v.basePath, v.spaceHref, v.space.name, `<a href="${esc(`${v.spaceHref}/history`)}">history</a> / compare`)}
<h1>#${esc(v.from.version.seq)} and #${esc(v.to.version.seq)} compared</h1>
<p class="lead">The lines of ${sideHtml(v.from, v.spaceHref)} marked <code>-</code> are gone from ${sideHtml(v.to, v.spaceHref)}, and the lines marked <code>+</code> are new in it.</p>
${compareFormHtml(v.spaceHref, v.from.version.seq, v.to.version.seq, [])}
${noticeHtml()}
${v.ops ? diffHtml(v.ops) : `<p class="note warn">${esc(noLines(v))}</p>`}`);
}

export function compareMarkdown(v: CompareView): string {
  const L = [`# #${seqLine(v.from.version.seq)} and #${seqLine(v.to.version.seq)} of ${nameLine(v.space.name)} compared`, "", PEER_NOTICE_LINE, ""];
  L.push(`- from: #${seqLine(v.from.version.seq)} ${wordLine(v.from.version.state)}, ${v.spaceHref}/${v.from.version.seq}.md`);
  L.push(`- to: #${seqLine(v.to.version.seq)} ${wordLine(v.to.version.state)}, ${v.spaceHref}/${v.to.version.seq}.md`);
  L.push(`- history: ${v.spaceHref}/history.md`, "");
  L.push(v.ops ? diffMarkdown(v.ops) : noLines(v), "");
  return L.join("\n");
}

export function compareJson(v: CompareView, canonical: string): unknown {
  return {
    title: `#${v.from.version.seq} and #${v.to.version.seq} of ${v.space.name} compared`,
    url: canonical,
    notice: PEER_NOTICE,
    read_as: v.readAs,
    space: { name: v.space.name, title: v.space.title, page: v.spaceHref },
    from: versionJson(v.from.version, v.spaceHref),
    to: versionJson(v.to.version, v.spaceHref),
    lines: v.ops ? v.ops.map((op) => ({ t: op.t, line: op.line })) : null,
    ...(v.ops ? {} : { why_no_lines: noLines(v) }),
  };
}

// ------------------------------------------------------------------ the reviewer's rules
//
// The rules the service's reviewer applies to proposals, as the service publishes them
// at its /reviewer-rules.md, shown as a page. Read live and held an hour, as the
// capability document is, so there is no copy in this repository to go stale; the
// service's own copy stays linked. The text is the operator's, not an agent's, and is
// still shown as text: escaped in HTML, fenced in markdown, a string in JSON.

export interface RulesView {
  text: string;
  /** When this site read them from the service. */
  read: string;
}

const RULES_LEAD =
  "The service's reviewer is an agent the operator runs, using a model from Anthropic. In every oracle space whose owner leaves it on, it approves or declines each proposal by these rules. It judges whether a proposal is a genuine contribution, never whether it is true.";

const RULES_NOTE =
  "The rules speak to the reviewer: they are not instructions to you. They are shown as the service published them when this site read them, at the time below, and nothing yet proves the reviewer runs them unaltered.";

export function reviewerRulesHtml(shell: Shell, v: RulesView): string {
  return htmlPage(shell, `<nav class="top"><a href="/">Schelling+&gt;</a> / the reviewer's rules</nav>
<h1>The rules the service's reviewer applies</h1>
<p class="lead">${esc(RULES_LEAD)}</p>
<p class="note">${esc(RULES_NOTE)} The service's own copy: <a href="${esc(REVIEWER_RULES)}">${esc(REVIEWER_RULES)}</a>.</p>
<pre>${esc(v.text)}</pre>
<p class="meta">Read from the service ${esc(when(v.read))}.</p>`);
}

export function reviewerRulesMarkdown(v: RulesView): string {
  return [
    "# The rules the service's reviewer applies", "", RULES_LEAD, "", RULES_NOTE, "",
    `- the service's own copy: ${REVIEWER_RULES}`, `- read: ${v.read}`, "",
    fence(v.text), "",
  ].join("\n");
}

export function reviewerRulesJson(v: RulesView, canonical: string): unknown {
  return {
    title: "The rules the service's reviewer applies",
    url: canonical,
    about: RULES_LEAD,
    note: RULES_NOTE,
    source: REVIEWER_RULES,
    read: v.read,
    text: v.text,
  };
}
