// Replying to one message in a conversation, and naming the space a message is about:
// every message offers a reply to it alone, the reply box says which message it answers
// and sends it, a reply names what it answers by its number, and what goes into the
// product is held to the shapes the service takes.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { json, service, type Call } from "./lib/service.ts";
import { hostileWorld } from "./lib/world.ts";
import { htmlProblems } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const ME = "a1b2".repeat(16);
const OTHER = "c3d4".repeat(16);
const CONVERSATION = "0199eeee-0000-7000-8000-00000000c0c0";
const FIRST = "0199eeee-0000-7000-8000-000000000001";
const SECOND_MESSAGE = "0199eeee-0000-7000-8000-000000000002";

const base = service(hostileWorld());
const { fake, handleRequest } = await site((call: Call) => {
  const p = call.url.pathname;
  if (p === `/v1/conversations/${CONVERSATION}`) {
    return json({
      conversation_id: CONVERSATION, kind: "pair", started_by: OTHER, created_at: "2026-09-18T09:00:00.000Z", state: "accepted",
      members: [{ peer_id: ME, state: "accepted" }, { peer_id: OTHER, state: "accepted" }], head_seq: "2", read_seq: "2", cleared_through: "0",
      unread: false, last_message_at: "2026-09-18T09:05:00.000Z",
    });
  }
  if (p === `/v1/conversations/${CONVERSATION}/messages` && call.method === "GET") {
    return json({
      items: [
        { message_id: SECOND_MESSAGE, conversation_id: CONVERSATION, seq: "2", author: ME, sent_at: "2026-09-18T09:05:00.000Z", reply_to: FIRST, about: null, body: "Yes, from tomorrow." },
        { message_id: FIRST, conversation_id: CONVERSATION, seq: "1", author: OTHER, sent_at: "2026-09-18T09:00:00.000Z", reply_to: null, about: "work-space", body: "Can you take the arm64 builds?" },
      ],
      next_after: null, has_more: false,
    });
  }
  if (p === `/v1/conversations/${CONVERSATION}/messages` && call.method === "POST") return json({ message_id: "0199eeee-0000-7000-8000-000000000003", seq: "3" }, 201);
  return base(call);
});

const { cookie, csrf } = await signedIn(ME, "reply-token", "192.0.2.96");
const sends = () => fake.calls.filter((c) => c.method === "POST" && c.url.pathname === `/v1/conversations/${CONVERSATION}/messages`);

async function page(query = "") {
  const res = await handleRequest(new Request(`${SITE}/me/messages/${CONVERSATION}${query}`, { headers: { Cookie: cookie } }), env);
  return { res, text: await res.text() };
}
async function send(fields: Record<string, string>) {
  const res = await handleRequest(new Request(`${SITE}/me/messages/${CONVERSATION}/send`, {
    method: "POST",
    headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, body: "On it.", ...fields }).toString(),
  }), env);
  return { res, text: await res.text() };
}

describe("replying to one message", () => {
  test("every message offers a reply to it alone, and a reply names what it answers by its number", async () => {
    const { res, text } = await page();
    assert.equal(res.status, 200, text.slice(0, 300));
    for (const id of [FIRST, SECOND_MESSAGE]) {
      assert.match(text, new RegExp(`href="/me/messages/${CONVERSATION}\\?reply_to=${id}#end">Reply to this</a>`));
    }
    assert.match(text, /a reply to <a href="#m1">#1<\/a>/);
    assert.doesNotMatch(text, /name="reply_to"/, "the box answers nothing until a message is chosen");
    assert.match(text, /name="about"/);
    assert.deepEqual(htmlProblems(text), []);
  });

  test("the box says which message it answers, and carries it", async () => {
    const { text } = await page(`?reply_to=${FIRST}`);
    assert.match(text, /Replying to <a href="#m1">#1<\/a>\./);
    assert.match(text, new RegExp(`<input type="hidden" name="reply_to" value="${FIRST}">`));
    assert.match(text, /Write without replying to it/);
    const odd = await page(`?reply_to=${encodeURIComponent('"><script>alert(1)</script>')}`);
    assert.doesNotMatch(odd.text, /name="reply_to"/, "an id in any other shape answers nothing");
    assert.ok(!odd.text.includes("<script>alert(1)"));
  });

  test("a reply and the space it names reach the product; either in another shape sends nothing", async () => {
    const { res } = await send({ reply_to: FIRST, about: "work-space" });
    assert.equal(res.status, 303);
    const sent = JSON.parse(sends().at(-1)!.body!);
    assert.equal(sent.reply_to, FIRST);
    assert.equal(sent.about, "work-space");
    const before = sends().length;
    for (const fields of [{ reply_to: "not-an-id" }, { about: "Not A Space" }]) {
      const { res: refused } = await send(fields);
      assert.equal(refused.status, 400, JSON.stringify(fields));
    }
    assert.equal(sends().length, before);
    await send({});
    const plain = JSON.parse(sends().at(-1)!.body!);
    assert.ok(!("reply_to" in plain) && !("about" in plain), "a message answering nothing names nothing");
  });
});
