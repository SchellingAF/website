// A space's funding: the section on its page, the funding page and its twin under /me, the
// coin picker and its POST, the numbers group, and the statements every funding page makes.
// The product's funding answers are fixtures in the shape of its contract; nothing here
// needs the product running.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, CATEGORIES, json, refusal, service, unanswered, type Call, type Json, type World } from "./lib/service.ts";
import { htmlProblems } from "./lib/documents.ts";
import { SITE, env, signedIn, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const ME = "c".repeat(64);
const space = (name: string, over: Json = {}): Json => ({
  name, space_id: "0199a0a0-0000-7000-8000-000000000001", title: `The ${name}`, description: "Work.", visibility: "public",
  join_policy: "request", status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"], owner: OWNER,
  contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-10-01T09:00:00.000Z", ...over,
});

const coin = (c: string, symbol: string, network: string, minimum: string, cheap: boolean, stable: boolean, family = "evm"): Json =>
  ({ coin: c, symbol, name: symbol, network, family, minimum, cheap, stable });
const COINS: Json[] = [
  coin("erc20/usdc", "USDC", "Ethereum", "10", false, true),
  coin("eth/eth", "ETH", "Ethereum", "0.005", false, false),
  coin("base/usdc", "USDC", "Base", "3", true, true),
  coin("base/eth", "ETH", "Base", "0.0003", true, false),
  coin("trc20/usdt", "USDT", "Tron", "5", false, true, "tron"),
  coin("btc/btc", "BTC", "Bitcoin", "0.0005", false, false, "btc"),
];
// The coins the product says are ready to pay: one with an address made, two without.
const READY = ["base/usdc", "btc/btc", "trc20/usdt"].map((t) => COINS.find((c) => c.coin === t)!);
const ADDRESS_A = `0x${"ab".repeat(20)}`;
/** The address the stand-in makes for a coin. */
const addrFor = (c: string): string => `Made${c.replace(/[^a-z0-9]/gi, "")}`.padEnd(30, "x");
const ADDRESS_T = `T${"Q".repeat(33)}`;
const address = (c: string, a: string, over: Json = {}): Json => {
  const found = COINS.find((x) => x.coin === c)!;
  return { coin: c, symbol: found.symbol, network: found.network, family: found.family, address: a, minimum: found.minimum,
    cheap: found.cheap, stable: found.stable, current: true, created_at: "2026-10-08T09:00:00.000Z", ...over };
};
const full = (name: string, visibility: string, over: Json = {}): Json => ({
  space: name, visibility, billing: "not_started", deposits_open: true,
  addresses: [address("base/usdc", ADDRESS_A)], ready_coins: READY, coins: COINS, minimums_as_of: "2026-10-08",
  make_address: "POST /v1/spaces/{name}/funding/addresses with {\"coin\": …}",
  bytes: { posts: 2034000, files: 10400000, total: 12434000 }, allowance_bytes: 25000000, over_bytes: 0,
  rate: { micro_usd_per_gb_month: 5000000, days_per_month: 30, bytes_per_gb: 1000000000 },
  would_be_billed_per_day_micro_usd: 0,
  last_day: { day: "2026-10-07", over_allowance: false, billable_bytes: null, would_be_billed_micro_usd: 0 },
  balance_micro_usd: 12500000, days_left: null,
  deposits: {
    pending: [{ coin: "base/usdc", txid_in: "0xfeed", value_coin: "4", seen_at: "2026-10-08T10:00:00.000Z" }],
    held: [{ coin: "erc20/usdc", txid_in: "0xheld", value_forwarded_coin: "150", usd_micro: 150000000, reason: "reviewed first", seen_at: "2026-10-08T10:05:00.000Z" }],
    rejected: [],
    pending_count: 1, held_count: 1, rejected_count: 0, credited_count: 2,
  },
  history: "GET /v1/spaces/{name}/funding/history",
  notice: "Billing has not started.",
  ...over,
});
const addressesOnly = (name: string, visibility: string, over: Json = {}): Json => ({
  space: name, visibility, billing: "not_started", deposits_open: true,
  addresses: [address("base/usdc", ADDRESS_A)], ready_coins: READY, coins: COINS, minimums_as_of: "2026-10-08",
  make_address: "POST /v1/spaces/{name}/funding/addresses with {\"coin\": …}",
  members_only: ["bytes", "balance", "deposits", "history"], notice: "Billing has not started.", ...over,
});

const entries = (from: number, to: number): Json[] => Array.from({ length: from - to + 1 }, (_, i) => {
  const id = from - i;
  return {
    entry_id: String(id), kind: "deposit", amount_micro_usd: 1500000, balance_after_micro_usd: id * 1500000, at: "2026-10-08T09:00:00.000Z",
    deposit: { coin: "base/usdc", network: "Base", txid_in: `0xtx${id}`, value_forwarded_coin: "1.5", address: ADDRESS_A },
  };
});

const names = ["fund-pub", "fund-none", "fund-closed", "fund-old", "fund-bad", "fund-priv", "fund-sealed", "fund-mine", "fund-held", "fund-count", "fund-denied", "fund-repl", "fund-nullfwd", "fund-fail", "fund-slow", "fund-shut"];
const shape: Record<string, Json> = {
  "fund-priv": { visibility: "private" },
  "fund-sealed": { visibility: "sealed" },
  "fund-mine": { visibility: "private", access: { role: "writer", tags: [], read: true, post: true } },
  "fund-denied": { visibility: "private" },
  "fund-repl": { replaced_by: "fund-next" },
};
const world: World = {
  capabilities: CAPABILITIES, categories: CATEGORIES,
  spaces: names.map((n) => space(n, shape[n] ?? {})),
  posts: Object.fromEntries(names.map((n) => [n, []])),
  funding: {
    "fund-pub": full("fund-pub", "public", { addresses: [address("base/usdc", ADDRESS_A), address("trc20/usdt", ADDRESS_T, { current: false })] }),
    "fund-none": full("fund-none", "public", { addresses: [] }),
    "fund-closed": full("fund-closed", "public", { deposits_open: false, addresses: [], coins: [] }),
    "fund-old": { space: "fund-old", visibility: "public", billing: "not_started", bytes: { posts: 1, files: 1, total: 12434000 }, allowance_bytes: 25000000, over_bytes: 0, last_day: null, notice: "x" },
    "fund-priv": addressesOnly("fund-priv", "private"),
    "fund-sealed": addressesOnly("fund-sealed", "sealed"),
    "fund-mine": full("fund-mine", "private"),
    "fund-held": full("fund-held", "public"),
    "fund-count": full("fund-count", "public"),
    "fund-denied": addressesOnly("fund-denied", "private"),
    "fund-repl": full("fund-repl", "public", { credited_to: { space_id: "0199a0a0-0000-7000-8000-000000000002", name: "fund-next" } }),
    "fund-nullfwd": full("fund-nullfwd", "public"),
    "fund-fail": full("fund-fail", "public", { addresses: [] }),
    "fund-slow": full("fund-slow", "public", { addresses: [] }),
    "fund-shut": full("fund-shut", "public", { addresses: [] }),
  },
  proofs: {}, checkpoints: {}, peers: {},
};
const base = service(world);
const posted: { path: string; body: unknown; auth: string | null }[] = [];
const { fake, handleRequest } = await site((call: Call) => {
  const p = call.url.pathname;
  // The product sends the coins only when asked for with coins=true.
  const m = p.match(/^\/v1\/spaces\/(fund-[a-z]+)\/funding$/);
  if (m && call.url.searchParams.get("coins") !== "true" && m[1] !== "fund-bad") {
    const r = base(call);
    const body = r instanceof Promise ? undefined : r;
    const answer = world.funding![m[1]!];
    if (answer && body && body.status === 200) { const { coins: _c, minimums_as_of: _m, ...plain } = answer as Record<string, unknown>; return json(plain as Json); }
    return r;
  }
  if (p === "/v1/spaces/fund-denied/posts") return refusal(403, "READ_DENIED", "not a member");
  if (p === "/v1/spaces/fund-bad/funding") return json({ ...full("fund-bad", "public"), balance_micro_usd: -5 });
  if (/^\/v1\/spaces\/fund-nullfwd\/funding\/history$/.test(p)) {
    const e = entries(2, 1);
    (e[0]!.deposit as Json).value_forwarded_coin = null;
    return json({ space: "fund-nullfwd", entries: e, has_more: false, next_before: null });
  }
  if (/^\/v1\/spaces\/(fund-pub|fund-mine|fund-closed|fund-repl|fund-none|fund-fail|fund-slow|fund-shut)\/funding\/history$/.test(p)) {
    const before = Number(call.url.searchParams.get("before") ?? "1000");
    const page = entries(Math.min(before - 1, 120), Math.max(Math.min(before - 1, 120) - 49, 1));
    const last = Number(page.at(-1)!.entry_id);
    return json({ space: p.split("/")[3], entries: page, has_more: last > 1, next_before: last > 1 ? String(last) : null });
  }
  if (p === "/v1/spaces/fund-count/funding/history") return refusal(500, "INTERNAL", "unwell");
  const made = p.match(/^\/v1\/spaces\/(fund-[a-z]+)\/funding\/addresses$/);
  if (call.method === "POST" && made) {
    const body = JSON.parse(call.body ?? "{}") as { coin: string };
    posted.push({ path: p, body, auth: call.headers.get("authorization") });
    if (body.coin === "nope/coin") return refusal(400, "COIN_NOT_OFFERED", "not offered");
    if (body.coin === "closed/x" || made[1] === "fund-fail") return refusal(503, "FUNDING_UNAVAILABLE", "closed");
    if (made[1] === "fund-shut") return refusal(409, "SPACE_CLOSED", "closed");
    if (body.coin === "fast/x") {
      const r = refusal(429, "RATE_LIMITED", "slow down");
      r.headers.set("Retry-After", "42");
      return r;
    }
    // The product does not answer at all.
    if (made[1] === "fund-slow") throw new Error("the service is not reached");
    return json({ space: made[1]!, created: true, address: address(body.coin, addrFor(body.coin)), minimums_as_of: "2026-10-08", notice: "Send only this coin on this network." }, 201);
  }
  return base(call);
});
const { cookie, csrf } = await signedIn(ME, "funding-token", "192.0.2.77");
const { fundingSection, readFunding, readHistory, statements, statementParts, money } = await import("../src/funding-section.ts");
const { networksOf } = await import("../src/funding-render.ts");

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await handleRequest(new Request(`${SITE}${path}`, { headers }), { ...env, SITE_TOKEN: "site-token-for-tests" });
  return { status: res.status, text: await res.text(), headers: res.headers };
}
const signed = (path: string) => get(path, { Cookie: cookie });
async function post(path: string, fields: Record<string, string>) {
  const res = await handleRequest(new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, ...fields }).toString(),
  }), env);
  return { res, text: await res.text() };
}

describe("fundingSection reads the funding answer exactly", () => {
  test("a full answer gives the storage line, the balance, what is incoming and held, and the addresses", () => {
    const s = fundingSection(full("fund-pub", "public"))!;
    assert.equal(s.storage, "Storage: 12.4 MB of 25 MB free. Billing has not started.");
    assert.equal(s.balance, "Balance: $12.50.");
    assert.equal(s.incoming, "1 deposit incoming, not yet credited.");
    assert.equal(s.held, "1 deposit held, not credited.");
    assert.deepEqual(s.addresses, [{ coin: "base/usdc", symbol: "USDC", network: "Base", address: ADDRESS_A, minimum: "3", older: false }]);
    assert.equal(s.membersOnly, false);
  });

  test("two or more deposits are said in the plural, none are not said at all", () => {
    const s = fundingSection(full("x-space", "public", { deposits: { pending: [], held: [], rejected: [], pending_count: 3, held_count: 0, rejected_count: 0, credited_count: 0 } }))!;
    assert.equal(s.incoming, "3 deposits incoming, not yet credited.");
    assert.equal(s.held, null);
  });

  test("an addresses-only answer has no storage, balance or deposits and says members only", () => {
    const s = fundingSection(addressesOnly("fund-priv", "private"))!;
    assert.equal(s.storage, null);
    assert.equal(s.balance, null);
    assert.equal(s.membersOnly, true);
    assert.equal(s.addresses!.length, 1);
  });

  test("an answer that carries byte figures beside members_only, or a balance beside it, is not read", () => {
    assert.equal(fundingSection(addressesOnly("fund-priv", "private", { bytes: { posts: 1, files: 1, total: 2 }, allowance_bytes: 1, over_bytes: 0 })), null);
    assert.equal(fundingSection(addressesOnly("fund-priv", "private", { balance_micro_usd: 5 })), null);
  });

  test("an address from an older wallet is marked, and deposits closed or none made are told apart", () => {
    const old = fundingSection(full("x-space", "public", { addresses: [address("base/usdc", ADDRESS_A, { current: false })] }))!;
    assert.equal(old.addresses![0]!.older, true);
    assert.equal(fundingSection(full("x-space", "public", { addresses: [] }))!.addresses!.length, 0);
    assert.equal(fundingSection(full("x-space", "public", { deposits_open: false, coins: [] }))!.depositsOpen, false);
  });

  test("an older service's answer reads as storage alone", () => {
    const s = fundingSection(world.funding!["fund-old"])!;
    assert.equal(s.addresses, null);
    assert.match(s.storage!, /^Storage: 12\.4 MB/);
  });

  test("anything out of shape is no section", () => {
    for (const bad of [
      null, "x", [], {},
      full("x-space", "public", { balance_micro_usd: -1 }),
      full("x-space", "public", { balance_micro_usd: 1.5 }),
      full("x-space", "public", { minimums_as_of: "yesterday" }),
      full("x-space", "public", { deposits_open: "true" }),
      full("x-space", "public", { billing: "bogus" }),
      full("x-space", "public", { addresses: "none" }),
      full("x-space", "public", { coins: {} }),
      full("x-space", "public", { deposits: { pending: "none", held: [], rejected: [], pending_count: 1, held_count: 0, rejected_count: 0, credited_count: 0 } }),
    ]) assert.equal(fundingSection(bad), null, JSON.stringify(bad)?.slice(0, 80));
  });

  test("real product answers: USD\u20ae0 coins, a dropped coin's null fields, a long txid", () => {
    const usdt0 = ["arbitrum", "bera", "optimism"].map((n) => coin(`${n}/usdt0`, "USDT0", n, "1", true, true));
    for (const c of usdt0) c.name = "USD\u20ae0";
    const dropped = { ...address("base/usdc", ADDRESS_A), coin: "base/old", symbol: null, network: null, minimum: null, cheap: false, stable: false };
    const txid = "0x" + "ab".repeat(99);
    const answer = full("x-space", "public", {
      coins: [...COINS, ...usdt0], addresses: [address("base/usdc", ADDRESS_A), dropped],
      deposits: {
        pending: [{ coin: "Arbitrum_USDC.e", txid_in: txid, value_coin: "4", seen_at: "2026-10-08T10:00:00.000Z" }],
        held: [], rejected: [], pending_count: 1, held_count: 0, rejected_count: 0, credited_count: 0,
      },
    });
    const f = readFunding(answer)!;
    assert.ok(f, "one \u20ae in a coin name must not drop the section");
    assert.equal(f.coins.length, COINS.length + 3);
    assert.equal(f.addresses!.length, 2);
    assert.equal(f.addresses![1]!.symbol, null);
    assert.equal(f.balance!.pending[0]!.txid_in, txid);
    assert.equal(fundingSection(answer)!.addresses!.length, 2);
  });

  test("an item out of shape is left out, never the section", () => {
    const bad = [{ ...COINS[0]!, minimum: "ten" }, { ...COINS[1]!, symbol: "A\u0000B" }, { ...COINS[2]!, name: "x\u2028y" }];
    const f = readFunding(full("x-space", "public", {
      coins: [...bad, COINS[3]], addresses: [{ ...address("base/usdc", ADDRESS_A), address: "<script>" }, address("base/usdc", ADDRESS_A)],
      deposits: { pending: [{ coin: "base/usdc" }], held: [], rejected: [], pending_count: 1, held_count: 0, rejected_count: 0, credited_count: 0 },
    }))!;
    assert.ok(f);
    assert.equal(f.coins.length, 1);
    assert.equal(f.addresses!.length, 1);
    assert.equal(f.balance!.pending.length, 0);
    const h = readHistory({ entries: [{ ...entries(1, 1)[0], kind: "<b>" }, ...entries(5, 4)], has_more: false, next_before: null })!;
    assert.equal(h.entries.length, 2);
  });

  test("money is formatted by dollars(), and a debit keeps its sign", () => {
    assert.equal(money(12500000), "$12.50");
    assert.equal(money(1), "$0.000001");
    assert.equal(money(-30000), "-$0.03");
  });

  test("the history reads whole or not at all", () => {
    const ok = readHistory({ space: "x-space", entries: entries(3, 1), has_more: false, next_before: null })!;
    assert.equal(ok.entries.length, 3);
    assert.equal(ok.hasMore, false);
    assert.equal(readHistory({ entries: "none", has_more: false, next_before: null }), null);
    assert.equal(readHistory({ entries: [], has_more: "no", next_before: null }), null);
    assert.equal(readHistory({ entries: [], has_more: true, next_before: "abc" }), null);
  });
});

describe("the funding section on a space's page", () => {
  test("it appears in the page, the markdown and the JSON with the same content", async () => {
    const html = (await get("/spaces/fund-pub")).text;
    assert.match(html, /<section id="funding">\s*<h2>Funding<\/h2>/);
    assert.match(html, /<p class="meta">Storage: 12\.4 MB of 25 MB free\. Billing has not started\.<\/p>/);
    assert.match(html, /<p>Balance: \$12\.50\. 1 deposit incoming, not yet credited\. 1 deposit held, not credited\.<\/p>/);
    assert.ok(html.includes(`<li>USDC on Base: <code>${ADDRESS_A}</code>, minimum 3 USDC</li>`));
    assert.ok(html.includes(`<li>USDT on Tron: <code>${ADDRESS_T}</code>, minimum 5 USDT <span class="meta">(older wallet, still credited)</span></li>`));
    assert.match(html, /<a href="\/spaces\/fund-pub\/funding">Send credit to this space<\/a>/);
    assert.deepEqual(htmlProblems(html), []);

    const md = (await get("/spaces/fund-pub.md")).text;
    assert.match(md, /- storage: Storage: 12\.4 MB of 25 MB free\. Billing has not started\./);
    assert.match(md, /- funding: Balance: \$12\.50\. 1 deposit incoming, not yet credited\. 1 deposit held, not credited\./);
    assert.ok(md.includes(`- deposit address: \`USDC\` on \`Base\`: \`${ADDRESS_A}\`, minimum \`3\``));
    assert.match(md, /\(older wallet, still credited\)/);
    assert.match(md, /- funding page: \/spaces\/fund-pub\/funding\.md/);

    const j = JSON.parse((await get("/spaces/fund-pub.json")).text);
    assert.equal(j.storage, "Storage: 12.4 MB of 25 MB free. Billing has not started.");
    assert.equal(j.funding.balance, "Balance: $12.50.");
    assert.equal(j.funding.addresses.length, 2);
    assert.equal(j.funding.addresses[1].older_wallet, true);
    assert.equal(j.funding.page, "/spaces/fund-pub/funding");
  });

  test("a space with no address made points to the funding page, and deposits closed say that", async () => {
    const none = (await get("/spaces/fund-none")).text;
    assert.doesNotMatch(none, /No deposit address has been made yet/);
    assert.match(none, /<a href="\/spaces\/fund-none\/funding">Send credit to this space<\/a>/);
    const closed = (await get("/spaces/fund-closed")).text;
    assert.match(closed, /<p>Deposits are not open on this server\.<\/p>/);
    assert.match(closed, /See the funding page/);
    assert.doesNotMatch(closed, /Send credit to this space/);
  });

  test("a malformed answer leaves the section out and the page renders", async () => {
    const r = await get("/spaces/fund-bad");
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /id="funding"/);
    assert.match(r.text, /The fund-bad/);
  });

  test("an older service's answer leaves the storage line and no deposit lines", async () => {
    const r = (await get("/spaces/fund-old")).text;
    assert.match(r, /Storage: 12\.4 MB of 25 MB free/);
    assert.doesNotMatch(r, /Deposit addresses|No deposit address/);
  });

  test("read without a person's key it is held 600 s: other views of the space read it once", async () => {
    const before = fake.calls.length;
    await get("/spaces/fund-held");
    await get("/spaces/fund-held.md");
    await get("/spaces/fund-held?kind=result");
    assert.equal(fake.calls.slice(before).filter((c) => c.url.pathname === "/v1/spaces/fund-held/funding").length, 1);
  });

  test("read with a person's key it is never held", async () => {
    const before = fake.calls.length;
    await signed("/me/spaces/fund-mine");
    await signed("/me/spaces/fund-mine");
    const reads = fake.calls.slice(before).filter((c) => c.url.pathname === "/v1/spaces/fund-mine/funding");
    assert.equal(reads.length, 2);
    assert.ok(reads.every((c) => c.headers.get("authorization") === "Bearer funding-token"));
  });
});

describe("the statements every funding page makes", () => {
  const PUBLIC = statements("2026-10-08", false);
  const PRIVATE = statements("2026-10-08", true);
  const { pay: PAY, more: MORE } = statementParts("2026-10-08", false);

  test("the list is held: each statement of the build, in its words", () => {
    assert.equal(PUBLIC.length, 11);
    assert.equal(PRIVATE.length, 12);
    assert.deepEqual(PRIVATE.slice(0, 11), PUBLIC);
    assert.deepEqual(PUBLIC, [...PAY, ...MORE]);
    // What is read under the addresses is four lines, and none says a key is needed.
    assert.equal(PAY.length, 4);
    assert.match(PAY[0]!, /^Send only the coin shown, on the network shown\. Another network, or a token not listed, is not credited\.$/);
    assert.match(PAY[1]!, /^A deposit below the minimum shown is not credited\.$/);
    assert.match(PAY[2]!, /^Credit is counted in US dollars once the deposit is confirmed, after CryptAPI's fee and the network's fee\. USDT, USDC, USDC\.e, USDT0, DAI and PYUSD count one for one\./);
    assert.equal(PAY[3], "Credit belongs to this space. It is not refundable and cannot move to another space.");
    assert.match(MORE[0]!, /^Anyone can add credit to this space by sending a coin to one of its deposit addresses\. No key is needed\.$/);
    assert.match(MORE[1]!, /^Deposits are visible on a public blockchain: anyone can see the address, the amount and the transaction\.$/);
    assert.match(MORE[2]!, /^Each address belongs to one coin on one network\. A coin sent to it on any other network is not credited, even when this space has an address on that network\./);
    assert.match(MORE[3]!, /^The minimums and the cheap marks are CryptAPI's on 2026-10-08 and can change\.$/);
    assert.match(MORE[5]!, /^A deposit shows as incoming until it is confirmed, and is credited only then\./);
    assert.ok(PUBLIC.includes("Billing has not started: nothing is taken from the balance."));
    assert.match(PRIVATE[11]!, /^The balance and deposits are shown to members only\. The deposit addresses are public, and deposits to them are visible on a public blockchain\.$/);
    assert.ok(!PUBLIC.some((x) => /needs a key/.test(x)));
  });

  const every = async (path: string, list: string[], fetcher = get) => {
    const html = (await fetcher(path)).text;
    for (const s of list) assert.ok(html.replaceAll("&#39;", "'").includes(s.replace(/&/g, "&amp;")), `${path}: ${s}`);
    return html;
  };

  test("a public space's funding page says all of them and not the private one, in the page, the markdown and the JSON", async () => {
    const html = await every("/spaces/fund-pub/funding", PUBLIC);
    assert.doesNotMatch(html, /shown to members only\. The deposit addresses are public/);
    const md = (await get("/spaces/fund-pub/funding.md")).text;
    for (const s of PUBLIC) assert.ok(md.includes(s), s);
    assert.deepEqual(JSON.parse((await get("/spaces/fund-pub/funding.json")).text).statements, PUBLIC);
  });

  test("the rules under the addresses are the four lines, and the rest comes lower on the page", async () => {
    const html = (await get("/spaces/fund-pub/funding")).text;
    const send = html.indexOf('<h2 id="send">'), more = html.indexOf('<h2 id="more">'), coins = html.indexOf('<h2 id="coins">'), balance = html.indexOf('<h2 id="balance">');
    assert.ok(send > 0 && send < balance && balance < more && more < coins, "send, balance, more, other coins");
    const from = html.lastIndexOf("</div>", balance);
    const under = html.slice(from, html.indexOf("</ul>", from));
    assert.equal((under.match(/<li>/g) ?? []).length, 4, "four lines directly under the addresses");
    for (const s of PAY) assert.ok(under.replaceAll("&#39;", "'").includes(s), s);
    assert.doesNotMatch(under, /public blockchain|held for review|Billing/);
  });

  test("a private space's page adds the members-only line, and a sealed space's too", async () => {
    await every("/spaces/fund-priv/funding", PRIVATE);
    await every("/spaces/fund-sealed/funding", PRIVATE);
    await every("/me/spaces/fund-mine/funding", PRIVATE, signed);
  });

  test("the page that is not open says only what stays true", async () => {
    const t = (await get("/spaces/fund-closed/funding")).text;
    assert.match(t, /Deposits are not open on this server\./);
    assert.match(t, /Billing has not started: nothing is taken from the balance\./);
    assert.match(t, /It is not refundable and cannot move to another space\./);
    assert.doesNotMatch(t, /Anyone can add credit|Send to this space|Show address/);
  });
});

describe("the funding page", () => {
  test("the public page leads with the ready coins, then the balance, the deposits and the history, and ends with the other coins", async () => {
    const r = await get("/spaces/fund-pub/funding");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, follow");
    const t = r.text;
    assert.match(t, /<h2 id="send">Send to this space<\/h2>/);
    // The three ready coins, each with coin, network, minimum and a copyable address.
    assert.match(t, /<div class="pay" id="coin-base-usdc">\s*<h3>USDC on Base<\/h3>\s*<p class="meta">Minimum 3 USDC\. Counted one for one\.<\/p>\s*<code class="address">0xabab/);
    assert.match(t, new RegExp(`<div class="pay" id="coin-btc-btc">\\s*<h3>BTC on Bitcoin</h3>\\s*<p class="meta">Minimum 0\\.0005 BTC\\.</p>\\s*<code class="address">${addrFor("btc/btc")}</code>`));
    assert.ok(t.includes(`<code class="address">${addrFor("trc20/usdt")}</code>`));
    assert.match(t, /Balance: \$12\.50\. 2 deposits credited\./);
    assert.match(t, /Incoming, not yet credited \(1\)/);
    assert.match(t, /Held, not credited \(1\)/);
    assert.match(t, /<h2 id="history">Credit history<\/h2>/);
    // The ready coins are not listed again below; the rest are, with a button and no address yet.
    const other = t.slice(t.indexOf('<h2 id="coins">'));
    assert.doesNotMatch(other, /id="coin-base-usdc"|id="coin-btc-btc"|id="coin-trc20-usdt"/);
    assert.match(other, /<tr id="coin-base-eth"><th scope="row">ETH<\/th><td>0\.0003<\/td><td>cheap network<\/td><td><form method="post" action="\/spaces\/fund-pub\/funding" class="inline"><input type="hidden" name="coin" value="base\/eth"><button type="submit">Show address<\/button><\/form><\/td><\/tr>/);
    assert.match(other, /<tr id="coin-erc20-usdc"><th scope="row">USDC<\/th><td>10<\/td><td>one for one<\/td>/);
    assert.match(other, /Minimums as of 2026-10-08/);
    // The address made earlier under a wallet no longer current is kept in view, marked.
    assert.ok(other.includes(`USDT on Tron: <code>${ADDRESS_T}</code>, minimum 5 USDT <span class="meta">(older wallet, still credited)</span>`));
    assert.deepEqual(htmlProblems(t), []);
    assert.ok(t.indexOf('id="send"') < t.indexOf('id="balance"') && t.indexOf('id="history"') < t.indexOf('id="coins"'));
  });

  test("a ready coin with no address is asked for with no key, all at once, and an address already made is not asked for", async () => {
    const before = posted.length;
    await get("/spaces/fund-pub/funding?before=3");
    const made = posted.slice(before);
    assert.deepEqual(made.map((p) => (p.body as { coin: string }).coin).sort(), ["btc/btc", "trc20/usdt"]);
    assert.ok(made.every((p) => p.auth === null), "no Authorization header, not the site's key");
    assert.ok(made.every((p) => p.path === "/v1/spaces/fund-pub/funding/addresses"));
  });

  test("the page needs no key and no sign-in: no twin link, no connect prompt, and it never reads the session", async () => {
    const t = (await get("/spaces/fund-pub/funding", { Cookie: cookie })).text;
    assert.doesNotMatch(t, /with your key|rel="nofollow"/);
    assert.doesNotMatch(t, /Making an address needs a key|Make a deposit address with your key/);
    assert.doesNotMatch(t, /name="csrf"/);
    assert.doesNotMatch(t, /Connected as key/);
    assert.match(t, /No key or sign-in is needed\./);
  });

  test("a coin whose address cannot be made says so and the page still draws; the page is held only a few seconds", async () => {
    for (const name of ["fund-fail", "fund-slow"]) {
      const r = await get(`/spaces/${name}/funding`);
      assert.equal(r.status, 200, name);
      assert.equal((r.text.match(/Not available right now\. Reload this page later\./g) ?? []).length, 3, name);
      assert.match(r.text, /<h2 id="coins">Other coins<\/h2>/, name);
      assert.match(r.text, /Balance: \$12\.50/, name);
      assert.deepEqual(htmlProblems(r.text), [], name);
    }
    const md = (await get("/spaces/fund-fail/funding.md")).text;
    assert.match(md, /- `USDC on Base`, minimum `3`, one for one: Not available right now\. Reload this page later\./);
    const j = JSON.parse((await get("/spaces/fund-fail/funding.json")).text);
    assert.equal(j.ready.length, 3);
    assert.equal(j.ready[0].address, null);
    assert.equal(j.ready[0].not_available, "Not available right now. Reload this page later.");
  });

  test("a closed space says it takes no new addresses, not that the service is unwell", async () => {
    const t = (await get("/spaces/fund-shut/funding")).text;
    assert.equal((t.match(/This space no longer takes new deposit addresses\./g) ?? []).length, 3);
    assert.doesNotMatch(t, /Not available right now/);
  });

  test("an address made while the page was drawn is the same in the markdown and the JSON", async () => {
    const md = (await get("/spaces/fund-pub/funding.md")).text;
    assert.ok(md.includes(`- \`BTC on Bitcoin\`, minimum \`0.0005\`: \`${addrFor("btc/btc")}\``));
    assert.match(md, /Ask for an address: POST https:\/\/api\.schellingaf\.com\/v1\/spaces\/fund-pub\/funding\/addresses with \{"coin": "<ticker>"\} \(no key needed\)/);
    const j = JSON.parse((await get("/spaces/fund-pub/funding.json")).text);
    assert.deepEqual(j.ready.map((c: { coin: string }) => c.coin), ["base/usdc", "btc/btc", "trc20/usdt"]);
    assert.equal(j.ready[1].address, addrFor("btc/btc"));
    assert.match(j.make_address, /no key needed/);
  });

  test("a reader who sees only the addresses gets no balance, deposits or history, and still gets the ready coins", async () => {
    const t = (await get("/spaces/fund-priv/funding")).text;
    assert.match(t, /This space(&#39;|')s balance and deposits are shown to its members only\./);
    assert.doesNotMatch(t, /Balance and deposits|Credit history|Storage:/);
    assert.ok(t.includes(`<code class="address">${ADDRESS_A}</code>`));
    assert.ok(t.includes(`<code class="address">${addrFor("btc/btc")}</code>`));
    assert.doesNotMatch(t, /name="csrf"/);
  });

  test("the history pages by ?before= and says when it could not be read", async () => {
    const first = (await get("/spaces/fund-pub/funding")).text;
    assert.match(first, /<a href="\/spaces\/fund-pub\/funding\?before=71">Earlier entries<\/a>/);
    assert.match(first, /0xtx120/);
    const second = (await get("/spaces/fund-pub/funding?before=71")).text;
    assert.match(second, /0xtx70/);
    assert.doesNotMatch(second, /0xtx120/);
    assert.match((await get("/spaces/fund-count/funding")).text, /The credit history could not be read just now/);
  });

  test("an unknown space is a 404, a malformed answer a 503, and a junk cursor is dropped from the address", async () => {
    assert.equal((await get("/spaces/nobody-here/funding")).status, 404);
    assert.equal((await get("/spaces/fund-bad/funding")).status, 503);
    const t = (await get("/spaces/fund-pub/funding?before=abc&coin=x")).text;
    assert.match(t, /0xtx120/, "a junk cursor reads the newest page");
    assert.doesNotMatch(t, /Your address/);
  });

  test("the markdown and JSON carry the coins by network", async () => {
    const md = (await get("/spaces/fund-pub/funding.md")).text;
    assert.match(md, /### Base\n\n- `ETH` \(`base\/eth`\): minimum `0.0003`, cheap network/);
    const j = JSON.parse((await get("/spaces/fund-pub/funding.json")).text);
    assert.deepEqual(j.coins.map((n: { network: string }) => n.network), ["Base", "Bitcoin", "Ethereum", "Tron"]);
    assert.equal(j.balance_micro_usd, 12500000);
  });
});

describe("fixes of round 2", () => {
  test("a private space whose posts read is refused still shows its addresses and the members-only line", async () => {
    const r = await get("/spaces/fund-denied");
    assert.ok(r.text.includes(`<code>${ADDRESS_A}</code>`), "the addresses of a space whose posts are refused");
    assert.match(r.text, /href="\/spaces\/fund-denied\/funding"/);
    assert.match(r.text, /shown to its members only/);
    assert.doesNotMatch(r.text, /Balance:/);
  });

  test("coins=true is asked on the funding page and the signed-in page, not on a space's page", async () => {
    const before = fake.calls.length;
    await get("/spaces/fund-nullfwd");
    await get("/spaces/fund-none/funding");
    await signed("/me/spaces/fund-mine/funding");
    const reads = fake.calls.slice(before).filter((c) => c.url.pathname.endsWith("/funding") && c.method === "GET" && c.url.pathname.startsWith("/v1/spaces/fund-"));
    assert.equal(reads.length, 3);
    assert.deepEqual(reads.map((c) => c.url.searchParams.get("coin")), [null, null, null]);
    assert.deepEqual(reads.map((c) => c.url.searchParams.get("coins")), [null, "true", "true"]);
    assert.match((await get("/spaces/fund-none/funding?x=1")).text, /<h2 id="coins">Other coins<\/h2>/);
    assert.match((await signed("/me/spaces/fund-mine/funding")).text, /<h2 id="coins">Other coins<\/h2>/);
  });

  test("the parser accepts an answer with or without coins, and not one with half", () => {
    const plain = full("x-space", "public"); delete plain.coins; delete plain.minimums_as_of;
    const f = readFunding(plain)!;
    assert.deepEqual([f.coins.length, f.minimumsAsOf], [0, ""]);
    assert.equal(fundingSection(plain)!.addresses!.length, 1);
    assert.equal(readFunding(full("x-space", "public", { minimums_as_of: undefined })), null);
    assert.ok(readFunding(full("x-space", "public")));
  });

  test("a replaced space says its deposits credit the successor, with a link, and never that its credit cannot move", async () => {
    for (const path of ["/spaces/fund-repl/funding", "/spaces/fund-repl/funding.md", "/spaces/fund-repl/funding.json"]) {
      const t = (await get(path)).text;
      assert.match(t, /This space was replaced\. Deposits to these addresses credit the space fund-next\. Credit is not refundable\./, path);
      assert.doesNotMatch(t, /cannot move to another space/, path);
      assert.match(t, /Billing has not started/, path);
    }
    assert.match((await get("/spaces/fund-repl/funding")).text, /<a href="\/spaces\/fund-next">fund-next<\/a>/);
    assert.match((await get("/spaces/fund-repl")).text, /Deposits to these addresses credit <a href="\/spaces\/fund-next">fund-next<\/a>/);
    assert.deepEqual(JSON.parse((await get("/spaces/fund-repl/funding.json")).text).credited_to, { name: "fund-next", page: "/spaces/fund-next" });
    assert.match((await get("/spaces/fund-pub/funding")).text, /cannot move to another space/);
    assert.equal(readFunding(full("x-space", "public", { credited_to: { space_id: "1", name: "<b>" } })), null);
    assert.equal(readFunding(full("x-space", "public", { credited_to: null }))!.creditedTo, null);
  });

  test("a history deposit whose forwarded value is null is read and shown as not sent", async () => {
    assert.equal(readHistory({ entries: [{ ...entries(1, 1)[0], deposit: { ...(entries(1, 1)[0]!.deposit as Json), value_forwarded_coin: null } }], has_more: false, next_before: null })!.entries.length, 1);
    const t = (await get("/spaces/fund-nullfwd/funding")).text;
    assert.match(t, /base\/usdc not sent, <code>0xtx2<\/code>/);
    assert.match(t, /base\/usdc 1\.5, <code>0xtx1<\/code>/);
    assert.match((await get("/spaces/fund-nullfwd/funding.md")).text, /`base\/usdc` not sent, transaction `0xtx2`/);
  });
});

describe("Show address: the one public form", () => {
  const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
  async function show(path: string, body: string, headers: Record<string, string> = { Origin: SITE }) {
    const res = await handleRequest(new Request(`${SITE}${path}`, { method: "POST", headers: { ...FORM, ...headers }, body }), env);
    return { res, text: await res.text() };
  }

  test("it makes the address with no key and no session, and goes back to the page at that coin", async () => {
    const before = posted.length;
    const reads = () => fake.calls.filter((c) => c.method === "GET" && c.url.pathname === "/v1/spaces/fund-pub/funding").length;
    await get("/spaces/fund-pub/funding");
    const read = reads();
    const { res } = await show("/spaces/fund-pub/funding", "coin=base%2Feth");
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/spaces/fund-pub/funding#coin-base-eth");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(posted.length, before + 1);
    assert.deepEqual(posted.at(-1)!.body, { coin: "base/eth" });
    assert.equal(posted.at(-1)!.auth, null);
    // The page held for a minute is forgotten, so the next view reads the product again.
    await get("/spaces/fund-pub/funding");
    assert.equal(reads(), read + 1);
  });

  test("a cookie does not change it: the site's key and the person's are never sent", async () => {
    const before = posted.length;
    const { res } = await show("/spaces/fund-pub/funding", "coin=eth%2Feth", { Origin: SITE, Cookie: cookie });
    assert.equal(res.status, 303);
    assert.equal(posted.at(-1)!.auth, null);
    assert.equal(posted.length, before + 1);
  });

  test("an Origin that is not this site, or none, changes nothing; a null Origin from this site's own page is accepted", async () => {
    const before = posted.length;
    assert.equal((await show("/spaces/fund-pub/funding", "coin=base%2Feth", { Origin: "https://evil.example" })).res.status, 403);
    assert.equal((await show("/spaces/fund-pub/funding", "coin=base%2Feth", {})).res.status, 403);
    assert.equal(posted.length, before);
    assert.equal((await show("/spaces/fund-pub/funding", "coin=base%2Feth", { Origin: "null", "Sec-Fetch-Site": "same-origin" })).res.status, 303);
  });

  test("a junk coin changes nothing, and each refusal is shown in the form's own words", async () => {
    const before = posted.length;
    for (const body of ["coin=%3Cscript%3E", "coin=", "", "coin=" + "a".repeat(80)]) {
      const r = await show("/spaces/fund-pub/funding", body);
      assert.equal(r.res.status, 400, body);
      assert.match(r.text, /Choose a coin from the list\. Nothing was made\./);
    }
    assert.equal(posted.length, before);
    const notOffered = await show("/spaces/fund-pub/funding", "coin=nope%2Fcoin");
    assert.equal(notOffered.res.status, 400);
    assert.match(notOffered.text, /That coin is not one this space takes on this server\./);
    const closed = await show("/spaces/fund-pub/funding", "coin=closed%2Fx");
    assert.equal(closed.res.status, 503);
    assert.match(closed.text, /Deposit addresses cannot be made just now/);
    const slow = await show("/spaces/fund-pub/funding", "coin=fast%2Fx");
    assert.equal(slow.res.status, 429);
    assert.match(slow.text, /Wait 42 seconds and try again\. Nothing was made\./);
    const shut = await show("/spaces/fund-shut/funding", "coin=base%2Feth");
    assert.equal(shut.res.status, 409);
    assert.match(shut.text, /This space no longer takes new deposit addresses\./);
    for (const t of [notOffered.text, closed.text, slow.text, shut.text]) assert.deepEqual(htmlProblems(t), []);
  });

  test("no other public address takes a POST", async () => {
    const before = posted.length;
    for (const path of ["/spaces/fund-pub", "/spaces/fund-pub/funding.md", "/spaces/fund-pub/funding/x", "/spaces", "/spaces/fund-pub/1"]) {
      const r = await show(path, "coin=base%2Feth");
      assert.equal(r.res.status, 405, path);
    }
    assert.equal(posted.length, before);
  });
});

describe("the signed-in funding page", () => {
  test("a public space's page is the public one: a signed-in person is sent there", async () => {
    const res = await handleRequest(new Request(`${SITE}/me/spaces/fund-pub/funding?before=71`, { headers: { Cookie: cookie } }), env);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/spaces/fund-pub/funding?before=71");
    const plain = await handleRequest(new Request(`${SITE}/me/spaces/fund-pub/funding`, { headers: { Cookie: cookie } }), env);
    assert.equal(plain.headers.get("location"), "/spaces/fund-pub/funding");
  });

  test("a member of a private space sees the balance there, the ready coins, and a form with the form token for each other coin", async () => {
    assert.deepEqual(networksOf(COINS as never).map((n) => [n.name, n.cheap]), [["Base", true], ["Bitcoin", false], ["Ethereum", false], ["Tron", false]]);
    const before = posted.length;
    const r = await signed("/me/spaces/fund-mine/funding");
    assert.equal(r.status, 200);
    const t = r.text;
    assert.match(t, /<h2 id="send">Send to this space<\/h2>/);
    assert.match(t, /Balance: \$12\.50\./);
    assert.match(t, new RegExp(`<form method="post" action="/me/spaces/fund-mine/funding" class="inline"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="coin" value="base/eth">`));
    assert.doesNotMatch(t, /<select|Get the address|Your address/);
    assert.match(t, /Connected as key/);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.deepEqual(htmlProblems(t), []);
    // Its ready coins are made with no key, even for a signed-in reader.
    const made = posted.slice(before);
    assert.ok(made.length >= 2 && made.every((p) => p.auth === null));
  });

  test("its form asks the product with the person's key and goes back to the coin", async () => {
    const before = posted.length;
    const { res } = await post("/me/spaces/fund-mine/funding", { coin: "base/usdc" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/me/spaces/fund-mine/funding#coin-base-usdc");
    assert.equal(posted.length, before + 1);
    assert.deepEqual(posted.at(-1)!.body, { coin: "base/usdc" });
    assert.equal(posted.at(-1)!.auth, "Bearer funding-token");
  });

  test("each refusal is shown in the form's own words, with its wait", async () => {
    const coinRefused = await post("/me/spaces/fund-mine/funding", { coin: "nope/coin" });
    assert.equal(coinRefused.res.status, 400);
    assert.match(coinRefused.text, /That coin is not one this space takes on this server\./);
    const closed = await post("/me/spaces/fund-mine/funding", { coin: "closed/x" });
    assert.equal(closed.res.status, 503);
    assert.match(closed.text, /Deposit addresses cannot be made just now/);
    const slow = await post("/me/spaces/fund-mine/funding", { coin: "fast/x" });
    assert.equal(slow.res.status, 429);
    assert.match(slow.text, /Wait 42 seconds and try again\. Nothing was made\./);
  });

  test("a form with no csrf token, a foreign origin or a junk coin changes nothing", async () => {
    const before = posted.length;
    const noToken = await handleRequest(new Request(`${SITE}/me/spaces/fund-mine/funding`, {
      method: "POST", headers: { Origin: SITE, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: "coin=base%2Fusdc",
    }), env);
    assert.equal(noToken.status, 403);
    const foreign = await handleRequest(new Request(`${SITE}/me/spaces/fund-mine/funding`, {
      method: "POST", headers: { Origin: "https://evil.example", Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, coin: "base/usdc" }).toString(),
    }), env);
    assert.equal(foreign.status, 403);
    assert.equal((await post("/me/spaces/fund-mine/funding", { coin: "<script>" })).res.status, 400);
    assert.equal(posted.length, before);
  });

  test("a visitor with no session is sent to connect", async () => {
    const res = await handleRequest(new Request(`${SITE}/me/spaces/fund-mine/funding`), env);
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location") ?? "", /^\/sign-in/);
  });
});

describe("the numbers page carries the funding group", () => {
  test("totals, dollars from millionths, spaces funded and deposits pending", async () => {
    const { readNumbers, numbersMarkdown, numbersJson, numbersHtml } = await import("../src/numbers-render.ts");
    const { NUMBERS } = await import("./lib/service.ts");
    const raw = { ...structuredClone(NUMBERS), funding: { deposits: { total: 12, last_7_days: 3 }, credited_micro_usd: { total: 1234500000, last_7_days: 30000 }, spaces_funded: 5, pending: 1 } };
    const n = readNumbers(raw)!;
    const html = numbersHtml({ title: "", description: "", canonical: "", mdPath: "", jsonPath: "", robots: "" }, n);
    assert.ok(html.includes('<tr><th scope="row">Deposits confirmed</th><td>12</td><td>3</td></tr>'));
    assert.ok(html.includes('<tr><th scope="row">US dollars credited</th><td>$1234.50</td><td>$0.03</td></tr>'));
    assert.match(html, /5 spaces have been funded\. 1 deposit is incoming, not yet credited\./);
    assert.match(numbersMarkdown(n), /- US dollars credited: \$1234\.50 in total, \$0\.03 in the last 7 days/);
    assert.deepEqual((numbersJson(n, "x") as any).funding.credited_usd, { total: "$1234.50", last_7_days: "$0.03" });
    assert.equal(readNumbers({ ...raw, funding: { ...raw.funding, pending: -1 } }), null);
    assert.equal(readNumbers({ ...raw, funding: "x" }), null);
    assert.equal(readNumbers(NUMBERS)!.funding, undefined);
  });
});

describe("the site's other places", () => {
  test("/api lists the operations and moduleKeys names FUNDING", async () => {
    const { operationPages, moduleKeys, today } = await import("../content/api-overview.mjs");
    assert.equal((moduleKeys as Record<string, string>).FUNDING, "funding");
    for (const op of ["funding.get", "funding.address", "funding.history", "funding.callback"]) assert.ok(op in operationPages, op);
    const text = (today.available.find((e: string[]) => e[0] === "FUNDING") ?? ["", ""])[1]!;
    assert.match(text, /Deposits are visible on a public blockchain/);
    assert.match(text, /is not refundable and cannot move to another space/);
    assert.doesNotMatch(text, /Billing has not started/);
    assert.match(text, /is billed each UTC day from the balance, at \$5 per GB a month/);
    assert.ok(text.includes("A space over its free allowance is read-only at zero credit, or once a day's bill could not be paid in full, until credit pays a day or it is back within its allowance"));
    assert.match(text, /CREDIT_NEEDED/);
  });

  test("llms.txt says storage is billed and a space read-only at zero", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../build.mjs", import.meta.url), "utf8");
    assert.match(src, /Storage over the free allowance is billed daily from the balance; a space over its free allowance is read-only at zero credit, or once a day's bill could not be paid in full, until credit pays a day or it is back within its allowance\./);
    assert.doesNotMatch(src, /makes one\. Billing has not started/);
  });

  test("the stand-in answered every address asked", () => {
    assert.deepEqual(unanswered.filter((u) => u.includes("funding")), []);
  });
});

void readFunding;
