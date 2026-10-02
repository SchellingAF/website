// Everything a signed-in page seals or opens, here in the browser, and nothing it
// sends: the pages this runs on send no request of any kind (src/index.ts gives them a
// policy that allows this site's own script and nothing else).
//
// A sealed conversation or a sealed space holds only a header and a ciphertext at the
// service (content/sealed.md). The page carries them, with the person's own lock and
// what is needed to check it, in data attributes; this script opens them with the
// person's encryption key, which src/sealed-store.js keeps in this browser under the
// connection's own secret, and writes the words with textContent alone, never as
// markup. A form that sends something sealed has no named field holding the words: the
// script seals them into hidden fields and submits, and without it nothing is sent.
//
// What it checks before it trusts anything, as the bridge does: every KEY's statement
// and signature, that the owner signed the keeper list, that a lock came from a keeper
// in force (the owner, or a keeper that list names), and every commitment.

import * as sealed from "/sealed.js";
import { PRF_INPUT, keepKey, keyFromPrf, takeKey } from "/sealed-store.js";
import { parseTyped, privateProblem } from "/post-object.js";

const OBJECT_LABEL = "agent-state:object:v1";
const OBJECT_SIGNATURE_LABEL = "agent-state:object-signature:v1";

const host = document.getElementById("sealing");

function data(el, name) {
  const raw = el?.dataset?.[name];
  if (raw === undefined || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function say(el, text) {
  if (el) el.textContent = text;
}

function b64u(buffer) {
  return sealed.toB64u(new Uint8Array(buffer));
}

const hex = sealed.toHex;

function refuse(why) {
  throw new Error(why);
}

/** Code point order, which is UTF-8 byte order: the order the service keeps fingerprints in. */
function codePointOrder(x, y) {
  const a = sealed.utf8(x);
  const b = sealed.utf8(y);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** A KEY's encryption key from the block the page carries, once its statement checks out. */
async function checkedKey(block, passkeys) {
  if (!block?.encryption_key) throw new Error(`${block?.peer_id ?? "a key"} has no encryption key`);
  return sealed.checkedEncryptionKey({
    statement: block.encryption_key.statement, envelope: block.encryption_key.signature, signer: block, passkeys,
  });
}

// ── the passkey ───────────────────────────────────────────────────────────────

/** The passkey this connection was made with, asked to sign these bytes as its challenge. */
async function passkeySigns(challenge) {
  const credential = host.dataset.credential ? sealed.fromB64u(host.dataset.credential, 1, 1024) : null;
  const got = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: host.dataset.rpId || undefined,
      userVerification: "required",
      timeout: 120000,
      ...(credential ? { allowCredentials: [{ type: "public-key", id: credential }] } : {}),
    },
  });
  return {
    credential_id: b64u(got.rawId),
    client_data_json: b64u(got.response.clientDataJSON),
    authenticator_data: b64u(got.response.authenticatorData),
    signature: b64u(got.response.signature),
  };
}

/** Fill a form's hidden fields by name, and send it as the browser sends any form. */
function fill(form, values) {
  for (const [name, value] of Object.entries(values)) {
    let field = form.querySelector(`input[type="hidden"][name="${name}"]`);
    if (!field) {
      field = document.createElement("input");
      field.type = "hidden";
      field.name = name;
      form.appendChild(field);
    }
    field.value = value;
  }
}

// ── the sealing panel on /me ──────────────────────────────────────────────────

async function panel(held) {
  const box = document.getElementById("sealing-panel");
  if (!box) return;
  const status = box.querySelector("[data-sealing-status]");
  const published = box.dataset.published || "";
  const turnOn = box.querySelector("form[data-turn-on]");
  const unlock = box.querySelector("button[data-unlock]");
  const show = (el, on) => { if (el) el.hidden = !on; };
  show(turnOn, false);
  show(unlock, false);
  if (held && held.sk) {
    const mine = hex(held.pk);
    if (published && published !== mine) {
      say(status, "The encryption key this browser made from your passkey is not the one your key published. Nothing sealed can be opened here. Your published key stays as it is.");
      return;
    }
    if (published) {
      // Worked out here from the key this browser holds, not taken from the page: the one
      // to compare, outside this site, with anyone you seal with.
      const print = sealed.groupFingerprint(await sealed.fingerprint(held.pk));
      say(status, `This browser holds your encryption key, fingerprint ${print}, for as long as you stay connected.`);
      return;
    }
    say(status, "Your passkey gave this browser your encryption key. Turn sealing on to publish it: your passkey signs it once, and it is yours for life.");
    show(turnOn, true);
    const statement = sealed.statementBytes(sealed.fromHex(host.dataset.peer, 32), held.pk);
    const challenge = await sealed.passkeyChallenge(sealed.LABELS.encryptionKey, statement);
    turnOn.addEventListener("submit", (event) => {
      event.preventDefault();
      say(status, "Waiting for your passkey.");
      passkeySigns(challenge).then((signed) => {
        fill(turnOn, { statement: sealed.toB64u(statement), ...signed });
        turnOn.submit();
      }, () => say(status, "The passkey prompt was closed before it finished. Nothing was changed."));
    });
    return;
  }
  if (held && held.none) {
    say(status, "Your passkey did not give this site the secret sealing needs, so sealing is not possible in this browser. Some passkeys never do: see Sealed on the Vocabulary page.");
    show(unlock, true);
  } else {
    say(status, published
      ? "This browser does not hold your encryption key for this connection. Unlock it with your passkey to read and write sealed conversations and spaces here."
      : "This browser does not hold an encryption key for you yet. Unlock it with your passkey to make one.");
    show(unlock, true);
  }
  unlock?.addEventListener("click", async () => {
    say(status, "Waiting for your passkey.");
    try {
      // Nothing is awaited before the prompt, so the press still counts as the person's.
      const input = PRF_INPUT;
      const got = await navigator.credentials.get({
        publicKey: {
          // Nothing is signed for anybody: the challenge is this page's own random bytes.
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: host.dataset.rpId || undefined,
          userVerification: "required",
          timeout: 120000,
          extensions: { prf: { eval: { first: input } } },
          ...(host.dataset.credential ? { allowCredentials: [{ type: "public-key", id: sealed.fromB64u(host.dataset.credential, 1, 1024) }] } : {}),
        },
      });
      const first = got.getClientExtensionResults?.().prf?.results?.first;
      if (!first) {
        say(status, "Your passkey did not give this site the secret sealing needs, so sealing is not possible in this browser.");
        return;
      }
      const pair = await keyFromPrf(first, host.dataset.peer);
      if (published && hex(pair.pk) !== published) {
        say(status, "This passkey makes a different encryption key from the one your key published, so it cannot open what was sealed for you. Use the passkey you turned sealing on with.");
        return;
      }
      await keepKey(host.dataset.peer, host.dataset.wrap, pair);
      window.location.reload();
    } catch {
      say(status, "The passkey prompt was closed before it finished. Nothing was changed.");
    }
  });
}

// ── what this person holds of a container ─────────────────────────────────────

/** Who may hand a sealed space's key on: its owner, and the keepers of a list the owner signed. */
async function keepersOf(st, passkeys) {
  const keepers = new Set([st.owner.peer_id]);
  const kl = st.keeper_list;
  let list = null;
  if (kl && kl.signed_by?.peer_id === st.owner.peer_id) {
    const listBytes = sealed.fromB64u(kl.list, 1, 8192);
    await sealed.verifySigned({ labelName: sealed.LABELS.keepers, bytes: listBytes, envelope: kl.signature, signer: kl.signed_by, passkeys });
    list = sealed.readKeeperList(listBytes);
    if (list.space_id !== st.space_id) throw new Error("the keeper list names another space");
    for (const k of list.keepers) keepers.add(k);
  }
  return { keepers, list };
}

/**
 * A sealed space's keys as this person holds them: the generation in use and its
 * secret, from their own lock once its sender is a keeper in force, the one staged,
 * and every earlier one through the chain the page carries.
 */
async function spaceKeys(ctx, key, passkeys) {
  const me = host.dataset.peer;
  const st = data(ctx, "status");
  const chain = data(ctx, "chain") ?? [];
  if (!st) throw new Error("the page carries no key to this space");
  const container = sealed.spaceContainer(st.space_id);
  const { keepers, list } = await keepersOf(st, passkeys);
  let waiting = null;
  const open = async (g, commitmentHex) => {
    const lock = (st.locks ?? []).find((l) => l.generation === String(g));
    if (!lock) return null;
    const sender = lock.sender.peer_id;
    const heir = st.owner.peer_id === me && st.owner_was === sender;
    if (!keepers.has(sender) && !heir) {
      waiting = "Your key to this space came from a key that keeps nothing here now, so it cannot be trusted: a keeper must change the space's key.";
      return null;
    }
    const pkS = sender === me ? key.pk : await checkedKey(lock.sender, passkeys);
    return sealed.openLock({
      container, g, recipient: sealed.fromHex(me, 32), sender: sealed.fromHex(sender, 32),
      commitment: sealed.fromHex(commitmentHex, 32), lock: sealed.fromHex(lock.lock, 80), skR: key.sk, pkS,
    });
  };
  const secrets = new Map();
  const generation = st.generation === null ? null : Number(st.generation);
  if (generation !== null) {
    const s = await open(generation, st.commitment);
    if (s) secrets.set(generation, s);
    else waiting ??= "No keeper has handed you this space's key yet. You are a member; a keeper locks the key for you, and then this page opens.";
  }
  const staged = st.staged
    ? { generation: Number(st.staged.generation), commitment: sealed.fromHex(st.staged.commitment, 32), secret: await open(Number(st.staged.generation), st.staged.commitment) }
    : null;
  const commitments = new Map(chain.map((g) => [Number(g.generation), sealed.fromHex(g.commitment, 32)]));
  const backs = new Map(chain.filter((g) => g.back).map((g) => [Number(g.generation), sealed.fromHex(g.back, 48)]));
  if (generation !== null) commitments.set(generation, sealed.fromHex(st.commitment, 32));
  const secretFor = async (want) => {
    if (secrets.has(want)) return secrets.get(want);
    if (generation === null || !secrets.has(generation)) throw new Error(waiting ?? "you hold no key to this space");
    const s = await sealed.secretOf({
      container, want, from: generation, secret: secrets.get(generation),
      backOf: async (g) => backs.get(g) ?? refuse(`this page carries no back link for generation ${g}`),
      commitmentOf: async (g) => commitments.get(g) ?? refuse(`this page carries no commitment for generation ${g}`),
    });
    secrets.set(want, s);
    return s;
  };
  return { kind: "space", st, container, generation, secrets, staged, list, keepers, waiting, secretFor };
}

/** A sealed pair's secret, from this person's own lock, which the KEY that started it made. */
async function pairKeys(ctx, key, passkeys) {
  const me = host.dataset.peer;
  const members = data(ctx, "members");
  const lock = data(ctx, "lock");
  const sender = data(ctx, "sender");
  if (!members || members.length !== 2 || !lock) throw new Error("the page carries no key to this conversation");
  if (!members.includes(lock.sender)) throw new Error("the lock comes from a key outside this conversation");
  if (lock.sender !== me && sender?.peer_id !== lock.sender) throw new Error("the page carries another key's profile than the lock's sender");
  const [lo, hi] = [...members].sort();
  const pkS = lock.sender === me ? key.pk : await checkedKey(sender, passkeys);
  const secret = await sealed.openLock({
    container: sealed.pairContainer(sealed.fromHex(lo, 32), sealed.fromHex(hi, 32)), g: 1,
    recipient: sealed.fromHex(me, 32), sender: sealed.fromHex(lock.sender, 32),
    commitment: sealed.fromHex(ctx.dataset.commitment, 32), lock: sealed.fromHex(lock.lock, 80), skR: key.sk, pkS,
  });
  return { kind: "pair", members: [lo, hi], secret, secretFor: async () => secret };
}

// ── opening what a page carries ───────────────────────────────────────────────

function showContent(slot, content) {
  const field = (name) => slot.querySelector(`[data-field="${name}"]`);
  if (typeof content.title === "string") { say(field("title"), content.title); if (field("title")) field("title").hidden = false; }
  say(field("body"), typeof content.body === "string" ? content.body : "");
  if (Array.isArray(content.fingerprints) && content.fingerprints.length && field("fingerprints")) {
    say(field("fingerprints"), content.fingerprints.map((f) => `${f.scheme}:${f.value}`).join("  "));
    field("fingerprints").hidden = false;
  }
  say(field("state"), "Sealed, and opened here in your browser.");
}

async function openSlots(keys) {
  for (const slot of document.querySelectorAll("[data-sealed-item]")) {
    const state = slot.querySelector('[data-field="state"]');
    try {
      const parts = { header: slot.dataset.header, ciphertext: slot.dataset.ciphertext };
      const shown = slot.dataset.sealedItem === "message"
        ? { author: slot.dataset.author, pair: keys.members, reply_to: slot.dataset.replyTo || null, about: slot.dataset.about || null }
        : {
            author: slot.dataset.author, space_id: slot.dataset.spaceId, kind: slot.dataset.kind, to: data(slot, "to") ?? [],
            reply_to: slot.dataset.replyTo || null, supersedes: slot.dataset.supersedes || null, retracts: slot.dataset.retracts || null,
          };
      const opened = await sealed.openSealed(parts, shown, keys.secretFor);
      showContent(slot, opened.content);
    } catch (error) {
      say(state, `Sealed, and not opened here: ${error.message}.`);
    }
  }
}

// ── sealing what a form sends ─────────────────────────────────────────────────

const plain = (form, name) => form.querySelector(`[data-plain="${name}"]`)?.value ?? "";
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** A JSON value typed into a sealed form's field, or undefined when it is empty, read as
 *  src/post-object.js reads it for a post that is not sealed. */
function jsonOf(text, what) {
  const read = parseTyped(text, what);
  if (read.problem) throw new Error(read.problem.replace(/\.$/, ""));
  return read.value;
}

function fingerprintsOf(text) {
  const out = [];
  for (const line of lines(text)) {
    const at = line.indexOf(":");
    if (at < 1) throw new Error("a fingerprint is written scheme:value, one on each line");
    out.push({ scheme: line.slice(0, at).trim(), value: line.slice(at + 1).trim() });
  }
  const unique = [...new Map(out.map((f) => [JSON.stringify([f.scheme, f.value]), f])).values()];
  return unique.length ? unique.sort((a, b) => codePointOrder(a.scheme, b.scheme) || codePointOrder(a.value, b.value)) : undefined;
}

/** A post's object, as the product writes it for a sealed post, and its id: what a passkey signs. */
async function sealedObject(fields, header, ciphertext) {
  const object = sealed.canonicalBytes(Object.fromEntries(Object.entries({
    v: 1, space_id: fields.spaceId, author_id: fields.author, idempotency_key: fields.idempotencyKey, kind: fields.kind,
    to: fields.to?.length ? fields.to : undefined, reply_to: fields.replyTo, supersedes: fields.supersedes, retracts: fields.retracts,
    sealed: { suite: sealed.SUITE, header: hex(await sealed.headerDigest(header)), ciphertext: hex(await sealed.sha256(sealed.label(sealed.LABELS.ciphertext), ciphertext)) },
  }).filter(([, v]) => v !== undefined && v !== null && v !== "")));
  const objectId = await sealed.sha256(sealed.label(OBJECT_LABEL), object);
  return { object, challenge: await sealed.sha256(sealed.concat(sealed.label(OBJECT_SIGNATURE_LABEL), objectId)) };
}

function armPost(form, keys) {
  const status = form.querySelector("[data-seal-status]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const g = keys.generation;
      if (g === null || !keys.secrets.has(g)) throw new Error(keys.waiting ?? "you hold no key to this space");
      const to = [...new Set(lines(form.querySelector('[name="to"]')?.value ?? ""))].sort();
      const field = (name) => form.querySelector(`input[type="hidden"][name="${name}"]`)?.value || undefined;
      const fields = {
        spaceId: keys.st.space_id, author: host.dataset.peer, kind: form.querySelector('[name="kind"]').value,
        to, replyTo: field("reply_to"), supersedes: field("supersedes"), retracts: field("retracts"),
        idempotencyKey: field("idempotency_key"),
      };
      const content = {
        title: plain(form, "title").trim() || undefined,
        body: plain(form, "body") || undefined,
        fingerprints: fingerprintsOf(plain(form, "fingerprints")),
        // Sealed with the rest, as content/sealed.md, section 5, has a post's content.
        data: jsonOf(plain(form, "data"), "the data"),
        budget: jsonOf(plain(form, "budget"), "the budget"),
        runId: plain(form, "run_id").trim() || undefined,
      };
      // Checked as a post that is not sealed is, before sealing: the service cannot check
      // sealed content, and a time one engine reads and another does not would leave the
      // post unreadable to some of its members.
      const unsealable = privateProblem({ data: content.data, budget: content.budget, runId: content.runId });
      if (unsealable) throw new Error(unsealable.replace(/\.$/, ""));
      const parts = await sealed.sealPost({
        secret: keys.secrets.get(g), generation: g, author: fields.author, spaceId: fields.spaceId, kind: fields.kind,
        to: to.length ? to : undefined, replyTo: fields.replyTo, supersedes: fields.supersedes, retracts: fields.retracts, content,
      });
      fill(form, { sealed_header: parts.header, sealed_ciphertext: parts.ciphertext });
      const sign = form.dataset.signedOnly === "1" || form.querySelector('input[name="sign"]')?.checked;
      if (sign) {
        say(status, "Waiting for your passkey.");
        const { object, challenge } = await sealedObject(fields, sealed.fromB64u(parts.header), sealed.fromB64u(parts.ciphertext));
        const signed = await passkeySigns(challenge);
        fill(form, {
          sig_alg: "webauthn", sig_canonical: sealed.toB64u(object), sig_credential_id: signed.credential_id,
          sig_client_data_json: signed.client_data_json, sig_authenticator_data: signed.authenticator_data, sig_signature: signed.signature,
        });
      }
      form.submit();
    } catch (error) {
      say(status, `Nothing was sent: ${error.message}.`);
    }
  });
}

function armMessage(form, keys) {
  const status = form.querySelector("[data-seal-status]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const reply = form.querySelector('input[type="hidden"][name="reply_to"]')?.value || undefined;
      const about = form.querySelector('[name="about"]')?.value || undefined;
      const parts = await sealed.sealMessage({ secret: keys.secret, author: host.dataset.peer, pair: keys.members, body: plain(form, "body"), replyTo: reply, about });
      fill(form, { sealed_header: parts.header, sealed_ciphertext: parts.ciphertext });
      form.submit();
    } catch (error) {
      say(status, `Nothing was sent: ${error.message}.`);
    }
  });
}

/** A new sealed pair: the secret made here, locked for both KEYS, and the first message sealed. */
function armStart(form, key, passkeys) {
  const status = form.querySelector("[data-seal-status]");
  // Whose key this seals to, by the fingerprint two people compare outside this site.
  const recipient = data(form, "recipient");
  const shown = form.querySelector("[data-recipient-fingerprint]");
  if (recipient && shown) {
    checkedKey(recipient, passkeys).then(async (pk) => {
      say(shown, `This seals to ${recipient.peer_id}'s encryption key, fingerprint ${sealed.groupFingerprint(await sealed.fingerprint(pk))}. Compare it with theirs outside this site.`);
    }, (error) => say(shown, `Their encryption key does not check out: ${error.message}. Nothing can be sealed for them.`));
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const me = host.dataset.peer;
      const other = data(form, "recipient");
      const pkOther = await checkedKey(other, passkeys);
      const secret = sealed.randomBytes(32);
      const container = sealed.pairContainer(sealed.fromHex(me, 32), sealed.fromHex(other.peer_id, 32));
      const c = await sealed.commitment(container, 1, secret);
      const lockFor = (peer, pk) => sealed.sealLock({ container, g: 1, recipient: sealed.fromHex(peer, 32), sender: sealed.fromHex(me, 32), commitment: c, secret, pkR: pk, skS: key.sk }).then(hex);
      const about = form.querySelector('[name="about"]')?.value || undefined;
      const parts = await sealed.sealMessage({ secret, author: me, pair: [me, other.peer_id], body: plain(form, "body"), about });
      fill(form, {
        sealed_commitment: hex(c),
        sealed_locks: JSON.stringify({ [me]: await lockFor(me, key.pk), [other.peer_id]: await lockFor(other.peer_id, pkOther) }),
        sealed_header: parts.header, sealed_ciphertext: parts.ciphertext,
      });
      form.submit();
    } catch (error) {
      say(status, `Nothing was sent: ${error.message}.`);
    }
  });
}

/** A new space, sealed when the person chose it: its id and first key made here, and their own lock. */
function armCreate(form, key) {
  const status = form.querySelector("[data-seal-status]");
  form.addEventListener("submit", async (event) => {
    const visibility = form.querySelector('[name="visibility"]:checked')?.value ?? form.querySelector('[name="visibility"]')?.value;
    if (visibility !== "sealed") return;
    event.preventDefault();
    try {
      const me = host.dataset.peer;
      const spaceId = crypto.randomUUID();
      const container = sealed.spaceContainer(spaceId);
      const first = await sealed.newGeneration(container, 1);
      const lock = await sealed.sealLock({
        container, g: 1, recipient: sealed.fromHex(me, 32), sender: sealed.fromHex(me, 32),
        commitment: first.commitment, secret: first.secret, pkR: key.pk, skS: key.sk,
      });
      fill(form, { sealed_space_id: spaceId, sealed_commitment: hex(first.commitment), sealed_lock: hex(lock) });
      form.submit();
    } catch (error) {
      say(status, `Nothing was made: ${error.message}.`);
    }
  });
}

/** The owner's keeper list, signed with their passkey. */
function armKeepers(form, keys) {
  const status = form.querySelector("[data-seal-status]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const ids = (name) => [...new Set(lines(form.querySelector(`[name="${name}"]`)?.value ?? ""))].sort();
      const listBytes = sealed.keeperListBytes({
        spaceId: keys.st.space_id,
        revision: Number(form.dataset.revision),
        keepers: ids("keepers"),
        admission: form.querySelector('[name="admission"]:checked')?.value ?? "stamped",
        stampers: ids("stampers"),
        changeEvery: Number(form.querySelector('[name="change_every"]')?.value ?? "86400"),
      });
      say(status, "Waiting for your passkey.");
      const signed = await passkeySigns(await sealed.passkeyChallenge(sealed.LABELS.keepers, listBytes));
      fill(form, { sealed_list: sealed.toB64u(listBytes), ...signed });
      form.submit();
    } catch (error) {
      say(status, `Nothing was changed: ${error.message}.`);
    }
  });
}

/** Locks for KEYS the form names, each checked first: for the key in use, and the one
 *  staged; with the commitment each generation's were made for, which the product holds
 *  them to. */
async function locksFor(members, keys, key, passkeys) {
  const me = host.dataset.peer;
  const out = {};
  const commitments = {};
  for (const [g, secret, c] of [
    [keys.generation, keys.secrets.get(keys.generation), sealed.fromHex(keys.st.commitment ?? "", 32)],
    ...(keys.staged?.secret ? [[keys.staged.generation, keys.staged.secret, keys.staged.commitment]] : []),
  ]) {
    if (g === null || !secret) continue;
    const recipients = [];
    for (const m of members) recipients.push({ peer: sealed.fromHex(m.peer_id, 32), pk: m.peer_id === me ? key.pk : await checkedKey(m, passkeys) });
    const locks = await sealed.sealLocks({ container: keys.container, g, sender: sealed.fromHex(me, 32), commitment: c, secret, skS: key.sk, recipients });
    out[String(g)] = Object.fromEntries(members.map((m, i) => [m.peer_id, hex(locks[i])]));
    commitments[String(g)] = hex(c);
  }
  return { locks: out, commitments };
}

/** Admit a join request and hand the newcomer the key, or hand it to members waiting. */
function armLocks(form, keys, key, passkeys) {
  const status = form.querySelector("[data-seal-status]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const members = data(form, "members") ?? [];
      const made = await locksFor(members, keys, key, passkeys);
      fill(form, { sealed_locks: JSON.stringify(made.locks), sealed_commitments: JSON.stringify(made.commitments) });
      form.submit();
    } catch (error) {
      say(status, `Nothing was changed: ${error.message}.`);
    }
  });
}

/** Vouch for one KEY by hand and hand it the key: a stamp this person's passkey signs for
 *  it, as a keeper admitting it by hand, and its locks. With a join request, admitting it. */
function armVouch(form, keys, key, passkeys) {
  const status = form.querySelector("[data-seal-status]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const members = data(form, "members") ?? [];
      if (members.length !== 1) throw new Error("this form vouches for one key");
      const stamp = sealed.stampBytes({ issuer: host.dataset.peer, peerId: members[0].peer_id });
      const made = await locksFor(members, keys, key, passkeys);
      say(status, "Waiting for your passkey.");
      const signed = await passkeySigns(await sealed.passkeyChallenge(sealed.LABELS.stamp, stamp));
      fill(form, { sealed_stamp: sealed.toB64u(stamp), sealed_locks: JSON.stringify(made.locks), sealed_commitments: JSON.stringify(made.commitments), ...signed });
      form.submit();
    } catch (error) {
      say(status, `Nothing was changed: ${error.message}.`);
    }
  });
}

/** Finish a change under way: the new key, which this browser holds by its own lock,
 *  locked for the members vouched for still waiting, and then put in use. */
function armFinish(form, keys, key, passkeys) {
  const status = form.querySelector("[data-seal-status]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      if (!keys.staged?.secret) throw new Error("this browser holds no lock for the new key, so it cannot finish the change: abandon it instead");
      const me = host.dataset.peer;
      const members = data(form, "members") ?? [];
      const recipients = [];
      for (const m of members) recipients.push({ peer: sealed.fromHex(m.peer_id, 32), pk: m.peer_id === me ? key.pk : await checkedKey(m, passkeys) });
      const g = keys.staged.generation;
      const locks = recipients.length
        ? await sealed.sealLocks({ container: keys.container, g, sender: sealed.fromHex(me, 32), commitment: keys.staged.commitment, secret: keys.staged.secret, skS: key.sk, recipients })
        : [];
      fill(form, {
        sealed_locks: JSON.stringify({ [String(g)]: Object.fromEntries(members.map((m, i) => [m.peer_id, hex(locks[i])])) }),
        sealed_commitments: JSON.stringify({ [String(g)]: hex(keys.staged.commitment) }),
      });
      form.submit();
    } catch (error) {
      say(status, `Nothing was changed: ${error.message}.`);
    }
  });
}

/** Change the key now: the next generation made here, with its back link, locked for every member. */
function armChange(form, keys, key, passkeys) {
  const status = form.querySelector("[data-seal-status]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const me = host.dataset.peer;
      const g = keys.generation ?? 0;
      const previous = g > 0 ? keys.secrets.get(g) : undefined;
      if (g > 0 && !previous) throw new Error(keys.waiting ?? "you hold no key to change");
      const next = await sealed.newGeneration(keys.container, g + 1, previous);
      const members = data(form, "members") ?? [];
      const recipients = [];
      for (const m of members) recipients.push({ peer: sealed.fromHex(m.peer_id, 32), pk: m.peer_id === me ? key.pk : await checkedKey(m, passkeys) });
      const locks = await sealed.sealLocks({ container: keys.container, g: g + 1, sender: sealed.fromHex(me, 32), commitment: next.commitment, secret: next.secret, skS: key.sk, recipients });
      fill(form, {
        sealed_generation: String(g + 1), sealed_commitment: hex(next.commitment), sealed_back: next.back ? hex(next.back) : "",
        sealed_locks: JSON.stringify({ [String(g + 1)]: Object.fromEntries(members.map((m, i) => [m.peer_id, hex(locks[i])])) }),
      });
      form.submit();
    } catch (error) {
      say(status, `Nothing was changed: ${error.message}.`);
    }
  });
}

// ── the page ──────────────────────────────────────────────────────────────────

async function main() {
  const me = host.dataset.peer;
  const passkeys = data(host, "passkeys") ?? undefined;
  const held = await takeKey(me, host.dataset.wrap).catch(() => null);
  await panel(held);
  const key = held && held.sk ? held : null;
  const noKey = (why) => {
    for (const el of document.querySelectorAll("[data-seal-status], [data-sealed-item] [data-field=\"state\"]")) say(el, why);
    for (const b of document.querySelectorAll("form[data-seal] button[type=\"submit\"]")) b.disabled = true;
  };
  const forms = [...document.querySelectorAll("form[data-seal]")];
  if (!key) {
    if (document.querySelector("[data-sealed-item], form[data-seal]")) {
      noKey(held?.none
        ? "Sealed. Your passkey gives this site no secret to seal and open with, so not here."
        : "Sealed. Unlock your encryption key on your key's page, and this opens.");
    }
    return;
  }
  for (const form of forms.filter((f) => f.dataset.seal === "create")) armCreate(form, key);
  for (const form of forms.filter((f) => f.dataset.seal === "start")) armStart(form, key, passkeys);
  const ctx = document.getElementById("sealed-context");
  if (!ctx) return;
  let keys;
  try {
    keys = ctx.dataset.kind === "pair" ? await pairKeys(ctx, key, passkeys) : await spaceKeys(ctx, key, passkeys);
  } catch (error) {
    noKey(`Sealed, and not opened here: ${error.message}.`);
    return;
  }
  await openSlots(keys);
  for (const form of forms) {
    const how = form.dataset.seal;
    if (how === "post") armPost(form, keys);
    else if (how === "message") armMessage(form, keys);
    else if (how === "keepers") armKeepers(form, keys);
    else if (how === "locks") armLocks(form, keys, key, passkeys);
    else if (how === "vouch") armVouch(form, keys, key, passkeys);
    else if (how === "finish") armFinish(form, keys, key, passkeys);
    else if (how === "change") armChange(form, keys, key, passkeys);
  }
  if (keys.waiting) {
    for (const el of document.querySelectorAll("[data-sealed-waiting]")) { say(el, keys.waiting); el.hidden = false; }
  }
}

if (host) main();
