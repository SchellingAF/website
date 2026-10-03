// A title where the service needs one, on the signed-in post form.
//
// The service lists the kinds it takes with no title (`kinds_without_title`, ack, hold, go,
// veto and stop) and refuses every other kind without one with TITLE_REQUIRED. This site
// checks before it sends, from that list and only when the service publishes it, and says
// the refusal in the service's own sentence. A passkey-signed post and a sealed one are
// checked by their scripts (test/post-fields.test.ts runs the first); a service that does
// not publish the list is test/title-required-absent.test.ts's, in a file of its own because
// the site holds the capability document for the whole process.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, json, refusal, service, type Call, type World } from "./lib/service.ts";
import { hostileWorld } from "./lib/world.ts";
import { htmlProblems, signedInProblems, tags } from "./lib/documents.ts";
import { titleProblem, titleWords } from "../src/post-object.js";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const SPACE_ID = "0199dddd-0000-7000-8000-00000000cccc";
const UNTITLED = ["ack", "hold", "go", "veto", "stop"];

const world: World = {
  ...hostileWorld(),
  capabilities: { ...CAPABILITIES, kinds_without_title: UNTITLED },
  spaces: [{
    name: "work-space", space_id: SPACE_ID, title: "Work", description: "Where work is done.", visibility: "private", join_policy: "request",
    status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: OWNER,
    contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-18T09:00:00.000Z",
    access: { role: "owner", tags: [], read: true, post: true },
  }],
  posts: {
    "work-space": [{
      post_id: "0199dddd-0000-7000-8000-0000000000a1", space: "work-space", space_id: SPACE_ID, seq: "1", kind: "result", author: OWNER,
      posted_at: "2026-10-03T10:00:00.000Z", title: "Slim fails on arm64: 3 of 3 runs", body: "The long working.", to: [], reply_to: null,
      supersedes: null, retracts: null, fingerprints: [], signed: false,
    }],
  },
};
const base = service(world);
const { fake, handleRequest } = await site((call: Call) => {
  if (call.method === "POST" && call.url.pathname === "/v1/spaces/work-space/posts") {
    // The service's own refusal, for a post that reached it with no title.
    if (JSON.parse(call.body ?? "{}").body === "REACH THE SERVICE") return refusal(400, "TITLE_REQUIRED", "TITLE_REQUIRED. This kind of POST needs a title.", "obs");
    return json({ post_id: "0199dddd-0000-7000-8000-000000000001", seq: "1" }, 201);
  }
  return base(call);
});
const { cookie, csrf } = await signedIn(OWNER, "title-token", "192.0.2.96");
const writes = () => fake.calls.filter((c) => c.method === "POST" && c.url.pathname === "/v1/spaces/work-space/posts");

async function send(fields: Record<string, string>) {
  const res = await handleRequest(new Request(`${SITE}/me/spaces/work-space/posts`, {
    method: "POST",
    headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, kind: "obs", body: "It starts on arm64.", ...fields }).toString(),
  }), env);
  return { res, text: await res.text() };
}

const SAID = "This kind of post needs a title: the result and the figure that decides it, not the topic, in about 120 bytes. Only ack, hold, go, veto and stop post without one. Nothing was posted.";

describe("a post with no title, where its kind needs one", () => {
  test("is refused here in the service's sentence, nothing is sent, and the form comes back as it was typed", async () => {
    await send({ title: "Warm up the capability document" });
    const before = writes().length;
    for (const title of [undefined, "", "   "]) {
      const { res, text } = await send(title === undefined ? {} : { title });
      assert.equal(res.status, 400, `title ${JSON.stringify(title)}`);
      assert.ok(text.includes(SAID), text.slice(text.indexOf("Not posted"), text.indexOf("Not posted") + 600));
      assert.match(text, /<textarea name="body"[^>]*>It starts on arm64\.<\/textarea>/, "what was typed is shown again");
      assert.deepEqual(htmlProblems(text), []);
    }
    assert.equal(writes().length, before, "nothing reached the service");
  });

  test("a title lets it through, and every kind of the coordination group needs none", async () => {
    const before = writes().length;
    assert.equal((await send({ title: "Slim fails on arm64: 3 of 3 runs" })).res.status, 303);
    for (const kind of UNTITLED) assert.equal((await send({ kind, body: `${kind}.` })).res.status, 303, kind);
    assert.equal(writes().length, before + 1 + UNTITLED.length);
    assert.equal(JSON.parse(writes()[before]!.body!).title, "Slim fails on arm64: 3 of 3 runs");
    assert.ok(!("title" in JSON.parse(writes().at(-1)!.body!)), "a post of a kind that needs none sends none");
  });

  test("the service's own refusal of one that reached it is said in the same words", async () => {
    // A post the service refused, as a form posted before this site read the list would be.
    const { res, text } = await send({ title: "x", body: "REACH THE SERVICE" });
    assert.equal(res.status, 400);
    assert.ok(text.includes(SAID), text);
    assert.ok(!text.includes("TITLE_REQUIRED"), "the service's code is not what the person reads");
  });

  test("the post form names the kinds that need none, for the script that signs", async () => {
    const page = await handleRequest(new Request(`${SITE}/me/spaces/work-space`, { headers: { Cookie: cookie } }), env);
    const text = await page.text();
    assert.equal(page.status, 200);
    const forms = tags(text).filter((t) => t.name === "form" && t.attributes.some(([k]) => k === "data-sign"));
    assert.ok(forms.length >= 1, "a form a passkey signs");
    for (const form of forms) assert.deepEqual(form.attributes.find(([k]) => k === "data-untitled-kinds"), ["data-untitled-kinds", "ack hold go veto stop"]);
  });
});

describe("the retraction form, which posts a decision", () => {
  test("says a title is needed, since a decision needs one here, and the reply form says nothing of it", async () => {
    const res = await handleRequest(new Request(`${SITE}/me/spaces/work-space/1`, { headers: { Cookie: cookie } }), env);
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 300));
    const retraction = /<h2>Retract this post, saying why<\/h2>[\s\S]*?<\/form>/.exec(text)?.[0] ?? "";
    assert.match(retraction, /<label>Title, needed here: say what you retract, in a line\n<input type="text" name="title"/);
    const reply = /<h2>Reply to this post<\/h2>[\s\S]*?<\/form>/.exec(text)?.[0] ?? "";
    assert.match(reply, /<label>Title\n<input type="text" name="title"/);
    assert.deepEqual(signedInProblems(text), []);
  });
});

describe("the words and the rule, which the server and both scripts share", () => {
  test("only a kind that needs a title, with no title, is a problem, and only where the kinds that need none are known", () => {
    assert.equal(titleProblem("obs", "", UNTITLED), titleWords(UNTITLED));
    assert.equal(titleProblem("obs", " \n", UNTITLED), titleWords(UNTITLED));
    assert.equal(titleProblem("obs", undefined, UNTITLED), titleWords(UNTITLED));
    assert.equal(titleProblem("version", "", UNTITLED), titleWords(UNTITLED));
    assert.equal(titleProblem("obs", "A result: 3 of 3", UNTITLED), "");
    for (const kind of UNTITLED) assert.equal(titleProblem(kind, "", UNTITLED), "", kind);
    assert.equal(titleProblem("obs", "", null), "", "a service that names none is not second-guessed");
    assert.equal(titleProblem("obs", "", undefined), "");
    assert.equal(titleProblem("", "", UNTITLED), "", "no kind is another check's to refuse");
  });

  test("the sentence names the kinds from the list the service gave, and none when it gave none", () => {
    assert.equal(titleWords(["ack"]), "This kind of post needs a title: the result and the figure that decides it, not the topic, in about 120 bytes. Only ack post without one.");
    assert.equal(titleWords(["ack", "go"]), "This kind of post needs a title: the result and the figure that decides it, not the topic, in about 120 bytes. Only ack and go post without one.");
    assert.equal(titleWords([]), "This kind of post needs a title: the result and the figure that decides it, not the topic, in about 120 bytes.");
    assert.equal(titleWords(null), titleWords([]));
    assert.ok(!/POST|TITLE_REQUIRED/.test(titleWords(UNTITLED)), "a person's words: post, never POST, and no code");
  });
});
