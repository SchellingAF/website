#!/bin/sh
# Proves the site with real requests instead of assuming.
#
# The checks a person would otherwise run with curl after a change -- that "/"
# returns HTML, that Accept: text/markdown returns markdown, that Vary: Accept is
# there, that a repeat request with the ETag gives a 304, that an unknown URL gives
# a real 404 -- and everything below. A list a person runs by hand gets run until
# the day it matters; this one runs every time.
#
# Run it against anything:
#
#   sh scripts/verify.sh                              # npm run dev, on :8787
#   SITE=http://localhost:8787 sh scripts/verify.sh
#   SITE=https://schellingaf.com sh scripts/verify.sh # after a deploy, from outside
#
# POSIX sh, curl, awk and python3, which a Mac and any Linux server already have.
# No grep -P (BSD grep on macOS does not have it), no bash arrays and no jq, so it
# runs from a machine that has never built the site. Node is needed only by the
# signed-in checks, which run a software passkey against this machine and say skip
# where there is no node. Basic-regex grep is used unless a check says otherwise,
# where "+" is a literal character -- which matters, because the mark is
# Schelling+> and the whole point of some of these checks is to find it spelled
# exactly that way.
#
# The mark is ALWAYS single-quoted here. Unquoted, ">" is shell redirection: mid
# command it is a parse error, and at the end of a command it silently creates a
# file and prints nothing.

SITE="${SITE:-http://localhost:8787}"
SITE="${SITE%/}"
# The canonical host, taken from what the build generated rather than repeated
# here, so the domain lives in exactly one place: SITE in build.mjs. The literal
# is the fallback for running this against a deployed site from a machine that
# does not have the repository.
if [ -z "${CANONICAL_HOST:-}" ] && [ -r "$(dirname "$0")/../src/routes.generated.ts" ]; then
  CANONICAL_HOST=$(sed -n 's/.*CANONICAL_HOST = "\([^"]*\)".*/\1/p' \
    "$(dirname "$0")/../src/routes.generated.ts")
fi
CANONICAL_HOST="${CANONICAL_HOST:-schellingaf.com}"

# The product's origin as this site names it, read from the copy module that owns
# it. Both pages name it in a link rather than in prose, so a live site whose API
# is not answering sends every reader to nothing. API_ORIGIN, where this run asks
# the product itself, is the named one unless it is set.
if [ -r "$(dirname "$0")/../content/api-overview.mjs" ]; then
  NAMED_API=$(sed -n 's/.*export const API_ORIGIN = "\([^"]*\)".*/\1/p' \
    "$(dirname "$0")/../content/api-overview.mjs")
fi
NAMED_API="${NAMED_API:-https://api.schellingaf.com}"
API_ORIGIN="${API_ORIGIN:-$NAMED_API}"

if ! command -v curl >/dev/null 2>&1; then
  echo "verify: curl is not installed." >&2
  exit 2
fi

pass=0
fail=0
skip=0
ok()  { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL  %s\n          %s\n' "$1" "$2"; }
# A skip is counted and printed, never folded into the passes. A check that
# quietly stops running is worse than one that fails.
skipped() { skip=$((skip + 1)); printf '  skip  %s\n          %s\n' "$1" "$2"; }

# status URL [curl args...] -- prints the status code the address answers with.
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
headers() { curl -s -D - -o /dev/null "$@"; }

# has_header NAME VALUE-SUBSTRING URL [curl args...]  -- case-insensitive on the name
has_header() {
  name="$1"; want="$2"; shift 2
  headers "$@" | grep -i "^$name:" | grep -q "$want"
}

# header_value NAME URL [curl args...] -- the header's value, trimmed.
header_value() {
  name="$1"; shift
  headers "$@" | grep -i "^$name:" | sed 's/^[^:]*: *//' | tr -d '\r\n'
}

# fingerprint_link PAGE -- the search a post's page links from its first
# fingerprint, as a browser would follow it: taken from the page, never typed here.
fingerprint_link() {
  curl -s "$SITE$1" | sed -n 's/.*<a class="tag" href="\(\/seek?fingerprint=[^"]*\)".*/\1/p' | head -1 | sed 's/&amp;/\&/g'
}

# alt ROUTE EXT -- a page's markdown or JSON address: the extension goes on the path,
# before any query string, and the homepage's are /index.md and /index.json.
alt() {
  case "$1" in
    /) echo "/index$2" ;;
    *\?*) echo "${1%%\?*}$2?${1#*\?}" ;;
    *) echo "$1$2" ;;
  esac
}

# THE SHAPES MOST CHECKS TAKE, written once: one request, one expectation, and the
# check's name. A function in sh shares every variable with its caller, so these keep
# theirs under names beginning with an underscore, which no check uses. Checks that
# ask more than one thing, or whose pass line says more than their name, are written
# out where they are.
#
# expect CODE NAME URL [curl args...] -- the address answers with that status.
expect() {
  _e_code=$1; _e_name=$2; shift 2
  _e_got=$(status "$@")
  if [ "$_e_got" = "$_e_code" ]; then ok "$_e_name"; else bad "$_e_name" "got $_e_got"; fi
}

# expect_prefix NAME HEADER PREFIX URL [curl args...] -- the header's value starts so.
expect_prefix() {
  _p_name=$1; _p_header=$2; _p_want=$3; shift 3
  if header_starts "$_p_header" "$_p_want" "$@"; then
    ok "$_p_name"
  else
    bad "$_p_name" "wanted $_p_header starting '$_p_want', got '$(header_value "$_p_header" "$@")'"
  fi
}

# expect_header NAME HEADER TEXT URL [curl args...] -- the header carries the text.
# refuse_header NAME HEADER TEXT URL [curl args...] -- the header does not carry it.
expect_header() {
  _h_name=$1; _h_header=$2; _h_want=$3; shift 3
  if has_header "$_h_header" "$_h_want" "$@"; then
    ok "$_h_name"
  else
    bad "$_h_name" "wanted $_h_header carrying '$_h_want', got '$(header_value "$_h_header" "$@")'"
  fi
}
refuse_header() {
  _h_name=$1; _h_header=$2; _h_want=$3; shift 3
  if has_header "$_h_header" "$_h_want" "$@"; then
    bad "$_h_name" "its $_h_header carries '$_h_want': '$(header_value "$_h_header" "$@")'"
  else
    ok "$_h_name"
  fi
}

# expect_body NAME URL PATTERN [grep options...] -- a line of the page matches.
# refuse_body NAME URL PATTERN [grep options...] -- no line of the page matches.
# The pattern is a basic regular expression unless an option such as -E or -F says
# otherwise.
expect_body() {
  _b_name=$1; _b_url=$2; _b_pattern=$3; shift 3
  if curl -s "$_b_url" | grep -q "$@" -e "$_b_pattern"; then
    ok "$_b_name"
  else
    bad "$_b_name" "nothing on $_b_url matches '$_b_pattern'"
  fi
}
refuse_body() {
  _b_name=$1; _b_url=$2; _b_pattern=$3; shift 3
  _b_hit=$(curl -s "$_b_url" | grep "$@" -e "$_b_pattern" | head -1 | cut -c1-200)
  if [ -n "$_b_hit" ]; then bad "$_b_name" "$_b_url carries: $_b_hit"; else ok "$_b_name"; fi
}

# relay NAME WHAT OUTPUT -- counts what a program this file runs reported, one line
# each: "ok NAME", "FAIL NAME<tab>DETAIL" or "skip NAME<tab>REASON". Any other line
# fails NAME, saying that WHAT printed it.
TAB=$(printf '\t')
relay() {
  _r_name=$1; _r_what=$2
  while IFS= read -r _r_line; do
    case "$_r_line" in
      "ok "*) ok "${_r_line#ok }" ;;
      "FAIL "*) _r_rest=${_r_line#FAIL }; bad "${_r_rest%%"$TAB"*}" "${_r_rest#*"$TAB"}" ;;
      "skip "*) _r_rest=${_r_line#skip }; skipped "${_r_rest%%"$TAB"*}" "${_r_rest#*"$TAB"}" ;;
      *) bad "$_r_name" "$_r_what printed something unexpected: $_r_line" ;;
    esac
  done <<EOF
$3
EOF
}

# WHAT COUNTS AS AGENT TEXT ESCAPING DIFFERS BY FORMAT, and a single grep for
# "<script>" across all three is wrong: in markdown and in JSON those are characters,
# not markup, and the hostile fixtures are supposed to contain them.
#
#   escapes_html ADDRESS  a raw script tag or event handler is the defect.
#   keeps_fenced ADDRESS  becoming STRUCTURE is the defect, so every one of them must
#                         sit inside a fenced block or a code span. Checked by
#                         tracking fences with OUTSIDE_FENCES, below, because a grep
#                         cannot tell inside from outside.
#   parses_json ADDRESS   a document that no longer parses is the defect.
escapes_html() {
  _t_body=$(curl -s "$SITE$1")
  if printf '%s\n' "$_t_body" | grep -q '<script>alert'; then
    bad "$1 escapes what agents wrote" "a raw <script> reached the markup"
  elif printf '%s\n' "$_t_body" | grep -q '<img src=x onerror'; then
    bad "$1 escapes what agents wrote" "a raw <img onerror> reached the markup"
  else
    ok "$1 escapes what agents wrote"
  fi
}
keeps_fenced() {
  _t_loose=$(curl -s "$SITE$1" | awk "$OUTSIDE_FENCES")
  if [ -n "$_t_loose" ]; then
    bad "$1 keeps agent text inside a fence" "$(printf '%s\n' "$_t_loose" | head -1)"
  else
    ok "$1 keeps agent text inside a fence"
  fi
}
parses_json() {
  if curl -s "$SITE$1" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
    ok "$1 is still valid JSON with hostile content in it"
  else
    bad "$1 is still valid JSON with hostile content in it" "it no longer parses"
  fi
}

# What a public address must never carry, whatever key the site read with: a
# member's counts and fields about a space, including a listing's "3 members", and
# a member's view of a post.
PRIVILEGE='"(head_seq|member_count|revision|updated_at|access)"|^- (members|posts):|<dt>members</dt>|&middot; [0-9]+ (member|post)'
MEMBER_VIEW='"run_id"|"(budget|data)": \{|<summary class="meta">(budget|data)'

# header_starts NAME PREFIX URL [curl args...]
#
# Substring matching is wrong for a header whose opposite CONTAINS it: "index"
# matches "noindex, nofollow", so a one-word edit telling every crawler to stay
# away would pass. Anchor at the start of the value.
header_starts() {
  name="$1"; want="$2"; shift 2
  v=$(header_value "$name" "$@")
  case "$v" in "$want"*) return 0 ;; *) return 1 ;; esac
}

# An awk program that prints every line of a markdown document where outside text
# escaped into the document itself: a tag, the link the search check sends, or one
# of the fixtures' headings, anywhere outside a fenced block and outside an inline
# code span.
#
# A fence closes only on a run of backticks at least as long as the one that
# opened it, so a three-tick fence inside a fixture's body does not close the
# site's four-tick fence around it.
#
# A code span closes only on the next run of exactly as many backticks, as
# CommonMark has it, and a run that finds none is text: a span around words holding
# backticks is one span, and text between two runs of different lengths is no span.
OUTSIDE_FENCES='
  function unspan(s,    out, n, start, rest, at, found) {
    out = ""
    while (match(s, /`+/)) {
      start = RSTART; n = RLENGTH
      out = out substr(s, 1, start - 1)
      rest = substr(s, start + n)
      at = 0; found = 0
      while (match(substr(rest, at + 1), /`+/)) {
        at += RSTART + RLENGTH - 1
        if (RLENGTH == n) { found = 1; break }
      }
      if (found) s = substr(rest, at + 1)
      else { out = out substr(s, start, n); s = rest }
    }
    return out s
  }
  /^`+$/ {
    if (!open) { open = length($0); next }
    if (length($0) >= open) { open = 0; next }
  }
  open { next }
  { line = unspan($0) }
  line ~ /<script/ || line ~ /<img [^>]*onerror/ || line ~ /\]\(\/\/e\.example/ { print NR": "$0; next }
  line ~ /^#+ (a heading after the break|A heading that is not ours|and a heading after the break)/ { print NR": "$0 }
'

echo
echo "verifying $SITE"
echo

# ---------------------------------------------------------------- reachability
if [ "$(status "$SITE/")" != "200" ]; then
  echo "  FAIL  nothing is answering at $SITE"
  echo "          Start it with: cd $(pwd) && npm run dev"
  echo
  exit 1
fi

# ------------------------------------------------------------ the pages to check
#
# Read from the site itself rather than typed here. The pages sitemap lists every
# page the build made, and each page's JSON says who it is written for, so a new
# page is checked from the day it is built. /spaces, /spaces/by/oracle, /vocabulary
# /reviewer-rules, /numbers and /proposals are in that sitemap too; they are not files, and
# their checks come further down.
PAGES=$(curl -s "$SITE/sitemap-pages.xml" | sed -n 's|.*<loc>[a-z]*://[^/]*\(/[^<]*\)</loc>.*|\1|p' | grep -v -e '^/spaces$' -e '^/spaces/by/oracle$' -e '^/vocabulary$' -e '^/reviewer-rules$' -e '^/numbers$' -e '^/proposals$')
case " $(echo $PAGES) " in
  *" / "*) ;;
  *) echo "  FAIL  could not read the list of pages from $SITE/sitemap-pages.xml"; echo; exit 1 ;;
esac
HUMAN_PAGES=""
AGENT_PAGES=""
for p in $PAGES; do
  audience=$(curl -s "$SITE$(alt "$p" .json)" | python3 -c 'import json,sys; print(json.load(sys.stdin)["audience"])' 2>/dev/null)
  case "$audience" in
    human) HUMAN_PAGES="$HUMAN_PAGES $p" ;;
    agent) AGENT_PAGES="$AGENT_PAGES $p" ;;
    *) echo "  FAIL  $SITE$(alt "$p" .json) does not say who $p is written for"; echo; exit 1 ;;
  esac
done
echo "  pages:" $PAGES
echo

# ------------------------------------------------- one address, three formats
#
# This is the whole pitch: the same URL serves a web page to a browser and plain
# markdown to an agent that asks for it. If only one check in this file matters,
# it is this one.
for route in $PAGES; do
  expect 200 "$route returns 200" "$SITE$route"
  expect_header "$route is HTML by default" content-type text/html "$SITE$route"
  expect_header "$route serves markdown when asked" content-type text/markdown "$SITE$route" -H 'Accept: text/markdown'
  expect_header "$route serves JSON when asked" content-type application/json "$SITE$route" -H 'Accept: application/json'
  # Without this a cache can hand markdown to a browser and HTML to an agent.
  expect_header "$route varies on Accept" vary Accept "$SITE$route"
  # So an agent can find the cheap format from a HEAD, without fetching the page.
  expect_header "$route advertises its alternates" link 'rel="alternate"' "$SITE$route"
done

# ------------------------------------------------------------- the .md and .json
for f in $(for p in $PAGES; do echo "$(alt "$p" .md) $(alt "$p" .json)"; done) \
         /llms.txt /robots.txt /sitemap.xml; do
  expect 200 "$f returns 200" "$SITE$f"
done
expect_header "/index.md is typed as markdown" content-type text/markdown "$SITE/index.md"

# --------------------------------------------------------- cheap re-checking
#
# An agent that has already read a page should be able to ask "changed?" and be
# told no, without paying for the page again.
etag=$(header_value etag "$SITE/")
if [ -n "$etag" ]; then
  ok "/ returns an ETag"
  expect 304 "the same ETag gives a 304" "$SITE/" -H "If-None-Match: $etag"
  size=$(curl -s -o /dev/null -w '%{size_download}' -H "If-None-Match: $etag" "$SITE/")
  [ "$size" = "0" ] && ok "the 304 carries no body" || bad "the 304 carries no body" "$size bytes"
else
  bad "/ returns an ETag" "no ETag header"
fi

expect_header "/ must be revalidated" cache-control must-revalidate "$SITE/"

# ------------------------------------------------------------ the two policies
#
# Agent pages load NOTHING -- no script, no font, no image -- and their policy
# says so. Pages designed for a person load this origin's font and logos, and
# need the relaxed one. Applying the strict policy to a designed page silently
# breaks it, so which page gets which is worth asserting rather than trusting.
# The 200 is asserted first. A route that 404s has no script-src either, so
# without this the check would report a missing page as a page that loads
# nothing -- passing, on a site where the page is gone.
for route in $AGENT_PAGES $(for p in $PAGES; do alt "$p" .md; done) /llms.txt; do
  c=$(status "$SITE$route")
  if [ "$c" != "200" ]; then
    bad "$route loads nothing" "the route itself returned $c, so there was nothing to check"
  elif has_header "content-security-policy" "script-src" "$SITE$route"; then
    bad "$route loads nothing" "its policy permits a script; it should be the strict one"
  else
    ok "$route loads nothing"
  fi
done
for route in $HUMAN_PAGES; do
  if [ "$(status "$SITE$route")" != "200" ]; then
    bad "$route may load this origin's own assets" "the route itself is not there"
  elif has_header "content-security-policy" "script-src 'self'" "$SITE$route"; then
    ok "$route may load this origin's own assets"
  else
    bad "$route may load this origin's own assets" "it got the strict policy and will render without its font"
  fi
done

for h in "x-content-type-options:nosniff" "referrer-policy:no-referrer" "x-robots-tag:index,"; do
  expect_prefix "/ sends ${h%%:*}" "${h%%:*}" "${h#*:}" "$SITE/"
done

# ------------------------------------------------------------- one canonical host
#
# Against a real origin, ask the www name itself. Against a local server, send
# the www name as the Host header: serve.mjs builds the request's address from
# that header, exactly as it does behind the proxy, so the same branch fires.
case "$SITE" in
  https://*)
    redirect_code=$(status "https://www.$CANONICAL_HOST/terms")
    redirect_to=$(header_value location "https://www.$CANONICAL_HOST/terms")
    ;;
  *)
    redirect_code=$(status -H "Host: www.$CANONICAL_HOST" "$SITE/terms")
    redirect_to=$(header_value location -H "Host: www.$CANONICAL_HOST" "$SITE/terms")
    ;;
esac
[ "$redirect_code" = "301" ] \
  && ok "www redirects to the apex" || bad "www redirects to the apex" "got $redirect_code"
[ "$redirect_to" = "https://$CANONICAL_HOST/terms" ] \
  && ok "the redirect names the apex over https, keeping the path" \
  || bad "the redirect names the apex over https, keeping the path" "got '$redirect_to'"

# HSTS is only legal on a secure response, so it is only asserted on one.
case "$SITE" in
  https://*)
    expect_header "HTTPS is pinned for two years" strict-transport-security max-age=63072000 "$SITE/"
    ;;
  *)
    if has_header "strict-transport-security" "max-age" "$SITE/"; then
      bad "no HSTS over plain http" "RFC 6797 forbids the header on a non-secure response"
    else
      ok "no HSTS over plain http (asserted against an https origin instead)"
    fi
    ;;
esac

# -------------------------------------------------------------------- a real 404
expect 404 "an unknown address is a real 404" "$SITE/no-such-page-here"
expect_body "the 404 says where the index is" "$SITE/no-such-page-here" 'llms.txt'
# The not-found page is not an address of its own: asked for by name it would
# answer 200 and could be listed. Nor is it ever an empty 404: asked for with a
# conditional header, the file server's 304 would go out as a 404 with no body.
expect 404 "/404 is not a page" "$SITE/404"
expect 404 "/404.html is not a page" "$SITE/404.html"
expect 404 "a 404 asked for conditionally is still a 404" "$SITE/no-such-page-here" -H 'If-None-Match: *'
# A missing address is no page to list, as a live page that did not render is not.
expect_prefix "a 404 tells a crawler not to list it" x-robots-tag "noindex, nofollow" "$SITE/no-such-page-here"
if curl -s -H 'If-None-Match: *' "$SITE/no-such-page-here" | grep -q 'llms.txt'; then
  ok "a 404 asked for conditionally still carries its page"
else
  bad "a 404 asked for conditionally still carries its page" "it came back with no body"
fi

# ------------------------------------------------------------------- the mark
#
# ">" must reach markup as &gt;. A new template that interpolates the name
# without escaping it ships a raw ">" into the HTML, which is invisible until
# something downstream parses it.
for route in $PAGES; do
  refuse_body "$route escapes the mark" "$SITE$route" 'Schelling+>'
done
expect_body "/ still carries the mark, escaped" "$SITE/" 'Schelling+&gt;'

# ------------------------------------------------------- the host this site names
#
# Only against a deployed site. The agent page links the API's primer and every
# page for people links /api, whose own links point there, so publishing this
# site while that host is silent points every one of those at nothing. Locally
# there is nothing to check: neither host exists.
case "$SITE" in
  https://*)
    c=$(status --max-time 10 "$API_ORIGIN/")
    if [ "$c" = "200" ]; then
      ok "the API this site names is answering"
    else
      bad "the API this site names is answering" \
        "$API_ORIGIN/ returned $c. Every link to it on / and /api is dead."
    fi
    ;;
  *)
    skipped "the API this site names is answering" \
      "neither host exists locally; checked against a deployed site"
    ;;
esac

# ------------------------------------------------------- the dynamic routes
#
# /spaces and /inspect are not files. They are rendered by the server from the
# product's JSON at the moment somebody asks, so unlike every check above them
# they depend on a second service being up. When it is not, the site answers
# 503 and says so -- which is correct behaviour and not something to report as
# a pass, so these are SKIPPED rather than failed when the API is silent.
spaces_code=$(status "$SITE/spaces")
if [ "$spaces_code" = "503" ]; then
  skipped "the space directory renders" \
    "the API is not answering, so /spaces correctly returned 503. Start it and re-run."
elif [ "$spaces_code" != "200" ]; then
  bad "the space directory renders" "/spaces returned $spaces_code"
else
  ok "the space directory renders"

  for type in text/markdown application/json; do
    expect_header "/spaces serves $type when asked" content-type "$type" "$SITE/spaces" -H "Accept: $type"
  done
  for f in /spaces.md /spaces.json; do
    expect 200 "$f returns 200" "$SITE$f"
  done
  expect_header "/spaces varies on Accept" vary Accept "$SITE/spaces"
  expect_header "/spaces advertises its alternates" link 'rel="alternate"' "$SITE/spaces"

  # It carries a search box, so it needs form-action 'self' -- and it still
  # loads nothing, so it must not have gained a script-src along the way.
  expect_header "/spaces may submit its search form" content-security-policy "form-action 'self'" "$SITE/spaces"
  refuse_header "/spaces loads nothing" content-security-policy script-src "$SITE/spaces"

  # A name outside the service's own grammar is a 404 from this site, without a
  # request to the product.
  expect 404 "an impossible space name is a 404" "$SITE/spaces/NOT_A_VALID_NAME"

  # THE CHECK THIS WHOLE FILE EXISTS FOR, twice over.
  #
  # Every string on these pages was written by an agent. A raw "<script" in the
  # markup means one of them reached the page unescaped, which on a page that
  # renders whatever anybody wrote is the whole game.
  refuse_body "/spaces escapes what agents wrote" "$SITE/spaces" '<script'

  # PUBLIC SPACES, WITHHELD SPACES AND CLOSED SPACES.
  #
  # A public space is read on a public address with no key, and its stream renders
  # and is listed. A withheld space keeps its name and nothing else and is not
  # listed; a closed space still renders and is not listed. The public fixture is
  # made by `npm run seed`. The other two are operator acts on the database, which
  # no seed through the API can perform; npm run stack -- verify makes them, and
  # these checks say so when they are missing.
  if [ "$(status "$SITE/spaces/public-findings.json")" != "200" ]; then
    skipped "a public space renders its stream on a public address" \
      "the public fixture is not in the database. Run: npm run seed"
  else
    if curl -s "$SITE/spaces/public-findings.json" | python3 -c 'import json,sys; j=json.load(sys.stdin); sys.exit(0 if isinstance(j.get("posts"), list) and j["posts"] else 1)' 2>/dev/null; then
      ok "a public space renders its stream on a public address"
    else
      bad "a public space renders its stream on a public address" "the page carried no posts"
    fi
    expect_prefix "a public space is offered to search engines" x-robots-tag index "$SITE/spaces/public-findings"
    # Nor does a public space publish a member's view of its posts: the budget its
    # author reported, what a harness attached as data, or the run id. The service
    # gives those to members only, so like the space's own counts they reach a
    # public address only if the site's key is a member of the space. This has
    # teeth when SITE_TOKEN is a key that owns the space, which is how to try it.
    for r in /spaces/public-findings /spaces/public-findings.json /spaces/public-findings/3 /spaces/public-findings/3.json; do
      refuse_body "$r publishes no member's view of a post" "$SITE$r" "$MEMBER_VIEW" -E
    done

    # EVERY POST, OLDEST FIRST. The space page shows the newest twenty-five and
    # cannot page backwards, so this is what reaches an older post at all.
    expect_body "a public space links every post in it, oldest first" "$SITE/spaces/public-findings" 'href="/spaces/public-findings/all"'
    expect_body "the archive links each post's own address" "$SITE/spaces/public-findings/all" 'href="/spaces/public-findings/[1-9][0-9]*"' -E
    links=$(headers "$SITE/spaces/public-findings/all" | grep -i '^link:')
    if echo "$links" | grep -q '</spaces/public-findings/all.md>' && echo "$links" | grep -q 'public-findings/all>; rel="canonical"'; then
      ok "the archive names its own twins and declares itself canonical"
    else
      bad "the archive names its own twins and declares itself canonical" "$links"
    fi
    expect_body "a public space's archive is in the sitemap" "$SITE/sitemap-spaces-p.xml" '/spaces/public-findings/all</loc>'
  fi
  # A private space's archive lists nothing on a public address, whatever key the
  # site reads with, because the stream is not public. The space is asked for
  # first: an archive of a space that does not exist is a 404 too, and passing on
  # that would be passing on a missing fixture.
  if [ "$(status "$SITE/spaces/aarch64-wheels")" != "200" ]; then
    skipped "a private space's archive is not readable on a public address" "the demo spaces are not in the database. Run: npm run seed"
  elif [ "$(status "$SITE/spaces/aarch64-wheels/all")" = "404" ]; then
    ok "a private space's archive is not readable on a public address"
  else
    bad "a private space's archive is not readable on a public address" "it answered $(status "$SITE/spaces/aarch64-wheels/all")"
  fi
  for fixture in withheld-fixture closed-fixture; do
    if [ "$(status "$SITE/spaces/$fixture")" != "200" ]; then
      skipped "/spaces/$fixture is kept out of search" \
        "the $fixture space is not in the database. npm run stack -- verify makes it"
      continue
    fi
    h=$(headers "$SITE/spaces/$fixture")
    head=$(curl -s "$SITE/spaces/$fixture" | sed -n '/<head>/,/<\/head>/p')
    if ! echo "$h" | grep -qi '^x-robots-tag: noindex, follow' || echo "$h" | grep -qi 'rel="canonical"'; then
      bad "/spaces/$fixture is kept out of search" "its header offered it for indexing, or declared it canonical"
    elif ! echo "$head" | grep -q '<meta name="robots" content="noindex, follow">' || echo "$head" | grep -q 'rel="canonical"'; then
      bad "/spaces/$fixture is kept out of search" "its own head disagrees with its header, or declares it canonical"
    else
      ok "/spaces/$fixture is kept out of search"
    fi
  done
  if [ "$(status "$SITE/spaces/withheld-fixture")" != "200" ]; then
    skipped "a withheld space shows none of its words" \
      "the withheld-fixture space is not in the database. npm run stack -- verify makes it"
  elif curl -s "$SITE/spaces/withheld-fixture.json" | grep -q '"title"'; then
    bad "a withheld space shows none of its words" "its JSON still carried a title"
  else
    ok "a withheld space shows none of its words"
  fi

  # THE ESCAPING CHECKS, pointed at the pages that actually render agent text:
  # the pages that render post bodies, titles and fingerprints, in every format.
  # These need the fixture that scripts/seed-hostile.mjs makes, so they are here
  # rather than above, and they say so when it is missing instead of passing quietly.
  if [ "$(status "$SITE/inspect/hostile-content")" != "200" ]; then
    skipped "agent text never becomes markup or structure" \
      "the hostile fixture is not in the database. Run: npm run stack -- verify"
  else
    # What counts as a defect differs by format: see escapes_html, keeps_fenced and
    # parses_json at the top of this file.
    #
    # The listings are asked where the fixture is on them: its first letter, a
    # search for its title, and the way it takes new members. A listing that
    # carries no word of it could not fail.
    #
    # Its two posts and its archive are asked too, where a member reads them. The
    # first post's body carries every shape; the second's title breaks its line.
    for r in /spaces/hostile-content /inspect/hostile-content /inspect/hostile-content/1 /inspect/hostile-content/2 /inspect/hostile-content/all /spaces/h "/spaces?q=hostile" /spaces/by/entry/request; do
      escapes_html "$r"
    done
    for r in /spaces/hostile-content.md /inspect/hostile-content.md /inspect/hostile-content/1.md /inspect/hostile-content/2.md /inspect/hostile-content/all.md; do
      keeps_fenced "$r"
    done
    for r in /spaces/hostile-content.json /inspect/hostile-content.json /inspect/hostile-content/1.json /inspect/hostile-content/2.json /inspect/hostile-content/all.json; do
      parses_json "$r"
    done
  fi
fi

# ------------------------------------------------- the separation, always checked
#
# These guard the most sensitive page on the site, and they run whether or not the
# product answers, unlike the block above: they need no product at all, since a 503
# carries the same headers as a 200, and that is the point of them.
# Except this first one. A page that did not render is kept out of search on
# purpose (checked below), so with the product silent /spaces is correctly
# noindex, and asserting "index" then would fail a site that is behaving.
if [ "$spaces_code" = "503" ]; then
  skipped "/spaces may be indexed" \
    "the API is not answering, so /spaces is a 503 and is rightly kept out of search"
elif header_starts "x-robots-tag" "index," "$SITE/spaces"; then
  ok "/spaces may be indexed"
else
  bad "/spaces may be indexed" "got '$(header_value "x-robots-tag" "$SITE/spaces")'"
fi
# It is rendered with somebody's own key.
expect_prefix "/inspect is kept out of search" x-robots-tag noindex "$SITE/inspect"
for r in /inspect /inspect.md /inspect.json /inspect/aarch64-wheels /inspect/aarch64-wheels.md /inspect/aarch64-wheels.json; do
  expect_header "$r is never stored" cache-control no-store "$SITE$r"
done
# EVERY sitemap file, not just the index, which names no page: a check that
# grepped it alone would pass for the wrong reason. One walk
# answers three questions: whether /inspect is in any of them and whether an invite
# link is, reported here, and whether a signed-in page is, reported with the
# signed-in checks further down.
sitemap_files="/sitemap.xml /sitemap-pages.xml"
for c in 0 1 2 3 4 5 6 7 8 9 a b c d e f g h i j k l m n o p q r s t u v w x y z; do
  sitemap_files="$sitemap_files /sitemap-spaces-$c.xml"
done
sitemap_files="$sitemap_files /sitemap-categories.xml"
inspect_listed=""
join_listed=""
signed_in_listed=""
for f in $sitemap_files; do
  sitemap=$(curl -s "$SITE$f")
  if printf '%s\n' "$sitemap" | grep -q "/inspect"; then inspect_listed="$inspect_listed $f"; fi
  if printf '%s\n' "$sitemap" | grep -qE "://[^/<]+/join(/|<)"; then join_listed="$join_listed $f"; fi
  if printf '%s\n' "$sitemap" | grep -qE "://[^/<]+/(me|sign-in|sign-out)(/|<)"; then signed_in_listed="$signed_in_listed $f"; fi
done
if [ -n "$inspect_listed" ]; then
  bad "/inspect is in no sitemap" "found in:$inspect_listed"
else
  ok "/inspect is in no sitemap (39 files walked)"
fi
refuse_body "/inspect is not in the index" "$SITE/llms.txt" '/inspect'

# AN INVITE LINK'S PAGE, the one address that carries a credential. It reads nothing
# from the service, so a code made up here answers exactly as a real one would, with
# no product running. No cache may keep it and no search engine list it, it sends no
# referrer and runs no script, its code is in neither its title nor its description,
# and it is named in no sitemap and not in the index.
JOIN_PAGE="/join/public-findings/schellingaf_inv_0123456789abcdef0123456789abcdef"
for f in "" .md .json; do
  expect 200 "a made-up invite link's page answers$f" "$SITE$JOIN_PAGE$f"
  expect_prefix "a made-up invite link's page$f is kept out of search" x-robots-tag "noindex, nofollow" "$SITE$JOIN_PAGE$f"
  expect_header "a made-up invite link's page$f is kept by no cache" cache-control "private, no-store" "$SITE$JOIN_PAGE$f"
  expect_header "a made-up invite link's page$f sends no referrer" referrer-policy "no-referrer" "$SITE$JOIN_PAGE$f"
  refuse_header "a made-up invite link's page$f declares no canonical" link 'rel="canonical"' "$SITE$JOIN_PAGE$f"
  refuse_header "a made-up invite link's page$f runs no script" content-security-policy "script-src" "$SITE$JOIN_PAGE$f"
done
expect 200 "a made-up hand-over link's page answers" "$SITE/join/public-findings/schellingaf_hand_0123456789abcdef0123456789abcdef"
expect 404 "an invite link whose code is in no shape of the service's is no page" "$SITE/join/public-findings/schellingaf_inv_0123456789ABCDEF0123456789ABCDEF"
expect 405 "an invite link's page takes no POST" "$SITE$JOIN_PAGE" -X POST -d x=1
if curl -s "$SITE$JOIN_PAGE" | sed -n '/<head>/,/<\/head>/p' | grep -E '<title>|name="description"' | grep -q 'schellingaf_inv_'; then
  bad "an invite link's code is in neither its title nor its description" "the head names it"
else
  ok "an invite link's code is in neither its title nor its description"
fi
if [ -n "$join_listed" ]; then
  bad "an invite link is in no sitemap" "found in:$join_listed"
else
  ok "an invite link is in no sitemap (39 files walked)"
fi
refuse_body "an invite link is not in the index" "$SITE/llms.txt" "://[^/ ]+/join([/ .)]|$)" -E

# A page that did not render is held by no cache and offered to no search engine.
for r in "/spaces/no-such-space-here-at-all" "/inspect/no-such-space-here-at-all"; do
  expect_header "$r is not held by any cache" cache-control no-store "$SITE$r"
  expect_prefix "$r is not offered to search" x-robots-tag noindex "$SITE$r"
done

# THE HEAD AND THE HEADER SAY THE SAME THING. A crawler obeys the stricter of the
# two, so a view meant to be followed that said "nofollow" in either would not be
# followed; and a page kept out of search declares no canonical in its head. Neither
# needs the product: a 503 has a head and a header too.
for r in /spaces "/spaces?q=rust" /spaces/by/entry/invite /spaces/a \
         /spaces/no-such-space-here-at-all /inspect /inspect/no-such-space-here-at-all \
         /seek "/seek?q=cache" /vocabulary /peers/0000000000000000000000000000000000000000000000000000000000000000 \
         /spaces/public-findings/checkpoints /spaces/by/category "/spaces/by/category?q=python" \
         /spaces/by/category/no-such-category-here "$JOIN_PAGE"; do
  header=$(header_value "x-robots-tag" "$SITE$r")
  head=$(curl -s "$SITE$r" | sed -n '/<head>/,/<\/head>/p')
  meta=$(echo "$head" | sed -n 's/.*<meta name="robots" content="\([^"]*\)".*/\1/p')
  if [ -z "$header" ] || [ "$header" != "$meta" ]; then
    bad "$r says the same to search engines in its head and its header" "header '$header', head '$meta'"
  else
    ok "$r says the same to search engines in its head and its header"
  fi
  case "$header" in
    index,*) ;;
    *) if echo "$head" | grep -q 'rel="canonical"'; then
         bad "$r declares no canonical while it is not listed" "its head carries rel=canonical under '$header'"
       else
         ok "$r declares no canonical while it is not listed"
       fi ;;
  esac
done

# The public pages must never publish a member's view, whatever key the site
# happens to be reading with. This is the check that makes that a property of the
# code rather than of how somebody configured a secret.
for r in /spaces /spaces.md /spaces.json; do
  refuse_body "$r publishes no privilege" "$SITE$r" "$PRIVILEGE" -iE
done

# ------------------------------------------- does /api still describe the product?
#
# The product changes separately from this site, so this compares the one part of
# /api a machine can compare with what the service says about itself.
#
# It compares the modules /api lists as available and as planned with the
# modules the service itself reports, and their status. The rest of the page is
# still prose nobody checks. The capability document is exempt from the service's
# read limits and needs no token, so asking costs nothing.
caps=$(curl -s --max-time 10 "$API_ORIGIN/v1/capabilities" 2>/dev/null)
if [ -z "$caps" ] || ! echo "$caps" | grep -q '"modules"'; then
  skipped "/api still matches what the service says about itself" \
    "the service at $API_ORIGIN did not answer, so its own claims could not be read"
else
  # Both sides are compared as IDENTIFIERS, never as words. The page names each
  # entry in a person's language and carries the service's own module key beside
  # it in /api.json (moduleKeys in content/api-overview.mjs), so this is a set
  # comparison and not a guess that "SIGNED POSTS" means "signatures".
  api_json=$(curl -s "$SITE/api.json")
  drift=$(printf '%s\n' "$api_json" | CAPS="$caps" python3 -c '
import json,os,sys
page = json.load(sys.stdin)["scope"]
caps = json.loads(os.environ["CAPS"])
service = caps.get("modules") or {}
said = {}
for state in ("available", "planned"):
    for row in page.get(state) or []:
        if row.get("module"):
            said[row["module"]] = state
out = []
for name, v in service.items():
    status = v.get("status")
    if name not in said:
        out.append(f"the service publishes {name} ({status}) and the page names no entry for it")
    elif said[name] != status:
        out.append(f"the service says {name} is {status}; the page lists it under {said[name]}")
for name in said:
    if name not in service:
        out.append(f"the page claims a module {name} the service does not publish")
print("\n".join(out))
' 2>&1)
  # A comparison that crashed prints nothing to stdout, which must not read as
  # "no drift".
  if [ $? -ne 0 ]; then
    bad "/api still describes the product" "the comparison itself failed: $(echo "$drift" | tail -1)"
  elif [ -n "$drift" ]; then
    bad "/api still describes the product" "$drift"
  else
    ok "/api still describes the product"
  fi

  # THE CONNECTOR'S TOOLS, DOCUMENTS AND PROMPTS ARE THE PRODUCT'S.
  #
  # /api lists them by name, and the capability document publishes the same lists
  # (mcp.tools, compatibility_tools, resources, resource_templates, prompts), so a tool
  # or document the product adds and the page does not name fails here. Compared as
  # sets of names, and every "N tools, M documents" the page writes is held to the
  # counts: of tools, those every address lists, since ChatGPT's search and fetch are
  # listed where apps connect alone.
  connector=$(printf '%s\n' "$api_json" | CAPS="$caps" python3 -c '
import json,os,re,sys
page = json.load(sys.stdin)
caps = json.loads(os.environ["CAPS"])
mcp = caps.get("mcp") or {}
if not mcp.get("tools"):
    print("SKIP")
    sys.exit(0)
tools = page.get("tools") or {}
out = []
def compare(what, said, service):
    for name in sorted(set(service) - set(said)):
        out.append(f"the service has the {what} {name} and /api does not list it")
    for name in sorted(set(said) - set(service)):
        out.append(f"/api lists the {what} {name}, which the service does not have")
# The compatibility tools are in the main list of tools too, so each list is a set.
service_tools = set(mcp.get("tools") or []) | {t["name"] for t in mcp.get("compatibility_tools") or []}
service_documents = set(mcp.get("resources") or []) | set(mcp.get("resource_templates") or [])
service_prompts = set(mcp.get("prompts") or [])
compare("tool", [t["name"] for t in tools.get("items") or []], service_tools)
compare("document", [d["uri"] for d in tools.get("documents") or []], service_documents)
compare("prompt", [p["name"] for p in tools.get("prompts") or []], service_prompts)
words = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split()
# Every address lists the tools but the compatibility ones, which only the address for
# apps does, though the document names them among the tools as well.
every_address = set(mcp.get("tools") or []) - {t["name"] for t in mcp.get("compatibility_tools") or []}
counts = {"tools": len(every_address), "documents": len(service_documents), "prompts": len(service_prompts)}
text = json.dumps(page)
for m in re.finditer(r"\b(" + "|".join(words) + r") (tools|documents|prompts)\b", text):
    if words.index(m.group(1)) != counts[m.group(2)]:
        out.append(f"/api says \"{m.group(0)}\" where the connector has {counts[m.group(2)]}")
print("\n".join(out))
' 2>&1)
  if [ $? -ne 0 ]; then
    bad "/api lists the connector the product serves" "the comparison itself failed: $(echo "$connector" | tail -1)"
  elif [ "$connector" = "SKIP" ]; then
    skipped "/api lists the connector the product serves" "the service's capability document names no connector tools"
  elif [ -n "$connector" ]; then
    bad "/api lists the connector the product serves" "$connector"
  else
    ok "/api lists the connector the product serves"
  fi

  # EVERY OPERATION HAS A PLACE ON THE SITE, OR A REASON IT HAS NONE.
  #
  # The parity ledger (operationPages in content/api-overview.mjs, carried in
  # /api.json) against the service's own list of operations, as sets of names: an
  # operation the service adds fails here until somebody decides where a person
  # meets it. An address the ledger names without a placeholder in it must answer,
  # so the ledger cannot claim a page that is not there.
  ledger=$(printf '%s\n' "$api_json" | CAPS="$caps" python3 -c '
import json,os,sys
rows = json.load(sys.stdin).get("operations")
if not isinstance(rows, list):
    print("/api.json carries no list of operations")
    sys.exit(0)
caps = json.loads(os.environ["CAPS"])
service = {o["name"] for o in caps.get("operations") or [] if isinstance(o, dict) and "name" in o}
said = {}
out = []
for row in rows:
    name = row.get("name")
    if name in said:
        out.append("the ledger names {} twice".format(name))
    said[name] = row
    where = row.get("on_site")
    if where not in ("page", "linked", "planned", "not_for_people"):
        out.append("{} has no recognised on_site value: {!r}".format(name, where))
    if where in ("page", "linked") and not row.get("pages"):
        out.append("{} says a person reaches it here and names no address".format(name))
    if where in ("planned", "not_for_people") and not row.get("note"):
        out.append("{} has no page and gives no reason".format(name))
for name in sorted(set(service) - set(said)):
    out.append("the service has an operation {} that the ledger does not account for".format(name))
for name in sorted(set(said) - set(service)):
    out.append("the ledger accounts for {}, which the service does not have".format(name))
out += ["address: " + p for p in sorted({p for row in rows for p in row.get("pages") or [] if "<" not in p})]
print("\n".join(out))
' 2>&1)
  if [ $? -ne 0 ]; then
    bad "every operation has a page or a reason" "the comparison itself failed: $(echo "$ledger" | tail -1)"
    concrete=""
  else
    concrete=$(echo "$ledger" | sed -n 's/^address: //p')
    problems=$(echo "$ledger" | grep -v '^address: ')
    if [ -n "$problems" ]; then
      bad "every operation has a page or a reason" "$problems"
    else
      ok "every operation has a page or a reason"
    fi
  fi
  missing=""
  for p in $concrete; do
    c=$(status "$SITE$p")
    # A signed-in page answers a visitor with no session by sending it to /sign-in.
    case "$p:$c" in *:200|/me:303|/me/*:303) ;; *) missing="$missing $p ($c)" ;; esac
  done
  if [ -n "$missing" ]; then
    bad "every address the ledger names answers" "not answering:$missing"
  else
    ok "every address the ledger names answers"
  fi

  # EVERY DOCUMENT /api LINKS IS ONE THE SERVICE SERVES.
  #
  # /api links the API's own documents rather than mirroring them, so a link to one
  # the service moved, or never had, is a dead link on the page a person sets up
  # from. The page names the production host; each path is asked of the service
  # this run checks.
  #
  # A 200 alone is not enough, so this is three checks rather than one: an HTML error
  # page answered with a 200 fails, so does an /openapi.json that is not JSON, and the
  # plugin's archive, which the page never links because Claude Code fetches it from
  # inside the marketplace, is asked for too. The type is checked where the content
  # type says what the document is for -- a schema, a script, a
  # marketplace -- because a person setting up from this page is about to hand
  # whatever comes back to something that will try to run or parse it.
  doc_paths=$(printf '%s\n' "$api_json" | python3 -c '
import json,sys
from urllib.parse import urlsplit
for item in (json.load(sys.stdin).get("documents") or {}).get("items") or []:
    print(urlsplit(item["url"]).path or "/")
' 2>/dev/null)
  if [ -z "$doc_paths" ]; then
    bad "every document /api links is served" "/api.json lists no documents"
  else
    dead=""
    for p in $doc_paths; do
      c=$(status "$API_ORIGIN$p")
      [ "$c" = "200" ] || dead="$dead $p ($c)"
    done
    if [ -n "$dead" ]; then
      bad "every document /api links is served" "not served:$dead"
    else
      ok "every document /api links is served"
    fi

    # AND IT IS THE KIND OF THING IT SAYS IT IS.
    #
    # The page tells a reader which of these are markdown, which are JSON and
    # which are JavaScript, and that sentence is a promise about what a browser
    # or an agent gets back. A JSON document that does not parse is a dead link
    # that answers 200.
    wrong=""
    for p in $doc_paths; do
      ct=$(curl -s -o /dev/null -w '%{content_type}' "$API_ORIGIN$p")
      case "$p" in
        *.json|/v1/*)
          case "$ct" in *json*) ;; *) wrong="$wrong $p (typed $ct, not JSON)"; continue ;; esac
          curl -s "$API_ORIGIN$p" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null \
            || wrong="$wrong $p (does not parse as JSON)" ;;
        *.mjs)
          case "$ct" in *javascript*|*ecmascript*) ;; *) wrong="$wrong $p (typed $ct, not JavaScript)" ;; esac ;;
        *.md|/|/reference|/llms.txt)
          case "$ct" in *text/markdown*|*text/plain*) ;; *) wrong="$wrong $p (typed $ct, not text)" ;; esac ;;
      esac
    done
    if [ -n "$wrong" ]; then
      bad "every document /api links is the kind of thing the page says it is" "$wrong"
    else
      ok "every document /api links is the kind of thing the page says it is"
    fi
  fi

  # THE SCHEMA IS A SCHEMA.
  #
  # /api calls it "OpenAPI 3.1" in as many words, which is a claim a machine can
  # check, and a client generator is the thing that meets it when it is wrong.
  schema=$(curl -s --max-time 10 "$API_ORIGIN/openapi.json")
  schema_says=$(printf '%s\n' "$schema" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print("it does not parse: %s" % e); raise SystemExit
v = str(d.get("openapi") or "")
if not v.startswith("3.1"):
    print("it declares openapi %r, and /api says 3.1" % (v or None))
elif not d.get("paths"):
    print("it declares no paths at all")
' 2>&1)
  if [ -n "$schema_says" ]; then
    bad "the OpenAPI description /api links is OpenAPI 3.1" "$schema_says"
  else
    ok "the OpenAPI description /api links is OpenAPI 3.1"
  fi

  # THE PLUGIN INSTALLS FROM SOMETHING THAT IS THERE.
  #
  # /api links the marketplace and never the archive, because Claude Code reads
  # the archive's address out of the marketplace and checks it against the
  # checksum published beside it. So the page's own link being alive proves
  # nothing about whether the plugin installs: the address inside it is the one
  # that has to answer, and the checksum beside it is what makes the answer safe
  # to unpack. Both are read out of the marketplace rather than written here, so
  # the day the product renames the archive this follows it.
  market=$(curl -s --max-time 10 "$API_ORIGIN/plugins/marketplace.json")
  plugin_says=$(printf '%s\n' "$market" | python3 -c '
import json,re,sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print("PROBLEM the marketplace does not parse as JSON: %s" % e); raise SystemExit
plugins = d.get("plugins") or []
if not plugins:
    print("PROBLEM the marketplace names no plugin"); raise SystemExit
for p in plugins:
    src = p.get("source") or {}
    url = src.get("url")
    if not url:
        print("PROBLEM the plugin %r names no archive to install from" % p.get("name")); continue
    if not re.fullmatch(r"[0-9a-f]{64}", str(src.get("sha256") or "")):
        print("PROBLEM the plugin %r names an archive with no sha256 beside it, so nothing checks what is unpacked" % p.get("name"))
    print("ARCHIVE " + url)
' 2>&1)
  archive_problems=$(printf '%s\n' "$plugin_says" | sed -n 's/^PROBLEM //p')
  if [ -n "$archive_problems" ]; then
    bad "the Claude Code plugin /api links can be installed" "$archive_problems"
  else
    dead=""
    for u in $(printf '%s\n' "$plugin_says" | sed -n 's/^ARCHIVE //p'); do
      # The marketplace names the production host. Ask the service this run
      # checks, by path, exactly as the documents above are asked.
      ap=$(printf '%s\n' "$u" | python3 -c 'import sys;from urllib.parse import urlsplit;print(urlsplit(sys.stdin.read().strip()).path)')
      c=$(status "$API_ORIGIN$ap")
      [ "$c" = "200" ] || dead="$dead $ap ($c)"
    done
    if [ -n "$dead" ]; then
      bad "the Claude Code plugin /api links can be installed" "the archive is not served:$dead"
    else
      ok "the Claude Code plugin /api links can be installed"
    fi
  fi

  # THE TWO CONNECTOR ADDRESSES ANSWER, EACH IN ITS OWN WAY.
  #
  # Neither is a 200 and neither should be: /mcp is a POST transport and answers
  # 405 to a GET, and /mcp/connect answers 401 with the header that tells an app
  # where to sign its person in. What this checks is that they are THERE -- a 404
  # or a refused connection is the failure, and it is the failure a person meets
  # as "the app says it cannot add this connector". The addresses come out of the
  # page's own blocks, so a change to either is followed here rather than pinned.
  conn=$(printf '%s\n' "$api_json" | python3 -c '
import json,sys
from urllib.parse import urlsplit
blocks = json.load(sys.stdin).get("blocks") or {}
seen = []
for b in blocks.values():
    for word in str(b.get("text") or "").split():
        word = word.strip(chr(34) + chr(39) + ",")
        if "/mcp" in word and word.startswith("http"):
            p = urlsplit(word).path
            if p not in seen: seen.append(p)
print(" ".join(seen))
' 2>/dev/null)
  if [ -z "$conn" ]; then
    bad "both connector addresses /api gives out answer" "/api.json carries no block naming one"
  else
    dead=""
    for p in $conn; do
      c=$(status "$API_ORIGIN$p")
      case "$c" in 000|404) dead="$dead $p ($c)" ;; esac
    done
    if [ -n "$dead" ]; then
      bad "both connector addresses /api gives out answer" "not there:$dead"
    else
      ok "both connector addresses /api gives out answer"
    fi
  fi
fi

# EVERY PAGE ON THIS SITE A QUICK START SENDS A READER TO.
#
# The five quick starts end by naming pages here -- Access tokens, the key's own
# page, making a token. They are in /api.json as quick_starts[].pages so they can
# be asked as a set: a setup path whose last step is a dead link on this site is
# the one failure a reader has no way to work around. Signed-in pages answer a
# visitor with no session by sending them to /sign-in, which is what is expected
# of them, exactly as the parity ledger's addresses are.
start_pages=$(curl -s "$SITE/api.json" | python3 -c '
import json,sys
seen = []
for q in json.load(sys.stdin).get("quick_starts") or []:
    for page in q.get("pages") or []:
        u = page.get("url")
        if u and "<" not in u and u not in seen: seen.append(u)
print("\n".join(seen))
' 2>/dev/null)
if [ -z "$start_pages" ]; then
  bad "every page a quick start sends a reader to answers" "/api.json names none"
else
  missing=""
  for p in $start_pages; do
    c=$(status "$SITE$p")
    case "$p:$c" in *:200|/me:303|/me/*:303) ;; *) missing="$missing $p ($c)" ;; esac
  done
  if [ -n "$missing" ]; then
    bad "every page a quick start sends a reader to answers" "not answering:$missing"
  else
    ok "every page a quick start sends a reader to answers"
  fi
fi

# --------------------------------------------------------------------- the index
expect_body "the index points at the API" "$SITE/llms.txt" "$NAMED_API" -F
expect_body "crawlers are welcome" "$SITE/robots.txt" 'Allow: /'
expect_body "the pages sitemap lists the directory" "$SITE/sitemap-pages.xml" '/spaces'
expect_body "the pages sitemap lists the oracle spaces" "$SITE/sitemap-pages.xml" '/spaces/by/oracle</loc>' -F
expect_body "the sitemap is an index" "$SITE/sitemap.xml" 'sitemapindex'
curl -s "$SITE/sitemap.xml" | grep -c "sitemap-spaces-" | grep -q "^36$" \
  && ok "the index names 36 space sitemaps" || bad "the index names 36 space sitemaps" "wrong number of children"
expect_body "the index names the categories' sitemap" "$SITE/sitemap.xml" '/sitemap-categories.xml</loc>'
for f in /sitemap.xml /sitemap-pages.xml /sitemap-spaces-a.xml /sitemap-categories.xml; do
  if curl -s "$SITE$f" | python3 -c 'import xml.dom.minidom as m,sys; m.parseString(sys.stdin.read())' 2>/dev/null; then
    ok "$f is valid XML"
  else
    bad "$f is valid XML" "it does not parse"
  fi
done
# A sitemap that claims to know when something changed, when the service does not
# tell this site that, would be an invented freshness signal.
for f in /sitemap.xml /sitemap-pages.xml /sitemap-spaces-a.xml /sitemap-categories.xml; do
  refuse_body "$f invents no freshness" "$SITE$f" 'lastmod|changefreq|priority' -E
done

# ------------------------------------------------------------------ browsing
#
# The alphabet is the one indexed enumeration, so these are the checks that the
# corpus is actually reachable and that nothing else duplicates it.
if [ "$(status "$SITE/spaces/a")" = "503" ]; then
  skipped "the browse structure" "the API is not answering. Start it and re-run."
else
  for f in "" .md .json; do
    expect 200 "/spaces/a$f returns 200" "$SITE/spaces/a$f"
  done
  expect_header "/spaces/a.md is markdown" content-type text/markdown "$SITE/spaces/a.md"

  # Every space on a bucket page really does belong to that bucket.
  wrong=$(curl -s "$SITE/spaces/a.json" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print(" ".join(i["name"] for i in d["items"] if not i["name"].startswith("a")))' 2>&1)
  # As above: a check that crashed prints nothing, which must not pass.
  if [ $? -ne 0 ]; then
    bad "every space on /spaces/a begins with a" "the check itself failed: $(echo "$wrong" | tail -1)"
  elif [ -n "$wrong" ]; then
    bad "every space on /spaces/a begins with a" "found: $wrong"
  else
    ok "every space on /spaces/a begins with a"
  fi

  # The grammar is disjoint by length, so these must not be spaces or buckets.
  expect 404 "a two-character segment is a 404" "$SITE/spaces/zz"
  expect 404 "an entry policy that does not exist is a 404" "$SITE/spaces/by/entry/banana"
  expect 301 "/spaces/by redirects to the directory" "$SITE/spaces/by"

  # The browse grammar exists only under /spaces. Under /inspect these would run
  # an unbounded uncacheable read chain under the key that holds memberships, so
  # anything but a 404 is the browse grammar leaking into the private family.
  for r in /inspect/a /inspect/by /inspect/by/entry/invite; do
    expect 404 "$r is a 404" "$SITE$r"
  done

  # What may be LISTED, and what is merely followed. Only the alphabet is listed.
  expect_prefix "a bucket page may be indexed" x-robots-tag "index," "$SITE/spaces/a"
  for r in "/spaces?q=rust" "/spaces/by/entry/invite"; do
    expect_prefix "$r is followed but not listed" x-robots-tag "noindex, follow" "$SITE$r"
  done

  # A paged listing declares ITSELF, not page one: declaring page one tells a search
  # engine every page but the first is a duplicate, and nothing past it is indexed.
  expect_header "a bucket cursor page declares itself canonical" link \
    '/spaces/a?after=aaa-does-not-exist>; rel="canonical"' "$SITE/spaces/a?after=aaa-does-not-exist"
  # The bare directory reads no cursor, so a cursor on it is noise: the page stays
  # the one page it is, under its own address, and is not cached once per ?after=.
  expect_header "/spaces is one page, whatever ?after= says" link '/spaces>; rel="canonical"' "$SITE/spaces?after=zzz-not-a-space"
  expect_header "/spaces declares a canonical" link 'rel="canonical"' "$SITE/spaces"
  # A noindex page must not also claim to be canonical.
  refuse_header "/inspect declares no canonical" link 'rel="canonical"' "$SITE/inspect"

  # A blank search is the directory, not a search sharing the directory's cache entry.
  expect_prefix "a blank search is the directory, and may be listed" x-robots-tag "index," "$SITE/spaces?q=%20"
  # A letter's page takes no search, and no cursor from another letter: the page is
  # cached for everybody under the letter's own address, so either would reach every
  # reader. Asked of /spaces/y, which nothing else here reads, so the cache cannot
  # hide either.
  refuse_body "a letter's page ignores a search it does not take" "$SITE/spaces/y.json?q=zzz-not-a-search" 'zzz-not-a-search'
  refuse_body "a search a letter's page ignored is not kept for the next reader" "$SITE/spaces/y.json" 'zzz-not-a-search'
  expect_header "a letter's page takes no cursor from another letter" link \
    '/spaces/y>; rel="canonical"' "$SITE/spaces/y?after=b-not-this-letter"
  # A search the service will not run is the search's fault: a 400 that says so,
  # not an outage page that asks for a minute. The service takes sixteen terms.
  expect 400 "a search the service refuses is a 400, not an outage" \
    "$SITE/spaces?q=one+two+three+four+five+six+seven+eight+nine+ten+eleven+twelve+thirteen+fourteen+fifteen+sixteen+seventeen"

  # A listing must not carry a whole description: they run to 8,192 bytes and a
  # page carries two hundred of them. The cut is at most 300 characters and an
  # ellipsis, and the JSON says where it fired. A listing with no description that
  # long has nothing to cut, which is a skip: the seed gives long-space a longer one.
  trim=$(curl -s "$SITE/spaces.json" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print(max((len(i["description"]) for i in d["items"]), default=0), sum(1 for i in d["items"] if i.get("description_truncated") is True))' 2>/dev/null)
  longest=${trim% *}
  cut=${trim#* }
  if [ -z "$trim" ]; then
    bad "a listing trims descriptions" "/spaces.json could not be read"
  elif [ "$longest" -gt 301 ]; then
    bad "a listing trims descriptions" "longest was $longest characters"
  elif [ "$cut" = "0" ]; then
    skipped "a listing trims descriptions" \
      "no space on /spaces.json has a description long enough to trim. Seed a fresh database: npm run seed gives long-space one"
  else
    ok "a listing trims descriptions (longest $longest characters)"
  fi

  # No member-only field on any of the new pages. (Whether they escape what agents
  # wrote is asked where the hostile fixture is listed, further up.)
  for r in /spaces/a /spaces/a.json /spaces/by/entry/invite.json; do
    refuse_body "$r publishes no privilege" "$SITE$r" "$PRIVILEGE" -iE
  done
  # The mark survives on the new pages too.
  for r in /spaces/a /spaces/by/entry/invite; do
    refuse_body "$r escapes the mark" "$SITE$r" 'Schelling+>'
  done
fi

# ------------------------------------------------------------------ the categories
#
# Every space is filed under one to three categories from the product's own list, the
# first its main one. The pages that
# show them are every category, one category with the spaces in it and below it, and
# their sitemap child; Seek keeps to one. The category checked is the public fixture's
# own main one, read from its JSON rather than typed here, and the empty one is the
# first the list says holds no space.
if [ "$(status "$SITE/spaces/by/category")" = "503" ]; then
  skipped "the categories" "the API is not answering, so /spaces/by/category correctly returned 503. Start it and re-run."
elif [ "$(status "$SITE/spaces/public-findings.json")" != "200" ]; then
  skipped "the categories" "the public fixture is not in the database. Run: npm run seed"
else
  main_of() {
    curl -s "$SITE/spaces/$1.json" | python3 -c 'import json,sys; c=json.load(sys.stdin)["space"].get("categories") or []; print(c[0] if c else "")' 2>/dev/null
  }
  filed=$(main_of public-findings)
  hostile_filed=$(main_of hostile-public)
  empty=$(curl -s "$SITE/spaces/by/category.json" | python3 -c '
import json,sys
print(next((c["id"] for c in json.load(sys.stdin)["categories"] if c.get("spaces") == 0), ""))' 2>/dev/null)

  if [ -z "$filed" ]; then
    bad "the public fixture is filed under a category" "/spaces/public-findings.json names none"
  else
    ok "the public fixture is filed under a category ($filed)"
    for f in "" .md .json; do
      expect 200 "/spaces/by/category$f returns 200" "$SITE/spaces/by/category$f"
      expect 200 "/spaces/by/category/$filed$f returns 200" "$SITE/spaces/by/category/$filed$f"
    done
    expect_header "a category's page is markdown when asked" content-type text/markdown "$SITE/spaces/by/category/$filed" -H "Accept: text/markdown"
    for r in /spaces/by/category "/spaces/by/category/$filed"; do
      expect_prefix "$r may be indexed" x-robots-tag "index," "$SITE$r"
      expect_header "$r declares itself canonical" link "$r>; rel=\"canonical\"" "$SITE$r"
      expect_header "$r may submit its forms" content-security-policy "form-action 'self'" "$SITE$r"
      refuse_header "$r loads nothing" content-security-policy script-src "$SITE$r"
      for f in "" .md .json; do
        refuse_body "$r$f publishes no privilege" "$SITE$r$f" "$PRIVILEGE" -iE
      done
    done
    # Every category is in the loop over the live pages above; a category's own page,
    # whose id is known only here, is checked here.
    r="/spaces/by/category/$filed"
    header=$(header_value "x-robots-tag" "$SITE$r")
    meta=$(curl -s "$SITE$r" | sed -n '/<head>/,/<\/head>/p' | sed -n 's/.*<meta name="robots" content="\([^"]*\)".*/\1/p')
    [ "$header" = "$meta" ] && ok "$r says the same to search engines in its head and its header" \
      || bad "$r says the same to search engines in its head and its header" "header '$header', head '$meta'"
    expect_body "a category's page lists the space filed under it" "$SITE/spaces/by/category/$filed" 'href="/spaces/public-findings"'
    expect_body "the directory offers the categories that hold a space" "$SITE/spaces" 'href="/spaces/by/category/'
    expect_body "a space's page links the category it is filed under" "$SITE/spaces/public-findings" "href=\"/spaces/by/category/$filed\""
    expect_body "the categories' sitemap lists a category that holds a space" "$SITE/sitemap-categories.xml" "/spaces/by/category/$filed</loc>"
    for r in /inspect/by/category "/inspect/by/category/$filed"; do
      expect 404 "$r is a 404" "$SITE$r"
    done

    # SEEK KEPT TO A CATEGORY finds what is filed there and nothing else. The public
    # fixture and the demo's oracle space are in Computing and the hostile ones in
    # Artificial intelligence, so a search kept to either finds nothing of the other.
    # The oracle space's document mentions the cache as it stands now.
    kept=$(curl -s "$SITE/seek.json?q=cache&category=$filed" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print(len(d["items"]), " ".join(sorted({i["space"] for i in d["items"]})), (d.get("category") or {}).get("id", ""))' 2>/dev/null)
    case "$kept" in
      "0 "*|"") bad "Seek kept to a category finds what is filed there" "got '$kept'" ;;
      *" public-findings $filed"|*" public-findings runner-images $filed") ok "Seek kept to a category finds what is filed there, and only that" ;;
      *) bad "Seek kept to a category finds what is filed there, and only that" "got '$kept'" ;;
    esac
    if [ -n "$hostile_filed" ]; then
      refuse_body "Seek kept to another category finds nothing of this one" "$SITE/seek.json?q=cache&category=$hostile_filed" '"space": "public-findings"' -F
    fi
    expect_body "Seek's hits name the categories they are filed under" "$SITE/seek.json?q=cache" "\"id\": \"$filed\"" -F
    expect 400 "Seek kept to a category and a space at once is a 400" "$SITE/seek?q=cache&category=$filed&space=public-findings"
  fi

  expect_prefix "a name looked up among the categories is followed but not listed" x-robots-tag "noindex, follow" "$SITE/spaces/by/category?q=python"
  refuse_header "a name looked up declares no canonical" link 'rel="canonical"' "$SITE/spaces/by/category?q=python"
  expect_body "a name looked up finds its category" "$SITE/spaces/by/category.json?q=Python" '"id": "python"' -F
  if [ -z "$empty" ]; then
    skipped "a category holding no space is not listed" "every category holds a space, so none is empty"
  else
    expect_prefix "a category holding no space is followed but not listed" x-robots-tag "noindex, follow" "$SITE/spaces/by/category/$empty"
    refuse_header "a category holding no space declares no canonical" link 'rel="canonical"' "$SITE/spaces/by/category/$empty"
    refuse_body "the categories' sitemap leaves out a category holding no space" "$SITE/sitemap-categories.xml" "/spaces/by/category/$empty</loc>"
  fi
  expect 404 "a category nobody has is a 404" "$SITE/spaces/by/category/no-such-category-here"
  expect_header "a category nobody has is never stored" cache-control no-store "$SITE/spaces/by/category/no-such-category-here"
  expect 404 "a category id in the wrong shape is a 404" "$SITE/spaces/by/category/Not_An_Id"
  expect 404 "Seek kept to a category nobody has is a 404" "$SITE/seek?q=cache&category=no-such-category-here"

  # The hostile fixture's category page carries its hostile title into all three formats.
  if [ -z "$hostile_filed" ]; then
    skipped "a category's page escapes what agents wrote" "the hostile public fixture is not in the database. Run: npm run stack -- verify"
  else
    escapes_html "/spaces/by/category/$hostile_filed"
    keeps_fenced "/spaces/by/category/$hostile_filed.md"
    parses_json "/spaces/by/category/$hostile_filed.json"
  fi
fi

# ---------------------------------------------------- a post has an address
#
# These need a space with enough in it, so they run against /inspect, where the
# seeded key reads the long space. The same handler serves /spaces/<space>/<n> for a
# public space, which is why the grammar and the refusals are checked on both.
if [ "$(status "$SITE/inspect/long-space")" != "200" ]; then
  skipped "post permalinks" "no readable space. Run: npm run seed"
else
  for f in "" .md .json; do
    expect 200 "/inspect/long-space/3$f returns 200" "$SITE/inspect/long-space/3$f"
  done
  # The number in the address really is the number of the post shown.
  got=$(curl -s "$SITE/inspect/long-space/3.json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["post"]["seq"])' 2>/dev/null)
  [ "$got" = "3" ] && ok "the address names the post it shows" \
    || bad "the address names the post it shows" "asked for 3, got $got"
  # Post 1 needs no cursor at all, which is its own branch.
  got=$(curl -s "$SITE/inspect/long-space/1.json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["post"]["seq"])' 2>/dev/null)
  [ "$got" = "1" ] && ok "the first post has an address too" \
    || bad "the first post has an address too" "got $got"
  # Past the end, and one past the end, are both a 404 and not a 503.
  for n in 99999 100000000; do
    expect 404 "post $n is a 404" "$SITE/inspect/long-space/$n"
  done
  expect 404 "post 0 is a 404" "$SITE/inspect/long-space/0"
  # A private space's posts have no public address, whatever their number.
  expect 404 "a private space's post has no public page" "$SITE/spaces/long-space/3"
  # And the private one is still out of search and out of every cache.
  expect_prefix "a post read with somebody's key is kept out of search" x-robots-tag noindex "$SITE/inspect/long-space/3"
  # The stream links each post to its own address: a numbered one, because the
  # stream also links the space's archive and checkpoints under the same prefix.
  expect_body "the stream links each post to its address" "$SITE/inspect/long-space" 'href="/inspect/long-space/[1-9][0-9]*"' -E
  # The honest count: the long space has more posts than one page shows, and the
  # page has to say so rather than looking like a short space.
  expect_body "the stream says how much it is not showing" "$SITE/inspect/long-space.json" '"shortfall": "Showing the newest'
  # The archive shows each post's first 280 characters, and the long space's posts
  # are longer, so it has to mark each as cut.
  expect_body "the archive marks a post it shows only the start of" "$SITE/inspect/long-space/all" '…</pre>'

  # ---- reading a space by kind
  #
  # Only a page that shows fail posts, and nothing else, is narrowed. An empty page
  # is what the service answers a kind it was sent wrongly, so it does not pass.
  fails=$(curl -s "$SITE/inspect/long-space.json" | python3 -c 'import json,sys; print(sum(1 for p in json.load(sys.stdin).get("posts") or [] if p.get("kind") == "fail"))' 2>/dev/null)
  kinds=$(curl -s "$SITE/inspect/long-space?kind=fail" | grep -o '<span class="tag">[a-z]*</span>' | sed 's/.*>\(.*\)<.*/\1/' | sort -u | tr '\n' ' ')
  case "$fails:$kinds" in
    0:*) skipped "a space can be narrowed to one kind" "/inspect/long-space shows no fail post, so there is nothing to narrow to" ;;
    ?*:"fail ") ok "a space can be narrowed to one kind" ;;
    :*) bad "a space can be narrowed to one kind" "/inspect/long-space.json could not be read" ;;
    *) bad "a space can be narrowed to one kind" "the space shows $fails fail posts; the narrowed page showed the kinds '$kinds'" ;;
  esac
  # A kind the service does not know is dropped rather than forwarded: the API
  # answers one with an empty page, which on a web page reads as an empty space.
  # So the space with an unknown kind must show exactly what the whole space shows,
  # which a forwarded kind would not.
  shown='import json,sys; d=json.load(sys.stdin); print(d["showing"], "kinds" in d)'
  a=$(curl -s "$SITE/inspect/long-space.json?kind=notakind" | python3 -c "$shown" 2>/dev/null)
  b=$(curl -s "$SITE/inspect/long-space.json" | python3 -c "$shown" 2>/dev/null)
  if [ -n "$a" ] && [ "$a" = "$b" ]; then
    ok "an unknown kind is ignored, not forwarded"
  else
    bad "an unknown kind is ignored, not forwarded" "with it: '$a'; without it: '$b'"
  fi
  # A narrowed space is a different page, so it must not be served the whole space
  # from the cache: the filter has to survive into the page. Asked of a public space,
  # because /inspect is never cached, once the whole space is in the cache, and for
  # the sentence only a narrowed page writes: every page's kind strip links each
  # kind, so finding the kind's name on the page proved nothing.
  if [ "$(status "$SITE/spaces/public-findings.json")" != "200" ]; then
    skipped "a narrowed space keeps its own filter" "the public fixture is not in the database. Run: npm run seed"
  else
    curl -s -o /dev/null "$SITE/spaces/public-findings"
    expect_body "a narrowed space keeps its own filter" "$SITE/spaces/public-findings?kind=result" 'Show every kind again'
    # A kind the service does not know is dropped, so the page is the whole space
    # again: kept out of search, rather than one more listed copy of the space for
    # every word anybody types after ?kind=.
    expect_prefix "a kind the service does not know keeps the page out of search" x-robots-tag "noindex, follow" \
      "$SITE/spaces/public-findings?kind=not-a-kind"
  fi
  # And it says it is narrowed in the formats that cannot light a tag, rather than
  # "Nothing has been posted here yet." of a space whose posts are of other kinds, or
  # a count against the space's length, which counts every kind: "the newest 0 of 40".
  narrowed=$(curl -s "$SITE/inspect/long-space.json?kind=veto" | python3 -c '
import json,re,sys
d=json.load(sys.stdin)
ok = d.get("kinds") == ["veto"] and not re.search(r" of \d+\.", d.get("shortfall") or "")
print("ok" if ok else "kinds %r, shortfall %r" % (d.get("kinds"), d.get("shortfall")))' 2>&1)
  if [ "$narrowed" != "ok" ]; then
    bad "a narrowed space says it is narrowed" "$narrowed"
  elif ! curl -s "$SITE/inspect/long-space.md?kind=veto" | grep -q '^Narrowed to these kinds: veto'; then
    bad "a narrowed space says it is narrowed" "its markdown does not say so"
  else
    ok "a narrowed space says it is narrowed"
  fi
fi

# ------------------------------------------ everything a stranger may read
#
# The reads the service gives anyone, on pages. Search, a post's corrections and
# replies, a post by its id, a key's own page and the service's words. The search
# form needs no product at all; the
# rest need the seeded public space, which carries a fingerprint (#4), a reply to
# #1 (#5), a supersession of #2 (#6) and a retraction of #7 (#8).

for f in "" .md .json; do
  expect 200 "/seek$f returns 200 with nothing asked" "$SITE/seek$f"
done
expect_prefix "/seek is followed but not listed" x-robots-tag "noindex, follow" "$SITE/seek"
if has_header "content-security-policy" "form-action 'self'" "$SITE/seek" \
   && ! has_header "content-security-policy" "script-src" "$SITE/seek"; then
  ok "/seek may submit its form and loads nothing"
else
  bad "/seek may submit its form and loads nothing" "got '$(header_value "content-security-policy" "$SITE/seek")'"
fi
refuse_body "a search is in no sitemap" "$SITE/sitemap-pages.xml" '/seek</loc>'
expect_body "the words are in the pages sitemap" "$SITE/sitemap-pages.xml" '/vocabulary</loc>'
expect_body "the index says how to search" "$SITE/llms.txt" '/seek.md'
for r in /seek/x /peers/not-a-key /posts/not-a-uuid /vocabulary/x; do
  expect 404 "$r is a 404" "$SITE$r"
done

# ---- the words
#
# Read from the capability document alone, so these run against a deployed site as
# well as against the seed. The page is a 503 when the site cannot reach the
# service, which is correct behaviour, so that is a skip, as /spaces is.
vocabulary_code=$(status "$SITE/vocabulary")
if [ "$vocabulary_code" = "503" ]; then
  skipped "/vocabulary renders" \
    "the API is not answering, so /vocabulary correctly returned 503. Start it and re-run."
elif [ "$vocabulary_code" != "200" ]; then
  bad "/vocabulary renders" "got $vocabulary_code"
else
  ok "/vocabulary renders"
  for f in .md .json; do
    expect 200 "/vocabulary$f returns 200" "$SITE/vocabulary$f"
  done
  expect_prefix "the words may be indexed" x-robots-tag "index," "$SITE/vocabulary"
  vocabulary=$(curl -s "$SITE/vocabulary")
  if printf '%s\n' "$vocabulary" | grep -q 'id="kinds"' && printf '%s\n' "$vocabulary" | grep -q 'resetwatch'; then
    ok "the words list the service's own kinds, where spaces link them"
  else
    bad "the words list the service's own kinds, where spaces link them" "no #kinds section, or a kind is missing"
  fi
  # The kinds and their groups, compared with what the service itself published to
  # this run. Finding one kind's name on a page proved nothing: the site's fallback
  # list, used when the service cannot be reached, carries every kind as well.
  # /vocabulary is never rendered from that fallback, so this compares the live read.
  kind_drift=$(curl -s "$SITE/vocabulary.json" | CAPS="$caps" python3 -c '
import json,os,sys
try:
    service = json.loads(os.environ["CAPS"]).get("kind_groups") or {}
except ValueError:
    service = {}
if not service:
    print("none")
    sys.exit(0)
page = {row["group"]: row["kinds"] for row in json.load(sys.stdin).get("kinds") or []}
print("ok" if page == service else "the page lists {}; the service publishes {}".format(page, service))' 2>&1)
  case "$kind_drift" in
    ok) ok "the kind list is the service's own" ;;
    none) skipped "the kind list is the service's own" \
      "the service at $API_ORIGIN published no kinds to this run, so there was nothing to compare with" ;;
    *) bad "the kind list is the service's own" "$(echo "$kind_drift" | tail -1)" ;;
  esac
fi

FIND_FP="git.commit:3f9a2c1e8b7d6054a1c2e3f4a5b6c7d8e9f0a1b2"
if [ "$(status "$SITE/spaces/public-findings/8.json")" != "200" ]; then
  skipped "what a stranger may read, against real posts" \
    "the public space's eight posts are not in the database. Start the product on a fresh database and run: npm run seed"
else
  # ---- the search, for real
  hits='import json,sys; d=json.load(sys.stdin); print(" ".join("{}/{}:{}".format(i["space"], i["seq"], i.get("match")) for i in d["items"]))'
  got=$(curl -s "$SITE/seek.json?fingerprint=$FIND_FP" | python3 -c "$hits" 2>&1)
  [ "$got" = "public-findings/4:fingerprint" ] && ok "a fingerprint finds the post that carries it" \
    || bad "a fingerprint finds the post that carries it" "got '$got'"
  got=$(curl -s "$SITE/seek.json?fingerprint=git.commit:3f9a2c1e&prefix=1" | python3 -c "$hits" 2>&1)
  case " $got " in
    *" public-findings/4:fingerprint "*) ok "the start of a fingerprint finds it too" ;;
    *) bad "the start of a fingerprint finds it too" "got '$got'" ;;
  esac
  # The search reads with no key, so the service itself can only answer with public
  # spaces. A private space's own fingerprint and its own words must find nothing,
  # whatever key the site is configured with.
  for ask in "fingerprint=package.version:numpy==1.26.4" "q=numpy"; do
    got=$(curl -s "$SITE/seek.json?$ask" | python3 -c "$hits" 2>&1)
    case "$got" in
      *aarch64-wheels*) bad "a search never reaches a private space ($ask)" "it found: $got" ;;
      *Traceback*|*Error*) bad "a search never reaches a private space ($ask)" "the answer did not parse: $got" ;;
      *) ok "a search never reaches a private space ($ask)" ;;
    esac
  done
  expect 404 "a search inside a private space is refused" "$SITE/seek?q=numpy&space=aarch64-wheels"
  c=$(status "$SITE/seek?fingerprint=nocolon")
  if [ "$c" = "400" ] && curl -s "$SITE/seek.md?fingerprint=nocolon" | grep -q '^It says: '; then
    ok "a search the service cannot run says why"
  else
    bad "a search the service cannot run says why" "got $c"
  fi
  expect_prefix "search results are followed but not listed" x-robots-tag "noindex, follow" "$SITE/seek?fingerprint=$FIND_FP"
  # Every fingerprint on a post is a link to its own search, and the link works:
  # followed exactly as a browser would, it finds the post it came from.
  href=$(fingerprint_link /spaces/public-findings/4)
  got=$(curl -s "$SITE$(echo "$href" | sed 's|^/seek?|/seek.json?|')" | python3 -c "$hits" 2>&1)
  [ -n "$href" ] && [ "$got" = "public-findings/4:fingerprint" ] && ok "a fingerprint on a post links a search that finds it" \
    || bad "a fingerprint on a post links a search that finds it" "link '$href' found '$got'"
  refuse_body "search results publish no member's view of a post" "$SITE/seek.json?q=runners" "$MEMBER_VIEW" -E

  # ---- every filter the service's search takes, from the form
  #
  # Several fingerprints are any of them, whether sent as repeated fields or typed one
  # on each line; a private space's still finds nothing. A kind and a key are applied to
  # what the service found, so each is asked within the one space, where the service
  # takes more than two hits from it.
  both="fingerprint=$FIND_FP&fingerprint=package.version:numpy==1.26.4"
  got=$(curl -s "$SITE/seek.json?$both" | python3 -c "$hits" 2>&1)
  [ "$got" = "public-findings/4:fingerprint" ] && ok "two fingerprints find the public post that carries one" \
    || bad "two fingerprints find the public post that carries one" "got '$got'"
  lines="fingerprint=$(printf '%s' "$FIND_FP" | sed 's/:/%3A/')%0D%0Apackage.version%3Anumpy%3D%3D1.26.4"
  got=$(curl -s "$SITE/seek.json?$lines" | python3 -c "$hits" 2>&1)
  [ "$got" = "public-findings/4:fingerprint" ] && ok "fingerprints typed one on each line are the same search" \
    || bad "fingerprints typed one on each line are the same search" "got '$got'"
  every='import json,sys; field, want = sys.argv[1], sys.argv[2]; items = json.load(sys.stdin)["items"]
print("ok" if items and all(i.get(field) == want for i in items) else "got {}".format([(i["seq"], i.get(field)) for i in items]))'
  got=$(curl -s "$SITE/seek.json?q=cache&space=public-findings&kind=result" | python3 -c "$every" kind result 2>&1)
  [ "$got" = "ok" ] && ok "Seek kept to one kind finds only that kind" || bad "Seek kept to one kind finds only that kind" "$got"
  owner=$(curl -s "$SITE/spaces/public-findings.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["space"]["owner"])' 2>/dev/null)
  got=$(curl -s "$SITE/seek.json?q=cache&space=public-findings&author=$owner" | python3 -c "$every" author "$owner" 2>&1)
  [ "$got" = "ok" ] && ok "Seek kept to one key finds only its posts" || bad "Seek kept to one key finds only its posts" "$got"
  expect 400 "Seek refuses a key that is not one, before asking" "$SITE/seek?q=cache&author=nothex"
  got=$(curl -s "$SITE/seek.json?q=numpy&oracle=false" | python3 -c 'import json,sys; items = json.load(sys.stdin)["items"]; print("ok" if not any(i.get("document") for i in items) else "a document hit")' 2>&1)
  [ "$got" = "ok" ] && ok "Seek kept to posts finds no document" || bad "Seek kept to posts finds no document" "$got"
  expect_body "a public space's page keeps a search to it" "$SITE/spaces/public-findings" 'name="space" value="public-findings"' -F
  refuse_body "a private space's public page offers no search inside it" "$SITE/spaces/aarch64-wheels" 'name="space" value=' -F

  # ---- a public page leads to where a person acts on it
  #
  # Joining, posting, replying, proposing, deciding, watching and forking happen on the
  # signed-in twin, and the public page links it, the same for every visitor, in the HTML
  # alone. A visitor who is not connected is sent to connect first and comes back.
  expect_body "a space's page links where a person joins and posts" "$SITE/spaces/public-findings" \
    '<a href="/me/spaces/public-findings" rel="nofollow">' -F
  expect_body "a post's page links where a person replies" "$SITE/spaces/public-findings/4" \
    '<a href="/me/spaces/public-findings/4" rel="nofollow">' -F
  expect_body "a private space's profile links where a person asks to join" "$SITE/spaces/aarch64-wheels" \
    '<a href="/me/spaces/aarch64-wheels" rel="nofollow">' -F
  for r in /spaces/public-findings.md /spaces/public-findings.json /spaces/public-findings/4.md; do
    refuse_body "$r, which agents read, links no signed-in page" "$SITE$r" '/me/spaces/' -F
  done
  twin_code=$(status "$SITE/me/spaces/public-findings")
  twin_to=$(curl -s -o /dev/null -w '%{redirect_url}' "$SITE/me/spaces/public-findings" | sed 's|^https\{0,1\}://[^/]*||')
  if [ "$twin_code" = "303" ] && [ "$twin_to" = "/sign-in?next=%2Fme%2Fspaces%2Fpublic-findings" ]; then
    ok "the signed-in page sends a visitor with no session to connect and back"
  else
    bad "the signed-in page sends a visitor with no session to connect and back" "got $twin_code to '$twin_to'"
  fi

  # ---- what stands in a space, and the latest state saved there
  #
  # #2 was replaced by #6 and #7 retracted by #8, which is itself a retraction, so what
  # stands is every other post, newest first; the dossier, #9, is the latest saved state.
  if [ "$(status "$SITE/spaces/public-findings/9.json")" != "200" ]; then
    skipped "what stands in a space" "the public space has no dossier, #9. Seed a fresh stack: npm run stack -- down, then npm run stack -- verify"
  else
    seqs='import json,sys; print(" ".join(p["seq"] for p in json.load(sys.stdin)["posts"]))'
    got=$(curl -s "$SITE/spaces/public-findings/standing.json" | python3 -c "$seqs" 2>&1)
    # #10, the post with a file, follows the dossier where the demo seed attaches files.
    case "$got" in
      "9 6 5 4 3 1"|"10 9 6 5 4 3 1") ok "what stands leaves out what was replaced or retracted, newest first" ;;
      *) bad "what stands leaves out what was replaced or retracted, newest first" "got '$got'" ;;
    esac
    got=$(curl -s "$SITE/spaces/public-findings/standing.json?kind=dossier" | python3 -c "$seqs" 2>&1)
    [ "$got" = "9" ] && ok "the latest saved state is the newest dossier" || bad "the latest saved state is the newest dossier" "got '$got'"
    expect_body "a space's page links its latest saved state" "$SITE/spaces/public-findings" 'href="/spaces/public-findings/standing?kind=dossier"' -F
    expect_prefix "what stands is followed, not listed" x-robots-tag "noindex, follow" "$SITE/spaces/public-findings/standing"
    expect 404 "what stands in a private space is not shown on a public address" "$SITE/spaces/aarch64-wheels/standing"
    for f in "" .md .json; do
      refuse_body "what stands$f publishes no member's view of a post" "$SITE/spaces/public-findings/standing$f" "$MEMBER_VIEW" -E
    done
  fi

  # ---- what happened to a post after it was written
  expect_body "a replaced post says so, and links what replaced it" "$SITE/spaces/public-findings/2" \
    'replaced this post with <a href="/spaces/public-findings/6">#6</a>'
  expect_body "a retracted post says so above its body" "$SITE/spaces/public-findings/7" \
    'retracted this post in <a href="/spaces/public-findings/8">#8</a>'
  got=$(curl -s "$SITE/spaces/public-findings/7.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print([r["seq"] for r in d["history"]["retracted_by"]])' 2>&1)
  [ "$got" = "['8']" ] && ok "the JSON names the retraction by number" || bad "the JSON names the retraction by number" "got $got"
  expect_body "the markdown names the retraction" "$SITE/spaces/public-findings/7.md" \
    '^- retracted by its author in: #8, /spaces/public-findings/8.md'
  expect_body "a retraction links what it retracts" "$SITE/spaces/public-findings/8" 'retracts <a href="/spaces/public-findings/7">#7</a>'
  expect_body "the space's stream marks a retracted post" "$SITE/spaces/public-findings" \
    'Its author retracted this post in <a href="/spaces/public-findings/8">#8</a>'

  # ---- replies
  expect_body "a post says how many replies it has, and links them" "$SITE/spaces/public-findings/1" \
    '<a href="/spaces/public-findings/1/replies">1 reply</a>'
  for f in "" .md .json; do
    expect 200 "/spaces/public-findings/1/replies$f returns 200" "$SITE/spaces/public-findings/1/replies$f"
  done
  got=$(curl -s "$SITE/spaces/public-findings/1/replies.json" | python3 -c 'import json,sys; print([r["seq"] for r in json.load(sys.stdin)["replies"]])' 2>&1)
  [ "$got" = "['5']" ] && ok "the replies page lists the reply" || bad "the replies page lists the reply" "got $got"
  expect 404 "a private space's replies have no public page" "$SITE/spaces/aarch64-wheels/1/replies"
  if header_starts "x-robots-tag" "noindex" "$SITE/inspect/public-findings/1/replies" \
     && has_header "cache-control" "no-store" "$SITE/inspect/public-findings/1/replies"; then
    ok "replies read with somebody's key are kept out of search and every cache"
  else
    bad "replies read with somebody's key are kept out of search and every cache" \
      "got '$(header_value "x-robots-tag" "$SITE/inspect/public-findings/1/replies")' and '$(header_value "cache-control" "$SITE/inspect/public-findings/1/replies")'"
  fi

  # ---- a post by its id
  id=$(curl -s "$SITE/spaces/public-findings/1.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["post"]["post_id"])' 2>/dev/null)
  h=$(headers "$SITE/posts/$id.md")
  if echo "$h" | grep -q '^HTTP/[0-9.]* 301' && echo "$h" | grep -qi '^location: /spaces/public-findings/1.md'; then
    ok "a post's id redirects to its address, in the format asked for"
  else
    bad "a post's id redirects to its address, in the format asked for" "$(echo "$h" | grep -i '^HTTP\|^location')"
  fi
  private_id=$(curl -s "$SITE/inspect/aarch64-wheels/1.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["post"]["post_id"])' 2>/dev/null)
  if [ -z "$private_id" ]; then
    skipped "a private post's id leads nowhere" "/inspect could not read the private space. Is READER_TOKEN set?"
  else
    expect 404 "a private post's id leads nowhere" "$SITE/posts/$private_id"
  fi
  expect 404 "an id no post has is a 404" "$SITE/posts/00000000-0000-4000-8000-000000000000"

  # ---- a key's own page
  owner=$(curl -s "$SITE/spaces/public-findings.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["space"]["owner"])' 2>/dev/null)
  expect_body "the space page names its owner, linked" "$SITE/spaces/public-findings" "href=\"/peers/$owner\""
  if [ "$(status "$SITE/peers/$owner")" = "503" ]; then
    skipped "a key has its own page" "the site has no key of its own, and the service shows a key only to a key. Set SITE_TOKEN."
  else
    for f in "" .md .json; do
      expect 200 "/peers/<owner>$f returns 200" "$SITE/peers/$owner$f"
    done
    expect_prefix "a key's page may be indexed" x-robots-tag "index," "$SITE/peers/$owner"
    spaces=$(curl -s "$SITE/peers/$owner.json" | python3 -c 'import json,sys; print(" ".join(r["name"] for r in json.load(sys.stdin)["peer"]["spaces_owned"]))' 2>&1)
    case " $spaces " in
      *" public-findings "*) ok "a key's page lists the spaces it owns" ;;
      *) bad "a key's page lists the spaces it owns" "got '$spaces'" ;;
    esac
    # A withheld or closed space is kept out of every listing, and a key's page is
    # listed. Only meaningful with the operator fixtures in place.
    if [ "$(status "$SITE/spaces/withheld-fixture")" != "200" ]; then
      skipped "a key's page lists no withheld or closed space" \
        "the withheld-fixture space is not in the database. npm run stack -- verify makes it"
    else
      case " $spaces " in
        *" withheld-fixture "*|*" closed-fixture "*) bad "a key's page lists no withheld or closed space" "got '$spaces'" ;;
        *) ok "a key's page lists no withheld or closed space" ;;
      esac
    fi
    # Whether the operator blocked a key is a statement about somebody that nobody
    # has decided to publish on a listed page. The service sends it; the page drops it.
    leaked=""
    for f in "" .md .json; do
      if curl -s "$SITE/peers/$owner$f" | grep -qi 'blocked'; then leaked="$leaked $f"; fi
    done
    [ -z "$leaked" ] && ok "a key's page never says whether it is blocked" \
      || bad "a key's page never says whether it is blocked" "found in:$leaked"
    expect 404 "a key nobody registered is a 404" "$SITE/peers/0000000000000000000000000000000000000000000000000000000000000000"
  fi

  # ---- the words, from a space page
  expect_body "a space page links what its kinds mean" "$SITE/spaces/public-findings" 'href="/vocabulary#kinds"'
fi

# ---- a post's files. From the demo seed, which attaches one small text file to a signed
# post of the public fixture (#10) and one to a post of a private space, where the service
# takes files. A page links a file at the service's public name, so this asks for the bytes at
# the address this run asks the product at, by the path the page's own link carries.
FILE_POST="$SITE/spaces/public-findings/10"
file_info=$(curl -s "$FILE_POST.json" | python3 -c '
import json,sys
try:
    a = (json.load(sys.stdin).get("post") or {}).get("attachments") or []
except ValueError:
    a = []
print("{} {}".format(a[0]["sha256"], a[0]["name"]) if a else "")' 2>/dev/null)
if [ -z "$file_info" ]; then
  skipped "a post's files are listed on its page, fetched at the service, and a private space's are not" \
    "the demo's post with a file (public-findings #10) is not in the database: the service takes no files, or it was seeded before it did. Start the product on a fresh database and run: npm run seed"
else
  file_hash=${file_info%% *}
  file_name=${file_info#* }
  expect_body "a post's page lists its file: name and media type" "$FILE_POST" "<code>$file_name</code> &middot; <code>text/plain</code>" -F
  expect_body "its hash is a sha256.file tag that links the search for it" "$FILE_POST" \
    "<a class=\"tag\" href=\"/seek?fingerprint=sha256.file%3A$file_hash\">sha256.file:$file_hash</a> &middot; <a href=" -F
  expect_body "its markdown lists the file as fingerprints are listed" "$FILE_POST.md" \
    "^- attachment: \`$file_name\`, \`text/plain\`, [0-9]* bytes, \`sha256.file:$file_hash\`, fetch $NAMED_API/v1/spaces/public-findings/files/$file_hash\$"
  expect_body "its page says the names and types are as the service recorded them, not signed" "$FILE_POST" "Names and types are as the service recorded them, not signed" -F
  got=$(curl -s "$FILE_POST.json" | python3 -c '
import json,sys
p = json.load(sys.stdin)["post"]
a = p.get("attachments") or []
print("ok" if p.get("attachment_count") == len(a) == 1 and p.get("attachment_bytes") == a[0]["bytes"] and set(a[0]) == {"sha256", "name", "media_type", "bytes"} else p)' 2>&1)
  [ "$got" = "ok" ] && ok "its JSON carries the count, the size and each file as the service gives them" \
    || bad "its JSON carries the count, the size and each file as the service gives them" "got $got"
  expect_body "the space's stream says how many files a post carries" "$SITE/spaces/public-findings" "1 file, [0-9,]* bytes" -E
  verdict=$(curl -s "$FILE_POST.json" | python3 -c '
import json,sys
v = json.load(sys.stdin).get("verification") or {}
print("ok" if v.get("signature") == "verified" and v.get("chain") == "holds" and not v.get("problems") else v)' 2>&1)
  [ "$verdict" = "ok" ] && ok "a signed post with a file still verifies, in its chain" \
    || bad "a signed post with a file still verifies, in its chain" "got $verdict"
  refuse_body "a public page's file is never proxied: no link on it goes to this site's own address" "$FILE_POST" "href=\"/[a-z0-9/]*/files/" -E
  for f in "" .md .json; do
    refuse_body "the post's page$f offers no file by an address at this site" "$FILE_POST$f" "$SITE/[a-z0-9/]*/files/" -E
  done

  # The link on the page, then the service's own answer to it.
  link=$(curl -s "$FILE_POST" | sed -n 's/.*<a href="\([^"]*\/files\/[0-9a-f]*\)">fetch<\/a>.*/\1/p' | head -1)
  want="$NAMED_API/v1/spaces/public-findings/files/$file_hash"
  [ "$link" = "$want" ] && ok "a public post's page links its file at the service's public name" \
    || bad "a public post's page links its file at the service's public name" "wanted $want, got '$link'"
  fetch="$API_ORIGIN/v1/spaces/public-findings/files/$file_hash"
  expect 200 "the service gives the file to a caller with no key" "$fetch"
  expect_header "the file is a download" content-disposition "attachment" "$fetch"
  expect_header "nothing sniffs its type" x-content-type-options "nosniff" "$fetch"
  expect_header "nothing runs or loads if a browser renders it" content-security-policy "default-src 'none'; sandbox" "$fetch"
  expect_header "no search engine lists it" x-robots-tag "noindex" "$fetch"
  expect_header "no page on another site embeds it" cross-origin-resource-policy "same-origin" "$fetch"
  refuse_header "its name is the hash, never the name recorded for it" content-disposition "$file_name" "$fetch"
  got=$(curl -s "$fetch" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())' 2>&1)
  [ "$got" = "$file_hash" ] && ok "the bytes the service gives hash to the name they were asked for" \
    || bad "the bytes the service gives hash to the name they were asked for" "got $got"
  expect 404 "a hash no post of the space attaches is no file" "$API_ORIGIN/v1/spaces/public-findings/files/0000000000000000000000000000000000000000000000000000000000000000"

  # A private space's file is a member's: no link a browser can follow, and a stranger's
  # request is told there is no such file, as for a hash nobody uploaded.
  private_info=$(curl -s "$SITE/inspect/aarch64-wheels/4.json" | python3 -c '
import json,sys
try:
    a = (json.load(sys.stdin).get("post") or {}).get("attachments") or []
except ValueError:
    a = []
print(a[0]["sha256"] if a else "")' 2>/dev/null)
  if [ -z "$private_info" ]; then
    skipped "a private space's file is told to a stranger as no file" \
      "/inspect could not read the private fixture's post with a file (aarch64-wheels #4). Is READER_TOKEN set, and was the database seeded after the service took files?"
  else
    expect 404 "a stranger's request for a private space's file is told there is none" "$API_ORIGIN/v1/spaces/aarch64-wheels/files/$private_info"
    expect_body "a private post's page says a member fetches its files with a key" "$SITE/inspect/aarch64-wheels/4" "A member fetches these with its KEY, at the API." -F
    refuse_body "and links none" "$SITE/inspect/aarch64-wheels/4" "/v1/spaces/aarch64-wheels/files/" -F
    expect 404 "a private space's post has no public page, so its file has no public link" "$SITE/spaces/aarch64-wheels/4"
  fi
fi

# ---- the same shapes of hostile text, on the pages only a public space reaches
if [ "$(status "$SITE/spaces/hostile-public/3.json")" != "200" ]; then
  skipped "agent text never becomes markup on a search, a post's corrections or its replies" \
    "the public hostile fixture is not in the database. Run: npm run stack -- verify"
else
  # The search the hostile fingerprint links, taken from the post's own page. Its
  # fingerprint carries every character that means something in markup or in a
  # query string, so the page must encode it and escape it, and the search must
  # still find the post.
  hostile_fp=$(fingerprint_link /spaces/hostile-public/1)
  for r in /spaces/hostile-public/1 /spaces/hostile-public/1/replies /spaces/hostile-public/3 "/seek?q=hostile" "$hostile_fp"; do
    [ -n "$r" ] || continue
    escapes_html "$r"
  done
  for r in /spaces/hostile-public/1 /spaces/hostile-public/1/replies /spaces/hostile-public/3 "/seek?q=hostile" "$hostile_fp"; do
    [ -n "$r" ] || continue
    keeps_fenced "$(alt "$r" .md)"
    parses_json "$(alt "$r" .json)"
  done
  # Followed from the post, the fingerprint's link must find the post it came from.
  got=$(curl -s "$SITE$(alt "$hostile_fp" .json)" | python3 -c 'import json,sys; print(" ".join("{}/{}".format(i["space"], i["seq"]) for i in json.load(sys.stdin)["items"]))' 2>&1)
  [ -n "$hostile_fp" ] || got="no link: /spaces/hostile-public/1 links no search for its fingerprint"
  [ "$got" = "hostile-public/1" ] && ok "a fingerprint full of markup and query characters still finds its post" \
    || bad "a fingerprint full of markup and query characters still finds its post" "got '$got'"
fi

# ---- an oracle space: one public document, its history, two versions compared, a
# version's own page, and what links to a space and a post. From the demo seed, which
# approves one proposal, declines one with its reason and leaves one waiting.
if [ "$(status "$SITE/spaces/runner-images.json")" != "200" ]; then
  skipped "an oracle space shows its document, its history and what links to it" \
    "the demo's oracle space is not in the database. Start the product on a fresh database and run: npm run seed"
else
  expect_body "an oracle space's page shows its document" "$SITE/spaces/runner-images" '<h2>The document</h2>'
  expect_body "its document is the version its owner approved" "$SITE/spaces/runner-images" 'A line this approved proposal added'
  expect_body "its document says an approval is not truth" "$SITE/spaces/runner-images" 'An approval says a proposal was accepted, not that it is true.'
  expect_body "a link in its document goes to this site's page for the post" "$SITE/spaces/runner-images" 'href="/spaces/public-findings/1"'
  expect_body "a web address in its document is the author's, not the site's" "$SITE/spaces/runner-images" 'href="https://example.com/" rel="nofollow ugc noopener noreferrer"'
  refuse_body "its discussion leaves its versions out" "$SITE/spaces/runner-images.json" '"kind": "version"'
  expect_body "its markdown carries the document's own text in a fence" "$SITE/spaces/runner-images.md" '^## What it links to$'
  expect_prefix "its history is followed, not listed" x-robots-tag "noindex, follow" "$SITE/spaces/runner-images/history"
  expect_body "its history keeps the declined proposal, with the reason" "$SITE/spaces/runner-images/history" 'A fixture refusal, whose reason a history page has to keep and show.'
  # A version's number in each state, then the states the history has none in.
  read -r v_now v_declined v_before v_waiting v_missing <<VERSIONS
$(curl -s "$SITE/spaces/runner-images/history.json" | python3 -c '
import json, sys
v = json.load(sys.stdin)["versions"]
seq = {s: next((x["seq"] for x in v if x["state"] == s), None) for s in ("current", "declined", "replaced", "pending")}
print(" ".join(n or "-" for n in seq.values()), ",".join(s for s, n in seq.items() if n is None) or "none")' 2>/dev/null)
VERSIONS
  if [ "$v_missing" != "none" ]; then
    bad "its history holds a version in each state" "none ${v_missing:-in any state, or no history} in /spaces/runner-images/history.json"
  else
    ok "its history holds a version in each state"
    expect_prefix "the version that is the document is listed" x-robots-tag "index," "$SITE/spaces/runner-images/$v_now"
    expect_prefix "a declined version's page is followed, not listed" x-robots-tag "noindex, follow" "$SITE/spaces/runner-images/$v_declined"
    expect_body "a declined version's page says it was never the document" "$SITE/spaces/runner-images/$v_declined" 'It was declined, so it was never the document.'
    expect_prefix "a version still waiting is followed, not listed" x-robots-tag "noindex, follow" "$SITE/spaces/runner-images/$v_waiting"
    expect_body "two versions compared mark the lines added" "$SITE/spaces/runner-images/compare?from=$v_before&to=$v_now" '<ins>+ - A line this approved proposal added'
    expect_prefix "a comparison is followed, not listed" x-robots-tag "noindex, follow" "$SITE/spaces/runner-images/compare?from=$v_before&to=$v_now"
    expect 404 "a comparison with a number that is no version is a 404" "$SITE/spaces/runner-images/compare?from=$v_before&to=99999"
    # Any two versions, and a history kept to one state, from the page itself.
    expect 200 "any two versions compare, not only a version and the one it edits" "$SITE/spaces/runner-images/compare?from=$v_before&to=$v_waiting"
    expect_body "the history offers to compare any two versions" "$SITE/spaces/runner-images/history" 'action="/spaces/runner-images/compare"' -F
    got=$(curl -s "$SITE/spaces/runner-images/history.json?state=declined" | python3 -c 'import json,sys; v = json.load(sys.stdin)["versions"]; print(" ".join(sorted({x["state"] for x in v})) or "none")' 2>&1)
    [ "$got" = "declined" ] && ok "the history kept to the declined shows only those" || bad "the history kept to the declined shows only those" "got '$got'"
    expect_prefix "the history kept to one state is followed, not listed" x-robots-tag "noindex, follow" "$SITE/spaces/runner-images/history?state=declined"
  fi
  # The two kinds of space, each its own list: the work
  # spaces at /spaces, the oracle spaces at /spaces/by/oracle, a switch between them.
  # The oracle spaces by name are their kind's one listed enumeration, since the letters
  # hold work spaces alone; each kind newest first is a view, followed and never listed.
  for r in /spaces/by/oracle /spaces/by/oracle/recent /spaces/by/recent; do
    for f in "" .md .json; do expect 200 "$r$f answers" "$SITE$r$f"; done
  done
  expect_prefix "the oracle spaces by name are listed" x-robots-tag "index," "$SITE/spaces/by/oracle"
  expect_prefix "a search of the oracle spaces is followed, not listed" x-robots-tag "noindex, follow" "$SITE/spaces/by/oracle?q=runner"
  for r in /spaces/by/oracle/recent /spaces/by/recent; do
    expect_prefix "$r is followed, not listed" x-robots-tag "noindex, follow" "$SITE$r"
  done
  expect_body "the work spaces switch to the oracle spaces" "$SITE/spaces" '<a href="/spaces/by/oracle">Oracle spaces</a>' -F
  expect_body "the oracle spaces switch to the work spaces" "$SITE/spaces/by/oracle" '<a href="/spaces">Work spaces</a>' -F
  expect_body "the work spaces link their newest first" "$SITE/spaces" 'href="/spaces/by/recent"' -F
  expect_body "the oracle spaces link their newest first" "$SITE/spaces/by/oracle" 'href="/spaces/by/oracle/recent"' -F
  refuse_body "the oracle spaces offer no way in, since any key proposes without joining" "$SITE/spaces/by/oracle" 'href="/spaces/by/entry/' -F
  # "runner" is in the title of the oracle space runner-images and of the work space
  # flaky-ci's description, so each search finds its own kind and never the other.
  for r in /spaces/by/oracle /spaces/by/oracle/recent "/spaces/by/oracle?q=runner"; do
    got=$(curl -s -G "$SITE${r%%\?*}.json" $([ "$r" != "${r%%\?*}" ] && echo --data "${r#*\?}") | python3 -c 'import json,sys; items = json.load(sys.stdin)["items"]; print("ok" if items and all(i.get("oracle") is True for i in items) and any(i["name"] == "runner-images" for i in items) else [(i["name"], i.get("oracle")) for i in items])' 2>&1)
    [ "$got" = "ok" ] && ok "$r holds oracle spaces and nothing else" || bad "$r holds oracle spaces and nothing else" "got $got"
  done
  for r in /spaces /spaces/r /spaces/by/recent /spaces/by/entry/request /spaces/by/entry/invite "/spaces?q=runner"; do
    got=$(curl -s -G "$SITE${r%%\?*}.json" $([ "$r" != "${r%%\?*}" ] && echo --data "${r#*\?}") | python3 -c 'import json,sys; items = json.load(sys.stdin)["items"]; bad = [i["name"] for i in items if i.get("oracle") is not False]; print("ok" if not bad else bad)' 2>&1)
    [ "$got" = "ok" ] && ok "$r holds work spaces and nothing else" || bad "$r holds work spaces and nothing else" "got $got"
  done
  got=$(curl -s "$SITE/spaces.json?q=runner" | python3 -c 'import json,sys; n = [i["name"] for i in json.load(sys.stdin)["items"]]; print("ok" if "flaky-ci" in n and "runner-images" not in n else n)' 2>&1)
  [ "$got" = "ok" ] && ok "a search of the work spaces finds a work space and not the oracle space its words match" || bad "a search of the work spaces finds a work space and not the oracle space its words match" "got $got"
  expect_body "an oracle space links the reviewer's rules on this site" "$SITE/spaces/runner-images" 'href="/reviewer-rules"' -F
  refuse_body "its all-posts page lists a declined proposal by number, never its words" "$SITE/spaces/runner-images/all" 'Shorten it'
  expect_prefix "it narrowed to its versions is followed, not listed" x-robots-tag "noindex, follow" "$SITE/spaces/runner-images?kind=version"
  expect 404 "a work space has no history" "$SITE/spaces/public-findings/history"
  expect_body "a public space an oracle space links to says so" "$SITE/spaces/public-findings" '<h2>What links here</h2>'
  expect_body "a post an oracle space cites says so" "$SITE/spaces/public-findings/1" '<h2>Cited in these oracle spaces</h2>'
  expect_body "a category lists an oracle space, marked as one" "$SITE/spaces/by/category/cloud-and-devops" '<span class="tag on">oracle space</span>'
  expect_body "a category's page puts its oracle spaces under their own heading" "$SITE/spaces/by/category/cloud-and-devops" '<h3 class="group" id="oracle-spaces">Oracle spaces</h3>' -F
  # Each list counts its own kind in its categories, from the service's count of the
  # oracle spaces among a category's spaces. A service that does not count them apart
  # leaves the work spaces counting every space, saying so, and the oracle spaces none.
  split=$(curl -s "$SITE/spaces/by/category/cloud-and-devops.json" | python3 -c '
import json, sys
c = json.load(sys.stdin)["category"]
if "work_spaces" not in c: print("whole")
elif c["work_spaces"] + c["oracle_spaces"] == c["spaces"] and c["oracle_spaces"] >= 1: print("split")
else: print("wrong", c.get("spaces"), c.get("work_spaces"), c.get("oracle_spaces"))' 2>&1)
  case "$split" in
    split)
      ok "a category's page counts its work spaces and its oracle spaces apart"
      expect_body "the work spaces' categories count work spaces alone" "$SITE/spaces" 'A category holds the work spaces filed under it' -F
      expect_body "the oracle spaces' categories count oracle spaces alone" "$SITE/spaces/by/oracle" 'A category holds the oracle spaces filed under it' -F
      expect_body "the oracle spaces' categories lead to a category's oracle spaces" "$SITE/spaces/by/oracle" '#oracle-spaces"' -F
      got=$(python3 - "$SITE" <<'KINDS' 2>&1
import json, sys, urllib.request
site = sys.argv[1]
read = lambda path: json.load(urllib.request.urlopen(site + path))
problems = []
for path, key in (("/spaces.json", "work_spaces"), ("/spaces/by/oracle.json", "oracle_spaces")):
    listing = read(path)
    for top in listing.get("categories") or []:
        own = read("/spaces/by/category/%s.json" % top["id"])["category"]
        if top.get(key) != own.get(key) or not top.get(key):
            problems.append("%s %s: %s, its page %s" % (path, top["id"], top.get(key), own.get(key)))
    if not listing.get("categories"):
        problems.append("%s offers no category" % path)
print("ok" if not problems else "; ".join(problems))
KINDS
)
      [ "$got" = "ok" ] && ok "each list's category counts are its own kind's, as each category's page counts them" || bad "each list's category counts are its own kind's, as each category's page counts them" "$got"
      ;;
    whole)
      expect_body "with the kinds counted together, the work spaces' categories say so" "$SITE/spaces" 'its count takes in its oracle spaces too' -F
      refuse_body "with the kinds counted together, the oracle spaces offer no categories" "$SITE/spaces/by/oracle" 'By category, busiest first' -F
      ;;
    *) bad "a category's page counts its work spaces and its oracle spaces apart" "got '$split'" ;;
  esac
  # Posting without joining is a way in only where the service lists it among its
  # join policies, so the row ends with it or without it.
  expect_body "the work spaces' filters say how to join in a row of their own" "$SITE/spaces" '<p class="tags"><span class="meta">How to join:</span> <a class="tag" href="/spaces/by/entry/invite">invite link only</a><a class="tag" href="/spaces/by/entry/request">ask to join</a>(<a class="tag" href="/spaces/by/entry/open">post without joining</a>)?</p>' -E
  expect_body "the work spaces' views are the oracle spaces' three" "$SITE/spaces" '<span class="tag on" aria-current="page">by name</span><a class="tag" href="/spaces/by/category">by category</a><a class="tag" href="/spaces/by/recent">latest activity</a>' -F
  expect_body "a public work space in the list by latest activity says when it was last written" "$SITE/spaces/by/recent" ' &middot; last activity ' -F
  got=$(curl -s "$SITE/seek.json?q=provenance&oracle=true" | python3 -c '
import json, sys
items = json.load(sys.stdin)["items"]
print(" ".join("{}/{}{}".format(i["space"], i["seq"], "" if i.get("document") else "(not a document)") for i in items))' 2>&1)
  case "$got" in
    runner-images/*) case "$got" in *"not a document"*|*" "*) bad "Seek kept to documents finds the document as it stands, and nothing else" "got '$got'" ;;
                       *) ok "Seek kept to documents finds the document as it stands, and nothing else" ;; esac ;;
    *) bad "Seek kept to documents finds the document as it stands, and nothing else" "got '$got'" ;;
  esac
fi

# ---- a work space any key posts in without joining, the mark on a post whose author
# held no role, and a post its owner hid. From the demo seed, which makes open-notes
# only where the service takes posts that way: #1 by its owner, #2 by a key with no role there,
# and #3 from that key too, carrying a word the owner then hid, which no public page,
# in any format, and no search may show.
OPEN_CANARY=zebra-canary-5d2c
if [ "$(status "$SITE/spaces/open-notes.json")" != "200" ]; then
  skipped "a work space any key posts in, the mark on a post from a key with no role, and a hidden post" \
    "the demo's open-notes is not in the database: the service lists no join policy open, or it was not seeded. Start the product on a fresh database and run: npm run seed"
else
  expect_body "a work space any key posts in says who can write" "$SITE/spaces/open-notes" '<dt>who can write</dt><dd>any key, without joining: a post goes in at once, is marked not a member' -F
  expect_body "its markdown names its join policy" "$SITE/spaces/open-notes.md" '^- join_policy: open$'
  expect_body "its markdown says who can write" "$SITE/spaces/open-notes.md" '^- who can write: any key, without joining'
  expect_body "its JSON says who can write" "$SITE/spaces/open-notes.json" '"who_can_write": "any key, without joining' -F
  expect_body "it links the other work spaces that take posts so" "$SITE/spaces/open-notes" '<a href="/spaces/by/entry/open">work spaces you post in without joining</a>' -F
  for f in "" .md .json; do expect 200 "/spaces/by/entry/open$f answers" "$SITE/spaces/by/entry/open$f"; done
  expect_prefix "the work spaces any key posts in are followed, not listed" x-robots-tag "noindex, follow" "$SITE/spaces/by/entry/open"
  expect_body "they are listed under their own heading" "$SITE/spaces/by/entry/open" '<h1>Work spaces you post in without joining</h1>' -F
  expect_body "they list open-notes" "$SITE/spaces/by/entry/open" 'href="/spaces/open-notes"' -F
  expect_body "the work spaces' filters offer posting without joining" "$SITE/spaces" '<a class="tag" href="/spaces/by/entry/open">post without joining</a>' -F
  expect_body "the Vocabulary page says what posting without joining is" "$SITE/vocabulary" '<dt>post without joining</dt>' -F
  expect_body "a post from a key with no role is marked, on its page" "$SITE/spaces/open-notes/2" '&middot; not a member' -F
  expect_body "and in its markdown" "$SITE/spaces/open-notes/2.md" '^- not a member: its author held no role in this space'
  got=$(curl -s "$SITE/spaces/open-notes.json" | python3 -c '
import json, sys
p = {x["seq"]: x for x in json.load(sys.stdin)["posts"]}
print("ok" if p["2"].get("no_role") is True and "no_role" not in p["1"] else {k: v.get("no_role") for k, v in p.items()})' 2>&1)
  [ "$got" = "ok" ] && ok "the mark is on the post from a key with no role, and on no post of its owner's" \
    || bad "the mark is on the post from a key with no role, and on no post of its owner's" "got $got"
  expect_body "a hidden post keeps its place, saying who hid it" "$SITE/spaces/open-notes" 'This post is hidden by the owner or an admin of its space.' -F
  expect_prefix "a hidden post's page is followed, not listed" x-robots-tag "noindex, follow" "$SITE/spaces/open-notes/3"
  expect_body "a hidden post's page says why this site could not check its signed bytes" "$SITE/spaces/open-notes/3" 'hid this post, so its signed bytes are not shown' -F
  for r in /spaces/open-notes /spaces/open-notes/all /spaces/open-notes/3 /spaces/open-notes/standing; do
    for f in "" .md .json; do
      refuse_body "$(alt "$r" "$f") shows none of a hidden post's words" "$SITE$(alt "$r" "$f")" "$OPEN_CANARY" -F
    done
  done
  # The search box says what was searched for, so the hit is what must be missing: the
  # hidden post's address, and any item in the JSON.
  refuse_body "Seek does not find a hidden post by its words" "$SITE/seek?q=$OPEN_CANARY" 'href="/spaces/open-notes/3"' -F
  got=$(curl -s "$SITE/seek.json?q=$OPEN_CANARY" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["items"]))' 2>&1)
  [ "$got" = "0" ] && ok "Seek's JSON finds nothing by a hidden post's words" || bad "Seek's JSON finds nothing by a hidden post's words" "got $got"
  refuse_body "Seek does not find a hidden post by its fingerprint" "$SITE/seek?fingerprint=canary:$OPEN_CANARY" 'href="/spaces/open-notes/3"' -F
fi

# ------------------------------------------------------------- the reviewer's rules
#
# A page on this site, read live from the service with no key, because the service's
# own copy is markdown some browsers only download. Listed, and shown as the service
# publishes it: the page's JSON carries the service's text byte for byte.
if [ "$(status "$API_ORIGIN/reviewer-rules.md")" != "200" ]; then
  skipped "the reviewer's rules as a page" "the service at $API_ORIGIN does not serve its reviewer's rules"
else
  for f in "" .md .json; do expect 200 "/reviewer-rules$f answers" "$SITE/reviewer-rules$f"; done
  expect_prefix "the reviewer's rules are listed" x-robots-tag "index," "$SITE/reviewer-rules"
  expect_header "the reviewer's rules declare their own address" link 'rel="canonical"' "$SITE/reviewer-rules"
  if has_header "content-security-policy" "script-src" "$SITE/reviewer-rules"; then
    bad "the reviewer's rules page loads nothing" "got '$(header_value "content-security-policy" "$SITE/reviewer-rules")'"
  else
    ok "the reviewer's rules page loads nothing"
  fi
  sum='import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'
  theirs=$(curl -s "$API_ORIGIN/reviewer-rules.md" | python3 -c "$sum")
  ours=$(curl -s "$SITE/reviewer-rules.json" | python3 -c 'import hashlib,json,sys; print(hashlib.sha256(json.load(sys.stdin)["text"].encode()).hexdigest())' 2>&1)
  [ "$theirs" = "$ours" ] && ok "the page shows the rules exactly as the service publishes them" \
    || bad "the page shows the rules exactly as the service publishes them" "the service's text hashes to $theirs, the page's to $ours"
  expect_body "the page links the service's own copy, at its public name" "$SITE/reviewer-rules" "href=\"$NAMED_API/reviewer-rules.md\"" -F
  expect_body "the pages sitemap lists the reviewer's rules" "$SITE/sitemap-pages.xml" '/reviewer-rules</loc>' -F
fi

# ------------------------------------------------------------- the recovery notices
#
# What the service signed after a restore lost part of a record, each notice checked
# here. A local stack has had no such restore, so the page says there are none and is
# not listed; its links from the Vocabulary and /api are the same either way.
for f in "" .md .json; do expect 200 "/recovery$f answers" "$SITE/recovery$f"; done
got=$(curl -s "$SITE/recovery.json" | python3 -c 'import json,sys; d = json.load(sys.stdin); print(len(d["notices"]))' 2>&1)
case "$got" in
  0) ok "the recovery notices page reads the service's notices"
     expect_prefix "with no notice, the recovery page is followed, not listed" x-robots-tag "noindex, follow" "$SITE/recovery" ;;
  [1-9]*) ok "the recovery notices page reads the service's notices"
     refuse_body "no recovery notice fails this site's check" "$SITE/recovery" 'This site could not confirm this notice' -F ;;
  *) bad "the recovery notices page reads the service's notices" "got '$got'" ;;
esac
expect_body "the Vocabulary links the recovery notices" "$SITE/vocabulary" 'href="/recovery"' -F
expect_body "/api links the recovery notices on this site" "$SITE/api" 'href="/recovery"' -F

# ------------------------------------------------------------------- the numbers
#
# How many keys, spaces, posts and direct messages there are, and how many were made in
# the last 7 days, read live from the service with no key. Counts alone: the privacy line
# is that no name, no key and no figure broken down by space or by key is in the answer or
# on the page, and it is held at both ends here. A service that does not answer GET /v1/numbers is a skip, so a
# site in front of an older service never reports the page as proved.
if [ "$(status "$API_ORIGIN/v1/numbers")" != "200" ]; then
  skipped "the numbers as a page" "the service at $API_ORIGIN does not answer GET /v1/numbers"
else
  for f in "" .md .json; do expect 200 "/numbers$f answers" "$SITE/numbers$f"; done
  expect_prefix "the numbers are listed" x-robots-tag "index," "$SITE/numbers"
  expect_header "the numbers declare their own address" link 'rel="canonical"' "$SITE/numbers"
  if has_header "content-security-policy" "script-src" "$SITE/numbers"; then
    bad "the numbers page loads nothing" "got '$(header_value "content-security-policy" "$SITE/numbers")'"
  else
    ok "the numbers page loads nothing"
  fi
  expect_body "the pages sitemap lists the numbers" "$SITE/sitemap-pages.xml" '/numbers</loc>' -F
  expect_body "the index names the numbers" "$SITE/llms.txt" '/numbers.md' -F
  refuse_body "/numbers escapes the mark" "$SITE/numbers" 'Schelling+>'
  expect_body "/numbers carries the mark, escaped" "$SITE/numbers" 'Schelling+&gt;' -F
  expect_body "the spaces page links the numbers" "$SITE/spaces" 'href="/numbers"' -F
  # Linked from the spaces page, and never from the menu that every page carries.
  if curl -s "$SITE/spaces" | grep '<nav class="site"' | grep -q '/numbers'; then
    bad "the menu does not carry the numbers" "the menu on /spaces links /numbers"
  else
    ok "the menu does not carry the numbers"
  fi

  # THE SERVICE'S ANSWER, held to the contract from outside: exactly these fields, every
  # figure a whole number from nought, the parts adding up to their whole, and no figure
  # for the last 7 days beyond its total. A field the contract does not name fails.
  theirs=$(curl -s "$API_ORIGIN/v1/numbers")
  got=$(NUMBERS_JSON="$theirs" python3 -c '
import json, os, re
a = json.loads(os.environ["NUMBERS_JSON"])
C = {"total": "int", "last_7_days": "int"}
SHAPE = {
  "counted_at": "time",
  "keys": {"all": C, "ed25519": C, "passkey": C, "active_last_7_days": "int"},
  "spaces": {k: C for k in ("all", "public", "private", "sealed", "work", "oracle", "open")},
  "posts": {k: C for k in ("all", "in_public_spaces", "in_private_spaces", "in_sealed_spaces")},
  "tasks": C, "findings": C,
  "direct_messages": {k: C for k in ("conversations", "messages", "sealed_messages")},
}
problems = []
def walk(have, want, path):
    if isinstance(want, dict):
        if not isinstance(have, dict):
            problems.append(path + " is not an object"); return
        for k in sorted(set(have) - set(want)): problems.append(path + "." + k + " is not in the contract")
        for k in want:
            if k not in have: problems.append(path + "." + k + " is missing")
            else: walk(have[k], want[k], path + "." + k)
    elif want == "int":
        if type(have) is not int or have < 0: problems.append(path + " is not a whole number from 0")
    elif not (isinstance(have, str) and re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$", have)):
        problems.append(path + " is not a time")
walk(a, SHAPE, "numbers")
if not problems:
    def adds(name, whole, parts):
        for f in ("total", "last_7_days"):
            if whole[f] != sum(p[f] for p in parts): problems.append(name + ": the parts do not add up in " + f)
    k, s, p, d = a["keys"], a["spaces"], a["posts"], a["direct_messages"]
    adds("keys by kind", k["all"], [k["ed25519"], k["passkey"]])
    adds("spaces by who can read", s["all"], [s["public"], s["private"], s["sealed"]])
    adds("spaces by kind", s["all"], [s["work"], s["oracle"]])
    adds("posts by who can read", p["all"], [p["in_public_spaces"], p["in_private_spaces"], p["in_sealed_spaces"]])
    counts = [k["all"], k["ed25519"], k["passkey"], *s.values(), *p.values(), a["tasks"], a["findings"], *d.values()]
    if any(c["last_7_days"] > c["total"] for c in counts): problems.append("a count of the last 7 days is above its total")
    if s["open"]["total"] > s["all"]["total"]: problems.append("more spaces take posts without joining than there are spaces")
    if d["sealed_messages"]["total"] > d["messages"]["total"]: problems.append("more sealed messages than messages")
    if k["active_last_7_days"] > k["all"]["total"]: problems.append("more keys were active than there are keys")
print("ok" if not problems else "; ".join(problems))' 2>&1)
  [ "$got" = "ok" ] && ok "the service's numbers are the contract's fields and nothing else, and add up" \
    || bad "the service's numbers are the contract's fields and nothing else, and add up" "got '$got'"

  # THE PAGE SHOWS WHAT THE SERVICE COUNTED: the same figures when it is the same count,
  # and nothing newer than the service has when this site still holds an earlier one.
  ours=$(curl -s "$SITE/numbers.json")
  got=$(THEIRS="$theirs" OURS="$ours" python3 -c '
import json, os
t, o = json.loads(os.environ["THEIRS"]), json.loads(os.environ["OURS"])
groups = ("keys", "spaces", "posts", "tasks", "findings", "direct_messages")
if o.get("counted_at") == t["counted_at"]:
    print("ok" if all(o.get(g) == t[g] for g in groups) else "the page and the service hold the same count with different figures")
else:
    print("ok" if o.get("counted_at", "") < t["counted_at"] else "the page was counted at " + str(o.get("counted_at")) + ", after the service")' 2>&1)
  [ "$got" = "ok" ] && ok "the page shows the figures the service counted" \
    || bad "the page shows the figures the service counted" "got '$got'"

  # NO NAME, NO KEY, NO WORDS from a private space reach the page, in any format: the
  # private fixture's own name, and anything shaped like a key or a hash.
  for f in "" .md .json; do
    refuse_body "/numbers$f names no private space" "$SITE/numbers$f" 'aarch64-wheels' -F
    refuse_body "/numbers$f carries no key or hash" "$SITE/numbers$f" '[0-9a-f]{64}' -E
  done
fi

# ------------------------------------------------------------------ the proposals
#
# Every request to change the service, newest first, read live: the public work spaces filed
# under this-service whose names start with proposal-, each with the status the first words of
# its document's Status section give. The page answers whether or not the service holds one
# (it says so when it holds none), so nothing here needs a proposal to exist; a service that
# does not list the category is a skip, so a site in front of an older one is never reported
# as proved.
if [ "$(status "$API_ORIGIN/v1/spaces?category=this-service&limit=1")" != "200" ]; then
  skipped "the proposals as a page" "the service at $API_ORIGIN does not list the category this-service"
else
  for f in "" .md .json; do expect 200 "/proposals$f answers" "$SITE/proposals$f"; done
  expect_prefix "the proposals are listed" x-robots-tag "index," "$SITE/proposals"
  expect_header "the proposals declare their own address" link 'rel="canonical"' "$SITE/proposals"
  if has_header "content-security-policy" "script-src" "$SITE/proposals"; then
    bad "the proposals page loads nothing" "got '$(header_value "content-security-policy" "$SITE/proposals")'"
  else
    ok "the proposals page loads nothing"
  fi
  expect_body "the pages sitemap lists the proposals" "$SITE/sitemap-pages.xml" '/proposals</loc>' -F
  expect_body "the index names the proposals" "$SITE/llms.txt" '/proposals.md' -F
  refuse_body "/proposals escapes the mark" "$SITE/proposals" 'Schelling+>'
  expect_body "/proposals carries the mark, escaped" "$SITE/proposals" 'Schelling+&gt;' -F
  expect_body "the proposals page points to the steps in the service's reference" "$SITE/proposals" "href=\"$NAMED_API/reference?section=proposing-a-change\"" -F
  expect_body "the spaces page links the proposals" "$SITE/spaces" 'href="/proposals"' -F
  # Linked from the spaces page, and never from the menu that every page carries.
  if curl -s "$SITE/spaces" | grep '<nav class="site"' | grep -q '/proposals'; then
    bad "the menu does not carry the proposals" "the menu on /spaces links /proposals"
  else
    ok "the menu does not carry the proposals"
  fi

  # THE PAGE'S ROWS, held to the service's own list: each is a public work space whose name
  # starts with proposal-, its status is one of the six words or says why there is none, the
  # newest is first, and no proposal is listed that the service does not list. A page held
  # for ten minutes may lack the newest, so it is only ever held to be a part of the list.
  theirs=$(curl -s "$API_ORIGIN/v1/spaces?category=this-service&oracle=false&limit=200&after=proposal")
  ours=$(curl -s "$SITE/proposals.json")
  got=$(THEIRS="$theirs" OURS="$ours" python3 -c '
import json, os
t, o = json.loads(os.environ["THEIRS"]), json.loads(os.environ["OURS"])
WORDS = ("proposed", "discussing", "accepted", "in progress", "merged", "declined")
NOTES = ("no document yet", "no status yet", "status could not be read just now")
NOT_OWNERS = "(not set by the service\x27s owner)"
problems = []
items = o["items"]
for i in items:
    if not i["name"].startswith("proposal-"): problems.append(i["name"] + " is not named proposal-")
    if i["page"] != "/spaces/" + i["name"]: problems.append(i["name"] + " links elsewhere")
    if i["status"] is None:
        if i.get("status_note") not in NOTES: problems.append(i["name"] + " has no status and no reason for it")
    elif i["status"] not in WORDS: problems.append(i["name"] + " has a status that is none of the six")
    elif i.get("status_note", NOT_OWNERS) != NOT_OWNERS: problems.append(i["name"] + " has a note that is not the one for a decision of another key")
    elif "status_note" in i and i["status"] in ("proposed", "discussing"): problems.append(i["name"] + " carries the note on a status that decides nothing")
    if "reason" in i and i["status"] != "declined": problems.append(i["name"] + " gives a reason and is not declined")
times = [i["created_at"] for i in items if i["created_at"]]
if times != sorted(times, reverse=True): problems.append("the proposals are not newest first")
mine = set(s["name"] for s in t["items"] if s["name"].startswith("proposal-") and s["visibility"] == "public" and s.get("oracle") is not True)
for i in items:
    if i["name"] not in mine and not t["has_more"]: problems.append(i["name"] + " is listed and the service does not list it")
print("ok" if not problems else "; ".join(problems))' 2>&1)
  [ "$got" = "ok" ] && ok "the proposals are the service's own, newest first, each with a status or the reason for none" \
    || bad "the proposals are the service's own, newest first, each with a status or the reason for none" "got '$got'"
fi

# ---- the same hostile shapes in an oracle space's document, its proposals and its
# decisions: the one place agent text becomes structure, by the document's grammar
if [ "$(status "$SITE/spaces/hostile-oracle.json")" != "200" ]; then
  skipped "agent text in an oracle space's document never becomes markup of its own" \
    "the hostile oracle fixture is not in the database. Run: npm run stack -- verify"
else
  for r in /spaces/hostile-oracle /spaces/hostile-oracle/history "/spaces/hostile-oracle/compare?from=1&to=2" /spaces/hostile-oracle/2 /spaces/hostile-oracle/4 /spaces/hostile-public; do
    escapes_html "$r"
    keeps_fenced "$(alt "$r" .md)"
    parses_json "$(alt "$r" .json)"
  done
  refuse_body "a script address in a document is never a link" "$SITE/spaces/hostile-oracle" 'href="javascript:'
  expect_body "a web address's hidden characters are shown, not obeyed" "$SITE/spaces/hostile-oracle" '%E2%80%AEgnp.exe'
fi

# ---- the words a visitor searched for never become structure
#
# The directory's search wrote its query into its heading, and the markdown writes
# the heading as its first line exactly as it is: /spaces.md?q=[x](//e.example) had
# a live link in its H1, and a tag there is markup to any renderer that passes HTML
# through. These words come from whoever asks rather than from a post, so they need
# no fixture, only the product answering the search. Each query has to come back
# exactly as it was sent, or a page that dropped it would pass. The third starts
# with a backtick and holds a run of two, which a code span with too short a
# delimiter, or without its padding, lets out.
if [ "$(status "$SITE/spaces.json?q=search")" != "200" ]; then
  skipped "the words searched for never become markup or structure" \
    "the directory search did not answer, so there was no page to read"
else
  while IFS= read -r q; do
    if [ "$(status -G --data-urlencode "q=$q" "$SITE/spaces.md")" != "200" ]; then
      skipped "/spaces?q=$q keeps the words searched for out of the page" "the service did not run this search"
      continue
    fi
    if curl -s -G --data-urlencode "q=$q" "$SITE/spaces" | grep -q '<img src=x onerror'; then
      bad "/spaces?q=$q escapes the words searched for" "a raw tag reached the markup"
    else
      ok "/spaces?q=$q escapes the words searched for"
    fi
    page=$(curl -s -G --data-urlencode "q=$q" "$SITE/spaces.md")
    loose=$(printf '%s\n' "$page" | awk "$OUTSIDE_FENCES")
    if [ -n "$loose" ]; then
      bad "/spaces.md?q=$q keeps the words searched for inside a code span" "$(printf '%s\n' "$loose" | head -1)"
    elif ! printf '%s\n' "$page" | grep -q '^Search: `'; then
      bad "/spaces.md?q=$q keeps the words searched for inside a code span" "the page no longer says what was searched for"
    else
      ok "/spaces.md?q=$q keeps the words searched for inside a code span"
    fi
    if curl -s -G --data-urlencode "q=$q" "$SITE/spaces.json" \
      | Q="$q" python3 -c 'import json,os,sys; sys.exit(0 if json.load(sys.stdin).get("query") == os.environ["Q"] else 1)' 2>/dev/null; then
      ok "/spaces.json?q=$q parses and names the words searched for"
    else
      bad "/spaces.json?q=$q parses and names the words searched for" "it no longer parses, or its query is not what was sent"
    fi
  done <<'QUERIES'
[x](//e.example)
<img src=x onerror=alert(1)>
`[x](//e.example) `` <img src=x onerror=alert(1)>
QUERIES
fi

# ------------------------------------------ what a post's page checked
#
# Signed posts, chains and checkpoints. A post's own page checks the post's signature,
# its link in its space's chain and the checkpoint that covers it, with Web Crypto
# and none of the product's code, and says what held in all three formats. The
# seed signs posts 1, 3 and 4 of the public fixture with its owner's key and leaves
# the rest unsigned, so both sentences are asked for. A post the product has not
# checkpointed yet says so instead, which counts as holding.
if [ "$(status "$SITE/spaces/public-findings/1.json")" != "200" ]; then
  skipped "a post's page says what this site checked" "the public fixture is not in the database. Run: npm run seed"
else
  verdicts=$(for n in 1 2 3; do printf '%s\t' "$n"; curl -s "$SITE/spaces/public-findings/$n.json" | tr -d '\n'; echo; done | python3 -c '
import json,sys
want = {"1": "verified", "2": "unsigned", "3": "verified"}
for line in sys.stdin:
    n, _, doc = line.rstrip("\n").partition("\t")
    try:
        v = json.loads(doc).get("verification") or {}
    except ValueError:
        print("FAIL post {} has a readable verdict\tits JSON did not parse".format(n)); continue
    first = (v.get("sentences") or [""])[0]
    good = v.get("signature") == want[n] and v.get("chain") == "holds" and v.get("record") in ("covered", "uncovered") and not v.get("problems")
    good = good and first.startswith("Signed by key" if want[n] == "verified" else "Not signed.")
    print(("ok" if good else "FAIL") + " post {} of the public fixture is {}, in its chain, and says so".format(n, want[n]) +
          ("" if good else "\tgot signature {!r}, chain {!r}, record {!r}, problems {!r}".format(v.get("signature"), v.get("chain"), v.get("record"), v.get("problems"))))
' 2>&1)
  relay "a post's page says what this site checked" "the check" "$verdicts"
  page=$(curl -s "$SITE/spaces/public-findings/1")
  if echo "$page" | grep -q 'This site checked the signature against that key.' && echo "$page" | grep -q '<details class="proof">'; then
    ok "a signed post's page says, in HTML, that this site checked its signature"
  else
    bad "a signed post's page says, in HTML, that this site checked its signature" "no verdict sentence or proof on the page"
  fi
  expect_body "an unsigned post's page says it is not signed" "$SITE/spaces/public-findings/2" \
    'Not signed. The service attests that an access token of key'
  md=$(curl -s "$SITE/spaces/public-findings/1.md")
  if echo "$md" | grep -q '^## What this site checked' && echo "$md" | grep -q '^- Signed by key [0-9a-f]\{64\}\. This site checked the signature against that key\.$'; then
    ok "a signed post's markdown says what this site checked"
  else
    bad "a signed post's markdown says what this site checked" "no verdict in the markdown"
  fi
  # A signed post's private part commits to its budget, data and run id, and like
  # them it is its space's members' to read, with the two inputs the admission
  # digest hides. strangerPost() drops all of it on a public address, whatever key
  # the site reads with; this has teeth when SITE_TOKEN owns the space.
  for r in /spaces/public-findings/3 /spaces/public-findings/3.json /spaces/public-findings/3.md; do
    refuse_body "$r publishes no member's part of a signed post" "$SITE$r" '"private"|admitted_revision|admitted_control_hash' -E
  done
  # A listing marks a signed post, and only its own page checks it.
  expect_body "the archive marks signed posts" "$SITE/spaces/public-findings/all" '&middot; signed</p>'

  # THE SPACE'S CHECKPOINTS. Followed and not listed; every one checked on the page.
  for f in "" .md .json; do
    expect 200 "/spaces/public-findings/checkpoints$f returns 200" "$SITE/spaces/public-findings/checkpoints$f"
  done
  held=$(curl -s "$SITE/spaces/public-findings/checkpoints.json" | python3 -c '
import json,sys
d = json.load(sys.stdin)
rows = d.get("checkpoints") or []
bad = [c.get("checkpoint_id") for c in rows if c.get("checked_by_this_site") != "holds"]
print("none" if not rows else ("ok" if not bad else "these did not hold: " + ", ".join(map(str, bad))))' 2>&1)
  case "$held" in
    ok) ok "every checkpoint of the public fixture holds when this site checks it" ;;
    none) skipped "every checkpoint of the public fixture holds when this site checks it" \
      "the product has signed none yet: run it with CHECKPOINT_AFTER_SECONDS=0, or wait ten minutes" ;;
    *) bad "every checkpoint of the public fixture holds when this site checks it" "$held" ;;
  esac
  expect_body "a public space's page names its latest checkpoint" "$SITE/spaces/public-findings" \
    'Latest checkpoint: posts [0-9]+ to [0-9]+|No checkpoint has been signed for this space yet' -E
  expect 404 "a private space's checkpoints have no public page" "$SITE/spaces/aarch64-wheels/checkpoints"
  c=$(status "$SITE/spaces/public-findings/checkpoints?stream=events")
  if [ "$c" = "200" ] && ! curl -s "$SITE/spaces/public-findings/checkpoints.json?stream=events" | grep -q '"record": "events"'; then
    ok "a public address never shows the membership history's checkpoints"
  else
    bad "a public address never shows the membership history's checkpoints" "got $c, or the events record"
  fi
fi

# ------------------------------------------ the outside witness
#
# A checkpoint shows that a record changed only to someone who kept an earlier one.
# So this run keeps one: the latest checkpoint of each public space it checks, in
# a file outside the repository, one file per site. On the next run, a space whose
# checkpoints no longer include the one kept -- a history that changed -- fails.
# Run from a machine the operator does not control, against the deployed site, it
# is a copy of each record's head beyond the operator's reach. WITNESS_SPACES names
# the spaces; left empty, it takes the local fixtures when they exist and otherwise
# up to twenty public spaces from the directory. Every space already kept for the
# site is compared as well, whichever list this run took.
WITNESS_FILE="${WITNESS_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/schellingaf/witness-$(printf '%s' "$SITE" | sed 's#[^A-Za-z0-9.-]#_#g').json}"
witness=$(SITE="$SITE" WITNESS_FILE="$WITNESS_FILE" WITNESS_SPACES="${WITNESS_SPACES:-}" python3 -c '
import json, os, sys, time, urllib.request, urllib.error
from urllib.parse import urlsplit
site, path = os.environ["SITE"], os.environ["WITNESS_FILE"]
# This machine, the same four as isThisMachine() in scripts/lib/local-api.mjs.
local = urlsplit(site).hostname in ("localhost", "127.0.0.1", "::1", "0.0.0.0")
class Unread(Exception):
    pass
def get(p):
    # A page that could not be read says nothing about the record, so it is never
    # counted against it: the space is skipped, and what was kept stays kept.
    try:
        with urllib.request.urlopen(urllib.request.Request(site + p, headers={"Accept": "application/json"}), timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise Unread("{} answered {}".format(p, e.code))
    except (urllib.error.URLError, ValueError, TimeoutError, OSError):
        raise Unread("{} could not be read".format(p))
def quiet(p):
    try:
        return get(p)
    except Unread:
        return None
names = os.environ["WITNESS_SPACES"].split()
if not names:
    names = [n for n in ("public-findings", "hostile-public") if quiet("/spaces/{}.json".format(n))]
if not names:
    listing = quiet("/spaces.json") or {}
    names = [s["name"] for s in listing.get("items") or [] if s.get("visibility") == "public"][:20]
try:
    with open(path) as f:
        kept = json.load(f)
except (OSError, ValueError):
    kept = {}
if not isinstance(kept, dict):
    kept = {}
# Every space this machine kept a checkpoint of is compared again, whatever the list
# above says: a kept space pushed out of the first twenty public spaces was otherwise
# never compared again, and one that is gone says so.
prefix = site + " "
names += sorted({k[len(prefix):] for k in kept if k.startswith(prefix)} - set(names))
if not names:
    print("skip the record of each public space still extends the checkpoint this machine kept\tno public space to witness")
    sys.exit(0)
changed = False
now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
for name in names:
    label = "{} extends the checkpoint this machine kept".format(name)
    key = site + " " + name
    try:
        space = ((get("/spaces/{}.json".format(name)) or {}).get("space")) or {}
        if space.get("visibility") != "public" or not space.get("space_id"):
            print("skip {}\tnot a public space here".format(label)); continue
        before = kept.get(key)
        if before and before.get("space_id") != space["space_id"]:
            if not local:
                # Names are never reused, so another space under this name is another
                # history under the same name. What was kept stays kept.
                print("FAIL {}\ta different space answers to this name now, and a name is never reused: the checkpoint kept on {} belongs to space {}".format(
                    label, before.get("seen_at"), before.get("space_id")))
                continue
            print("skip {}\ta different space has this name on this machine now, so its database was rebuilt: starting again".format(label))
            before = None
        # From the checkpoint kept, or from the first: the page after it holds the kept
        # one again, which is how the record is asked whether it still has it.
        page = "/spaces/{}/checkpoints.json".format(name) + ("?after={}".format(before["last"]) if before else "")
        latest, pages, unheld, gone = None, 0, 0, False
        while page and pages < 400:
            d = get(page)
            if d is None:
                raise Unread("{} answered 404".format(page))
            pages += 1
            if pages == 1 and before:
                f = d.get("follows") or {}
                if f.get("checkpoint_id") != before["checkpoint_id"] or f.get("merkle_root") != before["merkle_root"] or f.get("last") != before["last"]:
                    gone = True
                    break
                if f.get("checked_by_this_site") != "holds":
                    unheld += 1
            rows = d.get("checkpoints") or []
            unheld += sum(1 for c in rows if c.get("checked_by_this_site") != "holds")
            if rows:
                latest = rows[-1]
            nxt = d.get("next")
            page = nxt.replace("/checkpoints?", "/checkpoints.json?", 1) if nxt else None
        if gone:
            print("FAIL {}\tthe checkpoint kept on {}, for posts {} to {} with ROOT {}, is not in its record any more: the history changed. The space page says whether the service replaced it after a restore".format(
                label, before.get("seen_at"), before.get("first"), before.get("last"), before.get("merkle_root")))
            continue
        if unheld:
            print("FAIL {}\tthis site could not confirm {} of the checkpoints since".format(label, unheld)); continue
        if latest is None and before is None:
            print("skip {}\tno checkpoint has been signed for it yet".format(label)); continue
        if page:
            print("skip {}\tits record is longer than one run walks: this run kept up to posts {}, and the next run continues from there".format(label, (latest or before)["last"]))
        elif before:
            print("ok {}".format(label))
        else:
            print("skip {}\tnothing kept yet: this run keeps posts {} to {}, and the next run compares".format(label, latest["first"], latest["last"]))
        if latest is not None:
            kept[key] = {"space_id": space["space_id"], "checkpoint_id": latest["checkpoint_id"], "first": latest["first"],
                         "last": latest["last"], "merkle_root": latest["merkle_root"], "seen_at": now}
            changed = True
    except Unread as e:
        print("skip {}\t{}, so nothing was compared and what was kept stays kept".format(label, e))
if changed:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w") as f:
        json.dump(kept, f, indent=2, sort_keys=True)
    os.replace(path + ".tmp", path)
' 2>&1)
if [ -z "$witness" ]; then
  bad "the outside witness ran" "it printed nothing"
else
  relay "the outside witness ran" "it" "$witness"
fi

# ------------------------------------------------ every page is reached
#
# The ledger says where a person meets each operation, and the checks above ask each
# of those addresses to answer. Neither says anybody can get there: a page nothing
# links to passes both. scripts/reach.mjs follows links and GET forms from the
# site's own menu, as a person does, GET only, never /inspect, /me or a search, and
# names every page the ledger lists that it did not reach. The pages under /me are
# reached the same way from /me by the signed-in probe, below.
if ! command -v node >/dev/null 2>&1; then
  skipped "every page the ledger names is reached from the menu" "node is not installed here, and the crawl needs it"
else
  reached=$(node "$(dirname "$0")/reach.mjs" "$SITE" 2>&1)
  if [ $? -ne 0 ] || [ -z "$reached" ]; then
    bad "every page the ledger names is reached from the menu" "the crawl itself failed: $(echo "$reached" | tail -1)"
  else
    relay "every page the ledger names is reached from the menu" "the crawl" "$reached"
  fi
fi

# ------------------------------------------------ signed in, with a passkey
#
# A person signs in with a passkey and uses every page a key has. These checks are
# the one part of this file that needs node, because a passkey's signature is P-256
# and neither sh nor python3's standard library can make one;
# scripts/signed-in-probe.mjs is a software passkey
# that signs exactly what a browser's prompt would. It writes -- keys, spaces,
# posts, codes, messages -- so it runs only against this machine, and it skips when
# the product has passkeys switched off. It is handed API_ORIGIN too, because an app
# connecting as a key asks the product itself, as the app would; that part runs only
# when the product is on this machine as well.
# These three are asked here rather than by the probe, which runs only against this
# machine, so a deployed site is asked them too.
if header_starts "x-robots-tag" "noindex, nofollow" "$SITE/sign-in" \
   && has_header "cache-control" "private" "$SITE/sign-in" \
   && has_header "cache-control" "no-store" "$SITE/sign-in"; then
  ok "the sign-in page is kept out of search and every cache"
else
  bad "the sign-in page is kept out of search and every cache" \
    "got '$(header_value "x-robots-tag" "$SITE/sign-in")' and '$(header_value "cache-control" "$SITE/sign-in")'"
fi
me_code=$(status "$SITE/me")
me_location=$(header_value location "$SITE/me")
if [ "$me_code" = "303" ] && [ "$me_location" = "/sign-in" ]; then
  ok "/me without a session goes to the sign-in page"
else
  bad "/me without a session goes to the sign-in page" "got $me_code to '$me_location'"
fi
# Refused before it is read, even when it looks like a form this site's own page sent.
expect 405 "a public address takes no POST" "$SITE/spaces" \
  -X POST -H "Origin: $SITE" -H "Sec-Fetch-Site: same-origin" --data "csrf=x"
if [ -n "$signed_in_listed" ]; then
  bad "the signed-in pages are in no sitemap" "found in:$signed_in_listed"
else
  ok "the signed-in pages are in no sitemap"
fi
refuse_body "the signed-in pages are not in the index" "$SITE/llms.txt" "://[^/ ]+/(me|sign-in|sign-out)([/ .)]|$)" -E
if ! command -v node >/dev/null 2>&1; then
  skipped "signed-in pages, with a software passkey" "node is not installed here, and a passkey's signature needs it"
else
  probe=$(node "$(dirname "$0")/signed-in-probe.mjs" "$SITE" "$API_ORIGIN" 2>&1)
  if [ $? -ne 0 ] || [ -z "$probe" ]; then
    bad "signed-in pages, with a software passkey" "the probe itself failed: $(echo "$probe" | tail -1)"
  else
    relay "signed-in pages, with a software passkey" "the probe" "$probe"
  fi
fi

# ------------------------------------------------ sealed, in a real browser
#
# Sealed conversations and sealed spaces are sealed and opened in the person's browser
# by src/sealed-page.js, with the encryption key a passkey's PRF secret makes, which no
# software passkey here can stand in for. scripts/sealed-browser.mjs drives headless
# Chrome over its DevTools protocol, with Chrome's own virtual authenticator, PRF and
# all: two people connect, turn sealing on, make and join a sealed space, post, and
# hold a sealed conversation, and no word they type leaves the browser in any request.
# It writes, so it runs against this machine only, and it needs Chrome.
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
case "$SITE" in
  http://localhost:*|http://127.0.0.1:*)
    if ! command -v node >/dev/null 2>&1; then
      skipped "sealing in a real browser" "node is not installed here"
    elif [ ! -x "$chrome" ]; then
      skipped "sealing in a real browser" "no Chrome to drive here; set CHROME to one"
    else
      sealed=$(RELAY=1 SITE="$SITE" CHROME="$chrome" node "$(dirname "$0")/sealed-browser.mjs" 2>&1)
      relay "sealing in a real browser" "the browser run" "$sealed"
    fi ;;
  *) skipped "sealing in a real browser" "it writes, so it runs against this machine only" ;;
esac

# The single largest indexing change: the corpus is linked from the site at all.
# Asked of the site, not of a local build, so this holds against a deployed site
# checked from a machine that never built it.
for route in $PAGES; do
  expect_body "$route links the space directory" "$SITE$route" '/spaces'
done

echo
note=""
[ "$skip" -gt 0 ] && note=", $skip skipped"
if [ "$fail" -eq 0 ]; then
  echo "  $pass checks passed$note."
  echo
  exit 0
fi
echo "  $pass passed, $fail FAILED$note."
echo
exit 1
