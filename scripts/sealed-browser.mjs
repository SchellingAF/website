#!/usr/bin/env node
// Sealed conversations and sealed spaces, driven in a real browser.
//
// Headless Chrome over its DevTools protocol, with Node's own WebSocket, and Chrome's
// own virtual authenticator standing in for each person's passkey, the PRF extension
// included: what only a browser can show about src/sealed-page.js. Two people connect,
// each browser keeping the encryption key its passkey's secret makes; both turn sealing
// on; one makes a sealed space, admits the other from the keepers' page, and posts; the
// other reads it opened; a sealed conversation goes both ways; and throughout, no word
// that was typed leaves either browser in any request, and after Disconnect the
// browser keeps nothing.
//
//   SITE=http://127.0.0.1:<port> node scripts/sealed-browser.mjs
//
// It needs a site and a product running (npm run stack -- up) and Google Chrome, found
// at the usual place on a Mac or named by CHROME. It writes to the product: run it
// against this machine only.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SITE = (process.env.SITE ?? "").replace(/\/+$/, "");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!SITE || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SITE)) {
  console.error("SITE is this machine's site, such as http://127.0.0.1:8787: this writes to the product.");
  process.exit(2);
}

// RELAY=1 prints each result as scripts/verify.sh counts it: "ok NAME" or
// "FAIL NAME<tab>WHY", one a line, and nothing else.
const RELAY = process.env.RELAY === "1";
let failed = 0;
const ok = (what) => console.log(RELAY ? `ok ${what}` : `  ok    ${what}`);
const fail = (what, why) => {
  failed++;
  console.log(RELAY ? `FAIL ${what}\t${String(why).replace(/\s+/g, " ")}` : `  FAIL  ${what}\n        ${why}`);
};
async function step(what, work) {
  try {
    const said = await work();
    ok(said ? `${what}: ${said}` : what);
    return true;
  } catch (error) {
    fail(what, error.message);
    return false;
  }
}

// ── the browser ─────────────────────────────────────────────────────────────

async function launch() {
  const dir = mkdtempSync(join(tmpdir(), "schellingaf-chrome-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run",
    "--no-default-browser-check", "--disable-features=Translate", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const url = await new Promise((resolve, reject) => {
    let seen = "";
    chrome.stderr.on("data", (d) => {
      seen += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
      if (m) resolve(m[1]);
    });
    chrome.on("exit", () => reject(new Error(`Chrome stopped: ${seen.slice(0, 300)}`)));
    setTimeout(() => reject(new Error("Chrome did not start within 20 seconds")), 20000);
  });
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, method } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    } else {
      for (const listener of listeners) listener(msg);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject, method });
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return {
    send,
    listen: (f) => { listeners.add(f); return () => listeners.delete(f); },
    // Chrome goes on writing to its profile for a moment after it is told to stop, so
    // the folder goes once it has exited, and a folder that will not go is left behind
    // rather than failing a run whose steps all held.
    close: async () => {
      try { ws.close(); } catch {}
      const exited = chrome.exitCode !== null ? Promise.resolve() : new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill("SIGKILL");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    },
  };
}

/** One person: a browser profile of their own, a tab, and a passkey that gives a PRF secret. */
async function person(browser, name) {
  const { browserContextId } = await browser.send("Target.createBrowserContext");
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method, params) => browser.send(method, params, sessionId);
  await s("Page.enable");
  await s("Runtime.enable");
  await s("Network.enable");
  await s("WebAuthn.enable", { enableUI: false });
  await s("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true,
    },
  });
  const requests = [];
  const errors = [];
  browser.listen((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === "Network.requestWillBeSent") {
      const r = msg.params.request;
      requests.push({ url: r.url, method: r.method, body: r.postData ?? "" });
    }
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails?.exception?.description ?? "an exception");
  });

  const evaluate = async (expression) => {
    const out = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
    return out.result.value;
  };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (expression, what, ms = 15000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      let value = null;
      try { value = await evaluate(expression); } catch {}
      if (value) return value;
      if (Date.now() > deadline) {
        const at = await evaluate("location.pathname + location.search").catch(() => "?");
        const said = await evaluate("[...document.querySelectorAll('[data-seal-status],[data-sealing-status],.note,#passkey-status')].map(e => e.textContent.trim()).filter(Boolean).join(' | ')").catch(() => "");
        throw new Error(`waited for ${what}; the page is ${at}${said ? `, and says: ${said.slice(0, 400)}` : ""}${errors.length ? `; errors: ${errors.slice(-2).join(" / ")}` : ""}`);
      }
      await pause(150);
    }
  };
  const goto = async (path) => {
    await s("Page.navigate", { url: `${SITE}${path}` });
    await waitFor("document.readyState === 'complete'", `${path} to load`);
    await pause(300);
  };
  /** A real press, with the mouse, so the page has the user's activation a passkey prompt wants. */
  const press = async (selector) => {
    const box = await waitFor(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled || e.offsetParent === null) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`, `${selector} to be pressable`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await s("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
  };
  const fill = (selector, value) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error("no ${selector.replace(/"/g, "")}"); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const choose = (selector) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error("no ${selector.replace(/"/g, "")}"); e.checked = true; return true; })()`);
  return { name, send: s, evaluate, waitFor, goto, press, fill, choose, requests, errors, path: () => evaluate("location.pathname + location.search") };
}

// ── the run ─────────────────────────────────────────────────────────────────

const run = Math.random().toString(36).slice(2, 8);
const SPACE = `sealed-browser-${run}`;
const CANARY_POST = `zqxpost${run}${Math.random().toString(36).slice(2)}`;
const CANARY_MESSAGE = `zqxmessage${run}${Math.random().toString(36).slice(2)}`;
const CANARY_REPLY = `zqxreply${run}${Math.random().toString(36).slice(2)}`;

const browser = await launch().catch((error) => {
  fail("headless Chrome starts", error.message);
  process.exit(1);
});
try {
  const alice = await person(browser, "alice");
  const bob = await person(browser, "bob");

  async function connect(p) {
    await p.goto("/sign-in");
    await p.fill("#passkey-name", `${p.name} ${run}`);
    await p.press("#passkey-create");
    await p.waitFor("location.pathname === '/me'", "connecting to finish", 30000);
    const id = await p.waitFor("(document.querySelector('dd code') || {}).textContent", "the key's id");
    p.id = id.trim();
    return p.id.slice(0, 12);
  }
  await step("alice makes a key with a passkey that gives a PRF secret, and connects", () => connect(alice));
  await step("bob does the same", () => connect(bob));

  async function turnOn(p) {
    await p.waitFor("!document.querySelector('form[data-turn-on]').hidden", "the Turn sealing on button");
    await p.press("form[data-turn-on] button");
    await p.waitFor("location.search.includes('notice=sealing-on')", "sealing to be on", 30000);
    await p.waitFor("document.querySelector('[data-sealing-status]').textContent.includes('holds your encryption key')", "the browser to hold the key");
    return (await p.evaluate("document.querySelector('#sealing-panel code').textContent")).trim();
  }
  await step("alice turns sealing on: her passkey signs the key her browser made, and the page shows its fingerprint", () => turnOn(alice));
  await step("bob turns sealing on", () => turnOn(bob));

  await step("alice makes a sealed space: her browser makes its first key and her own lock", async () => {
    await alice.goto("/me/new");
    await alice.fill("input[name=name]", SPACE);
    await alice.fill("input[name=title]", "A sealed space, in a browser");
    await alice.fill("input[name=category_1]", "general");
    await alice.choose("input[name=visibility][value=sealed]");
    await alice.press("form[data-seal=create] button[type=submit]");
    await alice.waitFor(`location.pathname === '/me/spaces/${SPACE}'`, "the new space's page", 30000);
    return SPACE;
  });

  await step("bob asks to join it", async () => {
    await bob.goto(`/me/spaces/${SPACE}`);
    await bob.fill("textarea[name=message]", "Let me in, please.");
    await bob.press(`form[action='/me/spaces/${SPACE}/join'] button[type=submit]`);
    await bob.waitFor("location.search.includes('notice=asked')", "the join request to be waiting");
  });

  await step("alice admits bob from the keepers' page, and her browser hands him the key", async () => {
    await alice.goto(`/me/spaces/${SPACE}/keepers`);
    await alice.press(`form[action='/me/spaces/${SPACE}/admit'] button[type=submit]`);
    await alice.waitFor("location.search.includes('notice=admitted')", "the admission", 30000);
  });

  await step("alice posts in the sealed space, and the post is sealed in her browser", async () => {
    await alice.goto(`/me/spaces/${SPACE}`);
    await alice.fill("form[data-seal=post] [data-plain=title]", "sealed title");
    await alice.fill("form[data-seal=post] [data-plain=body]", `The plan: ${CANARY_POST}`);
    await alice.press("form[data-seal=post] button[type=submit]");
    await alice.waitFor(`/^\\/me\\/spaces\\/${SPACE}\\/1$/.test(location.pathname)`, "the post's own page", 30000);
    await alice.waitFor(`[...document.querySelectorAll('[data-field=body]')].some(e => e.textContent.includes(${JSON.stringify(CANARY_POST)}))`, "her own post to open on its page");
  });

  await step("bob reads it opened in his browser, with his own lock", async () => {
    await bob.goto(`/me/spaces/${SPACE}`);
    await bob.waitFor(`[...document.querySelectorAll('[data-field=body]')].some(e => e.textContent.includes(${JSON.stringify(CANARY_POST)}))`, "the post to open", 20000);
    return (await bob.evaluate("document.querySelector('[data-field=state]').textContent")).trim();
  });

  let conversation = "";
  await step("alice starts a sealed conversation with bob, whom she knows from the space", async () => {
    await alice.goto(`/me/messages/new?sealed=1&to=${bob.id}`);
    await alice.fill("form[data-seal=start] [data-plain=body]", `Between us: ${CANARY_MESSAGE}`);
    await alice.press("form[data-seal=start] button[type=submit]");
    await alice.waitFor("/^\\/me\\/messages\\/[0-9a-f-]{36}$/.test(location.pathname)", "the conversation's page", 30000);
    conversation = (await alice.path()).split("?")[0];
    return conversation;
  });

  await step("bob opens it, and answers sealed", async () => {
    await bob.goto(conversation);
    await bob.waitFor(`[...document.querySelectorAll('[data-field=body]')].some(e => e.textContent.includes(${JSON.stringify(CANARY_MESSAGE)}))`, "alice's message to open", 20000);
    await bob.fill("form[data-seal=message] [data-plain=body]", `And back: ${CANARY_REPLY}`);
    await bob.press("form[data-seal=message] button[type=submit]");
    await bob.waitFor("location.search.includes('notice=message-sent')", "the reply to be sent", 30000);
    await alice.goto(conversation);
    await alice.waitFor(`[...document.querySelectorAll('[data-field=body]')].some(e => e.textContent.includes(${JSON.stringify(CANARY_REPLY)}))`, "bob's reply to open for alice", 20000);
  });

  await step("no word typed into a sealed form left either browser in any request", async () => {
    const sent = [...alice.requests, ...bob.requests];
    for (const canary of [CANARY_POST, CANARY_MESSAGE, CANARY_REPLY]) {
      const leaked = sent.filter((r) => r.body.includes(canary) || r.url.includes(canary));
      if (leaked.length) throw new Error(`${canary} was in ${leaked.map((r) => `${r.method} ${r.url}`).join(", ")}`);
    }
    const posts = sent.filter((r) => r.method === "POST").length;
    return `${sent.length} requests checked, ${posts} of them forms`;
  });

  await step("with the page's script switched off, a sealed post sends no word and stores nothing", async () => {
    await bob.send("Emulation.setScriptExecutionDisabled", { value: true });
    try {
      await bob.goto(`/me/spaces/${SPACE}`);
      await bob.fill("form[data-seal=post] [data-plain=body]", `Without script: ${CANARY_POST}x`).catch(() => {});
      const named = await bob.evaluate("[...document.querySelectorAll('form[data-seal=post] [name]')].map(e => e.name).join(',')");
      if (/\b(title|body)\b/.test(named)) throw new Error(`the sealed form names ${named}`);
      await bob.press("form[data-seal=post] button[type=submit]");
      await bob.waitFor("document.readyState === 'complete' && !location.pathname.endsWith('/" + SPACE + "')", "the refusal", 20000);
      const said = await bob.evaluate("document.body.innerText.slice(0, 300)");
      if (bob.requests.some((r) => r.body.includes(`${CANARY_POST}x`))) throw new Error("the words were sent");
      return said.split("\n").find((l) => /sealed|Nothing/.test(l)) ?? "refused";
    } finally {
      await bob.send("Emulation.setScriptExecutionDisabled", { value: false });
    }
  });

  await step("after Disconnect, alice's browser keeps nothing this site stored", async () => {
    await alice.goto("/me");
    await alice.press("form[action='/sign-out'] button");
    await alice.waitFor("location.pathname === '/'", "Disconnect to finish", 20000);
    const left = await alice.evaluate(`(async () => {
      const dbs = indexedDB.databases ? await indexedDB.databases() : [];
      if (!dbs.some((d) => d.name === "schellingaf-sealing")) return 0;
      return await new Promise((resolve) => {
        const open = indexedDB.open("schellingaf-sealing");
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("keys")) { db.close(); resolve(0); return; }
          const count = db.transaction("keys").objectStore("keys").count();
          count.onsuccess = () => { db.close(); resolve(count.result); };
        };
        open.onerror = () => resolve(-1);
      });
    })()`);
    if (left !== 0) throw new Error(`${left} key(s) are still stored`);
    return "no key stored";
  });

  for (const p of [alice, bob]) {
    const errors = p.errors.filter((e) => !/NotAllowedError/.test(e));
    if (errors.length) fail(`${p.name}'s pages threw nothing`, errors.slice(0, 3).join(" / "));
  }
} finally {
  await browser.close();
}
if (!RELAY) console.log(failed === 0 ? "sealed-browser: every step held" : `sealed-browser: ${failed} step(s) failed`);
process.exit(failed === 0 ? 0 : 1);
