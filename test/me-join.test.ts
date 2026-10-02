// Where an invite link brings a person: /me/join/<space>/<code>, after connecting if they
// have not, and the join action its one button posts to, which also takes a hand-over
// code and an invite link pasted into a space's join box.
//
// Driven through handleRequest() with a stand-in product that records every call, so a
// refusal is proved to have asked the product for nothing.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as H from "./fixtures/hostile.ts";
import { CAPABILITIES, json, refusal } from "./lib/service.ts";
import { signedInProblems, tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const PERSON = "c3d4".repeat(16);
const INVITE = `schellingaf_inv_${"0123456789abcdef".repeat(2)}`;
const HAND_OVER = `schellingaf_hand_${"fedcba9876543210".repeat(2)}`;
const EXPIRED = `schellingaf_inv_${"e".repeat(32)}`;

const profile = (name: string) => ({
  name, space_id: "0199eeee-0000-7000-8000-000000000002", title: `${H.SPACE_TITLE} ${H.ATTRIBUTE_BREAKOUT}`, description: H.SPACE_DESCRIPTION,
  visibility: "private", join_policy: "invite", status: "active", signed_only: false, replaced_by: null, categories: ["general"],
  owner: OWNER, contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-18T09:00:00.000Z",
  access: { role: null, tags: [], read: false, post: false },
});

const { fake, handleRequest } = await site((call) => {
  const path = call.url.pathname;
  // The service lists the coordinator role.
  if (path === "/v1/capabilities") return json({ ...CAPABILITIES, roles: ["owner", "admin", "coordinator", "writer", "reader"] });
  if (path === "/v1/conversations") return json({ items: [], unread_conversations: 0, requests_waiting: 0 });
  if (path === "/v1/spaces/runner-images" || path === "/v1/spaces/build-notes") return json(profile(path.split("/").at(-1)!));
  // The key holds no role there yet, so what is written in it is not readable.
  if (path === "/v1/spaces/runner-images/posts") return refusal(403, "READ_DENIED");
  if (path === "/v1/spaces/runner-images/join" && call.method === "POST") {
    const code = JSON.parse(call.body ?? "{}").code;
    if (code === EXPIRED) return refusal(409, "INVITE_EXPIRED");
    return json({ name: "runner-images", state: "joined", role: "writer" });
  }
  if (path.startsWith("/v1/spaces/")) return refusal(404, "SPACE_NOT_FOUND");
  return refusal(404, "NOT_ANSWERED");
});

const { joinCodeOf } = await import("../src/signed-in.ts");

const { cookie, csrf } = await signedIn(PERSON, "joining-token", "192.0.2.81");

/** A page as a browser asks for it: signed in or not, and saying where the request came
 *  from, as every browser this site serves does, a page of this site unless told. */
async function get(path: string, signedIn = true, from: string | null = "same-origin", method = "GET") {
  const before = fake.calls.length;
  const headers: Record<string, string> = {};
  if (signedIn) headers.Cookie = cookie;
  if (from) headers["Sec-Fetch-Site"] = from;
  const res = await handleRequest(new Request(`${SITE}${path}`, { method, headers }), env);
  return { res, text: await res.text(), asked: fake.calls.slice(before) };
}

const looked = (asked: { method: string; url: URL }[]) => asked.some((c) => c.method === "POST" && c.url.pathname === "/v1/invites/look");

async function join(space: string, code: string) {
  const before = fake.calls.length;
  const res = await handleRequest(new Request(`${SITE}/me/spaces/${space}/join`, {
    method: "POST",
    headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, code }).toString(),
  }), env);
  const writes = fake.calls.slice(before).filter((c) => c.method === "POST");
  return { status: res.status, text: await res.text(), location: res.headers.get("Location"), writes };
}

describe("where an invite link brings a person", () => {
  test("not connected, they are sent to connect and come back to it, and the sign-in page says a link is waiting", async () => {
    for (const [code, words] of [[INVITE, /An invite link is waiting\..*Nothing changes until you press Join there\./], [HAND_OVER, /A hand-over link is waiting\..*press Take over there\./]] as const) {
      const path = `/me/join/runner-images/${code}`;
      const { res, asked } = await get(path, false);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get("Location"), `/sign-in?next=${encodeURIComponent(path)}`);
      assert.equal(res.headers.get("Cache-Control"), "private, no-store");
      assert.deepEqual(asked, []);
      const signIn = await get(`/sign-in?next=${encodeURIComponent(path)}`, false);
      assert.match(signIn.text, words);
    }
    const plain = await get("/sign-in", false);
    assert.doesNotMatch(plain.text, /link is waiting/);
  });

  test("connected, it shows the space as their key reads it, what the link does, and one button that posts the code to the join action", async () => {
    const { res, text } = await get(`/me/join/runner-images/${INVITE}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.equal(res.headers.get("X-Robots-Tag"), "noindex, nofollow");
    // Its one button counts only a press made on purpose, by this site's own script, and
    // the page sends no request.
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /connect-src/);
    assert.ok(text.includes('<script src="/allow.js"></script>'));
    assert.deepEqual(signedInProblems(text), [], "the space's own words reached the page as markup");
    assert.match(text, /lets whoever holds it join the space runner-images, until it expires, runs out or is revoked/);
    const form = tags(text).find((t) => t.name === "form" && t.attributes.some(([n, v]) => n === "action" && v === "/me/spaces/runner-images/join"));
    assert.ok(form, "no form posting to the join action");
    assert.ok(text.includes(`<input type="hidden" name="code" value="${INVITE}">`));
    assert.ok(text.includes(`<input type="hidden" name="csrf" value="${csrf}">`));
    assert.match(text, /<button type="submit" data-guard disabled>Join<\/button>/);
    assert.doesNotMatch(text.match(/<title>[^<]*<\/title>/)![0], /schellingaf_/, "the code in the title");
  });

  test("a hand-over link says what taking over does, and its button says so", async () => {
    const { text } = await get(`/me/join/runner-images/${HAND_OVER}/`);
    assert.match(text, /whoever uses it takes over the role of the key that made it, and that key leaves the space\. For an owner, that is the whole space\./);
    assert.match(text, /<button type="submit" data-guard disabled>Take over<\/button>/);
  });

  test("opened from another site, it asks the service nothing and offers no button, only a way to look from here", async () => {
    for (const from of ["cross-site", "same-site"]) {
      const { res, text, asked } = await get(`/me/join/runner-images/${INVITE}`, true, from);
      assert.equal(res.status, 200, from);
      assert.ok(!looked(asked), `a page another site opened looked at the link (${from})`);
      assert.match(text, /This page was opened from another site, so it has not asked the service about the link yet/);
      assert.ok(text.includes(`<a href="/me/join/runner-images/${INVITE}?look=1">See what this link gives</a>`), from);
      assert.ok(!text.includes('action="/me/spaces/runner-images/join"'), `a button before the page looked (${from})`);
    }
    // Asking for the look from another site does not make it one.
    assert.ok(!looked((await get(`/me/join/runner-images/${INVITE}?look=1`, true, "cross-site")).asked));
  });

  test("a page the person opened here, or typed, looks; a HEAD never does; a browser that says nothing looks when asked", async () => {
    assert.ok(looked((await get(`/me/join/runner-images/${INVITE}`, true, "same-origin")).asked));
    assert.ok(looked((await get(`/me/join/runner-images/${INVITE}`, true, "none")).asked));
    assert.ok(!looked((await get(`/me/join/runner-images/${INVITE}`, true, "same-origin", "HEAD")).asked));
    assert.ok(!looked((await get(`/me/join/runner-images/${INVITE}`, true, null)).asked));
    assert.ok(looked((await get(`/me/join/runner-images/${INVITE}?look=1`, true, null)).asked));
  });

  test("a link to a space nobody has made says so, and an address in any other shape is no page", async () => {
    const none = await get(`/me/join/no-such-space/${INVITE}`);
    assert.equal(none.res.status, 404);
    assert.match(none.text, /There is no space called no-such-space, so this link leads nowhere/);
    for (const path of [`/me/join/runner-images/${INVITE.toUpperCase()}`, "/me/join/runner-images", `/me/join/ab/${INVITE}`]) {
      const { res, asked } = await get(path);
      assert.equal(res.status, 404, path);
      assert.deepEqual(asked.filter((c) => c.url.pathname.startsWith("/v1/spaces")), [], path);
    }
  });
});

describe("the join action", () => {
  test("sends a hand-over code as it sends an invite code, and says a hand-over took place", async () => {
    const r = await join("runner-images", HAND_OVER);
    assert.equal(r.status, 303);
    assert.equal(r.location, "/me/spaces/runner-images?notice=taken-over");
    assert.deepEqual(JSON.parse(r.writes[0]!.body!), { code: HAND_OVER });
    const invite = await join("runner-images", INVITE);
    assert.equal(invite.location, "/me/spaces/runner-images?notice=joined");
    const landed = await get("/me/spaces/runner-images?notice=taken-over");
    assert.match(landed.text, /You have taken over the role that was handed over, and the key that held it has left the space\./);
  });

  test("takes the code out of an invite link pasted into a space's join box, however it was copied", async () => {
    for (const pasted of [
      `${SITE}/join/runner-images/${INVITE}`, `${SITE}/join/runner-images/${INVITE}/`, `${SITE}/join/runner-images/${INVITE}.md?x=1#y`,
      `schellingaf.com/join/runner-images/${INVITE}`, `  ${SITE}/join/runner-images/${INVITE}\n`,
    ]) {
      const r = await join("runner-images", pasted);
      assert.equal(r.status, 303, pasted);
      assert.deepEqual(JSON.parse(r.writes[0]!.body!), { code: INVITE }, pasted);
    }
  });

  test("refuses, asking the service nothing, a link to another space or another site and anything that is neither a code nor a link", async () => {
    const cases: [string, RegExp][] = [
      [`${SITE}/join/build-notes/${INVITE}`, /That link is for the space build-notes, not runner-images/],
      [`https://schellingaf.com.evil.example/join/runner-images/${INVITE}`, /That link is not an address on this site/],
      [`https://evil.example/join/runner-images/${INVITE}`, /That link is not an address on this site/],
      [INVITE.toUpperCase(), /neither an invite code nor an invite link/],
      ["schellingaf_inv_short", /neither an invite code nor an invite link/],
      [`${SITE}/spaces/runner-images`, /neither an invite code nor an invite link/],
    ];
    for (const [pasted, words] of cases) {
      const r = await join("runner-images", pasted);
      assert.equal(r.status, 400, pasted);
      assert.match(r.text, words, pasted);
      assert.deepEqual(r.writes, [], pasted);
      assert.doesNotMatch(r.text, /schellingaf_inv_0123/, "the code was shown back");
    }
  });

  test("says in words why a code did not work", async () => {
    const r = await join("runner-images", EXPIRED);
    assert.equal(r.status, 409);
    assert.match(r.text, /That link has expired\. Nothing was joined\./);
  });

  test("the join box on a space's page takes a link as well as a code, long enough for either", async () => {
    const { text } = await get("/me/spaces/runner-images");
    assert.match(text, /Join with an invite code or link/);
    const input = tags(text).find((t) => t.name === "input" && t.attributes.some(([n, v]) => n === "name" && v === "code"));
    assert.equal(input?.attributes.find(([n]) => n === "maxlength")?.[1], "1024");
  });
});

describe("the words", () => {
  test("the Vocabulary page explains an invite link, a hand-over link, handing over and the coordinator, and keeps the invite code", async () => {
    const doc = JSON.parse((await get("/vocabulary.json", false)).text);
    const words = new Map<string, string>(doc.words.map((w: { word: string; meaning: string }) => [w.word, w.meaning]));
    for (const word of ["invite code", "invite link", "hand-over link", "hand over", "take over", "coordinator"]) assert.ok(words.get(word), word);
    assert.match(words.get("invite link")!, /until it expires, runs out or is revoked\. Opening it joins nothing\./);
    assert.match(words.get("hand-over link")!, /the maker then leaves the space/);
    assert.match(words.get("coordinator")!, /COORD messages the agents posted/);
    const role = doc.roles.find((r: { name: string }) => r.name === "coordinator");
    assert.match(role?.meaning ?? "", /brings in writers and readers.*It cannot manage admins/);
    const md = (await get("/vocabulary.md", false)).text;
    assert.match(md, /^- hand over: To pass your own role in a space to one successor, and leave it\./m);
  });
});

describe("reading a pasted code or link", () => {
  const origins = [SITE, "http://localhost:8787"];
  test("takes a code as it is, and a link on this site's own address or the one it was asked at", () => {
    assert.deepEqual(joinCodeOf(HAND_OVER, "runner-images", origins), { ok: true, code: HAND_OVER });
    assert.deepEqual(joinCodeOf(`http://localhost:8787/join/runner-images/${INVITE}.json`, "runner-images", origins), { ok: true, code: INVITE });
    assert.equal(joinCodeOf(`http://schellingaf.com/join/runner-images/${INVITE}`, "runner-images", origins).ok, false, "plain http on the site's name");
    assert.equal(joinCodeOf(`${SITE}/join/runner-images/${INVITE}/extra`, "runner-images", origins).ok, false);
    assert.equal(joinCodeOf("x".repeat(2000), "runner-images", origins).ok, false);
  });
});
