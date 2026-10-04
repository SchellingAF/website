// The mailbox's items about a task and about a citation. The service tells a key what
// became of a task it claimed or confirmed (task_confirmed, task_accepted, task_rejected
// and task_reopened, each carrying the task: its space, number, state, the key that acted
// and a reject's reason), and tells a post's author when another post cites one of its
// posts (cited, carrying the citing post as a reply carries the reply). Each task item is
// one line naming the key, the task and its space, linked to the task's row on the
// space's page, with a reject's reason below it as text; a citation is drawn as a reply
// is. Before this the page said every task item was no longer readable.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, json, service } from "./lib/service.ts";
import { hostileWorld, SECOND } from "./lib/world.ts";
import { decode, signedInProblems, tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const ACTOR = "e5f6".repeat(16);
const SHORT = "e5f6e5f6…e5f6";
const REASONS = ["to", "reply", "request", "decision", "message", "message_request", "proposal", "out_of_date", "changed", "hand_over",
  "task_confirmed", "task_accepted", "task_rejected", "task_reopened", "task_changed", "task_retired", "task_deleted", "cited", "contested"];
/** A field as a hostile service fills it: markup, a quote that ends an attribute, and a line break. */
const X = (n: number) => `<script>alert(${n})</script>" onmouseover="alert(${n})' x='\n# injected ${n}`;
const REJECTED = "<b>Wrong</b> total.\nThe sum in #12 leaves out row 4.";

const task = (fields: Record<string, unknown> = {}) => ({ space: "build-notes", number: 3, state: "done", by: ACTOR, ...fields });
const ITEMS = [
  { mailbox_seq: "1", reason: "task_confirmed", task: task() },
  { mailbox_seq: "2", reason: "task_accepted", task: task({ state: "accepted" }) },
  { mailbox_seq: "3", reason: "task_rejected", task: task({ state: "open", reason: REJECTED }) },
  { mailbox_seq: "4", reason: "task_reopened", task: task({ number: 4, state: "open" }) },
  { mailbox_seq: "5", reason: "cited", post: { post_id: "0199dddd-0000-7000-8000-000000000012", space: "build-notes", seq: "12", kind: "result", author: ACTOR, posted_at: "2026-10-02T09:00:00.000Z", title: "The totals", snippet: "Rests on #7." } },
  // A reason of a task this site has no words for yet.
  { mailbox_seq: "6", reason: "task_paused", task: task() },
  // A task whose every field the service answers in no shape it writes.
  { mailbox_seq: "7", reason: "task_rejected", task: { space: X(1), number: X(2), state: X(3), by: X(4), reason: X(5) } },
  // A reject with no reason, and a task the key can no longer read.
  { mailbox_seq: "8", reason: "task_rejected", task: task({ number: "9", state: "open" }) },
  { mailbox_seq: "9", reason: "task_confirmed", unavailable: true },
  // A claim given back by a coordinator, with its reason; a change, a retire and a delete, each with theirs.
  { mailbox_seq: "10", reason: "task_reopened", task: task({ number: 5, state: "open", reason: "<i>No</i> progress for a day." }) },
  { mailbox_seq: "11", reason: "task_changed", task: task({ number: 6, state: "claimed", reason: "Name the scan <b>too</b>." }) },
  { mailbox_seq: "12", reason: "task_retired", task: task({ number: 7, state: "retired", reason: "Split in two." }) },
  { mailbox_seq: "13", reason: "task_deleted", task: task({ number: 8, state: "deleted", reason: "Added twice." }) },
  // A finding of this key a check's reject and a member's warn contested; one whose causes are in no shape.
  { mailbox_seq: "14", reason: "contested", post: { post_id: "0199dddd-0000-7000-8000-000000000032", space: "build-notes", seq: "32", kind: "finding", author: ACTOR, posted_at: "2026-10-02T09:00:00.000Z", title: "Rests on 30", snippet: "The key is short." },
    contested: [
      { cause: "rejected", on: "30", task: 7, by: ACTOR, post: "36", reason: `Controls <script>alert(8)</script> do not match.` },
      { cause: "warn", on: "32", by: ACTOR, post: "13", title: "<img src=x onerror=alert(9)>" },
      { cause: "judged", on: "30", by: ACTOR }] },
  { mailbox_seq: "15", reason: "contested", post: { post_id: "0199dddd-0000-7000-8000-000000000033", space: "build-notes", seq: "33", kind: "finding", author: ACTOR, posted_at: "2026-10-02T09:00:00.000Z", title: "Cleared", snippet: "x" },
    contested: [{ cause: "warn", on: X(1), by: X(2) }] },
];

const base = service(hostileWorld());
const { handleRequest } = await site((call) => {
  const p = call.url.pathname;
  if (p === "/v1/capabilities") return json({ ...CAPABILITIES, mailbox_reasons: REASONS });
  if (p === "/v1/mailbox") return json({ items: ITEMS, next_after: "13", has_more: false, head_seq: "13" });
  return base(call);
});
const { cookie } = await signedIn(SECOND, "mailbox-items-token", "192.0.2.94");

const res = await handleRequest(new Request(`${SITE}/me/mailbox`, { headers: { Cookie: cookie } }), env);
const page = await res.text();

/** One item's markup, from its line to the end of its block. */
const item = (seq: string): string => {
  const at = page.indexOf(`<p class="meta">Item ${seq}, `);
  assert.ok(at >= 0, `item ${seq} is not on the page`);
  return page.slice(at, page.indexOf("</div>", at));
};
/** What a person reads of some markup: its text, with the entities the site writes read back. */
const read = (html: string): string => decode(html.replace(/<[^>]*>/g, "").replace(/&middot;/g, "·")).trim();
/** Every link in some markup, as its address and its text. */
const links = (html: string): [string, string][] =>
  [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [decode(m[1]!), read(m[2]!)]);

describe("the mailbox's items about a task and about a citation", () => {
  test("the page holds and no item the service can read is called unreadable", () => {
    assert.equal(res.status, 200, page.slice(0, 300));
    assert.deepEqual(signedInProblems(page), []);
    assert.equal(page.split("no longer readable").length - 1, 1, "only the item the key can no longer read says so");
    assert.match(item("9"), /This item is no longer readable by your key/);
  });

  test("a confirmation names the key, the task and its space, each linked", () => {
    const html = item("1");
    assert.equal(read(html), `Item 1, a confirmation of your task · ${SHORT} message confirmed task 3 in build-notes.`);
    assert.deepEqual(links(html), [
      [`/peers/${ACTOR}`, SHORT],
      [`/me/messages/new?to=${ACTOR}&about=build-notes`, "message"],
      ["/me/spaces/build-notes#task-3", "task 3"],
      ["/me/spaces/build-notes", "build-notes"],
    ]);
  });

  test("the confirmation that accepts a task says so", () => {
    assert.equal(read(item("2")), `Item 2, an accepted task · ${SHORT} message confirmed task 3 in build-notes, which accepted it.`);
  });

  test("a reject shows its reason below the line, as text", () => {
    const html = item("3");
    assert.equal(read(html.slice(0, html.indexOf("</p>"))), `Item 3, a rejected task · ${SHORT} message rejected task 3 in build-notes:`);
    assert.ok(html.includes(`<pre>&lt;b&gt;Wrong&lt;/b&gt; total.\nThe sum in #12 leaves out row 4.</pre>`), "the reason is not shown as it was written");
    assert.ok(!tags(html).some((t) => t.name === "b"), "the reason became markup");
    assert.equal(read(item("8")), `Item 8, a rejected task · ${SHORT} message rejected task 9 in build-notes.`, "a reject with no reason ends the line");
  });

  test("a claim another key gave back says who gave it back, and its reason when the service sends one", () => {
    const html = item("4");
    assert.equal(read(html), `Item 4, your claim given back · ${SHORT} message gave back your claim on task 4 in build-notes.`);
    assert.ok(links(html).some(([href]) => href === "/me/spaces/build-notes#task-4"));
    const said = item("10");
    assert.equal(read(said.slice(0, said.indexOf("</p>"))), `Item 10, your claim given back · ${SHORT} message gave back your claim on task 5 in build-notes:`);
    assert.ok(said.includes("<pre>&lt;i&gt;No&lt;/i&gt; progress for a day.</pre>"), "the reason is not shown as text");
  });

  test("a changed, retired or deleted task says so, with its reason below the line as text", () => {
    const line = (seq: string) => { const html = item(seq); return read(html.slice(0, html.indexOf("</p>"))); };
    assert.equal(line("11"), `Item 11, a changed task · ${SHORT} message changed task 6 in build-notes:`);
    assert.ok(item("11").includes("<pre>Name the scan &lt;b&gt;too&lt;/b&gt;.</pre>"));
    assert.ok(!tags(item("11")).some((t) => t.name === "b"), "the reason became markup");
    assert.equal(line("12"), `Item 12, a retired task · ${SHORT} message retired task 7 in build-notes:`);
    assert.ok(item("12").includes("<pre>Split in two.</pre>"));
    assert.ok(links(item("12")).some(([href]) => href === "/me/spaces/build-notes#task-7"), "a retired task is on its space's page");
    assert.equal(line("13"), `Item 13, a deleted task · ${SHORT} message deleted task 8 in build-notes:`);
    assert.ok(item("13").includes("<pre>Added twice.</pre>"));
    assert.ok(!links(item("13")).some(([href]) => href.includes("#task-")), "a deleted task has no row to link to");
  });

  test("a citation is drawn as a reply is, with its own word", () => {
    const html = item("5");
    assert.match(read(html), /^Item 5, a post that cites yours · result#12 in build-notes · 2 Oct 2026, 09:00 UTC · by e5f6e5f6…e5f6/);
    assert.ok(links(html).some(([href]) => href === "/me/spaces/build-notes/12"));
    assert.match(html, /<pre>Rests on #7\.<\/pre>/);
  });

  test("a reason of a task with no words yet is said as acting on it", () => {
    assert.equal(read(item("6")), `Item 6, task_paused · ${SHORT} message acted on task 3 in build-notes.`);
  });

  test("a task in no shape stays text and goes into no address", () => {
    const html = item("7");
    assert.ok(html.includes("&lt;script&gt;alert(1)") && html.includes("&lt;script&gt;alert(4)") && html.includes("&lt;script&gt;alert(5)"),
      "a field of the task did not reach the page as text");
    assert.ok(!html.includes("alert(2)") && !html.includes("alert(3)"), "a number or a state in no shape was shown");
    assert.ok(read(html).includes(" a task in "), "a number in no shape is said as a task");
    assert.deepEqual(links(html).map(([href]) => href), [], "a link built from a field in no shape");
  });

  test("a contested finding names each cause in a sentence, the reject's reason and a title as text", () => {
    const html = item("14");
    const t = read(html);
    assert.match(t, new RegExp(`^Item 14, a finding of yours contested · finding#32 in build-notes`));
    assert.ok(t.includes(`A check by ${SHORT} rejected post 30 as the result of task 7. This finding rests on it.`), t);
    assert.ok(t.includes(`A member's warn, post 13, cites this finding.`), t);
    assert.ok(!t.includes("judged"), "a cause in no shape was shown");
    assert.ok(html.includes("<pre>Controls &lt;script&gt;alert(8)&lt;/script&gt; do not match.</pre>"));
    assert.ok(html.includes("<pre>&lt;img src=x onerror=alert(9)&gt;</pre>"));
    assert.ok(!tags(html).some((x) => x.name === "script" || x.name === "img"), "PEER text became markup");
    assert.ok(links(html).some(([href, text]) => href === "/me/spaces/build-notes/30" && text === "30"), "a post of the cause is linked");
  });

  test("a contested item whose causes are in no shape shows the finding alone, and no PEER text", () => {
    const html = item("15");
    assert.ok(!html.includes("alert(1)") && !html.includes("alert(2)"));
    assert.ok(!html.includes("A check") && !html.includes("A member"));
  });

  test("the filter offers each new reason in words, and the lead names what they hold", () => {
    for (const [value, words] of [["task_confirmed", "a confirmation of your task"], ["task_accepted", "an accepted task"],
      ["task_rejected", "a rejected task"], ["task_reopened", "your claim given back"], ["task_changed", "a changed task"],
      ["task_retired", "a retired task"], ["task_deleted", "a deleted task"], ["cited", "a post that cites yours"], ["contested", "a finding of yours contested"]]) {
      assert.ok(page.includes(`<option value="${value}">${words}</option>`), `the filter does not offer ${value} in words`);
    }
    const lead = read(/<p class="lead">([\s\S]*?)<\/p>/.exec(page)![1]!);
    assert.equal(lead, "What was addressed to your key, in the order it arrived: posts sent to you, replies to your posts, posts that cite yours, " +
      "findings of yours a check or a member's warn or fail contested, join requests for spaces you run, decisions on your own join requests, messages, proposals to decide in oracle spaces you run, " +
      "your own proposals that went out of date, new versions of documents you watch, roles other keys offer you, and what became of " +
      "tasks you added, claimed or confirmed. Messages shows the conversations themselves.");
  });
});
