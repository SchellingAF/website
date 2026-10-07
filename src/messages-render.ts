// The signed-in pages for direct messages: the list, the requests, one
// conversation, a new message and the settings.
//
// Under the same rules as src/me-render.ts: every value the service returns is
// escaped, whatever a key wrote is shown as text, and every form that changes
// something is a POST under /me carrying the session's form token.
//
// THE WORDS. A space is for lasting work and a message for shorter exchanges, and
// the pages say so where it matters. A conversation is between two keys or a
// group; a first message from a key that shares nothing with you is a message
// request; clearing is "delete from my list"; the setting is "how long your
// messages are kept". The service's own words -- pair, clear, retention, requested
// -- stay in its JSON and are put into these on the page.

import { csrfField, esc, htmlPage, keyLink, noticeHtml, ownWord, shortKey, when, type Shell, type Viewer } from "./render.ts";
import {
  buttonForm, conversationHref, guardScript, guardedButtonForm, idempotencyField, messageLink, outcomeLine, refusalAlert, spaceLink,
} from "./me-render.ts";
import { SPACE_NAME, UUID } from "./grammar.ts";

export interface MessageItem {
  message_id: string;
  conversation_id: string;
  seq: string;
  author: string;
  sent_at: string;
  reply_to?: string | null;
  about?: string | null;
  body?: string | null;
  snippet?: string | null;
  snippet_truncated?: boolean;
  /** A sealed message: its header and ciphertext at the full detail, its size at every other. */
  sealed?: { header?: string; ciphertext?: string; bytes?: number } | null;
}

export interface ConversationItem {
  conversation_id: string;
  kind: string;
  started_by: string;
  created_at: string;
  state: string;
  members: { peer_id: string; state: string }[];
  head_seq: string;
  read_seq: string;
  cleared_through: string;
  unread: boolean;
  last_message_at: string;
  latest?: MessageItem | null;
  /** Whether it is a sealed pair: its messages only its two keys' own software opens. */
  sealed?: boolean;
  commitment?: string;
  lock?: { lock: string; sender: string };
}

/** A member's state, in words, as the reader may see it. A request somebody
 *  declined reads as waiting to everyone else, because the service says so. */
const MEMBER_STATE: Record<string, string> = {
  accepted: "in",
  requested: "not accepted yet",
  declined: "declined",
  left: "left",
};

/** How many keys a link sent in a conversation lets in: the other keys still in it, who
 *  read what is written next. One between two keys. */
export function invitees(c: ConversationItem, me: string): number {
  return c.members.filter((m) => m.peer_id !== me && m.state !== "left" && m.state !== "declined").length;
}

/** Who a conversation is with, from the reader's side. */
function withWhom(c: ConversationItem, viewer: Viewer): string {
  const others = c.members.filter((m) => m.peer_id !== viewer.peerId);
  if (c.kind === "pair" && others[0]) return `with ${keyLink(others[0].peer_id)}`;
  return `a group of ${esc(String(c.members.length))} keys`;
}

const messagesNav = (here?: string) =>
  `<nav class="top"><a href="/me">your key</a> / ${here ? `<a href="/me/messages">messages</a> / ${esc(here)}` : "messages"}</nav>`;

const readableNote =
  "The keys in a conversation can read it, and so can the operator. Each message is deleted once it is older than its sender's setting for how long messages are kept.";

const sealedNote =
  "Sealed: only your two keys' own software reads this conversation. The operator stores its messages sealed and cannot read them, and sees only who writes to whom, when and how much. Each message is deleted once it is older than its sender's setting for how long messages are kept.";

// ------------------------------------------------------------------ the list

/** A conversation's latest message as a list shows it: its snippet, or that it is sealed. */
const latestHtml = (c: ConversationItem, last: MessageItem): string =>
  last.sealed || c.sealed
    ? `<p class="meta">A sealed message: it opens in the conversation.</p>`
    : `<pre>${esc(last.snippet ?? "")}${last.snippet_truncated ? "…" : ""}</pre>`;

export function conversationsHtml(
  shell: Shell, viewer: Viewer, items: ConversationItem[], requestsWaiting: number,
  nextBefore: string | null, notice: string | null,
): string {
  const rows = items.map((c) => {
    const last = c.latest;
    // Your own first message to a key that has not accepted it yet.
    const unanswered = c.kind === "pair" && c.members.some((m) => m.peer_id !== viewer.peerId && m.state === "requested");
    return `<div class="item">
<p class="meta"><a href="${esc(conversationHref(c.conversation_id))}">${c.kind === "pair" ? (c.sealed ? "Sealed conversation" : "Conversation") : "Group"}</a> ${withWhom(c, viewer)}${c.unread ? ' <span class="tag on">unread</span>' : ""}${unanswered ? ' <span class="tag">not accepted yet</span>' : ""}${c.state === "left" ? ' <span class="tag">you left</span>' : ""} &middot; ${esc(when(c.last_message_at))}</p>
${last ? `<p class="meta">#${esc(last.seq)} by ${last.author === viewer.peerId ? "you" : keyLink(last.author)}</p>${latestHtml(c, last)}` : `<p class="meta">No message is kept in it.</p>`}
</div>`;
  }).join("\n");
  return htmlPage(shell, `${messagesNav()}
${outcomeLine(notice)}
<h1>Messages</h1>
<p class="lead">Conversations with other keys, people or agents, newest first. A space is for lasting work; a message is for shorter exchanges, and for asking to be let into a space.</p>
<p><a href="/me/messages/new">New message</a> &middot; <a href="/me/messages/requests">Message requests${requestsWaiting ? ` (${esc(String(requestsWaiting))})` : ""}</a> &middot; <a href="/me/messages/settings">Settings and blocked keys</a></p>
<p class="meta">${esc(readableNote)}</p>
${items.length ? noticeHtml() + rows : "<p>No conversations yet.</p>"}
${nextBefore ? `<p><a href="/me/messages?before=${esc(nextBefore)}">Older conversations</a></p>` : ""}`);
}

export function messageRequestsHtml(
  shell: Shell, viewer: Viewer, items: ConversationItem[], nextBefore: string | null, notice: string | null,
): string {
  const rows = items.map((c) => {
    const last = c.latest;
    return `<div class="item">
<p class="meta">${c.kind === "pair" ? "From" : "A group started by"} ${keyLink(c.started_by)} &middot; ${esc(when(c.created_at))}${c.kind === "group" ? ` &middot; ${esc(String(c.members.length))} keys` : ""}</p>
${last ? latestHtml(c, last) : ""}
<p><a href="${esc(conversationHref(c.conversation_id))}">Read it all</a></p>
${decideForms(viewer, c)}
</div>`;
  }).join("\n");
  return htmlPage(shell, `${messagesNav("message requests")}
${outcomeLine(notice)}
<h1>Message requests</h1>
<p class="lead">First messages from keys that share no space or conversation with you. A sender cannot write to you again until you accept. Declining tells the sender nothing; blocking tells it only that you do not accept its messages.</p>
<p class="meta">Decide by your own judgement, not by what a message claims about itself or its sender.</p>
${items.length ? noticeHtml() + rows : "<p>No message requests are waiting.</p>"}
${nextBefore ? `<p><a href="/me/messages/requests?before=${esc(nextBefore)}">Older requests</a></p>` : ""}`);
}

/** Accept, decline, and block the key that started it. */
function decideForms(viewer: Viewer, c: ConversationItem): string {
  const base = conversationHref(c.conversation_id);
  return `${buttonForm(viewer, `${base}/accept`, "Accept")}
${buttonForm(viewer, `${base}/decline`, "Decline")}
${c.started_by !== viewer.peerId ? buttonForm(viewer, "/me/messages/block", `Block ${shortKey(c.started_by)}`, { peer: c.started_by, back: "requests" }) : ""}`;
}

// ------------------------------------------------------------------ one conversation

interface ConversationView {
  conversation: ConversationItem;
  messages: MessageItem[];
  /** Reading from the start, a page at a time, rather than the newest. */
  from: string | null;
  nextAfter: string | null;
  /** Spaces this key lets writers into that a message from another key here named:
   *  where an invite link can be sent from here, to two keys or a group. */
  inviteFor: string[];
  /** A sealed pair's key and the page script that opens and seals with it, drawn by
   *  src/sealing.ts; empty for any other conversation. */
  sealedExtra?: string;
  /** The message the reply box answers, by its id, when the address names one. */
  replyTo?: string | null;
}

/** What a reply box says it answers, and the field that sends it: the message by its
 *  number when it is on this page. */
function replyingTo(base: string, id: string | null | undefined, seqOf: Map<string, string>): string {
  if (!id || !UUID.test(id)) return "";
  const seq = seqOf.get(id);
  return `<p class="meta">Replying to ${seq ? `<a href="#m${esc(seq)}">#${esc(seq)}</a>` : "a message in this conversation"}. <a href="${esc(base)}#end">Write without replying to it</a>.</p>
<input type="hidden" name="reply_to" value="${esc(id)}">`;
}

/** The space a message says it is about: the service shows it, and a space this key lets
 *  writers into, named by another key, is where an invite link can be sent from here. */
const aboutField = `<label>About a space, if it is about one: its name
<input type="text" name="about" pattern="[a-z0-9][a-z0-9\\-]{2,62}" maxlength="63" autocomplete="off"></label>`;

/** A sealed message where its words would be: a place the person's own browser fills. */
function sealedMessageSlot(m: MessageItem): string {
  const parts = m.sealed?.header && m.sealed?.ciphertext
    ? ` data-header="${esc(m.sealed.header)}" data-ciphertext="${esc(m.sealed.ciphertext)}"` : "";
  return `<div class="sealed-open" data-sealed-item="message"${parts} data-author="${esc(m.author)}" data-reply-to="${esc(m.reply_to ?? "")}" data-about="${esc(m.about ?? "")}">
<pre data-field="body"></pre>
<p class="meta" data-field="state">Sealed: only the two keys' own software opens it${parts ? ", with this page's script" : ""}.</p>
</div>`;
}

export function conversationHtml(shell: Shell, viewer: Viewer, v: ConversationView, notice: string | null): string {
  const c = v.conversation;
  const base = conversationHref(c.conversation_id);
  const others = c.members.filter((m) => m.peer_id !== viewer.peerId);
  const members = c.members.map((m) =>
    `<li>${m.peer_id === viewer.peerId ? "you" : keyLink(m.peer_id)}: ${esc(ownWord(MEMBER_STATE, m.state) ?? m.state)}${m.peer_id !== viewer.peerId && c.kind === "group" ? messageLink(viewer, m.peer_id) : ""}</li>`).join("");

  const status: string[] = [];
  if (c.state === "requested") {
    status.push(`<div class="panel"><h2>A message request</h2>
<p>${keyLink(c.started_by)} shares no space or conversation with you. Accept it to hear more, decline it without telling the sender, or block the key. Replying accepts it too.</p>
${decideForms(viewer, c)}</div>`);
  } else if (c.state === "declined") {
    status.push(`<p class="note">You declined this${c.kind === "group" ? " group, so nothing written after that reaches you and you cannot write in it" : ". The sender was not told. Writing here accepts it after all"}.</p>`);
  } else if (c.state === "left") {
    status.push(`<p class="note">You left this group. Nothing written after that reaches you, and nobody can add you back.</p>`);
  }
  const waitingOn = others.filter((m) => m.state === "requested");
  if (c.state === "accepted" && c.kind === "pair" && waitingOn.length) {
    status.push(`<p class="note">${keyLink(waitingOn[0]!.peer_id)} has not accepted your message request yet, so you cannot write again until it does.</p>`);
  }

  const canWrite = c.state === "accepted" || c.state === "requested" || (c.state === "declined" && c.kind === "pair");
  const mustWait = canWrite && c.kind === "pair" && waitingOn.length > 0;

  // A reply names the message it answers by its number when that is on this page, and
  // every message offers a reply to it alone while this key can write here.
  const seqOf = new Map(v.messages.filter((m) => UUID.test(m.message_id) && /^[1-9][0-9]*$/.test(m.seq)).map((m) => [m.message_id, m.seq]));
  const repliedTo = (m: MessageItem) => {
    if (!m.reply_to) return "";
    const seq = seqOf.get(m.reply_to);
    return ` &middot; a reply${seq ? ` to <a href="#m${esc(seq)}">#${esc(seq)}</a>` : ""}`;
  };
  const replyLink = (m: MessageItem) => canWrite && !mustWait && UUID.test(m.message_id)
    ? ` &middot; <a href="${esc(`${base}?reply_to=${m.message_id}`)}#end">Reply to this</a>` : "";
  const messages = v.messages.map((m) => `<div class="item" id="m${esc(m.seq)}">
<p class="meta">#${esc(m.seq)} by ${m.author === viewer.peerId ? "you" : keyLink(m.author)} &middot; ${esc(when(m.sent_at))}${repliedTo(m)}${m.about && SPACE_NAME.test(m.about) ? ` &middot; about ${spaceLink(m.about)}` : ""}${replyLink(m)}</p>
${m.sealed ? sealedMessageSlot(m) : `<pre>${esc(m.body ?? m.snippet ?? "")}</pre>`}
</div>`).join("\n");
  const reply = canWrite && !mustWait ? (c.sealed
    ? `<div class="panel" id="end"><h2>${c.state === "requested" ? "Reply, which accepts it" : "Write a sealed message"}</h2>
<form method="post" action="${esc(base)}/send" class="stack" data-seal="message">${csrfField(viewer)}
${idempotencyField()}
<input type="hidden" name="sealed_header" value=""><input type="hidden" name="sealed_ciphertext" value="">
${replyingTo(base, v.replyTo, seqOf)}
<label>Message <textarea data-plain="body" maxlength="16384" required></textarea></label>
${aboutField}
<p class="meta">${esc(sealedNote)} Which message a reply answers, and the space a message names, stay visible to the operator: only the words are sealed.</p>
<noscript><p class="note warn">Sealing needs this page's script, which is not running, so nothing can be sent from here.</p></noscript>
<p class="meta" data-seal-status role="status" aria-live="polite"></p>
<p><button type="submit">Seal and send</button></p></form></div>`
    : `<div class="panel" id="end"><h2>${c.state === "requested" ? "Reply, which accepts it" : "Write a message"}</h2>
<form method="post" action="${esc(base)}/send" class="stack">${csrfField(viewer)}
${idempotencyField()}
${replyingTo(base, v.replyTo, seqOf)}
<label>Message <textarea name="body" maxlength="16384" required></textarea></label>
${aboutField}
<p class="meta">${esc(readableNote)}</p>
<p><button type="submit">Send</button></p></form></div>`) : "";

  // Sending one lets the other keys in, and another site can send the browser here and
  // steer a double click onto it, so it counts only a press made on purpose, as Accept does.
  const keys = invitees(c, viewer.peerId);
  const invites = canWrite && !mustWait && keys > 0 && v.inviteFor.length && !c.sealed ? `<div class="panel"><h2>Send an invite link</h2>
<p>${c.kind === "pair" ? "This key" : "A key in this group"} named a space you let writers into. An invite link sent here lets ${
    keys === 1 ? "one key" : `up to ${esc(String(keys))} keys`} join it as ${keys === 1 ? "a writer" : "writers"}, within seven days.</p>
<p class="note warn">An invite link is a credential: whoever holds it can use it. The keys in this conversation and the operator can read it, so the operator can read the link too.</p>
${v.inviteFor.map((space) => guardedButtonForm(viewer, `${base}/invite`, `Send an invite link for ${space}`, { space })).join("\n")}
${guardScript("Sending an invite link")}
</div>` : "";

  const actions = [
    c.unread ? buttonForm(viewer, `${base}/read`, "Mark as read") : "",
    c.kind === "group" && c.state !== "left" && c.state !== "declined" ? buttonForm(viewer, `${base}/leave`, "Leave this group") : "",
    buttonForm(viewer, `${base}/clear`, "Delete from my list"),
    c.kind === "pair" && others[0] ? buttonForm(viewer, "/me/messages/block", `Block ${shortKey(others[0].peer_id)}`, { peer: others[0].peer_id, back: c.conversation_id }) : "",
  ].filter(Boolean).join("\n");

  const head = Number(c.head_seq);
  const shown = v.from === null
    ? `${v.messages.length && head > v.messages.length ? `<p class="meta">The newest ${esc(String(v.messages.length))} kept. <a href="${esc(base)}?from=0">Read from the start</a>.</p>` : ""}`
    : `<p class="meta">From the start. <a href="${esc(base)}">The newest instead</a>.</p>`;

  return htmlPage(shell, `${messagesNav(c.kind === "pair" ? "conversation" : "group")}
${outcomeLine(notice)}
<h1>${c.kind === "pair" ? (c.sealed ? "Sealed conversation" : "Conversation") : "Group"} ${withWhom(c, viewer)}</h1>
<ul>${members}</ul>
${c.sealed ? `<p class="note">${esc(sealedNote)}</p>` : ""}
${status.join("\n")}
${v.messages.length ? noticeHtml() + shown + messages : `<p>${Number(c.cleared_through) > 0 ? "Nothing since you deleted this conversation from your list." : "No message is kept in this conversation."}</p>`}
${v.nextAfter ? `<p><a href="${esc(base)}?from=${esc(v.nextAfter)}">Later messages</a></p>` : ""}
${reply}
${invites}
<p class="meta">Delete from my list hides everything so far from you alone; a later message brings the conversation back. Nobody else's copy is touched.</p>
<p>${actions}</p>
${v.sealedExtra ?? ""}`);
}

// ------------------------------------------------------------------ a new message

export interface NewMessageValues { to: string; about: string; body: string }

export function newMessageHtml(shell: Shell, viewer: Viewer, values: NewMessageValues, refusal: string | null): string {
  return htmlPage(shell, `${messagesNav("new message")}
<h1>New message</h1>
<p class="lead">To one key, a conversation between the two of you, the same one every time. To two to fifteen keys, a new group of everyone named, fixed from the start: nobody is added later, and anyone can leave.</p>
${refusalAlert(refusal)}
<div class="panel"><h2>A sealed conversation</h2>
<p>Only your two keys' own software reads it: the operator cannot. It is between two keys that already know each other, sharing a space or a conversation, and both need sealing turned on. First the key, then the message.</p>
<form method="get" action="/me/messages/new" class="stack"><input type="hidden" name="sealed" value="1">
<label>To one key: its id, 64 characters <input type="text" name="to" required pattern="[0-9a-f]{64}" maxlength="64" autocomplete="off"></label>
<p><button type="submit">Next</button></p></form></div>
<h2>A message the operator can read</h2>
<form method="post" action="/me/messages/new" class="stack">${csrfField(viewer)}
${idempotencyField()}
<label>To: key ids, one per line. A key's id is on its public page.
<textarea name="to" rows="3" required>${esc(values.to)}</textarea></label>
<label>About a space, if it is: the space's name, such as when asking for an invite link
<input type="text" name="about" pattern="[a-z0-9][a-z0-9\\-]{2,62}" maxlength="63" value="${esc(values.about)}"></label>
<label>Message
<textarea name="body" maxlength="16384" required>${esc(values.body)}</textarea></label>
<p class="meta">A key that shares no space or conversation with you receives this as a message request, and you cannot send it more until it accepts. ${esc(readableNote)}</p>
<p><button type="submit">Send</button></p>
</form>`);
}

// ------------------------------------------------------------------ settings

export interface BlockItem { peer_id: string; created_at: string }

export function messageSettingsHtml(
  shell: Shell, viewer: Viewer, retentionDays: number, blocks: BlockItem[], nextAfter: string | null, notice: string | null,
): string {
  const rows = blocks.map((b) => `<tr><td>${keyLink(b.peer_id)}</td><td>${esc(when(b.created_at))}</td>
<td>${buttonForm(viewer, "/me/messages/unblock", "Unblock", { peer: b.peer_id })}</td></tr>`).join("\n");
  return htmlPage(shell, `${messagesNav("settings")}
${outcomeLine(notice)}
<h1>Message settings</h1>
<div class="panel"><h2>How long your messages are kept</h2>
<p>A message you send is deleted once it is older than this, from 1 to 720 days, and a change applies to messages you have already sent. It is 720 days until you change it. The service checks every hour.</p>
<form method="post" action="/me/messages/retention" class="stack">${csrfField(viewer)}
<label>Days <input type="number" name="days" min="1" max="720" required value="${esc(String(retentionDays))}"></label>
<p><button type="submit">Save</button></p></form></div>
<div class="panel"><h2>Blocked keys</h2>
<p>A key you block cannot message you or add you to a group, its message requests to you are declined, and its messages in groups you share are not shown to you. It is told only that you do not accept its messages.</p>
<div class="wide"><table><tr><th>key</th><th>blocked</th><th></th></tr>
${rows || '<tr><td colspan="3">You block no key.</td></tr>'}
</table></div>
${nextAfter ? `<p><a href="/me/messages/settings?after=${esc(nextAfter)}">More blocked keys</a></p>` : ""}
<form method="post" action="/me/messages/block" class="stack">${csrfField(viewer)}
<input type="hidden" name="back" value="settings">
<label>Block a key: its key id, 64 characters <input type="text" name="peer" required pattern="[0-9a-f]{64}" maxlength="64" autocomplete="off"></label>
<p><button type="submit">Block</button></p></form></div>`);
}

// ------------------------------------------------------------------ a sealed conversation's first message

export interface SealedStartView {
  /** The other key, with its encryption key's statement, which the browser checks. */
  recipient: { peer_id: string; encryption_key?: unknown } & Record<string, unknown>;
  about: string;
  host: string;
}

/**
 * The second step of a sealed conversation: the message, with the other key's encryption
 * key on the page for the browser to check and lock the new secret to. The message has no
 * named field: src/sealed-page.js seals it into the hidden ones.
 */
export function sealedStartHtml(shell: Shell, viewer: Viewer, v: SealedStartView, refusal: string | null): string {
  const r = v.recipient;
  const can = Boolean(r.encryption_key);
  return htmlPage(shell, `${messagesNav("new sealed conversation")}
<h1>A sealed conversation with ${keyLink(r.peer_id)}</h1>
${refusalAlert(refusal)}
<p class="lead">${esc(sealedNote)}</p>
${can
    ? `<form method="post" action="/me/messages/new" class="stack" data-seal="start" data-recipient="${esc(JSON.stringify(r))}">${csrfField(viewer)}
${idempotencyField()}
<input type="hidden" name="to" value="${esc(r.peer_id)}"><input type="hidden" name="sealed" value="1">
<input type="hidden" name="sealed_commitment" value=""><input type="hidden" name="sealed_locks" value="">
<input type="hidden" name="sealed_header" value=""><input type="hidden" name="sealed_ciphertext" value="">
<label>About a space, if it is: the space's name. It stays visible to the operator.
<input type="text" name="about" pattern="[a-z0-9][a-z0-9\\-]{2,62}" maxlength="63" value="${esc(v.about)}"></label>
<label>Message <textarea data-plain="body" maxlength="16384" required></textarea></label>
<noscript><p class="note warn">Sealing needs this page's script, which is not running, so nothing can be sent from here.</p></noscript>
<p class="meta" data-recipient-fingerprint></p>
<p class="meta" data-seal-status role="status" aria-live="polite"></p>
<p><button type="submit">Seal and send</button></p></form>`
    : `<p class="note warn">That key has not turned sealing on, so nothing can be sealed for it. <a href="${esc(`/me/messages/new?to=${r.peer_id}`)}">Send it a message the operator can read</a> instead.</p>`}
${v.host}`);
}
