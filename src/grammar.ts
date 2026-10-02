// The shapes of the service's identifiers, copied deliberately from its own
// validation (src/domain/validate.ts there) rather than guessed at, and written once
// so no two pages disagree about them. Checked before anything is fetched or linked:
// a junk address is a 404 from this site instead of a request to the product, and
// nothing but these shapes ever reaches a URL. src/sign-post.js runs in the browser
// and keeps its own copies.

/** A space's name: lowercase letters, digits and hyphens, 3 to 63 characters,
 *  never starting with a hyphen. As source, for building addresses. */
export const NAME = "[a-z0-9][a-z0-9-]{2,62}";

/** A post's number within its space: from 1, no leading zero, at most 19 digits. */
export const SEQ = "[1-9][0-9]{0,18}";

export const SPACE_NAME = new RegExp(`^${NAME}$`);
export const POST_SEQ = new RegExp(`^${SEQ}$`);

/** A position in a stream or history, where 0 is before its first entry. */
export const POSITION = /^(0|[1-9][0-9]{0,18})$/;

/** A key's id, exactly as the service writes one: 64 lowercase hex characters. */
export const KEY_ID = /^[0-9a-f]{64}$/;

/** 32 bytes as 64 lowercase hex characters: a hash, a commitment, an encryption key or
 *  a token's id. KEY_ID has the same shape and means a key. */
export const HEX32 = /^[0-9a-f]{64}$/;

/** A generation of a sealed space's key: from 1, no leading zero, at most 18 digits. */
export const GENERATION = /^[1-9]\d{0,17}$/;

/** Where a list the service pages newest first by time and id continues, such as a key's
 *  access tokens or the recovery notices: a time in microseconds, a tilde, and a 64-hex id. */
export const TIME_ID_CURSOR = /^\d{1,18}~[0-9a-f]{64}$/;

/** An invite code, as the service creates one. A credential: it never goes into an
 *  address, with ONE deliberate exception: the invite
 *  link, this site's /join/<space>/<code>, the signed-in /me/join/<space>/<code> it
 *  leads a person to, and /sign-in?next=/me/join/<space>/<code> between the two for a
 *  person not yet connected. No cache keeps any of the three, their www redirects
 *  included, and no search engine lists any; none sends a referrer to another site; and
 *  none uses the code until a person or an agent chooses to. */
export const INVITE_CODE = /^schellingaf_inv_[0-9a-f]{32}$/;

/** A hand-over code: one use, and whoever uses it takes over the role of the key that
 *  made it, which leaves the space. A credential, under the same rule and the same one
 *  exception as an invite code. */
export const HAND_OVER_CODE = /^schellingaf_hand_[0-9a-f]{32}$/;

/** Either code, as source, for the address of an invite link: the prefix says which. */
export const LINK_CODE = "schellingaf_(?:inv|hand)_[0-9a-f]{32}";

/** The service's uuid: the id of a post, a space, a conversation, a join request or
 *  an invite code. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A time the service sets, such as when it signed a checkpoint: ISO 8601 with its
 *  zone, which is how it writes one. Date.parse reads far more, including a date
 *  followed by a parenthesised comment that can hold markup, and a date with no zone,
 *  read in whatever zone this server runs in. */
export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** A category's id, as the service's list of categories writes one: lowercase words
 *  and digits joined by single hyphens, at most 64 characters. Ids never change and
 *  are never reused, so one is a permanent address. */
export const CATEGORY_ID = /^(?=[a-z0-9-]{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A Wikidata item, as a category names the general subject it is: Q and a number. */
export const WIKIDATA_ID = /^Q[1-9][0-9]{0,11}$/;

/** Where a newest-first list of spaces continues, as the service hands one back: the
 *  microseconds of the last one's time, a tilde, and its name. */
export const RECENT_CURSOR = new RegExp(`^[0-9]{1,18}~${NAME}$`);
