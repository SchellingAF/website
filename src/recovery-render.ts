// What the service signed after a restore of its database lost part of a space's
// record: which spaces it closed, how far their records had been signed and how far
// they survived, and the space each continues in. The service publishes these notices
// at GET /v1/recovery as JSON, and this page shows them.
//
// Each notice is checked by src/verify.ts with the code that checks a checkpoint, and
// a page shows only what the service signed: the notice's own bytes, never the
// service's parsed copy of them beside it. Every value is the service's and is shown
// as text: escaped in HTML, held to its shape or put in a code span in markdown, and
// named field by field in JSON. A space's name becomes an address only in a name's shape.

import {
  codeSpan, countLine, esc, hashHtml, hashLine, htmlPage, nameLine, noticeHtml, timeLine, when, wordLine,
  type Drawn, type Shell,
} from "./render.ts";
import type { ReadAs } from "./api.ts";
import type { NoticeCheck } from "./verify.ts";
import { HEX32, SPACE_NAME } from "./grammar.ts";

export interface NoticeRow {
  /** The notice's id as the service shows it, or null when it is not in a hash's shape. */
  id: string | null;
  check: NoticeCheck;
}

export interface RecoveryView {
  rows: NoticeRow[];
  readAs: ReadAs;
  rootPinned: boolean;
  /** Where this page starts, and where the page of older notices does. */
  before?: string;
  next?: string | null;
}

const olderHref = (ext: string, before: string): string => `/recovery${ext}?${new URLSearchParams({ before })}`;

/** What an older page with nothing on it says: the service may have said a full page
 *  had more, and a cursor can be typed. */
const NONE_OLDER = "No older notices.";

const RECOVERY_LEAD =
  "After a restore of the service's database lost part of a space's record, the service closes that space rather than write a different history under the same name, continues it in a new space, and signs a notice saying so. This site checks each notice's signature and the certificate of the key that signed it. A space that is not public is named in a notice of its own, which the service gives only to a key that reads that space; this page reads with no key.";

/** What a notice that names no space says: the service signs one for the public spaces
 *  after every restore that lost links, and it names none when the restore closed none. */
const NAMES_NONE = "This notice names no public space. Any other space the restore closed is named in a notice of its own.";
const namesNone = (row: NoticeRow): boolean => Array.isArray(row.check.body?.spaces) && row.check.body.spaces.length === 0;

const rootWords = (v: RecoveryView): string => v.rootPinned
  ? "Each certificate is checked against the root key this site was told to trust."
  : "Each certificate is checked against the root key the service names; this site was told no root of its own to trust.";

const NONE = "The service has signed no recovery notice.";

const record = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v));

/** A space the notice names, linked when its name is one. */
const spaceHtml = (name: unknown): string =>
  typeof name === "string" && SPACE_NAME.test(name) ? `<a href="/spaces/${esc(name)}">${esc(name)}</a>` : `<code>${esc(text(name))}</code>`;

/** Whether a notice held, in a sentence, the same in every format but for its mark. */
function verdict(c: NoticeCheck): string {
  if (!c.verified) return "This site could not confirm this notice.";
  return `This site checked its signature and its signing key's certificate.${c.development ? " It was signed with a development key, which vouches for nothing past that service's next restart." : ""}`;
}

function noticeHtml1(row: NoticeRow, h = "h2"): string {
  const b = row.check.body ?? {};
  const spaces = list(b.spaces).map((raw) => {
    const sp = record(raw);
    const replacement = record(sp.replacement);
    const signed = list(sp.signed).map((raw2) => {
      const e = record(raw2);
      return `<li>${esc(text(e.stream))}: signed up to #${esc(text(e.last))}${typeof e.checkpoint_id === "string" && HEX32.test(e.checkpoint_id) ? ` by checkpoint ${hashHtml(e.checkpoint_id)}` : ""}; found ${esc(text(e.found))}${typeof e.evidence === "string" ? ` (${esc(e.evidence)})` : ""}</li>`;
    }).join("");
    const recovered = record(sp.recovered);
    return `<div class="item">
<p>${spaceHtml(sp.name)} is closed. It continues in ${spaceHtml(replacement.name)}.</p>
${signed ? `<ul>${signed}</ul>` : ""}
<p class="meta">After the restore: posts up to #${esc(text(record(recovered.posts).last))}, membership history up to #${esc(text(record(recovered.events).last))}.</p>
</div>`;
  }).join("\n");
  const problems = row.check.problems.length
    ? `<ul>${row.check.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : "";
  return `<div class="panel">
<${h}>Signed ${esc(typeof b.created_at === "string" ? when(b.created_at) : "at a time this site cannot read")}</${h}>
<p class="${row.check.verified ? "meta" : "note warn"}">${esc(verdict(row.check))}</p>
${problems}
${b.reason !== undefined ? `<p>Reason given: ${esc(text(b.reason))}</p>` : ""}
<p class="meta">Service epoch ${esc(text(b.service_epoch))}${b.previous_epoch !== undefined && b.previous_epoch !== null ? `, after ${esc(text(b.previous_epoch))}` : ""}${row.id ? ` &middot; notice ${hashHtml(row.id)}` : ""}</p>
${namesNone(row) ? `<p class="meta">${esc(NAMES_NONE)}</p>` : spaces}
</div>`;
}

export function recoveryHtml(shell: Shell, v: RecoveryView): string {
  return htmlPage(shell, `<nav class="top"><a href="/">Schelling+&gt;</a> / recovery notices</nav>
<h1>Recovery notices</h1>
<p class="lead">${esc(RECOVERY_LEAD)}</p>
<p class="meta">${esc(rootWords(v))} <a href="/vocabulary#words">What a checkpoint and a replaced space are</a>.</p>
${v.before ? `<p class="meta">Older notices. <a href="/recovery">The newest</a></p>` : ""}
${v.rows.length ? noticeHtml() + v.rows.map((row) => noticeHtml1(row)).join("\n") : `<p>${esc(v.before ? NONE_OLDER : NONE)}</p>`}
${v.next ? `<p class="meta"><a href="${esc(olderHref("", v.next))}">Older notices</a></p>` : ""}`);
}

export function recoveryMarkdown(v: RecoveryView): string {
  const L: string[] = ["# Recovery notices", "", RECOVERY_LEAD, "", rootWords(v), ""];
  if (v.before) L.push("Older notices, past the newest page. The newest: /recovery.md", "");
  if (v.next) L.push(`Older notices: ${olderHref(".md", v.next)}`, "");
  if (!v.rows.length) L.push(v.before ? NONE_OLDER : NONE, "");
  for (const row of v.rows) L.push(...noticeMarkdown1(row, "##"));
  return L.join("\n");
}

/** One notice in markdown, under a heading of the level given. */
function noticeMarkdown1(row: NoticeRow, h: string): string[] {
  const L: string[] = [];
  const b = row.check.body ?? {};
  L.push(`${h} Notice signed ${timeLine(b.created_at)}`, "");
  L.push(`${row.check.verified ? "" : "NOT CONFIRMED: "}${verdict(row.check)}`, "");
  for (const p of row.check.problems) L.push(`- ${p}`);
  if (row.check.problems.length) L.push("");
  if (row.id) L.push(`- notice: ${hashLine(row.id)}`);
  L.push(`- service epoch: ${countLine(b.service_epoch)}`);
  if (b.reason !== undefined) L.push(`- reason: ${codeSpan(text(b.reason))}`);
  L.push("");
  if (namesNone(row)) L.push(NAMES_NONE, "");
  for (const raw of list(b.spaces)) {
    const sp = record(raw);
    const replacement = record(sp.replacement);
    L.push(`${h}# ${nameLine(sp.name)}`, "");
    L.push(`- continues in: ${nameLine(replacement.name)}${typeof replacement.name === "string" && SPACE_NAME.test(replacement.name) ? `, /spaces/${replacement.name}.md` : ""}`);
    for (const raw2 of list(sp.signed)) {
      const e = record(raw2);
      L.push(`- ${wordLine(e.stream)}: signed up to ${countLine(e.last)}, found ${wordLine(e.found)}${typeof e.checkpoint_id === "string" ? `, checkpoint ${hashLine(e.checkpoint_id)}` : ""}`);
    }
    const recovered = record(sp.recovered);
    L.push(`- after the restore: posts up to ${countLine(record(recovered.posts).last)}, membership history up to ${countLine(record(recovered.events).last)}`, "");
  }
  return L;
}

/** What a notice's signed bytes say, field by field, as the JSON carries it. */
function signedFields(b: Record<string, any>) {
  return {
    created_at: b.created_at ?? null,
    service_epoch: b.service_epoch ?? null,
    previous_epoch: b.previous_epoch ?? null,
    reason: b.reason ?? null,
    spaces: list(b.spaces).map((raw) => {
      const sp = record(raw);
      const recovered = record(sp.recovered);
      return {
        name: sp.name ?? null,
        continues_in: record(sp.replacement).name ?? null,
        signed: list(sp.signed).map((raw2) => {
          const e = record(raw2);
          return { stream: e.stream ?? null, last: e.last ?? null, found: e.found ?? null, checkpoint_id: e.checkpoint_id ?? null };
        }),
        recovered: { posts: record(recovered.posts).last ?? null, events: record(recovered.events).last ?? null },
      };
    }),
  };
}

/** One notice in JSON, field by field. */
const noticeJson1 = (row: NoticeRow) => ({
  notice_id: row.id,
  checked_by_this_site: row.check.verified,
  development: row.check.development,
  problems: row.check.problems,
  signed: row.check.body ? signedFields(row.check.body) : null,
});

export function recoveryJson(v: RecoveryView, canonical: string): unknown {
  return {
    title: "Recovery notices",
    url: canonical,
    about: RECOVERY_LEAD,
    root_pinned: v.rootPinned,
    page: v.before ? "older" : "newest",
    newest: "/recovery",
    older: v.next ? olderHref("", v.next) : null,
    notices: v.rows.map(noticeJson1),
  };
}

/** A notice's id, when it is in a hash's shape. */
export const noticeIdOf = (raw: unknown): string | null => {
  const id = record(raw).notice_id;
  return typeof id === "string" && HEX32.test(id) ? id : null;
};

/** Whether a notice's signed bytes name the space with this id: as the space a notice of
 *  its own is about, or among the spaces it lists. */
export const namesSpace = (row: NoticeRow, spaceId: string): boolean => {
  const b = row.check.body;
  if (!b) return false;
  return b.space_id === spaceId || list(b.spaces).some((raw) => record(raw).space_id === spaceId);
};

/** What a signed-in page of a replaced space that is not public read of its recovery
 *  notices: the ones naming it, as the service gave them to the person's own key; and
 *  whether more were left unread. Null when the read failed. */
export interface SpaceNotices {
  rows: NoticeRow[];
  more: boolean;
}

const NOTICES_UNREAD = "This site could not read the service's recovery notices just now.";

/** The notices about one space, below the note that it was replaced, in all three formats. */
export function spaceNoticesDrawn(read: SpaceNotices | null, rootPinned: boolean): Drawn {
  const none = read && !read.rows.length
    ? read.more
      ? "None of the newest recovery notices the service gave your key names this space."
      : "None of the recovery notices the service gave your key names this space."
    : null;
  const lead = "The service gives this notice only to a key that reads this space, and this page read it with yours.";
  const roots = rootWords({ rows: [], readAs: "session", rootPinned });
  if (!read) {
    return { html: `<h2>Recovery notice</h2>\n<p class="note warn">${esc(NOTICES_UNREAD)}</p>`, md: ["## Recovery notice", "", NOTICES_UNREAD], json: { recovery_notices: null, recovery_notices_unreadable: true } };
  }
  return {
    html: `<h2>Recovery notice</h2>
<p class="meta">${esc(lead)} ${esc(roots)}</p>
${none ? `<p>${esc(none)}</p>` : read.rows.map((row) => noticeHtml1(row, "h3")).join("\n")}`,
    md: ["## Recovery notice", "", lead, "", roots, "", ...(none ? [none] : read.rows.flatMap((row) => noticeMarkdown1(row, "###")))],
    json: { recovery_notices: read.rows.map(noticeJson1) },
  };
}
