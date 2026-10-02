// The categories every space is filed under, read from the product and held here.
//
// Every space is filed under one to three categories from one list for the whole
// service, the first of them its main one. The list is the product's: it serves it at
// GET /v1/categories, needs no key for it, and answers it from memory without
// counting it against any read allowance, as it does its capability document. So this
// site reads it the way src/capabilities.ts reads that document, and keeps no copy of
// its own that could drift from it.
//
// TWO READS, EACH HELD. The whole list with what each category is for, which changes
// only when the product is deployed, is held an hour. How many listed spaces each
// category holds, which the product counts at most once a minute, is held ten
// minutes. Each is asked for one request at a time; a page that finds a copy in hand
// never waits for a fresh one; and a read that fails keeps the last good copy and is
// tried again at most once a minute. Keeping an old copy is safe because the product
// never deletes or reuses a category's id: an old copy lacks at most the newest ones,
// and an id in the right shape that it lacks is read again within a minute of
// somebody asking for it (unknownId), rather than waiting out the hour; a form sends
// such an id on for the service to judge. Only before the first good read is there
// nothing, and every page that needs the list says so rather than guessing.
//
// EVERYTHING HERE IS THE SERVICE'S TEXT, and a page treats it as it treats a space's
// title: escaped in HTML, and in markdown bare only in a shape that cannot become
// structure. An entry this site cannot use -- an id in the wrong shape, a parent it
// cannot find, a status it does not know -- is dropped, never shown half-read, and
// the list is cut at five thousand.

import { apiGet } from "./api.ts";
import { CATEGORY_ID, ISO_TIME, WIKIDATA_ID } from "./grammar.ts";

export interface Category {
  id: string;
  label: string;
  parent: string | null;
  /** 1 for a top category, counted here from the parents rather than taken on trust. */
  depth: number;
  status: "active" | "retired";
  /** Where a retired category's spaces belong now, when the service names a place. */
  replacedBy: string | null;
  /** What a named entry is: a tool, a model, a benchmark, a law. Null for a subject. */
  type: string | null;
  /** What goes in it. */
  description: string;
  /** What does not, and where it goes instead. */
  elsewhere: string;
  examples: string[];
  aliases: string[];
  /** A Wikidata item's id, in its shape, or null. */
  wikidata: string | null;
  homepage: string | null;
  since: string | null;
}

export interface Register {
  version: string;
  /** In the service's own order, which is the order a person reads them in. */
  list: Category[];
  byId: ReadonlyMap<string, Category>;
  /** Each category's children, in order; the top categories under null. */
  children: ReadonlyMap<string | null, Category[]>;
  /** Every label and every alias, lowercased with its spacing collapsed, and what it names. */
  labels: ReadonlyMap<string, Category[]>;
  aliases: ReadonlyMap<string, Category[]>;
}

export interface Counts {
  /** When the service counted, as it wrote it, or "" when it wrote no time. */
  at: string;
  /** Listed spaces in each category, itself and everything inside it. */
  spaces: ReadonlyMap<string, number>;
  /** How many of those are oracle spaces, the rest being work spaces, never more than all
   *  of them; null when the service does not count the kinds apart, as an older one
   *  does not, and then no page splits a count. */
  oracles: ReadonlyMap<string, number> | null;
}

/** The two kinds of space, each with a list of its own. */
export type SpaceKind = "work" | "oracle";

/** The most categories this site will read. The list the product ships has 546. */
export const MOST_CATEGORIES = 5000;

const HOUR_MS = 3600 * 1000;
const TEN_MINUTES_MS = 600 * 1000;
const RETRY_MS = 60 * 1000;

/** Anything but a string is no text. */
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** A list of short texts, or none. */
const texts = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 50) : [];

/** What a person types, as it is compared with a label: case and spacing ignored. */
export const normalName = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** An https address, or nothing. */
function httpsAddress(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The list as the service answered it, with every entry this site can use and none it
 * cannot. Null when nothing usable came back, which the caller treats as a failed read.
 */
export function readableRegister(raw: unknown): Register | null {
  const doc = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (!Array.isArray(doc.categories)) return null;
  // Each entry this site can read, by id, the first of any id given twice.
  const read = new Map<string, { r: Record<string, unknown>; label: string; parent: string | null }>();
  for (const item of doc.categories.slice(0, MOST_CATEGORIES)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = text(r.id);
    const label = text(r.label).trim();
    const parent = r.parent === null ? null : text(r.parent);
    if (!CATEGORY_ID.test(id) || !label || label.length > 200 || read.has(id)) continue;
    if (parent !== null && !CATEGORY_ID.test(parent)) continue;
    if (r.status !== "active" && r.status !== "retired") continue;
    read.set(id, { r, label, parent });
  }

  // Kept only when every category above it is kept: reached walking down from the top
  // categories, nine levels at most, so an entry under a parent that is missing, or in
  // a loop, is never reached, and is dropped with everything below it.
  const under = new Map<string | null, string[]>();
  for (const [id, { parent }] of read) {
    const at = under.get(parent);
    if (at) at.push(id);
    else under.set(parent, [id]);
  }
  const depths = new Map<string, number>();
  let level: (string | null)[] = [null];
  for (let d = 1; d <= 9 && level.length; d++) {
    const reached = level.flatMap((p) => under.get(p) ?? []);
    for (const id of reached) depths.set(id, d);
    level = reached;
  }

  const list: Category[] = [];
  for (const [id, { r, label, parent }] of read) {
    const d = depths.get(id);
    if (d === undefined) continue;
    const replacedBy = text(r.replaced_by);
    const wikidata = text(r.wikidata);
    const since = text(r.since);
    list.push({
      id,
      label,
      parent,
      depth: d,
      status: r.status as Category["status"],
      // A successor only when it is kept itself, so every page can name and link it.
      replacedBy: depths.has(replacedBy) ? replacedBy : null,
      type: text(r.type) || null,
      description: text(r.description),
      elsewhere: text(r.elsewhere),
      examples: texts(r.examples),
      aliases: texts(r.aliases),
      wikidata: WIKIDATA_ID.test(wikidata) ? wikidata : null,
      homepage: httpsAddress(r.homepage),
      since: /^\d{4}-\d{2}-\d{2}$/.test(since) || ISO_TIME.test(since) ? since : null,
    });
  }
  if (list.length === 0) return null;

  const byId = new Map(list.map((c) => [c.id, c]));
  const children = new Map<string | null, Category[]>();
  const labels = new Map<string, Category[]>();
  const aliases = new Map<string, Category[]>();
  const add = (map: Map<string, Category[]>, key: string, c: Category) => {
    const k = normalName(key);
    if (!k) return;
    const at = map.get(k) ?? [];
    if (!at.includes(c)) at.push(c);
    map.set(k, at);
  };
  for (const c of list) {
    const at = children.get(c.parent) ?? [];
    at.push(c);
    children.set(c.parent, at);
    add(labels, c.label, c);
    for (const a of c.aliases) add(aliases, a, c);
  }
  return { version: text(doc.version), list, byId, children, labels, aliases };
}

/** The counts as the service answered them, or null when they are not counts. */
export function readableCounts(raw: unknown): Counts | null {
  const doc = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (!Array.isArray(doc.categories)) return null;
  const spaces = new Map<string, number>();
  const oracles = new Map<string, number>();
  const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
  for (const item of doc.categories.slice(0, MOST_CATEGORIES)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = text(r.id);
    if (!CATEGORY_ID.test(id) || !count(r.spaces)) continue;
    spaces.set(id, r.spaces);
    // Of those, the oracle spaces: never more than all of them, whatever the answer says.
    if (count(r.oracle_spaces)) oracles.set(id, Math.min(r.oracle_spaces, r.spaces));
  }
  const at = text(doc.counted_at);
  // A service that counts the kinds apart says so on every category it counts; one that
  // says it on none is older, and its counts stay whole.
  return { at: ISO_TIME.test(at) ? at : "", spaces, oracles: oracles.size ? oracles : null };
}

/**
 * One of the product's documents, read as this module reads both: held for `ttl`, one
 * read at a time, a copy in hand served while a fresh one is fetched, and a failed read
 * tried again at most once a minute while the last good copy goes on answering.
 */
function held<T>(path: string, readable: (raw: unknown) => T | null, ttl: number) {
  let good: T | null = null;
  let readAt = 0;
  let freshUntil = 0;
  let nextTry = 0;
  let asking: Promise<void> | null = null;
  const read = async (): Promise<T | null> => {
    const now = Date.now();
    if (good !== null && now < freshUntil) return good;
    if (asking === null && now >= nextTry) {
      asking = (async () => {
        // With no key, always: the list is the same for everybody, and the service
        // answers it without looking at a token.
        const res = await apiGet<unknown>({}, path, "none");
        const made = res.ok ? readable(res.data) : null;
        if (made !== null) {
          good = made;
          readAt = Date.now();
          freshUntil = readAt + ttl;
        } else {
          nextTry = Date.now() + RETRY_MS;
        }
      })().finally(() => { asking = null; });
    }
    // Only a page with nothing in hand waits, and only for the read already going.
    if (good === null && asking !== null) await asking;
    return good;
  };
  /** Read again a minute after the last good read, rather than an hour: somebody asked
   *  for an id the copy in hand does not have, which a release of the list since then
   *  may have added. At most once a minute, however often it is asked. */
  const soon = (): void => {
    if (good !== null) freshUntil = Math.min(freshUntil, readAt + RETRY_MS);
  };
  return Object.assign(read, { soon });
}

/** Every category, or null before the first good read. */
export const register = held("/v1/categories?depth=4&detail=full", readableRegister, HOUR_MS);

/** An id in the right shape that the copy in hand does not hold: a release may have
 *  added it, so the list is read again within a minute. */
export function unknownId(typed: string): void {
  if (CATEGORY_ID.test(typed)) register.soon();
}

/** How many listed spaces each category holds, or null before the first good read. */
export const categoryCounts = held("/v1/categories?depth=4&counts=true", readableCounts, TEN_MINUTES_MS);

/** A category and every category above it, the top one first. */
export function pathOf(reg: Register, id: string): Category[] {
  const out: Category[] = [];
  for (let c = reg.byId.get(id); c; c = c.parent === null ? undefined : reg.byId.get(c.parent)) {
    out.unshift(c);
    if (out.length > 8) break;
  }
  return out;
}

/** Whether `inner` is `outer` or anywhere inside it. */
export const isWithin = (reg: Register, inner: string, outer: string): boolean =>
  pathOf(reg, inner).some((c) => c.id === outer);

/** How many listed spaces a category holds, or null when the counts are not in hand. */
export const countOf = (counts: Counts | null, id: string): number | null =>
  counts ? (counts.spaces.get(id) ?? 0) : null;

/** How many listed spaces of one kind a category holds, or null when that is not known:
 *  the counts are not in hand, or the service does not count the kinds apart. */
export function kindCountOf(counts: Counts | null, id: string, kind: SpaceKind): number | null {
  if (!counts?.oracles) return null;
  const all = counts.spaces.get(id) ?? 0;
  const oracle = counts.oracles.get(id) ?? 0;
  return kind === "oracle" ? oracle : all - oracle;
}

/** The categories among `among` that hold a space, of one kind when `kind` names one and
 *  the service counts the kinds apart, busiest first by that count. The sort is stable,
 *  so a tie keeps the order `among` came in, which every caller gives in the service's. */
export function busiest(counts: Counts, among: Category[], kind: SpaceKind | null = null): Category[] {
  const n = (c: Category) => (kind === null ? null : kindCountOf(counts, c.id, kind)) ?? counts.spaces.get(c.id) ?? 0;
  return among.filter((c) => n(c) > 0).sort((a, b) => n(b) - n(a));
}

/** Where a category sits: the names of the categories above it. */
export const placeOf = (reg: Register, id: string): string =>
  pathOf(reg, id).slice(0, -1).map((c) => c.label).join(" › ");

/** What a name a person typed is: exactly one category, several, or none, and which of
 *  their names it was. */
export type Resolved =
  | { kind: "one"; category: Category; matched: "id" | "label" | "alias" }
  | { kind: "several"; categories: Category[]; matched: "label" | "alias" }
  | { kind: "none" };

/**
 * The category a person means by an id, a label or an alias, with case and spacing
 * ignored and nothing looser: a name that is not exactly one of those is no category
 * here. The service's lookup, which ranks near misses, is what the lookup box asks.
 * An id wins over a label, and a label over an alias; two categories may share a
 * label, a model family and the company that makes it, and then both are answered.
 */
export function resolveCategory(reg: Register, typed: string): Resolved {
  const name = normalName(typed);
  if (!name) return { kind: "none" };
  const byId = reg.byId.get(name);
  if (byId) return { kind: "one", category: byId, matched: "id" };
  for (const [matched, map] of [["label", reg.labels], ["alias", reg.aliases]] as const) {
    const found = map.get(name);
    if (found?.length === 1) return { kind: "one", category: found[0]!, matched };
    if (found) return { kind: "several", categories: found, matched };
  }
  return { kind: "none" };
}

/** A name a person typed, as a sentence quotes it: on one line, and not the whole of a long one. */
const quoted = (typed: string): string => {
  const flat = typed.replace(/\s+/g, " ").trim();
  return flat.length > 64 ? `${flat.slice(0, 63)}…` : flat;
};

/** A category as a sentence names it. */
export const named = (c: Category): string => `${c.label} (${c.id})`;

export type Filing = { ok: true; ids: string[] } | { ok: false; why: string };

/**
 * The categories a form names, checked by the service's rules before the service is
 * asked, and why not in one sentence. The fields are in order, the first the main one.
 * No field filled is no filing at all, which the caller decides the meaning of: a new
 * space needs one, and settings left blank change nothing.
 *
 * An id this site's copy of the list does not hold is sent on, normalised, and so is
 * every id without the list in hand: the copy can be an hour older than the service's,
 * and the service names the nearest categories when it refuses one. A name that is no
 * id and no category is refused here.
 */
export function resolveFiling(reg: Register | null, fields: string[]): Filing {
  const typed = fields.map((f) => f.trim());
  if (typed.every((t) => t === "")) return { ok: true, ids: [] };
  if (typed[0] === "") return { ok: false, why: "The first category is the space's main one: fill it in first." };
  const chosen: Category[] = [];
  const ids: string[] = [];
  for (const t of typed.filter(Boolean)) {
    const found: Resolved = reg ? resolveCategory(reg, t) : { kind: "none" };
    if (found.kind === "none") {
      const id = normalName(t);
      if (CATEGORY_ID.test(id)) {
        ids.push(id);
        continue;
      }
      return {
        ok: false,
        why: reg
          ? `No category is called ${quoted(t)}. Every category, with a box that looks a name up, is at /spaces/by/category.`
          : `${quoted(t)} is not a category id, and the list of categories cannot be read just now to look it up. Try again in a minute.`,
      };
    }
    if (found.kind === "several") {
      return { ok: false, why: `${quoted(t)} names more than one category: ${found.categories.map(named).join(", ")}. Use one of those ids.` };
    }
    const c = found.category;
    if (c.status === "retired") {
      const next = reg!.byId.get(c.replacedBy ?? c.parent ?? "");
      return { ok: false, why: `${named(c)} is retired and takes no new spaces.${next ? ` File this one under ${named(next)} instead.` : ""}` };
    }
    if (chosen.some((x) => x.id === c.id)) return { ok: false, why: `${named(c)} is listed twice.` };
    chosen.push(c);
    ids.push(c.id);
  }
  for (const a of chosen) {
    for (const b of chosen) {
      if (a !== b && isWithin(reg!, b.id, a.id)) {
        return { ok: false, why: `${named(b)} is inside ${named(a)}. List only ${b.label}: the narrower one is enough.` };
      }
    }
  }
  return { ok: true, ids };
}
