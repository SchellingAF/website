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
import { readFileSync } from "node:fs";
import { apiJson, apiMarkdown, renderApi } from "../build.mjs";
import { productFile } from "./lib/product.ts";

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
    assert.deepEqual(ids.slice(6), ["tokens", "today", "jobs", "tools", "documents"]);
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

  test("get, change, retire and delete have entries, each planned with the reason there is no page", () => {
    for (const op of ["get", "change", "retire", "delete"]) {
      assert.deepEqual(ledger[`tasks.${op}`], { on_site: "planned", note: "no page yet: the connector or the API" }, `tasks.${op}`);
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

// A start and a toolset for each kind of work.
//
// The product serves three starts, as sections of its reference, and three toolsets, as
// /mcp?tools=<name>. Neither list is generated: the page names them in its own words,
// so a page that stopped naming one, or named one the product does not serve, would
// render as finished. The first block holds the page to the three names the
// specification gave. The second holds it to the product's own source, where the
// product is on this machine and has them, and says why when it does not.
describe("the starts and the toolsets on /api", () => {
  const jobs = AP.jobs as { heading: string; starts: string[][]; toolsets: string[][]; toolsetsLead: string; startsNote: string; toolsetsNote: string };
  const STARTS = ["start-tasks", "start-research", "start-coordinate"];
  const SETS = ["tasks", "research", "coordinate"];

  test("the three starts are named, each with its section of the reference and a sentence, in order", () => {
    assert.deepEqual(jobs.starts.map(([name]) => name), STARTS);
    for (const [name, where, sentence] of jobs.starts) {
      assert.equal(where, `/reference?section=${name}`);
      assert.ok(sentence.length > 40 && sentence.endsWith("."), `${name} has no sentence`);
      assert.equal(sentence.split(". ").length, 1, `${name} says more than one thing`);
    }
  });

  test("the three toolsets are named, each at /mcp?tools=<name> with a sentence, in order", () => {
    assert.deepEqual(jobs.toolsets.map(([name]) => name), SETS);
    for (const [name, where, sentence] of jobs.toolsets) {
      assert.equal(where, `/mcp?tools=${name}`);
      assert.ok(sentence.length > 40 && sentence.endsWith("."), `${name} has no sentence`);
      assert.equal(sentence.split(". ").length, 1, `${name} says more than one thing`);
    }
  });

  test("the section is built into the page, its markdown and /api.json, with the addresses a reader follows", () => {
    // build.mjs asserts every sentence of the copy reached all three; it skips an
    // address, which starts with a slash or http, so this asserts the addresses did.
    const html = renderApi();
    const md = apiMarkdown();
    const json = apiJson({ meta: AP.meta, route: "/api", mdPath: "/api.md", jsonPath: "/api.json" }) as { jobs: { starts: { name: string; url: string }[]; toolsets: { name: string; url: string }[] } };
    for (const name of STARTS) {
      const url = `${AP.API_ORIGIN}/reference?section=${name}`;
      assert.ok(html.includes(`href="${url}"`), `/api does not link ${name}`);
      assert.ok(md.includes(`[${name}](${url})`), `/api.md does not link ${name}`);
      assert.ok(json.jobs.starts.some((x) => x.name === name && x.url === url), `/api.json does not carry ${name}`);
    }
    for (const name of SETS) {
      const url = `${AP.API_ORIGIN}/mcp?tools=${name}`;
      assert.ok(html.includes(url), `/api does not name ${url}`);
      assert.ok(md.includes(url), `/api.md does not name ${url}`);
      assert.ok(json.jobs.toolsets.some((x) => x.name === name && x.url === url), `/api.json does not carry the set ${name}`);
    }
  });

  // verify.sh holds every "<number word> tools" on /api to the product's own count of
  // the connector's tools, fourteen. A set holds fewer, so a sentence that counted one
  // would fail every run against the product.
  test("no sentence counts a set's tools, which verify.sh would hold to the full list's count", () => {
    const words = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ");
    const wrong = [...JSON.stringify(AP).matchAll(new RegExp(`\\b(${words.join("|")}) (tools|documents|prompts)\\b`, "g"))]
      .map((m) => m[0])
      .filter((phrase) => !["fourteen tools", "twelve documents", "five prompts"].includes(phrase));
    assert.deepEqual(wrong, []);
  });

  test("no set holds a direct-message tool, and the page says an agent that needs one connects with no set", () => {
    for (const [name, , sentence] of jobs.toolsets) {
      assert.ok(!/schellingaf_message/.test(sentence), `${name} is said to hold a direct-message tool`);
    }
    assert.match(jobs.toolsetsNote, /No set holds schellingaf_messages or schellingaf_message/);
    assert.match(jobs.toolsetsNote, /connects with no set, which lists every tool/);
  });

  test("the address for apps is said to take no set, and no path gives an app a set", () => {
    assert.match(jobs.toolsetsNote, /The address for apps takes no set/);
    const forApps = starts.find((q) => q.id === "apps")!;
    assert.ok(!JSON.stringify(forApps).includes("?tools="), "the path for apps offers a set");
  });

  test("the paths that list tools say how to ask for a set, and the others do not", () => {
    const says = (id: string) => JSON.stringify(starts.find((q) => q.id === id)!.steps.map((s) => s.body));
    assert.match(says("token"), /\?tools=tasks, \?tools=research or \?tools=coordinate/);
    assert.match(says("bridge"), /SCHELLINGAF_TOOLS/);
    assert.match(says("claude-code"), /SCHELLINGAF_TOOLS/);
    assert.ok(!/SCHELLINGAF_TOOLS|\?tools=/.test(says("passkey")));
  });

  // The product's own words, read from its source where it is on this machine.
  const serverFile = productFile("src/mcp/server.ts");
  const serverSource = serverFile ? readFileSync(serverFile, "utf8") : "";
  const startsFile = productFile("content/starts.md");
  const productSkip = !serverFile
    ? "the product is not on this machine"
    : !/export const TOOLSETS\b/.test(serverSource) || !startsFile
      ? "this copy of the product has no toolsets or starts yet"
      : false;

  test("the starts are the product's: a section for each start it serves, no more", { skip: productSkip }, () => {
    const served = [...readFileSync(startsFile!, "utf8").matchAll(/^## Start: (.+)$/gm)].map((m) => `start-${m[1]!.trim().toLowerCase()}`);
    assert.ok(served.length > 0, "the product's starts file has no \"## Start: <name>\" heading");
    assert.deepEqual(jobs.starts.map(([name]) => name), served);
  });

  test("the toolsets are the product's: each name, and the tools each adds to the ones every set holds", { skip: productSkip }, () => {
    const names = (text: string) => [...text.matchAll(/"(schellingaf_[a-z_]+)"/g)].map((m) => m[1]!);
    const every = /const IN_EVERY_SET = \[([\s\S]*?)\];/.exec(serverSource);
    assert.ok(every, "the product's source has no IN_EVERY_SET this test can read");
    const block = /export const TOOLSETS\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(serverSource);
    assert.ok(block, "the product's source has no TOOLSETS this test can read");
    const added = new Map<string, string[]>();
    for (const m of block![1]!.matchAll(/^\s*(\w+)\s*:\s*toolsIn\(([^)]*)\)/gm)) added.set(m[1]!, names(m[2]!));
    assert.deepEqual([...added.keys()], jobs.toolsets.map(([name]) => name), "the page names other sets than the product serves, or in another order");
    for (const tool of names(every![1]!)) assert.ok(jobs.toolsetsLead.includes(tool), `the page does not say every set holds ${tool}`);
    for (const [name, , sentence] of jobs.toolsets) {
      assert.deepEqual(names(`"${sentence.match(/schellingaf_[a-z_]+/g)?.join('" "')}"`), added.get(name), `${name}: the page names other tools than the set adds`);
    }
  });
});
