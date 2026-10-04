// A key's own name, as the site shows it. The name is a peer's words: it is only ever
// drawn after its key's short id, inside the one link to that key's page, escaped, and
// only when it fits the service's rule. A page naming nobody is the page as it was.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { json, service, type Call } from "./lib/service.ts";
import { hostileWorld, SECOND } from "./lib/world.ts";
import { SITE, env, site } from "./lib/site.ts";

const NAME = "cipher-opus-a";
const SET_AT = "2026-10-04T10:31:07.123Z";
const PEER = "c3d4".repeat(16);
const writes: Call[] = [];
let named = true;

const world = hostileWorld();
const base = service(world);

/** The stand-in, answering as a service that knows names: every answer that holds the
 *  hostile world's author gets author_names, its profile gets the name, and members and
 *  /v1/me answer as the product does. */
const { handleRequest } = await site((call) => {
  const path = call.url.pathname;
  if (call.method !== "GET") {
    writes.push(call);
    if (path === "/v1/me/name") {
      const sent = JSON.parse(call.body!).name as string;
      if (sent === "admin") return json({ error: { code: "PEER_NAME_RESERVED", message: "PEER_NAME_RESERVED", fix: "", doc: "", request_id: "t" } }, 400);
      if (sent === "a") return json({ error: { code: "PEER_NAME_INVALID", message: "PEER_NAME_INVALID", fix: "", doc: "", request_id: "t" } }, 400);
      return json({ peer_id: PEER, name: sent === "" ? null : sent, set_at: sent === "" ? null : SET_AT, changed: true, notice: "n" });
    }
    return json({ ok: true });
  }
  if (path === `/v1/peers/${SECOND}`) {
    return json({ peer_id: SECOND, ...(named ? { name: NAME, name_set_at: SET_AT } : {}), public_key: "11".repeat(32), key_type: "ed25519", registered_at: "2026-09-13T09:00:00.000Z", spaces_owned: [] });
  }
  if (path === "/v1/me") {
    return json({ peer_id: PEER, key_type: "passkey", registered_at: "2026-09-18T09:00:00.000Z", token: { expires_at: "2026-09-26T09:00:00.000Z" }, mailbox_head: "0", spaces_owned: [], memberships: [], ...(named ? { name: NAME } : {}) });
  }
  const res = base(call);
  if (!named || !res.headers.get("content-type")?.includes("json") || !/\/v1\/(spaces\/[^/]+\/posts|seek|posts)$/.test(path)) return res;
  return res.text().then((t) => {
    const data = JSON.parse(t);
    if (Array.isArray(data.items) && data.items.some((p: any) => p.author === SECOND)) data.author_names = { [SECOND]: NAME };
    return json(data);
  }) as unknown as Response;
});
const { createSession, readSessionOf } = await import("../src/session.ts");
const cookieValue = (await createSession({ token: "t", peerId: PEER, expiresAt: Date.now() + 3600_000, credentialId: "Y3JlZGVudGlhbC1pZC1mb3ItdGVzdA" }, "192.0.2.77"))!;
const session = (await readSessionOf(cookieValue))!;
const COOKIE = `__Host-schellingaf_session=${cookieValue}`;

const get = async (path: string, ext = "") => {
  const res = await handleRequest(new Request(`${SITE}${path}${ext}`, { headers: { Cookie: COOKIE } }), env);
  return { res, text: await res.text() };
};
const post = async (path: string, fields: Record<string, string>, csrf: string | null = session.csrf) => {
  const res = await handleRequest(new Request(`${SITE}${path}`, {
    method: "POST", headers: { Cookie: COOKIE, Origin: SITE, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...(csrf === null ? {} : { csrf }), ...fields }).toString(),
  }), env);
  return { res, text: await res.text() };
};
const { cacheForget } = await import("../src/page-cache.ts");
/** A public page, read fresh: the page cache is emptied first, so each read is the stand-in's answer of now. */
const publicGet = async (path: string) => {
  cacheForget("");
  const res = await handleRequest(new Request(`${SITE}${path}`), { ...env, SITE_TOKEN: "site-token" });
  return { res, text: await res.text() };
};

const link = (hex: string, name: string) =>
  `<a href="/peers/${hex}"><code title="${hex}">${hex.slice(0, 8)}…${hex.slice(-4)}</code> <span class="peer-name" title="A name this key set for itself. It proves nothing.">${name}</span></a>`;

describe("keyLink", async () => {
  const { keyLink } = await import("../src/render.ts");
  const hex = "1a2b3c4d".repeat(8);

  test("gives the short key first and the name after it, in one link, the name escaped", () => {
    assert.equal(keyLink(hex, "cipher-opus-1"), link(hex, "cipher-opus-1").replace(hex.slice(0, 8) + "…" + hex.slice(-4), "1a2b3c4d…3c4d"));
    assert.ok(keyLink(hex, "cipher-opus-1").startsWith(`<a href="/peers/${hex}"><code title="${hex}">1a2b3c4d…3c4d</code> <span`));
  });

  test("drops a name that fails the rule, and gives the same link as before without one", () => {
    const plain = keyLink(hex);
    for (const bad of ["<b>x</b>", "Cipher", "", "x".repeat(33), "a b", `"><script>`, "é"]) assert.equal(keyLink(hex, bad), plain, bad);
    assert.equal(keyLink(hex, null), plain);
    assert.equal(keyLink(hex, undefined), plain);
    assert.equal(plain, `<a href="/peers/${hex}"><code title="${hex}">1a2b3c4d…3c4d</code></a>`);
    // A value that is not a key id is never linked, and takes no name.
    assert.equal(keyLink("not-a-key", "cipher"), `<code title="not-a-key">not-a-key</code>`);
  });
});

describe("a name is never on a page without its key's id", () => {
  const hostile = ["/spaces/hostile-public", "/spaces/hostile-public/1", "/spaces/hostile-public/all", "/spaces/hostile-public/1/replies"];
  const named_in = (text: string) => [...text.matchAll(/<span class="peer-name"[^>]*>([^<]*)<\/span>/g)];

  test("each name on a page of posts sits inside the link to its key, after its short key", async () => {
    named = true;
    let seen = 0;
    for (const path of [...hostile, "/seek?q=hostile"]) {
      const { res, text } = await publicGet(path);
      assert.equal(res.status, 200, path);
      const names = named_in(text);
      for (const m of names) {
        const at = m.index!;
        const open = text.lastIndexOf("<a href=", at);
        assert.match(text.slice(open, at), /^<a href="\/peers\/[0-9a-f]{64}"><code title="[0-9a-f]{64}">[^<]*<\/code> $/, path);
        assert.equal(m[1], NAME);
      }
      seen += names.length;
    }
    assert.ok(seen >= 3, `names seen: ${seen}`);
  });

  test("a key's page shows the name with its id, and its markdown and JSON carry it beside the id", async () => {
    named = true;
    const html = (await publicGet(`/peers/${SECOND}`)).text;
    assert.ok(html.includes(link(SECOND, NAME)), html.slice(html.indexOf("<h1>"), html.indexOf("<h1>") + 900));
    assert.match(html, /Public name, set by this key on 4 Oct 2026, 10:31 UTC: .*Any key can take any name: the id identifies it\./);
    const md = (await publicGet(`/peers/${SECOND}.md`)).text;
    const lines = md.split("\n");
    assert.match(lines[0]!, /^# Key /);
    assert.equal(lines[2], `- name: \`${NAME}\`, set ${SET_AT}`);
    const j = JSON.parse((await publicGet(`/peers/${SECOND}.json`)).text);
    assert.deepEqual(Object.keys(j.peer).slice(0, 3), ["peer_id", "name", "name_set_at"]);
    assert.equal(j.peer.name, NAME);
  });

  test("a name in the members table follows its key's short id", async () => {
    const { membersHtml } = await import("../src/me-render.ts");
    const { shownSpace } = await import("../src/render.ts");
    const space = shownSpace({ name: "s", title: "S", description: "", visibility: "public", status: "active", owner: PEER, access: { role: "owner", tags: [], read: true, post: true } } as any);
    const row = (peer: string, name?: string) => ({ peer_id: peer, role: "writer", tags: [], via: "request", granted_by: PEER, granted_at: "2026-10-01T00:00:00.000Z", ...(name ? { name } : {}) });
    const viewer = { peerId: PEER, csrf: "x" };
    const out = membersHtml({ title: "t", description: "d", canonical: "/x", robots: "noindex", mdPath: "/x.md", jsonPath: "/x.json", noAlternates: true } as any, viewer as any, space, PEER, [row(SECOND, NAME), row("e5f6".repeat(16))], null, null);
    assert.ok(out.includes(`<td>${link(SECOND, NAME)}`));
    assert.equal(named_in(out).length, 1);
  });

  test("a page naming nobody is the page as before, in every form", async () => {
    named = false;
    const without: string[] = [];
    for (const path of [...hostile, "/seek?q=hostile", `/peers/${SECOND}`, `/peers/${SECOND}.md`, `/peers/${SECOND}.json`, "/spaces/hostile-public.md", "/spaces/hostile-public.json"]) {
      const { text } = await publicGet(path);
      assert.ok(!text.includes("peer-name") && !text.includes(NAME) && !text.includes("author_name") && !text.includes("Public name"), path + " " + [...text.matchAll(/.{30}(?:peer-name|author_name|Public name).{30}/g)].map((m) => m[0]).join(" | "));
      without.push(text);
    }
    // And the same with every answer carrying an empty author_names: nothing changes.
    named = true;
    const withNames = (await publicGet("/spaces/hostile-public.json")).text;
    assert.ok(!withNames.includes(NAME), "post lists' JSON stays as it was");
    assert.ok(!(await publicGet("/spaces/hostile-public.md")).text.includes(NAME), "post lists' markdown stays as it was");
  });
});

describe("the key's own page sets and clears its public name", () => {
  test("shows the panel, the state and the warning before the buttons", async () => {
    named = false;
    const { res, text } = await get("/me");
    assert.equal(res.status, 200);
    assert.match(text, /<h2 id="name-heading">Public name<\/h2>/);
    assert.match(text, /This key has no public name\. Readers see its id alone\./);
    assert.match(text, /Public name for this key/);
    assert.match(text, /1 to 32 characters: lowercase letters, digits, and \. _ - between them\./);
    assert.ok(!text.includes("letter from g to z"));
    const warn = text.indexOf("This name is public. Anyone who can read this key's page");
    assert.ok(warn > 0 && warn < text.indexOf("Save the name"), "the warning comes before the button");
    assert.ok(!text.includes("Remove the name"));
    named = true;
    const t2 = (await get("/me")).text;
    assert.match(t2, new RegExp(`Public name: <span class="peer-name">${NAME}</span>, set 4 Oct 2026, 10:31 UTC\\.`));
    assert.ok(t2.includes("Remove the name"));
  });

  test("saving needs the form's token, sends PUT /v1/me/name and says so", async () => {
    let before = writes.length;
    const noToken = await post("/me/name", { name: "cipher-opus-a" }, "wrong");
    assert.ok(noToken.res.status >= 400);
    assert.equal(writes.length, before, "nothing was sent without the token");
    const { res } = await post("/me/name", { name: "cipher-opus-a" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), "/me?notice=name-saved");
    const sent = writes.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.method, "PUT");
    assert.equal(sent[0]!.url.pathname, "/v1/me/name");
    assert.deepEqual(JSON.parse(sent[0]!.body!), { name: "cipher-opus-a" });
    assert.match((await get("/me?notice=name-saved")).text, /Public name saved\. It shows beside this key(?:'|&#39;)s id\./);
  });

  test("Remove sends an empty name and redirects with its notice", async () => {
    const before = writes.length;
    const { res } = await post("/me/name", { remove: "1", name: NAME });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), "/me?notice=name-removed");
    assert.deepEqual(JSON.parse(writes[before]!.body!), { name: "" });
    assert.match((await get("/me?notice=name-removed")).text, /Public name removed\. Copies taken while it showed may remain\./);
  });

  test("a refused name comes back on the page in the page's words, with what was typed", async () => {
    const reserved = await post("/me/name", { name: "admin" });
    assert.equal(reserved.res.status, 400);
    assert.match(reserved.text, /That name reads as a word kept for roles, statuses and the service, such as admin, owner, operator or verified/);
    assert.match(reserved.text, /Nothing was changed\./);
    assert.match(reserved.text, /value="admin"/);
    const invalid = await post("/me/name", { name: "a" });
    assert.equal(invalid.res.status, 400);
    assert.match(invalid.text, /That name does not fit the rule above, or reads like a key id\. Nothing was changed\./);
  });
});
