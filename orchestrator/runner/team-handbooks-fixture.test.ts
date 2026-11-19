import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHandbookHome, PAYMENTS, PLANTED, standInCalls } from "../browser-tests/handbook-home.js";
import type { HandbookHome } from "../browser-tests/handbook-home.js";
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
const PLUGIN = `plugin:${PAYMENTS}`;

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
    return (path: string, method = "GET", body?: unknown) => app.request(path, { method, headers: { cookie, [CSRF_HEADER]: csrf, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  return { store, fetchImpl, max: await browserOf(max.id), maxId: max.id };
}

describe("a person's stand-in Claude Code home managed from a team's orchestrator through their machine's runner", { timeout: 120_000 }, () => {
  let root: string;
  let built: HandbookHome;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "team-handbooks-fixture-")));
    built = buildHandbookHome(join(root, "person"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("given the fixture home paired as a machine, when its handbooks are listed, a skill is edited, the marketplaces are checked and the plugin behind its marketplace is updated, then each runs on that home through Claude Code's own commands and nothing planted is said", async () => {
    // given
    const org = await orchestrator();
    const { code } = await (await org.max("/api/machines/pair", "POST", {})).json();
    const dataDir = join(root, "runner-data");
    await connect({ address: ADDRESS, code, dataDir, name: "max-laptop", platform: "darwin-arm64", fetch: org.fetchImpl });
    const machineId = (await org.store.listMachines("acme", org.maxId))[0]!.id;
    const executor: TaskExecutor = { run: () => new Promise(() => {}) };
    const runner = startMachineRunner({ dataDir, home: built.home, env: { HOME: built.home, PATH: process.env.PATH }, executor, fetch: org.fetchImpl, mask: (t) => t, claude: built.claude });
    const on = (path: string) => `${path}${path.includes("?") ? "&" : "?"}machine=${machineId}`;
    const said: string[] = [];
    const json = async (response: Response) => {
      const text = await response.text();
      said.push(text);
      return JSON.parse(text);
    };
    try {
      // when
      let listed = await json(await org.max(on("/api/handbook/sources")));
      for (let i = 0; i < 100 && !listed.available; i++) {
        await new Promise((r) => setTimeout(r, 50));
        listed = await json(await org.max(on("/api/handbook/sources")));
      }
      const opened = await json(await org.max(on("/api/handbook/file?source=yours&kind=skill&name=review-checklist")));
      const edited = "---\nname: review-checklist\ndescription: My checklist before I ask for a review\n---\n\nRead the diff three times.\n";
      const saved = await org.max(on("/api/handbook/file"), "PUT", { source: "yours", kind: "skill", name: "review-checklist", content: edited, expectedDigest: opened.digest });
      const stale = await org.max(on("/api/handbook/file"), "PUT", { source: "yours", kind: "skill", name: "review-checklist", content: "x", expectedDigest: opened.digest });
      const ofPlugin = await org.max(on("/api/handbook/file"), "PUT", { source: PLUGIN, kind: "skill", name: "add-endpoint", content: "x", expectedDigest: opened.digest });
      const checked = await json(await org.max(on("/api/handbook/marketplaces/update"), "POST", {}));
      const updated = await json(await org.max(on("/api/handbook/plugins/update"), "POST", { plugin: PLUGIN }));
      const again = await json(await org.max(on("/api/handbook/plugins/update"), "POST", { plugin: PLUGIN }));
      const after = await json(await org.max(on("/api/handbook/sources")));

      // then
      expect(listed).toMatchObject({ available: true, machine: "max-laptop" });
      expect(listed.sources.find((s: { id: string }) => s.id === PLUGIN)).toMatchObject({ version: "1.4.0" });
      expect(saved.status).toBe(200);
      expect(readFileSync(join(built.home, ".claude", "skills", "review-checklist", "SKILL.md"), "utf8")).toBe(edited);
      expect(stale.status).toBe(409);
      expect(ofPlugin.status).toBeGreaterThanOrEqual(400);
      expect(checked).toEqual({ ok: true, command: "claude plugin marketplace update" });
      expect(updated).toEqual({ ok: true, command: `claude plugin update ${PAYMENTS}` });
      expect(again).toMatchObject({ ok: false, command: `claude plugin update ${PAYMENTS}` });
      expect(after.sources.find((s: { id: string }) => s.id === PLUGIN)).toMatchObject({ version: "1.5.0" });
      const commands = standInCalls(built).map((c) => c.call).filter((c) => /^plugin (marketplace update|update)$/.test(c));
      expect(commands).toEqual(["plugin marketplace update", "plugin update", "plugin update"]);
      for (const value of Object.values(PLANTED)) expect(said.join("\n")).not.toContain(value);
    } finally {
      await runner.stop();
    }
  });
});
