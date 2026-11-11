import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "./agents.js";
import type { TaskPaths } from "./isolation.js";
import { personalGuardDir, personalHooksRefusal, personalMcpFile, projectMcpServers, releasePersonalGuard, writePersonalGuard } from "./profile.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await releasePersonalGuard(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function task(): TaskPaths {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-profile-"));
  dirs.push(root);
  const paths = { root, work: join(root, "work"), home: join(root, "home"), tmp: join(root, "tmp"), git: join(root, "git") };
  mkdirSync(paths.work);
  mkdirSync(paths.home);
  return paths;
}

describe("Run as me and the orchestrator's own guard", () => {
  it("given the guard written for a task, when the agent's file tools are pointed at it or at the person's own settings, then a deny rule names each, and on disk the guard takes no write", async () => {
    // given
    const paths = task();

    // when
    const file = await writePersonalGuard(paths);
    const settings = JSON.parse(readFileSync(file, "utf8"));
    const dir = personalGuardDir(paths);

    // then
    expect(file).toBe(join(paths.root, "guard", "personal-settings.json"));
    expect(settings.permissions.deny.slice(0, 4)).toEqual(["Edit(/**)", "Read(/**)", "Edit(~/.claude/**)", "Edit(~/.claude.json)"]);
    expect([statSync(dir).mode & 0o777, statSync(file).mode & 0o777, statSync(join(dir, "personal-guard.mjs")).mode & 0o777]).toEqual([0o500, 0o400, 0o400]);
    expect(() => writeFileSync(join(dir, "personal-guard.mjs"), "process.exit(0)\n")).toThrow(/EACCES/);
    expect(() => writeFileSync(join(dir, "planted.mjs"), "")).toThrow(/EACCES/);
    expect(file.startsWith(paths.work)).toBe(false);
    expect(file.startsWith(paths.home)).toBe(false);
  });

  it("given a guard already written, when a task's next repository writes it again, then it is written anew and closed again", async () => {
    // given
    const paths = task();
    await writePersonalGuard(paths, ["first"]);

    // when
    const settings = JSON.parse(readFileSync(await writePersonalGuard(paths, ["second"]), "utf8"));

    // then
    expect(settings.disabledMcpjsonServers).toEqual(["second"]);
    expect(statSync(personalGuardDir(paths)).mode & 0o777).toBe(0o500);
  });
});

describe("the team's path rules in a run as you", () => {
  it("given the team keeping .env and a skills folder from edits and a keys folder from reads, when the guard is written, then each is a deny rule of Claude Code's own, an absolute path written as one, and a rule it cannot hold is left to the check after the run", async () => {
    // given
    const paths = task();
    const rules = [
      { action: "tool.use" as const, resource: "tool:Edit:.env", effect: "deny" as const, reason: "Secrets stay out." },
      { action: "tool.use" as const, resource: "tool:Edit:skills/payments/**", effect: "deny" as const, reason: "Owned by Payments." },
      { action: "tool.use" as const, resource: "tool:Read:keys/**", effect: "deny" as const, reason: "Keys stay unread." },
      { action: "tool.use" as const, resource: "tool:Bash:rm *", effect: "deny" as const, reason: "No shell." },
      { action: "tool.use" as const, resource: "tool:Edit:odd (name).md", effect: "deny" as const, reason: "Odd." },
      { action: "mcp.use" as const, resource: "mcp:tracker/delete_issue", effect: "deny" as const, reason: "No deletes." },
      { action: "tool.use" as const, resource: "tool:Edit:/etc/*", effect: "deny" as const, reason: "The host stays as it is." },
    ];

    // when
    const settings = JSON.parse(readFileSync(await writePersonalGuard(paths, [], rules), "utf8"));

    // then
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Edit(.env)", "Edit(skills/payments/**)", "Read(keys/**)", "Edit(//etc/*)"]));
    expect(settings.permissions.deny).not.toContain("Edit(/etc/*)");
    expect(settings.permissions.deny.filter((rule: string) => /rm|odd|delete_issue/.test(rule))).toEqual([]);
  });
});

describe("the isolated profile's own files", () => {
  it("given a task's Claude Code set up with the orchestrator, when its files are written, then its file tools are denied the task's home and the MCP file names the token's variable, never the token", async () => {
    // given
    const paths = task();
    const bearer = "th_tt_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

    // when
    await claudeCodeAdapter("claude").configure(paths, { skills: [], mcpServers: {}, mcpTools: [], orchestrator: { url: "http://orchestrator.invalid/api/orchestrator/mcp", bearer, tools: ["delegate_task"] } });

    // then
    const settings = JSON.parse(readFileSync(join(paths.home, ".claude", "settings.json"), "utf8"));
    expect(settings.permissions.deny).toContain(`Edit(/${paths.home}/**)`);
    const mcp = readFileSync(join(paths.home, "mcp.json"), "utf8");
    expect(mcp).not.toContain(bearer);
    expect(JSON.parse(mcp).mcpServers["th-orchestrator"]).toEqual({ type: "http", url: "http://orchestrator.invalid/api/orchestrator/mcp", headers: { Authorization: "Bearer ${TH_ORCHESTRATOR_TOKEN}" } });
  });
});

describe("Run as me and the repository's own MCP servers", () => {
  it("given a checkout whose .mcp.json names two servers, when the guard is written, then both are turned off by name beside the hook", async () => {
    // given
    const paths = task();
    writeFileSync(join(paths.work, ".mcp.json"), JSON.stringify({ mcpServers: { "deploy-bot": { command: "node", args: ["deploy.js"] }, docs: { type: "http", url: "https://docs.example.invalid/mcp" } } }));

    // when
    const servers = await projectMcpServers(paths.work);
    const settings = JSON.parse(readFileSync(await writePersonalGuard(paths, servers as string[]), "utf8"));

    // then
    expect(servers).toEqual(["deploy-bot", "docs"]);
    expect(settings).toMatchObject({ disabledMcpjsonServers: ["deploy-bot", "docs"], enableAllProjectMcpServers: false });
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  it("given a checkout with no .mcp.json and one with no servers in it, when they are read, then no server is named and project servers stay off as a whole", async () => {
    // given
    const none = task();
    const empty = task();
    writeFileSync(join(empty.work, ".mcp.json"), JSON.stringify({ mcpServers: [] }));

    // when
    const read = [await projectMcpServers(none.work), await projectMcpServers(empty.work)];
    const settings = JSON.parse(readFileSync(await writePersonalGuard(none), "utf8"));

    // then
    expect(read).toEqual([[], []]);
    expect(settings).not.toHaveProperty("disabledMcpjsonServers");
    expect(settings.enableAllProjectMcpServers).toBe(false);
  });

  it("given a .mcp.json that is not JSON or is a directory, when it is read, then the task is refused rather than started with servers nobody named", async () => {
    // given
    const broken = task();
    writeFileSync(join(broken.work, ".mcp.json"), "{ mcpServers: ");
    const folder = task();
    mkdirSync(join(folder.work, ".mcp.json"));

    // when
    const read = [await projectMcpServers(broken.work), await projectMcpServers(folder.work)];

    // then
    expect(read).toEqual([
      { refused: "the repository's .mcp.json is not JSON, so Run as me cannot keep its MCP servers off" },
      { refused: "the repository's .mcp.json cannot be read, so Run as me cannot keep its MCP servers off" },
    ]);
  });
});

describe("the guard beside the person's own Claude Code setup", () => {
  it("given the guard written with the orchestrator's own server, when its layer is read, then it turns the person's disableAllHooks off, denies the agent's reads of the guard and its writes into .git, and keeps the server's token in the guard alone", async () => {
    // given
    const paths = task();
    const servers = { "th-orchestrator": { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer th_task_stand-in-token" } } };

    // when
    const settings = JSON.parse(readFileSync(await writePersonalGuard(paths, [], [], { servers }), "utf8"));

    // then
    expect(settings.disableAllHooks).toBe(false);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Read(/**)", "Edit(**/.git/**)"]));
    expect(personalMcpFile(paths).startsWith(personalGuardDir(paths))).toBe(true);
    expect(JSON.parse(readFileSync(personalMcpFile(paths), "utf8"))).toEqual({ mcpServers: servers });
    expect(statSync(personalMcpFile(paths)).mode & 0o777).toBe(0o400);
  });

  it("given the guard, when the agent calls a writing tool of the person's own server and a tracker's, then the first is left to the person's own rules and the task's mode and the second is denied", async () => {
    // given
    const paths = task();
    const settings = JSON.parse(readFileSync(await writePersonalGuard(paths), "utf8"));
    const command = settings.hooks.PreToolUse[0].hooks[0].command as string;

    // when
    const decide = (tool_name: string) => spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input: {}, cwd: paths.work }), encoding: "utf8" }).stdout;

    // then
    expect(decide("mcp__deploy__start_rollout")).toBe("");
    expect(decide("mcp__tracker__create_issue")).toContain('"permissionDecision":"deny"');
  });
});

describe("managed Claude Code settings that would switch the guard off", () => {
  const managed = () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-managed-"));
    dirs.push(root);
    mkdirSync(join(root, "managed-settings.d"));
    return { root, places: { files: [join(root, "managed-settings.json"), join(root, "remote-settings.json")], dropIns: [join(root, "managed-settings.d")], plists: [] } };
  };

  it.each([
    ["managed-settings.json", { allowManagedHooksOnly: true }, "allow only their own hooks (allowManagedHooksOnly)"],
    ["remote-settings.json", { disableAllHooks: true }, "switch off every hook (disableAllHooks)"],
    ["managed-settings.d/10-plugins.json", { strictPluginOnlyCustomization: ["skills", "hooks"] }, "allow hooks only from plugins (strictPluginOnlyCustomization)"],
  ])("given %s holding %j, when a run as you is checked, then it is refused naming the file and the switch", async (file, settings, said) => {
    // given
    const { root, places } = managed();
    writeFileSync(join(root, file), JSON.stringify(settings));

    // when
    const refused = await personalHooksRefusal(places);

    // then
    expect(refused).toBe(`the managed Claude Code settings in ${join(root, file)} ${said}, which switches off the orchestrator's guard for a task that runs as you; run tasks in the isolated profile (ORCHESTRATOR_TASK_PROFILE=isolated)`);
  });

  it("given no managed settings, ones that switch nothing off, and ones that cannot be read, when a run as you is checked, then only the last is refused", async () => {
    // given
    const none = managed();
    const fine = managed();
    writeFileSync(join(fine.root, "managed-settings.json"), JSON.stringify({ disableAllHooks: false, permissions: { deny: ["Bash"] } }));
    const broken = managed();
    writeFileSync(join(broken.root, "managed-settings.d", "20-broken.json"), "{ disableAllHooks: ");

    // when
    const answers = [await personalHooksRefusal(none.places), await personalHooksRefusal(fine.places), await personalHooksRefusal(broken.places)];

    // then
    expect(answers.slice(0, 2)).toEqual([null, null]);
    expect(answers[2]).toMatch(/^the managed Claude Code settings in .*20-broken\.json cannot be read/);
  });
});

