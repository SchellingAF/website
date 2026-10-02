// A conversation's page puts each member's state into words from a table. The state is
// the service's, so a word such as "constructor" or "__proto__" must stay a word: a
// plain lookup in an object literal would return a built-in function or object for it.
// ownWord() asks the table for its own words only, and anything else is shown as the service wrote it, escaped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { conversationHtml } from "../src/messages-render.ts";
import { formShell } from "../src/me-render.ts";
import { htmlProblems } from "./lib/documents.ts";

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);
const viewer = { peerId: ME, csrf: "c".repeat(43) };

for (const state of ["constructor", "__proto__", "toString", "<script>alert(1)</script>"]) {
  test(`a member state of ${JSON.stringify(state)} is shown as text`, () => {
    const html = conversationHtml(formShell("A conversation", viewer), viewer, {
      conversation: {
        conversation_id: "0199a0b0-0000-7000-8000-000000000001",
        kind: "group",
        started_by: OTHER,
        created_at: "2026-09-18T12:00:00.000Z",
        state: "accepted",
        members: [{ peer_id: ME, state: "accepted" }, { peer_id: OTHER, state }],
        head_seq: "0",
        read_seq: "0",
        cleared_through: "0",
        unread: false,
        last_message_at: "2026-09-18T12:00:00.000Z",
      },
      messages: [],
      from: null,
      nextAfter: null,
      inviteFor: [],
    }, null);
    assert.ok(html.includes(state.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")), "the state reaches the page as text");
    assert.deepEqual(htmlProblems(html), []);
  });
}
