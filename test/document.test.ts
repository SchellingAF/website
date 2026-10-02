// The grammar an oracle space's document is written in, as this site's copy parses it.
//
// src/document.ts is the product's src/domain/document.ts, copied byte for byte, and
// test/fixtures/document-vectors.json is the product's own vectors, copied the same
// way. The first tests are the product's tests of that file, asked of the copy, so the
// site and the product agree on what every document says. The last two ask whether the
// copies are still copies: a change to the grammar made in the product and not carried
// here would otherwise pass every test on both sides while the two disagree.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, replaceSection, sectionText } from "../src/document.ts";
import { productFile } from "./lib/product.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vectors = JSON.parse(readFileSync(path.join(ROOT, "test", "fixtures", "document-vectors.json"), "utf8"));

describe("the document grammar", () => {
  for (const v of vectors.parse) {
    test(`parses: ${v.name}`, () => {
      const { name: _name, text, ...expected } = v;
      assert.deepEqual(parseDocument(text), expected);
    });
  }
  for (const e of vectors.edits) {
    test(`edits: ${e.name}`, () => {
      assert.equal(replaceSection(e.text, e.section, e.with), e.result);
      assert.equal(sectionText(e.text, e.section), e.section_text);
    });
  }

  test("an address scheme is never an identifier, and never a link at all", () => {
    const parsed = parseDocument("[[javascript:alert(1)]] [[data:text/html,x]] [[vbscript:x]]");
    assert.deepEqual(parsed.references, []);
  });

  test("links for what-links-here are SPACES and posts alone, once each, at most 256", () => {
    const many = Array.from({ length: 300 }, (_, i) => `[[space-${i}]] [[space-${i}]]`).join(" ");
    const parsed = parseDocument(many + " [[https://example.org]] [[git.commit:abc]]");
    assert.equal(parsed.links.length, 256);
    assert.equal(new Set(parsed.links).size, 256);
    assert.ok(parsed.links.every((l) => l.startsWith("space:")));
  });

  // Any key may propose a document, and a page on this site parses one on every read
  // it does not have cached, signed-in pages on every read. The product holds its copy
  // to the same inputs, and to the parser it replaced.
  test("reads a document built to be slow in time proportional to its length", () => {
    const k64 = (unit: string) => unit.repeat(Math.ceil(65536 / unit.length)).slice(0, 65536);
    const hostile = {
      "a thousand headings with one name": k64("# a\n"),
      "a line of link openings": k64("[["),
      "openings with a close far away": k64("[[" + "[".repeat(1998) + "]]"),
      "openings each with a bar": k64("[[x|"),
      "a target padded past its limit": k64("[[" + " ".repeat(3000) + "x]]"),
      "backticks never closed on a line": k64("`[[a|"),
      "list items of openings": k64("- [[[[[[\n"),
      "a heading of spaces that never ends": "#" + " ".repeat(65_000) + "\u2028",
      "a list item of spaces that never ends": "-" + "\t".repeat(65_000) + "\u2029",
    };
    // The time is this process's own processor time, which other work on the machine
    // does not add to, and the least of three reads: a parse costs the same each time,
    // and the first also pays for compiling the parser.
    for (const [name, text] of Object.entries(hostile)) {
      let took = Infinity;
      for (let read = 0; read < 3; read++) {
        const began = process.cpuUsage();
        parseDocument(text);
        const spent = process.cpuUsage(began);
        took = Math.min(took, (spent.user + spent.system) / 1000);
      }
      assert.ok(took < 250, `${name}: ${took.toFixed(0)} ms`);
    }
  });
});

describe("the copies are still the product's files", () => {
  const pairs: [site: string, product: string][] = [
    ["src/document.ts", "src/domain/document.ts"],
    ["test/fixtures/document-vectors.json", "test/fixtures/document-vectors.json"],
  ];
  for (const [site, product] of pairs) {
    test(`${site} is the product's ${product}, byte for byte`, (t) => {
      const theirs = productFile(product);
      if (!theirs) {
        t.skip(`the product's repository is not beside this one, so ${site} has nothing to be compared with`);
        return;
      }
      const same = readFileSync(path.join(ROOT, site)).equals(readFileSync(theirs));
      assert.ok(same, `${site} is no longer ${theirs}: copy the product's file again, byte for byte`);
    });
  }
});
