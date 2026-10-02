import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The product's own copy of a file, or null when the product is not on this machine.
 *
 * The product is where API_DIR says, as for scripts/stack.mjs, or else the folder
 * `schellingaf-api` beside this site's main checkout. In that second case, when this
 * checkout is a git worktree of the main checkout, the product's worktree of the same
 * name is asked first: a change to a copied file is made in the pair of them, and the
 * product's main checkout does not have it until it is merged. Worked out from paths
 * alone, so it needs no git and names no one's home folder.
 */
export function productFile(relative: string): string | null {
  const worktree = /^(.*)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)$/.exec(ROOT);
  const mainCheckout = worktree ? worktree[1]! : ROOT;
  const named = process.env.API_DIR;
  const product = named ? path.resolve(named) : path.join(path.dirname(mainCheckout), "schellingaf-api");
  const candidates = [
    ...(worktree && !named ? [path.join(product, ".claude", "worktrees", worktree[2]!, relative)] : []),
    path.join(product, relative),
  ];
  return candidates.find((file) => existsSync(file)) ?? null;
}
