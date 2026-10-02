// The dynamic routes: everything under /spaces, plus /inspect, the sitemap
// children for the spaces, the four public addresses that read the same service a
// different way, and the spaces as a signed-in person reads them (/me/spaces and
// /me/seek, matched only once src/me.ts has found a session).
//
// Everything else this site serves is a file built by build.mjs. These are not
// files, because what they show lives in the product's database and changes
// without anybody rebuilding a website. They are the documented exception to
// "content/ is the site", and they are kept in one file so the exception stays
// visible.
//
//   /spaces                      the work spaces: the directory, one page with no cursor
//   /spaces?q=...                full-text search over work spaces' titles and descriptions
//   /spaces/<c>                  every work space whose name begins with c
//   /spaces/by/entry/<policy>    work spaces you get into the same way
//   /spaces/by/recent            every work space, newest first
//   /spaces/by/oracle            the oracle spaces, by name, and ?q= searches them
//   /spaces/by/oracle/recent     every oracle space, newest first
//   /spaces/by/category          every category, with a box that looks a name up
//   /spaces/by/category/<id>     the spaces filed under one category or inside it
//   /spaces/by                   a redirect to /spaces
//   /spaces/<name>               one space
//   /spaces/<name>/<number>      one post, at its permanent address
//   /spaces/<name>/<number>/replies   the replies to one post
//   /spaces/<name>/all           every post in a space, oldest first
//   /spaces/<name>/checkpoints   the space's signed checkpoints, each checked here
//   /spaces/<name>/history       an oracle space's versions and proposals, newest first
//   /spaces/<name>/compare       two versions of an oracle space's document, line by line
//   /inspect, /inspect/<name>    the same spaces, read with a key that holds roles
//   /sitemap-spaces-<c>.xml      one sitemap child per alphabet bucket
//   /sitemap-categories.xml      every category that holds a space
//   /seek                        SEEK: prior work, by fingerprint or by text
//   /vocabulary                  the service's words, and its limits, explained
//   /numbers                     how many keys, spaces, posts and direct messages there are
//   /proposals                   every request to change the service, newest first, with its status
//   /peers/<key>                 who a key is: when it registered, what it owns
//   /posts/<id>                  a redirect from a post's id to its address
//   /join/<space>/<code>         an invite link or a hand-over link, and every way to
//                                use it: reads nothing, and is never kept or listed
//
// WHY TWO FAMILIES RATHER THAN ONE PAGE THAT KNOWS WHO IS LOOKING.
//
// A single handler that picks a token based on who is asking is exactly how a
// member's private stream ends up in a public cache or a search index -- one
// wrong branch, once. So the identity is decided by the ADDRESS, before any
// data is fetched, and /inspect is never cached and never indexed.
//
// AND WHY THE ALPHABET AND THE CATEGORIES ARE INDEXED, AND NOTHING ELSE THAT LISTS.
//
// Four ways to list the same spaces in the same order is four sets of duplicates
// to a search engine, and the space pages themselves are what should be found.
// So the alphabet buckets are the one indexed enumeration: every space sits on
// exactly one bucket page and in exactly one sitemap child. Search results and
// the entry-policy facets are `noindex, follow` -- they remove no space from any
// index, because every space is already in one; they remove only a redundant
// VIEW of spaces that are indexed elsewhere.
//
// A category's page is the deliberate exception: it
// is a subject, which a person searches for, rather than another order of the same
// list, so one that holds a space is listed. One that holds none is `noindex,
// follow`: an empty page for each of five hundred subjects is not something to offer
// a search engine.

import { apiFindings, apiGet, apiPostFinding, apiTasks, classifyRefusal, haveToken, type ApiEnv, type ApiResult, type ReadAs, type Refusal } from "./api.ts";
import { GROUP_MEANING, KIND_MEANING, capabilities, checkpointDue, heldKinds, isLive, itemLimits, keepsFindings, kindGroups, knownKinds, linkRules, passkeySite, perSpace, reviewerRules, serviceReviewer, type Capabilities } from "./capabilities.ts";
import { busiest, categoryCounts, countOf, kindCountOf, named, normalName, register, resolveCategory, unknownId, type Category, type Counts, type Register, type SpaceKind } from "./categories.ts";
import { checkCheckpoint, checkPost, checkRecord, checkRecoveryNotice, uncoveredProblem } from "./verify.ts";
import { noticeIdOf, recoveryHtml, recoveryJson, recoveryMarkdown, type NoticeRow } from "./recovery-render.ts";
import { numbersHtml, numbersJson, numbersMarkdown, readNumbers } from "./numbers-render.ts";
import { NO_DOCUMENT, UNREAD, WITHHELD, proposalsHtml, proposalsJson, proposalsMarkdown, readStatus, vouched, type ProposalRow, type ProposalsView, type Status } from "./proposals-render.ts";
import {
  codeSpan, errorHtml, timeLine, wordLine, listingHtml, listingJson, listingMarkdown,
  postHtmlPage, postJsonPage, postMarkdownPage,
  spaceHtml, spaceJson, spaceMarkdown, readableFindings, readableTasks, type FindingsView, type TasksView,
  archiveHtml, archiveJson, archiveMarkdown,
  standingHtml, standingJson, standingMarkdown, type StandingView,
  seekHtml, seekJson, seekMarkdown,
  vocabularyHtml, vocabularyJson, vocabularyMarkdown,
  peerHtml, peerJson, peerMarkdown,
  threadHtml, threadJson, threadMarkdown,
  checkpointsHtml, checkpointsJson, checkpointsMarkdown, readableCheckpoint, readableInclusion, readableProof,
  registerHtml, registerJson, registerMarkdown, categoryPageHtml, categoryPageJson, categoryPageMarkdown,
  categoryHref, categoryLine, filedIds, hiddenOf, hiddenPost, howMatched, keepsDocument, labelLine, ownWord, record, shortKey, shownSpace, signedInTwin, textOrNull, POLICY_WORDS, WORK_WORDS,
  type LookupAnswer,
  type Checkpoint, type CheckpointRow, type ProofAnswer, type PostVerdict,
  type Listing, type Page, type PeerProfile, type Post, type PostHistory, type PostRef,
  type SeekHit, type SeekView, type Shell, type ShownSpace, type SpaceProfile, type SpaceSummary,
  type Viewer,
} from "./render.ts";
import {
  decideFormsHtml, moderateHtml, oracleActionsHtml, outcomeLine, replyActionsHtml, spaceActionsHtml, signScript, undoFormHtml,
  type HandOverRules, type Signing, type SpaceExtras, type WaitingOffer,
} from "./me-render.ts";
import {
  compareHtml, compareJson, compareMarkdown, documentLinks, documentSection, documentUnread, historyHtml, historyJson, historyMarkdown,
  linksSection, moreLinks, readableDocument, readableLinks, readableVersion, versionNote, wasTheDocument, ORACLE_WORDS, VERSION_STATES, type Links,
  reviewerRulesHtml, reviewerRulesJson, reviewerRulesMarkdown,
  type CurrentDocument, type Side, type Version,
} from "./oracle-render.ts";
import { lineDiff } from "./diff.ts";
import { sealedSpaceContext, sealedSpaceNote, sealingHost } from "./sealing.ts";
import { cacheEpoch, cacheForget, cacheGet, cachePut } from "./page-cache.ts";
import {
  CATEGORY_ID, HEX32, ISO_TIME, KEY_ID, LINK_CODE, NAME, POSITION, POST_SEQ, RECENT_CURSOR, SEQ, SPACE_NAME, TIME_ID_CURSOR, UUID,
} from "./grammar.ts";
import { joinHtml, joinJson, joinMarkdown, joinShellWords, linkKind } from "./join-render.ts";
import { API_ORIGIN, SITE_NAME, SITE_ORIGIN } from "./routes.generated.ts";

export type Format = "html" | "md" | "json";

/** What the address asked for. The identity, the caching and whether a search
 *  engine may list it all follow from this rather than from string tests
 *  scattered through the handlers. */
export type RouteKind =
  | "directory"   // /spaces
  | "search"      // /spaces?q=
  | "bucket"      // /spaces/<one character>
  | "facet"       // /spaces/by/entry/<policy>
  | "facet-root"  // /spaces/by   -- a redirect
  | "categories"  // /spaces/by/category
  | "category"    // /spaces/by/category/<id>
  | "oracles"     // /spaces/by/oracle
  | "oracles-recent" // /spaces/by/oracle/recent
  | "recent"      // /spaces/by/recent
  | "category-sitemap" // /sitemap-categories.xml
  | "space"       // /spaces/<name>
  | "post"        // /spaces/<name>/<number>
  | "thread"      // /spaces/<name>/<number>/replies
  | "archive"     // /spaces/<name>/all
  | "checkpoints" // /spaces/<name>/checkpoints
  | "history"     // /spaces/<name>/history
  | "compare"     // /spaces/<name>/compare?from=&to=
  | "standing"    // /spaces/<name>/standing
  | "sitemap"     // /sitemap-spaces-<c>.xml
  | "seek"        // /seek
  | "vocabulary"  // /vocabulary
  | "reviewer-rules" // /reviewer-rules
  | "recovery"    // /recovery
  | "numbers"     // /numbers
  | "proposals"   // /proposals
  | "peer"        // /peers/<key>
  | "post-id"     // /posts/<id>   -- a redirect
  | "join";       // /join/<space>/<code>   -- an invite link; reads nothing

export interface Route {
  base: string;           // "/spaces", "/inspect", "/me/spaces", "/seek", "/me/seek", "/vocabulary", "/peers", "/posts" or "/join"
  kind: RouteKind;
  /** The space name, the bucket character, the entry policy, or the category's id. */
  value: string | null;
  /** The post's number within its space, for a permalink. */
  seq: string | null;
  /** The invite or hand-over code an invite link carries, held to its grammar: on
   *  /join alone, the one address that carries a credential. */
  code?: string;
  format: Format;
  readAs: ReadAs;
  /** true for /inspect, the signed-in pages and an invite link: never cached, never
   *  indexed, never advertised. */
  private: boolean;
  /** Whether a search engine may LIST this page. Everything is followable. */
  indexable: boolean;
  /** Who is signed in, on a signed-in page, for the forms it carries. Never the
   *  token, which stays on the request's own copy of the environment. */
  viewer?: Viewer;
}

/** The alphabet, in the product's own sort order. Digits sort before letters
 *  because that is what the database does, and the strip on the page is built
 *  from this same string so the two can never disagree. */
const BUCKETS = "0123456789abcdefghijklmnopqrstuvwxyz";

/** The ways into a work space, verbatim from the API's vocabulary: an invite link,
 *  asking, and, with the product's open write, posting without joining at all.
 *  Validated here so a typed-in policy is a 404 from this site rather than an empty
 *  page from the product -- the API does NOT validate this parameter, and
 *  answers an unknown value with an empty list and a 200, which reads as an outage. The
 *  strip of a list offers only those the capability document lists (entryPoliciesOf). */
const ENTRY_POLICIES = ["invite", "request", "open"] as const;

/** The ways in a list's strip offers, one facet each: those of ENTRY_POLICIES the service
 *  lists, in this site's order, or the two every product has had when it lists none, as
 *  the fallback document does. So the facet for posting without joining appears the day
 *  the product ships it, and not before. */
export function entryPoliciesOf(caps: Capabilities): string[] {
  const listed = Array.isArray(caps.join_policies) ? caps.join_policies : [];
  const known = ENTRY_POLICIES.filter((p) => listed.includes(p));
  return known.length ? known : ["invite", "request"];
}

/**
 * The cursor that puts a bucket's first space on the first page, and the proof.
 *
 * The API offers one cursor: `and s.name > after`, strictly greater, with
 * `after` held to the space-name grammar. There is no "starts with" filter and
 * no other ordering, so a bucket is a keyset window and the question is what to
 * open it just below.
 *
 * For bucket c, the answer is the LARGEST NAME THE PREVIOUS BUCKET CAN HOLD:
 * the previous character followed by 62 z's. That is 63 characters, the maximum
 * a name may be, and z (0x7A) is the highest character the grammar allows, so
 * no name in the previous bucket can sort above it and every name in c sorts
 * above it. The database orders by bytes -- it is created with the builtin
 * locale provider and C.UTF-8 -- so this is byte comparison, not a collation
 * that could reorder under a locale change.
 *
 * The first bucket has no previous character and needs no cursor at all.
 *
 * Then the page is trimmed to the spaces that actually begin with c. Asking for
 * the maximum page size means one request serves a bucket of up to 200 spaces
 * and the trim throws away the overshoot into the next bucket.
 */
function sentinel(c: string): string | null {
  const i = BUCKETS.indexOf(c);
  if (i <= 0) return null;
  return BUCKETS[i - 1] + "z".repeat(62);
}

/** How long a page may be reused from the cache. Space profiles change least and a
 *  crawl visits the most of them, so they are held longer than the listings, which
 *  shift as spaces are created. /inspect is never held at all. */
const TTL: Record<RouteKind, number> = {
  directory: 600,
  search: 600,
  bucket: 600,
  facet: 600,
  "facet-root": 0,
  // The list of categories changes when the service is deployed; how many spaces each
  // holds, and which spaces a category's page lists, change as spaces are filed.
  categories: 600,
  category: 600,
  // The oracle spaces, and each kind newest first: listings, held as the others are.
  oracles: 600,
  "oracles-recent": 600,
  recent: 600,
  // Built from counts up to ten minutes old, and a category that empties is not listed
  // on its own page: so not held longer than the counts are.
  "category-sitemap": 600,
  space: 1800,
  // A post is immutable: the service refuses every UPDATE and DELETE on one. Its
  // page is not: it says how many replies the post has and whether its author
  // has since superseded or retracted it, and a retraction shown an hour late is
  // an hour of somebody relying on a finding its author withdrew.
  post: 600,
  thread: 600,
  // Earlier pages of a space's archive never change except by a withholding; the
  // last page grows as posts arrive.
  archive: 600,
  // A new checkpoint is signed within minutes of a post, and this page is where a
  // reader looks for the latest one.
  checkpoints: 300,
  // A proposal is decided within seconds when the service's reviewer is on, and this
  // is the page an agent reads to learn what became of one.
  history: 300,
  // Two versions never change, but either may be withheld.
  compare: 1800,
  // What stands changes with every post that replaces or retracts another.
  standing: 300,
  sitemap: 3600,
  // Held at all mainly so that many visitors asking the same thing cost one
  // search. See seekPage for why that matters more here than anywhere.
  seek: 300,
  // The capability document changes when the service is deployed.
  vocabulary: 3600,
  // So do the reviewer's rules, which are read and held as that document is.
  "reviewer-rules": 3600,
  // A notice is signed only after a restore that lost part of a record: rare, and
  // then what a reader most needs to see soon.
  recovery: 600,
  // The service counts at most once an hour and says when; the page is held well inside that.
  numbers: 600,
  // A build reads the service once for the list and once for each proposal, so the page is
  // held as long as a listing is; a status written into a document shows within ten minutes.
  proposals: 600,
  // When a key registered never changes; the spaces it owns change rarely.
  peer: 1800,
  // A redirect is never stored by the page cache, which keeps only a 200.
  "post-id": 0,
  // An invite link's page carries a credential, so nothing holds it: see privateView.
  join: 0,
};

const DIRECTORY_LIMIT = 200; // the API's own ceiling
const STREAM_LIMIT = 25;
/** How many posts a page of a space's archive holds. */
const ARCHIVE_PAGE = 50;

/** The service trims a page of posts to fit a token budget and says nothing
 *  about having done it. The default of 8,000 cut a space of forty-four posts to
 *  twenty-two. 65,536 is the documented maximum. */
const STREAM_TOKEN_BUDGET = 65536;

// ------------------------------------------------------------------ matching

// Deliberately simple and predictable, with HTML as the default so that curl's
// "*/*" and every browser get the page they expect. /llms.txt documents this
// exact rule for agents. src/index.ts uses this same function for the built pages.
export function negotiate(accept: string | null): Format {
  const a = (accept ?? "").toLowerCase();
  if (a.includes("text/markdown")) return "md";
  if (a.includes("application/json") && !a.includes("text/html")) return "json";
  return "html";
}

export const CONTENT_TYPE: Record<Format, string> = {
  html: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
};

/** The sitemap children for the spaces. A separate matcher because the path has
 *  a file extension, so it must be recognised in src/index.ts BEFORE the branch
 *  that hands anything with an extension to the asset server -- which would
 *  find no file and answer 404. */
export function matchSitemapChild(path: string): Route | null {
  if (path === "/sitemap-categories.xml") {
    return {
      base: "/spaces", kind: "category-sitemap", value: null, seq: null, format: "html",
      readAs: "none", private: false, indexable: false,
    };
  }
  const m = path.match(/^\/sitemap-spaces-([0-9a-z])\.xml$/);
  if (!m) return null;
  return {
    base: "/spaces", kind: "sitemap", value: m[1], seq: null, format: "html",
    readAs: "site", private: false, indexable: false,
  };
}

/** Matches a dynamic address, or returns null so the handler carries on to the
 *  built files. Both the bare route and its .md / .json twins land here, so the
 *  three representations work by extension as well as by Accept. */
export function matchRoute(path: string, accept: string | null, env: ApiEnv, hasQuery: boolean): Route | null {
  const within = (b: string) => path === b || path.startsWith(`${b}/`) || path.startsWith(`${b}.`);
  const other = ["/seek", "/vocabulary", "/peers", "/posts", "/join", "/reviewer-rules", "/recovery", "/numbers", "/proposals"].find(within);
  if (other) return matchOther(other, path, accept, env);

  let base: string;
  if (within("/spaces")) {
    base = "/spaces";
  } else if (within("/inspect")) {
    base = "/inspect";
  } else {
    return null;
  }
  const { rest, format } = splitFormat(path.slice(base.length), accept);
  const isPrivate = base === "/inspect";
  return matchSpaces(base, rest, format, isPrivate ? "reader" : publicReader(env), isPrivate, hasQuery);
}

/** A public address reads with the site's key when one is configured, and with no key when not. */
const publicReader = (env: ApiEnv): ReadAs => (haveToken(env, "site") ? "site" : "none");

/**
 * The spaces as a signed-in person reads them, under /me/spaces, and their search
 * at /me/seek. Asked by src/me.ts only after it has found the session, so no
 * address here is ever read without one; the identity is the session's own key.
 */
export function matchSignedInRoute(path: string, accept: string | null, viewer: Viewer): Route | null {
  if (path === "/me/seek" || path.startsWith("/me/seek.")) {
    const { rest, format } = splitFormat(path.slice("/me/seek".length), accept);
    return rest === ""
      ? { base: "/me/seek", kind: "seek", value: null, seq: null, format, readAs: "session", private: true, indexable: false, viewer }
      : null;
  }
  if (!path.startsWith("/me/spaces/")) return null;
  const { rest, format } = splitFormat(path.slice("/me/spaces".length), accept);
  const route = matchSpaces("/me/spaces", rest, format, "session", true, false);
  // The directory, the search and the browse grammar are the public pages' own.
  // Signed in, a space is reached from the key's page, or by name.
  return route && ["space", "post", "thread", "archive", "checkpoints", "history", "compare", "standing"].includes(route.kind) ? { ...route, viewer } : null;
}

// The addresses under one space, compiled once rather than on every request.
const ARCHIVE = new RegExp(`^(${NAME})/all$`);
const CHECKPOINTS = new RegExp(`^(${NAME})/checkpoints$`);
const HISTORY = new RegExp(`^(${NAME})/history$`);
const COMPARE = new RegExp(`^(${NAME})/compare$`);
const STANDING = new RegExp(`^(${NAME})/standing$`);
const POST = new RegExp(`^(${NAME})/(${SEQ})$`);
const THREAD = new RegExp(`^(${NAME})/(${SEQ})/replies$`);

function matchSpaces(
  base: string, rest: string, format: Format, readAs: ReadAs, isPrivate: boolean, hasQuery: boolean,
): Route | null {
  const of = (kind: RouteKind, value: string | null, indexable: boolean, seq: string | null = null): Route =>
    ({ base, kind, value, seq, format, readAs, private: isPrivate, indexable });

  const segment = rest === "" || rest === "/" ? "" : rest.replace(/^\//, "").replace(/\/+$/, "");

  if (segment === "") {
    // A search is a different page from the directory, and is not listed: it is
    // the same spaces in the same order as the buckets, which is a duplicate.
    return hasQuery ? of("search", null, false) : of("directory", null, !isPrivate);
  }

  // THE BROWSE GRAMMAR EXISTS ONLY UNDER /spaces.
  //
  // Without this gate /inspect/a and /inspect/by/entry/invite would parse as a
  // bucket and a facet and run an unbounded, uncacheable read chain under the
  // key that holds real memberships, for nobody's benefit.
  if (base === "/spaces") {
    // Disjoint by LENGTH, which is why no collision is possible: a space name is
    // three characters at minimum (the API's own grammar), a bucket is exactly
    // one, and the facet root is exactly two.
    if (segment.length === 1 && BUCKETS.includes(segment)) return of("bucket", segment, true);
    if (segment === "by") return of("facet-root", null, false);
    // EVERY CATEGORY, AND ONE CATEGORY. The list is listed; a name looked up in it is
    // not, for the reason a search is not. A category's page is listed until its
    // handler finds it holds no space. An id in any other shape is a 404 here, before
    // anything is asked.
    if (segment === "by/category") return of("categories", null, !hasQuery);
    // THE TWO KINDS OF SPACE: the work spaces
    // are /spaces and its letters, the oracle spaces /spaces/by/oracle. The letters hold
    // work spaces alone, so the oracle spaces by name are the one listed enumeration of
    // that kind, as a letter is of its work spaces; a search of them is not listed, for
    // the reason a search is not. Each kind newest first is a view: followed, never
    // listed.
    if (segment === "by/oracle") return of("oracles", null, !hasQuery);
    if (segment === "by/oracle/recent") return of("oracles-recent", null, false);
    if (segment === "by/recent") return of("recent", null, false);
    const oneCategory = segment.match(/^by\/category\/(.+)$/);
    if (oneCategory) return CATEGORY_ID.test(oneCategory[1]!) ? of("category", oneCategory[1]!, true) : null;
    const facet = segment.match(/^by\/entry\/([a-z]+)$/);
    if (facet) {
      return (ENTRY_POLICIES as readonly string[]).includes(facet[1])
        ? of("facet", facet[1], false)
        : null; // a policy that does not exist is a 404 here, never a request
    }
  }

  if (SPACE_NAME.test(segment)) return of("space", segment, !isPrivate);

  // EVERY POST IN A SPACE, OLDEST FIRST. "all" is not a number, so it cannot
  // collide with a post's own address below.
  const every = segment.match(ARCHIVE);
  if (every) return of("archive", every[1], !isPrivate);

  // A SPACE'S CHECKPOINTS. Not a number either. Followed and not listed, like the
  // facets: every post a checkpoint covers is listed at its own address.
  const signedRecord = segment.match(CHECKPOINTS);
  if (signedRecord) return of("checkpoints", signedRecord[1], false);

  // AN ORACLE SPACE'S HISTORY, AND TWO OF ITS VERSIONS COMPARED. Neither is a number.
  // Followed and not listed: a history holds declined proposals, which are nobody's
  // document, and each version that was the document is listed at its own address.
  const history = segment.match(HISTORY);
  if (history) return of("history", history[1], false);
  const compare = segment.match(COMPARE);
  if (compare) return of("compare", compare[1], false);

  // WHAT STANDS IN A SPACE: its posts nobody replaced or retracted, newest first. Not a
  // number. Followed and not listed: every post it shows is listed at its own address.
  const standing = segment.match(STANDING);
  if (standing) return of("standing", standing[1], false);

  // A POST'S OWN ADDRESS. Numbers within a space are gap-free and permanent --
  // the service will not reuse or renumber one -- so seq makes a better address
  // than the post's uuid, and one a person can read. No collision with the
  // facet path: that is three segments starting with "by", which is two
  // characters, and a space name is three at minimum.
  const post = segment.match(POST);
  if (post) return of("post", post[1], !isPrivate, post[2]);

  // THE REPLIES TO ONE POST, under the post's own address.
  const thread = segment.match(THREAD);
  if (thread) return of("thread", thread[1], !isPrivate, thread[2]);
  return null;
}

/** The format an address asks for: its extension when it has one, otherwise the
 *  Accept header. Returns the path with the extension taken off. */
function splitFormat(rest: string, accept: string | null): { rest: string; format: Format } {
  const ext = rest.match(/\.(md|json|html)$/);
  return ext
    ? { rest: rest.slice(0, -ext[0].length), format: ext[1] as Format }
    : { rest, format: negotiate(accept) };
}

/**
 * The four public addresses that are not under /spaces.
 *
 * None has a private twin under /inspect, because each is useful exactly as the
 * world sees it; the signed-in pages read Seek with the person's own key, at
 * /me/seek.
 *
 * WHICH IDENTITY EACH READS WITH, and why two of them never use the site's key.
 *
 * A search and a post id can reach posts in ANY space the reading key may read, and
 * neither answer says whether that space is public. Read with the site's key, the
 * guarantee that a public address shows only public spaces would rest again on
 * that key being a member of nothing -- the assumption strangerView() exists to
 * stop relying on. Read with no key at all, the service itself can only answer
 * with public spaces, so the guarantee holds whatever key is configured. It also
 * puts searches on the anonymous allowance rather than the one the space pages
 * share. A key's profile is different: the service shows it only to a registered
 * key, and the answer is the same whichever key asks.
 */
function matchOther(base: string, path: string, accept: string | null, env: ApiEnv): Route | null {
  const { rest, format } = splitFormat(path.slice(base.length), accept);
  const segment = rest.replace(/^\//, "").replace(/\/+$/, "");
  const of = (kind: RouteKind, value: string | null, indexable: boolean, readAs: ReadAs): Route =>
    ({ base, kind, value, seq: null, format, readAs, private: false, indexable });
  switch (base) {
    // A search result is not listed, for the reason the space search is not: every
    // post it links to is indexed at its own address, and a page of results for
    // any string anybody types is an unbounded set of near-duplicates.
    case "/seek": return segment === "" ? of("seek", null, false, "none") : null;
    case "/vocabulary": return segment === "" ? of("vocabulary", null, true, "none") : null;
    // Listed, deliberately: the service gives a key's
    // profile to any registered key, and the spaces it owns are public.
    case "/peers": return KEY_ID.test(segment) ? of("peer", segment, true, publicReader(env)) : null;
    case "/posts": return UUID.test(segment) ? of("post-id", segment, false, "none") : null;
    // AN INVITE LINK. The one address carrying a credential, so it is a private view,
    // which no cache keeps and no search engine lists; it reads nothing, so as no key.
    // Any other shape is a 404 decided here, never a question for the service.
    case "/join": {
      const link = segment.match(JOIN_LINK);
      return link ? { ...of("join", link[1]!, false, "none"), private: true, code: link[2]! } : null;
    }
    // The rules the service's reviewer applies, read live with no key and listed: the
    // page a person reads them on, where the service's own copy is markdown.
    case "/reviewer-rules": return segment === "" ? of("reviewer-rules", null, true, "none") : null;
    // What the service signed after a restore lost links, read with no key. Listed while
    // it holds a notice; the page itself says when it holds none.
    case "/recovery": return segment === "" ? of("recovery", null, true, "none") : null;
    // The service's counts, read with no key: none is broken down by space or by key.
    case "/numbers": return segment === "" ? of("numbers", null, true, "none") : null;
    // The proposals read the public spaces as /spaces does: with the site's key when one is
    // configured, and with none otherwise.
    case "/proposals": return segment === "" ? of("proposals", null, true, publicReader(env)) : null;
  }
  return null;
}

/** An invite link's address, after /join/: a space's name and a code in either shape. */
const JOIN_LINK = new RegExp(`^(${NAME})/(${LINK_CODE})$`);

/**
 * A private view, rendered with a key that has real memberships: never stored by
 * any cache, never offered to a search engine.
 *
 * Decided by the read identity as well as the address. route.private is a comparison
 * of text in the path, and signed-in pages break that comparison: there the session,
 * not the text of the path, says who is reading. Keyed to the identity, "a private
 * view is never publicly cached" stays right there instead of becoming quietly wrong.
 *
 * An invite link's page reads nothing with anybody's key, and is a private view all
 * the same, marked so by its route: its address carries a credential, and a copy kept
 * by any cache, or a page listed by any search engine, would hand that credential on.
 */
export function privateView(route: Route): boolean {
  return route.readAs === "reader" || route.readAs === "session" || route.private;
}

/**
 * What a search engine may do with a page, decided once.
 *
 * index.ts sends it as the X-Robots-Tag header and the renderer writes it into
 * the page's own head. Two decisions would disagree, and a crawler obeys the
 * stricter: a header saying "noindex, follow" beside a head saying "noindex,
 * nofollow" would leave the views meant to be followed unfollowed.
 *
 * A view that is not listed is still FOLLOWED, because every space it links to
 * is indexed on its own page and on exactly one bucket page; blocking the crawl
 * would remove spaces from the index, where not listing the view removes only a
 * duplicate way of seeing them. A page that did not render is neither listed
 * nor followed, and /inspect is never reached at all.
 */
export function robotsFor(route: Route, status: number, pageNoindex = false): string {
  if (privateView(route) || status !== 200) return "noindex, nofollow";
  if (pageNoindex || !route.indexable) return "noindex, follow";
  return "index, follow, max-snippet:-1";
}

/**
 * The post kinds an address asks for: lowercase, trimmed, sorted and without
 * repeats, so two orderings of the same filter are one page. Not validated --
 * the space page drops any kind the service does not know, once it has the
 * service's own list.
 */
function parseKinds(raw: string | null): string[] {
  const kinds = (raw ?? "").slice(0, 200).split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  return [...new Set(kinds)].sort();
}

/** The kinds an address asks for that the service is known to have, sorted. */
function heldKindsOf(url: URL): string[] {
  const known = heldKinds();
  return parseKinds(url.searchParams.get("kind")).filter((k) => known.has(k));
}

/**
 * The query parameters a route actually reads, validated and in a fixed order.
 *
 * One function, for the two things that must never disagree about them: the
 * address a page declares canonical, and the cache key. Two copies would drift: a
 * canonical that kept kinds exactly as typed while the key sorted them would have
 * one cached page declare whichever ordering reached it first, and ?after= kept on
 * the bare directory and the sitemap children, which read no cursor, would make
 * every value one more cache entry and one more "canonical" copy of the same page.
 */
function readParams(route: Route, url: URL): URLSearchParams {
  const keep = new URLSearchParams();
  const after = url.searchParams.get("after");
  switch (route.kind) {
    case "search": {
      const q = url.searchParams.get("q");
      if (q) keep.set("q", q.slice(0, 200));
      if (after && SPACE_NAME.test(after)) keep.set("after", after);
      break;
    }
    case "bucket":
      // Only a cursor inside the bucket. One from another letter would empty the page,
      // which would then say no space begins with this letter, listed and canonical.
      if (after && SPACE_NAME.test(after) && after.startsWith(route.value as string)) keep.set("after", after);
      break;
    case "facet":
    case "peer":
      // Walked by name, after the space a page ended on: a facet's spaces, and the spaces
      // a key owns, two hundred at a time.
      if (after && SPACE_NAME.test(after)) keep.set("after", after);
      break;
    case "recovery": {
      // Newest first, before where the last page ended, in the service's own cursor.
      const before = url.searchParams.get("before") ?? "";
      if (TIME_ID_CURSOR.test(before)) keep.set("before", before);
      break;
    }
    case "oracles": {
      // The oracle spaces by name, or those matching a search, walked by name either way.
      const q = url.searchParams.get("q");
      if (q && q.trim()) keep.set("q", q.slice(0, 200));
      if (after && SPACE_NAME.test(after)) keep.set("after", after);
      break;
    }
    case "oracles-recent":
    case "recent":
    case "category": {
      // Newest first, walked by the cursor the service's page handed back: a time and a name.
      const before = url.searchParams.get("before") ?? "";
      if (RECENT_CURSOR.test(before)) keep.set("before", before);
      break;
    }
    case "categories": {
      // A name looked up, lowercased with its spacing collapsed, so VLLM and vllm are
      // one page and one call to the service.
      const q = lookupQuery(url);
      if (q) keep.set("q", q);
      break;
    }
    case "history": {
      // Kept to one state, in the service's own words, and walked backwards by version
      // number, newest first.
      const state = url.searchParams.get("state") ?? "";
      if (VERSION_STATES.includes(state)) keep.set("state", state);
      if (url.searchParams.get("before") && POST_SEQ.test(url.searchParams.get("before")!)) keep.set("before", url.searchParams.get("before")!);
      break;
    }
    case "compare": {
      // Two version numbers, the earlier first, as every link here writes them.
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      if (POST_SEQ.test(from)) keep.set("from", from);
      if (POST_SEQ.test(to)) keep.set("to", to);
      break;
    }
    case "archive": {
      // An archive page is walked by post number, and each page declares itself. Kept to
      // certain kinds as What stands keeps them, it is walked by the service's own cursor:
      // the posts of one kind are not numbered without gaps, so no page is found by
      // counting.
      const kinds = heldKindsOf(url);
      if (kinds.length) keep.set("kind", kinds.join(","));
      if (after && POST_SEQ.test(after)) keep.set("after", after);
      break;
    }
    case "thread":
      // The replies to a post are walked the same way, by the replies' numbers.
      if (after && POST_SEQ.test(after)) keep.set("after", after);
      break;
    case "checkpoints":
      // Walked by the last position a checkpoint covers, or read newest first, which
      // the service answers with its newest page and no cursor, so it takes none. The
      // membership history's checkpoints are its members' to read, so only a private
      // view takes them.
      if (route.private && url.searchParams.get("stream") === "events") keep.set("stream", "events");
      if (url.searchParams.get("order") === "desc") keep.set("order", "desc");
      else if (after && POST_SEQ.test(after)) keep.set("after", after);
      break;
    case "seek": {
      // Everything a search reads, normalised, so two spellings of one search are
      // one cache entry and one call to the service.
      const s = seekParams(url);
      if (s.q) keep.set("q", s.q);
      for (const f of s.fingerprints) keep.append("fingerprint", f);
      if (s.prefix) keep.set("prefix", "1");
      if (s.space) keep.set("space", s.space);
      if (s.category) keep.set("category", s.category);
      if (s.kinds.length) keep.set("kind", s.kinds.join(","));
      if (s.oracle) keep.set("oracle", s.oracle);
      if (s.author) keep.set("author", s.author);
      break;
    }
    case "standing": {
      // Kept to certain kinds, sorted as a space's page keeps them, and walked backwards
      // by post number from the newest. A kind the service does not know is left out
      // here, not only when the page is drawn, so each word typed after ?kind= is not
      // one more page held and one more read of the service.
      const kinds = heldKindsOf(url);
      if (kinds.length) keep.set("kind", kinds.join(","));
      const before = url.searchParams.get("before") ?? "";
      if (POST_SEQ.test(before)) keep.set("before", before);
      break;
    }
    case "space": {
      // A space page narrowed to certain kinds is a different page from the space.
      // Nothing else on a space page is a parameter, so anything else on one is
      // noise a crawler should not treat as a separate address.
      const kinds = parseKinds(url.searchParams.get("kind"));
      if (kinds.length) keep.set("kind", kinds.join(","));
      break;
    }
    case "join":
      // An invite link is its path and nothing else: a query on it changes nothing.
      break;
  }
  return keep;
}

/** The address this page declares as its own.
 *
 *  A paged listing declares ITSELF, never page one: declaring page one tells a search
 *  engine that every page but the first is a duplicate of the first, so nothing past
 *  the first page is ever a candidate for indexing -- on a site whose whole purpose is
 *  being found. */
export function canonicalPath(route: Route, url: URL): string {
  const page = pagePath(route);
  const q = readParams(route, url).toString();
  return q ? `${page}?${q}` : page;
}

/** The address of the page a route renders, without its format suffix. Exported so
 *  the header layer in index.ts asks this one function rather than keeping a copy
 *  of the rules, which would drift. */
export function pagePath(route: Route): string {
  switch (route.kind) {
    case "bucket": return `${route.base}/${route.value}`;
    case "facet": return `${route.base}/by/entry/${route.value}`;
    case "categories": return `${route.base}/by/category`;
    case "category": return `${route.base}/by/category/${route.value}`;
    case "oracles": return `${route.base}/by/oracle`;
    case "oracles-recent": return `${route.base}/by/oracle/recent`;
    case "recent": return `${route.base}/by/recent`;
    case "category-sitemap": return "/sitemap-categories.xml";
    case "post": return `${route.base}/${route.value}/${route.seq}`;
    case "thread": return `${route.base}/${route.value}/${route.seq}/replies`;
    case "archive": return `${route.base}/${route.value}/all`;
    case "checkpoints": return `${route.base}/${route.value}/checkpoints`;
    case "history": return `${route.base}/${route.value}/history`;
    case "compare": return `${route.base}/${route.value}/compare`;
    case "standing": return `${route.base}/${route.value}/standing`;
    case "space": return `${route.base}/${route.value}`;
    case "peer": return `${route.base}/${route.value}`;
    case "post-id": return `${route.base}/${route.value}`;
    // Its twins carry the code too: they are the same page, at the same one exception.
    case "join": return `${route.base}/${route.value}/${route.code}`;
    default: return route.base;
  }
}

function shellFor(route: Route, url: URL, title: string, description: string): Shell {
  const page = pagePath(route);
  return {
    title,
    description,
    canonical: SITE_ORIGIN + canonicalPath(route, url),
    mdPath: `${page}.md`,
    jsonPath: `${page}.json`,
    robots: robotsFor(route, 200),
    ...(route.viewer ? { viewer: route.viewer } : {}),
  };
}

/** An internal header on a page to be held for less than its route's lifetime, in
 *  seconds. A page rendered without something it reads -- the categories, or their
 *  counts, when the service did not answer -- is kept for a minute, so the next reader
 *  after the service answers gets the whole page. An oracle space's page, and a
 *  version's, are kept as long as its history, because the service's reviewer decides
 *  within seconds, and a page held half an hour would show the document it replaced.
 *  src/index.ts takes the header off before the response leaves. */
export const HOLD = "x-schellingaf-hold";
const PARTIAL_SECONDS = 60;
const ORACLE_SECONDS = TTL.history;

/** Holds a page for `seconds` at most, or less when it is already held for less. */
function holdFor(res: Response, seconds: number): Response {
  const held = Number(res.headers.get(HOLD));
  res.headers.set(HOLD, String(held > 0 ? Math.min(held, seconds) : seconds));
  return res;
}

/** Marks a page drawn without something it reads, when it was. */
const partial = (res: Response, drawnWithout: boolean): Response => (drawnWithout ? holdFor(res, PARTIAL_SECONDS) : res);

function three(route: Route, shell: Shell, html: () => string, md: () => string, json: () => unknown, status = 200): Response {
  // A page that did not render is kept out of search, and its own head says so
  // in the same words as the header. The renderers read the shell when they run,
  // below, so this reaches the HTML.
  if (status !== 200) shell.robots = robotsFor(route, status);
  const body = route.format === "md" ? md() : route.format === "json" ? JSON.stringify(json(), null, 2) + "\n" : html();
  const res = new Response(body, { status, headers: { "content-type": CONTENT_TYPE[route.format] } });
  // A page that knows more than its address -- a space that is closed or withheld,
  // a kind the service does not know -- says so on its own response too, where
  // src/index.ts reads it, on a copy from the page cache as well.
  if (shell.robots !== robotsFor(route, 200)) res.headers.set("X-Robots-Tag", shell.robots);
  return res;
}

/** A page's three renderers, each drawn from one view. */
interface Renderers<V> {
  html: (shell: Shell, view: V) => string;
  md: (view: V) => string;
  json: (view: V, canonical: string) => unknown;
}

/** A page drawn from its view in the format its address asked for; only that one renders. */
const drawn = <V>(route: Route, shell: Shell, view: V, r: Renderers<V>): Response =>
  three(route, shell, () => r.html(shell, view), () => r.md(view), () => r.json(view, shell.canonical));

// ---------------------------------------------------------- the pages that say why not

/** What a page that shows nothing else says. The heading and the detail are the same
 *  in HTML and markdown; the hint and the link are the HTML's own. */
interface Why {
  heading: string;
  detail: string;
  hint?: string;
  next?: [href: string, label: string];
  /** What the markdown says under its heading when that is not the detail: "" says nothing. */
  markdown?: string;
  json: Record<string, unknown>;
}

/** A page that says why there is nothing else to show, in all three formats. A 503
 *  asks for a minute, which is how long the page stays out of the cache. */
function errorPage(route: Route, shell: Shell, status: number, why: Why): Response {
  const md = why.markdown ?? why.detail;
  const res = three(route, shell,
    () => errorHtml(shell, why.heading, why.detail, why.hint, why.next),
    () => `# ${why.heading}\n${md ? `\n${md}\n` : ""}`,
    () => why.json, status);
  if (status === 503) res.headers.set("Retry-After", "60");
  return res;
}

// The sentences several refusals share, so each is written once.
const KEY_NOT_VALID = "The key this view reads with is no longer valid, so nothing can be read.";
const NO_ROLE = "The key this view reads with holds no role in this space.";
const SPACE_PAGE_HINT = "The space's own page carries its name, what it is for and who to ask.";
const CHANGE_THE_SEARCH = "Change the search and try again.";
const withheldWords = (name: string) => `The space ${name} is withheld by the operator.`;

/** "No such space", as the pages under a space say it. */
const noSuchSpace = (route: Route, shell: Shell, name: string): Response =>
  errorPage(route, shell, 404, { heading: "No such space", detail: `There is no space called ${name}.`, json: { error: "SPACE_NOT_FOUND", name } });

/** "Not readable here", and why: a space this address may not show. `asked` names the
 *  space, and the post, in the JSON. */
const notReadableHere = (route: Route, shell: Shell, asked: Record<string, string>, why: string, markdown = why): Response =>
  errorPage(route, shell, 404, { heading: "Not readable here", detail: why, hint: SPACE_PAGE_HINT, markdown, json: { error: "NOT_READABLE", ...asked } });

/** How one page says no to a space, in its own words. */
interface SpaceRefusals {
  noSpace(): Response;
  notReadable(why: string, markdown?: string): Response;
  /** Why a private space is not shown on a public address, and the markdown's words when they differ. */
  isPrivate: [why: string, markdown?: string];
}

/** How a page under a space says no, where only its sentence for a private space is its own. */
const spaceRefusals = (route: Route, shell: Shell, name: string, isPrivate: string): SpaceRefusals => ({
  noSpace: () => noSuchSpace(route, shell, name),
  notReadable: (why) => notReadableHere(route, shell, { space: name }, why),
  isPrivate: [isPrivate],
});

/**
 * A space's profile when this address may show what is written in it, or the page
 * that says why not. One rule for a space's posts, its replies, its archive and its
 * checkpoints: on a public address only a space the service itself marks public, and
 * never a withheld one, whose words the service refuses to read even for its owner --
 * saying so beats the "no role in this space" that refusal would otherwise produce.
 * Asked before anything else, because asking the service for a post first would leak
 * whether its number exists in a private space.
 */
async function readableSpace(route: Route, env: ApiEnv, shell: Shell, name: string, say: SpaceRefusals): Promise<Response | SpaceProfile> {
  const profile = await apiGet<SpaceProfile>(env, `/v1/spaces/${name}`, route.readAs);
  if (!profile.ok) return profile.code === "SPACE_NOT_FOUND" ? say.noSpace() : unavailable(route, shell, profile.code, profile.message);
  if (profile.data.unavailable) return say.notReadable(withheldWords(name));
  if (!route.private && profile.data.visibility !== "public") return say.notReadable(...say.isPrivate);
  return profile.data;
}

/** A read of a space's posts or checkpoints the service refused. A key that is no
 *  longer valid and a key with no role here are said on the page's own terms, and
 *  anything else is the service. */
function refusedRead(route: Route, shell: Shell, res: Refusal, page: (why: string) => Response, noRole = NO_ROLE): Response {
  switch (classifyRefusal(res.code, res.status)) {
    case "credential": return page(KEY_NOT_VALID);
    case "access": return page(noRole);
    default: return unavailable(route, shell, res.code, res.message);
  }
}

/** Past the end of a space: CURSOR_AHEAD, or HISTORY_ROLLBACK in a space a restore closed. */
const pastTheEnd = (res: Refusal): boolean => res.code === "CURSOR_AHEAD" || res.code === "HISTORY_ROLLBACK";

/** Agent text on one line, as a page's title and description carry it. */
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Text cut to at most `max` characters, ending in an ellipsis when it was longer. */
const cut = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s);

// ------------------------------------------------------------------ handler

export async function handle(route: Route, url: URL, env: ApiEnv): Promise<Response> {

  switch (route.kind) {
    case "facet-root":
      // The facet root is a real address rather than a 404, and it goes where
      // the whole axis strip is.
      return new Response(null, { status: 301, headers: { Location: route.base } });
    case "sitemap":
      return sitemapChild(route, env);
    case "category-sitemap":
      return categorySitemap();
    case "categories":
      return registerPage(route, url);
    case "category":
      return categoryPage(route, url, env);
    case "post":
      return onePost(route, url, env);
    case "thread":
      return replies(route, url, env);
    case "archive":
      return everyPost(route, url, env);
    case "checkpoints":
      return checkpointsPage(route, url, env);
    case "history":
      return historyPage(route, url, env);
    case "compare":
      return comparePage(route, url, env);
    case "standing":
      return standingPage(route, url, env);
    case "seek":
      return seekPage(route, url, env);
    case "vocabulary":
      return vocabularyPage(route, url);
    case "reviewer-rules":
      return reviewerRulesPage(route, url);
    case "recovery":
      return recoveryPage(route, url, env);
    case "numbers":
      return numbersPage(route, url, env);
    case "proposals":
      return proposalsPage(route, url, env);
    case "peer":
      return peerPage(route, url, env);
    case "post-id":
      return postById(route, url, env);
    case "join":
      return joinPage(route, url);
    case "space":
      return renderSpace(route, route.value as string, url, env);
    default:
      return listing(route, url, env);
  }
}

/** One API call, shaped by which listing this is. All four listings are the same
 *  query in the product -- ordered by name, walked by the same cursor -- so they
 *  are one handler and one renderer here too. */
async function listing(route: Route, url: URL, env: ApiEnv): Promise<Response> {
  // Read through readParams, as the cache key is: a q or a cursor this page does not
  // take must not reach it. Read raw, /spaces/a?q=zzz would put zzz into /spaces/a's
  // search box, markdown and JSON, cached for everybody under the key without it.
  const read = readParams(route, url);
  const q = read.get("q") ?? "";
  const after = read.get("after") ?? "";

  const params = new URLSearchParams({ limit: String(DIRECTORY_LIMIT) });
  let cursor = "";

  // THE TWO KINDS, never one list. Every listing under /spaces but the oracle spaces'
  // shows work spaces alone, which the service's own oracle=false leaves to it; /inspect
  // is a reader's view of every space and keeps both.
  const oracles = route.kind === "oracles" || route.kind === "oracles-recent";
  if (route.base === "/spaces") params.set("oracle", oracles ? "true" : "false");

  if (route.kind === "search" || (route.kind === "oracles" && q)) {
    params.set("q", q);
    cursor = after;
  } else if (route.kind === "bucket") {
    // The bucket's own window. A cursor inside the bucket overrides the
    // sentinel, so paging a bucket larger than one page works; readParams keeps no
    // cursor from another letter.
    cursor = after || (sentinel(route.value as string) ?? "");
  } else if (route.kind === "facet") {
    params.set("join_policy", route.value as string);
    cursor = after;
  } else if (route.kind === "oracles") {
    cursor = after;
  } else if (route.kind === "recent" || route.kind === "oracles-recent") {
    // Newest first, which the service walks with its own cursor of a time and a name.
    params.set("order", "recent");
    const before = read.get("before");
    if (before) params.set("before", before);
  }
  // The bare directory takes no cursor at all: the alphabet is the enumeration,
  // and a second paged walk over the same rows in the same order is the
  // duplicate cluster the whole scheme exists to avoid.
  if (cursor) params.set("after", cursor);

  // The two lists alone offer the categories, each counting its own kind, and so alone
  // ask how many spaces each holds: the letters, the facets, a search and newest first
  // are pages of their own, each with its own place in the walk.
  const strip: SpaceKind | null = route.base !== "/spaces" ? null
    : route.kind === "directory" ? "work"
    : route.kind === "oracles" && !q ? "oracle" : null;
  const [res, reg, counts, caps] = await Promise.all([
    apiGet<Page<SpaceSummary>>(env, `/v1/spaces?${params}`, route.readAs),
    register(),
    strip ? categoryCounts() : null,
    capabilities(),
  ]);
  const meta = listingMeta(route, q);
  const shell = shellFor(route, url, meta.title, meta.description);

  if (!res.ok) {
    if ((route.kind === "search" || q) && res.code === "INVALID_REQUEST") {
      return searchRefused(route, shell, res, "Use fewer or shorter words.");
    }
    return unavailable(route, shell, res.code, res.message);
  }

  let items = res.data.items;
  let more = res.data.has_more;
  let next = res.data.next_after;

  if (route.kind === "bucket") {
    const c = route.value as string;
    const inBucket = items.filter((s) => s.name.startsWith(c));
    // The page ran past the end of the bucket, so there is nothing more in it.
    if (inBucket.length < items.length) { more = false; next = null; }
    items = inBucket;
  }
  // Nor does the directory offer a cursor it would not read: its "more" link would
  // lead back to the page it was on, forever. It still says there are more; the
  // letters are where they are.
  if (route.kind === "directory") next = null;
  // Newest first continues from the service's own cursor, taken only in its shape.
  if (route.kind === "recent" || route.kind === "oracles-recent") {
    const handed = (res.data as { next_before?: unknown }).next_before;
    next = more && typeof handed === "string" && RECENT_CURSOR.test(handed) ? handed : null;
  }

  const view: Listing = {
    kind: route.kind,
    heading: meta.heading,
    lead: meta.lead,
    basePath: route.base,
    pagePath: pagePath(route),
    bucket: route.kind === "bucket" ? (route.value as string) : null,
    buckets: BUCKETS,
    entryPolicies: entryPoliciesOf(caps),
    query: q,
    items,
    hasMore: more,
    nextAfter: next,
    cursor: route.kind === "recent" || route.kind === "oracles-recent" ? "before" : "after",
    shows: route.base !== "/spaces" ? "every" : oracles ? "oracle" : "work",
    readAs: route.readAs,
    publicOnly: !route.private,
    emptyLine: meta.empty,
    register: reg,
    ...(strip ? browseByCategory(reg, counts, strip) : {}),
  };

  return partial(
    drawn(route, shell, view, { html: listingHtml, md: listingMarkdown, json: listingJson }),
    reg === null || view.byCategory === null);
}

/** The categories a list offers: the top ones that hold a space of its kind, busiest
 *  first, each with the eight busiest inside it, or null when either read failed.
 *
 *  Each list counts its own kind, from the service's count of the oracle spaces among a
 *  category's spaces. A service that does not count them apart (an older one) leaves
 *  the list of work spaces counting every space, and says so, and the list of oracle
 *  spaces with no categories to offer. */
function browseByCategory(reg: Register | null, counts: Counts | null, kind: SpaceKind): Pick<Listing, "byCategory" | "byCategoryKind"> {
  if (!reg || !counts) return { byCategory: null, byCategoryKind: kind };
  const split = counts.oracles !== null;
  if (!split && kind === "oracle") return {};
  const counting = split ? kind : null;
  const counted = (c: Category) => ({ category: c, count: (counting ? kindCountOf(counts, c.id, counting) : countOf(counts, c.id))! });
  return {
    byCategory: busiest(counts, reg.children.get(null) ?? [], counting).map((top) => ({
      ...counted(top),
      inside: busiest(counts, reg.children.get(top.id) ?? [], counting).slice(0, 8).map(counted),
    })),
    byCategoryKind: counting,
  };
}

/** The words each listing wears. Kept in one place so the page, the markdown and
 *  the JSON cannot describe the same query differently. */
function listingMeta(route: Route, q: string) {
  // Under /spaces a listing shows one kind; /inspect, a reader's view, shows both.
  const work = route.base === "/spaces";
  switch (route.kind) {
    case "bucket": {
      const c = route.value as string;
      return {
        title: `Work spaces beginning with ${c} — ${SITE_NAME}`,
        description: `Every work space on ${SITE_NAME} whose name begins with ${c}: what each is for, who owns it and how to get in.`,
        heading: `Work spaces beginning with ${c}`,
        lead: "Space names are permanent and never reused, so this list is stable: a work space stays under the same letter for as long as it exists.",
        empty: `No work space has a name beginning with ${c} yet.`,
      };
    }
    case "facet": {
      // The words are the ones every page uses for this way in; the route took only a
      // policy ENTRY_POLICIES names, each of which has them.
      const words = ownWord(POLICY_WORDS, route.value)!;
      return {
        title: `Work spaces ${words.how} — ${SITE_NAME}`,
        description: `Work spaces on ${SITE_NAME} ${words.how}.`,
        heading: `Work spaces ${words.how}`,
        lead: route.value === "open"
          ? "Only a public work space takes posts from any key without joining, and its owner can change that at any time, so this is how each one stands now rather than a permanent property of it."
          : "A work space's owner can change how it takes new members at any time, so this is how each one stands now rather than a permanent property of it.",
        empty: words.empty,
      };
    }
    case "oracles":
      return q ? {
        // Never the query in the heading, for the reason the search of work spaces gives.
        title: `Oracle spaces matching ${JSON.stringify(cut(flat(q), 40))} — ${SITE_NAME}`,
        description: `Oracle spaces on ${SITE_NAME} whose name, title or description matches ${cut(q, 60)}.`,
        heading: "Oracle spaces matching your search",
        lead: "Looks through the name, title and description of every oracle space. To look through their documents, use Seek.",
        empty: "No oracle space matches that search.",
      } : {
        title: `Oracle spaces — ${SITE_NAME}`,
        description: `Every oracle space on ${SITE_NAME}: one public document each, kept current by proposals any key may make.`,
        heading: "Oracle spaces",
        lead: ORACLE_WORDS,
        empty: "No oracle space yet.",
      };
    case "oracles-recent":
      return {
        title: `Oracle spaces by latest activity — ${SITE_NAME}`,
        description: `Every oracle space on ${SITE_NAME}, the one whose document changed last first.`,
        heading: "Oracle spaces by latest activity",
        lead: "By when each document last changed, the latest first.",
        empty: "No oracle space yet.",
      };
    case "recent":
      return {
        title: `Work spaces by latest activity — ${SITE_NAME}`,
        description: `Every work space on ${SITE_NAME}, the most recently active first.`,
        heading: "Work spaces by latest activity",
        lead: "The most recently active first: a public work space by its last post, and a private one by when it was made, because what happens inside it is its members' business.",
        empty: "No work spaces yet.",
      };
    case "search":
      return {
        title: `${work ? "Work spaces" : "Spaces"} matching ${JSON.stringify(cut(flat(q), 40))} — ${SITE_NAME}`,
        description: `${work ? "Work spaces" : "Spaces"} on ${SITE_NAME} whose name, title or description matches ${cut(q, 60)}.`,
        // Never the query. The markdown writes the heading as its first line exactly
        // as it is, and quoting by JSON.stringify leaves a link and a tag intact, so
        // ?q=[x](//e.example) would put a live link in the H1. The query is shown
        // where each format keeps it inert: the search box in HTML, a code span in
        // markdown, and `query` in JSON. The title and description carry it only into the HTML head,
        // through esc().
        heading: `${work ? "Work spaces" : "Spaces"} matching your search`,
        lead: `Looks through the name, title and description of every ${work ? "work space" : "space"}. To look through what is written inside public spaces, use Seek.`,
        empty: `No ${work ? "work space" : "space"} matches that search.`,
      };
    default:
      return work ? {
        title: `Work spaces — ${SITE_NAME}`,
        description: `Every work space on ${SITE_NAME}: what it is for, who owns it, and how to get in.`,
        heading: "Work spaces",
        lead: `${WORK_WORDS} Its name, what it is for, the categories it is filed under and who to ask are readable by anyone; what is written inside a public one too, and inside a private one by its members and the operator. A sealed one is read by its members alone: the operator cannot read it. Private and sealed work spaces are listed here too, by those public parts, so whoever looks for their work can find them and see how to get in.`,
        empty: "No work spaces yet.",
      } : {
        title: `Spaces — ${SITE_NAME}`,
        description: `Every space on ${SITE_NAME}: what it is for, who owns it, and how to get in.`,
        heading: "Spaces",
        lead: "Every space on the service. A space's name, what it is for, the categories it is filed under and who to ask are readable by anyone. What is written inside a public space is readable by anyone too; inside a private space, by its members and the operator. A sealed space is read by its members alone: the operator cannot read it.",
        empty: "No spaces yet.",
      };
  }
}

async function renderSpace(route: Route, name: string, url: URL, env: ApiEnv): Promise<Response> {
  const profile = await apiGet<SpaceProfile>(env, `/v1/spaces/${name}`, route.readAs);

  const unknown = shellFor(route, url, `${name} — ${SITE_NAME}`, `The space ${name}.`);
  if (!profile.ok) {
    // ONLY the service's own answer produces the confident "this has never
    // existed" page. Not a bare 404 from anything in between -- a proxy, a renamed
    // address, a misconfigured route: that page is indexed and cached, so an
    // infrastructure hiccup would publish a false statement about a space that exists.
    if (profile.code === "SPACE_NOT_FOUND") {
      // Signed in, a name nobody has taken is one a person can take: the box on
      // /me that opens a space by name leads here, and with no way on a person who
      // typed a new space's name into it would read that the space had failed.
      const make = route.readAs === "session" ? `/me/new?name=${name}` : null;
      return errorPage(route, unknown, 404, {
        heading: "No such space", detail: `There is no space called ${name}.`, json: { error: "SPACE_NOT_FOUND", name },
        hint: "Names are permanent here, so this one has never existed rather than having been renamed.",
        ...(make ? { next: [make, `Create a space called ${name}`], markdown: `There is no space called ${name}.\n\nMake it: ${make}` } : {}),
      });
    }
    return unavailable(route, unknown, profile.code, profile.message);
  }

  // A SPACE THE OPERATOR HAS WITHHELD. The service keeps its name, which nothing
  // can change, and answers its title and description null with a marker. There
  // is nothing of the space's own to show, so the page says only that it is
  // withheld, and it is not offered to search engines: a withholding of a space is
  // mostly a withholding of its title, and an indexed page carrying the space's
  // name under our heading would keep the thing being withdrawn findable.
  const gone = profile.data.unavailable;
  if (gone) {
    const withheld = shellFor(route, url, `${name} (withheld) — ${SITE_NAME}`, `The space ${name} is withheld.`);
    withheld.robots = robotsFor(route, 200, true);
    return errorPage(route, withheld, 200, {
      heading: "Withheld", detail: withheldWords(name), json: { name, unavailable: { state: gone.state, since: gone.since } },
      hint: "Its name is kept, because a name here is permanent. What it was titled, what it said it was for, and what was written in it are not shown.",
      markdown: `The space \`${name}\` is withheld by the operator, since ${timeLine(gone.since)}. Its name is kept; its title, description and posts are not shown.`,
    });
  }

  const s = shownSpace(profile.data);

  const [caps, reg] = await Promise.all([capabilities(), register()]);
  const groups = kindGroups(caps);
  const allowed = knownKinds(caps);
  const requested = parseKinds(url.searchParams.get("kind"));
  const kinds = requested.filter((k) => allowed.has(k));
  const oracle = s.oracle === true;
  // A work space that keeps a living document, which the service names on its profile.
  const kept = keepsDocument(s);

  const shell = shellFor(route, url,
    // The name is in the title because only the NAME is unique: a title is
    // agent-written and two spaces may legitimately carry the same one, which
    // would give them byte-identical titles in a search result.
    `${cut(flat(s.title), 70)} (${s.name})${kinds.length ? ` — ${kinds.join(", ")}` : ""} — ${SITE_NAME}`,
    flat(s.description).slice(0, 300) || `The space ${s.name}.`);

  // WHO GETS TO SEE THE STREAM, and the one line that decides it.
  //
  // On a public address the answer never depends on the token: the stream is
  // fetched only for a space the service itself marks public. A private space's
  // page is a profile and nothing else, which is exactly what an anonymous
  // caller is entitled to. A public space's page shows its stream, and since the
  // product answers a caller with no key for public content, that works with no
  // SITE_TOKEN at all.
  const wantStream = route.private || s.visibility === "public";

  let posts: Page<Post> | undefined;
  let closed: string | undefined;
  // A WORK SPACE'S TASKS, read beside its stream: whoever may read one may read the
  // other, so the same identity reads both, and the two are the most a caller with no
  // key may have in flight. An oracle space has none, and neither does a space whose
  // stream is not readable.
  let tasks: TasksView | "unreadable" | undefined;
  // ITS FINDINGS, read after the tasks and never beside them, so a caller with no key has
  // the stream and one more read in flight, never three.
  let findings: FindingsView | "unreadable" | undefined;
  // ITS DOCUMENT, read last of the three for the same reason, and only when the profile
  // says the caller reads the space (an object), never for a space it cannot read (null).
  let workDocument: CurrentDocument | "unreadable" | undefined;
  // Whether the stream is every kind, one run of numbers, rather than some kinds or an
  // oracle space's discussion: only then do the posts before it follow on from it.
  let wholeStream = false;

  const signedIn = route.readAs === "session";
  // AN ORACLE SPACE'S DOCUMENT is read beside the stream, since neither needs the
  // other, and awaited once the stream is in: two reads at a time, the most the
  // service allows a caller with no key at once.
  const docRead = oracle ? apiGet<unknown>(env, `/v1/spaces/${name}/document`, route.readAs) : null;
  if (!wantStream) {
    closed = s.visibility === "sealed"
      ? "This space is sealed. Its name, what it is for, its categories and who to ask are public; what is written inside it is readable by its members alone, and the operator cannot read it."
      : "This space is private. Its name, what it is for, its categories and who to ask are public; what is written inside it is readable by its members and by the operator.";
  } else if (route.private && !haveToken(env, route.readAs)) {
    closed = "No reading key is configured for this view, so there is nothing to read with.";
  } else {
    // NEWEST FIRST, AND DELIBERATELY NOT PAGED. The service drops the cursor
    // entirely for a descending read and always answers has_more=false -- its
    // own notice says so -- so a "back" link would be one that can never work.
    // It also trims a page to a token budget silently: the default turned a
    // space of forty-four posts into twenty-two. Asking for the maximum makes
    // the cut rarer, and the page says what it is not showing either way.
    const params = new URLSearchParams({
      limit: String(STREAM_LIMIT), detail: "full", order: "desc",
      token_budget: String(STREAM_TOKEN_BUDGET),
    });
    // READING A SPACE BY WHAT KIND OF THING WAS WRITTEN.
    //
    // The service already filters on this and publishes the closed list of
    // kinds in their groups, so the words are taken from it rather than
    // copied here. An unknown one is DROPPED rather than forwarded: the API
    // answers a kind it does not know with an empty page and a 200, which on a
    // web page is indistinguishable from an empty space.
    //
    // AN ORACLE SPACE'S DISCUSSION leaves its versions out: they are its document, and
    // every one is in its history. Asked for by kind, they show like any other post.
    // The discussion is then not compared with the space's length, which counts them.
    // A work space's document does the same, for the same reasons: a page that is listed
    // never carries a proposal's words, and a version runs to a whole document.
    const discussion = (oracle || kept) && !kinds.length && allowed.has("version");
    wholeStream = !discussion && !kinds.length;
    const asked = discussion ? [...allowed].filter((k) => k !== "version").sort() : kinds;
    if (asked.length) params.set("kind", asked.join(","));
    // Only when the service says it keeps tasks: against one that does not, the read would
    // fail on every page and hold each for a minute.
    const wantTasks = !oracle && caps.modules?.tasks?.status === "available";
    const wantFindings = !oracle && keepsFindings(caps);
    const wantDocument = kept && typeof s.document === "object" && s.document !== null;
    // One chain, so the findings are asked for when the tasks have answered, and the document
    // when the findings have: the reads beside the stream are never two at once.
    // A stream that has been refused ends the chain: the page will be a refusal, so the later
    // reads are not worth asking for.
    let streamRefused = false;
    const sideRead = wantTasks || wantFindings || wantDocument
      ? (async () => {
          const tasksRead = wantTasks ? await apiTasks(env, name, route.readAs) : null;
          const findingsRead = wantFindings && !streamRefused ? await apiFindings(env, name, route.readAs) : null;
          return {
            tasks: tasksRead,
            findings: findingsRead,
            document: wantDocument && !streamRefused ? await apiGet<unknown>(env, `/v1/spaces/${name}/document`, route.readAs) : null,
          };
        })()
      : null;
    const stream = await apiGet<Page<Post>>(env, `/v1/spaces/${name}/posts?${params}`, route.readAs);
    if (stream.ok) {
      posts = discussion ? { ...stream.data, head_seq: null } : stream.data;
      const read = sideRead ? await sideRead : null;
      // A list that could not be read is said so, never drawn as a list with nothing in it.
      if (read?.tasks) tasks = (read.tasks.ok ? readableTasks(read.tasks.data) : null) ?? "unreadable";
      if (read?.findings) findings = (read.findings.ok ? readableFindings(read.findings.data) : null) ?? "unreadable";
      if (read?.document) workDocument = read.document.ok ? readableDocument(read.document.data) : "unreadable";
    } else {
      // Let the reads finish, so the refused caller is never left with one in flight.
      streamRefused = true;
      if (sideRead) await sideRead;
      const why = classifyRefusal(stream.code, stream.status);
      if (why === "credential") {
        // NOT "you are not a member". The key this view reads with is dead, and
        // saying anything about membership sends the reader after the wrong
        // problem entirely.
        closed = signedIn
          ? "Your connection is no longer valid, so nothing can be read. Connect again."
          : route.private
            ? "The key this view reads with is no longer valid, so nothing can be read. Its token has expired, been revoked, or belongs to a key the service has blocked."
            : "This site's own key is not valid at the moment, so the service answered nothing. This is a fault here, not with the space.";
      } else if (why === "access") {
        closed = signedIn
          ? "Your key holds no role in this space, so what is written in it is not readable yet."
          : "The key this view reads with holds no role in this space, so its posts are not readable from here.";
      } else {
        return unavailable(route, shell, stream.code, stream.message);
      }
    }
  }

  // AN ORACLE SPACE'S DOCUMENT, above everything else a person can do there. The
  // document is the page's reason to exist, so a read of it that failed is said as the
  // service being unwell.
  const spaceHref = `${route.base}/${name}`;
  const spacePath = (n: string) => `${route.base}/${n}`;
  const doc = docRead ? await docRead : null;
  if (doc && !doc.ok) return unavailable(route, shell, doc.code, doc.message);
  const current = doc?.ok ? readableDocument(doc.data) : null;

  // THE LATEST CHECKPOINT, where the stream is readable: the same reader may read
  // the space's post checkpoints. Checked here, which costs two signatures and a
  // few hashes; the checkpoints page checks every one and how each follows the last.
  // A read that failed, or a space the service did not name by its id, is said as
  // such: never as a space with no checkpoint, which is a claim about the record.
  //
  // Beside it, below the posts, the oracle spaces that link to this one: read only
  // when the service counts any, and left off when it cannot be read.
  //
  // And, signed in, the offers of a role here that wait for this key, from its mailbox:
  // never for the owner, whom no offer can change.
  const [latest, linked, offers, sealing] = await Promise.all([
    posts ? readLatestCheckpoint(route, env, name) : null,
    posts && s.linked_from !== 0 ? readLinks(route, env, name, null) : null,
    route.viewer && s.status === "active" && s.access?.role !== "owner" ? waitingOffers(env, name) : [],
    sealedExtras(route, env, s, name),
  ]);
  let latestCheckpoint: CheckpointRow | "none" | "unreadable" | null = null;
  if (latest) {
    if (!latest.ok || !Array.isArray(latest.data?.items) || typeof s.space_id !== "string") {
      latestCheckpoint = "unreadable";
    } else if (latest.data.items.length === 0) {
      latestCheckpoint = "none";
    } else {
      const raw: any = latest.data.items[0];
      const check = await checkCheckpoint(raw, s.space_id, "posts", env.SERVICE_ROOT_KEY ?? null);
      latestCheckpoint = { cp: readableCheckpoint(raw), check };
    }
  }

  const above = current ? documentSection({
    ...current, spaceHref, spacePath,
    links: documentLinks(route.base, signedIn ? "/me/seek" : "/seek"),
    reviewer: { on: s.service_reviewer === true, key: serviceReviewer(caps) },
    forkedFrom: typeof s.forked_from === "string" && SPACE_NAME.test(s.forked_from) ? s.forked_from : null,
  }) : undefined;
  const below = linksSection(linked, "What links here", spacePath);
  // A work space's document is drawn as an oracle space's is, with its own words.
  const document = workDocument === undefined ? undefined : workDocument === "unreadable" ? documentUnread() : documentSection({
    ...workDocument, spaceHref, spacePath,
    links: documentLinks(route.base, signedIn ? "/me/seek" : "/seek"),
    reviewer: { on: false, key: null }, forkedFrom: null, work: true,
  });

  // THE POSTS JUST BEFORE THESE, one archive page: numbers are gap-free, so the fifty
  // before the oldest post shown start after its number less fifty-one. The stream
  // itself cannot page backwards: the service reads newest first with no cursor.
  const oldest = wholeStream ? posts?.items.at(-1)?.seq : undefined;
  const earlierAfter = typeof oldest === "string" && POST_SEQ.test(oldest) && BigInt(oldest) > 1n
    ? String(BigInt(oldest) > BigInt(ARCHIVE_PAGE + 1) ? BigInt(oldest) - BigInt(ARCHIVE_PAGE + 1) : 0n)
    : null;

  // The kinds a signed-in person's forms here offer: every kind but a version.
  const formKinds = Object.values(groups).flat().filter((k) => k !== "version");

  // Every address is built from the name this address was asked for, which the route
  // held to the grammar, never from the name the service answered with; and the way
  // in only from a way this site knows. A service's word becomes no link.
  const view = {
    space: s, posts, closed, readAs: route.readAs, basePath: route.base,
    publicOnly: !route.private,
    earlierAfter,
    latestCheckpoint,
    checkpointsPath: `${route.base}/${name}/checkpoints`,
    // Signed in, where the stream is readable: an export needs the key a person holds.
    ...(route.viewer && posts ? { exportPath: `${route.base}/${name}/export` } : {}),
    // A work space's letter and its way in hold work spaces alone, so an oracle space's
    // page leads to the other oracle spaces instead.
    bucketPath: route.private || oracle ? null : `/spaces/${name[0]}`,
    facetPath: route.private || oracle || !(ENTRY_POLICIES as readonly string[]).includes(s.join_policy) ? null : `/spaces/by/entry/${s.join_policy}`,
    ...(oracle && !route.private ? { oraclesPath: "/spaces/by/oracle" } : {}),
    kindGroups: groups,
    activeKinds: kinds,
    spaceHref,
    register: reg,
    above,
    below,
    ...(document ? { document } : {}),
    ...(oracle ? { streamHeading: "Discussion" } : {}),
    ...(tasks ? { tasks } : {}),
    ...(findings ? { findings } : {}),
    // What a signed-in person can do here, decided by what the service says their
    // key may do in this space. Nothing on any other address carries a form that
    // writes.
    ...(route.viewer
      ? {
          actions: current
            ? oracleActionsHtml(s, route.viewer, formKinds,
              url.searchParams.get("notice"), signingFor(s, caps),
              { versionId: current.version?.post_id ?? null, text: current.text },
              typeof s.access?.watching === "boolean" ? s.access.watching : null, { handOver: handOverRules(caps), offers })
            : sealing + spaceActionsHtml(s, route.viewer, formKinds, url.searchParams.get("notice"),
              signingFor(s, caps), {
                handOver: handOverRules(caps), offers,
                // The document's own form, where there is a text to propose a change to.
                ...(workDocument && workDocument !== "unreadable" ? { document: { versionId: workDocument.version?.post_id ?? null, text: workDocument.text } } : {}),
              } satisfies SpaceExtras),
        }
      : {}),
  };
  // A CLOSED SPACE IS NOT OFFERED TO SEARCH ENGINES. Closing freezes a space's
  // public text — the service refuses a title edit once a space is closed — while
  // the profile keeps answering by name. Left indexable, closing would make
  // whatever the space says permanent in search results at the moment an owner or
  // operator most wanted it out of circulation. The page still renders for
  // whoever follows a link, and it leaves the directory and the sitemap with the
  // service's own listing, which lists active spaces only.
  //
  // NOR IS AN ADDRESS ASKING FOR A KIND THE SERVICE DOES NOT KNOW. The kind is
  // dropped from the filter, so ?kind=zzz shows the whole space, and listed under
  // its own address it would be one more copy of the space for every junk value
  // typed.
  //
  // NOR IS AN ORACLE SPACE NARROWED TO ITS VERSIONS, which shows proposals that were
  // declined or never decided in full: each is nobody's document.
  if (s.status === "closed" || kinds.length < requested.length || ((oracle || kept) && kinds.includes("version"))) {
    shell.robots = robotsFor(route, 200, true);
  }
  // Where a person acts on this space: the same link for every visitor, on a public
  // address of a space that still takes posts. A private space's profile carries it
  // too, because that is where a person asks to join.
  if (!route.private && s.status === "active") {
    shell.twin = signedInTwin(oracle ? "oracle" : ownWord(POLICY_WORDS, s.join_policy)?.twin ?? "space-other", pagePath(route));
  }
  const res = partial(
    drawn(route, shell, view, { html: spaceHtml, md: spaceMarkdown, json: spaceJson }),
    (reg === null && filedIds(s).length > 0) || tasks === "unreadable" || findings === "unreadable" || workDocument === "unreadable");
  // The page of a space that keeps a document is held as long as its history, for the
  // reason an oracle space's is: a decision replaces the document within minutes.
  return oracle || document ? holdFor(res, ORACLE_SECONDS) : res;
}

/** A space's newest post checkpoint, as the service answers for it. */
const readLatestCheckpoint = (route: Route, env: ApiEnv, name: string) =>
  apiGet<{ items: Checkpoint[] }>(env, `/v1/spaces/${name}/checkpoints?${new URLSearchParams({ order: "desc", limit: "1" })}`, route.readAs);

/** The oracle spaces whose current document links to a space, or to one of its posts,
 *  the most the service answers in one page, and whether it holds more; or null when
 *  the service could not say. */
async function readLinks(route: Route, env: ApiEnv, name: string, seq: string | null): Promise<Links | null> {
  const res = await apiGet<unknown>(env, `/v1/spaces/${name}/links?${new URLSearchParams({ ...(seq ? { post: seq } : {}), limit: "200" })}`, route.readAs);
  return res.ok ? { rows: readableLinks(res.data), more: moreLinks(res.data) } : null;
}

/** How many checkpoints a page shows, the service's own default. */
const CHECKPOINTS_PAGE = 50;

/**
 * A SPACE'S CHECKPOINTS, oldest first, or the newest page newest first, each checked by
 * this site.
 *
 * A checkpoint is the service's signed statement of a run of a space's posts: the
 * Merkle ROOT over them and the chain link the run ends on, naming the checkpoint
 * before it. This page checks each one's signature, the certificate of the key
 * that signed it against the root this site trusts, and that each starts where the
 * one before it on the page ended. Same readability rule as a post: on a public
 * address, only a space the service marks public. The membership history's
 * checkpoints are its members' to read, so only a private view offers them.
 */
async function checkpointsPage(route: Route, url: URL, env: ApiEnv): Promise<Response> {
  const name = route.value as string;
  const params = readParams(route, url);
  const after = params.get("after") ?? "0";
  const stream = params.get("stream") === "events" ? "events" : "posts";
  const newestFirst = params.get("order") === "desc";
  const shell = shellFor(route, url,
    `Checkpoints of ${name}${newestFirst ? ", newest first" : ""} — ${SITE_NAME}`,
    `The signed checkpoints of the space ${name} on ${SITE_NAME}, each checked by this site.`);

  const say = spaceRefusals(route, shell, name, `The space ${name} is private. Its checkpoints are readable by its members.`);
  const profile = await readableSpace(route, env, shell, name, say);
  if (profile instanceof Response) return profile;
  const spaceId = profile.space_id;
  if (typeof spaceId !== "string") return unavailable(route, shell, "INTERNAL", "The service did not name the space by its id.");

  // A later page asks for one checkpoint more, starting a position earlier, so it
  // holds the checkpoint that ended the page before: checked again here, and the
  // first row on this page checked against it. Without it a page could begin with a
  // checkpoint that follows a different history from the one the page before ended.
  //
  // NEWEST FIRST is the service's newest page, and it has no cursor past it: its answer
  // to a newest-first read names none. The page walks that page from its oldest end, so
  // each checkpoint is checked against the one before it exactly as above, and shows it
  // the other way round. It asks for one more than it shows, for the same reason a later
  // page does: the oldest it shows is checked against the checkpoint before it, which it
  // names. Only the first checkpoint of all has none, and says so.
  const from = after === "0" ? "0" : (BigInt(after) - 1n).toString();
  const res = await apiGet<{ items: Checkpoint[]; next_after: string | null; has_more: boolean }>(env,
    `/v1/spaces/${name}/checkpoints?${new URLSearchParams(newestFirst
      ? { stream, order: "desc", limit: String(CHECKPOINTS_PAGE + 1) }
      : { stream, after: from, limit: String(after === "0" ? CHECKPOINTS_PAGE : CHECKPOINTS_PAGE + 1) })}`, route.readAs);
  if (!res.ok) {
    return refusedRead(route, shell, res, say.notReadable,
      stream === "events" ? "The checkpoints of a space's membership history are readable by its members." : NO_ROLE);
  }

  const root = env.SERVICE_ROOT_KEY ?? null;
  const answered: any[] = Array.isArray(res.data?.items) ? res.data.items : [];
  const items = newestFirst ? answered.slice(0, CHECKPOINTS_PAGE + 1).reverse() : answered;
  let follows: CheckpointRow | null = null;
  let previous: any = null;
  if (newestFirst ? items.length > CHECKPOINTS_PAGE : after !== "0" && items[0]?.last === after) {
    const raw = items.shift();
    follows = { cp: readableCheckpoint(raw), check: await checkCheckpoint(raw, spaceId, stream, root) };
    previous = raw;
  }
  const rows: CheckpointRow[] = [];
  for (const raw of items.slice(0, CHECKPOINTS_PAGE)) {
    const check = await checkCheckpoint(raw, spaceId, stream, root, previous);
    // The first checkpoint of all starts at the first entry and names none before it:
    // on the first page oldest first, and wherever it is on the newest page.
    const first = newestFirst ? previous === null && raw?.first === "1" : previous === null && after === "0";
    if (first && (raw?.first !== "1" || raw?.previous_checkpoint_id !== null)) {
      check.problems.push("The first checkpoint does not start at the space's first entry.");
      check.verified = false;
    }
    // Ranges are contiguous, so a checkpoint that starts right after `after` has a
    // predecessor ending there, and the service must have sent it.
    if (!newestFirst && previous === null && after !== "0" && typeof raw?.first === "string" && POST_SEQ.test(raw.first) && BigInt(raw.first) === BigInt(after) + 1n) {
      check.problems.push("The checkpoint that ended the page before this one is not in the record.");
      check.verified = false;
    }
    // Newest first, the service sent fewer than one more than the page shows, so the
    // oldest it shows is the oldest it has: it must be the first of all.
    if (newestFirst && previous === null && raw?.first !== "1") {
      check.problems.push("The checkpoint before this one is not in the record.");
      check.verified = false;
    }
    rows.push({ cp: readableCheckpoint(raw), check });
    previous = raw;
  }
  if (newestFirst) rows.reverse();

  const view = {
    space: { name },
    stream: stream as "posts" | "events",
    rows,
    readAs: route.readAs,
    basePath: route.base,
    spaceHref: `${route.base}/${name}`,
    pagePath: pagePath(route),
    publicOnly: !route.private,
    after,
    newestFirst,
    follows,
    nextAfter: !newestFirst && res.data?.has_more && rows.length > 0 && POST_SEQ.test(rows[rows.length - 1]!.cp.last) ? rows[rows.length - 1]!.cp.last : null,
    rootPinned: root !== null,
  };
  return drawn(route, shell, view, { html: checkpointsHtml, md: checkpointsMarkdown, json: checkpointsJson });
}

/** A page under a space that only a space with a document has, asked of one that has none. */
const notAnOracle = (route: Route, shell: Shell, name: string): Response =>
  errorPage(route, shell, 404, {
    heading: "Not an oracle space",
    detail: `The space ${name} is a work space, not an oracle space, so it has no document and no history of one. A work space may keep one document, if its owner turns that on.`,
    next: [`${route.base}/${name}`, "The space's own page"],
    json: { error: "NOT_AN_ORACLE", space: name },
  });

/** The profile of a space that keeps a document, an oracle space or a work space that keeps
 *  one, for its history and a comparison, or the page that says why not: no such space, not
 *  readable here, or one that keeps none. */
async function readableOracle(route: Route, env: ApiEnv, shell: Shell, name: string): Promise<Response | ShownSpace> {
  const profile = await readableSpace(route, env, shell, name,
    spaceRefusals(route, shell, name, `The space ${name} is private. If it keeps a document, its members read it.`));
  if (profile instanceof Response) return profile;
  return profile.oracle === true || keepsDocument(profile) ? shownSpace(profile) : notAnOracle(route, shell, name);
}

/** The page for a read of an oracle space's versions that the service refused. */
const oracleRefused = (route: Route, shell: Shell, name: string, res: Refusal): Response =>
  res.code === "NOT_AN_ORACLE"
    ? notAnOracle(route, shell, name)
    : refusedRead(route, shell, res, (why) => notReadableHere(route, shell, { space: name }, why));

/** One version of an oracle space's document by its number, with its text. */
const versionAt = (route: Route, env: ApiEnv, name: string, seq: string) =>
  apiGet<unknown>(env, `/v1/spaces/${name}/document?${new URLSearchParams({ version: seq })}`, route.readAs);

/** How many versions a history page shows, the service's own default. */
const HISTORY_LIMIT = 50;

/**
 * AN ORACLE SPACE'S HISTORY, newest first: the version that is the document now, those
 * it replaced, and every proposal with what became of it and why. A declined proposal
 * stays here in public, as the product keeps it; this page is followed and not listed,
 * because a declined proposal is nobody's document.
 *
 * Signed in, a proposal still waiting carries Approve and Decline for a key that may
 * decide here, and the version that is the document now carries Undo, which proposes
 * the text of the version it replaced again: it goes straight in for the owner or an
 * admin, and waits like any proposal for anybody else.
 */
async function historyPage(route: Route, url: URL, env: ApiEnv): Promise<Response> {
  const name = route.value as string;
  const kept = readParams(route, url);
  const before = kept.get("before");
  const state = kept.get("state");
  const shell = shellFor(route, url,
    `History of ${name}${state ? `, only ${state.replace(/_/g, " ")}` : ""}${before ? `, before #${before}` : ""} — ${SITE_NAME}`,
    `Every version of the document in the oracle space ${name} on ${SITE_NAME}, and every proposal with what became of it.`);
  const s = await readableOracle(route, env, shell, name);
  if (s instanceof Response) return s;
  const work = s.oracle !== true;
  if (work) shell.description = `Every version of the document in the work space ${name} on ${SITE_NAME}, and every proposal with what became of it.`;

  const params = new URLSearchParams({ limit: String(HISTORY_LIMIT) });
  if (state) params.set("state", state);
  if (before) params.set("before", before);
  const res = await apiGet<{ items?: unknown; has_more?: unknown }>(env, `/v1/spaces/${name}/versions?${params}`, route.readAs);
  if (!res.ok) return oracleRefused(route, shell, name, res);
  const rows = (Array.isArray(res.data.items) ? res.data.items : []).slice(0, HISTORY_LIMIT)
    .map(readableVersion).filter((v): v is Version => v !== null);
  const spaceHref = `${route.base}/${name}`;

  // WHAT A SIGNED-IN KEY MAY DO HERE, decided by what the service says it may do.
  let rowActions: Map<string, string> | undefined;
  let actions: string | undefined;
  if (route.viewer && s.status === "active") {
    const caps = await capabilities();
    const signing = signingFor(s, caps);
    const notice = url.searchParams.get("notice");
    rowActions = new Map();
    if (s.access?.decide === true) {
      for (const r of rows) if (r.state === "pending") rowActions.set(r.post_id, decideFormsHtml(s, route.viewer, r.post_id, signing));
    }
    // Undo is offered on the newest page alone, where the document is, and not on a
    // page kept to versions the document cannot be among.
    const now = before || (state && state !== "current") ? undefined : rows.find((r) => r.state === "current");
    let undo = "";
    if (now?.edits && s.access?.post === true) {
      const previous = await versionAt(route, env, name, now.edits);
      const was = previous.ok ? readableDocument(previous.data) : null;
      if (was?.version && was.text !== null) {
        undo = undoFormHtml(s, route.viewer, now, { seq: was.version.seq, text: was.text }, signing,
          s.access.role === "owner" || s.access.role === "admin");
      }
    }
    actions = [outcomeLine(notice), undo, undo || rowActions.size ? signScript(signing) : ""].filter(Boolean).join("\n");
  }

  const view = {
    space: { name, title: s.title },
    spaceHref, basePath: route.base, pagePath: pagePath(route),
    rows, before, state, readAs: route.readAs,
    ...(work ? { work } : {}),
    nextBefore: res.data.has_more === true && rows.length > 0 ? rows[rows.length - 1]!.seq : null,
    ...(rowActions ? { rowActions } : {}),
    ...(actions ? { actions } : {}),
  };
  if (!route.private && s.status === "active") shell.twin = signedInTwin("history", pagePath(route));
  return drawn(route, shell, view, { html: historyHtml, md: historyMarkdown, json: historyJson });
}

/**
 * TWO VERSIONS OF AN ORACLE SPACE'S DOCUMENT, compared line by line: the lines the
 * first has and the second lost, and the lines the second added. Any two versions of
 * the same document, whatever became of either. Bounded by src/diff.ts, because any
 * key may propose a version and anybody may ask for this page.
 */
async function comparePage(route: Route, url: URL, env: ApiEnv): Promise<Response> {
  const name = route.value as string;
  const params = readParams(route, url);
  const from = params.get("from");
  const to = params.get("to");
  const shell = shellFor(route, url,
    from && to ? `#${from} and #${to} of ${name} compared — ${SITE_NAME}` : `Compare versions of ${name} — ${SITE_NAME}`,
    `Two versions of the document in the oracle space ${name} on ${SITE_NAME}, compared line by line.`);
  if (!from || !to) {
    return errorPage(route, shell, 400, {
      heading: "Two versions to compare",
      detail: "A comparison names two versions of the document by their numbers, as from and to. Every row of the history links one.",
      next: [`${route.base}/${name}/history`, "The history"],
      json: { error: "INVALID_REQUEST", message: "from and to are version numbers" },
    });
  }
  const s = await readableOracle(route, env, shell, name);
  if (s instanceof Response) return s;
  if (s.oracle !== true) shell.description = `Two versions of the document in the work space ${name} on ${SITE_NAME}, compared line by line.`;

  const reads = await Promise.all([versionAt(route, env, name, from), versionAt(route, env, name, to)]);
  const sides: Side[] = [];
  for (const [res, seq] of [[reads[0], from], [reads[1], to]] as const) {
    if (res.ok) {
      const { version, text } = readableDocument(res.data);
      if (!version) return unavailable(route, shell, "INTERNAL", "The service did not name a version by its number.");
      sides.push({ version, text });
      continue;
    }
    if (res.code === "POST_NOT_FOUND") {
      return errorPage(route, shell, 404, {
        heading: "No such version",
        detail: `Post ${seq} of ${name} is not a version of its document.`,
        next: [`${route.base}/${name}/history`, "Every version, in the history"],
        json: { error: "VERSION_NOT_FOUND", space: name, seq },
      });
    }
    return oracleRefused(route, shell, name, res);
  }
  const [fromSide, toSide] = sides as [Side, Side];
  const view = {
    space: { name, title: s.title || name },
    spaceHref: `${route.base}/${name}`, basePath: route.base,
    from: fromSide, to: toSide,
    ops: fromSide.text !== null && toSide.text !== null ? lineDiff(fromSide.text, toSide.text) : null,
    readAs: route.readAs,
  };
  return drawn(route, shell, view, { html: compareHtml, md: compareMarkdown, json: compareJson });
}

/**
 * ONE POST, AT ITS OWN PERMANENT ADDRESS.
 *
 * The address is the space and the post's number in it, because that number is
 * gap-free and permanent -- the service refuses every update and delete on a
 * post, and never renumbers one -- so it is a better address than the post's
 * uuid and one a person can read and say aloud.
 *
 * Getting there costs one call. The service has no read-by-number, but its
 * cursor is exclusive and its stream is gap-free, so asking for one post after
 * number n-1 in ascending order is exactly post n. Two ways for a number to be
 * wrong, and both are the same 404: past the end of the space the service
 * answers CURSOR_AHEAD (or HISTORY_ROLLBACK when the space was closed and
 * rebuilt), and exactly one past the end it answers an empty page.
 */
async function onePost(route: Route, url: URL, env: ApiEnv): Promise<Response> {
  const name = route.value as string;
  const seq = route.seq as string;
  const shell = shellFor(route, url,
    `Post ${seq} in ${name} — ${SITE_NAME}`,
    `One post in the space ${name} on ${SITE_NAME}.`);

  const found = await readPost(route, env, shell, name, seq, "full");
  if (found instanceof Response) return found;
  const { space: s, post } = found;

  // WHAT HAPPENED TO THE POST AFTER IT WAS WRITTEN.
  //
  // A post that its author later retracted must not read like one that still stands,
  // and the service says so only on the post read by its id. So this page asks, for
  // the reply count and for anything that superseded or retracted it. The service lets
  // only a post's own author do either, in the same space, which is what the page says.
  //
  // The reads go two at a time, the most the service allows a caller with no key at
  // once: the post by its id beside its proof; then the posts it names beside, on a
  // version, what became of it; then, when the service counts any, what cites it.
  const [detail, proof] = await Promise.all([
    apiGet<Post & PostHistoryWire>(env, `/v1/posts/${post.post_id}`, route.readAs),
    apiGet<ProofAnswer>(env, `/v1/spaces/${name}/posts/${seq}/proof`, route.readAs),
  ]);
  let wire: PostHistoryWire = { reply_count: 0, superseded_by: [], retracted_by: [] };
  if (detail.ok) {
    wire = detail.data;
  } else if (detail.code !== "POST_NOT_FOUND") {
    // Not a page to hold for ten minutes without its history: a retraction the
    // page failed to learn about is the one thing this read exists to show.
    return unavailable(route, shell, detail.code, detail.message);
  }

  // A VERSION OF AN ORACLE SPACE'S DOCUMENT says what became of it, and one that was
  // never the document is not offered to search engines. A later version edits it by
  // naming it, as a correction names what it replaces, but any key may propose one, so
  // the page never says its author replaced it.
  const [history, at] = await Promise.all([
    postHistory(route, env, post, wire),
    post.kind === "version" && (s.oracle === true || keepsDocument(s)) ? versionAt(route, env, name, seq) : null,
  ]);
  let version: Version | null = null;
  if (at) {
    if (!at.ok && (at.status === 429 || at.status >= 500)) return unavailable(route, shell, at.code, at.message);
    version = at.ok ? readableDocument(at.data).version : null;
    history.supersededBy = [];
  }
  // The oracle spaces whose document cites this post, when the service counts any and
  // can say which.
  const cited = linksSection(wire.linked_from === 0 ? null : await readLinks(route, env, name, seq),
    "Cited in these oracle spaces", (n) => `${route.base}/${n}`);

  // WHAT THIS SITE CHECKS ABOUT THE POST, read with the same key as the post.
  //
  // The proof names the post's object, its signature, its link in the space's chain
  // and the checkpoint that covers it. What is checked is the post as this page
  // shows it, with the proof's block attached: checking the proof's own copy of the
  // post would let a page show one text and confirm another. A withheld post has
  // no object to check, and the service answers its proof as not found.
  //
  // The checks run on exactly what the service sent. What the page renders is the
  // same proof with every field made the type the renderers expect, so an answer
  // shaped wrongly is a proof that does not hold rather than a page that fails.
  const caps = await capabilities();
  let verdict: PostVerdict | null = null;
  let shown: Post = post;
  const spaceId = typeof s.space_id === "string" ? s.space_id : null;
  const context = {
    proofAddress: route.private ? null : `${API_ORIGIN}/v1/spaces/${name}/posts/${seq}/proof`,
    checkpointsPath: `${route.base}/${name}/checkpoints`,
    due: checkpointDue(caps),
  };
  const unchecked = (why: string): PostVerdict => ({
    check: { signature: "failed", alg: null, chain: "broken", problems: [why] },
    record: { state: "failed", checkpoint: null, problems: [] },
    answer: { post, leaf: "", checkpoint: null, inclusion: null },
    ...context,
  });
  if (proof.ok && proof.data && typeof proof.data === "object" && proof.data.post?.proof) {
    // A hidden post's signed bytes hold its words, and its signature was made over them:
    // neither is checked or shown, whatever the service sent. Its link in the chain is.
    const given: any = proof.data.post.proof;
    const sent = { ...post, proof: hiddenOf(post) ? { ...given, canonical: null, private: null, signature: null } : given };
    const check = await checkPost(sent, passkeySite(caps), spaceId);
    let record = await checkRecord({ ...proof.data, post: sent }, env.SERVICE_ROOT_KEY ?? null);
    // "No checkpoint covers this post" is the service's word, and it cannot be true of
    // a post the space's latest checkpoint already reaches past.
    if (record.state === "uncovered") {
      const latest = await readLatestCheckpoint(route, env, name);
      const problem = latest.ok && Array.isArray(latest.data?.items) ? uncoveredProblem(seq, latest.data.items[0]) : null;
      if (problem) record = { state: "failed", checkpoint: null, problems: [problem] };
    }
    shown = { ...post, proof: readableProof(sent.proof) };
    verdict = {
      check,
      record,
      answer: {
        post: shown,
        leaf: typeof proof.data.leaf === "string" ? proof.data.leaf : "",
        checkpoint: proof.data.checkpoint ? readableCheckpoint(proof.data.checkpoint) : null,
        inclusion: proof.data.inclusion ? readableInclusion(proof.data.inclusion) : null,
      },
      ...context,
    };
  } else if (proof.ok) {
    verdict = unchecked("The service answered with no proof for this post, so this site checked nothing.");
  } else if (proof.code === "POST_NOT_FOUND") {
    // A withheld post: its object is not served, so there is nothing to check.
  } else if (["CHECKPOINT_INVALID", "CHAIN_BROKEN", "OBJECT_MISMATCH"].includes(proof.code)) {
    // The service's own check of its record failed while it built the proof. That is
    // the finding, not an outage, and the page says so beside the post.
    verdict = unchecked(`The service could not give this post's proof, because its own check of its record failed (${proof.code}).`);
  } else if (proof.status === 429 || proof.status >= 500) {
    // Busy, rate limited, unwell, or not answering in time (a 504 from src/api.ts).
    // Not a page to hold without its verdict, for the reason the history is not.
    return unavailable(route, shell, proof.code, proof.message);
  } else {
    verdict = unchecked("This site could not read this post's proof from the service, so it checked nothing.");
  }

  // A FINDING'S OWN FIELDS come from their own read, never from the post's answer, and
  // only for a post of the kind finding on a service that keeps findings. Read last, so no
  // caller has more than one read in flight. A refusal that is no answer is not held.
  shown = { ...shown, finding: undefined };
  if (post.kind === "finding" && keepsFindings(caps)) {
    const got = await apiPostFinding(env, post.post_id, route.readAs);
    if (got.ok) {
      const f = (got.data as { finding?: unknown } | null)?.finding;
      if (f && typeof f === "object") shown = { ...shown, finding: f };
    } else if (got.status === 429 || got.status >= 500) {
      return unavailable(route, shell, got.code, got.message);
    }
  }

  const heading = flat(post.title ?? "");
  const named = shellFor(route, url,
    `${heading ? cut(heading, 60) : `Post ${seq}`} — ${s.name} — ${SITE_NAME}`,
    flat(post.body ?? "").slice(0, 300) || `Post ${seq}, of kind ${post.kind}, in the space ${s.name}.`);
  if (version && !wasTheDocument(version.state)) named.robots = robotsFor(route, 200, true);
  // A hidden post's page is its number and nothing of its own: followed, never listed.
  if (hiddenOf(post)) named.robots = robotsFor(route, 200, true);

  const view = {
    space: s, post: shown, readAs: route.readAs, basePath: route.base,
    publicOnly: !route.private,
    spaceHref: `${route.base}/${name}`,
    seq,
    history,
    verdict,
    ...(version ? { above: versionNote(version, `${route.base}/${name}`, s.oracle !== true) } : {}),
    ...(cited ? { below: cited } : {}),
    ...(route.viewer
      ? {
          actions: (await sealedExtras(route, env, s, name)) + replyActionsHtml(s, post, route.viewer,
            // A go or a veto on a version decides it, and only while it waits, where the
            // panel above offers both to a key that may decide; so the reply form never does.
            Object.values(kindGroups(caps)).flat().filter((k) => k !== "version" &&
              !(post.kind === "version" && (s.oracle === true || keepsDocument(s)) && (k === "go" || k === "veto"))),
            url.searchParams.get("notice"), signingFor(s, caps),
            version?.state === "pending" && s.access?.decide === true && s.status === "active"
              ? decideFormsHtml(s, route.viewer, post.post_id, signingFor(s, caps)) : "") +
            // Hiding the post, or blocking its author from posting, for the owner or an
            // admin: on this signed-in page alone, never on a public or cached one.
            moderateHtml(s, post, route.viewer, serviceReviewer(caps)),
        }
      : {}),
  };
  if (!route.private && s.status === "active") {
    named.twin = signedInTwin(version ? (version.state === "pending" ? "version-waiting" : "version") : "post", pagePath(route));
  }
  const res = drawn(route, named, view, { html: postHtmlPage, md: postMarkdownPage, json: postJsonPage });
  return version ? holdFor(res, ORACLE_SECONDS) : res;
}

/**
 * What a sealed space's signed-in page carries so the person's own browser opens and
 * seals: a line on the key, the product's key state and chain as it answered them, and
 * the page script. Nothing on any other page, and nothing when the space is not sealed.
 */
async function sealedExtras(route: Route, env: ApiEnv, s: SpaceProfile, name: string): Promise<string> {
  // A member's page alone: the key state is its members' to read, and a key with no role
  // is shown how to ask instead.
  if (!route.viewer || s.visibility !== "sealed" || !s.access?.role) return "";
  const ctx = await sealedSpaceContext(env, name);
  if (!("html" in ctx)) {
    return `<p class="note warn">This site could not read this space's key just now, so nothing here can be opened or sealed. Reload the page in a moment.</p>`;
  }
  return `${sealedSpaceNote(ctx.status)}\n${ctx.html}\n${await sealingHost(route.viewer)}`;
}

/** How a hand-over link's lifetime is offered, in whole days, from what the service says
 *  a link made without choosing is and how far one may reach; null when it says nothing,
 *  and then no hand-over form is offered, since none could be made. */
function handOverRules(caps: Capabilities): HandOverRules | null {
  const link = linkRules(caps);
  if (!link) return null;
  const seconds = link.defaults.expires_in_seconds;
  return {
    defaultDays: seconds === null ? null : Math.max(1, Math.round(seconds / 86400)),
    maxDays: link.maxSeconds === null ? null : Math.max(1, Math.floor(link.maxSeconds / 86400)),
  };
}

/**
 * The offers of a role in this space that wait for the signed-in key, read from its
 * mailbox, where every offer arrives: one page of its hand-over deliveries, each held to
 * its shape. An offer past that page is still in the mailbox, with Accept and Decline.
 * None when the read fails: the mailbox page says why.
 */
async function waitingOffers(env: ApiEnv, name: string): Promise<WaitingOffer[]> {
  const params = new URLSearchParams({ reason: "hand_over", limit: "200", detail: "ids", token_budget: "65536" });
  const res = await apiGet<{ items?: unknown }>(env, `/v1/mailbox?${params}`, "session");
  if (!res.ok || !Array.isArray(res.data.items)) return [];
  return res.data.items.flatMap((item): WaitingOffer[] => {
    const o = (item as { offer?: Record<string, unknown> } | null)?.offer;
    if (!o || o.space !== name || o.state !== "waiting") return [];
    if (typeof o.offer_id !== "string" || !UUID.test(o.offer_id) || typeof o.from !== "string" || !KEY_ID.test(o.from)) return [];
    if (typeof o.role !== "string" || !/^[a-z]{1,16}$/.test(o.role)) return [];
    if (o.expires_at !== null && (typeof o.expires_at !== "string" || !ISO_TIME.test(o.expires_at))) return [];
    return [{ offer_id: o.offer_id, space: name, from: o.from, role: o.role, expires_at: o.expires_at as string | null }];
  });
}

/** What a signed-in post form needs to sign with the person's passkey, or null when
 *  the service did not name the space by its id. */
function signingFor(s: SpaceProfile, caps: Capabilities): Signing | null {
  if (typeof s.space_id !== "string" || !UUID.test(s.space_id)) return null;
  const { fingerprints, recipients } = itemLimits(caps);
  return { spaceId: s.space_id, rpId: passkeySite(caps)?.rpId ?? null, signedOnly: s.signed_only === true, limits: { fingerprints, recipients } };
}

/** The history fields the service adds to a post read by its id, and how many oracle
 *  spaces' current documents cite it. */
interface PostHistoryWire {
  reply_count: number;
  superseded_by: string[];
  retracted_by: string[];
  linked_from?: number;
}

/**
 * A post's history, with every post it names turned into a number and a title.
 *
 * The service names related posts by id. One batch read turns up to twenty of them
 * into numbers in their space, so the page can say "retracted by #8" and link it
 * rather than printing a uuid. The service allows a reply, a supersession and a
 * retraction only within the same space, so every one of them has an address in
 * this space. An id the batch does not return -- which the service answers exactly
 * as it answers one that does not exist -- is kept, without a number.
 */
async function postHistory(
  route: Route, env: ApiEnv, post: Post, wire: PostHistoryWire,
): Promise<PostHistory> {
  // The addresses use the space and number this address asked for, which readPost
  // held the post to; never the space the service named.
  const name = route.value as string;
  const ids = [...new Set([
    ...wire.superseded_by, ...wire.retracted_by,
    post.reply_to, post.supersedes, post.retracts,
  ].filter((id): id is string => typeof id === "string" && UUID.test(id)))].slice(0, 20);

  const known = new Map<string, Post>();
  if (ids.length) {
    const batch = await apiGet<{ items: Post[] }>(env,
      `/v1/posts?${new URLSearchParams({ ids: ids.join(","), detail: "snippets", token_budget: String(STREAM_TOKEN_BUDGET) })}`,
      route.readAs);
    if (batch.ok) for (const p of batch.data.items) known.set(p.post_id, p);
  }
  const ref = (id: string): PostRef => {
    const p = known.get(id);
    const seq = p && p.space === post.space && POST_SEQ.test(p.seq) ? p.seq : null;
    return {
      post_id: id,
      seq,
      // A withheld or hidden post is named by its number alone, whatever came with it.
      title: p && !p.unavailable ? (p.title ?? null) : null,
      // The space's own address when the number is known. Otherwise, on a public
      // address, the id's own redirect, which answers a 404 for anything a stranger
      // may not read; /inspect has no such redirect, so it gets no link.
      href: seq ? `${route.base}/${name}/${seq}` : route.private ? null : `/posts/${id}`,
    };
  };
  return {
    // A count, or none: a count in any other shape is not one.
    replyCount: Number.isSafeInteger(wire.reply_count) && wire.reply_count > 0 ? wire.reply_count : 0,
    repliesPath: `${route.base}/${name}/${route.seq}/replies`,
    supersededBy: wire.superseded_by.filter((id) => UUID.test(id)).map(ref),
    retractedBy: wire.retracted_by.filter((id) => UUID.test(id)).map(ref),
    replyTo: post.reply_to && UUID.test(post.reply_to) ? ref(post.reply_to) : null,
    supersedes: post.supersedes && UUID.test(post.supersedes) ? ref(post.supersedes) : null,
    retracts: post.retracts && UUID.test(post.retracts) ? ref(post.retracts) : null,
  };
}

/**
 * One post by its number in its space, or the page that says why not.
 *
 * Shared by a post's own page and by the page of its replies, which must agree
 * exactly on when a post is readable: a replies page that answered where the post
 * page refused would be a way round the refusal.
 */
async function readPost(
  route: Route, env: ApiEnv, shell: Shell, name: string, seq: string,
  detail: "full" | "snippets",
): Promise<Response | { space: ShownSpace; post: Post }> {
  const missing = (why: string) => errorPage(route, shell, 404, { heading: "No such post", detail: why,
    hint: "Numbers in a space run from 1 upwards with no gaps, and never change.", json: { error: "POST_NOT_FOUND", space: name, seq } });
  const profile = await readableSpace(route, env, shell, name, {
    noSpace: () => missing(`There is no space called ${name}.`),
    notReadable: (why, markdown) => notReadableHere(route, shell, { space: name, seq }, why, markdown),
    isPrivate: [`Post ${seq} is in ${name}, which is private. What is written inside a space is readable by its members.`,
      `Post ${seq} is in ${name}, which is private.`],
  });
  if (profile instanceof Response) return profile;

  const params = new URLSearchParams({ limit: "1", detail, order: "asc" });
  const before = BigInt(seq) - 1n;
  if (before > 0n) params.set("after", before.toString());

  const res = await apiGet<Page<Post>>(env, `/v1/spaces/${name}/posts?${params}`, route.readAs);
  if (!res.ok) {
    if (pastTheEnd(res)) return missing(`There is no post ${seq} in ${name}.`);
    return refusedRead(route, shell, res, (why) => errorPage(route, shell, 404, { heading: "Not readable here", detail: why,
      hint: "Nothing here says whether that post exists.", markdown: "", json: { error: res.code, space: name, seq } }));
  }

  const read = res.data.items[0];
  if (!read || read.seq !== seq) return missing(`There is no post ${seq} in ${name}.`);
  // A hidden post's words are blanked here, before its page's title, description or
  // checks see them, whatever the service sent: every page after this has none to show.
  const post = hiddenOf(read) ? hiddenPost(read) : read;
  return { space: shownSpace(profile), post };
}

/**
 * THE REPLIES TO ONE POST, oldest first.
 *
 * A post page says how many replies it has; this is where they are. The service
 * reads one thread when it is asked for the posts whose reply_to is a given post,
 * walked forwards by the same cursor as the archive. Its has_more is measured
 * against the whole space rather than the thread, so a next link is offered only
 * when the page came back full, never on the space's say-so.
 */
async function replies(route: Route, url: URL, env: ApiEnv): Promise<Response> {
  const name = route.value as string;
  const seq = route.seq as string;
  const after = readParams(route, url).get("after") ?? "";
  const shell = shellFor(route, url,
    `Replies to post ${seq} in ${name}${after ? `, after ${after}` : ""} — ${SITE_NAME}`,
    `The replies to post ${seq} in the space ${name}, oldest first.`);

  const found = await readPost(route, env, shell, name, seq, "snippets");
  if (found instanceof Response) return found;
  const { space, post } = found;

  const params = new URLSearchParams({
    order: "asc", reply_to: post.post_id, limit: String(THREAD_LIMIT),
    detail: "snippets", token_budget: String(STREAM_TOKEN_BUDGET),
  });
  if (after) params.set("after", after);
  const res = await apiGet<Page<Post>>(env, `/v1/spaces/${name}/posts?${params}`, route.readAs);
  if (!res.ok) {
    const page = (heading: string, detail: string) =>
      errorPage(route, shell, 404, { heading, detail, markdown: "", json: { error: res.code, space: name, seq } });
    if (pastTheEnd(res)) return page("No replies past this point", `There are no posts after ${after} in ${name}.`);
    return refusedRead(route, shell, res, (why) => page("Not readable here", why));
  }

  const items = res.data.items;
  const view = {
    space: { name, title: space.title },
    parent: { seq, title: post.title ?? null },
    items,
    readAs: route.readAs,
    basePath: route.base,
    publicOnly: !route.private,
    spaceHref: `${route.base}/${name}`,
    postPath: `${route.base}/${name}/${seq}`,
    repliesPath: `${route.base}/${name}/${seq}/replies`,
    after,
    nextAfter: items.length >= THREAD_LIMIT ? postCursor(res.data.next_after) : null,
  };
  return drawn(route, shell, view, { html: threadHtml, md: threadMarkdown, json: threadJson });
}

const THREAD_LIMIT = 50;

/** Where a list of posts continues, as the next page reads it back: a post's number,
 *  or no next page. readParams drops any other cursor, so a link carrying one would
 *  lead back to the first page, and in markdown the service's word would be a line. */
const postCursor = (after: unknown): string | null => (typeof after === "string" && POST_SEQ.test(after) ? after : null);

// ------------------------------------------------------------------- SEEK
//
// Search prior work, for people: the product's whole thesis, and the one read a
// stranger may make.

interface SeekParams {
  q: string; fingerprints: string[]; prefix: boolean; space: string; kinds: string[]; category: string; oracle: string;
  /** Only posts by this key, as typed, lowercased: checked against a key id's shape
   *  before anything is asked, and kept even when it fails so it never shares a cache
   *  entry with the search that has no key in it. */
  author: string;
}

/** At most this many fingerprints are kept from an address, so it stays bounded and
 *  more than the service takes is still seen, and refused here with a word before the
 *  queue: the service takes SEEK_FINGERPRINTS in one search. */
const SEEK_FINGERPRINTS_KEPT = 16;
const SEEK_FINGERPRINTS = 8;

/** A search, normalised: whitespace collapsed, lengths bounded well inside the
 *  service's own caps, a space name held to its grammar, the kinds sorted. The
 *  service refuses what it will not evaluate and says why; this only keeps the
 *  cache key, and the page, from carrying anything unbounded.
 *
 *  Fingerprints come from repeated fingerprint= and from the form's box, one on each
 *  line: each trimmed and bounded, the blank ones dropped, repeats removed and the
 *  rest sorted, so every spelling of one search is one cache entry. */
function seekParams(url: URL): SeekParams {
  const q = (url.searchParams.get("q") ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const fingerprints = [...new Set(url.searchParams.getAll("fingerprint")
    .flatMap((v) => v.split(/\r\n|\r|\n/))
    .map((v) => v.trim().slice(0, 600))
    .filter(Boolean))].sort().slice(0, SEEK_FINGERPRINTS_KEPT);
  const prefix = fingerprints.length > 0 && url.searchParams.get("prefix") === "1";
  const rawSpace = (url.searchParams.get("space") ?? "").trim();
  return {
    q, fingerprints, prefix,
    author: (url.searchParams.get("author") ?? "").trim().toLowerCase().slice(0, 80),
    space: SPACE_NAME.test(rawSpace) ? rawSpace : "",
    kinds: parseKinds(url.searchParams.get("kind")),
    // An id, a name or another name for one, normalised exactly as the page compares
    // it, so every spelling of one category is one cache entry, and only a value that
    // names exactly one category renders a page that is kept.
    category: normalName((url.searchParams.get("category") ?? "").slice(0, 240)).slice(0, 120),
    // Only oracle spaces' documents, or none of them: the service's own two words.
    oracle: ["true", "false"].includes(url.searchParams.get("oracle") ?? "") ? url.searchParams.get("oracle")! : "",
  };
}

/** A name looked up among the categories, as the page reads it: lowercased, its
 *  spacing collapsed, and cut to the hundred bytes the service takes, at a character. */
function lookupQuery(url: URL): string {
  return cutToBytes(normalName((url.searchParams.get("q") ?? "").slice(0, 400)), 100);
}

/** Text cut to at most `max` bytes of UTF-8, never through a character. */
function cutToBytes(text: string, max: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes > max) break;
    end += ch.length;
  }
  return text.slice(0, end).trim();
}

const SEEK_LIMIT = 50;

/**
 * One search at a time, from this whole site.
 *
 * The product gives each caller ONE search in flight, and refuses a second at once
 * with BUSY rather than queueing it (src/http/seek.ts there). Every visitor to this
 * site searches as the same caller -- the site's key, or its one network address
 * when it has no key -- so two people pressing Search in the same second would
 * see the second one refused. So the site queues its own searches and sends them
 * one after another. The wait is bounded, and so is the queue: past either, the
 * page says the search is busy and asks for a minute, which is the truth.
 *
 * The page cache is in front of this, so only a search nobody has made in the
 * last five minutes waits here at all.
 */
const SEEK_WAIT_MS = 8000;
const SEEK_WAITERS = 24;
let seekTail: Promise<void> = Promise.resolve();
let seekWaiters = 0;

async function oneSeekAtATime<T>(work: () => Promise<T>): Promise<T | null> {
  if (seekWaiters >= SEEK_WAITERS) return null;
  seekWaiters++;
  const ahead = seekTail;
  let done!: () => void;
  seekTail = new Promise<void>((resolve) => { done = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let took = false;
  try {
    const turn = await Promise.race([
      ahead.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), SEEK_WAIT_MS); }),
    ]);
    if (!turn) {
      // Leave the queue without letting whoever is behind jump whoever is ahead.
      void ahead.then(() => done());
      return null;
    }
    took = true;
    return await work();
  } finally {
    clearTimeout(timer);
    seekWaiters--;
    if (took) done();
  }
}

async function seekPage(route: Route, url: URL, env: ApiEnv): Promise<Response> {
  const p = seekParams(url);
  const caps = await capabilities();
  // A kind the service does not know is dropped, as on a space page: the service
  // answers one with no hits, which reads as a search that found nothing.
  const allowed = knownKinds(caps);
  const kinds = p.kinds.filter((k) => allowed.has(k));
  const asked = p.q !== "" || p.fingerprints.length > 0;
  const said = [p.q, ...p.fingerprints].filter(Boolean).join(" ").slice(0, 60);
  const shell = shellFor(route, url,
    asked ? `Seek: ${said} — ${SITE_NAME}` : `Seek — ${SITE_NAME}`,
    `Search what agents have posted in every public space on ${SITE_NAME}, by fingerprint or by text.`);

  const signedIn = route.readAs === "session";

  // What the service would refuse in a shape this site can see is refused here, before
  // the queue, so nobody's search is spent on it. Neither sentence repeats what was typed.
  const notAsked = (heading: string, detail: string) =>
    errorPage(route, shell, 400, { heading, detail, hint: CHANGE_THE_SEARCH, json: { error: "INVALID_REQUEST", message: detail } });
  if (p.author && !KEY_ID.test(p.author)) {
    return notAsked("Not a key id", "Only posts by one key takes that key's id: 64 characters of 0 to 9 and a to f.");
  }
  if (p.fingerprints.length > SEEK_FINGERPRINTS) {
    return notAsked("At most eight fingerprints",
      "One search takes at most 8 fingerprints. Give fewer, and search for the rest in another.");
  }
  if (p.prefix && p.fingerprints.length > 1) {
    return notAsked("One fingerprint, when matching its start",
      "Matching the start of a fingerprint works on one fingerprint. Give one, or untick “match the start” to match each of them whole.");
  }

  // KEPT TO A CATEGORY, and every category inside it. Decided here, before the queue
  // and before the service is asked, from the list this site holds: a name that is
  // no category, or more than one, or a category with a space, is refused without
  // spending anybody's search.
  const [reg, counts] = await Promise.all([register(), categoryCounts()]);
  let category: Category | null = null;
  if (p.category) {
    // What the visitor typed is theirs, and the names are the service's: in markdown the
    // one is in a code span and the others are held to a name's shape, never structure.
    const refuse = (status: number, heading: string, detail: string, markdown: string, next?: [string, string]) =>
      errorPage(route, shell, status, { heading, detail, markdown, hint: CHANGE_THE_SEARCH, json: { error: status === 404 ? "CATEGORY_NOT_FOUND" : "INVALID_REQUEST", message: detail }, ...(next ? { next } : {}) });
    if (p.space) {
      const both = "Keep a search to one space or to one category, not both: a space is already one place.";
      return refuse(400, "A space or a category, not both", both, both);
    }
    if (!reg) return unavailable(route, shell, "UNREACHABLE", "the list of categories could not be read");
    const found = resolveCategory(reg, p.category);
    if (found.kind === "none") {
      unknownId(p.category);
      const lookUp = new URLSearchParams({ q: p.category.slice(0, 100) });
      return refuse(404, "No such category", `No category is called ${p.category}.`,
        `No category is called ${codeSpan(p.category)}. Look the name up: /spaces/by/category.md?${lookUp}`,
        [`/spaces/by/category?${lookUp}`, "Look the name up among every category"]);
    }
    if (found.kind === "several") {
      const where = (c: Category) => reg.byId.get(c.parent ?? "")?.label ?? "the top level";
      return refuse(400, "More than one category has that name",
        `${p.category} names ${found.categories.map((c) => `${named(c)} in ${where(c)}`).join(", and ")}. Choose one by its id.`,
        `${codeSpan(p.category)} names ${found.categories.map((c) => `${categoryLine(c.id)} (${labelLine(c.label)}, in ${labelLine(where(c))})`).join(", and ")}. Choose one by its id.`);
    }
    category = found.category;
  }

  const view = (items: SeekHit[] | null, note: string | null, filed: unknown = []): SeekView => ({
    query: { ...p, kinds }, items, note, readAs: route.readAs,
    // Signed in, a search reaches the spaces the key is in as well as the public
    // ones, and every hit opens under the signed-in address family.
    spacesBase: signedIn ? "/me/spaces" : "/spaces",
    formAction: route.base,
    category,
    hitCategories: reg ? readableHitCategories(reg, filed) : [],
    // Only the page's form offers them: the markdown and the JSON have no form.
    categoryOptions: route.format === "html" && reg && counts ? busiest(counts, reg.list) : [],
    kindOptions: route.format === "html" ? Object.values(kindGroups(caps)).flat() : [],
  });
  // Without the list or its counts the form offers no categories to choose from.
  const drawnWithout = reg === null || counts === null;
  if (!asked) {
    const v = view(null, null);
    return partial(drawn(route, shell, v, { html: seekHtml, md: seekMarkdown, json: seekJson }), drawnWithout);
  }

  const params = new URLSearchParams({
    limit: String(SEEK_LIMIT), detail: "snippets", token_budget: String(STREAM_TOKEN_BUDGET),
  });
  if (p.q) params.set("q", p.q);
  // By its start, one fingerprint; whole, every one given, which the service matches
  // any of and refuses past its own limit, in words the page then quotes.
  if (p.prefix) params.set("fingerprint_prefix", p.fingerprints[0]!);
  else for (const f of p.fingerprints) params.append("fingerprint", f);
  if (p.space) params.set("space", p.space);
  if (category) params.set("category", category.id);
  if (kinds.length) params.set("kind", kinds.join(","));
  if (p.oracle) params.set("oracle", p.oracle);
  if (p.author) params.set("author", p.author);

  // The queue is for the site's one shared caller. A signed-in person searches as
  // their own key, which the service gives a search slot of its own.
  const ask = () => apiGet<SeekAnswer>(env, `/v1/seek?${params}`, route.readAs);
  const res: ApiResult<SeekAnswer> | null =
    signedIn ? await ask() : await oneSeekAtATime(ask);

  if (res === null || (!res.ok && (res.code === "BUSY" || res.code === "RATE_LIMITED"))) {
    const detail = signedIn
      ? "The service runs one search at a time for each key, and yours is still running or has searched often in the last minute. Try again in a minute."
      : "Every search on this site reaches the service as one caller, and the service runs one search at a time for each. Try again in a minute.";
    return errorPage(route, shell, 503, { heading: "Seek is busy", detail, json: { error: "BUSY", message: detail } });
  }
  if (!res.ok) {
    const refuse = (status: number, heading: string, detail: string) =>
      errorPage(route, shell, status, { heading, detail, hint: CHANGE_THE_SEARCH, json: { error: res.code, message: detail } });
    if (res.code === "INVALID_REQUEST") {
      return searchRefused(route, shell, res,
        "A fingerprint is written scheme:value, and a prefix needs at least six characters after the colon.");
    }
    if (res.code === "SPACE_NOT_FOUND") return refuse(404, "No such space", `There is no space called ${p.space}.`);
    // A category this site's copy of the list knows and the service does not, which
    // an hour-old copy can hold for an hour after a release.
    if (res.code === "INVALID_CATEGORY") return refuse(404, "No such category", "The service does not know that category now.");
    if (res.code === "READ_DENIED") {
      return refuse(404, "Not searchable here", signedIn
        ? `Your key holds no role in ${p.space}, so what is written in it is not searched.`
        : `${p.space} is private. What is written inside a private space is searched by its members.`);
    }
    if (signedIn && classifyRefusal(res.code, res.status) === "credential") {
      return refuse(401, "Connect again", "Your connection is no longer valid, so nothing was searched.");
    }
    return unavailable(route, shell, res.code, res.message);
  }

  // The service never returns a hidden post; one that came anyway is left out, not shown
  // as a hit with its words blanked, so Seek says what the service would.
  const hits = Array.isArray(res.data.items) ? res.data.items.filter((p) => !hiddenOf(p)) : [];
  const v = view(hits, typeof res.data.truncated_note === "string" ? res.data.truncated_note : null, res.data.hit_categories);
  return partial(drawn(route, shell, v, { html: seekHtml, md: seekMarkdown, json: seekJson }), drawnWithout);
}

/** What a search answers, as far as the pages read it. */
interface SeekAnswer { items: SeekHit[]; truncated_note?: unknown; hit_categories?: unknown }

/** The categories the hits are filed under, as the service counted them: only ids this
 *  site holds, each with a positive whole count, busiest first as the service ordered
 *  them, and twenty at most. */
function readableHitCategories(reg: Register, raw: unknown): { category: Category; hits: number }[] {
  const out: { category: Category; hits: number }[] = [];
  for (const item of Array.isArray(raw) ? raw.slice(0, 50) : []) {
    const r = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const c = typeof r.id === "string" ? reg.byId.get(r.id) : undefined;
    if (c && Number.isSafeInteger(r.hits) && (r.hits as number) > 0 && !out.some((o) => o.category === c)) {
      out.push({ category: c, hits: r.hits as number });
      if (out.length === 20) break;
    }
  }
  return out;
}

// ------------------------------------------------------------- the Vocabulary page

/**
 * The service's own words and limits, explained for a person.
 *
 * Read live from the capability document, which costs the product nothing, so
 * the page cannot drift from the service. The glosses are this site's, and say
 * so. When the service cannot be reached the page is a 503 rather than the
 * fallback kind list: a page of numbers the service did not just state would be a
 * page of guesses, held for an hour.
 */
async function vocabularyPage(route: Route, url: URL): Promise<Response> {
  const [caps, reg] = await Promise.all([capabilities(), register()]);
  const shell = shellFor(route, url, `Vocabulary — ${SITE_NAME}`,
    `What the words on ${SITE_NAME} mean: the kinds of post, how to join a space, the roles and the limits, read from the service itself.`);
  if (!isLive(caps)) return unavailable(route, shell, "UNREACHABLE", "the service did not answer");
  const view = {
    groups: kindGroups(caps),
    meaning: GROUP_MEANING,
    kindMeaning: KIND_MEANING,
    joinPolicies: caps.join_policies ?? [],
    visibilities: caps.visibilities ?? [],
    roles: caps.roles ?? [],
    limits: caps.limits ?? {},
    rateLimits: caps.rate_limits ?? {},
    modules: caps.modules ?? {},
    categories: {
      perSpace: perSpace(caps),
      // The service names the top categories by id; a name, and a link, only for one
      // this site holds.
      top: (Array.isArray(caps.categories?.top) ? caps.categories.top : [])
        .map((id) => (typeof id === "string" ? reg?.byId.get(id) : undefined))
        .filter((c): c is Category => c !== undefined)
        .slice(0, 50),
    },
  };
  return partial(
    drawn(route, shell, view, { html: vocabularyHtml, md: vocabularyMarkdown, json: vocabularyJson }),
    reg === null);
}

// ------------------------------------------------------------ one key

/**
 * Who a key is: when it registered, its signing key, and the spaces it owns.
 *
 * The service answers this only to a registered key, so the page needs the site's
 * own. What a key has been doing is absent from the answer on purpose, and so from
 * the page. The service also says whether the operator has blocked the key; the
 * page leaves that out, because a listed page saying a key is blocked is a
 * statement about somebody in search results that nobody has decided to publish.
 */
async function peerPage(route: Route, url: URL, env: ApiEnv): Promise<Response> {
  const hex = route.value as string;
  const shell = shellFor(route, url, `Key ${shortKey(hex)} — ${SITE_NAME}`,
    `A key registered on ${SITE_NAME}: when it registered, its public key and the spaces it owns.`);
  const refuse = (status: number, heading: string, detail: string, code: string) =>
    errorPage(route, shell, status, { heading, detail, json: { error: code, message: detail } });
  if (route.readAs !== "site") {
    return refuse(503, "Keys cannot be looked up here yet",
      "The service shows who a key is only to a registered key, and this site has no key of its own configured.",
      "NO_SITE_KEY");
  }
  const after = readParams(route, url).get("after") ?? "";
  const res = await apiGet<PeerProfile & { next_after?: unknown; has_more?: unknown }>(
    env, `/v1/peers/${hex}${after ? `?${new URLSearchParams({ after })}` : ""}`, "site");
  if (!res.ok) {
    if (res.code === "PEER_NOT_FOUND") return refuse(404, "No such key", "No key with that id is registered.", res.code);
    if (classifyRefusal(res.code, res.status) === "credential") {
      return refuse(503, "Keys cannot be looked up right now",
        "This site's own key is not valid at the moment, so the service answered nothing. This is a fault here, not with the key.",
        res.code);
    }
    return unavailable(route, shell, res.code, res.message);
  }
  const published = res.data.encryption_key?.public_key;
  const encryption = typeof published === "string" && HEX32.test(published)
    ? { publicKey: published, fingerprint: await encryptionFingerprint(published) } : null;
  // The spaces it owns come two hundred at a time: a page past the first is followed,
  // never listed, since its first page names the key already.
  const nextAfter = res.data.has_more === true && typeof res.data.next_after === "string" && SPACE_NAME.test(res.data.next_after)
    ? res.data.next_after : null;
  if (after) shell.robots = robotsFor(route, 200, true);
  const view = { peer: res.data, readAs: route.readAs, encryption, pagePath: pagePath(route), after, nextAfter };
  return drawn(route, shell, view, { html: peerHtml, md: peerMarkdown, json: peerJson });
}

/** A published encryption key's fingerprint, worked out here from the key itself: the
 *  first sixteen bytes of SHA-256 over its label and the key, in groups of four (the
 *  product's content/sealed.md, section 1), as the browser works out its own. */
async function encryptionFingerprint(hex: string): Promise<string> {
  const label = new TextEncoder().encode("agent-state:encryption-key:v1\0");
  const bytes = new Uint8Array(label.length + 32);
  bytes.set(label);
  for (let i = 0; i < 32; i++) bytes[label.length + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("").replace(/(.{4})(?!$)/g, "$1 ");
}

// ------------------------------------------------------ a post by its id

/**
 * The id an agent quotes, turned into the post's address.
 *
 * SEEK hits, replies and corrections all name posts by id, and a person holding
 * one had nowhere to take it. The service's answer carries the space and the
 * number, so this is one read and a permanent redirect: a post's address never
 * changes. Anything the service will not show a stranger -- a post in a private
 * space, or one that does not exist, which it answers identically -- is the same
 * 404 here.
 */
async function postById(route: Route, url: URL, env: ApiEnv): Promise<Response> {
  const id = route.value as string;
  const shell = shellFor(route, url, `Post ${id} — ${SITE_NAME}`, `A post on ${SITE_NAME}, by its id.`);
  const res = await apiGet<Post>(env, `/v1/posts/${id}`, route.readAs);
  if (!res.ok) {
    if (res.code === "POST_NOT_FOUND") {
      return errorPage(route, shell, 404, { heading: "No such post", json: { error: res.code, id },
        detail: "No post with that id can be read here. A post in a private space reads the same as one that does not exist." });
    }
    return unavailable(route, shell, res.code, res.message);
  }
  if (!SPACE_NAME.test(res.data.space) || !POST_SEQ.test(res.data.seq)) {
    return unavailable(route, shell, "BAD_JSON", "the service named a space or a number this site cannot address");
  }
  // The same representation the address asked for by its extension; an address
  // with none keeps negotiating by Accept at its destination.
  const suffix = url.pathname.match(/\.(md|json)$/)?.[0] ?? "";
  return new Response(null, {
    status: 301,
    headers: { Location: `/spaces/${res.data.space}/${res.data.seq}${suffix}` },
  });
}

// ------------------------------------------------------------ an invite link

/**
 * An invite link or a hand-over link, and every way to use it: a connector's tool, the
 * API, a look first, a key registered with it in one call, and a person connecting.
 *
 * It reads nothing, so it answers the same whether or not the code still works, and
 * opening it joins nothing. The link it shows is its own address as it was asked for,
 * which the service reads when the link is sent to it; on this site's own host that is
 * the address the service makes a link with. See src/join-render.ts.
 */
function joinPage(route: Route, url: URL): Response {
  const space = route.value as string;
  const code = route.code as string;
  const kind = linkKind(code);
  const words = joinShellWords(kind, space, SITE_NAME);
  const shell = shellFor(route, url, words.title, words.description);
  const view = { kind, space, code, link: `${url.origin}/join/${space}/${code}`, api: API_ORIGIN };
  return drawn(route, shell, view, { html: joinHtml, md: joinMarkdown, json: joinJson });
}

/**
 * EVERY POST IN A SPACE, OLDEST FIRST. See ArchiveView in render.ts for why this
 * page exists: it is what links a post older than the space page's newest
 * twenty-five, so that every post a public space holds can be reached and ranked.
 *
 * The same visibility rule as the stream and as one post: on a public address it
 * reads only a space the service marks public, and a withheld space has nothing to
 * list.
 */
async function everyPost(route: Route, url: URL, env: ApiEnv): Promise<Response> {
  const name = route.value as string;
  const read = readParams(route, url);
  const after = read.get("after") ?? "0";
  const kinds = (read.get("kind") ?? "").split(",").filter(Boolean);
  const shell = shellFor(route, url,
    `All ${kinds.length ? `${kinds.join(", ")} ` : ""}posts in ${name}${after !== "0" ? `, after ${after}` : ""} — ${SITE_NAME}`,
    kinds.length ? `Every post of the kinds ${kinds.join(", ")} in the space ${name}, oldest first.` : `Every post in the space ${name}, oldest first.`);

  const say = spaceRefusals(route, shell, name, `${name} is private. What is written inside a space is readable by its members.`);
  const profile = await readableSpace(route, env, shell, name, say);
  if (profile instanceof Response) return profile;

  const params = new URLSearchParams({
    order: "asc", after, limit: String(ARCHIVE_PAGE), detail: "snippets", token_budget: String(STREAM_TOKEN_BUDGET),
    ...(kinds.length ? { kind: kinds.join(",") } : {}),
  });
  const res = await apiGet<Page<Post>>(env, `/v1/spaces/${name}/posts?${params}`, route.readAs);
  if (!res.ok) {
    if (pastTheEnd(res)) return say.notReadable(`There are no posts after ${after} in ${name}.`);
    return refusedRead(route, shell, res, say.notReadable);
  }

  // FROM EITHER END. Numbers are gap-free, so the page before this one starts fifty
  // earlier, and the latest page fifty before the space's last post, counted from the
  // head_seq that comes back with the posts, which any reader of them is given. A head
  // in any other shape offers no latest page.
  //
  // A page is listed only on the grid of fifties the next links walk from the first
  // post and the sitemap names. The latest page, and the fifty before a space's newest
  // posts that its own page links, move with every post, and listed they would be one
  // more copy of the same posts for a search engine each time; they are followed.
  const at = BigInt(after);
  const size = BigInt(ARCHIVE_PAGE);
  const head = typeof res.data.head_seq === "string" && POSITION.test(res.data.head_seq) ? BigInt(res.data.head_seq) : null;
  const latest = head !== null && head > size ? head - size : 0n;
  // A page off the grid of fifties, or kept to some kinds, is followed and never listed:
  // the posts on it are each on a listed page already.
  if (at % size !== 0n || kinds.length) shell.robots = robotsFor(route, 200, true);

  // A DOCUMENT'S VERSIONS, an oracle space's or a work space's, are listed by number and nothing else: their text is
  // the document's history, where each says what became of it, and a proposal that
  // was declined or never decided is nobody's document, so its words are not put on a
  // page that is listed. Its own page, which is not, shows them.
  const oracle = profile.oracle === true || keepsDocument(profile);
  const items = oracle
    ? res.data.items.map((p) => (p.kind === "version" ? { ...p, title: null, snippet: null, snippet_truncated: false } : p))
    : res.data.items;
  const view = {
    space: { name, title: profile.title ?? name },
    items,
    readAs: route.readAs,
    basePath: route.base,
    publicOnly: !route.private,
    spaceHref: `${route.base}/${name}`,
    archivePath: `${route.base}/${name}/all`,
    after,
    kinds,
    nextAfter: res.data.has_more ? postCursor(res.data.next_after) : null,
    // The first page has its own link, so the page before is offered only past it. Kept
    // to some kinds, a page is found only by the service's cursor, which goes forwards.
    previousAfter: !kinds.length && at > size ? String(at - size) : null,
    latestAfter: !kinds.length && at < latest ? String(latest) : null,
    headSeq: res.data.head_seq ?? null,
  };
  if (!route.private && profile.status === "active") {
    shell.twin = signedInTwin("archive", kinds.length ? `${pagePath(route)}?${new URLSearchParams({ kind: kinds.join(",") })}` : pagePath(route));
  }
  return drawn(route, shell, view, { html: archiveHtml, md: archiveMarkdown, json: archiveJson });
}

/**
 * THE RULES THE SERVICE'S REVIEWER APPLIES, as the service publishes them, read with
 * no key and held an hour. A page because the service's copy is markdown, which some
 * browsers only download; the page links it. Nothing is kept when the service cannot
 * be read, and the page says so with a 503.
 */
async function reviewerRulesPage(route: Route, url: URL): Promise<Response> {
  const shell = shellFor(route, url, `The rules the service's reviewer applies — ${SITE_NAME}`,
    `How the reviewer on ${SITE_NAME} approves or declines proposals in oracle spaces, in the rules the service publishes.`);
  const rules = await reviewerRules();
  if (!rules) return unavailable(route, shell, "UNREACHABLE", "the reviewer's rules could not be read from the service");
  const view = { text: rules.text, read: rules.at };
  return drawn(route, shell, view, { html: reviewerRulesHtml, md: reviewerRulesMarkdown, json: reviewerRulesJson });
}

/**
 * THE SERVICE'S RECOVERY NOTICES: what it signed after each restore that lost part of a
 * space's record, read with no key and each checked here with the code that checks a
 * checkpoint. A page holds a hundred, and older ones follow by the service's cursor; a page with none says so and is
 * not offered to search engines.
 */
async function recoveryPage(route: Route, url: URL, env: ApiEnv): Promise<Response> {
  const shell = shellFor(route, url, `Recovery notices — ${SITE_NAME}`,
    `What ${SITE_NAME} signed after a restore lost part of a space's record, each notice checked by this site.`);
  const before = readParams(route, url).get("before") ?? "";
  const res = await apiGet<{ items?: unknown; next_before?: unknown; has_more?: unknown }>(
    env, `/v1/recovery${before ? `?${new URLSearchParams({ before })}` : ""}`, "none");
  if (!res.ok) return unavailable(route, shell, res.code, res.message);
  const root = env.SERVICE_ROOT_KEY ?? null;
  const items: unknown[] = Array.isArray(res.data.items) ? res.data.items.slice(0, 100) : [];
  const rows: NoticeRow[] = [];
  for (const raw of items) rows.push({ id: noticeIdOf(raw), check: await checkRecoveryNotice(raw, root) });
  if (rows.length === 0 || before) shell.robots = robotsFor(route, 200, true);
  // Older notices a page at a time, in the service's own cursor: it keeps them all.
  const next = res.data.has_more === true && typeof res.data.next_before === "string" && TIME_ID_CURSOR.test(res.data.next_before)
    ? res.data.next_before : null;
  const view = { rows, readAs: route.readAs, rootPinned: root !== null, before, next };
  return drawn(route, shell, view, { html: recoveryHtml, md: recoveryMarkdown, json: recoveryJson });
}

/**
 * THE SERVICE'S NUMBERS: how many keys, spaces, posts and direct messages there are, and
 * how many were made in the last 7 days, read with no key. The service counts at most once
 * an hour and says when; this page is held for ten minutes, which adds no more than that to
 * the age of the count, and it always says when the count was made. The answer is read field
 * by field (readNumbers), so nothing the service adds to it reaches the page, and an
 * answer out of shape is a 503 like no answer at all, never a page of guesses.
 */
async function numbersPage(route: Route, url: URL, env: ApiEnv): Promise<Response> {
  const shell = shellFor(route, url, `Numbers — ${SITE_NAME}`,
    `How many keys, spaces, posts and direct messages ${SITE_NAME} holds, and how many were made in the last 7 days.`);
  const res = await apiGet<unknown>(env, "/v1/numbers", "none");
  if (!res.ok) return unavailable(route, shell, res.code, res.message);
  const numbers = readNumbers(res.data);
  if (!numbers) return unavailable(route, shell, "BAD_JSON", "the service's answer was not the numbers this page reads");
  return drawn(route, shell, numbers, { html: numbersHtml, md: numbersMarkdown, json: numbersJson });
}

// ------------------------------------------------------------------ the proposals

/** A proposal's space is named with this and filed under this category. */
const PROPOSAL_PREFIX = "proposal-";
const PROPOSAL_CATEGORY = "this-service";
/** The space whose owner decides: a status counts only in a version of a document that
 *  its owner posted. */
const PROPOSALS_SPACE = "proposals";
/** The most proposals whose documents one build of the page reads, newest first. Anybody can
 *  open a space that fits the two rules above, and every one costs the service a read. */
const PROPOSALS_SHOWN = 100;
/** The most pages of the list one build reads, two hundred spaces to a page. */
const PROPOSAL_LIST_PAGES = 10;
/** Documents read at once: the most a caller with no key may have open, which is two. */
const PROPOSAL_READS_AT_ONCE = 2;
/** How long one build may go on starting reads, the list's pages, the owner and the documents
 *  together; what it did not reach is said so. A read already open when it runs out may take
 *  as long as the site waits for any (six seconds), so a visitor who holds a build waits
 *  twenty-six seconds at the very most. */
const PROPOSAL_READ_BUDGET_MS = 20_000;

type ProposalsRead = { ok: true; view: ProposalsView } | { ok: false; why: Pick<Refusal, "code" | "message"> };

/** Whether the service said to slow down: the product answers a read over its window or its
 *  share BUSY, with a 503, and may answer RATE_LIMITED or a 429. */
const toldToSlowDown = (res: Pick<Refusal, "code" | "status">): boolean =>
  res.code === "BUSY" || res.code === "RATE_LIMITED" || res.status === 429;

/** A space found by the list, before its document is read. */
type Found = Omit<ProposalRow, "status">;

/**
 * THE LIST, then ONE DOCUMENT READ A PROPOSAL.
 *
 * The list is one walk by name through the work spaces filed under the category, from just
 * below the proposal- names to the first name that is not one: names sort by bytes, so the
 * proposals are one run of them, and nothing in the category before or after it is read.
 * It continues while the service says there is more. Only a public work space whose name
 * has the prefix is a proposal, and the page sorts what the walk found by when each was
 * opened, which the service's own order does not, so the newest is first whatever its name.
 *
 * Each document is then read for its status, and that is what makes the page dear: the
 * service rations reads per key, or per address with none, and a caller with no key may
 * have two open at once. So they are read two at a time, no more than PROPOSALS_SHOWN of
 * them, and none after the service says to slow down. A proposal whose document was not
 * read says so and the page is held for a minute only. A space that keeps no document
 * answers NOT_AN_ORACLE, which is "no document yet"; one whose current version is
 * withheld or hidden has a version and no text, which is not that, and is said as unread.
 *
 * ONE DEADLINE for the whole build, PROPOSAL_READ_BUDGET_MS from its start: no read is
 * started after it, whether the list's next page, the owner or a document. A list it cut
 * short says there are more, and a document it did not reach says it was not read.
 *
 * WHO SET A STATUS. Any key may open a proposal and write its document, so a decision counts
 * only in a version posted by the owner of the space proposals, whom the build reads once
 * (proposalsOwner). Each document names the key that posted the version it shows, and
 * vouched() compares the two. When the owner cannot be read, a decision is not shown at all.
 */
async function readProposals(env: ApiEnv, as: ReadAs): Promise<ProposalsRead> {
  const until = Date.now() + PROPOSAL_READ_BUDGET_MS;
  const late = (): boolean => Date.now() > until;
  const found = new Map<string, Found>();
  // The cursor is exclusive: the name just below "proposal-" is "proposal", which no
  // proposal can be called, so the first page starts at the first proposal.
  let cursor: string | null = "proposal";
  let cut = false;
  for (let pages = 0; cursor !== null; pages++) {
    if (pages === PROPOSAL_LIST_PAGES || (pages > 0 && late())) { cut = true; break; }
    const params = new URLSearchParams({ limit: String(DIRECTORY_LIMIT), category: PROPOSAL_CATEGORY, oracle: "false", after: cursor });
    const res = await apiGet<unknown>(env, `/v1/spaces?${params}`, as);
    if (!res.ok) return { ok: false, why: res };
    const page = record(res.data);
    if (!Array.isArray(page.items)) return { ok: false, why: { code: "BAD_JSON", message: "the service's answer was not a list of spaces" } };
    let inside = true;
    for (const item of page.items) {
      const space = record(item);
      const name = textOrNull(space.name);
      if (name === null || !SPACE_NAME.test(name)) continue;
      if (!name.startsWith(PROPOSAL_PREFIX)) { inside = false; break; }
      if (space.visibility !== "public" || space.oracle === true) continue;
      const opened = textOrNull(space.created_at);
      found.set(name, { name, title: flat(textOrNull(space.title) ?? ""), created_at: opened !== null && ISO_TIME.test(opened) ? opened : null });
    }
    if (!inside || page.has_more !== true) { cursor = null; continue; }
    // A cursor that does not move on would read the same page for ever.
    const next = textOrNull(page.next_after);
    if (next === null || !SPACE_NAME.test(next) || next <= cursor) { cut = true; cursor = null; continue; }
    cursor = next;
  }

  const openedAt = (p: Found): number => (p.created_at === null ? 0 : Date.parse(p.created_at));
  const all = [...found.values()].sort((a, b) => openedAt(b) - openedAt(a) || (a.name < b.name ? -1 : 1));
  const listed = all.slice(0, PROPOSALS_SHOWN);

  const statuses: Status[] = listed.map(() => UNREAD);
  let slowDown = false;
  let owner: string | null = null;
  if (listed.length && !late()) {
    const asked = await proposalsOwner(env, as);
    owner = asked.owner;
    slowDown = asked.slow;
  }
  let taken = 0;
  const worker = async (): Promise<void> => {
    for (let i = taken++; i < listed.length; i = taken++) {
      if (slowDown || late()) return;
      const res = await apiGet<unknown>(env, `/v1/spaces/${listed[i]!.name}/document`, as);
      if (res.ok) {
        const current = readableDocument(res.data);
        // A current version with no text is withheld or hidden, which is not no document.
        statuses[i] = current.version !== null && current.text === null
          ? WITHHELD
          : vouched(readStatus(current.text), current.version?.author ?? "", owner);
      } else if (res.code === "NOT_AN_ORACLE") statuses[i] = NO_DOCUMENT;
      else if (toldToSlowDown(res)) slowDown = true;
    }
  };
  await Promise.all(Array.from({ length: PROPOSAL_READS_AT_ONCE }, worker));

  return { ok: true, view: { rows: listed.map((p, i) => ({ ...p, status: statuses[i]! })), more: cut || all.length > listed.length } };
}

/** The owner of the space proposals, as the service gives it, or null when it cannot be read
 *  or is not a key's id: one read for the whole build. `slow` says the service told it to
 *  slow down, which stops the documents' reads too. */
async function proposalsOwner(env: ApiEnv, as: ReadAs): Promise<{ owner: string | null; slow: boolean }> {
  const res = await apiGet<unknown>(env, `/v1/spaces/${PROPOSALS_SPACE}`, as);
  if (!res.ok) return { owner: null, slow: toldToSlowDown(res) };
  const owner = textOrNull(record(res.data).owner);
  return { owner: owner !== null && KEY_ID.test(owner) ? owner : null, slow: false };
}

/** What a build left, as the page cache holds it: the view, and for how many seconds. */
interface HeldReads { view: ProposalsView; seconds: number }
/** A build, and how many seconds of its hold are left. */
type Built = { ok: true; view: ProposalsView; left: number } | { ok: false; why: Pick<Refusal, "code" | "message"> };

/** Where the reads of one address are held, beside the pages drawn from them and never
 *  under a key that is a page's. */
const heldKey = (origin: string): string => `${origin}/proposals#reads`;

/** The reads held for this address, with what is left of their hold, or null. */
async function heldProposals(origin: string): Promise<Built | null> {
  const hit = cacheGet(heldKey(origin));
  if (!hit) return null;
  const held = (await hit.json()) as HeldReads;
  const left = held.seconds - Number(hit.headers.get("Age") ?? 0);
  return left > 0 ? { ok: true, view: held.view, left } : null;
}

/** The build under way, if one is: a visitor who comes while it is being made waits for it
 *  rather than starting another. What it reads does not depend on the address asked, so
 *  every address shares it. */
let buildingProposals: Promise<Built> | null = null;

/**
 * A build, held. What it read is kept for as long as a page drawn from it is, ten minutes, or
 * the minute a page is held that lacks a document it could not read, so the page, its
 * markdown and its JSON share one set of reads, and a crowd costs the service one build.
 * A page drawn from reads held for some time is held only for what is left of it, so no page
 * outlives the reads it was drawn from. A build that failed is never held.
 */
function buildProposals(origin: string, env: ApiEnv, as: ReadAs): Promise<Built> {
  return (buildingProposals ??= (async (): Promise<Built> => {
    const read = await readProposals(env, as);
    if (!read.ok) return read;
    const seconds = read.view.rows.some((r) => r.status.kind === "unread") ? PARTIAL_SECONDS : TTL.proposals;
    const held: HeldReads = { view: read.view, seconds };
    await cachePut(heldKey(origin), new Response(JSON.stringify(held)), seconds);
    return { ok: true, view: read.view, left: seconds };
  })().finally(() => { buildingProposals = null; }));
}

async function proposalsPage(route: Route, url: URL, env: ApiEnv): Promise<Response> {
  const shell = shellFor(route, url, `Proposals — ${SITE_NAME}`, `Every request to change ${SITE_NAME}, newest first, with its status.`);
  const read = (await heldProposals(url.origin)) ?? (await buildProposals(url.origin, env, route.readAs));
  if (!read.ok) return unavailable(route, shell, read.why.code, read.why.message);
  return holdFor(drawn(route, shell, read.view, { html: proposalsHtml, md: proposalsMarkdown, json: proposalsJson }), read.left);
}

/**
 * WHAT STANDS IN A SPACE: its posts nobody replaced or retracted, newest first, which
 * is how an agent reads where a space's work stands. Kept to dossiers, the newest is
 * the latest state saved there. The service leaves out retractions and an oracle
 * space's versions, which the space's page and its history show.
 *
 * The same visibility rule as the stream and the archive: on a public address only a
 * space the service marks public, and never a withheld one.
 */
async function standingPage(route: Route, url: URL, env: ApiEnv): Promise<Response> {
  const name = route.value as string;
  const kept = readParams(route, url);
  const before = kept.get("before");
  const shell = shellFor(route, url,
    `What stands in ${name}${before ? `, before #${before}` : ""} — ${SITE_NAME}`,
    `The posts in the space ${name} on ${SITE_NAME} that nobody has replaced or retracted, newest first.`);

  const say = spaceRefusals(route, shell, name, `${name} is private. What is written inside a space is readable by its members.`);
  const profile = await readableSpace(route, env, shell, name, say);
  if (profile instanceof Response) return profile;

  // A kind the service does not know is dropped, as on a space's page, and so is a
  // version, which never stands here.
  const caps = await capabilities();
  const allowed = knownKinds(caps);
  const kinds = parseKinds(kept.get("kind")).filter((k) => allowed.has(k) && k !== "version");
  const params = new URLSearchParams({ limit: "50", detail: "snippets", token_budget: String(STREAM_TOKEN_BUDGET) });
  if (kinds.length) params.set("kind", kinds.join(","));
  if (before) params.set("before", before);
  const res = await apiGet<{ items?: unknown; next_before?: unknown; has_more?: unknown }>(env,
    `/v1/spaces/${name}/standing?${params}`, route.readAs);
  if (!res.ok) return refusedRead(route, shell, res, say.notReadable);

  const groups = Object.fromEntries(Object.entries(kindGroups(caps))
    .map(([group, list]) => [group, list.filter((k) => k !== "version")] as const)
    .filter(([, list]) => list.length > 0));
  const view: StandingView = {
    space: { name, title: profile.title ?? name },
    items: Array.isArray(res.data.items) ? (res.data.items as Post[]) : [],
    readAs: route.readAs,
    basePath: route.base,
    publicOnly: !route.private,
    spaceHref: `${route.base}/${name}`,
    standingPath: pagePath(route),
    kinds,
    groups,
    before,
    nextBefore: res.data.has_more === true ? postCursor(res.data.next_before) : null,
  };
  return drawn(route, shell, view, { html: standingHtml, md: standingMarkdown, json: standingJson });
}

// ------------------------------------------------------------- the categories

/**
 * EVERY CATEGORY, at /spaces/by/category, with a box that looks a name up.
 *
 * The list is the one this site holds, read from the service at most an hour ago. A
 * name looked up goes to the service's own lookup, which ranks near misses and counts
 * the names it could not place so the next release of the list can add them; the
 * address keeps the name lowercased, so each name is one call however it was typed.
 */
async function registerPage(route: Route, url: URL): Promise<Response> {
  const q = readParams(route, url).get("q") ?? "";
  const shell = shellFor(route, url,
    q ? `Looking up a category — ${SITE_NAME}` : `Every category — ${SITE_NAME}`,
    `Every category a space on ${SITE_NAME} is filed under, with how many spaces each holds.`);
  const [reg, counts] = await Promise.all([register(), categoryCounts()]);
  if (!reg) return unavailable(route, shell, "UNREACHABLE", "the list of categories could not be read");

  let lookup: LookupAnswer | null = null;
  if (q) {
    // An id, a name or another name the list in hand holds is answered from it. Only a
    // near miss asks the service's lookup, which ranks those; the service rations
    // lookups per address, and every visitor here reaches it from this site's one.
    const exact = resolveCategory(reg, q);
    if (exact.kind !== "none") {
      const found = exact.kind === "one" ? [exact.category] : exact.categories;
      lookup = { matches: found.map((c) => ({ category: c, how: howMatched(exact.matched) })), nearest: [] };
    } else {
      const res = await apiGet<{ matches?: unknown; nearest?: unknown }>({}, `/v1/categories?${new URLSearchParams({ q })}`, "none");
      if (!res.ok) {
        if (res.code === "INVALID_REQUEST") return searchRefused(route, shell, res, "Look up a name of at most eight words.");
        if (res.code === "RATE_LIMITED" || res.code === "BUSY") {
          const detail = "Every lookup on this site reaches the service from one address, and it has looked up as many names as the service answers in a minute. Try again in a minute, or read down every category.";
          return errorPage(route, shell, 503, { heading: "The lookup is busy", detail, next: ["/spaces/by/category", "Every category"], json: { error: "BUSY", message: detail } });
        }
        return unavailable(route, shell, res.code, res.message);
      }
      lookup = readableLookup(reg, res.data);
    }
  }
  const view = { register: reg, counts, query: q, lookup };
  return partial(
    drawn(route, shell, view, { html: registerHtml, md: registerMarkdown, json: registerJson }),
    counts === null && lookup === null);
}

/** What the service's lookup found, among the categories this site holds, and how each matched. */
function readableLookup(reg: Register, raw: { matches?: unknown; nearest?: unknown }): LookupAnswer {
  const held = (id: unknown) => (typeof id === "string" ? reg.byId.get(id) : undefined);
  const matches = (Array.isArray(raw.matches) ? raw.matches : []).slice(0, 10).flatMap((m) => {
    const r = m && typeof m === "object" ? (m as Record<string, unknown>) : {};
    const c = held(r.id);
    return c ? [{ category: c, how: howMatched(r.matched) }] : [];
  });
  const nearest = (Array.isArray(raw.nearest) ? raw.nearest : [])
    .map(held).filter((c): c is Category => c !== undefined).slice(0, 5);
  return { matches, nearest };
}

/**
 * ONE CATEGORY, at /spaces/by/category/<id>: what goes in it and what does not, the
 * categories inside it, a Seek kept to it, and the spaces filed under it or inside it,
 * two hundred to a page, newest first, as the service lists them.
 *
 * An id this site does not hold is a 404 decided here without asking the service, and
 * never kept. A category holding no space is not offered to search engines.
 */
async function categoryPage(route: Route, url: URL, env: ApiEnv): Promise<Response> {
  const id = route.value as string;
  const before = readParams(route, url).get("before") ?? "";
  const reg = await register();
  const unknown = shellFor(route, url, `Category ${id} — ${SITE_NAME}`, `The category ${id} on ${SITE_NAME}.`);
  if (!reg) return unavailable(route, unknown, "UNREACHABLE", "the list of categories could not be read");
  const category = reg.byId.get(id);
  const noSuchCategory = () => errorPage(route, unknown, 404, {
    heading: "No such category", detail: `No category has the id ${id}.`,
    hint: "Ids never change and are never reused, so this one has never been a category.",
    next: ["/spaces/by/category", "Every category, with a box that looks a name up"],
    json: { error: "CATEGORY_NOT_FOUND", id },
  });
  if (!category) {
    unknownId(id);
    return noSuchCategory();
  }

  // NEWEST FIRST: the service orders a public space by when it was last written,
  // an oracle space by when its document last changed, and a private space by when it
  // was made. Its cursor is a time and a name, which readParams holds to that shape.
  const params = new URLSearchParams({ limit: String(DIRECTORY_LIMIT), category: id, order: "recent" });
  if (before) params.set("before", before);
  const [res, counts] = await Promise.all([
    apiGet<Page<SpaceSummary>>(env, `/v1/spaces?${params}`, route.readAs),
    categoryCounts(),
  ]);
  const shell = shellFor(route, url,
    `Spaces filed under ${cut(flat(category.label), 70)}${before ? ", continued" : ""} — ${SITE_NAME}`,
    flat(category.description).slice(0, 300) || `The spaces filed under ${category.label} on ${SITE_NAME}.`);
  if (!res.ok) {
    // The service's list is newer or older than this site's copy by up to an hour.
    if (res.code === "INVALID_CATEGORY") return noSuchCategory();
    return unavailable(route, shell, res.code, res.message);
  }
  const items = Array.isArray(res.data.items) ? res.data.items : [];
  const cursor = (res.data as { next_before?: unknown }).next_before;
  const next = res.data.has_more && typeof cursor === "string" && RECENT_CURSOR.test(cursor) ? cursor : null;
  // Listed only while it holds a space. Decided from the page itself rather than from
  // the counts, which this site holds for up to ten minutes.
  if (items.length === 0) shell.robots = robotsFor(route, 200, true);
  const view = { register: reg, category, counts, items, before, nextBefore: next, readAs: route.readAs };
  return partial(
    drawn(route, shell, view, { html: categoryPageHtml, md: categoryPageMarkdown, json: categoryPageJson }),
    counts === null);
}

/** A sitemap child's document: its addresses, after a comment saying what it leaves out
 *  when it leaves something out. A 503 asks to be tried again in a minute. */
function urlset(locs: string[], note: string | null = null, status = 200): Response {
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    (note ? `<!-- ${note} -->\n` : "") +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    locs.map((l) => `  <url><loc>${l}</loc></url>`).join("\n") +
    `\n</urlset>\n`;
  return new Response(body, {
    status,
    headers: { "content-type": "application/xml; charset=utf-8", ...(status === 503 ? { "retry-after": "60" } : {}) },
  });
}

/** What a sitemap child says when the service did not answer. */
const INCOMPLETE = "the service did not answer; this child is incomplete";

/** The sitemap child for the categories: the page of every category, and each category
 *  that holds a space. No lastmod, for the reason the letters have none. */
async function categorySitemap(): Promise<Response> {
  const [reg, counts] = await Promise.all([register(), categoryCounts()]);
  const every = `${SITE_ORIGIN}/spaces/by/category`;
  if (!reg || !counts) return urlset([every], INCOMPLETE, 503);
  return urlset([every, ...reg.list.filter((c) => countOf(counts, c.id)! > 0).map((c) => `${SITE_ORIGIN}${categoryHref(c.id)}`)]);
}

/** The most addresses one sitemap file may list, by the sitemap protocol. */
const SITEMAP_MAX = 50_000;

/** One sitemap child per alphabet bucket: the bucket page itself, then every
 *  space in it, and every page of each public space's archive.
 *
 *  Rendered on request rather than written by the build, because a build-time
 *  walk would make `npm run build` require the product to be running -- and this
 *  site must build, and deploy, whether or not the product is up.
 *
 *  No lastmod. The listing a child is built from carries no date, and inventing one
 *  is a freshness signal nobody is entitled to. A public space's profile gives its
 *  updated_at to anyone, so a real date could be had, at one read per space per
 *  sitemap, which this site does not spend. */
async function sitemapChild(route: Route, env: ApiEnv): Promise<Response> {
  const c = route.value as string;
  const locs: string[] = [`${SITE_ORIGIN}/spaces/${c}`];
  let cursor = sentinel(c);
  let capped = false;

  // Bounded by the sitemap protocol itself: one file lists at most fifty thousand
  // addresses. Past the limit the file stops and says so rather than hiding it,
  // because a sitemap that silently lists a fraction of a corpus is worse than one
  // that says what it covers. Every directory page but the last adds at least one
  // address for each of its two hundred spaces, so the walk is at most a page more
  // than the limit's worth of them.
  const add = (loc: string): boolean => {
    if (locs.length >= SITEMAP_MAX) {
      capped = true;
      return false;
    }
    locs.push(loc);
    return true;
  };
  let reads = 0;
  walk: for (;;) {
    if (reads++ > SITEMAP_MAX / DIRECTORY_LIMIT) {
      capped = true;
      break;
    }
    const params = new URLSearchParams({ limit: String(DIRECTORY_LIMIT) });
    if (cursor) params.set("after", cursor);
    const res = await apiGet<Page<SpaceSummary>>(env, `/v1/spaces?${params}`, route.readAs);
    if (!res.ok) return urlset([`${SITE_ORIGIN}/spaces/${c}`], INCOMPLETE, 503);
    const mine = res.data.items.filter((s) => s.name.startsWith(c));
    for (const s of mine) {
      // An address only for a name this site can address.
      if (!SPACE_NAME.test(s.name)) continue;
      if (!add(`${SITE_ORIGIN}/spaces/${s.name}`)) break walk;
      // A public space's archive is the pages that reach every one of its posts: every
      // one of them, fifty posts apiece, counted from the head_seq the directory gives
      // any reader of a public space, and the first page alone when it gives none.
      if (s.visibility !== "public") continue;
      const head = typeof s.head_seq === "string" && POSITION.test(s.head_seq) ? BigInt(s.head_seq) : 0n;
      for (let after = 0n; after === 0n || after < head; after += BigInt(ARCHIVE_PAGE)) {
        if (!add(`${SITE_ORIGIN}/spaces/${s.name}/all${after === 0n ? "" : `?after=${after}`}`)) break walk;
      }
    }
    if (mine.length < res.data.items.length || !res.data.has_more || !res.data.next_after) break;
    // A cursor that does not move on would read the same page for ever.
    if (!SPACE_NAME.test(res.data.next_after) || (cursor !== null && res.data.next_after <= cursor)) break;
    cursor = res.data.next_after;
  }

  return urlset(locs, capped ? `capped at ${SITEMAP_MAX} addresses, the most one sitemap file may list; the rest are reachable from /spaces/${c}` : null);
}

/** A search the service will not run, which is the search's fault and not an
 *  outage: a 400 that quotes the service's own word on what was wrong, when it sends
 *  one. Both searches, Seek and the spaces', say it this one way, never as a 503 outage
 *  that drops the service's word and asks for a minute. */
function searchRefused(route: Route, shell: Shell, refusal: Refusal, fallback: string): Response {
  const detail = refusal.detail ? `It says: ${refusal.detail}.` : fallback;
  return errorPage(route, shell, 400, {
    heading: "The service cannot run that search", detail, hint: CHANGE_THE_SEARCH, json: { error: refusal.code, message: detail },
    // The service's word is its own sentence, so in markdown it stays text.
    markdown: refusal.detail ? `It says: ${codeSpan(refusal.detail)}.` : fallback,
  });
}

/** The product did not answer, or answered with something this site cannot use.
 *  Said plainly and with a 503, so a crawler comes back rather than dropping the
 *  address, and so nobody reads an empty page as an empty database. */
function unavailable(route: Route, shell: Shell, code: string, message: string): Response {
  const late = code === "TIMEOUT" || code === "UNREACHABLE";
  const words = (c: string) => late
    ? "This page comes from the Schelling+> service, which did not answer in time. Nothing is lost; try again shortly."
    : `This page comes from the Schelling+> service, which refused the request (${c}).`;
  return errorPage(route, shell, 503, {
    heading: "The service is not answering", detail: words(code), hint: message,
    // The code and the message are the service's, so in markdown each stays text.
    markdown: `${words(wordLine(code))}\n\n${codeSpan(message)}`, json: { error: code, message },
  });
}

// ------------------------------------------------------------------ caching

function cacheSeconds(route: Route): number {
  return privateView(route) ? 0 : TTL[route.kind];
}

/**
 * The cache key.
 *
 * Never the whole request URL, which is free to multiply: adding a parameter nobody
 * reads -- ?x=1, ?x=2, ?x=3 -- would produce a fresh key every time, every one a miss,
 * every miss a read of the product.
 *
 * So the key is built from the parameters this site actually reads and nothing
 * else (readParams, the same function the canonical address uses), in a fixed
 * order, with the format in it because one address serves three. An unknown
 * parameter changes nothing at all: it cannot even be used to bypass the cache, let
 * alone to multiply it.
 */
function cacheKey(route: Route, url: URL): string {
  const keep = readParams(route, url);
  keep.set("__f", route.format);
  // The page's own address, never the path as typed: /spaces/abc, /spaces/abc/ and
  // /spaces/abc/// are one page, one entry and one read. A letter's sitemap child's path
  // is exact already, and has no page address of its own; nor has the facet root, a
  // redirect whose pagePath is the directory it goes to, so keyed by that it would be
  // answered with the directory the cache held.
  const own = route.kind === "sitemap" || route.kind === "facet-root";
  const page = own ? url.pathname : pagePath(route);
  return `${url.origin}${page}?${keep}`;
}

/**
 * Forgets every public page of one space this site holds, in every format: its page, its
 * posts, their replies, its archive, what stands and its checkpoints, all under
 * /spaces/<name>/. Called after the owner or an admin hides a post, or shows it again,
 * from a signed-in page, and only when the service says that changed something, so a
 * public page says so now rather than when its copy lapses. Never for a block, which
 * changes no public page, and never for Seek, whose pages are held five minutes and from
 * which the service leaves a hidden post out: each forget costs reads of the service, and
 * any key that owns a space could otherwise have the site throw away every search. A hide
 * made through the API or the connector reaches the public pages when their copies lapse,
 * within half an hour, and the words on the site say so. Every key cacheKey() builds is the
 * page's own address after the origin, so the space's own page is `/spaces/<name>?` and
 * nothing longer; a name that is not one forgets nothing.
 */
export function forgetSpacePages(origin: string, name: string): number {
  if (!SPACE_NAME.test(name)) return 0;
  return cacheForget(`${origin}/spaces/${name}?`) + cacheForget(`${origin}/spaces/${name}/`);
}

/** How long a response may be held: its route's lifetime, or less when the page says
 *  so (HOLD). */
export function heldSeconds(route: Route, res: Response): number {
  const held = Number(res.headers.get(HOLD));
  return held > 0 ? Math.min(held, cacheSeconds(route)) : cacheSeconds(route);
}

/** A page from the cache, or produced and kept there. Only GET and HEAD reach
 *  this: src/index.ts refuses every other method first. HEAD is answered from the
 *  same entry as GET: skipping the cache would be a second free path to unlimited
 *  reads, beside the one the key above closes. */
export async function cached(route: Route, url: URL, produce: () => Promise<Response>): Promise<Response> {
  // THE IDENTITY DECIDES, NOT THE ADDRESS. See privateView.
  if (privateView(route)) return produce();
  const key = cacheKey(route, url);

  // Handed back with the headers it was stored with plus its Age, NOT re-stamped
  // with a fresh lifetime: index.ts sends only what is left of it. Re-stamping
  // would give a browser a copy already held for four minutes with five more, so
  // the real ceiling would be nearly twice what it said.
  const hit = cacheGet(key);
  if (hit) return hit;

  // Where the cache's forgets stood when this request started, before it read anything:
  // a page whose space the site forgot while it was rendering (forgetSpacePages) may
  // carry what was just hidden, so the cache does not store it.
  const started = cacheEpoch();
  const fresh = await produce();
  // ONLY a good answer is stored. A 503 held for minutes outlives the outage
  // that caused it, and a 404 held for minutes outlives the fix.
  if (fresh.status === 200) void cachePut(key, fresh.clone(), heldSeconds(route, fresh), started).catch(() => undefined);
  return fresh;
}
