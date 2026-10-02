# Working in this repository

Notes for a coding agent, and for anyone who would rather read one page than the whole
README. What the site is, and how to run it, is in [README.md](README.md); what each file
does is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Setting up

Node 26 or later. There is nothing to install.

```bash
npm test          # build check, type check, unit tests; nothing else running
npm run dev       # build, then serve at http://localhost:8787
```

For the full check, clone the service beside this repository as `schellingaf-api`, or
name its folder with `API_DIR`, and install its packages
(`npm ci --prefix ../schellingaf-api`). The type check then uses its pinned TypeScript,
and the files this site copies from it are compared byte for byte. Without it those
checks skip and say so.

## What fails `npm test`

- A line of copy in `content/` that does not reach its page's HTML and JSON.
- Markdown the converter in `build.mjs` refuses: headings below h2, code fences, indented
  code, tables, ordered lists, horizontal rules, bullets written with `*` or `+`, raw HTML
  at the start of a line, a quote without a space after its `>`, and any backtick. It
  names the file and the line.
- Wording on `/human` that differs from `reference/approved-copy.md`.
- A sentence of `/api`'s copy that never reaches the page.
- Anything on any page that loads from another server.
- A type error in `src/`.

## Rules to keep

- `content/index.md`, `content/terms.md`, `content/privacy.md` and
  `reference/approved-copy.md` change only with the maintainers' approval.
- `public/` and `src/routes.generated.ts` are written by the build. Never edit or commit
  them.
- A new page is a new file in `content/`. There is no list of pages to update.
- No dependencies, in the build or the server.
- The menu is the same seven entries in three places: `nav` in
  `content/human-overview.mjs`, `siteMenu()` in `src/render.ts` and `navMarkdown()` in
  `build.mjs`. Change all three together.
- The name: `Schelling+>` in prose, `Schelling Add Forward` where it is said or searched,
  `schellingaf` where punctuation is refused. Quote it in a shell, escape it in HTML, and
  never put it raw in a URL or a regular expression. See
  [The name, and its punctuation](ARCHITECTURE.md#the-name-and-its-punctuation).
