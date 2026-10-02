// The one challenge this site lets a passkey sign when the service hands it one: the
// product's challenge to connect with, which Connect and the page that makes an access
// token both use. For src/sign-in.js and src/new-token.js in the browser, and for
// src/me.ts, which hands the challenge on or draws it into the page, alike.
//
// Every signature a passkey makes for this site is the same kind of statement, a
// "webauthn.get" for this origin over whatever challenge the prompt carries, so the
// challenge alone says what was signed. The product's challenge to connect with is 56
// bytes: an expiry of eight, sixteen random and a tag of thirty-two that only the
// product can check (mintPasskeyChallenge in src/http/auth.ts in the product's
// repository). A post's is 32, the SHA-256 of what is signed (passkeyChallengeOf in its
// src/domain/objects.ts), and so are the statements sealing adds. A page that handed a
// passkey whatever challenge came back would let a tampered service have a person sign
// a post they never wrote, and the signature would check as theirs.
//
// The 56 bytes carry no label, so besides their length the expiry is checked: seconds
// since 1970, eight bytes big-endian, no earlier than EARLIEST below and before 2106,
// until when its first four bytes are zero. Never against
// this device's clock, which can be wrong while everything else works. The first eight
// bytes of a hash read as such a time about once in seven billion.
//
// Plain JavaScript and no imports, because it is served to the browser as it is.

/** The earliest expiry a challenge can carry: 14 September 2026. */
const EARLIEST = 1789344000;
/** 2^32 seconds, on 7 February 2106. */
const LATEST = 4294967296;

/** What a person reads on Connect when anything else came back, whichever of the page
 *  and this site's server refused it. The page that makes a token says its own. */
export const NOT_A_SIGN_IN_CHALLENGE =
  "The service asked for a signature on something other than connecting, so your passkey was not asked to sign it, and nothing was sent.";

/**
 * The bytes of a challenge to connect with, from the lowercase hex the product writes
 * it in, or null when it is not one.
 * @param {unknown} hex
 * @returns {Uint8Array | null}
 */
export function signInChallenge(hex) {
  if (typeof hex !== "string" || !/^[0-9a-f]{112}$/.test(hex)) return null;
  // Past 2^53 the number is rounded, and still far past LATEST.
  const expiry = parseInt(hex.slice(0, 16), 16);
  if (expiry < EARLIEST || expiry >= LATEST) return null;
  const bytes = new Uint8Array(56);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
