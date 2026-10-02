// The public half of the reachability check in scripts/lib/reach.mjs, as
// scripts/verify.sh runs it: every page the parity ledger names that a visitor can
// open, reached by following links and GET forms from the site's own menu. The pages
// under /me are the signed-in probe's to reach, with a session.
//
//   node scripts/reach.mjs SITE
//
// Prints one line for scripts/verify.sh to relay: ok, or FAIL naming every page not
// reached, and a skip for each page that is entered from outside by design.
//
// It crawls this machine only, unless REACH_REMOTE=1: every page it asks a deployed
// site for that nobody asked for lately costs the product reads that visitors share,
// and the pages are the same code here. Asked to, it waits half a second between pages.

import { isThisMachine } from "./lib/local-api.mjs";
import { menuOf, OUTSIDE, reach } from "./lib/reach.mjs";

const SITE = (process.argv[2] ?? "").replace(/\/+$/, "");
const NAME = "every page the ledger names is reached from the menu";
const local = isThisMachine(SITE);
if (!local && process.env.REACH_REMOTE !== "1") {
  console.log(`skip ${NAME}\tthe crawl asks a site for hundreds of pages, so it runs against this machine; REACH_REMOTE=1 runs it against ${SITE}, slowly`);
  process.exit(0);
}

const api = await (await fetch(`${SITE}/api.json`)).json();
const pages = [...new Set((api.operations ?? []).flatMap((o) => o.pages ?? []))];
const open = pages.filter((p) => !p.startsWith("/me") && !OUTSIDE.has(p));

// The menu, as the site draws it on every live page.
const start = menuOf(await (await fetch(`${SITE}/seek`)).text(), new URL("/seek", SITE));
if (start.length < 5) {
  console.log(`FAIL ${NAME}\tthe menu on /seek has ${start.length} links`);
  process.exit(0);
}

const { missing, fetched, busy } = await reach({
  site: SITE, pages: open, start, pause: local ? 0 : 500,
  fetchable: (url) => !url.pathname.startsWith("/inspect") && url.pathname !== "/me" && !url.pathname.startsWith("/me/") && !url.pathname.startsWith("/sign-out"),
});
for (const [page, why] of OUTSIDE) if (pages.includes(page)) console.log(`skip ${page} is reached from the menu\tentered from outside by design: ${why}`);
console.log(!missing.length
  ? `ok every page the ledger names that a visitor opens is reached from the menu: ${open.length} of them, ${fetched} pages fetched`
  : busy
    ? `skip ${NAME}\tthe site answered ${busy} of ${fetched} pages busy, so their links went unread, and these were not reached: ${missing.join(", ")}`
    : `FAIL ${NAME}\tnot reached by following links and forms from the menu: ${missing.join(", ")}`);
