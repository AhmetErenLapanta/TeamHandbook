import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../demo/seed.js";
import { createApp, mirrorDir, syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { localRepoPath } from "./forge/local.js";
import { git } from "./git.js";
import { teamFileWithUsage } from "./propose.js";
import { openSqliteStore } from "./store.js";
import { ensureIngestId, hourWithinWindow, ingestUrl, MAX_EVENTS, parseBatch, rateLimiter, usageAddressFinding } from "./usage.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const MEMBER: Principal = { id: "m", name: "Max Example", email: "max@example.invalid", role: "member", ownedTeams: [] };

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    await next();
  };
}

async function seeded(): Promise<OrchestratorContext> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-usage-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant, publicUrl: "https://orchestrator.example.com" };
  for (const repo of config.repos) {
    await ctx.store.upsertRepo({ ...repo, tenant: config.tenant });
    await syncRepo(ctx, repo.id);
  }
  return ctx;
}

function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return app.request(path, { method: "POST", body: text, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } });
}

/** Counts the git processes the orchestrator starts from now on, through a stand-in first on PATH that runs the real one. */
function gitCounter(): { calls: () => number; stop: () => void } {
  const bin = mkdtempSync(join(tmpdir(), "orchestrator-git-count-"));
  dirs.push(bin);
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

/** Gives the repository's plugin a version line on its default branch, the way a team's own commit would, and syncs. */
async function versioned(ctx: OrchestratorContext, bare: string, version: string): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "orchestrator-usage-version-"));
  dirs.push(work);
  git(["clone", "--quiet", bare, work], work);
  const file = join(work, ".claude-plugin", "plugin.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), version }, null, 2) + "\n");
  git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", `chore: version ${version}`], work);
  git(["fetch", "--quiet", work, "main:main"], bare);
  await syncRepo(ctx, "payments-skills");
}

const HOUR_NOW = new Date().toISOString().slice(0, 13);
const HOUR_BEFORE = new Date(Date.now() - 3_600_000).toISOString().slice(0, 13);

describe("receiving skill-use counts", () => {
  it("given a tenant's ingest id and skills the repository ships, when a batch arrives, then the counts are kept per skill and hour with nothing else", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const ingest = await ensureIngestId(ctx.store, ctx.tenant, "payments-skills");

    // when
    const res = await post(app, `/ingest/usage/${ingest}/payments-skills`, {
      events: [
        { skill: "release-checklist", hour: HOUR_BEFORE },
        { skill: "release-checklist", hour: HOUR_BEFORE },
        { skill: "add-ledger-migration", hour: HOUR_NOW },
      ],
    });

    // then
    expect(res.status).toBe(200);
    expect(await ctx.store.usage(ctx.tenant, "2000-01-01T00")).toEqual([
      { repoId: "payments-skills", skill: "release-checklist", count: 2, lastHour: HOUR_BEFORE },
      { repoId: "payments-skills", skill: "add-ledger-migration", count: 1, lastHour: HOUR_NOW },
    ]);
  });

  it.each([
    ["a skill the repository does not ship", (i: string) => [`/ingest/usage/${i}/payments-skills`, { events: [{ skill: "my-private-skill", hour: HOUR_BEFORE }] }]],
    ["an unknown ingest id", () => [`/ingest/usage/${"x".repeat(32)}/payments-skills`, { events: [{ skill: "release-checklist", hour: HOUR_BEFORE }] }]],
    ["an unknown repository", (i: string) => [`/ingest/usage/${i}/nope`, { events: [{ skill: "release-checklist", hour: HOUR_BEFORE }] }]],
    ["a time finer than the hour", (i: string) => [`/ingest/usage/${i}/payments-skills`, { events: [{ skill: "release-checklist", hour: `${HOUR_NOW}:14` }] }]],
    ["a body that is not JSON", (i: string) => [`/ingest/usage/${i}/payments-skills`, "not json"]],
    ["one bad event among good ones", (i: string) => [`/ingest/usage/${i}/payments-skills`, { events: [{ skill: "release-checklist", hour: HOUR_BEFORE }, { skill: 3, hour: "x" }] }]],
  ])("given %s, when it arrives, then the whole batch is refused and nothing is counted", async (_label, build) => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const [path, body] = build(await ensureIngestId(ctx.store, ctx.tenant, "payments-skills")) as [string, unknown];

    // when
    const res = await post(app, path, body);

    // then
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "refused" });
    expect(await ctx.store.usage(ctx.tenant, "2000-01-01T00")).toEqual([]);
  });

  it("given batches arriving one after another at one head, when they are checked, then the repository's tree is read once, not for every batch", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const ingest = await ensureIngestId(ctx.store, ctx.tenant, "payments-skills");
    const batch = { events: [{ skill: "release-checklist", hour: HOUR_NOW }] };
    expect((await post(app, `/ingest/usage/${ingest}/payments-skills`, batch)).status).toBe(200);
    const counted = gitCounter();

    // when
    const statuses: number[] = [];
    try {
      for (let i = 0; i < 10; i++) statuses.push((await post(app, `/ingest/usage/${ingest}/payments-skills`, batch)).status);
    } finally {
      counted.stop();
    }

    // then
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(counted.calls()).toBe(0);
    expect((await ctx.store.usage(ctx.tenant, "2000-01-01T00"))[0]!.count).toBe(11);
  });

  it("given a skill merged after the last batch, when the repository syncs, then the skill is counted, and not before the sync", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const ingest = await ensureIngestId(ctx.store, ctx.tenant, "payments-skills");
    expect((await post(app, `/ingest/usage/${ingest}/payments-skills`, { events: [{ skill: "release-checklist", hour: HOUR_NOW }] })).status).toBe(200);
    const bare = localRepoPath((await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.url)!;
    const work = mkdtempSync(join(tmpdir(), "orchestrator-usage-work-"));
    dirs.push(work);
    git(["clone", "--quiet", bare, work], work);
    mkdirSync(join(work, "skills", "on-call-handover"), { recursive: true });
    writeFileSync(join(work, "skills", "on-call-handover", "SKILL.md"), "---\nname: on-call-handover\ndescription: Use at shift change.\n---\n\nHand over.\n");
    git(["add", "-A"], work);
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "feat(skill): add on-call-handover"], work);
    git(["fetch", "--quiet", work, "main:main"], bare);
    const handover = { events: [{ skill: "on-call-handover", hour: HOUR_NOW }] };
    const beforeSync = (await post(app, `/ingest/usage/${ingest}/payments-skills`, handover)).status;

    // when
    await syncRepo(ctx, "payments-skills");
    const afterSync = (await post(app, `/ingest/usage/${ingest}/payments-skills`, handover)).status;

    // then
    expect(beforeSync).toBe(400);
    expect(afterSync).toBe(200);
  });

  it("given another tenant's id on a database the two share, when it is sent to this tenant's orchestrator, then it is refused like an unknown id and counts nothing", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const theirs = "g".repeat(32);
    await ctx.store.upsertRepo({ tenant: "globex", id: "payments-skills", team: "Payments", name: "payments-skills", url: "file:///elsewhere.git" });
    await ctx.store.setIngestId("globex", "payments-skills", theirs);

    // when
    const res = await post(app, `/ingest/usage/${theirs}/payments-skills`, { events: [{ skill: "release-checklist", hour: HOUR_NOW }] });

    // then
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(JSON.stringify({ error: "refused" }));
    expect(await ctx.store.usage("globex", "2000-01-01T00")).toEqual([]);
    expect(await ctx.store.usage(ctx.tenant, "2000-01-01T00")).toEqual([]);
  });

  it("given this orchestrator's copy of the repository gone, when a batch arrives, then it is refused like any other and names no folder", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const ingest = await ensureIngestId(ctx.store, ctx.tenant, "payments-skills");
    rmSync(mirrorDir(ctx, "payments-skills"), { recursive: true, force: true });

    // when
    const res = await post(app, `/ingest/usage/${ingest}/payments-skills`, { events: [{ skill: "release-checklist", hour: HOUR_NOW }] });

    // then
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(JSON.stringify({ error: "refused" }));
  });

  it("given another repository's id, when it writes to this one, then it is refused", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const payments = await ensureIngestId(ctx.store, ctx.tenant, "payments-skills");

    // when
    const res = await post(app, `/ingest/usage/${payments}/platform-skills`, { events: [{ skill: "rotate-service-certificate", hour: HOUR_NOW }] });

    // then
    expect(res.status).toBe(400);
    expect(await ctx.store.usage(ctx.tenant, "2000-01-01T00")).toEqual([]);
  });

  it("given a flood of made-up ids, when a real id reports, then it is still accepted", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const real = await ensureIngestId(ctx.store, ctx.tenant, "payments-skills");
    for (let i = 0; i < 200; i++) await post(app, `/ingest/usage/${String(i).padStart(32, "x")}/payments-skills`, { events: [{ skill: "release-checklist", hour: HOUR_NOW }] });

    // when
    const res = await post(app, `/ingest/usage/${real}/payments-skills`, { events: [{ skill: "release-checklist", hour: HOUR_NOW }] });

    // then
    expect(res.status).toBe(200);
  });

  it("given hours shaped right but out of reach, when they are checked, then only a real hour within the last month or the next hour passes", () => {
    const now = Date.parse("2026-10-23T12:30:00Z");
    expect(hourWithinWindow("2026-10-23T12", now)).toBe(true);
    expect(hourWithinWindow("2026-10-23T13", now)).toBe(true);
    expect(hourWithinWindow("2026-10-23T14", now)).toBe(false);
    expect(hourWithinWindow("2026-09-01T12", now)).toBe(false);
    expect(hourWithinWindow("9999-12-31T23", now)).toBe(false);
    expect(hourWithinWindow("2026-99-99T99", now)).toBe(false);
    expect(hourWithinWindow("2026-02-30T10", now)).toBe(false);
  });

  it("given more events than a batch may carry, when they are parsed, then the batch is refused", () => {
    const events = Array.from({ length: MAX_EVENTS + 1 }, () => ({ skill: "s", hour: HOUR_BEFORE }));
    expect(parseBatch({ events })).toBe("too many events");
  });

  it("given a body over the size limit, when it arrives, then it is refused before it is read", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const ingest = await ensureIngestId(ctx.store, ctx.tenant, "payments-skills");

    // when
    const res = await post(app, `/ingest/usage/${ingest}/payments-skills`, JSON.stringify({ events: [], pad: "x".repeat(70_000) }));

    // then
    expect(res.status).toBe(400);
  });

  it("given a limit per minute, when one id goes past it, then that id is held back while another is not", async () => {
    let t = 0;
    const allow = rateLimiter(2, () => t);
    expect([allow("a"), allow("a"), allow("a"), allow("b")]).toEqual([true, true, false, true]);
    t = 61_000;
    expect(allow("a")).toBe(true);
  });

  it("given keys typed by callers, when more arrive than the limiter keeps, then a new one is still counted and the one idle longest makes room", () => {
    // given
    let t = 0;
    const allow = rateLimiter(1, () => t, 2);
    allow("a");
    t = 1;
    allow("b");
    t = 2;
    allow("b");

    // when
    const newcomer = allow("c");

    // then
    expect(newcomer).toBe(true);
    expect(allow("b")).toBe(false);
    expect(allow("a")).toBe(true);
  });

  it("given the receiver, when it is called without signing in, then it answers, while the rest of the API still refuses", async () => {
    // given
    const ctx = await seeded();
    const saved = process.env.ORCHESTRATOR_AUTH;
    delete process.env.ORCHESTRATOR_AUTH;
    try {
      const app = createApp(ctx);
      const ingest = await ensureIngestId(ctx.store, ctx.tenant, "payments-skills");

      // when
      const ingestRes = await post(app, `/ingest/usage/${ingest}/payments-skills`, { events: [{ skill: "release-checklist", hour: HOUR_BEFORE }] });
      const apiRes = await app.request("/api/usage");

      // then
      expect(ingestRes.status).toBe(200);
      expect(apiRes.status).toBe(401);
    } finally {
      if (saved === undefined) delete process.env.ORCHESTRATOR_AUTH;
      else process.env.ORCHESTRATOR_AUTH = saved;
    }
  });
});

describe("asking a team to report", () => {
  it("given an admin, when usage reporting is proposed for a repository, then a request adds usage.endpoint and keeps every other key, and the default branch does not move", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const bare = localRepoPath((await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.url)!;
    const before = git(["rev-parse", "main"], bare).trim();

    // when
    const proposal = (await (await post(app, "/api/repos/payments-skills/usage/proposal", {})).json()).proposal;
    const res = await post(app, "/api/repos/payments-skills/usage/propose", { baseSha: before, message: "chore: ask the payments team to report skill use" });
    const { request } = await res.json();

    // then
    expect(res.status).toBe(200);
    expect(request).toMatchObject({ number: 1, status: "open", provider: "local", createdBy: "ada@example.invalid" });
    expect(git(["rev-parse", "main"], bare).trim()).toBe(before);
    const proposed = JSON.parse(git(["show", `${request.branch}:.teamhandbook.json`], bare));
    expect(proposed).toMatchObject({ commitPrefix: "PAY", reviewers: ["ada", "grace"], labels: ["skills"] });
    expect(proposed.usage.endpoint).toMatch(/^https:\/\/orchestrator\.example\.com\/ingest\/usage\/[A-Za-z0-9_-]{32}\/payments-skills$/);
    expect(git(["log", "-1", "--format=%an", request.branch], bare).trim()).toBe("Ada Example");
    expect(proposal).toBe("PAY chore: ask teammates' TeamHandbook to report skill-use counts");
    expect(git(["log", "-1", "--format=%s", request.branch], bare).trim()).toBe("PAY chore: ask the payments team to report skill use");
  });

  it("given no commit message, when usage reporting is proposed, then it is refused with the proposed message and no branch appears", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const bare = localRepoPath((await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.url)!;

    // when
    const res = await post(app, "/api/repos/payments-skills/usage/propose", { baseSha: git(["rev-parse", "main"], bare).trim() });

    // then
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(`write the commit message; the orchestrator proposes "chore: ask teammates' TeamHandbook to report skill-use counts"`);
    expect(git(["for-each-ref", "--format=%(refname)", "refs/heads"], bare).trim()).toBe("refs/heads/main");
  });

  it("given a repository whose plugin carries a version, when usage reporting is proposed, then the request raises the version so teammates fetch the endpoint", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const bare = localRepoPath((await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.url)!;
    await versioned(ctx, bare, "0.1.5");

    // when
    const res = await post(app, "/api/repos/payments-skills/usage/propose", { baseSha: git(["rev-parse", "main"], bare).trim(), message: "chore: ask teammates to report skill use" });
    const { request } = await res.json();

    // then
    expect(res.status).toBe(200);
    expect(JSON.parse(git(["show", `${request.branch}:.claude-plugin/plugin.json`], bare)).version).toBe("0.1.6");
    expect(git(["notes", "--ref", `refs/notes/orchestrator/${request.branch}`, "show", request.branch], bare)).toContain("Raises the plugin to version 0.1.6");
  });

  it("given a member, when they propose usage reporting, then it is refused and no branch appears", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(MEMBER));
    const bare = localRepoPath((await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.url)!;

    // when
    const res = await post(app, "/api/repos/payments-skills/usage/propose", { baseSha: git(["rev-parse", "main"], bare).trim(), message: "chore: ask" });

    // then
    expect(res.status).toBe(403);
    expect(git(["for-each-ref", "--format=%(refname)", "refs/heads"], bare).trim()).toBe("refs/heads/main");
  });

  it("given a team file that is not an object, when the usage key is added, then it is refused rather than overwritten", async () => {
    expect(() => teamFileWithUsage("[]", "https://x")).toThrow(/not a JSON object/);
  });
});

/** Merges a team file that asks for skill use at `endpoint` onto the default branch, the way a merged request leaves it, and syncs. */
async function reporting(ctx: OrchestratorContext, endpoint: string): Promise<string> {
  const bare = localRepoPath((await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.url)!;
  const work = mkdtempSync(join(tmpdir(), "orchestrator-usage-asked-"));
  dirs.push(work);
  git(["clone", "--quiet", bare, work], work);
  const file = join(work, ".teamhandbook.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), usage: { endpoint } }, null, 2) + "\n");
  git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "chore: ask for skill use"], work);
  git(["fetch", "--quiet", work, "main:main"], bare);
  await syncRepo(ctx, "payments-skills");
  return bare;
}

describe("managing a team's usage report", () => {
  const send = (app: ReturnType<typeof createApp>, ingest: string) => post(app, `/ingest/usage/${ingest}/payments-skills`, { events: [{ skill: "release-checklist", hour: HOUR_NOW }] });

  it("given a team reporting to this orchestrator, when a new address is asked for, then the request carries a new id, every other key is kept, the old id is refused at once and the new one counts", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const old = await ensureIngestId(ctx.store, ctx.tenant, "payments-skills");
    const bare = await reporting(ctx, ingestUrl(ctx.publicUrl!, old, "payments-skills"));

    // when
    const proposal = (await (await post(app, "/api/repos/payments-skills/usage/proposal", { action: "rotate" })).json()).proposal;
    const res = await post(app, "/api/repos/payments-skills/usage/propose", { action: "rotate", baseSha: git(["rev-parse", "main"], bare).trim(), message: "chore: new usage address" });
    const { request } = await res.json();

    // then
    expect(res.status).toBe(200);
    expect(proposal).toBe("PAY chore: give teammates' TeamHandbook a new address for skill-use counts");
    const proposed = JSON.parse(git(["show", `${request.branch}:.teamhandbook.json`], bare));
    const current = (await ctx.store.ingestId(ctx.tenant, "payments-skills"))!;
    expect(current).not.toBe(old);
    expect(proposed).toMatchObject({ commitPrefix: "PAY", reviewers: ["ada", "grace"], usage: { endpoint: ingestUrl(ctx.publicUrl!, current, "payments-skills") } });
    expect(git(["notes", "--ref", `refs/notes/orchestrator/${request.branch}`, "show", request.branch], bare)).toContain("asks them again before it sends anything to the new one");
    expect((await send(app, old)).status).toBe(400);
    expect((await send(app, current)).status).toBe(200);
  });

  it("given a new address asked for without a commit message, when it is refused, then no new id is issued and the address teammates use keeps counting", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const old = await ensureIngestId(ctx.store, ctx.tenant, "payments-skills");
    const bare = await reporting(ctx, ingestUrl(ctx.publicUrl!, old, "payments-skills"));

    // when
    const res = await post(app, "/api/repos/payments-skills/usage/propose", { action: "rotate", baseSha: git(["rev-parse", "main"], bare).trim() });

    // then
    expect(res.status).toBe(400);
    expect(await ctx.store.ingestId(ctx.tenant, "payments-skills")).toBe(old);
    expect((await send(app, old)).status).toBe(200);
  });

  it("given a team reporting and an orchestrator without a public address, when the team is asked to stop, then the request takes usage out, keeps every other key, and the address stops counting at once", async () => {
    // given
    const ctx = await seeded();
    const old = await ensureIngestId(ctx.store, ctx.tenant, "payments-skills");
    const bare = await reporting(ctx, ingestUrl(ctx.publicUrl!, old, "payments-skills"));
    const app = createApp({ ...ctx, publicUrl: undefined }, as(ADMIN));
    expect((await send(app, old)).status).toBe(200);

    // when
    const res = await post(app, "/api/repos/payments-skills/usage/propose", { action: "stop", baseSha: git(["rev-parse", "main"], bare).trim(), message: "chore: stop skill-use counts" });
    const { request } = await res.json();

    // then
    expect(res.status).toBe(200);
    const proposed = JSON.parse(git(["show", `${request.branch}:.teamhandbook.json`], bare));
    expect(proposed).not.toHaveProperty("usage");
    expect(proposed).toMatchObject({ commitPrefix: "PAY", reviewers: ["ada", "grace"], labels: ["skills"] });
    expect((await send(app, old)).status).toBe(400);
    expect(await ctx.store.ingestId(ctx.tenant, "payments-skills")).toBeNull();
  });

  it.each([
    ["a new address", "rotate", 409, "this team is not asked to report skill use"],
    ["a stop", "stop", 409, "this team is not asked to report skill use"],
    ["something else", "pause", 400, "a usage request asks, gives a new address, or stops"],
  ])("given a team not asked to report, when %s is asked for, then it is refused and no branch appears", async (_label, action, status, error) => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const bare = localRepoPath((await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.url)!;

    // when
    const res = await post(app, "/api/repos/payments-skills/usage/propose", { action, baseSha: git(["rev-parse", "main"], bare).trim(), message: "chore: x" });

    // then
    expect([res.status, (await res.json()).error]).toEqual([status, error]);
    expect(git(["for-each-ref", "--format=%(refname)", "refs/heads"], bare).trim()).toBe("refs/heads/main");
  });

  it("given a team file that still carries the address a new one replaced, when the repository opens, then the setup panel says its counts are refused", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const old = await ensureIngestId(ctx.store, ctx.tenant, "payments-skills");
    const bare = await reporting(ctx, ingestUrl(ctx.publicUrl!, old, "payments-skills"));
    await post(app, "/api/repos/payments-skills/usage/propose", { action: "rotate", baseSha: git(["rev-parse", "main"], bare).trim(), message: "chore: new usage address" });

    // when
    const { inventory } = await (await app.request("/api/repos/payments-skills/inventory")).json();

    // then
    expect(inventory.setup).toContainEqual(expect.objectContaining({ level: "attention", title: "Skill-use reports are refused" }));
  });
});

describe("the address a team file reports skill use to", () => {
  const PUBLIC = "https://orchestrator.example.com";
  const ID = "i".repeat(32);

  it.each([
    ["no address", undefined, PUBLIC, ID, null],
    ["this orchestrator's address for the repository", ingestUrl(PUBLIC, ID, "payments-skills"), PUBLIC, ID, "ok: Skill use is reported here"],
    ["an address while ORCHESTRATOR_PUBLIC_URL is unset", ingestUrl(PUBLIC, ID, "payments-skills"), undefined, ID, "attention: Skill-use reports cannot be checked"],
    ["this orchestrator's address with an id it replaced", ingestUrl(PUBLIC, "o".repeat(32), "payments-skills"), PUBLIC, ID, "attention: Skill-use reports are refused"],
    ["this orchestrator's address for another repository", ingestUrl(PUBLIC, ID, "platform-skills"), PUBLIC, ID, "attention: Skill-use reports are refused"],
    ["this orchestrator's address before it issued any id", ingestUrl(PUBLIC, ID, "payments-skills"), PUBLIC, null, "attention: Skill-use reports are refused"],
    ["another orchestrator's address", ingestUrl("https://old-orchestrator.example.com", ID, "payments-skills"), PUBLIC, ID, "attention: Skill use is reported elsewhere"],
  ])("given %s, when the setup panel reads it, then it says so", (_label, recorded, publicUrl, ingest, finding) => {
    const read = usageAddressFinding(recorded, publicUrl, ingest, "payments-skills");
    expect(read && `${read.level}: ${read.title}`).toBe(finding);
  });

  it("given another orchestrator's address, when the setup panel names it, then it shows that orchestrator's origin and not the id", () => {
    const read = usageAddressFinding(ingestUrl("https://old-orchestrator.example.com", ID, "payments-skills"), PUBLIC, ID, "payments-skills")!;
    expect(read.detail).toBe("The team file sends skill-use counts to https://old-orchestrator.example.com, not to this orchestrator at https://orchestrator.example.com.");
    expect(JSON.stringify(read)).not.toContain(ID);
  });
});
