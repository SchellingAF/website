// A list of more than one page keeps the view it is walked in: the link to the next page
// carries finished=all when the page does, and carries nothing when it does not. Its own file,
// because the world is larger than the other tests' and one process holds one site.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { service } from "./lib/service.ts";
import { hostileWorld, OWNER } from "./lib/world.ts";
import { env, site } from "./lib/site.ts";

const world = hostileWorld();
for (let i = 0; i < 205; i++) {
  world.spaces.push({
    name: `many-${String(i).padStart(3, "0")}`, space_id: `0199eeee-0000-7000-8000-${String(i).padStart(12, "0")}`,
    title: `Title ${i}`, description: "A space.", visibility: "public", join_policy: "request", status: "active",
    signed_only: false, replaced_by: null, categories: ["general"], owner: OWNER,
    contacts: [{ peer_id: OWNER, role: "owner" }], created_at: "2026-10-01T12:00:00.000Z",
  });
}
const { fake, handleRequest } = await site(service(world));

const ask = async (url: string) => (await handleRequest(new Request(url), env)).text();

describe("paging through a list", () => {
  test("the next-page link keeps the view it was walking, in every format", async () => {
    const link = /<a href="([^"]*)">More, continuing after many-199<\/a>/;
    assert.equal((await ask("https://p1.localhost/spaces/m")).match(link)?.[1], "/spaces/m?after=many-199");
    assert.equal((await ask("https://p1.localhost/spaces/m?finished=all")).match(link)?.[1], "/spaces/m?after=many-199&amp;finished=all");
    assert.match(await ask("https://p1.localhost/spaces/m.md"), /More: \/spaces\/m\.md\?after=many-199\n/);
    assert.match(await ask("https://p1.localhost/spaces/m.md?finished=all"), /More: \/spaces\/m\.md\?after=many-199&finished=all\n/);
  });

  test("the second page is asked for in the same view as the first", async () => {
    await ask("https://p2.localhost/spaces/m?after=many-199");
    assert.equal(fake.calls.filter((c) => c.url.pathname === "/v1/spaces").at(-1)?.url.searchParams.get("finished"), "false");
    await ask("https://p2.localhost/spaces/m?after=many-199&finished=all");
    assert.equal(fake.calls.filter((c) => c.url.pathname === "/v1/spaces").at(-1)?.url.searchParams.get("finished"), null);
  });
});
