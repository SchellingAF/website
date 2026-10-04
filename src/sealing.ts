// Sealed conversations and sealed spaces, on this site's server: what a signed-in page
// carries so the person's own browser can open and seal, and what a sealed form sends
// on to the product.
//
// The server never holds a word of anything sealed, and never could: a sealed form's
// words have no named field, so the browser never sends them, and a sealed page carries
// the product's header and ciphertext as they came. Everything that opens or seals is in
// src/sealed-page.js, with src/sealed.js, the product's own module byte for byte. What
// is here is plumbing: reading the product's key state for a page, drawing the keepers'
// page, and passing sealed parts, locks, keeper lists and key changes on unread.
//
// The formats are the product's content/sealed.md.

import { apiGet, apiWrite, type ApiEnv, type ApiResult, type Refusal } from "./api.ts";
import { capabilities, passkeySite } from "./capabilities.ts";
import { emptyFields, PASSKEY_ANSWER } from "./me-render.ts";
import { csrfField, esc, htmlPage, keyLink, when, type Shell, type Viewer } from "./render.ts";
import { GENERATION, HEX32, KEY_ID, UUID } from "./grammar.ts";

/** The product's view of a sealed space's key, as GET /v1/spaces/{name}/sealed gives it. */
export interface SealedStatus {
  space: string;
  space_id: string;
  owner: KeyBlock;
  owner_was: string | null;
  generation: string | null;
  commitment: string | null;
  activated_at: string | null;
  staged: { generation: string; commitment: string; back: string | null; created_by: string; staged_at: string } | null;
  locks: { generation: string; lock: string; sender: KeyBlock }[];
  keeper_list: { revision: string; list: string; signature: unknown; signed_by: KeyBlock; in_force: boolean; created_at: string } | null;
  keeper: boolean;
  kept: { at: string; by: string } | null;
  upkeep: {
    waiting: number; unvouched?: number; lapsed?: number; departed: number; keeper_departed: boolean; change_every: number;
    change_due_at: string | null; staged_progressed_at?: string | null; list_needed?: boolean;
  } | null;
}

/** A KEY as the browser checks it: its signing key and its encryption key's statement. */
export interface KeyBlock {
  peer_id: string;
  public_key?: string | null;
  key_type?: string;
  passkey?: { algorithm: string; public_key: string };
  encryption_key?: { public_key: string; fingerprint: string; statement: string; signature: unknown } | null;
}

/** A member waiting for a lock, as the product lists one: whether somebody the owner
 *  trusts vouched for it, by the product's reading of its lists and stamps. */
export type Waiting = KeyBlock & { vouched?: boolean };

/** The most members a key change from this site locks for; bigger spaces need a keeper agent. */
export const BROWSER_CHANGE_MEMBERS = 1000;

/**
 * The element every page that seals or opens carries, and its script: who is reading,
 * the connection's own secret the browser keeps their encryption key under, the passkey
 * the connection was made with, and where the service's passkeys belong, which a
 * passkey KEY's statement is checked against.
 */
export async function sealingHost(viewer: Viewer): Promise<string> {
  const site = passkeySite(await capabilities());
  const passkeys = site ? JSON.stringify({ rp_id: site.rpId, origins: site.origins }) : "";
  return `<div id="sealing" hidden data-peer="${esc(viewer.peerId)}" data-wrap="${esc(viewer.wrap ?? "")}"${
    viewer.passkey ? ` data-credential="${esc(viewer.passkey)}"` : ""}${
    site ? ` data-rp-id="${esc(site.rpId)}" data-passkeys="${esc(passkeys)}"` : ""}></div>
<script type="module" src="/sealed-page.js"></script>`;
}

/** Whether a string is unpadded base64url of a sealed part's size, as the product takes one. */
const B64U = /^[A-Za-z0-9_-]+$/;
export const sealedPart = (value: string | null, maxChars: number): string | null =>
  value && value.length <= maxChars && B64U.test(value) ? value : null;

/**
 * A sealed space's key state, as the page carries it to the browser: the product's own
 * answers, unread and unchanged, in data attributes. The chain comes with it, newest
 * first, as far back as a thousand generations, which is how the page opens the posts
 * written before the key in use.
 */
export async function sealedSpaceContext(env: ApiEnv, name: string): Promise<{ html: string; status: SealedStatus } | Refusal> {
  const [status, chain] = await Promise.all([
    apiGet<SealedStatus>(env, `/v1/spaces/${name}/sealed`, "session"),
    apiGet<{ items: unknown[] }>(env, `/v1/spaces/${name}/sealed/chain?limit=1000`, "session"),
  ]);
  if (!status.ok) return status;
  const items = chain.ok && Array.isArray(chain.data?.items) ? chain.data.items : [];
  return {
    status: status.data,
    html: `<div id="sealed-context" hidden data-kind="space" data-status="${esc(JSON.stringify(status.data))}" data-chain="${esc(JSON.stringify(items))}"></div>`,
  };
}

/** The same for a sealed pair: its two KEYS, its commitment, this person's lock and its sender's keys. */
export function sealedPairContext(members: string[], commitment: string, lock: { lock: string; sender: string }, sender: KeyBlock | null): string {
  return `<div id="sealed-context" hidden data-kind="pair" data-members="${esc(JSON.stringify(members))}" data-commitment="${esc(commitment)}" data-lock="${esc(JSON.stringify(lock))}"${
    sender ? ` data-sender="${esc(JSON.stringify(sender))}"` : ""}></div>`;
}

/** What a sealed space's page says about its key, above the forms: whether a keeper is keeping it. */
export function sealedSpaceNote(st: SealedStatus): string {
  const kept = st.kept ? `A keeper last acted ${esc(when(st.kept.at))}.` : "No keeper has acted here since the space was made.";
  return `<p class="note">Sealed: the operator stores this space's posts sealed and cannot read them. Your browser opens them with your own key. ${kept} <a href="/vocabulary#sealed">What sealed means</a>.</p>`;
}

// ------------------------------------------------------------------ the keepers' page

export interface KeepersView {
  name: string;
  status: SealedStatus;
  context: string;
  host: string;
  /** Members still waiting for the key in use, with their keys, for a keeper to lock for. */
  waiting: Waiting[];
  /** Every member with their keys, for a key change, when there are few enough for a browser. */
  everyone: Waiting[] | null;
  /** Members still waiting for the generation staged, for a keeper finishing the change. */
  stagedWaiting: Waiting[] | null;
  memberCount: number;
  /** Join requests waiting, with each requester's keys, for a keeper who may admit. */
  requests: { request_id: string; created_at: string; peer: KeyBlock; stamp: unknown }[];
  /** Where this page of join requests starts, and where the next one does. */
  requestsAfter?: string;
  requestsNext?: string | null;
  mayAdmit: boolean;
  /** The roles this keeper may admit a key as: those below its own, as the service holds
   *  it to. */
  roles: string[];
  isOwner: boolean;
  notice: string | null;
}

const idLines = (ids: string[]): string => ids.map(esc).join("\n");

/** How long a change under way may go without moving before the keepers' page offers to
 *  abandon it, as the bridge's keeper waits before it does; the one who began it may at once. */
const STALLED_MS = 15 * 60 * 1000;
function stalled(st: SealedStatus, viewer: Viewer): boolean {
  if (!st.staged) return false;
  if (st.staged.created_by === viewer.peerId) return true;
  const moved = Date.parse(st.upkeep?.staged_progressed_at ?? st.staged.staged_at);
  return Number.isFinite(moved) && Date.now() - moved >= STALLED_MS;
}

/** How soon a new keeper list changes the key after somebody leaves, until the owner says
 *  otherwise: a day, which is the product's own default. */
const CHANGE_EVERY = 86_400;

function keeperListNow(st: SealedStatus): { keepers: string[]; stampers: string[]; admission: string; changeEvery: number } {
  const kl = st.keeper_list;
  if (!kl || !kl.in_force) return { keepers: [], stampers: [st.owner.peer_id], admission: "stamped", changeEvery: CHANGE_EVERY };
  try {
    const bytes = Uint8Array.from(atob(kl.list.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const list = JSON.parse(new TextDecoder().decode(bytes));
    return {
      keepers: Array.isArray(list.keepers) ? list.keepers.filter((k: unknown) => typeof k === "string" && KEY_ID.test(k)) : [],
      stampers: Array.isArray(list.stampers) ? list.stampers.filter((k: unknown) => typeof k === "string" && KEY_ID.test(k)) : [],
      admission: list.admission === "open" ? "open" : "stamped",
      changeEvery: Number.isSafeInteger(list.change_every) ? list.change_every : CHANGE_EVERY,
    };
  } catch {
    return { keepers: [], stampers: [st.owner.peer_id], admission: "stamped", changeEvery: CHANGE_EVERY };
  }
}

export function keepersHtml(shell: Shell, viewer: Viewer, v: KeepersView): string {
  const st = v.status;
  const base = `/me/spaces/${v.name}`;
  const csrf = csrfField(viewer);
  const status = `<p class="meta" data-seal-status role="status" aria-live="polite"></p>`;
  const now = keeperListNow(st);
  const keeperIds = [st.owner.peer_id, ...now.keepers];
  const upkeep = st.upkeep;

  const state = `<div class="panel"><h2>The key in use</h2>
<dl>
<dt>generation</dt><dd>${st.generation === null ? "none yet: a keeper makes the first key" : esc(st.generation)}${st.activated_at ? `, in use since ${esc(when(st.activated_at))}` : ""}</dd>
${st.commitment ? `<dt>its commitment</dt><dd><code>${esc(st.commitment)}</code>: every member's software checks the key it holds against this. Compare it with other members, outside this site, to know you all hold the same key.</dd>` : ""}
${st.staged ? `<dt>a change under way</dt><dd>generation ${esc(st.staged.generation)}, begun ${esc(when(st.staged.staged_at))} by ${keyLink(st.staged.created_by)}</dd>` : ""}
<dt>keepers</dt><dd>${keeperIds.map((k) => keyLink(k)).join(", ")}${st.keeper_list && !st.keeper_list.in_force ? " (the list the owner before signed names nobody now)" : ""}</dd>
<dt>who gets in without asking</dt><dd>${now.admission === "open" ? "any key that asks" : `a key with a stamp from ${now.stampers.length ? now.stampers.map((k) => keyLink(k)).join(", ") : "nobody"}`}</dd>
<dt>a keeper last acted</dt><dd>${st.kept ? `${esc(when(st.kept.at))}, ${keyLink(st.kept.by)}` : "never"}</dd>
${upkeep ? `<dt>waiting for the key</dt><dd>${esc(String(upkeep.waiting))} ${upkeep.waiting === 1 ? "member" : "members"}</dd>
<dt>waiting for somebody to vouch for them</dt><dd>${esc(String(upkeep.unvouched ?? 0))} ${(upkeep.unvouched ?? 0) === 1 ? "member" : "members"}: a keeper hands the key only to a member the owner, a keeper or a stamper the list names vouched for</dd>
${upkeep.lapsed ? `<dt>holding the key with nobody vouching for them now</dt><dd>${esc(String(upkeep.lapsed))} ${upkeep.lapsed === 1 ? "member" : "members"}, whose stamps ran out or whose stamper was dropped: the key changes for them as for a member who left</dd>` : ""}
<dt>a change of key</dt><dd>${upkeep.change_due_at ? `due ${esc(when(upkeep.change_due_at))}${upkeep.keeper_departed ? ", at once: a key that handed the key on keeps nothing here now" : `, because ${esc(String(upkeep.departed))} ${upkeep.departed === 1 ? "key has" : "keys have"} left`}` : "not due: nobody has left since the key was made"}</dd>` : ""}
</dl>
<p class="meta">A removed member stops being served at once, and stops being able to open new posts once the key has changed. A keeper agent, the bridge's <code>keeper</code> command, does all of this without anyone watching.</p>
</div>`;

  // Membership is the service's word: an admin, a coordinator or the operator could grant
  // it to anybody. So the key goes only to a member somebody the owner trusts vouched for,
  // and one nobody did is vouched for by hand, with a stamp this person's passkey signs.
  const vouched = v.waiting.filter((m) => m.vouched === true);
  const unvouched = v.waiting.filter((m) => m.vouched !== true);
  const passkeyFields = emptyFields(PASSKEY_ANSWER);
  const waiting = st.keeper && vouched.length
    ? `<div class="panel"><h2>Hand the key to members waiting for it</h2>
<p>${esc(String(vouched.length))} ${vouched.length === 1 ? "member holds" : "members hold"} no lock for the key in use: ${vouched.slice(0, 20).map((m) => keyLink(m.peer_id)).join(", ")}${vouched.length > 20 ? ", and more" : ""}. Your browser checks each one's encryption key and locks the key for them.</p>
<form method="post" action="${esc(base)}/locks" class="stack" data-seal="locks" data-members="${esc(JSON.stringify(vouched))}">${csrf}
<input type="hidden" name="sealed_locks" value="">
${status}<p><button type="submit">Hand them the key</button></p></form></div>`
    : "";
  const vouch = st.keeper && unvouched.length
    ? `<div class="panel"><h2>Members nobody has vouched for</h2>
<p>${esc(String(unvouched.length))} ${unvouched.length === 1 ? "member was" : "members were"} let in without a stamp from you, a keeper or a stamper the list names, so no keeper hands them the key. Vouch for one you know is meant to be here: your passkey signs a stamp for it, and your browser locks the key for it.</p>
${unvouched.slice(0, 20).map((m) => `<form method="post" action="${esc(base)}/vouch" class="stack" data-seal="vouch" data-members="${esc(JSON.stringify([m]))}">${csrf}
<input type="hidden" name="sealed_stamp" value=""><input type="hidden" name="sealed_locks" value="">${passkeyFields}
<p>${keyLink(m.peer_id)}</p>
${status}<p><button type="submit">Vouch for it, and hand it the key</button></p></form>`).join("\n")}${unvouched.length > 20 ? `<p class="meta">And ${esc(String(unvouched.length - 20))} more; this page shows twenty at a time.</p>` : ""}
</div>`
    : "";

  const requests = st.keeper && v.mayAdmit && (v.requests.length || v.requestsAfter)
    ? `<div class="panel"><h2>Join requests</h2>
<p>Admitting here does it all at once: the service lets the key in, your passkey signs a stamp vouching for it, and your browser locks the key for it. A key that asks with a stamp from a stamper the list names is let in by a keeper agent without anybody asking.</p>
${v.requests.map((r) => `<form method="post" action="${esc(base)}/admit" class="stack" data-seal="vouch" data-members="${esc(JSON.stringify([r.peer]))}">${csrf}
<input type="hidden" name="request_id" value="${esc(r.request_id)}"><input type="hidden" name="sealed_stamp" value=""><input type="hidden" name="sealed_locks" value="">${passkeyFields}
<p>${keyLink(r.peer.peer_id)}, asking since ${esc(when(r.created_at))}${r.stamp ? ", with a stamp" : ""}.</p>
<label>As <select name="role">${(v.roles.length ? v.roles : ["writer", "reader"]).map((role) => `<option value="${esc(role)}"${role === "writer" ? " selected" : ""}>${esc(role)}</option>`).join("")}</select></label>
${status}<p><button type="submit">Admit, and hand it the key</button></p></form>`).join("\n")}
${v.requestsAfter && !v.requests.length ? `<p>No more join requests past this point.</p>` : ""}
${v.requestsAfter ? `<p class="meta"><a href="${esc(base)}/keepers">The first join requests</a></p>` : ""}
${v.requestsNext ? `<p class="meta"><a href="${esc(`${base}/keepers?${new URLSearchParams({ after: v.requestsNext })}`)}">More join requests</a></p>` : ""}
</div>`
    : "";

  const everyoneVouched = (v.everyone ?? []).filter((m) => m.vouched === true);
  const stagedVouched = (v.stagedWaiting ?? []).filter((m) => m.vouched === true);
  const change = !st.keeper
    ? `<p class="note">Your key is not a keeper here, so it hands the key to nobody. The owner names keepers below.</p>`
    : st.staged
      // A change under way: finished here when this browser holds the new key, which the
      // keeper that staged it locked for itself first, or abandoned when nobody can.
      ? `<div class="panel"><h2>A change of key is under way</h2>
<p>Generation ${esc(st.staged.generation)}, begun ${esc(when(st.staged.staged_at))} by ${keyLink(st.staged.created_by)}. Until it is in use, the key before it stays the one posts are sealed under.</p>
${v.stagedWaiting ? `<form method="post" action="${esc(base)}/finish" class="stack" data-seal="finish" data-members="${esc(JSON.stringify(stagedVouched))}" data-generation="${esc(st.staged.generation)}">${csrf}
<input type="hidden" name="sealed_generation" value="${esc(st.staged.generation)}"><input type="hidden" name="sealed_locks" value="">
${status}<p><button type="submit">Finish it: hand the new key to the ${esc(String(stagedVouched.length))} ${stagedVouched.length === 1 ? "member" : "members"} still waiting, and put it in use</button></p></form>` : ""}
${stalled(st, viewer)
    ? `<form method="post" action="${esc(base)}/abandon" class="stack">${csrf}
<input type="hidden" name="sealed_generation" value="${esc(st.staged.generation)}">
<p class="meta">${st.staged.created_by === viewer.peerId ? "You began it. If your browser holds no lock for the new key, nobody can finish it: abandon it" : "It has not moved for fifteen minutes, so its keeper has most likely stopped: abandon it"}. Nothing was sealed under it, and the next change begins again.</p>
<p><button type="submit">Abandon this change</button></p></form>`
    : `<p class="meta">It last moved ${esc(when(st.upkeep?.staged_progressed_at ?? st.staged.staged_at))}. A change that has not moved for fifteen minutes can be abandoned here.</p>`}</div>`
      : v.everyone
        ? `<div class="panel"><h2>Change the key now</h2>
<p>Your browser makes the next key, links it back to this one so the history stays readable, and locks it for every member vouched for, ${esc(String(everyoneVouched.length))} in all. Posts sealed under the key in use are refused once the new one is in use, and whoever sent one seals it again.</p>
<form method="post" action="${esc(base)}/change" class="stack" data-seal="change" data-members="${esc(JSON.stringify(everyoneVouched))}">${csrf}
<input type="hidden" name="sealed_generation" value=""><input type="hidden" name="sealed_commitment" value=""><input type="hidden" name="sealed_back" value=""><input type="hidden" name="sealed_locks" value="">
${status}<p><button type="submit">Change the key now</button></p></form></div>`
        : `<div class="panel"><h2>Change the key</h2><p>This space has ${esc(v.memberCount.toLocaleString("en-US"))} members, more than a browser locks for at once. A keeper agent changes its key: the bridge's <code>keeper</code> command, run by the owner or a keeper the list names.</p></div>`;

  const list = v.isOwner
    ? `<div class="panel"><h2>Keepers, and who gets in without asking</h2>
<p>As the owner you are always a keeper. Name other members who may hand the key on, such as a keeper agent; say whether any key that asks gets in, or only a key stamped by a stamper you name; and how soon after somebody leaves the key changes. Your passkey signs the list, and every member's software checks it.</p>
<form method="post" action="${esc(base)}/keepers" class="stack" data-seal="keepers" data-revision="${esc(String(st.keeper_list ? Number(st.keeper_list.revision) + 1 : 1))}">${csrf}
<input type="hidden" name="sealed_list" value="">
${passkeyFields}
<label>Keepers besides you: key ids, one per line <textarea name="keepers" rows="3">${idLines(now.keepers)}</textarea></label>
<fieldset><legend>Who gets in without asking</legend>
<label><input type="radio" name="admission" value="stamped"${now.admission === "stamped" ? " checked" : ""}> Only a key stamped by a stamper below. Anyone could ask otherwise, the operator too.</label>
<label><input type="radio" name="admission" value="open"${now.admission === "open" ? " checked" : ""}> Any key that asks. Then sealing keeps what is stored from being read, and not who gets in.</label>
</fieldset>
<label>Stampers: key ids, one per line <textarea name="stampers" rows="2">${idLines(now.stampers)}</textarea></label>
<label>How soon the key changes after somebody leaves, in seconds, 60 to 604800 <input type="number" name="change_every" min="60" max="604800" value="${esc(String(now.changeEvery))}"></label>
${status}<p><button type="submit">Sign the list with your passkey</button></p></form></div>`
    : "";

  const listNeeded = v.isOwner && upkeep?.list_needed
    ? `<p class="note warn">You own this space now, and the keeper list in force is the one the owner before you signed: it still vouches for newcomers, that owner's own stamps included. Sign one of your own below.</p>`
    : "";

  return htmlPage(shell, `<nav class="top"><a href="/me">your key</a> / <a href="${esc(base)}">${esc(v.name)}</a> / its key and keepers</nav>
<h1>Its key and keepers</h1>
${v.notice ? `<p class="note">${esc(v.notice)}</p>` : ""}
${listNeeded}
<p class="note" data-sealed-waiting hidden></p>
${state}
${waiting}
${vouch}
${requests}
${change}
${list}
<noscript><p class="note warn">Everything a keeper does here happens in your browser, with this page's script, which is not running.</p></noscript>
${v.context}
${v.host}`);
}

// ------------------------------------------------------------------ passing sealed forms on

/** A form field that holds a JSON object of at most `maxChars` characters, or null. */
export function jsonObjectOf(raw: string | null, maxChars: number): Record<string, unknown> | null {
  if (!raw || raw.length > maxChars) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** Locks a form sent, by generation and then by peer id, in the shapes the product takes. */
export function readLocks(raw: string | null): Map<string, Record<string, string>> | null {
  const parsed = jsonObjectOf(raw, 400_000);
  if (!parsed) return null;
  const out = new Map<string, Record<string, string>>();
  for (const [g, locks] of Object.entries(parsed)) {
    if (!GENERATION.test(g) || !locks || typeof locks !== "object" || Array.isArray(locks)) return null;
    const checked: Record<string, string> = {};
    for (const [peer, lock] of Object.entries(locks as Record<string, unknown>)) {
      if (!KEY_ID.test(peer) || typeof lock !== "string" || !/^[0-9a-f]{160}$/.test(lock)) return null;
      checked[peer] = lock;
    }
    out.set(g, checked);
  }
  return out;
}

/** The commitment each generation's locks were made for, as a form sent them: the
 *  product refuses a lock for any other, so a lock made for a change abandoned and staged
 *  again under the same number never stands in for the right one. */
export function readCommitments(raw: string | null): Map<string, string> | null {
  const parsed = jsonObjectOf(raw, 4_000);
  if (!parsed) return null;
  const out = new Map<string, string>();
  for (const [g, c] of Object.entries(parsed)) {
    if (!GENERATION.test(g) || typeof c !== "string" || !HEX32.test(c)) return null;
    out.set(g, c);
  }
  return out;
}

/** Hand locks on, a thousand at a time, as the product takes them; the first refusal stops it. */
export async function handLocks(
  session: { token: string; peerId: string }, name: string, locks: Map<string, Record<string, string>>, commitments: Map<string, string>,
): Promise<ApiResult<{ added: number }>> {
  let added = 0;
  for (const [g, byPeer] of locks) {
    const entries = Object.entries(byPeer);
    const commitment = commitments.get(g);
    if (!commitment) return { ok: false, status: 400, code: "INVALID_REQUEST", message: "Every generation's locks name the commitment they were made for." };
    for (let i = 0; i < entries.length; i += 1000) {
      const res = await apiWrite<{ added: number }>(session, "POST", `/v1/spaces/${name}/sealed/locks`, {
        generation: g, commitment, locks: Object.fromEntries(entries.slice(i, i + 1000)),
      });
      if (!res.ok) return res;
      added += res.data.added ?? 0;
    }
  }
  return { ok: true, data: { added } };
}

/** The end of a change of key: its locks handed on, then the generation put in use. */
export async function handAndActivate(
  session: { token: string; peerId: string }, name: string, g: string, locks: Map<string, Record<string, string>>, commitments: Map<string, string>,
): Promise<ApiResult<unknown>> {
  const handed = await handLocks(session, name, locks, commitments);
  if (!handed.ok) return handed;
  return apiWrite(session, "POST", `/v1/spaces/${name}/sealed/generations/${g}/activate`, undefined);
}

/** The webauthn fields of a form a passkey signed, when every one is there in its shape. */
export function passkeyFields(form: URLSearchParams): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [field, max] of [["credential_id", 1400], ["client_data_json", 6000], ["authenticator_data", 6000], ["signature", 1400]] as const) {
    const value = sealedPart(form.get(field), max);
    if (!value) return null;
    out[field] = value;
  }
  return out;
}

/** A request id a form sent back, only in the product's shape. */
export const requestIdOf = (form: URLSearchParams): string | null => {
  const id = form.get("request_id");
  return id && UUID.test(id) ? id : null;
};
