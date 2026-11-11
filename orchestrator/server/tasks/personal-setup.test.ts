import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUser } from "../accounts.js";
import { openSqliteStore } from "../store.js";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { claudeCodeAdapter } from "./agents.js";
import { probePersonalSetup } from "./personal-setup.js";
import { createTaskRunner } from "./runner.js";

const OWNER: Principal = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] };
const ACCOUNT = "ada@example.invalid";
const HEADER = "Bearer stand-in-header-token-0001";
const SECRET = "stand-in-env-secret-0002";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A person's machine: a stand-in for the claude CLI that answers `initialize` with commands and
 * the account it is signed in as, and keeps running after it, as a session would; a plugin list
 * with paths in it; and a global config with credentials beside its servers. `answers` false
 * leaves `initialize` unanswered.
 */
function machine(answers = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestrator-personal-setup-")));
  dirs.push(root);
  const home = join(root, "home");
  const folder = join(root, "notes");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(folder);
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "Prefer small commits.\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    oauthAccount: { emailAddress: ACCOUNT },
    mcpServers: { tracker: { type: "http", url: "https://tracker.example.invalid/mcp", headers: { Authorization: HEADER } }, notes: { command: "node", args: ["notes-server.mjs"] } },
  }));
  writeFileSync(join(folder, ".mcp.json"), JSON.stringify({ mcpServers: { lint: { command: "npx", args: ["lint-mcp"], env: { LINT_TOKEN: SECRET } } } }));
  const bin = join(root, "claude");
  writeFileSync(bin, `#!${process.execPath}
const { appendFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "plugin") {
  console.log(JSON.stringify([{ id: "release-notes@team-market", version: "1.2.0", scope: "user", enabled: true, installPath: ${JSON.stringify(join(home, ".claude", "plugins", "release-notes"))}, mcpServers: { changelog: { command: "node" } } }, { id: "lookup@team-market", version: "0.3.0", scope: "user", enabled: false, mcpServers: ["lookup-index"] }]));
  process.exit(0);
}
writeFileSync(process.env.HOME + "/argv.json", JSON.stringify(args));
process.stdin.setEncoding("utf8").on("data", (chunk) => {
  appendFileSync(process.env.HOME + "/stdin.txt", chunk);
  for (const line of chunk.split("\\n").filter(Boolean)) {
    const frame = JSON.parse(line);
    console.log(JSON.stringify({ type: "system", subtype: "status", account: ${JSON.stringify(ACCOUNT)} }));
    if (${answers} && frame.request?.subtype === "initialize") console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: { commands: [{ name: "release-check", description: "Check a release", argumentHint: "<version>" }, { name: "help", description: "Help", argumentHint: "", builtin: true }], account: { email: ${JSON.stringify(ACCOUNT)}, organization: "Acme" }, pid: process.pid } } }));
  }
});
setInterval(() => {}, 1000);
`);
  chmodSync(bin, 0o755);
  return { root, home, folder, bin, env: { PATH: process.env.PATH ?? "", HOME: home } };
}

describe("what a person's own Claude Code brings to a task", { timeout: 60_000 }, () => {
  it("given a machine whose CLI answers initialize, when its setup is read, then commands, plugins and servers come back by names alone, with no account, path, address, argument, header or value, and the CLI was asked with hooks and MCP off and only that one request", async () => {
    // given
    const { folder, bin, env, home, root } = machine();

    // when
    const setup = await probePersonalSetup(bin, env, root, [folder]);

    // then
    expect(setup).toMatchObject({
      commands: [{ name: "release-check", description: "Check a release", argumentHint: "<version>" }],
      claudeMd: true,
      plugins: [{ name: "release-notes", marketplace: "team-market", version: "1.2.0", enabled: true, scope: "user" }, { name: "lookup", marketplace: "team-market", version: "0.3.0", enabled: false, scope: "user" }],
      mcpServers: [
        { name: "tracker", kind: "http", scope: "user", asksForValue: true },
        { name: "notes", kind: "stdio", scope: "user", asksForValue: false },
        { name: "lint", kind: "stdio", scope: "project", asksForValue: true },
        { name: "changelog", kind: "stdio", scope: "plugin", asksForValue: false },
        { name: "lookup-index", kind: "unknown", scope: "plugin", asksForValue: null },
      ],
    });
    const said = JSON.stringify(setup);
    for (const kept of [ACCOUNT, "Acme", HEADER, SECRET, "tracker.example.invalid", "notes-server.mjs", "lint-mcp", home, "installPath", "Prefer small commits"]) expect(said).not.toContain(kept);
    const argv = JSON.parse(readFileSync(join(home, "argv.json"), "utf8")) as string[];
    expect(argv[argv.indexOf("--settings") + 1]).toBe(JSON.stringify({ disableAllHooks: true }));
    expect(argv).toEqual(expect.arrayContaining(["--strict-mcp-config", "--setting-sources", "user"]));
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe(JSON.stringify({ mcpServers: {} }));
    expect(readFileSync(join(home, "stdin.txt"), "utf8").trim().split("\n").map((l) => JSON.parse(l).request.subtype)).toEqual(["initialize"]);
  });

  it("given a CLI that never answers initialize, when its setup is read, then nothing comes back rather than a guess", async () => {
    // given
    const { bin, env, root } = machine(false);

    // when
    const setup = await probePersonalSetup(bin, env, root, [], 1_500);

    // then
    expect(setup).toBeNull();
  });

  it("given a one-person orchestrator whose tasks run as its user, when the setup is asked for twice, then it is read once and kept, and an isolated orchestrator reads none", async () => {
    // given
    const { bin, home, root } = machine();
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: "default" };
    await createUser(ctx.store, ctx.tenant, new Set(), { email: ACCOUNT, role: "owner" }, OWNER);
    const make = (profile: "personal" | "isolated") => createTaskRunner(ctx, { agents: [claudeCodeAdapter(bin)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH, HOME: home }, profile });
    const personal = make("personal");
    const isolated = make("isolated");

    // when
    const first = await personal.personalSetup();
    const second = await personal.personalSetup();
    const none = await isolated.personalSetup();

    // then
    expect(first?.commands.map((c) => c.name)).toEqual(["release-check"]);
    expect(second).toBe(first);
    expect(personal.lastPersonalSetup()).toBe(first);
    expect(none).toBeNull();
  });
});
