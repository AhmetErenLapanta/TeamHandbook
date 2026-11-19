import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUser, principalOf, setupFirstOwner, startSession } from "../server/accounts.js";
import { createApp } from "../server/app.js";
import type { OrchestratorContext } from "../server/app.js";
import { CSRF_HEADER, sessionCookie } from "../server/auth.js";
import { createRunnerService } from "../server/runner-service.js";
import { openSqliteStore } from "../server/store.js";
import { connect } from "./connect.js";
import { startMachineRunner } from "./machine.js";
import type { Fetch } from "./profile.js";
import type { TaskExecutor } from "./task.js";

const ADDRESS = "https://orchestrator.example.invalid";
const DOCS = "plugin:docs-kit@acme-market";

async function orchestrator() {
  const store = openSqliteStore(":memory:");
  const owner = await principalOf(store, await setupFirstOwner(store, "acme", "code", { code: "code", email: "ada@example.invalid", password: "correct horse battery" }));
  const max = await createUser(store, "acme", new Set(["Payments"]), { email: "max@example.invalid", role: "member", password: "correct horse battery" }, owner);
  const ctx: OrchestratorContext = { store, dataDir: "unused", tenant: "acme", allowedHosts: null, runnerService: createRunnerService({ tenant: "acme", store }) };
  const app = createApp(ctx);
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(String(input));
    return app.request(url.pathname + url.search, init);
  };
  const browserOf = async (userId: string) => {
    const cookie = `${sessionCookie("acme")}=${(await startSession(store, "acme", userId)).token}`;
    const { csrf } = await (await app.request("/api/me", { headers: { cookie } })).json();
    return async (path: string, method = "GET", body?: unknown) => app.request(path, { method, headers: { cookie, [CSRF_HEADER]: csrf, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  return { store, fetchImpl, max: await browserOf(max.id), ada: await browserOf(owner.id), maxId: max.id };
}

describe("a person's own Claude Code managed from a team's orchestrator through their machine's runner", { timeout: 120_000 }, () => {
  let root: string;
  let home: string;
  let dataDir: string;
  let ran: string;
  let claude: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "team-handbooks-")));
    home = join(root, "home");
    dataDir = join(root, "runner-data");
    ran = join(root, "claude-ran.txt");
    claude = join(root, "claude-stand-in");
    mkdirSync(join(home, ".claude", "skills", "review-checklist"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "review-checklist", "SKILL.md"), "---\nname: review-checklist\ndescription: Check a review.\n---\nCheck it.\n");
    const plugin = join(home, ".claude", "plugins", "cache", "acme-market", "docs-kit");
    mkdirSync(join(plugin, "skills", "write-docs"), { recursive: true });
    writeFileSync(join(plugin, "skills", "write-docs", "SKILL.md"), "---\nname: write-docs\ndescription: Write the docs.\n---\nWrite them.\n");
    writeFileSync(join(root, "docs-kit-version"), "1.0.0");
    mkdirSync(dataDir, { recursive: true });
    const version = join(root, "docs-kit-version");
    writeFileSync(
      claude,
      [
        "#!/bin/sh",
        `echo "$@" >> "${ran}"`,
        `if [ "$1 $2" = "plugin list" ]; then echo "[{\\"id\\":\\"docs-kit@acme-market\\",\\"version\\":\\"$(cat "${version}")\\",\\"scope\\":\\"user\\",\\"enabled\\":true,\\"installPath\\":\\"${plugin}\\"}]"; fi`,
        `if [ "$1 $2 $3" = "plugin update docs-kit@acme-market" ]; then echo 1.1.0 > "${version}"; fi`,
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(claude, 0o755);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("given Max's machine paired with his team, when he lists his setup, edits his own skill, checks for updates and updates a plugin from the team's page, then each is done on his machine by its runner with Claude Code's own commands, and nobody else can ask his machine", async () => {
    // given
    const org = await orchestrator();
    const { code } = await (await org.max("/api/machines/pair", "POST", {})).json();
    await connect({ address: ADDRESS, code, dataDir, name: "max-laptop", platform: "darwin-arm64", fetch: org.fetchImpl });
    const machineId = (await org.store.listMachines("acme", org.maxId))[0]!.id;
    const executor: TaskExecutor = { run: () => new Promise(() => {}) };
    const runner = startMachineRunner({ dataDir, home, env: { HOME: home, PATH: process.env.PATH }, executor, fetch: org.fetchImpl, mask: (t) => t, claude });
    const on = (path: string) => `${path}${path.includes("?") ? "&" : "?"}machine=${machineId}`;
    try {
      // when
      let listed = await (await org.max(on("/api/handbook/sources"))).json();
      for (let i = 0; i < 100 && !listed.available; i++) {
        await new Promise((r) => setTimeout(r, 50));
        listed = await (await org.max(on("/api/handbook/sources"))).json();
      }
      const opened = await (await org.max(on("/api/handbook/file?source=yours&kind=skill&name=review-checklist"))).json();
      const edited = "---\nname: review-checklist\ndescription: Check a review.\n---\nCheck it twice.\n";
      const saved = await org.max(on("/api/handbook/file"), "PUT", { source: "yours", kind: "skill", name: "review-checklist", content: edited, expectedDigest: opened.digest });
      const stale = await org.max(on("/api/handbook/file"), "PUT", { source: "yours", kind: "skill", name: "review-checklist", content: "x", expectedDigest: opened.digest });
      const checked = await (await org.max(on("/api/handbook/marketplaces/update"), "POST", {})).json();
      const updated = await (await org.max(on("/api/handbook/plugins/update"), "POST", { plugin: DOCS })).json();
      const after = await (await org.max(on("/api/handbook/sources"))).json();
      const before = readFileSync(ran, "utf8");
      const notHis = await org.ada(on("/api/handbook/sources"));

      // then
      expect(listed).toMatchObject({ available: true, machine: "max-laptop" });
      expect(listed.sources.map((s: { id: string; version?: string }) => [s.id, s.version ?? null])).toEqual([["yours", null], [DOCS, "1.0.0"]]);
      expect(opened).toEqual({ content: "---\nname: review-checklist\ndescription: Check a review.\n---\nCheck it.\n", digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(saved.status).toBe(200);
      expect(readFileSync(join(home, ".claude", "skills", "review-checklist", "SKILL.md"), "utf8")).toBe(edited);
      expect(stale.status).toBe(409);
      expect(checked).toEqual({ ok: true, command: "claude plugin marketplace update" });
      expect(updated).toEqual({ ok: true, command: "claude plugin update docs-kit@acme-market" });
      expect(after.sources.find((s: { id: string }) => s.id === DOCS)).toMatchObject({ version: "1.1.0" });
      expect(before).toContain("plugin marketplace update");
      expect(before).toContain("plugin update docs-kit@acme-market -s user");
      expect(notHis.status).toBe(404);
      expect(readFileSync(ran, "utf8")).toBe(before);
      expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    } finally {
      await runner.stop();
    }
  });
});
