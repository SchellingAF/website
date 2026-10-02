// Refuses to let the site go live while a placeholder is still in it.
//
// Every blank in this project is a deliberate one. The pattern the repository
// follows is that a placeholder must FAIL rather than quietly ship something that
// looks real: CONTACT-TBD reads as a blank to anybody who sees it, where a
// plausible address would be mistaken for a live one.
//
// A blank only fails if something checks for it, so this is the list of them,
// executed: the production image runs it while it is built (LAUNCH_CHECK=1), so a
// placeholder cannot reach the domain even by accident.
//
// It deliberately does NOT run inside `npm run build` or `npm run dev`. Working
// locally with placeholders in place is normal; the gate belongs at the moment of
// publishing, not of building.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

// Each blank, with what has to happen before it can go. The reason is printed with
// the hit, because a failure that only says "found HANDLE-TBD" tells the person
// reading it nothing about who has to do what.
// `patterns` is a list because one blank can be spelled differently in different
// places, as the reserved API block is "[API instructions reserved" on the agent page
// and "[Reserved for API instructions" on the human page: one of them matching is one
// blank, not two.
const BLANKS = [
  {
    patterns: ["HANDLE-TBD"],
    what: "the Connect link on every human page",
    fix: "CONNECT_URL in content/human-overview.mjs points at /sign-in. A hit here means the placeholder came back.",
  },
  {
    patterns: ["CONTACT-TBD"],
    what: "the operator's contact address, in the footer and in the terms",
    fix: "The contact address is schellingaf@proton.me, the address the terms and the privacy policy publish. It is footer.contact in content/human-overview.mjs, so every page for people shows it, and the product sets the same address as OPERATOR_CONTACT, which GET /v1/capabilities publishes. A hit here means the placeholder came back.",
  },
  {
    patterns: ["ENTITY-TBD"],
    what: "the entity that operates the service and publishes the terms",
    fix: "No operating entity is named in the terms or the privacy policy. A hit here means the placeholder came back.",
  },
  {
    patterns: ["[API instructions reserved", "[Reserved for API instructions"],
    what: "the reserved API block in the approved copy",
    fix: "Both pages name api.schellingaf.com. A hit here means the reserved block came back.",
  },
  {
    patterns: ["COPY-UNCONFIRMED"],
    what: "wording on /human that has not been approved",
    fix: "Wording on /human that has not been approved. What clears it is approval, not an edit.",
  },
  {
    patterns: ["EXAMPLE-DOMAIN-TBD"],
    what: "the site's own domain",
    fix: "The domain is SITE in build.mjs. A hit here means the placeholder came back.",
  },
];

// Files whose bytes are not text and cannot carry a placeholder.
const BINARY = new Set([".png", ".woff2", ".jpg", ".jpeg", ".gif", ".ico", ".webp"]);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (!BINARY.has(extname(name).toLowerCase())) acc.push(p);
  }
  return acc;
}

// A gate that cannot read a file must not report it clean: an unreadable file -- a
// permissions change, a rename, a bad path -- would otherwise let the deploy run with
// a placeholder never looked at. A check that fails open is worse than no check,
// because it is believed.
function scan(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`\nLAUNCH CHECK CANNOT RUN\n\n  Could not read ${file}: ${e.message}`);
    console.error("  A check that cannot finish counts as failed, and the production image does not build while it fails.\n");
    process.exit(2);
  }
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const b of BLANKS) {
      if (b.patterns.some((pat) => line.includes(pat))) {
        hits.push({ file, line: i + 1, blank: b, text: line.trim().slice(0, 100) });
      }
    }
  });
  return hits;
}

// public/ is what actually gets served, so it is the authority on what would ship.
let targets;
try {
  targets = [...walk("public"), "reference/approved-copy.md"];
} catch {
  console.error("\nLAUNCH CHECK CANNOT RUN\n\n  public/ does not exist. Run `npm run build` first.\n");
  process.exit(2);
}

const hits = targets.flatMap((f) => scan(f));

if (!hits.length) {
  console.log(`\nlaunch check: clean. ${targets.length} files scanned, none of the ${BLANKS.length} blanks remain.\n`);
  process.exit(0);
}

// Grouped by blank rather than by file: the person reading this has to make one
// decision per blank, not one per line, and the same placeholder usually appears
// on several pages.
const byBlank = new Map();
for (const h of hits) {
  const key = h.blank.patterns[0];
  if (!byBlank.has(key)) byBlank.set(key, []);
  byBlank.get(key).push(h);
}

console.error(`\nNOT READY TO GO LIVE\n\n  ${byBlank.size} blank(s) still in the built site, in ${new Set(hits.map((h) => h.file)).size} file(s).\n`);
for (const [name, group] of byBlank) {
  const b = group[0].blank;
  console.error(`  ${name}  --  ${b.what}`);
  for (const h of group.slice(0, 6)) console.error(`      ${h.file}:${h.line}  ${h.text}`);
  if (group.length > 6) console.error(`      ... and ${group.length - 6} more`);
  console.error(`      ${b.fix}\n`);
}
console.error("  The production image does not build while any of these remain.\n");
process.exit(1);
