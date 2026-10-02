// Serves the site. Node and nothing else: no framework, no dependency, no edge
// platform.
//
//   node serve.mjs                         # after `node build.mjs`
//   PORT=8787 HOST=127.0.0.1 node serve.mjs
//
// It runs as an ordinary process behind a reverse proxy that terminates TLS, and
// reads the visitor's address where CLIENT_ADDRESS_FROM says.
//
// src/index.ts is one function from a Request to a Response, and every decision
// about a page is made there. This file turns Node's requests into Requests, reads
// the built files in public/ for it (ASSETS, with ETags), and sends its Responses.
//
// It decides no header of its own, not even a file's type: src/index.ts is the
// one place every header is decided. This file adds only a body's length, and
// answers by itself only what never reaches the handler: a 405, a 400, a 413, a 503
// or a 500. On the way in it reads a POST's body, within a limit, and tells the
// handler the visitor's address in x-schellingaf-client, a name it overwrites.
//
// Environment:
//
//   PORT, HOST     where to listen. HOST defaults to 127.0.0.1, so a server
//                  started by hand is not reachable from the network by accident.
//   API_ORIGIN     where the product answers, read by src/api.ts. Defaults to the
//                  production origin.
//   SITE_TOKEN     the site's own KEY, a member of nothing.
//   READER_TOKEN   the KEY /inspect reads with. Deliberately unset in production.
//   SERVICE_ROOT_KEY  the service's root public key, which every checkpoint on the
//                  pages is checked against. Refused at start when malformed.
//   TRUST_PROXY    "1" behind the reverse proxy, and only there. The scheme is
//                  then taken from X-Forwarded-Proto and the host from
//                  X-Forwarded-Host when the proxy sends one, which the proxy sets
//                  and nothing else can reach this port to forge.
//   CLIENT_ADDRESS_FROM  where the visitor's address is read, the product's setting
//                  of the same name: last-forwarded (the last X-Forwarded-For
//                  entry, for a proxy that replaces the header; the default with
//                  TRUST_PROXY=1), first-forwarded (the first entry, for a
//                  platform's edge that writes the visitor first), x-real-ip (the
//                  X-Real-IP header) or socket (the connection's own address; the
//                  default, and the only value allowed, without TRUST_PROXY=1).
//                  A missing header falls back to the connection, never to
//                  another header.

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const ROOT = import.meta.dirname;
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const CLIENT_ADDRESS_FROM = process.env.CLIENT_ADDRESS_FROM || (TRUST_PROXY ? "last-forwarded" : "socket");

// Which address the product's limit on signing in counts is a security setting, so a
// value that is misspelt, or that would read a header nothing trusted wrote, stops
// the server rather than falling back to a default. Asked before the build is, so the
// answer does not depend on the checkout.
const CLIENT_ADDRESS_MODES = ["last-forwarded", "first-forwarded", "x-real-ip", "socket"];
let settingRefused = null;
if (!CLIENT_ADDRESS_MODES.includes(CLIENT_ADDRESS_FROM)) {
  settingRefused = "CLIENT_ADDRESS_FROM must be last-forwarded, first-forwarded, x-real-ip or socket.";
} else if (!TRUST_PROXY && CLIENT_ADDRESS_FROM !== "socket") {
  settingRefused = `CLIENT_ADDRESS_FROM=${CLIENT_ADDRESS_FROM} reads a header the proxy writes, so it needs TRUST_PROXY=1.`;
}
if (settingRefused) {
  if (!import.meta.main) throw new Error(settingRefused);
  console.error(settingRefused);
  process.exit(1);
}

// Only when this file is run, as `node serve.mjs`, does it stop the process or listen.
// test/serve.test.ts imports it, and listens on a free port of its own.
//
// A missing public/ or routes.generated.ts means the build was skipped. Both are
// said in words rather than as a module-resolution stack trace.
if (import.meta.main && (!existsSync(PUBLIC) || !existsSync(join(ROOT, "src", "routes.generated.ts")))) {
  console.error("serve: the site has not been built. Run: node build.mjs");
  process.exit(2);
}

// ------------------------------------------------------------------ the files
//
// Served by their literal path and nothing else. No index.html for a directory,
// no trailing-slash redirect, no fallback page: src/index.ts decides which file a
// page is, what type it is and what a 404 looks like, and a file server that
// guessed would answer questions the handler never asked.

// Held after the first read, and read again when the build rewrites the file.
const files = new Map();

export async function readPublic(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  // The URL parser has already removed ../ segments, but an encoded slash
  // survives it and decodes to one here. Resolve, then refuse anything that
  // landed outside public/.
  const full = resolve(PUBLIC, "." + rel);
  if (!full.startsWith(PUBLIC + sep)) return null;

  let info;
  try {
    info = await stat(full);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;

  const known = files.get(full);
  if (known && known.mtimeMs === info.mtimeMs && known.size === info.size) return known;
  const body = await readFile(full);
  const entry = {
    mtimeMs: info.mtimeMs,
    size: info.size,
    body,
    // From the bytes, so a rebuild that changes nothing keeps every ETag and
    // every agent's cached copy stays valid.
    etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`,
  };
  files.set(full, entry);
  return entry;
}

/** RFC 9110 weak comparison, which is the one If-None-Match uses. */
function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const bare = (t) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => bare(t) === bare(etag));
}

const ASSETS = {
  async fetch(request) {
    const file = await readPublic(new URL(request.url).pathname);
    if (!file) return new Response("Not Found", { status: 404 });
    const headers = { ETag: file.etag };
    if (etagMatches(request.headers.get("If-None-Match"), file.etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(file.body, { status: 200, headers });
  },
};

// ------------------------------------------------------------------- serving

const { handleRequest } = await import("./src/index.ts");
// The one test of which addresses take a POST, asked here as well as in the
// handler, so a POST anywhere else is refused before a byte of it is read.
const { isSignedInAddress } = await import("./src/me.ts");

// An empty value is no value: `SITE_TOKEN=` in a file means "not configured".
const setting = (name) => process.env[name] || undefined;
const env = {
  ASSETS,
  SITE_TOKEN: setting("SITE_TOKEN"),
  READER_TOKEN: setting("READER_TOKEN"),
  SERVICE_ROOT_KEY: setting("SERVICE_ROOT_KEY"),
};
// A root key the pages would compare every checkpoint against. A typo in it would
// make every checkpoint fail to hold, which a reader would take for a service that
// changed its history, so a malformed one stops the server instead.
if (import.meta.main && env.SERVICE_ROOT_KEY !== undefined && !/^[0-9a-f]{64}$/.test(env.SERVICE_ROOT_KEY)) {
  console.error("SERVICE_ROOT_KEY must be the service's root public key: 64 lowercase hex characters.");
  process.exit(1);
}

// The largest form a signed-in page sends: a post's body is at most 65,536 bytes,
// and a form encodes each byte as up to nine characters. Signing in sends a
// passkey's answer, which is far smaller. And no more than BODY_BUDGET of POST
// bodies is held at once, whoever sends them, so slow connections cannot hold
// the server's memory.
const BODY_BYTES = 640 * 1024;
const SIGN_IN_BYTES = 16 * 1024;
const BODY_BUDGET = 16 * 1024 * 1024;
export let bodyBytesHeld = 0;

/** A request's body, up to `limit`, or a word for why not: "large" when it is
 *  bigger than that, "busy" when the server already holds its budget of bodies.
 *  What it read stays counted in bodyBytesHeld until `done` is called, which the
 *  server does once the response is sent, because the body is held until then. */
export async function readBody(req, limit) {
  let size = 0;
  const done = () => {
    bodyBytesHeld -= size;
    size = 0;
  };
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > limit) return { refused: "large", done };
  const chunks = [];
  try {
    for await (const chunk of req) {
      size += chunk.length;
      bodyBytesHeld += chunk.length;
      if (size > limit || bodyBytesHeld > BODY_BUDGET) {
        const refused = size > limit ? "large" : "busy";
        done();
        return { refused, done };
      }
      chunks.push(chunk);
    }
  } catch (e) {
    // A connection that dropped half way through its body.
    done();
    throw e;
  }
  return { body: Buffer.concat(chunks), done };
}

// What answers hold while their readers take them. An answer's body stays in this
// process until the connection has taken all of it, and one that takes nothing keeps
// it for as long as the connection lasts: a large export asked for over a connection
// that never reads would hold the site's memory. So no more than SEND_BUDGET of
// answers is held at once: past it a large answer is refused, while a small page
// still goes out. And a connection that takes nothing of its answer for SEND_IDLE_MS
// is closed, which frees what it held; one that reads, however slowly, is not.
const SEND_BUDGET = 64 * 1024 * 1024;
const SEND_SMALL = 256 * 1024;
const SEND_IDLE_MS = 60_000;
export let sendBytesHeld = 0;

/** Counts an answer of `size` bytes as held until its connection closes, and closes a
 *  connection that takes nothing of it for SEND_IDLE_MS; false, holding nothing, when
 *  a large answer would take the held answers past SEND_BUDGET. */
export function holdForSending(res, size) {
  if (size > SEND_SMALL && sendBytesHeld + size > SEND_BUDGET) return false;
  sendBytesHeld += size;
  res.once("close", () => {
    sendBytesHeld -= size;
  });
  res.setTimeout(SEND_IDLE_MS, () => res.destroy());
  return true;
}

/** Who is asking, for the one place that needs it: the product's per-address
 *  limit on signing in, which would otherwise count every visitor as this site.
 *  Behind the proxy it is read where CLIENT_ADDRESS_FROM says, from a header the
 *  proxy wrote; without one, or anywhere else, it is the connection's own address. */
function clientAddress(req) {
  const chain = () => String(req.headers["x-forwarded-for"] ?? "").split(",");
  let fromProxy;
  if (CLIENT_ADDRESS_FROM === "last-forwarded") fromProxy = chain().at(-1);
  else if (CLIENT_ADDRESS_FROM === "first-forwarded") fromProxy = chain()[0];
  else if (CLIENT_ADDRESS_FROM === "x-real-ip") fromProxy = String(req.headers["x-real-ip"] ?? "");
  fromProxy = fromProxy?.trim();
  if (fromProxy) return fromProxy;
  return req.socket.remoteAddress ?? null;
}

/** The name the visitor asked for: the proxy's X-Forwarded-Host when the proxy is
 *  trusted and sends one (its first entry, where proxies have added theirs), and
 *  the request's own Host otherwise. */
function requestHost(req) {
  const forwarded = TRUST_PROXY ? String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim() : "";
  return forwarded || (req.headers.host ?? `localhost:${PORT}`);
}

/** An answer this file gives by itself, never reaching the handler: plain text,
 *  never stored. `extra` adds Allow, Retry-After or Connection: close. */
function refuse(res, status, text, extra = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(text);
}

export const server = createServer(async (req, res) => {
  try {
    // GET and HEAD everywhere, and POST for the signed-in pages, which the handler
    // refuses on every other address before it reads anything. Nothing else.
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
      return refuse(res, 405, "405 Method Not Allowed: addresses on this site are read with GET, and the signed-in pages take POST.\n",
        { Allow: "GET, HEAD, POST" });
    }
    // The request's address is rebuilt from the name the visitor asked for,
    // because the handler decides the www redirect, HSTS and the Origin check
    // of every signed-in form from it.
    const scheme = TRUST_PROXY && req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    let url;
    try {
      if (!req.url?.startsWith("/")) throw new Error("not a path");
      url = new URL(`${scheme}://${requestHost(req)}${req.url}`);
    } catch {
      return refuse(res, 400, "400 Bad Request\n");
    }

    // Every refusal of a body below closes the connection rather than keeping it:
    // the rest of the body may still be on its way, and the next request on the
    // same connection would start inside it.
    let sent = null;
    if (req.method === "POST") {
      if (!isSignedInAddress(url.pathname)) {
        return refuse(res, 405, "405 Method Not Allowed: this address is read with GET.\n", { Allow: "GET, HEAD", Connection: "close" });
      }
      const limit = url.pathname.startsWith("/sign-in") ? SIGN_IN_BYTES : BODY_BYTES;
      const read = await readBody(req, limit);
      res.once("close", read.done);
      if (read.refused === "large") return refuse(res, 413, "413 Content Too Large\n", { Connection: "close" });
      if (read.refused) {
        return refuse(res, 503, "503 Service Unavailable: too many forms arriving at once. Try again in a moment.\n",
          { Connection: "close", "Retry-After": "5" });
      }
      sent = read.body;
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    // Written here and nowhere else, over whatever the request itself sent under
    // this name, so a visitor cannot choose which address the product counts.
    headers.delete("x-schellingaf-client");
    const client = clientAddress(req);
    if (client) headers.set("x-schellingaf-client", client);
    const response = await handleRequest(
      new Request(url, { method: req.method, headers, ...(sent ? { body: sent } : {}) }), env);

    const bodyless = response.status === 304 || response.status === 204;
    const body = bodyless ? null : Buffer.from(await response.arrayBuffer());
    const out = {};
    response.headers.forEach((value, name) => {
      out[name] = value;
    });
    // Set-Cookie is the one header that may not be folded into a single line, so
    // it is copied as the list it is rather than as whichever value came last.
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out["set-cookie"] = cookies;
    // Sent on HEAD too, so an agent can learn a page's size without fetching it.
    if (body) out["content-length"] = String(body.byteLength);
    if (!holdForSending(res, req.method === "HEAD" || !body ? 0 : body.byteLength)) {
      return refuse(res, 503, "503 Service Unavailable: too many large answers are being sent at once. Try again in half a minute.\n",
        { "Retry-After": "30" });
    }
    res.writeHead(response.status, out);
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (e) {
    // The message and never the request, the same rule src/api.ts keeps.
    console.error(`serve: ${e instanceof Error ? e.message : String(e)}`);
    if (res.headersSent) res.end();
    else refuse(res, 500, "");
  }
});

// Headers that take ten seconds to arrive, or a request that takes thirty, are not
// from a reader.
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;

if (import.meta.main) {
  server.listen(PORT, HOST, () => {
    console.log(`serving on http://${HOST}:${PORT}`);
  });

  // Docker stops a container with SIGTERM. Finish what is in flight, then go.
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}
