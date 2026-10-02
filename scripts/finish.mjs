// Everything a finished change must pass, in this site and in the product, as one
// verdict.
//
//   npm run finish              every step
//   npm run finish -- --quick   every step but the local stack, which takes minutes
//
// 1. the product's tests and its check, on a database of their own that is removed after
// 2. the site's tests
// 3. the local stack's checks (npm run stack -- verify) on a stack started afresh, then
//    the stack taken down
// 4. every changed and new file in both repositories, so anything uncommitted is seen
//    before a commit sweeps it in
// 5. the files this change touched, scanned for invisible control characters
// 6. whether the approved-copy files changed, to be checked by eye
//
// It says ready only when 1, 2, 3 and 5 pass. The full output of every step is kept in a
// temporary folder whose path it prints. The product is found as scripts/stack.mjs finds
// it: API_DIR, or the folder beside the main checkout.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Control characters other than tab, line feed and carriage return, and the C1 set as
// UTF-8 decodes it. Written as escapes, so this file holds none of them itself.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/g;

// Files that are bytes rather than text, where any byte may appear. Chosen by name,
// because git calls a text file binary as soon as it holds a NUL: the very file to catch.
const BINARY = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".pdf", ".zip", ".gz", ".tgz", ".wasm"]);

/** Every control character in one file, as "line N: 0xNN". Empty when it is clean. */
export function controlBytes(file) {
  if (BINARY.has(extname(file).toLowerCase())) return [];
  const found = [];
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    for (const m of line.matchAll(CONTROL)) {
      found.push(`line ${i + 1}: 0x${m[0].charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()}`);
    }
  });
  return found;
}

function git(dir, ...args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${r.stderr.trim()}`);
  return r.stdout;
}

const lines = (text) => text.split("\n").filter(Boolean);

// What this change touched: everything that differs from where the branch left main,
// committed or not, and every new file git does not ignore.
function changedFiles(dir) {
  const base = git(dir, "merge-base", "main", "HEAD").trim();
  const files = [...lines(git(dir, "diff", "--name-only", base)), ...lines(git(dir, "ls-files", "--others", "--exclude-standard"))];
  return [...new Set(files)].filter((f) => existsSync(join(dir, f)));
}

function freePort() {
  return new Promise((done, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

const took = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

async function main() {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const mainCheckout = dirname(git(ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir").trim());
  const API_DIR = process.env.API_DIR ? resolve(process.env.API_DIR) : join(dirname(mainCheckout), "schellingaf-api");
  const quick = process.argv.includes("--quick");
  const OUT = mkdtempSync(join(tmpdir(), "schellingaf-finish-"));
  const failed = [];
  let number = 0;

  console.log(`Checking this change in the site (${ROOT}) and the product (${API_DIR}).`);
  console.log(`The full output of every step is kept in ${OUT}\n`);
  if (!existsSync(join(API_DIR, "package.json"))) {
    console.log(`Not ready: the product repository is not at ${API_DIR}. Set API_DIR to where it is.`);
    process.exit(1);
  }

  // Ctrl-C reaches the step running then as well, which ends it. The steps that remove
  // what this started (`always`) still run; nothing else after it does.
  let interrupted = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { interrupted = true; });

  // Runs one command with its output in its own file, and prints one line for it.
  async function step(name, command, args, { cwd, env = process.env, always = false }) {
    if (interrupted && !always) return false;
    const log = join(OUT, `${++number}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.log`);
    const out = openSync(log, "w");
    const started = Date.now();
    const r = spawnSync(command, args, { cwd, env, stdio: ["ignore", out, out] });
    closeSync(out);
    // A Ctrl-C that came during the command is only seen once the event loop turns.
    await new Promise((turned) => setImmediate(turned));
    if (interrupted && !always) return false;
    const ok = r.status === 0;
    console.log(`  ${ok ? "passed" : "FAILED"}  ${name}  (${took(Date.now() - started)})`);
    if (!ok) failed.push({ name, log });
    return ok;
  }

  // 1. The product, under a Compose project and port of its own: never its shared test
  // database on 5439, which setting the port alone would recreate and empty.
  const project = `schellingaf-finish-${basename(ROOT).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 60);
  const port = await freePort();
  if (port === 5439) throw new Error("the free port chosen was 5439, the product's default test database port");
  const productEnv = { ...process.env, COMPOSE_PROJECT_NAME: project, TEST_DB_PORT: String(port) };
  try {
    await step("product tests", "npm", ["test"], { cwd: API_DIR, env: productEnv });
    await step("product check", "npm", ["run", "check"], { cwd: API_DIR, env: productEnv });
  } finally {
    await step("product test database removed", "docker", ["compose", "-p", project, "-f", "compose.test.yml", "down", "-v"], { cwd: API_DIR, env: productEnv, always: true });
  }

  // 2 and 3. The site. A stack this checkout already had running holds the code as it
  // was when it started, so it is taken down first and the checks run on the code now.
  await step("site tests", "npm", ["test"], { cwd: ROOT });
  const stackEnv = { ...process.env, API_DIR };
  if (quick) {
    console.log("  skipped the local stack's checks (--quick)");
  } else if (!interrupted) {
    await step("earlier local stack taken down", "npm", ["run", "stack", "--", "down"], { cwd: ROOT, env: stackEnv });
    await step("local stack checks", "npm", ["run", "stack", "--", "verify"], { cwd: ROOT, env: stackEnv });
    await step("local stack taken down", "npm", ["run", "stack", "--", "down"], { cwd: ROOT, env: stackEnv, always: true });
  }
  if (interrupted) {
    console.log("\nNot ready to commit: stopped part way, by Ctrl-C. What it had started has been removed.");
    process.exit(1);
  }

  // 4, 5 and 6, in each repository.
  let approvedMoved = false;
  const approved = {
    site: ["reference/approved-copy.md", "reference/ai-english-style-guide.md", "content/index.md", "content/terms.md", "content/privacy.md"],
    product: ["reference/approved-copy.md", "reference/openapi.json", "content/guide.md", "content/sealed.md", "content/welcome-space.md",
      "content/skills/schellingaf/SKILL.md", "content/keysetup-shell.md", "content/reviewer-rules.md"],
  };
  for (const [label, dir] of [["site", ROOT], ["product", API_DIR]]) {
    const status = lines(git(dir, "status", "--short"));
    console.log(`\n  ${label}: ${status.length ? `${status.length} changed or new path${status.length === 1 ? "" : "s"}, make sure each is yours before committing` : "nothing changed and not committed"}`);
    for (const s of status) console.log(`      ${s}`);

    const found = [];
    for (const f of changedFiles(dir)) for (const where of controlBytes(join(dir, f))) found.push(`${f} ${where}`);
    const log = join(OUT, `${label}-control-characters.log`);
    writeFileSync(log, found.join("\n") + "\n");
    console.log(found.length
      ? `  FAILED  ${label}: invisible control characters in the files this change touched`
      : `  passed  ${label}: no invisible control characters in the files this change touched`);
    for (const f of found) console.log(`      ${f}`);
    if (found.length) failed.push({ name: `the ${label}'s control-character scan`, log });

    const base = git(dir, "merge-base", "main", "HEAD").trim();
    const moved = git(dir, "diff", "--stat", base, "--", ...approved[label]).trimEnd();
    if (moved) {
      approvedMoved = true;
      console.log(`  CHECK   ${label}: the approved-copy files changed; confirm the change was approved:`);
      for (const l of lines(moved)) console.log(`      ${l.trim()}`);
    } else {
      console.log(`  passed  ${label}: the approved-copy files are unchanged`);
    }
  }

  console.log("");
  if (failed.length) {
    console.log(`Not ready to commit: ${failed.map((f) => `${f.name} failed (its output: ${f.log})`).join("; ")}.`);
    process.exit(1);
  }
  const once = [
    quick && "the local stack's checks have passed too (run this again without --quick)",
    approvedMoved && "the approved-copy changes listed above are confirmed as approved",
  ].filter(Boolean);
  console.log(`${quick ? "Everything that ran passed" : "Everything passed"}: the change is ready to commit${once.length ? ` once ${once.join(" and ")}` : ""}.`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.log(`\nNot ready to commit: ${e.message}`);
    process.exit(1);
  }
}
