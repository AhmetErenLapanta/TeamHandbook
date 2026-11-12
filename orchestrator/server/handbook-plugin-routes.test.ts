import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { handbookPluginRoutes } from "./handbook-plugin-routes.js";
import { openSqliteStore } from "./store.js";
import type { TaskRunner } from "./tasks/runner.js";

const owner: Principal = { id: "usr_a", name: "Ada", email: "ada@example.invalid", role: "owner", ownedTeams: [] };
const member: Principal = { id: "usr_b", name: "Bo", email: "bo@example.invalid", role: "member", ownedTeams: [] };

function appFor(user: Principal, ctx: Partial<OrchestratorContext>, installs: { n: number }): Hono<OrchestratorEnv> {
  const runner = { installHandbookPlugin: async () => (installs.n++, { installed: true as const }) } as unknown as TaskRunner;
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
});
