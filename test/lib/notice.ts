// A recovery notice as the service signs one and GET /v1/recovery answers it, made
// with node:crypto keys, for the tests of src/verify.ts and of the page that shows
// the notices. Correct unless a test asks for one change.

import { createHash, sign, type KeyObject } from "node:crypto";
import { canonicalBytes } from "../../src/jcs.js";

type Json = Record<string, any>;
export type KeyPair = { publicKey: KeyObject; privateKey: KeyObject };

const label = (name: string) => Buffer.concat([Buffer.from(`agent-state:${name}:v1`), Buffer.from([0])]);
const H = (...parts: Uint8Array[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
export const rawKey = (k: KeyObject) => k.export({ format: "der", type: "spki" }).subarray(-32);

export interface NoticeMint {
  createdAt?: string; epoch?: string; keyId?: string; purposes?: string[]; certSigner?: KeyPair; cert?: Json;
  /** The space the restore closed, and the one it continues in. */
  name?: string; replacement?: string; reason?: string;
}

export function mintNotice(keys: { service: KeyPair; root: KeyPair }, m: NoticeMint = {}): Json {
  const pub = rawKey(keys.service.publicKey);
  const rootHex = hex(rawKey(keys.root.publicKey));
  const keyId = m.keyId ?? hex(H(label("service-key"), pub));
  const body = {
    v: 1, service_epoch: m.epoch ?? "2", previous_epoch: "1", reason: m.reason ?? "a restore from the backup of 14 September",
    created_at: m.createdAt ?? "2026-09-16T12:00:00.000Z",
    spaces: [{
      space_id: "0199aaaa-0000-7000-8000-00000000abcd", name: m.name ?? "long-space",
      signed: [{ stream: "posts", last: "40", ending_hash: hex(H(Buffer.from("end 40"))), checkpoint_id: hex(H(Buffer.from("cp 40"))), found: "short" }],
      recovered: { posts: { last: "37", chain_hash: hex(H(Buffer.from("end 37"))) }, events: { last: "3", chain_hash: null } },
      replacement: { space_id: "0199aaaa-0000-7000-8000-00000000dcba", name: m.replacement ?? "long-space-2" },
    }],
    signer_key_id: keyId,
  };
  const canonical = Buffer.from(canonicalBytes(body));
  const id = H(label("recovery"), canonical);
  const signature = sign(null, Buffer.concat([label("recovery-signature"), id]), keys.service.privateKey);
  const certificate = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries({
    key: hex(pub), root: rootHex, purposes: m.purposes ?? ["checkpoint", "receipt", "recovery"],
    not_before: "2026-09-01T00:00:00.000Z", not_after: "2027-09-01T00:00:00.000Z", ...m.cert,
  }).filter(([, v]) => v !== undefined))));
  const certificateSignature = sign(null, Buffer.concat([label("service-certificate-signature"), H(label("service-certificate"), certificate)]),
    (m.certSigner ?? keys.root).privateKey);
  return {
    notice_id: hex(id), service_epoch: body.service_epoch, created_at: body.created_at, notice: body,
    canonical: b64u(canonical), signature: hex(signature),
    signer: { key_id: keyId, public_key: hex(pub), root_key: rootHex, certificate: b64u(certificate), certificate_signature: hex(certificateSignature), development: false },
  };
}
