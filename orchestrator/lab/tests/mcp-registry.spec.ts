import { expect, test } from "@playwright/test";
import { as, lab, SHAPES, unique } from "./support.js";

interface Listed {
  name: string;
  approved: boolean;
  config: Record<string, unknown> | null;
}

const calls = async () => ((await (await fetch(`${lab.registry!.url}/lab/calls`)).json()) as { calls: string[] }).calls;

test.describe("servers from an approved MCP registry", () => {
  for (const org of [...new Set(SHAPES.map((s) => s.org))]) {
    test(`given ${org.name} reading the lab's registry, when its owner approves servers, then one whose namespace checks out and pins a version is approved and listed first, an impostor, a floating package and an unknown name are refused, an admin approves nothing, and the registry is asked once while its answer is kept`, async () => {
      test.skip(!lab.registry, "this lab has no stand-in MCP registry");
      // given
      const owner = await as(org, "admin");
      const admin = await as(org, "org-admin");
      const member = await as(org, "member");
      const cursor = unique("lab-cursor");
      const said = (r: { status: number; json: { error?: string; code?: string } }) => [r.status, r.json.code, r.json.error];

      // when a member reads the list twice
      const first = await member.ok<{ configured: boolean; servers: Listed[] }>("GET", `/api/mcp-registry?cursor=${cursor}`);
      await member.ok("GET", `/api/mcp-registry?cursor=${cursor}`);

      // then it comes from the registry, asked once
      expect(first.configured).toBe(true);
      expect(first.servers.map((s) => s.name)).toEqual(expect.arrayContaining(["io.github.lab-org/tracker", "io.github.lab-org/notes"]));
      expect((await calls()).filter((c) => c.includes(cursor))).toHaveLength(1);

      // when people approve servers
      const byAdmin = await admin.call<{ error?: string; code?: string }>("PUT", "/api/mcp-registry/approved", { name: "io.github.lab-org/tracker" });
      const remote = await owner.ok<{ approved: { name: string; version: string; config: Record<string, unknown> } }>("PUT", "/api/mcp-registry/approved", { name: "io.github.lab-org/tracker" });
      const pinned = await owner.ok<{ approved: { config: Record<string, unknown> } }>("PUT", "/api/mcp-registry/approved", { name: "io.github.lab-org/notes" });
      const impostor = await owner.call<{ error?: string; code?: string }>("PUT", "/api/mcp-registry/approved", { name: "io.github.lab-org/impostor" });
      const floating = await owner.call<{ error?: string; code?: string }>("PUT", "/api/mcp-registry/approved", { name: "io.github.lab-org/floating" });
      const unknown = await owner.call<{ error?: string; code?: string }>("PUT", "/api/mcp-registry/approved", { name: "io.github.lab-org/nothing-here" });
      const bare = await owner.call<{ error?: string; code?: string }>("PUT", "/api/mcp-registry/approved", { name: "tracker" });
      try {
        // then
        expect(said(byAdmin)).toEqual([403, "forbidden", "only an owner approves registry servers"]);
        expect(remote.approved).toMatchObject({ name: "io.github.lab-org/tracker", version: "1.2.0", config: { type: "http", url: "https://tracker.example.invalid/mcp" } });
        expect(pinned.approved.config).toEqual({ command: "npx", args: ["-y", "@lab-org/notes-mcp@0.4.1"] });
        expect([impostor.status, impostor.json.code]).toEqual([409, "registry-namespace"]);
        expect(impostor.json.error).toMatch(/^io\.github\.lab-org\/impostor is not approved: /);
        expect(said(floating)).toEqual([409, "registry-unpinnable", "io.github.lab-org/floating is not approved: it offers no https remote and no npm or PyPI package at a fixed version"]);
        expect(said(unknown)).toEqual([404, "not-found", "the MCP registry has no server io.github.lab-org/nothing-here"]);
        expect(said(bare)).toEqual([400, "invalid", "name a registry server as namespace/name"]);
        const listed = await member.ok<{ servers: Listed[] }>("GET", `/api/mcp-registry?cursor=${unique("lab-cursor")}`);
        expect(listed.servers.slice(0, 2).map((s) => [s.name, s.approved]).sort()).toEqual([["io.github.lab-org/notes", true], ["io.github.lab-org/tracker", true]]);
        const { events } = await admin.ok<{ events: { kind: string; subject: string }[] }>("GET", "/api/events?kind=mcp.registry");
        expect(events.filter((e) => e.kind === "mcp.registry.approved").map((e) => e.subject)).toEqual(expect.arrayContaining(["mcp:io.github.lab-org/tracker", "mcp:io.github.lab-org/notes"]));
      } finally {
        for (const name of ["io.github.lab-org/tracker", "io.github.lab-org/notes", "io.github.lab-org/floating"]) await owner.call("DELETE", `/api/mcp-registry/approved/${name}`);
      }
    });
  }
});
