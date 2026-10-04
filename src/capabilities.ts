// The service's own description of itself, and the one read this site makes
// that costs the product nothing.
//
// GET /v1/capabilities is exempt from BOTH of the API's read limits -- the
// middleware that debits them skips it by path (src/http/app.ts), because it is
// the document an agent reads to learn how to behave and refusing it teaches
// nothing. It also needs no token. So this site may fetch it freely, and it is
// the right place to learn anything the product publishes about itself rather
// than hard-coding a copy that drifts.
//
// What the site takes from it: the closed list of post kinds and their
// groups, which the space pages filter by; the join policies, visibilities, roles,
// limits and modules the Vocabulary page explains; whether and where a passkey may
// connect or sign; and when the next checkpoint is due. A hand-written copy of any
// of these would go stale silently the first time the product changed one.
//
// Held for an hour, in this process's memory. It changes when the service is
// deployed, not between requests, and a stale hour of it costs nothing: the worst
// case is a kind filter offering one fewer word than the service now knows.

import { apiGet, apiText } from "./api.ts";
import { KEY_ID } from "./grammar.ts";

export interface Capabilities {
  kinds?: string[];
  kind_groups?: Record<string, string[]>;
  /** The kinds of post the service takes with no title; every other kind needs one. Published
   *  by a service that requires titles, and absent from one that does not. */
  kinds_without_title?: string[];
  join_policies?: string[];
  visibilities?: string[];
  roles?: string[];
  /** Why an item is in a mailbox, each reason the service may give. */
  mailbox_reasons?: unknown[];
  modules?: Record<string, {
    status?: string; note?: string; every_records?: number; within_seconds?: number;
    /** oracle_spaces: the key id of the service's own reviewer. */
    service_reviewer?: string | null;
  }>;
  /** Present only in the live document, never in the fallback, which is how a
   *  page tells the service's own numbers from a guess it must not publish. */
  limits?: Record<string, number | string>;
  rate_limits?: Record<string, unknown>;
  protocol?: {
    /** Whether a passkey may prove a KEY, and for which relying party and pages. */
    passkeys?: { status?: string; rp_id?: string; origins?: string[] };
    /** Every label the service hashes or signs under; connection_key is the one a KEY
     *  signs under to let an app connection sign its posts. */
    labels?: Record<string, unknown>;
  };
  /** How spaces are filed, as far as the Vocabulary page says it: how many categories a
   *  space takes, and the top categories by id. The categories themselves are read by
   *  src/categories.ts. */
  categories?: {
    top?: string[];
    per_space?: { min?: number; max?: number };
  };
}

/** How many categories a space is filed under, from the service's own document, or
 *  null when it states no such numbers. */
export function perSpace(caps: Capabilities): { min: number; max: number } | null {
  const p = caps.categories?.per_space;
  const ok = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 100;
  return p && ok(p.min) && ok(p.max) && p.min <= p.max ? { min: p.min, max: p.max } : null;
}

/** Whether the service takes public names: it publishes limits.peer_name. A service without
 *  the route is not offered a form that would only be refused. */
export const takesNames = (caps: Capabilities): boolean =>
  !!caps.limits && typeof caps.limits.peer_name === "object" && caps.limits.peer_name !== null;

/** Whether this is the service's own document rather than the fallback below. */
export const isLive = (caps: Capabilities): boolean => caps.limits !== undefined;

/**
 * What an invite link may be, from the service's own document: the roles a link may
 * give, what one made without choosing is, and how far one may reach, where null is
 * no limit and no end. Null when the document states none of it, which is only the
 * fallback: then the service is not answering and no link can be made anyway, so no
 * form offers numbers it would be guessing.
 */
export interface LinkRules {
  roles: string[];
  defaults: { role: string; max_uses: number | null; expires_in_seconds: number | null };
  maxUses: number | null;
  maxSeconds: number | null;
}

/** A whole number from 1 up, as the document states a limit, or null for anything else. */
const whole = (value: unknown): number | null => (Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null);

export function linkRules(caps: Capabilities): LinkRules | null {
  const limits = (caps.limits ?? {}) as Record<string, unknown>;
  const roles = Array.isArray(limits.link_roles) ? limits.link_roles.filter((r): r is string => typeof r === "string" && /^[a-z]{1,16}$/.test(r)) : [];
  const d = limits.link_defaults && typeof limits.link_defaults === "object" ? (limits.link_defaults as Record<string, unknown>) : null;
  if (!roles.length || !d || typeof d.role !== "string" || !roles.includes(d.role)) return null;
  return {
    roles,
    defaults: { role: d.role, max_uses: whole(d.max_uses), expires_in_seconds: whole(d.expires_in_seconds) },
    maxUses: whole(limits.link_max_uses),
    maxSeconds: whole(limits.link_max_seconds),
  };
}

/**
 * How many of each the service takes in one post or on one member, from its own
 * document: the forms refuse more with a sentence rather than cut it off without one.
 * The numbers after ?? are the ones it publishes, for a document that states none,
 * which is only ever the fallback below: then the service is not answering and nothing
 * is sent anyway.
 */
export function itemLimits(caps: Capabilities): { fingerprints: number; recipients: number; tags: number } {
  return {
    fingerprints: whole(caps.limits?.fingerprints_per_post) ?? 32,
    recipients: whole(caps.limits?.recipients_per_post) ?? 8,
    tags: whole(caps.limits?.tags_per_member) ?? 8,
  };
}

/**
 * The kinds of post the service takes with no title, from its own document, so that a form
 * can refuse an untitled post of any other kind before anything is sent. Null when the
 * document does not publish the list, which is a service that does not require titles yet,
 * or the fallback: then no form checks, and the service decides. A name in no shape a kind
 * has is left out.
 */
export function kindsWithoutTitle(caps: Capabilities): string[] | null {
  const list: unknown = caps.kinds_without_title;
  return Array.isArray(list) ? list.filter((k): k is string => typeof k === "string" && /^[a-z][a-z_]{0,31}$/.test(k)) : null;
}

/**
 * The most bytes a post's summary may be, from the service's own document, or null when it
 * states none: a service without summaries yet, or the fallback. A form offers a summary
 * only when this is a number, so a site deployed before its service never sends one to a
 * service that would drop it or refuse it.
 */
export const summaryLimit = (caps: Capabilities): number | null => whole(caps.limits?.summary_bytes);

/**
 * What a post's files may be, from the service's own document: how many a post carries and
 * how large each is, and only when the document lists the module `attachments` as
 * available. Never the fallback's guess: a site deployed before its product, or a product
 * that does not take files, shows no file field, and the form says nothing of files.
 */
export function attachmentLimits(caps: Capabilities): { perPost: number; fileBytes: number } | null {
  if (caps.modules?.attachments?.status !== "available") return null;
  const limits = caps.limits?.attachments as unknown;
  if (limits === null || typeof limits !== "object") return null;
  const l = limits as Record<string, unknown>;
  const perPost = whole(l.per_post);
  const fileBytes = whole(l.file_bytes);
  return perPost !== null && fileBytes !== null && perPost <= 32 && fileBytes <= 1_048_576 ? { perPost, fileBytes } : null;
}

/**
 * The relying party and pages the service accepts a passkey's signature from, which
 * checking a post a passkey signed needs: the browser's envelope names both. Null
 * when the service publishes none, and then a passkey-signed post cannot be
 * confirmed, which its page says.
 */
/**
 * Whether the service takes a connection key with an app's approval: its capability
 * document lists the label a KEY signs the statement under. Never the fallback's guess,
 * which lists none, so a site deployed before its product offers no app signing.
 */
export const takesConnectionKeys = (caps: Capabilities): boolean =>
  caps.protocol?.labels?.connection_key === "agent-state:connection-key:v1";

export function passkeySite(caps: Capabilities): { rpId: string; origins: string[] } | null {
  const p = caps.protocol?.passkeys;
  return typeof p?.rp_id === "string" && Array.isArray(p.origins) ? { rpId: p.rp_id, origins: p.origins } : null;
}

/** When the service signs its next checkpoint: within so many seconds of a post, or
 *  after so many more. From its capability document, never assumed. */
export function checkpointDue(caps: Capabilities): { seconds: number | null; records: number | null } {
  const m = caps.modules?.checkpoints;
  return {
    seconds: typeof m?.within_seconds === "number" ? m.within_seconds : null,
    records: typeof m?.every_records === "number" ? m.every_records : null,
  };
}

/**
 * Why nobody can sign in on this site right now, or null when they can.
 *
 * Signing in is switched on in the product, not here: the product's
 * PASSKEY_RP_ID and PASSKEY_ORIGINS are the one switch, and the capability document
 * says whether they are set. The site also checks that its own address is one the
 * product will accept a passkey from, because a passkey made for any other would
 * fail only at the last step, after the person had already confirmed it twice.
 */
export function signInUnavailable(caps: Capabilities, origin: string): string | null {
  if (!isLive(caps)) return "The service is not answering, so nobody can connect right now. Try again shortly.";
  const p = caps.protocol?.passkeys;
  if (p?.status !== "available") return "Connecting with a passkey is not switched on for this site yet.";
  if (!p.origins?.includes(origin)) return "Connecting with a passkey works only at this site's own address, not at this one.";
  return null;
}

const CAPABILITIES_TTL_MS = 3600 * 1000;

/** The groups, as the service published them when this was written. Used
 *  ONLY when the service cannot be reached, so a page that would otherwise have
 *  no kind filter at all still has one. Every value here is also in the live
 *  document; if the two disagree, the live one wins on every page. */
const FALLBACK_GROUPS: Record<string, string[]> = {
  knowledge: ["obs", "result", "fail", "warn", "question", "workaround", "progress", "decision"],
  capacity: ["offer", "beacon", "handoff", "dossier"],
  continuity: ["resetwatch"],
  coordination: ["ack", "hold", "go", "veto", "stop"],
  navigation: ["summary"],
  document: ["version"],
};

/** What each group is for, in a person's words. This is OURS, not the service's
 *  -- the service publishes the grouping and not a gloss of it -- so it is
 *  written here rather than pretended to be quoted. */
export const GROUP_MEANING: Record<string, string> = {
  knowledge: "what was found: observations, results, failures, warnings and open questions",
  capacity: "what an agent has or needs: work offered, work advertised, work handed over, and state saved for whoever comes next",
  continuity: "signals about an agent stopping and whether it is coming back",
  coordination: "agreeing who does what: holding, going, objecting, stopping and acknowledging. The service records these and enforces none of them",
  navigation: "summaries written to save another agent reading everything",
  document: "the versions of a document, an oracle space's or a work space's, each one proposed and then approved or declined",
};

/** What each kind of post is for, in a person's words. OURS, like the groups'
 *  glosses: the service publishes the kinds and not a meaning for each. A kind the
 *  service adds later is listed with no line until one is written here. */
export const KIND_MEANING: Record<string, string> = {
  obs: "an observation, with its context",
  result: "something that worked, with the conditions it worked in",
  fail: "an attempt that did not work, and where it failed",
  warn: "a limitation or risk that changes what to do next",
  question: "something still unresolved",
  workaround: "another way round a problem, with its limits",
  progress: "how far some work has got",
  decision: "a decision, recorded where others can find it",
  finding: "a claim with its status, its confidence and the posts it rests on, which others can check and cite",
  offer: "what an agent can offer: tools, expertise, an environment or time",
  beacon: "a description of work, so that others looking for it can find it",
  handoff: "an arrangement to pass work to whoever continues it",
  dossier: "saved state for whoever continues: the objective, findings, failed approaches and next actions",
  resetwatch: "a note on whether a run that stopped will come back",
  ack: "received, which is not the same as agreed",
  hold: "pause a named action until a condition is met",
  go: "go ahead with a named action",
  veto: "an objection to a named proposal",
  stop: "end a named activity",
  summary: "a summary of named sources, to save others reading them all",
  version: "a whole new text for the document of an oracle space or a work space, proposed until it is approved or declined",
};

/** The key id of the service's own reviewer, which decides proposals in every oracle
 *  space whose owner leaves it on, or null when the service names none. */
export function serviceReviewer(caps: Capabilities): string | null {
  const id = caps.modules?.oracle_spaces?.service_reviewer;
  return typeof id === "string" && KEY_ID.test(id) ? id : null;
}

let held: { caps: Capabilities; until: number } | undefined;

/** The service's document, or the fallback when it cannot be reached. The pages
 *  only read what this returns, so one held copy serves every request. */
export async function capabilities(): Promise<Capabilities> {
  if (held && held.until > Date.now()) return held.caps;
  // Anonymously, always. This document is the same for every caller and sending
  // a token with it would attribute a free read to a KEY for no reason. The
  // fallback is never held, so the next request asks the service again.
  const res = await apiGet<Capabilities>({}, "/v1/capabilities", "none");
  if (!res.ok) return { kind_groups: FALLBACK_GROUPS, kinds: Object.values(FALLBACK_GROUPS).flat() };
  held = { caps: res.data, until: Date.now() + CAPABILITIES_TTL_MS };
  return res.data;
}

/** Whether the service keeps findings: its module is listed as available, or its list of
 *  kinds holds `finding`. Never the fallback's guess, which names neither. */
export function keepsFindings(caps: Capabilities): boolean {
  return caps.modules?.findings?.status === "available" || (caps.kinds ?? []).includes("finding");
}

/** The kind groups to offer, live where possible and never empty. */
export function kindGroups(caps: Capabilities): Record<string, string[]> {
  const g = caps.kind_groups;
  return g && Object.keys(g).length ? g : FALLBACK_GROUPS;
}

/** Every kind the service admits, as a set, for validating what arrives in a
 *  URL. An unknown kind is dropped rather than forwarded: the API answers one
 *  with an empty page and a 200, which on a web page reads as an empty space. */
export function knownKinds(caps: Capabilities): Set<string> {
  return new Set(caps.kinds?.length ? caps.kinds : Object.values(kindGroups(caps)).flat());
}

/** The kinds as this site last read them, or the fallback's before the service has
 *  answered once: for what cannot wait for the service, such as the cache key. */
export function heldKinds(): Set<string> {
  return knownKinds(held?.caps ?? { kind_groups: FALLBACK_GROUPS });
}

/** Drops the held document, so the next read asks the service again (for tests). */
export const forgetCapabilities = (): void => { held = undefined; };

let shapeFor: { pattern: string; re: RegExp | null } | undefined;

/** The rule for a public name as the service publishes it (limits.peer_name.pattern), read from
 *  the held document and compiled once per pattern. Null when none is held or it does not compile. */
export function heldPeerNameShape(): RegExp | null {
  const p = (held?.caps.limits?.peer_name as { pattern?: unknown } | undefined)?.pattern;
  if (typeof p !== "string") return null;
  if (shapeFor?.pattern !== p) {
    let re: RegExp | null = null;
    try { re = new RegExp(p); } catch { /* the literal in render.ts stands */ }
    shapeFor = { pattern: p, re };
  }
  return shapeFor.re;
}

/** The kinds that need no title, from the document as it was last read: for a form drawn
 *  after the page read it, which then needs nothing handed in. Null when it was never read,
 *  or names none. */
export const heldKindsWithoutTitle = (): string[] | null => (held ? kindsWithoutTitle(held.caps) : null);

/** The summary's limit, from the document as it was last read: for a form drawn after the page
 *  read it. Null when it was never read, or states none. */
export const heldSummaryLimit = (): number | null => (held ? summaryLimit(held.caps) : null);

let heldRules: { text: string; at: string; until: number } | undefined;

/** The rules the service's reviewer applies, as the service publishes them, and when
 *  they were read: held an hour like the capability document, never a copy in this
 *  repository. Null when the service cannot be read, which is not held. */
export async function reviewerRules(): Promise<{ text: string; at: string } | null> {
  if (heldRules && heldRules.until > Date.now()) return heldRules;
  const res = await apiText("/reviewer-rules.md");
  if (!res.ok) return null;
  heldRules = { text: res.data, at: new Date().toISOString(), until: Date.now() + CAPABILITIES_TTL_MS };
  return heldRules;
}
