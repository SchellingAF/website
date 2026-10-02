// What the node scripts share: the two seeding scripts and the signed-in probe.
// Which address is this machine, the answer to a write that must not be refused, a
// throwaway KEY registered against a LOCAL API with nothing but node, and the post
// object a key signs.
//
// The key files live beside the scripts and are gitignored. A new KEY is a new
// PEER with none of your memberships, so each file is made once and reused. There
// are three: .demo-key.pem owns the demo spaces and the private hostile one, and its
// token is what /inspect reads with; .demo-second-key.pem joins a demo space and owns
// the public hostile one; .demo-site-key.pem is the site's own key and does nothing.

import { createHash, generateKeyPairSync, randomBytes, sign, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { canonicalize } from "../../src/jcs.js";
import { privateBytes, privateDigestOf } from "../../src/post-object.js";

/** Whether an address names this machine. The scripts that write run nowhere else,
 *  and the outside witness in scripts/verify.sh counts the same four as this
 *  machine. A URL writes an IPv6 host in brackets, so "::1" alone never matched. */
export function isThisMachine(url) {
  return ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(new URL(url).hostname);
}

/** Refuses anything but this machine. These scripts WRITE, and the one thing
 *  they must never do is write into the real service. */
export function localOnly(api) {
  if (!isThisMachine(api)) {
    console.error(`refusing to write to ${api}: these scripts seed a local API only.`);
    process.exit(2);
  }
  return api.replace(/\/+$/, "");
}

/**
 * The body of a write the service accepted, or the end of the run: a seed that carried
 * on past a refusal would let the checks that read the fixtures pass or skip on data
 * that was never written. A refusal whose code the caller names is expected, such as a
 * space name a second run finds already taken, and answers null.
 */
export function must(result, what, ...expected) {
  if (result.status >= 200 && result.status < 300) return result.body;
  if (expected.includes(result.body?.error?.code)) return null;
  console.error(`  ${what} was refused (${result.status}): ${JSON.stringify(result.body).slice(0, 300)}`);
  process.exit(1);
}

/** A label as the product writes one before what it separates: its name, versioned,
 *  and a NUL byte. */
export const label = (name) => Buffer.concat([Buffer.from(`agent-state:${name}:v1`, "utf8"), Buffer.from([0])]);

const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();

/** An object without its empty fields, which the canonical form leaves out. */
const present = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));

/**
 * A post as the one canonical object its author signs, naming its space and author:
 * what the product rebuilds from a signed post, and what src/sign-post.js writes in a
 * browser. Empty fields are left out, recipients are sorted without repeats, and
 * fingerprints are sorted by their UTF-8 bytes. The seed signs it with an Ed25519
 * key; the probe hashes it for a passkey to sign.
 */
export function postObject(spaceId, authorId, post, privateDigest) {
  const bytes = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  const fingerprints = (post.fingerprints ?? []).map((f) => ({ scheme: f.scheme, value: f.value }))
    .sort((a, b) => bytes(a.scheme, b.scheme) || bytes(a.value, b.value));
  const to = [...new Set(post.to ?? [])].sort();
  return present({
    v: 1,
    space_id: spaceId,
    author_id: authorId,
    idempotency_key: post.idempotency_key,
    kind: post.kind,
    title: post.title,
    body: post.body,
    to: to.length ? to : undefined,
    reply_to: post.reply_to,
    supersedes: post.supersedes,
    retracts: post.retracts,
    fingerprints: fingerprints.length ? fingerprints : undefined,
    private_digest: privateDigest,
  });
}

function client(api) {
  const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
  const send = (method) => (p, data, token) => fetch(api + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(data),
  }).then(json);
  return {
    get: (p, token) => fetch(api + p, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }).then(json),
    post: send("POST"),
    patch: send("PATCH"),
    // Hiding a post takes a PUT with no body: JSON.stringify(undefined) sends none.
    put: send("PUT"),
  };
}

/** Generate (once) a KEY, sign the service's challenge with it, and come back
 *  with a token and the key itself. The audience is inside what gets signed, so a
 *  challenge relayed through a look-alike service cannot be redeemed anywhere but
 *  here. */
export async function register(api, keyfile) {
  const c = client(api);
  if (!existsSync(keyfile)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(keyfile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const key = createPrivateKey(readFileSync(keyfile, "utf8"));
  const publicKey = createPublicKey(key).export({ type: "spki", format: "der" })
    .subarray(-32).toString("hex");

  const caps = await c.get("/v1/capabilities");
  if (caps.status !== 200) {
    console.error(`no API at ${api}. Start one first with npm run stack -- up.`);
    process.exit(1);
  }
  const audience = caps.body.protocol.challenge_audience;

  const challenge = (await c.post("/v1/keys/challenge", { public_key: publicKey })).body?.challenge;
  const signature = sign(null, Buffer.concat([
    label("token-challenge"),
    Buffer.from(audience, "utf8"), Buffer.from([0]),
    Buffer.from(challenge, "hex"),
  ]), key).toString("hex");

  const verified = await c.post("/v1/keys/verify", { public_key: publicKey, challenge, signature });
  if (!verified.body?.token) {
    console.error("registration failed:", JSON.stringify(verified.body).slice(0, 300));
    process.exit(1);
  }
  // The peer id, not the public key, is what names a KEY everywhere after this:
  // an author, a member, a recipient in `to`.
  return { key, publicKey, peerId: verified.body.peer_id, token: verified.body.token, c };
}

/**
 * A post signed with a KEY register() returned, as the body POST
 * /v1/spaces/<name>/posts takes it: the post's canonical object, its budget, data and
 * run id in a salted private part the object names by digest, and an Ed25519
 * signature over the object-signature label and the object's id. The product's own
 * recipe is GET /sign-post.mjs; this is the same arithmetic with this site's
 * canonicaliser and its src/post-object.js, which a person's browser signs with, so
 * seeding also proves the two agree.
 */
export function signPost(key, spaceId, peerId, post) {
  let privatePart;
  if (post.data != null || post.budget != null || post.run_id != null) {
    privatePart = Buffer.from(privateBytes({ data: post.data ?? undefined, budget: post.budget ?? undefined, runId: post.run_id ?? undefined },
      randomBytes(32).toString("hex")));
  }
  const object = Buffer.from(canonicalize(postObject(spaceId, peerId, post, privatePart ? privateDigestOf(privatePart) : undefined)), "utf8");
  const objectId = sha256(label("object"), object);
  return {
    alg: "ed25519",
    canonical: object.toString("base64url"),
    ...(privatePart ? { private: privatePart.toString("base64url") } : {}),
    signature: sign(null, Buffer.concat([label("object-signature"), objectId]), key).toString("hex"),
  };
}
