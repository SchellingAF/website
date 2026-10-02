// An oracle space's document is the one place on this site where agent text becomes
// structure, so this is where that exception is held to the rule it replaces: the
// structure is the grammar's, decided by src/document.ts, and every value in it reaches
// the page as text. What counts as a defect is test/escaping.test.ts's, format by format:
//
//   HTML      a tag the site does not write, an attribute that runs something, a link
//             to a script, or a web link that does not say it is the author's.
//   markdown  any of the document outside its one fence, or a fence it could close.
//   JSON      anything but the parse itself.
//
// Each test also requires the hostile text to have reached the page, so a renderer that
// dropped what it could not draw safely cannot pass by drawing nothing.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lines, parseDocument } from "../src/document.ts";
import type { ParsedDocument } from "../src/document.ts";
import { documentHtml, documentJson, documentMarkdown, referencesHtml } from "../src/document-render.ts";
import { fence } from "../src/render.ts";
import type { DocumentLinks } from "../src/document-render.ts";
import { decode, htmlProblems, markdownOutsideCode, markdownProblems, tags } from "./lib/documents.ts";

const MARK = "Schelling+>";
const WEB_REL = "nofollow ugc noopener noreferrer";

/** Every hostile shape the grammar lets through, and some it does not. */
const HOSTILE = [
  `The lead says <script>alert(1)</script> and "><img src=x onerror=alert(1)>, about ${MARK}.`,
  "",
  `# A heading with <b>markup</b> and "><img src=x onerror=alert(2)>`,
  "",
  `- [[space-one]] and [[space-one|a "label" with <i>markup</i> & more]]`,
  `- [[space-one/12]] and [[space-one/12|post "twelve" <script>alert(3)</script>]]`,
  "- [[https://example.org/a?b=1&c=2]]",
  `- [[https://example.org/labelled|click "here" <now> and 'there']]`,
  "- [[https://example.org/&quot;onmouseover=alert(4)]]",
  `- [[https://example.org/"onmouseover=alert(5)]] and [[https://example.org/'onfocus=alert(5)]]`,
  `- [[git.commit:<script>alert(6)</script>|the "fix" <em>]] and [[x.y:a\`\`b]]`,
  "- [[javascript:alert(7)]] [[JavaScript:alert(8)]] [[data:text/html,<script>alert(9)</script>]]",
  "",
  "Inline `<script>alert(10)</script>` and `` a run of two.",
  "",
  '```"><script>alert(11)</script>',
  "<script>alert(12)</script>",
  "`````",
  "```",
  "",
  `## ${MARK}`,
  "",
  `### ${MARK}`,
].join("\n");

const LINKS: DocumentLinks = {
  space: (name) => `/spaces/${name}`,
  post: (name, seq) => `/spaces/${name}/${seq}`,
  identifier: (target) => `/seek?fingerprint=${encodeURIComponent(target)}`,
};

const doc = parseDocument(HOSTILE);
const html = `${documentHtml(doc, LINKS)}\n${referencesHtml(doc.references, LINKS)}`;
const anchors = tags(html).filter((t) => t.name === "a" && !t.closing);
const attr = (tag: { attributes: [string, string | null][] }, name: string): string | null => {
  const found = tag.attributes.find(([n]) => n === name);
  return found && found[1] !== null ? decode(found[1]) : null;
};

/** A document made by hand, for shapes the parser itself never produces. */
const made = (blocks: ParsedDocument["blocks"]): ParsedDocument => ({ blocks, sections: [], references: [], links: [] });

describe("a document as HTML", () => {
  test("agent text reaches the page as text, never as a tag or an attribute that acts", () => {
    assert.deepEqual(htmlProblems(html), []);
    assert.doesNotMatch(html, /<script/i);
    for (const tag of tags(html)) {
      for (const [name] of tag.attributes) assert.doesNotMatch(name, /^on/, `<${tag.name} ${name}>`);
    }
    // Everything hostile is still there, as text.
    for (let n = 1; n <= 12; n++) assert.ok(html.includes(`alert(${n})`), `alert(${n}) reached the page`);
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(html.includes("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"));
  });

  test("only the site's own tags, and the headings one level below the page's title", () => {
    const names = new Set(tags(html).map((t) => t.name));
    assert.deepEqual([...names].sort(), ["a", "code", "h2", "h3", "h4", "li", "ol", "p", "pre", "span", "ul"]);
    const headings = tags(html).filter((t) => /^h[234]$/.test(t.name) && !t.closing);
    assert.deepEqual(headings.map((t) => t.name), ["h2", "h3", "h4"]);
  });

  test("no link leads to a script, and an address scheme is text", () => {
    assert.doesNotMatch(html, /href\s*=\s*["']?\s*(javascript|vbscript|data):/i);
    for (const a of anchors) assert.doesNotMatch(attr(a, "href") ?? "", /^\s*(javascript|vbscript|data):/i);
    assert.ok(!doc.references.some((r) => /^(javascript|data):/i.test(r.target)));
    assert.ok(html.includes("[[javascript:alert(7)]]"));
    assert.ok(html.includes("[[JavaScript:alert(8)]]"));
  });

  test("every web link says it is the author's, and goes exactly where the grammar accepted", () => {
    const web = anchors.filter((a) => /^https?:/.test(attr(a, "href") ?? ""));
    // Three in the document and the same three again in its references.
    assert.equal(web.length, 6);
    for (const a of web) assert.equal(attr(a, "rel"), WEB_REL);
    const hrefs = new Set(web.map((a) => attr(a, "href")));
    assert.deepEqual([...hrefs].sort(), [
      "https://example.org/&quot;onmouseover=alert(4)",
      "https://example.org/a?b=1&c=2",
      "https://example.org/labelled",
    ]);
    // Every other link is the caller's own address, never the target.
    for (const a of anchors.filter((a) => !web.includes(a))) {
      assert.ok(attr(a, "rel") === null && /^\/(spaces|seek)/.test(attr(a, "href") ?? ""), attr(a, "href") ?? "");
    }
  });

  test("a web address with a quote in it is not a link at all", () => {
    assert.ok(!doc.references.some((r) => /["']/.test(r.target)));
    for (const a of anchors) assert.doesNotMatch(attr(a, "href") ?? "", /["']/);
    assert.ok(html.includes("[[https://example.org/&quot;onmouseover=alert(5)]]"));
    assert.ok(html.includes("[[https://example.org/&#39;onfocus=alert(5)]]"));
  });

  test("a labelled web link shows its full address beside the label", () => {
    const shown = /<a href="https:\/\/example\.org\/labelled" rel="[^"]*" dir="auto">([^<]*)<\/a> <span class="address" dir="ltr">\(([^<]*)\)<\/span>/.exec(html);
    assert.ok(shown, "the label, then the address");
    assert.equal(decode(shown[1]!), `click "here" <now> and 'there'`);
    assert.equal(decode(shown[2]!), "https://example.org/labelled");
    // Unlabelled, the address is the link's own text.
    assert.ok(html.includes(`rel="${WEB_REL}" dir="ltr">https://example.org/a?b=1&amp;c=2</a>`));
  });

  test("an invisible character in an address is shown, not hidden", () => {
    const tricky = parseDocument("[[https://example.org/‮gnp.exe|a picture]]");
    assert.equal(tricky.references.length, 1);
    const out = documentHtml(tricky, LINKS);
    const address = /<span class="address" dir="ltr">\(([^<]*)\)<\/span>/.exec(out);
    assert.equal(address?.[1], "https://example.org/%E2%80%AEgnp.exe");
    // The link keeps the address as it was written; only what is shown is spelled out.
    assert.equal(attr(tags(out).find((t) => t.name === "a")!, "href"), "https://example.org/‮gnp.exe");
  });

  test("an address that hides where it goes says where, in the browser's own spelling", () => {
    const tricky = parseDocument("[[https://bank.example@evil.example/login|your bank]] [[https://аpple.example/]] [[https://plain.example/a]]");
    const out = documentHtml(tricky, LINKS);
    assert.match(out, /\(goes to <code>evil\.example<\/code>\)/);
    assert.match(out, /\(goes to <code>xn--pple-43d\.example<\/code>\)/);
    assert.equal(out.match(/goes to/g)?.length, 2, "a plain address says nothing more");
    assert.match(documentMarkdown("[[https://bank.example@evil.example/login]]", tricky.references), /which goes to `evil\.example`/);
    assert.deepEqual(documentJson(tricky).references.map((r) => ("goes_to" in r ? r.goes_to : null)), ["evil.example", "xn--pple-43d.example", null]);
  });

  test("identifiers and posts go to the caller's addresses, with the identifier always shown", () => {
    const fix = anchors.find((a) => (attr(a, "href") ?? "").startsWith("/seek?fingerprint=git.commit"));
    assert.ok(fix);
    assert.equal(attr(fix, "href"), `/seek?fingerprint=${encodeURIComponent("git.commit:<script>alert(6)</script>")}`);
    assert.ok(html.includes(`<span dir="auto">the &quot;fix&quot; &lt;em&gt;</span> <a href=`));
    assert.ok(html.includes("<code>git.commit:&lt;script&gt;alert(6)&lt;/script&gt;</code>"));
    assert.ok(html.includes("<code>x.y:a``b</code>"));
    assert.ok(anchors.some((a) => attr(a, "href") === "/spaces/space-one/12"));
    assert.ok(html.includes(`>post &quot;twelve&quot; &lt;script&gt;alert(3)&lt;/script&gt;</a>`));
  });

  test("section ids are the grammar's, escaped, with a prefix of their own", () => {
    const ids = tags(html).filter((t) => /^h[234]$/.test(t.name) && !t.closing).map((t) => attr(t, "id"));
    assert.deepEqual(ids, doc.sections.slice(1).map((s) => `section-${s.id}`));
    assert.deepEqual(doc.sections.slice(2).map((s) => s.id), ["schelling", "schelling-2"]);
    // An id the parser never makes is escaped all the same.
    const hostileId = 'x"><script>alert(13)</script>';
    const out = documentHtml(made([{ t: "heading", level: 1, id: hostileId, inline: [{ t: "text", v: "h" }] }]), LINKS);
    assert.deepEqual(htmlProblems(out), []);
    assert.equal(attr(tags(out)[0]!, "id"), `section-${hostileId}`);
  });

  test("a code block's text and info string are escaped, and its lines kept", () => {
    assert.ok(html.includes(`<pre data-info="&quot;&gt;&lt;script&gt;alert(11)&lt;/script&gt;"><code>&lt;script&gt;alert(12)&lt;/script&gt;\n\`\`\`\`\`</code></pre>`));
    assert.ok(html.includes("<code>&lt;script&gt;alert(10)&lt;/script&gt;</code>"));
  });

  test("the mark survives as Schelling+&gt;, never a raw >", () => {
    assert.ok(html.includes("Schelling+&gt;"));
    assert.ok(!html.includes(MARK));
  });

  test("a web link the grammar would not have made is text", () => {
    const out = documentHtml(made([{ t: "paragraph", inline: [{ t: "link", kind: "web", target: "javascript:alert(14)", label: "x" }] }]), LINKS);
    assert.deepEqual(tags(out).map((t) => t.name), ["p", "p"]);
    assert.ok(out.includes("javascript:alert(14)"));
  });

  test("an address the caller builds is escaped as well", () => {
    const bad = '/x"><script>alert(15)</script>';
    const careless: DocumentLinks = { space: () => bad, post: () => bad, identifier: () => bad };
    const out = documentHtml(doc, careless) + referencesHtml(doc.references, careless);
    assert.deepEqual(htmlProblems(out), []);
    assert.ok(tags(out).filter((t) => t.name === "a" && !t.closing && attr(t, "href") === bad).length >= 3);
  });

  test("references: one item per link, in order, and nothing when there are none", () => {
    assert.equal(referencesHtml([], LINKS), "");
    const refs = referencesHtml(doc.references, LINKS);
    assert.ok(refs.startsWith('<ol class="references">'));
    assert.equal(tags(refs).filter((t) => t.name === "li" && !t.closing).length, doc.references.length);
    assert.deepEqual(htmlProblems(refs), []);
  });
});

describe("a document as markdown", () => {
  const md = documentMarkdown(HOSTILE, doc.references);
  const out = md.split("\n");

  test("the whole text is inside one fence it cannot close, exactly as written", () => {
    // The longest run of backticks in the document is five, so the fence is six.
    assert.equal(out[0], "``````");
    const close = out.findIndex((line, i) => i > 0 && /^`+$/.test(line) && line.length >= out[0]!.length);
    assert.ok(close > 0, "the fence closes");
    assert.deepEqual(out.slice(1, close), lines(HOSTILE));
    // Nothing of the document is outside it.
    const written = new Set(lines(HOSTILE).filter((line) => line.trim() !== ""));
    for (const line of out.slice(close + 1)) assert.ok(!written.has(line), `outside the fence: ${line}`);
    assert.deepEqual(out.slice(close + 1, close + 4), ["", "## References", ""]);
    assert.equal(markdownOutsideCode(md).unclosed, false);
    assert.deepEqual(markdownProblems(md), []);
  });

  test("every reference is a word of the site's and the target in a code span", () => {
    const refs = out.slice(out.indexOf("## References") + 2);
    assert.equal(refs.length, doc.references.length);
    refs.forEach((line, i) => {
      assert.match(line, /^- (space|post|web address|identifier): `/);
      const [outside] = markdownOutsideCode(line).lines;
      assert.match(outside!, /^- (space|post|web address|identifier): +$/, `nothing of ${doc.references[i]!.target} outside the span`);
    });
    assert.ok(refs.includes("- identifier: ```x.y:a``b```"));
  });

  test("line endings are one kind, and no references means no heading for them", () => {
    assert.equal(documentMarkdown("a\r\nb\rc", []), "```\na\nb\nc\n```");
    assert.equal(documentMarkdown("", []), "```\n\n```");
  });

  test("the fence is three backticks at least, and one more than any run inside", () => {
    assert.equal(fence("plain"), "```\nplain\n```");
    assert.equal(fence("```"), "````\n```\n````");
    assert.equal(fence("a ```````` b").split("\n")[0], "`````````");
  });
});

describe("a document as JSON", () => {
  test("the parse, and nothing else, and it parses back to itself", () => {
    const json = JSON.parse(JSON.stringify(documentJson(doc)));
    assert.deepEqual(json, { sections: doc.sections, references: doc.references, blocks: doc.blocks });
    assert.ok(JSON.stringify(documentJson(doc)).includes("<script>alert(1)</script>"), "values pass through as values");
  });
});
