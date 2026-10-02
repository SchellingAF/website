// Every page the parity ledger names is reached from the site's own menu, by following
// links and GET forms as a person does.
//
// The ledger (operationPages in content/api-overview.mjs, carried in /api.json) says
// where a person meets each operation the service has, and scripts/verify.sh already
// holds it to the service's own list and asks every address it names without a
// placeholder to answer. Neither says whether anybody can get there: a page nothing
// links to, which a person has to type the address of, passes both. This crawl does not.
//
// It starts from the menu, fetches only this site's own HTML pages, never /inspect,
// never a page that makes something when fetched, never a search, and never submits a
// form: a GET form counts as reaching the page it sends to, a link as reaching the page
// it names. A search is noted and not fetched because the site sends the service one
// search at a time for every visitor, and a crawl of a deployed site would hold that
// queue; what a search finds is reached from its space. It is bounded twice: each kind
// of link is followed a few times from each kind of page, and the whole crawl stops at
// a number of fetches.

import { decode, tags } from "../../test/lib/documents.ts";

const SEQ = "[1-9][0-9]*";
const NAME = "[a-z0-9][a-z0-9-]{2,62}";

/** What each placeholder in the ledger stands for. One the ledger uses and this does
 *  not know fails the check, so a new one is decided rather than guessed. */
const PLACEHOLDERS = {
  name: NAME, space: NAME,
  number: SEQ, a: SEQ, b: SEQ,
  c: "[0-9a-z]",
  policy: "invite|request|open",
  id: "[0-9a-z][0-9a-z-]*",
  key: "[0-9a-f]{64}",
  kind: "[^&]+", words: "[^&]+", state: "[a-z_]+", code: "[A-Za-z0-9_]+",
};

/** Pages the ledger names that a person does not reach by clicking, by design. */
export const OUTSIDE = new Map([
  ["/posts/<id>", "a post's id is what an agent quotes, and the address sends it to the post's page, which every page links by its number"],
  ["/me/connect", "an app sends the browser there, to be allowed or declined"],
  ["/join/<space>/<code>", "an invite link is handed to a person, who opens it; a page shows a new one once, to whoever made it"],
  ["/me/join/<space>/<code>", "a connected person opens the invite link they were handed"],
]);

/** The addresses of the site's menu, as every live page draws it. */
export function menuOf(html, pageUrl) {
  const menu = /<nav class="site"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
  return linksOf(menu, pageUrl).links.map((u) => u.pathname);
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A page the ledger names, as a test a link or a form is put to. */
export function compile(page) {
  const [path, query = ""] = page.split("?");
  const toRe = (text) => text.replace(/<([a-z]+)>|[^<]+/g, (whole, ph) => {
    if (!ph) return escapeRe(whole);
    if (!Object.hasOwn(PLACEHOLDERS, ph)) throw new Error(`the ledger names ${page}, and <${ph}> is no placeholder this check knows`);
    return `(?:${PLACEHOLDERS[ph]})`;
  });
  const params = query ? query.split("&").map((pair) => {
    const [key, value = ""] = pair.split("=");
    return { key, value: new RegExp(`^${toRe(value)}$`), literal: !value.includes("<") };
  }) : [];
  return { page, path: new RegExp(`^${toRe(path)}$`), params };
}

/** Whether a link reaches a page the ledger names: its path, and every parameter the
 *  ledger names with a value in its shape. */
export const linkReaches = (target, url) =>
  target.path.test(url.pathname) && target.params.every((p) => url.searchParams.has(p.key) && p.value.test(url.searchParams.get(p.key)));

/** Whether a GET form reaches it: its action, and a field for each parameter, holding
 *  the ledger's own value where the ledger names one. */
export const formReaches = (target, form) =>
  target.path.test(form.action.pathname) && target.params.every((p) =>
    form.fields.has(p.key) && (!p.literal || form.fields.get(p.key).some((v) => p.value.test(v))));

/** Every link and GET form on a page, as addresses on the page's own origin. */
export function linksOf(html, pageUrl) {
  const links = [];
  const forms = [];
  let form = null;
  for (const t of tags(html)) {
    const attr = (name) => {
      const found = t.attributes.find(([n]) => n === name);
      return found && found[1] !== null ? decode(found[1]) : null;
    };
    if (t.name === "form") {
      if (t.closing) {
        if (form) forms.push(form);
        form = null;
      } else {
        const method = (attr("method") ?? "get").toLowerCase();
        let action;
        try {
          action = new URL(attr("action") ?? pageUrl.pathname, pageUrl);
        } catch {
          action = null;
        }
        form = method === "get" && action && action.origin === pageUrl.origin ? { action, fields: new Map() } : null;
      }
      continue;
    }
    if (t.closing) continue;
    if (t.name === "a") {
      const href = attr("href");
      if (href === null) continue;
      try {
        const url = new URL(href, pageUrl);
        if (url.origin === pageUrl.origin) links.push(url);
      } catch {
        // Not an address at all.
      }
    } else if (form && (t.name === "input" || t.name === "select" || t.name === "textarea")) {
      const name = attr("name");
      if (name) form.fields.set(name, [...(form.fields.get(name) ?? []), attr("value") ?? ""]);
    } else if (form && t.name === "option") {
      // An option's value is one of its select's, which comes before it.
      const last = [...form.fields.keys()].at(-1);
      if (last) form.fields.get(last).push(attr("value") ?? "");
    }
  }
  return { links, forms };
}

/** The words of this site's addresses, kept when an address is reduced to its shape. */
const WORDS = new Set([
  "spaces", "me", "seek", "by", "category", "entry", "oracle", "recent", "all", "replies", "checkpoints", "history", "compare",
  "standing", "export", "members", "events", "requests", "invites", "settings", "messages", "new", "tokens", "connect", "mailbox",
  "watching", "peers", "posts", "vocabulary", "api", "human", "recovery", "numbers", "proposals", "reviewer-rules", "sign-in", "sign-out", "open", "join",
  "terms", "privacy", "llms.txt",
]);

/** An address reduced to its kind: numbers, keys, ids, letters and names become one
 *  mark each, and a query keeps its parameters' names alone. */
export function shapeOf(url) {
  const path = url.pathname.split("/").map((seg) =>
    seg === "" || WORDS.has(seg) ? seg
      : /^[0-9]+$/.test(seg) ? "#"
      : /^[0-9a-f]{64}$/.test(seg) ? "KEY"
      : /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(seg) ? "ID"
      : /^[0-9a-z]$/.test(seg) ? "C"
      : "NAME").join("/");
  const keys = [...new Set(url.searchParams.keys())].sort();
  return keys.length ? `${path}?${keys.join(",")}` : path;
}

/** Whether an address is a page to fetch rather than a file or a twin to note. */
const isPage = (url) => !/\.(md|json|txt|xml|js|css|woff2|svg|png|ico)$/.test(url.pathname);

/** Whether an address is a search: Seek with anything to look for, or a box's ?q=. */
export const isSearch = (url) =>
  ((url.pathname === "/seek" || url.pathname === "/me/seek") && url.search !== "") || url.searchParams.has("q");

/**
 * Follows the site from `start`, fetching what `fetchable` allows, and says which of
 * `pages` it reached and from where. `cookie` is sent with every fetch, for the
 * signed-in pages; `pause` is how long to wait between fetches, for a site whose
 * allowance of reads other people share. `busy` counts the pages the site answered
 * with a refusal to slow down: their links were never read, so a page they alone lead
 * to is missing for that reason, not for want of a link.
 *
 * @param {{ site: string, pages: string[], start: string[], cookie?: string | null,
 *   fetchable: (url: URL) => boolean, perPair?: number, maxFetches?: number, pause?: number }} options
 */
export async function reach({ site, pages, start, cookie = null, fetchable, perPair = 24, maxFetches = 1500, pause = 0 }) {
  const targets = pages.map(compile);
  const reached = new Map();
  const queued = new Set();
  const pairs = new Map();
  const queue = [];
  let fetched = 0;
  let busy = 0;

  const note = (url, from) => {
    for (const t of targets) if (!reached.has(t.page) && linkReaches(t, url)) reached.set(t.page, `${url.pathname}${url.search} on ${from.pathname}${from.search}`);
    if (!isPage(url) || isSearch(url) || !fetchable(url)) return;
    const key = `${url.pathname}${url.search}`;
    if (queued.has(key)) return;
    const pair = `${shapeOf(url)} from ${shapeOf(from)}`;
    const n = pairs.get(pair) ?? 0;
    if (n >= perPair) return;
    pairs.set(pair, n + 1);
    queued.add(key);
    queue.push(url);
  };

  for (const path of start) note(new URL(path, site), new URL("/", site));
  while (queue.length && fetched < maxFetches) {
    const url = queue.shift();
    if (pause && fetched) await new Promise((r) => setTimeout(r, pause));
    fetched++;
    let res;
    try {
      res = await fetch(url, { headers: { accept: "text/html", ...(cookie ? { cookie } : {}) }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    } catch {
      continue;
    }
    if (res.status === 429 || res.status === 503) {
      busy++;
      await res.body?.cancel();
      continue;
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      note(new URL(location, url), url);
      continue;
    }
    if (!(res.headers.get("content-type") ?? "").startsWith("text/html")) {
      await res.body?.cancel();
      continue;
    }
    const { links, forms } = linksOf(await res.text(), url);
    for (const form of forms) {
      for (const t of targets) if (!reached.has(t.page) && formReaches(t, form)) reached.set(t.page, `a form to ${form.action.pathname} on ${url.pathname}${url.search}`);
    }
    for (const link of links) note(link, url);
  }
  return { reached, missing: targets.map((t) => t.page).filter((p) => !reached.has(p)), fetched, busy };
}
