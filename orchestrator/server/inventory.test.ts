import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../demo/seed.js";
import type { MiddlewareHandler } from "hono";
import { createApp, maskUrl, mirrorDir, syncError, syncRepo, syncRepos } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { git, gitMaybe } from "./git.js";
import { MAX_FILE_BYTES, readHistory, readInventory, readTeamRecord, readTeamRecordAsync, readTeamSetup, readTeamSetupAsync, syncMirror } from "./inventory.js";
import { openSqliteStore } from "./store.js";
import { mcpInTasks } from "./tasks/mcp-tasks.js";
import type { TaskRunner } from "./tasks/runner.js";

process.env.ORCHESTRATOR_AUTH = "dev-admin";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-test-"));
  dirs.push(dir);
  return dir;
}

async function seeded(): Promise<{ root: string; ctx: OrchestratorContext; config: { tenant: string; repos: { id: string; team: string; name: string; url: string }[] } }> {
  const root = scratch();
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const store = openSqliteStore(":memory:");
  const ctx: OrchestratorContext = { store, dataDir: join(root, "data"), tenant: config.tenant };
  for (const repo of config.repos) {
    await store.upsertRepo({ ...repo, tenant: config.tenant });
    await syncRepo(ctx, repo.id);
  }
  return { root, ctx, config };
}

describe("skills that answer the same requests", () => {
  it("given two skills whose descriptions say the same thing and one that says something else, when the overlaps are asked for, then the first two name each other and the third names nobody", async () => {
    // given
    const { ctx, root, config } = await seeded();
    const bare = config.repos.find((r) => r.id === "payments-skills")!.url.replace("file://", "");
    const work = mkdtempSync(join(root, "teammate-"));
    git(["clone", "--quiet", bare, work], work);
    const skill = (slug: string, description: string) => {
      mkdirSync(join(work, "skills", slug), { recursive: true });
      writeFileSync(join(work, "skills", slug, "SKILL.md"), `---\nname: ${slug}\ndescription: ${description}\n---\n\nSteps.\n`);
    };
    skill("ship-payments-release", "Use when shipping a payments release to production after the release checks pass.");
    skill("payments-release-shipping", "Use when shipping the payments release to production once the release checks pass.");
    skill("rotate-ledger-keys", "Use when the ledger encryption keys reach their rotation date.");
    git(["add", "-A"], work);
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "feat(skill): three skills"], work);
    git(["fetch", "--quiet", work, "main:main"], bare);
    await syncRepo(ctx, "payments-skills");

    // when
    const { overlaps } = await (await createApp(ctx).request("/api/repos/payments-skills/overlaps")).json();

    // then
    expect(overlaps["ship-payments-release"].names[0]).toBe("payments-release-shipping");
    expect(overlaps["payments-release-shipping"].names[0]).toBe("ship-payments-release");
    expect(overlaps["rotate-ledger-keys"]).toEqual({ names: [], more: 0 });
  });
});

describe("reading a team repository TeamHandbook set up", () => {
  it("given a seeded repository, when its inventory is read, then skills, servers, commands and the team record come back as the repository holds them", async () => {
    // given
    const { ctx } = await seeded();

    // when
    const inventory = await readInventory(mirrorDir(ctx, "payments-skills"));

    // then
    expect(inventory.skills.map((s) => s.slug)).toEqual(["add-ledger-migration", "release-checklist"]);
    expect(inventory.skills[0]!.files).toEqual(["SKILL.md", "check.sql"]);
    expect(inventory.mcpServers.map((m) => [m.name, m.transport, m.shareable])).toEqual([
      ["docs", "http", true],
      ["postgres", "stdio", true],
    ]);
    expect(inventory.commands).toEqual([{ name: "deploy-check", description: "Run the pre-deploy checks for the payments service", file: "commands/deploy-check.md" }]);
    expect(inventory.team).toMatchObject({ commitPrefix: "PAY", reviewers: ["ada", "grace"], labels: ["skills"] });
    expect(inventory.team?.scaffoldVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(inventory.plugin.versionedByCommit).toBe(true);
  });

  it("given a server definition carrying a token in its URL, when the inventory is read, then the server is marked refused and its URL is withheld", async () => {
    // given
    const { ctx, config } = await seeded();
    const repo = config.repos.find((r) => r.id === "platform-skills")!;
    const work = scratch();
    git(["clone", "--quiet", repo.url, work], work);
    writeFileSync(
      join(work, ".mcp.json"),
      JSON.stringify({ mcpServers: { remote: { type: "http", url: "https://mcp.example.com/s/0123456789abcdef0123456789abcdef/sse" } } }),
    );
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "feat(mcp): add remote"], work);
    git(["fetch", "--quiet", work, "main:main"], repo.url.replace("file://", ""));

    // when
    await syncRepo(ctx, "platform-skills");
    const server = (await readInventory(mirrorDir(ctx, "platform-skills"))).mcpServers.find((m) => m.name === "remote")!;

    // then
    expect(server.shareable).toBe(false);
    expect(server.target).toBe("(withheld)");
    expect(JSON.stringify(server)).not.toContain("0123456789abcdef");
  });

  it("given skills whose text holds characters wider than a byte, when the inventory is read, then each description comes back whole and the skills after them are read too", async () => {
    // given
    const { ctx, config } = await seeded();
    const repo = config.repos.find((r) => r.id === "platform-skills")!;
    const work = scratch();
    git(["clone", "--quiet", repo.url, work], work);
    for (const [slug, description] of [["a-cafe", "Use at the café ✓ for the naïve case"], ["b-plain", "Use after the wide one"]]) {
      mkdirSync(join(work, "skills", slug!), { recursive: true });
      writeFileSync(join(work, "skills", slug!, "SKILL.md"), `---\nname: ${slug}\ndescription: ${description}\n---\n\n${"→ step\n".repeat(50)}`);
    }
    git(["add", "-A"], work);
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "wide"], work);
    git(["fetch", "--quiet", work, "main:main"], repo.url.replace("file://", ""));

    // when
    await syncRepo(ctx, "platform-skills");
    const skills = (await readInventory(mirrorDir(ctx, "platform-skills"))).skills;

    // then
    expect(skills.find((s) => s.slug === "a-cafe")!.description).toBe("Use at the café ✓ for the naïve case");
    expect(skills.find((s) => s.slug === "b-plain")!.description).toBe("Use after the wide one");
    expect(skills.find((s) => s.slug === "rotate-service-certificate")!.problem).toBeUndefined();
  });

  it("given a seeded repository, when what a task is given is read blocking and in the background, then both answers are the same and hold the team's skills and servers", async () => {
    // given
    const { ctx } = await seeded();
    const mirror = mirrorDir(ctx, "payments-skills");

    // when
    const [setup, setupAsync, record, recordAsync] = [readTeamSetup(mirror, "HEAD"), await readTeamSetupAsync(mirror, "HEAD"), readTeamRecord(mirror, "HEAD"), await readTeamRecordAsync(mirror, "HEAD")];

    // then
    expect(setupAsync).toEqual(setup);
    expect(recordAsync).toEqual(record);
    expect(setup.skills.map((s) => s.slug)).toEqual(["add-ledger-migration", "release-checklist"]);
    expect(setup.skills[0]!.files.map((f) => f.path)).toEqual(["SKILL.md", "check.sql"]);
    expect(Object.keys(setup.mcpServers).sort()).toEqual(["docs", "postgres"]);
    expect(record).toMatchObject({ commitPrefix: "PAY", reviewers: ["ada", "grace"] });
  });

  it("given a skill folder holding three files of 25 MB, when what a task is given is read, then every file comes back whole", async () => {
    // given
    const { ctx, config } = await seeded();
    const repo = config.repos.find((r) => r.id === "platform-skills")!;
    const work = scratch();
    git(["clone", "--quiet", repo.url, work], work);
    for (const n of [1, 2, 3]) writeFileSync(join(work, "skills", "rotate-service-certificate", `data-${n}.txt`), String(n).repeat(25_000_000));
    git(["add", "-A"], work);
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "large"], work);
    git(["fetch", "--quiet", work, "main:main"], repo.url.replace("file://", ""));
    await syncRepo(ctx, "platform-skills");

    // when
    const setup = await readTeamSetupAsync(mirrorDir(ctx, "platform-skills"), "HEAD");

    // then
    const files = setup.skills.find((s) => s.slug === "rotate-service-certificate")!.files;
    expect(files.filter((f) => f.path.startsWith("data-")).map((f) => [f.path, f.content.length, f.content[0]])).toEqual([
      ["data-1.txt", 25_000_000, "1"],
      ["data-2.txt", 25_000_000, "2"],
      ["data-3.txt", 25_000_000, "3"],
    ]);
    expect(readTeamSetup(mirrorDir(ctx, "platform-skills"), "HEAD").skills.find((s) => s.slug === "rotate-service-certificate")!.files).toHaveLength(files.length);
  });

  it("given a skill file over the orchestrator's limit, when what a task is given is read, then the refusal names that file", async () => {
    // given
    const { ctx, config } = await seeded();
    const repo = config.repos.find((r) => r.id === "platform-skills")!;
    const work = scratch();
    git(["clone", "--quiet", repo.url, work], work);
    writeFileSync(join(work, "skills", "rotate-service-certificate", "huge.bin"), Buffer.alloc(MAX_FILE_BYTES + 1, 7));
    git(["add", "-A"], work);
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "huge"], work);
    git(["fetch", "--quiet", work, "main:main"], repo.url.replace("file://", ""));
    await syncRepo(ctx, "platform-skills");

    // when
    const attempt = readTeamSetupAsync(mirrorDir(ctx, "platform-skills"), "HEAD");

    // then
    await expect(attempt).rejects.toThrow("skills/rotate-service-certificate/huge.bin is 65 MiB; the orchestrator reads files of at most 64 MiB");
    expect((await readInventory(mirrorDir(ctx, "platform-skills"))).skills.map((s) => s.slug)).toContain("rotate-service-certificate");
  });

  it("given an inventory request the caller gave up on, when it is read, then the read stops with the abort", async () => {
    const { ctx } = await seeded();
    const controller = new AbortController();
    controller.abort();
    await expect(readInventory(mirrorDir(ctx, "payments-skills"), "HEAD", controller.signal)).rejects.toThrow(/abort/i);
  });

  it("given a skill directory without a readable frontmatter, when the inventory is read, then the skill is listed with the reason rather than dropped", async () => {
    // given
    const { ctx, config } = await seeded();
    const repo = config.repos.find((r) => r.id === "platform-skills")!;
    const work = scratch();
    git(["clone", "--quiet", repo.url, work], work);
    mkdirSync(join(work, "skills", "half-done"), { recursive: true });
    writeFileSync(join(work, "skills", "half-done", "SKILL.md"), "no frontmatter here\n");
    git(["add", "-A"], work);
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "wip"], work);
    git(["fetch", "--quiet", work, "main:main"], repo.url.replace("file://", ""));

    // when
    await syncRepo(ctx, "platform-skills");
    const skill = (await readInventory(mirrorDir(ctx, "platform-skills"))).skills.find((s) => s.slug === "half-done")!;

    // then
    expect(skill.problem).toBe("SKILL.md has no readable name and description");
  });

  it("given a path, when its history is read, then only the commits touching it come back, newest first", async () => {
    // given
    const { ctx } = await seeded();

    // when
    const history = await readHistory(mirrorDir(ctx, "payments-skills"), "skills/release-checklist");

    // then
    expect(history.map((h) => h.subject)).toEqual(["feat(skill): add release-checklist"]);
  });
});

describe("a team's commands", () => {
  it("given commands in folders and one with no frontmatter, when the inventory is read, then each is named as Claude Code types it and described as the plugin describes it", async () => {
    // given
    const { ctx, config } = await seeded();
    const repo = config.repos[0]!;
    const bare = repo.url.replace("file://", "");
    const work = scratch();
    git(["clone", "--quiet", bare, work], work);
    mkdirSync(join(work, "commands", "git"), { recursive: true });
    writeFileSync(join(work, "commands", "git", "sync.md"), "# Sync\n\nBring the branch up to date with main.\n");
    writeFileSync(join(work, "commands", "sync.md"), "---\ndescription: Sync the docs\n---\n\nRun it.\n");
    git(["add", "-A"], work);
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "feat(command): add sync commands"], work);
    git(["fetch", "--quiet", work, "main:main"], bare);
    await syncRepo(ctx, repo.id);

    // when
    const inventory = await readInventory(mirrorDir(ctx, repo.id));

    // then
    expect(inventory.commands).toEqual([
      { name: "deploy-check", description: "Run the pre-deploy checks for the payments service", file: "commands/deploy-check.md" },
      { name: "git:sync", description: "Bring the branch up to date with main.", file: "commands/git/sync.md" },
      { name: "sync", description: "Sync the docs", file: "commands/sync.md" },
    ]);
  });
});

describe("syncing", () => {
  it("given a URL carrying a credential that cannot be cloned, when it is synced, then the error kept and shown masks the credential", async () => {
    // given
    const root = scratch();
    const store = openSqliteStore(":memory:");
    const ctx: OrchestratorContext = { store, dataDir: join(root, "data"), tenant: "t" };
    await store.upsertRepo({ tenant: "t", id: "broken", team: "X", name: "broken", url: "https://user:s3cr3t-token@127.0.0.1:9/team.git" });

    // when
    const result = await syncRepo(ctx, "broken");

    // then
    expect("error" in result && result.error).toBeTruthy();
    expect((await store.getRepo("t", "broken"))!.error).not.toContain("s3cr3t-token");
  });

  it("given git stderr naming a URL with a password, when it is summarised, then the password is replaced", async () => {
    expect(syncError({ stderr: "fatal: unable to access 'https://bob:hunter2@host/x.git/': refused\n" })).toBe(
      "fatal: unable to access 'https://***@host/x.git/': refused",
    );
  });

  it("given an existing mirror, when the repository moves on, then a second sync fetches the new head", async () => {
    // given
    const { ctx, config } = await seeded();
    const repo = config.repos[0]!;
    const work = scratch();
    git(["clone", "--quiet", repo.url, work], work);
    writeFileSync(join(work, "NOTES.md"), "x\n");
    git(["add", "-A"], work);
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "docs: notes"], work);
    git(["fetch", "--quiet", work, "main:main"], repo.url.replace("file://", ""));

    // when
    const head = await syncMirror(repo.url, mirrorDir(ctx, repo.id));

    // then
    expect(head).toBe(git(["rev-parse", "HEAD"], work).trim());
  });
});

describe("a repository whose address changes", () => {
  it("given a mirror cloned from one address, when the configuration gives another, with a token and then without, then the newest address is fetched and the token leaves the mirror's git config", async () => {
    // given
    const { ctx, config } = await seeded();
    const [payments, platform] = config.repos;
    const mirror = mirrorDir(ctx, payments!.id);
    const withToken = "https://ada:s3cr3t-rotated-out@127.0.0.1:9/payments.git";

    // when
    const unreachable = await syncMirror(withToken, mirror).then(() => null, (err: Error) => syncError(err));
    const head = await syncMirror(platform!.url, mirror);

    // then
    expect(unreachable).not.toBeNull();
    expect(unreachable).not.toContain("s3cr3t-rotated-out");
    expect(head).toBe(git(["rev-parse", "HEAD"], platform!.url.replace("file://", "")).trim());
    expect(readFileSync(join(mirror, "config"), "utf8")).not.toContain("s3cr3t-rotated-out");
  });
});

describe("syncing every repository at a start", () => {
  it("given more repositories than syncs at once and one that cannot be read, when the start syncs them, then no more run together than allowed and every other one is read", async () => {
    // given
    const root = scratch();
    const { configFile } = seed(join(root, "demo"));
    const { repos } = JSON.parse(readFileSync(configFile, "utf8")) as { repos: { id: string; team: string; name: string; url: string }[] };
    const store = openSqliteStore(":memory:");
    const ctx: OrchestratorContext = { store, dataDir: join(root, "data"), tenant: "t" };
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = `copy-${i}`;
      ids.push(id);
      await store.upsertRepo({ tenant: "t", id, team: "X", name: id, url: i === 3 ? `file://${join(root, "missing.git")}` : repos[i % repos.length]!.url });
    }
    let running = 0;
    let most = 0;
    const counted: typeof syncRepo = async (c, id) => {
      most = Math.max(most, ++running);
      try {
        return await syncRepo(c, id);
      } finally {
        running--;
      }
    };

    // when
    await syncRepos(ctx, ids, undefined, 2, counted);

    // then
    expect(most).toBe(2);
    const records = await store.listRepos("t");
    expect(records.filter((r) => r.head).map((r) => r.id).sort()).toEqual(ids.filter((id) => id !== "copy-3"));
    expect(records.find((r) => r.id === "copy-3")!.error).toBeTruthy();
  });

  it("given a sync that throws, such as a store that cannot record it, when the start syncs, then the others are still synced", async () => {
    // given
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: scratch(), tenant: "t" };
    const done: string[] = [];
    const sync: typeof syncRepo = async (_c, id) => {
      if (id === "b") throw new Error("the store is gone");
      done.push(id);
      return { head: id };
    };

    // when
    const all = syncRepos(ctx, ["a", "b", "c", "d"], undefined, 1, sync);

    // then
    await expect(all).resolves.toBeUndefined();
    expect(done).toEqual(["a", "c", "d"]);
  });

  it("given a stop asked for while the start syncs, when it is asked, then the syncs under way finish and no further one begins", async () => {
    // given
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: scratch(), tenant: "t" };
    const stop = new AbortController();
    const began: string[] = [];
    const ids = ["a", "b", "c", "d", "e"];
    const sync: typeof syncRepo = async (_c, id) => {
      began.push(id);
      if (id === "b") stop.abort();
      return { head: id };
    };

    // when
    await syncRepos(ctx, ids, stop.signal, 2, sync);

    // then
    expect(began).toEqual(["a", "b"]);
  });
});

describe("the HTTP surface", () => {
  it("given a seeded orchestrator, when the API is called, then repositories and inventory are served and unknown ids are refused", async () => {
    // given
    const { ctx } = await seeded();
    const app = createApp(ctx);

    // when
    const repos = await (await app.request("/api/repos")).json();
    const inventory = await app.request("/api/repos/payments-skills/inventory");
    const unknown = await app.request("/api/repos/nope/inventory");
    const traversal = await app.request("/api/repos/payments-skills/history?path=../../etc");

    // then
    expect(repos.repos.map((r: { id: string }) => r.id)).toEqual(["payments-skills", "platform-skills"]);
    expect(inventory.status).toBe(200);
    expect(unknown.status).toBe(404);
    expect(traversal.status).toBe(400);
  });

  it("given an address for teammates in the configuration, when the inventory is read, then its join message names that address and not the one the orchestrator fetches from", async () => {
    // given
    const { ctx } = await seeded();
    const member = "https://git.example.invalid/acme/payments-skills.git";
    const app = createApp({ ...ctx, memberUrls: new Map([["payments-skills", member]]) });

    // when
    const { repo, join } = await (await app.request("/api/repos/payments-skills/inventory")).json();

    // then
    expect(join.use[0]).toBe(`/plugin marketplace add ${member}`);
    expect(join.contribute).toBe(`/handbook:join ${member}`);
    expect(JSON.stringify(join)).not.toContain(repo.url);
  });

  it("given an orchestrator that runs tasks, when the inventory is read, then each server says whether a task gets it by the task runner's own rule, and a refused server's secret is nowhere in the answer", async () => {
    // given
    const { ctx, root, config } = await seeded();
    const bare = config.repos.find((r) => r.id === "payments-skills")!.url.replace("file://", "");
    const work = mkdtempSync(join(root, "teammate-"));
    git(["clone", "--quiet", bare, work], work);
    const servers = {
      postgres: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "${PAYMENTS_DB_URL}"] },
      docs: { type: "http", url: "https://docs.example.com/mcp" },
      billing: { command: "billing-mcp", env: { BILLING_TOKEN: "hand-written-literal-value" } },
    };
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "chore: servers"], work);
    git(["fetch", "--quiet", work, "main:main"], bare);
    await syncRepo(ctx, "payments-skills");
    let given: Record<string, unknown> | null = null;
    const agent = { label: "Claude Code", placesMcp: true };
    const tasks = {
      codeTarget: () => null,
      mcpInTasks: (_repo: unknown, read: Record<string, unknown>) => {
        given = read;
        return mcpInTasks([agent], [{ server: "postgres", tool: "query" }, { server: "docs", tool: "search" }], read);
      },
    } as unknown as TaskRunner;

    // when
    const body = await (await createApp({ ...ctx, tasks }).request("/api/repos/payments-skills/inventory")).text();
    const plain = await (await createApp(ctx).request("/api/repos/payments-skills/inventory")).json();

    // then
    expect(given).toEqual(servers);
    const inTasks = Object.fromEntries(JSON.parse(body).inventory.mcpServers.map((m: { name: string; inTasks?: unknown }) => [m.name, m.inTasks]));
    expect(inTasks.postgres).toEqual({ usable: true, detail: "query for Claude Code", signIn: false });
    expect(inTasks.docs).toMatchObject({ usable: true, signIn: true, detail: expect.stringContaining("nobody is there to finish one in a browser") });
    expect(inTasks.billing).toMatchObject({ usable: false, signIn: false, detail: expect.stringContaining("env.BILLING_TOKEN holds a literal value") });
    expect(body).not.toContain("hand-written-literal-value");
    expect(plain.inventory.mcpServers.some((m: { inTasks?: unknown }) => m.inTasks)).toBe(false);
  });

  it("given more requests than a page holds, when the next page is asked for with the cursor handed out and with one made up, then the first continues the list and the second is refused", async () => {
    // given
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: scratch(), tenant: "t" };
    for (let n = 1; n <= 51; n++) {
      await ctx.store.saveRequest({ tenant: "t", repoId: "payments-skills", number: n, provider: "local", url: `local://requests/payments-skills/${n}`, branch: `b${n}`, headSha: "a".repeat(40), title: "t", status: "open", createdAt: new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString(), createdBy: "x" });
    }
    const app = createApp(ctx);
    const first = await (await app.request("/api/requests")).json();

    // when
    const second = await (await app.request(`/api/requests?after=${first.next}`)).json();
    const madeUp = await app.request(`/api/requests?after=${Buffer.from(JSON.stringify({ createdAt: "x", repoId: "../etc", number: 1 })).toString("base64url")}`);

    // then
    expect(first.requests).toHaveLength(50);
    expect(second.requests.map((r: { number: number }) => r.number)).toEqual([1]);
    expect(second.next).toBeNull();
    expect(madeUp.status).toBe(400);
  });
});

describe("sign-in", () => {
  it("given no sign-in configured, when the API is called, then it refuses and only the health check answers", async () => {
    // given
    const { ctx } = await seeded();
    const saved = process.env.ORCHESTRATOR_AUTH;
    delete process.env.ORCHESTRATOR_AUTH;
    try {
      const app = createApp(ctx);

      // when
      const repos = await app.request("/api/repos");
      const health = await app.request("/api/health");

      // then
      expect(repos.status).toBe(401);
      expect(health.status).toBe(200);
    } finally {
      process.env.ORCHESTRATOR_AUTH = saved;
    }
  });
});

describe("a mirror and the branches the orchestrator moved aside", () => {
  it("given moved-aside refs in a team repository, when it is cloned and synced, and an older mirror already holds some, then no mirror keeps any", async () => {
    // given
    const { ctx, config } = await seeded();
    const repo = config.repos.find((r) => r.id === "payments-skills")!;
    const bare = repo.url.replace("file://", "");
    const head = git(["rev-parse", "main"], bare).trim();
    git(["update-ref", "refs/orchestrator/orphaned/t1/heads/handbook/orchestrator-x", head], bare);
    const fresh = join(scratch(), "fresh.git");

    // when
    await syncMirror(repo.url, fresh);
    const unique = git(["commit-tree", `${head}^{tree}`, "-p", head, "-m", "moved aside after the clone"], bare).trim();
    git(["update-ref", "refs/orchestrator/orphaned/t2/heads/handbook/orchestrator-y", unique], bare);
    await syncMirror(repo.url, fresh);
    const older = mirrorDir(ctx, "payments-skills");
    git(["update-ref", "refs/orchestrator/orphaned/t0/heads/handbook/orchestrator-old", head], older);
    await syncMirror(repo.url, older);

    // then
    expect(git(["for-each-ref", "refs/orchestrator/"], fresh).trim()).toBe("");
    expect(git(["for-each-ref", "refs/orchestrator/"], older).trim()).toBe("");
    expect(git(["rev-parse", "HEAD"], fresh).trim()).toBe(head);
    expect(gitMaybe(["cat-file", "-e", unique], fresh)).toBeNull();
    expect(git(["for-each-ref", "refs/orchestrator/"], bare).trim().split("\n")).toHaveLength(2);
  });
});

describe("errors and the log", () => {
  it("given a read the browser gave up on and a real fault, when each reaches the orchestrator, then only the fault is logged", async () => {
    // given
    const { ctx } = await seeded();
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args[0]);
    const gone = new AbortController();
    gone.abort();
    const broken = { ...ctx, store: { ...ctx.store, listRepos: async () => Promise.reject(new Error("the database is gone")) } };

    // when
    let abandoned: Response;
    let fault: Response;
    try {
      abandoned = await createApp(ctx).request("/api/repos/payments-skills/inventory", { signal: gone.signal });
      fault = await createApp(broken).request("/api/repos");
    } finally {
      console.error = original;
    }

    // then
    expect(abandoned.status).toBe(499);
    expect(fault.status).toBe(500);
    expect(logged.map((e) => (e as Error).message)).toEqual(["the database is gone"]);
  });
});

describe("a repository URL that carries a credential", () => {
  const TOKEN = "glpat-UrlSecret0123456789abc";
  const users: Principal[] = [
    { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] },
    { id: "m", name: "Max Example", email: "max@example.invalid", role: "member", ownedTeams: [] },
  ];
  const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
    c.set("user", user);
    c.set("csrf", "t");
    await next();
  };

  it.each(users.map((u) => [u.role, u] as const))("given a URL with a token and a failed sync quoting it, when %s reads the repositories and an inventory, then the token appears nowhere and the stored URL stays whole", async (_role, user) => {
    // given
    const { ctx } = await seeded();
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    await ctx.store.upsertRepo({ ...repo, url: `https://oauth2:${TOKEN}@git.example.invalid/acme/payments-skills.git` });
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "broken", team: "Payments", name: "broken", url: `https://oauth2:${TOKEN}@127.0.0.1:9/x.git` });
    await ctx.store.recordSync(ctx.tenant, "broken", { error: `fatal: unable to access 'https://oauth2:${TOKEN}@127.0.0.1:9/x.git/'` });
    const app = createApp(ctx, as(user));

    // when
    const bodies = await Promise.all(
      ["/api/repos", "/api/repos/payments-skills/inventory", "/api/repos/broken/inventory"].map(async (path) => (await app.request(path)).text()),
    );

    // then
    for (const body of bodies) expect(body).not.toContain(TOKEN);
    expect(JSON.parse(bodies[1]!).join).toEqual({ problem: expect.stringContaining("Set memberUrl") });
    expect(JSON.parse(bodies[1]!).refresh).toEqual({ problem: expect.stringContaining("runs no tasks") });
    expect(bodies[0]).toContain("https://***@git.example.invalid/acme/payments-skills.git");
    expect(JSON.parse(bodies[1]!).repo.url).toBe("https://***@git.example.invalid/acme/payments-skills.git");
    expect((await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.url).toContain(TOKEN);
  });

  it("given URLs in text, when they are masked, then the user and password go and the rest stays", () => {
    expect(maskUrl("https://u:p@host/x and ssh://git@host/y and https://host/z")).toBe("https://***@host/x and ssh://***@host/y and https://host/z");
  });
});

describe("requests of a team kept to its own people", () => {
  it("given a team kept to its own people, when someone outside it lists requests and reads a description, then they see only what other teams opened and what they opened themselves, and the team's own request is unknown to them, while its opener reads it", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const ctx: OrchestratorContext = { store, dataDir: scratch(), tenant: "acme" };
    for (const [id, team] of [["payments-skills", "Payments"], ["platform-skills", "Platform"]] as const) await store.upsertRepo({ tenant: "acme", id, team, name: id, url: `https://gitlab.example.invalid/acme/${id}.git` });
    const request = (repoId: string, number: number, createdBy: string, createdAt: string) => store.saveRequest({ tenant: "acme", repoId, number, provider: "gitlab", url: `https://gitlab.example.invalid/acme/${repoId}/-/merge_requests/${number}`, branch: `handbook/change-${number}`, headSha: "a".repeat(40), title: `change ${number}`, status: "open", createdAt, createdBy });
    await request("payments-skills", 1, "pat@example.invalid", "2026-11-03T10:00:00.000Z");
    await request("platform-skills", 2, "lee@example.invalid", "2026-11-03T10:01:00.000Z");
    await request("payments-skills", 3, "max@example.invalid", "2026-11-03T10:02:00.000Z");
    const as = (email: string) => createApp(ctx, async (c, next) => {
      c.set("user", { id: email, name: email, email, role: "member", ownedTeams: [], restrictedTeams: ["Payments"] });
      await next();
    });

    // when
    const listed = await (await as("max@example.invalid").request("/api/requests")).json();
    const outside = await as("max@example.invalid").request("/api/repos/payments-skills/requests/1/description");
    const opener = await as("pat@example.invalid").request("/api/repos/payments-skills/requests/1/description");

    // then
    expect(listed.requests.map((r: { number: number }) => r.number)).toEqual([3, 2]);
    expect(listed.total).toBe(2);
    expect([outside.status, (await outside.json()).error]).toEqual([404, "unknown request"]);
    expect(opener.status).toBe(200);
  });
});
