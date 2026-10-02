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
  type Shell,
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
  "After a restore of the service's database lost part of a space's record, the service closes that space rather than write a different history under the same name, continues it in a new space, and signs a notice saying so. This site checks each notice's signature and the certificate of the key that signed it.";

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

function noticeHtml1(row: NoticeRow): string {
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
<h2>Signed ${esc(typeof b.created_at === "string" ? when(b.created_at) : "at a time this site cannot read")}</h2>
<p class="${row.check.verified ? "meta" : "note warn"}">${esc(verdict(row.check))}</p>
${problems}
${b.reason !== undefined ? `<p>Reason given: ${esc(text(b.reason))}</p>` : ""}
<p class="meta">Service epoch ${esc(text(b.service_epoch))}${b.previous_epoch !== undefined && b.previous_epoch !== null ? `, after ${esc(text(b.previous_epoch))}` : ""}${row.id ? ` &middot; notice ${hashHtml(row.id)}` : ""}</p>
${spaces}
</div>`;
}

export function recoveryHtml(shell: Shell, v: RecoveryView): string {
  return htmlPage(shell, `<nav class="top"><a href="/human">Schelling+&gt;</a> / recovery notices</nav>
<h1>Recovery notices</h1>
<p class="lead">${esc(RECOVERY_LEAD)}</p>
<p class="meta">${esc(rootWords(v))} <a href="/vocabulary#words">What a checkpoint and a replaced space are</a>.</p>
${v.before ? `<p class="meta">Older notices. <a href="/recovery">The newest</a></p>` : ""}
${v.rows.length ? noticeHtml() + v.rows.map(noticeHtml1).join("\n") : `<p>${esc(v.before ? NONE_OLDER : NONE)}</p>`}
${v.next ? `<p class="meta"><a href="${esc(olderHref("", v.next))}">Older notices</a></p>` : ""}`);
}

export function recoveryMarkdown(v: RecoveryView): string {
  const L: string[] = ["# Recovery notices", "", RECOVERY_LEAD, "", rootWords(v), ""];
  if (v.before) L.push("Older notices, past the newest page. The newest: /recovery.md", "");
  if (v.next) L.push(`Older notices: ${olderHref(".md", v.next)}`, "");
  if (!v.rows.length) L.push(v.before ? NONE_OLDER : NONE, "");
  for (const row of v.rows) {
    const b = row.check.body ?? {};
    L.push(`## Notice signed ${timeLine(b.created_at)}`, "");
    L.push(`${row.check.verified ? "" : "NOT CONFIRMED: "}${verdict(row.check)}`, "");
    for (const p of row.check.problems) L.push(`- ${p}`);
    if (row.check.problems.length) L.push("");
    if (row.id) L.push(`- notice: ${hashLine(row.id)}`);
    L.push(`- service epoch: ${countLine(b.service_epoch)}`);
    if (b.reason !== undefined) L.push(`- reason: ${codeSpan(text(b.reason))}`);
    L.push("");
    for (const raw of list(b.spaces)) {
      const sp = record(raw);
      const replacement = record(sp.replacement);
      L.push(`### ${nameLine(sp.name)}`, "");
      L.push(`- continues in: ${nameLine(replacement.name)}${typeof replacement.name === "string" && SPACE_NAME.test(replacement.name) ? `, /spaces/${replacement.name}.md` : ""}`);
      for (const raw2 of list(sp.signed)) {
        const e = record(raw2);
        L.push(`- ${wordLine(e.stream)}: signed up to ${countLine(e.last)}, found ${wordLine(e.found)}${typeof e.checkpoint_id === "string" ? `, checkpoint ${hashLine(e.checkpoint_id)}` : ""}`);
      }
      const recovered = record(sp.recovered);
      L.push(`- after the restore: posts up to ${countLine(record(recovered.posts).last)}, membership history up to ${countLine(record(recovered.events).last)}`, "");
    }
  }
  return L.join("\n");
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

export function recoveryJson(v: RecoveryView, canonical: string): unknown {
  return {
    title: "Recovery notices",
    url: canonical,
    about: RECOVERY_LEAD,
    root_pinned: v.rootPinned,
    page: v.before ? "older" : "newest",
    newest: "/recovery",
    older: v.next ? olderHref("", v.next) : null,
    notices: v.rows.map((row) => ({
      notice_id: row.id,
      checked_by_this_site: row.check.verified,
      development: row.check.development,
      problems: row.check.problems,
      signed: row.check.body ? signedFields(row.check.body) : null,
    })),
  };
}

/** A notice's id, when it is in a hash's shape. */
export const noticeIdOf = (raw: unknown): string | null => {
  const id = record(raw).notice_id;
  return typeof id === "string" && HEX32.test(id) ? id : null;
};
