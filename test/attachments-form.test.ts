// A person posts files from the signed-in post form, as an agent does through the API: up
// to four file fields on a multipart form, no script needed; the site hashes each file,
// uploads it with the person's own token, and then posts naming it. The limits are the
// service's own, read from its capability document. A sealed space, a key that may not
// upload and a service that takes no files see no file field. What is wrong with a file is
// said before anything is uploaded. src/sign-post.js puts each file's hash in the object a
// passkey signs, and the site checks the signed object covers every file before it sends.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { CAPABILITIES, json, refusal, service, type Call, type Json, type World } from "./lib/service.ts";
import { htmlProblems, tags } from "./lib/documents.ts";
import * as postObject from "../src/post-object.js";
import { canonicalBytes } from "../src/jcs.js";
import { visibleName } from "../src/grammar.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "a1b2".repeat(16);
const WRITER = "c3d4".repeat(16);
const ids = { files: "0199c0c0-0000-7000-8000-000000000001", sealed: "0199c0c0-0000-7000-8000-000000000002", open: "0199c0c0-0000-7000-8000-000000000003" };
const LIMITS = { file_bytes: 262144, per_post: 4, bytes_per_post: 1048576, name_bytes: 255, media_type_bytes: 127, pending_hours: 24, bytes_per_key_per_day: 8388608, bytes_per_key_first_day: 2097152, attached_bytes_per_space: 268435456 };

const profile = (name: string, spaceId: string, visibility: string, join: string, access: Json): Json => ({
  name, space_id: spaceId, title: `The ${name}`, description: "Where files go.", visibility, join_policy: join, status: "active", signed_only: false,
  replaced_by: null, oracle: false, categories: ["general"], owner: OWNER, contacts: [{ peer_id: OWNER, role: "owner" }],
  created_at: "2026-10-02T09:00:00.000Z", access: { tags: [], read: true, post: true, ...access },
});
const capabilities: Json = {
  ...CAPABILITIES,
  modules: { ...CAPABILITIES.modules, attachments: { status: "available" } },
  limits: { ...CAPABILITIES.limits, attachments: LIMITS },
};
const world: World = {
  capabilities,
  spaces: [
    profile("files-room", ids.files, "public", "request", { role: "writer" }),
    profile("sealed-room", ids.sealed, "sealed", "request", { role: "writer" }),
    profile("open-room", ids.open, "public", "open", { role: null }),
  ],
  posts: { "files-room": [], "sealed-room": [], "open-room": [] },
  versions: {}, proofs: {}, checkpoints: { "files-room": [], "sealed-room": [], "open-room": [] }, peers: {},
} as World;

/** What the stand-in service answers a file's upload and a post with, which a test changes. */
const answers: { put: (call: Call) => Response; post: (call: Call) => Response } = {
  put: (call) => json({ space: "files-room", sha256: call.url.pathname.split("/").pop(), bytes: call.bytes?.length ?? 0, pending_until: "2026-10-03T10:00:00.000Z" }, 201),
  post: () => json({ post_id: "0199c0c0-0000-7000-8000-0000000000aa", seq: "1" }, 201),
};
const base = service(world);
const { fake, handleRequest } = await site((call: Call) => {
  if (call.method === "PUT" && /^\/v1\/spaces\/[a-z0-9-]+\/files\/[0-9a-f]{64}$/.test(call.url.pathname)) return answers.put(call);
  if (call.method === "POST" && /^\/v1\/spaces\/[a-z0-9-]+\/posts$/.test(call.url.pathname)) return answers.post(call);
  return base(call);
});
// After site(): src/signed-in.ts loads src/api.ts, which reads where the service answers once.
const { attachmentName, attachmentType, prepareFiles } = await import("../src/signed-in.ts");
const { cookie, csrf } = await signedIn(WRITER, "writer-token", "192.0.2.141");
const puts = () => fake.calls.filter((c) => c.method === "PUT");
const posts = () => fake.calls.filter((c) => c.method === "POST" && c.url.pathname === "/v1/spaces/files-room/posts");
const sha = async (bytes: Uint8Array) => Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
const file = (name: string, content: string | Uint8Array, type = "text/plain") => new File([content as BlobPart], name, { type });
const reset = () => { fake.calls.length = 0; answers.put = (call) => json({ space: "files-room", sha256: call.url.pathname.split("/").pop(), bytes: call.bytes?.length ?? 0, pending_until: "x" }, 201); };

/** The form as a browser sends it with files: multipart, every field and every file part. */
async function sendFiles(fields: Record<string, string>, files: [string, File][], where = "/me/spaces/files-room/posts") {
  const data = new FormData();
  for (const [k, v] of Object.entries({ csrf, kind: "result", title: "Solver re-run", body: "Run: python3 solve.py", ...fields })) data.set(k, v);
  for (const [field, f] of files) data.append(field, f);
  const res = await handleRequest(new Request(`${SITE}${where}`, { method: "POST", headers: { Origin: SITE, Cookie: cookie }, body: data }), env);
  const text = await res.text();
  if (process.env.SHOW) console.log(res.status, /<p class="note warn">([^<]*)/.exec(text)?.[1] ?? "");
  return { res, text };
}

describe("the post form offers file fields, and only where a post may carry files", () => {
  const page = async (name: string, c = cookie) => (await handleRequest(new Request(`${SITE}/me/spaces/${name}`, { headers: { Cookie: c } }), env)).text();
  const fileInputs = (html: string) => tags(html).filter((t) => t.name === "input" && t.attributes.some(([k, v]) => k === "type" && v === "file")).map((t) => t.attributes.find(([k]) => k === "name")![1]);

  test("a writer's form has one field for each file a post may carry, a multipart form, and the limits the script holds the files to", async () => {
    const html = await page("files-room");
    assert.deepEqual(htmlProblems(html).filter((p) => !/script/.test(p)), [], "the passkey's script is the one the site writes");
    assert.deepEqual(fileInputs(html), ["file1", "file2", "file3", "file4"]);
    const form = tags(html).find((t) => t.name === "form" && t.attributes.some(([k, v]) => k === "data-sign"))!;
    const has = (k: string, v: string) => form.attributes.some(([a, b]) => a === k && b === v);
    assert.ok(has("enctype", "multipart/form-data"));
    assert.ok(has("data-max-files", "4") && has("data-max-file-bytes", "262144"));
    assert.match(html, /Up to 4 files, each at most 262,144 bytes, are uploaded to this space with the post\. Whoever may read the space may fetch them\. A signature covers each file&#39;s hash, not its name\./);
  });

  test("a sealed space's form and a key with no role see no file field", async () => {
    assert.deepEqual(fileInputs(await page("sealed-room")), [], "sealed: the service would hold the bytes as sent");
    assert.deepEqual(fileInputs(await page("open-room")), [], "a key with no role cannot upload");
  });
});

describe("a post with files, sent unsigned", () => {
  test("each file is uploaded with the person's own token to its hash, then the post names them in the order chosen", async () => {
    reset();
    const solve = new TextEncoder().encode("print('solved')\n");
    const cipher = new Uint8Array([0, 1, 2, 3, 255, 254]);
    const { res } = await sendFiles({}, [["file1", file("solve.py", solve, "text/x-python")], ["file2", file("cipher.bin", cipher, "application/octet-stream")]]);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/me/spaces/files-room/1?notice=posted");
    const [first, second] = [await sha(solve), await sha(cipher)];
    assert.deepEqual(puts().map((c) => c.url.pathname), [`/v1/spaces/files-room/files/${first}`, `/v1/spaces/files-room/files/${second}`]);
    assert.deepEqual([...puts()[0]!.bytes!], [...solve]);
    assert.deepEqual([...puts()[1]!.bytes!], [...cipher], "the bytes go as they are, not as text");
    for (const c of puts()) assert.equal(c.headers.get("authorization"), "Bearer writer-token");
    for (const c of puts()) assert.equal(c.headers.get("content-length"), String(c.bytes!.length), "with the length the body has");
    assert.equal(fake.calls.findIndex((c) => c.method === "PUT"), fake.calls.findIndex((c) => c.method === "POST" && c.url.pathname.endsWith("/posts")) - 2, "uploads first, then the post");
    const sent = JSON.parse(posts().at(-1)!.body!);
    assert.deepEqual(sent.attachments, [
      { sha256: first, name: "solve.py", media_type: "text/x-python" },
      { sha256: second, name: "cipher.bin", media_type: "application/octet-stream" },
    ]);
    assert.ok(!("fingerprints" in sent), "the service adds each file's hash to the fingerprints");
    assert.equal(sent.title, "Solver re-run");
  });

  test("the name is the file's own, exactly as it was sent, and the type is the part's when it is one", async () => {
    reset();
    await sendFiles({}, [
      ["file1", file("notes.txt", "A=1", "text/plain; charset=utf-8")],
      ["file2", file("résumé 日本.txt", "n", "TEXT/Plain")],
      ["file3", file("no type.bin", "r", "not a type")],
      ["file4", file("a.md", "c", "")],
    ]);
    const sent = JSON.parse(posts().at(-1)!.body!);
    assert.deepEqual(sent.attachments.map((a: Json) => [a.name, a.media_type]), [
      ["notes.txt", "text/plain"], ["résumé 日本.txt", "text/plain"], ["no type.bin", "application/octet-stream"], ["a.md", "application/octet-stream"],
    ]);
  });

  test("a name the service refuses goes to it unchanged, and the service's own refusal is what the person reads", async () => {
    // A direction override, a zero-width space, a leading dot: the service refuses each, and
    // the site neither strips them silently nor guesses which names it takes.
    for (const name of ["invoice\u202Efdp.exe", "a\u200Bb.txt", ".env"]) {
      reset();
      answers.post = () => refusal(400, "INVALID_REQUEST", undefined, "attachments[0].name: no control or format character, no slash or backslash, and no leading dot");
      const { res, text } = await sendFiles({}, [["file1", file(name, "x")]]);
      assert.equal(JSON.parse(posts().at(-1)!.body!).attachments[0].name, name, "unchanged on its way to the service");
      assert.equal(res.status, 400);
      assert.match(text, /The service could not use what was sent\. The service says: attachments\[0\]\.name: no control or format character, no slash or backslash, and no leading dot\./);
      assert.deepEqual(htmlProblems(text), []);
      assert.ok(!/[\u202E\u200B]/.test(text), "no direction override or zero-width character on the page");
    }
    answers.post = () => json({ post_id: "0199c0c0-0000-7000-8000-0000000000aa", seq: "1" }, 201);
  });

  test("a form with no file chosen is the plain post it was", async () => {
    reset();
    const { res } = await sendFiles({}, [["file1", new File([], "")], ["file2", new File([], "")]]);
    assert.equal(res.status, 303);
    assert.equal(puts().length, 0);
    assert.ok(!("attachments" in JSON.parse(posts().at(-1)!.body!)));
  });

  test("fingerprints typed beside the files count with each file's hash toward the service's limit, and are sent as typed", async () => {
    reset();
    const typed = Array.from({ length: 31 }, (_, i) => `x.n:${i}`).join("\n");
    const { res, text } = await sendFiles({ fingerprints: typed }, [["file1", file("a.txt", "a")], ["file2", file("b.txt", "b")]]);
    assert.equal(res.status, 400);
    assert.match(text, /A post carries at most 32 fingerprints, each file&#39;s hash among them, and this one has 33\. Nothing was posted\./);
    assert.equal(puts().length + posts().length, 0);
    reset();
    const fits = await sendFiles({ fingerprints: typed }, [["file1", file("a.txt", "a")]]);
    assert.equal(fits.res.status, 303);
    assert.equal(JSON.parse(posts().at(-1)!.body!).fingerprints.length, 31);
  });
});

describe("what is wrong with a file is said before anything is sent", () => {
  const refused = async (files: [string, File][], words: RegExp, fields: Record<string, string> = {}) => {
    reset();
    const { res, text } = await sendFiles({ body: "My words, kept.", ...fields }, files);
    assert.equal(res.status, 400);
    assert.match(text, words);
    assert.deepEqual(htmlProblems(text), []);
    assert.equal(puts().length + posts().length, 0, "nothing reached the service");
    assert.match(text, /My words, kept\./, "the post is shown again as it was typed");
    assert.match(text, /The files you chose are not kept: choose them again\./);
    assert.deepEqual(tags(text).filter((t) => t.name === "input" && t.attributes.some(([k, v]) => k === "type" && v === "file")).length, 4, "with its file fields");
  };

  test("a file over the limit, an empty one, more than a post carries, one name twice and one file twice", async () => {
    await refused([["file1", file("big.bin", new Uint8Array(262145))]], /The file big\.bin is 262,145 bytes, and a file is at most 262,144\. Nothing was posted\./);
    await refused([["file1", file("a.txt", "a")], ["file2", file("a.txt", "b")]], /Two of the files are named a\.txt\./);
    await refused([["file1", file("a.txt", "same")], ["file2", file("b.txt", "same")]], /The same file was chosen twice \(b\.txt\)\./);
    await refused(
      [1, 2, 3, 4, 5].map((n) => [`file${n}`, file(`f${n}.txt`, String(n))] as [string, File]),
      /A post carries at most 4 files, and this one has 5\. Nothing was posted\./,
    );
  });

  test("an empty file is refused by name", async () => {
    reset();
    const { res, text } = await sendFiles({}, [["file1", new File([], "empty.txt")]]);
    assert.equal(res.status, 400);
    assert.match(text, /The file empty\.txt is empty, and the service takes no empty file\. Nothing was posted\./);
    assert.equal(puts().length + posts().length, 0);
  });

  test("a sealed post takes no file, and a multipart form to any other address is a form that expired", async () => {
    reset();
    const sealed = await sendFiles({ sealed_header: "a", sealed_ciphertext: "b" }, [["file1", file("a.txt", "a")]], "/me/spaces/sealed-room/posts");
    assert.equal(sealed.res.status, 400);
    assert.match(sealed.text, /A sealed space takes no files, so nothing was posted\./);
    const elsewhere = await sendFiles({ name: "x-space" }, [["file1", file("a.txt", "a")]], "/me/new");
    assert.equal(elsewhere.res.status, 403);
    assert.match(elsewhere.text, /That form has expired/);
    assert.equal(puts().length, 0);
  });
});

describe("what the service refuses, said in a person's words", () => {
  test("a refused upload shows the post again as typed, with the service's word for why, and posts nothing", async () => {
    reset();
    answers.put = () => refusal(409, "SEALED_NO_FILES");
    const { res, text } = await sendFiles({ body: "Kept words." }, [["file1", file("a.txt", "a")]]);
    assert.equal(res.status, 400);
    assert.match(text, /A sealed space takes no files, because the service would hold their bytes as sent\./);
    assert.match(text, /Kept words\./);
    assert.equal(posts().length, 0);
  });

  test("the daily bytes are said with the service's own numbers", async () => {
    reset();
    answers.put = () => refusal(429, "RATE_LIMITED");
    const { text } = await sendFiles({}, [["file1", file("a.txt", "a")]]);
    assert.match(text, /A key uploads at most 8,388,608 bytes of files a day, and 2,097,152 on its first day\./);
  });

  test("a post refused for files says so; any other post's refusal is worded as before", async () => {
    reset();
    answers.post = () => refusal(409, "FILE_LIMIT");
    const { res, text } = await sendFiles({}, [["file1", file("a.txt", "a")]]);
    assert.equal(res.status, 409);
    assert.match(text, /This space holds as many bytes of attached files as it may\. Nothing was posted\./);
    reset();
    answers.post = () => refusal(429, "RATE_LIMITED");
    const plain = await sendFiles({}, []);
    assert.match(plain.text, /Too many posts in a short time/);
    answers.post = () => json({ post_id: "0199c0c0-0000-7000-8000-0000000000aa", seq: "1" }, 201);
  });
});

describe("a post with files, signed with a passkey", () => {
  const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
  const signedFields = (canonical: unknown): Record<string, string> => ({
    sig_alg: "webauthn", sig_canonical: b64u(canonicalBytes(canonical)), sig_credential_id: "AAAA", sig_client_data_json: "AAAA", sig_authenticator_data: "AAAA", sig_signature: "AAAA",
  });

  test("the files go up, and the post carries them beside the signed bytes, which name each one's hash", async () => {
    reset();
    const bytes = new TextEncoder().encode("signed file");
    const hash = await sha(bytes);
    const object = { v: 1, kind: "result", fingerprints: [{ scheme: "sha256.file", value: hash }] };
    const { res } = await sendFiles(signedFields(object), [["file1", file("run.txt", bytes)]]);
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location")!, /notice=posted-signed/);
    assert.equal(puts().length, 1);
    const sent = JSON.parse(posts().at(-1)!.body!);
    assert.equal(sent.alg, "webauthn");
    assert.equal(sent.canonical, signedFields(object).sig_canonical);
    assert.deepEqual(sent.attachments, [{ sha256: hash, name: "run.txt", media_type: "text/plain" }]);
    assert.ok(!("title" in sent) && !("body" in sent) && !("fingerprints" in sent), "a signed post carries nothing beside its signed bytes but its files");
  });

  test("a file the signed object does not name is refused before it is uploaded", async () => {
    reset();
    const object = { v: 1, kind: "result", fingerprints: [{ scheme: "git.commit", value: "abc" }, { scheme: "sha256.file", value: "f".repeat(64) }] };
    const { res, text } = await sendFiles(signedFields(object), [["file1", file("run.txt", "other")]]);
    assert.equal(res.status, 400);
    assert.match(text, /A file you chose is not one your passkey signed for, so nothing was posted\./);
    assert.equal(puts().length + posts().length, 0);
  });
});

describe("the helpers", () => {
  test("a name is the file's own, exactly as sent, and only a part with no name at all is called file", () => {
    for (const name of ["solve.py", ".env", "..\\..\\x.txt", "a/b.txt", "a\u202Eb.txt", "a\u200Bb.txt", "a\nb.txt", "é".repeat(200)]) {
      assert.equal(attachmentName(name), name);
    }
    assert.equal(attachmentName(""), "file");
  });

  test("a name is spelled out where a page says it: every character that hides or reorders is its code point", () => {
    assert.equal(visibleName("invoice\u202Efdp.exe"), "invoice<U+202E>fdp.exe");
    assert.equal(visibleName("a\u200Bb\uFEFFc"), "a<U+200B>b<U+FEFF>c");
    assert.equal(visibleName("a\nb\u0000c\u2028d\u2029e\u007Ff"), "a<U+000A>b<U+0000>c<U+2028>d<U+2029>e<U+007F>f");
    assert.equal(visibleName("a\uD800b"), "a<U+D800>b", "a lone surrogate");
    assert.equal(visibleName("résumé 日本 \u{1F600}.txt"), "résumé 日本 \u{1F600}.txt", "an ordinary name is as it is");
  });

  test("a type is the part's, lowercase and with no parameter, when the service takes it", () => {
    assert.equal(attachmentType("text/plain"), "text/plain");
    assert.equal(attachmentType("Text/X-Python; charset=UTF-8"), "text/x-python");
    for (const bad of ["", "text", "text/", "/plain", "text/pl ain", "text/plain/x", "a".repeat(120) + "/" + "b".repeat(20)]) {
      assert.equal(attachmentType(bad), "application/octet-stream", bad);
    }
  });

  test("files are hashed with SHA-256 as they are", async () => {
    const made = await prepareFiles([new File(["abc"], "abc.txt", { type: "text/plain" })], { perPost: 4, fileBytes: 10 });
    assert.ok(made.ok);
    assert.equal(made.files[0]!.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

// ------------------------------------------------------------------ src/sign-post.js

const SCRIPT = (() => {
  let text = readFileSync(path.join(ROOT, "src", "sign-post.js"), "utf8");
  for (const line of ['import { canonicalBytes } from "/jcs.js";', 'import { challengeOf, hex, objectIdOf, parseTyped, privateBytes, privateDigestOf, privateProblem, sha256, titleProblem } from "/post-object.js";']) {
    assert.equal(text.split(`${line}\n`).length, 2, `sign-post.js does not import as ${line}`);
    text = text.replace(`${line}\n`, "");
  }
  return text;
})();

/** A post form with two file fields, a passkey that signs anything, and what happened. */
function page(values: Record<string, string>, dataset: Record<string, string> = {}) {
  const fields: Record<string, { value: string }> = {};
  for (const name of ["idempotency_key", "kind", "title", "body", "to", "fingerprints", "reply_to", "supersedes", "retracts", "data", "budget", "run_id",
    "sig_alg", "sig_canonical", "sig_private", "sig_credential_id", "sig_client_data_json", "sig_authenticator_data", "sig_signature"]) fields[name] = { value: values[name] ?? "" };
  const listeners: Record<string, ((event: { preventDefault(): void }) => void)[]> = {};
  const state = { submitted: 0, prompts: 0, said: "" };
  const inputs = [0, 1].map(() => {
    const handlers: (() => void)[] = [];
    return { files: [] as unknown[], addEventListener: (_: string, fn: () => void) => handlers.push(fn), choose(f: unknown) { this.files = f ? [f] : []; handlers.forEach((h) => h()); } };
  });
  const form = {
    dataset: { spaceId: "0199c0c0-0000-7000-8000-000000000001", author: WRITER, credential: "AAAA", rpId: "schellingaf.com", maxFileBytes: "100", ...dataset },
    elements: { namedItem: (name: string) => fields[name] ?? null },
    querySelectorAll: (q: string) => (q === "input[type=file]" ? inputs : []),
    querySelector: (q: string) => (q === "[data-sign-status]" ? { set textContent(t: string) { state.said = t; } } : q === "input[name=sign]" ? { checked: true } : null),
    addEventListener: (type: string, fn: (event: { preventDefault(): void }) => void) => (listeners[type] ??= []).push(fn),
    submit: () => { state.submitted++; },
  };
  const credential = { rawId: new Uint8Array(16).buffer, response: { clientDataJSON: new Uint8Array(8).buffer, authenticatorData: new Uint8Array(37).buffer, signature: new Uint8Array(70).buffer } };
  vm.runInNewContext(SCRIPT, {
    document: { querySelectorAll: () => [form] },
    window: { PublicKeyCredential: function PublicKeyCredential() {} },
    navigator: { credentials: { get: () => { state.prompts++; return Promise.resolve(credential); } } },
    crypto: globalThis.crypto, btoa, atob, TextEncoder, Uint8Array, DataView, Math, JSON, Map, Set, Promise, Array, Object, String, Number, Infinity,
    canonicalBytes: (v: unknown) => canonicalBytes(JSON.parse(JSON.stringify(v))), ...postObject,
  });
  const press = async () => {
    let prevented = false;
    for (const fn of listeners.submit ?? []) fn({ preventDefault: () => { prevented = true; } });
    await new Promise((r) => setTimeout(r, 0));
    return prevented;
  };
  const chosen = (name: string, content: Uint8Array | string) => {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    return { name, size: bytes.length, arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) };
  };
  return { fields, state, press, inputs, chosen };
}

describe("src/sign-post.js puts each file's hash in the object the passkey signs", () => {
  test("a file chosen is hashed at once, and its hash is a sha256.file fingerprint among the typed ones, sorted", async () => {
    const p = page({ idempotency_key: "k1", kind: "result", body: "Run it.", fingerprints: "git.commit:abc" });
    const [a, b] = ["first file", "second file"];
    p.inputs[0]!.choose(p.chosen("a.txt", a));
    p.inputs[1]!.choose(p.chosen("b.txt", b));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await p.press(), true);
    assert.equal(p.state.prompts, 1, p.state.said);
    assert.equal(p.state.submitted, 1);
    const object = JSON.parse(Buffer.from(p.fields.sig_canonical!.value, "base64url").toString("utf8"));
    const want = [{ scheme: "git.commit", value: "abc" }, ...(await Promise.all([a, b].map(async (t) => ({ scheme: "sha256.file", value: await sha(new TextEncoder().encode(t)) }))))]
      .sort((x, y) => (x.scheme < y.scheme ? -1 : x.scheme > y.scheme ? 1 : x.value < y.value ? -1 : 1));
    assert.deepEqual(object.fingerprints, want);
  });

  test("a press before a file was read is held, says so, and is never sent unsigned in the post's place", async () => {
    // A file whose bytes never arrive is a file that is never hashed.
    const unread = page({ idempotency_key: "k3", kind: "result", body: "Run it." });
    unread.inputs[0]!.choose({ name: "never.txt", size: 5, arrayBuffer: () => new Promise(() => {}) });
    assert.equal(await unread.press(), true);
    assert.equal(unread.state.prompts, 0);
    assert.equal(unread.state.submitted, 0);
    assert.match(unread.state.said, /Your files are still being read\. Nothing was sent: press Post again in a moment\./);
  });

  test("a file that is empty, or larger than the page says, opens no prompt and sends nothing", async () => {
    for (const [name, content, words] of [
      ["empty.txt", "", /The file empty\.txt is empty, and the service takes no empty file\./],
      ["big.bin", "x".repeat(101), /The file big\.bin is 101 bytes, and a file is at most 100\./],
      // A name that reorders what is around it is spelled out, so the sentence reads as written.
      ["invoice\u202Efdp.exe", "", /The file invoice<U\+202E>fdp\.exe is empty, and the service takes no empty file\./],
    ] as const) {
      const p = page({ idempotency_key: "k4", kind: "result", body: "Run it." });
      p.inputs[0]!.choose(p.chosen(name, content));
      assert.equal(await p.press(), true, name);
      assert.equal(p.state.prompts + p.state.submitted, 0, name);
      assert.match(p.state.said, words);
      assert.match(p.state.said, /Nothing was sent\. Choose another file, or none, and press Post again\.$/);
    }
  });

  test("a file chosen and then cleared is not in the object", async () => {
    const p = page({ idempotency_key: "k5", kind: "result", body: "Run it." });
    p.inputs[0]!.choose(p.chosen("a.txt", "gone"));
    p.inputs[0]!.choose(null);
    await new Promise((r) => setTimeout(r, 5));
    await p.press();
    assert.ok(!("fingerprints" in JSON.parse(Buffer.from(p.fields.sig_canonical!.value, "base64url").toString("utf8"))));
  });
});
