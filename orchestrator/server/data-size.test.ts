import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { Principal } from "./auth.js";
import { dataSize } from "./data-size.js";
import { openSqliteStore } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const OWNER: Principal = { id: "usr_a", name: "Ada", email: "ada@example.invalid", role: "owner", ownedTeams: [] };
const MEMBER: Principal = { id: "usr_b", name: "Max", email: "max@example.invalid", role: "member", ownedTeams: [] };

describe("what the orchestrator's data takes on this machine", () => {
  it("given a data folder with a database and its log, task folders and turns, attachments, copies, a mirror, something else and a link out of it, when its size is read, then each part is counted in its own name, the link is not followed, and a local owner reads it while a member and a team's orchestrator do not", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "th-size-"));
    dirs.push(dir);
    const put = (path: string, bytes: number) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), Buffer.alloc(bytes, 1));
    };
    put("orchestrator.db", 1000);
    put("orchestrator.db-wal", 200);
    put("tasks/acme/tsk_1/work/a.txt", 3000);
    put("task-git/acme/tsk_1/objects", 500);
    put("task-turns/acme/tsk_1/objects/pack", 300);
    put("shadow/acme/shop/objects/pack", 200);
    put("attachments/acme/att_1", 700);
    put("backups/backup-2026-11-12T10-00-00-000Z/orchestrator.db", 900);
    put("mirrors/acme/shop.git/HEAD", 40);
    put("secret.key", 44);
    const outside = mkdtempSync(join(tmpdir(), "th-size-out-"));
    dirs.push(outside);
    writeFileSync(join(outside, "big"), Buffer.alloc(99_999));
    symlinkSync(outside, join(dir, "tasks", "acme", "linked"));
    vi.stubEnv("ORCHESTRATOR_MODE", "local");
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), mode: "local", dataDir: dir, tenant: "acme", allowedHosts: null };
    const as = (user: Principal) => createApp(ctx, async (c, next) => { c.set("user", user); await next(); });

    // when
    const size = await dataSize(dir);
    const owners = await as(OWNER).request("/api/data/size");
    const members = await as(MEMBER).request("/api/data/size");
    vi.stubEnv("ORCHESTRATOR_MODE", "self-hosted");
    const onTeam = await as(OWNER).request("/api/data/size");

    // then
    expect(size).toEqual({ total: 1200 + 4000 + 700 + 900 + 40 + 44, parts: { database: 1200, "task-folders": 4000, attachments: 700, copies: 900, repositories: 40, other: 44 }, partial: false, path: dir, keep: 7 });
    expect([owners.status, members.status, onTeam.status]).toEqual([200, 403, 404]);
  });
});
