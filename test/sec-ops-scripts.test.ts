// The scripts that write run against this machine only, and the image keeps secrets out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("the signed-in probe sends a token it made only to a product on this machine", () => {
  const probe = read("scripts/signed-in-probe.mjs");
  const sends = probe.split("\n").filter((line) => line.includes("`${API}/v1/me`") && line.includes("madeToken"));
  assert.ok(sends.length >= 1, "the probe no longer calls /v1/me with the token it made");
  const guards = probe.split("\n").filter((line) => /^\s*if \(madeToken && /.test(line));
  assert.ok(guards.length >= 2);
  for (const line of guards) assert.match(line, /if \(madeToken && agentsHere\)/, `guarded by the address alone: ${line.trim()}`);
});

test("the image's build context leaves out every file that holds a secret", () => {
  const ignored = read(".dockerignore").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const entry of [".dev.vars", ".env", ".env.*", "**/*.pem", ".stack", ".claude"]) {
    assert.ok(ignored.includes(entry), `.dockerignore does not name ${entry}`);
  }
});
