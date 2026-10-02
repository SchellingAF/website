// A work space's task list on its page, read-only: one row for each task with its number,
// its state and who holds it, its tag, its title and a link to its result post; the
// sentence for a space with none; nothing on an oracle space; and the same facts in the
// markdown and JSON twins.
//
// Driven through handleRequest() against a stand-in for the product that answers a space's
// tasks as the product's `GET /v1/spaces/{name}/tasks` does: newest number first, every
// field of a task, a count of confirmations with the number the space requires.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, CATEGORIES, json, refusal, service, unanswered, type Json, type World } from "./lib/service.ts";
import { htmlProblems, markdownProblems, tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const WRITER = "c3d4".repeat(16);
const CHECKER = "e5f6".repeat(16);
const SPACE_ID = "0199a0a0-0000-7000-8000-000000000001";
const id = (n: number) => `0199a1a1-0000-7000-8000-${String(n).padStart(12, "0")}`;
const taskId = (n: number) => `0199a2a2-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = (n: number) => `2026-10-01T10:0${n}:00.000Z`;
const hex = (b: string) => b.repeat(32);

const space = (name: string, fields: Json = {}): Json => ({
  name, space_id: SPACE_ID, title: `The ${name}`, description: "Work to be done.", visibility: "public", join_policy: "request",
  status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: OWNER,
  contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-10-01T09:00:00.000Z",
  ...fields,
});
const post = (n: number, name = "task-board"): Json => ({
  post_id: id(n), space: name, seq: String(n), kind: "result", author: WRITER, posted_at: at(n), title: `Result ${n}`, body: `The words of result ${n}.`,
  to: [], reply_to: null, supersedes: null, retracts: null, fingerprints: [], signed: false, space_id: SPACE_ID, object_id: hex(`0${n}`),
});
/** A task as the product answers one: every field, so a field the page loses shows. */
const task = (number: number, fields: Json = {}): Json => ({
  number, task_id: taskId(number), title: `Task ${number}`, body: `What task ${number} asks for.`, tag: null, after: [], state: "open",
  created_by: OWNER, created_at: at(1), claimed_by: null, claimed_until: null, done_post_id: null, done_at: null, accepted_at: null,
  cycle: 1, confirmations: { required: 2, given: [] },
  ...fields,
});

/** The one of each state a person can meet. */
const BOARD: Json[] = [
  task(1, { title: "Transcribe page 3", tag: "transcription" }),
  task(2, { title: "Check the key table", tag: "verify", state: "claimed", claimed_by: WRITER, claimed_until: at(5) }),
  task(3, { title: "Copy the second letter", state: "open", claim_expired: true }),
  task(4, { title: "Decode the first line", tag: "solve", state: "done", claimed_by: WRITER, done_post_id: id(2), done_at: at(2), confirmations: { required: 2, given: [CHECKER] } }),
  task(5, { title: "Name the cipher", state: "accepted", claimed_by: WRITER, done_post_id: id(3), done_at: at(3), accepted_at: at(4), confirmations: { required: 2, given: [OWNER, CHECKER] } }),
  task(6, {
    title: "Read the margin", state: "open", cycle: 2,
    rejected: { by: CHECKER, reason: "The reading ignored the second line.", at: at(5) },
  }),
  task(7, { title: "Name the oldest hand", state: "accepted", claimed_by: WRITER, done_post_id: id(40), done_at: at(3), accepted_at: at(4), confirmations: { required: 0, given: [] } }),
];

const MANY: Json[] = Array.from({ length: 60 }, (_, i) => task(i + 1, { title: `Page ${i + 1}` }));

const world: World = {
  capabilities: { ...CAPABILITIES, modules: { ...CAPABILITIES.modules, tasks: { status: "available" } } },
  categories: CATEGORIES,
  spaces: [
    space("task-board"),
    space("empty-board"),
    space("quiet-board", { visibility: "private" }),
    space("wide-board"),
    space("broken-board"),
    space("shaped-board"),
    space("odd-board"),
    space("task-oracle", { oracle: true, service_reviewer: false, forked_from: null }),
  ],
  posts: {
    "task-board": [post(1), post(2), post(3)],
    "empty-board": [], "quiet-board": [], "wide-board": [], "broken-board": [], "shaped-board": [], "odd-board": [], "task-oracle": [],
  },
  tasks: {
    "task-board": BOARD, "quiet-board": [task(1, { title: "A private task" })], "wide-board": MANY,
    "odd-board": [
      task(1, { x_secret: "SENTINEL-TASK-FIELD", claimed_by: "not a key", done_at: "yesterday", confirmations: { required: 2, given: [OWNER, "not a key"] } }),
    ],
  },
  versions: { "task-oracle": [] },
  proofs: {}, checkpoints: { "task-board": [] }, peers: {},
};
const base = service(world);
const { fake, handleRequest } = await site((call) => {
  if (call.url.pathname === "/v1/mailbox") return json({ items: [], next_after: null, has_more: false, head_seq: "0" });
  if (call.url.pathname === "/v1/spaces/broken-board/tasks") return refusal(500, "INTERNAL", "the service is unwell");
  if (call.url.pathname === "/v1/spaces/shaped-board/tasks") return json({ notice: "no list here" });
  if (call.url.pathname === "/v1/spaces/task-oracle/document") return json({ space: "task-oracle", title: "A document", version: null, text: null, sections: [], references: [], pending: 0 });
  return base(call);
});

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await handleRequest(new Request(`${SITE}${path}`, { headers }), { ...env, SITE_TOKEN: "site-token-for-tests" });
  return { status: res.status, text: await res.text(), headers: res.headers };
}
const taskCalls = (name: string) => fake.calls.filter((c) => c.url.pathname === `/v1/spaces/${name}/tasks`);
/** The page between its Tasks heading and the next one. */
const section = (html: string): string => /<h2 id="tasks">[\s\S]*?(?=<h2)/.exec(html)?.[0] ?? "";
/** One task's row, from the tasks section: its state and number above its title, its sentences below. */
const rowOf = (text: string, n: number): string => text.split('<div class="item">').find((r) => r.includes(`<h3 id="task-${n}">`)) ?? "";

describe("a work space's page lists its tasks", () => {
  test("above its stream, one row for each task, with its number, state, tag and title", async () => {
    const page = await get("/spaces/task-board");
    assert.equal(page.status, 200);
    assert.deepEqual(htmlProblems(page.text), []);
    const text = section(page.text);
    assert.ok(text.length > 0, "no Tasks section");
    assert.ok(page.text.indexOf('<h2 id="tasks">') < page.text.indexOf("<h2>Latest posts</h2>"), "the tasks come before the stream");
    assert.equal((text.match(/<div class="item">/g) ?? []).length, BOARD.length);
    for (const t of BOARD) {
      assert.ok(text.includes(`<h3 id="task-${t.number}">${t.title}</h3>`), `task ${t.number} is listed by its title`);
      assert.ok(text.includes(`<a href="#task-${t.number}">Task ${t.number}</a>`), `task ${t.number} has its number`);
    }
    assert.match(text, /tagged <code>transcription<\/code>/);
    // Newest number first, as the service lists them.
    assert.ok(text.indexOf("task-7") < text.indexOf("task-1\""));
  });

  test("an open task is open, and one whose claim ran out says so", async () => {
    const text = section((await get("/spaces/task-board")).text);
    const row = (n: number) => rowOf(text, n);
    assert.match(row(1), /<span class="tag">open<\/span>/);
    assert.match(row(1), /<p class="meta">Open\.<\/p>/);
    assert.match(row(3), /Open\. Its last claim ran out\./);
  });

  test("a claimed task says who holds it and until when", async () => {
    const text = section((await get("/spaces/task-board")).text);
    const row = rowOf(text, 2);
    assert.match(row, /<span class="tag">claimed<\/span>/);
    assert.match(row, new RegExp(`Claimed by <a href="/peers/${WRITER}"><code title="${WRITER}">`));
    assert.match(row, /until 1 Oct 2026, 10:05 UTC\./);
  });

  test("a done task says how many have confirmed it, of how many, and links its result post on the page", async () => {
    const text = section((await get("/spaces/task-board")).text);
    const row = rowOf(text, 4);
    assert.match(row, /<span class="tag">done<\/span>/);
    assert.match(row, /Done by <a href="\/peers\/[0-9a-f]{64}">/);
    assert.match(row, /Confirmations: 1 of 2\./);
    assert.match(row, /Result post: <a href="\/spaces\/task-board\/2">#2<\/a>\./);
  });

  test("an accepted task says so, and a result post off the page is the id's own link", async () => {
    const text = section((await get("/spaces/task-board")).text);
    const accepted = rowOf(text, 5);
    assert.match(accepted, /<span class="tag">accepted<\/span>/);
    assert.match(accepted, /Accepted, 1 Oct 2026, 10:04 UTC\. Confirmations: 2 of 2\./);
    assert.match(accepted, /Result post: <a href="\/spaces\/task-board\/3">#3<\/a>\./);
    const far = rowOf(text, 7);
    assert.match(far, new RegExp(`<a href="/posts/${id(40)}">Result post</a>\\.`));
    assert.doesNotMatch(far, /Confirmations/);
  });

  test("a reopened task shows the last reason", async () => {
    const text = section((await get("/spaces/task-board")).text);
    const row = rowOf(text, 6);
    assert.match(row, /Open\. Reopened after a rejection by <a href="\/peers\/[0-9a-f]{64}">/);
    assert.match(row, /Reason: The reading ignored the second line\./);
  });

  test("a space with no tasks says so in one sentence", async () => {
    const page = await get("/spaces/empty-board");
    assert.equal(page.status, 200);
    assert.match(section(page.text), /<p>This space has no tasks\.<\/p>/);
    assert.equal((section(page.text).match(/<div class="item">/g) ?? []).length, 0);
    assert.match((await get("/spaces/empty-board.md")).text, /\n## Tasks\n[\s\S]*\nThis space has no tasks\.\n/);
    assert.deepEqual((JSON.parse((await get("/spaces/empty-board.json")).text) as Json).tasks, { items: [], has_more: false });
  });

  test("an oracle space has no section in any format, and the service is not asked", async () => {
    const page = await get("/spaces/task-oracle");
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /id="tasks"|has no tasks/);
    assert.doesNotMatch((await get("/spaces/task-oracle.md")).text, /## Tasks/);
    assert.ok(!("tasks" in (JSON.parse((await get("/spaces/task-oracle.json")).text) as Json)));
    assert.deepEqual(taskCalls("task-oracle"), []);
  });

  test("a space whose stream is not readable has no section, and its tasks are not asked for", async () => {
    const page = await get("/spaces/quiet-board");
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /id="tasks"|A private task/);
    assert.deepEqual(taskCalls("quiet-board"), []);
  });

  test("a list that could not be read is said so, never as a list with nothing in it", async () => {
    for (const name of ["broken-board", "shaped-board"]) {
      const page = await get(`/spaces/${name}`);
      assert.equal(page.status, 200, name);
      assert.match(section(page.text), /This site could not read the space(?:'|&#39;)s tasks just now\./, name);
      assert.doesNotMatch(section(page.text), /has no tasks/, name);
      assert.match((await get(`/spaces/${name}.md`)).text, /This site could not read the space's tasks just now\./);
      assert.deepEqual((JSON.parse((await get(`/spaces/${name}.json`)).text) as Json).tasks, null);
      assert.equal((JSON.parse((await get(`/spaces/${name}.json`)).text) as Json).tasks_unreadable, true);
    }
  });

  test("more than the page shows is said, and the newest are the ones shown", async () => {
    const page = await get("/spaces/wide-board");
    const text = section(page.text);
    assert.match(text, /Showing the newest 50 tasks\. The service holds more\./);
    assert.equal((text.match(/<div class="item">/g) ?? []).length, 50);
    assert.ok(text.includes('<h3 id="task-60">Page 60</h3>') && !text.includes("Page 10<"));
    assert.equal(taskCalls("wide-board")[0]!.url.searchParams.get("limit"), "50");
  });

  test("it carries no form of its own, and the whole page offers nothing that writes", async () => {
    const page = await get("/spaces/task-board");
    assert.doesNotMatch(section(page.text), /<form|<button|<input/);
    for (const t of tags(page.text).filter((x) => x.name === "form")) {
      assert.notEqual((t.attributes.find(([n]) => n === "method")?.[1] ?? "get").toLowerCase(), "post");
    }
  });
});

describe("the tasks are read like the rest of the page, and held with it", () => {
  test("with the site's own key, beside the stream, and once for everybody until the page is let go", async () => {
    await get("/spaces/task-board");
    const calls = taskCalls("task-board");
    assert.ok(calls.length >= 1);
    const stream = fake.calls.find((c) => c.url.pathname === "/v1/spaces/task-board/posts")!;
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers.get("authorization"), "Bearer site-token-for-tests");
    assert.equal(calls[0]!.headers.get("authorization"), stream.headers.get("authorization"));
    const held = fake.calls.length;
    await get("/spaces/task-board");
    await get("/spaces/task-board");
    assert.equal(fake.calls.length, held, "a second visitor is served from the page the first was");
  });

  test("a signed-in person's page reads them with that person's own key", async () => {
    const { cookie } = await signedIn(WRITER, "writer-token", "192.0.2.61");
    const before = taskCalls("task-board").length;
    const page = await get("/me/spaces/task-board", { Cookie: cookie });
    assert.equal(page.status, 200);
    assert.match(section(page.text), /Transcribe page 3/);
    const mine = taskCalls("task-board").slice(before);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.headers.get("authorization"), "Bearer writer-token");
    assert.doesNotMatch(section(page.text), /<form|<button|<input/, "nothing here changes a task");
  });
});

describe("the markdown twin lists them", () => {
  test("a heading for each, in the service's order, then what the page says", async () => {
    const md = (await get("/spaces/task-board.md")).text;
    assert.deepEqual(markdownProblems(md), []);
    assert.ok(md.indexOf("## Tasks") > 0 && md.indexOf("## Tasks") < md.indexOf("## Latest posts"));
    const headings = [...md.matchAll(/^### Task (\d+) (\w+)$/gm)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(headings, ["7 accepted", "6 open", "5 accepted", "4 done", "3 open", "2 claimed", "1 open"]);
    assert.match(md, /title: `Transcribe page 3`\n\ntag: `transcription`\n\nOpen\./);
    assert.match(md, new RegExp(`Claimed by ${WRITER} until 2026-10-01T10:05:00.000Z\\.`));
    assert.match(md, /Done by [0-9a-f]{64}, 2026-10-01T10:02:00.000Z\. Confirmations: 1 of 2\.\n\nResult post: #2: \/spaces\/task-board\/2\.md/);
    assert.match(md, /Accepted, 2026-10-01T10:04:00.000Z\. Confirmations: 2 of 2\./);
    assert.match(md, /Open\. Its last claim ran out\./);
    assert.match(md, /Reopened after a rejection by [0-9a-f]{64}, 2026-10-01T10:05:00.000Z\. Reason: `The reading ignored the second line\.`/);
    assert.match(md, new RegExp(`Result post: ${id(40)}, at /posts/${id(40)}`));
  });
});

describe("the JSON twin carries the service's fields unchanged", () => {
  test("each task is what the service sent, field for field, and a field it did not name is not forwarded", async () => {
    const doc = JSON.parse((await get("/spaces/task-board.json")).text) as Json;
    const sent = [...BOARD].sort((a, b) => b.number - a.number);
    assert.deepEqual(doc.tasks.items, sent);
    assert.equal(doc.tasks.has_more, false);
    assert.deepEqual(Object.keys(doc.tasks), ["items", "has_more"]);
  });

  test("a field the service adds is dropped, and one in a shape it does not write is left out", async () => {
    const doc = JSON.parse((await get("/spaces/odd-board.json")).text) as Json;
    const [row] = doc.tasks.items;
    assert.ok(!("x_secret" in row));
    assert.ok(!("claimed_by" in row) && !("done_at" in row));
    assert.deepEqual(row.confirmations, { required: 2, given: [OWNER] });
    assert.doesNotMatch(JSON.stringify(doc), /SENTINEL-TASK-FIELD/);
  });
});

describe("the stand-in service was asked for nothing it does not answer", () => {
  test("every address the pages read was answered", () => {
    assert.deepEqual(unanswered, []);
  });
});
