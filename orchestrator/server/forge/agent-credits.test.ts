import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { openSqliteStore } from "../store.js";
import { removesAgentCredits, withoutAgentCredits } from "./agent-credits.js";

const REPORT = [
  "Added the retry skill and its example.",
  "",
  "Co-authored-by: Claude <noreply@anthropic.com>",
  "Generated with [Claude Code](https://claude.com/claude-code)",
  "Co-authored-by: Grace Hopper <grace@example.invalid>",
  "",
  "```",
  "Co-authored-by: Claude <noreply@anthropic.com>",
  "```",
].join("\n");

describe("leaving the agent's credit lines out of a description", () => {
  it("given a report with an agent's trailer and generated-with line, when the lines are left out, then a person's co-author line and a quoted block stay", () => {
    expect(withoutAgentCredits(REPORT)).toBe(["Added the retry skill and its example.", "", "Co-authored-by: Grace Hopper <grace@example.invalid>", "", "```", "Co-authored-by: Claude <noreply@anthropic.com>", "```"].join("\n"));
  });

  it("given a description with no agent's credit, when the lines are left out, then it is unchanged", () => {
    expect(withoutAgentCredits("Adds the retry skill.\n\nCo-authored-by: Ada <ada@example.invalid>")).toBe("Adds the retry skill.\n\nCo-authored-by: Ada <ada@example.invalid>");
  });
});

describe("a repository's choice about agent credits", () => {
  async function org(user: Principal) {
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: "/nonexistent", tenant: "acme" };
    await ctx.store.upsertRepo({ tenant: "acme", id: "skills", team: "Payments", name: "skills", url: "https://gitlab.example.invalid/acme/skills.git" });
    const app = createApp(ctx, async (c, next) => {
      c.set("user", user);
      await next();
    });
    const put = (remove: unknown) => app.request("/api/repos/skills/agent-credits", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ remove }) });
    return { ctx, app, put };
  }

  it("given a repository, when nobody chose, then its requests keep the agent's credit lines", async () => {
    const { ctx } = await org({ id: "u-1", name: "Pat", email: "pat@example.invalid", role: "member", ownedTeams: ["Payments"] });
    expect(await removesAgentCredits(ctx, "skills")).toBe(false);
  });

  it("given the team's owner, when they turn removal on and off, then the choice holds and each change is in the event log", async () => {
    const { ctx, put } = await org({ id: "u-1", name: "Pat", email: "pat@example.invalid", role: "member", ownedTeams: ["Payments"] });
    expect((await put(true)).status).toBe(200);
    expect(await removesAgentCredits(ctx, "skills")).toBe(true);
    expect((await put(false)).status).toBe(200);
    expect(await removesAgentCredits(ctx, "skills")).toBe(false);
    expect((await ctx.store.eventPage("acme", {}, null, 10)).events.filter((e) => e.kind === "repo.agent-credits")).toHaveLength(2);
  });

  it("given a member of another team, or no clear choice, when either is sent, then it is refused and nothing changes", async () => {
    const stranger = await org({ id: "u-2", name: "Max", email: "max@example.invalid", role: "member", ownedTeams: [] });
    expect((await stranger.put(true)).status).toBe(403);
    const owner = await org({ id: "u-1", name: "Pat", email: "pat@example.invalid", role: "member", ownedTeams: ["Payments"] });
    expect((await owner.put("yes")).status).toBe(400);
    expect(await removesAgentCredits(owner.ctx, "skills")).toBe(false);
  });
});
