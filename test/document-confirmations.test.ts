// A work space whose document is accepted by writers' confirmations: a version accepted that
// way is never worded as one key's approval, a waiting version says how many confirmations it
// has, the page says how many the space asks for, and a writer who may confirm is offered the
// form, and nobody else is.
//
// Driven through handleRequest() against the stand-in service.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, CATEGORIES, json, refusal, service, type Json, type World } from "./lib/service.ts";
import { htmlProblems, markdownProblems, tags } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const AP = await import("../content/api-overview.mjs");

const OWNER = "a1b2".repeat(16);
const ALICE = "c3d4".repeat(16);
const BOB = "e5f6".repeat(16);
const WRITER = "0a1b".repeat(16);
const SPACE_ID = "0199e0e0-0000-7000-8000-00000000bbbb";
const id = (n: number) => `0199e2e2-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = (n: number) => `2026-10-04T10:0${n}:00.000Z`;

const ACCESS = {
  writer: { role: "writer", tags: [], read: true, post: true, decide: false },
  reader: { role: "reader", tags: [], read: true, post: false, decide: false },
  coordinator: { role: "coordinator", tags: [], read: true, post: true, decide: true },
};
const space = (name: string, fields: Json = {}): Json => ({
  name, space_id: SPACE_ID, title: `The ${name}`, description: "A work space with a document.", visibility: "public", join_policy: "request",
  status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: OWNER,
  contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-10-04T09:00:00.000Z", access: ACCESS.writer,
  document: { version: { post_id: id(3), seq: "3" }, pending: 1 }, document_confirmations: 2, ...fields,
});
const post = (n: number, name: string, fields: Json): Json => ({
  post_id: id(n), space: name, seq: String(n), author: ALICE, posted_at: at(n), title: null, to: [], reply_to: null,
  supersedes: null, retracts: null, fingerprints: [], signed: false, space_id: SPACE_ID, ...fields,
});
const version = (n: number, state: string, fields: Json = {}): Json => ({
  post_id: id(n), seq: String(n), author: ALICE, posted_at: at(n), summary: null, signed: false, state, edits: null,
  same_text_as: null, decision: null, ...fields,
});

const waits = (given: string[]): Json => ({
  decision: ["owner", "admin", "coordinator"], confirmations: { given, required: 2 },
});
/** Version 1 accepted by two confirmations, version 3 waiting with the given confirmations. */
const posts = (name: string): Json[] => [
  post(1, name, { kind: "version", author: OWNER, title: "First", body: "Lead.\n\nOne." }),
  post(2, name, { kind: "go", author: BOB, body: "ok", reply_to: id(1) }),
  post(3, name, { kind: "version", title: "More", body: "Lead.\n\nOne. Two.", supersedes: id(1) }),
];
const versions = (given: string[], extra: Json = {}): Json[] => [
  version(1, "current", {
    author: OWNER, summary: "First",
    decision: { post_id: id(2), seq: "2", kind: "go", author: BOB, reason: "ok", at: at(2), by: "confirmations", confirmed_by: [ALICE, BOB] },
  }),
  version(3, "pending", { summary: "More", edits: "1", waits_for: waits(given), ...extra }),
];

const world: World = {
  capabilities: CAPABILITIES, categories: CATEGORIES,
  spaces: [
    space("conf-notes"),
    space("author-notes", { access: { ...ACCESS.writer } }),
    space("given-notes"),
    space("coord-notes", { access: ACCESS.coordinator }),
    space("reader-notes", { access: ACCESS.reader }),
    space("off-notes", { document_confirmations: 0 }),
  ],
  posts: {
    "conf-notes": posts("conf-notes"), "author-notes": posts("author-notes"), "given-notes": posts("given-notes"),
    "coord-notes": posts("coord-notes"), "reader-notes": posts("reader-notes"), "off-notes": posts("off-notes"),
  },
  versions: {
    "conf-notes": versions([BOB]),
    // The waiting version is the viewer's own.
    "author-notes": versions([BOB], { author: WRITER }),
    "given-notes": versions([WRITER, BOB]),
    "coord-notes": versions([BOB]),
    "reader-notes": versions([BOB]),
    "off-notes": versions([]).map((v) => ({ ...v, waits_for: undefined })),
  },
  documentFields: {},
  findings: {}, tasks: {}, proofs: {}, checkpoints: {}, peers: {},
};
const base = service(world);
/** What the next post to conf-notes answers: null passes it to the stand-in. */
let NEXT_POST: Response | null = null;
const { fake, handleRequest } = await site(async (call) => {
  if (call.method === "POST" && call.url.pathname === "/v1/spaces/conf-notes/posts" && NEXT_POST) return NEXT_POST;
  if (call.url.pathname === "/v1/mailbox") return json({ items: [], next_after: null, has_more: false, head_seq: "0" });
  return base(call);
});
const { confirmationsOf } = await import("../src/render.ts");
const { readableVersion } = await import("../src/oracle-render.ts");
const { cookie, csrf } = await signedIn(WRITER, "doc-confirmations-token", "192.0.2.94");

async function get(path: string, withCookie = false) {
  const res = await handleRequest(new Request(`${SITE}${path}`, withCookie ? { headers: { Cookie: cookie } } : {}), { ...env, SITE_TOKEN: "site-token-for-tests" });
  const out = { status: res.status, text: await res.text() };
  return out;
}
const confirmForms = (html: string) =>
  [...html.matchAll(/<form [^>]*>[\s\S]*?<\/form>/g)].map((m) => m[0]).filter((f) => /<button[^>]*>Confirm this version/.test(f));
const attr = (t: { attributes: [string, string | null][] } | undefined, name: string) => t?.attributes.find(([n]) => n === name)?.[1];

describe("a version writers' confirmations accepted", () => {
  test("is never worded as one key's approval, in HTML, markdown and JSON", async () => {
    const html = await get("/spaces/conf-notes/history");
    assert.equal(html.status, 200, html.text.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<link[^>]*>/g, "").slice(0, 1200));
    assert.deepEqual(htmlProblems(html.text), []);
    assert.match(html.text, /Accepted by 2 confirmations, the last in <a [^>]*>#2<\/a>:/);
    assert.doesNotMatch(html.text, /Approved in/);
    const md = await get("/spaces/conf-notes/history.md");
    assert.deepEqual(markdownProblems(md.text), []);
    assert.match(md.text, /- approved: Accepted by 2 confirmations, the last in #2: /);
    const j = JSON.parse((await get("/spaces/conf-notes/history.json")).text);
    const first = JSON.stringify(j);
    assert.ok(first.includes('"by":"confirmations"') && first.includes(`"confirmed_by":["${ALICE}","${BOB}"]`), first.slice(0, 600));
  });

  test("shows on the document, and on its own page, as accepted by confirmations", async () => {
    const page = (await get("/spaces/conf-notes")).text;
    assert.match(page, /Accepted by 2 confirmations, the last in/);
    assert.doesNotMatch(page, /Approved in/);
    const own = (await get("/spaces/conf-notes/1")).text;
    assert.match(own, /It was accepted by 2 confirmations, the last in/);
    assert.match((await get("/spaces/conf-notes/1.md")).text, /It was accepted by 2 confirmations, the last in #2:/);
    assert.match((await get("/spaces/conf-notes.md")).text, /- approved: Accepted by 2 confirmations, the last in #2:/);
  });

  test("ids that are not keys are not shown", () => {
    const v = readableVersion(version(1, "current", { decision: { post_id: id(2), seq: "2", kind: "go", author: BOB, by: "confirmations", confirmed_by: ["<script>", BOB, 7] } }));
    assert.deepEqual(v?.decision?.confirmedBy, [BOB]);
    const other = readableVersion(version(1, "current", { decision: { post_id: id(2), seq: "2", kind: "go", author: BOB, by: "something-else", confirmed_by: [BOB] } }));
    assert.equal(other?.decision?.byConfirmations, false);
  });
});

describe("a waiting version", () => {
  test("says how many confirmations it has, in the history and on its own page", async () => {
    const history = (await get("/spaces/conf-notes/history")).text;
    assert.match(history, /1 of 2 confirmations by writers/);
    assert.match((await get("/spaces/conf-notes/history.md")).text, /- waiting: 1 of 2 confirmations by writers/);
    assert.match((await get("/spaces/conf-notes/3")).text, /It has 1 of 2 confirmations by writers\./);
    assert.match((await get("/spaces/conf-notes/3.md")).text, /It has 1 of 2 confirmations by writers\./);
    assert.deepEqual(JSON.parse((await get("/spaces/conf-notes/3.json")).text).version?.waits_for ?? JSON.parse((await get("/spaces/conf-notes/3.json")).text).waits_for ?? null, { decision: ["owner", "admin", "coordinator"], confirmations: { given: [BOB], required: 2 } });
  });

  test("says nothing of confirmations where the space counts none", async () => {
    assert.doesNotMatch((await get("/spaces/off-notes/history")).text, /confirmations by writers/);
  });

  test("a service that sends a count out of range is not believed", () => {
    for (const required of [0, 6, "2", null]) {
      assert.equal(readableVersion(version(3, "pending", { waits_for: { confirmations: { given: [], required } } }))?.confirmations, null, String(required));
    }
    assert.equal(confirmationsOf({ document_confirmations: 7 }), 0);
    assert.equal(confirmationsOf({ document_confirmations: 3 }), 3);
  });
});

describe("the sentence on who decides", () => {
  test("names the number of confirmations where the space sets one, and only there", async () => {
    assert.match((await get("/spaces/conf-notes")).text, /A version is also accepted when 2 writers confirm it\./);
    assert.doesNotMatch((await get("/spaces/off-notes")).text, /A version is also accepted when/);
  });

  test("the API page says a set number of writers may accept a version", () => {
    const section = JSON.stringify(AP);
    assert.ok(section.includes("Its owner or an admin may let a set number of writers, 1 to 5, accept a version as well."));
  });
});

describe("the confirm form", () => {
  test("is offered to a writer who may confirm, on the history and on the version's page", async () => {
    for (const path of ["/me/spaces/conf-notes/history", "/me/spaces/conf-notes/3"]) {
      const forms = confirmForms((await get(path, true)).text);
      assert.equal(forms.length, 1, path);
      const f = forms[0]!;
      assert.equal(attr(tags(f).find((t) => t.name === "input" && attr(t, "name") === "kind"), "value"), "go");
      assert.equal(attr(tags(f).find((t) => t.name === "input" && attr(t, "name") === "reply_to"), "value"), id(3));
      assert.ok(tags(f).some((t) => t.name === "input" && attr(t, "name") === "body"), "a reason field");
      assert.doesNotMatch(f, /Approve|Decline/);
    }
  });

  test("the reply form on a version still leaves out go and veto", async () => {
    const values = tags((await get("/me/spaces/conf-notes/3", true)).text).filter((t) => t.name === "option").map((t) => attr(t, "value"));
    assert.ok(!values.includes("go") && !values.includes("veto"));
  });

  test("is not offered to the author, a key already counted, a decider, a reader, or where the space counts none", async () => {
    for (const name of ["author-notes", "given-notes", "coord-notes", "reader-notes", "off-notes"]) {
      for (const path of [`/me/spaces/${name}/history`, `/me/spaces/${name}/3`]) {
        assert.deepEqual(confirmForms((await get(path, true)).text), [], path);
      }
    }
  });

  test("is not offered to a visitor who is not signed in", async () => {
    for (const path of ["/spaces/conf-notes/history", "/spaces/conf-notes/3"]) {
      assert.deepEqual(confirmForms((await get(path)).text), [], path);
    }
  });

  test("a decider keeps Approve and Decline, and no confirm form", async () => {
    const t = (await get("/me/spaces/coord-notes/history", true)).text;
    assert.match(t, /<button[^>]*>Approve/);
    assert.deepEqual(confirmForms(t), []);
    assert.match(t, /Your reason is a post in this space, beside the proposal: whoever reads the space reads it\./);
  });

  test("the propose form says where the space counts confirmations", async () => {
    const t = (await get("/me/spaces/conf-notes", true)).text;
    assert.match(t, /Where the space counts confirmations, enough writers confirming it accept it too\./);
  });
});

describe("the refusals of a confirmation", () => {
  test("are said in words, not as a code", async () => {
    const { refusalText } = await import("../src/signed-in.ts");
    assert.match(refusalText({ code: "PROPOSAL_SELF_CONFIRM" } as never), /wrote this proposal, so it cannot confirm it/);
    assert.match(refusalText({ code: "PROPOSAL_ALREADY_CONFIRMED" } as never), /confirmed this proposal already/);
    assert.doesNotMatch(refusalText({ code: "CONTROL_DENIED", detail: OWNER } as never), new RegExp(OWNER), "no other refusal of control carries an id");
  });

  async function confirm(fields: Record<string, string> = {}) {
    const res = await handleRequest(new Request(`${SITE}/me/spaces/conf-notes/posts`, {
      method: "POST",
      headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, kind: "go", reply_to: id(3), body: "Checked.", then: "history", idempotency_key: "d".repeat(32), ...fields }).toString(),
    }), env);
    return { status: res.status, text: await res.text(), location: res.headers.get("Location") };
  }

  test("a refused confirm says what the service says, in a work space", async () => {
    const detail = "a go on a version counts from a writer, and decides from the owner, an admin or a coordinator: GET /v1/spaces/conf-notes/document names them";
    NEXT_POST = refusal(403, "CONTROL_DENIED", "CONTROL_DENIED", detail);
    try {
      const out = await confirm();
      assert.equal(out.status, 403);
      assert.match(out.text, /does not decide a version here, so nothing was posted/);
      assert.match(out.text, /decides from the owner, an admin or a coordinator/);
      assert.doesNotMatch(out.text, /service&#39;s reviewer/, "no reviewer in a work space");
    } finally {
      NEXT_POST = null;
    }
  });

  test("a refused confirm shows no bare key id", async () => {
    NEXT_POST = refusal(403, "CONTROL_DENIED", "CONTROL_DENIED", OWNER);
    try {
      const out = await confirm();
      assert.equal(out.status, 403);
      assert.doesNotMatch(out.text, new RegExp(OWNER));
    } finally {
      NEXT_POST = null;
    }
  });

  test("the confirmation that decides says the version is accepted; one that does not says it was counted", async () => {
    try {
      NEXT_POST = json({ post_id: id(9), seq: "9", oracle: { decided: "approved", version: id(3), by: "confirmations", confirmations: { given: [BOB, WRITER], required: 2 } } }, 201);
      assert.match(new URL((await confirm()).location ?? "", SITE).search, /notice=proposal-accepted/);
      NEXT_POST = json({ post_id: id(9), seq: "9", oracle: { confirmed: id(3), confirmations: { given: [WRITER], required: 2 } } }, 201);
      assert.match(new URL((await confirm()).location ?? "", SITE).search, /notice=confirmation-counted/);
    } finally {
      NEXT_POST = null;
    }
  });

  test("the forms do not say the reason is public or kept for good", async () => {
    const t = (await get("/me/spaces/conf-notes/history", true)).text;
    assert.match(t, /whoever reads the space reads it/);
    assert.doesNotMatch(t, /Your reason is public|for good/);
  });

  test("a writer who may not post is offered no confirm form", async () => {
    const { mayConfirm } = await import("../src/me-render.ts");
    const v = { state: "pending", author: ALICE, confirmations: { given: [], required: 2 } };
    assert.equal(mayConfirm({ access: { role: "writer", post: true, decide: false } }, WRITER, v), true);
    assert.equal(mayConfirm({ access: { role: "writer", post: false, decide: false } }, WRITER, v), false);
    assert.equal(mayConfirm({ access: { role: "writer", decide: false } }, WRITER, v), false);
  });
});
