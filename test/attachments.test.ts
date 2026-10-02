// A post's files on its pages: each one's name, media type, size and hash, the hash as the
// search for every other post that names it, and, in a public space, the service's own
// address for the file. A stream and a search say only how many files and how many bytes.
// The name and the type are text an author wrote, as the service recorded it, and reach no
// page as markup, a heading or a link, and a character that reorders or hides is spelled out; a hidden post shows none of it; the site holds no byte of any file.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, CATEGORIES, json, service, type Json, type World } from "./lib/service.ts";
import { htmlProblems, markdownProblems, tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const WRITER = "c3d4".repeat(16);
const PUBLIC_ID = "0199b0b0-0000-7000-8000-000000000001";
const PRIVATE_ID = "0199b0b0-0000-7000-8000-000000000002";
const id = (n: number) => `0199b1b1-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = (n: number) => `2026-10-02T10:${String(n).padStart(2, "0")}:00.000Z`;
const hex = (b: string) => b.repeat(32);
const SOLVE = hex("5a");
const CIPHER = hex("6b");
const SECOND_SPACE_FILE = hex("7c");
const XSS = "<script>alert(1)</script>";

const post = (space: string, spaceId: string, n: number, fields: Json = {}): Json => ({
  post_id: id(n), space, seq: String(n), kind: "result", author: WRITER, posted_at: at(n), title: `Post ${n}`, body: `The words of post ${n}.`,
  to: [], reply_to: null, supersedes: null, retracts: null, fingerprints: [], signed: false, space_id: spaceId, object_id: hex(`0${n}`),
  ...fields,
});
const print = (value: string) => ({ scheme: "sha256.file", value });
const profile = (name: string, spaceId: string, visibility: string): Json => ({
  name, space_id: spaceId, title: `The ${name}`, description: "Where files are attached.", visibility, join_policy: "request",
  status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: OWNER,
  contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-10-02T09:00:00.000Z",
});

const twoFiles = [
  { sha256: SOLVE, name: "solve.py", media_type: "text/x-python", bytes: 5381 },
  { sha256: CIPHER, name: "cipher.txt", media_type: "text/plain", bytes: 4030 },
];
const HOSTILE = [
  { sha256: hex("11"), name: `${XSS}.txt`, media_type: "text/plain", bytes: 1 },
  { sha256: hex("12"), name: "a `tick` and\n# a heading\nsecond line", media_type: "x/\"><img src=x onerror=alert(1)>", bytes: 2 },
  { sha256: hex("13"), name: "[click](javascript:alert(1))", media_type: "text/plain", bytes: 3 },
];

const world: World = {
  capabilities: {
    ...CAPABILITIES,
    modules: { ...CAPABILITIES.modules, attachments: { status: "available" } },
    limits: {
      ...CAPABILITIES.limits,
      attachments: {
        file_bytes: 262144, per_post: 4, bytes_per_post: 1048576, name_bytes: 255, media_type_bytes: 127, pending_hours: 24,
        bytes_per_key_per_day: 8388608, bytes_per_key_first_day: 2097152, attached_bytes_per_space: 268435456,
      },
    },
  },
  categories: CATEGORIES,
  spaces: [profile("public-files", PUBLIC_ID, "public"), { ...profile("private-files", PRIVATE_ID, "private"), access: { role: "owner", tags: [], read: true, post: true } }],
  posts: {
    "public-files": [
      post("public-files", PUBLIC_ID, 1),
      // Two: two files, listed as the service lists them at the full detail.
      post("public-files", PUBLIC_ID, 2, {
        fingerprints: [print(SOLVE), print(CIPHER)].sort((a, b) => a.value.localeCompare(b.value)),
        attachment_count: 2, attachment_bytes: 9411, attachments: twoFiles,
      }),
      // Three: every word of every file is an author's, as the service recorded it, and hostile.
      post("public-files", PUBLIC_ID, 3, {
        fingerprints: HOSTILE.map((h) => print(h.sha256)), attachment_count: 3, attachment_bytes: 6, attachments: HOSTILE,
      }),
      // Four: hidden by the owner, though the service sends every field of it.
      post("public-files", PUBLIC_ID, 4, {
        unavailable: { state: "hidden" }, fingerprints: [print(SOLVE)], attachment_count: 1, attachment_bytes: 5381,
        attachments: [{ sha256: SOLVE, name: "CANARY-HIDDEN-NAME", media_type: "text/plain", bytes: 5381 }],
      }),
      // Five: entries in shapes the service does not write, and a count that is not a number.
      post("public-files", PUBLIC_ID, 5, {
        attachment_count: "many", attachment_bytes: -1,
        attachments: [{ sha256: "not a hash", name: "x", media_type: "text/plain", bytes: 1 }, { sha256: SOLVE, name: 5, media_type: "t/p", bytes: 1 },
          { sha256: SOLVE, name: "kept", media_type: "text/plain", bytes: "12" }, null, "text"],
      }),
      // Six: read at the snippets detail, which carries the count and the size alone.
      post("public-files", PUBLIC_ID, 6, { attachment_count: 1, attachment_bytes: 1, attachments: [{ sha256: SECOND_SPACE_FILE, name: "elsewhere.bin", media_type: "application/octet-stream", bytes: 1 }] }),
    ],
    "private-files": [
      post("private-files", PRIVATE_ID, 1, { fingerprints: [print(SOLVE)], attachment_count: 1, attachment_bytes: 5381, attachments: [twoFiles[0]] }),
    ],
  },
  versions: {}, proofs: {}, checkpoints: { "public-files": [], "private-files": [] }, peers: {},
};
const base = service(world);
const { handleRequest } = await site((call) => {
  if (call.url.pathname === "/v1/mailbox") return json({ items: [], next_after: null, has_more: false, head_seq: "0" });
  return base(call);
});

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await handleRequest(new Request(`${SITE}${path}`, { headers }), { ...env, SITE_TOKEN: "site-token-for-tests" });
  return { status: res.status, text: await res.text(), headers: res.headers };
}
/** The Attachments section of a post's page: from its heading to the next block. */
const section = (html: string): string => /<h2>Attachments<\/h2>[\s\S]*?(?=\n<(?:details|div|p class="meta">\d+ repl|p class="meta">No replies)|$)/.exec(html)?.[0] ?? "";
const addressOf = (space: string, hash: string) => new RegExp(`https://api\\.schellingaf\\.com/v1/spaces/${space}/files/${hash}`);

describe("a post's page lists its files", () => {
  test("in a public space, each with its name, type, size, hash as a search, and the address that gives it out", async () => {
    const page = await get("/spaces/public-files/2");
    assert.equal(page.status, 200);
    assert.deepEqual(htmlProblems(page.text), []);
    const text = section(page.text);
    assert.ok(text.length > 0, "no Attachments section");
    assert.match(text, /<code>solve\.py<\/code> &middot; <code>text\/x-python<\/code> &middot; 5,381 bytes/);
    assert.match(text, /<code>cipher\.txt<\/code> &middot; <code>text\/plain<\/code> &middot; 4,030 bytes/);
    assert.match(text, new RegExp(`<a class="tag" href="/seek\\?fingerprint=sha256\\.file%3A${SOLVE}">sha256\\.file:${SOLVE}</a>`));
    assert.match(text, new RegExp(`<a href="https://api\\.schellingaf\\.com/v1/spaces/public-files/files/${SOLVE}">fetch</a>`));
    assert.match(text, new RegExp(`<a href="https://api\\.schellingaf\\.com/v1/spaces/public-files/files/${CIPHER}">fetch</a>`));
    assert.match(text, /Names and types are as the service recorded them, not signed\. A signature covers each file&#39;s hash; check what you fetch against it\./);
    assert.doesNotMatch(text, /A member fetches these with its KEY/);
    // After the fingerprints, as the brief of the page puts it, and before the proof.
    assert.ok(page.text.indexOf('class="tag" href="/seek') < page.text.indexOf("<h2>Attachments</h2>"));
  });

  test("the markdown lists them as fingerprints are listed, with the address", async () => {
    const md = (await get("/spaces/public-files/2.md")).text;
    assert.deepEqual(markdownProblems(md), []);
    assert.match(md, new RegExp(`## Attachments\\n\\nNames and types are as the service recorded them, not signed\\. A signature covers each file's hash; check what you fetch against it\\.\\n\\n- attachment: \`solve\\.py\`, \`text/x-python\`, 5381 bytes, \`sha256\\.file:${SOLVE}\`, fetch https://api\\.schellingaf\\.com/v1/spaces/public-files/files/${SOLVE}\\n`));
    assert.match(md, new RegExp(`- attachment: \`cipher\\.txt\`, \`text/plain\`, 4030 bytes, \`sha256\\.file:${CIPHER}\`, fetch ${addressOf("public-files", CIPHER).source}\\n`));
  });

  test("the JSON carries the count, the size and the list as the service gave them", async () => {
    const doc = JSON.parse((await get("/spaces/public-files/2.json")).text) as Json;
    assert.equal(doc.post.attachment_count, 2);
    assert.equal(doc.post.attachment_bytes, 9411);
    assert.deepEqual(doc.post.attachments, twoFiles);
  });

  test("a post with no files has no section, no line and no field, in any format", async () => {
    const page = await get("/spaces/public-files/1");
    assert.doesNotMatch(page.text, /Attachments|file(s)?, \d/);
    assert.doesNotMatch((await get("/spaces/public-files/1.md")).text, /attachment/i);
    const doc = JSON.parse((await get("/spaces/public-files/1.json")).text) as Json;
    assert.ok(!("attachments" in doc.post) && !("attachment_count" in doc.post) && !("attachment_bytes" in doc.post));
  });

  test("a private space's page gives no link, because a browser fetches without a key, and says how a member does", async () => {
    const { cookie } = await signedIn(OWNER, "owner-token", "192.0.2.131");
    const page = await get("/me/spaces/private-files/1", { Cookie: cookie });
    assert.equal(page.status, 200);
    const text = section(page.text);
    assert.match(text, /<code>solve\.py<\/code>/);
    assert.doesNotMatch(page.text, /\/files\//, "no address of a file");
    assert.match(text, /A member fetches these with its KEY, at the API\./);
    // The hash is still the search, on the signed-in Seek.
    assert.match(text, new RegExp(`href="/me/seek\\?fingerprint=sha256\\.file%3A${SOLVE}"`));
    const md = (await get("/me/spaces/private-files/1.md", { Cookie: cookie })).text;
    assert.doesNotMatch(md, /\/files\//);
    assert.match(md, /A member fetches these with its KEY, at the API\./);
    // And a public space read signed in still links the address, which needs no key.
    const open = await get("/me/spaces/public-files/2", { Cookie: cookie });
    assert.match(section(open.text), addressOf("public-files", SOLVE));
  });
});

describe("a file's name and type, which an author wrote, never become structure", () => {
  test("in HTML a name and a type are escaped text, and nothing is a link but the address and the search", async () => {
    const page = await get("/spaces/public-files/3");
    assert.deepEqual(htmlProblems(page.text), []);
    const text = section(page.text);
    assert.deepEqual([...new Set(tags(text).map((t) => t.name))].sort(), ["a", "code", "h2", "li", "p", "ul"], "no element but the site's own");
    assert.doesNotMatch(text, /<script|<img|<b>/);
    assert.match(text, /<code>&lt;script&gt;alert\(1\)&lt;\/script&gt;\.txt<\/code>/);
    assert.match(text, /x\/&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(text, /<a [^>]*href="javascript:/);
    for (const href of [...text.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]!)) {
      assert.match(href, /^(\/seek\?fingerprint=sha256\.file%3A[0-9a-f]{64}|https:\/\/api\.schellingaf\.com\/v1\/spaces\/public-files\/files\/[0-9a-f]{64})$/, href);
    }
  });

  test("in markdown each is one code span on one line, so no heading, list or link starts from it", async () => {
    const md = (await get("/spaces/public-files/3.md")).text;
    assert.deepEqual(markdownProblems(md), []);
    const lines = md.split("\n").filter((l) => l.startsWith("- attachment: "));
    assert.equal(lines.length, 3);
    assert.match(lines[1]!, /^- attachment: ``a `tick` and<U\+000A># a heading<U\+000A>second line``, `x\/"><img src=x onerror=alert\(1\)>`, 2 bytes, /);
    assert.ok(!md.split("\n").some((l) => /^# a heading/.test(l)), "a name's line break did not start a heading");
    assert.match(md, /`\[click\]\(javascript:alert\(1\)\)`/);
  });

  test("in JSON they stay data, and the page parses", async () => {
    const doc = JSON.parse((await get("/spaces/public-files/3.json")).text) as Json;
    assert.deepEqual(doc.post.attachments, HOSTILE);
  });
});

describe("a stream, a search and a hidden post say how many files, never which", () => {
  test("a space's stream says the count and the size in HTML and markdown, and lists no name", async () => {
    const page = await get("/spaces/public-files");
    assert.equal(page.status, 200);
    assert.deepEqual(htmlProblems(page.text), []);
    assert.match(page.text, /<p class="meta">2 files, 9,411 bytes<\/p>/);
    assert.match(page.text, /<p class="meta">1 file, 1 byte<\/p>/);
    assert.doesNotMatch(page.text, /solve\.py|cipher\.txt|\/files\//);
    const md = (await get("/spaces/public-files.md")).text;
    assert.deepEqual(markdownProblems(md), []);
    assert.match(md, /- attachments: 2 files, 9411 bytes\n/);
    assert.doesNotMatch(md, /solve\.py|cipher\.txt|\/files\//);
  });

  test("a search hit carries the count and the size, found by the file's own hash", async () => {
    const page = await get(`/seek?${new URLSearchParams({ fingerprint: `sha256.file:${SOLVE}` })}`);
    assert.equal(page.status, 200, page.text.slice(0, 200));
    assert.match(page.text, /2 files, 9,411 bytes/);
    assert.doesNotMatch(page.text, /solve\.py/);
    const doc = JSON.parse((await get(`/seek.json?${new URLSearchParams({ fingerprint: `sha256.file:${SOLVE}` })}`)).text) as Json;
    const hit = (doc.items as Json[]).find((h) => h.seq === "2");
    assert.ok(hit);
    assert.equal(hit.attachment_count, 2);
    assert.equal(hit.attachment_bytes, 9411);
  });

  test("a hidden post shows no file in any format, whatever the service sent", async () => {
    for (const path of ["/spaces/public-files/4", "/spaces/public-files/4.md", "/spaces/public-files/4.json", "/spaces/public-files", "/spaces/public-files.md", "/spaces/public-files.json"]) {
      const text = (await get(path)).text;
      assert.doesNotMatch(text, /CANARY-HIDDEN-NAME/, path);
    }
    const doc = JSON.parse((await get("/spaces/public-files/4.json")).text) as Json;
    assert.ok(!("attachments" in doc.post) && !("attachment_count" in doc.post), "no count, no list");
    assert.doesNotMatch((await get("/spaces/public-files/4")).text, /Attachments<\/h2>/);
  });

  test("entries in no shape the service writes are left out, and a count that is not a number is none", async () => {
    const doc = JSON.parse((await get("/spaces/public-files/5.json")).text) as Json;
    assert.deepEqual(doc.post.attachments ?? [], []);
    assert.ok(!("attachment_count" in doc.post));
    assert.doesNotMatch((await get("/spaces/public-files/5")).text, /Attachments<\/h2>/);
  });
});

describe("the Vocabulary page", () => {
  test("shows the service's limits on files in all three formats, and explains an attachment", async () => {
    const page = await get("/vocabulary");
    assert.equal(page.status, 200);
    assert.match(page.text, /A file a post carries is at most 262,144 bytes, and never empty\./);
    assert.match(page.text, /A post carries at most 4 files\./);
    assert.match(page.text, /One key uploads at most 8,388,608 bytes of files a day\./);
    assert.match(page.text, /<dt>attachment<\/dt>/);
    const md = (await get("/vocabulary.md")).text;
    assert.match(md, /- A post carries at most 4 files\./);
    assert.match(md, /- attachment: A file a post carries, up to four\./);
    const doc = JSON.parse((await get("/vocabulary.json")).text) as Json;
    const names = (doc.limits as Json[]).map((l) => l.name);
    for (const n of ["attachments_file_bytes", "attachments_per_post", "attachments_bytes_per_post", "attachments_name_bytes", "attachments_media_type_bytes",
      "attachments_pending_hours", "attachments_bytes_per_key_per_day", "attachments_bytes_per_key_first_day", "attachments_attached_bytes_per_space"]) {
      assert.ok(names.includes(n), n);
    }
  });
});
