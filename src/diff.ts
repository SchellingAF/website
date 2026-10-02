// Two versions of a document, compared line by line.
//
// Myers' difference algorithm ("An O(ND) Difference Algorithm and Its Variations",
// 1986): the shortest list of lines to delete and insert that turns one text into the
// other, found in time proportional to the texts' length times how much they differ.
// Written out here rather than taken from a library, because the site has no
// dependencies.
//
// BOUNDED, because any KEY may propose a version, and a comparison is drawn on a page
// anybody can ask for. Two texts of 5,000 lines that share nothing would cost a hundred
// million steps and a trace of a hundred million numbers to walk back through. Past
// MAX_LINES, or past `maxEdits` lines added and removed, the answer is null, and the
// page says the versions are too different to compare line by line rather than the
// server spending seconds and memory finding out how different. At the default bound
// the trace is at most about four million numbers, sixteen megabytes, for a moment.

import { lines } from "./document.ts";
import { esc, fence } from "./render.ts";

/** One line of a comparison: in both versions, added by the second, or deleted by it. */
export type DiffOp = { t: "same" | "add" | "del"; line: string };

/** The most lines either version may have and still be compared. */
export const MAX_LINES = 5000;

/** The most lines two versions may differ by, added and deleted, and still be compared. */
export const MAX_EDITS = 2000;

/**
 * The lines of `a` and `b`, in order, each marked same, added or deleted, with as few
 * added and deleted as possible. Line endings are made one kind first, so a version
 * saved with \r\n and one saved with \n are the same text. Null when either has more than
 * MAX_LINES lines, or when they differ by more than `maxEdits` lines added and deleted.
 */
export function lineDiff(a: string, b: string, maxEdits = MAX_EDITS): DiffOp[] | null {
  const x = lines(a);
  const y = lines(b);
  if (x.length > MAX_LINES || y.length > MAX_LINES) return null;

  // What both versions start and end with is the same, and costs nothing to say so: most
  // proposals change one section, so this is usually most of the document, and only the
  // middle is left for the search.
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }

  const middle = shortestEdit(x.slice(start, endX), y.slice(start, endY), Math.max(0, Math.floor(maxEdits)));
  if (!middle) return null;
  const same = (line: string): DiffOp => ({ t: "same", line });
  return [...x.slice(0, start).map(same), ...middle, ...x.slice(endX).map(same)];
}

/**
 * Myers' greedy search, with its trace kept so the path can be walked back.
 *
 * v[k] is how far along `a` the furthest path on diagonal k (x - y = k) has reached with
 * d edits. Each round tries one more edit, and ends when a path reaches the end of both.
 * Before each round the part of v it will read, diagonals -d-1 to d+1, is kept, so the
 * trace grows with the square of the edits, not with the texts' length.
 */
function shortestEdit(a: string[], b: string[], max: number): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  // Every line one has and the other lacks is an edit, so a difference in length alone
  // can already be past the bound.
  if (Math.abs(n - m) > max) return null;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      // Down from diagonal k+1 (a line of b inserted), or right from k-1 (a line of a
      // deleted), whichever has come further.
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return walkBack(a, b, trace);
    }
  }
  return null;
}

/** The path the search found, from its end back to its start, turned into lines. */
function walkBack(a: string[], b: string[], trace: Int32Array[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const kept = trace[d]!;
    const at = (k: number): number => kept[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: "same", line: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) ops.push(x === prevX ? { t: "add", line: b[prevY]! } : { t: "del", line: a[prevX]! });
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

const PREFIX: Record<DiffOp["t"], string> = { same: "  ", add: "+ ", del: "- " };

/** A comparison as a page shows it: one line each, marked the way a diff is read, and
 *  every line escaped, because every line is somebody's proposal. */
export function diffHtml(ops: DiffOp[]): string {
  const rows = ops.map((op) => {
    const text = esc(PREFIX[op.t] + op.line);
    return op.t === "add" ? `<ins>${text}</ins>` : op.t === "del" ? `<del>${text}</del>` : `<span>${text}</span>`;
  });
  return `<pre class="diff">${rows.join("\n")}</pre>`;
}

/** A comparison for an agent: the same lines inside one fence no line can close. */
export function diffMarkdown(ops: DiffOp[]): string {
  return fence(ops.map((op) => PREFIX[op.t] + op.line).join("\n"));
}
