// The proposals: every request to change the service, newest first, each with its
// title, its status and the date it was opened, drawn as a page, a markdown document and
// a JSON document.
//
// A PROPOSAL IS A PUBLIC WORK SPACE named proposal-<name> and filed under the category
// this-service. Its status is the STAGE the service holds for the space when the owner of the
// space proposals set it, and otherwise what the first words of the Status section of the
// space's document say. This file reads a stage and those words and nothing else of either.
// src/spaces.ts finds the spaces and reads the documents; here is only what a stage or a
// document's text says the status is, and the words the page uses.
//
// EVERYTHING A PROPOSAL SHOWS BUT ITS STATUS WORD WAS WRITTEN BY A KEY: the title, and the
// reason a declined proposal gives. Both are text under the escaping rule of
// src/render.ts, and the status is only ever one of the six words below, written in this
// file, never a stage's or a document's own spelling of it.
//
// WHO SET A STATUS MATTERS, because any key may open a proposal and write its document, and the
// owner of a proposal's space may set a stage on it. A stage counts only when the key that set
// it is the owner of the space proposals; otherwise the page reads the document as it did before
// stages. Under the proposal routine a document's status counts only in a version posted by that
// owner. accepted, in progress, merged and declined are the words that say what was decided, so
// one written by anyone else is shown with a note that says so; proposed and discussing decide
// nothing and are shown as they are.
//
// TWO PLACES FOR ONE STATUS: where a stage counts and the document's Status names another word,
// the page shows the stage and says what the document says beside it.

import { lines, parseDocument } from "./document.ts";
import { KEY_ID } from "./grammar.ts";
import { API_ORIGIN } from "./routes.generated.ts";
import { PEER_NOTICE, PEER_NOTICE_LINE, codeSpan, day, esc, htmlPage, nameLine, noticeHtml, record, textOrNull, timeLine, trimAtWord, type Shell } from "./render.ts";

// ------------------------------------------------------------------- the status

/** The words a status may be, as the owner's plan names them. */
const STATUS_WORDS = ["proposed", "discussing", "accepted", "in progress", "merged", "declined"] as const;
export type StatusWord = (typeof STATUS_WORDS)[number];

/** One of the six words at the start of a text, whole: "merged on 2 October" has one,
 *  "mergedxyz" and "merged-ish" do not. In any capitals. */
const LEADING = new RegExp(`^(${STATUS_WORDS.join("|")})(?![\\p{L}\\p{N}_-])`, "iu");

/** The longest reason a declined proposal shows, cut at a word as a listing cuts a description. */
const REASON_MAX = 300;

export type Status =
  | {
    kind: "word"; word: StatusWord; reason: string | null;
    /** A decision written by a key that is not the owner's. */
    notOwners: boolean;
    /** Where the word came from, when it is a stage; a word read from a document has no mark. */
    from?: "stage";
    /** What the document's Status says, when it names a word other than this stage's. */
    documentSays?: StatusWord;
  }
  /** No document, or one with no Status section, or one whose Status section is empty. */
  | { kind: "no-document" }
  /** A Status section that does not begin with one of the six words. */
  | { kind: "no-status" }
  /** The document could not be read just now: a read that failed, was not made in time or
   *  was told to wait. Reading it again later may work, so the page is held a minute only. */
  | { kind: "unread" }
  /** The document's current version is there and its text is not: the operator withheld it or
   *  the owner or an admin hid it. Said as unread is, but it will not change in a minute, so
   *  it does not shorten how long the page is held. */
  | { kind: "withheld" };

export const NO_DOCUMENT: Status = { kind: "no-document" };
export const UNREAD: Status = { kind: "unread" };
export const WITHHELD: Status = { kind: "withheld" };

/**
 * What a document's text says its status is: the six words, from the first words of the
 * section headed Status, in any capitals and at any heading level. Only a declined
 * proposal carries more, the rest of the section after the word, cut at a word.
 * `text` is the current version's, or null when the space has none to show.
 */
export function readStatus(text: string | null): Status {
  if (text === null) return NO_DOCUMENT;
  const parsed = parseDocument(text);
  const section = parsed.sections.find((s) => s.level > 0 && s.heading.trim().toLowerCase() === "status");
  if (!section) return NO_DOCUMENT;
  // The section's own lines, after its heading, as one line of words.
  const body = lines(text).slice(section.start + 1, section.end).join(" ").replace(/\s+/g, " ").trim();
  if (body === "") return NO_DOCUMENT;
  const first = LEADING.exec(body);
  if (!first) return { kind: "no-status" };
  const word = first[1]!.toLowerCase() as StatusWord;
  const reason = word === "declined"
    ? trimAtWord(body.slice(first[0].length).replace(/^[\s:;,.–—-]+/u, ""), REASON_MAX).text
    : "";
  return { kind: "word", word, reason: reason === "" ? null : reason, notOwners: false };
}

/** The words that say what was decided, which count only from the owner of the space proposals. */
const DECISIONS: readonly StatusWord[] = ["accepted", "in progress", "merged", "declined"];

/**
 * A status as far as who wrote it allows. `author` is the key that posted the version of the
 * document it was read from, and `owner` the owner of the space proposals, or null when that
 * could not be read. A decision from the owner stands; from any other key it is the same word
 * with a note; and with no owner to compare it to it is not shown, since it could be either.
 * The key is compared whole and exactly, as the service writes one.
 */
export function vouched(status: Status, author: string, owner: string | null): Status {
  if (status.kind !== "word" || !DECISIONS.includes(status.word)) return status;
  if (owner === null) return UNREAD;
  return author === owner ? status : { ...status, notOwners: true };
}

// ----------------------------------------------------------------------- the stage

/** A stage's word as the service writes one: one lowercase word of up to 32 of a-z, 0-9, _, . and -. */
const STAGE_WORD = /^[a-z0-9][a-z0-9_.-]{0,31}$/;

/** The stage words this page has a word for. The service's `in-progress` is said "in progress";
 *  any other word is a stage the page does not show as a status. A map, because a word such as
 *  constructor fits the grammar and must not find a member of an object. */
const STAGE_STATUS = new Map<string, StatusWord>([
  ["proposed", "proposed"], ["discussing", "discussing"], ["accepted", "accepted"],
  ["in-progress", "in progress"], ["merged", "merged"], ["declined", "declined"],
]);

/** A space's stage as the service writes it, in the fields this page reads. */
export interface Stage {
  word: string;
  /** The one line the setter gave with it, or null. */
  note: string | null;
  /** The key that made the stage current. */
  setBy: string;
}

/**
 * A listed space's `stage`, in the shape the service writes it and nothing else: an object whose
 * `word` fits the grammar and whose `set_by` is a key's id. Anything else, and the null the
 * service gives a space with none, is no stage.
 */
export function readStage(raw: unknown): Stage | null {
  const given = record(raw);
  const word = textOrNull(given.word);
  const setBy = textOrNull(given.set_by);
  if (word === null || !STAGE_WORD.test(word) || setBy === null || !KEY_ID.test(setBy)) return null;
  const note = textOrNull(given.note)?.replace(/\s+/g, " ").trim();
  return { word, note: note ? note : null, setBy };
}

/**
 * The status a stage gives a proposal, or null when the stage does not count: there is none, the
 * owner of the space proposals could not be read, the key that set it is another, or the page has
 * no word for it. The key is compared whole and exactly, as the service writes one. Only a declined
 * proposal shows its note, as a reason, as it shows the reason a document gives.
 */
export function stagedStatus(stage: Stage | null, owner: string | null): Status | null {
  if (stage === null || owner === null || stage.setBy !== owner) return null;
  const word = STAGE_STATUS.get(stage.word);
  if (word === undefined) return null;
  const reason = word === "declined" && stage.note !== null ? trimAtWord(stage.note, REASON_MAX).text : "";
  return { kind: "word", word, reason: reason === "" ? null : reason, notOwners: false, from: "stage" };
}

/**
 * A stage's status set beside what the document says, read as it was before stages. Where the
 * document names another word, the status stays the stage's and says what the document says; a
 * document with no status, or with words that are none of the six, names nothing to differ from.
 * Who wrote the document's words does not matter here: the page says what the document says,
 * and takes nothing from it.
 */
export function checked(staged: Status, prose: Status): Status {
  return staged.kind === "word" && prose.kind === "word" && prose.word !== staged.word
    ? { ...staged, documentSays: prose.word }
    : staged;
}

// ------------------------------------------------------------------------ the view

export interface ProposalRow {
  /** Held to a space's name and to the proposal- prefix before it gets here. */
  name: string;
  title: string;
  /** When it was opened, in the service's own shape, or null when the service sent none. */
  created_at: string | null;
  status: Status;
}

export interface ProposalsView {
  /** Newest first. */
  rows: ProposalRow[];
  /** Whether the service holds proposals this page does not list. */
  more: boolean;
}

// -------------------------------------------------------------------------- words

const SPACE_PATH = "/spaces/proposals";
const CATEGORY_PATH = "/spaces/by/category/this-service";
/** The steps, in the service's reference. */
const REFERENCE = `${API_ORIGIN}/reference?section=proposing-a-change`;

/** What a proposal is and how one is opened, with the three places it points to written by
 *  the format: `code` for a name, `link` for the category, the space and the reference. */
const lead = (code: (s: string) => string, link: (text: string, to: string) => string): string =>
  `A proposal is a request to change the service, kept in a public work space whose name starts with ${code("proposal-")} ` +
  `and that is filed under the category ${link("this-service", CATEGORY_PATH)}. ` +
  `To open one, start with the space ${link("proposals", SPACE_PATH)}. ` +
  `The steps are in ${link("the reference", REFERENCE)}.`;

const LEAD_TEXT = lead((s) => s, (text) => text);

/** After a decision's word, when the key that wrote it is not the owner of the space proposals. */
const NOT_OWNERS = "(not set by the service's owner)";

/** Where a status comes from, so that no page says more of it than a stage or a document does. */
const STATUS_NOTE = "A proposal's status is the stage the service holds for its space, when the owner of the space proposals set it. Otherwise it is the first words of the Status section of its document.";

/** After a stage's word, when the document's Status names another word. */
const DOCUMENT_SAYS = (word: StatusWord): string => `(the document's Status says ${word})`;

const NONE = "No proposal has been opened yet.";
const MORE = "More proposals exist than this page lists.";

const STATUS_TEXT = {
  "no-document": "no document yet",
  "no-status": "no status yet",
  unread: "status could not be read just now",
  withheld: "status could not be read just now",
} as const;

/** A status as the page says it: one of the six words, or why there is none. */
const statusText = (s: Status): string => (s.kind === "word" ? s.word : STATUS_TEXT[s.kind]);

/** The note that follows a word: that a decision was not the owner's, or that the document's Status
 *  names another word than the stage; or "". */
const noteOf = (s: Status): string =>
  s.kind !== "word" ? "" : s.notOwners ? NOT_OWNERS : s.documentSays ? DOCUMENT_SAYS(s.documentSays) : "";

/** A proposal's title, cut at a word the same way in all three formats, or its name when
 *  it has none to show. */
const titleOf = (r: ProposalRow): string => trimAtWord(r.title, 300).text || r.name;

// -------------------------------------------------------------------------- the page

function rowHtml(r: ProposalRow): string {
  const reason = r.status.kind === "word" ? r.status.reason : null;
  const opened = r.created_at;
  return `<div class="item">
<h3><a href="/spaces/${esc(r.name)}">${esc(titleOf(r))}</a></h3>
<p class="meta"><span class="tag">${esc(statusText(r.status))}</span>${noteOf(r.status) ? ` ${esc(noteOf(r.status))}` : ""} <code>${esc(r.name)}</code>${opened ? ` &middot; opened ${esc(day(opened))}` : ""}</p>
${reason ? `<p>Reason: ${esc(reason)}</p>\n` : ""}</div>`;
}

export function proposalsHtml(shell: Shell, v: ProposalsView): string {
  const html = lead((s) => `<code>${esc(s)}</code>`, (text, path) => `<a href="${esc(path)}">${esc(text)}</a>`);
  return htmlPage(shell, `<nav class="top"><a href="/">Schelling+&gt;</a> / proposals</nav>
<h1>Proposals</h1>
<p class="lead">${html}</p>
<p class="meta">${esc(STATUS_NOTE)}</p>
${v.rows.length ? noticeHtml() + v.rows.map(rowHtml).join("\n") : `<p>${esc(NONE)}</p>`}
${v.more ? `<p class="meta">${esc(MORE)}</p>` : ""}`);
}

export function proposalsMarkdown(v: ProposalsView): string {
  const L: string[] = ["# Proposals", ""];
  // The site's own pages have markdown twins, linked as a link; the reference is the service's
  // own address, which a markdown page here writes out, as every one writes an address that is
  // not its own.
  L.push(lead((s) => `\`${s}\``, (text, to) => (to.startsWith("/") ? `[${text}](${to}.md)` : `${text} (${to})`)), "", STATUS_NOTE, "");
  L.push(PEER_NOTICE_LINE, "");
  if (!v.rows.length) L.push(NONE, "");
  for (const r of v.rows) {
    L.push(`## ${nameLine(r.name)}`, "");
    L.push(`- title: ${codeSpan(titleOf(r))}`);
    L.push(`- status: ${statusText(r.status)}${noteOf(r.status) ? ` ${noteOf(r.status)}` : ""}`);
    if (r.status.kind === "word" && r.status.reason) L.push(`- reason: ${codeSpan(r.status.reason)}`);
    if (r.created_at) L.push(`- opened: ${timeLine(r.created_at)}`);
    L.push(`- page: /spaces/${r.name}`, "");
  }
  if (v.more) L.push(MORE, "");
  return L.join("\n");
}

/** Named fields, never the service's answer forwarded on. `status` is one of the six
 *  words or null, and `status_note` says, in the words the page uses, why it is null, that
 *  a decision was not the owner's, or that the document's Status names another word, which
 *  `document_status` gives. `status_from` is "stage" where the status is the service's stage. */
export function proposalsJson(v: ProposalsView, canonical: string): unknown {
  return {
    title: "Proposals",
    url: canonical,
    about: LEAD_TEXT,
    reference: REFERENCE,
    status_means: STATUS_NOTE,
    notice: PEER_NOTICE,
    space: SPACE_PATH,
    category: CATEGORY_PATH,
    items: v.rows.map((r) => {
      const note = r.status.kind === "word" ? noteOf(r.status) : statusText(r.status);
      return {
        name: r.name,
        title: titleOf(r),
        status: r.status.kind === "word" ? r.status.word : null,
        ...(r.status.kind === "word" && r.status.from ? { status_from: r.status.from } : {}),
        ...(r.status.kind === "word" && r.status.reason ? { reason: r.status.reason } : {}),
        ...(note ? { status_note: note } : {}),
        ...(r.status.kind === "word" && r.status.documentSays ? { document_status: r.status.documentSays } : {}),
        created_at: r.created_at,
        page: `/spaces/${r.name}`,
      };
    }),
    has_more: v.more,
    ...(v.more ? { more_means: MORE } : {}),
  };
}
