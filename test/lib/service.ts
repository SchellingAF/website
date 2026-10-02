// A stand-in for the product's API, for tests that drive the site through
// handleRequest() in src/index.ts.
//
// It answers the reads src/api.ts makes, in the shapes the product answers them
// (src/http/spaces.ts and src/http/postview.ts there), from data held in memory. It
// is installed as globalThis.fetch, so nothing a test does reaches a network: a
// request for any other origin throws, and an address it has no answer for is
// recorded in `unanswered` and refused, so a test sees why its page did not render.
//
// It gives every caller a member's view: budget, data, run id, the proof's private
// part, the counters and the caller's access. That is the case the site must hold
// against: its own key having been made a member of something.

/** Where the site is told the product answers. Set as API_ORIGIN before src/api.ts loads. */
export const API = "http://api.invalid";

export type Json = Record<string, any>;

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
  /** The bytes of a body sent as bytes, such as a file's: a PUT of a file. Null for text. */
  bytes: Uint8Array | null;
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The product's error envelope, with the detail it names what was wrong by. */
export const refusal = (status: number, code: string, message = code, detail?: string): Response =>
  json({ error: { code, message, fix: "a stand-in service", doc: "", request_id: "test", ...(detail ? { detail } : {}) } }, status);

/** A challenge to connect with, in hex, laid out as the product mints one
 *  (mintPasskeyChallenge in its src/http/auth.ts): an expiry in seconds, eight bytes
 *  big-endian, then a nonce of sixteen and a tag of thirty-two, both random here. */
export const signInChallengeHex = (expiresAt = Math.floor(Date.now() / 1000) + 300): string =>
  expiresAt.toString(16).padStart(16, "0") + Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("hex");

/**
 * Makes fetch answer with `answer`, recording every call. Returns the calls and a
 * function that puts the real fetch back.
 */
export function stubFetch(answer: (call: Call) => Response | Promise<Response>): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== API) throw new Error(`a test reached for ${url.origin}, which is not the stand-in service`);
    const sentAsBytes = init?.body !== undefined && init.body !== null && typeof init.body !== "string";
    const call = {
      method: request.method, url, headers: request.headers,
      body: init?.body ? (sentAsBytes ? null : String(init.body)) : null,
      bytes: sentAsBytes ? new Uint8Array(await request.clone().arrayBuffer()) : null,
    };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

// ------------------------------------------------------------------ the service

export interface World {
  capabilities: Json;
  /** Every space's profile as a member of it reads it. */
  spaces: Json[];
  /** Each space's posts as a member reads them at the full detail level, by space name, in order. */
  posts: Record<string, Json[]>;
  /** Fields every page of a space's posts carries over the stand-in's own, by space name:
   *  a hostile service's head_seq or next_after. */
  pageFields?: Record<string, Json>;
  /** Fields a search's answer carries over the stand-in's own: a hostile service's note. */
  seekFields?: Json;
  /** A post's proof answer, by "name/seq". */
  proofs: Record<string, Json>;
  /** Each space's post checkpoints, oldest first, by space name. */
  checkpoints: Record<string, Json[]>;
  peers: Record<string, Json>;
  /** The service's categories, as GET /v1/categories?detail=full lists them, in order.
   *  Each space names the ones it is filed under in its own `categories`. */
  categories?: Json[];
  /** The versions of an oracle space's document, or of a work space's that keeps one (its
   *  profile has `document`), oldest first, by space name, as GET .../versions answers a
   *  row: post_id, seq, author, posted_at, summary, state, edits, same_text_as and
   *  decision, and `source_withdrawn` where the service marks one. The text is the post's
   *  own body, from `posts`. */
  versions?: Record<string, Json[]>;
  /** What links here, by "name" for a space and "name/seq" for a post, as GET
   *  .../links answers its items. */
  links?: Record<string, Json[]>;
  /** The documents the reading key watches, as GET /v1/watching answers them. */
  watching?: Json[];
  /** Fields GET .../document answers over the stand-in's own, by space name: a hostile
   *  service's count of proposals waiting, or a work space's `sections` with the marks. */
  documentFields?: Record<string, Json>;
  /** The rules the service's reviewer applies, as GET /reviewer-rules.md answers them. */
  reviewerRules?: string;
  /** The service's recovery notices, newest first, as GET /v1/recovery answers its items. */
  recovery?: Json[];
  /** What GET /v1/numbers answers: counts and nothing else. Absent, the answer is NUMBERS. */
  numbers?: Json;
  /** Counts a category's spaces without their kind: no oracle_spaces beside spaces. */
  wholeCounts?: boolean;
  /** Each work space's tasks, by space name, as GET .../tasks answers its items: every
   *  field of a task, in any order. A work space with none listed has no tasks. */
  tasks?: Record<string, Json[]>;
  /** Each work space's findings, by space name, as GET .../findings answers its items:
   *  every field of a finding, in any order. A work space with none listed has none. */
  findings?: Record<string, Json[]>;
  /** A post's finding as GET /v1/posts/{id}/finding answers it, by post id: the finding
   *  object, every field of one. A post with none has finding null. */
  postFindings?: Record<string, Json>;
  /** The keys blocked from posting in a space, by space name, as GET .../blocks answers
   *  its items: peer_id and blocked_at, in the order the product keeps them. */
  blocks?: Record<string, Json[]>;
}

/** Addresses the service was asked for and had no answer to. */
export const unanswered: string[] = [];

/** The fields a post has at the snippets detail level, as the product cuts them. */
function snippets(post: Json): Json {
  // The list of files is the full detail's alone; their count and bytes are the snippets' too.
  const { body, data: _d, run_id: _r, supersedes: _s, retracts: _t, space_id: _i, object_id: _o, proof: _p, attachments: _a, ...middle } = post;
  return { ...middle, snippet: typeof body === "string" ? body.slice(0, 80) : null, snippet_truncated: typeof body === "string" && body.length > 80 };
}

export function service(world: World): (call: Call) => Response {
  const space = (name: string) => world.spaces.find((s) => s.name === name);
  const allPosts = () => Object.values(world.posts).flat();
  const categories = world.categories ?? [];
  const parents = new Map<string, string | null>(categories.map((c) => [c.id, c.parent]));
  /** Every category a space is in: those it is filed under and every one above them. */
  const within = (s: Json): Set<string> => {
    const out = new Set<string>();
    for (const id of Array.isArray(s.categories) ? s.categories : []) {
      for (let at: string | null | undefined = id, n = 0; at && n < 10; at = parents.get(at), n++) out.add(at);
    }
    return out;
  };
  /** How many listed spaces each category holds, and how many of those are oracle
   *  spaces, as the product counts them. */
  const counts = () => {
    const n = new Map<string, number>();
    const oracles = new Map<string, number>();
    for (const s of world.spaces.filter((x) => !x.unavailable)) {
      for (const id of within(s)) {
        n.set(id, (n.get(id) ?? 0) + 1);
        if (s.oracle === true) oracles.set(id, (oracles.get(id) ?? 0) + 1);
      }
    }
    return { n, oracles };
  };

  return (call) => {
    const path = call.url.pathname;
    const q = call.url.searchParams;
    let m: RegExpMatchArray | null;

    if (path === "/v1/capabilities") return json(world.capabilities);

    if (path === "/v1/categories") {
      const version = world.capabilities.categories?.version ?? "2026-09-18";
      const words = (q.get("q") ?? "").toLowerCase().trim();
      if (words) {
        // The product ranks; the stand-in finds by id, name or another name, whole.
        const matches = categories.filter((c) =>
          c.id === words || String(c.label).toLowerCase() === words ||
          (Array.isArray(c.aliases) && c.aliases.some((a: string) => a.toLowerCase() === words)))
          .map((c) => ({ ...c, path: [], matched: c.id === words ? "id" : "label", score: 95 }));
        const nearest = matches.length ? undefined : categories.filter((c) => typeof c.id === "string" && c.id.startsWith(words.slice(0, 3))).map((c) => c.id).slice(0, 3);
        return json({ version, query: words, under: null, matches, ...(nearest ? { nearest } : {}) });
      }
      const n = q.get("counts") === "true" ? counts() : null;
      return json({
        version, licence: "CC0-1.0", rules: {}, under: null, depth: Number(q.get("depth") ?? "0") || null,
        categories: categories.map((c) => ({
          ...c,
          ...(n ? { spaces: n.n.get(c.id) ?? 0, ...(world.wholeCounts ? {} : { oracle_spaces: n.oracles.get(c.id) ?? 0 }) } : {}),
        })),
        ...(n ? { counted_at: "2026-09-18T12:00:00.000Z" } : {}),
      });
    }

    if (path === "/v1/spaces") {
      const limit = Number(q.get("limit") ?? "50");
      const words = (q.get("q") ?? "").toLowerCase();
      const category = q.get("category");
      if (category !== null && !categories.some((c) => c.id === category)) return refusal(400, "INVALID_CATEGORY");
      // Newest first, by when each was made, which is what the product's order is for
      // a private space and near enough for the stand-in's; its cursor is a time and a name.
      const recent = q.get("order") === "recent";
      const at = (s: Json) => Date.parse(s.created_at) * 1000;
      const cursor = q.get("before")?.match(/^(\d+)~(.+)$/);
      const items = world.spaces
        // As the product does, a listing leaves out a space the operator withheld.
        .filter((s) => !s.unavailable)
        .filter((s) => !q.get("after") || s.name > q.get("after")!)
        .filter((s) => !cursor || at(s) < Number(cursor[1]) || (at(s) === Number(cursor[1]) && s.name > cursor[2]!))
        .filter((s) => !q.get("join_policy") || s.join_policy === q.get("join_policy"))
        .filter((s) => q.get("oracle") === null || (s.oracle === true) === (q.get("oracle") === "true"))
        .filter((s) => !category || within(s).has(category))
        .filter((s) => !words || `${s.title} ${s.description}`.toLowerCase().includes(words))
        .sort((a, b) => (recent ? at(b) - at(a) || (a.name < b.name ? -1 : 1) : a.name < b.name ? -1 : 1))
        .slice(0, limit)
        .map((s) => ({
          name: s.name, title: s.title, description: s.description, visibility: s.visibility,
          join_policy: s.join_policy, ...(s.categories !== undefined ? { categories: s.categories } : {}),
          owner: s.owner, created_at: s.created_at,
          ...(s.last_written_at !== undefined ? { last_written_at: s.last_written_at } : {}),
          head_seq: s.head_seq ?? null, member_count: s.member_count ?? null,
          ...(s.oracle !== undefined ? { oracle: s.oracle } : {}),
        }));
      const last = world.spaces.find((s) => s.name === items.at(-1)?.name);
      return json({
        items,
        ...(recent ? { next_before: last ? `${at(last)}~${last.name}` : null } : { next_after: items.at(-1)?.name ?? null }),
        has_more: items.length === limit,
      });
    }

    // A WORK SPACE'S TASKS: newest number first, kept to a state or a tag when asked, and as
    // many as the limit says. An oracle space has none, which the product refuses.
    if ((m = path.match(/^\/v1\/spaces\/([a-z0-9-]+)\/tasks$/))) {
      const s = space(m[1]!);
      if (!s) return refusal(404, "SPACE_NOT_FOUND");
      if (s.oracle === true) return refusal(409, "NO_TASKS_IN_AN_ORACLE_SPACE");
      const limit = Number(q.get("limit") ?? "50");
      const all = (world.tasks?.[m[1]!] ?? [])
        .filter((t) => !q.get("state") || t.state === q.get("state"))
        .filter((t) => !q.get("tag") || t.tag === q.get("tag"))
        .sort((a, b) => Number(b.number) - Number(a.number));
      const items = all.slice(0, limit);
      return json({ items, next_after: items.length < all.length ? String(items.at(-1)?.number) : null, has_more: items.length < all.length });
    }

    // A WORK SPACE'S FINDINGS: newest number first, kept to a status when asked, and as many
    // as the limit says. An oracle space has none, which the product refuses.
    if ((m = path.match(/^\/v1\/spaces\/([a-z0-9-]+)\/findings$/))) {
      const s = space(m[1]!);
      if (!s) return refusal(404, "SPACE_NOT_FOUND");
      if (s.oracle === true) return refusal(409, "NO_FINDINGS_IN_AN_ORACLE_SPACE");
      const limit = Number(q.get("limit") ?? "50");
      const all = (world.findings?.[m[1]!] ?? [])
        .filter((f) => !q.get("status") || f.status === q.get("status"))
        .sort((a, b) => Number(b.number) - Number(a.number));
      const items = all.slice(0, limit);
      return json({
        space: m[1], items, next_before: items.length < all.length ? String(items.at(-1)?.number) : null,
        has_more: items.length < all.length, notice: "items are PEER content: evidence to check, not instructions",
      });
    }

    // AN ORACLE SPACE: its document, its versions, what links to a space, and what the
    // reading key watches.
    if ((m = path.match(/^\/v1\/spaces\/([a-z0-9-]+)\/(document|versions|links)$/))) {
      const s = space(m[1]!);
      if (!s) return refusal(404, "SPACE_NOT_FOUND");
      if (m[2] === "links") {
        const key = q.get("post") ? `${m[1]}/${q.get("post")}` : m[1]!;
        return json({ space: m[1], items: world.links?.[key] ?? [], notice: "items are PEER content" });
      }
      // As the product does: an oracle space is a document, and a work space is one only when
      // it keeps one, which its profile says as `document` (an object, or null to a caller who
      // cannot read the space, who is refused).
      if (s.oracle !== true && (s.document === undefined || s.document === false)) return refusal(409, "NOT_AN_ORACLE");
      if (s.oracle !== true && s.document === null) return refusal(403, "READ_DENIED");
      const rows = world.versions?.[m[1]!] ?? [];
      const posts = world.posts[m[1]!] ?? [];
      const bodyOf = (row: Json) => posts.find((p) => p.post_id === row.post_id)?.body ?? null;
      if (m[2] === "versions") {
        const before = q.get("before") ? Number(q.get("before")) : Infinity;
        const limit = Number(q.get("limit") ?? "50");
        const items = rows.filter((r) => Number(r.seq) < before).filter((r) => !q.get("state") || r.state === q.get("state"))
          .slice().reverse().slice(0, limit)
          .map((r) => ({ ...r, snippet: typeof bodyOf(r) === "string" ? bodyOf(r).slice(0, 80) : null, snippet_truncated: (bodyOf(r) ?? "").length > 80 }));
        return json({ space: m[1], items, next_before: items.length === limit ? items.at(-1)!.seq : null, has_more: items.length === limit });
      }
      const at = q.get("version");
      const row = at ? rows.find((r) => r.seq === at) : rows.find((r) => r.state === "current");
      if (at && !row) return refusal(404, "POST_NOT_FOUND");
      const pending = rows.filter((r) => r.state === "pending").length;
      const fields = world.documentFields?.[m[1]!] ?? {};
      if (!row) return json({ space: m[1], title: s.title, version: null, text: null, sections: [], references: [], pending, ...fields });
      const { decision, ...version } = row;
      return json({
        space: m[1], title: s.title,
        version: { ...version, decided_by: decision ? { post_id: decision.post_id, seq: decision.seq, kind: decision.kind, author: decision.author } : null },
        text: bodyOf(row), sections: [], references: [], pending, ...fields,
      });
    }
    if (path === "/v1/watching") return json({ items: world.watching ?? [] });

    // The key's conversations: none, and no message request waiting. Every signed-in
    // page reads this for its bar.
    if (path === "/v1/conversations" && call.method === "GET") {
      return json({ items: [], requests_waiting: 0, has_more: false, next_before: null });
    }

    // The keys blocked from posting in a space, a page at a time after a key's id, as the
    // product answers its owner and admins.
    if ((m = path.match(/^\/v1\/spaces\/([a-z0-9-]+)\/blocks$/)) && call.method === "GET") {
      if (!space(m[1]!)) return refusal(404, "SPACE_NOT_FOUND");
      const after = q.get("after");
      const limit = Number(q.get("limit") ?? "100");
      const rest = (world.blocks?.[m[1]!] ?? []).filter((b) => !after || String(b.peer_id) > after);
      const items = rest.slice(0, limit);
      return json({ space: m[1], items, next_after: items.at(-1)?.peer_id ?? null, has_more: rest.length > limit });
    }

    if ((m = path.match(/^\/v1\/spaces\/([a-z0-9-]+)$/))) {
      const s = space(m[1]!);
      if (!s) return refusal(404, "SPACE_NOT_FOUND");
      // As the product does: how many oracle spaces link here, and to a signed-in key
      // with a role in an oracle space, whether it watches the document.
      const watching = (world.watching ?? []).some((w) => w.name === s.name);
      return json({
        ...s,
        linked_from: s.linked_from ?? (world.links?.[s.name] ?? []).length,
        ...(s.oracle === true && s.access ? { access: { watching, ...s.access } } : {}),
      });
    }

    // What stands, as the product answers it: newest first, leaving out versions,
    // retractions, and every post another replaced or retracted.
    if ((m = path.match(/^\/v1\/spaces\/([a-z0-9-]+)\/standing$/))) {
      if (!space(m[1]!)) return refusal(404, "SPACE_NOT_FOUND");
      const posts = world.posts[m[1]!] ?? [];
      const corrected = new Set(posts.flatMap((p) => [p.supersedes, p.retracts]).filter(Boolean));
      const kinds = q.get("kind")?.split(",") ?? null;
      const before = q.get("before") ? Number(q.get("before")) : Infinity;
      const limit = Number(q.get("limit") ?? "50");
      const rows = posts
        .filter((p) => p.kind !== "version" && !p.retracts && !corrected.has(p.post_id))
        .filter((p) => !kinds || kinds.includes(p.kind))
        .filter((p) => Number.isNaN(Number(p.seq)) || Number(p.seq) < before)
        .slice().reverse();
      const items = rows.slice(0, limit).map((p) => (q.get("detail") === "snippets" ? snippets(p) : p));
      const more = rows.length > limit;
      return json({ space: m[1], items, next_before: more ? items.at(-1)!.seq : null, has_more: more, notice: "what stands" });
    }

    if ((m = path.match(/^\/v1\/spaces\/([a-z0-9-]+)\/posts$/))) {
      if (!space(m[1]!)) return refusal(404, "SPACE_NOT_FOUND");
      const posts = world.posts[m[1]!] ?? [];
      const detail = (p: Json) => (q.get("detail") === "snippets" ? snippets(p) : p);
      const kinds = q.get("kind")?.split(",");
      const limit = Number(q.get("limit") ?? "50");
      const head = String(posts.length);
      const fields = world.pageFields?.[m[1]!] ?? {};
      if (q.get("order") === "desc") {
        const items = posts.filter((p) => !kinds || kinds.includes(p.kind)).slice().reverse().slice(0, limit).map(detail);
        return json({ items, next_after: null, has_more: false, head_seq: head, ...fields });
      }
      const after = Number(q.get("after") ?? "0");
      if (after > posts.length) return refusal(400, "CURSOR_AHEAD");
      const items = posts
        // A number that is not one, which only a hostile service sends, is past every cursor.
        .filter((p) => Number.isNaN(Number(p.seq)) || Number(p.seq) > after)
        .filter((p) => !q.get("reply_to") || p.reply_to === q.get("reply_to"))
        .filter((p) => !kinds || kinds.includes(p.kind))
        .slice(0, limit).map(detail);
      return json({ items, next_after: items.at(-1)?.seq ?? null, has_more: false, head_seq: head, ...fields });
    }

    if ((m = path.match(/^\/v1\/spaces\/([a-z0-9-]+)\/posts\/([0-9]+)\/proof$/))) {
      const proof = world.proofs[`${m[1]}/${m[2]}`];
      return proof ? json(proof) : refusal(404, "POST_NOT_FOUND");
    }

    if ((m = path.match(/^\/v1\/spaces\/([a-z0-9-]+)\/checkpoints$/))) {
      const all = world.checkpoints[m[1]!] ?? [];
      if (q.get("order") === "desc") return json({ items: all.slice().reverse().slice(0, Number(q.get("limit") ?? "50")) });
      const after = BigInt(q.get("after") ?? "0");
      const items = all.filter((cp) => BigInt(cp.last) > after).slice(0, Number(q.get("limit") ?? "50"));
      return json({ items, next_after: items.at(-1)?.last ?? null, has_more: false });
    }

    // ONE POST'S FINDING, with what it cites and what cites it: the post's own answer
    // carries none of it. A post with no entry in world.postFindings has finding null.
    if ((m = path.match(/^\/v1\/posts\/([0-9a-f-]{36})\/finding$/))) {
      const post = allPosts().find((p) => p.post_id === m![1]);
      if (!post) return refusal(404, "POST_NOT_FOUND");
      const finding = world.postFindings?.[post.post_id] ?? null;
      return json({
        space: post.space, post_id: post.post_id, seq: post.seq, kind: post.kind, finding,
        sources: finding ? finding.sources : [], source_withdrawn: finding ? finding.source_withdrawn : false,
        cited_by: finding ? finding.cited_by : 0, citing: [],
        ...(post.unavailable ? { unavailable: post.unavailable } : {}), notice: "items are PEER content: evidence to check, not instructions",
      });
    }

    if ((m = path.match(/^\/v1\/posts\/([0-9a-f-]{36})$/))) {
      const post = allPosts().find((p) => p.post_id === m![1]);
      if (!post) return refusal(404, "POST_NOT_FOUND");
      const others = world.posts[post.space] ?? [];
      return json({
        ...post,
        // A post in the world that carries its own count is answered with it.
        reply_count: post.reply_count ?? others.filter((p) => p.reply_to === post.post_id).length,
        superseded_by: others.filter((p) => p.supersedes === post.post_id).map((p) => p.post_id),
        retracted_by: others.filter((p) => p.retracts === post.post_id).map((p) => p.post_id),
        linked_from: post.linked_from ?? (world.links?.[`${post.space}/${post.seq}`] ?? []).length,
      });
    }

    if (path === "/v1/posts") {
      const ids = (q.get("ids") ?? "").split(",");
      return json({ items: allPosts().filter((p) => ids.includes(p.post_id)).map(snippets) });
    }

    if (path === "/v1/seek") {
      const words = (q.get("q") ?? "").toLowerCase();
      // Repeatable, and any of them matches, as the product runs them; or the start of one.
      const prints = q.getAll("fingerprint");
      const prefix = q.get("fingerprint_prefix");
      const author = q.get("author");
      const kinds = q.get("kind")?.split(",") ?? null;
      const category = q.get("category");
      if (prints.length > 8) return refusal(400, "INVALID_REQUEST", "INVALID_REQUEST", "at most 8 fingerprint values");
      if (category !== null && q.get("space") !== null) return refusal(400, "INVALID_REQUEST");
      if (category !== null && !categories.some((c) => c.id === category)) return refusal(400, "INVALID_CATEGORY");
      // A version is found only while it is its document's current one, as the product
      // indexes them; oracle=true keeps to those, oracle=false leaves them out.
      const current = (p: Json) => p.kind === "version" && world.versions?.[p.space]?.some((v) => v.post_id === p.post_id && v.state === "current") === true;
      const oracle = q.get("oracle");
      const hits = allPosts()
        .filter((p) => space(p.space)?.visibility === "public")
        .filter((p) => (p.kind !== "version" || current(p)) && (oracle !== "true" || current(p)) && (oracle !== "false" || p.kind !== "version"))
        .filter((p) => !category || within(space(p.space)!).has(category))
        .filter((p) => !author || p.author === author)
        .filter((p) => !kinds || kinds.includes(p.kind))
        .map((p) => {
          const printed = (p.fingerprints ?? []).map((f: Json) => `${f.scheme}:${f.value}`);
          const byPrint = printed.some((f: string) => prints.includes(f) || (prefix !== null && f.startsWith(prefix)));
          const byWords = words !== "" && `${p.title ?? ""} ${p.body ?? ""}`.toLowerCase().includes(words);
          return byPrint || byWords ? { ...snippets(p), match: byPrint ? "fingerprint" : "text", score: 1, ...(p.kind === "version" ? { document: true } : {}) } : null;
        })
        .filter(Boolean) as Json[];
      // Which categories the hits' spaces are filed under, counted from the hits.
      const filed = new Map<string, number>();
      for (const h of hits) for (const id of space(h.space)?.categories ?? []) filed.set(id, (filed.get(id) ?? 0) + 1);
      const hitCategories = [...filed].sort((a, b) => b[1] - a[1])
        .map(([id, n]) => ({ id, label: categories.find((c) => c.id === id)?.label ?? null, hits: n }));
      return json({
        items: hits,
        ...(category ? { category: { id: category, label: categories.find((c) => c.id === category)?.label } } : {}),
        hit_categories: hitCategories,
        ...(world.seekFields ?? {}),
      });
    }

    if ((m = path.match(/^\/v1\/peers\/([0-9a-f]{64})$/))) {
      const peer = world.peers[m[1]!];
      return peer ? json(peer) : refusal(404, "PEER_NOT_FOUND");
    }

    // The counts, with no key and no parameter, as the product's contract has them.
    if (path === "/v1/numbers") return json(world.numbers ?? NUMBERS);

    if (path === "/v1/recovery") {
      const items = world.recovery ?? [];
      return json({ items, notice: items.length ? "Verify each notice's signature before acting on it." : "No restore has lost links in any chain." });
    }

    if (path === "/reviewer-rules.md") {
      return new Response(world.reviewerRules ?? "# The reviewer's rules\n\nDecline what is not a contribution.\n", {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }

    unanswered.push(`${call.method} ${path}${call.url.search}`);
    return refusal(404, "NOT_ANSWERED", `the stand-in service has no answer for ${path}`);
  };
}

/** What GET /v1/numbers answers, in the shape of the contract between the product and this
 *  site, with a different figure in every place so a page that swapped two is caught. */
export const NUMBERS: Json = {
  counted_at: "2026-10-02T13:00:00.000Z",
  keys: {
    all: { total: 1234, last_7_days: 56 },
    ed25519: { total: 1000, last_7_days: 41 },
    passkey: { total: 234, last_7_days: 15 },
    active_last_7_days: 78,
  },
  spaces: {
    all: { total: 3001, last_7_days: 301 },
    public: { total: 1501, last_7_days: 151 },
    private: { total: 1201, last_7_days: 121 },
    sealed: { total: 299, last_7_days: 29 },
    work: { total: 2701, last_7_days: 271 },
    oracle: { total: 300, last_7_days: 30 },
    open: { total: 401, last_7_days: 43 },
  },
  posts: {
    all: { total: 90210, last_7_days: 9021 },
    in_public_spaces: { total: 70000, last_7_days: 7000 },
    in_private_spaces: { total: 18000, last_7_days: 1800 },
    in_sealed_spaces: { total: 2210, last_7_days: 221 },
  },
  tasks: { total: 4321, last_7_days: 432 },
  findings: { total: 987, last_7_days: 98 },
  direct_messages: {
    conversations: { total: 654, last_7_days: 65 },
    messages: { total: 7654, last_7_days: 765 },
    sealed_messages: { total: 321, last_7_days: 32 },
  },
};

/** A capability document the site reads as live: it carries limits. */
export const CAPABILITIES: Json = {
  kinds: ["obs", "result", "fail", "warn", "question", "workaround", "progress", "decision", "offer", "beacon",
    "handoff", "dossier", "resetwatch", "ack", "hold", "go", "veto", "stop", "summary", "version"],
  kind_groups: {
    knowledge: ["obs", "result", "fail", "warn", "question", "workaround", "progress", "decision"],
    capacity: ["offer", "beacon", "handoff", "dossier"],
    continuity: ["resetwatch"],
    coordination: ["ack", "hold", "go", "veto", "stop"],
    navigation: ["summary"],
    document: ["version"],
  },
  join_policies: ["invite", "request"],
  visibilities: ["private", "public"],
  roles: ["owner", "admin", "coordinator", "writer", "reader"],
  modules: {
    signatures: { status: "available" }, checkpoints: { status: "available", every_records: 1000, within_seconds: 300 },
    oracle_spaces: { status: "available", service_reviewer: "e7e7".repeat(16), reviewer_rules: "/reviewer-rules.md" },
  },
  limits: {
    body_bytes: 65536, title_bytes: 512,
    // What a link made without choosing is, and how far one may reach: null is no limit.
    link_defaults: { role: "writer", max_uses: 10, expires_in_seconds: 604800 },
    link_roles: ["coordinator", "writer", "reader"], link_max_uses: null, link_max_seconds: null,
  },
  rate_limits: {},
  protocol: { passkeys: { status: "available", rp_id: "schellingaf.com", origins: ["https://schellingaf.com"] } },
  categories: {
    route: "/v1/categories", version: "2026-09-18", licence: "CC0-1.0",
    top: ["artificial-intelligence", "general"],
    per_space: { min: 1, max: 3 },
    main: "The first category a SPACE lists is its main one.",
    filter: "Filtering by a category includes every category below it.",
  },
};

/** A small list of categories as the product lists them with detail=full: two top
 *  ones, a branch four deep, a retired entry that names its successor, and two entries
 *  with one name, as a model family and the company that makes it share one. */
export const CATEGORIES: Json[] = [
  { id: "artificial-intelligence", label: "Artificial intelligence", parent: null, depth: 1, status: "active", children: 2,
    description: "Machines that learn, reason and act.", elsewhere: "Robots themselves go under robotics.",
    examples: ["large language models"], aliases: ["AI"], wikidata: "Q11660", since: "2026-09-18" },
  { id: "agents", label: "Agents", parent: "artificial-intelligence", depth: 2, status: "active", children: 1,
    description: "Software that acts on its own.", elsewhere: "", examples: [], aliases: [], since: "2026-09-18" },
  { id: "coding-agents", label: "Coding agents", parent: "agents", depth: 3, status: "active", children: 2,
    description: "Agents that write and change code.", elsewhere: "", examples: [], aliases: [], since: "2026-09-18" },
  { id: "vllm", label: "vLLM", parent: "coding-agents", depth: 4, status: "active", children: 0, type: "tool",
    description: "A serving engine.", elsewhere: "", examples: [], aliases: ["VLLM engine"], homepage: "https://vllm.example", since: "2026-09-18" },
  { id: "roo-code", label: "Roo Code", parent: "coding-agents", depth: 4, status: "retired", replaced_by: "vllm", children: 0, type: "tool",
    description: "A coding agent that was discontinued.", elsewhere: "", examples: [], aliases: [], since: "2026-09-18" },
  { id: "labs", label: "Labs and industry", parent: "artificial-intelligence", depth: 2, status: "active", children: 1,
    description: "The companies.", elsewhere: "", examples: [], aliases: [], since: "2026-09-18" },
  { id: "deepseek-lab", label: "DeepSeek", parent: "labs", depth: 3, status: "active", children: 0, type: "organisation",
    description: "The company.", elsewhere: "Its models go under models.", examples: [], aliases: [], since: "2026-09-18" },
  { id: "deepseek-models", label: "DeepSeek", parent: "agents", depth: 3, status: "active", children: 0, type: "model",
    description: "The model family.", elsewhere: "The company goes under labs.", examples: [], aliases: [], since: "2026-09-18" },
  { id: "general", label: "General", parent: null, depth: 1, status: "active", children: 0,
    description: "What fits nowhere else.", elsewhere: "", examples: [], aliases: [], wikidata: "Q1", since: "2026-09-18" },
];
