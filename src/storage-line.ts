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

export function storageLine(answer: unknown): string | null {
  const f = answer as any;
  if (f === null || typeof f !== "object" || f.billing !== "not_started") return null;
  const b = f.bytes;
  if (b === null || typeof b !== "object" || !whole(b.total) || !whole(f.allowance_bytes) || !whole(f.over_bytes)) return null;
  const used = megabytes(b.total);
  const free = megabytes(f.allowance_bytes);
  let line = f.over_bytes > 0
    ? `Storage: ${used}, ${megabytes(f.over_bytes)} over the ${free} free.`
    : `Storage: ${used} of ${free} free.`;
  line += " Billing has not started.";
  const d = f.last_day;
  if (d !== null && typeof d === "object" && d.over_allowance === true && whole(d.would_be_billed_micro_usd)
    && d.would_be_billed_micro_usd > 0 && typeof d.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.day)) {
    line += ` On ${d.day} it would have been billed ${dollars(d.would_be_billed_micro_usd)}.`;
  }
  return line;
}
