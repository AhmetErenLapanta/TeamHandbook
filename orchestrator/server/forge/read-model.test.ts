import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFakeForge } from "../../lab/forge.js";
import { createApp, mirrorDir } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import { forgeTokenName } from "../propose.js";
import { openSqliteStore } from "../store.js";
import { createVault, storeSecret } from "../vault.js";
import { ForgeHttpError } from "./http.js";
import { CAPABILITIES, COMMENT_MAX, ForgeReadError, normalizeChecks, readFailure, readRequestWatch } from "./read-model.js";
import type { RawCheck } from "./read-model.js";
import { readRequestTemplate, TEMPLATE_MAX } from "./templates.js";

const TENANT = "acme";
const TOKEN = "glpat-lab-read-model-0001";
const PROJECT = "acme/skills";
const IDENTITY = ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid"];

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

const check = (over: Partial<RawCheck>): RawCheck => ({ name: "test", group: "pipeline", state: "success", at: "2026-11-02T12:00:00Z", sequence: 1, url: null, ...over });

describe("folding a request's checks", () => {
  it("given a check run twice in the same second, when folded, then the later of the two counts and the request passes", () => {
    const folded = normalizeChecks([check({ state: "failure", sequence: 7 }), check({ state: "success", sequence: 8 })], CAPABILITIES.gitlab);
    expect(folded).toEqual({ state: "passing", checks: [{ name: "test", group: "pipeline", state: "success", url: null }] });
  });

  it("given checks of several states, when folded, then failures come first, then what is running, and the request fails", () => {
    const folded = normalizeChecks([check({ name: "lint" }), check({ name: "build", state: "pending" }), check({ name: "test", state: "failure" }), check({ name: "docs", state: "skipped" })], CAPABILITIES.github);
    expect(folded.state).toBe("failing");
    expect(folded.checks.map((c) => c.name)).toEqual(["test", "build", "lint", "docs"]);
  });

  it("given the same name from two groups, when folded, then both stay", () => {
    expect(normalizeChecks([check({ group: "lab-ci" }), check({ group: "status" })], CAPABILITIES.github).checks).toHaveLength(2);
  });

  it("given no check at all, when folded, then GitLab says the repository runs no CI and GitHub says it cannot tell yet", () => {
    expect(normalizeChecks([], CAPABILITIES.gitlab).state).toBe("no-ci");
    expect(normalizeChecks([], CAPABILITIES.github).state).toBe("unknown");
  });
});

describe("why a forge read failed", () => {
  const repo = { tenant: TENANT, id: "skills", team: "Payments", name: "skills", url: "https://gitlab.example.invalid/acme/skills.git", head: null, error: null, syncedAt: null } as never;

  it("given a refused token, when the repository is reached through the connection or a token of its own, then the fix says which to renew and who renews it", () => {
    expect(readFailure(new ForgeHttpError("GitLab answered 401", 401), "gitlab", repo, true)).toMatchObject({ reason: "unauthenticated", message: expect.stringContaining("an owner or an admin connects GitLab again under Integrations") });
    expect(readFailure(new ForgeHttpError("GitLab answered 401", 401), "gitlab", repo, false)).toMatchObject({ reason: "unauthenticated", message: expect.stringContaining("an owner or an admin enters a new token for skills under Integrations") });
  });

  it("given a spent rate limit, when the forge says when to come back, then the reason is rate-limited and carries that time", () => {
    const failed = readFailure(new ForgeHttpError("GitHub answered 403", 403, "2026-11-02T13:00:00.000Z"), "github", repo, true);
    expect(failed).toBeInstanceOf(ForgeReadError);
    expect(failed).toMatchObject({ reason: "rate-limited", retryAt: "2026-11-02T13:00:00.000Z", status: 429 });
  });

  it("given a request the forge does not have, when read, then the reason is not-found, said as a request, with what to do next", () => {
    expect(readFailure(new ForgeHttpError("answered 404", 404), "github", repo, false).message).toMatch(/^GitHub has no such request in skills, .*; open it again from the list of requests, and if it is there, an owner or an admin enters a new token/);
  });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** The lab's forge holding acme/skills with `main` and a `feature` branch, and an orchestrator whose repository opens its requests there with a token. */
async function onLabForge(kind: "gitlab" | "github", conflicting = false) {
  const root = mkdtempSync(join(tmpdir(), "read-model-"));
  const bare = join(root, "forge", `${PROJECT}.git`);
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" }).trim();
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "skills\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "first");
  git(seed, "checkout", "-q", "-b", "feature");
  writeFileSync(join(seed, "README.md"), "skills, with a feature\n");
  git(seed, "commit", "-q", "-am", "feature");
  if (conflicting) {
    git(seed, "checkout", "-q", "main");
    writeFileSync(join(seed, "README.md"), "skills, changed on main\n");
    git(seed, "commit", "-q", "-am", "main moves");
  }
  mkdirSync(join(root, "forge", "acme"), { recursive: true });
  execFileSync("git", ["clone", "-q", "--bare", seed, bare]);
  const port = await freePort();
  servers.push(await startFakeForge({ kind, port, token: TOKEN, root: join(root, "forge"), path: process.env.PATH ?? "", projects: [PROJECT], users: ["grace", "ada"], log: join(root, "forge.log"), scratch: root }));
  const web = `http://127.0.0.1:${port}`;
  const apiUrl = kind === "gitlab" ? `${web}/api/v4` : `${web}/api`;
  const auth: Record<string, string> = kind === "gitlab" ? { "private-token": TOKEN } : { authorization: `Bearer ${TOKEN}` };
  const lab = (path: string, body: unknown) => fetch(`${web}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-lab-user": "ada", ...auth }, body: JSON.stringify(body) });
  const opened = kind === "gitlab"
    ? await (await lab(`/api/v4/projects/${encodeURIComponent(PROJECT)}/merge_requests`, { source_branch: "feature", target_branch: "main", title: "Add a feature" })).json()
    : await (await lab(`/api/repos/${PROJECT}/pulls`, { head: "feature", base: "main", title: "Add a feature" })).json();
  const number = Number((opened as { iid?: number; number?: number }).iid ?? (opened as { number?: number }).number);

  const store = openSqliteStore(":memory:");
  const ctx: OrchestratorContext = { store, dataDir: join(root, "data"), tenant: TENANT, vault: createVault(randomBytes(32)), addedRepos: new Map() };
  const repo = await store.upsertRepo({ tenant: TENANT, id: "skills", team: "Payments", name: "skills", url: `${web}/${PROJECT}.git` });
  await store.setForgeConfig(TENANT, { repoId: "skills", kind, apiUrl, project: PROJECT });
  await storeSecret(store, ctx.vault!, TENANT, forgeTokenName({ repoId: "skills", apiUrl }), TOKEN, "ada@example.invalid");
  const head = git(seed, "rev-parse", "feature");
  return { ctx, repo, number, lab, head };
}

// Each case seeds a repository and starts the lab's forge, seconds of git on a loaded machine.
const ON_FORGE = { timeout: 120_000 };

describe("reading a request on GitLab", ON_FORGE, () => {
  it("given an approval and a pipeline whose failed job was rerun green, when read, then it is approved, mergeable, and its checks pass with the rerun", async () => {
    const { ctx, repo, number, lab, head } = await onLabForge("gitlab");
    await lab("/lab/review", { project: PROJECT, number, user: "grace", state: "APPROVED" });
    await lab("/lab/check", { project: PROJECT, sha: head, name: "test", state: "failed", at: "2026-11-02T12:00:00Z" });
    await lab("/lab/check", { project: PROJECT, sha: head, name: "test", state: "success", at: "2026-11-02T12:00:00Z" });
    await lab("/lab/check", { project: PROJECT, sha: head, name: "lint", state: "success", at: "2026-11-02T12:00:01Z" });

    const { detail } = await readRequestWatch(ctx, repo, number);

    expect(detail).toMatchObject({ number, status: "open", headSha: head, mergeability: { state: "mergeable" }, review: { decision: "approved", approvedBy: ["grace"] } });
    expect(detail.checks).toMatchObject({ state: "passing", checks: [{ name: "lint", state: "success" }, { name: "test", state: "success" }] });
  });

  it("given a branch that conflicts with main and no pipeline, when read, then it is a conflict, nobody approved, and the repository runs no CI", async () => {
    const { ctx, repo, number } = await onLabForge("gitlab", true);
    const { detail } = await readRequestWatch(ctx, repo, number);
    expect(detail.mergeability.state).toBe("conflict");
    expect(detail.review.decision).toBe("none");
    expect(detail.checks.state).toBe("no-ci");
  });

  it("given a request number GitLab does not have, when read, then the reason is not-found", async () => {
    const { ctx, repo } = await onLabForge("gitlab");
    await expect(readRequestWatch(ctx, repo, 99)).rejects.toMatchObject({ reason: "not-found" });
  });
});

describe("reading a pull request on GitHub", ON_FORGE, () => {
  it("given one reviewer asking for changes after another approved, and a running check, when read, then changes are requested and the checks are pending", async () => {
    const { ctx, repo, number, lab, head } = await onLabForge("github");
    await lab("/lab/review", { project: PROJECT, number, user: "grace", state: "APPROVED" });
    await lab("/lab/review", { project: PROJECT, number, user: "ada", state: "CHANGES_REQUESTED" });
    await lab("/lab/check", { project: PROJECT, sha: head, name: "test", state: "running" });

    const { detail } = await readRequestWatch(ctx, repo, number);

    expect(detail).toMatchObject({ status: "open", mergeability: { state: "mergeable" }, review: { decision: "changes-requested", approvedBy: ["grace"] }, checks: { state: "pending" } });
  });

  it("given no check reported yet, when read, then GitHub's checks are unknown rather than no CI", async () => {
    const { ctx, repo, number } = await onLabForge("github");
    expect((await readRequestWatch(ctx, repo, number)).detail.checks.state).toBe("unknown");
  });
});

describe("the request template from the orchestrator's copy", ON_FORGE, () => {
  async function mirrored(files: Record<string, string>, link?: [string, string]) {
    const root = mkdtempSync(join(tmpdir(), "template-"));
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: TENANT };
    const seed = join(root, "seed");
    mkdirSync(seed, { recursive: true });
    const git = (cwd: string, ...args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" }).trim();
    git(seed, "init", "-q", "-b", "main");
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(seed, path, ".."), { recursive: true });
      writeFileSync(join(seed, path), text);
    }
    if (link) {
      mkdirSync(join(seed, link[0], ".."), { recursive: true });
      execFileSync("ln", ["-s", link[1], join(seed, link[0])]);
    }
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "files");
    mkdirSync(join(ctx.dataDir, "mirrors", TENANT), { recursive: true });
    execFileSync("git", ["clone", "-q", "--bare", seed, mirrorDir(ctx, "skills")]);
    const repo = { ...(await ctx.store.upsertRepo({ tenant: TENANT, id: "skills", team: "Payments", name: "skills", url: "https://gitlab.example.invalid/acme/skills.git" })), head: git(seed, "rev-parse", "HEAD") };
    return { ctx, repo };
  }

  it("given GitLab templates with a Default one, when read for GitLab, then Default is taken", async () => {
    const { ctx, repo } = await mirrored({ ".gitlab/merge_request_templates/Bug.md": "bug\n", ".gitlab/merge_request_templates/Default.md": "## What changed\n" });
    expect(await readRequestTemplate(ctx, repo, "gitlab")).toEqual({ path: ".gitlab/merge_request_templates/Default.md", text: "## What changed\n", truncated: false });
  });

  it("given a GitHub template written in capitals, when read for GitHub, then it is found", async () => {
    const { ctx, repo } = await mirrored({ ".github/PULL_REQUEST_TEMPLATE.md": "## Why\n" });
    expect(await readRequestTemplate(ctx, repo, "github")).toMatchObject({ path: ".github/PULL_REQUEST_TEMPLATE.md" });
  });

  it("given a template larger than the limit, when read, then it is cut to the limit on a whole character and says so", async () => {
    const { ctx, repo } = await mirrored({ ".github/pull_request_template.md": "€".repeat(TEMPLATE_MAX) });
    const template = (await readRequestTemplate(ctx, repo, "github"))!;
    expect(template.truncated).toBe(true);
    expect(Buffer.byteLength(template.text)).toBeLessThanOrEqual(TEMPLATE_MAX);
    expect(template.text.endsWith("€")).toBe(true);
  });

  it("given the template's place holding a symbolic link, when read, then nothing is taken from it", async () => {
    const { ctx, repo } = await mirrored({ "README.md": "x\n" }, [".github/pull_request_template.md", "../README.md"]);
    expect(await readRequestTemplate(ctx, repo, "github")).toBeNull();
  });
});

describe("a teammate's request over the API", ON_FORGE, () => {
  it("given a teammate's request that is closed, when its status is asked for, then it is not read through here", async () => {
    const { ctx, number } = await onLabForge("gitlab");
    const signedIn = createApp(ctx, async (c, next) => {
      c.set("user", { id: "u-1", name: "Max Member", email: "max@example.invalid", role: "member", ownedTeams: [], restrictedTeams: [] });
      await next();
    });
    await fetch(`${(await ctx.store.getForgeConfig(TENANT, "skills"))!.apiUrl}/projects/${encodeURIComponent(PROJECT)}/merge_requests/${number}`, { method: "PUT", headers: { "content-type": "application/json", "private-token": TOKEN }, body: JSON.stringify({ state_event: "close" }) });
    expect((await signedIn.request(`/api/repos/skills/requests/${number}/status`)).status).toBe(404);
  });
});

describe("watching a request: what was said on it and its fingerprint", ON_FORGE, () => {
  for (const kind of ["gitlab", "github"] as const) {
    it(`given comments on a ${kind} request, one on a line, a bot's and the forge's own, when watched, then they come newest first with their lines kept, the bot's marked a bot, and the forge's own note left out`, async () => {
      const { ctx, repo, number, lab } = await onLabForge(kind);
      await lab("/lab/comment", { project: PROJECT, number, user: "grace", body: "Looks right.\nOne nit below.", at: "2026-11-02T12:00:00Z" });
      await lab("/lab/comment", { project: PROJECT, number, user: "ada", body: "Rename this.", path: "README.md", line: "1", at: "2026-11-02T12:05:00Z" });
      await lab("/lab/comment", { project: PROJECT, number, user: "lab-bot", body: "Coverage 91%", at: "2026-11-02T12:06:00Z", bot: "true" });
      if (kind === "gitlab") await lab("/lab/comment", { project: PROJECT, number, user: "ada", body: "added 1 commit", at: "2026-11-02T12:07:00Z", system: "true" });

      const watch = await readRequestWatch(ctx, repo, number);

      expect(watch.comments.map((c) => [c.author, c.kind, c.body, c.path, c.line])).toEqual([
        ["lab-bot", "bot", "Coverage 91%", null, null],
        ["ada", "person", "Rename this.", "README.md", 1],
        ["grace", "person", "Looks right.\nOne nit below.", null, null],
      ]);
      expect(watch.detail.number).toBe(number);
      expect(watch.detail.target).toBe("main");
      expect(watch.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    });
  }

  it("given a request watched twice, when nothing changed, then the fingerprint is the same; when a person's comment, a review or a check lands, then it changes each time, and a bot's comment changes nothing", async () => {
    const { ctx, repo, number, lab, head } = await onLabForge("github");
    const seen = [(await readRequestWatch(ctx, repo, number)).fingerprint];
    seen.push((await readRequestWatch(ctx, repo, number)).fingerprint);
    await lab("/lab/comment", { project: PROJECT, number, user: "grace", body: "Please add a test.", at: "2026-11-02T12:00:00Z" });
    seen.push((await readRequestWatch(ctx, repo, number)).fingerprint);
    await lab("/lab/review", { project: PROJECT, number, user: "grace", state: "CHANGES_REQUESTED" });
    seen.push((await readRequestWatch(ctx, repo, number)).fingerprint);
    await lab("/lab/check", { project: PROJECT, sha: head, name: "test", state: "failed" });
    seen.push((await readRequestWatch(ctx, repo, number)).fingerprint);
    await lab("/lab/comment", { project: PROJECT, number, user: "lab-bot", body: "Coverage 91%", at: "2026-11-02T12:06:00Z", bot: "true" });
    const afterBot = (await readRequestWatch(ctx, repo, number)).fingerprint;

    expect(seen[1]).toBe(seen[0]);
    expect(new Set(seen.slice(1)).size).toBe(4);
    expect(afterBot).toBe(seen.at(-1));
  });

  it("given a comment longer than the cap with control characters in it, when watched, then it is cut to the cap and its control characters become spaces", async () => {
    const { ctx, repo, number, lab } = await onLabForge("gitlab");
    await lab("/lab/comment", { project: PROJECT, number, user: "grace", body: `start\u001b[31m${"x".repeat(COMMENT_MAX + 50)}`, at: "2026-11-02T12:00:00Z" });

    const [said] = (await readRequestWatch(ctx, repo, number)).comments;

    expect(said!.body).toHaveLength(COMMENT_MAX);
    expect(said!.body.startsWith("start [31m")).toBe(true);
  });
});

describe("where a request stands, as the person's screen reads it", ON_FORGE, () => {
  const signedIn = (ctx: OrchestratorContext) =>
    createApp(ctx, async (c, next) => {
      c.set("user", { id: "u-1", name: "Max", email: "max@example.invalid", role: "member", ownedTeams: [], restrictedTeams: [] });
      await next();
    });

  it("given a GitLab request with an approval, a passing check and a comment, when its status is asked for, then it comes from the forge with GitLab's capabilities, the review, the checks and what was said", async () => {
    const { ctx, number, lab, head } = await onLabForge("gitlab");
    await lab("/lab/review", { project: PROJECT, number, user: "grace", state: "APPROVED" });
    await lab("/lab/check", { project: PROJECT, sha: head, name: "test", state: "success" });
    await lab("/lab/comment", { project: PROJECT, number, user: "grace", body: "Ship it.", at: "2026-11-02T12:00:00Z" });

    const res = await signedIn(ctx).request(`/api/repos/skills/requests/${number}/status`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: unknown }).status).toMatchObject({
      source: "forge",
      capabilities: { term: "merge request" },
      detail: { number, status: "open", mergeability: { state: "mergeable" }, review: { decision: "approved", approvedBy: ["grace"] }, checks: { state: "passing" } },
      comments: [{ author: "grace", body: "Ship it." }],
      fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });

  it("given a repository connected with no token in local mode, when a request's status is asked for, then it is read through the person's own gh, and without gh it says how to sign in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-gh-"));
    const answer = (name: string, body: unknown) => writeFileSync(join(dir, name), JSON.stringify(body));
    answer("pull.json", { state: "open", merged: false, mergeable: true, mergeable_state: "clean", head: { sha: "a".repeat(40) }, requested_reviewers: [] });
    answer("list.json", []);
    answer("runs.json", { check_runs: [] });
    answer("combined.json", { statuses: [] });
    const script = [
      "#!/bin/sh",
      'case "$1" in auth) exit 0 ;; esac',
      'case "$4" in',
      `  */pulls/7) cat '${join(dir, "pull.json")}' ;;`,
      `  */check-runs*) cat '${join(dir, "runs.json")}' ;;`,
      `  */status) cat '${join(dir, "combined.json")}' ;;`,
      `  *) cat '${join(dir, "list.json")}' ;;`,
      "esac",
    ].join("\n");
    writeFileSync(join(dir, "gh"), `${script}\n`);
    chmodSync(join(dir, "gh"), 0o755);
    vi.stubEnv("PATH", `${dir}${delimiter}${process.env.PATH}`);
    const store = openSqliteStore(":memory:");
    const ctx: OrchestratorContext = { store, dataDir: join(dir, "data"), tenant: TENANT, vault: createVault(randomBytes(32)), ownForgeCli: true, addedRepos: new Map() };
    await store.upsertRepo({ tenant: TENANT, id: "skills", team: "Payments", name: "skills", url: "https://github.com/acme/skills.git" });
    await store.setForgeConfig(TENANT, { repoId: "skills", kind: "github", apiUrl: "https://api.github.com", project: PROJECT });

    const read = await signedIn(ctx).request("/api/repos/skills/requests/7/status");
    writeFileSync(join(dir, "gh"), "#!/bin/sh\nexit 1\n");
    const refused = await signedIn(ctx).request("/api/repos/skills/requests/7/status");
    vi.unstubAllEnvs();

    expect(((await read.json()) as { status: unknown }).status).toMatchObject({ source: "forge", detail: { status: "open", mergeability: { state: "mergeable" }, checks: { state: "unknown" } }, comments: [] });
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { error: string }).error).toContain("gh auth login --hostname github.com");
  });
});

