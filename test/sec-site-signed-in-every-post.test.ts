// Every address a signed-in form posts to refuses a POST from another site, and one
// without the session's form token, before it asks the product anything. The checks sit
// in front of every handler (handleSignedIn in src/me.ts), and this holds each address to
// them. A space's actions are read from src/me.ts's own ACTING pattern, so one added there
// is asked about here without anybody listing it. The rest are a list kept by hand below:
// the key's own forms, join requests, invite links, hand-overs and direct messages. An
// address added outside ACTING is asked about here only once it is added to that list.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { json } from "./lib/service.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const ME = "a1b2".repeat(16);
const ID = "0199eeee-0000-7000-8000-000000000001";

const { fake, handleRequest } = await site(() => json({}));

// The actions a space's forms post to, read from src/me.ts as it routes them.
const source = readFileSync(new URL("../src/me.ts", import.meta.url), "utf8");
const acting = /const ACTING = new RegExp\(`\^\/me\/spaces\/\(\$\{NAME\}\)\/\(([a-z/|-]+)\)\$`\)/.exec(source)?.[1];

const ADDRESSES = [
  // By hand: the key's own forms.
  "/me/new", "/me/encryption-key", "/me/name", "/me/connect", "/me/tokens/new", "/me/tokens/revoke", "/me/tokens/revoke-all",
  // Read from src/me.ts: every action of a space.
  ...(acting ?? "").split("|").map((a) => `/me/spaces/crew/${a}`),
  // By hand: join requests, invite links, hand-overs and direct messages.
  ...["approve", "decline", "withdraw"].map((a) => `/me/requests/${ID}/${a}`),
  ...["revoke", "remove"].map((a) => `/me/invites/${ID}/${a}`),
  ...["accept", "decline"].map((a) => `/me/hand-overs/${ID}/${a}`),
  "/me/messages/new", "/me/messages/block", "/me/messages/unblock", "/me/messages/retention",
  ...["send", "accept", "decline", "leave", "clear", "read", "invite"].map((a) => `/me/messages/${ID}/${a}`),
  // An address with no action at all is refused the same way, before anything says so.
  "/me/nothing-here",
];

const me = await signedIn(ME, "every-post-token", "192.0.2.250");
const FORM = "application/x-www-form-urlencoded";

async function post(path: string, headers: Record<string, string>, body: string) {
  const before = fake.calls.length;
  const res = await handleRequest(new Request(`${SITE}${path}`, { method: "POST", headers: { Cookie: me.cookie, ...headers }, body }), env);
  return { res, text: await res.text(), asked: fake.calls.slice(before) };
}

describe("every signed-in form's address", () => {
  test("the space actions were read from src/me.ts", () => {
    assert.ok(acting && acting.split("|").length >= 20, "src/me.ts no longer lists its space actions where this test reads them");
  });

  test("refuses a form from another site, or from nowhere it says, and asks the product nothing", async () => {
    for (const path of ADDRESSES) {
      for (const from of [{ Origin: "https://evil.example" }, { Origin: "null", "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, {}]) {
        const { res, text, asked } = await post(path, { ...from, "Content-Type": FORM }, new URLSearchParams({ csrf: me.csrf }).toString());
        assert.equal(res.status, 403, `${path} ${JSON.stringify(from)}`);
        assert.ok(text.includes("did not come from a page of this site"), path);
        assert.deepEqual(asked, [], `${path} ${JSON.stringify(from)} asked the product`);
      }
    }
  });

  test("refuses a form without the session's own token, or that is not a form, and asks the product nothing", async () => {
    for (const path of ADDRESSES) {
      for (const [type, body] of [[FORM, "csrf=wrong"], [FORM, ""], ["text/plain", `csrf=${me.csrf}`], ["application/json", JSON.stringify({ csrf: me.csrf })]] as const) {
        const { res, asked } = await post(path, { Origin: SITE, "Content-Type": type }, body);
        assert.equal(res.status, 403, `${path} ${type} ${body.slice(0, 20)}`);
        assert.deepEqual(asked, [], `${path} asked the product`);
      }
    }
  });

  test("a multipart form, the one shape that carries files, is read only at a space's posts", async () => {
    for (const path of ADDRESSES.filter((p) => !p.endsWith("/crew/posts"))) {
      const body = new FormData();
      body.set("csrf", me.csrf);
      const { res, asked } = await post(path, { Origin: SITE }, body as unknown as string);
      assert.equal(res.status, 403, path);
      assert.deepEqual(asked, [], `${path} asked the product`);
    }
  });
});
