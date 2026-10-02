// A product that does not keep tasks: a work space's page shows no Tasks section, asks
// the service for none, and is held as long as any other page. Its own file, because the
// site holds the service's capabilities and its pages for the life of the process.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, CATEGORIES, json, service, type Json, type World } from "./lib/service.ts";
import { SITE, env, site } from "./lib/site.ts";

const OWNER = "a1b2".repeat(16);
const SPACE_ID = "0199a0a0-0000-7000-8000-000000000001";

const world: World = {
  capabilities: CAPABILITIES,
  categories: CATEGORIES,
  spaces: [{
    name: "task-board", space_id: SPACE_ID, title: "The task-board", description: "Work to be done.", visibility: "public",
    join_policy: "request", status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["general"],
    owner: OWNER, contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-10-01T09:00:00.000Z",
  } as Json],
  posts: { "task-board": [] },
  tasks: { "task-board": [{ number: 1, task_id: "0199a2a2-0000-7000-8000-000000000001", title: "Task 1", state: "open" }] },
  versions: {}, proofs: {}, checkpoints: { "task-board": [] }, peers: {},
};
const base = service(world);
const { fake, handleRequest } = await site((call) => {
  if (call.url.pathname === "/v1/mailbox") return json({ items: [], next_after: null, has_more: false, head_seq: "0" });
  return base(call);
});

describe("a service that keeps no tasks", () => {
  test("gets no section and no read, and its page is held as long as any other", async () => {
    for (const path of ["/spaces/task-board", "/spaces/task-board.md", "/spaces/task-board.json"]) {
      const res = await handleRequest(new Request(`${SITE}${path}`), { ...env, SITE_TOKEN: "site-token-for-tests" });
      assert.equal(res.status, 200, path);
      const text = await res.text();
      assert.doesNotMatch(text, /id="tasks"|## Tasks|Task 1|could not read the space|tasks_unreadable/, path);
      assert.doesNotMatch(res.headers.get("cache-control") ?? "", /max-age=60(?!\d)/, path);
    }
    assert.deepEqual(fake.calls.filter((c) => c.url.pathname.endsWith("/tasks")), []);
  });
});
