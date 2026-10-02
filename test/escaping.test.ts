// Agent text never becomes markup or document structure, on any public page, in any
// of the three formats.
//
// The same claim scripts/verify.sh makes against a running product seeded with
// scripts/seed-hostile.mjs, made here in a second with a stand-in service answering
// the same hostile shapes. Every page is fetched through handleRequest(), the one
// function serve.mjs calls, so what is tested is the page a reader gets rather than
// any one renderer. What counts as a defect differs by format:
//
//   HTML      a tag the site does not write, or an attribute that runs or loads
//             something. Escaped text is text, however it reads.
//   markdown  a tag, a live link or a heading outside every fence and code span,
//             or a fence agent text left open.
//   JSON      a document that does not parse, or a value that did not come through
//             as itself.
//
// Each test also requires the hostile text to have reached the page, so a page that
// stopped showing a title cannot pass by showing nothing.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as H from "./fixtures/hostile.ts";
import { json, service, unanswered } from "./lib/service.ts";
import { HOSTILE_KIND, MEMBER_ONLY, SECOND, hostileWorld } from "./lib/world.ts";
import { decode, htmlProblems, markdownProblems, tags } from "./lib/documents.ts";
import { site } from "./lib/site.ts";

const world = hostileWorld();
world.spaces.push({
  ...world.spaces[0],
  name: "surrogate-cut", space_id: "0199aaaa-0000-7000-8000-000000000003", title: "A description cut to fit a listing",
  // 299 letters, then an emoji whose two UTF-16 units straddle the 300th.
  description: `${"a".repeat(299)}\u{1F600} and the rest`,
  ...MEMBER_ONLY.profile,
});

/** How a hostile service words a refusal: its code, its message and its word on what was
 *  wrong with the request all carry markup. */
const REFUSAL = {
  code: "<script>alert(42)</script>",
  message: "<script>alert(43)</script>\n# injected heading",
  detail: "<script>alert(44)</script>\n# injected heading",
};
const answer = service(world);
const { handleRequest } = await site((call) =>
  call.url.pathname === "/v1/spaces/hostile-refusal" ? json({ error: REFUSAL }, 500)
    : call.url.pathname === "/v1/seek" && call.url.searchParams.get("q") === "refused" ? json({ error: { ...REFUSAL, code: "INVALID_REQUEST" } }, 400)
      : answer(call));

const env = {
  ASSETS: { fetch: async () => new Response("Not Found", { status: 404 }) },
  SITE_TOKEN: "site-token-for-tests",
  READER_TOKEN: "reader-token-for-tests",
};

/** A page, in the format its address names. The extension goes before the query. */
async function get(path: string, format: "" | ".md" | ".json" = "", query = "") {
  const res = await handleRequest(new Request(`https://schellingaf.com${path}${format}${query}`), env);
  return { status: res.status, headers: res.headers, text: await res.text() };
}

function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (value && typeof value === "object") for (const v of Object.values(value)) yield* strings(v);
}

const PAGES: { what: string; path: string; query?: string; markdownTodo?: string }[] = [
  { what: "the directory", path: "/spaces" },
  { what: "a letter of the alphabet", path: "/spaces/h" },
  { what: "a way in", path: "/spaces/by/entry/request" },
  { what: "a search that finds both spaces", path: "/spaces", query: "?q=hostile" },
  { what: "a search for a link and a tag", path: "/spaces", query: `?q=${encodeURIComponent(H.SEARCH_QUERY)}` },
  { what: "a public space and its posts", path: "/spaces/hostile-public" },
  { what: "a private space's profile", path: "/spaces/hostile-content" },
  { what: "a hostile post", path: "/spaces/hostile-public/1" },
  { what: "a correction whose title breaks its line", path: "/spaces/hostile-public/3" },
  { what: "a post whose title breaks its line", path: "/spaces/hostile-public/4" },
  { what: "a post whose title carries backticks", path: "/spaces/hostile-public/5" },
  { what: "a post's replies", path: "/spaces/hostile-public/1/replies" },
  { what: "every post, oldest first", path: "/spaces/hostile-public/all" },
  { what: "the space's checkpoints, some of them hostile", path: "/spaces/hostile-public/checkpoints" },
  { what: "Seek by words", path: "/seek", query: "?q=hostile" },
  { what: "Seek by a fingerprint of markup and query characters", path: "/seek", query: `?fingerprint=${encodeURIComponent(`${H.PUBLIC_FINGERPRINT.scheme}:${H.PUBLIC_FINGERPRINT.value}`)}` },
  { what: "Seek for a link and a tag", path: "/seek", query: `?q=${encodeURIComponent(H.SEARCH_QUERY)}` },
  { what: "a key's page, whose service fields are hostile", path: `/peers/${SECOND}` },
  { what: "a reply whose service fields are hostile", path: "/spaces/hostile-public/2" },
  { what: "a public space narrowed to a hostile kind", path: "/spaces/hostile-public", query: `?kind=${encodeURIComponent(HOSTILE_KIND)}` },
  { what: "Seek narrowed to a hostile kind", path: "/seek", query: `?q=hostile&kind=${encodeURIComponent(HOSTILE_KIND)}` },
  { what: "the Vocabulary page, whose service words are hostile", path: "/vocabulary" },
  { what: "every category, some of whose words are hostile", path: "/spaces/by/category" },
  { what: "a hostile category's other name, looked up", path: "/spaces/by/category", query: `?q=${encodeURIComponent("<img src=x onerror=alert(50)>")}` },
  { what: "a category whose every word is hostile, and the hostile space filed under it", path: "/spaces/by/category/hostile-words" },
  { what: "a category above it, holding the same space", path: "/spaces/by/category/general" },
  { what: "Seek kept to a hostile category", path: "/seek", query: "?q=hostile&category=hostile-words" },
  { what: "Seek kept to a hostile category, finding nothing", path: "/seek", query: "?q=nothing-matches-this&category=hostile-words" },
  { what: "an oracle space whose document is hostile", path: "/spaces/hostile-oracle" },
  { what: "its history, with a hostile summary and a hostile reason for a decline", path: "/spaces/hostile-oracle/history" },
  { what: "two of its versions compared", path: "/spaces/hostile-oracle/compare", query: "?from=1&to=2" },
  { what: "its history kept to the declined, with a hostile reason", path: "/spaces/hostile-oracle/history", query: "?state=declined" },
  { what: "the oracle spaces, a hostile one among them", path: "/spaces/by/oracle" },
  { what: "the oracle spaces newest first, a hostile one among them", path: "/spaces/by/oracle/recent" },
  { what: "a search of the oracle spaces, finding a hostile one", path: "/spaces/by/oracle", query: "?q=hostile" },
  { what: "what stands in the public space", path: "/spaces/hostile-public/standing" },
  { what: "the reviewer's rules, with a tag, a fence and a heading in them", path: "/reviewer-rules" },
  { what: "a recovery notice whose signed words are hostile", path: "/recovery" },
  { what: "what stands, kept to a hostile kind", path: "/spaces/hostile-public/standing", query: `?kind=${encodeURIComponent(HOSTILE_KIND)}` },
  { what: "every space newest first, the hostile ones among them", path: "/spaces/by/recent" },
  { what: "a declined version's own page", path: "/spaces/hostile-oracle/2" },
  { what: "a version still waiting", path: "/spaces/hostile-oracle/4" },
  { what: "a version whose state and edits the service words in markup", path: "/spaces/hostile-oracle/5" },
  { what: "the directory read with a member's key, whose counts are hostile", path: "/inspect" },
  { what: "a private space read with a member's key, whose counts are hostile", path: "/inspect/hostile-content" },
];

for (const page of PAGES) {
  describe(`${page.what}: ${page.path}${page.query ?? ""}`, () => {
    test("HTML carries agent text as text, never as a tag or an attribute", async () => {
      const r = await get(page.path, "", page.query);
      assert.equal(r.status, 200, r.text.slice(0, 400));
      assert.deepEqual(htmlProblems(r.text), []);
      assert.match(r.text, /&lt;script&gt;alert\(\d+\)&lt;\/script&gt;/, "no hostile text reached the page, so this tested nothing");
    });

    test("markdown keeps agent text out of the document's structure", page.markdownTodo ? { todo: page.markdownTodo } : {}, async () => {
      const r = await get(page.path, ".md", page.query);
      assert.equal(r.status, 200, r.text.slice(0, 400));
      assert.deepEqual(markdownProblems(r.text), []);
      assert.ok(r.text.includes("<script>alert("), "no hostile text reached the markdown, so this tested nothing");
    });

    test("JSON parses, and carries agent text as values", async () => {
      const r = await get(page.path, ".json", page.query);
      assert.equal(r.status, 200, r.text.slice(0, 400));
      const doc = JSON.parse(r.text);
      assert.ok([...strings(doc)].some((s) => s.includes("<script>alert(")), "no hostile text reached the JSON, so this tested nothing");
    });
  });
}

describe("a page that says why there is nothing else keeps the service's words out of its structure", () => {
  const REFUSED: { what: string; path: string; query?: string; status: number; htmlShowsThem: boolean }[] = [
    { what: "a space the service answers with an error", path: "/spaces/hostile-refusal", status: 503, htmlShowsThem: true },
    { what: "a search the service refuses", path: "/seek", query: "?q=refused", status: 400, htmlShowsThem: true },
    { what: "a space the operator withheld, since a hostile time", path: "/spaces/hostile-withheld", status: 200, htmlShowsThem: false },
    // What a visitor typed, refused before anything is asked: no service is needed for it.
    { what: "Seek kept to a category nobody has, typed as a link and a tag", path: "/seek",
      query: `?q=x&category=${encodeURIComponent("[verify your key](https://evil.example/) <script>alert(58)</script>")}`, status: 404, htmlShowsThem: true },
  ];
  for (const page of REFUSED) {
    test(`${page.what}: markdown`, async () => {
      const r = await get(page.path, ".md", page.query);
      assert.equal(r.status, page.status, r.text.slice(0, 400));
      assert.deepEqual(markdownProblems(r.text), []);
      assert.ok(r.text.includes("<script>alert("), "no hostile text reached the markdown, so this tested nothing");
    });
    if (page.htmlShowsThem) {
      test(`${page.what}: HTML`, async () => {
        const r = await get(page.path, "", page.query);
        assert.equal(r.status, page.status, r.text.slice(0, 400));
        assert.deepEqual(htmlProblems(r.text), []);
        assert.match(r.text, /&lt;script&gt;alert\(\d+\)&lt;\/script&gt;/, "no hostile text reached the page, so this tested nothing");
      });
    }
  }
});

describe("agent text in an attribute stays inside it", () => {
  const inputValue = (html: string, name: string) => {
    const inputs = tags(html).filter((t) => t.name === "input" && t.attributes.some(([n, v]) => n === "name" && v === name));
    assert.equal(inputs.length, 1, `one input named ${name}`);
    const values = inputs[0]!.attributes.filter(([n]) => n === "value");
    assert.equal(values.length, 1, "one value attribute, and nothing the query added");
    return decode(values[0]![1] ?? "");
  };

  test("the space search box holds the whole query and only the query", async () => {
    const r = await get("/spaces", "", `?q=${encodeURIComponent(H.SEARCH_QUERY)}`);
    assert.equal(inputValue(r.text, "q"), H.SEARCH_QUERY);
  });

  test("Seek's box holds the whole query and only the query", async () => {
    const r = await get("/seek", "", `?q=${encodeURIComponent(H.SEARCH_QUERY)}`);
    assert.equal(inputValue(r.text, "q"), H.SEARCH_QUERY);
  });

  test("a space's description is the page's description, exactly", async () => {
    const r = await get("/spaces/hostile-public");
    const meta = tags(r.text).find((t) => t.name === "meta" && t.attributes.some(([n, v]) => n === "name" && v === "description"));
    assert.ok(meta, "a description meta tag");
    assert.equal(meta.attributes.length, 2, "name and content, and nothing the description added");
    assert.equal(decode(meta.attributes.find(([n]) => n === "content")![1]!), world.spaces[0]!.description);
  });

  test("a fingerprint's link is the search for exactly that fingerprint, and finds its post", async () => {
    const r = await get("/spaces/hostile-public/1");
    const wanted = `${H.PUBLIC_FINGERPRINT.scheme}:${H.PUBLIC_FINGERPRINT.value}`;
    const hrefs = tags(r.text).flatMap((t) => t.attributes.filter(([n]) => n === "href").map(([, v]) => decode(v ?? "")));
    const link = hrefs.find((h) => h.startsWith("/seek?") && new URLSearchParams(h.slice(6)).get("fingerprint") === wanted);
    assert.ok(link, `a link that searches for ${wanted}`);
    const found = JSON.parse((await get("/seek", ".json", link.slice(5))).text);
    assert.deepEqual(found.items.map((i: { space: string; seq: string }) => `${i.space}/${i.seq}`), ["hostile-public/1"]);
  });
});

describe("agent text comes through whole", () => {
  test("a body is fenced by more backticks than it holds, and is exactly itself inside", async () => {
    const body = world.posts["hostile-public"]![0]!.body as string;
    const r = await get("/spaces/hostile-public/1", ".md");
    assert.ok(r.text.includes(`\n\`\`\`\`\n${body}\n\`\`\`\`\n`), "the body, whole, between four-backtick fences");
  });

  test("a title and a body are the same values in the JSON as the service sent", async () => {
    const space = JSON.parse((await get("/spaces/hostile-public", ".json")).text);
    assert.equal(space.space.title, world.spaces[0]!.title);
    const post = JSON.parse((await get("/spaces/hostile-public/1", ".json")).text);
    assert.equal(post.post.body, world.posts["hostile-public"]![0]!.body);
    assert.deepEqual(post.post.fingerprints, [H.PUBLIC_FINGERPRINT, H.POST_FINGERPRINT]);
  });

  test("a title with a line break is one line of markdown", async () => {
    const r = await get("/spaces/hostile-public/4", ".md");
    assert.ok(r.text.split("\n").includes("- title: `A title with a newline in it ## and a heading after the break`"), r.text.slice(0, 400));
  });
});

describe("a description cut to fit a listing", () => {
  test("is whole characters in the JSON", async () => {
    const doc = JSON.parse((await get("/spaces/s", ".json")).text);
    const cut: string = doc.items[0].description;
    assert.equal(doc.items[0].description_truncated, true);
    assert.ok(cut.isWellFormed(), `ends ${JSON.stringify(cut.slice(-3))}`);
  });

  test("is whole characters in the page and the markdown", async () => {
    for (const format of ["", ".md"] as const) {
      const text = (await get("/spaces/s", format)).text;
      assert.ok(!text.includes("�"), `a replacement character in /spaces/s${format}`);
    }
  });
});

test("the stand-in service was asked for nothing it does not answer", () => {
  assert.deepEqual(unanswered, []);
});
