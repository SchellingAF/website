// /me/connect against a product that does not take connection keys: its capability
// document lists no label for their statement, as a product deployed before the site's
// app signing does not. The page offers no box and runs no signing script, and Allow
// connects the app as it always did. A file of its own, because the site holds the
// capability document for the whole process.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, json, refusal } from "./lib/service.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";

const { fake, handleRequest } = await site((call) => {
  const path = call.url.pathname;
  if (path === "/v1/capabilities") return json(CAPABILITIES);
  if (path === "/v1/conversations") return json({ items: [], unread_conversations: 0, requests_waiting: 0 });
  if (path === `/v1/authorizations/${ID}`) {
    return json({
      request_id: ID, state: "pending",
      client: { id: "https://claude.ai/oauth/client.json", kind: "metadata_document", name: "Claude", publisher: "claude.ai" },
      redirect: { host: "claude.ai", uri: "https://claude.ai/api/mcp/auth_callback", loopback: false, only_loopback: false },
      scope: ["read", "write"], expires_at: new Date(Date.now() + 600_000).toISOString(), token_lifetime_days: 90,
    });
  }
  if (path === `/v1/authorizations/${ID}/approve`) {
    return json({ decision: "approved", redirect_to: "https://claude.ai/api/mcp/auth_callback?code=c&state=s" });
  }
  return refusal(404, "NOT_ANSWERED");
});

describe("a product that takes no connection keys", () => {
  test("is offered no box and no signing script, and Allow connects the app as before", async () => {
    assert.equal((CAPABILITIES.protocol as Record<string, unknown>).labels, undefined, "the stand-in lists a label after all");
    const { cookie, csrf } = await signedIn("d5".repeat(32), "no-keys-token", "198.51.100.90", "Q3JlZGVudGlhbA");
    const page = await handleRequest(new Request(`${SITE}/me/connect?request=${ID}`, { headers: { Cookie: cookie } }), env);
    const text = await page.text();
    assert.equal(page.status, 200);
    assert.match(text, /An app wants to connect as your key/);
    assert.doesNotMatch(text, /sign_posts|connect-signing\.js|data-connection-key|ck_seed|signing_offered/);
    assert.match(text, /<button type="submit" data-guard disabled>Allow<\/button>/);
    const before = fake.calls.length;
    const allowed = await handleRequest(new Request(`${SITE}/me/connect`, {
      method: "POST",
      headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, request: ID, decision: "allow" }).toString(),
    }), env);
    const said = await allowed.text();
    assert.equal(allowed.status, 200);
    const approve = fake.calls.slice(before).find((c) => c.url.pathname === `/v1/authorizations/${ID}/approve`)!;
    assert.deepEqual(JSON.parse(approve.body ?? "null"), {});
    assert.match(said, /The app can now act as your key\. Revoke it any time on Access tokens\./);
  });
});
