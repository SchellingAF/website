// The build's own checks, asked directly: the markdown converter, the guard that
// holds /human to the approved copy, and the check that no page loads anything from
// off this origin.
//
// build.mjs builds only when it is run (import.meta.main), so importing it here
// builds nothing. The converter is strict on purpose: it renders the constructs the
// copy uses and refuses, with a file and a line, every one it knows it does not.
// Each refusal checks every line a construct takes, and a refusal and a paragraph never
// disagree about a line, so the build always finishes.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DYNAMIC_ROUTES, TAB_ICON, assertApprovedCopy, checkNoExternalLoads, inline, reservation, toHtml } from "../build.mjs";
import { tags } from "./lib/documents.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("the markdown converter", () => {
  test("renders the constructs the copy uses", () => {
    const html = toHtml([
      "# The mark",
      "",
      "A paragraph with **bold**, *italic* and [a link](/api).",
      "Its second line.  ",
      "Its third, after a hard break.",
      "",
      "## A section",
      "",
      "- one",
      "- two",
      "",
      "> PEER A: first",
      ">",
      "> PEER B: second",
    ].join("\n"), "content/x.md", 1);
    assert.equal(html, [
      '<h1 id="the-mark">The mark</h1>',
      '<p>A paragraph with <strong>bold</strong>, <em>italic</em> and <a href="/api">a link</a>.\nIts second line.<br>\nIts third, after a hard break.</p>',
      '<h2 id="a-section">A section</h2>',
      "<ul><li>one</li><li>two</li></ul>",
      "<blockquote><p>PEER A: first</p><p>PEER B: second</p></blockquote>",
    ].join("\n"));
  });

  test("refuses every construct it does not render, naming the file and the line", () => {
    const refusals: [string, string][] = [
      ["### A third level", "heading level 3+ is not supported"],
      ["```", "code fences are not supported"],
      ["~~~", "code fences are not supported"],
      ["| a | b |", "tables are not supported"],
      ["* an item", 'use "-" for bullets'],
      ["+ an item", 'use "-" for bullets'],
      ["1. an item", "ordered lists are not supported"],
      ["---", "horizontal rules are not supported"],
      ["***", "horizontal rules are not supported"],
      ["<div>raw</div>", "raw HTML is not supported"],
      ["    indented code", "indented code blocks are not supported"],
      [">Quoted without a space", 'write "> " before quoted text'],
      ["a `backtick`", "backticks are not supported"],
    ];
    for (const [line, why] of refusals) {
      assert.throws(() => toHtml(`A first paragraph.\n\n${line}`, "content/x.md", 10), (e: Error) =>
        e.message.startsWith(`content/x.md:12  ${why}`), line);
    }
  });

  test("checks every line a construct takes, not only its first", () => {
    for (const [body, line] of [["- one\n- `two`", 2], ["> one\n> `two`", 2], ["A paragraph\nwith a `backtick` on its second line", 2], ["- one\n- two\n- three `3`", 3]] as const) {
      assert.throws(() => toHtml(body, "content/x.md", 1), (e: Error) => e.message.startsWith(`content/x.md:${line}  backticks are not supported`), body);
    }
  });

  test("finishes on a line that is almost a quote", { timeout: 2000 }, () => {
    assert.throws(() => toHtml("A paragraph\n>Quoted", "content/x.md", 1), /write "> " before quoted text/);
  });

  test("escapes text, and a link's address cannot leave its attribute", () => {
    assert.equal(inline(`<script>alert(1)</script> & "q"`), "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;");
    assert.equal(inline("[<b>x</b>](/y)"), '<a href="/y">&lt;b&gt;x&lt;/b&gt;</a>');
    const link = inline(`[x](/a"onmouseover="b)`);
    const parsed = tags(link);
    assert.deepEqual(parsed[0]?.attributes.map(([n]) => n), ["href"], link);
    assert.equal(inline("[a](/b?c=1&d=2)"), '<a href="/b?c=1&amp;d=2">a</a>', "an ampersand escaped once");
  });
});

describe("the approved copy guard", () => {
  const approved = readFileSync(path.join(ROOT, "reference", "approved-copy.md"), "utf8");
  // The copy as a page renders it: the markdown's own marks gone, as the guard strips them.
  const rendered = approved.replace(/\*\*/g, "").replace(/^\s*[-*]\s+/gm, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^>\s?/gm, "");
  const page = (text: string) => `<main>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}</main>`;

  test("passes a page carrying every approved sentence", () => {
    assert.ok(assertApprovedCopy(page(rendered), rendered, {}) > 50);
  });

  test("fails a page that lost a sentence", () => {
    const sentence = "Its interfaces, tools, and conventions are designed for agents to use directly.";
    assert.ok(rendered.includes(sentence));
    const without = rendered.replace(sentence, "");
    assert.throws(() => assertApprovedCopy(page(without), without, {}), /approved sentence is not on \/human/);
  });

  test("fails a page that lost the mark's +>", () => {
    const unmarked = rendered.replaceAll("Schelling+>", "Schelling");
    assert.throws(() => assertApprovedCopy(page(unmarked), unmarked, {}), /approved sentence/);
  });
});

describe("the check that no page loads anything from off this origin", () => {
  const human = { route: "/human", meta: { audience: "human" } };
  const agent = { route: "/", meta: { audience: "agent" } };

  test("passes this origin's own files, data URLs and navigations anywhere", () => {
    const html = `<link rel="icon" href="data:,"><link rel="stylesheet" href="/overview.css"><script src="/overview.js"></script>
<img src="/logo/mark.svg"><style>@font-face{src:url(/fonts/mono.woff2)}</style>
<a href="https://example.com/report">a navigation</a><link rel="canonical" href="https://schellingaf.com/human">
<link rel="alternate" type="text/markdown" href="https://schellingaf.com/human.md">`;
    assert.equal(checkNoExternalLoads(human, html), 5, "the icon, the stylesheet, the script, the image and the font");
  });

  test("the tab icon of a page that loads nothing is the mark, written into the page, and loads nothing", async () => {
    // Two pictures, both data: the svg, which is assets/logo/favicon.svg, and the png.
    assert.equal(checkNoExternalLoads(agent, TAB_ICON), 2);
    const svg = /href="data:image\/svg\+xml,([^"]+)"/.exec(TAB_ICON)?.[1];
    assert.equal(decodeURIComponent(svg ?? ""), readFileSync(path.join(ROOT, "assets/logo/favicon.svg"), "utf8").trim());
    assert.match(TAB_ICON, /href="data:image\/png;base64,[A-Za-z0-9+/=]+" sizes="32x32"/);
    // The live pages carry the same two lines, from the file the build writes.
    const generated = await import("../src/routes.generated.ts");
    assert.equal(generated.TAB_ICON, TAB_ICON);
    assert.ok(!/href="data:,"/.test(readFileSync(path.join(ROOT, "src/render.ts"), "utf8")), "a live page still has the empty icon");
  });

  test("fails a script, a stylesheet, an icon, a font or an import from another origin, in either quote", () => {
    for (const html of [
      `<script src="https://cdn.example/x.js"></script>`,
      `<script src='https://cdn.example/x.js'></script>`,
      `<img src="http://images.example/x.png">`,
      `<link rel="stylesheet" href="https://fonts.googleapis.com/css2">`,
      `<link rel="shortcut icon" href="https://example.com/favicon.ico">`,
      `<link rel="preload" href='https://cdn.example/font.woff2'>`,
      `<style>@font-face{src:url("https://fonts.gstatic.com/x.woff2")}</style>`,
      `<style>@import "https://cdn.example/x.css";</style>`,
    ]) {
      assert.throws(() => checkNoExternalLoads(human, html), /loads something from off this origin/, html);
    }
  });

  test("fails any script at all on a page written for agents, however its tag is written", () => {
    for (const html of [`<script src="/overview.js"></script>`, `<SCRIPT>1</SCRIPT>`, `<script/src="/overview.js"></script>`]) {
      assert.throws(() => checkNoExternalLoads(agent, html), /must carry no script at all/, html);
    }
  });

  test("fails a protocol-relative address, which loads from another origin", () => {
    for (const html of [
      `<script src="//evil.example/x.js"></script>`,
      `<link rel="stylesheet" href="//evil.example/x.css">`,
      `<style>@font-face{src:url(//evil.example/x.woff2)}</style>`,
      // The same address as a browser is brought to read it: a backslash is read as a
      // slash, a tab is dropped, and a character reference becomes its character.
      `<img src="/\\evil.example/x.png">`,
      `<script src="/\t/evil.example/x.js"></script>`,
      `<script src="/&#47;evil.example/x.js"></script>`,
    ]) {
      assert.throws(() => checkNoExternalLoads(human, html), /loads something from off this origin/, html);
    }
  });

  test("fails an attribute however a browser reads it: in capitals, unquoted, or over a line break", () => {
    for (const html of [
      `<SCRIPT SRC="https://evil.example/x.js"></SCRIPT>`,
      `<script src=https://evil.example/x.js></script>`,
      `<script src="\nhttps://evil.example/x.js"></script>`,
      // Spaces around the "=", a slash or the quote that closed the value before it in
      // place of a space, and a ">" inside quotes, which does not end the tag.
      `<img src = "https://evil.example/x.png">`,
      `<img/src="https://evil.example/x.png">`,
      `<img alt="a"src="https://evil.example/x.png">`,
      `<LINK REL=STYLESHEET HREF=https://evil.example/x.css>`,
      `<link title="a>b" rel="stylesheet" href="https://evil.example/x.css">`,
    ]) {
      assert.throws(() => checkNoExternalLoads(human, html), /loads something from off this origin/, html);
    }
  });

  test("fails every other attribute a browser loads from: any srcset candidate, a poster, an object's data", () => {
    for (const html of [
      `<img srcset="https://evil.example/x.png 2x">`,
      `<video poster="https://evil.example/x.png"></video>`,
      `<object data="https://evil.example/x.swf"></object>`,
      `<img src="/logo/mark.svg" srcset="/logo/mark.svg 1x, https://evil.example/x.png 2x">`,
      `<picture><source srcset="https://evil.example/x.webp"><img src="/logo/mark.svg"></picture>`,
      `<link rel="preload" as="image" href="/logo/mark.svg" imagesrcset="https://evil.example/x.png 2x">`,
      `<body background="https://evil.example/x.png">`,
      // Inside an svg, an image and a script load from their href.
      `<svg><image href="https://evil.example/x.png"/></svg>`,
      `<svg><script xlink:href="https://evil.example/x.js"/></svg>`,
    ]) {
      assert.throws(() => checkNoExternalLoads(human, html), /loads something from off this origin/, html);
    }
  });

  test("fails a srcset candidate hidden behind character references, which a browser decodes before it splits the list", () => {
    for (const html of [
      `<img src="/logo/mark.svg" srcset="/logo/mark.svg&#32;1x&#44;&#32;https://evil.example/x.png&#32;2x">`,
      `<img src="/logo/mark.svg" srcset="/logo/mark.svg 1x&comma; https://evil.example/x.png 2x">`,
      `<link rel="preload" as="image" href="/logo/mark.svg" imagesrcset="/logo/mark.svg&#32;1x&#44;&#32;https://evil.example/x.png&#32;2x">`,
    ]) {
      assert.throws(() => checkNoExternalLoads(human, html), /loads something from off this origin/, html);
    }
  });

  test("fails an svg animation that writes another origin's address into an href, however it names the attribute or lists its values", () => {
    for (const html of [
      `<svg><image href="/logo/mark.svg" width="10" height="10"><set attributeName="href" to="https://evil.example/x.png"/></image></svg>`,
      `<svg><image width="10" height="10"><animate attributeName="href" values="https://evil.example/x.png" dur="1s"/></image></svg>`,
      // The older name, which a declared namespace makes the same attribute, and the value an
      // animation starts from.
      `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image width="10" height="10"><animate attributeName="xlink:href" from="https://evil.example/x.png" to="/logo/mark.svg" dur="1s"/></image></svg>`,
      // A later value in the list, and one a character reference separates, which a browser
      // decodes before it splits the list.
      `<svg><image width="10" height="10"><animate attributeName="href" values="/logo/mark.svg; https://evil.example/x.png" dur="1s"/></image></svg>`,
      `<svg><image width="10" height="10"><animate attributeName="href" values="/logo/mark.svg&#59https://evil.example/x.png" dur="1s"/></image></svg>`,
      // The attribute's name written with character references, a prefix's colon among
      // them, and every name in capitals.
      `<svg><image width="10" height="10"><set attributeName="&#104;ref" to="https://evil.example/x.png"/></image></svg>`,
      `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image width="10" height="10"><set attributeName="xlink&colon;href" to="https://evil.example/x.png"/></image></svg>`,
      `<SVG><IMAGE WIDTH=10 HEIGHT=10><SET ATTRIBUTENAME=href TO=https://evil.example/x.png /></IMAGE></SVG>`,
    ]) {
      assert.throws(() => checkNoExternalLoads(human, html), /loads something from off this origin/, html);
    }
  });

  test("fails a link unless every rel it carries is known to load nothing: one the check has not met, or one written with a character reference", () => {
    for (const html of [
      `<link rel="compression-dictionary" href="https://evil.example/x.dict">`,
      `<link rel="a-rel-no-browser-has-yet" href="https://evil.example/x">`,
      `<link rel="&#115;tylesheet" href="https://evil.example/x.css">`,
      `<link rel="canonical &#115;tylesheet" href="https://evil.example/x.css">`,
    ]) {
      assert.throws(() => checkNoExternalLoads(human, html), /loads something from off this origin/, html);
    }
  });

  test("fails any base element, which moves where every relative address loads from", () => {
    for (const html of [
      `<base href="https://evil.example/"><script src="/overview.js"></script>`,
      `<BASE HREF=/>`,
      `<base target="_blank">`,
    ]) {
      assert.throws(() => checkNoExternalLoads(human, html), /base element/, html);
    }
  });

  test("fails any meta http-equiv, a header written into the page, since a refresh sends the page to another address with no click", () => {
    for (const html of [
      `<meta http-equiv="refresh" content="1;url=https://evil.example/x.html">`,
      `<META HTTP-EQUIV=REFRESH CONTENT=0;URL=https://evil.example/x.html>`,
      `<meta content="0; url='https://evil.example/x.html'" http-equiv="Refresh">`,
      `<meta http-equiv="&#114;efresh" content="0;url=https://evil.example/x.html">`,
      // Any other header as well, even one that loads nothing: this site sets every header
      // in src/index.ts.
      `<meta http-equiv="content-type" content="text/html; charset=utf-8">`,
    ]) {
      assert.throws(() => checkNoExternalLoads(human, html), /http-equiv/, html);
    }
  });

  // What a data: address holds, written as a browser is handed it.
  const pct = encodeURIComponent;
  const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${inner}</svg>`;

  test("fails a data: address anywhere but a picture, since the stylesheet, document or script it holds loads from wherever it names", () => {
    const css = `@import "https://evil.example/x.css";`;
    const image = `<image href="https://evil.example/x.png" width="10" height="10"/>`;
    const script = `fetch("https://evil.example/x.json")`;
    for (const html of [
      `<link rel="stylesheet" href="data:text/css,${pct(css)}">`,
      `<link rel="stylesheet" href="data:text/css;base64,${btoa(css)}">`,
      `<style>@import url("data:text/css,${pct(css)}");</style>`,
      // An icon's rel does not make a stylesheet a picture.
      `<link rel="icon stylesheet" href="data:text/css,${pct(css)}">`,
      `<iframe src="data:text/html,${pct(`<img src="https://evil.example/x.png">`)}"></iframe>`,
      `<object data="data:image/svg+xml,${pct(svg(image))}"></object>`,
      `<embed src="data:image/svg+xml,${pct(svg(image))}">`,
      `<script src="data:text/javascript,${pct(script)}"></script>`,
      `<svg><script href="data:text/javascript,${pct(script)}"></script></svg>`,
      // Read as UTF-8, neither holds a load, but a browser reads the encoding the address
      // names: so decoding an address as UTF-8 would not be enough to check it.
      `<link rel="stylesheet" href="data:text/css;charset=utf-16le,${[...css].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}%00`).join("")}">`,
      `<link rel="stylesheet" href="data:text/css;charset=iso-2022-jp,${pct("@im")}%1B(B${pct(`port "https://evil.example/x.css";`)}">`,
    ]) {
      assert.throws(() => checkNoExternalLoads(human, html), /data: address/, html);
    }
  });

  test("fails any srcdoc, a whole document inside an attribute, whose tags can be written as character references", () => {
    for (const html of [
      `<iframe srcdoc="&lt;img src=&quot;https://evil.example/x.png&quot;&gt;"></iframe>`,
      `<IFRAME SRCDOC='<p>a document</p>'></IFRAME>`,
    ]) {
      assert.throws(() => checkNoExternalLoads(human, html), /srcdoc/, html);
    }
  });

  test("fails a url() or an @import however a stylesheet writes it: in capitals, spaced, over a line break, unspaced, commented, escaped or never closed", () => {
    for (const html of [
      `<style>@font-face{src:URL(https://evil.example/x.woff2)}</style>`,
      `<style>@font-face{src:url( "https://evil.example/x.woff2" )}</style>`,
      `<style>@font-face{src:url(\n"https://evil.example/x.woff2")}</style>`,
      `<style>@IMPORT "https://evil.example/x.css";</style>`,
      // Any space a stylesheet reads as one, in either quote.
      `<style>@font-face{src:url(\t'https://evil.example/x.woff2')}</style>`,
      `<style>@font-face{src:url(\r\n"https://evil.example/x.woff2")}</style>`,
      // An @import needs no space before its address, and a comment can stand in one, even
      // one holding character references, which a style element's text reads as text.
      `<style>@import"https://evil.example/x.css";</style>`,
      `<style>@import/**/"https://evil.example/x.css";</style>`,
      `<style>@import/*&ast;&sol;*/"https://evil.example/x.css";</style>`,
      // A name written with escapes is the same name.
      `<style>div{background:u\\72l(https://evil.example/x.png)}</style>`,
      `<style>@im\\70ort "https://evil.example/x.css";</style>`,
      // A url() left open runs to the end of the stylesheet, and loads.
      `<style>div{background:url(https://evil.example/x.png</style><p>it's text</p>`,
    ]) {
      assert.throws(() => checkNoExternalLoads(human, html), /loads something from off this origin/, html);
    }
  });

  test("fails a string in image-set() or -webkit-image-set(), which loads as a url() does, whichever candidate it is", () => {
    for (const html of [
      `<style>div{background:image-set("https://evil.example/x.png" 1x)}</style>`,
      `<style>div{background:-webkit-image-set("https://evil.example/x.png" 1x)}</style>`,
      `<style>div{background:IMAGE-SET('https://evil.example/x.png' 1x)}</style>`,
      `<style>div{background:image\\-set(/**/"https://evil.example/x.png" type("image/png"))}</style>`,
      // A later candidate: after a url(), after a type(), and after a string holding an
      // escaped quote.
      `<style>div{background:image-set(url(/logo/mark.svg) 1x, "https://evil.example/x.png" 2x)}</style>`,
      `<style>div{background:image-set("/logo/mark.svg" type("image/svg+xml") 1x, "https://evil.example/x.png" 2x)}</style>`,
      `<style>div{background:image-set("/logo/\\"mark.svg" 1x, "https://evil.example/x.png" 2x)}</style>`,
    ]) {
      assert.throws(() => checkNoExternalLoads(human, html), /loads something from off this origin/, html);
    }
  });

  test("fails a stylesheet in an attribute or inside svg, which HTML reads first: through a character reference, a comment, a CDATA section or a tag", () => {
    for (const html of [
      `<div style="background:&#117;rl(https://evil.example/x.png)"></div>`,
      `<div style="background:image-set(&quot;https://evil.example/x.png&quot; 1x)"></div>`,
      `<svg><style>@&#105;mport "https://evil.example/x.css";</style></svg>`,
      `<svg><style>@import<!---->"https://evil.example/x.css";</style></svg>`,
      `<svg><style>@import<!-->"https://evil.example/x.css";</style></svg>`,
      `<svg><style>@import<![CDATA[ "https://evil.example/x.css" ]]>;</style></svg>`,
      // A ">" inside a quoted value does not end a tag, so the address in that value is
      // not the stylesheet's.
      `<svg><style>@import<a title='>"/overview.css"'></a> "https://evil.example/x.css";</style></svg>`,
    ]) {
      assert.throws(() => checkNoExternalLoads(human, html), /loads something from off this origin/, html);
    }
  });

  test("passes stylesheets loading from this origin however they are written, and strings that load nothing", () => {
    const html = `<style>@font-face{font-family:"Liberation Mono";src:URL( "/fonts/mono.woff2" ) format("woff2")}
@IMPORT"/overview.css";div{background:-webkit-image-set("/logo/mark.svg" type("image/svg+xml"), url(/logo/mark.svg) 2x);content:"https://example.com/"}</style>
<div style="background:image-set(&quot;/logo/mark.svg&quot; 1x)"></div><svg><style><![CDATA[@import url(/overview.css);]]></style></svg>
<p>Written as text, curl(https://example.com/) loads nothing.</p>`;
    assert.equal(checkNoExternalLoads(human, html), 6, "the font, the import, the two image-set candidates, the attribute's candidate and the svg's import");
  });

  test("passes those attributes loading from this origin, and markup that is only text", () => {
    const html = `<img alt="a > b" src=/logo/mark.svg srcset="data:image/png;base64,AAAA 1x, /logo/mark.svg 2x">
<VIDEO POSTER=/logo/mark.svg></VIDEO><object data="/logo/mark.svg"></object><svg><use href="#mark"/></svg>
<div data="https://example.com/" data-src="https://example.com/x.js"></div><A HREF=https://example.com/report>a navigation</A>
<p>Written as text, src="https://example.com/x.js" and &lt;img src=https://example.com/x.png&gt; load nothing.</p>`;
    assert.equal(checkNoExternalLoads(human, html), 6, "the image, its two candidates, the poster, the object's data and the use");
  });

  test("passes a data: address a browser only draws as a picture, whatever it holds, since a picture loads nothing", () => {
    const picture = `data:image/svg+xml,${pct(svg(`<image href="https://evil.example/x.png" width="10" height="10"/><style>@import url("https://evil.example/x.css");</style>`))}`;
    const html = `<link rel="shortcut icon" href="${picture}"><link rel="apple-touch-icon" href="${picture}">
<link rel="preload" as="image" imagesrcset="${picture} 1x"><img src="${picture}" srcset="${picture} 1x">
<input type="image" src="${picture}"><video poster="${picture}"></video><body background="${picture}">
<svg><image href="${picture}" width="10" height="10"/><filter id="f"><feImage xlink:href="${picture}"/></filter><rect width="10" height="10" filter="url(#f)"/></svg>`;
    assert.equal(checkNoExternalLoads(human, html), 11, "the two icons, the preload, the img's two, the input, the poster, the background, the svg image, the feImage and the rect's url(#f)");
  });

  test("passes an animation that writes this origin's own address or animates anything else, a srcset whose references decode to this origin, and a meta that is no header", () => {
    const html = `<svg><image href="/logo/mark.svg" width="10" height="10"><set attributeName="href" to="/logo/mark.svg"/>
<animate attributeName="href" values="/logo/mark.svg; /logo/mark.svg&#59/logo/mark.svg" dur="1s"/></image>
<rect width="10" height="10"><animate attributeName="opacity" values="0;1;0" dur="1s"/><set attributeName="x" to="5"/></rect></svg>
<img src="/logo/mark.svg" srcset="/logo/mark.svg&#32;1x&#44;&#32;/logo/mark.svg&#32;2x"><meta charset="utf-8"><meta name="robots" content="index, follow">`;
    assert.equal(checkNoExternalLoads(human, html), 8, "the image, the set, the animate's three values, the img and its two candidates");
  });

  test("fails a script with no src naming this origin's own file, whatever its type, since an import map and speculation rules load from anywhere with no JavaScript", () => {
    for (const html of [
      `<script>fetch("https://evil.example/x")</script>`,
      `<script type="module">import "https://evil.example/x.js";</script>`,
      // An import map sends a module this origin serves to another origin for what it
      // imports, and speculation rules fetch the addresses they list, or every link on the
      // page, which the check passes as navigations.
      `<script type="importmap">{"imports":{"/lib.js":"https://evil.example/x.js"}}</script><script type="module" src="/overview.js"></script>`,
      `<script type="speculationrules">{"prefetch":[{"source":"list","urls":["https://evil.example/x"]}]}</script>`,
      `<script type="speculationrules">{"prefetch":[{"source":"document","eagerness":"immediate"}]}</script><a href="https://example.com/report">a navigation</a>`,
      // A data block loads nothing today, but which types a browser acts on is a list the
      // check does not keep, as with rels.
      `<script type="application/ld+json">{"@context":"https://schema.org"}</script>`,
      // An empty one, and one with an href, which an HTML script ignores to run its text.
      `<script></script>`,
      `<script href="/overview.js">fetch("https://evil.example/x")</script>`,
    ]) {
      assert.throws(() => checkNoExternalLoads(human, html), /a script with no src naming this origin's own file/, html);
    }
  });

  test("fails a script with anything between its tags, even beside a src, since inside svg a src means nothing and the text runs, however it is written", () => {
    for (const html of [
      `<svg><script src="/overview.js">fetch("https://evil.example/x")</script></svg>`,
      // Inside svg a script's text is read as markup, so a character reference or a CDATA
      // section is text like any other, and runs.
      `<svg><script src="/overview.js">&#102;etch("https://evil.example/x")</script></svg>`,
      `<svg><script src="/overview.js"><![CDATA[fetch("https://evil.example/x")]]></script></svg>`,
      // An HTML script ignores its text beside a src, but the check cannot tell it from an
      // svg one.
      `<SCRIPT SRC=/overview.js>fetch("https://evil.example/x")</SCRIPT>`,
    ]) {
      assert.throws(() => checkNoExternalLoads(human, html), /a script with something between its tags/, html);
    }
  });

  test("fails any event handler on any page, however it is written, since what it holds is code, most of it run as the page opens", () => {
    for (const page of [human, agent]) {
      for (const html of [
        `<img src="/logo/mark.svg" onerror="fetch('https://evil.example/x')">`,
        `<body onload="fetch('https://evil.example/x')">`,
        `<svg onload="fetch('https://evil.example/x')"></svg>`,
        `<style onload="fetch('https://evil.example/x')">p{color:red}</style>`,
        `<details open ontoggle="fetch('https://evil.example/x')"><summary>a</summary></details>`,
        `<input autofocus onfocus="fetch('https://evil.example/x')">`,
        `<svg><animate attributeName="x" dur="1s" onbegin="fetch('https://evil.example/x')"/></svg>`,
        // One that waits for a click is code all the same, and which events fire with no
        // click at all is a list the check does not keep.
        `<a href="/api" onclick="fetch('https://evil.example/x')">a navigation</a>`,
        // In capitals and unquoted, after a slash or a closing quote, and over a line break.
        `<IMG SRC=/logo/mark.svg ONERROR=fetch('https://evil.example/x')>`,
        `<img/onerror="fetch('https://evil.example/x')"/src="/logo/mark.svg">`,
        `<img src="/logo/mark.svg"onerror="fetch('https://evil.example/x')">`,
        `<img src="/logo/mark.svg"\nonerror="fetch('https://evil.example/x')">`,
      ]) {
        assert.throws(() => checkNoExternalLoads(page, html), /event handler/, `${page.route} ${html}`);
      }
    }
  });

  test("passes a script that is a src naming this origin's own file and nothing else, and attributes that only mention a handler", () => {
    const html = `<script src="/overview.js" defer></script><SCRIPT TYPE=module SRC=/sign-post.js></SCRIPT >
<details open><summary>a</summary></details><div data-onload="x" aria-label="on"></div>`;
    assert.equal(checkNoExternalLoads(human, html), 2, "the two scripts");
  });
});

describe("the addresses the server answers", () => {
  test("keep every content file off an invite link's address, and off every one under it", () => {
    for (const route of ["/join", "/join/runner-images", `/join/runner-images/schellingaf_inv_${"0".repeat(32)}`]) {
      assert.match(reservation(route) ?? "", /^\/join and every address under it/, route);
    }
    assert.equal(reservation("/joining"), null, "a page beside it is not under it");
  });

  test("never name an invite link where llms.txt and the pages sitemap are written from", () => {
    // Every entry here is written into llms.txt, and the listed ones into the pages sitemap.
    assert.deepEqual(DYNAMIC_ROUTES.filter((r: { route: string }) => r.route === "/join" || r.route.startsWith("/join/")), []);
  });
});
