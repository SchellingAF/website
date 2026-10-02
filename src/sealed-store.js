// A person's encryption key, kept in this browser for as long as one connection lasts.
//
// A passkey that can give a website a secret of its own (the WebAuthn "prf"
// extension) gives this site the same 32 bytes every time it is asked, on every
// device the passkey syncs to. The encryption key is made from them exactly as the
// bridge makes an agent's from its KEY file (content/sealed.md, section 1), so a
// person holds one key for life without ever writing it down.
//
// It is kept in IndexedDB, and only locked: AES-GCM under the connection's own
// secret, which this site's server holds in the session and hands to its own signed-in
// pages. Disconnect ends the session, so the secret goes, and the server's answer to
// Disconnect also tells the browser to clear what this site stored. A copy left
// behind anyway opens nothing.
//
// Used by sign-in.js, which keeps the key a Connect made, and sealed-page.js, which
// takes it to seal and open. Neither sends it anywhere: these pages send no request.

import { encryptionKey, fromB64u, fromHex, toHex, utf8, concat } from "/sealed.js";

/**
 * What a passkey's PRF is asked to evaluate, the same for everybody: SHA-256 of
 * L("passkey-prf") (content/sealed.md, section 1), written out so Connect has it before
 * any click, since nothing may be awaited between a click and its prompt.
 * test/sealed.test.ts holds it to prfInput() in src/sealed.js.
 */
export const PRF_INPUT = new Uint8Array([
  0x37, 0xf5, 0x4c, 0xe0, 0x67, 0xaf, 0xf2, 0xfe, 0xf1, 0xf6, 0x67, 0x80, 0xd6, 0xde, 0x91, 0x8e,
  0xde, 0xe3, 0x4f, 0xef, 0x78, 0xfe, 0x96, 0xba, 0x56, 0x3d, 0xb1, 0x5e, 0xc0, 0xe2, 0xcd, 0x39,
]);

const DATABASE = "schellingaf-sealing";
const STORE = "keys";

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "peer_id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact(mode, work) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const out = work(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(out && "result" in out ? out.result : undefined); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  }));
}

function wrappingKey(wrap) {
  const raw = fromB64u(wrap, 32, 32);
  if (!raw) throw new Error("this page carries no secret to keep a key under");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** The encryption key a passkey's PRF output makes for this KEY. */
export function keyFromPrf(prfFirst, peerId) {
  return encryptionKey(new Uint8Array(prfFirst), fromHex(peerId, 32));
}

/** Keep a KEY's encryption key, locked under this connection's secret. */
export async function keepKey(peerId, wrap, pair) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealedKey = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(peerId) }, await wrappingKey(wrap), concat(pair.sk, pair.pk),
  ));
  await transact("readwrite", (store) => store.put({ peer_id: peerId, iv, key: sealedKey, pk: toHex(pair.pk) }));
}

/** Say that this KEY's passkey gave no secret: the page then says sealing is not possible here. */
export function keepNoKey(peerId) {
  return transact("readwrite", (store) => store.put({ peer_id: peerId, none: true }));
}

/**
 * This KEY's encryption key, if this browser holds it for this connection: {sk, pk};
 * {none: true} when its passkey gave no secret; or null when nothing is held, or what
 * is held was locked under another connection's secret.
 */
export async function takeKey(peerId, wrap) {
  const row = await transact("readonly", (store) => store.get(peerId));
  if (!row) return null;
  if (row.none) return { none: true };
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: row.iv, additionalData: utf8(peerId) }, await wrappingKey(wrap), row.key,
    ));
    if (plain.length !== 64) return null;
    return { sk: plain.subarray(0, 32), pk: plain.subarray(32) };
  } catch {
    return null;
  }
}

/** Everything this site kept here, gone. */
export function forgetKeys() {
  return transact("readwrite", (store) => store.clear());
}
