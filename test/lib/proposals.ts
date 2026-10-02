// Proposal spaces for the stand-in service: public work spaces named proposal-<name>,
// filed under the category this-service, each with the document a proposal is, or none.
//
// The stand-in already lists spaces by category, name and cursor, and answers a work
// space's document as the product does: the document of a space whose profile has
// `document`, a document with no version yet, and a refusal, NOT_AN_ORACLE, for a space
// that keeps none. What it lacked was the category and spaces that use them, which is all
// this adds.

import { CAPABILITIES, CATEGORIES, type Json, type World } from "./service.ts";

/** The category every proposal is filed under, as the service's list holds it. */
export const THIS_SERVICE: Json = {
  id: "this-service", label: "This service", parent: "general", depth: 2, status: "active", children: 0,
  description: "The service itself.", elsewhere: "", examples: [], aliases: [], since: "2026-09-18",
};

export interface Proposal {
  name: string;
  title?: string;
  /** When it was opened. */
  created?: string;
  /** The text of its document. Absent: the space keeps no document. null: it keeps one that
   *  has no version yet. */
  document?: string | null;
  /** The key that posted the document's version: the owner of the space proposals, unless
   *  given. */
  author?: string;
  /** Fields of the space's listing over the stand-in's own: a hostile service's, or a space
   *  that is not public. */
  fields?: Json;
}

/** The owner of the space proposals, and a key that is nobody's but its own. */
export const OWNER = "a1b2".repeat(16);
export const STRANGER = "c3d4".repeat(16);
/** A proposal's document as the plan shapes it, ending in the section a status is read from.
 *  `status` null leaves the section out; the empty string leaves it empty. */
export const proposalText = (title: string, status: string | null): string =>
  `# ${title}\n\n## Problem\nSomething is missing.\n\n## Evidence\nA trial.\n\n## Proposed change\n- Add it.\n` +
  (status === null ? "" : `\n## Status\n${status}\n`);

const uuid = (n: number, seq: number) => `0199f0f0-0000-7000-8${String(n % 10)}00-${String(n * 10 + seq).padStart(12, "0")}`;

/** A world whose spaces are these proposals and whatever else is given, in the order given,
 *  and the space proposals, owned by OWNER, unless one of the others is it. */
export function proposalWorld(proposals: Proposal[], others: Json[] = []): World {
  const spaces: Json[] = [];
  const posts: Record<string, Json[]> = {};
  const versions: Record<string, Json[]> = {};
  proposals.forEach((p, n) => {
    const created = p.created ?? "2026-10-01T12:00:00.000Z";
    const author = p.author ?? OWNER;
    const space: Json = {
      name: p.name, space_id: uuid(n, 0), title: p.title ?? `Title of ${p.name}`, description: "A proposal.", visibility: "public",
      join_policy: "open", status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["this-service"],
      owner: OWNER, contacts: [{ peer_id: OWNER, role: "owner" }], created_at: created, last_written_at: created,
      access: { role: null, tags: [], read: true, post: true }, ...p.fields,
    };
    posts[p.name] = [];
    if (typeof p.document === "string") {
      space.document = { version: { post_id: uuid(n, 1), seq: "1" }, pending: 0 };
      posts[p.name] = [{
        post_id: uuid(n, 1), space: p.name, seq: "1", kind: "version", author, posted_at: created, title: "First", to: [],
        reply_to: null, supersedes: null, retracts: null, fingerprints: [], signed: false, space_id: uuid(n, 0), body: p.document,
      }];
      versions[p.name] = [{
        post_id: uuid(n, 1), seq: "1", author, posted_at: created, summary: null, signed: false, state: "current",
        edits: null, same_text_as: null, decision: null,
      }];
    } else if (p.document === null) {
      space.document = { version: null, pending: 0 };
    }
    spaces.push(space);
  });
  return {
    capabilities: CAPABILITIES, categories: [...CATEGORIES, THIS_SERVICE],
    spaces: [...spaces, ...(others.some((s) => s.name === "proposals") ? [] : [otherSpace("proposals")]), ...others], posts, versions,
    proofs: {}, checkpoints: {}, peers: {},
  };
}

/** A space that is not a proposal, filed where the stand-in can list it. */
export const otherSpace = (name: string, fields: Json = {}): Json => ({
  name, space_id: "0199f0f0-0000-7000-8000-00000000f000", title: `The ${name}`, description: "Not a proposal.", visibility: "public",
  join_policy: "request", status: "active", signed_only: false, replaced_by: null, oracle: false, categories: ["this-service"],
  owner: OWNER, contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-09-20T12:00:00.000Z",
  access: { role: null, tags: [], read: true, post: true }, ...fields,
});
