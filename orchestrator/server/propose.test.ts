import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../demo/seed.js";
import { mirrorDir, syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { Principal } from "./auth.js";
import { prepareChange } from "./changes.js";
import { saveForgeAccess } from "./editing.js";
import { forgeTokenName, localForge, mergeRequest, propose, repositoryAddress } from "./propose.js";
import { openSqliteStore } from "./store.js";
import { createVault, storeSecret } from "./vault.js";

const TOKEN = "glpat-Ab12Cd34Ef56Gh78Ij90";
const OWNER: Principal = { id: "p", name: "Pat Example", email: "pat@example.invalid", role: "member", ownedTeams: ["Payments"], forgeLogin: "pat" };

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

/** A GitLab project acme/payments-skills that records each request and answers the calls a request needs. */
async function fakeGitLab(): Promise<{ apiUrl: string; recorded: Recorded[] }> {
  const recorded: Recorded[] = [];
  const project = "/api/v4/projects/acme%2Fpayments-skills";
  const users: Record<string, number> = { ada: 11, grace: 12, pat: 21 };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const path = req.url!;
      recorded.push({ method: req.method!, path, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      const answer = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };
      const user = path.match(/^\/api\/v4\/users\?username=(\w+)$/)?.[1];
      if (user) return answer(200, users[user] ? [{ id: users[user], username: user }] : []);
      if (req.method === "GET" && path === project) return answer(200, { id: 7, default_branch: "main" });
      if (req.method === "GET" && path.startsWith(`${project}/repository/files/`)) return answer(200, {});
      if (req.method === "POST" && path === `${project}/repository/commits`) return answer(201, { id: "c0ffee".padEnd(40, "0") });
      if (req.method === "POST" && path === `${project}/merge_requests`) return answer(201, { iid: 5, web_url: "https://gitlab.example.invalid/acme/payments-skills/-/merge_requests/5", state: "opened" });
      return answer(404, { message: "404 Not found" });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v4`, recorded };
}

/** The seeded Payments repository, as if it lived on GitLab: its mirror stays, its URL is no longer a path. */
async function onGitLab(): Promise<OrchestratorContext> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-propose-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant, vault: createVault(randomBytes(32)) };
  const entry = config.repos.find((r: { id: string }) => r.id === "payments-skills");
  await ctx.store.upsertRepo({ ...entry, tenant: config.tenant });
  await syncRepo(ctx, entry.id);
  await ctx.store.upsertRepo({ ...entry, tenant: config.tenant, url: "https://gitlab.example.invalid/acme/payments-skills.git" });
  return ctx;
}

describe("a change to a repository on a hosted forge", () => {
  it("given a GitLab project and its sealed token, when an owner proposes a change, then the request goes to GitLab with the team's reviewers, labels and the owner as assignee, and the token only in the header", async () => {
    // given
    const ctx = await onGitLab();
    const { apiUrl, recorded } = await fakeGitLab();
    await ctx.store.setForgeConfig(ctx.tenant, { repoId: "payments-skills", kind: "gitlab", apiUrl, project: "acme/payments-skills" });
    await storeSecret(ctx.store, ctx.vault!, ctx.tenant, forgeTokenName({ repoId: "payments-skills", apiUrl }), TOKEN, "ada@example.invalid");
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const prepared = await prepareChange(mirrorDir(ctx, repo.id), repo.head!, { kind: "skill.delete", slug: "release-checklist" }, "chore(skill): remove release-checklist", OWNER.name, { commitPrefix: "PAY" });

    // when
    const request = await propose(ctx, repo, OWNER, prepared);

    // then
    expect(request).toMatchObject({ provider: "gitlab", number: 5, status: "open", createdBy: "pat@example.invalid" });
    expect((await ctx.store.listRequests(ctx.tenant, repo.id))[0]).toMatchObject({ provider: "gitlab", number: 5 });
    const commit = recorded.find((r) => r.method === "POST" && r.path.endsWith("/repository/commits"))!.body as Record<string, unknown>;
    expect(commit).toMatchObject({ start_sha: repo.head, author_name: "Pat Example", author_email: "pat@example.invalid" });
    expect(commit.actions).toEqual([{ action: "delete", file_path: "skills/release-checklist/SKILL.md" }]);
    const mr = recorded.find((r) => r.method === "POST" && r.path.endsWith("/merge_requests"))!.body;
    expect(mr).toMatchObject({ target_branch: "main", title: "PAY chore(skill): remove release-checklist", reviewer_ids: [11, 12], labels: "skills", assignee_id: 21 });
    expect(recorded.every((r) => r.headers["private-token"] === TOKEN)).toBe(true);
    expect(recorded.some((r) => r.path.includes(TOKEN) || JSON.stringify(r.body ?? "").includes(TOKEN))).toBe(false);
  });

  it("given a GitLab project with no token stored, when a change is proposed, then nothing is sent and the orchestrator says no forge is configured", async () => {
    // given
    const ctx = await onGitLab();
    const { apiUrl, recorded } = await fakeGitLab();
    await ctx.store.setForgeConfig(ctx.tenant, { repoId: "payments-skills", kind: "gitlab", apiUrl, project: "acme/payments-skills" });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const prepared = await prepareChange(mirrorDir(ctx, repo.id), repo.head!, { kind: "skill.delete", slug: "release-checklist" }, "chore(skill): remove release-checklist", OWNER.name);

    // when
    const attempt = propose(ctx, repo, OWNER, prepared);

    // then
    await expect(attempt).rejects.toThrow(/no forge is configured/);
    expect(recorded).toEqual([]);
  });
});

describe("a forge token and the address it was entered for", () => {
  it("given a stored token, when an admin points the repository at another address without entering a token, then it is refused and nothing changes", async () => {
    // given
    const ctx = await onGitLab();
    const real = await fakeGitLab();
    const config = { repoId: "payments-skills", kind: "gitlab" as const, apiUrl: real.apiUrl, project: "acme/payments-skills" };
    await saveForgeAccess(ctx.store, ctx.vault!, ctx.tenant, config, TOKEN, "ada@example.invalid");

    // when
    const moved = saveForgeAccess(ctx.store, ctx.vault!, ctx.tenant, { ...config, apiUrl: "https://elsewhere.example.invalid/api/v4" }, undefined, "eve@example.invalid");

    // then
    await expect(moved).rejects.toThrow(/enter a token for the new settings/);
    expect(await ctx.store.getSecret(ctx.tenant, forgeTokenName(config))).not.toBeNull();
    expect((await ctx.store.getForgeConfig(ctx.tenant, "payments-skills"))!.apiUrl).toBe(real.apiUrl);
  });

  it.each([
    ["the forge", { kind: "github" as const, project: "acme/payments-skills" }],
    ["the project", { project: "acme/other-skills" }],
  ])("given a stored token, when %s changes without a new token, then it is refused, and a new token for the new settings replaces the old one", async (_label, change) => {
    const ctx = await onGitLab();
    const config = { repoId: "payments-skills", kind: "gitlab" as const, apiUrl: "https://gitlab.example.invalid/api/v4", project: "acme/payments-skills" };
    await saveForgeAccess(ctx.store, ctx.vault!, ctx.tenant, config, TOKEN, "ada@example.invalid");
    await expect(saveForgeAccess(ctx.store, ctx.vault!, ctx.tenant, { ...config, ...change }, "", "eve@example.invalid")).rejects.toThrow(/enter a token/);
    expect(await ctx.store.getForgeConfig(ctx.tenant, "payments-skills")).toEqual(config);
    await saveForgeAccess(ctx.store, ctx.vault!, ctx.tenant, { ...config, ...change, apiUrl: "https://gitlab2.example.invalid/api/v4" }, "glpat-AnotherToken0123", "ada@example.invalid");
    expect(await ctx.store.getSecret(ctx.tenant, forgeTokenName(config))).toBeNull();
  });

  it("given a token stored for one address, when the saved address is changed behind the orchestrator's back, then a change sends nothing to the new address", async () => {
    // given
    const ctx = await onGitLab();
    const real = await fakeGitLab();
    const attacker = await fakeGitLab();
    await saveForgeAccess(ctx.store, ctx.vault!, ctx.tenant, { repoId: "payments-skills", kind: "gitlab", apiUrl: real.apiUrl, project: "acme/payments-skills" }, TOKEN, "ada@example.invalid");
    await ctx.store.setForgeConfig(ctx.tenant, { repoId: "payments-skills", kind: "gitlab", apiUrl: attacker.apiUrl, project: "acme/payments-skills" });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const prepared = await prepareChange(mirrorDir(ctx, repo.id), repo.head!, { kind: "skill.delete", slug: "release-checklist" }, "chore(skill): remove release-checklist", OWNER.name);

    // when
    const attempt = propose(ctx, repo, OWNER, prepared);

    // then
    await expect(attempt).rejects.toThrow(/no forge is configured/);
    expect(attacker.recorded).toEqual([]);
    expect(real.recorded).toEqual([]);
  });
});

describe("the address two orchestrators share a team repository by", () => {
  it.each([
    ["two tokens for one repository", "https://oauth2:glpat-aaaaaaaaaaaaaaaaaaaa@GitLab.Example.invalid/acme/skills.git", "https://pat:other@gitlab.example.invalid/acme/skills"],
    ["an ssh address with its user and without", "git@git.example.invalid:acme/skills.git", "git.example.invalid:acme/skills"],
    ["a trailing slash", "https://git.example.invalid/acme/skills/", "https://git.example.invalid/acme/skills.git"],
    ["an scp-like address and an ssh URL with its port", "git@git.example.invalid:acme/skills.git", "ssh://git@git.example.invalid:22/acme/skills"],
    ["ssh and https for one repository", "git@git.example.invalid:acme/skills.git", "https://git.example.invalid/acme/skills.git"],
    ["the default https port and the path in another case", "https://git.example.invalid:443/Acme/Skills.git", "https://git.example.invalid/acme/skills"],
  ])("given %s, when each is turned into the shared address, then they are one and carry no credential", (_label, a, b) => {
    expect(repositoryAddress(a)).toBe(repositoryAddress(b));
    expect(repositoryAddress(a)).not.toMatch(/glpat|other@|oauth2/);
  });

  it("given a local repository reached through a link and by its own path, when each is turned into the shared address, then they are one", () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "orchestrator-address-"));
    dirs.push(root);
    const link = `${root}-link`;
    symlinkSync(root, link);
    dirs.push(link);

    // when
    const direct = repositoryAddress(`file://${join(root, "skills.git")}`);
    const linked = repositoryAddress(`file://${join(link, "skills.git")}`);

    // then
    expect(linked).toBe(direct);
  });

  it("given two different repositories on one host, when each is turned into the shared address, then they differ", () => {
    expect(repositoryAddress("https://git.example.invalid/acme/skills.git")).not.toBe(repositoryAddress("https://git.example.invalid/acme/other.git"));
  });
});

describe("merging a local request only at the head its check passed", () => {
  const IDENTITY = ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid"];
  const OWNER: Principal = { id: "usr_owner", name: "Grace", email: "grace@example.invalid", role: "owner", ownedTeams: [] };

  /** A team repository on the local forge with one request open on it. */
  async function opened() {
    const root = mkdtempSync(join(tmpdir(), "merge-check-"));
    const seedDir = join(root, "seed");
    mkdirSync(seedDir);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" }).trim();
    git(seedDir, "init", "-q", "-b", "main");
    writeFileSync(join(seedDir, "README.md"), "skills\n");
    git(seedDir, "add", ".");
    git(seedDir, "commit", "-q", "-m", "first");
    const bare = join(root, "team.git");
    execFileSync("git", ["clone", "-q", "--bare", seedDir, bare]);
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: "acme" };
    const repo = await ctx.store.upsertRepo({ tenant: "acme", id: "skills", team: "Payments", name: "skills", url: `file://${bare}` });
    const base = git(bare, "rev-parse", "main");
    const request = await localForge(ctx).open(repo, { title: "Add retry", body: "Adds retry.", branch: "handbook/retry", baseSha: base, files: [{ path: "retry.md", content: "# Retry\n" }], author: { name: "Pat", email: "pat@example.invalid" } });
    await ctx.store.saveRequest({ tenant: "acme", repoId: "skills", ...request, title: "Add retry", status: "open", provider: "local", createdAt: "2026-11-03T00:00:00.000Z", createdBy: "pat@example.invalid" });
    const pushAfter = () => {
      const pushed = git(bare, "commit-tree", `${request.headSha}^{tree}`, "-p", request.headSha, "-m", "pushed after the check");
      git(bare, "update-ref", "refs/heads/handbook/retry", pushed);
    };
    return { ctx, repo, bare, request, base, git, pushAfter };
  }

  it("given a request its check held, when an owner merges it, then it is refused with the check's reason and the default branch stays", async () => {
    const { ctx, repo, bare, request, base, git } = await opened();
    await ctx.store.recordRequestCheck("acme", "skills", request.number, { head: request.headSha, passed: false, reason: "the pushed branch writes outside the task's repository" });

    await expect(mergeRequest(ctx, repo, request.number, OWNER)).rejects.toThrow("the pushed branch writes outside the task's repository");
    expect(git(bare, "rev-parse", "main")).toBe(base);
  });

  it("given a request whose check passed its head, when an owner merges it, then that head merges", async () => {
    const { ctx, repo, bare, request, git } = await opened();
    await ctx.store.recordRequestCheck("acme", "skills", request.number, { head: request.headSha, passed: true });

    expect((await mergeRequest(ctx, repo, request.number, OWNER)).status).toBe("merged");
    expect(git(bare, "rev-parse", "main^2")).toBe(request.headSha);
  });

  it("given a push to the branch after its check passed, when an owner merges it, then it is refused until the new head is checked, and the default branch stays", async () => {
    const { ctx, repo, bare, request, base, git, pushAfter } = await opened();
    await ctx.store.recordRequestCheck("acme", "skills", request.number, { head: request.headSha, passed: true });
    pushAfter();

    await expect(mergeRequest(ctx, repo, request.number, OWNER)).rejects.toThrow("the branch moved since it was checked; it is checked again before it merges");
    expect(git(bare, "rev-parse", "main")).toBe(base);
  });

  it("given a request no task opened, so never checked, when an owner merges it, then it merges as it stands", async () => {
    const { ctx, repo, request } = await opened();
    expect((await mergeRequest(ctx, repo, request.number, OWNER)).status).toBe("merged");
  });
});

