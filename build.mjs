// Builds the whole site from content/ into public/.
//
// The folder layout under content/ IS the site. Drop a markdown file in and it
// gets an HTML page, a .md version, a .json version, a line in sitemap-pages.xml
// and an entry in llms.txt. Nothing else to update, because a hand-maintained index
// is an index that eventually goes stale.
//
// No dependencies on purpose. The markdown converter below handles exactly the
// constructs our copy uses and THROWS on anything else, so unsupported syntax
// fails the build loudly instead of silently vanishing from the page.

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, extname } from "node:path";
import * as OV from "./content/human-overview.mjs";
import * as AP from "./content/api-overview.mjs";

// Lowercase on purpose. Hostnames are case-insensitive and crawlers normalise
// them, so the canonical URL should be lowercase even though the brand is
// written schellingAF.com.
const SITE = "https://schellingaf.com";

// The canonical host, derived so the domain is written once. src/routes.generated.ts
// carries it to the request handler, which 301s the www name to it: a site reachable at two
// names is two sites to a crawler, and every canonical URL, sitemap line and index
// entry here names the apex.
const CANONICAL_HOST = new URL(SITE).hostname;

// The product's own origin. The site LINKS to the API's documents and never mirrors
// them -- one canonical rendering lives at the API, guarded on its own side.
//
// Declared in content/api-overview.mjs and imported here, not the other way round:
// that module needs it inside its own prose and cannot import from this file
// without a cycle, so the copy owns it and the build follows. Written in two
// places they drift, and the half that drifts is the connector configuration a
// person pastes into their editor.
const API_ORIGIN = AP.API_ORIGIN;

// Three names, and they are not interchangeable.
//
//   Schelling+>            the mark. Stays in the copy and the H1. Unsearchable
//                          by design: search engines strip punctuation.
//   Schelling Add Forward  how the mark is said and typed. This is what carries
//                          the page into search results, so it owns <title>.
//   schellingaf            the identifier form, for anything rejecting + and >.
//
// See "The name, and its punctuation" in README.md before touching any of this.
const SITE_NAME = "Schelling Add Forward";
const TAGLINE = "multi-agent coordination and shared memory for AI agents";

const CONTENT = "content";
// public/, or with `node build.mjs --check` a temporary folder that is removed when
// the build ends: everything is still built and checked, and public/ is left alone
// for a server that may be reading it. npm test builds this way. Either way the
// build writes src/routes.generated.ts.
const CHECK_ONLY = import.meta.main && process.argv.includes("--check");
const OUT = CHECK_ONLY ? mkdtempSync(join(tmpdir(), "schellingaf-build-")) : "public";

// ---------------------------------------------------------------- utilities

// The one escaper, for text and for a double-quoted attribute value alike. It
// escapes quotes too, so a value put into an attribute cannot end it early.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The rendered text of a page, for the checks that ask whether copy reached it.
// &amp; is undone last, so a literal "&lt;" in the copy reads back as itself.
const stripTags = (h) =>
  h.replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// Those checks ignore whitespace entirely. Stripping a tag necessarily leaves a
// gap, so an inline link mid-sentence turns "investigation." into
// "investigation ." and a naive comparison reports missing copy that is present.
// Removing whitespace from both sides still catches text that actually vanished
// or got mangled, which is what they guard.
const squash = (s) => s.replace(/\s+/g, "");

// What a page's HTML and its JSON say, in that form, computed once per page. The
// JSON has its escaping of line breaks and quotes undone, the two that prose meets.
const pageText = (html) => squash(stripTags(html));
const jsonText = (json) => squash(JSON.stringify(json).replace(/\\n/g, " ").replace(/\\"/g, '"'));

// GitHub-style slugs, so an agent can derive an anchor from a heading it has
// read without needing a lookup table.
const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

class BuildError extends Error {}
const fail = (file, line, msg) => {
  throw new BuildError(`${file}:${line}  ${msg}`);
};

// ------------------------------------------------------------ front matter

function parseFrontMatter(text, file) {
  if (!text.startsWith("---\n")) fail(file, 1, "missing front matter block");
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) fail(file, 1, "front matter block is not closed with ---");
  const meta = {};
  text.slice(4, end).split("\n").forEach((l, i) => {
    if (!l.trim()) return;
    const m = l.match(/^([a-z]+):\s*(.*)$/);
    if (!m) fail(file, i + 2, `front matter line is not "key: value": ${l}`);
    meta[m[1]] = m[2].trim();
  });
  for (const k of ["title", "summary", "audience"]) {
    if (!meta[k]) fail(file, 1, `front matter is missing "${k}"`);
  }
  if (!["agent", "human"].includes(meta.audience)) {
    fail(file, 1, `audience must be "agent" or "human", got "${meta.audience}"`);
  }
  return { meta, body: text.slice(end + 5), bodyStartLine: text.slice(0, end + 5).split("\n").length };
}

// -------------------------------------------------------- inline rendering

export function inline(text) {
  // Escape first, then re-introduce only the markup we support. A link's address
  // is taken from the escaped text, so it is already safe inside its attribute;
  // escaping it again would turn "&amp;" into "&amp;amp;".
  let s = esc(text);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => `<a href="${href}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italics AFTER bold, so the remaining single asterisks are unambiguous.
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  return s;
}

// Two trailing spaces = hard line break, which the quoted exchange in the copy
// relies on to keep each PEER's lines apart.
const joinLines = (lines) =>
  lines.map((l, i) => inline(l.replace(/\s+$/, "")) + (i < lines.length - 1 && /  $/.test(l) ? "<br>" : ""))
       .join("\n");

// ------------------------------------------------------ block rendering

// Whether a line belongs to a quote: one test, for the quote and for the paragraph
// that stops before one. Were they two, a line both reject, such as ">Quoted", would
// be taken by neither and the build would never finish. Such a line is refused.
const isQuote = (l) => l.startsWith(">");

// `firstLine` is the line number, in the file, of the first line of `body`.
export function toHtml(body, file, firstLine) {
  const lines = body.split("\n");
  const out = [];
  let i = 0;

  const reject = (l) => {
    if (/^#{3,}\s/.test(l)) return "heading level 3+ is not supported";
    if (/^\s*(```|~~~)/.test(l)) return "code fences are not supported";
    if (/^\s*\|/.test(l)) return "tables are not supported";
    if (/^\s*[*+]\s/.test(l)) return 'use "-" for bullets';
    if (/^\s*\d+\.\s/.test(l)) return "ordered lists are not supported";
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) return "horizontal rules are not supported";
    if (/^\s*</.test(l)) return "raw HTML is not supported";
    if (/^ {4,}\S/.test(l)) return "indented code blocks are not supported";
    if (isQuote(l) && !/^>( |$)/.test(l)) return 'write "> " before quoted text';
    if (/`/.test(l)) return "backticks are not supported";
    return null;
  };

  // Every line a construct consumes is taken through here, so every line is
  // checked whichever construct it belongs to, not only a quote's or a list's first.
  const take = () => {
    const l = lines[i];
    const bad = reject(l);
    if (bad) fail(file, firstLine + i, `${bad}\n    ${l.trim().slice(0, 60)}`);
    i++;
    return l;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // headings
    const h = line.match(/^(#{1,2})\s+(.*)$/);
    if (h) {
      take();
      const level = h[1].length;
      const text = h[2].trim();
      out.push(`<h${level} id="${slug(text)}">${inline(text)}</h${level}>`);
      continue;
    }

    // blockquote
    if (isQuote(line)) {
      const buf = [];
      while (i < lines.length && isQuote(lines[i])) buf.push(take().replace(/^>\s?/, ""));
      // A bare ">" separates speakers; render as a paragraph break inside the quote.
      const paras = buf.join("\n").split(/\n\s*\n/).map((p) => `<p>${joinLines(p.split("\n"))}</p>`);
      out.push(`<blockquote>${paras.join("")}</blockquote>`);
      continue;
    }

    // bullet list
    if (line.startsWith("- ")) {
      const items = [];
      while (i < lines.length && lines[i].startsWith("- ")) items.push(`<li>${inline(take().slice(2).trim())}</li>`);
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // paragraph. Its first line is taken unconditionally, so every pass of this
    // loop moves on by at least one line.
    const buf = [take()];
    while (i < lines.length && lines[i].trim() && !/^(#{1,2}\s|- )/.test(lines[i]) && !isQuote(lines[i])) {
      buf.push(take());
    }
    out.push(`<p>${joinLines(buf)}</p>`);
  }

  return out.join("\n");
}

// Sections for the JSON representation: each H2 and the prose under it, so an
// agent can take one section without parsing the whole page.
function toSections(body) {
  const sections = [];
  let cur = { id: null, title: null, body: [] };
  for (const line of body.split("\n")) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      sections.push(cur);
      cur = { id: slug(h[1].trim()), title: h[1].trim(), body: [] };
    } else {
      cur.body.push(line);
    }
  }
  sections.push(cur);
  return sections
    .map((s) => ({ ...s, body: s.body.join("\n").trim() }))
    .filter((s) => s.body || s.title);
}

// ------------------------------------------------------------------ layout

// AGENT PAGES. Deliberately barely-there: monospace, a readable measure, and it
// follows the reader's light/dark setting. No webfonts, no images, no script.
const CSS_AGENT = `:root{--bg:#fff;--fg:#141414;--dim:#565656;--rule:#e4e4e4;--link:#0b4fa8}
@media(prefers-color-scheme:dark){:root{--bg:#111312;--fg:#e6e6e2;--dim:#9a9a94;--rule:#2c2f2e;--link:#8ab4f8}}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);margin:0;padding:2.5rem 1.25rem 6rem;
font:15px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
main{max-width:72ch;margin:0 auto}
h1{font-size:1.5rem;letter-spacing:-.01em;margin:0 0 1.5rem}
h2{font-size:1rem;margin:2.75rem 0 .75rem;padding-top:1.25rem;border-top:1px solid var(--rule)}
p,ul{margin:0 0 1rem}
ul{padding-left:1.25rem}
li{margin-bottom:.35rem}
a{color:var(--link)}
strong{font-weight:600}
blockquote{margin:0 0 1rem;padding:.75rem 0 .75rem 1rem;border-left:2px solid var(--rule);color:var(--dim)}
blockquote p:last-child{margin-bottom:0}
nav{margin:0 0 2rem;padding-bottom:1rem;border-bottom:1px solid var(--rule);color:var(--dim);font-size:.85rem}
nav p{margin:0 0 .2rem}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--rule);color:var(--dim);font-size:.85rem}
.meta{color:var(--dim);font-size:.85rem}
dl{margin:0 0 1rem}
dt{font-weight:600}
dd{margin:0 0 .6rem 1.25rem}
ol{padding-left:1.5rem;margin:0 0 1rem}
ol li{margin-bottom:1rem}
pre{margin:0;padding:.7rem .8rem;overflow-x:auto;white-space:pre-wrap;word-break:break-word;font:inherit;font-size:.9em}
.block{margin:.6rem 0 1rem;border:1px solid var(--rule)}
.block-head{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;padding:.3rem .8rem;border-bottom:1px solid var(--rule);color:var(--dim);font-size:.85rem}
.copy{margin-left:auto;font:inherit;font-size:.8rem;padding:.1rem .6rem;cursor:pointer;border:1px solid var(--rule);background:var(--bg);color:var(--fg)}
.copy-done{color:var(--link);border-color:var(--link)}`;

// HUMAN PAGES share one shell: the designed nav, the designed footer and
// src/overview.css. There is no second human stylesheet, so a page for a person
// looks like the site whichever function renders it.
//
// The shell loads the self-hosted font and the logo SVGs from this origin and
// nothing else, so the site makes zero external requests.
const OVERVIEW_CSS = readFileSync("src/overview.css", "utf8");

function renderNav(active) {
  const { nav } = OV;
  const items = nav.items.map((i) => {
    // Which item is lit is decided here, from the route being rendered, rather
    // than stored in the copy. Every page written for a person shares this nav; a
    // hard-coded active flag would light the same one on all of them.
    const on = i.href === active;
    return `<a class="nav-item${on ? " on" : ""}" href="${esc(i.href)}"${on ? ' aria-current="page"' : ""}>` +
      `<span>${esc(i.label)}</span>${on ? '<span class="bar"></span>' : ""}</a>`;
  }).join("");
  return `<div class="nav"><div class="wrap nav-in">
<div class="brand"><img src="/logo/schelling-mark-accent-dark.svg" alt="">
<span class="wordmark">${esc(nav.wordmark.text)}<span>${esc(nav.wordmark.mark)}</span></span></div>
<nav class="nav-right">${items}<a class="btn btn-sm" href="${esc(OV.CONNECT_URL)}">${esc(nav.cta.label)}</a></nav>
</div></div>`;
}

// One line of status, outside the approved copy: the release, where what works and what is
// planned is written, and that nothing is charged. It is split around its one address so
// the footer can link it and the agent page's block can write it as markdown.
const STATUS_BEFORE_LINK = "Early release, version 0.2. What works today and what is planned: ";
const STATUS_AFTER_LINK = ". Nothing is charged today.";

export function renderFooter() {
  const { footer } = OV;
  const links = footer.links.map((l) =>
    `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join("");
  // The same address the terms and the privacy policy publish, so a person who reads
  // either meets it again in the footer of every other page. scripts/launch-check.mjs
  // holds the production image if a placeholder comes back in its place.
  const contact = footer.contact
    ? `<a class="foot-contact" href="mailto:${esc(footer.contact)}">${esc(footer.contact)}</a>` : "";
  return `<footer class="foot terminal"><div class="wrap foot-in">
<div class="foot-l"><img src="/logo/schelling-mark-paper.svg" alt=""><span>${esc(footer.tagline)} ${esc(STATUS_BEFORE_LINK)}<a href="/api">/api</a>${esc(STATUS_AFTER_LINK)}</span></div>
<div class="foot-r">${links}${contact}</div>
</div></footer>`;
}

// The one menu, as the agent page writes it. Every page this build writes for a
// person carries the same line, rendered, so the built pages and the live pages
// look alike: plain, and following the reader's own light or dark setting.
const MENU_LINE = `Menu: [Home](/) · [Spaces](/spaces) · [Seek](/seek) · [Vocabulary](/vocabulary) · [API](/api) · [Connect](${OV.CONNECT_URL})`;

// The plain page a person reads: the menu, the page, and the footer the live
// pages carry, with the status line, the terms, both sources and the address.
function plainDocument(page, bodyHtml, after = "") {
  const { footer } = OV;
  const links = footer.links.map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join(" &middot; ");
  return htmlDocument(page, `<main>
<nav><p>${inline(MENU_LINE)}</p></nav>
${bodyHtml}
<footer>
<p>${esc(footer.tagline)} ${esc(STATUS_BEFORE_LINK)}<a href="/api">/api</a>${esc(STATUS_AFTER_LINK)}</p>
<p>${links} &middot; <a href="mailto:${esc(footer.contact)}">${esc(footer.contact)}</a></p>
</footer>
</main>${after}`);
}

export function navMarkdown(page) {
  const lines = [];
  if (page.meta.audience === "agent") {
    // The same menu, in the same order, as every page for people: `nav` in
    // content/human-overview.mjs and siteMenu() in src/render.ts. It is on this page
    // too. Each address answers markdown to an agent that asks for it, so the one menu
    // serves both readers.
    lines.push(MENU_LINE);
    // The line for a person comes second, bold, so a person who lands here reads it
    // before anything else and an agent still reads the menu first.
    if (page.meta.counterpart) lines.push(`**Human reader? Ordinary English: [${page.meta.counterpart}](${page.meta.counterpart})**`);
    // Both documents address an agent directly -- the terms say so in their own second
    // line -- so an agent meets them where it reads, rather than only in the footer a
    // person sees. Both must be easy for either reader to find. They are deliberately
    // not in the menu above, which is the same six entries in the same order on every
    // page, written in three places: here, `nav` in content/human-overview.mjs, and
    // siteMenu() in src/render.ts. Change all three together.
    lines.push(`Terms and privacy, which apply to an agent as well: [/terms](/terms) · [/privacy](/privacy)`);
    // The one page on multi-agent coordination, linked from every other page for an
    // agent, so the homepage carries the phrase as a link (the owner, 7 October 2026).
    if (page.route !== "/multi-agent-coordination") lines.push(`How agents coordinate here: [multi-agent coordination](/multi-agent-coordination)`);
    lines.push(`Every space on the service, live: [/spaces.md](/spaces.md)`);
    lines.push(`All pages and formats: [/llms.txt](/llms.txt)`);
    // Both repositories, for an agent reading the page it is built from. Each address
    // is written once in content/human-overview.mjs, where the footer every page for
    // people takes it too.
    lines.push(`The source of this service: [${OV.SOURCE_URL}](${OV.SOURCE_URL})`);
    lines.push(`The source of this site: [${OV.SITE_SOURCE_URL}](${OV.SITE_SOURCE_URL})`);
    lines.push(`${STATUS_BEFORE_LINK}[/api](/api)${STATUS_AFTER_LINK}`);
  } else {
    // Humans get one link, not a directory listing. /llms.txt is for agents.
    //
    // This block is the markdown representation's nav only. The HTML of a human
    // page carries the designed nav bar instead, so it never shows both.
    if (page.meta.counterpart) lines.push(`This page is in ordinary English. The version written for agents is at [${page.meta.counterpart}](${page.meta.counterpart}).`);
    // A human page with no agent counterpart -- terms, privacy -- would otherwise
    // render an empty nav and a markdown file starting with two blank lines.
    else lines.push(`${SITE_NAME}: [API](/api) · [terms](/terms) · [privacy](/privacy) · [written for agents](/)`);
  }
  return lines.map((l) => "> " + l + "  ").join("\n");
}

// The search headline. Homepage leads with the name; every other page uses the
// conventional "Page — Site" form. A page whose own title already contains the
// site name is left alone, so titles never double up.
function pageTitle(page) {
  // A designed page states its own search headline, because its best one is a
  // sentence from the page rather than the index entry an agent reads.
  if (page.htmlTitle) return page.htmlTitle;
  if (page.route === "/") return `${SITE_NAME} — ${TAGLINE}`;
  const t = page.meta.title;
  return t.includes(SITE_NAME) ? t : `${t} — ${SITE_NAME}`;
}

// The head every page shares. Every page is plain and loads nothing but its own
// script, if it has one. The designed shell -- its stylesheet, self-hosted font and
// logos, all from this origin -- is for a page that asks for it with
// `designedShell`, which today is only /human, taken down: the owner, 2 October
// 2026, had every other page put in the plain look.
function htmlHead(page) {
  const human = page.meta.audience === "human";
  const designed = Boolean(page.designedShell);
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pageTitle(page))}</title>
<meta name="description" content="${esc(page.meta.summary)}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:${human ? "large" : "none"}">
<link rel="canonical" href="${esc(SITE + page.route)}">
<link rel="alternate" type="text/markdown" href="${esc(page.mdPath)}">
<link rel="alternate" type="application/json" href="${esc(page.jsonPath)}">
${designed ? HUMAN_HEAD : TAB_ICON}
<style>${designed ? OVERVIEW_CSS : CSS_AGENT}</style>`;
}

// The tab icon of every page that loads nothing: the mark written into the page as data,
// so the tab shows it and the page still asks this origin for nothing. The svg for the
// browsers that draw one, and a 32-pixel png for those that do not. The live pages take
// the same two lines from src/routes.generated.ts.
export const TAB_ICON = `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(readFileSync("assets/logo/favicon.svg", "utf8").trim())}" type="image/svg+xml">
<link rel="icon" href="data:image/png;base64,${readFileSync("assets/logo/schelling-icon-32.png").toString("base64")}" sizes="32x32" type="image/png">`;

// Icons, theme colour and the font preload, for every page a person opens.
const HUMAN_HEAD = `<meta name="theme-color" content="#07080A">
<link rel="icon" href="/logo/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/logo/schelling-icon-512.png" sizes="512x512" type="image/png">
<link rel="apple-touch-icon" href="/logo/schelling-icon-512.png">
<link rel="preload" href="/fonts/jetbrains-mono-latin.woff2" as="font" type="font/woff2" crossorigin>`;

// Every built page is this one document: the shared head, and a body that the
// page's own renderer writes.
const htmlDocument = (page, body) => `<!doctype html>
<html lang="en">
<head>
${htmlHead(page)}
</head>
<body>
${body}
</body>
</html>
`;

// The fields every page's JSON begins with, in this order, whichever renderer
// writes the rest.
const jsonHead = (page) => ({
  title: page.meta.title,
  summary: page.meta.summary,
  audience: page.meta.audience,
  url: SITE + page.route,
  formats: { html: page.route, markdown: page.mdPath, json: page.jsonPath },
  // terms and privacy are named on every page, in the machine-readable rendering too,
  // so an agent that holds one page's JSON never has to look for either; so are both
  // repositories.
  navigation: {
    index: "/llms.txt", terms: "/terms", privacy: "/privacy",
    source: { service: OV.SOURCE_URL, site: OV.SITE_SOURCE_URL },
    ...(page.meta.counterpart ? { counterpart: page.meta.counterpart } : {}),
  },
});

function htmlDoc(page, nav, bodyHtml) {
  // A human markdown page -- terms, privacy -- is a plain page with the menu.
  if (page.meta.audience === "human") {
    // Its HTML drops the markdown nav block, because the menu above says the
    // same thing better -- but only when it really does; the markdown
    // representation keeps it. A page whose counterpart is not one of the menu's
    // own destinations would otherwise link its agent version from its markdown
    // and its JSON and not from the page a person opens. No page is in that
    // position today; adding one is meant to be the whole job, so it has to work
    // when somebody does.
    const inNav = MENU_LINE.includes(`](${page.meta.counterpart})`);
    const counterpart = page.meta.counterpart && !inNav ? `<p class="meta">${nav}</p>\n` : "";
    return plainDocument(page, `${counterpart}${bodyHtml}`);
  }
  return htmlDocument(page, `<main>
<nav>${nav}</nav>
${bodyHtml}
</main>`);
}

// --------------------------------------- approved-copy guard for /human
//
// reference/approved-copy.md is the approved text, vendored so this check
// has a reference OUTSIDE the data it checks. Every sentence in it must appear
// in the rendered page. Reword or drop one and the build stops.
//
// The reference must be external. A check that walked the copy OBJECT would be
// worthless: deleting a sentence from the object also deletes it from the check,
// so the build would stay green while the sentence vanished from the site.

const APPROVED = readFileSync("reference/approved-copy.md", "utf8");

// Sentences the design legitimately renders in split form, so a contiguous match
// is impossible. Every part is still required to be present, individually.
const SPLIT_RENDERED = [
  // The name section sets the pronunciation as a display line and the Schelling
  // gloss as a coda, with the two glyph glosses between them.
  ["Pronounced", "Schelling Add Forward", "Schelling refers to a natural meeting point for coordination"],
  // The glyph is a large accent character; its gloss sits beside it.
  ["means adding knowledge, capability, or help"],
  ["means carrying progress forward"],
];

// Approved copy deliberately NOT rendered, each with its reason. This is the
// only sanctioned way to drop approved copy and it must stay short.
const OMITTED = [];

export function assertApprovedCopy(html, md, _json) {
  const strip = (s) => s
    .replace(/\*\*/g, "").replace(/^\s*[-*]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^>\s?/gm, "");
  // Letters and digits are compared, and so are the mark's own two characters: with
  // letters and digits alone, a page that lost every "+>" of "Schelling+>" would pass.
  const norm = (s) => s
    .replace(/[“”]/g, '"').replace(/[’‘]/g, "'").replace(/[—–]/g, "-")
    .replace(/[^a-z0-9+>]/gi, "").toLowerCase();

  const page = norm(stripTags(html));
  const mdText = norm(md);

  // Each "## " block is a heading plus body. A heading may carry a bracketed
  // editorial note, which is not copy and is stripped. The body is copy as it stands.
  const sentences = [];
  for (const block of APPROVED.split(/^## /m).slice(1)) {
    const nl = block.indexOf("\n");
    const heading = block.slice(0, nl).replace(/\s*\[[^\]]*\]\s*$/, "").trim();
    if (norm(heading).length > 14) sentences.push(heading);
    strip(block.slice(nl)).split(/(?<=[.?!])\s+|\n+/)
      .map((s) => s.trim()).filter((s) => norm(s).length > 14)
      .forEach((s) => sentences.push(s));
  }

  const excused = (want) =>
    OMITTED.some((o) => norm(o) === want) ||
    SPLIT_RENDERED.some((parts) => parts.every((x) => want.includes(norm(x))) && parts.every((x) => page.includes(norm(x))));

  for (const s of sentences) {
    const want = norm(s);
    if (page.includes(want) || excused(want)) continue;
    fail("reference/approved-copy.md", 1, `approved sentence is not on /human:\n    ${s.slice(0, 88)}`);
  }
  // Prose must also survive into the markdown reading format.
  for (const s of sentences) {
    const want = norm(s);
    if (want.length < 60 || mdText.includes(want) || excused(want)) continue;
    fail("reference/approved-copy.md", 1, `approved sentence is not in /human.md:\n    ${s.slice(0, 88)}`);
  }
  return sentences.length;
}

// ------------------------------------------------- designed human overview
//
// /human is a designed layout, not a markdown document, so it has its own
// renderer. Its copy lives in content/human-overview.mjs and both this HTML and
// the markdown/JSON versions below are generated from that one object, so they
// cannot drift.

function renderOverview(page) {
  const { hero, feed, why, mechanisms, name, plainly, connect } = OV;

  const heroActions = hero.actions.map((a) =>
    `<a class="${a.solid ? "btn btn-lg" : "link"}" href="${esc(a.href)}">${esc(a.label)}</a>`).join("");

  const mechs = mechanisms.map((m) =>
    `<div class="rack-row"><span class="rack-eyebrow">${esc(m.eyebrow)}</span>` +
    `<span class="rack-title">${esc(m.title)}</span>` +
    `<span class="rack-body pretty">${esc(m.body)}</span></div>`).join("");

  const glosses = name.glosses.map((g) =>
    `<div class="gloss"><b>${esc(g.glyph)}</b><span>${esc(g.text)}</span></div>`).join("");

  // Nine compositions, none repeating on consecutive sections. Right-hand ink
  // comes only from alignment, so DOM order always equals visual order. A pull
  // promotes one WHOLE existing sentence; it never splits one.
  const L = OV.layout, MV = OV.movements;

  // Inline emphasis inside an intact sentence. The sentence stays one string in
  // the source and one text run on the page; only its weight changes.
  //
  // A span that marks nothing fails the build. Matching is exact, so rewording a
  // sentence would otherwise orphan its emphasis silently.
  const unmarked = new Set(Object.entries(L).flatMap(([id, c]) => (c.emphasis || []).map((x) => `${id}: ${x}`)));
  const mark = (text, spans, id) => {
    let out = esc(text);
    for (const s of spans || []) {
      const e = esc(s);
      if (!out.includes(e)) continue;
      out = out.replace(e, `<b class="k">${e}</b>`);
      unmarked.delete(`${id}: ${s}`);
    }
    return out;
  };

  const band = (m) => !m ? "" :
    `<div class="movement"><div class="movement-in">` +
    `<span class="movement-n">${esc(m.n)}</span>` +
    `<span class="movement-l">${esc(m.label)}</span>` +
    `<span class="movement-r">${esc(m.range)}</span></div></div>`;

  const chapters = OV.sections.map((s, i) => {
    const c = L[s.id];
    const n = String(i + 1).padStart(2, "0");
    const em = c.emphasis;

    // Which sentence is promoted. It is moved whole, never split.
    const pullKey = c.pull;
    const bodyIdx = pullKey && pullKey.startsWith("body") ? Number(pullKey.slice(4)) : null;
    const pullText = pullKey === "lead" ? s.lead : bodyIdx !== null ? s.body[bodyIdx] : null;
    const leadText = pullKey === "lead" ? null : s.lead;
    const bodyRest = s.body.filter((_, k) => k !== bodyIdx);

    const eyebrow = `<span class="eyebrow eyebrow-accent">${esc(s.eyebrow)}</span>`;
    const folio = `<span class="folio">${n} / ${OV.sections.length}</span>`;
    const chead = `<div class="chead${c.comp === "hang-r" ? " chead--end" : ""}">${eyebrow}${folio}</div>`;
    const h2 = `<h2 class="pretty">${esc(s.heading)}</h2>`;
    const head = chead + h2;

    const lead = leadText ? `<p class="lead pretty">${mark(leadText, em, s.id)}</p>` : "";
    const pullCls = c.pullStyle === "beam" ? "beam" : c.pullStyle === "peak" ? "pull pull--peak" : "pull";

    // A promoted body sentence is rendered IN PLACE, not hoisted above the
    // paragraphs it was written after. Promotion changes a sentence's size, and
    // must never change the order of the argument.
    //
    // The exception is ANCHOR-R, whose whole point is that the block moves off
    // the home edge and leaves its conclusion behind; there the promoted
    // sentence is the LAST one, so trailing it still reads in order.
    const inPlace = bodyIdx !== null && c.comp !== "anchor";
    const proseItems = inPlace ? s.body : bodyRest;
    const prose = proseItems.length
      ? `<div class="prose">${proseItems.map((x, k) =>
          inPlace && k === bodyIdx
            ? `<p class="${pullCls} pretty">${esc(x)}</p>`
            : `<p class="pretty">${mark(x, em, s.id)}</p>`).join("")}</div>` : "";

    const pull = pullText && !inPlace ? `<p class="${pullCls} pretty">${esc(pullText)}</p>` : "";
    const brk = c.brk ? `<div class="brk" aria-hidden="true"><i></i><u></u><u></u><i></i></div>` : "";

    const frames = s.defs?.length
      ? `<div class="frames">${s.defs.map(([k, v]) =>
          `<div><dl><dt>${esc(k)}</dt><dd>${esc(v)}</dd></dl></div>`).join("")}</div>` : "";
    const panel = s.quote
      ? `<div class="panel"><div class="panel-head">${esc(s.quote.label)}</div>` +
        `<div class="panel-body">${s.quote.lines.map((l) => `<p>${esc(l)}</p>`).join("")}</div></div>` : "";
    const after = s.after ? `<p class="after pretty">${mark(s.after, em, s.id)}</p>` : "";

    // Composition. Every arrangement keeps DOM order = reading order.
    let inner;
    if (c.comp === "rail") {
      // The folio leads here, above the eyebrow; in the chapter head it trails.
      inner =
        `<div class="rail"><div class="rail-margin">${folio}${eyebrow}</div>` +
        `<div class="rail-body">${h2}${lead}${pull}${prose}${frames}${panel}${after}</div></div>`;
    } else if (c.comp === "anchor") {
      // The heading travels with the block, so the whole chapter sits off the
      // home edge and only its promoted conclusion stays behind at x=108.
      inner = chead +
        `<div class="anchor${c.tier === "quiet" ? " anchor--narrow" : ""}">` +
        `${h2}${lead}${prose}${frames}${panel}${after}</div>${pull}`;
    } else if (c.comp === "spine") {
      inner = `${head}${pull}<div class="spine">${lead}${prose}${frames}${panel}${after}</div>`;
    } else {
      // span, hang-r and plate share the vertical stack; their difference is
      // alignment, which is expressed by the section class, not the markup.
      inner = `${head}${lead}${pull}${brk}${prose}${frames}${panel}${after}`;
    }

    const isPlate = c.comp === "plate";
    const shell = isPlate
      ? `<section class="plate rel reveal" id="${s.id}"><div class="wash"></div>` +
        `<div class="plate-in chapter h-${c.tier}">${inner}</div></section>`
      : `<section class="chapter-sec reveal" id="${s.id}">` +
        `<div class="wrap chapter h-${c.tier} comp-${c.comp}">${inner}</div></section>`;

    return band(MV[s.id]) + shell;
  }).join("\n");

  if (unmarked.size) {
    fail("content/human-overview.mjs", 1, `emphasis matches no sentence it can mark in its section:\n    ` +
      [...unmarked].join("\n    "));
  }

  return `<div class="progress" aria-hidden="true"><i></i></div>
${renderNav(page.route)}

<main>
<section class="hero rel"><div class="wash"></div>
<div class="wrap col hero-in">
<div class="status"><span class="dot"></span><span class="eyebrow">${esc(hero.status)}</span></div>
<h1 class="hero-h pretty">${esc(hero.heading)}</h1>
<p class="lead pretty">${esc(hero.lead)}</p>
<div class="hero-support">${hero.support.map((x) => `<p class="support pretty">${esc(x)}</p>`).join("")}</div>
<div class="actions">${heroActions}</div>
</div></section>

<section class="reveal feed" id="feed" data-entries="${esc(JSON.stringify(feed.entries))}">
<div class="wrap col feed-in">
<div class="feed-head">
<div class="feed-head-l"><span class="feed-label">${esc(feed.label)}</span><span class="feed-badge">${esc(feed.badge)}</span></div>
<span class="clock"></span>
</div>
<div class="feed-rows col">${feed.entries.slice(0, 3).map((e) =>
  `<div class="feed-row"><span class="feed-tag">${esc(e[0])}</span><span class="feed-text">${esc(e[1])}</span></div>`).join("")}</div>
</div></section>

<section class="reveal wrap sec" id="need">
<div class="eyebrow eyebrow-warn">${esc(why.eyebrow)}</div>
<h2 class="big pretty">${esc(why.heading)}</h2>
<div class="stair">${why.paragraphs.map((x) => `<p class="pretty">${esc(x)}</p>`).join("")}</div>
<div class="investigation"><a href="${esc(why.link.href)}">${esc(why.link.label)}</a></div>
</section>

<section class="reveal rule"><div class="wrap sec"><div class="rack">${mechs}</div></div></section>

<section class="reveal plate rel"><div class="wash"></div>
<div class="plate-in name-in">
<img src="/logo/schelling-mark-accent-dark.svg" alt="">
<div class="eyebrow eyebrow-accent">${esc(name.eyebrow)}</div>
<div class="name-statement pretty">${esc(name.statement)}</div>
<div class="glosses">${glosses}</div>
<div class="coda">${name.coda.map((c) => `<p>${esc(c)}</p>`).join("")}</div>
</div></section>

${chapters}

<section class="rule"><div class="wrap plainly">
<div class="eyebrow eyebrow-warn">${esc(plainly.eyebrow)}</div>
<div class="statement pretty">${esc(plainly.heading)}</div>
<div class="three-col">${plainly.items.map((x) => `<div>${esc(x)}</div>`).join("")}</div>
</div></section>

<section class="reveal connect rel terminal" id="connect"><div class="wash"></div>
<div class="wrap col connect-in">
<h2 class="huge pretty">${esc(connect.heading)}</h2>
<p class="pretty">${esc(connect.body)}</p>
<p class="pretty">${esc(connect.body2)}</p>
<div class="actions"><a class="btn btn-lg" href="${esc(connect.primary.href)}">${esc(connect.primary.label)}</a></div>
<div class="closing"><a class="link" href="${esc(connect.pendingHref)}">${esc(connect.pending)}</a><a class="link link-accent" href="${esc(connect.secondary.href)}">${esc(connect.secondary.label)}</a></div>
<p class="reserved">${esc(connect.reserved)}</p>
</div></section>
</main>

${renderFooter()}`;
}

function overviewDoc(page) {
  // NOTE: the Content-Security-Policy for this page is set in src/index.ts, not
  // here. It must be the relaxed one -- this page loads a script, a font and SVG
  // logos, all of which the agent pages' strict policy forbids. The handler decides
  // that from the page's audience, which build.mjs writes into
  // src/routes.generated.ts, so a new human page needs no change there either.
  return htmlDocument(page, `${renderOverview(page)}
<script src="/overview.js" defer></script>`);
}

// The first lines of /human.md and /api.md. The two trailing spaces on the first
// are a markdown hard break, so the second line starts a line of its own.
const DESIGNED_MD_HEADER = [
  `> This page is in ordinary English. The version written for agents is at [/](/)  `,
  `> Terms and privacy: [/terms](/terms) · [/privacy](/privacy)`,
  "",
];

// Markdown and JSON for the same page, generated from the same copy object so
// agents get the designed page's actual content rather than a stale duplicate.
function overviewMarkdown() {
  const { hero, feed, why, mechanisms, name, plainly, connect } = OV;
  const L = [...DESIGNED_MD_HEADER];
  L.push(`# Schelling+>`, "", `## ${hero.heading}`, "", hero.lead, "");
  hero.support.forEach((x) => L.push(x, ""));
  L.push(`## ${why.heading}`, "");
  why.paragraphs.forEach((p) => L.push(p, ""));
  L.push(`[${why.link.label}](${why.link.href})`, "");
  L.push(`## How it works`, "");
  mechanisms.forEach((m) => L.push(`- **${m.title}** (${m.eyebrow}) — ${m.body}`));
  L.push("", `## ${name.eyebrow}`, "", name.statement, "");
  name.glosses.forEach((g) => L.push(`- \`${g.glyph}\` ${g.text}`));
  L.push("", ...name.coda.flatMap((c) => [c, ""]));
  L.push(`## ${plainly.eyebrow}`, "", plainly.heading, "");
  plainly.items.forEach((x) => L.push(`- ${x}`));
  // Every full-copy section, so the markdown carries the same content as the page.
  OV.sections.forEach((s) => {
    L.push(`## ${s.heading}`, "", s.lead, "");
    s.body.forEach((x) => L.push(x, ""));
    (s.defs || []).forEach(([k, v]) => L.push(`- **${k}** — ${v}`));
    if (s.defs) L.push("");
    if (s.quote) {
      L.push(`*${s.quote.label.toLowerCase()}*`, "");
      s.quote.lines.forEach((l) => L.push(`> ${l}`, ">"));
      L.push("");
    }
    if (s.after) L.push(s.after, "");
  });
  L.push(`## ${connect.heading}`, "", connect.body, "", connect.body2, "");
  L.push(`[${connect.pending}](${connect.pendingHref})`, "", connect.reserved, "");
  L.push(`${feed.badge}: the entries shown on this page are illustrative examples, not live activity.`, "");
  return L.join("\n");
}

function overviewJson(page) {
  return {
    ...jsonHead(page),
    hero: { heading: OV.hero.heading, lead: OV.hero.lead, support: OV.hero.support },
    why: { heading: OV.why.heading, paragraphs: OV.why.paragraphs, source: OV.why.link.href },
    mechanisms: OV.mechanisms,
    name: { statement: OV.name.statement, glosses: OV.name.glosses, notes: OV.name.coda },
    limits: { heading: OV.plainly.heading, items: OV.plainly.items },
    connect: { heading: OV.connect.heading, body: [OV.connect.body, OV.connect.body2], reserved: OV.connect.reserved },
    sections: OV.sections.map((s) => ({
      id: s.id, heading: s.heading, lead: s.lead,
      body: s.body || [],
      ...(s.defs ? { options: s.defs.map(([k, v]) => ({ name: k, description: v })) } : {}),
      ...(s.quote ? { illustrative: s.quote.lines } : {}),
      ...(s.after ? { note: s.after } : {}),
    })),
    disclosure: "Feed entries shown on the HTML page are illustrative examples, not live activity.",
  };
}

// ------------------------------------------------------------ the API page
//
// The API page: one plain column, like every other page, with the menu on top. Its
// content is the API's own statement about itself, in a person's words. It was a
// designed three-pane page with a dark shell until the owner, 2 October 2026, had
// it put in the plain look; its words did not change.
//
// Nothing here is an illustration: a fiction on the page a sceptic reads is worse
// than an absence.

// One definition: a term and what it means.
//
// `termHtml` is the one place a caller may pass markup instead of text, and it
// exists because the documents section links its terms. It is an explicit flag
// rather than a guess from the term's first character: text is escaped unless the
// caller says, in as many words, that it built the markup itself.
const row = (term, text, { termHtml = false, afterHtml = "" } = {}) =>
  `<dt>${termHtml ? term : esc(term)}</dt><dd>${esc(text)}${afterHtml}</dd>`;

const rows = (items) => `<dl>${items.join("")}</dl>`;

// The block a step names, for the page and its markdown alike. It fails loudly on
// a block the copy module does not define, because the quiet alternative is a
// step whose configuration file is simply absent from the page, which reads as a
// step with nothing to copy.
function blockNamed(key) {
  const b = AP.blocks[key];
  if (!b) fail("content/api-overview.mjs", 1, `a step names a block that does not exist: ${key}`);
  return b;
}

// A block of literal text a person moves somewhere else, with the copy button
// src/copy.js hangs off its head. The button is NOT written here: a page whose
// script is blocked would then carry a button that does nothing, where this way
// it carries the text, still selectable and still correct.
function apiBlock(key) {
  const b = blockNamed(key);
  return `<div class="block"><div class="block-head">${esc(b.label)}</div>` +
    `<pre>${esc(b.text)}</pre></div>`;
}

export function renderApi() {
  const { page, contents, contentsNote, chooser, states, starts, startLinks, tokens, today, jobs, tools, documents } = AP;

  // Every step ends with what the reader should see, and some with what it means
  // when they do not. The second is rendered only where the copy has one: an
  // empty troubleshooting line is worse than none, because it reads as "nothing
  // can go wrong here".
  const stepHtml = (s) =>
    `<li><p><strong>${esc(s.title)}</strong> ${esc(s.body[0])}</p>` +
    s.body.slice(1).map((b) => `<p>${esc(b)}</p>`).join("") +
    (s.block ? apiBlock(s.block) : "") +
    (s.done ? `<p><em>You should see.</em> ${esc(s.done)}</p>` : "") +
    (s.otherwise ? `<p><em>If you do not.</em> ${esc(s.otherwise)}</p>` : "") +
    `</li>`;

  // The pages on this site a path ends at, gathered rather than linked mid-
  // sentence: the prose here is escaped whole, so an anchor inside a paragraph
  // would have to be assembled from fragments, and scripts/verify.sh can ask a
  // list of addresses whether they answer where it cannot ask a paragraph.
  const startLinksHtml = (id) => {
    const links = startLinks[id];
    if (!links) return "";
    return `<p>Pages on this site: ` +
      links.map(([label, href]) => `<a href="${esc(href)}">${esc(label)}</a>`).join(" · ") + `</p>`;
  };

  const startHtml = (q) => {
    const state = states[q.state];
    if (!state) fail("content/api-overview.mjs", 1, `the quick start ${q.id} claims a state nothing defines: ${q.state}`);
    return `<h2 id="${esc(q.id)}">${esc(q.heading)} — ${esc(state.label)}</h2>
<p>${esc(q.who)}</p>
<p><strong>What you need.</strong> ${esc(q.need)}</p>
<p><strong>How long.</strong> ${esc(q.time)}</p>
<ol>${q.steps.map(stepHtml).join("")}</ol>
${startLinksHtml(q.id)}`;
  };

  const toc = contents.map((c) => `<li><a href="#${esc(c.id)}">${esc(c.label)}</a></li>`).join("");

  // A document that also has a page on this site links it after its description.
  const docLinks = documents.items.map(([label, path, text, page]) =>
    row(`<a href="${esc(API_ORIGIN + path)}">${esc(label)}</a>`, text,
      { termHtml: true, afterHtml: page ? ` <a href="${esc(page[0])}">${esc(page[1])}</a>.` : "" }));

  return `<h1>${esc(page.heading)}</h1>
<p class="meta">${esc(page.eyebrow)} · ${esc(page.status)}</p>
<p>${esc(page.lead)}</p>
<p>${esc(page.person)} <a href="${esc(page.personLink.href)}">${esc(page.personLink.label)}</a></p>
<p><strong>On this page</strong></p>
<ul>${toc}</ul>
<p><em>${esc(contentsNote)}</em></p>

<h2 id="start">${esc(chooser.heading)}</h2>
<p>${esc(chooser.lead)}</p>
<ul>${chooser.rows.map((r) =>
  `<li>${esc(r.what)} → <a href="${esc(r.href)}">${esc(r.go)}</a></li>`).join("")}</ul>
<p>${esc(chooser.note)}</p>
${rows(Object.values(states).map((s) => row(s.label, s.meaning)))}
<p><strong>${esc(chooser.planned.label)}.</strong> ${esc(chooser.planned.lead)}</p>
${rows(chooser.planned.items.map(([t, x]) => row(t, x)))}

${starts.map(startHtml).join("\n")}

<h2 id="tokens">${esc(tokens.heading)}</h2>
<p>${esc(tokens.lead)}</p>
${rows(tokens.facts.map(([t, x]) => row(t, x)))}
<p>${esc(tokens.note)}</p>

<h2 id="today">${esc(today.heading)}</h2>
<p>${esc(today.lead)}</p>
<p><strong>Available now.</strong></p>
${rows(today.available.map(([t, x]) => row(t, x)))}
<p><strong>Planned.</strong></p>
${rows(today.planned.map(([t, x]) => row(t, x)))}
<p><strong>${esc(today.plainly.label)}</strong></p>
${today.plainly.lines.map((l) => `<p>${esc(l)}</p>`).join("")}

<h2 id="jobs">${esc(jobs.heading)}</h2>
<p>${esc(jobs.lead)}</p>
<p><strong>Starts.</strong></p>
${rows(jobs.starts.map(([name, path, text]) =>
  row(`<a href="${esc(API_ORIGIN + path)}">${esc(name)}</a>`, text, { termHtml: true })))}
<p>${esc(jobs.startsNote)}</p>
<p><strong>Toolsets.</strong> ${esc(jobs.toolsetsLead)}</p>
${rows(jobs.toolsets.map(([name, path, text]) => row(API_ORIGIN + path, text)))}
<p>${esc(jobs.toolsetsNote)}</p>

<h2 id="tools">${esc(tools.heading)}</h2>
<p>${esc(tools.lead)}</p>
${rows(tools.items.map(([t, x]) => row(t, x)))}
<p><strong>Documents an app attaches.</strong></p>
${rows(tools.documents.map(([t, x]) => row(t, x)))}
<p><strong>Prompts.</strong></p>
${rows(tools.prompts.map(([t, x]) => row(t, x)))}
<p>${esc(tools.after)}</p>

<h2 id="documents">${esc(documents.heading)}</h2>
<p>${esc(documents.lead)}</p>
${rows(docLinks)}
<p>${esc(documents.note)}</p>`;
}

function apiDoc(page) {
  // One script, and it animates nothing. src/copy.js exists because every block
  // here is text a person moves into somewhere else, and selecting a multi-line
  // block with a trackpad and missing the last line is how a configuration file
  // ends up one brace short. It builds the buttons rather than the page carrying
  // them, so with the script blocked there is no button that does nothing.
  return plainDocument(page, renderApi(), `
<script src="/copy.js" defer></script>`);
}

// The blocks as the markdown writes them: a fenced block in the language the copy
// module names, which is the right way to hand somebody a configuration file and
// the reason this representation is written out rather than parsed from content/.
function apiMarkdownBlock(key, L) {
  const b = blockNamed(key);
  // The label is pushed as written rather than lowercased. It is the same label
  // the page shows and the same one /api.json carries, and checkRendered compares
  // the three letter for letter, so a lowercased label here fails the build.
  L.push(`   **${b.label}**`, "", "```" + b.lang, b.text, "```", "");
}

// The markdown representation. Unlike content/*.md this is written out rather than
// parsed, so it may use constructs the strict converter refuses -- a fenced block
// is the right way to hand somebody a configuration file, and no page written in
// content/ can carry one.
export function apiMarkdown() {
  const { page, contentsNote, chooser, states, starts, startLinks, tokens, today, jobs, tools, documents } = AP;
  const L = [...DESIGNED_MD_HEADER];
  L.push(`# ${page.heading.replace(/\.$/, "")}`, "", page.lead, "");
  L.push(`${page.person} [${page.personLink.label}](${page.personLink.href})`, "");
  L.push(`*${contentsNote}*`, "");

  L.push(`## ${chooser.heading}`, "", chooser.lead, "");
  chooser.rows.forEach((r) => L.push(`- ${r.what} → **${r.go}**`));
  L.push("", chooser.note, "");
  Object.values(states).forEach((s) => L.push(`- **${s.label}** — ${s.meaning}`));
  L.push("", `**${chooser.planned.label}.** ${chooser.planned.lead}`, "");
  chooser.planned.items.forEach(([t, x]) => L.push(`- **${t}** — ${x}`));
  L.push("");

  // Each quick start is its own section, so /api.md read in a terminal skips the
  // four that do not apply exactly as the page does.
  starts.forEach((q) => {
    L.push(`## ${q.heading} — ${states[q.state].label}`, "", q.who, "");
    L.push(`**What you need.** ${q.need}`, "", `**How long.** ${q.time}`, "");
    q.steps.forEach((s, i) => {
      L.push(`${i + 1}. **${s.title}** ${s.body[0]}`, "");
      s.body.slice(1).forEach((b) => L.push(`   ${b}`, ""));
      if (s.block) apiMarkdownBlock(s.block, L);
      if (s.done) L.push(`   *You should see.* ${s.done}`, "");
      if (s.otherwise) L.push(`   *If you do not.* ${s.otherwise}`, "");
    });
    (startLinks[q.id] ?? []).forEach(([label, href]) => L.push(`- [${label}](${href})`));
    if (startLinks[q.id]) L.push("");
  });

  L.push(`## ${tokens.heading}`, "", tokens.lead, "");
  tokens.facts.forEach(([t, x]) => L.push(`- **${t}** — ${x}`));
  L.push("", tokens.note, "");

  L.push(`## ${today.heading}`, "", today.lead, "");
  L.push("**Available now.**", "");
  today.available.forEach(([t, x]) => L.push(`- **${t}** — ${x}`));
  L.push("", "**Planned.**", "");
  today.planned.forEach(([t, x]) => L.push(`- **${t}** — ${x}`));
  L.push("", `**${today.plainly.label}**`, "");
  today.plainly.lines.forEach((l) => L.push(l, ""));
  L.push(`## ${jobs.heading}`, "", jobs.lead, "", "**Starts.**", "");
  jobs.starts.forEach(([name, path, text]) => L.push(`- [${name}](${API_ORIGIN}${path}) — ${text}`));
  L.push("", jobs.startsNote, "", `**Toolsets.** ${jobs.toolsetsLead}`, "");
  jobs.toolsets.forEach(([name, path, text]) => L.push(`- \`${API_ORIGIN}${path}\` — ${text}`));
  L.push("", jobs.toolsetsNote, "");
  L.push(`## ${tools.heading}`, "", tools.lead, "");
  tools.items.forEach(([t, x]) => L.push(`- \`${t}\` — ${x}`));
  L.push("", "**Documents an app attaches.**", "");
  tools.documents.forEach(([t, x]) => L.push(`- \`${t}\` — ${x}`));
  L.push("", "**Prompts.**", "");
  tools.prompts.forEach(([t, x]) => L.push(`- \`${t}\` — ${x}`));
  L.push("", tools.after, "");
  L.push(`## ${documents.heading}`, "", documents.lead, "");
  documents.items.forEach(([label, path, text, page]) =>
    L.push(`- [${label}](${API_ORIGIN}${path}) — ${text}${page ? ` ${page[1]}: ${page[0]}.md` : ""}`));
  L.push("", documents.note, "");
  return L.join("\n");
}

export function apiJson(page) {
  // A scope entry, with the service's own module identifier where it has one.
  // Keys stay in the order name, description, module.
  const withModule = ([name, description]) =>
    ({ name, description, ...(AP.moduleKeys[name] ? { module: AP.moduleKeys[name] } : {}) });
  return {
    ...jsonHead(page),
    // The page's own prose, so the JSON is a representation of the page rather
    // than a summary of it. checkRendered asserts the copy's prose reaches all
    // three renderings, and this block is what makes that true here.
    page: {
      status: AP.page.status,
      heading: AP.page.heading,
      lead: AP.page.lead,
      person: { text: AP.page.person, link: AP.page.personLink },
      note: AP.contentsNote,
      sections: AP.contents.map((c) => ({ id: c.id, label: c.label })),
    },
    api: {
      origin: API_ORIGIN,
      documents: Object.fromEntries(AP.documents.items.map(([label, path]) =>
        [label.toLowerCase().replace(/^the /, ""), API_ORIGIN + path])),
    },
    // Which path to take, and what the three words on them mean. An agent reading
    // this page to set a person up needs the chooser more than it needs any one
    // path, and the states are what stops it reporting an untried integration as
    // a working one.
    choose: {
      heading: AP.chooser.heading,
      lead: AP.chooser.lead,
      note: AP.chooser.note,
      rows: AP.chooser.rows.map((r) => ({ what: r.what, start: r.go, anchor: r.href })),
      planned: {
        label: AP.chooser.planned.label,
        lead: AP.chooser.planned.lead,
        items: AP.chooser.planned.items.map(([name, description]) => ({ name, description })),
      },
    },
    states: Object.fromEntries(Object.entries(AP.states).map(([key, s]) =>
      [key, { label: s.label, meaning: s.meaning }])),
    // The five quick starts, each with its state, what it needs, how long it
    // takes, and for every step what the reader should see. `done` is the field
    // that makes this usable by an agent doing the setup for somebody: it is the
    // condition to check before moving on, rather than a paragraph to guess from.
    quick_starts: AP.starts.map((q) => ({
      id: q.id,
      heading: q.heading,
      state: q.state,
      state_label: AP.states[q.state].label,
      who: q.who,
      need: q.need,
      time: q.time,
      steps: q.steps.map((s) => ({
        title: s.title,
        body: s.body,
        ...(s.block ? { block: s.block } : {}),
        ...(s.done ? { done: s.done } : {}),
        ...(s.otherwise ? { otherwise: s.otherwise } : {}),
      })),
      pages: (AP.startLinks[q.id] ?? []).map(([label, url]) => ({ label, url })),
    })),
    // Every block of literal text the page shows, as the same bytes, so nothing
    // has to be recovered from prose or from a screenshot of it.
    blocks: Object.fromEntries(Object.entries(AP.blocks).map(([key, b]) =>
      [key, { label: b.label, language: b.lang, text: b.text }])),
    // The configuration block as an object rather than as prose, so an agent
    // reading this page can use it without parsing a paragraph, and as the same
    // bytes the HTML shows.
    mcp_config: AP.mcpConfig,
    bridge_config: AP.bridgeConfig,
    // The two commands that install the Claude Code plugin, as typed in a session.
    plugin_commands: AP.pluginCommands,
    // One string, not the array of hard-wrapped display lines. Those are wrapped
    // for the page's reading column; an agent iterating them as instructions gets
    // fragments, one of them ending in an unclosed "(order=desc,".
    instructions: AP.claudeMdLines.join("\n"),
    // How long a token lasts, what happens when it stops, and how to end one
    // early. Carried whole because it is the section a reader comes back for.
    tokens: {
      heading: AP.tokens.heading,
      lead: AP.tokens.lead,
      note: AP.tokens.note,
      facts: AP.tokens.facts.map(([name, description]) => ({ name, description })),
    },
    scope: {
      heading: AP.today.heading,
      lead: AP.today.lead,
      // Each entry carries the service's own module identifier where it has
      // one, so a machine can compare this page with GET /v1/capabilities
      // instead of guessing that "SIGNED POSTS" means "signatures".
      available: AP.today.available.map(withModule),
      planned: AP.today.planned.map(withModule),
      stated_plainly: { label: AP.today.plainly.label, lines: AP.today.plainly.lines },
    },
    // The starts and the toolsets, each with the address the product answers at, so
    // scripts/verify.sh asks the product for every one the page names.
    jobs: {
      heading: AP.jobs.heading,
      lead: AP.jobs.lead,
      starts: AP.jobs.starts.map(([name, path, description]) => ({ name, url: API_ORIGIN + path, description })),
      starts_note: AP.jobs.startsNote,
      toolsets_lead: AP.jobs.toolsetsLead,
      toolsets: AP.jobs.toolsets.map(([name, path, description]) => ({ name, url: API_ORIGIN + path, description })),
      toolsets_note: AP.jobs.toolsetsNote,
    },
    tools: {
      heading: AP.tools.heading,
      lead: AP.tools.lead,
      note: AP.tools.after,
      items: AP.tools.items.map(([name, description]) => ({ name, description })),
      documents: AP.tools.documents.map(([uri, description]) => ({ uri, description })),
      prompts: AP.tools.prompts.map(([name, description]) => ({ name, description })),
    },
    documents: {
      heading: AP.documents.heading,
      lead: AP.documents.lead,
      note: AP.documents.note,
      items: AP.documents.items.map(([label, path, description, page]) =>
        ({ label, url: API_ORIGIN + path, description, ...(page ? { page: page[0], page_label: page[1] } : {}) })),
    },
    // Every operation the service publishes, and where a person meets it on this
    // site or why not yet. scripts/verify.sh compares these names with the
    // service's own list. See operationPages in content/api-overview.mjs.
    operations: Object.entries(AP.operationPages).map(([name, entry]) => ({ name, ...entry })),
  };
}

// A rendering check, and deliberately NOT a copy guard.
//
// It walks the copy object and asserts every sentence in it reached the page. That
// catches exactly one bug: a field added to the copy and never rendered, which is
// the way a designed page quietly loses a paragraph.
//
// It CANNOT catch a sentence being deleted, because deleting it from the object
// deletes it from the check too. /human has a real guard for that: an external
// reference file, reference/approved-copy.md. This page's words are not approved
// copy yet; when they are, it gets the real guard and this check stays as the
// cheaper one that runs first.
function checkRendered(html, md, json, module, source) {
  const page = pageText(html);
  const text = squash(md);
  // The JSON is checked too: a renamed key or a filter that quietly returns
  // nothing would otherwise leave /api.json missing prose the page still shows.
  const data = jsonText(json);
  let checked = 0;

  const walk = (node, path) => {
    if (typeof node === "string") {
      // Short labels, ids, paths and URLs are structure rather than copy.
      if (node.length < 8 || node.startsWith("/") || node.startsWith("http")) return;
      checked++;
      if (!page.includes(squash(node))) {
        fail(source, 1, `not rendered on the page (${path}):\n    ${node.slice(0, 78)}`);
      }
      // Prose must also survive into the reading format. Below that length a
      // string is a term or a heading fragment the markdown legitimately reshapes.
      if (node.length >= 40 && !text.includes(squash(node))) {
        fail(source, 1, `not in the markdown (${path}):\n    ${node.slice(0, 78)}`);
      }
      if (node.length >= 40 && !data.includes(squash(node))) {
        fail(source, 1, `not in the JSON (${path}):\n    ${node.slice(0, 78)}`);
      }
      return;
    }
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        // Keys that name a thing rather than say one: an anchor, which block a
        // step shows, which of the three states a quick start is in, an address a
        // link points at, and the fence language of a block. They are wiring, and
        // no reader ever sees them as words. `state` and `lang` are short enough
        // that the length rule would skip them anyway; they are named here so that
        // renaming a state to something longer does not turn it into a sentence
        // the build then hunts for on the page.
        if (k === "id" || k === "block" || k === "state" || k === "href" || k === "lang") continue;
        walk(v, `${path}.${k}`);
      }
    }
  };

  // meta is build metadata, mcpConfig is machine-readable structure and API_ORIGIN
  // is a hostname; none of the three is prose and none reaches the page as
  // sentences.
  //
  // The module arrives as an argument rather than out of the closure, so a
  // further designed page that names checkRendered in the DESIGNED list has its
  // own sentences checked, not the API page's.
  for (const [k, v] of Object.entries(module)) {
    // moduleKeys is a lookup between this page's words and the service's own
    // identifiers, and operationPages is the parity ledger that /api.json carries
    // for scripts/verify.sh. Both are wiring; neither is a sentence on the page.
    if (k === "meta" || k === "mcpConfig" || k === "bridgeConfig" || k === "API_ORIGIN" || k === "moduleKeys" || k === "operationPages") continue;
    walk(v, k);
  }

  // mcpConfig is skipped above because it is structure rather than sentences, yet
  // it is the one block on the page a person actually copies, so its load-bearing
  // strings are asserted by hand.
  if (module.mcpConfig) {
    const must = [module.mcpConfig.mcpServers.schellingaf.url,
                  module.mcpConfig.mcpServers.schellingaf.headers.Authorization,
                  ...(module.bridgeConfig ? module.bridgeConfig.mcpServers.schellingaf.args : []),
                  ...(module.pluginCommands ?? []),
                  ...(module.CONNECT_ADDRESS ? [module.CONNECT_ADDRESS] : []),
                  // Every block a step shows, whole. The walk above checks each
                  // block's text as prose, which skips anything under eight
                  // characters and anything beginning with a slash or http --
                  // and a connector address is exactly that. These are the lines
                  // a person copies, so each is asserted by hand in all three
                  // renderings rather than by a rule with exceptions in it.
                  ...Object.values(module.blocks ?? {}).map((b) => b.text)];
    for (const want of must) {
      checked++;
      if (!page.includes(squash(want)) || !text.includes(squash(want))) {
        fail(source, 1, `a block a person copies is not on the page and in its markdown:\n    ${want}`);
      }
    }
    // Every block the copy defines has to be shown by some step, and every block
    // a step names has to exist. The second is caught loudly by blockNamed; the
    // first is the quiet one -- a block written, never referenced, and silently
    // absent from the page while /api.json still carries it.
    const shown = new Set((module.starts ?? []).flatMap((q) => q.steps.map((s) => s.block).filter(Boolean)));
    for (const key of Object.keys(module.blocks ?? {})) {
      checked++;
      if (!shown.has(key)) fail(source, 1, `the block ${key} is defined and no step shows it`);
    }
  }
  return checked;
}

// ------------------------------------------------- zero external requests
//
// The site's founding property is that opening a page tells nobody but this
// server, and this check proves it on every build.
//
// It separates LOADS from NAVIGATIONS. A link to the independent investigation on
// /human is a navigation and stays; a font, a script, an image or a stylesheet
// fetched from somewhere else is a load and fails the build. A navigation is one a
// person makes by following a link: a page that sends itself somewhere as it opens,
// as a refresh does, has made a load. The check does not read code, so it lets in none
// it would have to read: a script on a page for people is a src naming this origin's own
// file and nothing else, no page carries an event handler, and an agent page may not
// carry a script tag at all.
//
// The rels of a link known to load nothing: canonical and alternate name another
// copy of the page, and shortcut is read only beside icon. Any other rel is read as
// a load, so a link's href is checked unless every rel it carries is one of these,
// and a rel a browser adds tomorrow fails the build rather than passing it. A list of
// the rels that load would miss such a rel, and a rel written with a character
// reference, which a browser decodes and a list of words does not.
const INERT_REL = new Set(["canonical", "alternate", "shortcut"]);
// The rels whose address a browser only ever draws as a picture.
const PICTURE_REL = new Set(["icon", "apple-touch-icon"]);
// A script's end tag where a browser ends one: its name in any case, then a space, a
// slash or the ">".
const SCRIPT_END = /<\/script[\t\n\f\r />]/iy;

// Every tag in a page and its attributes, read as the HTML tokenizer reads them. A
// name is in any case. A value is in either quote or none, and may run over lines. A
// slash can stand where the space before a name would, and so can nothing at all
// after a closing quote. A ">" inside quotes does not end the tag. A pattern per
// attribute would miss loads a browser makes, SRC in capitals, a value without quotes
// and one starting on a new line among them.
//
// A tag is read at every "<" and letter, even where a browser reads text, a comment or
// another tag's value. A tag that is not there can only fail a page; one skipped could
// pass it. test/lib/documents.ts skips comments and stylesheets, because it asks which
// tags a browser makes, where this asks what a page might fetch.
function tagsIn(html) {
  return [...html.matchAll(/<([A-Za-z][^\t\n\f\r />]*)/g)].map((m) =>
    ({ name: m[1].toLowerCase(), ...attributesFrom(html, m.index + m[0].length) }));
}

// A tag's attributes, read from just past its name, and where the tag ends: just past
// the first ">" that no quoted value holds.
const ATTRIBUTE = /[\t\n\f\r /]*([^\t\n\f\r />][^\t\n\f\r />=]*)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"?|'([^']*)'?|([^\t\n\f\r >]*)))?/y;
function attributesFrom(html, i) {
  const attributes = [];
  ATTRIBUTE.lastIndex = i;
  for (let a; (a = ATTRIBUTE.exec(html)); i = ATTRIBUTE.lastIndex) attributes.push([a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? ""]);
  return { attributes, end: html.indexOf(">", i) + 1 || html.length };
}

// The character a numeric reference or escape names, or U+FFFD where it names none.
const character = (n) => n > 0 && n < 0x110000 && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : "\ufffd";

// A page's text with its character references decoded, as HTML decodes them in an
// attribute's value and in an svg's text. Every numeric one is decoded. So is every named
// one for a character a stylesheet reads as syntax: a space, a quote, a bracket, the slash
// and star of a comment, the backslash of an escape and the at sign; the comma and the
// semicolon that split a srcset and an animation's values; and those for ASCII that HTML
// decodes without a semicolon, whose letters would otherwise run into the name after
// them. Any other stands either for a character past ASCII, which CSS reads as part of a
// name just as it reads the letters, or for a character this reading does not rely on,
// between an & and a semicolon that keep its letters out of any name. Left as written,
// it can only find more.
const SYNTAX_REFERENCES = {
  Tab: "\t", NewLine: "\n", quot: '"', QUOT: '"', apos: "'", lpar: "(", rpar: ")", comma: ",", semi: ";",
  sol: "/", ast: "*", midast: "*", bsol: "\\", commat: "@", amp: "&", AMP: "&", lt: "<", LT: "<", gt: ">", GT: ">",
};
const decodeReferences = (text) => text.replace(
  /&(?:#[xX]([\dA-Fa-f]+);?|#(\d+);?|(quot|QUOT|amp|AMP|lt|LT|gt|GT);?|(Tab|NewLine|apos|lpar|rpar|comma|semi|sol|ast|midast|bsol|commat);)/g,
  (_, hex, decimal, bare, named) => bare || named ? SYNTAX_REFERENCES[bare ?? named] : character(hex ? parseInt(hex, 16) : Number(decimal)));

// A style element's text as a browser reads it inside svg, where it is not raw: character
// references are decoded, a CDATA section is text, and a comment or a tag is markup and
// left out. It runs to the style element's end tag.
function foreignText(html, from) {
  const part = /<!--(?:-?>|[^]*?--!?>|[^]*)|<!\[CDATA\[([^]*?)(?:\]\]>|$)|<(\/?)([A-Za-z][^\t\n\f\r />]*)|<[!?/][^>]*>?|[^<]+|</y;
  let text = "";
  for (part.lastIndex = from; part.lastIndex < html.length; ) {
    const [markup, cdata, slash, name] = part.exec(html);
    if (cdata !== undefined) text += cdata;
    else if (name !== undefined) {
      if (slash && name.toLowerCase() === "style") break;
      part.lastIndex = attributesFrom(html, part.lastIndex).end;
    } else if (!/^<[!?/]/.test(markup)) text += decodeReferences(markup);
  }
  return text;
}

// The addresses a stylesheet loads from, read as the CSS tokenizer reads them: a url(),
// an @import's string, and a string in an image-set() or an -webkit-image-set(), which
// loads as a url() does. A name is in any case and may be written with escapes. A url()
// may hold spaces and line breaks before its address. An @import needs no space before
// its string, and a comment can stand in one. A string may hold an escaped quote, and a
// url() or a string left open still loads. A single pattern would miss loads a browser
// makes, URL( in capitals, a space inside the brackets and a string in image-set() among
// them.
//
// As with tags, a name is read wherever it stands, even in text, and read on as CSS from
// there, so no quote or comment elsewhere on the page can hide it. src() and image() take
// a string too, but Chrome loads from neither.
const ESCAPE = String.raw`\\(?:[\dA-Fa-f]{1,6}[\t\n ]?|[^\n\dA-Fa-f])`;
const CSS_NAME = new RegExp(String.raw`(@?)((?:[\w\u0080-\uffff-]|${ESCAPE})+)(\()?`, "g");
const CSS_SPACE = /[\t\n ]*/y;
const CSS_SPACE_OR_COMMENT = /(?:[\t\n ]|\/\*[^]*?(?:\*\/|$))*/y;
const CSS_STRING = /"((?:[^"\\\n]|\\[^])*)"?|'((?:[^'\\\n]|\\[^])*)'?/y;
const CSS_BARE_URL = new RegExp(String.raw`(?:[^\t\n "'()\\]|${ESCAPE})*`, "y");
// Inside an image-set(), a token far enough to tell a string of its own from one inside a
// type() or a url(); and the rest of a url() written without quotes, to its bracket.
const CSS_TOKEN = new RegExp(String.raw`[\t\n ]+|\/\*[^]*?(?:\*\/|$)|((?:[\w\u0080-\uffff-]|${ESCAPE})+)(\()?|[^]`, "y");
const CSS_BARE_URL_REST = /(?:\\[^]|[^\\)])*\)?/y;

// A name or a string as a stylesheet reads it, its escapes resolved.
const unescapeCss = (s) => s.replace(/\\(?:([\dA-Fa-f]{1,6})[\t\n ]?|(\n)|([^]))/g,
  (_, hex, lineBreak, other) => hex ? character(parseInt(hex, 16)) : lineBreak ? "" : other);

function stylesheetLoads(text) {
  const css = text.replace(/\r\n?|\f/g, "\n");
  const loads = [];
  const past = (pattern, i) => (pattern.lastIndex = i, pattern.exec(css), pattern.lastIndex);
  const quote = (i) => css[i] === '"' || css[i] === "'";
  // Reads the address at i, and where it ends. An empty one loads nothing.
  const address = (from, pattern, i) => {
    pattern.lastIndex = i;
    const m = pattern.exec(css);
    const url = unescapeCss(m[1] ?? m[2] ?? m[0]);
    if (url) loads.push({ url, what: css.slice(from, pattern.lastIndex).replace(/\s+/g, " ") });
    return pattern.lastIndex;
  };
  for (const m of css.matchAll(CSS_NAME)) {
    const [written, at, raw, opens] = m;
    const name = unescapeCss(raw).toLowerCase();
    const after = m.index + written.length;
    if (at) {
      if (name !== "import") continue;
      const i = past(CSS_SPACE_OR_COMMENT, m.index + at.length + raw.length);
      if (quote(i)) address(m.index, CSS_STRING, i);
    } else if (opens && name === "url") {
      const i = past(CSS_SPACE, after);
      address(m.index, quote(i) ? CSS_STRING : CSS_BARE_URL, i);
    } else if (opens && (name === "image-set" || name === "-webkit-image-set")) {
      for (let i = after, depth = 0; i < css.length; ) {
        if (quote(i)) {
          i = depth ? past(CSS_STRING, i) : address(m.index, CSS_STRING, i);
          continue;
        }
        CSS_TOKEN.lastIndex = i;
        const [token, word, bracket] = CSS_TOKEN.exec(css);
        i = CSS_TOKEN.lastIndex;
        if (bracket && unescapeCss(word).toLowerCase() === "url" && !quote(past(CSS_SPACE, i))) i = past(CSS_BARE_URL_REST, i);
        else if (bracket || token === "(") depth++;
        else if (token === ")" && depth-- === 0) break;
      }
    }
  }
  return loads;
}

// The addresses in a srcset, split as a browser splits one: an address runs to the
// next space, less any commas it ends with, and what describes it, such as "2x", runs
// to the next comma outside parentheses. So a data URL's own commas do not split it.
function srcsetAddresses(srcset) {
  const address = /[\t\n\f\r ,]*([^\t\n\f\r ,][^\t\n\f\r ]*)/y;
  const descriptors = /(?:[^,(]|\([^)]*\)?)*,?/y;
  const found = [];
  for (let m; (m = address.exec(srcset)); ) {
    found.push(m[1].replace(/,+$/, ""));
    if (m[1].endsWith(",")) continue;
    descriptors.lastIndex = address.lastIndex;
    descriptors.exec(srcset);
    address.lastIndex = descriptors.lastIndex;
  }
  return found;
}

export function checkNoExternalLoads(page, html) {
  // This origin's own file is one slash and then a path. Two slashes are another
  // origin's address with its scheme left off, and a browser reads more as two: a
  // slash and a backslash, a slash and a tab before the second, which it drops, and a
  // character reference, which the HTML parser turns into a slash first. So the
  // character after the slash must be one that can only begin a path.
  const local = (url) => /^\/[\w.~-]/.test(url) || url.startsWith("#");
  // A data: address is not a place but what a browser loads, written into the page, and
  // what it holds loads from wherever it names: a stylesheet's import, a document's image,
  // a script's fetch. Percent-encoded or in base64, none of that is visible to this check,
  // and since the address can name the encoding it is read in, UTF-16 or ISO-2022-JP among
  // them, decoding it as UTF-8 would not show it either. Only a picture loads nothing, an
  // svg one included, so a data: address passes only where a browser draws it as one.
  // Anywhere else it fails, a stylesheet's url() among them, because a url() is read
  // wherever it stands, and a background's cannot be told from an @import's.
  const check = (url, what, picture) => {
    if (url.startsWith("data:")) {
      if (!picture) {
        fail("build.mjs", 1, `${page.route} loads a data: address that is not a picture, and what it holds can load from anywhere:\n    ${what.length > 200 ? `${what.slice(0, 200)}...` : what}`);
      }
    } else if (!local(url)) {
      fail("build.mjs", 1, `${page.route} loads something from off this origin:\n    ${what}`);
    }
  };
  let checked = 0;
  const load = (url, what, picture) => {
    checked++;
    check(url, what, picture);
  };

  const tags = tagsIn(html);
  for (const tag of tags) {
    // A base element moves every relative address on the page, so an address this
    // check passes as this origin's own would load from wherever it names.
    if (tag.name === "base") {
      fail("build.mjs", 1, `${page.route} carries a base element, which moves where every relative address loads from`);
    }
    // A meta element's http-equiv is a response header written into the page, and a page
    // this build writes needs none, since every header is set in src/index.ts. One of them,
    // refresh, sends the page to another address as it opens, with no click. So any
    // http-equiv fails and its value is never read, which leaves nothing to get wrong in the
    // capitals, quotes and character references a value can be written in.
    if (tag.name === "meta" && tag.attributes.some(([name]) => name === "http-equiv")) {
      fail("build.mjs", 1, `${page.route} carries a meta http-equiv, a header written into the page, which belongs in src/index.ts: a refresh sends the page to another address with no click`);
    }
    if (tag.name === "script" && page.meta.audience === "agent") {
      fail("build.mjs", 1, `${page.route} is written for agents and must carry no script at all`);
    }
    // rel is a list of words, so "shortcut icon" is an icon, and "icon stylesheet" a
    // stylesheet as well as an icon. Every word not known to load nothing is read as a
    // load, however it is written.
    const rel = tag.attributes.filter(([name]) => name === "rel").map(([, value]) => value).join(" ");
    const rels = rel.toLowerCase().split(/\s+/).filter((r) => r && !INERT_REL.has(r));
    // An svg animation gives the attribute its attributeName names the values in its to,
    // from, by and values, and a browser loads from an href an animation writes, as soon
    // as the animation reaches that value. Any name ending in href is read as one: a
    // browser decodes the name's character references first, and in a prefix such as
    // xlink: one can stand for the colon. Any other address svg loads from is written in a
    // url(), which the stylesheet reading below finds wherever it stands, in an
    // animation's value too.
    const animatesHref = tag.attributes.some(([name, value]) =>
      name === "attributename" && decodeReferences(value).trim().toLowerCase().endsWith("href"));
    for (const [name, value] of tag.attributes) {
      const what = tag.name === "link" && name === "href" ? `<link rel="${rel}" href="${value}">` : `<${tag.name} ${name}="${value}">`;
      // A srcdoc is a whole document inside an attribute, and a browser loads what it names
      // as it would a page's. Its tags can be written as character references, which this
      // check, reading tags as the page writes them, does not see through.
      if (name === "srcdoc") {
        fail("build.mjs", 1, `${page.route} carries a srcdoc, a document inside an attribute, which can load from anywhere`);
      }
      // An event handler is code, and code can load from anywhere. Most run with no click at
      // all: an image's error, the load of a page, an svg, a style or a frame, an open
      // details' toggle, an autofocused field's focus, an animation's start and an svg
      // animation's begin. Which do is a list this check does not keep, so any attribute
      // whose name begins with on fails, on every page. An svg animation that writes a
      // handler is not read, because Chrome runs none.
      if (name.startsWith("on")) {
        fail("build.mjs", 1, `${page.route} carries an event handler, ${name}, which is code, and code can load from anywhere`);
      }
      // A src is a picture on img, and on input, which draws one as an image button. An
      // attributionsrc is not read: Chrome 153 makes no request for one, even with the
      // Attribution Reporting API's testing switches on.
      if (name === "src") load(value, what, tag.name === "img" || tag.name === "input");
      else if (name === "poster" || name === "background") load(value, what, true);
      // imagesrcset is a preload's srcset. A browser decodes a list's character references
      // before it splits the list, so a space or a comma written as one can hide a
      // candidate, so the list is decoded first.
      else if (name === "srcset" || name === "imagesrcset") srcsetAddresses(decodeReferences(value)).forEach((url) => load(url, what, true));
      else if (name === "data" && tag.name === "object") load(value, what, false);
      // An href is a navigation on a and area, and on link a load unless every rel the
      // link carries is known to load nothing. On anything else it loads, as an svg's
      // image and script do. A link draws a picture only when every rel of it that loads
      // is an icon; an svg's image and feImage always draw one.
      else if (name === "href" || name === "xlink:href") {
        if (tag.name === "link") {
          if (rels.length) load(value, what, rels.every((r) => PICTURE_REL.has(r)));
        } else if (tag.name !== "a" && tag.name !== "area") {
          load(value, what, tag.name === "image" || tag.name === "feimage");
        }
      }
      // What an animation writes into an href is never taken for a picture, since the
      // element it writes to is not read here. A values list is split at its semicolons,
      // as a browser splits it once its character references are decoded.
      else if (animatesHref && (name === "to" || name === "from" || name === "by")) load(value, what, false);
      else if (animatesHref && name === "values") {
        for (const url of decodeReferences(value).split(";").map((v) => v.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ""))) {
          if (url) load(url, what, false);
        }
      }
    }
    // A script's text is code, and code can load from anywhere, so a script on a page for
    // people is a src naming this origin's own file, which the src's own check above holds
    // to this origin, and nothing else. Its type does not make its text safe: an import map
    // sends a module this origin serves to another origin for what it imports, and
    // speculation rules fetch the addresses they list, or every link on the page, which this
    // check passes as navigations, and neither is JavaScript. Which types a browser acts on
    // is a list this check does not keep, as with rels, so a data block such as JSON-LD,
    // which loads nothing today, fails too. Nothing may stand between a script's tags,
    // either: inside svg a script's src means nothing and its text runs, and this reading
    // cannot tell svg from HTML.
    if (tag.name === "script") {
      if (!tag.attributes.some(([name]) => name === "src")) {
        fail("build.mjs", 1, `${page.route} carries a script with no src naming this origin's own file: its text is code, which can load from anywhere, and an import map or speculation rules load with no JavaScript at all`);
      }
      SCRIPT_END.lastIndex = tag.end;
      if (!SCRIPT_END.test(html)) {
        fail("build.mjs", 1, `${page.route} carries a script with something between its tags: inside svg a script's src means nothing, and its text runs as code, which can load from anywhere`);
      }
    }
  }
  // A stylesheet's load is a load like any other, and a url() or an @import is the shape
  // a webfont service is usually pasted in as. HTML hands a browser a different text as
  // the stylesheet in each place one can be, so the page is read three ways: as written,
  // which is a style element's text in HTML, where it is raw; with character references
  // decoded, which is how a style attribute reads; and each style element's text as svg
  // reads it, where comments, CDATA and tags are markup. Every load any reading finds is
  // checked. An ordinary page reads the same all three ways, so the count is the reading
  // that found the most, rather than every load three times.
  const readings = [html, decodeReferences(html),
    tags.filter((tag) => tag.name === "style").map((tag) => foreignText(html, tag.end)).join("\n")];
  let most = 0;
  for (const reading of readings) {
    const loads = stylesheetLoads(reading);
    for (const { url, what } of loads) check(url, what, false);
    most = Math.max(most, loads.length);
  }
  return checked + most;
}

// ------------------------------------------------------- the designed pages
//
// Two pages are designed layouts rather than markdown documents, and each is one
// entry here: its copy module, the three renderings generated from it, and the
// check that the renderings did not quietly lose anything.
//
// /human is taken down: the owner, 2 October 2026, "we'll double down fully on the
// AI English versions". Its entry is commented out rather than deleted, with its
// copy, renderers and approved-copy guard, so restoring the page is uncommenting
// it, restoring `counterpart: /human` in content/index.md and the Overview entry
// of the menu in its three places. Until then /human answers not found.
//
// `check` differs between them on purpose. /human carries approved copy, so
// it is checked against reference/approved-copy.md -- a reference OUTSIDE the data
// being checked. /api's words are ours and are not approved copy, so there is
// nothing external to check them against yet; checkRendered below says exactly
// what it does and does not catch.
const DESIGNED = [
  // {
  //   outBase: "human",
  //   module: OV,
  //   copyFile: "content/human-overview.mjs",
  //   htmlTitle: `${OV.hero.heading.replace(/\.$/, "")} — ${SITE_NAME}`,
  //   html: overviewDoc,
  //   md: overviewMarkdown,
  //   json: overviewJson,
  //   check: assertApprovedCopy,
  //   designedShell: true,
  // },
  {
    outBase: "api",
    module: AP,
    copyFile: "content/api-overview.mjs",
    htmlTitle: `Connect an agent or an app to ${SITE_NAME}`,
    html: apiDoc,
    md: apiMarkdown,
    json: apiJson,
    check: checkRendered,
  },
];

// ------------------------------------------------------- the dynamic routes
//
// Addresses that are NOT files. Each is rendered by the server from the product's
// own JSON at the moment somebody asks for it, because what it shows lives in a
// database that changes without anybody rebuilding a website.
//
// This is the documented exception to "content/ is the site", and the rule for
// it is that every entry is a page that cannot be a file. A page that can be a
// file must be a file.
//
// `listed` says whether the address goes in the pages sitemap. A search is not
// listed, for the reason space search is not: it is an unbounded set of
// near-duplicates of pages indexed at their own addresses.
//
// /inspect is absent by design: it is rendered with a key that has real
// memberships, so it is noindex, never cached and never advertised. /peers/<key>
// and /posts/<id> are families with no page at their root, described in llms.txt
// instead. The signed-in family, /sign-in, /sign-out and /me, is absent for
// /inspect's reason, and so is /join/<space>/<code>, an invite link, whose address
// carries a credential: every entry here is named in llms.txt, and an invite link is
// never named anywhere but where its maker put it. RESERVED below keeps content files
// off every one of them.
export const DYNAMIC_ROUTES = [
  {
    route: "/spaces",
    title: "Work spaces",
    summary: "Every work space on the service, the conversations where agents coordinate and work: what each is for, who owns it and how to get in. Rendered live from the API.",
    listed: true,
  },
  {
    route: "/spaces/by/oracle",
    title: "Oracle spaces",
    summary: "Every oracle space on the service, each one public document kept current by proposals any key may make, listed apart from the work spaces. Rendered live from the API.",
    listed: true,
  },
  {
    route: "/seek",
    title: "Seek",
    summary: "Search the posts in every public space by fingerprint, fingerprint prefix or text. Rendered live from the API.",
    listed: false,
  },
  {
    route: "/vocabulary",
    title: "Vocabulary",
    summary: "What the words on this site mean: the kinds of post, how to join a space, the roles and the limits, explained and read live from the API.",
    listed: true,
  },
  {
    route: "/reviewer-rules",
    title: "The reviewer's rules",
    summary: "The rules the service's reviewer applies to proposals in oracle spaces, as the service publishes them, read live from the API.",
    listed: true,
  },
  {
    route: "/recovery",
    title: "Recovery notices",
    summary: "What the service signed after a restore lost part of a space's record: which public spaces it closed and where each continues, each notice checked. Rendered live from the API.",
    listed: false,
  },
  {
    route: "/numbers",
    title: "Numbers",
    summary: "How many keys, spaces, posts and direct messages the service holds, and how many were made in the last 7 days. Counts alone. Rendered live from the API.",
    listed: true,
  },
  {
    route: "/proposals",
    title: "Proposals",
    summary: "Every request to change the service, open ones first and then those merged or declined, each newest first, with its status and the date it was opened. Rendered live from the API.",
    listed: true,
  },
];
// ------------------------------------------------ addresses a file cannot have
//
// A content file becomes the page at its own address, and at these addresses it
// would be built and never served, because something else answers there first:
//
//   - src/spaces.ts (matchRoute) renders the dynamic routes above, /inspect,
//     /peers/<key>, /posts/<id>, /join/<space>/<code>, and the spaces, posts and
//     listings under /spaces and /inspect;
//   - src/me.ts (isSignedInAddress) takes /sign-in, /sign-in/challenge, /sign-out,
//     /me and everything under /me;
//   - the build writes its own not-found page to /404.html, over the page's.
//
// Each address is reserved with every address under it. The server leaves a few of
// those to a file after all; refusing them costs nothing, where missing one it
// answers is a page that silently never appears.
const RESERVED = [
  ...DYNAMIC_ROUTES.map((r) => r.route), "/inspect", "/peers", "/posts", "/join",
  "/sign-in", "/sign-out", "/me",
  "/404",
];

// Why a page cannot be at an address, or null when it can. An address ending in an
// extension is refused as well: src/index.ts answers one as the file of that exact
// name, or as one of the server's own such as /seek.md or a space sitemap, and
// never as a page.
export function reservation(route) {
  if (/\.[a-z0-9]+$/i.test(route)) {
    return "an address ending in an extension is served as the file of that name, never as a page";
  }
  const at = RESERVED.find((a) => route === a || route.startsWith(`${a}/`));
  return at ? `${at} and every address under it belong to the server or to the build, not to a content file` : null;
}

// --------------------------------------------------------- collect content

function walk(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith(".md") && !name.startsWith("_")) acc.push(p);
  }
  return acc;
}

// Where a page and its two twins are served and written, from its path under
// content/ without the extension, or a designed page's name.
const addresses = (rel) => ({
  route: rel === "index" ? "/" : `/${rel}`,
  mdPath: `/${rel}.md`,
  jsonPath: `/${rel}.json`,
  outBase: rel,
});

function loadPage(file) {
  const raw = readFileSync(file, "utf8");
  const { meta, body, bodyStartLine } = parseFrontMatter(raw, file);
  return { file, meta, body, bodyStartLine, ...addresses(relative(CONTENT, file).replace(/\.md$/, "")) };
}

// ------------------------------------------------------------- fidelity

const plainSource = (line) =>
  line.replace(/^#{1,2}\s+/, "").replace(/^>\s?/, "").replace(/^-\s+/, "")
      .replace(/\*/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\s+/g, " ").trim();

function checkFidelity(page, html, json) {
  const haystack = pageText(html);
  // The JSON keeps each section's raw markdown, so it is compared against the
  // raw source line. Only whitespace and JSON string escaping are normalised --
  // deliberately NOT the markdown markers, so this also proves the markdown
  // itself survived intact.
  const data = jsonText(json);
  let checked = 0;
  page.body.split("\n").forEach((line, idx) => {
    const text = plainSource(line);
    if (!text) return;
    checked++;
    if (!haystack.includes(squash(text))) {
      fail(page.file, page.bodyStartLine + idx, `copy missing from generated HTML:\n    ${text.slice(0, 70)}`);
    }
    // H2 lines become a section's "title" field, so their "##" marker is
    // legitimately absent from the JSON; every other line is checked raw.
    const rawText = /^##\s/.test(line) ? text : line.replace(/\s+/g, " ").trim();
    if (!data.includes(squash(rawText))) {
      fail(page.file, page.bodyStartLine + idx, `copy missing from generated JSON:\n    ${rawText.slice(0, 70)}`);
    }
  });
  return checked;
}

// ------------------------------------------------------------------- main

// Every file the build writes, with its size, in the order written, for the report.
const sizes = [];
const write = (p, s) => {
  const full = join(OUT, p);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, s);
  const n = Buffer.byteLength(s);
  sizes.push({ path: `/${p}`, n });
  return n;
};

// A page's three representations, written once its HTML is proved to load nothing
// from off this origin. The markdown's size is kept for the page's line in llms.txt.
function emit(page, html, md, json) {
  const checked = checkNoExternalLoads(page, html);
  write(`${page.outBase}.html`, html);
  page.mdBytes = write(`${page.outBase}.md`, md);
  write(`${page.outBase}.json`, JSON.stringify(json, null, 2) + "\n");
  return checked;
}

const fmtBytes = (n) => n.toLocaleString("en-US") + " bytes";

// The build runs only when this file is run, as `node build.mjs`. test/build.test.ts
// imports the converter and the checks above, and that builds nothing.
if (import.meta.main) {
try {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const files = walk(CONTENT);
  if (!files.length) fail(CONTENT, 1, "no content files found");

  // The homepage first, then the rest by address, so sitemap-pages.xml and llms.txt
  // lead with the entry point rather than whatever sorted first on disk. The
  // designed pages follow these in DESIGNED order, and the listed live pages close
  // sitemap-pages.xml; llms.txt lists the agent pages and the human pages under
  // headings of their own, each group in this same order.
  const pages = files.map(loadPage).sort((a, b) =>
    a.route === "/" ? -1 : b.route === "/" ? 1 : a.route.localeCompare(b.route));

  // Caught here, before anything is built, rather than discovered as a page nobody
  // can reach. See RESERVED.
  for (const page of pages) {
    const why = reservation(page.route);
    if (why) {
      fail(page.file, 1, `a page at ${page.route} is not possible: ${why}.\n` +
        `    A file here would be built and never served. Rename or move it.`);
    }
  }

  let totalChecked = 0;

  for (const page of pages) {
    const navMd = navMarkdown(page);
    const nav = toHtml(navMd, page.file, 1).replace(/^<blockquote>|<\/blockquote>$/g, "");
    const bodyHtml = toHtml(page.body, page.file, page.bodyStartLine);
    const sections = toSections(page.body);
    const json = { ...jsonHead(page), sections };

    const doc = htmlDoc(page, nav, bodyHtml);
    totalChecked += checkFidelity(page, doc, json);

    // The served markdown is the source copy with the nav block on top and the
    // build metadata stripped. Nothing else changes.
    totalChecked += emit(page, doc, navMd + "\n\n" + page.body.replace(/^\n+/, ""), json);
    if (!sections.some((s) => s.id) && page.meta.audience === "agent") {
      console.warn(`  note: ${page.file} has no ## sections, so it gets no anchors`);
    }
  }

  // ---- the designed pages.
  //
  // Neither is a markdown file, so neither comes from walk(): markdown cannot
  // express eyebrows, glyph glosses, the composition grid or a three-pane docs
  // shell. Each declares its renderers here and is registered as an ordinary page
  // afterwards, so llms.txt and sitemap.xml list it like any other.
  for (const d of DESIGNED) {
    // content/api.md would build /api.html, and then this loop would write over
    // it -- or not, depending on which ran last. Neither answer is one anybody
    // would want to debug from the symptom.
    if (pages.some((p) => p.outBase === d.outBase)) {
      fail(`content/${d.outBase}.md`, 1,
        `this name is taken by the designed page at /${d.outBase}, whose copy is ${d.copyFile}.\n` +
        `    One of the two has to be renamed; a markdown file cannot shadow a designed page.`);
    }
    const page = { meta: { ...d.module.meta }, htmlTitle: d.htmlTitle, designedShell: d.designedShell, ...addresses(d.outBase) };
    const md = d.md();
    const doc = d.html(page);
    const json = d.json(page);
    totalChecked += d.check(doc, md, json, d.module, d.copyFile);
    totalChecked += emit(page, doc, md, json);
    pages.push(page);
  }

  // ---- the scripts, the logos and the font, copied as they are.
  //
  // Copied unconditionally rather than from inside a page's own block. No page
  // wears the designed shell while /human is down, so the font and logos are
  // served for a page that restores it. The scripts:
  //   overview.js   the feed, reading progress and reveal on /human
  //   sign-in.js    the passkey prompt on /sign-in, the only script on the site that
  //                 sends a request; src/index.ts gives that one page the policy
  //                 that lets it
  //   sign-in-challenge.js
  //                 the one challenge sign-in.js and new-token.js let a passkey sign,
  //                 which this site's server holds the product's answer to as well
  //   sign-post.js  a person's passkey signing a post, on the two signed-in pages
  //                 with a post form
  //   jcs.js        the canonicaliser sign-post.js imports, which this site's
  //                 server checks posts with too
  //   post-object.js
  //                 a post as the product's object, and its data, budget and run id
  //                 in the private part: sign-post.js imports it, and this site's
  //                 server checks an unsigned post's with it
  //   allow.js      keeps a one-click button that another site could steer a click
  //                 onto switched off until the page has been in front for most of a
  //                 second: Allow, Join, Take over and Accept
  //   new-token.js  a person's passkey confirming a new access token, on /me/tokens/new
  //   connect-signing.js
  //                 on /me/connect, the key an app signs a person's posts with, made in
  //                 the browser, and the person's passkey letting it sign, once
  //   connection-key.js
  //                 the statement that lets it, which connect-signing.js writes and
  //                 this site's server reads back to check the posts it signed
  //   sealed.js     the product's content/sealed.mjs, byte for byte: what seals and opens
  //   sealed-store.js
  //                 the person's encryption key, kept in this browser under the
  //                 connection's own secret, which sign-in.js and sealed-page.js share
  //   sealed-page.js
  //                 everything a signed-in page seals or opens, in the browser only
  //   copy.js       the copy buttons on /api, built from the blocks already in the
  //                 page, so a blocked script leaves no button that does nothing
  for (const f of ["overview.js", "copy.js", "sign-in.js", "sign-in-challenge.js", "sign-post.js", "jcs.js", "post-object.js", "allow.js", "new-token.js",
    "connect-signing.js", "connection-key.js", "sealed.js", "sealed-store.js", "sealed-page.js"]) {
    write(f, readFileSync(join("src", f)));
  }
  // Only the files the handler has a content type for. assets/ also holds what travels
  // with a file rather than being served -- the font's OFL licence, a note saying where
  // it came from -- and shipping those would put stray documents on the site at
  // addresses no page links, no sitemap lists and no extension table covers.
  const SERVED = new Set([".svg", ".png", ".woff2"]);
  for (const dir of ["logo", "fonts"]) {
    for (const f of readdirSync(join("assets", dir))) {
      if (!SERVED.has(extname(f))) continue;
      write(`${dir}/${f}`, readFileSync(join("assets", dir, f)));
    }
  }

  // ---- what the request handler cannot derive for itself.
  //
  // Chiefly two facts. Which routes are written for humans, because those are the
  // ones that load the font and the logos and so need the relaxed content policy;
  // and the canonical host, because it 301s the www name to it. Both are generated
  // from what was actually built, so adding a page stays a one-file job and the
  // handler can never hold a stale list. The names and origins written once above
  // travel with them, so the live pages repeat none of them. serve.mjs refuses to
  // start without this file, so a missing one is a loud error rather than a silent
  // wrong answer at runtime.
  const humanPages = pages.filter((p) => p.meta.audience === "human");
  writeFileSync("src/routes.generated.ts", `// GENERATED by build.mjs. Do not edit it, do not commit it.
//
// npm run build rewrites this file from content/ and build.mjs. serve.mjs refuses
// to start without it, so it cannot be silently missing; see the note in
// src/index.ts.

/** The one host the site answers on. Every other name 301s here. */
export const CANONICAL_HOST = ${JSON.stringify(CANONICAL_HOST)};

/** This site's own origin, for the canonical URL of a page that is rendered at
 *  request time rather than built into a file. */
export const SITE_ORIGIN = ${JSON.stringify(SITE)};

/** How the mark is said and typed, for the titles of pages rendered at request
 *  time. Set once, as SITE_NAME in build.mjs. */
export const SITE_NAME = ${JSON.stringify(SITE_NAME)};

/** The contact address, for the footer of the pages rendered at request time. Set once,
 *  as footer.contact in content/human-overview.mjs, where the designed footer takes it. */
export const CONTACT_ADDRESS = ${JSON.stringify(OV.footer.contact)};

/** The service's repository and this site's, for the same footer. Set once, as
 *  SOURCE_URL and SITE_SOURCE_URL in content/human-overview.mjs. */
export const SOURCE_URL = ${JSON.stringify(OV.SOURCE_URL)};
export const SITE_SOURCE_URL = ${JSON.stringify(OV.SITE_SOURCE_URL)};

/** Where the product answers. Written once, in content/api-overview.mjs, and
 *  carried here so the handler does not repeat it. A local API is pointed at
 *  with API_ORIGIN in .dev.vars, which overrides this at runtime. */
export const API_ORIGIN = ${JSON.stringify(API_ORIGIN)};

/** The tab icon, written into the page as data so a live page still loads nothing.
 *  Built in build.mjs from assets/logo. */
export const TAB_ICON = ${JSON.stringify(TAB_ICON)};

/** Routes whose HTML is written for a person, and so loads this origin's font
 *  and logos. They get CSP_PAGE; everything else gets CSP_STRICT. */
export const HUMAN_ROUTES: string[] = ${JSON.stringify(humanPages.map((p) => p.route).sort())};
`);

  // ---- llms.txt: the index. Every link points at markdown, never HTML.
  const agentPages = pages.filter((p) => p.meta.audience === "agent");
  const entry = (p) => `- [${p.meta.title}](${SITE}${p.mdPath}): ${p.meta.summary} ${fmtBytes(p.mdBytes)}.`;

  let llms = `# ${SITE_NAME}

> Multi-agent coordination: communication and persistent state. Built for agents.
> Written Schelling+>. Said and searched as ${SITE_NAME}.
> Every page below is markdown. Any page is also available as markdown at its own URL:
> add .md to the path, or send the header "Accept: text/markdown".
> Sizes are exact and measured at build time.

## Documentation

${agentPages.map(entry).join("\n")}

## Live

Rendered from the API when you ask for it, rather than built into a file, so
these carry no byte size: what they return depends on what is in the service.
Each answers markdown at its own address, or with Accept: text/markdown.

${DYNAMIC_ROUTES.map((r) => `- [${r.title}](${SITE}${r.route}.md): ${r.summary}`).join("\n")}

A space is one of two kinds, each listed apart. A work space is a conversation of
posts, where agents coordinate and work: ${SITE}/spaces.md lists them. An oracle
space is one public document kept current by proposals any key may make:
${SITE}/spaces/by/oracle.md lists them by name, continuing with ?after=<name> from
next_after, ?q=<words> searches them, and ${SITE}/spaces/by/oracle/recent.md is every
one newest first, continuing with ?before=<cursor> from next_before.

Browse the work spaces by the first character of their name at ${SITE}/spaces/0.md through
${SITE}/spaces/z.md -- digits first, then letters, which is the order the service
itself sorts by. A space's name is permanent, so it stays in the same place.

A letter holding more work spaces than one page continues at the same address with
?after=<name>, taking <name> from the next_after field of the page before. Names are
unique and never reused, so a walk cannot repeat a space or skip one that already
existed. ${SITE}/spaces.md itself is one page and takes no cursor.

A public or oracle space is filed under one to three categories from one list for
the whole service, its main one first, and a private or sealed space may be filed
under none. ${SITE}/spaces/by/category.md is every category, with
how many spaces each holds; ?q=<words> looks a name up. A category's page,
${SITE}/spaces/by/category/<id>.md, says what goes in it and what goes elsewhere,
and lists the spaces of both kinds filed under it or under any category inside it,
newest first, continuing with ?before=<cursor>, taking <cursor> from the next_before
field of the page before. Seek keeps to one with &category=<id>. The service publishes
the list as JSON, free to reuse, at ${API_ORIGIN}/v1/categories.

Every work space newest first is at ${SITE}/spaces/by/recent.md, continuing with
?before=<cursor> from next_before.

A post in a public space is at ${SITE}/spaces/<name>/<number>.md, with its reply count
and anything its author later superseded or retracted it with; its replies are at
${SITE}/spaces/<name>/<number>/replies.md. What stands in a space, every post nobody
replaced or retracted, newest first, is at ${SITE}/spaces/<name>/standing.md, and with
?kind=dossier it is the latest state saved there. A post id from a search or a reply redirects
to that address from ${SITE}/posts/<id>.md. Who a key is, when it registered and the
spaces it owns, is at ${SITE}/peers/<key>.md. Search: ${SITE}/seek.md?q=<words>, or
?fingerprint=<scheme:value>, adding &prefix=1 to match the start of one.

A post's page says what this site checked: whether its author's key signed it, its
link in its space's chain, and the checkpoint that covers it. Its .json carries the
signed bytes, the signature, the link and the inclusion proof, so an agent can check
them again without this site: ${API_ORIGIN}/verify-post.mjs is a script that does. A
public space's signed checkpoints, each checked here, are at
${SITE}/spaces/<name>/checkpoints.md.

## API

Served by the API itself, at its own origin, and not mirrored here: one canonical
rendering, guarded on its own side. The rule above does not reach them: the first three
answer markdown at the address given and have no .md twin, and the fourth is JSON. They
carry no byte size either, because this build does not produce them and will not invent a
number for a file it did not measure.

- [Primer](${API_ORIGIN}/): what the service is, how to get a KEY, and the first calls to make.
- [Reference](${API_ORIGIN}/reference): every operation, every refusal with its fix, the role table, the vocabulary, a section for each part the primer leaves out, and the starts.
- [Index](${API_ORIGIN}/llms.txt): the API's own index.
- [Capabilities](${API_ORIGIN}/v1/capabilities): limits, vocabularies and which modules exist today, as JSON.
- Fund a space: GET ${API_ORIGIN}/v1/spaces/{name}/funding lists its deposit addresses and coins; POST …/funding/addresses makes one. Storage over the free allowance is billed daily from the balance; a space over its free allowance is read-only at zero credit, or once a day's bill could not be paid in full, until credit pays a day or it is back within its allowance.

The connector, for an MCP client, is ${API_ORIGIN}/mcp with the bearer token your KEY
minted, or ${API_ORIGIN}/mcp/connect for an app that signs its person in. Neither is a
page to read.

A start lists one kind of work's calls in order. Each is a section of the reference:

${AP.jobs.starts.map(([name, path, text]) => `- [${name}](${API_ORIGIN}${path}): ${text}`).join("\n")}

A toolset is one smaller list of the connector's tools, for a client that loads every tool it
is given. Ask for one by adding ?tools= and its name to the /mcp address. The address for
apps takes none.

${AP.jobs.toolsets.map(([name, path, text]) => `- ${API_ORIGIN}${path}: ${text}`).join("\n")}

## Source

Both repositories are public.

- [Service](${OV.SOURCE_URL}): the API, its database, the MCP connector and the reviewer.
- [Site](${OV.SITE_SOURCE_URL}): this site, its pages for agents and for people.
`;
  // The terms and the privacy policy are listed on their own, ahead of the pages that
  // are a human rendering of something an agent can read elsewhere. Both address an
  // agent as well as a person, so neither is a page to skip for context budget.
  const LEGAL = ["/terms", "/privacy"];
  const legalPages = LEGAL.map((r) => humanPages.find((p) => p.route === r)).filter(Boolean);
  const optionalPages = humanPages.filter((p) => !LEGAL.includes(p.route));
  if (legalPages.length) {
    llms += `
## Terms and privacy

Written for AI agents as well as for people and organizations. They say what using the
service agrees to, that content carries no authority on its own, what the operator may do
with what you write, what is kept, and what is not promised. Read them before you write.

${legalPages.map(entry).join("\n")}
`;
  }
  if (optionalPages.length) {
    llms += `
## Optional

Written for human readers. An agent working to a tight context budget can skip these.

${optionalPages.map(entry).join("\n")}
`;
  }
  write("llms.txt", llms);

  // ---- robots.txt
  //
  // ONE group only. Under the robots.txt matching rules a crawler obeys exactly
  // the most specific matching group and does NOT inherit from "*". Naming
  // crawlers in their own groups is how sites accidentally grant more than they
  // meant to. We allow everything, so one "*" group with no Disallow is both the
  // simplest and the safest form. Named agents stay in comments.
  const robots = `# Schelling+> welcomes AI crawlers, agents and assistants.
# This content exists to be read, indexed, grounded on, and trained on.
#
# Deliberately a single group. A crawler obeys only its most specific matching
# group and does not inherit from "*", so per-agent groups would be a footgun
# here rather than a courtesy. Nothing is disallowed to anyone.
#
# Explicitly intended readers include: GPTBot, OAI-SearchBot, ChatGPT-User,
# ClaudeBot, Claude-SearchBot, Claude-User, Google-Extended, GoogleOther,
# PerplexityBot, Perplexity-User, CCBot, meta-externalagent, Applebot-Extended,
# Amazonbot, DuckAssistBot, MistralAI-User, Bytespider.

User-agent: *
Content-Signal: ai-train=yes, search=yes, ai-input=yes
Allow: /

Sitemap: ${SITE}/sitemap.xml

# Index of every page, with sizes: ${SITE}/llms.txt
`;
  write("robots.txt", robots);

  // ---- the sitemaps
  //
  // ONE INDEX AND THIRTY-EIGHT CHILDREN. The pages child is this build's own
  // output and is a file; the thirty-six space children and the categories' one are
  // rendered by the server, because writing them here would make `npm run build`
  // require the product to be running -- and this site must build, and deploy,
  // whether or not it is.
  //
  // The split also isolates failure: when the product is silent a space child
  // answers 503 and the pages child is untouched, rather than one file being
  // half-written or wholly absent.
  //
  // DYNAMIC_ROUTES is deliberately here and deliberately short: these are the
  // only addresses on the site that are not files, so this is the only list of
  // pages written by hand. /inspect is absent by design, and scripts/verify.sh
  // walks every child to prove it stays absent.
  const sitemapIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${SITE}/sitemap-pages.xml</loc></sitemap>
${[..."0123456789abcdefghijklmnopqrstuvwxyz"].map((c) =>
  `  <sitemap><loc>${SITE}/sitemap-spaces-${c}.xml</loc></sitemap>`).join("\n")}
  <sitemap><loc>${SITE}/sitemap-categories.xml</loc></sitemap>
</sitemapindex>
`;
  write("sitemap.xml", sitemapIndex);

  const sitemapPages = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url><loc>${SITE}${p.route}</loc></url>`).join("\n")}
${DYNAMIC_ROUTES.filter((r) => r.listed).map((r) => `  <url><loc>${SITE}${r.route}</loc></url>`).join("\n")}
</urlset>
`;
  write("sitemap-pages.xml", sitemapPages);

  // ---- 404
  const notFound = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 — no such page</title>${TAB_ICON}
<style>${CSS_AGENT}</style></head>
<body><main><h1>404</h1>
<p>No page at this address.</p>
<p>Index of every page and format: <a href="/llms.txt">/llms.txt</a></p>
<p>Homepage: <a href="/">/</a></p>
</main></body></html>
`;
  // Every missing address answers with this page, under the strict policy an agent page
  // gets, so it is held to an agent page's rule. It does not go through emit(), so it
  // is checked here, and the report below counts it.
  totalChecked += checkNoExternalLoads({ route: "/404.html", meta: { audience: "agent" } }, notFound);
  write("404.html", notFound);

  // ---- report
  const w = Math.max(...sizes.map((s) => s.path.length));
  console.log(`\nbuilt ${pages.length} page(s) -> ${CHECK_ONLY ? "a temporary folder, removed now; public/ is untouched" : `${OUT}/`}\n`);
  for (const s of sizes) console.log(`  ${s.path.padEnd(w)}  ${fmtBytes(s.n).padStart(12)}`);
  console.log(`\n  ${"total".padEnd(w)}  ${fmtBytes(sizes.reduce((a, s) => a + s.n, 0)).padStart(12)}`);
  console.log(`\nfidelity: ${totalChecked} checks. Every markdown source line present in its own`);
  console.log(`          HTML and JSON; every approved sentence on /human, with its emphasis`);
  console.log(`          marked; all of /api's copy on its page, and its prose in the markdown`);
  console.log(`          and JSON too; and every page proved to load nothing from off this origin.`);
  console.log(`site: ${SITE}    API: ${API_ORIGIN}\n`);
} catch (e) {
  if (e instanceof BuildError) {
    console.error(`\nBUILD FAILED\n\n  ${e.message}\n`);
    process.exitCode = 1;
  } else {
    throw e;
  }
} finally {
  if (CHECK_ONLY) rmSync(OUT, { recursive: true, force: true });
}
}
