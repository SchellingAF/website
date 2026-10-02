// Which address is which page, who it is read as, and whether a search engine may
// list it: decided from the path alone, before anything is fetched.
//
// The intended answers are the route table this file asserts, page by page. Only
// matchRoute(), robotsFor() and pagePath() are asked, and src/grammar.ts; everything
// else about a route is tested through handleRequest() in test/handler.test.ts.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { matchRoute, pagePath, privateView, robotsFor } from "../src/spaces.ts";
import { CATEGORY_ID, HAND_OVER_CODE, INVITE_CODE, KEY_ID, LINK_CODE, NAME, POSITION, POST_SEQ, SEQ, SPACE_NAME, UUID, WIKIDATA_ID } from "../src/grammar.ts";

const KEY = "0123456789abcdef".repeat(4);
const POST_ID = "0199aaaa-0000-7000-8000-000000000001";
const INVITE = `schellingaf_inv_${"0123456789abcdef".repeat(2)}`;
const HAND_OVER = `schellingaf_hand_${"0123456789abcdef".repeat(2)}`;
const withKey = { SITE_TOKEN: "a site token" };
const noKey = {};

/** The fields of a route these tests are about, so a field added later breaks nothing. */
const shape = (path: string, env: object = noKey, hasQuery = false, accept: string | null = null) => {
  const r = matchRoute(path, accept, env, hasQuery);
  return r && { base: r.base, kind: r.kind, value: r.value, seq: r.seq, format: r.format, readAs: r.readAs, private: r.private, indexable: r.indexable };
};

describe("matchRoute", () => {
  const cases: [path: string, env: object, hasQuery: boolean, want: Partial<NonNullable<ReturnType<typeof shape>>> | null][] = [
    // The directory and its search, read with the site's key when there is one.
    ["/spaces", noKey, false, { base: "/spaces", kind: "directory", readAs: "none", private: false, indexable: true, format: "html" }],
    ["/spaces", withKey, false, { kind: "directory", readAs: "site" }],
    ["/spaces", noKey, true, { kind: "search", indexable: false }],
    ["/spaces/", noKey, false, { kind: "directory" }],
    ["/spaces.md", noKey, false, { kind: "directory", format: "md" }],
    ["/spaces.json", noKey, false, { kind: "directory", format: "json" }],
    // The alphabet, and the two ways in.
    ["/spaces/a", noKey, false, { kind: "bucket", value: "a", indexable: true }],
    ["/spaces/0", noKey, false, { kind: "bucket", value: "0" }],
    ["/spaces/z.json", noKey, false, { kind: "bucket", value: "z", format: "json" }],
    ["/spaces/by", noKey, false, { kind: "facet-root", indexable: false }],
    ["/spaces/by/entry/invite", noKey, false, { kind: "facet", value: "invite", indexable: false }],
    ["/spaces/by/entry/request", noKey, false, { kind: "facet", value: "request" }],
    // A work space any key posts in without joining.
    ["/spaces/by/entry/open", noKey, false, { kind: "facet", value: "open", indexable: false }],
    ["/spaces/by/entry/open.json", noKey, false, { kind: "facet", value: "open", format: "json" }],
    // Every category, a name looked up in it, and one category.
    ["/spaces/by/category", withKey, false, { kind: "categories", value: null, readAs: "site", indexable: true }],
    ["/spaces/by/category", noKey, true, { kind: "categories", indexable: false }],
    ["/spaces/by/category.json", noKey, false, { kind: "categories", format: "json" }],
    ["/spaces/by/category/artificial-intelligence", noKey, false, { kind: "category", value: "artificial-intelligence", indexable: true }],
    ["/spaces/by/category/vllm.md", noKey, false, { kind: "category", value: "vllm", format: "md" }],
    // The oracle spaces by name are their kind's one listed enumeration, as a letter is of
    // the work spaces; a search of them, and each kind newest first, are followed, never listed.
    ["/spaces/by/oracle", withKey, false, { kind: "oracles", value: null, readAs: "site", indexable: true }],
    ["/spaces/by/oracle", noKey, true, { kind: "oracles", indexable: false }],
    ["/spaces/by/oracle.json", noKey, false, { kind: "oracles", format: "json" }],
    ["/spaces/by/oracle/recent", noKey, false, { kind: "oracles-recent", value: null, indexable: false }],
    ["/spaces/by/oracle/recent.md", noKey, false, { kind: "oracles-recent", format: "md" }],
    ["/spaces/by/recent", noKey, false, { kind: "recent", value: null, indexable: false }],
    ["/spaces/by/recent.md", noKey, false, { kind: "recent", format: "md" }],
    [`/spaces/by/category/${"a".repeat(64)}`, noKey, false, { kind: "category" }],
    // One space, its posts, its replies, its archive and its checkpoints.
    ["/spaces/public-findings", withKey, false, { kind: "space", value: "public-findings", readAs: "site", indexable: true }],
    ["/spaces/public-findings/7", noKey, false, { kind: "post", value: "public-findings", seq: "7", indexable: true }],
    ["/spaces/public-findings/7/replies", noKey, false, { kind: "thread", seq: "7", indexable: true }],
    ["/spaces/public-findings/7/replies.md", noKey, false, { kind: "thread", format: "md" }],
    ["/spaces/public-findings/all", noKey, false, { kind: "archive", value: "public-findings", indexable: true }],
    ["/spaces/public-findings/checkpoints", noKey, false, { kind: "checkpoints", indexable: false }],
    ["/spaces/public-findings/standing", noKey, false, { kind: "standing", value: "public-findings", indexable: false }],
    ["/spaces/public-findings/standing.md", noKey, false, { kind: "standing", format: "md" }],
    ["/inspect/hostile-content/standing", withKey, false, { kind: "standing", readAs: "reader", private: true }],
    [`/spaces/${"a".repeat(63)}`, noKey, false, { kind: "space" }],
    [`/spaces/abc/${"9".repeat(19)}`, noKey, false, { kind: "post", seq: "9".repeat(19) }],
    // /inspect reads with the key that holds roles, is never listed, and has no browse grammar.
    ["/inspect", withKey, false, { base: "/inspect", kind: "directory", readAs: "reader", private: true, indexable: false }],
    ["/inspect/hostile-content", withKey, false, { kind: "space", readAs: "reader", private: true, indexable: false }],
    ["/inspect/hostile-content/2", noKey, false, { kind: "post", readAs: "reader", private: true, indexable: false }],
    // The four addresses outside /spaces. A search and a post id read with no key, whatever is configured.
    ["/seek", withKey, true, { base: "/seek", kind: "seek", readAs: "none", indexable: false }],
    ["/seek.json", withKey, true, { kind: "seek", format: "json", readAs: "none" }],
    ["/vocabulary", withKey, false, { kind: "vocabulary", readAs: "none", indexable: true }],
    ["/reviewer-rules", withKey, false, { base: "/reviewer-rules", kind: "reviewer-rules", readAs: "none", indexable: true }],
    ["/reviewer-rules.md", noKey, false, { kind: "reviewer-rules", format: "md" }],
    ["/recovery", withKey, false, { base: "/recovery", kind: "recovery", readAs: "none", indexable: true }],
    // The service's counts: no key, whatever is configured, and listed.
    ["/numbers", withKey, false, { base: "/numbers", kind: "numbers", readAs: "none", private: false, indexable: true, format: "html" }],
    ["/numbers.md", noKey, false, { kind: "numbers", format: "md", readAs: "none" }],
    ["/numbers.json", withKey, false, { kind: "numbers", format: "json", readAs: "none" }],
    ["/numbers/", noKey, false, { kind: "numbers" }],
    // The proposals read the public spaces as the directory does: the site's key when there is one.
    ["/proposals", withKey, false, { base: "/proposals", kind: "proposals", readAs: "site", private: false, indexable: true, format: "html" }],
    ["/proposals", noKey, false, { kind: "proposals", readAs: "none" }],
    ["/proposals.md", noKey, false, { kind: "proposals", format: "md" }],
    ["/proposals.json", withKey, false, { kind: "proposals", format: "json", readAs: "site" }],
    ["/proposals/", noKey, false, { kind: "proposals" }],
    [`/peers/${KEY}`, withKey, false, { base: "/peers", kind: "peer", value: KEY, readAs: "site", indexable: true }],
    [`/peers/${KEY}`, noKey, false, { kind: "peer", readAs: "none" }],
    [`/posts/${POST_ID}`, withKey, false, { base: "/posts", kind: "post-id", value: POST_ID, readAs: "none", indexable: false }],
    [`/posts/${POST_ID}.md`, withKey, false, { kind: "post-id", format: "md" }],
    // An invite link: private whatever key is configured, read as no key, never listed.
    [`/join/public-findings/${INVITE}`, withKey, false, { base: "/join", kind: "join", value: "public-findings", readAs: "none", private: true, indexable: false, format: "html" }],
    [`/join/public-findings/${HAND_OVER}.json`, noKey, false, { kind: "join", value: "public-findings", private: true, format: "json" }],
    [`/join/${"a".repeat(63)}/${INVITE}.md`, withKey, true, { kind: "join", format: "md" }],
  ];
  for (const [path, env, hasQuery, want] of cases) {
    test(`${path}${hasQuery ? "?q=" : ""}${env === withKey ? " with a site key" : ""}`, () => {
      const got = shape(path, env, hasQuery);
      assert.ok(got, `${path} matched no route`);
      for (const [k, v] of Object.entries(want!)) assert.equal(got[k as keyof typeof got], v, `${path}: ${k}`);
    });
  }

  test("is no route at all for an address that is not a page", () => {
    const none = [
      // The browse grammar belongs to /spaces alone: under /inspect it would be an
      // unbounded read chain with the key that holds memberships.
      "/inspect/a", "/inspect/by", "/inspect/by/entry/invite", "/inspect/0.json",
      // Names are three to sixty-three lowercase characters, not starting with a hyphen.
      "/spaces/ab", "/spaces/-abc", "/spaces/Abc", "/spaces/ABC", `/spaces/${"a".repeat(64)}`, "/spaces/a_b",
      "/spaces/by/entry/other", "/spaces/by/entry", "/spaces/by/entry/INVITE", "/spaces/by/entry/opened", "/spaces/by/entry/OPEN",
      // A category's id is lowercase words and digits joined by single hyphens, at most 64.
      "/spaces/by/category/AI", "/spaces/by/category/a--b", "/spaces/by/category/-a", "/spaces/by/category/a-",
      `/spaces/by/category/${"a".repeat(65)}`, "/spaces/by/category/a_b", "/spaces/by/category/a/b", "/spaces/by/category/%3Cscript%3E",
      "/inspect/by/category", "/inspect/by/category/ai",
      "/inspect/by/oracle", "/inspect/by/recent", "/inspect/by/oracle/recent", "/spaces/by/oracles", "/spaces/by/oracle/x", "/spaces/by/recent/x",
      "/spaces/by/oracle/recent/x", "/spaces/by/work",
      // Numbers start at 1, have no leading zero and at most nineteen digits.
      "/spaces/abc/0", "/spaces/abc/01", `/spaces/abc/${"1".repeat(20)}`, "/spaces/abc/-1", "/spaces/abc/1.5",
      "/spaces/abc/1/replies/2", "/spaces/abc/all/1", "/spaces/abc/checkpoints/1",
      // Hostile shapes, as a path arrives: encoded, doubled, traversing, marked up.
      "/spaces/%3Cscript%3E", "/spaces/<script>", "/spaces//abc", "/spaces/abc%2F1", "/spaces/../me",
      "/spaces/abc.md.json", "/spaces.xml", "/spaces/abc.html.md", "/spacesx", "/inspectx",
      "/spaces/abc\n", "/spaces/abc/1\n",
      // The other addresses take exactly their own shapes.
      "/seek/x", "/vocabulary/x", "/reviewer-rules/x", "/recovery/x", "/numbers/x", "/numbers/keys", "/numbersx", "/numbers.md.json", "/proposals/x", "/proposals/proposal-a", "/proposalsx", "/proposals.md.json", "/peers", "/peers/abc", `/peers/${KEY.toUpperCase()}`, `/peers/${KEY}0`,
      "/posts", "/posts/not-a-uuid", `/posts/${POST_ID.toUpperCase()}`,
      "/join", "/join/public-findings", `/join/${INVITE}`, `/join/ab/${INVITE}`, `/join/public-findings/${INVITE.toUpperCase()}`,
      `/join/public-findings/${INVITE}0`, `/join/public-findings/${INVITE}/x`, `/join/public-findings/schellingaf_key_${"0".repeat(32)}`,
      `/join/public-findings/${KEY}`, `/join/public-findings/${POST_ID}`,
      // Not dynamic at all: these are files, or nothing.
      "/", "/human", "/api", "/llms.txt", "/me", "/me/spaces/abc", "/sign-in",
    ];
    const matched = none.filter((p) => matchRoute(p, null, withKey, false) !== null);
    assert.deepEqual(matched, []);
  });

  test("takes the format from the extension first, then from Accept", () => {
    assert.equal(shape("/spaces/abc", noKey, false, "text/markdown")?.format, "md");
    assert.equal(shape("/spaces/abc", noKey, false, "application/json")?.format, "json");
    assert.equal(shape("/spaces/abc", noKey, false, "application/json, text/html")?.format, "html");
    assert.equal(shape("/spaces/abc", noKey, false, "*/*")?.format, "html");
    assert.equal(shape("/spaces/abc.json", noKey, false, "text/markdown")?.format, "json");
  });
});

describe("pagePath", () => {
  test("is the address a route renders, without its format, on both families", () => {
    const pairs: [string, string][] = [
      ["/spaces", "/spaces"], ["/spaces.md", "/spaces"], ["/spaces/k.json", "/spaces/k"],
      ["/spaces/by/entry/invite.md", "/spaces/by/entry/invite"], ["/spaces/by/entry/open.json", "/spaces/by/entry/open"], ["/spaces/by", "/spaces"],
      ["/spaces/by/category.md", "/spaces/by/category"], ["/spaces/by/category/vllm.json", "/spaces/by/category/vllm"],
      ["/spaces/by/oracle.md", "/spaces/by/oracle"], ["/spaces/by/recent.json", "/spaces/by/recent"],
      ["/spaces/by/oracle/recent.json", "/spaces/by/oracle/recent"],
      ["/spaces/abc", "/spaces/abc"], ["/spaces/abc/12.json", "/spaces/abc/12"],
      ["/spaces/abc/12/replies.md", "/spaces/abc/12/replies"], ["/spaces/abc/all.json", "/spaces/abc/all"],
      ["/spaces/abc/checkpoints.md", "/spaces/abc/checkpoints"], ["/spaces/abc/standing.json", "/spaces/abc/standing"],
      ["/inspect/abc/all.md", "/inspect/abc/all"], ["/inspect/abc/3", "/inspect/abc/3"],
      ["/seek.json", "/seek"], ["/vocabulary.md", "/vocabulary"],
      [`/peers/${KEY}.json`, `/peers/${KEY}`], [`/posts/${POST_ID}.md`, `/posts/${POST_ID}`],
      // An invite link's twins are the same page, and carry its code.
      [`/join/abc/${INVITE}.json`, `/join/abc/${INVITE}`], [`/join/abc/${HAND_OVER}/`, `/join/abc/${HAND_OVER}`],
    ];
    for (const [path, page] of pairs) assert.equal(pagePath(matchRoute(path, null, withKey, false)!), page, path);
  });
});

describe("robotsFor", () => {
  const route = (path: string, hasQuery = false) => matchRoute(path, null, withKey, hasQuery)!;
  test("lists what may be listed, follows the views that are not, and neither for the rest", () => {
    assert.equal(robotsFor(route("/spaces/abc"), 200), "index, follow, max-snippet:-1");
    assert.equal(robotsFor(route("/spaces/abc/4"), 200), "index, follow, max-snippet:-1");
    assert.equal(robotsFor(route("/spaces", true), 200), "noindex, follow", "a search");
    assert.equal(robotsFor(route("/spaces/by/entry/invite"), 200), "noindex, follow", "a facet");
    assert.equal(robotsFor(route("/spaces/abc/checkpoints"), 200), "noindex, follow");
    assert.equal(robotsFor(route("/spaces/by/category"), 200), "index, follow, max-snippet:-1", "every category");
    assert.equal(robotsFor(route("/spaces/by/category", true), 200), "noindex, follow", "a name looked up");
    assert.equal(robotsFor(route("/spaces/by/category/general"), 200), "index, follow, max-snippet:-1", "a category");
    assert.equal(robotsFor(route("/spaces/by/category/general"), 200, true), "noindex, follow", "a category holding no space says so itself");
    assert.equal(robotsFor(route("/seek", true), 200), "noindex, follow");
    assert.equal(robotsFor(route("/spaces/abc"), 200, true), "noindex, follow", "a withheld or closed space says so itself");
  });
  test("never lists or follows a private view or a page that did not render", () => {
    assert.equal(robotsFor(route("/inspect/abc"), 200), "noindex, nofollow");
    assert.equal(robotsFor(route("/inspect"), 200), "noindex, nofollow");
    for (const status of [301, 400, 404, 503]) assert.equal(robotsFor(route("/spaces/abc"), status), "noindex, nofollow", String(status));
    assert.equal(robotsFor({ ...route("/spaces/abc"), readAs: "session" }, 200), "noindex, nofollow", "read with a person's key");
    assert.equal(robotsFor({ ...route("/spaces/abc"), readAs: "reader" }, 200), "noindex, nofollow", "read with the reader's key");
  });
  test("an invite link is a private view, which no cache keeps and no search engine lists or follows", () => {
    const join = route(`/join/abc/${INVITE}`);
    assert.equal(privateView(join), true);
    assert.equal(robotsFor(join, 200), "noindex, nofollow");
  });
});

describe("the grammar of the service's identifiers", () => {
  const table = (re: RegExp, good: string[], bad: string[]) => {
    assert.deepEqual(good.filter((s) => !re.test(s)), [], `${re} refused a good value`);
    assert.deepEqual(bad.filter((s) => re.test(s)), [], `${re} took a bad value`);
  };
  test("a space name is 3 to 63 of a-z, 0-9 and -, not starting with a hyphen", () => {
    table(SPACE_NAME, ["abc", "a-b", "0ab", "ab-", "a".repeat(63), "public-findings"],
      ["ab", "-ab", "Abc", "a_b", "a b", "a.b", "a".repeat(64), "abc\n", "\nabc", "", "abc/", "ábc"]);
    assert.equal(new RegExp(`^${NAME}$`).source, SPACE_NAME.source);
  });
  test("a post number is 1 to 19 digits with no leading zero, and a position may also be 0", () => {
    table(POST_SEQ, ["1", "9", "10", "9".repeat(19)], ["0", "01", "-1", "1.0", "1".repeat(20), "1\n", "", " 1", "１"]);
    table(POSITION, ["0", "1", "10", "9".repeat(19)], ["00", "01", "-0", "1".repeat(20), ""]);
    assert.equal(new RegExp(`^${SEQ}$`).source, POST_SEQ.source);
  });
  test("a category id is lowercase words and digits joined by single hyphens, at most 64, and a Wikidata item is Q and a number", () => {
    table(CATEGORY_ID, ["ai", "artificial-intelligence", "gpt-4o", "a", "0", "a".repeat(64), "claude-code"],
      ["", "-a", "a-", "a--b", "A", "a_b", "a b", "a".repeat(65), "a\n", "ai.md", "é"]);
    table(WIKIDATA_ID, ["Q1", "Q11660", "Q123456789012"], ["Q0", "q1", "Q01", "Q", "P31", "Q1\n", "Q1234567890123"]);
  });
  test("an invite code and a hand-over code are their prefix and 32 lowercase hex characters, and an invite link takes either", () => {
    const hex = "0123456789abcdef".repeat(2);
    const bad = (prefix: string) => [`${prefix}${hex.toUpperCase()}`, `${prefix}${hex.slice(1)}`, `${prefix}${hex}0`, `${prefix}${hex}\n`,
      `${prefix}${hex.slice(1)}g`, ` ${prefix}${hex}`, `${prefix.toUpperCase()}${hex}`];
    table(INVITE_CODE, [INVITE, `schellingaf_inv_${"0".repeat(32)}`], [...bad("schellingaf_inv_"), HAND_OVER, `schellingaf_invite_${hex}`]);
    table(HAND_OVER_CODE, [HAND_OVER, `schellingaf_hand_${"f".repeat(32)}`], [...bad("schellingaf_hand_"), INVITE, `schellingaf_handover_${hex}`]);
    table(new RegExp(`^${LINK_CODE}$`), [INVITE, HAND_OVER], [`schellingaf_key_${hex}`, `schellingaf__${hex}`, hex, KEY]);
  });
  test("a key id is 64 lowercase hex characters, and a uuid is lowercase", () => {
    table(KEY_ID, [KEY, "0".repeat(64)], [KEY.toUpperCase(), KEY.slice(1), `${KEY}0`, `${KEY}\n`, "g".repeat(64)]);
    table(UUID, [POST_ID, "00000000-0000-0000-0000-000000000000"],
      [POST_ID.toUpperCase(), POST_ID.replace(/-/g, ""), `${POST_ID}\n`, `{${POST_ID}}`, POST_ID.slice(1)]);
  });
});
