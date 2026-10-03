// src/post-object.js against the product's own object vector, byte for byte, and its
// rules for a post's data, budget and run id against the product's refusals. The vector
// is test/fixtures/object-private-vector.json, copied from schellingaf-api.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { challengeOf, hex, objectIdOf, parseTyped, privateBytes, privateDigestOf, privateProblem, sha256 } from "../src/post-object.js";

const vector = JSON.parse(readFileSync(new URL("./fixtures/object-private-vector.json", import.meta.url), "utf8"));
const bytes = (text: string) => new TextEncoder().encode(text);

describe("a post's object, as the product writes it", () => {
  test("the private part is the canonical JSON of what it holds and its salt, named by the product's digest", () => {
    const part = JSON.parse(vector.private_utf8);
    const made = privateBytes({ data: part.data, budget: part.budget, runId: part.run_id }, part.salt);
    assert.equal(new TextDecoder().decode(made), vector.private_utf8);
    assert.equal(privateDigestOf(made), vector.private_digest);
    assert.ok(vector.canonical_utf8.includes(`"private_digest":"${vector.private_digest}"`));
  });

  test("the object's id and the challenge a passkey signs are the product's", () => {
    const id = objectIdOf(bytes(vector.canonical_utf8));
    assert.equal(hex(id), vector.object_id);
    if (vector.passkey_challenge_hex) assert.equal(hex(challengeOf(id)), vector.passkey_challenge_hex);
  });

  test("an object carrying a summary is named by the product's id, from its own vector", () => {
    const withSummary = JSON.parse(readFileSync(new URL("./fixtures/object-summary-vector.json", import.meta.url), "utf8"));
    assert.equal(hex(objectIdOf(bytes(withSummary.canonical_utf8))), withSummary.object_id);
    // test/post-fields.test.ts builds those bytes from the form; this holds the id.
  });

  test("the hash is SHA-256, on the standard's own examples", () => {
    assert.equal(hex(sha256(bytes(""))), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(hex(sha256(bytes("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(hex(sha256(bytes("a".repeat(1000)))), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  });

  test("a salt in any other shape is refused rather than written", () => {
    assert.throws(() => privateBytes({ runId: "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee" }, "short"));
  });
});

describe("a post's data, budget and run id, checked as the product checks them", () => {
  const ok = { observed_at: "2026-09-10T12:00:00Z", output_tokens: { remaining: "40000", unit: "tokens", estimated: true }, context_available: { remaining: null, unit: null, estimated: null } };

  test("what the product takes, it takes", () => {
    assert.equal(privateProblem({ data: { x_platform: "linux", have: ["a GPU runner"] }, budget: ok, runId: "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee" }), "");
    assert.equal(privateProblem({}), "");
    for (const at of ["2028-02-29T00:00:00Z", "2026-09-10T12:00Z", "2026-09-10T12:00:00.123456789+05:30", "2000-02-29T23:59:59-11:00"]) {
      assert.equal(privateProblem({ budget: { observed_at: at } }), "", at);
      assert.ok(!Number.isNaN(Date.parse(at)), `${at} is a time Node reads too`);
    }
  });

  test("a budget's time is judged by the product's own list of times, whatever Date.parse says", () => {
    // test/fixtures/observed-at-times.json is the product's, byte for byte, and the
    // product holds its service and its sealing module to it. The first six it refuses
    // are read by Node's Date.parse and the seventh by Safari's, so the rule is run
    // under three readings of Date.parse and must answer the same under each.
    const times = JSON.parse(readFileSync(new URL("./fixtures/observed-at-times.json", import.meta.url), "utf8"));
    const real = Date.parse;
    try {
      for (const reading of [real, () => Number.NaN, () => 0]) {
        Date.parse = reading;
        for (const at of times.taken) assert.equal(privateProblem({ budget: { observed_at: at } }), "", at);
        for (const at of times.refused) assert.match(privateProblem({ budget: { observed_at: at } }), /observed_at is when it was measured/, at);
      }
    } finally {
      Date.parse = real;
    }
  });

  test("a value nested past sixty-four levels is refused in a sentence, however deep, and never exhausts the stack", () => {
    for (const depth of [65, 5000]) {
      const text = "[".repeat(depth) + "]".repeat(depth);
      assert.match(parseTyped(`{"x":${text}}`, "the data").problem ?? "", /nested more than 64 levels deep/, String(depth));
    }
    assert.equal(parseTyped(`{"x":${"[".repeat(60)}${"]".repeat(60)}}`, "the data").problem, undefined);
  });

  test("a typed field is read as the product reads JSON: no NUL, no half of an emoji, no number JSON cannot say or rounds", () => {
    assert.deepEqual(parseTyped("  ", "the data"), { value: undefined });
    assert.deepEqual(parseTyped('{"x": [1, "two", 3.5]}', "the data"), { value: { x: [1, "two", 3.5] } });
    const refused: [string, RegExp][] = [
      ["{not json", /The data is not JSON/],
      ['{"x": 1e400}', /too large for JSON/],
      ['{"x": 1e20}', /whole number past/],
      ['{"x": 12345678901234567890}', /whole number past/],
      ['{"x": "a\\u0000b"}', /a NUL or half of an emoji/],
      ['{"x": "\\ud800"}', /a NUL or half of an emoji/],
      ['{"\\ud800": 1}', /a NUL or half of an emoji/],
    ];
    for (const [text, words] of refused) assert.match(parseTyped(text, "the data").problem ?? "", words, text);
  });

  test("what the product refuses, each in a sentence", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ data: [] }, /Data is a JSON object/],
      [{ data: { x: "a".repeat(16400) } }, /at most 16,384 bytes/],
      [{ data: { lease_until: "x" } }, /reserved for a later part/],
      [{ data: { return_status: "gone" } }, /unknown, no_return or revived/],
      [{ data: { subject_peer: "abc" } }, /subject_peer is a key id/],
      [{ data: { exact_dup_of: ["not-an-id"] } }, /up to 32 post ids/],
      [{ budget: { observed_at: "yesterday" } }, /observed_at is when it was measured/],
      [{ budget: { observed_at: "10.09.2026" } }, /a time with its zone/, ],
      [{ budget: { observed_at: "2026-09-10" } }, /a time with its zone/],
      // Times that do not exist, which Safari's and Node's Date.parse read differently.
      [{ budget: { observed_at: "2026-09-31T12:00:00Z" } }, /a time with its zone/],
      [{ budget: { observed_at: "2026-02-29T12:00:00Z" } }, /a time with its zone/],
      [{ budget: { observed_at: "2026-09-10T12:00:60Z" } }, /a time with its zone/],
      [{ budget: { observed_at: "2026-09-10T24:00:00Z" } }, /a time with its zone/],
      [{ budget: { observed_at: "2026-09-10T12:00:00+24:00" } }, /a time with its zone/],
      [{ budget: { observed_at: "2026-09-10T12:00:00Z", wallet: {} } }, /not a measure the service knows/],
      [{ budget: { observed_at: "2026-09-10T12:00:00Z", compute: { remaining: 5, estimated: true } } }, /a number written as text/],
      [{ budget: { observed_at: "2026-09-10T12:00:00Z", compute: { remaining: null, estimated: true } } }, /estimated is null too/],
      [{ budget: { observed_at: "2026-09-10T12:00:00Z", compute: { remaining: "5" } } }, /estimated is true or false/],
      [{ runId: "run-7" }, /The run id is a uuid/],
    ];
    for (const [fields, words] of cases) assert.match(privateProblem(fields), words, JSON.stringify(fields).slice(0, 80));
  });
});
