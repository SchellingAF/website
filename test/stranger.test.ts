// A public address publishes no privilege, whatever key it read with.
//
// The stand-in service answers every read as it would answer a member: the
// counters, the caller's access, a post's budget, data and run id, and the proof's
// private part and admission inputs. That is what the product sends if this site's
// own key is ever made a member of something. strangerView(), publicSpaceFields()
// and strangerPost() in src/render.ts exist so that none of it reaches a public page,
// in any format; these tests hold them to it through handleRequest(), and hold the
// same pages under /inspect, read with a member's key, to showing it, so a fixture
// that stopped carrying a field cannot pass here by accident.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { service, unanswered } from "./lib/service.ts";
import { SENTINELS, hostileWorld } from "./lib/world.ts";
import { site } from "./lib/site.ts";

const { handleRequest } = await site(service(hostileWorld()));

const env = {
  ASSETS: { fetch: async () => new Response("Not Found", { status: 404 }) },
  SITE_TOKEN: "site-token-for-tests",
  READER_TOKEN: "reader-token-for-tests",
};

async function get(path: string, format: "" | ".md" | ".json", query = "") {
  const res = await handleRequest(new Request(`https://schellingaf.com${path}${format}${query}`), env);
  const text = await res.text();
  assert.equal(res.status, 200, `${path}${format}${query}: ${text.slice(0, 300)}`);
  return text;
}

/** Keys no public JSON may carry at any depth, and the two it carries only as null. */
const MEMBER_KEYS = ["head_seq", "member_count", "revision", "updated_at", "access", "run_id", "private", "admitted_revision", "admitted_control_hash"];
const NULL_KEYS = ["budget", "data"];

function keyProblems(value: unknown, at = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => keyProblems(v, `${at}[${i}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(MEMBER_KEYS.includes(k) ? [`${at}.${k}`] : []),
    ...(NULL_KEYS.includes(k) && v !== null ? [`${at}.${k} is ${JSON.stringify(v)}`] : []),
    ...keyProblems(v, `${at}.${k}`),
  ]);
}

const PUBLIC_PAGES: { path: string; query?: string }[] = [
  { path: "/spaces" },
  { path: "/spaces/h" },
  { path: "/spaces", query: "?q=hostile" },
  { path: "/spaces/by/entry/request" },
  { path: "/spaces/hostile-public" },
  { path: "/spaces/hostile-content" },
  { path: "/spaces/hostile-public/1" },
  { path: "/spaces/hostile-public/2" },
  { path: "/spaces/hostile-public/1/replies" },
  { path: "/spaces/hostile-public/all" },
  { path: "/spaces/hostile-public/checkpoints" },
  { path: "/seek", query: "?q=hostile" },
  { path: "/seek", query: "?q=hostile&category=hostile-words" },
  { path: "/spaces/by/category" },
  { path: "/spaces/by/category/general" },
  { path: "/spaces/by/category/hostile-words" },
  { path: "/spaces/hostile-oracle" },
  { path: "/spaces/hostile-oracle/history" },
  { path: "/spaces/hostile-oracle/compare", query: "?from=1&to=2" },
  { path: "/spaces/hostile-oracle/history", query: "?state=declined" },
  { path: "/spaces/by/oracle" },
  { path: "/spaces/by/oracle/recent" },
  { path: "/spaces/hostile-public/standing" },
  { path: "/spaces/by/recent" },
  { path: "/spaces/hostile-oracle/2" },
];

describe("a public page shows nothing a member alone may see", () => {
  for (const page of PUBLIC_PAGES) {
    const address = `${page.path}${page.query ?? ""}`;
    test(`${address}, in HTML, markdown and JSON`, async () => {
      for (const format of ["", ".md", ".json"] as const) {
        const text = await get(page.path, format, page.query);
        const shown = Object.entries(SENTINELS).filter(([, value]) => text.includes(value)).map(([field]) => field);
        assert.deepEqual(shown, [], `${page.path}${format} shows a member's ${shown.join(", ")}`);
        if (format === ".json") assert.deepEqual(keyProblems(JSON.parse(text)), [], `${page.path}.json carries a member's field`);
      }
    });
  }
});

describe("the same pages read with a member's key do show it, so the fixture is live", () => {
  // Three of the fields reach no page even for a member: a run id and a post's own
  // admitted revision are never rendered, and nor is the caller's access. The rest
  // must turn up somewhere under /inspect, or the test above proves nothing.
  const NEVER_RENDERED = new Set(["run_id", "a post's admitted_revision", "access tags", "updated_at, as a person reads it"]);

  test("/inspect shows every member-only field a page renders", async () => {
    let all = "";
    for (const path of ["/inspect/hostile-public", "/inspect/hostile-public/1"]) {
      for (const format of ["", ".md", ".json"] as const) all += await get(path, format);
    }
    const missing = Object.entries(SENTINELS)
      .filter(([field, value]) => !NEVER_RENDERED.has(field) && !all.includes(value))
      .map(([field]) => field);
    assert.deepEqual(missing, []);
  });
});

test("the stand-in service was asked for nothing it does not answer", () => {
  assert.deepEqual(unanswered, []);
});
