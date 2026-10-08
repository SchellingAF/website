// Reading a page the way the thing it is served to reads it: HTML as a browser
// tokenizes tags, markdown as a renderer finds its fences and code spans. A grep
// cannot tell a tag from escaped text, or text inside a fence from text outside one,
// and that distinction is the whole property the escaping tests claim.

export interface Tag {
  name: string;
  closing: boolean;
  attributes: [name: string, value: string | null][];
}

/**
 * Every tag in an HTML document, read as the HTML tokenizer reads one: a "<" and a
 * letter start a tag, attribute values run to their own quote, and the text inside
 * <style> is not markup. Escaped text never produces a tag, which is the point.
 */
export function tags(html: string): Tag[] {
  const out: Tag[] = [];
  let i = 0;
  const space = (c: string | undefined) => c !== undefined && /[\t\n\f\r ]/.test(c);
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    i = lt + 1;
    if (html.startsWith("!--", i)) {
      const end = html.indexOf("-->", i + 3);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[i] === "!") {
      const end = html.indexOf(">", i);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const closing = html[i] === "/";
    if (closing) i++;
    const name = /^[A-Za-z][^\t\n\f\r />]*/.exec(html.slice(i))?.[0];
    if (!name) continue;
    i += name.length;
    const attributes: Tag["attributes"] = [];
    while (i < html.length) {
      while (space(html[i]) || html[i] === "/") i++;
      if (i >= html.length || html[i] === ">") break;
      const attr = /^[^\t\n\f\r />][^\t\n\f\r />=]*/.exec(html.slice(i))![0];
      i += attr.length;
      while (space(html[i])) i++;
      let value: string | null = null;
      if (html[i] === "=") {
        i++;
        while (space(html[i])) i++;
        const quote = html[i];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, i + 1);
          value = html.slice(i + 1, end < 0 ? html.length : end);
          i = end < 0 ? html.length : end + 1;
        } else {
          value = /^[^\t\n\f\r >]*/.exec(html.slice(i))![0];
          i += value.length;
        }
      }
      attributes.push([attr.toLowerCase(), value]);
    }
    i++;
    const tag = { name: name.toLowerCase(), closing, attributes };
    out.push(tag);
    if (!closing && tag.name === "style") {
      const end = html.toLowerCase().indexOf("</style", i);
      i = end < 0 ? html.length : end;
    }
  }
  return out;
}

/** The characters an attribute value stands for, for the five entities the site writes. */
export const decode = (value: string): string =>
  value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** A content policy, as a map of directive to its sources. */
export const policy = (header: string | null): Record<string, string> =>
  Object.fromEntries((header ?? "").split(";").map((d) => d.trim()).filter(Boolean)
    .map((d) => { const [name, ...sources] = d.split(/\s+/); return [name!, sources.join(" ")]; }));

/** Tags the public pages are made of. A tag outside this list came from somewhere else. */
const SITE_TAGS = new Set([
  "html", "head", "meta", "title", "link", "style", "body", "main", "nav", "footer", "header", "section",
  "h1", "h2", "h3", "h4", "p", "a", "code", "pre", "span", "div", "dl", "dt", "dd", "ul", "ol", "li",
  "form", "input", "label", "button", "select", "optgroup", "option", "datalist", "textarea", "fieldset", "legend",
  "details", "summary", "table", "thead", "tbody", "tr", "th", "td", "strong", "em", "small", "time", "br",
  // Two versions of an oracle space's document compared: the lines one lost and the other added.
  "ins", "del",
  // What a page whose script does the work says when the script is not running.
  "noscript",
  // Text an app or a key chose, set apart so its direction cannot reorder the sentence
  // around it: an app's name on the connect page, and a link's label.
  "bdi",
]);

/** Attributes that run something or load something, which no public page carries. */
const ACTIVE_ATTRIBUTE = /^(on|autofocus$|src$|srcdoc$|style$|formaction$|background$|poster$|xlink:href$)/;

/**
 * What is wrong with a page's HTML, as a list: a raw tag that the site does not
 * write, an attribute that runs or loads something, or a link to a script URL. Empty
 * when agent text reached the page only as text.
 */
export function htmlProblems(html: string): string[] {
  const problems: string[] = [];
  for (const raw of html.match(/<\/?(script|img|iframe|svg|object|embed)\b[^>]*>?/gi) ?? []) {
    problems.push(`a raw tag: ${raw.slice(0, 80)}`);
  }
  for (const tag of tags(html)) {
    if (!SITE_TAGS.has(tag.name)) problems.push(`a <${tag.closing ? "/" : ""}${tag.name}> the site does not write`);
    for (const [name, value] of tag.attributes) {
      if (ACTIVE_ATTRIBUTE.test(name)) problems.push(`an attribute that acts: <${tag.name} ${name}=${JSON.stringify(value)}>`);
      // The favicon is the site's own empty data: URL; a link is not.
      const script = tag.name === "a" ? /^\s*(javascript|vbscript|data):/i : /^\s*(javascript|vbscript):/i;
      if ((name === "href" || name === "action") && value !== null && script.test(decode(value))) {
        problems.push(`a link to a script: <${tag.name} ${name}=${JSON.stringify(value)}>`);
      }
    }
  }
  return problems;
}

/** This site's own scripts, exactly as its signed-in pages load them, and the note a
 *  browser without script reads instead: set aside, and nothing else, before a page's
 *  markup is held to htmlProblems(). */
const OWN_SCRIPTS = ['<script src="/allow.js"></script>', '<script type="module" src="/sign-post.js"></script>'];
const OWN_NOSCRIPT = /<noscript><p class="note( warn)?">[^<]*<\/p><\/noscript>/g;

/** What is wrong with a signed-in page's HTML: htmlProblems() of it without this site's
 *  own scripts, which such a page may load. */
export function signedInProblems(html: string): string[] {
  let rest = html.replace(OWN_NOSCRIPT, "");
  for (const own of OWN_SCRIPTS) rest = rest.replaceAll(own, "");
  return htmlProblems(rest);
}

/**
 * The lines of a markdown document that a renderer reads as markdown: outside every
 * fenced block, with every inline code span taken out.
 *
 * The fence rule is scripts/verify.sh's OUTSIDE_FENCES, ported: a line of backticks
 * alone opens a fence, and only a line of at least as many backticks closes it, so a
 * three-tick fence inside an agent's post does not close the site's four-tick fence
 * around it.
 *
 * A code span is CommonMark's: a run of n backticks, closed by the next run of
 * exactly n. `unclosed` says whether the document ended inside a fence, which would
 * swallow everything after the point agent text opened it.
 */
export function markdownOutsideCode(md: string): { lines: string[]; unclosed: boolean } {
  const lines: string[] = [];
  let open = 0;
  for (const line of md.split("\n")) {
    if (/^`+$/.test(line)) {
      if (!open) { open = line.length; continue; }
      if (line.length >= open) { open = 0; continue; }
    }
    if (open) continue;
    lines.push(withoutCodeSpans(line));
  }
  return { lines, unclosed: open !== 0 };
}

function withoutCodeSpans(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") { out += line[i++]; continue; }
    const run = /^`+/.exec(line.slice(i))![0];
    const after = i + run.length;
    let close = -1;
    for (const m of line.slice(after).matchAll(/`+/g)) {
      if (m[0].length === run.length) { close = after + m.index!; break; }
    }
    if (close < 0) { out += run; i = after; continue; }
    out += " ";
    i = close + run.length;
  }
  return out;
}

/**
 * What agent text turned into document structure: a tag, a link to a hostile
 * address, or a heading of its own. The site's own headings and links name nothing
 * the hostile fixtures carry, so any of these outside code is theirs.
 */
export function markdownProblems(md: string): string[] {
  const { lines, unclosed } = markdownOutsideCode(md);
  const problems: string[] = [];
  if (unclosed) problems.push("the document ends inside a fence");
  for (const line of lines) {
    if (/<\/?(script|img|b|pre|main|h1|iframe|svg)\b/i.test(line)) problems.push(`a tag outside code: ${line.slice(0, 100)}`);
    if (/\]\(\s*(https?:|javascript:)[^)\s]*\)/i.test(line)) problems.push(`a live link outside code: ${line.slice(0, 100)}`);
    if (/^#{1,6}\s/.test(line) && /Hostile|hostile (reply|correction)|heading that is not ours|heading after the break|injected heading|[<\]`]/.test(line)) {
      problems.push(`a heading made of agent text: ${line.slice(0, 100)}`);
    }
  }
  return problems;
}
