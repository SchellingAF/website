// The data the stand-in service answers with for the escaping and nothing-privileged
// tests: the two hostile fixtures of scripts/seed-hostile.mjs, as the product would
// return them to a member of both spaces.
//
// Agent-written fields carry the hostile shapes. Every field the product shows only
// to a member carries a sentinel value that appears nowhere else, so a page that
// publishes one can be caught by looking for the value.

import * as H from "../fixtures/hostile.ts";
import { CAPABILITIES, CATEGORIES, type Json, type World } from "./service.ts";

export const OWNER = "a1b2".repeat(16);
export const SECOND = "c3d4".repeat(16);
export const PUBLIC_ID = "0199aaaa-0000-7000-8000-000000000001";
export const PRIVATE_ID = "0199aaaa-0000-7000-8000-000000000002";
export const postId = (seq: number) => `0199bbbb-0000-7000-8000-${String(seq).padStart(12, "0")}`;
export const ORACLE_ID = "0199aaaa-0000-7000-8000-000000000005";
export const oraclePostId = (seq: number) => `0199cccc-0000-7000-8000-${String(seq).padStart(12, "0")}`;

const hex = (byte: string) => byte.repeat(32);
const b64u = (text: string) => Buffer.from(text, "utf8").toString("base64url");

/** What the product gives a member and never a stranger, with values found nowhere else. */
export const MEMBER_ONLY = {
  profile: {
    head_seq: "80808",
    member_count: 7919,
    revision: "8675309",
    updated_at: "2031-02-03T04:05:06.789Z",
    access: { role: "writer", tags: ["tag-sentinel-for-access"], read: true, post: true },
  },
  post: {
    budget: { budget_sentinel: "BUDGET-SENTINEL-1" },
    data: { data_sentinel: "DATA-SENTINEL-1" },
    run_id: "RUN-ID-SENTINEL-1",
    admitted_revision: "4242424242",
  },
  proof: {
    private: b64u("PRIVATE-PART-SENTINEL"),
    admitted_revision: "5353535353",
    admitted_control_hash: "acac".repeat(16),
  },
};

/** Each sentinel as the text it would appear as on a page. */
export const SENTINELS: Record<string, string> = {
  "the profile's head_seq": MEMBER_ONLY.profile.head_seq,
  member_count: String(MEMBER_ONLY.profile.member_count),
  revision: MEMBER_ONLY.profile.revision,
  updated_at: "2031-02-03T04:05:06",
  "updated_at, as a person reads it": "3 Feb 2031",
  "access tags": "tag-sentinel-for-access",
  budget: "BUDGET-SENTINEL-1",
  data: "DATA-SENTINEL-1",
  run_id: MEMBER_ONLY.post.run_id,
  "a post's admitted_revision": MEMBER_ONLY.post.admitted_revision,
  "the proof's private part": MEMBER_ONLY.proof.private,
  "the proof's admitted_revision": MEMBER_ONLY.proof.admitted_revision,
  "the proof's admitted_control_hash": "acacacacacacacac",
};

/** The kind a hostile capability document adds, which a space can be narrowed to. */
export const HOSTILE_KIND = "<script>alert(36)</script>";

/** A value the service writes itself, with a heading and a tag after a line break. Only a
 *  hostile service sends one; a page still takes none of them for granted. */
const injected = (honest: string, n: number) => `${honest}\n# injected heading <script>alert(${n})</script>`;

/** The category the hostile public space is filed under first, whose every word is hostile. */
export const HOSTILE_CATEGORY = "hostile-words";

/** The categories as a hostile service would list them: every text a category has
 *  carries markup and a line break, and among them are an id in the wrong shape, an
 *  entry under a parent that does not exist, and fields in shapes this site refuses. */
export function hostileRegister(): Json[] {
  return [
    ...CATEGORIES,
    {
      id: HOSTILE_CATEGORY, label: injected(`Hostile category ${H.XSS}`, 46), parent: "general", depth: 2, status: "active", children: 0,
      type: "<script>alert(53)</script>",
      description: injected(`Hostile category description ${H.ATTRIBUTE_BREAKOUT}`, 47),
      elsewhere: injected("Hostile elsewhere [a link](https://example.invalid/elsewhere)", 48),
      examples: ["<script>alert(49)</script>", "[a link](https://example.invalid/example)"],
      aliases: ["<img src=x onerror=alert(50)>", "``two ticks`` and a ` tick"],
      wikidata: "Q42\n<script>alert(51)</script>", homepage: "javascript:alert(52)", since: injected("2026-09-18", 54),
    },
    { id: "Not An Id <script>alert(55)</script>", label: "An id in the wrong shape", parent: null, depth: 1, status: "active", children: 0,
      description: "", elsewhere: "", examples: [], aliases: [] },
    { id: "orphaned", label: "Under a parent that is not there", parent: "nowhere-at-all", depth: 2, status: "active", children: 0,
      description: "", elsewhere: "", examples: [], aliases: [] },
    { id: "odd-status", label: "In a status this site does not know", parent: "general", depth: 2, status: "<b>open</b>", children: 0,
      description: "", elsewhere: "", examples: [], aliases: [] },
  ];
}

export function hostileWorld(): World {
  const breakout = H.ATTRIBUTE_BREAKOUT;
  const spaces: Json[] = [
    {
      name: "hostile-public", space_id: PUBLIC_ID,
      title: `${H.PUBLIC_TITLE} ${breakout}`, description: `${H.PUBLIC_DESCRIPTION} ${breakout}`,
      visibility: "public", join_policy: "request", status: "active", signed_only: false, replaced_by: null,
      // Filed under the hostile category first, then a named tool, then an id nobody
      // lists and a value that is no id at all.
      categories: [HOSTILE_CATEGORY, "vllm", "<script>alert(56)</script>"],
      owner: SECOND, contacts: [{ peer_id: SECOND, role: "owner" }], created_at: injected("2026-09-14T10:00:00.000Z", 25),
      last_written_at: "2026-09-14T11:00:00.000Z",
      ...MEMBER_ONLY.profile,
    },
    {
      // Every field the service sets on a space is hostile here, where no page's logic
      // depends on it: the space stays private, takes nobody by request, and is not closed.
      name: "hostile-content", space_id: PRIVATE_ID,
      title: H.SPACE_TITLE, description: `${H.SPACE_DESCRIPTION} ${breakout}`,
      visibility: injected("private", 16), join_policy: injected("invite", 17), status: injected("active", 18),
      signed_only: false, replaced_by: null, categories: ["general"],
      owner: injected(OWNER, 19), contacts: [{ peer_id: injected(OWNER, 20), role: injected("owner", 21) }],
      created_at: injected("2026-09-14T09:00:00.000Z", 22),
      ...MEMBER_ONLY.profile,
      head_seq: injected("0", 23), member_count: injected("1", 24),
    },
    {
      // An oracle space, one public document, whose document, proposals and decisions
      // are hostile. Its current version links to the public space and its first post.
      name: "hostile-oracle", space_id: ORACLE_ID,
      title: H.ORACLE_TITLE, description: `An oracle space of hostile content ${breakout}`,
      visibility: "public", join_policy: "request", status: "active", signed_only: false, replaced_by: null,
      categories: ["general"], owner: SECOND, contacts: [{ peer_id: SECOND, role: "owner" }],
      created_at: "2026-09-14T09:30:00.000Z",
      oracle: true, service_reviewer: true, forked_from: "<script>alert(78)</script>",
      document: { version: { post_id: oraclePostId(1), seq: "1" }, pending: 1 },
      ...MEMBER_ONLY.profile,
    },
    {
      // Withheld by the operator: the service keeps its name and blanks its words, and
      // leaves it out of every listing.
      name: "hostile-withheld", space_id: "0199aaaa-0000-7000-8000-000000000004",
      title: null, description: null, visibility: "public", join_policy: "request", status: "active", categories: null,
      owner: SECOND, contacts: [], created_at: "2026-09-14T08:00:00.000Z",
      unavailable: { state: "withheld", since: injected("2026-09-15T08:00:00.000Z", 41) },
    },
  ];

  const post = (seq: number, fields: Json): Json => ({
    post_id: postId(seq), space: "hostile-public", seq: String(seq), author: SECOND,
    posted_at: `2026-09-14T11:0${seq}:00.000Z`, to: [], reply_to: null, supersedes: null, retracts: null,
    fingerprints: [], fingerprint_count: 0, signed: false, space_id: PUBLIC_ID, object_id: hex(`0${seq}`),
    ...MEMBER_ONLY.post,
    ...fields,
  });
  const posts = [
    post(1, {
      kind: "result", title: H.PUBLIC_POST_TITLE, body: `${H.PUBLIC_POST_BODY}\n${H.POST_BODY}\n${breakout}`,
      fingerprints: [H.PUBLIC_FINGERPRINT, H.POST_FINGERPRINT], fingerprint_count: 2, signed: true,
    }),
    // A reply whose kind, author and time, all set by the service, are hostile.
    post(2, {
      kind: injected("obs", 26), author: injected(SECOND, 27), posted_at: injected("2026-09-14T11:02:00.000Z", 28),
      title: H.REPLY_TITLE, body: H.XSS, reply_to: postId(1),
    }),
    post(3, { kind: "result", title: H.CORRECTION_TITLE, body: H.XSS, supersedes: postId(1) }),
    post(4, { kind: "warn", title: H.NEWLINE_TITLE, body: "The title of this post contains a line break on purpose." }),
    // Read by its id, the service counts its replies in words.
    post(5, {
      kind: "question", title: `${H.POST_TITLE} ${H.BACKTICK_TITLE}`, body: "``two`` and ````four```` and a lone ` tick",
      reply_count: injected("1", 29),
    }),
    // Withheld for a reason this site has no words for, and titled, so Seek finds it.
    post(6, {
      kind: "obs", title: "A hostile post the operator withheld", body: null,
      unavailable: { state: "withheld", reason: injected("court_order", 30), since: "2026-09-14T12:10:00.000Z" },
    }),
    post(7, { kind: "obs", title: null, body: null, unavailable: { state: injected("archived", 31) } }),
    // A number that is not one, retracting a post on the same page and replying to an id
    // that is not one either. Last, so every cursor before it still finds its own post.
    post(8, {
      seq: injected("8", 32), kind: "result", title: "A hostile post whose number is not one", body: H.XSS,
      retracts: postId(4), reply_to: injected(postId(1), 33),
      // Not "08" repeated, which holds the profile's head_seq sentinel, 80808.
      object_id: hex("0f"),
    }),
  ];

  // The service's own record. Shaped as the product shapes one; nothing here is
  // meant to check out, and the hostile values sit in the fields the pages quote.
  const checkpoints = [
    {
      checkpoint_id: hex("c1"), stream: "posts", first: "1", last: "3", previous_checkpoint_id: null,
      predecessor_hash: hex("d1"), ending_hash: hex("e1"), merkle_root: hex("f1"), service_epoch: "1",
      created_at: "2026-09-14T12:00:00.000Z", canonical: b64u("{}"), signature: "5a".repeat(64),
      signer: { key_id: hex("b1"), public_key: hex("b2"), root_key: hex("b3"), certificate: b64u("{}"), certificate_signature: "5b".repeat(64), development: false },
    },
    {
      checkpoint_id: "<script>alert(8)</script>", stream: "posts", first: "4", last: "5", previous_checkpoint_id: hex("c1"),
      predecessor_hash: hex("e1"), ending_hash: `" onmouseover="alert(9)`, merkle_root: "[a link](https://example.invalid/root)",
      service_epoch: "1", created_at: "2026-09-14T12:05:00.000Z", canonical: "not base64url!", signature: "<b>bold</b>",
      signer: { key_id: "<img src=x onerror=alert(10)>", public_key: hex("b2"), root_key: hex("b3"), certificate: b64u("{}"), certificate_signature: "5b".repeat(64), development: true },
    },
  ];

  const proofs: Record<string, Json> = {};
  for (const p of posts) {
    // A post whose number is not one has no address, so nothing asks for its proof.
    if (!/^[0-9]+$/.test(p.seq)) continue;
    const seq = Number(p.seq);
    proofs[`hostile-public/${seq}`] = {
      post: {
        ...p,
        proof: {
          // Post 1's proof is the shape a hostile service would send; the others are
          // well formed and simply do not check out.
          object_id: seq === 1 ? "<script>alert(7)</script>" : hex(`0${seq}`),
          canonical: b64u(JSON.stringify({ v: 1, title: p.title })),
          private: MEMBER_ONLY.proof.private,
          signature: null,
          chain: {
            seq: p.seq, admission: hex("ad"),
            admitted_revision: MEMBER_ONLY.proof.admitted_revision, admitted_control_hash: MEMBER_ONLY.proof.admitted_control_hash,
            previous_hash: hex("9e"), chain_hash: hex(`1${seq}`),
          },
        },
      },
      leaf: hex("1e"),
      checkpoint: seq <= 3 ? checkpoints[0] : checkpoints[1],
      inclusion: { leaf_index: seq <= 3 ? seq - 1 : seq - 4, tree_size: seq <= 3 ? 3 : 2, path: [hex("2e")] },
    };
  }

  // The public space's tasks. The agent's own words, a title, a tag and a reason, are hostile;
  // so is every field the service writes itself, in a task that would otherwise be ordinary.
  const task = (number: number, fields: Json): Json => ({
    number, title: `Task ${number}`, body: null, tag: null, after: [], state: "open", created_by: SECOND,
    created_at: "2026-09-14T14:00:00.000Z", claimed_by: null, claimed_until: null, done_post_id: null, done_at: null,
    accepted_at: null, cycle: 1, confirmations: { required: 2, given: [] },
    ...fields,
  });
  const tasks = [
    task(1, {
      title: `${H.XSS} ${H.BACKTICK_TITLE}`, tag: `${H.XSS}`, state: "open", cycle: 2,
      rejected: { by: SECOND, reason: `${H.XSS}\n# A heading that is not ours ${H.ATTRIBUTE_BREAKOUT}`, at: "2026-09-14T14:30:00.000Z" },
    }),
    task(2, { title: H.NEWLINE_TITLE, state: "claimed", claimed_by: SECOND, claimed_until: "2026-09-14T18:00:00.000Z" }),
    task(3, {
      title: "A task the service describes in markup", state: injected("done", 80), claimed_by: injected(SECOND, 81),
      claimed_until: injected("2026-09-14T18:00:00.000Z", 82), done_post_id: injected(postId(1), 83),
      done_at: injected("2026-09-14T15:00:00.000Z", 84), confirmations: { required: injected("2", 85), given: [injected(OWNER, 86)] },
      rejected: { by: injected(SECOND, 87), reason: H.XSS, at: injected("2026-09-14T14:30:00.000Z", 88) },
    }),
    task(4, { title: "A done task whose result is on the page", state: "done", claimed_by: SECOND, done_post_id: postId(1), done_at: "2026-09-14T15:00:00.000Z", confirmations: { required: 2, given: [OWNER] } }),
    task(5, { title: "An accepted task whose result is not", state: "accepted", claimed_by: SECOND, done_post_id: "0199bbbb-0000-7000-8000-0000000000ff", done_at: "2026-09-14T15:00:00.000Z", accepted_at: "2026-09-14T16:00:00.000Z", confirmations: { required: 2, given: [OWNER, SECOND] } }),
    // A number that is not one, and a task with no title: left out, because neither can be named.
    task(6, { number: injected("6", 89), title: "Not a number" }),
    task(7, { title: null }),
  ];

  // The public space's findings. The agent's own words, a claim, are hostile; so is every
  // field the service writes itself, in a finding that would otherwise be ordinary.
  const finding = (number: number, fields: Json): Json => ({
    number, post_id: postId(number), claim: `Claim ${number}`, status: "proposed", confidence: "low", author: SECOND,
    posted_at: "2026-09-14T14:00:00.000Z", sources: [], cited_by: 0, source_withdrawn: false, superseded_by: null, retracted_by: null,
    ...fields,
  });
  const findings = [
    finding(1, { claim: `${H.XSS} ${H.BACKTICK_TITLE}`, status: "supported", confidence: "high", sources: [postId(2)], cited_by: 2, source_withdrawn: true }),
    finding(2, { claim: H.NEWLINE_TITLE, status: "disputed", confidence: "medium" }),
    finding(3, {
      claim: "A finding the service describes in markup", status: injected("supported", 90), confidence: injected("high", 91),
      author: injected(OWNER, 92), posted_at: injected("2026-09-14T14:00:00.000Z", 93), post_id: injected(postId(3), 94),
      sources: [injected(postId(1), 95)], cited_by: injected("2", 96), source_withdrawn: injected("true", 97), superseded_by: injected(postId(1), 98),
    }),
    // A number that is not one, and a finding with no claim: left out, because neither can be named.
    finding(4, { number: injected("4", 99), claim: "Not a number" }),
    finding(5, { claim: null }),
  ];

  // The oracle space's record: its document, a proposal declined with a hostile reason,
  // the decision, and a proposal still waiting.
  const oraclePost = (seq: number, fields: Json): Json => ({
    post_id: oraclePostId(seq), space: "hostile-oracle", seq: String(seq), author: SECOND,
    posted_at: `2026-09-14T13:0${seq}:00.000Z`, to: [], reply_to: null, supersedes: null, retracts: null,
    fingerprints: [], fingerprint_count: 0, signed: false, space_id: ORACLE_ID, object_id: hex(`a${seq}`),
    ...MEMBER_ONLY.post,
    ...fields,
  });
  const oraclePosts = [
    oraclePost(1, { kind: "version", title: H.PROPOSAL_SUMMARY, body: H.ORACLE_DOCUMENT }),
    oraclePost(2, { kind: "version", title: H.PROPOSAL_SUMMARY, body: `${H.ORACLE_DOCUMENT}\n\n${H.XSS}`, supersedes: oraclePostId(1) }),
    oraclePost(3, { kind: "veto", title: null, body: H.DECLINE_REASON, reply_to: oraclePostId(2) }),
    oraclePost(4, { kind: "version", title: H.PROPOSAL_SUMMARY, body: H.XSS, supersedes: oraclePostId(1) }),
    oraclePost(5, { kind: "version", title: H.PROPOSAL_SUMMARY, body: H.XSS, supersedes: oraclePostId(1) }),
  ];
  const version = (seq: number, state: string, fields: Json = {}): Json => ({
    post_id: oraclePostId(seq), seq: String(seq), author: SECOND, posted_at: `2026-09-14T13:0${seq}:00.000Z`,
    summary: H.PROPOSAL_SUMMARY, signed: false, state, edits: seq === 1 ? null : "1", same_text_as: null, decision: null,
    ...fields,
  });
  const versions = [
    version(1, "current"),
    // Declined, by a decision whose kind, author and time, all set by the service, are hostile.
    version(2, "declined", {
      decision: {
        post_id: oraclePostId(3), seq: "3", kind: injected("veto", 60), author: injected(SECOND, 61),
        reason: H.DECLINE_REASON, at: injected("2026-09-14T13:03:30.000Z", 62),
      },
    }),
    version(4, "pending"),
    // What became of it, what it edits and what it repeats, all set by the service, in words.
    version(5, injected("out_of_date", 63), { edits: injected("1", 64), same_text_as: injected("1", 65) }),
  ];
  const cites = [{ name: "hostile-oracle", title: H.ORACLE_TITLE, version_seq: injected("1", 66), changed_at: injected("2026-09-14T13:01:00.000Z", 67) }];

  return {
    // The words the service describes itself with are its own, and hostile too.
    capabilities: {
      ...CAPABILITIES,
      kinds: [...CAPABILITIES.kinds, HOSTILE_KIND],
      kind_groups: { ...CAPABILITIES.kind_groups, [injected("misc", 37)]: [HOSTILE_KIND] },
      join_policies: [...CAPABILITIES.join_policies, injected("open", 38)],
      visibilities: [...CAPABILITIES.visibilities, injected("secret", 39)],
      roles: [...CAPABILITIES.roles, injected("guest", 40)],
      categories: { ...CAPABILITIES.categories, top: [...CAPABILITIES.categories.top, "<script>alert(57)</script>", HOSTILE_CATEGORY] },
      modules: { ...CAPABILITIES.modules, findings: { status: "available" } },
    },
    categories: hostileRegister(),
    spaces,
    posts: { "hostile-public": posts, "hostile-content": [], "hostile-oracle": oraclePosts },
    tasks: { "hostile-public": tasks },
    findings: { "hostile-public": findings },
    versions: { "hostile-oracle": versions },
    documentFields: { "hostile-oracle": { pending: injected("2", 68) } },
    links: { "hostile-public": cites, "hostile-public/1": cites },
    // Every page of the public space's posts says how long the space is, and where it
    // continues, in words.
    pageFields: { "hostile-public": { head_seq: injected("8", 34), next_after: injected("8", 35), has_more: true } },
    seekFields: { truncated_note: injected("more text matches exist; narrow q or raise limit.", 45) },
    // A notice whose signed words are hostile: a reason with markup, a name that is no
    // name, a state in markup and a line break, and a signature that is not one.
    recovery: [{
      notice_id: "<script>alert(71)</script>", service_epoch: injected("2", 72), created_at: "2026-09-16T12:00:00.000Z",
      notice: { reason: "the service's parsed copy, which no page shows" },
      canonical: b64u(JSON.stringify({
        v: 1, service_epoch: injected("2", 72), previous_epoch: "<b>1</b>", reason: `${H.XSS} ${breakout}`, created_at: "2026-09-16T12:00:00.000Z",
        spaces: [{
          name: "<img src=x onerror=alert(73)>",
          signed: [{ stream: injected("posts", 74), last: "40\n# heading", found: "<script>alert(75)</script>", checkpoint_id: "[a link](https://example.invalid/cp)" }],
          recovered: { posts: { last: injected("37", 76) }, events: { last: "3" } },
          replacement: { name: "hostile-public" },
        }],
        signer_key_id: "<script>alert(77)</script>",
      })),
      signature: "<b>not a signature</b>",
      signer: { key_id: "<script>alert(77)</script>", public_key: hex("b2"), root_key: hex("b3"), certificate: b64u("{}"), certificate_signature: "5b".repeat(64), development: false },
    }],
    // The rules are the operator's, and still shown only as text: a tag, a fence the page
    // must not let them close, a heading and a line that tries to end the block.
    reviewerRules: `# A heading that is not ours <script>alert(69)</script>\n\n\`\`\`\nfenced\n\`\`\`\n\n</pre><img src=x onerror=alert(70)> ${H.ATTRIBUTE_BREAKOUT}\n`,
    proofs,
    checkpoints: { "hostile-public": checkpoints },
    peers: {
      [SECOND]: {
        // The fields the service writes itself are hostile too: its id for the key,
        // the passkey's algorithm and when the key registered. Only a hostile service
        // sends these, and a page still takes none of them for granted.
        peer_id: "<script>alert(13)</script>", public_key: null, key_type: "passkey",
        passkey: { algorithm: "ES256) <script>alert(14)</script> [a link](https://example.invalid/alg", public_key: "<script>alert(11)</script>" },
        registered_at: "2026-09-13T09:00:00.000Z\n# injected heading <script>alert(15)</script>",
        spaces_owned: ["hostile-public", "<script>alert(12)</script>"],
      },
    },
  };
}
