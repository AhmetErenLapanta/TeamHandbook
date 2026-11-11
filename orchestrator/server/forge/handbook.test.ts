import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChangeRefused } from "../changes.js";
import { buildHandbookChange, ownHandbook, teamHandbook } from "./handbook.js";

const IDENTITY = ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid"];
const skillMd = (name: string, says = `What ${name} is for.`) => `---\nname: ${name}\ndescription: ${says}\n---\n\nBody of ${name}.\n`;

/** A team repository with the skill release-notes, the server docs and the command deploy, as the orchestrator's copy holds it. */
function teamRepository() {
  const dir = mkdtempSync(join(tmpdir(), "handbook-team-"));
  const git = (...args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "skills", "release-notes"), { recursive: true });
  writeFileSync(join(dir, "skills", "release-notes", "SKILL.md"), skillMd("release-notes"));
  writeFileSync(join(dir, "skills", "release-notes", "old.md"), "An old note.\n");
  mkdirSync(join(dir, "commands"));
  writeFileSync(join(dir, "commands", "deploy.md"), "Deploy the service.\n");
  writeFileSync(join(dir, ".mcp.json"), `${JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://docs.example.invalid/mcp" } } }, null, 2)}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "team");
  return { mirror: dir, head: git("rev-parse", "HEAD") };
}

/** A person's Claude Code: the skills release-notes (newer) and on-call, the servers tickets and vault (holding a credential), the command triage. */
function ownClaudeCode() {
  const home = mkdtempSync(join(tmpdir(), "handbook-home-"));
  for (const [name, says] of [["release-notes", "Writes the release notes."], ["on-call", "Hands the pager over."]] as const) {
    mkdirSync(join(home, ".claude", "skills", name), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", name, "SKILL.md"), skillMd(name, says));
  }
  writeFileSync(join(home, ".claude", "skills", "on-call", "steps.md"), "1. Read the open incidents.\n");
  mkdirSync(join(home, ".claude", "commands"));
  writeFileSync(join(home, ".claude", "commands", "triage.md"), "---\ndescription: Sort the new issues.\n---\nSort the new issues.\n");
  const servers = { tickets: { type: "http", url: "https://tickets.example.invalid/mcp" }, vault: { type: "http", url: "https://vault.example.invalid/mcp", headers: { Authorization: "Bearer 8f2c41d9ab7e05631cd4a29f" } } };
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: servers }, null, 2));
  return { userHome: home, cwd: home, configFile: join(home, ".claude.json") };
}

describe("the person's own Claude Code, as the Team handbook offers it", () => {
  it("given skills, servers and a command of their own, when it is read beside the team repository, then each says whether the team has it and whether it can go, and a server holding a credential is listed but never offered or shown", async () => {
    // given
    const { mirror, head } = teamRepository();
    const paths = ownClaudeCode();

    // when
    const own = ownHandbook(await teamHandbook(mirror, head), paths);

    // then
    expect(own.skills).toEqual(expect.arrayContaining([{ name: "release-notes", description: "Writes the release notes.", inTeam: true, addable: true }, { name: "on-call", description: "Hands the pager over.", inTeam: false, addable: true }]));
    expect(own.mcpServers.find((s) => s.name === "tickets")).toMatchObject({ inTeam: false, addable: true });
    expect(own.mcpServers.find((s) => s.name === "vault")).toMatchObject({ addable: false, why: expect.any(String) });
    expect(JSON.stringify(own)).not.toContain("8f2c41d9ab7e05631cd4a29f");
    expect(own.commands).toEqual([expect.objectContaining({ name: "triage", inTeam: false, addable: true })]);
  });
});

describe("one change to the team repository from what the person picked", () => {
  it("given a new skill, a skill the team has, a server and a command picked, when the change is built, then the new ones are added, the team's skill becomes the person's copy, and the title says which is which", async () => {
    // given
    const { mirror, head } = teamRepository();
    const paths = ownClaudeCode();

    // when
    const built = await buildHandbookChange(mirror, head, { skills: ["on-call", "release-notes"], mcpServers: ["tickets"], commands: ["triage"] }, paths);

    // then
    expect(built.proposal).toBe("feat(handbook): add on-call, tickets, triage; update release-notes");
    const byPath = Object.fromEntries(built.files.map((f) => [f.path, f.content]));
    expect(byPath["skills/on-call/SKILL.md"]).toBe(skillMd("on-call", "Hands the pager over."));
    expect(byPath["skills/on-call/steps.md"]).toBe("1. Read the open incidents.\n");
    expect(byPath["skills/release-notes/SKILL.md"]).toBe(skillMd("release-notes", "Writes the release notes."));
    expect(byPath["skills/release-notes/old.md"]).toBeNull();
    expect(JSON.parse(byPath[".mcp.json"]!).mcpServers).toEqual({ docs: { type: "http", url: "https://docs.example.invalid/mcp" }, tickets: { type: "http", url: "https://tickets.example.invalid/mcp" } });
    expect(byPath["commands/triage.md"]).toContain("Sort the new issues.");
  });

  it("given a server holding a credential, a name the person does not have, or a skill file that looks like a key, when the change is built, then nothing is proposed and the reason names it", async () => {
    // given
    const { mirror, head } = teamRepository();
    const paths = ownClaudeCode();
    writeFileSync(join(paths.userHome, ".claude", "skills", "on-call", "key.pem"), "-----BEGIN RSA PRIVATE KEY-----\nstand-in\n-----END RSA PRIVATE KEY-----\n");

    // when
    const attempt = (pick: object) => buildHandbookChange(mirror, head, pick, paths).catch((err: unknown) => err);
    const [server, unknown, skill] = [await attempt({ mcpServers: ["vault"] }), await attempt({ commands: ["unknown"] }), await attempt({ skills: ["on-call"] })];

    // then
    expect(server).toBeInstanceOf(ChangeRefused);
    expect((server as Error).message).toMatch(/^vault cannot go to the team: /);
    expect((unknown as Error).message).toBe("your Claude Code has no command unknown");
    expect(skill).toBeInstanceOf(ChangeRefused);
    expect((skill as Error).message).toMatch(/^on-call cannot go to the team: key\.pem/);
  });

  it("given the team's copies already equal the person's, or no pick at all, when the change is built, then it is refused as having nothing to propose", async () => {
    // given
    const { mirror, head } = teamRepository();
    const paths = ownClaudeCode();
    writeFileSync(join(paths.userHome, ".claude", "skills", "release-notes", "SKILL.md"), skillMd("release-notes"));
    writeFileSync(join(paths.userHome, ".claude", "skills", "release-notes", "old.md"), "An old note.\n");

    // when
    const same = await buildHandbookChange(mirror, head, { skills: ["release-notes"] }, paths).catch((err: Error) => err.message);
    const none = await buildHandbookChange(mirror, head, {}, paths).catch((err: Error) => err.message);

    // then
    expect(same).toBe("the team's copies already match yours; nothing to propose");
    expect(none).toBe("pick at least one skill, MCP server or command");
  });
});
