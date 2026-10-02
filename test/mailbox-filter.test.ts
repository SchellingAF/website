// The mailbox kept to one reason, one kind of post or one key, as the service's mailbox
// read takes them: the reasons and the kinds the service publishes, each reason in words;
// a reason or a kind it does not publish is no filter, and a key in any other shape is
// refused before anything is asked. A kept page is walked forwards alone, because the
// positions it spans hold items it leaves out.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, json, service } from "./lib/service.ts";
import { hostileWorld, SECOND } from "./lib/world.ts";
import { htmlProblems, tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const KEY = "a1b2".repeat(16);
const REASONS = ["to", "reply", "request", "decision", "message", "message_request", "proposal", "out_of_date", "changed", "hand_over"];

const base = service(hostileWorld());
const { fake, handleRequest } = await site((call) => {
  const p = call.url.pathname;
  if (p === "/v1/capabilities") return json({ ...CAPABILITIES, mailbox_reasons: [...REASONS, "<script>alert(1)</script>"] });
  if (p === "/v1/mailbox") {
    return json({
      items: [{ mailbox_seq: "7", reason: "proposal", post: { post_id: "0199dddd-0000-7000-8000-000000000007", space: "runner-images", seq: "7", kind: "version", author: KEY, posted_at: "2026-09-18T10:07:00.000Z", title: "More", snippet: "Lead." } }],
      next_after: "7", has_more: true, head_seq: "400",
    });
  }
  return base(call);
});

const { cookie } = await signedIn(SECOND, "mailbox-token", "192.0.2.93");
const reads = () => fake.calls.filter((c) => c.url.pathname === "/v1/mailbox");

async function get(path: string) {
  const res = await handleRequest(new Request(`${SITE}${path}`, { headers: { Cookie: cookie } }), env);
  return { res, text: await res.text() };
}
const options = (html: string, name: string) => {
  const t = tags(html);
  const at = t.findIndex((x) => x.name === "select" && x.attributes.some(([n, v]) => n === "name" && v === name));
  const end = t.findIndex((x, i) => i > at && x.name === "select" && x.closing);
  return t.slice(at, end).filter((x) => x.name === "option" && !x.closing).map((x) => x.attributes.find(([n]) => n === "value")?.[1]);
};

describe("the mailbox, kept to one reason, one kind or one key", () => {
  test("offers every reason the service publishes, in words, and every kind; an unkept page walks from either end", async () => {
    const { res, text } = await get("/me/mailbox");
    assert.equal(res.status, 200, text.slice(0, 300));
    assert.deepEqual(options(text, "reason"), ["", ...REASONS], "a reason in any other shape is not offered");
    assert.match(text, /<option value="proposal">a proposal waiting for your decision<\/option>/);
    assert.ok(options(text, "kind").includes("version"));
    assert.match(text, /Newest items/);
    assert.deepEqual(htmlProblems(text), []);
    // A service that lists no reason of a task or a citation is not said to send them.
    assert.match(text, /new versions of documents you watch, and roles other keys offer you\./);
    assert.doesNotMatch(text, /cite yours|tasks you claimed/);
  });

  test("a kept page asks the service for exactly that, says what it keeps, and walks forwards alone", async () => {
    const { text } = await get(`/me/mailbox?reason=proposal&kind=version&author=${KEY.toUpperCase()}`);
    const sent = reads().at(-1)!.url.searchParams;
    assert.equal(sent.get("reason"), "proposal");
    assert.equal(sent.get("kind"), "version");
    assert.equal(sent.get("author"), KEY);
    assert.match(text, /Showing only a proposal waiting for your decision, posts of the kind version, what key a1b2a1b2…a1b2 sent\./);
    assert.match(text, new RegExp(`href="/me/mailbox\\?reason=proposal&amp;kind=version&amp;author=${KEY}&amp;after=7">Later items`));
    assert.doesNotMatch(text, /Newest items|Earlier items/);
    assert.match(text, /<option value="proposal" selected>/);
  });

  test("a reason or a kind the service does not publish is no filter at all", async () => {
    await get(`/me/mailbox?reason=nonsense&kind=${encodeURIComponent("<script>")}`);
    const sent = reads().at(-1)!.url.searchParams;
    assert.equal(sent.get("reason"), null);
    assert.equal(sent.get("kind"), null);
  });

  test("a key in any other shape is refused before anything is asked, and shown back as text", async () => {
    const before = reads().length;
    const { res, text } = await get(`/me/mailbox?author=${encodeURIComponent('"><script>alert(2)</script>')}`);
    assert.equal(res.status, 400);
    assert.equal(reads().length, before);
    assert.match(text, /64 characters of 0 to 9 and a to f/);
    assert.doesNotMatch(text, /Showing only|Nothing here/, "a refused filter shows its form and why, and claims nothing about the mailbox");
    assert.ok(!text.includes("<script>alert(2)"));
    assert.deepEqual(htmlProblems(text), []);
  });
});
