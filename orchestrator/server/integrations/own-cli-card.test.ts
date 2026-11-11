import { afterEach, describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import type { AddedRepo } from "../connect.js";
import type { CliRun } from "../forge/own-cli.js";
import { openSqliteStore } from "../store.js";
import { integrationCards } from "./routes.js";

const ME: Principal = { id: "u-me", name: "Mo Example", email: "mo@example.invalid", role: "owner", ownedTeams: [] };
const before = process.env.ORCHESTRATOR_MODE;
afterEach(() => {
  if (before === undefined) delete process.env.ORCHESTRATOR_MODE;
  else process.env.ORCHESTRATOR_MODE = before;
});

/** One person's orchestrator with a GitHub repository reached with their own gh, and a gh and glab that answer as told; every call is kept. */
async function orchestrator_(answers: { gh: { missing?: boolean; code: number }; glab: { missing?: boolean; code: number } }) {
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: "unused", tenant: "local" };
  await ctx.store.upsertRepo({ tenant: "local", id: "payments-api", team: "Mine", name: "payments-api", url: "https://github.com/acme/payments-api.git" });
  await ctx.store.setForgeConfig("local", { repoId: "payments-api", kind: "github", apiUrl: "https://api.github.com", project: "acme/payments-api" });
  ctx.addedRepos = new Map([["payments-api", { id: "payments-api", forge: "github", kind: "code", skillsFrom: null, gitOrigin: "https://github.com", memberUrl: null, viaOwnCli: true, addedBy: ME.email, addedAt: "2026-11-02T10:00:00.000Z" } as AddedRepo]]);
  const asked: string[] = [];
  const run: CliRun = async (tool, args) => {
    asked.push(`${tool} ${args.join(" ")}`);
    const a = { ...answers, tea: { code: 1, missing: true } }[tool];
    return { code: a.code, stdout: "", stderr: "", missing: Boolean(a.missing) };
  };
  return { ctx, run, asked };
}

describe("the forge cards on one person's own machine", () => {
  it("given gh signed in and glab not installed, when the cards are read in local mode, then GitHub says requests open with gh for its repository, and GitLab says to install glab and how to sign in", async () => {
    // given
    process.env.ORCHESTRATOR_MODE = "local";
    const { ctx, run, asked } = await orchestrator_({ gh: { code: 0 }, glab: { missing: true, code: 127 } });

    // when
    const cards = await integrationCards(ctx, ME, run);

    // then
    const github = cards.find((c) => c.id === "github") as { state: string; ownCli: unknown };
    const gitlab = cards.find((c) => c.id === "gitlab") as { state: string; ownCli: unknown };
    expect(github.state).toBe("connected");
    expect(github.ownCli).toEqual({ tool: "gh", name: "GitHub's gh", host: "github.com", installed: true, signedIn: true, account: null, version: null, helper: true, install: "https://cli.github.com", login: "gh auth login --hostname github.com", repos: ["payments-api"] });
    expect(gitlab.state).toBe("off");
    expect(gitlab.ownCli).toMatchObject({ tool: "glab", installed: false, signedIn: false, login: "glab auth login --hostname gitlab.com", repos: [] });
    expect(asked.sort()).toEqual(["gh --version", "gh api --hostname github.com user", "gh auth git-credential --help", "gh auth status --hostname github.com", "glab --version", "glab auth git-credential --help", "glab auth status --hostname gitlab.com"]);
  });

  it("given a team's orchestrator, when the cards are read, then no CLI is asked and the cards carry none", async () => {
    // given
    process.env.ORCHESTRATOR_MODE = "self-hosted";
    const { ctx, run, asked } = await orchestrator_({ gh: { code: 0 }, glab: { code: 0 } });

    // when
    const cards = await integrationCards(ctx, ME, run);

    // then
    expect(cards.filter((c) => c.id === "github" || c.id === "gitlab").map((c) => (c as { ownCli: unknown }).ownCli)).toEqual([null, null]);
    expect(asked).toEqual([]);
  });
});
