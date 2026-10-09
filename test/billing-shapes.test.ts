// The site reads two answers from the service: the one that says billing has not started,
// and the one that bills. Each is checked here against the words it must give, so the site
// can ship before the service does and keep the funding section the day billing starts.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

type Json = Record<string, unknown>;

const { storageLine } = await import("../src/storage-line.ts");
const { readFunding, fundingSection, readHistory, statements, closedStatements, entryLabel } = await import("../src/funding-section.ts");
const { readNumbers, numbersHtml, numbersMarkdown, numbersJson } = await import("../src/numbers-render.ts");
const { refusalText } = await import("../src/signed-in.ts");
const { NUMBERS } = await import("./lib/service.ts");

const ADDRESS = `0x${"ab".repeat(20)}`;
const COIN = { coin: "base/usdc", symbol: "USDC", name: "USD Coin", network: "Base", family: "evm", minimum: "3", cheap: true, stable: true };
const RATE = { micro_usd_per_gb_month: 5000000, days_per_month: 30, bytes_per_gb: 1000000000 };

/** What the service answers today: billing not started, no start day. */
const oldShape = (over: Json = {}): Json => ({
  space: "x-space", visibility: "public", billing: "not_started", deposits_open: true,
  addresses: [{ coin: "base/usdc", symbol: "USDC", network: "Base", family: "evm", address: ADDRESS, minimum: "3", cheap: true, stable: true, current: true, created_at: "2026-10-08T09:00:00.000Z" }],
  coins: [COIN], minimums_as_of: "2026-10-08",
  bytes: { posts: 2034000, files: 10400000, total: 12434000 }, allowance_bytes: 25000000, over_bytes: 0, rate: RATE,
  would_be_billed_per_day_micro_usd: 0,
  last_day: { day: "2026-10-07", over_allowance: false, billable_bytes: null, would_be_billed_micro_usd: 0 },
  balance_micro_usd: 12500000, days_left: null,
  deposits: { pending: [], held: [], rejected: [], pending_count: 0, held_count: 0, rejected_count: 0, credited_count: 2 },
  ...over,
});

/** What the service answers once it bills. */
const newShape = (over: Json = {}): Json => oldShape({
  billing: "started", billing_from: "2026-10-10", free_until: null, per_day_micro_usd: 0,
  bytes: { posts: 2034000, files: 10400000, tasks: 20000, total: 12454000 },
  last_day: { day: "2026-10-09", over_allowance: false, billable_bytes: 0, billed_micro_usd: 0, taken_micro_usd: 0, free: false, shadow: false, would_be_billed_micro_usd: 0 },
  read_only: false, read_only_since: null,
  ...over,
});
const OVER = { bytes: { posts: 20000000, files: 10000000, tasks: 0, total: 30000000 }, over_bytes: 5000000 };
const TODAY = "2026-10-12";

describe("the storage line, both shapes", () => {
  test("the old answer gives the old words, and the start day replaces them", () => {
    assert.equal(storageLine(oldShape()), "Storage: 12.4 MB of 25 MB free. Billing has not started.");
    assert.equal(storageLine(oldShape({ ...OVER, last_day: { day: "2026-10-07", over_allowance: true, would_be_billed_micro_usd: 1000 } })),
      "Storage: 30 MB, 5 MB over the 25 MB free. Billing has not started. On 2026-10-07 it would have been billed $0.001.");
    assert.equal(storageLine(oldShape({ billing_from: "2026-10-10" })), "Storage: 12.4 MB of 25 MB free. Billing starts on 2026-10-10.");
  });

  test("billing started: under, over with yesterday's bill, free, and free days", () => {
    assert.equal(storageLine(newShape(), TODAY), "Storage: 12.5 MB of 25 MB free.");
    const over = newShape({ ...OVER, per_day_micro_usd: 833,
      last_day: { day: "2026-10-11", over_allowance: true, billable_bytes: 5000000, billed_micro_usd: 833, taken_micro_usd: 833, free: false, shadow: false } });
    assert.equal(storageLine(over, TODAY), "Storage: 30 MB, 5 MB over the 25 MB free: $0.000833 a day. On 2026-10-11 it was billed $0.000833.");
    const free = newShape({ ...OVER, per_day_micro_usd: 0, free_until: "2026-12-30",
      last_day: { day: "2026-10-11", over_allowance: true, billable_bytes: 5000000, billed_micro_usd: 0, taken_micro_usd: 0, free: true, shadow: false } });
    assert.equal(storageLine(free, TODAY), "Storage: 30 MB, 5 MB over the 25 MB free. On 2026-10-11 it was free. Free until 2026-12-30.");
    assert.equal(storageLine(newShape({ free_until: "2026-10-01" }), TODAY), "Storage: 12.5 MB of 25 MB free.", "free days that ended are not shown");
  });

  test("billing started and read-only, and paused", () => {
    assert.equal(storageLine(newShape({ ...OVER, per_day_micro_usd: 833, read_only: true, read_only_since: "2026-10-11T00:00:05.000Z" }), TODAY),
      "Storage: 30 MB, 5 MB over the 25 MB free: $0.000833 a day. Read-only: its credit does not pay a day of storage. Credit that pays a day opens it again.");
    assert.equal(storageLine(newShape({ billing: "paused" }), TODAY), "Storage: 12.5 MB of 25 MB free. Billing is paused: nothing is taken.");
  });

  test("an unknown state, or a new field out of shape, is no line", () => {
    assert.equal(storageLine(newShape({ billing: "later" })), null);
    for (const bad of [{ billing_from: "soon" }, { free_until: 5 }, { per_day_micro_usd: -1 }, { read_only: "yes" }, { bytes: { total: 1, tasks: -1 } }]) {
      assert.equal(storageLine(newShape(bad)), null, JSON.stringify(bad));
    }
  });
});

describe("the funding answer, both shapes", () => {
  test("both are read; billing started keeps the section and its figures", () => {
    assert.ok(readFunding(oldShape()));
    const f = readFunding(newShape())!;
    assert.ok(f, "billing started must not drop the section");
    assert.equal(f.billing!.state, "started");
    assert.equal(fundingSection(newShape())!.storage, storageLine(newShape()));
    assert.equal(readFunding(newShape({ billing: "later" })), null);
  });

  test("days left follow the balance once billing started, and not before", () => {
    assert.equal(fundingSection(newShape({ days_left: 41, per_day_micro_usd: 300000 }))!.balance, "Balance: $12.50. 41 days of storage left.");
    assert.equal(fundingSection(newShape({ days_left: 1 }))!.balance, "Balance: $12.50. 1 day of storage left.");
    assert.equal(fundingSection(newShape({ days_left: null }))!.balance, "Balance: $12.50.");
    assert.equal(fundingSection(oldShape({ days_left: 41 }))!.balance, "Balance: $12.50.");
  });

  test("an addresses-only answer carries the terms too", () => {
    const only = { space: "x-space", visibility: "private", billing: "started", billing_from: "2026-10-10", allowance_bytes: 10000000, rate: RATE,
      deposits_open: true, addresses: [], members_only: ["bytes", "balance", "deposits", "history", "read_only"] };
    assert.equal(readFunding(only)!.billing!.allowanceBytes, 10000000);
  });
});

describe("the statements", () => {
  const OLD = "Billing has not started: nothing is taken from the balance.";
  const READ_ONLY = "A space over its free allowance is read-only at zero credit, or once a day's bill could not be paid in full, until credit pays a day or it is back within its allowance. Everything in it can still be read and nothing is deleted.";

  test("an older answer keeps today's words", () => {
    const b = readFunding(oldShape())!.billing;
    assert.equal(b, null);
    assert.ok(statements("2026-10-08", false, null, b).includes(OLD));
    assert.ok(closedStatements(false, null, b).includes(OLD));
  });

  test("not started with a day, started, and paused", () => {
    const soon = readFunding(oldShape({ billing_from: "2026-10-10" }))!.billing;
    assert.ok(statements("2026-10-08", false, null, soon).includes("Billing starts on 2026-10-10. Nothing is taken from the balance before then."));

    const on = readFunding(newShape())!.billing;
    const list = statements("2026-10-08", false, null, on);
    assert.ok(list.includes("Storage above this space's free 25 MB is billed each UTC day from the balance, at $5 per GB a month: a thirtieth of that a day."));
    assert.ok(list.includes(READ_ONLY));
    assert.ok(!list.includes(OLD));
    assert.ok(closedStatements(false, null, on).includes(READ_ONLY));

    const paused = readFunding(newShape({ billing: "paused" }))!.billing;
    assert.ok(statements("2026-10-08", false, null, paused).includes("Billing is paused: nothing is taken from the balance."));
  });
});

describe("the history names a bill", () => {
  const entry = (over: Json = {}): Json => ({ entry_id: "9", kind: "bill", amount_micro_usd: -833, balance_after_micro_usd: 12499167, at: "2026-10-11T00:00:05.000Z", deposit: null, ...over });
  test("a bill reads for its day, and names the space when it is another", () => {
    const h = readHistory({ entries: [entry({ bill: { day: "2026-10-10", space: "x-space" } }), entry({ entry_id: "8", bill: { day: "2026-10-10", space: "old-one" } }), entry({ entry_id: "7", kind: "deposit", amount_micro_usd: 5, bill: null }), entry({ entry_id: "6" })], has_more: false, next_before: null })!;
    assert.deepEqual(h.entries.map((e: any) => entryLabel(e, "x-space")), ["bill for 2026-10-10", "bill for 2026-10-10, old-one", "deposit", "bill"]);
  });
  test("a bill field out of shape leaves that entry out", () => {
    const h = readHistory({ entries: [entry({ bill: { day: "later", space: "x" } }), entry({ entry_id: "5", bill: "x" })], has_more: false, next_before: null })!;
    assert.equal(h.entries.length, 0);
  });
});

describe("a refused write and the numbers", () => {
  test("CREDIT_NEEDED has its own words", () => {
    assert.equal(refusalText({ ok: false, status: 402, code: "CREDIT_NEEDED", message: "" } as never),
      "This write needs credit: with it, a day of this space's storage costs more than its balance. Nothing was posted. Anyone can add credit on its funding page; everything in it can still be read.");
  });

  const shell = { title: "", description: "", canonical: "", mdPath: "", jsonPath: "", robots: "" };
  const funding = { deposits: { total: 12, last_7_days: 3 }, credited_micro_usd: { total: 1234500000, last_7_days: 30000 }, spaces_funded: 5, pending: 1 };
  const billing = { state: "started", from: "2026-10-10", taken_micro_usd: { total: 2500000, last_7_days: 1250000 }, spaces_billed: { total: 4, last_7_days: 3 }, spaces_read_only: 1, spaces_with_free_days: 20 };

  test("with billing: a Billing group and the new note; without: neither", () => {
    const n = readNumbers({ ...structuredClone(NUMBERS), funding, billing })!;
    const html = numbersHtml(shell, n);
    assert.match(html, /<h2 id="billing">Billing<\/h2>/);
    assert.ok(html.includes('<tr><th scope="row">US dollars billed</th><td>$2.50</td><td>$1.25</td></tr>'));
    assert.ok(html.includes('<tr><th scope="row">Spaces billed</th><td>4</td><td>3</td></tr>'));
    assert.match(html, /1 space is read-only\. 20 spaces have free days left\./);
    assert.match(html, /Billed is storage taken from balances, each UTC day\./);
    assert.doesNotMatch(html, /Billing has not started/);
    assert.match(numbersMarkdown(n), /- US dollars billed: \$2\.50 in total, \$1\.25 in the last 7 days/);
    assert.deepEqual((numbersJson(n, "x") as any).billing.taken_usd, { total: "$2.50", last_7_days: "$1.25" });

    const old = readNumbers({ ...structuredClone(NUMBERS), funding })!;
    const oldHtml = numbersHtml(shell, old);
    assert.doesNotMatch(oldHtml, /id="billing"/);
    assert.match(oldHtml, /Billing has not started\./);
    assert.equal((numbersJson(old, "x") as any).billing, undefined);
  });

  test("a paused billing says it is paused, never that it has not started", () => {
    const n = readNumbers({ ...structuredClone(NUMBERS), funding, billing: { ...billing, state: "paused" } })!;
    for (const t of [numbersHtml(shell, n), numbersMarkdown(n)]) {
      assert.match(t, /Billing is paused\./);
      assert.doesNotMatch(t, /Billing has not started/);
    }
  });

  test("billing out of shape is no answer", () => {
    assert.equal(readNumbers({ ...structuredClone(NUMBERS), billing: { ...billing, state: "soon" } }), null);
    assert.equal(readNumbers({ ...structuredClone(NUMBERS), billing: { ...billing, spaces_read_only: -1 } }), null);
  });
});
