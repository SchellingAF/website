// What serve.mjs answers by itself, before or instead of the handler: how much of a
// body it reads and holds, which files it will serve, and the refusals it sends.
//
// serve.mjs listens and exits only when it is run (import.meta.main), so it is
// imported here and listens on a free port of this process's own, which closes with
// the process. The body limits are asked of readBody() directly, with request
// bodies made here, because a refusal that closes a connection mid-upload races the
// client's own writes; the server is asked what only a real connection can show.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API, CAPABILITIES, json, refusal, signInChallengeHex, stubFetch } from "./lib/service.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KIB = 1024;

process.env.API_ORIGIN = API;
// Read when serve.mjs is imported: the server imported here trusts no proxy.
delete process.env.TRUST_PROXY;
delete process.env.CLIENT_ADDRESS_FROM;
let origin = "";
// Every origin a server in this file answers at, and the site's own, filled in before
// the first passkey challenge, since the capability document is held once read.
const origins: string[] = ["https://schellingaf.com"];
const fake = stubFetch((call) => {
  if (call.url.pathname === "/v1/capabilities") {
    return json({ ...CAPABILITIES, protocol: { passkeys: { status: "available", rp_id: "127.0.0.1", origins: [origin, ...origins] } } });
  }
  if (call.url.pathname === "/v1/passkeys/challenge") return json({ challenge: signInChallengeHex(), rp_id: "127.0.0.1" });
  return refusal(404, "NOT_ANSWERED");
});
after(() => fake.restore());
const serve = await import("../serve.mjs");

// ------------------------------------------------------------------ the body

/** A request body arriving in chunks, as Node hands one over. */
function body(chunks: Buffer[], headers: Record<string, string> = {}, drops = false) {
  const state = { read: 0 };
  return {
    state,
    req: {
      headers,
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) { state.read++; yield chunk; }
        if (drops) throw new Error("the connection dropped");
      },
    },
  };
}
const chunks = (count: number, size: number) => Array.from({ length: count }, () => Buffer.alloc(size, 0x61));

describe("reading a body", () => {
  test("within its limit, it is read whole and held until the answer is sent", async () => {
    const before = serve.bodyBytesHeld;
    const { req } = body(chunks(3, 10 * KIB));
    const read = await serve.readBody(req, 640 * KIB);
    assert.equal(read.body?.length, 30 * KIB);
    assert.equal(serve.bodyBytesHeld, before + 30 * KIB);
    read.done();
    assert.equal(serve.bodyBytesHeld, before);
  });

  test("a declared length over the limit is refused before a byte is read", async () => {
    const { req, state } = body(chunks(1, KIB), { "content-length": String(640 * KIB + 1) });
    const read = await serve.readBody(req, 640 * KIB);
    assert.equal(read.refused, "large");
    assert.equal(state.read, 0);
  });

  test("a body that grows past the limit is refused as it arrives, whatever it declared", async () => {
    const before = serve.bodyBytesHeld;
    for (const headers of [{}, { "content-length": "10" }]) {
      const { req, state } = body(chunks(20, 64 * KIB), headers);
      const read = await serve.readBody(req, 640 * KIB);
      assert.equal(read.refused, "large", JSON.stringify(headers));
      assert.equal(state.read, 11, "stopped at the chunk that crossed the limit");
      assert.equal(serve.bodyBytesHeld, before, "what it had read is no longer counted");
    }
  });

  test("sixteen MiB of bodies held at once is the budget: past it, the next is refused as busy", async () => {
    const before = serve.bodyBytesHeld;
    const held = [];
    for (let i = 0; i < 25; i++) held.push(await serve.readBody(body(chunks(10, 64 * KIB)).req, 640 * KIB));
    assert.ok(held.every((r) => r.body), "twenty-five bodies of 640 KiB fit, leaving 384 KiB of the budget");
    const small = await serve.readBody(body(chunks(5, 64 * KIB)).req, 640 * KIB);
    assert.ok(small.body, "320 KiB more still fits");
    small.done();
    const busy = await serve.readBody(body(chunks(10, 64 * KIB)).req, 640 * KIB);
    assert.equal(busy.refused, "busy");
    for (const r of held) r.done();
    assert.equal(serve.bodyBytesHeld, before);
    const after = await serve.readBody(body(chunks(2, 64 * KIB)).req, 640 * KIB);
    assert.ok(after.body, "the budget is free again once the answers are sent");
    after.done();
  });

  test("a connection that drops half way is not counted against the budget", async () => {
    const before = serve.bodyBytesHeld;
    await assert.rejects(serve.readBody(body(chunks(3, 64 * KIB), {}, true).req, 640 * KIB), /the connection dropped/);
    assert.equal(serve.bodyBytesHeld, before);
  });
});

// ------------------------------------------------------------------ the answer

/** A response as holdForSending() meets one: it closes, and it can time out. */
function answer() {
  const on: { close?: () => void } = {};
  const state = { timeout: 0, destroyed: false, fire: () => {} };
  return {
    state,
    close: () => on.close?.(),
    res: {
      once(event: string, listener: () => void) { if (event === "close") on.close = listener; },
      setTimeout(ms: number, listener: () => void) { state.timeout = ms; state.fire = listener; },
      destroy() { state.destroyed = true; },
    },
  };
}
const MIB = 1024 * KIB;

describe("sending an answer", () => {
  test("an answer is held until its connection closes, and one that takes nothing for a minute is closed", () => {
    const before = serve.sendBytesHeld;
    const a = answer();
    assert.equal(serve.holdForSending(a.res, 12 * MIB), true);
    assert.equal(serve.sendBytesHeld, before + 12 * MIB);
    assert.equal(a.state.timeout, 60_000);
    a.state.fire();
    assert.equal(a.state.destroyed, true);
    a.close();
    assert.equal(serve.sendBytesHeld, before);
  });

  test("past its budget a large answer is refused and holds nothing, while a small page still goes out", () => {
    const before = serve.sendBytesHeld;
    const held = Array.from({ length: 5 }, () => answer());
    for (const a of held) assert.equal(serve.holdForSending(a.res, 12 * MIB), true);
    const refused = answer();
    assert.equal(serve.holdForSending(refused.res, 12 * MIB), false);
    assert.equal(serve.sendBytesHeld, before + 60 * MIB);
    const small = answer();
    assert.equal(serve.holdForSending(small.res, 100 * KIB), true);
    for (const a of [...held, small]) a.close();
    assert.equal(serve.sendBytesHeld, before);
    assert.equal(serve.holdForSending(refused.res, 12 * MIB), true, "once the others close");
    refused.close();
  });
});

// ------------------------------------------------------------------ the files

describe("reading a built file", () => {
  test("never leaves public/, however the address is encoded", async () => {
    // ../package.json exists, so a null here is the guard, not a missing file.
    assert.ok(existsSync(path.join(ROOT, "package.json")));
    for (const address of ["/..%2fpackage.json", "/..%2F..%2Fpackage.json", "/%2e%2e%2fpackage.json", "/%2E%2E/package.json", "/../package.json",
      "/..%2fserve.mjs", "/..%2fsrc%2fsession.ts", "/..%2fpublic-sibling%2fx", "/..%5cpackage.json", "/"]) {
      assert.equal(await serve.readPublic(address), null, address);
    }
  });

  test("refuses a NUL byte and an address that does not decode", async () => {
    for (const address of ["/robots.txt%00.html", "/%00", "/%E0%A4%A", "/%"]) {
      assert.equal(await serve.readPublic(address), null, address);
    }
  });

  test("serves a file that is there, with an ETag made from its bytes", async (t) => {
    if (!existsSync(path.join(ROOT, "public", "robots.txt"))) {
      t.skip("public/ has not been built in this checkout; npm run build makes it");
      return;
    }
    const file = await serve.readPublic("/robots.txt");
    assert.match(file?.body.toString("utf8") ?? "", /User-agent: \*/);
    assert.match(file?.etag ?? "", /^"[A-Za-z0-9_-]{27}"$/);
  });
});

// ------------------------------------------------------------------ the server

test("run as a program, it still checks what it was given before it listens", () => {
  // Either check stops it before it opens a port, so this starts no server: a
  // checkout with no public/ says it has not been built, and one with it refuses the
  // malformed root key.
  const run = spawnSync(process.execPath, [path.join(ROOT, "serve.mjs")], {
    env: { ...process.env, SERVICE_ROOT_KEY: "not a key", PORT: "0", API_ORIGIN: API },
    encoding: "utf8", timeout: 10_000,
  });
  const [status, said] = existsSync(path.join(ROOT, "public"))
    ? [1, /SERVICE_ROOT_KEY must be the service's root public key/]
    : [2, /the site has not been built/];
  assert.equal(run.status, status, `${run.stdout}${run.stderr}`);
  assert.match(run.stderr, said);
});

test("run as a program, it refuses a CLIENT_ADDRESS_FROM it does not know, or one that reads a header from no trusted proxy", () => {
  // This check comes before the one for a build, so it answers in any checkout.
  for (const [extra, said] of [
    [{ CLIENT_ADDRESS_FROM: "first" }, /CLIENT_ADDRESS_FROM must be last-forwarded, first-forwarded, x-real-ip or socket/],
    [{ CLIENT_ADDRESS_FROM: "x-real-ip" }, /CLIENT_ADDRESS_FROM=x-real-ip reads a header the proxy writes, so it needs TRUST_PROXY=1/],
  ] as const) {
    const env: Record<string, string | undefined> = { ...process.env, PORT: "0", API_ORIGIN: API, ...extra };
    delete env.TRUST_PROXY;
    const run = spawnSync(process.execPath, [path.join(ROOT, "serve.mjs")], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.match(run.stderr, said);
  }
});

const servers: Server[] = [];
after(() => Promise.all(servers.map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); }))));

/** A server of its own, as serve.mjs makes one under these settings, listening on a free port. */
async function serverWith(settings: Record<string, string>) {
  const saved = { TRUST_PROXY: process.env.TRUST_PROXY, CLIENT_ADDRESS_FROM: process.env.CLIENT_ADDRESS_FROM };
  Object.assign(process.env, settings);
  // A query makes a module of its own, which reads the settings afresh.
  const own = await import(`../serve.mjs?${new URLSearchParams(settings)}`).finally(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  await new Promise<void>((resolve) => own.server.listen(0, "127.0.0.1", resolve));
  const at = (own.server.address() as AddressInfo).port;
  origins.push(`http://127.0.0.1:${at}`);
  servers.push(own.server);
  return at;
}

const proxied: Record<string, number> = {};
const PROXY_SETTINGS: Record<string, Record<string, string>> = {
  "TRUST_PROXY=1": { TRUST_PROXY: "1" },
  "last-forwarded": { TRUST_PROXY: "1", CLIENT_ADDRESS_FROM: "last-forwarded" },
  "first-forwarded": { TRUST_PROXY: "1", CLIENT_ADDRESS_FROM: "first-forwarded" },
  "x-real-ip": { TRUST_PROXY: "1", CLIENT_ADDRESS_FROM: "x-real-ip" },
  "socket": { TRUST_PROXY: "1", CLIENT_ADDRESS_FROM: "socket" },
};
before(async () => {
  for (const [name, settings] of Object.entries(PROXY_SETTINGS)) proxied[name] = await serverWith(settings);
});

test("a CLIENT_ADDRESS_FROM it does not know refuses the import too", async () => {
  process.env.TRUST_PROXY = "1";
  process.env.CLIENT_ADDRESS_FROM = "everything";
  try {
    await assert.rejects(import("../serve.mjs?unknown"), /CLIENT_ADDRESS_FROM must be last-forwarded, first-forwarded, x-real-ip or socket/);
  } finally {
    delete process.env.TRUST_PROXY;
    delete process.env.CLIENT_ADDRESS_FROM;
  }
});

let port = 0;
before(async () => {
  await new Promise<void>((resolve) => serve.server.listen(0, "127.0.0.1", resolve));
  port = (serve.server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
});
after(() => new Promise<void>((resolve) => { serve.server.closeAllConnections(); serve.server.close(() => resolve()); }));

/** One request, sent as a client sends it. With `withhold`, the headers go and the body never does. */
function send(o: { method?: string; path: string; headers?: Record<string, string>; body?: string; withhold?: boolean; port?: number }) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: o.port ?? port, method: o.method ?? "GET", path: o.path, headers: o.headers }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => {
        resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(parts).toString("utf8") });
        if (o.withhold) req.destroy();
      });
    });
    req.on("error", reject);
    if (o.withhold) req.flushHeaders();
    else req.end(o.body);
  });
}

describe("the server", () => {
  test("answers a method it never takes with a 405 of its own", async () => {
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const r = await send({ method, path: "/" });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.allow, "GET, HEAD, POST");
      assert.equal(r.headers["cache-control"], "no-store");
    }
  });

  test("refuses a POST outside the signed-in pages before it reads the body", { timeout: 5000 }, async () => {
    const r = await send({ method: "POST", path: "/spaces/public-findings", headers: { "Content-Length": "100" }, withhold: true });
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, "GET, HEAD");
    assert.equal(r.headers.connection, "close");
  });

  test("refuses a form, or an answer to a passkey prompt, declared larger than its limit", { timeout: 5000 }, async () => {
    for (const [pathname, bytes] of [["/me/new", 640 * KIB + 1], ["/sign-in", 16 * KIB + 1]] as const) {
      const r = await send({ method: "POST", path: pathname, headers: { "Content-Length": String(bytes) }, withhold: true });
      assert.equal(r.status, 413, pathname);
      assert.equal(r.headers.connection, "close", pathname);
    }
  });

  test("hands a form within its limit to the handler", async () => {
    const r = await send({ method: "POST", path: "/me/new", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "csrf=x" });
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, "/sign-in");
  });

  test("serves nothing from outside public/, however the address is written", async () => {
    for (const pathname of ["/..%2fpackage.json", "/%2e%2e/package.json", "/..%2F..%2Fpackage.json", "/public/../package.json"]) {
      const r = await send({ path: pathname });
      assert.equal(r.status, 404, pathname);
      assert.ok(!r.text.includes('"name": "schellingaf"'), `${pathname} served package.json`);
    }
  });

  test("answers a request whose target is not a path with a 400", async () => {
    assert.equal((await send({ path: "http://evil.example/" })).status, 400);
  });

  test("tells the product the visitor's own address, whatever the request claimed it was", async () => {
    const before = fake.calls.length;
    const r = await send({
      method: "POST", path: "/sign-in/challenge",
      headers: { Origin: origin, "Content-Type": "application/json", "X-Schellingaf-Client": "203.0.113.9", "X-Forwarded-For": "198.51.100.7" },
      body: "{}",
    });
    assert.equal(r.status, 200, r.text);
    const challenge = fake.calls.slice(before).find((c) => c.url.pathname === "/v1/passkeys/challenge");
    assert.equal(challenge?.headers.get("x-forwarded-for"), "127.0.0.1");
  });
});

// ------------------------------------------------------------------ behind a proxy

/** What the stand-in for the product was told on a passkey challenge sent with these headers. */
async function forwarded(at: number, headers: Record<string, string>) {
  const before = fake.calls.length;
  const r = await send({
    port: at, method: "POST", path: "/sign-in/challenge",
    headers: { Origin: `http://127.0.0.1:${at}`, "Content-Type": "application/json", ...headers },
    body: "{}",
  });
  assert.equal(r.status, 200, r.text);
  const challenge = fake.calls.slice(before).find((c) => c.url.pathname === "/v1/passkeys/challenge");
  assert.ok(challenge, "the challenge reached the product");
  return { forwardedFor: challenge.headers.get("x-forwarded-for"), realIp: challenge.headers.get("x-real-ip") };
}

const SPOOFED = { "X-Forwarded-For": "203.0.113.9, 198.51.100.7", "X-Real-IP": "192.0.2.1" };

describe("behind a proxy", () => {
  test("each CLIENT_ADDRESS_FROM reads the visitor's address where it says, and the product is told it under both names", async () => {
    for (const [name, expected] of [
      ["no proxy", "127.0.0.1"],
      ["TRUST_PROXY=1", "198.51.100.7"],
      ["last-forwarded", "198.51.100.7"],
      ["first-forwarded", "203.0.113.9"],
      ["x-real-ip", "192.0.2.1"],
      ["socket", "127.0.0.1"],
    ] as const) {
      const at = name === "no proxy" ? port : proxied[name]!;
      assert.deepEqual(await forwarded(at, SPOOFED), { forwardedFor: expected, realIp: expected }, name);
    }
  });

  test("a mode whose header is missing falls back to the connection's own address, never to another header", async () => {
    for (const [name, headers] of [
      ["last-forwarded", { "X-Real-IP": "192.0.2.1" }],
      ["first-forwarded", { "X-Real-IP": "192.0.2.1" }],
      ["x-real-ip", { "X-Forwarded-For": "203.0.113.9, 198.51.100.7" }],
    ] as const) {
      assert.deepEqual(await forwarded(proxied[name]!, headers), { forwardedFor: "127.0.0.1", realIp: "127.0.0.1" }, name);
    }
  });

  test("X-Forwarded-Host names the site only behind a trusted proxy: the www redirect", async () => {
    const trusted = await send({ port: proxied["TRUST_PROXY=1"], path: "/robots.txt", headers: { "X-Forwarded-Host": "www.schellingaf.com" } });
    assert.equal(trusted.status, 301);
    assert.equal(trusted.headers.location, "https://schellingaf.com/robots.txt");
    const byHost = await send({ port: proxied["TRUST_PROXY=1"], path: "/robots.txt", headers: { Host: "www.schellingaf.com" } });
    assert.equal(byHost.status, 301, "without X-Forwarded-Host the Host header still decides");
    const forged = await send({ path: "/robots.txt", headers: { "X-Forwarded-Host": "www.schellingaf.com" } });
    assert.notEqual(forged.status, 301, "a forged X-Forwarded-Host changes nothing without TRUST_PROXY");
    assert.equal(forged.headers.location, undefined);
  });

  test("X-Forwarded-Host names the site only behind a trusted proxy: a signed-in POST's Origin check", async () => {
    const headers = {
      "X-Forwarded-Proto": "https", "X-Forwarded-Host": "schellingaf.com",
      Origin: "https://schellingaf.com", "Content-Type": "application/json",
    };
    const trusted = await send({ port: proxied["TRUST_PROXY=1"], method: "POST", path: "/sign-in/challenge", headers, body: "{}" });
    assert.equal(trusted.status, 200, trusted.text);
    const forged = await send({ method: "POST", path: "/sign-in/challenge", headers, body: "{}" });
    assert.equal(forged.status, 403, forged.text);
  });
});
