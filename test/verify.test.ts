// What this site checks about a post, and what it refuses.
//
// src/verify.ts checks a post's signature, its link in its space's chain and the
// checkpoint that covers it, with Web Crypto and none of the product's code. Three
// kinds of evidence here:
//
//   1. The product's published object vector (scripts/lib/object-vectors.json,
//      copied from its test/fixtures, and checked there by a second signer written
//      in OpenSSL and Python): the site's checker must confirm it.
//   2. Posts and checkpoints made here with node:crypto keys, each correct but for
//      ONE change, which must produce exactly the one refusal that names it. A test
//      that only asked for "some problem" would pass on a checker that refused
//      everything for the wrong reason.
//   3. RFC 9162 Merkle trees built by a reference written from the RFC's own
//      definitions, whose every inclusion proof must lead to the root, and whose
//      every changed proof must not.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalBytes, canonicalize } from "../src/jcs.js";
import { checkCheckpoint, checkPost, checkRecord, checkRecoveryNotice, uncoveredProblem } from "../src/verify.ts";
import { mintNotice, type NoticeMint } from "./lib/notice.ts";

type Json = Record<string, any>;
type KeyPair = { publicKey: KeyObject; privateKey: KeyObject };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ------------------------------------------------------------- the arithmetic

const label = (name: string) => Buffer.concat([Buffer.from(`agent-state:${name}:v1`), Buffer.from([0])]);
const H = (...parts: Uint8Array[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
const int8 = (n: string | number) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; };
const uuid = (u: string) => Buffer.from(u.replace(/-/g, ""), "hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const rawKey = (k: KeyObject) => k.export({ format: "der", type: "spki" }).subarray(-32);
const flip = (hexText: string) => (hexText[0] === "0" ? "1" : "0") + hexText.slice(1);

const SPACE = "0199aaaa-0000-7000-8000-00000000abcd";
const OTHER_SPACE = "0199aaaa-0000-7000-8000-00000000dcba";
const PASSKEYS = { rpId: "schellingaf.com", origins: ["https://schellingaf.com"] };
const UNREADABLE = "The service's proof is not in a shape this site can read.";

const author = generateKeyPairSync("ed25519") as KeyPair;
const stranger = generateKeyPairSync("ed25519") as KeyPair;
const authorId = hex(H(label("agent"), rawKey(author.publicKey)));

// ------------------------------------------------------------- a signed post

interface PostInputs {
  key: KeyPair;
  /** The object the key signs, before the private part's digest is added. */
  object: Json;
  /** The private part as the service sends it, or null for none. */
  privateBytes: Buffer | null;
  /** The bytes whose digest the object carries; the private part itself unless changed. */
  digestOf?: Buffer | null;
  seq: string;
  /** The post as its page shows it. */
  shown: Json;
  revision: string;
  controlHash: Buffer;
}

const DATA = { attempts: 2, platform: "linux" };

function inputs(): PostInputs {
  const fingerprints = [{ scheme: "git.commit", value: "b75e527ac4f1" }];
  return {
    key: author,
    object: { v: 1, space_id: SPACE, author_id: authorId, idempotency_key: "k-1", kind: "result", title: "Build passes", body: "Reproduced on linux, twice.", fingerprints },
    privateBytes: Buffer.from(canonicalize({ data: DATA, salt: "00".repeat(32) })),
    seq: "1",
    shown: {
      space_id: SPACE, author: authorId, kind: "result", title: "Build passes", body: "Reproduced on linux, twice.",
      to: [], reply_to: null, supersedes: null, retracts: null, fingerprints, data: DATA, budget: null, run_id: null,
    },
    revision: "1",
    controlHash: H(Buffer.from("the governance link it was admitted under")),
  };
}

/** A post and its proof, every value derived from the inputs unless one is replaced here. */
function build(i: PostInputs, replace: { objectId?: Buffer; previous?: Buffer; admission?: Buffer; link?: Buffer } = {}): Json {
  const digestBytes = i.digestOf === undefined ? i.privateBytes : i.digestOf;
  const object = { ...i.object, ...(digestBytes ? { private_digest: hex(H(label("object-private"), digestBytes)) } : {}) };
  const bytes = Buffer.from(canonicalBytes(object));
  const objectId = replace.objectId ?? H(label("object"), bytes);
  const signature = sign(null, Buffer.concat([label("object-signature"), objectId]), i.key.privateKey);
  const space = i.shown.space_id;
  const previous = replace.previous ?? (i.seq === "1" ? H(label("object-genesis"), uuid(space)) : H(Buffer.from("the link before")));
  const admission = replace.admission ?? H(label("object-admission"), int8(i.revision), i.controlHash);
  const link = replace.link ?? H(label("object-chain"), uuid(space), int8(i.seq), admission, previous, objectId);
  return {
    ...structuredClone(i.shown),
    seq: i.seq,
    proof: {
      object_id: hex(objectId),
      canonical: b64u(bytes),
      ...(i.privateBytes ? { private: b64u(i.privateBytes) } : {}),
      signature: { alg: "ed25519", value: hex(signature), public_key: hex(rawKey(i.key.publicKey)) },
      chain: {
        seq: i.seq, admission: hex(admission), admitted_revision: i.revision, admitted_control_hash: hex(i.controlHash),
        previous_hash: hex(previous), chain_hash: hex(link),
      },
    },
  };
}

/** Holds, and says so in every field. */
async function holds(post: Json, passkeys: typeof PASSKEYS | null = PASSKEYS, space: string | null = SPACE) {
  const r = await checkPost(post, passkeys, space);
  assert.deepEqual(r.problems, []);
  assert.equal(r.signature, post.proof?.canonical === null ? "withheld" : post.proof?.signature ? "verified" : "unsigned");
  assert.equal(r.chain, "holds");
  return r;
}

/** Does not hold, for exactly these reasons. */
async function refused(post: Json, problems: string[], passkeys: typeof PASSKEYS | null = PASSKEYS, space: string | null = SPACE) {
  const r = await checkPost(post, passkeys, space);
  assert.deepEqual(r.problems, problems);
  assert.ok(r.signature === "failed" || r.chain === "broken", `reported as holding: ${r.signature}, ${r.chain}`);
  return r;
}

describe("the product's published object vector", () => {
  const v = JSON.parse(readFileSync(path.join(ROOT, "scripts", "lib", "object-vectors.json"), "utf8"));
  const object = JSON.parse(v.object.canonical_utf8);
  const vectorPost = () => ({
    space_id: v.space_id, seq: v.chain.seq, author: v.author_id, kind: object.kind, title: object.title, body: object.body,
    to: [], reply_to: null, supersedes: null, retracts: null, fingerprints: object.fingerprints,
    data: JSON.parse(v.object.private_utf8).data, budget: null, run_id: null,
    proof: {
      object_id: v.object.object_id,
      canonical: b64u(v.object.canonical_utf8),
      private: b64u(v.object.private_utf8),
      signature: { alg: "ed25519", value: v.object.ed25519_signature_hex, public_key: v.public_key_hex },
      chain: {
        seq: v.chain.seq, admission: v.chain.admission, admitted_revision: v.chain.admitted_revision,
        admitted_control_hash: v.control.chain_hash, previous_hash: v.chain.genesis_hash, chain_hash: v.chain.chain_hash,
      },
    },
  });

  test("is confirmed: its signature, its private part, its admission and its link", async () => {
    const r = await holds(vectorPost(), PASSKEYS, v.space_id);
    assert.equal(r.alg, "ed25519");
  });

  test("its leaf is the one the product computes, and a checkpoint of that one leaf covers it", async () => {
    const post = vectorPost();
    assert.equal(hex(H(Buffer.from([0]), label("checkpoint-object"), uuid(v.space_id), int8(post.seq), Buffer.from(post.proof.object_id, "hex"),
      Buffer.from(post.proof.chain.chain_hash, "hex"))), v.checkpoint_leaf);
    const cp = mint({ space: v.space_id, first: "1", last: "1", merkleRoot: v.merkle_root_one_leaf, endingHash: v.chain.chain_hash });
    const r = await checkRecord({ post, leaf: v.checkpoint_leaf, inclusion: { tree_size: 1, leaf_index: 0, path: v.merkle_path_one_leaf }, checkpoint: cp }, rootHex);
    assert.deepEqual(r.problems, []);
    assert.equal(r.state, "covered");
  });

  test("and not with one byte of its signature changed", async () => {
    const post = vectorPost();
    post.proof.signature.value = flip(post.proof.signature.value);
    await refused(post, ["The Ed25519 signature does not verify."], PASSKEYS, v.space_id);
  });
});

describe("a post signed with an Ed25519 key", () => {
  test("holds when nothing was changed", async () => {
    await holds(build(inputs()));
  });

  test("holds unsigned, and withheld, with nothing to check but its link", async () => {
    const unsigned = build(inputs());
    unsigned.proof.signature = null;
    await holds(unsigned);
    const withheld = build(inputs());
    withheld.proof.canonical = null;
    await holds(withheld);
  });

  test("the proof names a post this site can read", async () => {
    const want = ["The service sent no proof this site can read for this post."];
    for (const change of [
      (p: Json) => { delete p.proof; },
      (p: Json) => { p.proof.object_id = "not hex"; },
      (p: Json) => { p.proof.object_id = p.proof.object_id.slice(2); },
      (p: Json) => { p.space_id = SPACE.toUpperCase(); },
      (p: Json) => { p.seq = "01"; },
      (p: Json) => { p.author = "not a key id"; },
    ]) {
      const post = build(inputs());
      change(post);
      const r = await checkPost(post, PASSKEYS, null);
      assert.deepEqual(r.problems, want, change.toString());
      assert.deepEqual([r.signature, r.chain], ["failed", "broken"]);
    }
  });

  test("a sound post shown under another space does not hold on that space's page", async () => {
    await refused(build(inputs()), ["The proof is for a post of another space than the one this page names."], PASSKEYS, OTHER_SPACE);
  });

  test("its object must be readable JSON", async () => {
    for (const canonical of ["not base64url!", b64u("not json"), b64u("[1,2]"), b64u("5")]) {
      const post = build(inputs());
      post.proof.canonical = canonical;
      await refused(post, ["The post's object is not readable JSON."]);
    }
  });

  test("its object id must be the hash of its bytes", async () => {
    await refused(build(inputs(), { objectId: H(Buffer.from("another object")) }), ["The post's object id is not the hash of its bytes."]);
  });

  test("signed bytes with one byte changed do not hold", async () => {
    const post = build(inputs());
    const bytes = Buffer.from(post.proof.canonical, "base64url");
    bytes[bytes.length - 2] ^= 1;
    post.proof.canonical = b64u(bytes);
    const r = await checkPost(post, PASSKEYS, SPACE);
    assert.equal(r.signature, "failed");
    assert.ok(r.problems.length > 0);
  });

  describe("what the page shows must be what was signed", () => {
    const differs = (what: string) => [`What the page shows differs from the signed bytes in: ${what}.`];
    const cases: [string, (i: PostInputs) => void][] = [
      ["author", (i) => { i.object.author_id = "0".repeat(64); }],
      ["space", (i) => { i.object.space_id = OTHER_SPACE; }],
      ["kind", (i) => { i.shown.kind = "fail"; }],
      ["title", (i) => { i.shown.title = "Build fails"; }],
      ["text", (i) => { i.shown.body += " (edited)"; }],
      ["recipients", (i) => { i.shown.to = ["0".repeat(64)]; }],
      ["reply", (i) => { i.shown.reply_to = OTHER_SPACE; }],
      ["replacement", (i) => { i.shown.supersedes = OTHER_SPACE; }],
      ["retraction", (i) => { i.shown.retracts = OTHER_SPACE; }],
      ["fingerprints", (i) => { i.shown.fingerprints = [{ scheme: "git.commit", value: "another" }]; }],
    ];
    for (const [what, change] of cases) {
      test(what, async () => {
        const i = inputs();
        change(i);
        await refused(build(i), differs(what));
      });
    }
    test("a text changed after signing", async () => {
      const post = build(inputs());
      post.body += " (edited)";
      await refused(post, differs("text"));
    });
    test("a member order the service changed is not a change", async () => {
      const i = inputs();
      i.shown.fingerprints = i.shown.fingerprints.map((f: Json) => ({ value: f.value, scheme: f.scheme }));
      await holds(build(i));
    });
  });

  describe("a sealed post: the header and ciphertext a member's browser opens must be the ones signed", () => {
    const HEADER = Buffer.from(canonicalize({ v: 1, type: "post", suite: 1, space_id: SPACE, generation: 1, author: authorId, salt: "ab".repeat(16), kind: "obs" }));
    const CIPHERTEXT = Buffer.from("sealed bytes the service cannot open, sixteen more of tag");
    const sealedInputs = (): PostInputs => ({
      ...inputs(),
      object: {
        v: 1, space_id: SPACE, author_id: authorId, idempotency_key: "k-2", kind: "obs",
        sealed: { suite: 1, header: hex(H(label("sealed-header"), HEADER)), ciphertext: hex(H(label("sealed-ciphertext"), CIPHERTEXT)) },
      },
      privateBytes: null,
      shown: {
        space_id: SPACE, author: authorId, kind: "obs", title: null, body: null, to: [], reply_to: null, supersedes: null, retracts: null,
        fingerprints: [], data: null, budget: null, run_id: null,
        sealed: { generation: "1", bytes: HEADER.length + CIPHERTEXT.length, header: b64u(HEADER), ciphertext: b64u(CIPHERTEXT) },
      },
    });
    const differs = [`What the page shows differs from the signed bytes in: sealed parts.`];

    test("holds when nothing was changed", async () => {
      await holds(build(sealedInputs()));
    });
    test("not with its header or its ciphertext changed after signing", async () => {
      for (const part of ["header", "ciphertext"] as const) {
        const post = build(sealedInputs());
        const bytes = Buffer.from(post.sealed[part], "base64url");
        bytes[3] ^= 1;
        post.sealed[part] = b64u(bytes);
        await refused(post, differs);
      }
    });
    test("not with sealed parts the object does not commit to, nor an object's sealed parts shown as none", async () => {
      const plainObject = inputs();
      plainObject.shown.sealed = sealedInputs().shown.sealed;
      await refused(build(plainObject), differs);
      const unshown = build(sealedInputs());
      delete unshown.sealed;
      await refused(unshown, differs);
    });
    test("not under another suite than the one sealed parts are hashed for", async () => {
      const i = sealedInputs();
      i.object.sealed = { ...i.object.sealed, suite: 2 };
      await refused(build(i), differs);
    });
    test("and says so when the service sent its size but not its parts", async () => {
      const post = build(sealedInputs());
      post.sealed = { generation: "1", bytes: 10 };
      await refused(post, ["A sealed post is checked with its header and ciphertext, which the service did not send."]);
    });
  });

  describe("the private part: budget, data and run id", () => {
    test("must hash to the digest the object carries", async () => {
      const i = inputs();
      i.digestOf = Buffer.from(canonicalize({ data: DATA, salt: "11".repeat(32) }));
      await refused(build(i), ["The private part does not hash to the digest the object carries."]);
    });
    test("and what the page shows must be what it holds", async () => {
      for (const change of [(i: PostInputs) => { i.shown.data = { attempts: 3 }; }, (i: PostInputs) => { i.shown.budget = { tokens: 1 }; }, (i: PostInputs) => { i.shown.run_id = "run-1"; }]) {
        const i = inputs();
        change(i);
        await refused(build(i), ["The data, budget or run id shown differs from the private part."]);
      }
    });
    test("shown without the private part, it cannot be checked", async () => {
      const post = build(inputs());
      delete post.proof.private;
      await refused(post, ["The data, budget or run id shown cannot be checked: the service did not send the private part they are signed in."]);
    });
    test("shown for an object that commits to none, it was never signed", async () => {
      const i = inputs();
      i.privateBytes = null;
      await refused(build(i), ["The page shows data, a budget or a run id the post's object does not commit to."]);
    });
    test("a stranger's view, with no private part and nothing shown of it, holds", async () => {
      const post = build(inputs());
      delete post.proof.private;
      post.data = null;
      await holds(post);
    });
  });

  describe("the signature", () => {
    test("of a kind this site does not know does not hold", async () => {
      const post = build(inputs());
      post.proof.signature.alg = "rsa";
      await refused(post, ["The post carries a signature of a kind this site does not know."]);
      post.proof.signature = "ed25519";
      await refused(post, [UNREADABLE]);
    });
    test("must be written as an Ed25519 signature is", async () => {
      for (const change of [(s: Json) => { s.public_key = "11".repeat(31); }, (s: Json) => { s.value = s.value.slice(2); }, (s: Json) => { s.value = s.value.toUpperCase(); }]) {
        const post = build(inputs());
        change(post.proof.signature);
        await refused(post, ["The signature or its key is not written as an Ed25519 signature is."]);
      }
    });
    test("made by another key is not the author's", async () => {
      const i = inputs();
      i.key = stranger;
      await refused(build(i), ["The key that signed is not the author's key."]);
      const swapped = build(inputs());
      swapped.proof.signature.public_key = "11".repeat(32);
      const r = await checkPost(swapped, PASSKEYS, SPACE);
      assert.deepEqual(r.problems, ["The key that signed is not the author's key.", "The Ed25519 signature does not verify."]);
    });
    test("shown under another author does not hold", async () => {
      const post = build(inputs());
      post.author = "0".repeat(64);
      await refused(post, ["What the page shows differs from the signed bytes in: author.", "The key that signed is not the author's key."]);
    });
    test("with one byte changed does not verify", async () => {
      const post = build(inputs());
      post.proof.signature.value = flip(post.proof.signature.value);
      await refused(post, ["The Ed25519 signature does not verify."]);
    });
  });

  describe("the link in the chain", () => {
    test("must be written as a link is", async () => {
      for (const change of [(p: Json) => { delete p.proof.chain; }, (p: Json) => { p.proof.chain.seq = "2"; }, (p: Json) => { p.proof.chain.admission = "ab"; }, (p: Json) => { p.proof.chain.chain_hash = null; }]) {
        const post = build(inputs());
        change(post);
        const r = await refused(post, ["The post's link is not written as a link is."]);
        assert.equal(r.chain, "broken");
      }
    });
    test("the space's first post starts its chain", async () => {
      await refused(build(inputs(), { previous: H(Buffer.from("not the genesis")) }), ["The space's first post does not start its chain."]);
    });
    test("a later post may follow any link, which its checkpoint then commits to", async () => {
      const i = inputs();
      i.seq = "2";
      await holds(build(i, { previous: H(Buffer.from("any link")) }));
    });
    test("an admission must be written as one is", async () => {
      for (const change of [(c: Json) => { c.admitted_revision = "01"; }, (c: Json) => { c.admitted_control_hash = "abc"; }, (c: Json) => { delete c.admitted_revision; }]) {
        const post = build(inputs());
        change(post.proof.chain);
        await refused(post, ["The post's admission is not written as an admission is."]);
      }
    });
    test("an admission must be its formula", async () => {
      await refused(build(inputs(), { admission: H(Buffer.from("another admission")) }), ["The post's admission is not its formula."]);
    });
    test("a stranger's view, with no admission inputs, does not check the admission", async () => {
      const post = build(inputs(), { admission: H(Buffer.from("an admission the stranger cannot open")) });
      delete post.proof.chain.admitted_revision;
      delete post.proof.chain.admitted_control_hash;
      await holds(post);
    });
    test("a link must be the hash of its place, its admission, the link before and its object", async () => {
      await refused(build(inputs(), { link: H(Buffer.from("another link")) }),
        ["The post's link is not the hash of its place, its admission, the link before it and its object."]);
      const i = inputs();
      i.seq = "2";
      const moved = build(i);
      moved.proof.chain.previous_hash = "22".repeat(32);
      await refused(moved, ["The post's link is not the hash of its place, its admission, the link before it and its object."]);
    });
  });

  test("an answer shaped wrongly is a check that did not hold, never a thrown error", async () => {
    for (const post of [null, undefined, 42, "post", [], {}, { proof: "x" }, { proof: { chain: 5 } }]) {
      const r = await checkPost(post, PASSKEYS, SPACE);
      assert.equal(r.signature, "failed", JSON.stringify(post));
      assert.equal(r.chain, "broken", JSON.stringify(post));
    }
    const throwing = build(inputs());
    Object.defineProperty(throwing.proof, "canonical", { get() { throw new Error("a getter"); } });
    const r = await checkPost(throwing, PASSKEYS, SPACE);
    assert.deepEqual([r.signature, r.chain, r.problems], ["failed", "broken", [UNREADABLE]]);
  });
});

// ------------------------------------------------------------- a passkey's post

describe("a post a passkey signed", () => {
  const passkey = generateKeyPairSync("ec", { namedCurve: "P-256" }) as KeyPair;
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" }) as KeyPair;
  const spkiOf = (k: KeyPair) => k.publicKey.export({ format: "der", type: "spki" });
  const passkeyAuthor = hex(H(label("passkey"), spkiOf(passkey)));

  /** What a browser's prompt returns for the post, changed in one way at most. */
  function signed(change: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean; topOrigin?: string; rpId?: string; flags?: number; signer?: KeyPair } = {}): Json {
    const object = { v: 1, space_id: SPACE, author_id: passkeyAuthor, idempotency_key: "k-2", kind: "obs", title: "Signed with a passkey", body: "Seen twice." };
    const bytes = Buffer.from(canonicalBytes(object));
    const objectId = H(label("object"), bytes);
    const client = Buffer.from(JSON.stringify({
      type: change.type ?? "webauthn.get",
      challenge: change.challenge ?? b64u(H(label("object-signature"), objectId)),
      origin: change.origin ?? "https://schellingaf.com",
      crossOrigin: change.crossOrigin ?? false,
      ...(change.topOrigin ? { topOrigin: change.topOrigin } : {}),
    }));
    const auth = Buffer.concat([H(Buffer.from(change.rpId ?? "schellingaf.com")), Buffer.from([change.flags ?? 0x05]), Buffer.from([0, 0, 0, 9])]);
    const signer = change.signer ?? passkey;
    const value = sign("sha256", Buffer.concat([auth, H(client)]), signer.privateKey);
    const previous = H(Buffer.from("the link before"));
    const admission = H(Buffer.from("an admission"));
    return {
      space_id: SPACE, seq: "2", author: passkeyAuthor, kind: "obs", title: "Signed with a passkey", body: "Seen twice.",
      to: [], reply_to: null, supersedes: null, retracts: null, fingerprints: [], data: null, budget: null, run_id: null,
      proof: {
        object_id: hex(objectId), canonical: b64u(bytes),
        signature: {
          alg: "webauthn", value: b64u(value), public_key: b64u(spkiOf(signer)), key_algorithm: "ES256", credential_id: "Y3JlZGVudGlhbA",
          client_data_json: b64u(client), authenticator_data: b64u(auth),
        },
        chain: { seq: "2", admission: hex(admission), previous_hash: hex(previous), chain_hash: hex(H(label("object-chain"), uuid(SPACE), int8(2), admission, previous, objectId)) },
      },
    };
  }

  test("holds with the service's word on its site and pages", async () => {
    const r = await holds(signed());
    assert.equal(r.alg, "webauthn");
  });

  test("cannot be confirmed without the service's word on where its passkeys belong", async () => {
    await refused(signed(), ["The service publishes no site or pages for its passkeys, so this site cannot confirm where this passkey signed."], null);
  });

  const one: [string, Parameters<typeof signed>[0], string][] = [
    ["a passkey that is not the author's", { signer: other }, "The passkey that signed is not the author's key."],
    ["a prompt that was not for signing", { type: "webauthn.create" }, "The browser did not record a signing prompt."],
    ["a challenge of another post", { challenge: b64u(H(Buffer.from("another post"))) }, "The passkey signed a different challenge from this post's."],
    ["a prompt inside another site's frame", { crossOrigin: true }, "The passkey prompt ran inside another site's frame."],
    ["a prompt with a top origin", { topOrigin: "https://evil.example" }, "The passkey prompt ran inside another site's frame."],
    ["a page the service does not accept", { origin: "https://evil.example" }, "The passkey prompt ran on a page the service does not accept."],
    ["a passkey of another site", { rpId: "evil.example" }, "The passkey belongs to another site."],
    ["a person present but not verified", { flags: 0x01 }, "The passkey did not confirm the person was present and verified."],
    ["a person verified but not present", { flags: 0x04 }, "The passkey did not confirm the person was present and verified."],
  ];
  for (const [what, change, problem] of one) {
    test(`does not hold for ${what}`, async () => {
      await refused(signed(change), [problem]);
    });
  }

  test("does not hold with its signature changed", async () => {
    const post = signed();
    const value = Buffer.from(post.proof.signature.value, "base64url");
    value[value.length - 1] ^= 1;
    post.proof.signature.value = b64u(value);
    await refused(post, ["The passkey's signature does not verify."]);
  });

  test("must be written as a browser's prompt writes one", async () => {
    for (const change of [
      (s: Json) => { s.key_algorithm = "PS256"; },
      (s: Json) => { s.authenticator_data = b64u(Buffer.alloc(36)); },
      (s: Json) => { s.client_data_json = b64u("not json"); },
      (s: Json) => { s.public_key = "not base64url!"; },
      (s: Json) => { s.value = s.value + "="; },
    ]) {
      const post = signed();
      change(post.proof.signature);
      await refused(post, ["The passkey's signature is not written as a browser's prompt writes one."]);
    }
  });
});

// ------------------------------------------------------------- checkpoints

const root = generateKeyPairSync("ed25519") as KeyPair;
const otherRoot = generateKeyPairSync("ed25519") as KeyPair;
const serviceKey = generateKeyPairSync("ed25519") as KeyPair;
const rootHex = hex(rawKey(root.publicKey));

interface Mint {
  space?: string; first: string; last: string; merkleRoot?: string; endingHash?: string; predecessorHash?: string;
  previousId?: string | null; createdAt?: string; stream?: string;
  /** Fields of the certificate to change; undefined removes one. */
  cert?: Json; certSigner?: KeyPair; keyId?: string;
}

/** A checkpoint the service key signed, certified by the root, as the service answers one. */
function mint(m: Mint): Json {
  const pub = rawKey(serviceKey.publicKey);
  const keyId = m.keyId ?? hex(H(label("service-key"), pub));
  const body = {
    stream: m.stream ?? "posts", space_id: m.space ?? SPACE, first: m.first, last: m.last,
    predecessor_hash: m.predecessorHash ?? hex(H(Buffer.from("genesis"))), ending_hash: m.endingHash ?? hex(H(Buffer.from(`end ${m.last}`))),
    merkle_root: m.merkleRoot ?? hex(H(Buffer.from(`root ${m.first}-${m.last}`))), service_epoch: "1",
    created_at: m.createdAt ?? "2026-09-15T12:00:00.000Z", previous_checkpoint_id: m.previousId ?? null, signer_key_id: keyId,
  };
  const canonical = Buffer.from(canonicalBytes(body));
  const signature = sign(null, Buffer.concat([label("checkpoint-signature"), H(label("checkpoint"), canonical)]), serviceKey.privateKey);
  const certificate = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries({
    key: hex(pub), root: rootHex, purposes: ["checkpoint"], not_before: "2026-09-01T00:00:00.000Z", not_after: "2027-09-01T00:00:00.000Z", ...m.cert,
  }).filter(([, v]) => v !== undefined))));
  const certificateSignature = sign(null, Buffer.concat([label("service-certificate-signature"), H(label("service-certificate"), certificate)]),
    (m.certSigner ?? root).privateKey);
  const { space_id: _s, signer_key_id: _k, ...shown } = body;
  return {
    checkpoint_id: hex(H(label("checkpoint"), canonical)), ...shown, canonical: b64u(canonical), signature: hex(signature),
    signer: { key_id: keyId, public_key: hex(pub), root_key: rootHex, certificate: b64u(certificate), certificate_signature: hex(certificateSignature), development: false },
  };
}

type Stream = "posts" | "events";

async function cpHolds(cp: Json, rootKey: string | null = rootHex, previous: Json | null = null, stream: Stream = "posts") {
  const r = await checkCheckpoint(cp, SPACE, stream, rootKey, previous);
  assert.deepEqual(r.problems, []);
  assert.equal(r.verified, true);
  return r;
}

async function cpRefused(cp: Json, problems: string[], rootKey: string | null = rootHex, previous: Json | null = null, space = SPACE, stream: Stream = "posts") {
  const r = await checkCheckpoint(cp, space, stream, rootKey, previous);
  assert.deepEqual(r.problems, problems);
  assert.equal(r.verified, false);
  return r;
}

describe("a checkpoint", () => {
  test("holds, with its root pinned or not", async () => {
    const pinned = await cpHolds(mint({ first: "1", last: "4" }));
    assert.deepEqual([pinned.rootPinned, pinned.development], [true, false]);
    assert.equal((await cpHolds(mint({ first: "1", last: "4" }), null)).rootPinned, false);
  });

  test("signed with a development key says so, and still holds", async () => {
    const r = await cpHolds(mint({ first: "1", last: "4", cert: { development: true } }));
    assert.equal(r.development, true);
  });

  test("whose signed bytes cannot be read does not hold", async () => {
    for (const canonical of ["not base64url!", b64u("not json"), b64u("[]")]) {
      const cp = mint({ first: "1", last: "4" });
      cp.canonical = canonical;
      await cpRefused(cp, ["The checkpoint's signed bytes are not readable."]);
    }
  });

  test("shaped wrongly is unreadable", async () => {
    for (const change of [(c: Json) => { c.first = "0"; }, (c: Json) => { c.last = "x"; }, (c: Json) => { c.first = "5"; }, (c: Json) => { c.merkle_root = "ab"; },
      (c: Json) => { c.ending_hash = null; }, (c: Json) => { c.checkpoint_id = 7; }, (c: Json) => { c.created_at = "yesterday"; }]) {
      const cp = mint({ first: "1", last: "4" });
      change(cp);
      await cpRefused(cp, [UNREADABLE]);
    }
  });

  test("signed at a time not written as the service writes one is unreadable, however Date.parse reads it", async () => {
    // A post's page quotes a covering checkpoint's time, and compares it with its
    // certificate's dates. Date.parse takes a comment in parentheses, markup and all,
    // and a time with no zone in whatever zone this server runs in.
    for (const createdAt of ["Tue, 15 Sep 2026 12:00:00 GMT (<script>alert(1)</script>)", "2026-09-15 12:00:00", "2026-09-15T12:00:00"]) {
      assert.ok(!Number.isNaN(Date.parse(createdAt)), createdAt);
      await cpRefused(mint({ first: "1", last: "4", createdAt }), [UNREADABLE]);
    }
  });

  describe("shows what was signed", () => {
    const shown: [string, (c: Json) => void][] = [
      ["stream", (c) => { c.stream = "events"; }],
      ["first", (c) => { c.first = "2"; }],
      ["last", (c) => { c.last = "5"; }],
      ["predecessor hash", (c) => { c.predecessor_hash = flip(c.predecessor_hash); }],
      ["ending hash", (c) => { c.ending_hash = flip(c.ending_hash); }],
      ["merkle root", (c) => { c.merkle_root = flip(c.merkle_root); }],
      ["service epoch", (c) => { c.service_epoch = "2"; }],
      ["created at", (c) => { c.created_at = "2026-09-15T12:00:01.000Z"; }],
    ];
    for (const [field, change] of shown) {
      test(field, async () => {
        const cp = mint({ first: "1", last: "4" });
        change(cp);
        await cpRefused(cp, [`The signed ${field} is not the one shown.`]);
      });
    }
    test("previous checkpoint", async () => {
      const cp = mint({ first: "1", last: "4" });
      cp.previous_checkpoint_id = "ab".repeat(32);
      await cpRefused(cp, ["The signed previous checkpoint is not the one shown."]);
    });
  });

  test("signed for another space does not hold on this one's page", async () => {
    await cpRefused(mint({ first: "1", last: "4" }), ["The checkpoint was signed for another space."], rootHex, null, OTHER_SPACE);
  });

  test("holds only as a checkpoint of the record it was signed for, the posts or the membership history", async () => {
    const history = mint({ first: "1", last: "4", stream: "events" });
    await cpHolds(history, rootHex, null, "events");
    await cpRefused(history, ["The checkpoint was not signed for the space's posts."]);
    await cpRefused(mint({ first: "1", last: "4" }), ["The checkpoint was not signed for the space's membership history."], rootHex, null, SPACE, "events");
  });

  test("whose id is not the hash of its bytes does not hold", async () => {
    const cp = mint({ first: "1", last: "4" });
    cp.checkpoint_id = flip(cp.checkpoint_id);
    await cpRefused(cp, ["The checkpoint's id is not the hash of its bytes."]);
  });

  test("naming a signing key other than the one shown does not hold", async () => {
    await cpRefused(mint({ first: "1", last: "4", keyId: "ab".repeat(32) }), ["The checkpoint names a signing key other than the one shown."]);
    const cp = mint({ first: "1", last: "4" });
    cp.signer.key_id = "ab".repeat(32);
    await cpRefused(cp, ["The checkpoint names a signing key other than the one shown."]);
  });

  test("whose signature changed does not verify", async () => {
    const cp = mint({ first: "1", last: "4" });
    cp.signature = "44".repeat(64);
    await cpRefused(cp, ["The service's signature on the checkpoint does not verify."]);
  });

  describe("its signing key's certificate", () => {
    const naming = "The signing key's certificate does not name it, or does not allow it to sign checkpoints.";
    test("must allow the key to sign checkpoints", async () => {
      await cpRefused(mint({ first: "1", last: "4", cert: { purposes: ["events"] } }), [naming]);
      await cpRefused(mint({ first: "1", last: "4", cert: { purposes: "checkpoint" } }), [naming]);
    });
    test("must name the key, and the root", async () => {
      await cpRefused(mint({ first: "1", last: "4", cert: { key: "ab".repeat(32) } }), [naming]);
      await cpRefused(mint({ first: "1", last: "4", cert: { root: "ab".repeat(32) } }), [naming]);
    });
    test("must verify against its root", async () => {
      const cp = mint({ first: "1", last: "4" });
      cp.signer.certificate_signature = "55".repeat(64);
      await cpRefused(cp, ["The signing key's certificate does not verify against its root."]);
      await cpRefused(mint({ first: "1", last: "4", certSigner: otherRoot }), ["The signing key's certificate does not verify against its root."]);
    });
    test("must say when it is valid", async () => {
      const when = "The signing key's certificate does not say when it is valid.";
      await cpRefused(mint({ first: "1", last: "4", cert: { not_before: undefined } }), [when]);
      await cpRefused(mint({ first: "1", last: "4", cert: { not_before: "soon" } }), [when]);
      await cpRefused(mint({ first: "1", last: "4", cert: { not_after: 5 } }), [when]);
    });
    test("vouches for the key only between its dates, with a minute's grace before the first", async () => {
      const outside = "The checkpoint was signed outside the dates its signing key's certificate is valid.";
      const at = (createdAt: string, cert: Json = {}) => mint({ first: "1", last: "4", createdAt, cert: { not_before: "2026-09-15T12:00:00.000Z", not_after: "2026-09-16T12:00:00.000Z", ...cert } });
      await cpHolds(at("2026-09-15T11:59:30.000Z"));
      await cpHolds(at("2026-09-16T11:59:59.999Z"));
      await cpHolds(at("2030-01-01T00:00:00.000Z", { not_after: undefined }));
      await cpRefused(at("2026-09-15T11:58:59.999Z"), [outside]);
      await cpRefused(at("2026-09-16T12:00:00.000Z"), [outside]);
    });
  });

  test("signed under a root this site does not trust does not hold", async () => {
    await cpRefused(mint({ first: "1", last: "4" }), ["The checkpoint was signed under a root this site does not trust."], "66".repeat(32));
  });

  describe("follows the one before it", () => {
    const first = mint({ first: "1", last: "4" });
    const next = (m: Partial<Mint> = {}) => mint({ first: "5", last: "9", previousId: first.checkpoint_id, predecessorHash: first.ending_hash, ...m });
    test("when it starts where that one ended, names it, and starts from its ending link", async () => {
      await cpHolds(next(), rootHex, first);
    });
    test("not when it starts elsewhere", async () => {
      await cpRefused(next({ first: "6" }), ["The checkpoint does not start where the one before it ended."], rootHex, first);
    });
    test("not when it names another", async () => {
      await cpRefused(next({ previousId: "ab".repeat(32) }), ["The checkpoint does not name the one before it."], rootHex, first);
    });
    test("not when it starts from another link", async () => {
      await cpRefused(next({ predecessorHash: flip(first.ending_hash) }), ["The checkpoint does not start from the one before it's ending link."], rootHex, first);
    });
    test("not when the one before cannot be read", async () => {
      await cpRefused(next(), [UNREADABLE], rootHex, { ...first, last: "four" });
    });
  });

  test("an answer shaped wrongly is a check that did not hold, never a thrown error", async () => {
    for (const cp of [null, undefined, 1, "cp", [], {}, { canonical: 5 }]) {
      assert.equal((await checkCheckpoint(cp, SPACE, "posts", rootHex)).verified, false, JSON.stringify(cp));
    }
    const throwing = mint({ first: "1", last: "4" });
    Object.defineProperty(throwing, "signer", { get() { throw new Error("a getter"); } });
    await cpRefused(throwing, [UNREADABLE]);
  });
});

// ------------------------------------------------------------- the record

/** RFC 9162 2.1.1, written from the RFC: the hash of a list of leaf hashes. */
function mth(leaves: Buffer[]): Buffer {
  if (leaves.length === 1) return leaves[0]!;
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return H(Buffer.from([1]), mth(leaves.slice(0, k)), mth(leaves.slice(k)));
}

/** RFC 9162 2.1.3.1: the audit path for leaf m, nearest sibling first. */
function auditPath(m: number, leaves: Buffer[]): Buffer[] {
  if (leaves.length === 1) return [];
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return m < k ? [...auditPath(m, leaves.slice(0, k)), mth(leaves.slice(k))] : [...auditPath(m - k, leaves.slice(k)), mth(leaves.slice(0, k))];
}

const leafOf = (space: string, seq: string, objectId: string, link: string) =>
  H(Buffer.from([0]), label("checkpoint-object"), uuid(space), int8(seq), Buffer.from(objectId, "hex"), Buffer.from(link, "hex"));

/** A post at `seq` in a tree of `size` leaves starting at `first`, its proof, and the checkpoint over the tree. */
function record(size: number, index: number, firstSeq = 1, m: Partial<Mint> = {}) {
  const seq = String(firstSeq + index);
  const post = { space_id: SPACE, seq, proof: { object_id: hex(H(Buffer.from(`object ${seq}`))), chain: { chain_hash: hex(H(Buffer.from(`link ${seq}`))) } } };
  const leaves = Array.from({ length: size }, (_, i) =>
    i === index ? leafOf(SPACE, seq, post.proof.object_id, post.proof.chain.chain_hash) : H(Buffer.from(`another leaf ${i}`)));
  const checkpoint = mint({
    first: String(firstSeq), last: String(firstSeq + size - 1), merkleRoot: hex(mth(leaves)),
    endingHash: index === size - 1 ? post.proof.chain.chain_hash : hex(H(Buffer.from("the last link"))), ...m,
  });
  return { post, leaf: hex(leaves[index]!), inclusion: { tree_size: size, leaf_index: index, path: auditPath(index, leaves).map(hex) }, checkpoint };
}

const R = {
  names: "The proof does not name the post it proves.",
  covers: "The checkpoint does not cover this post.",
  leaf: "The proof's leaf is not this post's.",
  tree: "The inclusion proof is for a different tree from the one the checkpoint signed.",
  path: "The inclusion proof does not lead from this post to the checkpoint's root.",
  stream: "The checkpoint was not signed for the space's posts.",
  ending: "This post is the last the checkpoint covers, and the checkpoint does not end on its link.",
};

describe("a post's place in the record", () => {
  test("every leaf of trees of 1 to 9, 16, 17 and 33 leaves is covered, and nothing else is", async () => {
    for (const size of [1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17, 33]) {
      for (let index = 0; index < size; index++) {
        const answer = record(size, index, size === 7 ? 11 : 1);
        const r = await checkRecord(answer, rootHex);
        assert.deepEqual([r.state, r.problems], ["covered", []], `leaf ${index} of ${size}`);
        if (size === 1) continue;

        const changed = structuredClone(answer);
        const p = Math.min(index % changed.inclusion.path.length, changed.inclusion.path.length - 1);
        changed.inclusion.path[p] = flip(changed.inclusion.path[p]);
        assert.deepEqual((await checkRecord(changed, rootHex)).problems, [R.path], `a changed hash, leaf ${index} of ${size}`);

        const shorter = structuredClone(answer);
        shorter.inclusion.path.pop();
        assert.deepEqual((await checkRecord(shorter, rootHex)).problems, [R.path], `a path one short, leaf ${index} of ${size}`);

        const longer = structuredClone(answer);
        longer.inclusion.path.push("33".repeat(32));
        assert.deepEqual((await checkRecord(longer, rootHex)).problems, [R.path], `a path one long, leaf ${index} of ${size}`);

        const moved = structuredClone(answer);
        moved.inclusion.leaf_index = (index + 1) % size;
        assert.deepEqual((await checkRecord(moved, rootHex)).problems, [R.tree, R.path], `another place, leaf ${index} of ${size}`);
      }
    }
  });

  test("with no checkpoint is not yet covered, which is not a failure", async () => {
    assert.deepEqual(await checkRecord({ post: record(1, 0).post, checkpoint: null }, rootHex), { state: "uncovered", checkpoint: null, problems: [] });
  });

  test("must name the post it proves", async () => {
    const answer = record(4, 1);
    delete (answer.post.proof as Json).object_id;
    assert.deepEqual(await checkRecord(answer, rootHex), { state: "failed", checkpoint: null, problems: [R.names] });
  });

  test("is not covered by a checkpoint whose range it is outside", async () => {
    // Post 4 of a checkpoint signed for posts 1 to 3, with a path that does reach that
    // checkpoint's root: the range alone refuses it. A leaf index past the tree's size
    // is the same refusal, since both are read from the post's number and the range.
    const answer = record(4, 3);
    answer.checkpoint = mint({ first: "1", last: "3", merkleRoot: answer.checkpoint.merkle_root });
    answer.inclusion.tree_size = 3;
    const r = await checkRecord(answer, rootHex);
    assert.deepEqual([r.state, r.problems], ["failed", [R.covers]]);
  });

  test("with the wrong leaf does not hold", async () => {
    const answer = record(4, 2);
    answer.leaf = "33".repeat(32);
    assert.deepEqual((await checkRecord(answer, rootHex)).problems, [R.leaf]);
  });

  test("for a tree of another size does not hold", async () => {
    const answer = record(4, 2);
    answer.inclusion.tree_size += 1;
    assert.deepEqual((await checkRecord(answer, rootHex)).problems, [R.tree, R.path]);
  });

  test("for another space does not hold", async () => {
    const answer = record(4, 2);
    answer.post.space_id = OTHER_SPACE;
    const r = await checkRecord(answer, rootHex);
    assert.deepEqual([r.state, r.problems], ["failed", [R.leaf, R.path, "The checkpoint was signed for another space."]]);
  });

  test("under a checkpoint that does not hold, does not hold", async () => {
    const changedSignature = record(4, 2);
    changedSignature.checkpoint.signature = "44".repeat(64);
    assert.deepEqual((await checkRecord(changedSignature, rootHex)).problems, ["The service's signature on the checkpoint does not verify."]);
    const otherCertificate = record(4, 2);
    otherCertificate.checkpoint.signer.certificate_signature = "55".repeat(64);
    assert.equal((await checkRecord(otherCertificate, rootHex)).state, "failed");
    const untrustedRoot = await checkRecord(record(4, 2), "66".repeat(32));
    assert.deepEqual([untrustedRoot.state, untrustedRoot.problems], ["failed", ["The checkpoint was signed under a root this site does not trust."]]);
  });

  test("an answer shaped wrongly is a check that did not hold, never a thrown error", async () => {
    for (const answer of [{ checkpoint: 1, post: null }, { checkpoint: {}, post: {} }, { checkpoint: { first: "x" }, post: record(1, 0).post }]) {
      assert.equal((await checkRecord(answer, rootHex)).state, "failed", JSON.stringify(answer));
    }
    const noInclusion = record(4, 1) as Json;
    delete noInclusion.inclusion;
    assert.equal((await checkRecord(noInclusion, rootHex)).state, "failed");
    const throwing = record(4, 1) as Json;
    Object.defineProperty(throwing, "inclusion", { get() { throw new Error("a getter"); } });
    assert.deepEqual(await checkRecord(throwing, rootHex), { state: "failed", checkpoint: null, problems: [UNREADABLE] });
  });

  // A space keeps two records, its posts and its membership history, and each has its
  // own checkpoints, numbered by its own entries. The product takes a checkpoint's
  // leaves as posts only when its stream is "posts", and so does this site: one of the
  // membership history says nothing about a post, whatever its range and its tree.
  test("is not covered by a checkpoint of the membership history", async () => {
    const r = await checkRecord(record(4, 1, 1, { stream: "events" }), rootHex);
    assert.deepEqual([r.state, r.problems], ["failed", [R.stream]]);
  });

  // A checkpoint says where its range ends twice: in its tree, whose last leaf carries
  // the last post's link, and in its ending hash, which the next checkpoint must start
  // from and which a witness follows. The product's database refuses a checkpoint
  // whose two disagree, and its check of a whole record compares them; its check of one
  // post's proof does not. This site compares them wherever a post's page can, which is
  // on the last post a checkpoint covers: a checkpoint that contradicts its own tree
  // there covers nothing, and nothing an honest service signs is refused. An earlier
  // post's proof carries no link of the last post's, so it cannot be compared there.
  test("is not covered by a checkpoint that ends on another link than the last post's", async () => {
    const endingHash = hex(H(Buffer.from("a different last link")));
    const last = await checkRecord(record(4, 3, 1, { endingHash }), rootHex);
    assert.deepEqual([last.state, last.problems], ["failed", [R.ending]]);
    const earlier = await checkRecord(record(4, 2, 1, { endingHash }), rootHex);
    assert.deepEqual([earlier.state, earlier.problems], ["covered", []]);
  });
});

describe("a post the service says no checkpoint covers", () => {
  test("cannot be uncovered when the latest checkpoint reaches past it", () => {
    assert.equal(uncoveredProblem("3", { last: "5" }), "The service says no checkpoint covers this post, and its latest checkpoint covers posts up to 5.");
    assert.equal(uncoveredProblem("5", { last: "5" }), "The service says no checkpoint covers this post, and its latest checkpoint covers posts up to 5.");
  });
  test("can be, when nothing reaches it, or nothing can be read", () => {
    for (const [seq, latest] of [["6", { last: "5" }], ["3", null], ["3", { last: 5 }], ["3", { last: "05" }], ["03", { last: "5" }], ["3", undefined]] as const) {
      assert.equal(uncoveredProblem(seq, latest), null, `${seq} ${JSON.stringify(latest)}`);
    }
  });
});

// ------------------------------------------------------------- a recovery notice

const notice = (m: NoticeMint = {}): Json => mintNotice({ service: serviceKey, root }, m);

describe("a recovery notice", () => {
  const refused = async (n: Json, problems: string[], rootKey: string | null = rootHex) => {
    const r = await checkRecoveryNotice(n, rootKey);
    assert.deepEqual(r.problems, problems);
    assert.equal(r.verified, false);
  };

  test("holds, and gives the page what was signed", async () => {
    const r = await checkRecoveryNotice(notice(), rootHex);
    assert.deepEqual(r.problems, []);
    assert.deepEqual([r.verified, r.rootPinned, r.development], [true, true, false]);
    assert.equal((r.body as Json).spaces[0].replacement.name, "long-space-2");
    assert.equal((await checkRecoveryNotice(notice(), null)).rootPinned, false);
  });

  test("signed with a development key says so, and still holds", async () => {
    const r = await checkRecoveryNotice(notice({ cert: { development: true } }), rootHex);
    assert.deepEqual([r.verified, r.development], [true, true]);
  });

  test("whose bytes cannot be read, or that says no time, does not hold", async () => {
    for (const canonical of ["not base64url!", b64u("not json"), b64u("[]")]) {
      await refused({ ...notice(), canonical }, ["The notice's signed bytes are not readable."]);
    }
    await refused(notice({ createdAt: "yesterday" }), ["The notice does not say when it was signed."]);
  });

  test("refuses each change with the one sentence that names it", async () => {
    await refused({ ...notice(), notice_id: flip(notice().notice_id) }, ["The notice's id is not the hash of its bytes."]);
    await refused({ ...notice(), service_epoch: "9" }, ["The signed service epoch is not the one shown."]);
    await refused(notice({ keyId: hex(H(Buffer.from("another key"))) }), ["The notice names a signing key other than the one shown."]);
    await refused({ ...notice(), signature: flip(notice().signature) }, ["The service's signature on the notice does not verify."]);
    await refused(notice({ purposes: ["checkpoint"] }), ["The signing key's certificate does not name it, or does not allow it to sign recovery notices."]);
    await refused(notice({ certSigner: stranger }), ["The signing key's certificate does not verify against its root."]);
    await refused(notice({ createdAt: "2028-01-01T00:00:00.000Z" }), ["The notice was signed outside the dates its signing key's certificate is valid."]);
    await refused(notice(), ["The notice was signed under a root this site does not trust."], hex(H(Buffer.from("another root"))));
  });

  test("shaped wrongly is a notice that did not hold, never a thrown error", async () => {
    for (const n of [null, undefined, 7, "x", [], {}, { canonical: 5 }, { ...notice(), signer: null }, { ...notice(), signer: "x" }]) {
      const r = await checkRecoveryNotice(n, rootHex);
      assert.equal(r.verified, false);
      assert.ok(r.problems.length > 0);
    }
  });
});
