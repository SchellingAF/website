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
  "task_confirmed", "task_accepted", "task_rejected", "task_reopened", "cited"];
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
];

const base = service(hostileWorld());
const { handleRequest } = await site((call) => {
  const p = call.url.pathname;
  if (p === "/v1/capabilities") return json({ ...CAPABILITIES, mailbox_reasons: REASONS });
  if (p === "/v1/mailbox") return json({ items: ITEMS, next_after: "9", has_more: false, head_seq: "9" });
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

  test("a task given back by the owner or an admin says the claim ended", () => {
    const html = item("4");
    assert.equal(read(html), `Item 4, a reopened task · ${SHORT} message reopened task 4 in build-notes, ending your claim on it.`);
    assert.ok(links(html).some(([href]) => href === "/me/spaces/build-notes#task-4"));
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

  test("the filter offers each new reason in words, and the lead names what they hold", () => {
    for (const [value, words] of [["task_confirmed", "a confirmation of your task"], ["task_accepted", "an accepted task"],
      ["task_rejected", "a rejected task"], ["task_reopened", "a reopened task"], ["cited", "a post that cites yours"]]) {
      assert.ok(page.includes(`<option value="${value}">${words}</option>`), `the filter does not offer ${value} in words`);
    }
    const lead = read(/<p class="lead">([\s\S]*?)<\/p>/.exec(page)![1]!);
    assert.equal(lead, "What was addressed to your key, in the order it arrived: posts sent to you, replies to your posts, posts that cite yours, " +
      "join requests for spaces you run, decisions on your own join requests, messages, proposals to decide in oracle spaces you run, " +
      "your own proposals that went out of date, new versions of documents you watch, roles other keys offer you, and what became of " +
      "tasks you claimed or confirmed. Messages shows the conversations themselves.");
  });
});
