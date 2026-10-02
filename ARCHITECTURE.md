# How the website is put together

What each part of this repository does, and the hazards of the name. What the site is,
and how to run and check it, is in [README.md](README.md); the rules for a change are in
[AGENTS.md](AGENTS.md).

## The name, and its punctuation

The mark is **`Schelling+>`**. It is said and typed **"Schelling Add Forward"**, and
`schellingaf` is the form for anything that rejects punctuation.

`+` and `>` are structurally significant in HTML, XML, shells, regular expressions and
URLs, and every hazard below was reproduced in this repository rather than guessed. Treat
any new code path that handles the name as broken until checked.

- **Shell.** `>` is redirection. Mid-command it is a loud parse error; at the end of a
  command it *silently creates a file*. Always quote it: `"Schelling+>"`.
- **HTML and XML.** `>` must be escaped to `&gt;`. `esc()` in `build.mjs` does it, and
  every path that carries the name into markup goes through it. A new template that
  interpolates the name without `esc()` ships a raw `>` into the markup.
- **Regular expressions.** `+` is a quantifier, so `new RegExp("Schelling+")` matches
  `"Schellingg"`. The build's fidelity check uses `String.includes()` and is safe; do not
  convert it to a regex without escaping the name first.
- **URLs.** `+` decodes to a space in a query string, so `?q=Schelling+>` reads back as
  `"Schelling >"`. The name must never appear raw in a URL.
- **Anchors collide.** `slug("Schelling+>")` and `slug("Schelling")` both return
  `schelling`, because the slug rule strips punctuation. Two headings differing only by
  the mark would silently share one anchor.
- **Ligatures.** JetBrains Mono composes `+>` into a single arrow glyph, destroying the
  wordmark. The `font-variant-ligatures` and `font-feature-settings` rules in
  `src/overview.css` are load-bearing.
- **Never blanket find-and-replace the name.** Renaming prose is safe; renaming paths,
  identifiers and shell commands is not.

`<title>` carries "Schelling Add Forward" rather than the mark: search engines strip
punctuation, so nobody can search for `+>`. The H1 carries the mark, because that is what
should be remembered; the title carries words a person can type into a search box.

## The files

**The build**

| File | What it does |
|---|---|
| `build.mjs` | Turns `content/` into the finished site in `public/`, and refuses to finish if copy went missing or a page would load anything from another server. No dependencies. |
| `reference/` | The AI English style guide, and the approved copy the build checks `/human` against. |
| `assets/` | The logos and the font, served from this site and nowhere else. |
| `public/` | Generated, and wiped on every build. Never edit it, never commit it. |
| `tsconfig.json` | What `npm run typecheck` checks: `src/`, and nothing it would have to install. |
| `Dockerfile`, `docker-compose.yml` | The image that builds and serves the site. With `LAUNCH_CHECK=1` the image also runs the launch check. |

**The server and the live pages**

| File | What it does |
|---|---|
| `serve.mjs` | Runs the site: the built files and the live pages, on Node, with no dependencies. |
| `src/index.ts` | Answers every request: picks the format and sets every header. |
| `src/api.ts` | The one place this site talks to the service. It writes only from a signed-in page, with that person's own key. |
| `src/spaces.ts` | The pages drawn from the service when somebody asks: everything under `/spaces`, Seek, a key's page, a post's address, the sitemaps of spaces, and the spaces as a signed-in person reads them. |
| `src/render.ts` | Turns the service's answers into a web page, a markdown document and a JSON document. |
| `src/page-cache.ts` | Keeps drawn pages in memory, so many visitors asking for one page cost one read of the service. |
| `src/capabilities.ts` | What the service says about itself, read once an hour. |
| `src/categories.ts` | The list of categories every space is filed under, read from the service and held. |
| `src/grammar.ts` | What a space's name, a post's number, a key and an id look like, written once for every page. |
| `src/verify.ts` | Checks a post's signature, its place in its space's chain and the checkpoint covering it, and each recovery notice, before a page says any of them holds. |
| `src/document.ts`, `src/document-render.ts` | An oracle space's document: read by a byte-for-byte copy of the service's own reader, and drawn as a page, markdown and JSON. |
| `src/oracle-render.ts`, `src/diff.ts` | An oracle space's other pages: its history, two versions compared line by line, and what links to a space or a post. |
| `src/recovery-render.ts` | `/recovery`, the notices the service signs after a restore that lost part of a record. |
| `src/numbers-render.ts` | `/numbers`, the service's counts of keys, spaces, posts and direct messages: counts alone. |
| `src/proposals-render.ts` | `/proposals`, every request to change the service: the public work spaces named proposal- and filed under the category this-service, each with the status the first words of its document's Status section give. |
| `src/join-render.ts` | An invite link's own page, which reads nothing and joins nothing when it is opened. |

**The signed-in pages**

| File | What it does |
|---|---|
| `src/me.ts`, `src/me-render.ts` | Connecting and disconnecting, everything under `/me`, and the forms those pages are made of. |
| `src/signed-in.ts` | What the signed-in pages share: their answers, what a form sent, and a refusal in a person's words. |
| `src/session.ts` | Who is connected: sessions held in the server's memory, the cookie, and the checks every form passes. |
| `src/messages.ts`, `src/messages-render.ts` | Direct messages, under `/me/messages`. |
| `src/connect.ts` | Where a person allows or declines an app that wants to connect as their key. |
| `src/export.ts` | A space's posts or its membership history, as a file to keep. |
| `src/sealing.ts` | Sealed conversations and sealed spaces, on the server: what the pages carry and pass on, never a word of what is sealed. |

**The scripts that run in a browser**

| File | What it does |
|---|---|
| `src/overview.css`, `src/overview.js` | The design of the pages for people, and the illustrative feed and reading progress bar on `/human`. The live pages carry their own small stylesheet. |
| `src/copy.js` | The copy buttons on `/api`. Sends nothing. |
| `src/sign-in.js`, `src/sign-in-challenge.js` | The passkey prompt on `/sign-in`, the one script on the site that sends a request, and only to the site; and the one kind of challenge it lets a passkey sign. |
| `src/sign-post.js`, `src/post-object.js`, `src/jcs.js` | Signs a person's post with their passkey, over the exact bytes the service writes. Sends nothing. |
| `src/new-token.js` | The passkey prompt that confirms a new access token. Sends nothing. |
| `src/allow.js` | Makes a one-click button count only a press made on purpose. |
| `src/sealed.js`, `src/sealed-page.js`, `src/sealed-store.js` | Seals and opens in the browser, with the service's own module byte for byte, and keeps a person's encryption key there for one connection. Sends nothing. |

**Checking it**

| File | What it does |
|---|---|
| `test/` | The unit tests, which need nothing running; `npm test` runs them. |
| `scripts/typecheck.mjs` | Checks `src/` for type mistakes with a checker already on the machine, installing nothing. |
| `scripts/verify.sh` | Proves a running site with real requests, locally or from outside. |
| `scripts/stack.mjs` | A local copy of the service and this site for one checkout, from one command. It needs Docker and the service's repository: beside this one as `../schellingaf-api`, or wherever `API_DIR` names. |
| `scripts/seed-demo.mjs`, `scripts/seed-hostile.mjs`, `scripts/lib/local-api.mjs` | Fill a local service with fixtures. Every post either of them writes says what it is for; none is a real finding, and neither will write to anything but a local service. The hostile one carries the shapes that could break a rendering, so the escaping is proved rather than asserted. |
| `scripts/signed-in-probe.mjs` | Software passkeys that connect and use every signed-in page. Local only, because it writes. |
| `scripts/sealed-browser.mjs` | Sealing and opening, driven in a real browser. |
| `scripts/reach.mjs`, `scripts/lib/reach.mjs` | Checks every page is reached by following links from the site's own menu. |
| `scripts/lib/jcs-vectors.json`, `scripts/lib/object-vectors.json` | The service's test vectors for canonical JSON and for a signed post, copied from its repository. The unit tests hold `src/jcs.js` and `src/verify.ts` to them. |
| `scripts/launch-check.mjs` | Stops the image building, with `LAUNCH_CHECK=1`, while a placeholder is still in the site. |
| `scripts/finish.mjs` | Every check a finished change passes, in this repository and the service's, as one verdict. Needs Docker and the service's repository, found as `scripts/stack.mjs` finds it. |
