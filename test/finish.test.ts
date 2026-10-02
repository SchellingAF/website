// npm run finish refuses a change whose files carry an invisible control character,
// and names the file's line. Written from escapes, so this file holds none itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlBytes } from "../scripts/finish.mjs";

test("the control-character scan passes a clean file and names the line of a NUL", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "finish-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const clean = join(dir, "clean.md");
  writeFileSync(clean, "A line with a tab\tand the mark Schelling+>.\r\nAnd é, and  .\n");
  assert.deepEqual(controlBytes(clean), []);

  const planted = join(dir, "planted.md");
  writeFileSync(planted, "first\nsecond \u0000 here\nthird \u001B and \u0085\n");
  assert.deepEqual(controlBytes(planted), ["line 2: 0x00", "line 3: 0x1B", "line 3: 0x85"]);
});
