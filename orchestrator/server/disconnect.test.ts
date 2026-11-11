import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seed } from "../demo/seed.js";
import { createApp, mirrorDir, MIRROR_GONE_UNCONFIGURED, NOT_CONFIGURED, syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { prepareChange } from "./changes.js";
import { localRepoPath } from "./forge/local.js";
import { git, gitMaybe } from "./git.js";
import { closeRequest, forgeTokenName, propose, reconcileLocalRequests, refreshRequest } from "./propose.js";
import { openSqliteStore } from "./store.js";
import { createVault, storeSecret } from "./vault.js";
import { randomBytes } from "node:crypto";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const PLATFORM_OWNER: Principal = { id: "l", name: "Lin Example", email: "lin@example.invalid", role: "member", ownedTeams: ["Platform"] };
const MEMBER: Principal = { id: "m", name: "Max Example", email: "max@example.invalid", role: "member", ownedTeams: [] };
const SKILL = "---\nname: on-call-handover\ndescription: Use at shift change.\n---\n\nHand over.\n";

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    await next();
  };
}

/** The demo's two repositories, read once, with the configuration then listing only payments-skills. */
async function platformTakenOut(): Promise<{ ctx: OrchestratorContext; root: string; bare: string }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-disconnect-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant, publicUrl: "https://orchestrator.example.com" };
  for (const repo of config.repos) {
    await ctx.store.upsertRepo({ ...repo, tenant: config.tenant });
    await syncRepo(ctx, repo.id);
  }
  ctx.configured = new Set(["payments-skills"]);
  return { ctx, root, bare: localRepoPath((await ctx.store.getRepo(ctx.tenant, "platform-skills"))!.url)! };
}

function send(app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) {
  return app.request(path, { method, headers: { "content-type": "application/json", "x-csrf-token": "t" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function openRequest(ctx: OrchestratorContext, id = "platform-skills") {
  const repo = (await ctx.store.getRepo(ctx.tenant, id))!;
  const prepared = await prepareChange(mirrorDir(ctx, id), repo.head!, { kind: "skill.add", slug: "on-call-handover", content: SKILL }, "feat(skill): add on-call-handover", "Lin");
  return propose(ctx, repo, PLATFORM_OWNER, prepared);
}

describe("a repository the configuration no longer lists", () => {
  it("given platform-skills taken out of the file, when it is listed, synced and changed, then it shows as out of the configuration, its remote is not fetched, and changes are refused", async () => {
    // given
    const { ctx, root, bare } = await platformTakenOut();
    const before = (await ctx.store.getRepo(ctx.tenant, "platform-skills"))!;
    const work = mkdtempSync(join(root, "teammate-"));
    git(["clone", "--quiet", bare, work], work);
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-qm", "chore: moved on"], work);
    git(["fetch", "--quiet", work, "main:main"], bare);
    const app = createApp(ctx, as(ADMIN));

    // when
    const listed = (await (await app.request("/api/repos")).json()).repos as { id: string; configured: boolean }[];
    const synced = await syncRepo(ctx, "platform-skills");
    const syncAsked = await send(app, "POST", "/api/repos/platform-skills/sync");
    const proposal = await send(app, "POST", "/api/repos/platform-skills/changes/proposal", { change: { kind: "skill.add", slug: "x", content: SKILL } });
    const change = await send(app, "POST", "/api/repos/platform-skills/changes", { baseSha: before.head, message: "m", change: { kind: "skill.add", slug: "x", content: SKILL } });
    const usage = await send(app, "POST", "/api/repos/platform-skills/usage/propose");

    // then
    expect(listed.map((r) => [r.id, r.configured])).toEqual([["payments-skills", true], ["platform-skills", false]]);
    expect(synced).toEqual({ error: NOT_CONFIGURED });
    expect(await ctx.store.getRepo(ctx.tenant, "platform-skills")).toEqual(before);
    expect(git(["rev-parse", "HEAD"], mirrorDir(ctx, "platform-skills")).trim()).toBe(before.head);
    for (const res of [syncAsked, proposal, change, usage]) {
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(NOT_CONFIGURED);
    }
    expect((await app.request("/api/repos/platform-skills/inventory")).status).toBe(200);
  });

  it("given its copy missing, when it is read, then the answer says the copy is not read again while it is out of the configuration", async () => {
    // given
    const { ctx } = await platformTakenOut();
    rmSync(mirrorDir(ctx, "platform-skills"), { recursive: true, force: true });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // when
    const read = await createApp(ctx, as(ADMIN)).request("/api/repos/platform-skills/inventory");

    // then
    expect(read.status).toBe(409);
    expect(((await read.json()) as { error: string }).error).toBe(MIRROR_GONE_UNCONFIGURED);
  });
});

describe("disconnecting a repository", () => {
  it("given an admin and a repository out of the configuration, when it is disconnected, then its copy, forge access, token and ingest id go, and its requests, numbers and counts stay, with the team's repository untouched", async () => {
    // given
    const { ctx, bare } = await platformTakenOut();
    ctx.vault = createVault(randomBytes(32));
    const forge = { repoId: "platform-skills", kind: "gitlab" as const, apiUrl: "https://gitlab.example.invalid/api/v4", project: "platform/skills" };
    await ctx.store.setForgeConfig(ctx.tenant, forge);
    await storeSecret(ctx.store, ctx.vault, ctx.tenant, forgeTokenName(forge), "glpat-disconnect-0000000000", "ada@example.invalid");
    await ctx.store.setIngestId(ctx.tenant, "platform-skills", "i".repeat(32));
    await ctx.store.addUsage(ctx.tenant, "platform-skills", "rotate-service-certificate", new Date().toISOString().slice(0, 13), 3);
    ctx.configured = new Set(["payments-skills", "platform-skills"]);
    const request = await openRequest(ctx);
    await closeRequest(ctx, (await ctx.store.getRepo(ctx.tenant, "platform-skills"))!, request.number);
    ctx.configured = new Set(["payments-skills"]);
    const refs = git(["for-each-ref"], bare);

    // when
    const res = await send(createApp(ctx, as(ADMIN)), "DELETE", "/api/repos/platform-skills");

    // then
    expect(res.status).toBe(200);
    expect(await ctx.store.getRepo(ctx.tenant, "platform-skills")).toBeNull();
    expect(existsSync(mirrorDir(ctx, "platform-skills"))).toBe(false);
    expect(await ctx.store.getForgeConfig(ctx.tenant, "platform-skills")).toBeNull();
    expect(await ctx.store.getSecret(ctx.tenant, forgeTokenName(forge))).toBeNull();
    expect(await ctx.store.repoForIngest("i".repeat(32))).toBeNull();
    expect((await ctx.store.listRequests(ctx.tenant, "platform-skills")).map((r) => r.number)).toEqual([request.number]);
    expect(await ctx.store.nextRequestNumber(ctx.tenant, "platform-skills")).toBe(request.number + 1);
    expect((await ctx.store.usage(ctx.tenant, "2000-01-01T00", "platform-skills"))[0]!.count).toBe(3);
    expect(git(["for-each-ref"], bare)).toBe(refs);
    expect(await ctx.store.getRepo(ctx.tenant, "payments-skills")).not.toBeNull();
  });

  it.each([
    ["a member, CSRF token and all", MEMBER, () => undefined, 403, "only an owner or an admin disconnects a repository"],
    ["a repository the file still lists", ADMIN, (ctx: OrchestratorContext) => void (ctx.configured = new Set(["payments-skills", "platform-skills"])), 409, "remove it from ORCHESTRATOR_CONFIG first"],
  ] as const)("given %s, when disconnecting is asked for, then it is refused and nothing goes", async (_label, user, arrange, status, message) => {
    // given
    const { ctx } = await platformTakenOut();
    arrange(ctx);

    // when
    const res = await send(createApp(ctx, as(user)), "DELETE", "/api/repos/platform-skills");

    // then
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: string }).error).toContain(message);
    expect(await ctx.store.getRepo(ctx.tenant, "platform-skills")).not.toBeNull();
    expect(existsSync(mirrorDir(ctx, "platform-skills"))).toBe(true);
  });

  it("given an open request on it, when an admin disconnects it, then it is refused until the request is closed", async () => {
    // given
    const { ctx } = await platformTakenOut();
    ctx.configured = new Set(["payments-skills", "platform-skills"]);
    const request = await openRequest(ctx);
    ctx.configured = new Set(["payments-skills"]);
    const app = createApp(ctx, as(ADMIN));

    // when
    const refused = await send(app, "DELETE", "/api/repos/platform-skills");
    await closeRequest(ctx, (await ctx.store.getRepo(ctx.tenant, "platform-skills"))!, request.number);
    const allowed = await send(app, "DELETE", "/api/repos/platform-skills");

    // then
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("it has 1 open request; merge or close it first (one on a forge is closed there and refreshed here)");
    expect(allowed.status).toBe(200);
  });

  it("given a task queued on it, when an admin disconnects it, then it is refused", async () => {
    // given
    const { ctx } = await platformTakenOut();
    await ctx.store.createTask({ tenant: ctx.tenant, id: "aaaaaaaaaaaa", repoId: "platform-skills", team: "Platform", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: "x", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null });

    // when
    const res = await send(createApp(ctx, as(ADMIN)), "DELETE", "/api/repos/platform-skills");

    // then
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("a task is running on it; cancel the task first");
    expect(await ctx.store.getRepo(ctx.tenant, "platform-skills")).not.toBeNull();
  });

  it("given a repository renamed in the file, its old id disconnected, when the orchestrator starts, then the old id's request branch stays in the team's repository", async () => {
    // given
    const { ctx } = await platformTakenOut();
    ctx.configured = new Set(["payments-skills", "platform-skills"]);
    const request = await openRequest(ctx);
    const old = (await ctx.store.getRepo(ctx.tenant, "platform-skills"))!;
    await closeRequest(ctx, old, request.number);
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "platform-renamed", team: "Platform", name: "platform-renamed", url: old.url });
    ctx.configured = new Set(["payments-skills", "platform-renamed"]);
    await send(createApp(ctx, as(ADMIN)), "DELETE", "/api/repos/platform-skills");
    const bare = localRepoPath(old.url)!;

    // when
    await reconcileLocalRequests(ctx);

    // then
    expect(gitMaybe(["rev-parse", "--verify", "--quiet", `refs/heads/${request.branch}`], bare)).not.toBeNull();
  });

  it("given a repository whose URL carries a token, when it is listed, refused and disconnected, then the token is in no answer and no log line, and its copy is gone", async () => {
    // given
    const { ctx } = await platformTakenOut();
    const token = "s3cr3t-token-in-the-url";
    const url = `https://ada:${token}@git.example.invalid/platform/skills.git`;
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "platform-skills", team: "Platform", name: "platform-skills", url });
    git(["remote", "set-url", "origin", url], mirrorDir(ctx, "platform-skills"));
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => void logged.push(args.map(String).join(" ")));
    const app = createApp(ctx, as(ADMIN));

    // when
    const answers = [
      await (await app.request("/api/repos")).text(),
      await (await app.request("/api/repos/platform-skills/inventory")).text(),
      await (await send(app, "POST", "/api/repos/platform-skills/sync")).text(),
      JSON.stringify(await syncRepo(ctx, "platform-skills")),
      await (await send(app, "DELETE", "/api/repos/platform-skills")).text(),
    ];

    // then
    for (const answer of [...answers, ...logged]) expect(answer).not.toContain(token);
    expect(answers[0]).toContain("https://***@git.example.invalid/platform/skills.git");
    expect(existsSync(mirrorDir(ctx, "platform-skills"))).toBe(false);
  });
});

describe("a repository out of the configuration and its team's repository", () => {
  it("given a request recorded merged whose branch never reached main, when the orchestrator starts, then a repository the file no longer lists is left as it is", async () => {
    // given
    const { ctx } = await platformTakenOut();
    ctx.configured = new Set(["payments-skills", "platform-skills"]);
    const request = await openRequest(ctx);
    await ctx.store.transitionRequest(ctx.tenant, "platform-skills", request.number, "open", "merged");
    ctx.configured = new Set(["payments-skills"]);

    // when
    const said = await reconcileLocalRequests(ctx);

    // then
    expect(said).toEqual([]);
    expect((await ctx.store.getRequest(ctx.tenant, "platform-skills", request.number))!.status).toBe("merged");
  });
});

describe("a folder without git at a start", () => {
  it("given a project on a folder that is no git repository beside a team repository, when the orchestrator starts, then the start settles the repository and leaves the folder alone", async () => {
    // given
    const { ctx, root } = await platformTakenOut();
    const folder = mkdtempSync(join(root, "notes-"));
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "notes", team: "Mine", name: "notes", url: folder });
    ctx.configured = new Set(["payments-skills", "notes"]);

    // when
    const said = await reconcileLocalRequests(ctx);

    // then
    expect(said).toEqual([]);
  });
});

describe("a refresh and a disconnect at once", () => {
  it("given a hosted request closed here and reopened on its forge, when a disconnect lands while the forge is answering, then the request stays closed rather than open with no repository to close it in", async () => {
    // given
    const { ctx } = await platformTakenOut();
    ctx.vault = createVault(randomBytes(32));
    let release: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => (release = resolve));
    let asked: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (asked = resolve));
    const server = createServer((req, res) => {
      asked();
      void answered.then(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(req.url!.endsWith("/merge_requests/5") ? { iid: 5, state: "opened" } : {}));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const forge = { repoId: "platform-skills", kind: "gitlab" as const, apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v4`, project: "platform/skills" };
      await ctx.store.setForgeConfig(ctx.tenant, forge);
      await storeSecret(ctx.store, ctx.vault, ctx.tenant, forgeTokenName(forge), "glpat-race-0000000000000000", "ada@example.invalid");
      const repo = (await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "platform-skills", team: "Platform", name: "platform-skills", url: "https://gitlab.example.invalid/platform/skills.git" }))!;
      await ctx.store.saveRequest({ tenant: ctx.tenant, repoId: repo.id, number: 5, provider: "gitlab", url: "https://gitlab.example.invalid/platform/skills/-/merge_requests/5", branch: "handbook/orchestrator-x", headSha: "a".repeat(40), title: "t", status: "closed", createdAt: new Date().toISOString(), createdBy: "x" });
      // Settled into a value at once, so its refusal is held while the disconnect is awaited.
      const refreshing = refreshRequest(ctx, repo, 5).then(() => null, (err: Error) => err);
      await reached;

      // when
      const disconnecting = (await import("./app.js")).disconnectRepo(ctx, repo);
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();

      // then
      await expect(disconnecting).resolves.toBeUndefined();
      expect(((await refreshing) as Error).message).toBe("platform-skills was disconnected while its forge was asked about request #5");
      expect((await ctx.store.getRequest(ctx.tenant, repo.id, 5))!.status).toBe("closed");
      expect(await ctx.store.getRepo(ctx.tenant, repo.id)).toBeNull();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
