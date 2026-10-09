// What the signed-in pages share: the responses they send, what a form sent, and a
// refusal in a person's words.
//
// src/me.ts and src/messages.ts both answer signed-in addresses and share these.
// They live here because src/me.ts imports src/messages.ts, so neither file could
// hold them for the other. Nothing here finds a session or sends
// a request to the product.

import type { ApiEnv, Refusal } from "./api.ts";
import { formShell, resultHtml } from "./me-render.ts";
import type { Shell, Viewer } from "./render.ts";
import type { Session } from "./session.ts";
import { HAND_OVER_CODE, INVITE_CODE, LINK_CODE, MEDIA_TYPE, NAME, SPACE_NAME, visibleName } from "./grammar.ts";
import { titleWords } from "./post-object.js";

/** What src/messages.ts, src/export.ts and src/connect.ts need from src/me.ts: the
 *  session's reads, and a refusal that can end the session behind a dead token. */
export interface SignedInContext {
  url: URL;
  /** The request's environment with this session's token, for reading. */
  env: ApiEnv;
  session: Session;
  viewer: Viewer;
  /** A refusal in a person's words, with where to go next; a dead connection goes
   *  back to the connect page. From src/me.ts, which holds the request and so can
   *  end the session. */
  refused(res: Refusal, links: [string, string][]): Response;
}

// ------------------------------------------------------------------ responses

export function see(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

export function html(body: string): Response {
  return page(body, 200);
}

export function page(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** A file to save rather than a page to show: its bytes, its type, and the name a
 *  browser saves it under, held to a plain shape. src/index.ts adds this family's
 *  policy headers to it as to any page here. */
export function download(bytes: Uint8Array<ArrayBuffer>, type: string, filename: string): Response {
  const name = /^[a-z0-9][a-z0-9.-]{0,200}$/.test(filename) ? filename : "export.ndjson";
  return new Response(bytes, { status: 200, headers: { "content-type": type, "content-disposition": `attachment; filename="${name}"` } });
}

/** A space the operator withheld, on a signed-in page that would have shown it. */
export const withheldPage = (shell: Shell, name: string): Response =>
  page(resultHtml(shell, "Withheld", `The space ${name} is withheld by the operator.`, [["/me", "Your key"]]), 404);

export function notAllowed(allow: string): Response {
  return new Response("405 Method Not Allowed\n", { status: 405, headers: { Allow: allow, "content-type": "text/plain; charset=utf-8" } });
}

// ------------------------------------------------------------------ refusals

export function forbidden(viewer: Viewer | undefined, detail: string): Response {
  return page(resultHtml(formShell("Refused", viewer), "Refused", detail, [["/me", "Your key"]], true), 403);
}

/** A form this site did not send. */
export function badForm(viewer: Viewer, detail = "That form was not one this site sent. Nothing was changed."): Response {
  return page(resultHtml(formShell("Refused", viewer), "Not done", detail, [["/me", "Your key"]], true), 400);
}

export function statusFor(res: Refusal): number {
  if (res.status >= 400 && res.status < 500) return res.status;
  return 503;
}

/** The text fields the service refuses by name alone when they are empty or too long,
 *  in the words a form labels them with. */
const TEXT_FIELDS: Record<string, string> = {
  title: "The title",
  summary: "The summary",
  description: "What it is for",
  message: "The note",
  body: "The text",
  label: "The label",
};

/** A refusal the service explains in a detail of its own words, put into a person's:
 *  the rules of the product's open write. */
const DETAIL_WORDS: Record<string, string> = {
  "join_policy open is for a public work space": "Only a public work space takes posts from any key without joining, so nothing was changed.",
  "every version and every decision of an oracle space stays in public": "Every version of an oracle space's document, and every decision on one, stays readable, so nothing was hidden.",
  "a KEY with no role here addresses only the owner with to": "A key with no role in this space can send its post to the owner's mailbox as well, and to no other key's. Everyone who reads the space reads the post either way. Nothing was posted.",
};

/**
 * Too many posts in a short time, with the service's own numbers: a key's writes a minute,
 * and where it holds no role, its posts a day, its first day's, and a space's from all such
 * keys. The refusal alone does not say which was reached, so each number the capability
 * document states is said, and none is typed here.
 */
export function postLimitWords(caps: { rate_limits?: Record<string, unknown> }): string {
  const R = (caps.rate_limits ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const n = (v: unknown): string | null => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number).toLocaleString("en-US") : null);
  const minute = n(R.writes_per_peer?.per_minute);
  const day = n(R.open_posts_per_peer?.per_day);
  const first = n(R.open_posts_per_peer?.first_day);
  const space = n(R.open_posts_per_space?.per_day);
  const said = [
    minute ? `A key writes at most ${minute} times a minute.` : "",
    day ? `Where it holds no role, it posts at most ${day} times a day${first ? `, and ${first} on its first day` : ""}.` : "",
    space ? `A work space any key posts in takes at most ${space} posts a day from keys that hold no role in it.` : "",
  ].filter(Boolean);
  return `Too many posts in a short time, so nothing was posted.${said.length ? ` ${said.join(" ")}` : ""} Wait, and try again later.`;
}

export function refusalText(res: Refusal): string {
  const detail = res.detail ? ` The service says: ${res.detail}.` : "";
  switch (res.code) {
    case "READ_DENIED": return "Your key holds no role in this space.";
    case "WRITE_DENIED": return "Your key may not post in this space.";
    case "WRITE_BLOCKED": return "The owner or an admin of this space has blocked your key from posting in it, and from asking to join it. Nothing was sent. You can still read it.";
    case "CONTROL_DENIED": return "Your role does not reach that. Each role reaches only the roles below it: the owner every member, an admin coordinators, writers and readers, and a coordinator the writers and readers it brought in. Nobody changes their own role.";
    case "SPACE_NOT_FOUND": return "There is no space by that name.";
    case "SPACE_NAME_TAKEN": return "That name is taken. Space names are permanent and never released.";
    case "NAME_RESERVED": return "That name is reserved. Choose another.";
    case "KEY_TOO_NEW": return "This key is too new to create a public space yet; how long it must wait is on the Vocabulary page. Create the space as private now, or create the public one later.";
    case "CREDIT_NEEDED": return "This write needs credit: with it, a day of this space's storage costs more than its balance. Nothing was posted. Anyone can add credit on its funding page; everything in it can still be read.";
    case "SPACE_CLOSED": return "This space is closed. Nothing more is written to it.";
    case "JOIN_BY_INVITE_ONLY": return "This space takes new members by invite link or code only. Message the owner or an admin, listed on its page under who to ask, to ask for an invite link.";
    case "INVITE_INVALID": return "That link or code is not one for this space: it may be mistyped, or made for another space. Nothing was joined. Ask whoever gave it to you for a fresh one.";
    case "INVITE_REVOKED": return "That link was revoked, or whoever made it can no longer let anybody in with it. Nothing was joined. Ask whoever gave it to you for a new one.";
    case "INVITE_EXPIRED": return "That link has expired. Nothing was joined. Ask whoever gave it to you for a new one.";
    case "INVITE_EXHAUSTED": return "That link has been used as many times as it may be. Nothing was joined. Ask whoever gave it to you for a new one.";
    case "INVITE_LIMIT": return "You have as many working links in this space as a key may. Revoke one you no longer need: one link can let in any number of keys.";
    case "INVITE_NOT_FOUND": return "No link or offer of yours has that id, or it is not yours to change.";
    case "PEER_NOT_REGISTERED": return "That key has never registered here, so nothing can be offered or given to it.";
    case "OWNER_CANNOT_LEAVE": return "An owner cannot simply leave its space: hand the space over instead, and you leave when your successor takes it.";
    case "HAND_OVER_UNREACHABLE": return "An offer reaches only a key that knows you, one you share a space or a conversation with, and that does not block you. Nothing was offered. Make a hand-over link instead, and give it to your successor yourself.";
    case "REQUEST_PENDING": return "Your earlier join request is still waiting for a decision.";
    case "RATE_LIMITED": return "Too much in a short time. Wait a minute and try again.";
    case "BUSY": return "The service is busy. Try again in a moment.";
    case "SERVICE_READ_ONLY": return "The service is being repaired and takes no changes right now. Reading still works.";
    case "INVALID_KIND": return "That kind of post is not one the service knows.";
    case "TITLE_REQUIRED": return `${titleWords(null)} Nothing was posted.`;
    case "INVALID_CATEGORY": return `That is not a category a space can be filed under.${detail}`;
    case "INVALID_ROLE": return "That role cannot be given here.";
    case "INVALID_TAGS":
    case "TAG_RESERVED": return "One of those tags is not allowed. A tag is lowercase with no spaces, is given once, and is never a role's name or a word that claims authority. Nothing was changed.";
    case "CONVERSATION_NOT_FOUND": return "There is no conversation you are in at that address.";
    case "MESSAGES_NOT_ACCEPTED": return "That key does not accept messages from you. Nothing was sent, and nothing you change will get a message to it.";
    case "MESSAGE_REQUEST_WAITING": return "Your first message to that key is still a message request. You cannot send it more until it accepts.";
    case "MESSAGE_REQUEST_LIMIT": return "This key has started as many message requests as it may for now: 20 a day, and 5 on its first day. A key you share a space with needs no request.";
    case "BLOCKED_BY_YOU": return "You block that key. Unblock it in your message settings before you message it.";
    case "BLOCK_LIMIT": return "You block as many keys as a key may. Unblock one first.";
    case "NOT_A_REQUEST": return "That conversation is not a message request waiting for you.";
    case "CONVERSATION_LEFT": return "You left or declined this group, so you cannot write in it. Start a new message instead.";
    case "PAIR_CANNOT_BE_LEFT": return "A conversation between two keys cannot be left. Delete it from your list, or block the other key.";
    case "MESSAGE_NOT_FOUND": return "The message this answers is not in this conversation any more.";
    case "RECIPIENT_NOT_REGISTERED": return `One of those keys has never registered here, so it cannot be messaged.${detail}`;
    case "PEER_NOT_FOUND": return "No key has that id.";
    case "IDEMPOTENCY_CONFLICT": return "That form was already used to send something else. Reload the page and write it again.";
    case "SIGNATURE_REQUIRED": return "This space accepts signed posts only, and that post was not signed. Nothing was posted. Signing needs this page's script and a passkey: press the button again and let your browser ask for it.";
    case "POST_SIGNATURE_INVALID": return `Your passkey's signature on that post did not check out, so nothing was posted.${detail}`;
    case "PASSKEYS_UNAVAILABLE": return "The service is not accepting passkeys right now, so a signed post cannot be sent. Try again later, or send it unsigned where the space allows.";
    case "NOT_AN_ORACLE": return "This space is a work space, not an oracle space, so it has no document to propose a version of or to watch.";
    case "VERSION_CHANGED": return "Another version became the document while you were editing, so yours was not proposed. Open the space again, make your change to the text it shows now, and propose it again.";
    case "PROPOSAL_LIMIT": return `Too many proposals are waiting here: three of your own in one oracle space, or a hundred in all. Wait for a decision, which reaches your mailbox, or say it in the discussion instead.${detail}`;
    case "PROPOSAL_SELF_CONFIRM": return "Your key wrote this proposal, so it cannot confirm it. Other writers confirm it, or the owner, an admin or a coordinator approves it.";
    case "PROPOSAL_ALREADY_CONFIRMED": return "Your key confirmed this proposal already. Nothing more to do: your confirmation stands while you hold the role of a writer or above.";
    case "PROPOSAL_DECIDED": return `That proposal was decided already, or went out of date, so nothing was changed. Its history says what became of it.${detail}`;
    case "WATCH_LIMIT": return `No more watches can be added: a key watches at most 200 documents, and a document has at most 10,000 watchers. Stop watching one first.${detail}`;
    case "REVISION_TARGET_NOT_FOUND": return "Only a post of yours in this space can be replaced or retracted, and the version a proposal edits must be one of this document's versions.";
    case "REPLY_TARGET_NOT_FOUND": return "The post this answers is not in this space.";
    case "SPACE_SEALED": return "This space is sealed, so it takes only posts sealed in your browser, and that one was not. Nothing was posted. Sealing needs this page's script and your encryption key: see Sealing on your key's page.";
    case "SPACE_NOT_SEALED": return "This space is not sealed, so it takes no sealed post. Nothing was posted.";
    case "KEY_CHANGED": return "The space's key changed while you were writing, so what you sealed was sealed under a key no longer in use. Nothing was stored. Reload the page and send it again.";
    case "NOT_A_KEEPER": return "Only a keeper hands out a sealed space's key: its owner, and the members the owner's keeper list names. Nothing was changed.";
    case "KEEPER_LIST_STALE": return "Somebody signed a newer keeper list while this page was open. Nothing was changed. Reload the page and sign again.";
    case "KEY_CHANGE_STAGED": return "A change of this space's key is already under way, and only one runs at a time. Nothing was changed; its keepers' page says where it stands.";
    case "LOCKS_MISSING": return `Some members vouched for hold no lock for the new key yet, so it was not put in use.${detail} Reload the keepers' page, hand the key to whoever waits, and try again.`;
    case "LOCK_RECIPIENT_NOT_A_MEMBER": return "A lock was for a key that is not in this space. Admit it first. Nothing was stored.";
    case "LOCK_RECIPIENT_NOT_VOUCHED": return "A lock was for a key nobody the owner trusts has vouched for: the owner, a keeper or a stamper the keeper list names. Vouch for it from the keepers' page first. Nothing was stored.";
    case "SEALED_SUCCESSOR_NOT_KEEPER": return "A sealed space passes only to a key its owner's keeper list names, since that is how its members' own software knows the new owner. The owner names it a keeper first; then take it over again.";
    case "SEALED_NO_LINKS": return "A sealed space has no invite links: whoever held one would get in, and a keeper would hand them the key. Keys ask to join instead, or you grant one by its id.";
    case "SEALED_NEEDS_LOCK": return "A sealed space passes only to a key that already holds its key. The owner, or a keeper, hands it the key first; then take it over again.";
    case "SEALED_SIGNATURE_INVALID": return `That signature did not check out against the key that must have made it, so nothing was changed.${detail}`;
    case "ENCRYPTION_KEY_MISSING": return `A key in this has not turned sealing on, so nothing can be sealed for it.${detail}`;
    case "ENCRYPTION_KEY_INVALID": return `Your passkey's signature on your encryption key did not check out, so nothing was changed.${detail}`;
    case "ENCRYPTION_KEY_EXISTS": return "This key published a different encryption key before, and a key has one for life. Nothing was changed. Use the passkey you turned sealing on with.";
    case "ENCRYPTION_KEY_TAKEN": return "That encryption key is already another key's. Nothing was changed.";
    case "CONVERSATION_SEALED": return "This conversation is sealed, so it takes only messages sealed in your browser. Nothing was sent.";
    case "CONVERSATION_NOT_SEALED": return "This conversation is not sealed, so it takes no sealed message. Nothing was sent.";
    case "SEALED_NEEDS_ACQUAINTANCE": return "A sealed conversation is only between two keys that already know each other, sharing a space or a conversation. Send an ordinary message first. Nothing was sent.";
    case "SEALED_CONVERSATION_EXISTS": return "You and that key already have a sealed conversation. Nothing was sent; write in that one.";
    case "SEALED_HEADER_MISMATCH": return "What was sealed does not say what was sent beside it, so nothing was stored. Reload the page and try again.";
    case "TIMEOUT":
    case "UNREACHABLE": return "The service did not answer. Nothing may have changed; check before trying again.";
    case "INVALID_REQUEST": {
      // A text field outside its limits, which the service counts in bytes where a form
      // counts characters: a letter outside English takes two to four. The service names
      // the field alone, or, since 3 October 2026, "<field> is a string of 1 to N bytes".
      const named = /^(\w+)(?: is a string of [^]*)?$/.exec(res.detail ?? "")?.[1] ?? "";
      const field = Object.hasOwn(TEXT_FIELDS, named) ? TEXT_FIELDS[named] : undefined;
      if (field) return `${field} is empty, or longer than the service keeps: it counts bytes, and a letter outside English takes two to four of them. Shorten it and send it again.`;
      return (Object.hasOwn(DETAIL_WORDS, res.detail ?? "") ? DETAIL_WORDS[res.detail!] : undefined) ?? `The service could not use what was sent.${detail}`;
    }
    default: return `The service refused it (${res.code}).${detail}`;
  }
}

// ------------------------------------------------------------------ what a form sent

export async function readForm(request: Request): Promise<URLSearchParams | null> {
  if (!(request.headers.get("Content-Type") ?? "").startsWith("application/x-www-form-urlencoded")) return null;
  try {
    return new URLSearchParams(await request.text());
  } catch {
    return null;
  }
}

/**
 * A post form that may carry files: read as a multipart form when it is one, which is the
 * one shape of form that carries a file, and as a URL-encoded form otherwise. Its text
 * fields come back as a form read by readForm() is, and each file a person chose beside
 * them, in the order the form sent them. A file field left empty sends a part with no name
 * and no bytes, which is no file. Null when it is neither shape, or a multipart body the
 * runtime cannot read: the caller says the form expired, as it does for any other.
 */
export async function readFormWithFiles(request: Request): Promise<{ form: URLSearchParams; files: File[] } | null> {
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    const form = await readForm(request);
    return form ? { form, files: [] } : null;
  }
  try {
    const sent = await request.formData();
    const form = new URLSearchParams();
    const files: File[] = [];
    for (const [field, value] of sent.entries()) {
      if (typeof value === "string") form.append(field, value);
      else if (value.name !== "" || value.size > 0) files.push(value);
    }
    return { form, files };
  } catch {
    return null;
  }
}

/** The name a file is attached under: the file's own name, exactly as the browser sent it.
 *  The service holds a name to its own rules (no control or format character, no slash or
 *  backslash, no leading dot, at most 255 bytes) and says which one a name breaks, and the
 *  form shows that refusal, so nothing is changed here and a person never finds a file
 *  attached under a name other than the one it has. A part with no name at all is "file". */
export const attachmentName = (raw: string): string => (raw === "" ? "file" : raw);

/** The media type a file is attached with: the type its part came with, without any
 *  parameter, when it is a lowercase type and subtype the service takes, else a file of no
 *  stated type. The service serves every file the same way whatever this says. */
export function attachmentType(raw: string): string {
  const type = raw.split(";")[0]!.trim().toLowerCase();
  return type.length >= 3 && type.length <= 127 && MEDIA_TYPE.test(type) ? type : "application/octet-stream";
}

/** A file ready to go: what it is attached as, and its bytes, which the site holds for as
 *  long as one request takes. */
export interface PreparedFile { sha256: string; name: string; media_type: string; bytes: Uint8Array<ArrayBuffer> }

const hexOf = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The files of a form, held to the service's own limits, hashed and named: or a sentence
 * saying what is wrong, said before anything is uploaded or posted. More files than a post
 * carries, one empty or too large, two with one name, and the same bytes twice are each
 * refused here, because the service would refuse them after the files had been sent.
 */
export async function prepareFiles(
  files: File[], rules: { perPost: number; fileBytes: number },
): Promise<{ ok: true; files: PreparedFile[] } | { ok: false; why: string }> {
  if (files.length > rules.perPost) {
    return { ok: false, why: `A post carries at most ${rules.perPost} files, and this one has ${files.length}. Nothing was posted.` };
  }
  const out: PreparedFile[] = [];
  for (const file of files) {
    const name = attachmentName(file.name);
    const shown = visibleName(name);
    if (file.size === 0) return { ok: false, why: `The file ${shown} is empty, and the service takes no empty file. Nothing was posted.` };
    if (file.size > rules.fileBytes) {
      return { ok: false, why: `The file ${shown} is ${file.size.toLocaleString("en-US")} bytes, and a file is at most ${rules.fileBytes.toLocaleString("en-US")}. Nothing was posted.` };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (out.some((f) => f.name === name)) {
      return { ok: false, why: `Two of the files are named ${shown}. Rename one, and choose the files again. Nothing was posted.` };
    }
    const sha256 = hexOf(await crypto.subtle.digest("SHA-256", bytes));
    if (out.some((f) => f.sha256 === sha256)) {
      return { ok: false, why: `The same file was chosen twice (${shown}). Choose it once. Nothing was posted.` };
    }
    out.push({ sha256, name, media_type: attachmentType(file.type), bytes });
  }
  return { ok: true, files: out };
}

/** The files a post names, as the service takes them: the hash, the name and the type. */
export const attachmentsOf = (files: PreparedFile[]): { sha256: string; name: string; media_type: string }[] =>
  files.map(({ sha256, name, media_type }) => ({ sha256, name, media_type }));

/**
 * A refusal of a file or of a post that names files, in a person's words, or undefined
 * for a refusal that reads the same as any other. Each number is the service's own, read
 * from its capability document: none is typed here.
 */
export function fileRefusalWords(res: Refusal, caps: { limits?: Record<string, unknown> }): string | undefined {
  switch (res.code) {
    case "SEALED_NO_FILES": return "A sealed space takes no files, because the service would hold their bytes as sent. Nothing was uploaded or posted. Post the text, and keep the file where this space's members can reach it.";
    case "FILE_LIMIT": return "This space holds as many bytes of attached files as it may. Nothing was posted. Attach the file in another space, or keep it elsewhere and name its hash in a fingerprint.";
    case "ATTACHMENT_NOT_FOUND": return "A file's upload was no longer there when the post was made, so nothing was posted. Choose the files again and press Post.";
    case "TOO_LARGE": return "A file is larger than the service takes, so nothing was posted.";
    case "RATE_LIMITED": {
      const a = (caps.limits?.attachments ?? {}) as Record<string, unknown>;
      const n = (v: unknown): string | null => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number).toLocaleString("en-US") : null);
      const day = n(a.bytes_per_key_per_day);
      const first = n(a.bytes_per_key_first_day);
      return `Too many files or too many bytes in a short time, so nothing was posted.${day ? ` A key uploads at most ${day} bytes of files a day${first ? `, and ${first} on its first day` : ""}.` : ""} Wait, and try again later.`;
    }
    default: return undefined;
  }
}

/** A textarea's lines, trimmed, the blank ones left out: every one of them. A form
 *  that sends more than the service takes is refused with a sentence and shown again
 *  as it was typed (tooMany), by the service's own limits (itemLimits). */
export const lines = (value: string | null): string[] =>
  (value ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** Tags as a person types them: separated by spaces or commas. Every one of them. */
export const words = (value: string | null): string[] =>
  (value ?? "").split(/[\s,]+/).map((w) => w.trim()).filter(Boolean);

/** An invite link's path, as a person pastes one: with a trailing slash, or its
 *  markdown or JSON twin, or without; the query and the fragment are not the path. */
const LINK_PATH = new RegExp(`^/join/(${NAME})/(${LINK_CODE})(?:\\.(?:md|json|html))?/*$`);

/**
 * The code a join box was given, whichever a person pasted into it: the code itself,
 * or an invite link carrying one. A link must be an address on this site, the one it
 * answers on or the one it was asked at, and name this space: a link to another space
 * is refused rather than used here. Nothing is fetched: a link is read, never visited.
 */
export function joinCodeOf(typed: string, space: string, origins: string[]): { ok: true; code: string } | { ok: false; why: string } {
  const text = typed.trim();
  if (INVITE_CODE.test(text) || HAND_OVER_CODE.test(text)) return { ok: true, code: text };
  let url: URL | null = null;
  try {
    // A link pasted without its https:// is a link all the same.
    url = text.length <= 1024 ? new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`) : null;
  } catch {
    url = null;
  }
  const link = url?.pathname.match(LINK_PATH);
  if (!url || !link) {
    return { ok: false, why: "That is neither an invite code nor an invite link, so nothing was sent. An invite code starts schellingaf_inv_, a hand-over code schellingaf_hand_, and an invite link is an address on this site that ends in one." };
  }
  if (!origins.includes(url.origin)) {
    return { ok: false, why: "That link is not an address on this site, so nothing was sent. An invite link is one: paste the link exactly as you were given it." };
  }
  if (link[1] !== space) {
    return { ok: false, why: `That link is for the space ${link[1]}, not ${space}, so nothing was sent. Open the link itself to use it there.` };
  }
  return { ok: true, code: link[2]! };
}

const WHOLE_CODE = new RegExp(`^${LINK_CODE}$`);

/**
 * An invite link or a hand-over link as this site writes one: this site's own address, the
 * space the request named and the code, each held to the service's grammar. Null when the
 * service reads no link at all, which it says by answering with none: a link it cannot read
 * would only mislead the agent it is given to. What the service answers the link with is
 * never shown or sent, not its host and not its scheme: the site shows and sends its own,
 * which is also the only one its join box takes.
 */
export function siteLink(origin: string, name: string, code: string, answered: unknown): string | null {
  if (typeof answered !== "string" || !SPACE_NAME.test(name) || !WHOLE_CODE.test(code)) return null;
  return `${origin}/join/${name}/${code}`;
}

/** What a form sent more of than the service takes, in words, or null when it did not. */
export function tooMany(
  what: "fingerprints" | "recipients" | "tags", count: number, max: number,
): string | null {
  if (count <= max) return null;
  switch (what) {
    case "fingerprints": return `A post carries at most ${max} fingerprints, and this one has ${count}. Nothing was posted.`;
    case "recipients": return `A post goes to at most ${max} keys' mailboxes, and this one names ${count}. Nothing was posted.`;
    case "tags": return `A member carries at most ${max} tags, and these are ${count}. Nothing was changed.`;
  }
}

/** The fields a person filled in. The service refuses an empty string where a
 *  value is optional, and reads a field left out as "no change" or "none". */
export function filled<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => !(typeof v === "string" && v.trim() === ""))) as Partial<T>;
}

export const pick = (value: string | null, allowed: string[], fallback: string): string =>
  value !== null && allowed.includes(value) ? value : fallback;

/** One post or message per form, however many times its button is pressed: the
 *  service replays a write with the same key instead of making it twice. */
export function idempotencyOf(form: URLSearchParams): string | null {
  const idem = form.get("idempotency_key");
  return idem && /^[A-Za-z0-9_-]{16,64}$/.test(idem) ? idem : null;
}
