// RFC 8785 canonical JSON, as src/jcs.js writes it for a passkey to sign in the
// browser and for this site's server to check a post with.
//
// The vectors are the product's, copied into scripts/lib/jcs-vectors.json; its own
// tests hold src/domain/jcs.ts to the same file, and the first two vectors are
// RFC 8785's own.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalBytes, canonicalize, sameValue } from "../src/jcs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vectors = JSON.parse(readFileSync(path.join(ROOT, "scripts", "lib", "jcs-vectors.json"), "utf8"));

describe("RFC 8785 canonical JSON", () => {
  test("every canonical vector writes exactly its output, as text and as UTF-8 bytes", () => {
    assert.ok(vectors.canonical.length >= 6);
    for (const v of vectors.canonical) {
      assert.equal(canonicalize(JSON.parse(v.input)), v.output, v.name);
      assert.deepEqual(Buffer.from(canonicalBytes(JSON.parse(v.input))), Buffer.from(v.output, "utf8"), v.name);
      assert.equal(canonicalize(JSON.parse(v.output)), v.output, `${v.name}, written again`);
    }
  });

  test("no text that is JSON but not canonical comes back unchanged", () => {
    // Such a text either does not parse here, as a leading
    // byte order mark does not, or canonicalises to something else.
    assert.ok(vectors.not_canonical.length >= 10);
    for (const v of vectors.not_canonical) {
      let same = false;
      try {
        same = canonicalize(JSON.parse(v.text)) === v.text;
      } catch {
        same = false;
      }
      assert.equal(same, false, v.name);
    }
  });

  test("a value JSON cannot say is an error, never a repair", () => {
    const lone = String.fromCharCode(0xd800);
    for (const bad of [lone, `a${lone}`, String.fromCharCode(0xdc00), { [lone]: 1 }, [lone], Number.NaN, Infinity, -Infinity,
      undefined, () => 1, new Date(0), 1n, Symbol("s"), new Map(), [undefined], { a: undefined }]) {
      assert.throws(() => canonicalize(bad), TypeError, String(typeof bad));
    }
    assert.equal(canonicalize("\u{1F600}"), '"\u{1F600}"', "a surrogate pair is text");
    assert.equal(canonicalize(Object.create(null)), "{}", "an object with no prototype is a plain object");
  });

  test("two values are the same when they write the same, whatever order their members came in", () => {
    assert.equal(sameValue({ b: 1, a: [1, { d: 2, c: 3 }] }, { a: [1, { c: 3, d: 2 }], b: 1 }), true);
    assert.equal(sameValue({ a: 1 }, { a: 1.0 }), true);
    assert.equal(sameValue({ a: [1, 2] }, { a: [2, 1] }), false);
    assert.equal(sameValue(null, {}), false);
    assert.equal(sameValue("", null), false);
  });
});
