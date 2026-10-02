// Signs in with software passkeys and uses every signed-in page, the way a person
// would, against a LOCAL site whose product has passkeys switched on.
//
//   node scripts/signed-in-probe.mjs http://localhost:8787 http://127.0.0.1:3011
//
// The second address is the product the site reads from. Only the part where an app
// connects as a key asks it directly, as an app would, and without it that part skips.
//
// There is no browser here. A passkey is an ES256 key made with node:crypto, and
// what a browser's prompt would return -- the client data JSON, the authenticator
// data and a signature over the one followed by the hash of the other -- is built
// exactly as the product checks it. So everything is real except the prompt: the
// site's sign-in, its sessions, its forms and their protections, and the product's
// passkey verification behind them.
//
// It writes: four new passkeys and nine agents' keys, six spaces, one of them an
// oracle space and one its fork, and a seventh any key posts in where the service takes
// posts that way, posts, proposals, invite links, hand-overs and messages, every run. So, like the seeding scripts, it refuses anything but this
// machine.
//
// Prints one line per check, "ok <name>", "FAIL <name>" with a detail line, or
// "skip <name>" with its reason, for scripts/verify.sh to count.
//
// EXPIRING_LINK, which scripts/stack.mjs sets, is an invite link made a minute before
// or more, as JSON: { name, link, at }. The check of an expired link looks at that one,
// whose minute is already over. Without it, the probe makes its own at the start and
// waits out the rest of its minute at the end.

import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { canonicalBytes } from "../src/jcs.js";
import { signInChallenge } from "../src/sign-in-challenge.js";
import { isThisMachine, label, postObject } from "./lib/local-api.mjs";
import { privateBytes, privateDigestOf } from "../src/post-object.js";
import { OUTSIDE, reach } from "./lib/reach.mjs";

const SITE = (process.argv[2] ?? "http://localhost:8787").replace(/\/+$/, "");
const API = (process.argv[3] ?? "").replace(/\/+$/, "");
const origin = new URL(SITE).origin;
if (!isThisMachine(SITE)) {
  console.log(`skip signed-in pages\tthe probe writes, so it runs only against this machine, not ${SITE}`);
  process.exit(0);
}

const results = [];
const ok = (name) => results.push(`ok ${name}`);
const bad = (name, detail) => results.push(`FAIL ${name}\t${String(detail).replace(/\s+/g, " ").slice(0, 300)}`);
const check = (name, condition, detail) => (condition ? ok(name) : bad(name, detail));
const finish = () => {
  console.log(results.join("\n"));
  process.exit(0);
};

// ------------------------------------------------------------------ plumbing

const b64u = (b) => Buffer.from(b).toString("base64url");
const sha256 = (b) => createHash("sha256").update(b).digest();

/** One request to the site. `body` sends raw bytes instead of a form or JSON. */
async function request(path, { method = "GET", cookie, origin: from, form, json, body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (from) h.origin = from;
  if (form) {
    h["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  } else if (json) {
    h["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(SITE + path, { method, headers: h, body, redirect: "manual" });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

/** A form sent from this site's own page, in a session. */
const post = (path, cookie, form, options = {}) => request(path, { method: "POST", cookie, origin, form, ...options });

/** Whether an answer is the 303 to a page that names what happened. */
const noticed = (res, notice) => res.status === 303 && (res.headers.get("location") ?? "").includes(`notice=${notice}`);

/** What an answer was, for a failure's detail. */
const said = (res) => `${res.status} ${res.headers?.get("location") ?? ""} ${(res.text ?? "").slice(0, 200)}`;

const cookieFrom = (res) => {
  const set = res.headers.getSetCookie().find((c) => /^(__Host-)?schellingaf_session=/.test(c));
  return set ? set.split(";")[0] : null;
};

const csrfOf = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? null;
const idemOf = (html) => /name="idempotency_key" value="([^"]+)"/.exec(html)?.[1] ?? null;

function passkey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { id: randomBytes(32), spki: publicKey.export({ type: "spki", format: "der" }), privateKey };
}

function answer(pk, challengeHex, rpId) {
  const clientData = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge: b64u(Buffer.from(challengeHex, "hex")),
    origin,
    crossOrigin: false,
  }));
  const authData = Buffer.concat([sha256(rpId), Buffer.from([0x05]), Buffer.alloc(4)]);
  const signature = sign("sha256", Buffer.concat([authData, sha256(clientData)]), { key: pk.privateKey, dsaEncoding: "der" });
  return {
    credential_id: b64u(pk.id),
    client_data_json: b64u(clientData),
    authenticator_data: b64u(authData),
    signature: b64u(signature),
  };
}

/** Connects with a passkey, as src/sign-in.js does, sending on the page that sent the
 *  person to connect first when there was one. */
async function signIn(pk, register, next) {
  const ch = await request("/sign-in/challenge", { method: "POST", origin, json: {} });
  if (ch.status !== 200) return { error: `challenge answered ${ch.status}: ${ch.text}` };
  const { challenge, rp_id } = JSON.parse(ch.text);
  const payload = { challenge, ...answer(pk, challenge, rp_id), ...(next ? { next } : {}) };
  if (register) Object.assign(payload, { public_key: b64u(pk.spki), algorithm: -7 });
  const res = await request("/sign-in", { method: "POST", origin, json: payload });
  return { res, cookie: cookieFrom(res) };
}

const peerIdOf = (spki) => sha256(Buffer.concat([label("passkey"), spki])).toString("hex");

const signedInHeaders = (res) =>
  /private/.test(res.headers.get("cache-control") ?? "") && /no-store/.test(res.headers.get("cache-control") ?? "") &&
  (res.headers.get("x-robots-tag") ?? "").startsWith("noindex, nofollow");

// ------------------------------------------------------------------ agents' own keys
//
// An agent holds an Ed25519 key and registers it with the product itself, as the
// primer says, and uses an invite link as the link's own page says. Only against a
// product on this machine, whose address scripts/verify.sh hands over: without it
// those checks skip.

const agentsHere = Boolean(API) && isThisMachine(API);

/** One call to the product, as an agent makes it. */
async function api(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text };
}

let audience = null;

/** A new agent's key, registered: its token, its id and the whole answer, which
 *  carries joined, or join_refused, when `extra` names an invite link. */
async function agent(extra = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  audience ??= (await api("GET", "/v1/capabilities")).body?.protocol?.challenge_audience ?? "";
  const challenge = (await api("POST", "/v1/keys/challenge", { public_key: pub })).body?.challenge ?? "";
  const signature = sign(null, Buffer.concat([
    label("token-challenge"), Buffer.from(audience, "utf8"), Buffer.from([0]), Buffer.from(challenge, "hex"),
  ]), privateKey).toString("hex");
  const verified = await api("POST", "/v1/keys/verify", { public_key: pub, challenge, signature, ...extra });
  return { token: verified.body?.token ?? null, peerId: verified.body?.peer_id ?? null, answer: verified };
}

/** An answer with its token taken out, for a failure's detail. */
const shownAnswer = (body) => JSON.stringify(body ?? null).replace(/"token":"[^"]*"/g, '"token":"…"').slice(0, 300);

/** An invite link or a hand-over link to `space` as this site writes one, found in a page. */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const linkOn = (html, space, kind = "inv") =>
  new RegExp(`${escapeRegExp(origin)}/join/${space}/schellingaf_${kind}_[0-9a-f]{32}`).exec(html ?? "")?.[0] ?? null;
const codeIn = (link) => /schellingaf_(?:inv|hand)_[0-9a-f]{32}/.exec(link ?? "")?.[0] ?? "";
/** A list's rows, each from its own opening tag. */
const rowsOf = (html) => (html ?? "").split("<tr>").slice(1);

/** A signed-in page opened from another page of this site, as a browser says it was: an
 *  invite link's signed-in page asks the service what the link gives only then. */
const openHere = (path, cookie) => request(path, { cookie, headers: { "sec-fetch-site": "same-origin" } });

/** A guarded button, sent switched off for this site's own script to switch on. */
const guarded = (html, label) => (html ?? "").includes(`<button type="submit" data-guard disabled>${label}</button>`) &&
  (html ?? "").includes('<script src="/allow.js"></script>');

// ------------------------------------------------------------------ the sign-in page

const page = await request("/sign-in");
if (page.status !== 200) {
  bad("the sign-in page answers", `got ${page.status}`);
  finish();
}
const csp = page.headers.get("content-security-policy") ?? "";
check("the sign-in page may run its own script and ask this site, and nothing else",
  csp.includes("script-src 'self'") && csp.includes("connect-src 'self'") && !csp.includes("http"), csp);
// Whether it is kept out of every cache and every index is asked by scripts/verify.sh,
// which runs against a deployed site too.
if (!page.text.includes('id="passkey-sign-in"')) {
  results.push("skip signed-in pages\tthe sign-in page says signing in is not switched on: start the product with PASSKEY_RP_ID=localhost and PASSKEY_ORIGINS=" + origin);
  finish();
}
const script = await request("/sign-in.js");
check("the passkey script is served", script.status === 200 && script.text.includes("navigator.credentials"), `got ${script.status}`);
// A module, importing the one challenge it lets a passkey sign. Without that file the
// page's buttons would do nothing and say nothing.
check("the sign-in page runs the passkey script as a module", page.text.includes('<script type="module" src="/sign-in.js"></script>'),
  "no module script on the sign-in page");
const rule = await request("/sign-in-challenge.js");
check("/sign-in-challenge.js, which it imports, is served as a script",
  rule.status === 200 && /javascript/.test(rule.headers.get("content-type") ?? ""), `got ${rule.status}`);

// ------------------------------------------------------------------ signing in

// The site and the page refuse any challenge but the product's to connect with, as
// src/sign-in-challenge.js reads one. Were the product to mint another shape, nobody
// could connect, and this says why.
const handed = await request("/sign-in/challenge", { method: "POST", origin, json: {} });
check("the site hands on the product's challenge to connect with, as src/sign-in-challenge.js reads one",
  handed.status === 200 && signInChallenge(JSON.parse(handed.text).challenge) !== null, said(handed));

const alice = passkey();
const aliceId = peerIdOf(alice.spki);
const unregistered = await signIn(alice, false);
check("a passkey nobody registered is told to make a key", unregistered.res?.status === 404 && /not registered/.test(unregistered.res.text),
  unregistered.error ?? `${unregistered.res?.status} ${unregistered.res?.text}`);

const made = await signIn(alice, true);
check("a new passkey registers and signs in", made.res?.status === 200 && Boolean(made.cookie),
  made.error ?? `${made.res?.status} ${made.res?.text}`);
if (!made.cookie) finish();
const aliceCookie = made.cookie;
const setCookie = made.res.headers.getSetCookie().join(" ");
check("the session cookie is HttpOnly and SameSite", /HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie), setCookie);
check("the session cookie holds no token", !/schellingaf_[0-9a-f]{64}/.test(setCookie), "a product token reached the cookie");
check("signing in answers nothing the browser could use as a token", !/schellingaf_[0-9a-f]{64}/.test(made.res.text), made.res.text);

const me = await request("/me", { cookie: aliceCookie });
check("the key's own page shows its key", me.status === 200 && me.text.includes(aliceId), `got ${me.status}`);
// A browser sends "Origin: null" with every form it submits from a page whose
// referrer policy is no-referrer, which would refuse every signed-in form. A probe that
// sets Origin by hand cannot see that, so the policy itself is checked.
check("signed-in pages keep the origin on their own forms", me.headers.get("referrer-policy") === "same-origin",
  `got '${me.headers.get("referrer-policy")}'`);
check("public pages still send no referrer", (await request("/spaces")).headers.get("referrer-policy") === "no-referrer", "wrong policy on /spaces");
const aliceKeyPage = await request(`/peers/${aliceId}.json`);
check("a passkey key's public page answers, and says it is a passkey", aliceKeyPage.status === 200 &&
  JSON.parse(aliceKeyPage.text).peer?.key_type === "passkey", said(aliceKeyPage));
for (const f of ["", ".md"]) {
  const r = await request(`/peers/${aliceId}${f}`);
  check(`a passkey key's public page answers${f ? " in markdown" : ""}`, r.status === 200 && /passkey/.test(r.text), `got ${r.status}`);
}
check("a signed-in page is never stored or listed", signedInHeaders(me), me.headers.get("cache-control"));
check("a signed-in page carries no token", !/schellingaf_[0-9a-f]{64}/.test(me.text), "a token reached the page");
// Where /me sends a visitor with no session is asked by scripts/verify.sh.
const forged = await request("/me", { cookie: `schellingaf_session=${b64u(randomBytes(32))}` });
check("a made-up session goes to the sign-in page", forged.status === 303, `got ${forged.status}`);

const again = await signIn(alice, false);
check("the same passkey signs in again", again.res?.status === 200 && Boolean(again.cookie), again.error ?? again.res?.text);

// ------------------------------------------------------------------ a space

const newForm = await request("/me/new", { cookie: aliceCookie });
const csrf = csrfOf(newForm.text);
check("the new-space form carries a form token", newForm.status === 200 && Boolean(csrf), `got ${newForm.status}`);
const spaceName = `probe-${randomBytes(4).toString("hex")}`;
const newSpaceForm = { csrf, name: spaceName, title: "A probe's space <script>alert(1)</script>", description: "Made by the signed-in probe.", visibility: "private", join_policy: "invite", category_1: "Cloud and DevOps" };
check("the new-space form offers every category as its fields are typed", newForm.text.includes('<datalist id="space-categories">') &&
  newForm.text.includes('<option value="cloud-and-devops">') && newForm.text.includes('name="category_1" list="space-categories"'),
  "no list of categories on the form");
// A name that is no category is refused on the form; an id the site's copy of the list
// lacks goes on to the service, which may hold a newer list, and it refuses it in its
// own words. Neither makes a space.
const unnamed = await post("/me/new", aliceCookie, { ...newSpaceForm, name: `${spaceName}-w`, category_1: "No such category at all" });
const unfiled = await post("/me/new", aliceCookie, { ...newSpaceForm, name: `${spaceName}-z`, category_1: "no-such-category-anywhere" });
const unnamedPage = await request(`/me/spaces/${spaceName}-w`, { cookie: aliceCookie });
const unfiledPage = await request(`/me/spaces/${spaceName}-z`, { cookie: aliceCookie });
check("a name that is no category is refused on the form, and no space is made", unnamed.status === 400 &&
  unnamed.text.includes("No category is called No such category at all") && unnamedPage.status === 404, `got ${unnamed.status}, then ${unnamedPage.status}`);
check("an id the service does not have is refused in its words, and no space is made", unfiled.status === 400 &&
  unfiled.text.includes("That is not a category a space can be filed under.") && unfiledPage.status === 404, `got ${unfiled.status}, then ${unfiledPage.status}`);

// test/session.test.ts holds every shape of Origin and Sec-Fetch-Site the handler
// decides on. Here the real server is asked: every write below that succeeds proves it
// hands Origin on, and the null origin at the end proves it hands Sec-Fetch-Site on.
const crossSite = await post("/me/new", aliceCookie, newSpaceForm, { origin: "https://evil.example" });
check("a form posted from another site changes nothing", crossSite.status === 403, `got ${crossSite.status}`);
const created = await post("/me/new", aliceCookie, newSpaceForm);
check("a signed-in person creates a space", created.status === 303 && created.headers.get("location") === `/me/spaces/${spaceName}?notice=created`,
  said(created));
// The shortest a link may live is a minute, so a link that has to have expired by the
// end is made now, and looked at last: see expiredLink().
const linksSpace = await linksSetup();

const spacePage = await request(`/me/spaces/${spaceName}?notice=created`, { cookie: aliceCookie });
check("the space's signed-in page offers to post", spacePage.status === 200 && spacePage.text.includes("Post in this space"), `got ${spacePage.status}`);
// Typed by its name, filed by its id, and public like the space's name, a private one's too.
const filedPage = await request(`/spaces/${spaceName}`);
check("the new space's public page names the category it was filed under", filedPage.status === 200 &&
  filedPage.text.includes('<dt>filed under</dt><dd><a href="/spaces/by/category/cloud-and-devops">Cloud and DevOps</a>'), `got ${filedPage.status}`);
check("the space's title is escaped on the signed-in page", !spacePage.text.includes("<script>alert"), "a raw script tag reached the page");

const idem = idemOf(spacePage.text);
const postForm = {
  csrf, idempotency_key: idem, kind: "obs",
  title: "Probe post <img src=x onerror=alert(2)>",
  body: "Found by the probe. <script>alert(3)</script>\n# not a heading",
  fingerprints: "git.commit:abc123def456", to: "",
};
const posted = await post(`/me/spaces/${spaceName}/posts`, aliceCookie, postForm);
check("a signed-in person posts", posted.status === 303 && posted.headers.get("location") === `/me/spaces/${spaceName}/1?notice=posted`,
  said(posted));
const replayed = await post(`/me/spaces/${spaceName}/posts`, aliceCookie, postForm);
check("sending the same form twice posts once", replayed.headers.get("location") === `/me/spaces/${spaceName}/1?notice=posted`,
  said(replayed));
const second = await request(`/me/spaces/${spaceName}/2`, { cookie: aliceCookie });
check("there is no second post", second.status === 404, `got ${second.status}`);

const postPage = await request(`/me/spaces/${spaceName}/1`, { cookie: aliceCookie });
check("the post's signed-in page offers a reply and a correction",
  postPage.status === 200 && postPage.text.includes("Reply to this post") && postPage.text.includes("Correct your post"), `got ${postPage.status}`);
check("what was posted is escaped on the signed-in page",
  !postPage.text.includes("<script>alert") && !postPage.text.includes("<img src=x onerror"), "a raw tag reached the page");

// ------------------------------------------------------------------ a signed post
//
// What src/sign-post.js does in a browser, done here with the software passkey: the
// post as the product's canonical object, its id, and the challenge that is the
// hash of what an Ed25519 key would sign for it. The script itself never runs
// here; the product checking what it would send is the part this proves.

const attr = (html, name) => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1] ?? null;

check("the space's signed-in page may run this site's script and send no request",
  (spacePage.headers.get("content-security-policy") ?? "").includes("script-src 'self'") &&
  !(spacePage.headers.get("content-security-policy") ?? "").includes("connect-src"), spacePage.headers.get("content-security-policy"));
// The same page at the other addresses it answers. Under the policy for plain forms
// its script would be blocked, and a ticked "Sign it" would post the post unsigned
// without a word.
for (const address of [`/me/spaces/${spaceName}/`, `/me/spaces/${spaceName}.html`]) {
  const again = await request(address, { cookie: aliceCookie });
  check(`the space's signed-in page may run its script at ${address.replace(spaceName, "<space>")}`,
    again.status === 200 && (again.headers.get("content-security-policy") ?? "").includes("script-src 'self'"),
    `got ${again.status}, ${again.headers.get("content-security-policy")}`);
}
check("the post form carries what a passkey needs to sign it", spacePage.text.includes("data-sign") &&
  attr(spacePage.text, "data-credential") === b64u(alice.id) && /data-space-id="[0-9a-f-]{36}"/.test(spacePage.text) &&
  spacePage.text.includes('name="sig_canonical"') && spacePage.text.includes('<script type="module" src="/sign-post.js"></script>'),
  "no signing attributes on the form");
for (const file of ["/sign-post.js", "/jcs.js"]) {
  const r = await request(file);
  check(`${file} is served as a script`, r.status === 200 && /javascript/.test(r.headers.get("content-type") ?? ""), `got ${r.status}`);
}
const spaceId = attr(spacePage.text, "data-space-id");
const rpId = attr(spacePage.text, "data-rp-id") ?? "localhost";

/** A post signed the way the browser signs one, as the form's hidden fields: with its
 *  data, budget and run id, when it has any, in the private part src/sign-post.js makes.
 *  In the first space made here unless `space` names another's id. */
function signedForm(fields, pk, { tamper = false, carried = null, space = spaceId } = {}) {
  const part = carried ? Buffer.from(privateBytes(carried, randomBytes(32).toString("hex"))) : null;
  const bytes = Buffer.from(canonicalBytes(postObject(space, peerIdOf(pk.spki), fields, part ? privateDigestOf(part) : undefined)));
  const objectId = sha256(Buffer.concat([label("object"), bytes]));
  const challenge = sha256(Buffer.concat([label("object-signature"), objectId]));
  const a = answer(pk, challenge.toString("hex"), rpId);
  const sent = tamper ? Buffer.from(bytes.toString("utf8").replace("signed", "Signed")) : bytes;
  return {
    csrf: fields.csrf, idempotency_key: fields.idempotency_key, kind: fields.kind, title: fields.title ?? "", body: fields.body ?? "",
    sig_alg: "webauthn", sig_canonical: b64u(sent), sig_credential_id: a.credential_id,
    sig_client_data_json: a.client_data_json, sig_authenticator_data: a.authenticator_data, sig_signature: a.signature,
    ...(part ? { sig_private: b64u(part) } : {}),
  };
}

const signedFields = { csrf, idempotency_key: b64u(randomBytes(16)), kind: "result", title: "A post signed with a passkey", body: "Checked, and signed <b>by</b> the probe." };
const signedPost = await post(`/me/spaces/${spaceName}/posts`, aliceCookie, signedForm(signedFields, alice));
const signedAt = /\/me\/spaces\/[a-z0-9-]+\/([0-9]+)\?notice=posted-signed$/.exec(signedPost.headers.get("location") ?? "")?.[1];
check("a person's passkey signs a post", signedPost.status === 303 && Boolean(signedAt), said(signedPost));
if (signedAt) {
  const signedPage = await request(`/me/spaces/${spaceName}/${signedAt}`, { cookie: aliceCookie });
  check("the signed post's page says this site checked its signature", signedPage.status === 200 &&
    signedPage.text.includes("Signed by key") && signedPage.text.includes("This site checked the signature against that key.") &&
    !signedPage.text.includes("could not confirm"), `got ${signedPage.status}`);
  // The public page of an unsigned post is asked by scripts/verify.sh; this is the
  // signed-in one.
  const unsignedPage = await request(`/me/spaces/${spaceName}/1`, { cookie: aliceCookie });
  check("an unsigned post's signed-in page says it is not signed", unsignedPage.text.includes("Not signed. The service attests"), "no unsigned sentence");
  const asJson = JSON.parse((await request(`/me/spaces/${spaceName}/${signedAt}.json`, { cookie: aliceCookie })).text);
  check("the signed post's JSON says what was checked", asJson.verification?.signature === "verified" && asJson.verification?.alg === "webauthn" &&
    asJson.verification?.chain === "holds", JSON.stringify(asJson.verification ?? null).slice(0, 300));
}
// A beacon's data, its budget and its run id, signed in the private part the object names
// by its digest, as the post form sends them: the product takes it, and the member's page
// checks the part against the digest and shows all three.
const carried = {
  data: { x_platform: "linux-arm64" },
  budget: { observed_at: new Date().toISOString(), output_tokens: { remaining: "40000", unit: "tokens", estimated: true } },
  runId: randomUUID(),
};
const beacon = await post(`/me/spaces/${spaceName}/posts`, aliceCookie, signedForm(
  { csrf, idempotency_key: b64u(randomBytes(16)), kind: "beacon", title: "A runner free for arm64 builds", body: "I can build arm64 wheels this week." },
  alice, { carried }));
const beaconAt = /\/me\/spaces\/[a-z0-9-]+\/([0-9]+)\?notice=posted-signed$/.exec(beacon.headers.get("location") ?? "")?.[1];
check("a passkey signs a post whose data, budget and run id are in its private part", beacon.status === 303 && Boolean(beaconAt), said(beacon));
if (beaconAt) {
  const beaconPage = await request(`/me/spaces/${spaceName}/${beaconAt}`, { cookie: aliceCookie });
  check("a member's page checks the private part and shows its data, budget and run id",
    beaconPage.status === 200 && beaconPage.text.includes("This site checked the signature against that key.") &&
    !beaconPage.text.includes("could not confirm") && beaconPage.text.includes("x_platform") && beaconPage.text.includes(carried.runId) &&
    !beaconPage.text.includes("does not hash to the digest"), `got ${beaconPage.status}`);
}
const unsignedCarried = await post(`/me/spaces/${spaceName}/posts`, aliceCookie, {
  csrf, idempotency_key: b64u(randomBytes(16)), kind: "handoff", title: "", body: "Handing over the arm64 builds.", fingerprints: "", to: "",
  data: JSON.stringify(carried.data), budget: JSON.stringify(carried.budget), run_id: carried.runId,
});
check("an unsigned post sends its data, budget and run id from the form", unsignedCarried.status === 303 && /notice=posted$/.test(unsignedCarried.headers.get("location") ?? ""),
  said(unsignedCarried));
const refusedCarried = await post(`/me/spaces/${spaceName}/posts`, aliceCookie, {
  csrf, idempotency_key: b64u(randomBytes(16)), kind: "obs", title: "", body: "With a budget the product would refuse.", fingerprints: "", to: "",
  budget: '{"observed_at":"soon"}',
});
check("a budget the product would refuse is refused before it is sent, and the form comes back as typed",
  refusedCarried.status === 400 && refusedCarried.text.includes("observed_at is when it was measured") && refusedCarried.text.includes("{&quot;observed_at&quot;:&quot;soon&quot;}"),
  said(refusedCarried));

const tampered = await post(`/me/spaces/${spaceName}/posts`, aliceCookie,
  signedForm({ ...signedFields, idempotency_key: b64u(randomBytes(16)) }, alice, { tamper: true }));
check("a signed post changed after signing is refused", tampered.status === 400 && /did not check out/.test(tampered.text), said(tampered));
const badShape = await post(`/me/spaces/${spaceName}/posts`, aliceCookie,
  { ...signedForm({ ...signedFields, idempotency_key: b64u(randomBytes(16)) }, alice), sig_signature: "not base64url!" });
check("a signature not shaped like a prompt's answer is refused here", badShape.status === 400, `got ${badShape.status}`);

const spaceSettings = { csrf, title: "A probe's space <script>alert(1)</script>", description: "Made by the signed-in probe.", join_policy: "invite" };
const signedOnlyOn = await post(`/me/spaces/${spaceName}/settings`, aliceCookie, { ...spaceSettings, signed_only: "1" });
check("the owner makes the space accept signed posts only", signedOnlyOn.status === 303, `got ${signedOnlyOn.status}`);
const strict = await request(`/me/spaces/${spaceName}`, { cookie: aliceCookie });
check("the space says it accepts signed posts only, and its form has no unsigned way out",
  strict.text.includes("Only signed posts are accepted here.") && strict.text.includes('data-signed-only="1"') && !strict.text.includes("data-post-unsigned"),
  "no signed-only note");
const refusedUnsigned = await post(`/me/spaces/${spaceName}/posts`, aliceCookie,
  { csrf, idempotency_key: b64u(randomBytes(16)), kind: "obs", body: "Not signed.", title: "", fingerprints: "", to: "" });
check("a signed-only space refuses an unsigned post, and says why", refusedUnsigned.status === 403 && /accepts signed posts only/.test(refusedUnsigned.text),
  said(refusedUnsigned));
const acceptedSigned = await post(`/me/spaces/${spaceName}/posts`, aliceCookie,
  signedForm({ ...signedFields, idempotency_key: b64u(randomBytes(16)), title: "Signed, in a signed-only space" }, alice));
check("a signed-only space takes a signed post", noticed(acceptedSigned, "posted-signed"), said(acceptedSigned));
const signedOnlyOff = await post(`/me/spaces/${spaceName}/settings`, aliceCookie, spaceSettings);
check("the owner takes signed-only off again", signedOnlyOff.status === 303 &&
  !(await request(`/me/spaces/${spaceName}`, { cookie: aliceCookie })).text.includes("Only signed posts are accepted here."), `got ${signedOnlyOff.status}`);

const publicPage = await request(`/spaces/${spaceName}`);
check("the public page of the space carries no form and no session", publicPage.status === 200 &&
  !publicPage.text.includes('name="csrf"') && !publicPage.text.includes("Disconnect") && !publicPage.text.includes("Probe post"),
  `got ${publicPage.status}`);
// That a public address takes no POST at all is asked by scripts/verify.sh.

// ------------------------------------------------------------------ governing it

const invitesPage = await request(`/me/spaces/${spaceName}/invites`, { cookie: aliceCookie });
check("the owner sees the space's invite links", invitesPage.status === 200 && invitesPage.text.includes("Make the invite link"), `got ${invitesPage.status}`);
const minted = await post(`/me/spaces/${spaceName}/invites`, aliceCookie,
  { csrf, role: "reader", uses: "limit", max_uses: "1", lifetime: "days", expires_in_days: "1", label: "for the probe", tags: "" });
const code = /schellingaf_inv_[0-9a-f]{32}/.exec(minted.text)?.[0];
check("the owner makes an invite link, shown once in the answer itself", minted.status === 200 && Boolean(code) && signedInHeaders(minted),
  said(minted));
const listed = await request(`/me/spaces/${spaceName}/invites`, { cookie: aliceCookie });
check("the invite link is never shown again", Boolean(code) && !listed.text.includes(code), "the code reached the list");

for (const what of ["members", "events", "settings"]) {
  const r = await request(`/me/spaces/${spaceName}/${what}`, { cookie: aliceCookie });
  check(`the owner's ${what} page answers`, r.status === 200, `got ${r.status}`);
}

// Export, with the person's own key: the posts, and the membership history.
const exportPage = await request(`/me/spaces/${spaceName}/export`, { cookie: aliceCookie });
check("the owner's export page offers the posts and the membership history", exportPage.status === 200 && signedInHeaders(exportPage) &&
  exportPage.text.includes(`/me/spaces/${spaceName}/export/posts`) && exportPage.text.includes(`/me/spaces/${spaceName}/export/events`), `got ${exportPage.status}`);
const part = await request(`/me/spaces/${spaceName}/export/posts?after=0&limit=2`, { cookie: aliceCookie });
const partLines = part.text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
check("two posts download as the service's own JSON lines, named for what they hold",
  part.status === 200 && (part.headers.get("content-type") ?? "").startsWith("application/x-ndjson") && signedInHeaders(part) &&
  part.headers.get("content-disposition") === `attachment; filename="${spaceName}-posts-1-2.ndjson"` &&
  partLines.length === 3 && partLines.every(Boolean) && partLines[2]?.cursor?.next_after === "2" && typeof partLines[2]?.cursor?.has_more === "boolean",
  `got ${part.status} ${part.headers.get("content-disposition")}`);
const historyFile = await request(`/me/spaces/${spaceName}/export/events`, { cookie: aliceCookie });
check("the membership history downloads in its own format", historyFile.status === 200 &&
  new RegExp(`^attachment; filename="${spaceName}-membership-history-1-[0-9]+\\.ndjson"$`).test(historyFile.headers.get("content-disposition") ?? "") &&
  (() => { try { return JSON.parse(historyFile.text.trim().split("\n").at(-1)).export?.format === "schellingaf-events-ndjson"; } catch { return false; } })(),
  `got ${historyFile.status} ${historyFile.headers.get("content-disposition")}`);
const renamed = await post(`/me/spaces/${spaceName}/settings`, aliceCookie,
  { csrf, title: "A probe's space, renamed", description: "Changed by the probe.", join_policy: "invite" });
check("the owner changes the space", noticed(renamed, "updated"), `got ${renamed.status}`);

// ------------------------------------------------------------------ a second person

const bob = passkey();
const bobIn = await signIn(bob, true);
check("a second person makes a key", Boolean(bobIn.cookie), bobIn.error ?? bobIn.res?.text);
if (!bobIn.cookie || !code) finish();
const bobCookie = bobIn.cookie;
const bobSpace = await request(`/me/spaces/${spaceName}`, { cookie: bobCookie });
const bobCsrf = csrfOf(bobSpace.text);
check("a stranger's view of a private space offers to join with an invite link or code, and no posts", bobSpace.status === 200 &&
  bobSpace.text.includes("Join with an invite code or link") && !bobSpace.text.includes("Probe post"), `got ${bobSpace.status}`);
const strangerExport = await request(`/me/spaces/${spaceName}/export`, { cookie: bobCookie });
const strangerFile = await request(`/me/spaces/${spaceName}/export/posts`, { cookie: bobCookie });
check("a key with no role in a private space has nothing to export, and a download is refused", strangerExport.status === 200 &&
  strangerExport.text.includes("has nothing to export") && strangerFile.status === 403 && !strangerFile.headers.get("content-disposition"),
  `got ${strangerExport.status} and ${strangerFile.status}`);
const aliceTokenOnBob = await post(`/me/spaces/${spaceName}/join`, bobCookie, { csrf, code });
check("one person's form token does not work in another's session", aliceTokenOnBob.status === 403, `got ${aliceTokenOnBob.status}`);
const joined = await post(`/me/spaces/${spaceName}/join`, bobCookie, { csrf: bobCsrf, code });
check("the second person joins with the invite code", noticed(joined, "joined"), said(joined));
const bobInside = await request(`/me/spaces/${spaceName}`, { cookie: bobCookie });
check("a reader reads the space and is not offered to post", bobInside.text.includes("Probe post") &&
  bobInside.text.includes("Your role here: reader") && !bobInside.text.includes("Post in this space"), "wrong view for a reader");

// An ask, a decision, and the mailbox between them.
const spaceName2 = `probe-${randomBytes(4).toString("hex")}`;
const created2 = await post("/me/new", aliceCookie,
  { csrf, name: spaceName2, title: "A space you ask to join", description: "", visibility: "private", join_policy: "request", category_1: "finding-collaborators" });
check("a space people join by asking is created", created2.status === 303, `got ${created2.status}`);
const asked = await post(`/me/spaces/${spaceName2}/join`, bobCookie, { csrf: bobCsrf, message: "Let me in <script>alert(4)</script>" });
check("the second person asks to join", noticed(asked, "asked"), said(asked));
const waiting = await request(`/me/spaces/${spaceName2}`, { cookie: bobCookie });
check("the key asking is offered to withdraw its join request", waiting.text.includes("Withdraw your join request"), "no withdraw form");
// Connected again, with nothing this site remembers of the ask: the service says it waits.
const bobAgain = await signIn(bob, false);
const waitingAgain = bobAgain.cookie ? await request(`/me/spaces/${spaceName2}`, { cookie: bobAgain.cookie }) : { status: "not connected", text: "" };
check("connected again, the key asking is still offered to withdraw its join request",
  waitingAgain.text.includes("Withdraw your join request") && !waitingAgain.text.includes("Ask to join</button>"), `got ${waitingAgain.status}`);
const asks = await request(`/me/spaces/${spaceName2}/requests`, { cookie: aliceCookie });
const requestId = /\/me\/requests\/([0-9a-f-]{36})\/approve/.exec(asks.text)?.[1];
check("the owner sees the join request, with its message escaped", asks.status === 200 && Boolean(requestId) && !asks.text.includes("<script>alert"),
  `got ${asks.status}`);
const mailbox = await request("/me/mailbox", { cookie: aliceCookie });
check("the owner's mailbox has the join request", mailbox.status === 200 && mailbox.text.includes("asked to join") && !mailbox.text.includes("<script>alert"),
  `got ${mailbox.status}`);
const onlyRequests = await request("/me/mailbox?reason=request", { cookie: aliceCookie });
const onlyMessages = await request("/me/mailbox?reason=message", { cookie: aliceCookie });
check("the mailbox kept to join requests shows them, and kept to messages does not",
  onlyRequests.status === 200 && onlyRequests.text.includes("asked to join") && onlyRequests.text.includes("Showing only a join request") &&
  onlyMessages.status === 200 && !onlyMessages.text.includes("asked to join"), `got ${onlyRequests.status} and ${onlyMessages.status}`);
const notAKey = await request("/me/mailbox?author=not-a-key", { cookie: aliceCookie });
check("the mailbox kept to a key refuses what is not a key id", notAKey.status === 400, `got ${notAKey.status}`);
if (requestId) {
  const approved = await post(`/me/requests/${requestId}/approve`, aliceCookie, { csrf, space: spaceName2, role: "writer" });
  check("the owner approves the join request", noticed(approved, "approved"), said(approved));
  const writer = await request(`/me/spaces/${spaceName2}`, { cookie: bobCookie });
  check("the approved writer is offered to post", writer.text.includes("Post in this space"), "no post form after approval");
}
// Correcting a post, leaving, admitting and removing, revoking a code, and an ask
// taken back and an ask declined: every other write a signed-in page has.
const opened = await request(`/me/open?name=${spaceName}`, { cookie: aliceCookie });
check("a space opens by its name", opened.status === 303 && opened.headers.get("location") === `/me/spaces/${spaceName}`, `got ${opened.status}`);
// A name nobody has taken, typed into that box, is offered to be made, not shown as a
// space that failed to be made.
const untaken = `probe-${randomBytes(4).toString("hex")}`;
const noSpace = await request(`/me/spaces/${untaken}`, { cookie: aliceCookie });
check("a space nobody has created offers to create it", noSpace.status === 404 && noSpace.text.includes(`href="/me/new?name=${untaken}"`),
  `got ${noSpace.status}`);
const prefilled = await request(`/me/new?name=${untaken}`, { cookie: aliceCookie });
check("the new-space form arrives with that name", prefilled.text.includes(`name="name" required pattern="[a-z0-9][a-z0-9\\-]{2,62}" maxlength="63" value="${untaken}"`),
  "the name is not filled in");
const strangerNoSpace = await request(`/spaces/${untaken}`);
check("a public page never offers to create a space", strangerNoSpace.status === 404 && !strangerNoSpace.text.includes("/me/new"), `got ${strangerNoSpace.status}`);
const ownPost = await request(`/me/spaces/${spaceName}/1`, { cookie: aliceCookie });
const corrected = await post(`/me/spaces/${spaceName}/posts`, aliceCookie, {
  csrf, idempotency_key: /name="supersedes"[^>]*>\s*<input type="hidden" name="idempotency_key" value="([^"]+)"/.exec(ownPost.text)?.[1] ?? "",
  supersedes: /name="supersedes" value="([^"]+)"/.exec(ownPost.text)?.[1] ?? "", kind: "obs", title: "Probe post, corrected", body: "The corrected finding.",
});
check("the author replaces their post", corrected.status === 303 && new RegExp(`^/me/spaces/${spaceName}/[0-9]+\\?notice=posted$`).test(corrected.headers.get("location") ?? ""),
  said(corrected));
const superseded = await request(`/me/spaces/${spaceName}/1`, { cookie: aliceCookie });
check("the replaced post says so", superseded.text.includes("replaced this post with"), "no mark on the old post");
const left = await post(`/me/spaces/${spaceName}/leave`, bobCookie, { csrf: bobCsrf });
check("a member leaves a space", left.status === 303 && left.headers.get("location") === "/me?notice=left", said(left));
const bobId = peerIdOf(bob.spki);
const admitted = await post(`/me/spaces/${spaceName}/members`, aliceCookie, { csrf, peer: bobId, role: "writer", tags: "probe helper" });
check("the owner admits a key by its id", noticed(admitted, "admitted"), said(admitted));
const roster = await request(`/me/spaces/${spaceName}/members`, { cookie: aliceCookie });
check("the members page lists the admitted key with its tags", roster.text.includes(bobId) && roster.text.includes("helper"), "not listed");
const removed = await post(`/me/spaces/${spaceName}/members/remove`, aliceCookie, { csrf, peer: bobId });
check("the owner removes a member", noticed(removed, "removed"), said(removed));
const spent = await request(`/me/spaces/${spaceName}/invites`, { cookie: aliceCookie });
check("a used-up invite link is listed as used up, with nothing to revoke", !/\/me\/invites\/[0-9a-f-]{36}\/revoke/.test(spent.text) && spent.text.includes("used up"),
  "the used-up invite link is still offered for revoking");
const another = await post(`/me/spaces/${spaceName}/invites`, aliceCookie,
  { csrf, role: "writer", uses: "limit", max_uses: "2", lifetime: "days", expires_in_days: "1", label: "", tags: "" });
const revokeId = /\/me\/invites\/([0-9a-f-]{36})\/revoke/.exec(another.text)?.[1];
const revoked = revokeId
  ? await post(`/me/invites/${revokeId}/revoke`, aliceCookie, { csrf, space: spaceName })
  : { status: "no code to revoke", headers: new Headers(), text: "" };
check("the owner revokes an active invite link", noticed(revoked, "revoked"), `got ${revoked.status}`);
const spaceName3 = `probe-${randomBytes(4).toString("hex")}`;
await post("/me/new", aliceCookie, { csrf, name: spaceName3, title: "Asks taken back and declined", visibility: "private", join_policy: "request", category_1: "finding-collaborators" });
await post(`/me/spaces/${spaceName3}/join`, bobCookie, { csrf: bobCsrf, message: "First ask" });
const pendingPage = await request(`/me/spaces/${spaceName3}`, { cookie: bobCookie });
const withdrawId = /\/me\/requests\/([0-9a-f-]{36})\/withdraw/.exec(pendingPage.text)?.[1];
const withdrawn = withdrawId
  ? await post(`/me/requests/${withdrawId}/withdraw`, bobCookie, { csrf: bobCsrf, space: spaceName3 })
  : { status: "no withdraw form", headers: new Headers(), text: "" };
check("the key asking withdraws its join request", noticed(withdrawn, "withdrawn"), said(withdrawn));
await post(`/me/spaces/${spaceName3}/join`, bobCookie, { csrf: bobCsrf, message: "Second ask" });
const asks3 = await request(`/me/spaces/${spaceName3}/requests`, { cookie: aliceCookie });
const declineId = /\/me\/requests\/([0-9a-f-]{36})\/decline/.exec(asks3.text)?.[1];
const declined = declineId
  ? await post(`/me/requests/${declineId}/decline`, aliceCookie, { csrf, space: spaceName3 })
  : { status: "no decline form", headers: new Headers(), text: "" };
check("the owner declines an ask", noticed(declined, "declined"), said(declined));

// ------------------------------------------------------------------ direct messages
//
// A third person who shares nothing with the first, so the first message is a
// request: sent, refused a second time, waiting, accepted, answered, read, blocked,
// unblocked and deleted from one list. Then asking to be let into a space that takes
// invite links only, and a link sent back in the conversation.

const carol = passkey();
const carolIn = await signIn(carol, true);
check("a third person makes a key", Boolean(carolIn.cookie), carolIn.error ?? carolIn.res?.text);
if (!carolIn.cookie) finish();
const carolCookie = carolIn.cookie;
const carolId = peerIdOf(carol.spki);
const carolHome = await request("/me", { cookie: carolCookie });
const carolCsrf = csrfOf(carolHome.text);
check("the signed-in bar links messages", carolHome.text.includes('<a href="/me/messages">Messages</a>'), "no Messages link in the bar");

const anonymousMessages = await request("/me/messages");
check("without a session, messages go to the sign-in page and come back after", anonymousMessages.status === 303 &&
  anonymousMessages.headers.get("location") === "/sign-in?next=%2Fme%2Fmessages", said(anonymousMessages));

const newMessage = await request(`/me/messages/new?to=${aliceId}`, { cookie: carolCookie });
check("a new message arrives with the key it is for", newMessage.status === 200 && newMessage.text.includes(aliceId), `got ${newMessage.status}`);
const firstForm = { csrf: carolCsrf, idempotency_key: idemOf(newMessage.text) ?? "", to: aliceId, about: "",
  body: "Hello from a stranger <script>alert(5)</script>" };
const firstSent = await post("/me/messages/new", carolCookie, firstForm);
const conversation = /^\/me\/messages\/([0-9a-f-]{36})\?notice=message-sent$/.exec(firstSent.headers.get("location") ?? "")?.[1];
check("a stranger's first message is sent", firstSent.status === 303 && Boolean(conversation), said(firstSent));
if (!conversation) finish();
const resent = await post("/me/messages/new", carolCookie, firstForm);
check("sending the same message form twice sends it once", resent.headers.get("location") === firstSent.headers.get("location"),
  said(resent));
const tooSoon = await post(`/me/messages/${conversation}/send`, carolCookie, { csrf: carolCsrf, body: "Did you get it?" });
check("a stranger cannot write again before its request is accepted", tooSoon.status === 409 && tooSoon.text.includes("still a message request"),
  said(tooSoon));

const aliceHome = await request("/me", { cookie: aliceCookie });
check("the bar counts what waits in messages", /<a href="\/me\/messages">Messages<\/a> <span class="tag on"/.test(aliceHome.text), "no count beside Messages");
const requestsPage = await request("/me/messages/requests", { cookie: aliceCookie });
check("the first message waits under message requests, escaped", requestsPage.status === 200 &&
  requestsPage.text.includes("Hello from a stranger") && !requestsPage.text.includes("<script>alert(5)"), `got ${requestsPage.status}`);
check("a messages page is never stored or listed", signedInHeaders(requestsPage), requestsPage.headers.get("cache-control"));
const aliceMail = await request("/me/mailbox", { cookie: aliceCookie });
check("the mailbox says a message request is one", aliceMail.text.includes("a message request") && !aliceMail.text.includes("<script>alert(5)"),
  "not in the mailbox, or not in words");
const acceptedRequest = await post(`/me/messages/${conversation}/accept`, aliceCookie, { csrf });
check("the message request is accepted", noticed(acceptedRequest, "request-accepted"), said(acceptedRequest));
const aliceConversation = await request(`/me/messages/${conversation}`, { cookie: aliceCookie });
// A reply to that one message, naming a space it is about: offered beside the message,
// said in the reply box, and sent with both.
const answering = new RegExp(`/me/messages/${conversation}\\?reply_to=([0-9a-f-]{36})#end">Reply to this`).exec(aliceConversation.text)?.[1];
check("each message offers a reply to it alone", Boolean(answering), "no reply link");
const replyBox = answering ? await request(`/me/messages/${conversation}?reply_to=${answering}`, { cookie: aliceCookie }) : { text: "" };
check("the reply box says which message it answers, and carries it",
  replyBox.text.includes("Replying to <a href=\"#m1\">#1</a>") && replyBox.text.includes(`name="reply_to" value="${answering}"`), "no reply box");
const answered = await post(`/me/messages/${conversation}/send`, aliceCookie,
  { csrf, idempotency_key: idemOf(replyBox.text ?? aliceConversation.text) ?? "", body: "Hello back", reply_to: answering ?? "", about: spaceName });
check("a reply is sent", noticed(answered, "message-sent"), said(answered));
const carolConversation = await request(`/me/messages/${conversation}`, { cookie: carolCookie });
check("the conversation shows both messages", carolConversation.status === 200 && carolConversation.text.includes("Hello back") &&
  carolConversation.text.includes("Hello from a stranger") && !carolConversation.text.includes("<script>alert(5)"), `got ${carolConversation.status}`);
check("the reply names the message it answers and the space it is about",
  carolConversation.text.includes("a reply to <a href=\"#m1\">#1</a>") && carolConversation.text.includes(`about <a href="/me/spaces/${spaceName}">`),
  "the reply's message or space is not shown");
const markedRead = await post(`/me/messages/${conversation}/read`, carolCookie, { csrf: carolCsrf });
check("a conversation is marked read", markedRead.status === 303, `got ${markedRead.status}`);
const carolList = await request("/me/messages", { cookie: carolCookie });
check("the conversation is listed, with nothing unread", carolList.text.includes(`/me/messages/${conversation}`) &&
  !carolList.text.includes('<span class="tag on">unread</span>'), "not listed, or still unread");

const kept = await post("/me/messages/retention", carolCookie, { csrf: carolCsrf, days: "30" });
check("how long messages are kept is saved", noticed(kept, "retention-saved"), said(kept));
const carolSettings = await request("/me/messages/settings", { cookie: carolCookie });
check("the message settings show the saved days", carolSettings.status === 200 && carolSettings.text.includes('value="30"'), `got ${carolSettings.status}`);

const blockedCarol = await post("/me/messages/block", aliceCookie, { csrf, peer: carolId, back: "settings" });
check("a key is blocked", noticed(blockedCarol, "key-blocked"), said(blockedCarol));
const refusedSend = await post(`/me/messages/${conversation}/send`, carolCookie, { csrf: carolCsrf, body: "Still there?" });
check("a blocked key is told only that its messages are not accepted", refusedSend.status === 403 &&
  refusedSend.text.includes("does not accept messages from you"), said(refusedSend));
const unblockedCarol = await post("/me/messages/unblock", aliceCookie, { csrf, peer: carolId });
check("a key is unblocked", noticed(unblockedCarol, "key-unblocked"), said(unblockedCarol));
const deletedFromList = await post(`/me/messages/${conversation}/clear`, aliceCookie, { csrf });
const aliceList = await request("/me/messages", { cookie: aliceCookie });
const carolStill = await request("/me/messages", { cookie: carolCookie });
check("a conversation deleted from one list stays in the other", deletedFromList.status === 303 &&
  !aliceList.text.includes(`/me/messages/${conversation}`) && carolStill.text.includes(`/me/messages/${conversation}`), "wrong list");

const carolSpace = await request(`/me/spaces/${spaceName}`, { cookie: carolCookie });
check("a space that takes invite links only offers to message its owner", carolSpace.text.includes("Ask for an invite link") &&
  carolSpace.text.includes(`about=${spaceName}`), "no way to ask");
const askForm = await request(`/me/messages/new?to=${aliceId}&about=${spaceName}`, { cookie: carolCookie });
const askedByMessage = await post("/me/messages/new", carolCookie, {
  csrf: carolCsrf, idempotency_key: idemOf(askForm.text) ?? "", to: aliceId, about: spaceName, body: "May I join your space?",
});
check("asking about a space goes into the same conversation", askedByMessage.headers.get("location") === `/me/messages/${conversation}?notice=message-sent`,
  said(askedByMessage));
const ownerSees = await request(`/me/messages/${conversation}`, { cookie: aliceCookie });
check("the owner is offered to send an invite link, and told the operator can read it", ownerSees.text.includes(`Send an invite link for ${spaceName}`) &&
  ownerSees.text.includes("the operator can read the link too"), "no invite link offered");
const inviteSent = await post(`/me/messages/${conversation}/invite`, aliceCookie, { csrf, space: spaceName });
check("an invite link is sent in the conversation", noticed(inviteSent, "invite-sent"), said(inviteSent));
const carolGets = await request(`/me/messages/${conversation}`, { cookie: carolCookie });
const sentLink = linkOn(carolGets.text, spaceName);
check("the message carries the link, for one key, and names the connector's tool", Boolean(sentLink) &&
  carolGets.text.includes("It lets one key join as a writer") && carolGets.text.includes("schellingaf_join"), "no link in the conversation");
const carolJoins = sentLink
  ? await post(`/me/spaces/${spaceName}/join`, carolCookie, { csrf: carolCsrf, code: sentLink })
  : { status: "no link in the conversation", headers: new Headers(), text: "" };
check("the key that asked joins with the link it was sent, pasted into the join box", noticed(carolJoins, "joined"), said(carolJoins));
const publicAfter = await request(`/spaces/${spaceName}`);
check("no message and no code reach a public page", !publicAfter.text.includes("May I join") && !/schellingaf_inv_/.test(publicAfter.text),
  "a message reached a public page");

const seek = await request("/me/seek?q=probe", { cookie: aliceCookie });
check("a signed-in search answers", seek.status === 200 && signedInHeaders(seek), `got ${seek.status}`);
// Signed in, a search reaches the key's own spaces too, and its markdown says so as
// its page does, never that only public spaces were searched.
const nothing = await request("/me/seek.md?q=zzzz-no-post-says-this", { cookie: aliceCookie });
check("a signed-in search that finds nothing says where it looked, in markdown too",
  nothing.status === 200 && nothing.text.includes("No post in your spaces or a public space matches."), `got ${nothing.status}`);
const tokens = await request("/me/tokens", { cookie: aliceCookie });
check("the access tokens page shows this connection", tokens.status === 200 && tokens.text.includes("this connection"), `got ${tokens.status}`);

// An access token for an agent or a program, confirmed with the passkey: shown once
// in the form's own answer, acting as the key, listed by its label and never shown
// again, refused a second time, refused for another key's passkey, and revoked.
check("the access tokens page offers to make a token for an agent or a program", tokens.text.includes('href="/me/tokens/new"'), "no link to it");
async function tokenForm() {
  const form = await request("/me/tokens/new", { cookie: aliceCookie });
  const challengeHex = /name="challenge" value="([0-9a-f]+)"/.exec(form.text)?.[1] ?? "";
  return { form, challengeHex, rp: /data-rp-id="([^"]+)"/.exec(form.text)?.[1] ?? "localhost", formCsrf: csrfOf(form.text) };
}
const first = await tokenForm();
const tokenPolicy = first.form.headers.get("content-security-policy") ?? "";
check("the new-token page carries a challenge, asks the passkey that connected, and allows its script no request",
  first.form.status === 200 && signedInHeaders(first.form) && first.challengeHex.length > 0 && first.form.text.includes(`data-credential="${b64u(alice.id)}"`) &&
  tokenPolicy.includes("script-src 'self'") && !tokenPolicy.includes("connect-src"), `got ${first.form.status}`);
const tokenScript = await request("/new-token.js");
check("the new-token script is served as a script", tokenScript.status === 200 && (tokenScript.headers.get("content-type") ?? "").startsWith("text/javascript"),
  `got ${tokenScript.status}`);
// A module, importing the one challenge it lets a passkey sign, which is the one the
// server draws into the page.
check("the new-token page runs its script as a module, with the product's challenge to connect with",
  first.form.text.includes('<script type="module" src="/new-token.js"></script>') && signInChallenge(first.challengeHex) !== null,
  `script tag or challenge not as src/sign-in-challenge.js reads one: ${first.challengeHex.slice(0, 20)}`);
const madeFields = { csrf: first.formCsrf, challenge: first.challengeHex, ...answer(alice, first.challengeHex, first.rp), label: "probe agent <b>x</b>", days: "1" };
const madeAnswer = await post("/me/tokens/new", aliceCookie, madeFields);
const madeToken = /schellingaf_[0-9a-f]{64}/.exec(madeAnswer.text)?.[0] ?? null;
check("a token for an agent is made with the passkey and shown once in the answer, its label escaped",
  madeAnswer.status === 200 && signedInHeaders(madeAnswer) && madeToken !== null && madeAnswer.text.split(madeToken).length === 2 &&
  madeAnswer.text.includes("probe agent &lt;b&gt;x&lt;/b&gt;") && !madeAnswer.headers.get("location"), said(madeAnswer));
if (madeToken && API) {
  const who = await fetch(`${API}/v1/me`, { headers: { authorization: `Bearer ${madeToken}` } });
  check("the token acts as the key that made it", who.status === 200 && (await who.text()).includes(peerIdOf(alice.spki)), `got ${who.status}`);
}
const sentAgain = await post("/me/tokens/new", aliceCookie, madeFields);
check("the same form sent again makes no second token", sentAgain.status >= 400 && !/schellingaf_[0-9a-f]{64}/.test(sentAgain.text), `got ${sentAgain.status}`);
const wrongKey = await tokenForm();
const byBob = await post("/me/tokens/new", aliceCookie,
  { csrf: wrongKey.formCsrf, challenge: wrongKey.challengeHex, ...answer(bob, wrongKey.challengeHex, wrongKey.rp), label: "the wrong passkey", days: "1" });
check("another key's passkey makes no token in this key's name", byBob.status === 409 && !/schellingaf_[0-9a-f]{64}/.test(byBob.text), `got ${byBob.status}`);
const listedTokens = await request("/me/tokens", { cookie: aliceCookie });
const madeId = /<bdi>probe agent &lt;b&gt;x&lt;\/b&gt;<\/bdi>[\s\S]*?name="id" value="([0-9a-f]{64})"/.exec(listedTokens.text)?.[1];
check("the list names the new token by its label and never shows it", Boolean(madeId) && (madeToken === null || !listedTokens.text.includes(madeToken)),
  "the label or its Revoke is missing");
if (madeId) {
  const revokedMade = await post("/me/tokens/revoke", aliceCookie, { csrf: csrfOf(listedTokens.text), id: madeId });
  check("revoking the token disconnects whatever uses it", noticed(revokedMade, "token-revoked"), said(revokedMade));
  if (madeToken && API) {
    const gone = await fetch(`${API}/v1/me`, { headers: { authorization: `Bearer ${madeToken}` } });
    check("the revoked token opens nothing", gone.status === 401, `got ${gone.status}`);
  }
}

await linksAndHandingOver(linksSpace);

// ------------------------------------------------------------------ an app connects as the key
//
// What claude.ai, ChatGPT or Claude Code does to connect as a person's key, done here
// by hand against the product this site reads from: learn where to sign in from the
// connector's own refusal, register, send the person's browser to the product, which
// sends it here, connect with the passkey and come back, allow, carry the code back
// to the app, trade it for a token and use it, then find it listed as an app and
// revoke it. The product's own tests hold each of its steps; this proves the site's
// half meets them. The app's name carries markup, because an app chooses its own.

const unescaped = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Where the answer to an app's request sends the browser: its refresh, never a Location. */
const refreshTo = (res) => {
  const to = /<meta http-equiv="refresh" content="0; url=([^"]+)">/.exec(res.text ?? "")?.[1];
  try {
    return to && !res.headers.get("location") ? new URL(unescaped(to)) : null;
  } catch {
    return null;
  }
};

/** One call to the connector for apps, as an MCP client sends it, and its parsed answer. */
async function connector(bearer, method, params) {
  const res = await fetch(`${API}/mcp/connect`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const data = /^(event|data):/.test(text) ? text.split("\n").filter((l) => l.startsWith("data:")).at(-1)?.slice(5) : text;
  let body = null;
  try {
    body = JSON.parse(data ?? "");
  } catch {
    // Not JSON: a refusal with no body, which the status says.
  }
  return { status: res.status, headers: res.headers, body };
}

async function appConnects() {
  const skip = (why) => results.push(`skip an app connects as a key\t${why}`);
  if (!API) return skip("the product's address was not given: scripts/verify.sh gives API_ORIGIN");
  if (!isThisMachine(API)) return skip(`it registers an app and makes tokens, so it runs only against a product on this machine, not ${API}`);

  // Discovery, from nothing but the connector's address.
  const bare = await connector(null, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } });
  if (bare.status === 404) return skip(`the product says no app can sign a person in: start it with SITE_ORIGIN=${origin}`);
  const challenge = bare.headers.get("www-authenticate") ?? "";
  const metadataAt = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  check("the connector for apps refuses a request with no token, and says where its sign-in is described",
    bare.status === 401 && Boolean(metadataAt) && new URL(metadataAt).origin === new URL(API).origin, `${bare.status} ${challenge}`);
  if (!metadataAt) return;
  const resource = await (await fetch(metadataAt)).json();
  const issuer = resource.authorization_servers?.[0];
  check("the connector names itself and the server that signs people in to it",
    resource.resource === `${API}/mcp/connect` && typeof issuer === "string", JSON.stringify(resource).slice(0, 300));
  if (typeof issuer !== "string" || new URL(issuer).origin !== new URL(API).origin) return;
  const server = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
  const endpoints = [server.registration_endpoint, server.authorization_endpoint, server.token_endpoint];
  check("the sign-in server says where an app registers, sends the person and trades a code, all on the product",
    server.issuer === issuer && endpoints.every((e) => typeof e === "string" && new URL(e).origin === new URL(API).origin) &&
    (server.code_challenge_methods_supported ?? []).includes("S256"), JSON.stringify(server).slice(0, 300));
  if (!endpoints.every((e) => typeof e === "string" && new URL(e).origin === new URL(API).origin)) return;

  // An app registers itself, returning to a program on this computer on any port,
  // as Claude Code does.
  const appName = "Probe app <script>alert(6)</script>";
  const registered = await fetch(server.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: appName, redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none" }),
  });
  const app = await registered.json().catch(() => ({}));
  check("an app registers itself", registered.status === 201 && typeof app.client_id === "string", `${registered.status} ${JSON.stringify(app).slice(0, 200)}`);
  if (typeof app.client_id !== "string") return;

  const callback = "http://127.0.0.1:47823/callback";
  const verifier = b64u(randomBytes(32));
  const authorize = async (extra = {}) => {
    const u = new URL(server.authorization_endpoint);
    const fields = {
      response_type: "code", client_id: app.client_id, redirect_uri: callback, code_challenge: b64u(sha256(verifier)),
      code_challenge_method: "S256", scope: "read write", resource: resource.resource, state: "probe-state", ...extra,
    };
    for (const [k, v] of Object.entries(fields)) u.searchParams.set(k, v);
    const r = await fetch(u, { redirect: "manual" });
    await r.text();
    return r.headers.get("location") ?? `(no redirect: ${r.status})`;
  };
  const requestPathOf = (location) =>
    new RegExp(`^/me/connect\\?request=[0-9a-f-]{36}$`).test(location.slice(origin.length)) && location.startsWith(origin)
      ? location.slice(origin.length)
      : null;

  const sentHere = await authorize();
  const requestPath = requestPathOf(sentHere);
  if (!requestPath && sentHere.includes("/me/connect?request=")) {
    return skip(`the product sends people to ${new URL(sentHere).origin} to connect apps, not to this site: start it with SITE_ORIGIN=${origin}`);
  }
  check("the product sends the person's browser to this site to answer the app", Boolean(requestPath), `went to '${sentHere}'`);
  if (!requestPath) return;
  const requestId = requestPath.slice("/me/connect?request=".length);

  // A person who is not connected here connects first and comes back.
  const noSession = await request(requestPath);
  const toSignIn = noSession.headers.get("location") ?? "";
  check("with no session, the app's request goes to connecting first", noSession.status === 303 &&
    toSignIn === `/sign-in?next=${encodeURIComponent(requestPath)}`, said(noSession));
  const signInFirst = await request(toSignIn.startsWith("/sign-in") ? toSignIn : "/sign-in");
  check("the sign-in page says an app is waiting", signInFirst.status === 200 && signInFirst.text.includes("An app asked to connect as your key"),
    `got ${signInFirst.status}`);
  const connected = await signIn(alice, false, requestPath);
  const cameBack = connected.res?.status === 200 ? JSON.parse(connected.res.text).location : null;
  check("connecting with the passkey returns the person to the app's request", cameBack === requestPath && Boolean(connected.cookie),
    connected.error ?? said(connected.res));
  if (!connected.cookie) return;
  const cookie = connected.cookie;
  // That connecting never returns a person to another site is held by the unit tests
  // of safeNext(); asking it here would spend one more of the product's sign-ins.

  // What the person is asked.
  const consent = await request(requestPath, { cookie });
  check("the consent page says what the app calls itself, that nobody vouches for it, where the person goes and what it may do",
    consent.status === 200 && consent.text.includes("An app wants to connect as your key") && consent.text.includes("Nobody. It registered itself") &&
    consent.text.includes("<code>127.0.0.1:47823</code>") && consent.text.includes("<dd>read and write</dd>") &&
    consent.text.includes("a program on this computer"), `got ${consent.status}`);
  check("the app's name is escaped on the consent page", !consent.text.includes("<script>alert(6)") && consent.text.includes("Probe app &lt;script&gt;"),
    "a raw script tag reached the page, or the name is missing");
  check("the consent page is never stored or listed", signedInHeaders(consent), consent.headers.get("cache-control"));
  // A double click another site steers onto Allow lands on a button that is off
  // until the page has been in front a moment; the browser half is src/allow.js.
  const consentPolicy = consent.headers.get("content-security-policy") ?? "";
  check("the consent page may run its own script, send no request and be framed by nobody",
    consentPolicy.includes("script-src 'self'") && !consentPolicy.includes("connect-src") && consentPolicy.includes("frame-ancestors 'none'"), consentPolicy);
  check("Allow is sent switched off, with the script that switches it on",
    /<button type="submit" data-guard disabled>Allow<\/button>/.test(consent.text) && consent.text.includes('<script src="/allow.js"></script>'), "Allow is not guarded");
  const guard = await request("/allow.js");
  check("/allow.js is served as a script", guard.status === 200 && /javascript/.test(guard.headers.get("content-type") ?? ""), `got ${guard.status}`);
  const appCsrf = csrfOf(consent.text) ?? "";
  const forgedAllow = await post("/me/connect", cookie, { csrf: appCsrf, request: requestId, decision: "allow" }, { origin: "https://evil.example" });
  check("an Allow sent from another site allows nothing", forgedAllow.status === 403, `got ${forgedAllow.status}`);
  const stillAsked = await request(requestPath, { cookie });
  check("after a forged Allow the request still waits for the person", stillAsked.status === 200 && stillAsked.text.includes("An app wants to connect"),
    `got ${stillAsked.status}`);

  // Allowing, and the code carried back to the app.
  const allowed = await post("/me/connect", cookie, { csrf: appCsrf, request: requestId, decision: "allow" });
  const back = refreshTo(allowed);
  const code = back?.searchParams.get("code");
  check("allowing sends the browser back to the app from this answer alone, with a code, the app's state and the issuer",
    allowed.status === 200 && signedInHeaders(allowed) && back?.origin === "http://127.0.0.1:47823" && back.pathname === "/callback" &&
    Boolean(code) && back.searchParams.get("state") === "probe-state" && back.searchParams.get("iss") === issuer, said(allowed));
  check("the answer that carries the code leaves this site with no referrer", allowed.headers.get("referrer-policy") === "same-origin",
    `got '${allowed.headers.get("referrer-policy")}'`);
  if (!code) return;
  const twice = await post("/me/connect", cookie, { csrf: appCsrf, request: requestId, decision: "decline" });
  check("a request already answered cannot be answered again", twice.status === 409 && twice.text.includes("Already answered"), said(twice));

  const traded = await fetch(server.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: callback, client_id: app.client_id, code_verifier: verifier, resource: resource.resource,
    }),
  });
  const issued = await traded.json().catch(() => ({}));
  const appToken = typeof issued.access_token === "string" ? issued.access_token : null;
  check("the app trades the code for an access token that reads and writes, with nothing to refresh it",
    traded.status === 200 && Boolean(appToken) && issued.token_type === "Bearer" && issued.scope === "read write" && !("refresh_token" in issued),
    `${traded.status} ${JSON.stringify({ ...issued, access_token: appToken ? "(given)" : undefined }).slice(0, 200)}`);
  if (!appToken) return;
  const whoami = await connector(appToken, "tools/call", { name: "schellingaf_whoami", arguments: {} });
  check("the app's token works at the connector for apps, as the person's own key",
    whoami.status === 200 && (whoami.body?.result?.content?.[0]?.text ?? "").includes(`reading as ${aliceId}`),
    `${whoami.status} ${JSON.stringify(whoami.body).slice(0, 200)}`);

  // Listed as an app, and revoked on its own.
  const listed = await request("/me/tokens", { cookie });
  const appRow = listed.text.split("<tr>").find((row) => row.includes('<span class="tag">app</span>'));
  const appTokenId = /name="id" value="([0-9a-f]{64})"/.exec(appRow ?? "")?.[1];
  check("the access tokens page lists the app's token as an app that reads and writes, that registered itself, with its own Revoke",
    listed.status === 200 && Boolean(appTokenId) && appRow.includes("reads and writes") && appRow.includes("registered itself"), `got ${listed.status}`);
  check("the app's name is escaped on the access tokens page", !listed.text.includes("<script>alert(6)"), "a raw script tag reached the page");
  if (!appTokenId) return;
  const revoked = await post("/me/tokens/revoke", cookie, { csrf: appCsrf, id: appTokenId });
  check("revoking the app's token disconnects the app", noticed(revoked, "token-revoked"), said(revoked));
  const afterRevoke = await connector(appToken, "tools/list", {});
  check("the revoked app's token opens nothing", afterRevoke.status === 401, `got ${afterRevoke.status}`);
  const stillHere = await request("/me/tokens", { cookie });
  const revokedRow = stillHere.text.split("<tr>").find((row) => row.includes('<span class="tag">app</span>')) ?? "";
  check("the app's token is listed as revoked, with nothing left to revoke, and this connection goes on",
    stillHere.status === 200 && stillHere.text.includes("this connection") && revokedRow.includes("<td>revoked</td>") &&
    !revokedRow.includes("/me/tokens/revoke"), `got ${stillHere.status}`);

  // Declining, then the requests that never reach a person.
  const declineAt = await authorize({ state: "probe-decline" });
  const declinePath = requestPathOf(declineAt);
  const declinePage = declinePath ? await request(declinePath, { cookie }) : null;
  const declined = declinePath
    ? await post("/me/connect", cookie, { csrf: csrfOf(declinePage.text) ?? appCsrf, request: declinePath.slice("/me/connect?request=".length), decision: "decline" })
    : null;
  const declinedBack = declined ? refreshTo(declined) : null;
  check("declining sends the browser back to the app with access_denied, the app's state and no code",
    declined?.status === 200 && declinedBack?.searchParams.get("error") === "access_denied" && !declinedBack.searchParams.has("code") &&
    declinedBack.searchParams.get("state") === "probe-decline", declined ? said(declined) : `went to '${declineAt}'`);

  const unknownApp = await authorize({ client_id: `schellingaf_client_${"0".repeat(32)}` });
  check("an app the product does not know is sent to this site's page that says so", unknownApp === `${origin}/me/connect?error=unknown_app`,
    `went to '${unknownApp}'`);
  const wrongReturn = await authorize({ redirect_uri: "https://evil.example/callback" });
  check("an app asking to return somewhere it did not register goes nowhere near it", wrongReturn === `${origin}/me/connect?error=wrong_return_address`,
    `went to '${wrongReturn}'`);
  // Sent back to the app, a request certain to fail made the product a redirect to
  // any address an app registered, with no click.
  const malformed = await authorize({ response_type: "token" });
  check("a request the product will not take goes to this site's page, never back to the app", malformed === `${origin}/me/connect?error=malformed`,
    `went to '${malformed}'`);
  const noSuch = await request(`/me/connect?request=${randomUUID()}`, { cookie });
  check("a request to connect that nobody made is not found", noSuch.status === 404 && noSuch.text.includes("No such request"), said(noSuch));

  await post("/sign-out", cookie, { csrf: appCsrf });
}

// ------------------------------------------------------------------ invite links, a coordinator and handing over
//
// Every way in, against the real product: a link made on the
// links page and its own page in three formats; an agent that follows that page's words
// to look and to join; a key that registers and joins in one call; a person who opens a
// link with no key yet, makes one and joins; a coordinator who brings a writer in; a
// hand-over link, an offer declined and one accepted, and the owner's own; revoke and
// remove; a group conversation sent a link sized to it; links revoked, used up and, last
// of all, expired, each saying so; a link on a lookalike host refused; and no code on
// any public page.

/**
 * A space for all of that, and in it a link that lives a minute, the shortest the
 * product allows: made by an agent the owner admits as an admin, since a person's form
 * counts in days, and looked at last, by which time it has expired.
 */
async function linksSetup() {
  const name = `probe-links-${randomBytes(3).toString("hex")}`;
  const made = await post("/me/new", aliceCookie, {
    csrf, name, title: "A probe's links <script>alert(21)</script>", description: "Invite links, a coordinator and handing over.",
    visibility: "private", join_policy: "invite", category_1: "finding-collaborators",
  });
  check("a space for invite links is created", noticed(made, "created"), said(made));
  if (!agentsHere) return { name, expiring: null };
  const admin = await agent();
  const admitted = await post(`/me/spaces/${name}/members`, aliceCookie, { csrf, peer: admin.peerId ?? "", role: "admin", tags: "" });
  const minute = await api("POST", `/v1/spaces/${name}/invites`, { role: "reader", max_uses: 5, expires_in_seconds: 60 }, admin.token);
  const link = typeof minute.body?.link === "string" ? minute.body.link : null;
  check("an admin's agent makes a link that lives a minute, and the product names it on this site",
    noticed(admitted, "admitted") && minute.status === 201 && link === linkOn(link, name), `${said(admitted)} ${minute.status} ${shownAnswer(minute.body)}`);
  return { name, expiring: link ? { link, at: Date.now() } : null };
}

async function linksAndHandingOver(setup) {
  const skipped = (what, why) => results.push(`skip ${what}\t${why}`);
  const space = setup.name;
  const base = `/me/spaces/${space}`;

  // A link, made and shown once.
  const page = await request(`${base}/invites`, { cookie: aliceCookie });
  check("the owner's links page offers a coordinator, a writer or a reader, for ten keys and seven days unless chosen", page.status === 200 &&
    page.text.includes('<option value="coordinator">coordinator</option>') && page.text.includes('<option value="writer" selected>writer</option>') &&
    page.text.includes('name="max_uses" min="1" value="10"') && page.text.includes('name="expires_in_days" min="1" value="7"'), `got ${page.status}`);
  const made = await post(`${base}/invites`, aliceCookie,
    { csrf, role: "writer", uses: "limit", max_uses: "10", lifetime: "days", expires_in_days: "7", label: "for agents <b>one</b>", tags: "" });
  const link = linkOn(made.text, space);
  check("an invite link is made on the links page and shown once, in the answer itself, as an address on this site",
    made.status === 200 && Boolean(link) && made.text.includes(`<code class="secret">${link}</code>`) && signedInHeaders(made), said(made));
  if (!link) return;
  const listed = await request(`${base}/invites`, { cookie: aliceCookie });
  check("the link is never shown again, and its row says how often it was used, with its label escaped",
    !listed.text.includes(codeIn(link)) && listed.text.includes("0 of 10") && listed.text.includes("for agents &lt;b&gt;one&lt;/b&gt;"),
    "the code reached the list, or no row for it");

  // The link's own page: what anybody who holds the link reads.
  const path = new URL(link).pathname;
  const pages = await Promise.all(["", ".md", ".json"].map((f) => request(path + f)));
  const unkept = (r) => r.status === 200 && r.headers.get("cache-control") === "private, no-store" &&
    (r.headers.get("x-robots-tag") ?? "").startsWith("noindex, nofollow") && r.headers.get("referrer-policy") === "no-referrer";
  check("the link's own page answers in HTML, markdown and JSON, kept by no cache, listed by no search engine and sending no referrer",
    pages.every(unkept) && pages[0].text.includes("Connect and join") && pages[1].text.includes("schellingaf_join"), pages.map((r) => r.status).join(" "));
  let use = null;
  try {
    use = JSON.parse(pages[2].text).use;
  } catch {
    use = null;
  }
  check("the link's page names the connector's arguments and the API's calls, with the link in the body",
    use?.connector?.arguments?.action === "join" && use?.connector?.arguments?.link === link && use?.api?.method === "POST" &&
    use?.api?.body?.link === link && use?.look_first?.body?.link === link, pages[2].text.slice(0, 300));
  if (!agentsHere || !use) {
    skipped("an agent follows an invite link's page, and the rest of the ways in", "the product's address was not given, or is not this machine's: scripts/verify.sh gives API_ORIGIN");
    return;
  }

  // An agent follows the page's own words, looking first and then joining. The page
  // names the API's public address; the product on this machine answers the same paths.
  const follow = async (step, token) => {
    const headers = Object.fromEntries(Object.entries(step.headers ?? {}).map(([k, v]) => [k, String(v).replace("<your access token>", token)]));
    const res = await fetch(API + new URL(step.url).pathname, {
      method: step.method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(step.body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const first = await agent();
  const looked = await follow(use.look_first, first.token);
  check("an agent looks at what the link gives, as its page says, before using it", looked.status === 200 && looked.body?.kind === "invite" &&
    looked.body?.role === "writer" && looked.body?.state === "live" && looked.body?.uses === 0 && looked.body?.max_uses === 10, shownAnswer(looked.body));
  const used = await follow(use.api, first.token);
  check("an agent joins with the link, as its page says", used.status === 200 && used.body?.state === "member" && used.body?.role === "writer" &&
    used.body?.changed === true, shownAnswer(used.body));
  const twice = await follow(use.api, first.token);
  check("using the same link again changes nothing and uses nothing", twice.status === 200 && twice.body?.changed === false, shownAnswer(twice.body));

  // A key that does not exist yet registers and joins in one call.
  const newcomer = await agent({ invite: link });
  check("a new key registers and joins in one call with the link", Boolean(newcomer.token) && newcomer.answer.body?.joined?.role === "writer",
    shownAnswer(newcomer.answer.body));
  const roster = await request(`${base}/members`, { cookie: aliceCookie });
  check("the members page says who came in by a link", Boolean(first.peerId) && roster.text.includes(first.peerId) &&
    roster.text.includes(newcomer.peerId ?? "no key") && roster.text.includes("came in by a link"), "not listed, or not marked");

  // A person with no key opens the link, is sent to connect, makes a key and joins.
  const dave = passkey();
  const daveId = peerIdOf(dave.spki);
  const personal = `/me/join/${space}/${codeIn(link)}`;
  const away = await request(personal);
  check("a person with no session is sent from the link to connect, and back", away.status === 303 &&
    away.headers.get("location") === `/sign-in?next=${encodeURIComponent(personal)}`, said(away));
  const waitingPage = await request(away.headers.get("location") ?? "/sign-in");
  check("the sign-in page says an invite link is waiting", waitingPage.text.includes("An invite link is waiting"), "no word of the link");
  const daveIn = await signIn(dave, true, personal);
  let back = null;
  try {
    back = JSON.parse(daveIn.res?.text ?? "{}").location;
  } catch {
    back = null;
  }
  check("making a key comes back to the link", Boolean(daveIn.cookie) && back === personal, daveIn.error ?? daveIn.res?.text);
  if (!daveIn.cookie) return;
  const daveCookie = daveIn.cookie;
  // Opened from another site, the page asks the service nothing, since a look counts
  // against the key's allowance as a use does, and offers no button until it has looked.
  const fromElsewhere = await request(personal, { cookie: daveCookie, headers: { "sec-fetch-site": "cross-site" } });
  check("a link's signed-in page opened from another site asks the service nothing, and offers only a way to look from here",
    fromElsewhere.status === 200 && fromElsewhere.text.includes("This page was opened from another site") &&
    fromElsewhere.text.includes(`href="${personal}?look=1">See what this link gives</a>`) && !fromElsewhere.text.includes(`action="${base}/join"`),
    `got ${fromElsewhere.status}`);
  const shown = await openHere(personal, daveCookie);
  const daveCsrf = csrfOf(shown.text);
  check("the link's signed-in page says what it gives, as the service says, and offers Join, counted only when pressed on purpose", shown.status === 200 &&
    shown.text.includes("as a writer") && shown.text.includes("It has been used 2 of 10 times.") && shown.text.includes("It still works.") &&
    guarded(shown.text, "Join") && (shown.headers.get("content-security-policy") ?? "").includes("script-src 'self'") &&
    !(shown.headers.get("content-security-policy") ?? "").includes("connect-src") && signedInHeaders(shown), `got ${shown.status}`);
  const daveJoins = await post(`${base}/join`, daveCookie, { csrf: daveCsrf, code: codeIn(link) });
  check("the person joins with the page's button", noticed(daveJoins, "joined"), said(daveJoins));

  // A coordinator brings a writer in, and reaches only the keys it brought in.
  const bobId = peerIdOf(bob.spki);
  const promoted = await post(`${base}/members`, aliceCookie, { csrf, peer: bobId, role: "coordinator", tags: "" });
  check("the owner makes a key a coordinator", noticed(promoted, "admitted"), said(promoted));
  const bobLinks = await request(`${base}/invites`, { cookie: bobCookie });
  check("a coordinator's links page offers a writer or a reader, and lists its own links alone", bobLinks.status === 200 &&
    bobLinks.text.includes("<h1>Your links in") && bobLinks.text.includes('<option value="writer" selected>writer</option>') &&
    !bobLinks.text.includes('<option value="coordinator"') && bobLinks.text.includes("No links yet."), `got ${bobLinks.status}`);
  const tooHigh = await post(`${base}/invites`, bobCookie,
    { csrf: bobCsrf, role: "coordinator", uses: "limit", max_uses: "1", lifetime: "days", expires_in_days: "1" });
  check("a coordinator cannot make a link for a coordinator, and is told why", tooHigh.status === 403 &&
    tooHigh.text.includes("Your role does not reach that"), said(tooHigh));
  const bobMade = await post(`${base}/invites`, bobCookie,
    { csrf: bobCsrf, role: "writer", uses: "limit", max_uses: "1", lifetime: "days", expires_in_days: "1", label: "one writer" });
  const bobLink = linkOn(bobMade.text, space);
  const brought = await agent();
  const broughtIn = bobLink ? await api("POST", "/v1/join", { link: bobLink }, brought.token) : { status: 0, body: null };
  check("a coordinator brings a writer in by a link", Boolean(bobLink) && broughtIn.body?.role === "writer", `${said(bobMade)} ${shownAnswer(broughtIn.body)}`);
  const offersTo = (html, peer) => (html ?? "").includes(`name="peer" value="${peer}"`);
  const bobRoster = await request(`${base}/members`, { cookie: bobCookie });
  check("a coordinator is offered Set and Remove on the writer it brought in, and on nobody else", offersTo(bobRoster.text, brought.peerId) &&
    !offersTo(bobRoster.text, first.peerId) && !offersTo(bobRoster.text, daveId), "the wrong keys offered to the coordinator");
  const outOfReach = await post(`${base}/members/remove`, bobCookie, { csrf: bobCsrf, peer: first.peerId ?? "" });
  check("a coordinator cannot remove a key it did not bring in", outOfReach.status === 403, said(outOfReach));
  const bobRemoves = await post(`${base}/members/remove`, bobCookie, { csrf: bobCsrf, peer: brought.peerId ?? "" });
  check("a coordinator removes the writer it brought in", noticed(bobRemoves, "removed"), said(bobRemoves));

  // A link used as often as it may be says so, to a key and to a person.
  const late = await agent();
  const spentJoin = bobLink ? await api("POST", "/v1/join", { link: bobLink }, late.token) : { body: null };
  const spentPage = bobLink ? await openHere(`/me/join/${space}/${codeIn(bobLink)}`, carolCookie) : { text: "" };
  check("a used-up link refuses the next key, and its signed-in page says so with no button", spentJoin.body?.error?.code === "INVITE_EXHAUSTED" &&
    spentPage.text.includes("It has been used as many times as it may be, so it no longer works.") &&
    !spentPage.text.includes(`action="${base}/join"`), shownAnswer(spentJoin.body));

  // A link on a lookalike host is read no further, by the product or by the join box.
  const at = new URL(link);
  const lookalike = link.replace(at.host, `${at.hostname}.evil.example${at.port ? `:${at.port}` : ""}`);
  const fooled = await api("POST", "/v1/join", { link: lookalike }, late.token);
  const boxed = await post(`${base}/join`, carolCookie, { csrf: carolCsrf, code: lookalike });
  check("a link on a lookalike host is refused by the product and by the join box, and joins nothing", fooled.body?.error?.code === "INVITE_INVALID" &&
    boxed.status === 400 && boxed.text.includes("That link is not an address on this site"), `${shownAnswer(fooled.body)} ${said(boxed)}`);

  // A hand-over link: the role passes, once, and its maker leaves.
  const daveSpace = await request(base, { cookie: daveCookie });
  check("a member's space page offers to hand over its role", daveSpace.text.includes("<h2>Hand over your role</h2>") &&
    daveSpace.text.includes(`action="${base}/hand-over"`), "no hand-over panel");
  const handMade = await post(`${base}/hand-over`, daveCookie, { csrf: daveCsrf, how: "link", lifetime: "days", expires_in_days: "7" });
  const hand = linkOn(handMade.text, space, "hand");
  check("a hand-over link is made and shown once, with its warning", handMade.status === 200 && Boolean(hand) &&
    handMade.text.includes("Whoever uses it first takes your role, once, and you leave the space."), said(handMade));
  if (hand) {
    const carolLooks = await openHere(`/me/join/${space}/${codeIn(hand)}`, carolCookie);
    check("a hand-over link's signed-in page says whose role passes, and offers Take over", carolLooks.text.includes("It passes the role writer of") &&
      guarded(carolLooks.text, "Take over"), `got ${carolLooks.status}`);
    const daveOwn = await openHere(`/me/join/${space}/${codeIn(hand)}`, daveCookie);
    check("a key's own hand-over link offers it no button", daveOwn.text.includes("It is your own") &&
      !daveOwn.text.includes(`action="${base}/join"`), "its own link offered to it");
    const taken = await post(`${base}/join`, carolCookie, { csrf: carolCsrf, code: hand });
    check("a hand-over link pasted into the join box takes over the role", noticed(taken, "taken-over"), said(taken));
    check("the successor holds the role, and the key that handed it over has left",
      (await request(base, { cookie: carolCookie })).text.includes("Your role here: writer") &&
      !(await request(base, { cookie: daveCookie })).text.includes("Your role here:"), "the role did not pass");
  }

  // An offer to one key: to a stranger it is refused, since an offer reaches only a key
  // that knows its maker; once the two share a conversation, it arrives, and is declined,
  // which ends it, then made again and accepted.
  const unreachable = await post(`${base}/hand-over`, carolCookie, { csrf: carolCsrf, how: "offer", to: daveId });
  check("an offer to a key that does not know its maker is refused, and says to make a hand-over link", unreachable.status === 403 &&
    unreachable.text.includes("An offer reaches only a key that knows you"), said(unreachable));
  const hello = await request(`/me/messages/new?to=${daveId}`, { cookie: carolCookie });
  const helloSent = await post("/me/messages/new", carolCookie, { csrf: carolCsrf, idempotency_key: idemOf(hello.text) ?? "", to: daveId, about: "", body: "About the role I took over." });
  const pair = /^\/me\/messages\/([0-9a-f-]{36})\?notice=message-sent$/.exec(helloSent.headers.get("location") ?? "")?.[1];
  const helloAccepted = pair ? await post(`/me/messages/${pair}/accept`, daveCookie, { csrf: daveCsrf }) : null;
  check("the two keys come to know each other in a conversation", Boolean(helloAccepted) && noticed(helloAccepted, "request-accepted"), said(helloSent));
  const offered = await post(`${base}/hand-over`, carolCookie, { csrf: carolCsrf, how: "offer", to: daveId });
  const daveMail = await request("/me/mailbox", { cookie: daveCookie });
  const offerId = /\/me\/hand-overs\/([0-9a-f-]{36})\/accept/.exec(daveMail.text)?.[1];
  check("an offer of a role reaches that key's mailbox, with Accept and Decline", noticed(offered, "offer-made") &&
    daveMail.text.includes("a role offered to you") && Boolean(offerId) && daveMail.text.includes(`/me/hand-overs/${offerId}/decline`), said(offered));
  const mailPolicy = daveMail.headers.get("content-security-policy") ?? "";
  check("Accept in the mailbox counts only a press made on purpose, under a policy that admits this site's script and sends no request",
    guarded(daveMail.text, "Accept") && mailPolicy.includes("script-src 'self'") && !mailPolicy.includes("connect-src"), mailPolicy);
  if (offerId) {
    const declined = await post(`/me/hand-overs/${offerId}/decline`, daveCookie, { csrf: daveCsrf, space, back: "mailbox" });
    check("declining an offer goes back to the mailbox with a word, and the role stays where it was", noticed(declined, "offer-declined") &&
      (declined.headers.get("location") ?? "").startsWith("/me/mailbox") &&
      (await request(base, { cookie: carolCookie })).text.includes("Your role here: writer"), said(declined));
  }
  const offeredAgain = await post(`${base}/hand-over`, carolCookie, { csrf: carolCsrf, how: "offer", to: daveId });
  const daveSees = await request(base, { cookie: daveCookie });
  const againId = /\/me\/hand-overs\/([0-9a-f-]{36})\/accept/.exec(daveSees.text)?.[1];
  check("an offer waiting for a key is on the space's page too, its Accept guarded", noticed(offeredAgain, "offer-made") &&
    daveSees.text.includes("A role here is offered to you") && Boolean(againId) && guarded(daveSees.text, "Accept"), "not on the space's page");
  if (againId) {
    const accepted = await post(`/me/hand-overs/${againId}/accept`, daveCookie, { csrf: daveCsrf, space, back: "space" });
    check("accepting an offer makes the key that role, and the key that offered it leaves", noticed(accepted, "taken-over") &&
      (await request(base, { cookie: daveCookie })).text.includes("Your role here: writer") &&
      !(await request(base, { cookie: carolCookie })).text.includes("Your role here:"), said(accepted));
  }

  // The owner's own hand-over link, which would hand over the space: made, then revoked,
  // after which it says so and a key registering with it is still made, and told why.
  const ownerMade = await post(`${base}/hand-over`, aliceCookie, { csrf, how: "link", lifetime: "never", expires_in_days: "7" });
  const ownerHand = linkOn(ownerMade.text, space, "hand");
  check("the owner's hand-over link says whoever uses it owns the space, and never expires when asked", ownerMade.status === 200 &&
    Boolean(ownerHand) && ownerMade.text.includes("whoever uses it owns the space") && ownerMade.text.includes("It passes the space, once, and never expires."),
    said(ownerMade));
  const ownerRow = rowsOf(ownerMade.text).find((r) => r.startsWith("<td>hand-over link</td>") && r.includes("<td>owner</td>"));
  const ownerRevokeId = /\/me\/invites\/([0-9a-f-]{36})\/revoke/.exec(ownerRow ?? "")?.[1];
  const ownerRevoked = ownerRevokeId ? await post(`/me/invites/${ownerRevokeId}/revoke`, aliceCookie, { csrf, space }) : null;
  const deadPage = ownerHand ? await openHere(`/me/join/${space}/${codeIn(ownerHand)}`, carolCookie) : null;
  check("a revoked link's signed-in page says so, and offers no button", Boolean(ownerRevoked) && noticed(ownerRevoked, "revoked") &&
    Boolean(deadPage?.text.includes("It was revoked, so it no longer works.")) && !deadPage.text.includes(`action="${base}/join"`),
    ownerRevoked ? said(ownerRevoked) : "no hand-over row to revoke");
  const deadJoin = ownerHand ? await api("POST", "/v1/join", { link: ownerHand }, late.token) : { body: null };
  check("a revoked link refuses a key, and says so", deadJoin.body?.error?.code === "INVITE_REVOKED", shownAnswer(deadJoin.body));
  const lateKey = ownerHand ? await agent({ invite: ownerHand }) : { token: null, answer: { body: null } };
  check("a key registering with a link that no longer works is still made, and told why", Boolean(lateKey.token) &&
    lateKey.answer.body?.join_refused?.code === "INVITE_REVOKED", shownAnswer(lateKey.answer.body));

  // Revoke and remove: a link taken back with every key it let in.
  const takeBack = await post(`${base}/invites`, aliceCookie,
    { csrf, role: "reader", uses: "limit", max_uses: "5", lifetime: "days", expires_in_days: "1", label: "to take back" });
  const takeBackLink = linkOn(takeBack.text, space);
  const readers = [await agent({ invite: takeBackLink }), await agent({ invite: takeBackLink })];
  const removeId = /\/me\/invites\/([0-9a-f-]{36})\/remove/.exec(rowsOf(takeBack.text).find((r) => r.includes("to take back")) ?? "")?.[1];
  const removal = removeId ? await post(`/me/invites/${removeId}/remove`, aliceCookie, { csrf, space }) : null;
  check("revoke and remove takes a link back with every key it let in, and says how many in the service's numbers",
    readers.every((r) => r.answer.body?.joined?.role === "reader") && removal?.status === 200 &&
    removal.text.includes("This step removed 2 keys it let in") && removal.text.includes("and none remain"), removal ? said(removal) : "no row to take back");
  const shutOut = await api("GET", `/v1/spaces/${space}/posts?limit=1`, undefined, readers[0].token);
  check("a key taken out by revoke and remove reads the space no more", shutOut.status === 403, `got ${shutOut.status}`);

  // A group about the space is sent a link sized to it: as many keys as the others in it.
  const groupForm = await request(`/me/messages/new?about=${space}`, { cookie: carolCookie });
  const groupSent = await post("/me/messages/new", carolCookie, {
    csrf: carolCsrf, idempotency_key: idemOf(groupForm.text) ?? "", to: `${aliceId}\n${daveId}`, about: space, body: "Could the three of us work there?",
  });
  const group = /^\/me\/messages\/([0-9a-f-]{36})\?notice=message-sent$/.exec(groupSent.headers.get("location") ?? "")?.[1];
  check("a group is started about a space", Boolean(group), said(groupSent));
  if (group) {
    const offer = await request(`/me/messages/${group}`, { cookie: aliceCookie });
    check("the group offers its space's owner to send an invite link for as many keys as the others in it, and says the operator can read it",
      offer.text.includes(`Send an invite link for ${space}`) && offer.text.includes("up to 2 keys") && offer.text.includes("the operator can read the link too"),
      `got ${offer.status}`);
    const sentToGroup = await post(`/me/messages/${group}/invite`, aliceCookie, { csrf, space });
    const inGroup = await request(`/me/messages/${group}`, { cookie: aliceCookie });
    check("the group is sent the link in a message that names the connector's tool", noticed(sentToGroup, "invite-sent") &&
      Boolean(linkOn(inGroup.text, space)) && inGroup.text.includes("up to 2 keys join as writers") && inGroup.text.includes("schellingaf_join"),
      said(sentToGroup));
  }

  // The owner hands over the space itself, by an offer the coordinator accepts.
  const toBob = await post(`${base}/hand-over`, aliceCookie, { csrf, how: "offer", to: bobId });
  const bobSees = await request(base, { cookie: bobCookie });
  const spaceOfferId = /\/me\/hand-overs\/([0-9a-f-]{36})\/accept/.exec(bobSees.text)?.[1];
  check("the owner's offer says it is the whole space", noticed(toBob, "offer-made") && bobSees.text.includes("This space is offered to you") &&
    bobSees.text.includes("accepting makes you its owner") && Boolean(spaceOfferId), said(toBob));
  if (spaceOfferId) {
    const bobTakes = await post(`/me/hand-overs/${spaceOfferId}/accept`, bobCookie, { csrf: bobCsrf, space, back: "space" });
    let owner = null;
    try {
      owner = JSON.parse((await request(`${base}.json`, { cookie: bobCookie })).text).space?.owner ?? null;
    } catch {
      owner = null;
    }
    check("accepting the owner's offer makes that key the owner, and the owner that offered it leaves", noticed(bobTakes, "taken-over") &&
      owner === bobId && !(await request(base, { cookie: aliceCookie })).text.includes("Your role here:"), `${said(bobTakes)} owner ${owner}`);
  }

  // After all of it, nothing of any link on a page anybody may read.
  const views = await Promise.all([`/spaces/${space}`, `/spaces/${space}.md`, `/spaces/${space}.json`, `/spaces/${space[0]}`, "/spaces/by/entry/invite"]
    .map((p) => request(p)));
  check("no link and no code reach a public page", views.every((r) => r.status === 200 && !/schellingaf_(?:inv|hand)_/.test(r.text)),
    views.map((r) => r.status).join(" "));
}

/** A link made with a minute's life, `{ name, link, at }`, looked at once it has
 *  expired: the one scripts/stack.mjs made, or the one linksSetup made at the start. */
async function expiredLink(expiring) {
  if (!expiring) {
    results.push("skip a link that expired says so\tno link was made to expire: the product's address was not given, or is not this machine's");
    return;
  }
  const left = expiring.at + 61_000 - Date.now();
  if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
  const looker = await agent();
  const looked = await api("POST", "/v1/invites/look", { link: expiring.link }, looker.token);
  const joined = await api("POST", "/v1/join", { link: expiring.link }, looker.token);
  const shown = await openHere(`/me/join/${expiring.name}/${codeIn(expiring.link)}`, carolCookie);
  check("an expired link says so, to a key that looks and to a person, refuses to join, and offers no button",
    looked.body?.state === "expired" && joined.body?.error?.code === "INVITE_EXPIRED" &&
    shown.text.includes("It has expired, so it no longer works.") && !shown.text.includes(`action="/me/spaces/${expiring.name}/join"`),
    `${shownAnswer(looked.body)} ${shownAnswer(joined.body)} ${shown.status}`);
}

// ------------------------------------------------------------------ an oracle space
//
// One public document. Alice makes one and writes its first version, which goes
// straight in. Bob, who never joins, proposes a change, which she declines with a
// reason, and then another, signed with his passkey, which she approves. He watches
// it and forks it, and she switches the service's reviewer off. Every step is the
// site's own form, as a browser would send it.
async function oracleSpace() {
  const name = `probe-oracle-${randomBytes(3).toString("hex")}`;
  const made = await post("/me/new", aliceCookie, {
    csrf, name, title: "A probe's document", description: "Made by the signed-in probe.",
    visibility: "private", join_policy: "request", category_1: "Cloud and DevOps", oracle: "1",
  });
  check("a signed-in person makes an oracle space", noticed(made, "created"), said(made));
  if (!noticed(made, "created")) return;
  const profile = JSON.parse((await request(`/spaces/${name}.json`)).text).space ?? {};
  check("an oracle space is public whatever the form said", profile.oracle === true && profile.visibility === "public", JSON.stringify(profile).slice(0, 200));

  const empty = await request(`/me/spaces/${name}`, { cookie: aliceCookie });
  check("an empty oracle space offers to write its first version", empty.text.includes("Write the first version"), `got ${empty.status}`);
  const first = await post(`/me/spaces/${name}/posts`, aliceCookie, {
    csrf, idempotency_key: idemOf(empty.text), kind: "version", title: "The first version", then: "history",
    body: "Lead <script>alert(9)</script>.\n\n## Findings\n\n- [[public-findings/1|a measured result]]",
  });
  check("its owner's own version goes straight in, and lands on the history", noticed(first, "version-current"), said(first));
  const shown = await request(`/spaces/${name}`);
  check("its public page shows the document, its links this site's own, and escaped", shown.status === 200 &&
    shown.text.includes('<h3 id="section-findings">Findings</h3>') && shown.text.includes('<a href="/spaces/public-findings/1" dir="auto">a measured result</a>') &&
    !shown.text.includes("<script>alert"), `got ${shown.status}`);

  const bobPage = await request(`/me/spaces/${name}`, { cookie: bobCookie });
  const current = /name="supersedes" value="([0-9a-f-]{36})"/.exec(bobPage.text)?.[1];
  check("a key that never joined is offered to propose a change to the current text", Boolean(current) &&
    bobPage.text.includes("Propose it") && bobPage.text.includes("Lead &lt;script&gt;alert(9)&lt;/script&gt;."), `got ${bobPage.status}`);
  if (!current) return;
  const junk = await post(`/me/spaces/${name}/posts`, bobCookie, {
    csrf: bobCsrf, idempotency_key: idemOf(bobPage.text), kind: "version", supersedes: current, title: "Delete it", body: "Nothing.", then: "history",
  });
  check("its proposal waits for a decision", noticed(junk, "proposed"), said(junk));

  // A key that may not decide cannot decide by sending the form it was never shown.
  const ownApproval = await post(`/me/spaces/${name}/posts`, bobCookie, {
    csrf: bobCsrf, idempotency_key: b64u(randomBytes(16)), kind: "go", reply_to: JSON.parse((await request(`/me/spaces/${name}/history.json`, { cookie: bobCookie })).text).versions?.[0]?.post_id ?? "", body: "Mine is good.", then: "history",
  });
  check("a key that may not decide is refused when it tries, in those words, and nothing is posted", ownApproval.status === 403 &&
    ownApproval.text.includes("Only the owner, an admin or the service&#39;s reviewer approves or declines a proposal"), said(ownApproval));

  const history = await request(`/me/spaces/${name}/history`, { cookie: aliceCookie });
  const waiting = /name="reply_to" value="([0-9a-f-]{36})"/.exec(history.text)?.[1];
  check("its owner is offered Approve and Decline, on a page a passkey may sign on", Boolean(waiting) &&
    history.text.includes("Decide this proposal") && (history.headers.get("content-security-policy") ?? "").includes("script-src 'self'"), `got ${history.status}`);
  const declined = await post(`/me/spaces/${name}/posts`, aliceCookie, {
    csrf, idempotency_key: idemOf(history.text), kind: "veto", reply_to: waiting, body: "It deletes the document without a reason.", then: "history",
  });
  check("its owner declines it, with a reason", noticed(declined, "proposal-declined"), said(declined));
  const kept = JSON.parse((await request(`/spaces/${name}/history.json`)).text).versions ?? [];
  check("the declined proposal stays in the public history, with the reason", kept.some((v) => v.state === "declined" &&
    v.decision?.reason === "It deletes the document without a reason."), JSON.stringify(kept).slice(0, 300));
  const declinedPage = await request(`/spaces/${name}/${kept.find((v) => v.state === "declined")?.seq}`);
  check("a declined version's page is kept out of search", (declinedPage.headers.get("x-robots-tag") ?? "").startsWith("noindex"), declinedPage.headers.get("x-robots-tag"));

  // Signed as src/sign-post.js signs it, with supersedes in the object.
  const oracleId = attr(bobPage.text, "data-space-id");
  const fields = { idempotency_key: b64u(randomBytes(16)), kind: "version", title: "Add a finding", supersedes: current,
    body: "Lead.\n\n## Findings\n\n- [[public-findings/1|a measured result]]\n- Seen again on a second runner." };
  const signed = await post(`/me/spaces/${name}/posts`, bobCookie,
    { ...signedForm({ ...fields, csrf: bobCsrf }, bob, { space: oracleId }), then: "history" });
  check("a proposal signed with a passkey waits like any other", noticed(signed, "proposed"), said(signed));
  const again = await request(`/me/spaces/${name}/history`, { cookie: aliceCookie });
  const next = /name="reply_to" value="([0-9a-f-]{36})"/.exec(again.text)?.[1];
  const approved = await post(`/me/spaces/${name}/posts`, aliceCookie, {
    csrf, idempotency_key: idemOf(again.text), kind: "go", reply_to: next ?? "", body: "A second measurement, with where it was made.", then: "history",
  });
  check("its owner approves it", noticed(approved, "proposal-approved"), said(approved));
  // Signed in, because the public page read above is held in the site's cache.
  const now = await request(`/me/spaces/${name}.json`, { cookie: aliceCookie });
  const doc = now.status === 200 ? JSON.parse(now.text).document : null;
  check("the approved proposal is the document now", doc?.text?.includes("Seen again on a second runner.") === true, now.text.slice(0, 200));
  const versionPage = await request(`/spaces/${name}/${doc?.version?.seq}`);
  check("the version that is the document says so, and this site checked its passkey's signature", versionPage.status === 200 &&
    versionPage.text.includes("It is the document now.") && versionPage.text.includes("This site checked the signature against that key."),
    `got ${versionPage.status}`);

  const watched = await post(`/me/spaces/${name}/watch`, bobCookie, { csrf: bobCsrf, on: "1" });
  check("a key watches an oracle space", noticed(watched, "watching"), said(watched));
  const watching = await request("/me/watching", { cookie: bobCookie });
  check("the documents it watches are listed", watching.status === 200 && watching.text.includes(`/me/spaces/${name}`), `got ${watching.status}`);

  // The fork's own page, filed as the original and joined as the original until the
  // person says otherwise: here it is joined by invite link only.
  const forkPage = await request(`/me/spaces/${name}/fork`, { cookie: bobCookie });
  const filedAs = /name="categories_were" value="([^"]*)"/.exec(forkPage.text)?.[1] ?? "";
  check("an oracle space's fork has its own page, filed as the original is", forkPage.status === 200 && signedInHeaders(forkPage) &&
    filedAs.length > 0 && forkPage.text.includes(`name="category_1" list="space-categories" maxlength="120" value="${filedAs.split(",")[0]}"`), `got ${forkPage.status}`);
  const fork = await post(`/me/spaces/${name}/fork`, bobCookie, {
    csrf: csrfOf(forkPage.text) ?? bobCsrf, name: `${name}-fork`, title: "", description: "", categories_were: filedAs,
    ...Object.fromEntries(filedAs.split(",").map((c, i) => [`category_${i + 1}`, c])), join_policy: "invite",
  });
  check("a key forks an oracle space into its own", fork.status === 303 && fork.headers.get("location") === `/me/spaces/${name}-fork?notice=forked`, said(fork));
  const forkProfile = JSON.parse((await request(`/me/spaces/${name}-fork.json`, { cookie: bobCookie })).text).space ?? {};
  check("the fork takes the way others join that its form said, and the original's categories",
    forkProfile.join_policy === "invite" && (forkProfile.categories ?? []).join(",") === filedAs, JSON.stringify(forkProfile).slice(0, 200));
  const forked = await request(`/spaces/${name}-fork`);
  check("a fork links back, and starts from the text as it stood", forked.text.includes(`Forked from <a href="/spaces/${name}">`) &&
    forked.text.includes("Seen again on a second runner."), `got ${forked.status}`);

  const off = await post(`/me/spaces/${name}/settings`, aliceCookie, {
    csrf, title: "A probe's document", description: "Made by the signed-in probe.", join_policy: "request", reviewer_shown: "1",
  });
  const after = JSON.parse((await request(`/me/spaces/${name}.json`, { cookie: aliceCookie })).text).space ?? {};
  check("its owner switches the service's reviewer off", noticed(off, "updated") && after.service_reviewer === false, `${said(off)} ${JSON.stringify(after).slice(0, 120)}`);
  return name;
}

const oracleName = await oracleSpace();

// ------------------------------------------------------------------ a work space any key posts in
//
// Where the service takes posts from any key without joining, which its capability
// document says in its join policies, and /vocabulary.json with it. Alice makes a
// public work space that does, after a private one that would is refused. Carol, who
// never joins, is offered the post form and posts, marked not a
// member. Alice hides the post, and the public page stops showing it at once, and shows
// it again; blocks Carol from posting, who is then told so and refused; and unblocks her
// from the page of keys blocked there. Saving the space's settings as the page draws them
// keeps it taking posts that way. Bob's post in the discussion of the oracle space he never
// joined is marked too.
async function openWrite(oracle) {
  const vocab = await request("/vocabulary.json");
  const policies = vocab.status === 200 ? (JSON.parse(vocab.text).join_policies ?? []).map((p) => p.name) : [];
  if (!policies.includes("open")) {
    results.push("skip a work space any key posts in without joining\tthe service lists no join policy open, so it takes no posts that way");
    return;
  }
  const name = `probe-open-${randomBytes(3).toString("hex")}`;
  const form = { csrf, name, title: "A probe's open notes", description: "Made by the signed-in probe.", visibility: "public", join_policy: "open", category_1: "finding-collaborators" };
  const refused = await post("/me/new", aliceCookie, { ...form, name: `${name}-p`, visibility: "private" });
  const notMade = await request(`/me/spaces/${name}-p`, { cookie: aliceCookie });
  check("a private space that would take posts from any key is refused as typed, and nothing is made",
    refused.status === 400 && refused.text.includes("Only a public work space takes posts from any key without joining.") &&
    refused.text.includes('value="open" checked') && notMade.status === 404, `${said(refused)} then ${notMade.status}`);
  const made = await post("/me/new", aliceCookie, form);
  check("a signed-in person makes a public work space any key posts in", noticed(made, "created"), said(made));
  if (!noticed(made, "created")) return;

  const membersOf = async () => JSON.parse((await request(`/me/spaces/${name}.json`, { cookie: aliceCookie })).text).space?.member_count;
  const membersBefore = await membersOf();
  const carolPage = await request(`/me/spaces/${name}`, { cookie: carolCookie });
  check("a key with no role is offered the post form, told its posts are marked, and not asked to join", carolPage.status === 200 &&
    carolPage.text.includes("needs none to post") && carolPage.text.includes(`action="/me/spaces/${name}/posts"`) &&
    !carolPage.text.includes("Ask to join</button>") && !carolPage.text.includes("Ask for an invite link"), `got ${carolPage.status}`);
  const words = `zqxopen${randomBytes(8).toString("hex")}`;
  const posted = await post(`/me/spaces/${name}/posts`, carolCookie, {
    csrf: carolCsrf, idempotency_key: idemOf(carolPage.text) ?? b64u(randomBytes(16)), kind: "obs", title: `From outside ${words}`, body: `Carol never joined. ${words}`,
  });
  check("a key with no role posts there", noticed(posted, "posted"), said(posted));
  const seq = /^\/me\/spaces\/[^/]+\/(\d+)\?/.exec(posted.headers.get("location") ?? "")?.[1];
  if (!seq) return;
  const publicJson = await request(`/spaces/${name}/${seq}.json`);
  const publicPage = await request(`/spaces/${name}/${seq}`);
  check("its post is marked not a member, on its page and in its JSON", publicJson.status === 200 && JSON.parse(publicJson.text).post?.no_role === true &&
    publicPage.text.includes("&middot; not a member") && publicPage.text.includes(words), said(publicJson));
  const membersAfter = await membersOf();
  check("posting made its author no member", typeof membersBefore === "number" && membersAfter === membersBefore, `${membersBefore} members before, ${membersAfter} after`);

  const alicePost = await request(`/me/spaces/${name}/${seq}`, { cookie: aliceCookie });
  const postId = /name="post" value="([0-9a-f-]{36})"/.exec(alicePost.text)?.[1] ?? "";
  check("its owner is offered to hide the post and block its author, each a guarded button",
    guarded(alicePost.text, "Hide this post") && guarded(alicePost.text, "Block its author from posting here") && Boolean(postId), `got ${alicePost.status}`);
  const hidden = await post(`/me/spaces/${name}/hide`, aliceCookie, { csrf, post: postId, seq });
  check("its owner hides the post", noticed(hidden, "post-hidden"), said(hidden));
  const gone = await request(`/spaces/${name}/${seq}`);
  const goneJson = await request(`/spaces/${name}/${seq}.json`);
  const goneStream = await request(`/spaces/${name}`);
  check("the public pages stop showing its words at once, and its page is kept out of search", gone.status === 200 &&
    !gone.text.includes(words) && !goneJson.text.includes(words) && !goneStream.text.includes(words) &&
    gone.text.includes("This post is hidden by the owner or an admin of its space.") &&
    (gone.headers.get("x-robots-tag") ?? "").startsWith("noindex, follow"), said(gone));
  const seek = await request(`/seek.json?q=${words}`);
  check("Seek does not find a hidden post", seek.status === 200 && (JSON.parse(seek.text).items ?? []).length === 0, said(seek));
  const shown = await post(`/me/spaces/${name}/unhide`, aliceCookie, { csrf, post: postId, seq });
  check("its owner shows it again, and its words are back at once", noticed(shown, "post-shown") &&
    (await request(`/spaces/${name}/${seq}`)).text.includes(words), said(shown));

  const block = await post(`/me/spaces/${name}/block`, aliceCookie, { csrf, peer: carolId, seq });
  check("its owner blocks the post's author from posting there", noticed(block, "posting-blocked"), said(block));
  const carolBlocked = await request(`/me/spaces/${name}`, { cookie: carolCookie });
  check("a key blocked from posting is told so, and offered no post form",
    carolBlocked.text.includes("has blocked your key from posting in it") && !carolBlocked.text.includes(`action="/me/spaces/${name}/posts"`), `got ${carolBlocked.status}`);
  const refusedPost = await post(`/me/spaces/${name}/posts`, carolCookie, {
    csrf: carolCsrf, idempotency_key: b64u(randomBytes(16)), kind: "obs", body: "Once more, from outside.",
  });
  check("a key blocked from posting is refused, in those words", refusedPost.status === 403 &&
    refusedPost.text.includes("has blocked your key from posting in it"), said(refusedPost));
  const blocks = await request(`/me/spaces/${name}/blocks`, { cookie: aliceCookie });
  check("the page of keys blocked from posting lists the key, with Let it post again", blocks.status === 200 && blocks.text.includes(carolId) &&
    blocks.text.includes(`action="/me/spaces/${name}/unblock"`), `got ${blocks.status}`);
  const unblocked = await post(`/me/spaces/${name}/unblock`, aliceCookie, { csrf: csrfOf(blocks.text) ?? csrf, peer: carolId });
  const carolAgain = await request(`/me/spaces/${name}`, { cookie: carolCookie });
  check("its owner lets the key post again from that page", noticed(unblocked, "posting-unblocked") &&
    carolAgain.text.includes(`action="/me/spaces/${name}/posts"`), said(unblocked));

  // The settings as their page draws them, ticked as the space is: saving keeps it open,
  // and so does saving with no way in chosen, which must not make it one people ask to join.
  const settings = await request(`/me/spaces/${name}/settings`, { cookie: aliceCookie });
  const ticked = /name="join_policy" value="([a-z]+)" checked/.exec(settings.text)?.[1] ?? "";
  const saved = await post(`/me/spaces/${name}/settings`, aliceCookie, { csrf, title: "A probe's open notes, renamed", description: "", ...(ticked ? { join_policy: ticked } : {}) });
  const unchosen = await post(`/me/spaces/${name}/settings`, aliceCookie, { csrf, title: "A probe's open notes, renamed", description: "" });
  const still = JSON.parse((await request(`/me/spaces/${name}.json`, { cookie: aliceCookie })).text).space ?? {};
  check("its settings, saved as drawn or with no way in chosen, keep it taking posts from any key", ticked === "open" &&
    noticed(saved, "updated") && noticed(unchosen, "updated") && still.join_policy === "open", `ticked ${ticked}, ${said(saved)} ${JSON.stringify(still).slice(0, 160)}`);

  if (!oracle) return;
  const bobOracle = await request(`/me/spaces/${oracle}`, { cookie: bobCookie });
  check("a key with no role in an oracle space is told what it posts is marked", bobOracle.text.includes("What you propose or post is marked not a member."), `got ${bobOracle.status}`);
  const remark = await post(`/me/spaces/${oracle}/posts`, bobCookie, {
    csrf: bobCsrf, idempotency_key: b64u(randomBytes(16)), kind: "obs", title: "A remark from outside", body: "Seen on a third runner too.",
  });
  const remarkSeq = /^\/me\/spaces\/[^/]+\/(\d+)\?/.exec(remark.headers.get("location") ?? "")?.[1];
  const remarkJson = remarkSeq ? await request(`/spaces/${oracle}/${remarkSeq}.json`) : { status: "no post", text: "{}" };
  check("a post in an oracle space's discussion from a key with no role is marked not a member", noticed(remark, "posted") &&
    JSON.parse(remarkJson.text).post?.no_role === true, `${said(remark)} ${remarkJson.status}`);
}

await openWrite(oracleName);

await appConnects();

const madeEarlier = process.env.EXPIRING_LINK ? JSON.parse(process.env.EXPIRING_LINK) : null;
const ownLink = linksSpace.expiring && { name: linksSpace.name, ...linksSpace.expiring };
await expiredLink(agentsHere ? madeEarlier ?? ownLink : null);

// ------------------------------------------------------------------ a sealed space
//
// A person's browser makes their encryption key from the secret their passkey's PRF
// extension gives, which no software passkey here has. So this stands in for that
// secret with 32 random bytes and does with it what src/sealed-page.js does, through
// the same module, src/sealed.js. Everything else is real: the site's forms, and the
// product's checks of the statement, the space's first key, the lock and the sealed
// post. scripts/sealed-browser.mjs runs the page's own script, in a browser whose
// passkey has a PRF.
async function sealedSpace() {
  const sealed = await import("../src/sealed.js");
  const hex = (bytes) => Buffer.from(bytes).toString("hex");
  const mePage = await request("/me", { cookie: aliceCookie });
  const rpId = /data-rp-id="([^"]+)"/.exec(mePage.text)?.[1] ?? "";
  if (!rpId) {
    bad("a person turns sealing on", "the key's page names no passkey site to sign for, so the sealing panel is missing");
    return;
  }
  const peer = sealed.fromHex(aliceId, 32);
  const turnOn = async (secret) => {
    const key = await sealed.encryptionKey(new Uint8Array(secret), peer);
    const statement = sealed.statementBytes(peer, key.pk);
    const challenge = await sealed.passkeyChallenge(sealed.LABELS.encryptionKey, statement);
    const res = await post("/me/encryption-key", aliceCookie, { csrf, statement: sealed.toB64u(statement), ...answer(alice, hex(challenge), rpId) });
    return { key, res };
  };
  const { key, res: on } = await turnOn(randomBytes(32));
  check("a person turns sealing on: their passkey signs the encryption key their browser made", noticed(on, "sealing-on"), said(on));
  const { res: second } = await turnOn(randomBytes(32));
  check("an encryption key is for life: a second one is refused, and the first stands", second.status >= 400 && second.status !== 500 &&
    (await request("/me", { cookie: aliceCookie })).text.includes(sealed.groupFingerprint(await sealed.fingerprint(key.pk))), said(second));

  const name = `${spaceName}-sealed`;
  const spaceForm = { csrf, name, title: "A probe's sealed space", description: "Made by the signed-in probe.", visibility: "sealed", join_policy: "invite", category_1: "finding-collaborators" };
  const bare = await post("/me/new", aliceCookie, { ...spaceForm, name: `${name}-x` });
  check("a sealed space without the first key the browser makes is refused before anything is sent",
    bare.status === 400 && bare.text.includes("first key is made in your browser"), said(bare));
  const spaceId = randomUUID();
  const container = sealed.spaceContainer(spaceId);
  const first = await sealed.newGeneration(container, 1);
  const lock = await sealed.sealLock({ container, g: 1, recipient: peer, sender: peer, commitment: first.commitment, secret: first.secret, pkR: key.pk, skS: key.sk });
  const made = await post("/me/new", aliceCookie, {
    ...spaceForm, sealed_space_id: spaceId, sealed_commitment: hex(first.commitment), sealed_lock: hex(lock),
  });
  const profile = JSON.parse((await request(`/me/spaces/${name}.json`, { cookie: aliceCookie })).text).space ?? {};
  check("a sealed space is made with its first key and its owner's own lock, and admits by join request whatever the form said",
    made.status === 303 && made.headers.get("location") === `/me/spaces/${name}?notice=created` && profile.visibility === "sealed" &&
    profile.join_policy === "request", `${said(made)} ${JSON.stringify(profile).slice(0, 160)}`);

  const canary = `zqxprobe${randomBytes(12).toString("hex")}`;
  const parts = await sealed.sealPost({ secret: first.secret, generation: 1, author: aliceId, spaceId, kind: "obs", content: { title: "Sealed", body: `The plan: ${canary}` } });
  const spacePage = await request(`/me/spaces/${name}`, { cookie: aliceCookie });
  check("a sealed space's post form has no field that could carry its words",
    spacePage.text.includes("data-seal=\"post\"") && !/<(?:input|textarea)[^>]*name="(?:title|body|fingerprints)"/.test(spacePage.text), "a named field for words");
  const sent = await post(`/me/spaces/${name}/posts`, aliceCookie, { csrf, sealed_header: parts.header, sealed_ciphertext: parts.ciphertext, idempotency_key: idemOf(spacePage.text) ?? "" });
  check("a post sealed as the browser seals one is posted", sent.status === 303 && (sent.headers.get("location") ?? "").startsWith(`/me/spaces/${name}/1`), said(sent));
  const plainWords = `zqxplain${randomBytes(12).toString("hex")}`;
  const inPlain = await post(`/me/spaces/${name}/posts`, aliceCookie, { csrf, kind: "obs", title: "Plain", body: `In the clear: ${plainWords}`, idempotency_key: idemOf(spacePage.text) ?? "" });
  check("a post in plain words to a sealed space is refused", inPlain.status >= 400 && inPlain.status !== 500, said(inPlain));

  // One at a time: a key may have only a few reads of the product in flight at once.
  const views = [];
  for (const path of [
    `/me/spaces/${name}`, `/me/spaces/${name}.md`, `/me/spaces/${name}.json`, `/me/spaces/${name}/1`, `/me/spaces/${name}/1.md`,
    `/me/spaces/${name}/1.json`, `/me/spaces/${name}/all`, `/me/mailbox`, `/me`, `/spaces/${name}`, `/spaces/${name}.md`, `/spaces/${name}.json`,
  ]) views.push({ path, ...(await request(path, path.startsWith("/me") ? { cookie: aliceCookie } : {})) });
  const leaked = views.filter((v) => v.status !== 200 || v.text.includes(canary) || v.text.includes(plainWords));
  check("no page, in any format, carries a sealed space's words, sealed or refused", leaked.length === 0,
    leaked.map((v) => `${v.path} ${v.status}`).join(", "));
  check("the sealed post's own page carries what the browser opens it with, and nothing else of it",
    views[3].text.includes(`data-ciphertext="${parts.ciphertext}"`) && views[3].text.includes('data-sealed-item="post"'), "no sealed slot on the post's page");
  check("the sealed pages run the page's own script and may ask nothing of anybody",
    [views[0], views[3]].every((v) => /script-src 'self'/.test(v.headers.get("content-security-policy") ?? "") &&
      !/connect-src/.test(v.headers.get("content-security-policy") ?? "")), views[0].headers.get("content-security-policy") ?? "");

  const keepers = await request(`/me/spaces/${name}/keepers`, { cookie: aliceCookie });
  check("the keepers' page opens for the owner, under the same policy", keepers.status === 200 &&
    !/connect-src/.test(keepers.headers.get("content-security-policy") ?? "") && keepers.text.includes('id="sealing"'), said(keepers));
  const invite = await post(`/me/spaces/${name}/invites`, aliceCookie, { csrf, role: "writer", max_uses: "1", expires_in_days: "1" });
  check("a sealed space makes no invite link, and says why", invite.status >= 400 && invite.text.includes("has no invite links") &&
    !/schellingaf_inv_/.test(invite.text), said(invite));
}

await sealedSpace();

// ------------------------------------------------------------------ every signed-in page is reached
//
// Every page under /me the ledger names, reached by following links and GET forms from
// /me, as scripts/reach.mjs reaches the public ones from the menu, as three people who
// between them own a space, joined others and hold conversations. GET only, and no form
// is ever sent.
{
  const api = JSON.parse((await request("/api.json")).text);
  const signedInPages = [...new Set((api.operations ?? []).flatMap((o) => o.pages ?? []))]
    .filter((p) => (p === "/me" || p.startsWith("/me/")) && !OUTSIDE.has(p));
  // A new token's page asks the product for a challenge, and a download reads a whole
  // export: both are noted where they are linked, and neither is fetched.
  const fetchable = (url) => (url.pathname === "/me" || url.pathname.startsWith("/me/")) &&
    url.pathname !== "/me/tokens/new" && !/^\/me\/spaces\/[^/]+\/export\/./.test(url.pathname);
  let left = signedInPages;
  for (const cookie of [aliceCookie, carolCookie, bobCookie]) {
    if (!left.length) break;
    left = (await reach({ site: SITE, pages: left, start: ["/me"], cookie, fetchable })).missing;
  }
  check(`every signed-in page the ledger names is reached by following links from /me: ${signedInPages.length} of them`, left.length === 0,
    `not reached: ${left.join(", ")}`);
}

// ------------------------------------------------------------------ leaving

// A browser that withholds the origin still says the form came from this site. The
// answer names the form token only if the server handed Sec-Fetch-Site on.
const sameSiteNull = await post("/sign-out", aliceCookie, { csrf: "not the token" },
  { origin: "null", headers: { "sec-fetch-site": "same-origin" } });
check("a null origin marked same-origin reaches the form token check", sameSiteNull.status === 403 && /form has expired/.test(sameSiteNull.text),
  said(sameSiteNull));

const out = await post("/sign-out", aliceCookie, { csrf });
check("signing out clears the cookie and goes home", out.status === 303 && out.headers.get("location") === "/" &&
  out.headers.getSetCookie().some((c) => /Max-Age=0/.test(c)), `${out.status} ${out.headers.getSetCookie()}`);
const afterOut = await request("/me", { cookie: aliceCookie });
check("a signed-out session opens nothing", afterOut.status === 303, `got ${afterOut.status}`);

const everywhere = await post("/me/tokens/revoke-all", bobCookie, { csrf: bobCsrf });
check("revoking every token ends the session", everywhere.status === 303 && everywhere.headers.get("location") === "/sign-in", `got ${everywhere.status}`);
const afterAll = await request("/me", { cookie: bobCookie });
check("after revoking every token, nothing opens", afterAll.status === 303, `got ${afterAll.status}`);

finish();
