import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());
// The routes keep what they read for a minute, in the process; a test starts with nothing kept by another.
beforeEach(() => handbookReads.forget());
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { handbookPluginRoutes } from "./handbook-plugin-routes.js";
import { handbookReads } from "./short-memory.js";
import { openSqliteStore } from "./store.js";
import type { ReadSources } from "./tasks/handbook-sources.js";
import type { TaskRunner } from "./tasks/runner.js";

const owner: Principal = { id: "usr_a", name: "Ada", email: "ada@example.invalid", role: "owner", ownedTeams: [] };
const member: Principal = { id: "usr_b", name: "Bo", email: "bo@example.invalid", role: "member", ownedTeams: [] };

const read: ReadSources = {
  sources: [{ id: "yours", kind: "yours", name: "Yours", enabled: true, skills: [{ name: "triage-notes" }], commands: [], mcpServers: [], hooks: [] }],
  roots: new Map(),
};

function appFor(user: Principal, ctx: Partial<OrchestratorContext>, installs: { n: number }, sources: ReadSources | null = read): Hono<OrchestratorEnv> {
  const runner = { installHandbookPlugin: async () => (installs.n++, { installed: true as const }), handbookSources: async () => sources } as unknown as TaskRunner;
  const app = new Hono<OrchestratorEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", handbookPluginRoutes({ store: openSqliteStore(":memory:"), dataDir: "/data", tenant: "default", ...ctx }, runner));
  return app;
}

describe("the handbook plugin's install route", () => {
  it("given the owner of an orchestrator only their machine reaches, when they press Install, then the runner installs the plugin and the answer says so", async () => {
    // given
    const installs = { n: 0 };
    const app = appFor(owner, { ownForgeCli: true }, installs);

    // when
    const answered = await app.request("/api/handbook/plugin", { method: "POST" });

    // then
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ installed: true });
    expect(installs.n).toBe(1);
  });

  it("given a team's orchestrator, when the owner presses Install, then nothing is installed and the answer says to type the commands", async () => {
    // given
    const installs = { n: 0 };
    const app = appFor(owner, {}, installs);

    // when
    const answered = await app.request("/api/handbook/plugin", { method: "POST" });

    // then
    expect(answered.status).toBe(409);
    expect((await answered.json()).error).toContain("type the two commands");
    expect(installs.n).toBe(0);
  });

  it("given a member of an orchestrator only this machine reaches, when they press Install, then nothing is installed", async () => {
    // given
    const installs = { n: 0 };
    const app = appFor(member, { ownForgeCli: true }, installs);

    // when
    const answered = await app.request("/api/handbook/plugin", { method: "POST" });

    // then
    expect(answered.status).toBe(409);
    expect(installs.n).toBe(0);
  });

  it("given the owner of a one-person orchestrator, when the sources are asked for, then they come as a list, and for a team's orchestrator, a member or an API key the answer says it is not available", async () => {
    // given
    const own = appFor(owner, { ownForgeCli: true }, { n: 0 });
    const team = appFor(owner, {}, { n: 0 });
    const asMember = appFor(member, { ownForgeCli: true }, { n: 0 });
    const asKey = appFor({ ...owner, key: true } as unknown as Principal, { ownForgeCli: true }, { n: 0 });

    // when
    const answers = await Promise.all([own, team, asMember, asKey].map(async (app) => (await app.request("/api/handbook/sources")).json()));

    // then
    expect(answers[0]).toMatchObject({ available: true, sources: [{ id: "yours", skills: [{ name: "triage-notes" }] }] });
    for (const refused of answers.slice(1)) expect(refused).toMatchObject({ available: false });
  });

  it("given a skill read for a name the sources do not list, a team's orchestrator and a runner that reads nothing, when each is asked, then each is a 404", async () => {
    // given
    const own = appFor(owner, { ownForgeCli: true }, { n: 0 });
    const team = appFor(owner, {}, { n: 0 });
    const none = appFor(owner, { ownForgeCli: true }, { n: 0 }, null);

    // when
    const unlisted = await own.request("/api/handbook/skill?source=yours&name=..%2Fsettings");
    const teams = await team.request("/api/handbook/skill?source=yours&name=triage-notes");
    const nothing = await none.request("/api/handbook/skill?source=yours&name=triage-notes");

    // then
    expect([unlisted.status, teams.status, nothing.status]).toEqual([404, 404, 404]);
  });

  it("given a plugin that brings a server and the orchestrator holding nothing, when the sources are asked for, then the server row names the plugin it comes with", async () => {
    // given
    const withPlugin: ReadSources = {
      sources: [{ id: "plugin:payments-skills@payments-market", kind: "plugin", name: "payments-skills", enabled: true, skills: [], commands: [], mcpServers: [{ name: "ledger" }], hooks: [] }],
      roots: new Map(),
    };
    const setup = { commands: [], plugins: [], mcpServers: [{ name: "ledger", kind: "stdio" as const, scope: "plugin" as const, asksForValue: false }], claudeMd: false, readAt: "" };
    const runner = { handbookSources: async () => withPlugin, lastPersonalSetup: () => setup, personalSetup: async () => setup } as unknown as TaskRunner;
    const app = new Hono<OrchestratorEnv>();
    app.use("*", async (c, next) => {
      c.set("user", owner);
      await next();
    });
    app.route("/", handbookPluginRoutes({ store: openSqliteStore(":memory:"), dataDir: "/data", tenant: "default", ownForgeCli: true, tasks: runner }, runner));
    vi.stubEnv("ORCHESTRATOR_MODE", "local");

    // when
    const answer = await (await app.request("/api/handbook/sources")).json();

    // then
    expect(answer.mcp).toEqual([expect.objectContaining({ name: "ledger", origins: ["claude-plugin"], plugins: ["plugin:payments-skills@payments-market"] })]);
  });

  it("given the person's own folder, when a skill is opened, saved on its digest and deleted, then each lands, and a plugin's source or a member is refused", async () => {
    // given
    const root = realpathSync(mkdtempSync(join(tmpdir(), "th-file-route-")));
    const claudeDir = join(root, ".claude");
    mkdirSync(join(claudeDir, "skills", "triage-notes"), { recursive: true });
    writeFileSync(join(claudeDir, "skills", "triage-notes", "SKILL.md"), "Old steps.\n");
    const sources: ReadSources = { sources: read.sources, roots: new Map([["yours", claudeDir], ["plugin:payments-skills@payments-market", join(root, "plugin")]]) };
    const app = appFor(owner, { ownForgeCli: true }, { n: 0 }, sources);
    const put = (body: unknown) => app.request("/api/handbook/file", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

    try {
      // when
      const opened = await (await app.request("/api/handbook/file?source=yours&kind=skill&name=triage-notes")).json();
      const saved = await put({ source: "yours", kind: "skill", name: "triage-notes", content: "---\nname: triage-notes\ndescription: When a ticket comes in\n---\nNew steps.\n", expectedDigest: opened.digest });
      const stale = await put({ source: "yours", kind: "skill", name: "triage-notes", content: "Again.\n", expectedDigest: opened.digest });
      const plugin = await put({ source: "plugin:payments-skills@payments-market", kind: "skill", name: "add-endpoint", content: "x", expectedDigest: null });
      const asMember = await appFor(member, { ownForgeCli: true }, { n: 0 }, sources).request("/api/handbook/file?source=yours&kind=skill&name=triage-notes");
      const current = await (await app.request("/api/handbook/file?source=yours&kind=skill&name=triage-notes")).json();
      const deleted = await app.request("/api/handbook/file", { method: "DELETE", body: JSON.stringify({ source: "yours", kind: "skill", name: "triage-notes", expectedDigest: current.digest }), headers: { "content-type": "application/json" } });

      // then
      expect(opened).toMatchObject({ content: "Old steps.\n" });
      expect(saved.status).toBe(200);
      expect(stale.status).toBe(409);
      expect(plugin.status).toBe(400);
      expect(asMember.status).toBe(404);
      expect(deleted.status).toBe(200);
      expect(existsSync(join(claudeDir, "skills", "triage-notes"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("given a plugin installed for one folder, when it is turned off from the page, then nothing runs and the answer says to use that folder's terminal", async () => {
    // given
    const ops: string[] = [];
    const folderPlugin: ReadSources = { sources: [{ id: "plugin:docs-kit@payments-market", kind: "plugin", name: "docs-kit", marketplace: "payments-market", scope: "project", enabled: true, skills: [], commands: [], mcpServers: [], hooks: [] }], roots: new Map() };
    const runner = { handbookSources: async () => folderPlugin, pluginOp: async (op: string) => (ops.push(op), { ok: true, command: "x" }) } as unknown as TaskRunner;
    const app = new Hono<OrchestratorEnv>();
    app.use("*", async (c, next) => {
      c.set("user", owner);
      await next();
    });
    app.route("/", handbookPluginRoutes({ store: openSqliteStore(":memory:"), dataDir: "/data", tenant: "default", ownForgeCli: true }, runner));

    // when
    const answered = await app.request("/api/handbook/plugins/disable", { method: "POST", body: JSON.stringify({ plugin: "plugin:docs-kit@payments-market" }), headers: { "content-type": "application/json" } });

    // then
    expect(answered.status).toBe(409);
    expect((await answered.json()).error).toContain("that folder's terminal");
    expect(ops).toEqual([]);
  });

  it("given the owner of an orchestrator only their machine reaches and a member of it, when each presses Check for updates, then the runner refreshes the marketplaces once for the owner and the member is refused", async () => {
    // given
    const ops: string[][] = [];
    const runner = { handbookSources: async () => read, pluginOp: async (...args: string[]) => (ops.push(args), { ok: true, command: "claude plugin marketplace update" }) } as unknown as TaskRunner;
    const appAs = (user: Principal) => {
      const app = new Hono<OrchestratorEnv>();
      app.use("*", async (c, next) => {
        c.set("user", user);
        await next();
      });
      app.route("/", handbookPluginRoutes({ store: openSqliteStore(":memory:"), dataDir: "/data", tenant: "default", ownForgeCli: true }, runner));
      return app;
    };

    // when
    const mine = await appAs(owner).request("/api/handbook/marketplaces/update", { method: "POST" });
    const theirs = await appAs(member).request("/api/handbook/marketplaces/update", { method: "POST" });

    // then
    expect([mine.status, await mine.json()]).toEqual([200, { ok: true, command: "claude plugin marketplace update" }]);
    expect(theirs.status).toBe(404);
    expect(ops).toEqual([["check", "", "user"]]);
  });
});
