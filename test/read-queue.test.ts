// The site's reads wait their turn rather than spend the product's share at once.
//
// The product lets one caller have six reads in flight with a key and two without, and
// refuses the next with BUSY rather than queueing it. Every visitor reads as the site's
// one caller, so on 1-2 October 2026 a crawler asking for a dozen pages together turned
// 403 of them into 503s. The stand-in here refuses exactly as the product does, and the
// site must never be refused by it, however many pages are asked for together.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { API, json, refusal, stubFetch } from "./lib/service.ts";

process.env.API_ORIGIN = API;

/** A product that answers after `delayMs`, counts each caller's reads in flight and
 *  refuses one past that caller's share with BUSY, as the product's read gate does.
 *  `hold` keeps every answer back until it is let go. */
function product(delayMs: number) {
  const inFlight = new Map<string, number>();
  const most = new Map<string, number>();
  let refused = 0;
  let held: Array<() => void> | null = null;
  const fake = stubFetch(async (call) => {
    const who = call.headers.get("authorization") ?? "no key";
    const share = who === "no key" ? 2 : 6;
    const now = (inFlight.get(who) ?? 0) + 1;
    if (now > share) {
      refused++;
      return refusal(503, "BUSY");
    }
    inFlight.set(who, now);
    most.set(who, Math.max(most.get(who) ?? 0, now));
    try {
      if (held) await new Promise<void>((resolve) => held!.push(resolve));
      else await new Promise((resolve) => setTimeout(resolve, delayMs));
      return json({ items: [], path: call.url.pathname });
    } finally {
      inFlight.set(who, inFlight.get(who)! - 1);
    }
  });
  after(() => fake.restore());
  return {
    fake,
    most: (who: string) => most.get(who) ?? 0,
    refused: () => refused,
    hold() { held = []; },
    letGo() { const h = held ?? []; held = null; for (const go of h) go(); },
  };
}

const p = product(5);
const { apiGet, readLanes, READS_AT_ONCE } = await import("../src/api.ts");
const env = { SITE_TOKEN: "site-token-for-tests", READER_TOKEN: "reader-token-for-tests" };

test("the shares the queue keeps to are the product's: six with a key, two without", () => {
  assert.deepEqual({ ...READS_AT_ONCE }, { key: 6, noKey: 2 });
});

test("forty reads asked for together, as the site's key, are all answered and never more than six run at once", async () => {
  const out = await Promise.all(Array.from({ length: 40 }, (_, i) => apiGet(env, `/v1/spaces/s${i}`, "site")));
  assert.equal(out.filter((r) => r.ok).length, 40);
  assert.equal(p.refused(), 0);
  assert.equal(p.most("Bearer site-token-for-tests"), 6);
  // Every one in order of asking: none was dropped or answered for another.
  out.forEach((r, i) => assert.equal(r.ok && (r.data as { path: string }).path, `/v1/spaces/s${i}`));
});

test("reads with no key keep to two at once", async () => {
  const out = await Promise.all(Array.from({ length: 12 }, () => apiGet(env, "/v1/spaces", "none")));
  assert.equal(out.filter((r) => r.ok).length, 12);
  assert.equal(p.refused(), 0);
  assert.equal(p.most("no key"), 2);
});

test("each caller has its own turn: the site's crowd does not hold back a signed-in person", async () => {
  const site = Array.from({ length: 30 }, () => apiGet(env, "/v1/spaces", "site"));
  const person = apiGet({ ...env, SESSION_TOKEN: "a-person" }, "/v1/me", "session");
  const first = await Promise.race([person.then(() => "person"), Promise.all(site).then(() => "site")]);
  assert.equal(first, "person");
  await Promise.all(site);
  assert.equal(p.refused(), 0);
});

test("a caller's turn is forgotten once nothing of it is in flight or waiting", async () => {
  await Promise.all(Array.from({ length: 10 }, () => apiGet(env, "/v1/spaces", "site")));
  assert.deepEqual(readLanes(), []);
});

test("past the queue's length the read is BUSY at once, and the queue drains afterwards", async () => {
  p.hold();
  const asked = Array.from({ length: 6 + 256 + 1 }, () => apiGet(env, "/v1/spaces", "site"));
  // The last one found six running and 256 waiting.
  const last = await asked.at(-1)!;
  assert.equal(last.ok, false);
  assert.equal(!last.ok && last.code, "BUSY");
  assert.deepEqual(readLanes(), [{ running: 6, waiting: 256 }]);
  p.letGo();
  // Each one let go hands its place to the next, which the stand-in holds again
  // only while `hold` is on; it is off now, so the rest answer in turn.
  const rest = await Promise.all(asked.slice(0, -1));
  assert.equal(rest.filter((r) => r.ok).length, 6 + 256);
  assert.equal(p.refused(), 0);
  assert.deepEqual(readLanes(), []);
});

test("a read that waits four seconds for its turn is BUSY, and takes nobody's place", async () => {
  p.hold();
  const running = Array.from({ length: 6 }, () => apiGet(env, "/v1/spaces", "site"));
  const started = Date.now();
  const waited = await apiGet(env, "/v1/spaces", "site");
  assert.equal(!waited.ok && waited.code, "BUSY");
  assert.ok(Date.now() - started >= 3900, "it waited its four seconds first");
  assert.deepEqual(readLanes(), [{ running: 6, waiting: 0 }]);
  p.letGo();
  assert.equal((await Promise.all(running)).filter((r) => r.ok).length, 6);
  assert.deepEqual(readLanes(), []);
  assert.equal(p.refused(), 0);
});
