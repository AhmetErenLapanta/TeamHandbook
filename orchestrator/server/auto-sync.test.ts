import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../demo/seed.js";
import { createApp, syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import { syncMinutes, syncRound } from "./auto-sync.js";
import { localRepoPath } from "./forge/local.js";
import { git } from "./git.js";
import { forgeTokenName } from "./propose.js";
import { openSqliteStore } from "./store.js";
import { fakeAgentAdapter } from "./tasks/agents.js";
import { createTaskRunner } from "./tasks/runner.js";
import { createVault, storeSecret } from "./vault.js";

const SECRET = "a-shared-trigger-secret-0123456789";
const FAKE_AGENT = join(import.meta.dirname, "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/**
 * The seeded repositories, read once, beside a hosted one on a stand-in GitLab that holds a request
 * of the orchestrator's, open; the webhook secret is set for both. The hosted repository's address is
 * the stand-in's own, so a fetch of it fails at once on this machine.
 */
async function seeded(gitlab: (path: string) => unknown = () => ({ iid: 5, state: "opened" })): Promise<{ ctx: OrchestratorContext; bare: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-auto-sync-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant, vault: createVault(randomBytes(32)) };
  for (const repo of config.repos) {
    await ctx.store.upsertRepo({ ...repo, tenant: config.tenant });
    await syncRepo(ctx, repo.id);
  }
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(gitlab(req.url!)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "hosted-skills", team: "Payments", name: "hosted-skills", url: `http://127.0.0.1:${port}/acme/hosted-skills.git` });
  const forge = { repoId: "hosted-skills", kind: "gitlab" as const, apiUrl: `http://127.0.0.1:${port}/api/v4`, project: "acme/hosted-skills" };
  await ctx.store.setForgeConfig(ctx.tenant, forge);
  await storeSecret(ctx.store, ctx.vault!, ctx.tenant, forgeTokenName(forge), "glpat-auto-sync-000000000000", "ada@example.invalid");
  await ctx.store.saveRequest({ tenant: ctx.tenant, repoId: "hosted-skills", number: 5, provider: "gitlab", url: "https://gitlab.example.invalid/acme/hosted-skills/-/merge_requests/5", branch: "handbook/orchestrator-x", headSha: "a".repeat(40), title: "Add on-call", status: "open", createdAt: new Date().toISOString(), createdBy: "x" });
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  ctx.jobs = () => ({ jobs: [], triggerSecret: SECRET });
  const payments = config.repos.find((r: { id: string }) => r.id === "payments-skills");
  return { ctx, bare: localRepoPath(payments.url)!, root };
}

/** A teammate's commit on the default branch, made on the forge and not through the orchestrator. */
function mergedOnTheForge(bare: string, root: string): string {
  const work = mkdtempSync(join(root, "work-"));
  git(["clone", "--quiet", bare, work], work);
  writeFileSync(join(work, "NOTES.md"), "merged on the forge\n");
  git(["add", "-A"], work);
  git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "docs: notes"], work);
  git(["fetch", "--quiet", work, "main:main"], bare);
  return git(["rev-parse", "main"], bare).trim();
}

const gitlabHook = (event: string, body: unknown, token = SECRET) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-gitlab-event": event, "x-gitlab-token": token } });
const github = (event: string, body: unknown, secret = SECRET) => {
  const text = JSON.stringify(body);
  return { method: "POST", body: text, headers: { "content-type": "application/json", "x-github-event": event, "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(text).digest("hex")}` } };
};
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 50));
};

describe("the orchestrator's own rounds", () => {
  it("given a commit merged on the forge and a request GitLab merged, when a round runs, then the copy reads the new head and the request is merged at the forge's time, logged as the orchestrator's own check", async () => {
    // given
    const { ctx, bare, root } = await seeded(() => ({ iid: 5, state: "merged", merged_at: "2026-10-26T09:00:00Z" }));
    const moved = mergedOnTheForge(bare, root);

    // when
    const round = await syncRound(ctx, undefined, () => {});

    // then
    expect(round).toEqual({ repos: 3, requests: 1 });
    expect((await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head).toBe(moved);
    expect(await ctx.store.getRequest(ctx.tenant, "hosted-skills", 5)).toMatchObject({ status: "merged", mergedAt: "2026-10-26T09:00:00.000Z" });
    const [event] = (await ctx.store.eventPage(ctx.tenant, { kindPrefix: "request." }, null, 1)).events;
    expect([event!.kind, event!.actor.kind, event!.detail]).toEqual(["request.merged", "orchestrator", 'GitLab says "Add on-call" is merged; read by the orchestrator\'s own check']);
  });

  it("given two requests on a repository read by path, one whose branch the person merged in their own repository and one whose branch they deleted, when a round runs, then the first is merged and the second closed", async () => {
    // given
    const { ctx, bare, root } = await seeded();
    const work = mkdtempSync(join(root, "work-"));
    git(["clone", "--quiet", bare, work], work);
    const branch = (name: string) => {
      git(["checkout", "--quiet", "-b", name, "main"], work);
      writeFileSync(join(work, `${name.replace("/", "-")}.md`), `${name}\n`);
      git(["add", "-A"], work);
      git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", name], work);
      git(["fetch", "--quiet", work, `${name}:${name}`], bare);
      return git(["rev-parse", "HEAD"], work).trim();
    };
    for (const [number, name] of [[1, "task/merged"], [2, "task/dropped"]] as const) {
      await ctx.store.saveRequest({ tenant: ctx.tenant, repoId: "payments-skills", number, provider: "local", url: `local://requests/payments-skills/${number}`, branch: name, headSha: branch(name), title: name, status: "open", createdAt: new Date().toISOString(), createdBy: "x" });
    }
    git(["fetch", "--quiet", work, "task/merged:main"], bare);
    git(["update-ref", "-d", "refs/heads/task/dropped"], bare);

    // when
    await syncRound(ctx, undefined, () => {});

    // then
    expect((await ctx.store.getRequest(ctx.tenant, "payments-skills", 1))?.status).toBe("merged");
    expect((await ctx.store.getRequest(ctx.tenant, "payments-skills", 2))?.status).toBe("closed");
  });

  it.each([
    [undefined, 10],
    ["0", 0],
    ["30", 30],
  ])("given ORCHESTRATOR_SYNC_MINUTES=%s, when it is read, then rounds come every %s minutes", (value, minutes) => {
    expect(syncMinutes(value)).toBe(minutes);
  });

  it.each([["-1"], ["1441"], ["ten"]])("given ORCHESTRATOR_SYNC_MINUTES=%s, when it is read, then the orchestrator stops", (value) => {
    expect(() => syncMinutes(value)).toThrow();
  });
});

describe("the forge telling the orchestrator it moved", () => {
  it("given a signed push from GitLab and one from GitHub, when they arrive, then the orchestrator reads the repository again", async () => {
    // given
    const { ctx, bare, root } = await seeded();
    const app = createApp(ctx, async (c) => c.json({ error: "sign in" }, 401));
    const moved = mergedOnTheForge(bare, root);

    // when
    const fromGitlab = await app.request("/api/hooks/forge/payments-skills", gitlabHook("Push Hook", { ref: "refs/heads/main" }));
    await until(async () => (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head === moved);
    const fromGithub = await app.request("/api/hooks/forge/payments-skills", github("push", { ref: "refs/heads/main" }));

    // then
    expect([fromGitlab.status, fromGithub.status]).toEqual([202, 202]);
    expect((await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head).toBe(moved);
  });

  it("given a GitLab delivery saying the orchestrator's request was merged, when it arrives signed, then the request is read from GitLab and recorded merged", async () => {
    // given
    const { ctx } = await seeded(() => ({ iid: 5, state: "merged", merged_at: "2026-10-26T09:00:00Z" }));
    const app = createApp(ctx, async (c) => c.json({ error: "sign in" }, 401));

    // when
    const res = await app.request("/api/hooks/forge/hosted-skills", gitlabHook("Merge Request Hook", { object_attributes: { iid: 5, action: "merge" } }));
    await until(async () => (await ctx.store.getRequest(ctx.tenant, "hosted-skills", 5))!.status === "merged");

    // then
    expect(res.status).toBe(202);
    expect((await ctx.store.getRequest(ctx.tenant, "hosted-skills", 5))!.status).toBe("merged");
  });

  it.each([
    ["a wrong GitLab token", gitlabHook("Push Hook", {}, "not-the-secret-0000000000"), 401],
    ["a GitHub signature with another secret", github("push", {}, "another-secret-000000000000"), 401],
    ["no signature at all", { method: "POST", body: "{}", headers: { "content-type": "application/json", "x-gitlab-event": "Push Hook" } }, 401],
  ])("given a push with %s, when it arrives, then it is refused and the copy is not read again", async (_label, delivery, status) => {
    // given
    const { ctx, bare, root } = await seeded();
    const app = createApp(ctx, async (c) => c.json({ error: "sign in" }, 401));
    const before = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head;
    mergedOnTheForge(bare, root);

    // when
    const res = await app.request("/api/hooks/forge/payments-skills", delivery);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // then
    expect(res.status).toBe(status);
    expect((await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head).toBe(before);
  });
});
