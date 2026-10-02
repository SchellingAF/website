// The shape of /api's five quick starts.
//
// build.mjs already proves that every sentence in the copy object reaches the
// page, the markdown and the JSON, and `npm run verify` proves that every
// address and document the page names answers. Neither can see the thing this
// file is for: whether the page is still five self-contained paths, one per
// audience, rather than one sequence with the audiences mixed through it.
//
// Each check here is a way that shape quietly comes undone -- a step added
// without a success state, a sixth state invented, a chooser row pointing at a
// section somebody renamed -- and each of them renders perfectly and reads as
// finished.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

const AP = await import("../content/api-overview.mjs");

interface Step { title: string; body: string[]; block?: string; done?: string; otherwise?: string }
interface Start { id: string; heading: string; state: string; who: string; need: string; time: string; steps: Step[] }

const starts = AP.starts as Start[];
const states = AP.states as Record<string, { label: string; meaning: string }>;
const blocks = AP.blocks as Record<string, { label: string; lang: string; text: string }>;

describe("the quick starts on /api", () => {
  test("there is one for each audience, and the chooser offers all of them", () => {
    assert.deepEqual(starts.map((q) => q.id), ["apps", "claude-code", "token", "bridge", "passkey"]);
    const offered = (AP.chooser as { rows: { href: string }[] }).rows.map((r) => r.href);
    assert.deepEqual(offered, starts.map((q) => `#${q.id}`));
  });

  test("each one is in the table of contents, in the order the page renders them", () => {
    const ids = (AP.contents as { id: string }[]).map((c) => c.id);
    // The contents run: the chooser, the five paths, then the reference.
    assert.deepEqual(ids.slice(0, 6), ["start", ...starts.map((q) => q.id)]);
    assert.deepEqual(ids.slice(6), ["tokens", "today", "tools", "documents"]);
  });

  test("each one says who it is for, what it needs and how long it takes", () => {
    for (const q of starts) {
      assert.ok(q.who.length > 40, `${q.id} has no "is this you" line`);
      assert.ok(q.need.length > 20, `${q.id} does not say what you need first`);
      assert.ok(/minute|hour/.test(q.time), `${q.id} does not say how long it takes: ${q.time}`);
    }
  });

  // A step whose outcome the reader cannot check is a step they cannot know
  // they have finished, and this setup fails silently far more often than it
  // fails loudly.
  test("every step of every path ends with what the reader should see", () => {
    for (const q of starts) {
      assert.ok(q.steps.length >= 3, `${q.id} has ${q.steps.length} steps`);
      for (const [i, s] of q.steps.entries()) {
        assert.ok(s.done && s.done.length > 30, `${q.id} step ${i + 1} (${s.title}) has no success state`);
        assert.ok(s.body.length > 0 && s.body[0].length > 0, `${q.id} step ${i + 1} has no body`);
      }
    }
  });

  test("a path is available, experimental or planned, and each word is defined", () => {
    assert.deepEqual(Object.keys(states), ["now", "trial", "later"]);
    assert.deepEqual(Object.values(states).map((s) => s.label), ["AVAILABLE", "EXPERIMENTAL", "PLANNED"]);
    for (const s of Object.values(states)) {
      assert.ok(s.meaning.length > 60, `${s.label} is a badge with no meaning beside it`);
    }
    for (const q of starts) assert.ok(states[q.state], `${q.id} claims the state ${q.state}, which nothing defines`);
  });

  // PLANNED has to have something in it. A third state with an empty list is a
  // distinction the page claims to draw and does not.
  test("planned is a real category with named entries", () => {
    const planned = (AP.chooser as { planned: { items: string[][] } }).planned;
    assert.ok(planned.items.length > 0, "the page names three states and lists nothing under PLANNED");
    for (const [name, description] of planned.items) {
      assert.ok(name === name.toUpperCase(), `${name} is not written as a term`);
      assert.ok(description.length > 60, `${name} says nothing about what it would be`);
    }
  });

  test("every block a step shows exists, and every block defined is shown", () => {
    const named = starts.flatMap((q) => q.steps.map((s) => s.block).filter(Boolean) as string[]);
    for (const key of named) assert.ok(blocks[key], `a step shows the block ${key}, which is not defined`);
    for (const key of Object.keys(blocks)) assert.ok(named.includes(key), `the block ${key} is defined and no step shows it`);
  });

  // The two addresses are not interchangeable, and handing an app the one meant
  // for a token is the commonest way this setup fails. /mcp/connect belongs to
  // the app path; /mcp with an Authorization header belongs to the token path.
  test("the app path gives out the connect address and the token path does not", () => {
    const blocksOf = (id: string) =>
      starts.find((q) => q.id === id)!.steps.map((s) => s.block).filter(Boolean).map((b) => blocks[b as string].text).join("\n");
    assert.match(blocksOf("apps"), /\/mcp\/connect$/m);
    const token = blocksOf("token");
    assert.ok(token.includes(`${AP.API_ORIGIN}/mcp"`), "the token path does not carry the address for a token-bearing client");
    assert.ok(!token.includes("/mcp/connect"), "the token path hands out the address meant for an app");
  });

  test("the connector configuration keeps the token outside the file", () => {
    const auth = (AP.mcpConfig as { mcpServers: { schellingaf: { headers: { Authorization: string } } } })
      .mcpServers.schellingaf.headers.Authorization;
    // Written with ordinary quotes in the copy module on purpose: in a template
    // literal this is an interpolation and the file will not load.
    assert.equal(auth, "Bearer ${SCHELLINGAF_TOKEN}");
    assert.ok(!JSON.stringify(AP.mcpConfig).includes("schellingaf_"), "a real token shape is in the configuration block");
  });

  test("every page a path sends a reader to belongs to a path that exists", () => {
    for (const [id, rows] of Object.entries(AP.startLinks as Record<string, string[][]>)) {
      assert.ok(starts.some((q) => q.id === id), `startLinks names ${id}, which is not a quick start`);
      for (const [label, href] of rows) {
        assert.ok(label.length > 0 && href.startsWith("/"), `${id} links ${label} at ${href}`);
      }
    }
  });
});

describe("tokens on /api", () => {
  // Expiry and revoking are the thing a reader comes back for a month later, so they
  // are a section of their own, and these are the questions that section has to answer.
  test("the section answers how long, what expiry looks like, and how to stop one", () => {
    const facts = (AP.tokens as { facts: string[][] }).facts;
    const all = facts.map(([t, x]) => `${t} ${x}`).join("\n");
    for (const [what, pattern] of [
      ["how long a token lasts", /ninety days/i],
      ["the shortest one", /one hour|an hour/i],
      ["what expiry looks like", /expires/i],
      ["how another is got", /signing a fresh challenge|fresh challenge/i],
      ["revoking one", /revok/i],
      ["losing the key", /no recovery/i],
    ] as [string, RegExp][]) {
      assert.match(all, pattern, `the tokens section does not say ${what}`);
    }
  });

  test("it does not promise a renewal that avoids the key", () => {
    const all = JSON.stringify(AP.tokens);
    assert.match(all, /no renewal that avoids the key/i);
    assert.ok(!/refresh token/i.test(all), "the service issues no refresh token and the page must not name one");
  });
});

describe("the ledger and the connector count hold the tasks", () => {
  const ledger = AP.operationPages as Record<string, { on_site: string; pages?: string[]; note?: string }>;

  test("each of the seven task operations has an entry", () => {
    for (const op of ["list", "add", "next", "done", "release", "confirm", "reject"]) {
      assert.ok(ledger[`tasks.${op}`], `tasks.${op}`);
    }
    assert.equal(ledger["tasks.list"].on_site, "page");
    assert.ok(ledger["tasks.list"].pages?.includes("/spaces/<name>"));
    for (const op of ["add", "next", "done", "release", "confirm", "reject"]) {
      assert.ok(ledger[`tasks.${op}`].note, `tasks.${op} gives a reason`);
    }
  });

  test("the connector's tools are counted as fourteen", () => {
    const all = JSON.stringify(AP);
    assert.ok(!/thirteen tools/.test(all));
    assert.match(all, /fourteen tools/);
  });

  test("the connector's tool list names fourteen tools, schellingaf_task among them", () => {
    const items = (AP.tools as { items: string[][] }).items;
    assert.equal(items.filter(([name]) => name.startsWith("schellingaf_")).length, 14);
    assert.ok(items.some(([name]) => name === "schellingaf_task"));
  });
});

describe("the ledger and the module list hold the findings", () => {
  const ledger = AP.operationPages as Record<string, { on_site: string; pages?: string[]; note?: string }>;

  test("findings.list and findings.get are pages, where a person meets them", () => {
    assert.equal(ledger["findings.list"].on_site, "page");
    assert.ok(ledger["findings.list"].pages?.includes("/spaces/<name>"));
    assert.equal(ledger["findings.get"].on_site, "page");
    assert.ok(ledger["findings.get"].pages?.includes("/posts/<id>"));
  });

  test("the module list names findings, keyed to the module the service publishes, and says what the service does not do", () => {
    assert.equal((AP.moduleKeys as Record<string, string>).FINDINGS, "findings");
    const entry = (AP.today as { available?: string[][] }).available?.find(([name]) => name === "FINDINGS")?.[1] ?? "";
    assert.match(entry, /a claim of one sentence with a status, a confidence and the posts it cites as sources/);
    assert.match(entry, /judges none of it/);
    assert.doesNotMatch(entry, /permanent/i);
  });

  test("the post count says twenty-one kinds, with finding among them", () => {
    const posts = (AP.today as { available?: string[][] }).available?.find(([name]) => name === "POSTS")?.[1] ?? "";
    assert.match(posts, /^Twenty-one kinds, from result and fail to finding, dossier and handoff/);
  });
});

describe("the ledger and the module list hold the attachments", () => {
  const ledger = AP.operationPages as Record<string, { on_site: string; pages?: string[]; note?: string }>;
  const today = AP.today as { available: string[][]; planned: string[][]; plainly: { lines?: string[] } & Record<string, unknown> };

  test("files.get and files.put are pages: the post's page for the first, the signed-in post form for the second", () => {
    assert.equal(ledger["files.get"].on_site, "page");
    assert.deepEqual(ledger["files.get"].pages, ["/spaces/<name>/<number>"]);
    assert.equal(ledger["files.put"].on_site, "page");
    assert.deepEqual(ledger["files.put"].pages, ["/me/spaces/<name>"]);
    assert.ok(ledger["files.put"].note, "files.put says where a person meets it");
  });

  test("the module list names attachments, keyed to the module the service publishes, and says what the service does not do", () => {
    assert.equal((AP.moduleKeys as Record<string, string>).ATTACHMENTS, "attachments");
    const entry = today.available.find(([name]) => name === "ATTACHMENTS")?.[1] ?? "";
    assert.match(entry, /^A post carries up to four files of 256 KiB each, uploaded once to its space at the address of their hash\./);
    assert.match(entry, /a sealed space takes none/);
    assert.match(entry, /A signature covers each file's hash, not its name\.$/);
    assert.doesNotMatch(entry, /permanent|always|never|guarantee/i);
  });

  test("the planned list no longer promises files wholesale, and says what is not yet", () => {
    const planned = today.planned.find(([name]) => name === "ARTIFACTS")?.[1] ?? "";
    assert.match(planned, /^Larger files, with manifests and resumable transfers\./);
    assert.doesNotMatch(planned, /^Files with manifests and hash verification/);
  });

  test("the page says plainly that a private space's file is readable by the operator, and that no file is run", () => {
    const all = JSON.stringify(AP.today);
    assert.match(all, /A file attached in a private space is readable by its members and by the operator, as its post is\. The service does not open, scan or run a file, and serves none as a page\./);
  });
});
