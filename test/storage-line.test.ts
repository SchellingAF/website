// The one line of storage on a space's page, from the service's funding answer: it renders
// from a good answer in the page, the markdown and the JSON, is left out silently on every
// kind of failure, escapes, and costs exactly one extra read.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, CATEGORIES, json, refusal, service, unanswered, type Json, type World } from "./lib/service.ts";
import { SITE, env, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const space = (name: string): Json => ({
  name, space_id: "0199a0a0-0000-7000-8000-000000000001", title: `The ${name}`, description: "Work.", visibility: "public",
  join_policy: "request", status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: OWNER,
  contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-10-01T09:00:00.000Z",
});
const funding = (over: Json = {}): Json => ({
  space: "x", visibility: "public", billing: "not_started",
  bytes: { posts: 2034000, files: 10400000, total: 12434000 }, allowance_bytes: 25000000, over_bytes: 0,
  rate: { micro_usd_per_gb_month: 5000000, days_per_month: 30, bytes_per_gb: 1000000000 },
  would_be_billed_per_day_micro_usd: 0,
  last_day: { day: "2026-10-07", over_allowance: false, billable_bytes: null, would_be_billed_micro_usd: 0 },
  notice: "Billing has not started: nothing is taken and no balance is kept.",
  ...over,
});
const names = ["store-ok", "store-over", "store-null", "store-none", "store-bad", "store-down", "store-count", "store-evil", "store-held"];
const world: World = {
  capabilities: CAPABILITIES, categories: CATEGORIES,
  spaces: names.map(space),
  posts: Object.fromEntries(names.map((n) => [n, []])),
  funding: {
    "store-ok": funding(),
    "store-count": funding(),
    "store-held": funding(),
    "store-over": funding({ bytes: { posts: 1, files: 1, total: 31200000 }, over_bytes: 6200000, last_day: { day: "2026-10-07", over_allowance: true, billable_bytes: 6000000, would_be_billed_micro_usd: 1000 } }),
    "store-null": funding({ last_day: null }),
    "store-evil": funding({ billing: "<img src=x onerror=alert(1)>" }),
  },
  proofs: {}, checkpoints: {}, peers: {},
};
const base = service(world);
const { fake, handleRequest } = await site((call) => {
  if (call.url.pathname === "/v1/spaces/store-bad/funding") return json({ notice: "no figures here" });
  if (call.url.pathname === "/v1/spaces/store-down/funding") return refusal(500, "INTERNAL", "the service is unwell");
  if (call.url.pathname === "/v1/spaces/store-evil/funding") return json(funding({ bytes: { total: "<script>1</script>" } }));
  return base(call);
});
const { storageLine, megabytes, dollars } = await import("../src/storage-line.ts");

async function get(path: string) {
  const res = await handleRequest(new Request(`${SITE}${path}`), { ...env, SITE_TOKEN: "site-token-for-tests" });
  return { status: res.status, text: await res.text() };
}
const FREE = "Storage: 12.4 MB of 25 MB free. Billing has not started.";

describe("the storage line on a space's page", () => {
  test("it shows from a funding answer, in the page, the markdown and the JSON", async () => {
    const html = await get("/spaces/store-ok");
    assert.equal(html.status, 200);
    assert.match(html.text, new RegExp(`<p class="meta">${FREE.replace(/\./g, "\\.")}</p>`));
    assert.match((await get("/spaces/store-ok.md")).text, new RegExp(`- storage: ${FREE.replace(/\./g, "\\.")}`));
    assert.equal(JSON.parse((await get("/spaces/store-ok.json")).text).storage, FREE);
  });

  test("over the allowance it says what the last day would have been billed", async () => {
    const t = (await get("/spaces/store-over")).text;
    assert.match(t, /Storage: 31\.2 MB, 6\.2 MB over the 25 MB free\. Billing has not started\. On 2026-10-07 it would have been billed \$0\.001\./);
  });

  test("a null last day adds nothing", async () => {
    assert.match((await get("/spaces/store-null")).text, /Storage: 12\.4 MB of 25 MB free\. Billing has not started\.<\/p>/);
  });

  test("it is left out, and the page still renders, on a 404, a refusal, a wrong shape and a 500", async () => {
    for (const n of ["store-none", "store-bad", "store-down", "store-evil"]) {
      const r = await get(`/spaces/${n}`);
      assert.equal(r.status, 200, n);
      assert.doesNotMatch(r.text, /Storage:/, n);
      assert.match(r.text, new RegExp(`The ${n}`), n);
    }
  });

  test("it makes one read for the answer and none more", async () => {
    const before = fake.calls.length;
    await get("/spaces/store-count");
    const mine = fake.calls.slice(before).filter((c) => c.url.pathname.endsWith("/funding"));
    assert.equal(mine.length, 1);
  });

  test("read without a person's key, the line is held: another view of the space reads it again from memory", async () => {
    const before = fake.calls.length;
    await get("/spaces/store-held");
    await get("/spaces/store-held.md");
    await get("/spaces/store-held?kind=result");
    const mine = fake.calls.slice(before).filter((c) => c.url.pathname.endsWith("/funding"));
    assert.equal(mine.length, 1);
    assert.match((await get("/spaces/store-held.md")).text, /- storage: Storage: 12\.4 MB/);
  });

  test("the words are plain and carry no markup of their own", () => {
    assert.equal(storageLine(funding({ billing: "<b>" })), null);
    assert.equal(storageLine(null), null);
    assert.equal(storageLine({ billing: "not_started", bytes: { total: -1 }, allowance_bytes: 1, over_bytes: 0 }), null);
    assert.equal(storageLine(funding({ last_day: { day: "<b>", over_allowance: true, would_be_billed_micro_usd: 5 } })), FREE);
  });

  test("money is whole-number arithmetic", () => {
    assert.equal(dollars(30000), "$0.03");
    assert.equal(dollars(1), "$0.000001");
    assert.equal(dollars(1500000), "$1.50");
    assert.equal(dollars(12000000), "$12.00");
    assert.equal(megabytes(25000000), "25 MB");
    assert.equal(megabytes(12434000), "12.4 MB");
  });

  test("the stand-in answered every address asked", () => {
    assert.deepEqual(unanswered, []);
  });
});
