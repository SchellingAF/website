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
const ADDRESS_A = `0x${"ab".repeat(20)}`;
const ADDRESS_T = `T${"Q".repeat(33)}`;
const address = (c: string, a: string, over: Json = {}): Json => {
  const found = COINS.find((x) => x.coin === c)!;
  return { coin: c, symbol: found.symbol, network: found.network, family: found.family, address: a, minimum: found.minimum,
    cheap: found.cheap, stable: found.stable, current: true, created_at: "2026-10-08T09:00:00.000Z", ...over };
};
const full = (name: string, visibility: string, over: Json = {}): Json => ({
  space: name, visibility, billing: "not_started", deposits_open: true,
  addresses: [address("base/usdc", ADDRESS_A)], coins: COINS, minimums_as_of: "2026-10-08",
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
  addresses: [address("base/usdc", ADDRESS_A)], coins: COINS, minimums_as_of: "2026-10-08",
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

const names = ["fund-pub", "fund-none", "fund-closed", "fund-old", "fund-bad", "fund-priv", "fund-sealed", "fund-mine", "fund-held", "fund-count", "fund-denied", "fund-repl", "fund-nullfwd"];
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
  if (/^\/v1\/spaces\/(fund-pub|fund-mine|fund-closed|fund-repl|fund-none)\/funding\/history$/.test(p)) {
    const before = Number(call.url.searchParams.get("before") ?? "1000");
    const page = entries(Math.min(before - 1, 120), Math.max(Math.min(before - 1, 120) - 49, 1));
    const last = Number(page.at(-1)!.entry_id);
    return json({ space: p.split("/")[3], entries: page, has_more: last > 1, next_before: last > 1 ? String(last) : null });
  }
  if (p === "/v1/spaces/fund-count/funding/history") return refusal(500, "INTERNAL", "unwell");
  if (call.method === "POST" && p === "/v1/spaces/fund-mine/funding/addresses") {
    const body = JSON.parse(call.body ?? "{}") as { coin: string };
    posted.push({ path: p, body, auth: call.headers.get("authorization") });
    if (body.coin === "nope/coin") return refusal(400, "COIN_NOT_OFFERED", "not offered");
    if (body.coin === "closed/x") return refusal(503, "FUNDING_UNAVAILABLE", "closed");
    if (body.coin === "fast/x") {
      const r = refusal(429, "RATE_LIMITED", "slow down");
      r.headers.set("Retry-After", "42");
      return r;
    }
    return json({ space: "fund-mine", created: true, address: address(body.coin, ADDRESS_A), minimums_as_of: "2026-10-08", notice: "Send only this coin on this network." }, 201);
  }
  return base(call);
});
const { cookie, csrf } = await signedIn(ME, "funding-token", "192.0.2.77");
const { fundingSection, readFunding, readHistory, statements, money } = await import("../src/funding-section.ts");
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
    assert.match(html, /<a href="\/spaces\/fund-pub\/funding">Make a deposit address or see every coin<\/a>/);
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

  test("a space with no address made says so, and deposits closed say that", async () => {
    assert.match((await get("/spaces/fund-none")).text, /<p>No deposit address has been made yet\.<\/p>/);
    const closed = (await get("/spaces/fund-closed")).text;
    assert.match(closed, /<p>Deposits are not open on this server\.<\/p>/);
    assert.match(closed, /See the funding page/);
    assert.doesNotMatch(closed, /Make a deposit address/);
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

  test("the list is held: each statement of the build, in its words", () => {
    assert.equal(PUBLIC.length, 9);
    assert.equal(PRIVATE.length, 10);
    assert.deepEqual(PRIVATE.slice(0, 9), PUBLIC);
    assert.match(PUBLIC[0]!, /^Anyone can add credit to this space by sending a coin to one of its deposit addresses\. Making an address needs a key\.$/);
    assert.match(PUBLIC[1]!, /^Deposits are visible on a public blockchain: anyone can see the address, the amount and the transaction\.$/);
    assert.match(PUBLIC[2]!, /^Each address belongs to one coin on one network\. A coin sent to it on any other network is not credited, even when this space has an address on that network\./);
    assert.match(PUBLIC[3]!, /^A deposit below the minimum shown is not credited\. The minimums and the cheap marks are CryptAPI's on 2026-10-08 and can change\.$/);
    assert.match(PUBLIC[4]!, /^A token not in this list is not credited, even on the right network\.$/);
    assert.match(PUBLIC[5]!, /USDT, USDC, USDC\.e, USDT0, DAI and PYUSD count one for one/);
    assert.match(PUBLIC[6]!, /^A deposit shows as incoming until it is confirmed, and is credited only then\./);
    assert.ok(PUBLIC.includes("Credit belongs to this space. It is not refundable and cannot move to another space."));
    assert.ok(PUBLIC.includes("Billing has not started: nothing is taken from the balance."));
    assert.match(PRIVATE[9]!, /^The balance and deposits are shown to members only\. The deposit addresses are public, and deposits to them are visible on a public blockchain\.$/);
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
    assert.doesNotMatch(t, /Anyone can add credit/);
    assert.doesNotMatch(t, /Get the address|Make a deposit address with your key/);
  });
});

describe("the funding page", () => {
  test("the public page lists the addresses, every coin by network, the balance, the deposits and the history", async () => {
    const r = await get("/spaces/fund-pub/funding");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, follow");
    const t = r.text;
    assert.ok(t.includes(`<code>${ADDRESS_A}</code>`));
    assert.match(t, /Balance: \$12\.50\. 2 deposits credited\./);
    assert.match(t, /Incoming, not yet credited \(1\)/);
    assert.match(t, /Held, not credited \(1\)/);
    assert.match(t, /<h2 id="history">Credit history<\/h2>/);
    assert.match(t, /<th scope="row">USDC<\/th><td>3<\/td><td>cheap network, one for one<\/td>/);
    assert.match(t, /<th scope="row">BTC<\/th><td>0\.0005<\/td><td><\/td>/);
    assert.match(t, /Minimums as of 2026-10-08/);
    assert.deepEqual(htmlProblems(t), []);
  });

  test("the public page carries the twin link, never a form, and never reads the session", async () => {
    const t = (await get("/spaces/fund-pub/funding", { Cookie: cookie })).text;
    assert.match(t, /<a href="\/me\/spaces\/fund-pub\/funding" rel="nofollow">Make a deposit address with your key<\/a>/);
    assert.doesNotMatch(t, /<form method="post"/);
    assert.doesNotMatch(t, /Connected as key/);
  });

  test("a reader who sees only the addresses gets no balance, deposits or history", async () => {
    const t = (await get("/spaces/fund-priv/funding")).text;
    assert.match(t, /This space(&#39;|')s balance and deposits are shown to its members only\./);
    assert.doesNotMatch(t, /Balance and deposits|Credit history|Storage:/);
    assert.ok(t.includes(`<code>${ADDRESS_A}</code>`));
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
    assert.doesNotMatch(t, /Your address/, "a coin is only taken on the signed-in page");
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
    assert.deepEqual(reads.map((c) => c.url.searchParams.get("coins")), [null, "true", "true"]);
    assert.match((await get("/spaces/fund-none/funding?x=1")).text, /<h2 id="coins">Every coin<\/h2>/);
    assert.match((await signed("/me/spaces/fund-mine/funding")).text, /<optgroup label="Base, cheap network">/);
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

describe("the signed-in funding page and its picker", () => {
  test("groups by network, cheap networks first and marked, with each coin's minimum", async () => {
    assert.deepEqual(networksOf(COINS as never).map((n) => [n.name, n.cheap]), [["Base", true], ["Bitcoin", false], ["Ethereum", false], ["Tron", false]]);
    const r = await signed("/me/spaces/fund-mine/funding");
    assert.equal(r.status, 200);
    const t = r.text;
    assert.match(t, /<form method="post" action="\/me\/spaces\/fund-mine\/funding"/);
    assert.ok(t.includes(`name="csrf" value="${csrf}"`));
    assert.match(t, /<select name="coin" required>/);
    assert.match(t, /<optgroup label="Base, cheap network"><option value="base\/eth">ETH, minimum 0\.0003<\/option><option value="base\/usdc">USDC, minimum 3<\/option><\/optgroup>/);
    assert.match(t, /<optgroup label="Ethereum"><option value="eth\/eth">ETH, minimum 0\.005<\/option><option value="erc20\/usdc">USDC, minimum 10<\/option><\/optgroup>/);
    assert.ok(t.indexOf('label="Base, cheap network"') < t.indexOf('label="Bitcoin"'));
    assert.match(t, /<button type="submit">Get the address<\/button>/);
    assert.match(t, /Connected as key/);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.deepEqual(htmlProblems(t), []);
  });

  test("the POST asks the product with the person's key and goes to ?coin=", async () => {
    const before = posted.length;
    const { res } = await post("/me/spaces/fund-mine/funding", { coin: "base/usdc" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/me/spaces/fund-mine/funding?coin=base%2Fusdc");
    assert.equal(posted.length, before + 1);
    assert.deepEqual(posted.at(-1)!.body, { coin: "base/usdc" });
    assert.equal(posted.at(-1)!.auth, "Bearer funding-token");
  });

  test("the address asked for is shown first, highlighted, with the statements above it", async () => {
    const t = (await signed("/me/spaces/fund-mine/funding?coin=base%2Fusdc")).text;
    assert.match(t, /<li class="note"><strong>Your address<\/strong>: USDC on Base: <code>/);
    assert.ok(t.indexOf("Anyone can add credit") < t.indexOf("Your address"));
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
