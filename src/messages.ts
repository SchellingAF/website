// Direct messages, signed in: /me/messages and everything under it.
//
// A message is between two keys or inside a fixed group; it is never a post. The
// product holds every rule -- who is a
// stranger, what a block stops, how long a message lasts -- and these pages read
// and act with the signed-in key's own token, under the rules src/me.ts keeps for
// the whole family: the session is found first, every write is a POST carrying
// the form token, and nothing here is cached or indexed.
//
// src/me.ts finds the session and hands every /me/messages address here; this
// file answers null for an address that is not one of its own.

import { apiGet, apiWrite, classifyRefusal, type ApiEnv } from "./api.ts";
import { formShell, rankOf, resultHtml } from "./me-render.ts";
import {
  conversationHtml, conversationsHtml, invitees, messageRequestsHtml, messageSettingsHtml, newMessageHtml, sealedStartHtml,
  type BlockItem, type ConversationItem, type MessageItem, type NewMessageValues,
} from "./messages-render.ts";
import { jsonObjectOf, readLocks, sealedPairContext, sealedPart, sealingHost, type KeyBlock } from "./sealing.ts";
import type { Session } from "./session.ts";
import { badForm, html, idempotencyOf, lines, page, refusalText, see, siteLink, statusFor, type SignedInContext } from "./signed-in.ts";
import { HEX32, INVITE_CODE, KEY_ID, POSITION, SPACE_NAME, UUID } from "./grammar.ts";

const BACK: [string, string][] = [["/me/messages", "Messages"], ["/me", "Your key"]];

/** What the bar shows: unread conversations and waiting requests, or nothing when
 *  the service did not say. One read per signed-in page. */
export async function waitingOf(env: ApiEnv): Promise<{ unread: number; requests: number } | undefined> {
  const res = await apiGet<{ unread_conversations?: number; requests_waiting?: number }>(
    env, "/v1/conversations?limit=1", "session");
  if (!res.ok) return undefined;
  const unread = res.data.unread_conversations;
  const requests = res.data.requests_waiting;
  return typeof unread === "number" && typeof requests === "number" ? { unread, requests } : undefined;
}

// ------------------------------------------------------------------ reading

type ListAnswer = { items: ConversationItem[]; next_before: string | null; has_more: boolean; requests_waiting: number };

export async function readMessages(x: SignedInContext, path: string): Promise<Response | null> {
  const q = x.url.searchParams;
  const notice = q.get("notice");

  if (path === "/me/messages" || path === "/me/messages/requests") {
    const requests = path.endsWith("/requests");
    const before = UUID.test(q.get("before") ?? "") ? q.get("before")! : null;
    const params = new URLSearchParams({ limit: "50", ...(requests ? { state: "requested" } : {}), ...(before ? { before } : {}) });
    const res = await apiGet<ListAnswer>(x.env, `/v1/conversations?${params}`, "session");
    if (!res.ok) return x.refused(res, [["/me", "Your key"]]);
    const next = res.data.has_more && UUID.test(res.data.next_before ?? "") ? res.data.next_before : null;
    if (requests) return html(messageRequestsHtml(formShell("Message requests", x.viewer), x.viewer, res.data.items, next, notice));
    return html(conversationsHtml(formShell("Messages", x.viewer), x.viewer, res.data.items,
      res.data.requests_waiting ?? 0, next, notice));
  }

  if (path === "/me/messages/new") {
    // A key or several, and a space, come along from a link beside a key or on a
    // space's page. Anything else in the address is dropped.
    const to = q.getAll("to").filter((id) => KEY_ID.test(id) && id !== x.session.peerId).slice(0, 15);
    const about = SPACE_NAME.test(q.get("about") ?? "") ? q.get("about")! : "";
    // A sealed conversation's second step: its one key, with its encryption key, then the
    // message, which the browser seals.
    if (q.get("sealed") === "1" && to.length === 1) {
      const peer = await apiGet<KeyBlock>(x.env, `/v1/peers/${to[0]}`, "session");
      if (!peer.ok) return x.refused(peer, [["/me/messages/new", "New message"], ...BACK]);
      return html(sealedStartHtml(formShell("New sealed conversation", x.viewer), x.viewer,
        { recipient: { ...peer.data, peer_id: to[0]! }, about, host: await sealingHost(x.viewer) }, null));
    }
    return html(newMessageHtml(formShell("New message", x.viewer), x.viewer, { to: to.join("\n"), about, body: "" }, null));
  }

  if (path === "/me/messages/settings") {
    const after = KEY_ID.test(q.get("after") ?? "") ? q.get("after")! : "";
    const [me, blocks] = await Promise.all([
      apiGet<{ messages?: { retention_days?: number } }>(x.env, "/v1/me", "session"),
      apiGet<{ items: BlockItem[]; next_after: string | null; has_more: boolean }>(
        x.env, `/v1/blocks?limit=200${after ? `&after=${after}` : ""}`, "session"),
    ]);
    if (!me.ok) return x.refused(me, BACK);
    if (!blocks.ok) return x.refused(blocks, BACK);
    const days = me.data.messages?.retention_days;
    return html(messageSettingsHtml(formShell("Message settings", x.viewer), x.viewer,
      typeof days === "number" ? days : 720, blocks.data.items,
      blocks.data.has_more && KEY_ID.test(blocks.data.next_after ?? "") ? blocks.data.next_after : null, notice));
  }

  const one = path.match(/^\/me\/messages\/([0-9a-f-]{36})$/);
  if (one && UUID.test(one[1]!)) return conversationPage(x, one[1]!, notice);
  return null;
}

async function conversationPage(x: SignedInContext, id: string, notice: string | null): Promise<Response> {
  const conversation = await apiGet<ConversationItem>(x.env, `/v1/conversations/${id}`, "session");
  if (!conversation.ok) return x.refused(conversation, BACK);

  const from = POSITION.test(x.url.searchParams.get("from") ?? "") ? x.url.searchParams.get("from")! : null;
  const params = from === null
    ? new URLSearchParams({ order: "desc", limit: "50", detail: "full", token_budget: "65536" })
    : new URLSearchParams({ after: from, limit: "50", detail: "full", token_budget: "65536" });
  const page = await apiGet<{ items: MessageItem[]; next_after: string | null; has_more: boolean }>(
    x.env, `/v1/conversations/${id}/messages?${params}`, "session");
  if (!page.ok) return x.refused(page, BACK);
  // Newest first from the service; oldest first on the page, as a conversation reads.
  const messages = from === null ? [...page.data.items].reverse() : page.data.items;

  // Where an invite link could be sent from here: a space another key named in a message
  // on this page, that this key lets writers into, as its owner, an admin or a
  // coordinator. Each space's own profile says so, read only when a message names one,
  // and for the four named last: a list of a key's memberships comes a page at a time.
  const c = conversation.data;
  const named = [...new Set(messages.filter((m) => m.author !== x.session.peerId && m.about && SPACE_NAME.test(m.about)).map((m) => m.about!))]
    .slice(-4);
  const profiles = await Promise.all(named.map((space) =>
    apiGet<{ status?: string; access?: { role?: string | null } }>(x.env, `/v1/spaces/${space}`, "session")));
  const inviteFor = named.filter((_, i) => {
    const p = profiles[i]!;
    return p.ok && p.data.status === "active" && rankOf(p.data.access?.role) > rankOf("writer");
  });

  // A sealed pair: its key, as the product holds it for this key, and the keys of the one
  // who locked it, for the browser to check before it opens anything.
  let sealedExtra = "";
  if (c.sealed === true && c.lock && /^[0-9a-f]{160}$/.test(c.lock.lock) && KEY_ID.test(c.lock.sender) && HEX32.test(c.commitment ?? "")) {
    const sender = c.lock.sender === x.session.peerId ? null : await apiGet<KeyBlock>(x.env, `/v1/peers/${c.lock.sender}`, "session");
    sealedExtra = `${sealedPairContext(c.members.map((m) => m.peer_id), c.commitment!, c.lock,
      sender?.ok ? { ...sender.data, peer_id: c.lock.sender } : null)}\n${await sealingHost(x.viewer)}`;
  } else if (c.sealed === true) {
    sealedExtra = `<p class="note warn">This sealed conversation holds no key for you that this site can read, so nothing in it can be opened here.</p>`;
  }

  return html(conversationHtml(formShell(c.kind === "pair" ? "Conversation" : "Group", x.viewer), x.viewer, {
    conversation: c,
    messages,
    from,
    nextAfter: from !== null && page.data.has_more && POSITION.test(page.data.next_after ?? "") ? page.data.next_after : null,
    inviteFor: c.sealed === true ? [] : inviteFor,
    sealedExtra,
    replyTo: UUID.test(x.url.searchParams.get("reply_to") ?? "") ? x.url.searchParams.get("reply_to") : null,
  }, notice));
}

// ------------------------------------------------------------------ acting

export async function actOnMessages(x: SignedInContext, path: string, form: URLSearchParams): Promise<Response | null> {
  const s = x.session;

  if (path === "/me/messages/new" && form.get("sealed") === "1") return startSealed(x, form);
  if (path === "/me/messages/new") {
    const values: NewMessageValues = {
      to: (form.get("to") ?? "").slice(0, 2048),
      about: (form.get("about") ?? "").trim().slice(0, 63),
      body: (form.get("body") ?? "").slice(0, 16384 * 4),
    };
    const again = (refusal: string, status = 400) =>
      page(newMessageHtml(formShell("New message", x.viewer), x.viewer, values, refusal), status);
    const to = lines(values.to);
    if (to.length === 0 || to.length > 15) return again("Name one to fifteen keys under To, one on each line. Nothing was sent.");
    if (to.some((id) => !KEY_ID.test(id))) {
      return again("Each line under To must be a key id: 64 characters of 0 to 9 and a to f. Nothing was sent.");
    }
    if (to.includes(s.peerId)) return again("Your own key cannot be among the keys you message. Nothing was sent.");
    if (values.about && !SPACE_NAME.test(values.about)) return again("A space's name is lowercase letters, digits and hyphens. Nothing was sent.");
    if (!values.body.trim()) return again("Write a message first. Nothing was sent.");
    const body: Record<string, unknown> = { to: [...new Set(to)], body: values.body };
    if (values.about) body.about = values.about;
    const idem = idempotencyOf(form);
    if (idem) body.idempotency_key = idem;
    const res = await apiWrite<{ conversation_id?: string }>(s, "POST", "/v1/conversations", body);
    if (!res.ok) {
      if (classifyRefusal(res.code, res.status) === "credential") return x.refused(res, BACK);
      return again(refusalText(res), statusFor(res));
    }
    return started(res.data.conversation_id);
  }

  if (path === "/me/messages/block" || path === "/me/messages/unblock") {
    const peer = form.get("peer") ?? "";
    if (!KEY_ID.test(peer) || peer === s.peerId) return badForm(x.viewer, "A key id is 64 characters of 0 to 9 and a to f, and not your own. Nothing was changed.");
    const blocking = path.endsWith("/block");
    const res = await apiWrite(s, blocking ? "PUT" : "DELETE", `/v1/blocks/${peer}`, blocking ? {} : undefined);
    if (!res.ok) return x.refused(res, [["/me/messages/settings", "Message settings"], ...BACK]);
    const back = form.get("back") ?? "settings";
    const target = back === "requests" ? "/me/messages/requests" : UUID.test(back) ? `/me/messages/${back}` : "/me/messages/settings";
    return see(`${target}?notice=${blocking ? "key-blocked" : "key-unblocked"}`);
  }

  if (path === "/me/messages/retention") {
    const days = Number(form.get("days") ?? "");
    if (!Number.isInteger(days) || days < 1 || days > 720) {
      return badForm(x.viewer, "How long messages are kept is a whole number of days from 1 to 720. Nothing was changed.");
    }
    const res = await apiWrite(s, "PUT", "/v1/messages/retention", { days });
    if (!res.ok) return x.refused(res, [["/me/messages/settings", "Message settings"], ...BACK]);
    return see("/me/messages/settings?notice=retention-saved");
  }

  const onConversation = path.match(/^\/me\/messages\/([0-9a-f-]{36})\/(send|accept|decline|leave|clear|read|invite)$/);
  if (!onConversation || !UUID.test(onConversation[1]!)) return null;
  const [id, action] = [onConversation[1]!, onConversation[2]!];
  const here = `/me/messages/${id}`;
  const links: [string, string][] = [[here, "Back to the conversation"], ...BACK];

  switch (action) {
    case "send": {
      // Sealed in the browser: the header and ciphertext, and nothing the person typed.
      if (form.get("sealed_header") || form.get("sealed_ciphertext")) {
        const header = sealedPart(form.get("sealed_header"), 2800);
        const ciphertext = sealedPart(form.get("sealed_ciphertext"), 87_500);
        if (!header || !ciphertext) return badForm(x.viewer, "That sealed message was not in the shape this page seals one, so nothing was sent. Reload the page and try again.");
        const idem = idempotencyOf(form);
        const res = await apiWrite(s, "POST", `/v1/conversations/${id}/messages`, {
          sealed: { header, ciphertext }, ...(idem ? { idempotency_key: idem } : {}),
        });
        if (!res.ok) return x.refused(res, links);
        return see(`${here}?notice=message-sent#end`);
      }
      const text = form.get("body") ?? "";
      if (!text.trim()) return badForm(x.viewer, "Write a message first. Nothing was sent.");
      const body: Record<string, unknown> = { body: text };
      const idem = idempotencyOf(form);
      if (idem) body.idempotency_key = idem;
      // The one message it answers, and the space it names, each in the shape the service
      // takes, since the one goes into what the product is sent and the other names a space.
      const replyTo = form.get("reply_to") ?? "";
      const about = (form.get("about") ?? "").trim();
      if (replyTo && !UUID.test(replyTo)) return badForm(x.viewer, "That reply named no message in the shape this page writes one. Nothing was sent.");
      if (about && !SPACE_NAME.test(about)) return badForm(x.viewer, "A space's name is lowercase letters, digits and hyphens, 3 to 63 characters. Nothing was sent.");
      if (replyTo) body.reply_to = replyTo;
      if (about) body.about = about;
      const res = await apiWrite(s, "POST", `/v1/conversations/${id}/messages`, body);
      if (!res.ok) return x.refused(res, links);
      return see(`${here}?notice=message-sent#end`);
    }
    case "invite":
      return sendInvite(x, id, form.get("space") ?? "", links);
    default: {
      const res = await apiWrite(s, "POST", `/v1/conversations/${id}/${action}`, {});
      if (!res.ok) return x.refused(res, links);
      if (action === "decline") return see("/me/messages/requests?notice=request-declined");
      if (action === "clear") return see("/me/messages?notice=conversation-deleted");
      if (action === "accept") return see(`${here}?notice=request-accepted`);
      if (action === "leave") return see(`${here}?notice=group-left`);
      return see(here);
    }
  }
}

/**
 * A sealed conversation, started: the one key it is with, and what the browser made for
 * it, the secret's commitment, a lock for each of the two keys and the first message
 * sealed. Passed to the product unread; the words were never in a named field.
 */
async function startSealed(x: SignedInContext, form: URLSearchParams): Promise<Response> {
  const to = form.get("to") ?? "";
  const about = (form.get("about") ?? "").trim();
  const commitment = form.get("sealed_commitment") ?? "";
  const locks = readLocks(JSON.stringify({ 1: jsonObjectOf(form.get("sealed_locks"), 4096) }));
  const header = sealedPart(form.get("sealed_header"), 2800);
  const ciphertext = sealedPart(form.get("sealed_ciphertext"), 87_500);
  if (!KEY_ID.test(to) || to === x.session.peerId || !HEX32.test(commitment) || !locks || !header || !ciphertext
    || (about && !SPACE_NAME.test(about))) {
    return badForm(x.viewer, "That was not what this page sends to start a sealed conversation, so nothing was sent. Go back, reload the page and try again.");
  }
  const idem = idempotencyOf(form);
  const res = await apiWrite<{ conversation_id?: string }>(x.session, "POST", "/v1/conversations", {
    to: [to],
    sealed: { commitment, locks: locks.get("1"), header, ciphertext },
    ...(about ? { about } : {}),
    ...(idem ? { idempotency_key: idem } : {}),
  });
  if (!res.ok) return x.refused(res, [[`/me/messages/new?sealed=1&to=${to}`, "Try again"], ...BACK]);
  return started(res.data.conversation_id);
}

/** On to a conversation just started, or to the list when the service named no id for it. */
function started(id: string | undefined): Response {
  return see(UUID.test(id ?? "") ? `/me/messages/${id}?notice=message-sent` : "/me/messages?notice=message-sent");
}

/**
 * An invite link, made and sent as a message in one step, sized to the conversation: one
 * use between two keys, and in a group as many as the other keys still in it, as a
 * writer, for seven days.
 *
 * A link goes into a group as well as between two keys.
 * A link is a credential, and the page that offers this says the keys in the
 * conversation and the operator can read it. If the link cannot be sent, because the
 * message fails or because the service answered in a shape this site cannot read, it is
 * revoked again rather than left alive with nobody holding it.
 */
async function sendInvite(x: SignedInContext, id: string, space: string, links: [string, string][]): Promise<Response> {
  if (!SPACE_NAME.test(space)) return badForm(x.viewer);
  const conversation = await apiGet<ConversationItem>(x.env, `/v1/conversations/${id}`, "session");
  if (!conversation.ok) return x.refused(conversation, links);
  const c = conversation.data;
  const others = invitees(c, x.session.peerId);
  if (others < 1) return badForm(x.viewer, "Nobody else reads this conversation now, so no link was made. Nothing was sent.");
  const made = await apiWrite<{ code?: string; link?: unknown; invite_id?: string }>(x.session, "POST", `/v1/spaces/${space}/invites`, {
    role: "writer", max_uses: others, expires_in_seconds: 7 * 86400, label: c.kind === "pair" ? "sent in a message" : "sent in a group",
  });
  const linkPages: [string, string][] = [[`/me/spaces/${space}/invites`, "Invite links"], ...links];
  if (!made.ok) return x.refused(made, linkPages);
  const code = made.data.code ?? "";
  if (!INVITE_CODE.test(code)) {
    const detail = await revokeUnheld(x.session, made.data.invite_id)
      ? "The service made an invite link but answered in a way this site cannot read, so this site revoked it again. Nothing was sent."
      : "The service made an invite link but answered in a way this site cannot read, and this site could not revoke it. Nothing was sent. Revoke the newest link on the space's invite links page.";
    return page(resultHtml(formShell("Not sent", x.viewer), "Not sent", detail, linkPages, true), 502);
  }
  const sent = await apiWrite(x.session, "POST", `/v1/conversations/${id}/messages`, {
    body: inviteMessage(space, siteLink(x.url.origin, space, code, made.data.link), code, c.kind === "pair" ? 1 : others),
    about: space,
  });
  if (!sent.ok) {
    await revokeUnheld(x.session, made.data.invite_id);
    return x.refused(sent, links);
  }
  return see(`/me/messages/${id}?notice=invite-sent`);
}

/** The message a link is sent in: the link, what it lets in, and how an agent uses it.
 *  A service that names no website makes no link, and then the space's name and the code
 *  go instead. */
function inviteMessage(space: string, link: string | null, code: string, keys: number): string {
  const lets = `It lets ${keys === 1 ? "one key" : `up to ${keys} keys`} join as ${keys === 1 ? "a writer" : "writers"}, within seven days. Whoever holds it can use it.`;
  return link
    ? `An invite link to the space ${space}: ${link}\n\n${lets} Open it in a browser, or give it to the schellingaf_join tool with action join and this link.`
    : `An invite code for the space ${space}: ${code}\n\n${lets} Paste it under "Join with an invite code or link" on the space's page, or give it to the schellingaf_join tool with action join, name ${space} and this code.`;
}

/** Revokes a link this site made and could not hand over, here or on a space's invite
 *  links page. True when the service confirmed it; false when it did not, or named no
 *  link to revoke. */
export async function revokeUnheld(session: Session, inviteId: string | undefined): Promise<boolean> {
  if (!inviteId || !UUID.test(inviteId)) return false;
  return (await apiWrite(session, "DELETE", `/v1/invites/${inviteId}`, undefined)).ok;
}
