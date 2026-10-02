// Comparing two versions of a document, line by line: the shortest comparison, bounded,
// and every line of it escaped.
//
// The shortest is proved against the textbook answer rather than trusted: for hundreds
// of small random pairs, the lines Myers' search marks added and deleted are exactly as
// many as a longest-common-subsequence table says the fewest can be, and the marked
// lines rebuild both versions.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { diffHtml, diffMarkdown, lineDiff, MAX_LINES } from "../src/diff.ts";
import type { DiffOp } from "../src/diff.ts";
import { lines } from "../src/document.ts";
import { tags } from "./lib/documents.ts";

/** The two versions a comparison was made from, read back out of it. */
const before = (ops: DiffOp[]) => ops.filter((o) => o.t !== "add").map((o) => o.line);
const after = (ops: DiffOp[]) => ops.filter((o) => o.t !== "del").map((o) => o.line);
const edits = (ops: DiffOp[]) => ops.filter((o) => o.t !== "same").length;
const marks = (ops: DiffOp[]) => ops.map((o) => `${o.t} ${o.line}`);

/** The fewest lines added and deleted, from the longest common subsequence. */
function fewestEdits(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(above, row[j - 1]!);
      diagonal = above;
    }
  }
  return a.length + b.length - 2 * row[b.length]!;
}

describe("comparing two versions", () => {
  test("identical texts are the same line for line", () => {
    const ops = lineDiff("a\nb\nc", "a\nb\nc")!;
    assert.deepEqual(marks(ops), ["same a", "same b", "same c"]);
  });

  test("an insertion, a deletion and a replacement", () => {
    assert.deepEqual(marks(lineDiff("a\nc", "a\nb\nc")!), ["same a", "add b", "same c"]);
    assert.deepEqual(marks(lineDiff("a\nb\nc", "a\nc")!), ["same a", "del b", "same c"]);
    assert.deepEqual(marks(lineDiff("a\nb\nc", "a\nx\nc")!), ["same a", "del b", "add x", "same c"]);
    assert.deepEqual(marks(lineDiff("", "a")!), ["del ", "add a"]);
  });

  test("a version saved with \\r\\n is the same text as one saved with \\n", () => {
    const ops = lineDiff("a\r\nb\r\n", "a\nb\n")!;
    assert.ok(ops.every((o) => o.t === "same"));
    assert.deepEqual(before(ops), ["a", "b", ""]);
  });

  test("the comparison is always the shortest, and rebuilds both versions", () => {
    // A small alphabet, so lines repeat and there are many ways to line them up.
    // Park and Miller's generator, so every run asks the same five hundred questions.
    let seed = 42;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const text = () => Array.from({ length: Math.floor(random() * 14) }, () => "abcd"[Math.floor(random() * 4)]).join("\n");
    for (let i = 0; i < 500; i++) {
      const a = text();
      const b = text();
      const ops = lineDiff(a, b)!;
      assert.deepEqual(before(ops), lines(a), `${JSON.stringify(a)} → ${JSON.stringify(b)}`);
      assert.deepEqual(after(ops), lines(b), `${JSON.stringify(a)} → ${JSON.stringify(b)}`);
      assert.equal(edits(ops), fewestEdits(lines(a), lines(b)), `${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    }
  });

  test("past the bound on edits the answer is null, and at the bound it is not", () => {
    const a = Array.from({ length: 10 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 10 }, (_, i) => `b${i}`).join("\n");
    assert.equal(lineDiff(a, b, 19), null);
    assert.equal(edits(lineDiff(a, b, 20)!), 20);
    assert.equal(lineDiff("x", "y", 0), null);
    assert.equal(edits(lineDiff("x", "x", 0)!), 0);
    // A difference in length alone can be past it.
    assert.equal(lineDiff("", "a\nb\nc\nd", 2), null);
  });

  test("past the bound on length the answer is null, however alike the texts are", () => {
    const long = Array.from({ length: MAX_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
    assert.equal(lineDiff(long, long), null);
    assert.equal(lineDiff("short", long), null);
    const most = Array.from({ length: MAX_LINES }, (_, i) => `line ${i}`).join("\n");
    assert.equal(lineDiff(most, most)!.length, MAX_LINES);
  });

  test("the largest comparison the bound allows is found, and quickly", () => {
    const a = Array.from({ length: MAX_LINES }, (_, i) => `line ${i}`);
    // Every fifth line replaced: a thousand deletions and a thousand insertions.
    const b = a.map((line, i) => (i % 5 === 0 ? `changed ${i}` : line));
    const started = performance.now();
    const ops = lineDiff(a.join("\n"), b.join("\n"))!;
    assert.ok(ops, "two thousand edits is within the bound");
    assert.equal(edits(ops), 2000);
    assert.deepEqual(after(ops), b);
    assert.ok(performance.now() - started < 5000, "well under the time a page can wait");
  });
});

describe("a comparison on a page", () => {
  const ops = lineDiff("keep\n<script>alert(1)</script>\nSchelling+>", "keep\n\"><img src=x onerror=alert(2)>\nSchelling+>\n````")!;

  test("HTML: every line escaped, marked, and in the site's own tags only", () => {
    const html = diffHtml(ops);
    assert.ok(html.startsWith('<pre class="diff">') && html.endsWith("</pre>"));
    assert.deepEqual([...new Set(tags(html).map((t) => t.name))].sort(), ["del", "ins", "pre", "span"]);
    for (const tag of tags(html)) assert.ok(tag.attributes.every(([name]) => name === "class"), tag.name);
    assert.doesNotMatch(html, /<script|<img/i);
    assert.ok(html.includes("<span>  keep</span>"));
    assert.ok(html.includes("<del>- &lt;script&gt;alert(1)&lt;/script&gt;</del>"));
    assert.ok(html.includes("<ins>+ &quot;&gt;&lt;img src=x onerror=alert(2)&gt;</ins>"));
    assert.ok(html.includes("<span>  Schelling+&gt;</span>"));
    assert.ok(!html.includes("Schelling+>"));
  });

  test("markdown: the same lines inside one fence no line can close", () => {
    const md = diffMarkdown(ops).split("\n");
    assert.equal(md[0], "`````");
    assert.equal(md[md.length - 1], "`````");
    assert.deepEqual(md.slice(1, -1), ["  keep", "- <script>alert(1)</script>", '+ "><img src=x onerror=alert(2)>', "  Schelling+>", "+ ````"]);
  });
});
