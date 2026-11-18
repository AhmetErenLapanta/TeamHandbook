import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUser } from "../accounts.js";
import type { OrchestratorContext } from "../app.js";
import { openSqliteStore } from "../store.js";
import { claudeCodeAdapter } from "./agents.js";
import { readOff } from "./handbook-use.js";
import { createTaskRunner } from "./runner.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "tok-abcdef-0123456789";

/** A stand-in for the claude CLI: it keeps its arguments at `seen`, repeats what it was given, and fails for a server named taken. */
function standIn(seen: string): string {
  const dir = mkdtempSync(join(tmpdir(), "th-claude-mcp-"));
  dirs.push(dir);
  const file = join(dir, "claude-stand-in.mjs");
  writeFileSync(
    file,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(seen)}, JSON.stringify(argv) + "\\n");
if (argv.includes("taken")) {
  console.error("MCP server taken already exists with headers " + argv.join(" "));
  process.exit(1);
}
console.log("Added HTTP MCP server with headers " + argv.join(" "));
`,
  );
  chmodSync(file, 0o755);
  return file;
}

describe("a change to a person's own MCP servers by Claude Code's own command", { timeout: 60_000 }, () => {
  it("given one person's orchestrator on their own machine, when an add works, one fails, something other than add or remove is asked and the orchestrator is not where their Claude Code is, then only the first two run, as claude mcp with the arguments given, and nothing the command printed comes back", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "th-claude-mcp-runner-"));
    dirs.push(dir);
    const seen = join(dir, "seen.txt");
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: dir, tenant: "acme", ownForgeCli: true };
    await createUser(ctx.store, ctx.tenant, new Set(["Mine"]), { email: "ada@example.invalid", name: "Ada Example", role: "owner" }, { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] });
    const runner = createTaskRunner(ctx, { agents: [claudeCodeAdapter(standIn(seen))], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH, HOME: dir }, profile: "personal" });
    const add = (name: string) => ["mcp", "add", "-s", "user", "-t", "http", "-H", `Authorization: Bearer ${TOKEN}`, name, "https://docs.example.invalid/mcp"];

    // when
    const added = await runner.runClaudeMcp!(add("docs"));
    const failed = await runner.runClaudeMcp!(add("taken"));
    const other = await runner.runClaudeMcp!(["mcp", "serve"]);
    ctx.ownForgeCli = false;
    const elsewhere = await runner.runClaudeMcp!(["mcp", "remove", "docs", "-s", "user"]);

    // then
    expect([added, failed, other, elsewhere]).toEqual([{ ok: true }, { ok: false }, { ok: false }, { ok: false }]);
    // A change that worked has the person's setup read again, which calls the CLI too: only the mcp calls are the change's.
    expect(readFileSync(seen, "utf8").trim().split("\n").map((line) => (JSON.parse(line) as string[]).slice(0, 2)).filter(([first]) => first === "mcp")).toEqual([["mcp", "add"], ["mcp", "add"]]);
  });

  it("given a start that turns off one of the person's own commands, when it is read, then the command is kept beside the skills and servers", () => {
    // when
    const off = readOff({ commands: [{ source: "yours", name: "deploy-check" }] });

    // then
    expect(off).toEqual({ sources: [], skills: [], mcpServers: [], commands: [{ source: "yours", name: "deploy-check" }] });
  });
});
