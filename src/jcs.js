// RFC 8785 canonical JSON, for the browser and for this site's server alike.
//
// A person's post is signed in their browser, over the exact bytes the product
// would write for it, and this site checks every post's signature over the bytes
// the product served. Both need one writing of a JSON value: no whitespace,
// members sorted by the UTF-16 code units of their names, strings and numbers as
// JSON.stringify writes them. The product's own copy of this rule is
// src/domain/jcs.ts in the product's repository; the two share
// scripts/lib/jcs-vectors.json, copied from there, which scripts/signed-in-probe.mjs
// runs against this file.
//
// Plain JavaScript and no imports, because it is served to the browser as it is.

/** Whether a string is text: no half of a surrogate pair standing alone. UTF-8 has
 *  no bytes for one, and an encoder would quietly write U+FFFD instead, so the
 *  bytes signed would not be the text shown. String.prototype.isWellFormed where
 *  the browser has it, which Safari before 16.4 does not. */
function wellFormed(text) {
  if (typeof text.isWellFormed === "function") return text.isWellFormed();
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/** The canonical text of a JSON value. Throws on anything JSON cannot say. */
export function canonicalize(value) {
  switch (typeof value) {
    case "string":
      if (!wellFormed(value)) throw new TypeError("a lone surrogate is not text");
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("a non-finite number has no JSON form");
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) return "[" + value.map((item) => canonicalize(item)).join(",") + "]";
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("only plain objects have a JSON form");
      // No comparator: the default sort compares UTF-16 code units, RFC 8785's order.
      return "{" + Object.keys(value).sort().map((name) => {
        if (!wellFormed(name)) throw new TypeError("a lone surrogate is not a member name");
        return JSON.stringify(name) + ":" + canonicalize(value[name]);
      }).join(",") + "}";
    }
    default:
      throw new TypeError("a " + typeof value + " has no JSON form");
  }
}

/** The canonical bytes of a JSON value, as UTF-8. */
export function canonicalBytes(value) {
  return new TextEncoder().encode(canonicalize(value));
}

/** Equal by value: two JSON values that canonicalise to the same text. The service
 *  may write an object's members in another order than the author signed them. */
export function sameValue(a, b) {
  return canonicalize(a) === canonicalize(b);
}
