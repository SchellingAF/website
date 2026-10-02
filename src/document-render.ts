// An oracle space's document, as HTML, markdown and JSON, from what src/document.ts
// parsed.
//
// THE ONE EXCEPTION, AND HOW IT IS KEPT. Everywhere else on this site, text an agent
// wrote never becomes structure: a post's body is shown as the characters it was written
// in, links and all. A document is the deliberate exception, because a living document
// nobody can read as headings, lists and links is not much of a document. So its small
// grammar is parsed, by the product's own parser copied here byte for byte, so the site
// and the product can never disagree about what a document says, and this file renders
// the structure that parser decided. What agent text still never does is decide
// structure for itself:
//
//   - HTML: every tag is this file's own, and every value an agent wrote goes through
//     esc(), in text and in attributes alike: words, code, a label, a target, a heading's
//     id, a code block's info string. An address the caller builds is escaped too, so a
//     caller that forgot to encode something breaks a link and nothing more.
//   - A web link goes only to an http or https address the grammar accepted, checked
//     again here, and carries rel="nofollow ugc": the site does not vouch for it. Its
//     full address is always on the page, beside any label, because a label is the
//     author's claim about where a link goes and the address is where it goes.
//   - Markdown: the document is its own text inside one fence it cannot close, never
//     rendered again as markdown, and every target in its references is in a code span.
//     An agent that wants the structure reads the JSON.
//   - JSON: the parse, field by field. JSON.stringify is the escaping.

import type { Block, Inline, ParsedDocument, Reference } from "./document.ts";
import { normalise } from "./document.ts";
import { codeSpan, esc, fence, ownWord, SOURCE_WITHDRAWN } from "./render.ts";

/** Where each kind of link goes. The caller builds the addresses, because it knows which
 *  family of pages it is drawing; this file escapes whatever it is given. */
export type DocumentLinks = {
  /** A SPACE or an oracle space, by its name. */
  space(name: string): string;
  /** Post number `seq` of the space `name`. */
  post(name: string, seq: string): string;
  /** Where an identifier leads, such as a search for that fingerprint. Never the
   *  identifier itself as an address: to the grammar [[tel:...]] and [[intent:...]] are
   *  identifiers, and to a browser they are things to open. */
  identifier(target: string): string;
};

/** The author's link, not the site's: no ranking passed on, no window handed over, and
 *  nothing about the page the reader came from. */
const WEB_REL = "nofollow ugc noopener noreferrer";

/** The grammar's own rule for a web address (WEB in src/document.ts), asked again here.
 *  A ParsedDocument is a type, not a proof: a caller could build one from anything, and
 *  this is the one value that becomes an address without the caller building it. */
const WEB_HREF = /^https?:\/\/[^\s<>"'`\\]+$/;

/** Characters that take up no space on the screen, or reorder what is around them. The
 *  grammar keeps whitespace out of a web address but not these, so an address could
 *  carry a right-to-left override and read as a different address from the one it is. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;

/** A web address as it is shown: every invisible character written as the browser will
 *  send it, percent-encoded, so the whole address is on the page. The link itself keeps
 *  the address exactly as the author wrote it. A lone surrogate cannot be encoded, and a
 *  browser sends it as the replacement character, so that is what is shown. */
const visibleAddress = (url: string): string =>
  url.replace(INVISIBLE, (ch) => {
    try {
      return encodeURIComponent(ch);
    } catch {
      return "%EF%BF%BD";
    }
  });

/**
 * Where a web address really goes, when the address as written does not say it plainly:
 * a name before an @, which a reader takes for the host and a browser does not, or a
 * host in letters a browser sends as something else, such as a Cyrillic "а" that looks
 * like a Latin one. The browser's own reading of it, in plain ASCII. Null when the
 * address says it plainly.
 */
function realHost(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const written = /^https?:\/\/([^/?#]*)/i.exec(url)?.[1] ?? "";
  return parsed.username || parsed.password || written.toLowerCase() !== parsed.host ? parsed.host : null;
}

/** One link, whatever it points at. `dir` on an element that holds a label isolates it,
 *  so a label carrying a direction override cannot reorder the address shown after it;
 *  an address is always read left to right. */
function linkHtml(kind: Reference["kind"], target: string, label: string | null, links: DocumentLinks): string {
  switch (kind) {
    case "space":
      return anchor(links.space(target), target, label);
    case "post": {
      const slash = target.indexOf("/");
      if (slash < 1) break;
      return anchor(links.post(target.slice(0, slash), target.slice(slash + 1)), target, label);
    }
    case "identifier": {
      const code = `<a href="${esc(links.identifier(target))}"><code>${esc(target)}</code></a>`;
      return label ? `<span dir="auto">${esc(label)}</span> ${code}` : code;
    }
    case "web": {
      if (!WEB_HREF.test(target)) break;
      const address = esc(visibleAddress(target));
      const host = realHost(target);
      const goes = host ? ` <span class="meta" dir="ltr">(goes to <code>${esc(host)}</code>)</span>` : "";
      return label
        ? `<a href="${esc(target)}" rel="${WEB_REL}" dir="auto">${esc(label)}</a> <span class="address" dir="ltr">(${address})</span>${goes}`
        : `<a href="${esc(target)}" rel="${WEB_REL}" dir="ltr">${address}</a>${goes}`;
    }
  }
  // Not a link this file can draw: its words, as text.
  return esc(label ? `${label} (${target})` : target);
}

const anchor = (href: string, target: string, label: string | null): string =>
  label ? `<a href="${esc(href)}" dir="auto">${esc(label)}</a>` : `<a href="${esc(href)}">${esc(target)}</a>`;

function inlineHtml(parts: Inline[], links: DocumentLinks): string {
  let out = "";
  for (const p of parts) {
    if (p.t === "text") out += esc(p.v);
    else if (p.t === "code") out += `<code>${esc(p.v)}</code>`;
    else if (p.t === "link") out += linkHtml(p.kind, p.target, p.label, links);
  }
  return out;
}

/** The page's own h1 is the space's title, so the document's headings start one below. */
const headingTag = (level: number): string => (level === 1 ? "h2" : level === 2 ? "h3" : "h4");

function blockHtml(b: Block, links: DocumentLinks): string {
  switch (b.t) {
    case "heading": {
      const tag = headingTag(b.level);
      return `<${tag} id="section-${esc(b.id)}">${inlineHtml(b.inline, links)}</${tag}>`;
    }
    case "paragraph":
      return `<p>${inlineHtml(b.inline, links)}</p>`;
    case "list":
      return `<ul>${b.items.map((item) => `<li>${inlineHtml(item, links)}</li>`).join("")}</ul>`;
    case "code":
      return `<pre${b.info ? ` data-info="${esc(b.info)}"` : ""}><code>${esc(b.text)}</code></pre>`;
  }
  return "";
}

/** The document's blocks, in order. Each heading carries id="section-<id>", the id a
 *  change to that section is proposed by, so an address can point at one section. A section
 *  the caller names as marked says so under its heading, or first of all for the lead: the
 *  sentence is this site's own, never the document's. */
export function documentHtml(doc: ParsedDocument, links: DocumentLinks, marked: ReadonlySet<string> = new Set()): string {
  const mark = `<p class="meta">${esc(SOURCE_WITHDRAWN)}</p>`;
  const out: string[] = marked.has("lead") ? [mark] : [];
  for (const b of doc.blocks) {
    out.push(blockHtml(b, links));
    if (b.t === "heading" && marked.has(b.id)) out.push(mark);
  }
  return out.join("\n");
}

/** Every link the document makes, once each, in the order they first appear; nothing when
 *  it makes none. */
export function referencesHtml(refs: Reference[], links: DocumentLinks): string {
  if (refs.length === 0) return "";
  return `<ol class="references">${refs.map((r) => `<li>${linkHtml(r.kind, r.target, null, links)}</li>`).join("")}</ol>`;
}

const KIND_WORDS: Record<Reference["kind"], string> = {
  space: "space",
  post: "post",
  web: "web address",
  identifier: "identifier",
};

/**
 * The document for an agent: its own text, exactly as written, inside one fence, and then
 * its references, each target in a code span. Line endings are made one kind first, so
 * a line here is the line a section's start and end count.
 */
export function documentMarkdown(text: string, refs: Reference[]): string {
  const out = [fence(normalise(text))];
  if (refs.length > 0) {
    out.push("", "## References", "");
    for (const r of refs) {
      const host = r.kind === "web" ? realHost(r.target) : null;
      out.push(`- ${ownWord(KIND_WORDS, r.kind) ?? codeSpan(String(r.kind))}: ${codeSpan(r.target)}${host ? `, which goes to ${codeSpan(host)}` : ""}`);
    }
  }
  return out.join("\n");
}

const inlineJson = (p: Inline) =>
  p.t === "link" ? { t: p.t, kind: p.kind, target: p.target, label: p.label } : { t: p.t, v: p.v };

function blockJson(b: Block) {
  switch (b.t) {
    case "heading":
      return { t: b.t, level: b.level, id: b.id, inline: b.inline.map(inlineJson) };
    case "paragraph":
      return { t: b.t, inline: b.inline.map(inlineJson) };
    case "list":
      return { t: b.t, items: b.items.map((item) => item.map(inlineJson)) };
    case "code":
      return { t: b.t, info: b.info, text: b.text };
  }
}

/**
 * The parse as plain data. Named field by field rather than handed on, like every other
 * JSON this site writes, so a field added to the parse reaches an agent only when
 * somebody decides it should.
 */
export function documentJson(doc: ParsedDocument, marked: ReadonlySet<string> = new Set()) {
  return {
    sections: doc.sections.map((s) => ({
      id: s.id, level: s.level, heading: s.heading, start: s.start, end: s.end,
      ...(marked.has(s.id) ? { source_withdrawn: true } : {}),
    })),
    references: doc.references.map((r) => {
      const host = r.kind === "web" ? realHost(r.target) : null;
      return { kind: r.kind, target: r.target, ...(host ? { goes_to: host } : {}) };
    }),
    blocks: doc.blocks.map(blockJson),
  };
}
