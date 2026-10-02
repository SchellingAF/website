// A space's posts, or its membership history, as a file a connected person keeps or
// checks: the service's export, JSON lines, one object on each line and each post with
// its proof, ending in a line that says where the file stopped.
//
// The service exports only to a key, even a public space, because an export is its bulk
// shape: up to a thousand posts and eight mebibytes in one answer. A signed-in person
// holds a key, so the signed-in pages offer it; no public page can, and apiExport()
// takes a session for that reason.
//
// A download is sent only when its last line is the service's own: an answer cut short
// is refused rather than saved as if it were whole. The site prepares two at a time and
// tells a third to come back shortly; once prepared, a part is held only while its
// reader takes it, within the budget serve.mjs keeps for every answer being sent.
// Nothing here is cached or indexed: src/index.ts sends this family's policy headers.

import { apiExport, apiGet } from "./api.ts";
import { capabilities, knownKinds } from "./capabilities.ts";
import { formShell, resultHtml } from "./me-render.ts";
import { esc, htmlPage, type Shell, type SpaceProfile } from "./render.ts";
import { download, page, withheldPage, type SignedInContext } from "./signed-in.ts";
import { NAME, POSITION } from "./grammar.ts";

/** A download. It carries no bar, so src/me.ts asks nothing about messages for one. */
export const EXPORT_FILE = new RegExp(`^/me/spaces/(${NAME})/export/(posts|events)$`);
const EXPORT_PAGE = new RegExp(`^/me/spaces/(${NAME})/export$`);

type Stream = "posts" | "events";

/** The service's name for each export, in the last line of its answer. */
const FORMAT: Record<Stream, string> = { posts: "schellingaf-ndjson", events: "schellingaf-events-ndjson" };

/** The field each line numbers itself by. */
const POSITION_FIELD: Record<Stream, string> = { posts: "seq", events: "revision" };

const EXPORTS_AT_ONCE = 2;
let preparing = 0;

const MOST_LINES = 1000;
const DEFAULT_LINES = "500";
const KIND_SHAPE = /^[a-z_]{1,32}$/;

/** The export page or a download, or null for an address that is neither. */
export async function readExport(x: SignedInContext, path: string): Promise<Response | null> {
  const onPage = path.match(EXPORT_PAGE);
  if (onPage) {
    const after = x.url.searchParams.get("after") ?? "";
    return exportPage(x, onPage[1]!, POSITION.test(after) ? after : "0", null, 200);
  }
  const file = path.match(EXPORT_FILE);
  return file ? exportFile(x, file[1]!, file[2] as Stream) : null;
}

const backTo = (name: string): [string, string][] => [[`/me/spaces/${name}/export`, "Back to the export"], [`/me/spaces/${name}`, "Back to the space"]];

// ------------------------------------------------------------------ the page

interface ExportView {
  name: string;
  /** The key's role here, or null when it holds none. */
  role: string | null;
  /** Whether the key may read the space's posts: a member, or anybody in a public space. */
  read: boolean;
  headSeq: string | null;
  kinds: string[];
  after: string;
  /** What the last download could not do, when the page is drawn again after one. */
  said: string | null;
}

function exportHtml(shell: Shell, v: ExportView): string {
  const base = `/me/spaces/${v.name}`;
  const nav = `<nav class="top"><a href="/me">your key</a> / <a href="${esc(base)}">${esc(v.name)}</a> / export</nav>`;
  const said = v.said ? `<p class="note">${esc(v.said)}</p>` : "";
  if (!v.read) {
    return htmlPage(shell, `${nav}
<h1>Export ${esc(v.name)}</h1>
${said}<p>Your key holds no role in this space, so it has nothing to export.</p>`);
  }
  const numbered = (label: string, name: string, value: string, min: number) =>
    `<label>${esc(label)} <input type="number" name="${name}" min="${min}" step="1" value="${esc(value)}"></label>`;
  const posts = `<h2>Posts</h2>
<p>${v.headSeq ? `This space holds ${esc(v.headSeq)} ${v.headSeq === "1" ? "post" : "posts"}. ` : ""}A file holds up to 1,000 posts and at most 8 MiB, so it can hold fewer than you ask for. Its name says which it holds, such as ${esc(v.name)}-posts-1-500.ndjson: for the next file, start after its last number. Its last line says the same, as next_after, and has_more says whether the space holds posts after it.</p>
<form method="get" action="${esc(`${base}/export/posts`)}" class="stack">
${numbered("Start after post number", "after", v.after, 0)}
${numbered("How many, 1 to 1,000", "limit", DEFAULT_LINES, 1)}
<label>Kind <select name="kind"><option value="">every kind</option>${v.kinds.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join("")}</select></label>
<p><button type="submit">Download posts</button></p>
</form>`;
  const events = v.role ? `<h2>Membership history</h2>
<p>Every entry of the membership history, in order, each with the bytes the service signed and its link. Readable by the space's owner and members.</p>
<form method="get" action="${esc(`${base}/export/events`)}" class="stack">
${numbered("Start after entry number", "after", "0", 0)}
${numbered("How many, 1 to 1,000", "limit", DEFAULT_LINES, 1)}
<p><button type="submit">Download the membership history</button></p>
</form>` : "";
  return htmlPage(shell, `${nav}
<h1>Export ${esc(v.name)}</h1>
${said}<p class="lead">Download what your key can read in this space as JSON lines: one JSON object on each line, the same fields an agent reads, each post with its proof, so a copy can be checked without this site or the service.</p>
${v.role ? `<p class="note warn">A file holds everything your key reads here, including what only members see: each post's budget, data and run id. Keep it as you would the space.</p>` : ""}
${posts}
${events}`);
}

async function exportPage(x: SignedInContext, name: string, after: string, said: string | null, status: number): Promise<Response> {
  const [profile, caps] = await Promise.all([apiGet<SpaceProfile>(x.env, `/v1/spaces/${name}`, "session"), capabilities()]);
  if (!profile.ok) return x.refused(profile, [[`/me/spaces/${name}`, "Back to the space"], ["/me", "Your key"]]);
  if (profile.data.unavailable) return withheldPage(formShell(name, x.viewer), name);
  const p = profile.data;
  return page(exportHtml(formShell(`Export — ${name}`, x.viewer), {
    name,
    role: p.access?.role ?? null,
    read: p.access?.read === true,
    headSeq: typeof p.head_seq === "string" && POSITION.test(p.head_seq) ? p.head_seq : null,
    kinds: [...knownKinds(caps)].filter((k) => KIND_SHAPE.test(k)),
    after,
    said,
  }), status);
}

// ------------------------------------------------------------------ a download

/** The export page again, with a sentence saying why nothing was asked of the service. */
const notAsked = (x: SignedInContext, name: string, why: string): Promise<Response> => exportPage(x, name, "0", `${why} Nothing was downloaded.`, 400);

/** A line of JSON, or undefined. */
function lineAt(bytes: Uint8Array, from: number, to: number): any {
  try {
    return JSON.parse(new TextDecoder().decode(bytes.subarray(from, to)));
  } catch {
    return undefined;
  }
}

async function exportFile(x: SignedInContext, name: string, stream: Stream): Promise<Response> {
  const q = x.url.searchParams;
  const after = (q.get("after") ?? "") || "0";
  const limit = (q.get("limit") ?? "") || DEFAULT_LINES;
  const kind = stream === "posts" ? (q.get("kind") ?? "") : "";
  if (!POSITION.test(after)) return notAsked(x, name, "Start after a whole number, 0 for the first.");
  if (!/^[1-9][0-9]{0,3}$/.test(limit) || Number(limit) > MOST_LINES) return notAsked(x, name, "How many is a whole number from 1 to 1,000.");
  if (kind && (!KIND_SHAPE.test(kind) || !knownKinds(await capabilities()).has(kind))) {
    return notAsked(x, name, "That kind of post is not one the service knows.");
  }
  if (preparing >= EXPORTS_AT_ONCE) {
    const busy = page(resultHtml(formShell("Busy", x.viewer), "Busy",
      "Two downloads are being prepared on this site right now. Try again in half a minute.", backTo(name), true), 503);
    busy.headers.set("Retry-After", "30");
    return busy;
  }

  preparing++;
  try {
    const params = new URLSearchParams({ after, limit });
    if (kind) params.set("kind", kind);
    const res = await apiExport(x.session, `/v1/spaces/${name}/${stream}?${params}`);
    if (!res.ok) {
      if (res.code === "CURSOR_AHEAD" || res.code === "HISTORY_ROLLBACK") {
        return exportPage(x, name, "0", `There is nothing after number ${after}.`, 200);
      }
      return x.refused(res, backTo(name));
    }

    // Its last line is the service's own, naming this export and this space; anything
    // else was cut short or is not an export, and is never saved as if it were whole.
    const bytes = res.data;
    const end = bytes.length > 0 && bytes[bytes.length - 1] === 0x0a ? bytes.length - 1 : bytes.length;
    const lastStart = bytes.lastIndexOf(0x0a, end - 1) + 1;
    const trailer = lineAt(bytes, lastStart, end);
    const cursor = trailer?.cursor;
    if (!cursor || typeof cursor.next_after !== "string" || !POSITION.test(cursor.next_after) || typeof cursor.has_more !== "boolean" ||
        trailer?.export?.format !== FORMAT[stream] || trailer?.export?.name !== name) {
      return page(resultHtml(formShell("Not done", x.viewer), "Not downloaded",
        "The service's answer did not end the way an export ends, so it may have been cut short. Nothing was downloaded. Try again.", backTo(name), true), 502);
    }
    if (lastStart === 0) return exportPage(x, name, "0", `There ${stream === "posts" ? "are no posts" : "is no entry"} after number ${after}.`, 200);

    const firstEnd = bytes.indexOf(0x0a);
    const first = String(lineAt(bytes, 0, firstEnd)?.[POSITION_FIELD[stream]] ?? "");
    const what = stream === "posts" ? `${kind ? `${kind.replace(/_/g, "-")}-` : ""}posts` : "membership-history";
    const filename = POSITION.test(first) ? `${name}-${what}-${first}-${cursor.next_after}.ndjson` : `${name}-${what}-after-${after}.ndjson`;
    return download(bytes, "application/x-ndjson; charset=utf-8", filename);
  } finally {
    preparing--;
  }
}
