import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { aiAnalytics } from "./ai-requests.js";
import { createApp, mirrorDir } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { openSqliteStore } from "./store.js";

const OWNER: Principal = { id: "o", name: "Ada Owner", email: "ada@example.invalid", role: "owner", ownedTeams: [] };
const MEMBER: Principal = { id: "m", name: "Max Member", email: "max@example.invalid", role: "member", ownedTeams: [] };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    await next();
  };
}

/** A team repository with a history a forge would leave, built commit by commit at the times given. */
function history(work: string) {
  const run = (args: string[], at: string, who = { name: "Pat Dev", email: "pat@example.invalid" }) =>
    execFileSync("git", args, {
      cwd: work,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: work, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: "Forge", GIT_COMMITTER_EMAIL: "forge@example.invalid", GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
    });
  const commit = (file: string, message: string, at: string, who?: { name: string; email: string }) => {
    mkdirSync(dirname(join(work, file)), { recursive: true });
    writeFileSync(join(work, file), `${message}\n`);
    run(["add", "-A"], at, who);
    run(["commit", "-q", "-m", message], at, who);
  };
  run(["init", "-q", "-b", "main"], "2026-10-01T00:00:00Z");
  commit("README.md", "first", "2026-10-01T00:00:00Z");
  return { run, commit };
}

async function orchestrator_(): Promise<OrchestratorContext> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-ai-"));
  dirs.push(root);
  const work = join(root, "work");
  mkdirSync(work);
  const { run, commit } = history(work);

  // A merge before the window.
  run(["checkout", "-q", "-b", "old"], "2026-09-01T00:00:00Z");
  commit("old.md", "old\n\nCo-Authored-By: Claude <noreply@anthropic.com>", "2026-09-01T00:00:00Z");
  run(["checkout", "-q", "main"], "2026-09-02T00:00:00Z");
  run(["merge", "-q", "--no-ff", "old", "-m", "Merge pull request #3 from acme/old"], "2026-09-02T00:00:00Z");

  // GitLab: a branch whose commits name Claude Code, merged with a merge commit 10 hours later.
  run(["checkout", "-q", "-b", "refunds"], "2026-10-10T00:00:00Z");
  commit("skills/refunds/SKILL.md", "feat: refunds\n\nCo-Authored-By: Claude <noreply@anthropic.com>", "2026-10-10T00:00:00Z");
  commit("skills/refunds/notes.md", "docs: notes", "2026-10-10T02:00:00Z");
  run(["checkout", "-q", "main"], "2026-10-10T10:00:00Z");
  run(["merge", "-q", "--no-ff", "refunds", "-m", "Merge branch 'refunds' into 'main'\n\nSee merge request acme/payments!12"], "2026-10-10T10:00:00Z");

  // GitHub: a pull request with no agent in it, merged 4 hours after its first commit.
  run(["checkout", "-q", "-b", "ledger"], "2026-10-12T00:00:00Z");
  commit("skills/ledger/SKILL.md", "feat: ledger", "2026-10-12T00:00:00Z", { name: "Lin Dev", email: "lin@example.invalid" });
  run(["checkout", "-q", "main"], "2026-10-12T04:00:00Z");
  run(["merge", "-q", "--no-ff", "ledger", "-m", "Merge pull request #7 from acme/ledger"], "2026-10-12T04:00:00Z");

  // A squash with the pull request's number, written with Copilot.
  commit("skills/fx/SKILL.md", "feat: fx rates (#9)\n\nCo-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>", "2026-10-14T00:00:00Z", { name: "Lin Dev", email: "lin@example.invalid" });

  // A push straight to main is no request, whatever it carries.
  commit("skills/direct/SKILL.md", "chore: direct\n\nCo-Authored-By: Claude <noreply@anthropic.com>", "2026-10-15T00:00:00Z");

  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: "acme", allowedHosts: null };
  const mirror = mirrorDir(ctx, "payments-skills");
  mkdirSync(dirname(mirror), { recursive: true });
  execFileSync("git", ["clone", "-q", "--mirror", work, mirror], { env: { PATH: process.env.PATH, HOME: work, GIT_CONFIG_NOSYSTEM: "1" } });
  const head = execFileSync("git", ["rev-parse", "main"], { cwd: work, encoding: "utf8" }).trim();
  await ctx.store.upsertRepo({ tenant: "acme", id: "payments-skills", team: "Payments", name: "payments-skills", url: `file://${work}` });
  await ctx.store.recordSync("acme", "payments-skills", { head });
  return ctx;
}

/** The window from 5 October to 20 October, whatever day the test runs. */
const read = (ctx: OrchestratorContext, people = true) => aiAnalytics(ctx, 15, people, new Date("2026-10-20T00:00:00Z"));

describe("merged requests a coding agent helped write, read from the repository's history", () => {
  it("given a GitLab merge with a Claude trailer, a GitHub merge without one and a squash with Copilot's, when an owner reads them, then three requests merged and two are AI-assisted, a direct push and a merge before the window left out", async () => {
    // given
    const ctx = await orchestrator_();

    // when
    const body = await read(ctx);

    // then
    expect(body.total).toMatchObject({ merged: 3, aiAssisted: 2, share: 0.667 });
    expect(body.byAgent.filter((a: { requests: number }) => a.requests)).toEqual([
      { agent: "claude-code", label: "Claude Code", requests: 1 },
      { agent: "copilot", label: "GitHub Copilot", requests: 1 },
    ]);
    expect(body.byTeam).toEqual([expect.objectContaining({ team: "Payments", merged: 3, aiAssisted: 2 })]);
  });

  it("given requests whose branches keep their commits, when the times are read, then hours to merge run from the first commit, and a squash, whose start is unknown, is left out of them", async () => {
    // given
    const ctx = await orchestrator_();

    // when
    const body = await read(ctx);

    // then
    expect(body.total.hoursToMerge).toEqual({ ai: { median: 10, p90: 10 }, other: { median: 4, p90: 4 } });
  });

  it("given an owner and a member, when each reads the page, then the owner sees who wrote the requests and the member sees no person", async () => {
    // given
    const ctx = await orchestrator_();

    // when
    const counted = await read(ctx);
    const owner = await (await createApp(ctx, as(OWNER)).request("/api/analytics/ai-requests?days=365")).json();
    const member = await (await createApp(ctx, as(MEMBER)).request("/api/analytics/ai-requests?days=365")).json();

    // then
    expect(counted.byPerson!.map((p) => [p.email, p.merged, p.aiAssisted])).toEqual([
      ["lin@example.invalid", 2, 1],
      ["pat@example.invalid", 1, 1],
    ]);
    expect(Array.isArray(owner.byPerson)).toBe(true);
    expect(member.byPerson).toBeNull();
    expect(JSON.stringify(member)).not.toContain("example.invalid");
  });

  it("given a days value out of range, when it is asked for, then it is refused", async () => {
    // given
    const ctx = await orchestrator_();

    // when
    const res = await createApp(ctx, as(OWNER)).request("/api/analytics/ai-requests?days=0");

    // then
    expect(res.status).toBe(400);
  });
});

