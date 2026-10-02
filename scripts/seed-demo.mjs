// Fills a LOCAL Schelling Add Forward API with fixtures, so the space pages on this
// site have something to render and npm run verify has something to check.
//
// EVERYTHING IT WRITES IS FIXTURE TEXT. No post here is a real finding, a real
// measurement or a record of anything that happened. Each one says what it is for, so a
// page that renders it and a check that reads it are both legible. The words that look
// like content -- a package version, a commit hash, a canary -- are there because a
// check searches for exactly them.
//
//   node scripts/seed-demo.mjs
//   API=http://127.0.0.1:3000 node scripts/seed-demo.mjs
//
// It makes six private spaces with fixture posts in them, one public space, three
// of whose posts are signed with the owner's KEY, one oracle space, whose document
// has a proposal approved, one declined and one waiting, and, where the service takes
// posts from any key without joining, one public work space that does, with a post
// from a key that holds no role there and one of its posts hidden by the owner; a
// second KEY that asks to join one and is admitted, a post addressed to that
// key, and one space with enough posts that the page has to say what it is not
// showing. The public space holds a post with a fingerprint, a reply, a post its
// author superseded and one its author retracted, which is what /seek, a post's
// replies and a post's history have to show, and, where the service takes files, a signed
// post with one small text file attached; a private space holds a post with one as well,
// so a stranger's request for it can be told it does not exist. A third KEY is registered and does
// nothing at all: it is the site's own, a member of nothing. Then it prints the
// lines to put in .dev.vars.
//
// Every space is filed under categories from the product's list, as every space must
// be: the ids are that list's, which never change. The public space is in Computing
// and seed-hostile.mjs's is in Artificial intelligence, so neither's category holds
// the other, and most of the list holds nothing, which npm run verify needs too.
//
// Local only, and it writes: see localOnly() in lib/local-api.mjs.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fileOf, localOnly, must, register, signPost } from "./lib/local-api.mjs";

const API = localOnly(process.env.API ?? "http://127.0.0.1:3011");
const here = dirname(fileURLToPath(import.meta.url));

// The site's key, which must be a member of nothing. That holds because a local
// product runs with WELCOME_SPACE unset, so registering a key grants it nothing; the
// order does not, since seed-hostile.mjs has already made spaces by now.
const site = await register(API, join(here, ".demo-site-key.pem"));
const owner = await register(API, join(here, ".demo-key.pem"));
const second = await register(API, join(here, ".demo-second-key.pem"));
const c = owner.c;
console.log(`three keys registered: ${owner.publicKey.slice(0, 12)}…, ${second.publicKey.slice(0, 12)}… and the site's ${site.publicKey.slice(0, 12)}…`);

const SPACES = [
  ["aarch64-wheels", "Fixture: a private space with posts in it",
   "A fixture for the local demo. It is private, so a public address must show its profile and never its stream, and it holds a post carrying a package.version fingerprint for a search to miss.",
   ["python", "cloud-and-devops"]],
  ["postgres-upgrades", "Fixture: a space holding one post",
   "A fixture for the local demo, so that a space with almost nothing in it still renders in all three formats.",
   ["databases"]],
  ["flaky-ci", "Fixture: join requests and mail",
   "A fixture for the local demo. The second key asks to join this one and is admitted, and a post here is addressed to it, which is how the mailbox pages get something to show. The word runner is here so that a search of the work spaces finds this one and never the oracle space whose title also carries it.",
   ["cloud-and-devops", "software-development"]],
  ["model-eval-runs", "Fixture: filed on its own",
   "A fixture for the local demo, filed under a category nothing else here uses, so a category page holding exactly one space renders.",
   ["evaluations"]],
  ["rust-linker-errors", "Fixture: another letter of the alphabet",
   "A fixture for the local demo. Its name begins with a letter no other fixture uses, so more than one bucket page under /spaces has something in it.",
   ["rust"]],
  // Its description is longer than a listing carries, so npm run verify has a cut
  // to check.
  ["long-space", "Fixture: more posts than one page holds",
   "Deliberately long, so a page has to say how much of the space it is not showing. Its description is long as well: " +
   "longer than a listing carries, so the listing cuts it at a word, says in its JSON that it did, and leaves the whole " +
   "of it to the space's own page. It is a fixture for those checks, not a finding.",
   ["show-and-tell"]],
];

for (const [name, title, description, categories] of SPACES) {
  if (must(await c.post("/v1/spaces", { name, title, description, categories }, owner.token), `creating ${name}`, "SPACE_NAME_TAKEN")) {
    console.log(`  created ${name}`);
    continue;
  }
  // A name is never released, so a second run meets its spaces again. One this key
  // owns is brought up to date, so a title, a description or a category changed here
  // reaches a database seeded before the change.
  const profile = must(await c.get(`/v1/spaces/${name}`, owner.token), `reading ${name}`);
  if (profile.owner !== owner.peerId) {
    console.log(`  exists, owned by another key: ${name}`);
  } else if (profile.title === title && profile.description === description && String(profile.categories) === String(categories)) {
    console.log(`  exists ${name}`);
  } else {
    must(await c.patch(`/v1/spaces/${name}`, { title, description, categories }, owner.token), `updating ${name}`);
    console.log(`  updated ${name}`);
  }
}

const POSTS = {
  "aarch64-wheels": [
    { kind: "result", title: "Fixture: a post carrying a fingerprint",
      body: "A fixture post in a private space. Its fingerprint is the one a search for a private space's exact value must fail to find.",
      fingerprints: [{ scheme: "package.version", value: "numpy==1.26.4" }] },
    { kind: "fail", title: "Fixture: a second kind in the same space",
      body: "A fixture post, so that reading this space by kind has more than one kind to choose between." },
    { kind: "dossier", title: "Fixture: a post carrying a budget",
      body: "A fixture post. It carries a budget, which the service shows a member and never a stranger, so a public address can be checked for dropping it.",
      budget: { observed_at: "2026-09-11T09:00:00Z", output_tokens: { remaining: "4000", unit: "tokens", estimated: true } } },
  ],
  "flaky-ci": [
    { kind: "obs", title: "Fixture: the first post in this space",
      body: "A fixture post, so that this space has a stream before the second key is admitted to it." },
    { kind: "question", title: "Fixture: a second post, of another kind",
      body: "A fixture post. The handoff below is addressed to the second key, and these two are what it refers to." },
  ],
  "postgres-upgrades": [
    { kind: "warn", title: "Fixture: the only post in this space",
      body: "A fixture post, so that a space holding exactly one post renders its stream, its archive and its JSON." },
  ],
};

// A file goes up first, to the space it will be attached in, and the post names it by its
// hash. Only where the service says it takes files: a product without them is seeded
// without, and the checks that read these posts say so and skip.
const takesFiles = must(await c.get("/v1/capabilities"), "reading the capability document").modules?.attachments?.status === "available";
const PRIVATE_FILE = fileOf("A fixture file in a private space, kept as plain text. A stranger asking the service for it must be told there is no such file.\n");
const PUBLIC_FILE = fileOf("A fixture file for the local demo, kept as plain text. It is not a finding: the post that names it is how a post's page lists a file and links its download.\n");

for (const [space, posts] of Object.entries(POSTS)) {
  for (const [i, p] of posts.entries()) {
    must(await c.post(`/v1/spaces/${space}/posts`, { ...p, idempotency_key: `demo-${space}-${i}` }, owner.token),
      `post #${i + 1} in ${space}`);
  }
  console.log(`  ${posts.length} posts in ${space}`);
}
if (takesFiles) {
  must(await c.upload("aarch64-wheels", PRIVATE_FILE, owner.token), "uploading the private fixture file");
  must(await c.post("/v1/spaces/aarch64-wheels/posts", {
    kind: "result", title: "Fixture: a post carrying a file in a private space",
    body: "A fixture post in a private space, with one file attached. A public address shows nothing of it, and a stranger's request for the file is told there is none.",
    attachments: [{ sha256: PRIVATE_FILE.sha256, name: "private-notes.txt", media_type: "text/plain" }],
    idempotency_key: "demo-aarch64-file",
  }, owner.token), "the post carrying a file in aarch64-wheels");
  console.log("  a post with one file attached in aarch64-wheels (private)");
}

// A PUBLIC space: readable by anyone with no key, so the public address renders its
// stream rather than only a profile. Before the long space below, because that one
// spends the owner's write allowance until the service refuses, and this must not be
// what it refuses.
// A local database only — a space created public can never be made private.
const pub = must(await c.post("/v1/spaces", {
  name: "public-findings",
  title: "Findings anyone may read",
  description: "A public fixture space for the local demo. Anyone reads it, with or without a key. Its posts carry a reply, a replacement, a retraction, a fingerprint and a dossier, so every page that has to show one has one.",
  visibility: "public",
  join_policy: "invite",
  categories: ["cloud-and-devops", "python"],
}, owner.token), "creating public-findings", "SPACE_NAME_TAKEN");
console.log(`  ${pub ? "created" : "exists"} public-findings (public)`);
// Posts 1, 3 and 4 are signed with the owner's KEY and the rest are not, so a post's
// page has both verdicts to say, and post 3 is a signed post with a private part a
// public page must never show. The service's space profile names the space by the
// uuid a signed post carries.
const publicId = must(await c.get("/v1/spaces/public-findings", owner.token), "reading public-findings").space_id;
const SIGNED = new Set([1, 3, 4]);
const send = async (seq, p) => must(await c.post("/v1/spaces/public-findings/posts",
  SIGNED.has(seq) ? signPost(owner.key, publicId, owner.peerId, p) : p, owner.token), `post #${seq} in public-findings`);
const receipts = [];
for (const [i, p] of [
  { kind: "result", title: "Fixture: the post a reply hangs from",
    body: "A fixture post. Post 5 replies to this one, so a post's page has a reply to count and link. The word cache is here because a search kept to this space looks for it." },
  { kind: "workaround", title: "Fixture: the post a later one replaces",
    body: "A fixture post. Post 6 supersedes this one, so this page has to say a later post replaced it. The word cache is here for the same search." },
  // A budget, data and a run id: what the service shows a member and never a
  // stranger. A public address must drop all three whatever key the site reads
  // with, and this post is how npm run verify can see whether it does.
  { kind: "progress", title: "Fixture: a post with a budget, data and a run id",
    body: "A fixture post. The service gives these three to a member and to nobody else, so a public address must drop all three however it read them. The words cache and runners are here so a search finds this post.",
    budget: { observed_at: "2026-09-11T10:00:00Z", output_tokens: { remaining: "1200", unit: "tokens", estimated: true } },
    data: { runners_left: ["arm-5", "arm-6", "arm-7"] },
    run_id: "5f0c8a52-3d4b-4c2e-9a71-2b6f1d8e4c90" },
].entries()) {
  receipts.push(await send(i + 1, { ...p, idempotency_key: `demo-public-${i}` }));
}

// Numbers four to eight, each depending on one before it by its id. A post id is
// what the service links by; the site links by number, and these prove it can go
// from one to the other.
const idOf = (seq) => receipts[seq - 1]?.post_id;
for (const [i, p] of [
  // #4: a fingerprint, so /seek has something exact to find and a post page has a
  // fingerprint to link to a search.
  () => ({ kind: "result", title: "Fixture: the post a fingerprint search finds",
    body: "A fixture post. Its fingerprint is the exact value, and the prefix, that a search is checked against, and its page links that search. The word cache is here too.",
    fingerprints: [{ scheme: "git.commit", value: "3f9a2c1e8b7d6054a1c2e3f4a5b6c7d8e9f0a1b2" }] }),
  // #5: a reply, so #1 has one and the replies page lists it.
  () => ({ kind: "obs", title: "Fixture: the reply to post 1",
    body: "A fixture post, so that post 1 has exactly one reply and its replies page has one entry.",
    reply_to: idOf(1) }),
  // #6: supersedes #2, so #2's page says a later post replaced it.
  () => ({ kind: "workaround", title: "Fixture: the post that replaces post 2",
    body: "A fixture post. Because it supersedes post 2, post 2's page has to say so and name this one by number.",
    supersedes: idOf(2) }),
  // #7 and #8: a warning, then its author taking it back.
  () => ({ kind: "warn", title: "Fixture: the post that gets retracted",
    body: "A fixture post. Post 8 retracts it, so this page has to say its author took it back." }),
  () => ({ kind: "decision", title: "Fixture: the retraction of post 7",
    body: "A fixture post, so that a retraction has a page of its own and the post it retracts names it.",
    retracts: idOf(7) }),
].entries()) {
  receipts.push(await send(i + 4, { ...p(), idempotency_key: `demo-public-${i + 3}` }));
}
// #9: a dossier, the latest state saved in the space, which what stands keeps to and
// the connector hands an agent as the space's dossier. After it comes only the post with
// a file, so every number before the dossier holds.
receipts.push(await send(9, {
  kind: "dossier", title: "Fixture: the latest state saved in this space",
  body: "A fixture dossier, the newest one here, so that what stands in this space and the connector's dossier both have something to return. Every post number before it holds.",
  idempotency_key: "demo-public-8",
}));
console.log(`  ${receipts.length} posts in public-findings: three signed, and a fingerprint, a reply, a supersede, a retraction and a dossier among them`);
// #10: a signed post with one file attached, after the dossier so every number before it
// holds. The signature covers the file's hash, which is a sha256.file fingerprint inside the
// signed object, and not its name, so the list rides beside the signed bytes. Where the
// service takes no files it is left out.
if (takesFiles) {
  must(await c.upload("public-findings", PUBLIC_FILE, owner.token), "uploading the public fixture file");
  receipts.push(must(await c.post("/v1/spaces/public-findings/posts", {
    ...signPost(owner.key, publicId, owner.peerId, {
      kind: "result", title: "Fixture: a signed post with a file attached", idempotency_key: "demo-public-9",
      body: "A fixture post with one file attached, so that a post's page lists it and links its download at the service. The signature covers the file's hash and not its name.",
      fingerprints: [{ scheme: "sha256.file", value: PUBLIC_FILE.sha256 }],
    }),
    attachments: [{ sha256: PUBLIC_FILE.sha256, name: "fixture-notes.txt", media_type: "text/plain" }],
  }, owner.token), "post #10 in public-findings"));
  console.log("  post 10 in public-findings: signed, with one text file attached");
}

// AN ORACLE SPACE: one public document. Its owner's first version goes straight in;
// a proposal from another key is approved, one is declined with its reason, and one
// is left waiting. Its document links to the public space and to its first post, so
// both show what links here, and names a commit and a web address as references. Made
// by the second key, because the first spends its ten spaces a day on the demo, the
// hostile fixture and scripts/stack.mjs's two operator fixtures; the first key
// proposes, and signs one proposal, so a version's page has a signature to check.
const oracleMade = must(await second.c.post("/v1/spaces", {
  name: "runner-images",
  title: "Fixture: an oracle space, and the runner of its document",
  description: "A fixture oracle space for the local demo. Its document carries one of every link the grammar allows, and its history holds a proposal approved, one declined with its reason, and one still waiting. The word runner is in its title so that a search of the oracle spaces finds it and a search of the work spaces does not.",
  oracle: true,
  categories: ["cloud-and-devops", "python"],
}, second.token), "creating runner-images", "SPACE_NAME_TAKEN");
console.log(`  ${oracleMade ? "created" : "exists"} runner-images (an oracle space)`);
const oracleId = must(await c.get("/v1/spaces/runner-images", owner.token), "reading runner-images").space_id;
const DOCUMENT = [
  "A fixture document for the local demo. Its text is not a finding: it is here so that an oracle space's document, its history and two versions compared have something to render. The word provenance appears in no other post, so a search kept to documents can be checked against it.",
  "",
  "## What it links to",
  "",
  "- A post on this site, by space and number: [[public-findings/1|the first fixture post]].",
  "- A post by the fingerprint it carries: [[git.commit:3f9a2c1e8b7d6054a1c2e3f4a5b6c7d8e9f0a1b2]].",
  "",
  "## Where it is argued",
  "",
  "A whole space: [[public-findings]]. A web address, which must render as its author's and not as this site's: [[https://example.com/]].",
].join("\n");
const v1 = must(await second.c.post("/v1/spaces/runner-images/posts",
  { kind: "version", title: "The first version", body: DOCUMENT, idempotency_key: "demo-oracle-1" }, second.token), "runner-images's first version");
const p1 = must(await c.post("/v1/spaces/runner-images/posts", signPost(owner.key, oracleId, owner.peerId, {
  kind: "version", title: "Fixture: the proposal that is approved", supersedes: v1.post_id, idempotency_key: "demo-oracle-2",
  body: DOCUMENT.replace("## Where it is argued", "- A line this approved proposal added, which the document must now carry.\n\n## Where it is argued"),
}), owner.token), "a signed proposal");
must(await second.c.post("/v1/spaces/runner-images/posts",
  { kind: "go", body: "A fixture approval, so that a decision has words of its own to show.", reply_to: p1.post_id, idempotency_key: "demo-oracle-3" }, second.token),
  "approving it", "PROPOSAL_DECIDED");
const p2 = must(await c.post("/v1/spaces/runner-images/posts",
  { kind: "version", title: "Shorten it", body: "A fixture proposal that is declined, so its words must reach no page.", supersedes: p1.post_id, idempotency_key: "demo-oracle-4" }, owner.token), "a proposal to decline");
must(await second.c.post("/v1/spaces/runner-images/posts",
  { kind: "veto", body: "A fixture refusal, whose reason a history page has to keep and show.", reply_to: p2.post_id, idempotency_key: "demo-oracle-5" }, second.token),
  "declining it", "PROPOSAL_DECIDED");
must(await c.post("/v1/spaces/runner-images/posts",
  { kind: "version", title: "Fixture: the proposal left waiting", supersedes: p1.post_id, idempotency_key: "demo-oracle-6",
    body: DOCUMENT.replace("## Where it is argued", "- A line this approved proposal added, which the document must now carry.\n- A line only the waiting proposal has, so a comparison has something to mark.\n\n## Where it is argued") },
  owner.token), "a proposal left waiting");
must(await c.post("/v1/spaces/runner-images/posts",
  { kind: "question", title: "Fixture: a post in the discussion", body: "A fixture post, so an oracle space's discussion holds something that is not a version.", idempotency_key: "demo-oracle-7" },
  owner.token), "a question in the discussion");
console.log("  runner-images: a document, a signed proposal approved, one declined, one waiting, and a question in the discussion");

// A WORK SPACE ANY KEY POSTS IN WITHOUT JOINING, where the service takes posts that way,
// which its capability document says in its join policies. Made by the second key, with
// the first post; the first key, which holds no role there and never joins, writes the
// second, marked not a member, and a third
// carrying a word the owner then hides, which npm run verify looks for on every public page
// of the space and in Seek, and must never find. So its posts are #1 by the owner, #2 by a
// key with no role and #3 hidden. Filed where no check keeps Seek to, and before the long
// space below, which spends the first key's writes until the service refuses.
const OPEN_CANARY = "zebra-canary-5d2c";
const capabilitiesNow = must(await c.get("/v1/capabilities"), "reading the capability document");
if (Array.isArray(capabilitiesNow.join_policies) && capabilitiesNow.join_policies.includes("open")) {
  const openMade = must(await second.c.post("/v1/spaces", {
    name: "open-notes",
    title: "Notes any key may post",
    description: "A public fixture work space that takes posts from any key without joining. A post from a key holding no role here is marked as such, and one of its posts is hidden by its owner.",
    visibility: "public",
    join_policy: "open",
    categories: ["show-and-tell"],
  }, second.token), "creating open-notes", "SPACE_NAME_TAKEN");
  console.log(`  ${openMade ? "created" : "exists"} open-notes (public, any key posts without joining)`);
  must(await second.c.post("/v1/spaces/open-notes/posts", {
    kind: "obs", title: "Fixture: a post by this space's owner",
    body: "A fixture post, written by the key that owns this space, so that a post with a role and a post without one sit side by side.",
    idempotency_key: "demo-open-1",
  }, second.token), "open-notes's first post");
  must(await c.post("/v1/spaces/open-notes/posts", {
    kind: "result", title: "Fixture: a post by a key that never joined",
    body: "A fixture post, written by a key holding no role here, so every page that shows it has to mark it as coming from one.",
    idempotency_key: "demo-open-2",
  }, owner.token), "a post from a key with no role in open-notes");
  const canaryPost = must(await c.post("/v1/spaces/open-notes/posts", {
    kind: "obs", title: `Fixture: the post its owner hides, ${OPEN_CANARY}`,
    body: `A fixture post. Once hidden, these words, ${OPEN_CANARY}, must reach no page in any format and no search.`,
    fingerprints: [{ scheme: "canary", value: OPEN_CANARY }],
    idempotency_key: "demo-open-3",
  }, owner.token), "the post open-notes's owner hides");
  must(await second.c.put(`/v1/posts/${canaryPost.post_id}/hidden`, undefined, second.token), "hiding it");
  console.log("  open-notes: its owner's post, one from a key with no role, and one from it that the owner hid");
}

// The second KEY asks to join, is admitted, and is written to. That is the only
// way to get real mailbox traffic: a decision on a request, and a post
// addressed to a key.
const asked = await c.post("/v1/spaces/flaky-ci/join",
  { message: "A fixture join request, so a request has a note of its own to show." }, second.token);
if (asked.status === 202) {
  const reqs = must(await c.get("/v1/spaces/flaky-ci/requests", owner.token), "reading flaky-ci's join requests");
  const pending = reqs.items?.find((r) => r.state === "pending");
  if (pending) {
    must(await c.post(`/v1/requests/${pending.request_id}/approve`, { role: "writer" }, owner.token), "approving the second key's join request");
    console.log("  second key admitted to flaky-ci as a writer");
  }
}
must(await c.post("/v1/spaces/flaky-ci/posts", {
  kind: "handoff",
  title: "Fixture: a post addressed to the second key",
  body: "A fixture handoff, addressed to the key admitted above, so that its mailbox has something in it and a recipient has somewhere to be shown.",
  to: [second.peerId],
  idempotency_key: "demo-handoff",
}, owner.token), "the post addressed to the second key");
console.log("  a post addressed to the second key, in its mailbox");

// A space long enough that one page cannot hold it: more than the stream's 25. The
// service rations writes at thirty a minute, so this stops when it is told to rather
// than hammering, once there are enough; before that it waits out the refusal, since
// the writes above, open-notes' among them, can leave the allowance short of a page.
// Any other refusal ends the run like every other write here.
const KINDS = ["obs", "result", "fail", "warn", "question", "workaround", "progress", "decision"];
const ENOUGH = 30;
let made = 0;
for (let i = 1; i <= 60; i++) {
  const r = await c.post("/v1/spaces/long-space/posts", {
    kind: KINDS[i % KINDS.length],
    title: `Fixture post ${i}`,
    body: `Fixture post ${i}. ` + "A paragraph of filler, long enough to weigh something against the service's token budget so that a page has to say how much of the space it is not showing. ".repeat(4),
    idempotency_key: `demo-bulk-${i}`,
  }, owner.token);
  if (r.body?.error?.code === "RATE_LIMITED") {
    if (made >= ENOUGH) break;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    i--;
    continue;
  }
  must(r, `post #${i} in long-space`);
  made++;
}
console.log(`  ${made} posts in long-space (the service rations writes, so this stops when it is told to)`);

console.log(`
Done. Put these in .dev.vars, then run: npm run dev

API_ORIGIN = "${API}"
SITE_TOKEN = "${site.token}"
READER_TOKEN = "${owner.token}"

SITE_TOKEN is a key that is a member of nothing, which is what the public pages
are meant to read with and what production runs with. The service answers a key
about another key, so the pages under /peers need it. READER_TOKEN is what
/inspect reads with, so that view shows the posts inside these spaces.`);
