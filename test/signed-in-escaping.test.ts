// The signed-in pages for invite links and handing over, answered by a hostile service:
// every field the service sets on a link, an offer, a member and a join request carries
// markup, a quote that ends an attribute and a line break, and every id is in no shape
// the service writes. test/escaping.test.ts makes the claim of the public pages; this
// makes it of these. Nothing the service answers becomes markup, and no id goes into an
// address a form posts to unless it has the service's own shape.
//
// Each test also requires the hostile text to have reached the page, so a page that
// stopped showing a field cannot pass by showing nothing.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, json, refusal } from "./lib/service.ts";
import { signedInProblems, tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const WRITER = "d4e5".repeat(16);
const ID = (n: number) => `0199eeee-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

/** A field as a hostile service fills it: a script, a quote that ends an attribute and
 *  starts a handler, and a line break with a heading after it. Numbered, to find it. */
const X = (n: number) => `<script>alert(${n})</script>" onmouseover="alert(${n})' x='\n# injected ${n}`;
/** What a hostile id is: an address that would do something, and a quote to leave the
 *  attribute it is written into. */
const BAD_ID = `../../../me/tokens/revoke-all" formaction="/sign-out`;
/** The hostile text as a page shows it, once escaped. A time is not looked for: a lenient
 *  date parser reads a date out of some of these, and the page then shows that date. */
const shown = (n: number) => `&lt;script&gt;alert(${n})&lt;/script&gt;&quot; onmouseover=&quot;alert(${n})`;

const KEYS: Record<string, { peer: string; role: string }> = {
  "owner-token": { peer: OWNER, role: "owner" },
  "writer-token": { peer: WRITER, role: "writer" },
};

const profile = (role: string) => ({
  name: "crew", space_id: "0199eeee-0000-7000-8000-00000000c0de", title: "Crew", description: "A space.",
  visibility: "private", join_policy: "invite", status: "active", signed_only: false, replaced_by: null, categories: ["general"],
  owner: OWNER, contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-18T09:00:00.000Z",
  access: { role, tags: [], read: true, post: true },
});

const { handleRequest } = await site((call) => {
  const path = call.url.pathname;
  const me = KEYS[(call.headers.get("Authorization") ?? "").replace(/^Bearer /, "")] ?? { peer: "", role: "reader" };
  if (path === "/v1/capabilities") return json(CAPABILITIES);
  if (path === "/v1/conversations") return json({ items: [], unread_conversations: 0, requests_waiting: 0 });
  if (path === "/v1/categories") return json({ categories: [] });
  if (path === "/v1/spaces/crew") return json(profile(me.role));
  if (path === "/v1/spaces/crew/posts") return json({ items: [], next_after: null, has_more: false, head_seq: "0" });
  if (path === "/v1/spaces/crew/checkpoints") return json({ items: [] });
  if (path === "/v1/spaces/crew/invites") {
    return json({
      items: [
        // Every field hostile, the id too, and it still works, so it would carry buttons.
        { invite_id: BAD_ID, kind: X(1), role: X(2), tags: [X(3)], label: X(4), max_uses: X(5), uses: X(6), created_by: X(7), to: X(8), expires_at: X(9), active: true },
        // An offer and a hand-over that no longer work, for why.
        { invite_id: ID(1), kind: "offer", role: X(10), tags: [], label: null, max_uses: 1, uses: 0, created_by: OWNER, to: X(11), expires_at: X(12), active: false, inactive_reason: X(13) },
        { invite_id: ID(2), kind: "hand_over", role: X(14), tags: [], label: null, max_uses: 1, uses: 0, created_by: OWNER, expires_at: null, active: false, inactive_reason: "creator_no_longer_governs" },
      ],
      next_after: BAD_ID, has_more: true,
    });
  }
  if (path === "/v1/spaces/crew/members") {
    return json({
      owner: X(20),
      items: [{ peer_id: X(21), role: X(22), tags: [X(23)], via: X(24), granted_by: X(25), granted_at: X(26), managed_by: X(27), invite_id: X(28) }],
      next_after: X(29), has_more: true,
    });
  }
  if (path === "/v1/spaces/crew/requests") {
    return json({
      items: [
        { request_id: BAD_ID, requester: X(30), message: X(31), state: "pending", created_at: X(32), expires_at: X(33), decided_at: null, decided_by: null, decided_role: null },
        { request_id: ID(3), requester: X(34), message: X(35), state: X(36), created_at: X(37), expires_at: X(38), decided_at: X(39), decided_by: X(40), decided_role: X(41) },
      ],
      next_after: BAD_ID, has_more: true, pending_count: X(42),
    });
  }
  if (path === "/v1/mailbox") {
    return json({
      items: [
        { mailbox_seq: X(50), reason: X(51), offer: { offer_id: BAD_ID, space: "crew", from: OWNER, role: "writer", expires_at: null, state: "waiting" } },
        { mailbox_seq: "2", reason: "hand_over", offer: { offer_id: ID(4), space: X(52), from: X(53), role: X(54), expires_at: X(55), state: "waiting" } },
        { mailbox_seq: "3", reason: "hand_over", offer: { offer_id: ID(5), space: "crew", from: X(56), role: X(57), expires_at: X(58), state: "waiting" } },
        { mailbox_seq: "4", reason: "hand_over", offer: { offer_id: ID(6), space: "crew", from: OWNER, role: X(59), expires_at: null, state: X(60) } },
      ],
      next_after: X(61), has_more: true, head_seq: X(62),
    });
  }
  if (path === "/v1/invites/look") {
    return json({ name: "crew", kind: "invite", role: "writer", tags: [X(70), "builder"], max_uses: 10, uses: 3, expires_at: null, state: X(71), made_by: X(72) });
  }
  return refusal(404, "NOT_ANSWERED");
});

const cookies: Record<string, string> = {};
let address = 150;
for (const [token, { peer }] of Object.entries(KEYS)) {
  cookies[peer] = (await signedIn(peer, token, `192.0.2.${address++}`)).cookie;
}

async function get(as: string, path: string) {
  const res = await handleRequest(new Request(`${SITE}${path}`, { headers: { Cookie: cookies[as]!, "Sec-Fetch-Site": "same-origin" } }), env);
  return { status: res.status, text: await res.text() };
}

/** Every address a form on the page posts to, and every link it offers. */
const addresses = (html: string): string[] => tags(html).flatMap((t) =>
  t.attributes.filter(([n]) => n === "action" || n === "href" || n === "formaction").map(([, v]) => v ?? ""));

/** The page's markup holds, a hostile id reached no address, and the hostile text is on it. */
function holds(text: string, ...reached: number[]): void {
  assert.deepEqual(signedInProblems(text), [], "the service's text became markup");
  assert.ok(!addresses(text).some((a) => a.includes("revoke-all") || a.includes("sign-out") && a !== "/sign-out"), "a hostile id went into an address");
  assert.ok(!/formaction=/.test(text.replace(/&quot; formaction=&quot;/g, "")), "a hostile id left its attribute");
  for (const n of reached) assert.ok(text.includes(shown(n)), `field ${n} did not reach the page`);
}

describe("a hostile service, on the signed-in pages for invite links", () => {
  test("the links page: role, kind, state, keys, id, counts and dates stay text, and an id in no shape gets no button", async () => {
    const { status, text } = await get(OWNER, "/me/spaces/crew/invites");
    assert.equal(status, 200);
    holds(text, 1, 2, 4, 7, 10, 11, 13, 14);
    assert.ok(!text.includes(`/me/invites/${BAD_ID}`) && !text.includes("/me/invites/../"), "a button for an id in no shape");
    // Counts in no shape are said as not known, and the list offers no page past an id in no shape.
    assert.ok(text.includes("? of ?"), "a count in no shape was not said as not known");
    assert.ok(!text.includes("Older links"));
    // A dead hand-over is said in a hand-over's words, whatever role it names.
    assert.ok(text.includes("the role it passes is no longer held as it was"));
  });

  test("the members page: every field of a member stays text, and a member in no shape gets no Set or Remove", async () => {
    const { status, text } = await get(OWNER, "/me/spaces/crew/members");
    assert.equal(status, 200);
    holds(text, 20, 21, 22, 23, 24, 25);
    assert.ok(!tags(text).some((t) => t.name === "input" && t.attributes.some(([n, v]) => n === "name" && v === "peer") &&
      t.attributes.some(([n, v]) => n === "type" && v === "hidden")), "Set or Remove for a member whose key is in no shape");
    assert.ok(text.includes("came in by a link"));
    assert.ok(!text.includes("More members"), "a next page past a cursor in no shape");
  });

  test("the join requests page: every field of a request stays text, and a request in no shape gets no Approve or Decline", async () => {
    const { status, text } = await get(OWNER, "/me/spaces/crew/requests");
    assert.equal(status, 200);
    holds(text, 30, 31, 34, 35, 36, 40, 41);
    assert.ok(!addresses(text).some((a) => a.includes("/me/requests/") && !a.includes(ID(3))), "a button for a request in no shape");
    assert.ok(!text.includes("wait for a decision"), "a count in no shape was said");
    assert.ok(!text.includes("More requests"));
  });

  test("the mailbox: every field of an offer stays text, and an offer in no shape, or of a space in no shape, gets no Accept", async () => {
    const { status, text } = await get(OWNER, "/me/mailbox");
    assert.equal(status, 200);
    holds(text, 50, 51, 53, 54, 56, 57, 59, 62);
    // A space in no shape is named nowhere, not even as text.
    assert.ok(!text.includes("alert(52)"));
    const accepts = addresses(text).filter((a) => a.endsWith("/accept"));
    assert.deepEqual(accepts, [`/me/hand-overs/${ID(5)}/accept`], "Accept on an offer in no shape");
    assert.ok(!text.includes("Later items"), "a next page past a cursor in no shape");
  });

  test("a space's page: offers the service answers in no shape are not shown at all", async () => {
    const { status, text } = await get(WRITER, "/me/spaces/crew");
    assert.equal(status, 200);
    assert.deepEqual(signedInProblems(text), []);
    assert.ok(!text.includes("offered to you"), "an offer in no shape on the space's page");
    assert.ok(!text.includes('<script src="/allow.js"></script>'), "the guard's script with nothing to guard");
  });

  test("a link looked at: the tags, the state and the maker the service names stay text, or are left out", async () => {
    const { status, text } = await get(WRITER, `/me/join/crew/schellingaf_inv_${"0".repeat(32)}`);
    assert.equal(status, 200);
    assert.deepEqual(signedInProblems(text), []);
    assert.ok(text.includes('<span class="tag">builder</span>') && !text.includes("alert(70)"), "a tag in no shape was shown");
    assert.ok(text.includes("The service did not say whether it still works."), "a state in no shape was said as one");
    assert.ok(!text.includes("alert(72)"), "a maker in no shape was shown");
  });
});
