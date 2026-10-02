// src/sealed.js is the product's content/sealed.mjs, byte for byte: the one module
// that seals and opens, which the bridge carries too and the product serves at
// GET /sealed.mjs. Held here two ways, as src/document.ts is: to the product's own
// file when its repository is beside this one, and always to the vectors the
// product's independent implementation wrote, copied into test/fixtures.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as sealed from "../src/sealed.js";
import { productFile } from "./lib/product.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("the sealing module is the product's", () => {
  for (const [site, product] of [
    ["src/sealed.js", "content/sealed.mjs"],
    ["test/fixtures/sealed-vectors.json", "test/fixtures/sealed-vectors.json"],
    // The times a budget's observed_at takes, which hold the product, this module and
    // src/post-object.js to one rule: test/post-object.test.ts reads this copy.
    ["test/fixtures/observed-at-times.json", "test/fixtures/observed-at-times.json"],
  ] as const) {
    test(`${site} is the product's ${product}, byte for byte`, (t) => {
      const theirs = productFile(product);
      if (!theirs) {
        t.skip(`the product's repository is not beside this one, so ${site} has nothing to be compared with`);
        return;
      }
      assert.ok(readFileSync(path.join(ROOT, site)).equals(readFileSync(theirs)),
        `${site} is no longer ${theirs}: copy the product's file again, byte for byte`);
    });
  }

  test("it reproduces every value in the product's vectors", async () => {
    const v = JSON.parse(readFileSync(path.join(ROOT, "test", "fixtures", "sealed-vectors.json"), "utf8"));
    for (const k of v.encryption_keys) {
      const pair = await sealed.encryptionKey(bytes(k.secret), bytes(k.peer_id));
      assert.equal(hex(pair.sk), k.sk);
      assert.equal(hex(pair.pk), k.pk);
      assert.equal(hex(sealed.statementBytes(bytes(k.peer_id), pair.pk)), k.statement);
      assert.equal(await sealed.fingerprint(pair.pk), k.fingerprint);
    }
    for (const c of v.containers) {
      const container = c.pair ? sealed.pairContainer(bytes(c.pair[0]), bytes(c.pair[1])) : sealed.spaceContainer(c.space_id);
      assert.equal(hex(container), c.container);
      for (const g of c.generations) {
        assert.equal(hex(await sealed.commitment(container, g.g, bytes(g.secret))), g.commitment);
        if (g.back) assert.equal(hex(await sealed.sealBack(container, g.g, bytes(g.secret), bytes(c.generations[g.g - 2].secret))), g.back);
      }
      for (const l of c.locks) {
        const lock = await sealed.sealLock({
          container, g: l.g, recipient: bytes(l.recipient), sender: bytes(l.sender), commitment: bytes(l.commitment),
          secret: bytes(l.secret), pkR: bytes(l.pkR), skS: bytes(l.skS), ikmE: bytes(l.ikmE),
        });
        assert.equal(hex(lock), l.lock);
      }
    }
    for (const item of v.items) {
      assert.equal(hex(await sealed.headerDigest(bytes(item.header))), item.header_digest);
      assert.equal(hex(await sealed.sealItem(bytes(item.header), bytes(item.secret), bytes(item.content))), item.ciphertext);
    }
  });

  test("a passkey's PRF input is the one the spec names, so a browser and the bridge derive the same key", async () => {
    // Pinned: a PRF input that changed would give every person a different encryption
    // key from the same passkey, and nothing sealed to the old one would open again.
    assert.equal(hex(await sealed.prfInput()), hex(await sealed.sha256(sealed.label("agent-state:passkey-prf:v1"))));
    assert.equal(hex(await sealed.prfInput()).length, 64);
  });
});

// Connect asks a passkey for its PRF secret in the prompt its click opens, and nothing may
// be awaited between the two, so the input is written out in src/sealed-store.js rather than
// hashed there. Written out, it could drift from the rule, and a person connecting would
// make another key than the one they turned sealing on with, for good.
test("the PRF input Connect asks for is the one the module's rule makes", async () => {
  const store = readFileSync(path.join(ROOT, "src", "sealed-store.js"), "utf8");
  const written = /export const PRF_INPUT = new Uint8Array\(\[([^\]]*)\]\)/.exec(store)?.[1] ?? "";
  const bytes = [...written.matchAll(/0x([0-9a-f]{2})/g)].map((m) => parseInt(m[1]!, 16));
  assert.equal(bytes.length, 32);
  assert.deepEqual(new Uint8Array(bytes), await sealed.prfInput());
});
