// A private local copy of the product and this site, for the checkout it runs in.
//
// `npm run verify` means something only against a product with its database, both
// seeds, the two operator fixtures and the site started with their tokens, and on a
// database no other checkout re-seeds or rebuilds under it; and a run whose settings
// made checks skip must not report success.
//
// This does all of it for one checkout, sharing nothing: its own database container under
// its own Compose project name and port, its own product and site on free ports, and its
// state in .stack/, which git ignores. Two checkouts or worktrees run their own at once.
//
// The demo is the same stack on the fixed addresses a person keeps open in a browser,
// the product on 127.0.0.1:3011 and the site on localhost:8787. There is one on the
// machine, whichever checkout starts or stops it, so its state is kept outside every
// checkout, in ~/.local/state/schellingaf/demo: a checkout's `down` never touches it, and
// removing the worktree that started it cannot strand it. A demo whose checkout is gone
// is stopped and started again from the checkout that asks.
//
//   npm run stack -- up            start and seed everything, then print the addresses
//   npm run stack -- verify        up if needed, then scripts/verify.sh against it; fails
//                                  on any skip that a full local stack should not have
//   npm run stack -- restart-site  rebuild and restart only the site, after a code change
//   npm run stack -- down          stop what this checkout started and remove its data
//   npm run stack -- status        every stack on this machine, and anything left behind
//   npm run stack -- demo          start the demo on 3011 and 8787, or say it is running
//   npm run stack -- demo down     stop the demo and remove its data
//
// It needs Docker running and the product repository beside the main checkout; API_DIR
// points it somewhere else. It never touches the product's own test database or
// .dev.vars, and never stops a process it did not start.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The product repository sits beside the main checkout. From a git worktree "../" is
// not the main checkout's parent, so the main checkout is found through git.
function mainCheckout(dir) {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${dir} is not inside a git checkout`);
  return dirname(r.stdout.trim());
}
const API_DIR = process.env.API_DIR
  ? resolve(process.env.API_DIR)
  : join(dirname(mainCheckout(ROOT)), "schellingaf-api");

// Every stack's Compose project starts with this, and nothing else is ever stopped or
// removed: the product's own tests use the project schellingaf-test, which a slip here
// would wipe along with its data.
const PREFIX = "schellingaf-stack-";
const SLUG = basename(ROOT).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "checkout";
// A checkout named demo would otherwise share the demo's project.
const PROJECT = PREFIX + (SLUG === "demo" ? "checkout-demo" : SLUG);

// A stack is where its state lives, its Compose project and, for the demo, its fixed
// ports. `ports: null` means free ones, chosen when it starts.
const CHECKOUT = { dir: join(ROOT, ".stack"), project: PROJECT, ports: null, stop: "npm run stack -- down" };
// Beside the outside witness scripts/verify.sh keeps.
const DEMO = {
  dir: join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "schellingaf", "demo"),
  project: `${PREFIX}demo`,
  ports: { api: 3011, site: 8787 },
  stop: "npm run stack -- demo down",
};
// What npm run finish names the product's test database; status reports one left behind.
const FINISH_PREFIX = "schellingaf-finish-";

// Fixed, local and public on purpose; the product's compose.test.yml says why.
const TEMPLATE = "schellingaf_tmpl";
const DATABASE = "schellingaf_stack";
const API_USER = "schellingaf_api";
const API_PASSWORD = "test_api_password_not_a_secret";

// What a full local stack still cannot check, and why none of it is a gap. Anything
// else that skips means the stack is not what it should be, and fails the run.
const EXPECTED_SKIPS = [
  // Only a deployed site can say whether the product answers at its real hostname.
  (s) => s.name === "the API this site names is answering",
  // The outside witness compares with a checkpoint an earlier run kept. A stack's first
  // run has none yet and keeps one for the next.
  (s) => s.reason.startsWith("nothing kept yet"),
  (s) => s.reason.includes("its record is longer than one run walks"),
  // A post's id and an app's request are addresses a person arrives at from outside,
  // never by a link on this site: scripts/reach.mjs names them rather than failing.
  (s) => s.reason.startsWith("entered from outside by design"),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiOrigin = (state) => `http://127.0.0.1:${state.ports.api}`;
const siteOrigin = (state) => `http://localhost:${state.ports.site}`;

// The state names the folder it was read from, so every log and file it leads to is
// written beside it.
function readState(dir) {
  const file = join(dir, "state.json");
  return existsSync(file) ? { ...JSON.parse(readFileSync(file, "utf8")), dir } : null;
}

function writeState(state) {
  const { dir, ...saved } = state;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(saved, null, 2) + "\n", { mode: 0o600 });
}

// `log` is a log file's path, or null for none.
function appendLog(log, text) {
  if (!log || !existsSync(dirname(log))) return;
  appendFileSync(log, text);
}

function step(what) {
  console.log(`  ${what}`);
}

// Children get a small, explicit environment rather than this shell's: a DB_PORT or an
// API_ORIGIN exported for some other purpose would otherwise decide what they talk to.
function baseEnv(extra) {
  const env = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "USER"]) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

function run(command, args, { cwd, env, log }) {
  const r = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  appendLog(log, `$ ${command} ${args.join(" ")}\n${output}\n`);
  if (r.status !== 0) {
    const tail = output.trim().split("\n").slice(-15).join("\n");
    throw new Error(`${basename(command)} ${args[0]} failed${r.error ? ` (${r.error.message})` : ""}:\n${tail}`);
  }
  return r.stdout;
}

function compose(project, apiDir, dbPort, args, log) {
  if (!project.startsWith(PREFIX)) throw new Error(`refusing to act on Compose project ${project}`);
  return run("docker", ["compose", "-p", project, "-f", join(apiDir, "compose.test.yml"), ...args], {
    cwd: apiDir,
    env: { ...process.env, TEST_DB_PORT: String(dbPort) },
    log,
  });
}

function psql(state, database, ...commands) {
  const args = ["exec", "-T", "postgres", "psql", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1", "-q"];
  for (const c of commands) args.push("-c", c);
  compose(state.project, state.apiDir, state.ports.db, args, join(state.dir, "database.log"));
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function startDetached(dir, name, script, { cwd, env }) {
  const out = openSync(join(dir, `${name}.log`), "a");
  const child = spawn(process.execPath, [script], { cwd, env, detached: true, stdio: ["ignore", out, out] });
  closeSync(out);
  child.unref();
  return child;
}

// A process id is only trusted while it still runs what this script started, so a
// number the system has since handed to something else is never signalled.
function alive(pid, marker) {
  if (!pid) return false;
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return r.status === 0 && r.stdout.includes(marker);
}

async function stop(pid, marker) {
  if (!alive(pid, marker)) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const until = Date.now() + 5000;
  while (Date.now() < until && alive(pid, marker)) await sleep(100);
  if (alive(pid, marker)) try { process.kill(pid, "SIGKILL"); } catch {}
}

function containerRunning(project) {
  const r = spawnSync("docker", ["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() !== "";
}

// The checkout whose site the stack serves. A checkout's own stack lives inside it.
const checkoutOf = (state) => state.checkout ?? dirname(state.dir);

// A site whose checkout was removed still runs, but has nothing left to serve.
function siteRunning(state) {
  return alive(state.pids?.site, "serve.mjs") && existsSync(join(checkoutOf(state), "serve.mjs"));
}

function running(state) {
  return siteRunning(state) && alive(state.pids?.product, "src/server.ts") && containerRunning(state.project);
}

// Asks until the answer is yes or the time is up. A child that has already exited is
// reported at once rather than waited out.
async function waitFor(test, seconds, child) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    if (child && child.exitCode !== null) return false;
    try { if (await test()) return true; } catch {}
    if (Date.now() > until) return false;
    await sleep(250);
  }
}

async function answers(url, wanted = 200) {
  const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
  return r.status === wanted;
}

function preflight() {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    throw new Error("Docker is not running. Open Docker Desktop, wait until it says it is running, and run this again.");
  }
  for (const f of ["test/bootstrap.ts", "src/server.ts", "compose.test.yml", "node_modules"]) {
    if (!existsSync(join(API_DIR, f))) {
      throw new Error(`The product repository is not ready at ${API_DIR}: it has no ${f}. Set API_DIR to where it is, or run npm install there.`);
    }
  }
}

function printed(output, name) {
  const m = new RegExp(`^${name} = "([^"]+)"`, "m").exec(output);
  if (!m) throw new Error(`the seed did not print ${name}`);
  return m[1];
}

function printAddresses(state, heading, stack) {
  console.log(`
${heading}: ${state.project}
  site      ${siteOrigin(state)}
  product   ${apiOrigin(state)}
  database  127.0.0.1:${state.ports.db}, database ${DATABASE}
Logs are in ${state.dir}. Stop it with: ${stack.stop}`);
}

// What is listening on a port, in words, or null when nothing is.
function holder(port) {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  const pid = r.stdout?.trim().split("\n")[0];
  if (!pid) return null;
  const command = spawnSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).stdout.trim();
  return `process ${pid} (${command || "a program this script cannot name"})`;
}

// The two spaces only an operator can make: each is made through the product as the
// reader key, then one is withheld (a row in withheld_spaces) and the other closed (its
// status set to closed) straight in the database, as an operator would. Making a space
// spends the same allowance the seed has just drained, so a refusal to slow down is
// waited out for as long as it asks, up to two minutes.
async function operatorFixtures(state) {
  for (const name of ["withheld-fixture", "closed-fixture"]) {
    const until = Date.now() + 120_000;
    for (;;) {
      const r = await fetch(`${apiOrigin(state)}/v1/spaces`, {
        method: "POST",
        headers: { authorization: `Bearer ${state.tokens.reader}`, "content-type": "application/json" },
        body: JSON.stringify({ name, title: `A ${name} space`, visibility: "public", categories: ["this-service"] }),
      });
      if (r.status === 201 || r.status === 409) break;
      const wait = Number(r.headers.get("retry-after")) || 5;
      if (r.status === 429 && Date.now() + wait * 1000 < until) {
        await sleep(wait * 1000);
        continue;
      }
      throw new Error(`the product refused to make ${name}: ${r.status} ${(await r.text()).slice(0, 300)}`);
    }
  }
  psql(state, DATABASE,
    "insert into schellingaf.withheld_spaces (space_id, reason, note) select space_id, 'abuse', 'local fixture' from schellingaf.spaces where name = 'withheld-fixture' on conflict do nothing",
    "update schellingaf.spaces set status = 'closed' where name = 'closed-fixture'");
}

// The signed-in probe's last check looks at an invite link that has expired, and the
// shortest life the product gives a link is a minute. Made here, as the stack starts,
// that minute passes while verify.sh runs its other checks, where a link the probe
// made itself kept it waiting most of a minute with nothing to do. In hostile-content,
// the seed's private space: a link shows on no page another check reads, and making
// one writes no event, where a space made for it would join the public directory. The
// seed and the operator fixtures have spent the reader's allowance, so a refusal to
// slow down is waited out, as the fixtures wait it out.
async function expiringLink(state) {
  const name = "hostile-content";
  const until = Date.now() + 120_000;
  for (;;) {
    const r = await fetch(`${apiOrigin(state)}/v1/spaces/${name}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.tokens.reader}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "reader", max_uses: 5, expires_in_seconds: 60 }),
    });
    const answer = await r.json().catch(() => null);
    if (r.status === 201) return { name, link: answer.link, at: Date.now() };
    const wait = Number(r.headers.get("retry-after")) || 5;
    if (r.status === 429 && Date.now() + wait * 1000 < until) {
      await sleep(wait * 1000);
      continue;
    }
    throw new Error(`the product refused a link for ${name}: ${r.status} ${JSON.stringify(answer).slice(0, 300)}`);
  }
}

async function startSite(state) {
  const site = startDetached(state.dir, "site", "serve.mjs", {
    cwd: ROOT,
    env: baseEnv({
      PORT: String(state.ports.site),
      HOST: "127.0.0.1",
      API_ORIGIN: apiOrigin(state),
      SITE_TOKEN: state.tokens.site,
      READER_TOKEN: state.tokens.reader,
    }),
  });
  state.pids.site = site.pid;
  writeState(state);
  if (!(await waitFor(() => answers(`http://127.0.0.1:${state.ports.site}/`), 30, site))) {
    throw new Error(`the site did not start. Its log: ${join(state.dir, "site.log")}`);
  }
}

// Starts a stack, or reports the one already running. Fixed ports are checked only
// after this stack's own leftovers are stopped, so what still holds one is not its own.
async function bringUp(stack, { expiring = false } = {}) {
  const existing = readState(stack.dir);
  if (existing && running(existing)) {
    printAddresses(existing, "Already running", stack);
    return existing;
  }
  if (existing) await takeDown(stack, { quiet: true, keepLogs: true });

  preflight();
  for (const [what, port] of Object.entries(stack.ports ?? {})) {
    const held = holder(port);
    if (held) {
      throw new Error(`Port ${port}, where the ${what === "api" ? "product" : "site"} goes, is already taken by ${held}, which this script did not start; stop that first.`);
    }
  }
  mkdirSync(stack.dir, { recursive: true });
  const ports = {
    db: await freePort(),
    api: stack.ports?.api ?? await freePort(),
    site: stack.ports?.site ?? await freePort(),
  };
  // Written before anything starts, so that `down` can clear away a stack that failed
  // half way.
  const state = { project: stack.project, apiDir: API_DIR, checkout: ROOT, ports, pids: {}, started: new Date().toISOString(), dir: stack.dir };
  writeState(state);
  console.log(`Starting ${stack.project}`);

  try {
    step("database: its own container, and the product's schema");
    run(process.execPath, ["test/bootstrap.ts"], {
      cwd: API_DIR,
      env: { ...process.env, COMPOSE_PROJECT_NAME: stack.project, TEST_DB_PORT: String(ports.db) },
      log: join(stack.dir, "database.log"),
    });
    psql(state, "postgres",
      `drop database if exists ${DATABASE} with (force)`,
      `create database ${DATABASE} template ${TEMPLATE} owner schellingaf_owner`);

    step("product: every setting the checks need, so none of them skips");
    const product = startDetached(stack.dir, "product", "src/server.ts", {
      cwd: API_DIR,
      env: baseEnv({
        API_HOST: `127.0.0.1:${ports.api}`,
        PUBLIC_ORIGIN: apiOrigin(state),
        CHALLENGE_KEY: "a-local-key-not-a-secret",
        DB_HOST: "127.0.0.1",
        DB_PORT: String(ports.db),
        DB_NAME: DATABASE,
        DB_USER: API_USER,
        DB_PASSWORD: API_PASSWORD,
        // A new key may make a public space at once, so the seed can make one.
        PUBLIC_SPACE_MIN_KEY_AGE_HOURS: "0",
        // Passkeys for this stack's own site, so the signed-in probe runs, and the
        // same site as the page where a person answers an app, so an app can connect.
        PASSKEY_RP_ID: "localhost",
        PASSKEY_ORIGINS: siteOrigin(state),
        SITE_ORIGIN: siteOrigin(state),
        // A checkpoint within seconds of a post, not ten minutes.
        CHECKPOINT_AFTER_SECONDS: "0",
        CHECKPOINT_EVERY_SECONDS: "5",
        // Every read the site makes comes from this one machine, and one run makes
        // hundreds. At the service's real per-minute allowances a second run within a
        // minute of the first was refused on the pages that read with no key, and
        // failed checks with nothing wrong in them. No check depends on reaching an
        // allowance; how many reads may run at once is left as the service sets it.
        READS_PER_MINUTE: "100000",
        ANON_READS_PER_MINUTE: "100000",
        SEEKS_PER_MINUTE: "100000",
        PORT: String(ports.api),
        LOG_DIR: join(stack.dir, "product-logs"),
      }),
    });
    state.pids.product = product.pid;
    writeState(state);
    if (!(await waitFor(() => answers(`${apiOrigin(state)}/v1/capabilities`), 60, product))) {
      throw new Error(`the product did not start. Its log: ${join(stack.dir, "product.log")}`);
    }

    step("seed: the demo spaces and the hostile fixtures");
    const seedEnv = baseEnv({ API: apiOrigin(state) });
    const seedLog = join(stack.dir, "seed.log");
    run(process.execPath, ["scripts/seed-hostile.mjs"], { cwd: ROOT, env: seedEnv, log: seedLog });
    const demo = run(process.execPath, ["scripts/seed-demo.mjs"], { cwd: ROOT, env: seedEnv, log: seedLog });
    state.tokens = { site: printed(demo, "SITE_TOKEN"), reader: printed(demo, "READER_TOKEN") };
    writeState(state);

    step("operator fixtures: a withheld space and a closed one");
    await operatorFixtures(state);
    if (expiring) {
      step("a link that expires in a minute, for the signed-in probe to find expired");
      state.expiring = await expiringLink(state);
      writeState(state);
    }

    step("site: built, and started with this stack's tokens");
    run(process.execPath, ["build.mjs"], { cwd: ROOT, env: baseEnv({}), log: join(stack.dir, "site.log") });
    await startSite(state);
  } catch (e) {
    await takeDown(stack, { quiet: true, keepLogs: true });
    throw e;
  }

  printAddresses(state, "Running", stack);
  return state;
}

const up = () => bringUp(CHECKOUT);
const down = () => takeDown(CHECKOUT);

async function verify() {
  const state = await bringUp(CHECKOUT, { expiring: true });
  // A stack started by `up` has none yet: its minute starts now.
  if (!state.expiring) {
    state.expiring = await expiringLink(state);
    writeState(state);
  }

  // Asked of the product, not the site: the site keeps a page for minutes, and a page
  // kept from before the first checkpoint would make the check skip.
  step("waiting for the product to sign its first checkpoint");
  const signed = await waitFor(async () => {
    const r = await fetch(`${apiOrigin(state)}/v1/spaces/public-findings/checkpoints`, { signal: AbortSignal.timeout(3000) });
    return r.ok && ((await r.json()).items ?? []).length > 0;
  }, 60);
  if (!signed) step("no checkpoint after a minute; the checks will say what they could not see");

  const output = await new Promise((done, reject) => {
    const child = spawn("sh", ["scripts/verify.sh"], {
      cwd: ROOT,
      env: {
        ...process.env,
        SITE: siteOrigin(state),
        API_ORIGIN: apiOrigin(state),
        WITNESS_FILE: join(state.dir, "witness.json"),
        EXPIRING_LINK: JSON.stringify(state.expiring),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    child.stdout.on("data", (d) => { text += d; process.stdout.write(d); });
    child.stderr.on("data", (d) => { text += d; process.stderr.write(d); });
    child.on("error", reject);
    child.on("close", (code) => done({ code, text }));
  });

  const lines = output.text.split("\n");
  const skips = [];
  lines.forEach((line, i) => {
    const m = /^ {2}skip {2}(.*)$/.exec(line);
    if (m) skips.push({ name: m[1], reason: (lines[i + 1] ?? "").trim() });
  });
  const unexpected = skips.filter((s) => !EXPECTED_SKIPS.some((expected) => expected(s)));

  if (output.code !== 0) {
    console.log(`verify failed. Logs are in ${state.dir}.`);
    process.exitCode = 1;
    return;
  }
  if (unexpected.length) {
    console.log(`But ${unexpected.length} check${unexpected.length === 1 ? "" : "s"} skipped that this stack should have run:`);
    for (const s of unexpected) console.log(`  ${s.name}\n      ${s.reason}`);
    console.log(`That is a stack that is not what it should be, not a pass. Logs are in ${state.dir}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Every check a local stack can run, ran${skips.length ? ` (${skips.length} skipped by design: only a deployed site or a later run can check them, or they are pages a person enters from outside)` : ""}.`);
}

async function restartSite() {
  const state = readState(CHECKOUT.dir);
  if (!state || !alive(state.pids?.product, "src/server.ts")) {
    throw new Error("No stack is running from this checkout. Run: npm run stack -- up");
  }
  await stop(state.pids.site, "serve.mjs");
  run(process.execPath, ["build.mjs"], { cwd: ROOT, env: baseEnv({}), log: join(state.dir, "site.log") });
  await startSite(state);
  console.log(`Site restarted with the code as it is now: ${siteOrigin(state)}`);
}

async function takeDown(stack, { quiet = false, keepLogs = false } = {}) {
  const state = readState(stack.dir);
  const project = state?.project ?? stack.project;
  let stopped = false;
  if (state) {
    await stop(state.pids?.site, "serve.mjs");
    await stop(state.pids?.product, "src/server.ts");
    stopped = true;
  }
  // A container can outlive its state if a run was interrupted, so it is looked for
  // by name either way.
  const listed = spawnSync("docker", ["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${project}`], { encoding: "utf8" });
  if (listed.status === 0 && listed.stdout.trim()) {
    // The product checkout it was started from may have been removed since.
    const apiDir = state?.apiDir && existsSync(join(state.apiDir, "compose.test.yml")) ? state.apiDir : API_DIR;
    compose(project, apiDir, state?.ports?.db ?? 5439, ["down", "-v", "--remove-orphans"], null);
    stopped = true;
  }
  if (keepLogs) {
    for (const f of ["state.json", "witness.json"]) rmSync(join(stack.dir, f), { force: true });
  } else {
    rmSync(stack.dir, { recursive: true, force: true });
  }
  if (!quiet) console.log(stopped ? `Stopped ${project} and removed its data.` : `No ${stack === CHECKOUT ? "stack is running from this checkout" : "demo is running"}.`);
}

function checkouts() {
  const list = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  return (list.stdout ?? "").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
}

async function demo() {
  const action = process.argv[3];
  if (action === "down") return takeDown(DEMO);
  if (action) throw new Error(`demo takes nothing, or down; not ${action}.`);
  await bringUp(DEMO);
}

function status() {
  const claimed = new Set();
  let any = false;
  const stacks = [
    ...checkouts().map((dir) => [join(dir, ".stack"), () => dir, "run `npm run stack -- down` in that checkout, then up again"]),
    [DEMO.dir, (state) => `the demo, serving the site from ${checkoutOf(state)}`, "run `npm run stack -- demo`, which starts it again"],
  ];
  for (const [dir, label, again] of stacks) {
    const state = readState(dir);
    if (!state) continue;
    any = true;
    claimed.add(state.project);
    const site = siteRunning(state);
    const product = alive(state.pids?.product, "src/server.ts");
    const database = containerRunning(state.project);
    console.log(`${label(state)}
  site      ${siteOrigin(state)}  ${site ? "running" : "NOT RUNNING"}
  product   ${apiOrigin(state)}  ${product ? "running" : "NOT RUNNING"}
  database  127.0.0.1:${state.ports.db}  ${database ? "running" : "NOT RUNNING"}  (${state.project})`);
    if (!(site && product && database)) console.log(`  part of it stopped: ${again}`);
  }
  const containers = spawnSync("docker", ["ps", "-a", "--filter", "label=com.docker.compose.project",
    "--format", '{{.Label "com.docker.compose.project"}}\t{{.Status}}'], { encoding: "utf8" });
  for (const line of (containers.stdout ?? "").split("\n")) {
    const [project, how] = line.split("\t");
    if (!project || claimed.has(project)) continue;
    const what = project.startsWith(PREFIX) ? `the database container of ${project} (${how}), which no checkout claims`
      : project.startsWith(FINISH_PREFIX) ? `the test database of ${project} (${how}), which npm run finish makes and removes, unless one is running now`
      : null;
    if (!what) continue;
    any = true;
    console.log(`left behind: ${what}. Remove it:
  cd ${API_DIR} && docker compose -p ${project} -f compose.test.yml down -v`);
  }
  if (!any) console.log("No stacks on this machine.");
}

const COMMANDS = { up, verify, "restart-site": restartSite, down, status, demo };
const command = process.argv[2];
if (!Object.hasOwn(COMMANDS, command ?? "")) {
  console.log("Usage: npm run stack -- up | verify | restart-site | down | status | demo | demo down");
  process.exit(command ? 2 : 0);
}
try {
  await COMMANDS[command]();
} catch (e) {
  console.error(`\nstack ${command}: ${e.message}`);
  process.exitCode = 1;
}
