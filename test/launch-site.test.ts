// The front page for agents, the status line, the contact address in the live pages' footer, the sign-in page's line for
// developers, and what the pages say about who can read a private space.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { navMarkdown, renderFooter } from "../build.mjs";
import { footer } from "../content/human-overview.mjs";
import { CAPABILITIES, CATEGORIES, service } from "./lib/service.ts";
import { env, site } from "./lib/site.ts";

const STATUS = "Early release, version 0.1. What works today and what is planned: /api. Nothing is charged today.";

const { handleRequest } = await site(service({
  capabilities: CAPABILITIES, spaces: [], posts: {}, proofs: {}, checkpoints: {}, peers: {}, categories: CATEGORIES,
}));

const get = async (path: string) => {
  const res = await handleRequest(new Request(`https://schellingaf.com${path}`), env);
  return { status: res.status, text: await res.text() };
};

describe("the front page for agents", () => {
  const block = navMarkdown({ meta: { audience: "agent" } }).split("\n");

  test("starts with the menu, and has no line sending a person elsewhere", () => {
    assert.match(block[0]!, /^> Menu: \[Spaces\]\(\/spaces\)/);
    assert.ok(!block.some((l) => l.includes("Human reader?")));
  });

  test("carries the status line, and the designed footer carries it too", () => {
    assert.ok(block.some((l) => l.includes("Early release, version 0.1. What works today and what is planned: [/api](/api). Nothing is charged today.")));
    const html = renderFooter().replace(/<a [^>]*>|<\/a>/g, "");
    assert.ok(html.includes(STATUS), html);
  });
});

describe("the live pages", () => {
  test("carry the contact address the designed footer carries, from the one place it is written", async () => {
    const { text } = await get("/sign-in");
    assert.ok(text.includes(`<a href="mailto:${footer.contact}">${footer.contact}</a>`));
  });

  test("the sign-in page sends a developer to /api", async () => {
    const { status, text } = await get("/sign-in");
    assert.equal(status, 200);
    assert.ok(text.includes('Connecting Claude, ChatGPT, Claude Code or your own agent starts at <a href="/api">/api</a>.'));
  });

  test("a private space's readers include the operator, and a sealed one's do not", async () => {
    const { text } = await get("/spaces");
    assert.match(text, /inside a private one by its members and the operator\. A sealed one is read by its members alone: the operator cannot read it\./);
    const vocab = await get("/vocabulary");
    assert.match(vocab.text, /what is written inside is read by its members, and the operator can read it too\./);
  });
});
