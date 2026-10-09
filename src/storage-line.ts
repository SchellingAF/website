// The one line a space's page shows about its storage, from the service's funding answer
// (GET /v1/spaces/{name}/funding). Plain text: the page escapes it. Null when the answer is
// not one this reads exactly, so the page leaves the line out and says nothing.

const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Decimal megabytes with one decimal, ".0" dropped: 12434000 is "12.4 MB", and 1 byte "0.1 MB",
 *  never "0 MB". Whole numbers only. */
export function megabytes(bytes: number): string {
  const tenths = Math.round(bytes / 100_000) || (bytes > 0 ? 1 : 0);
  return `${Math.floor(tenths / 10)}${tenths % 10 ? `.${tenths % 10}` : ""} MB`;
}

/** Millionths of a dollar as dollars, by whole-number arithmetic: 30000 is "$0.03", 1 is "$0.000001". */
export function dollars(micro: number): string {
  const units = Math.floor(micro / 1_000_000);
  const rest = String(micro % 1_000_000).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `$${units}.${rest}`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v);

/** The billing state of an answer: one of the three values the service sends, else null. */
export type BillingState = "not_started" | "started" | "paused";
export const billingState = (v: unknown): BillingState | null => (v === "not_started" || v === "started" || v === "paused" ? v : null);

/**
 * The storage line, or null when the answer is not one this reads exactly. It reads both
 * answers: an older service's (billing not started, no start date) and the one that bills.
 * A field the older one lacks is read only when present, and a present field out of shape
 * makes the line unreadable. `today` is the UTC day, for free days that are still running.
 */
export function storageLine(answer: unknown, today: string = new Date().toISOString().slice(0, 10)): string | null {
  const f = answer as any;
  if (f === null || typeof f !== "object") return null;
  const state = billingState(f.billing);
  if (state === null) return null;
  const b = f.bytes;
  if (b === null || typeof b !== "object" || !whole(b.total) || !whole(f.allowance_bytes) || !whole(f.over_bytes)) return null;
  if (b.tasks !== undefined && !whole(b.tasks)) return null;
  if (f.billing_from !== undefined && !isDay(f.billing_from)) return null;
  if (f.free_until !== undefined && f.free_until !== null && !isDay(f.free_until)) return null;
  if (f.per_day_micro_usd !== undefined && !whole(f.per_day_micro_usd)) return null;
  if (f.read_only !== undefined && typeof f.read_only !== "boolean") return null;
  if (f.read_only_since !== undefined && f.read_only_since !== null && typeof f.read_only_since !== "string") return null;
  const d = f.last_day;
  if (d !== null && d !== undefined) {
    if (typeof d !== "object") return null;
    for (const k of ["billed_micro_usd", "taken_micro_usd"]) if (d[k] !== undefined && !whole(d[k])) return null;
    if (d.free !== undefined && typeof d.free !== "boolean") return null;
  }
  const used = megabytes(b.total);
  const free = megabytes(f.allowance_bytes);
  const over = f.over_bytes > 0;
  let line = over ? `Storage: ${used}, ${megabytes(f.over_bytes)} over the ${free} free` : `Storage: ${used} of ${free} free`;

  if (state === "started") {
    line += over && whole(f.per_day_micro_usd) && f.per_day_micro_usd > 0 ? `: ${dollars(f.per_day_micro_usd)} a day.` : ".";
    if (d && typeof d === "object" && isDay(d.day)) {
      if (d.free === true) line += ` On ${d.day} it was free.`;
      else if (whole(d.taken_micro_usd) && d.taken_micro_usd > 0) line += ` On ${d.day} it was billed ${dollars(d.taken_micro_usd)}.`;
    }
    if (typeof f.free_until === "string" && f.free_until > today) line += ` Free until ${f.free_until}.`;
    if (f.read_only === true) line += " Read-only: its credit does not pay a day of storage. Credit that pays a day opens it again.";
    return line;
  }
  if (state === "paused") return `${line}. Billing is paused: nothing is taken.`;

  // Not started. With the start date: the date. Without it, an older service: what it said.
  if (isDay(f.billing_from)) return `${line}. Billing starts on ${f.billing_from}.`;
  line += ". Billing has not started.";
  if (d !== null && typeof d === "object" && d.over_allowance === true && whole(d.would_be_billed_micro_usd)
    && d.would_be_billed_micro_usd > 0 && isDay(d.day)) {
    line += ` On ${d.day} it would have been billed ${dollars(d.would_be_billed_micro_usd)}.`;
  }
  return line;
}
