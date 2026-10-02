// Type-checks src/ against tsconfig.json with a TypeScript checker that is already
// on this machine, and installs nothing: the site has no dependencies.
//
//   npm run typecheck
//   TSC=/opt/homebrew/bin/tsc npm run typecheck    # a particular checker
//
// Which checker, in this order:
//
//   1. the product repository's own, pinned in its package.json, so the two
//      repositories are held to one version. From a git worktree, ../schellingaf-api
//      does not resolve, so the main checkout is found through git's common
//      directory, and the product is the folder beside it.
//   2. tsc on PATH.
//   3. neither: says so in one line and exits 0. A machine with no checker, such as
//      the Docker image, still runs every other check.
//
// Exits with the checker's own code, so a type error fails npm test.

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const executable = (file) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

function productChecker() {
  const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: ROOT, encoding: "utf8" });
  if (git.status !== 0) return null;
  const mainCheckout = dirname(git.stdout.trim());
  const tsc = join(mainCheckout, "..", "schellingaf-api", "node_modules", ".bin", "tsc");
  return executable(tsc) ? tsc : null;
}

function pathChecker() {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && executable(join(dir, "tsc"))) return join(dir, "tsc");
  }
  return null;
}

let tsc = null;
let source = "";
if (process.env.TSC) {
  tsc = process.env.TSC;
  source = "named by TSC";
} else if ((tsc = productChecker())) {
  source = "the product repository's pinned checker";
} else if ((tsc = pathChecker())) {
  source = "tsc on PATH";
}

if (!tsc) {
  console.log("typecheck: skipped, because no TypeScript checker was found: the product repository's (../schellingaf-api/node_modules/.bin/tsc) is not installed and there is no tsc on PATH.");
  process.exit(0);
}

const version = spawnSync(tsc, ["--version"], { encoding: "utf8" });
if (version.status !== 0) {
  console.error(`typecheck: ${tsc} (${source}) did not run: ${(version.stderr || version.error?.message || "").trim()}`);
  process.exit(1);
}
console.log(`typecheck: ${version.stdout.trim()}, ${source} (${tsc})`);

const run = spawnSync(tsc, ["-p", join(ROOT, "tsconfig.json")], { cwd: ROOT, stdio: "inherit" });
if (run.status === 0) console.log("typecheck: no errors in src/");
process.exit(run.status ?? 1);
