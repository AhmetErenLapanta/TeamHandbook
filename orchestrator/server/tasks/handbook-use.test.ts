import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { calledIn, loadedWithout, mcpSource, offChanges, offNames, readOff, setupOf, skillSource, startedWithOf, withUse, withUseAt } from "./handbook-use.js";
import type { HandbookPlace } from "./handbook-use.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in home and folder: one skill and one server of the person's own, one skill and one server of the folder's, a plugin and a team. */
function place(): HandbookPlace {
  const root = mkdtempSync(join(tmpdir(), "th-handbook-use-"));
  dirs.push(root);
  const home = join(root, "home");
  const folder = join(root, "notes");
  mkdirSync(join(home, ".claude", "skills", "review-checklist"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { postgres: { command: "pg", env: { PGPASSWORD: "not-read" } } } }));
  mkdirSync(join(folder, ".claude", "skills", "release-notes"), { recursive: true });
  writeFileSync(join(folder, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { url: "https://docs.example.invalid" } } }));
  return { home, folder, plugins: [{ name: "payments-skills", marketplace: "acme-handbook", version: "1.4.0" }], team: { id: "lending-skills", name: "lending-skills", skills: ["add-endpoint"], mcpServers: ["tracker"] } };
}

describe("where what a task uses comes from", () => {
  it("given an off list with sources, picks and things that are not one, when each is read, then the well formed one is kept and the others are refused", () => {
    // when
    const read = [
      readOff({ sources: ["plugin:payments-skills@acme-handbook"], skills: [{ source: "yours", name: "review-checklist" }], mcpServers: [{ source: "folder:/work/notes", name: "docs" }] }),
      readOff({ sources: ["somewhere-else"] }),
      readOff({ skills: [{ source: "yours", name: "bad\u0007name" }] }),
      readOff({}),
      readOff(undefined),
    ];

    // then
    expect(read[0]).toEqual({ sources: ["plugin:payments-skills@acme-handbook"], skills: [{ source: "yours", name: "review-checklist" }], mcpServers: [{ source: "folder:/work/notes", name: "docs" }] });
    expect([read[1], read[2]].every((r) => r && "error" in r)).toBe(true);
    expect([read[3], read[4]]).toEqual([undefined, undefined]);
  });

  it("given skills and servers of the person's own, the folder's, a plugin's, the team's and one nobody declares, when their sources are read, then each is named by where it lives, with its label and a plugin's version", async () => {
    // given
    const at = place();

    // when
    const skills = await Promise.all(["review-checklist", "release-notes", "payments-skills:add-refund", "add-endpoint", "made-up", "payments-skills:review-checklist", "teamhandbook-task-skills:add-endpoint", "other-kit:review-checklist"].map((n) => skillSource(at, n)));
    const servers = await Promise.all(["postgres", "docs", "plugin_payments-skills_ledger", "tracker", "nobody"].map((n) => mcpSource(at, n)));

    // then
    expect(skills).toEqual([
      { source: "yours", sourceLabel: "Yours" },
      { source: `folder:${at.folder}`, sourceLabel: "notes" },
      { source: "plugin:payments-skills@acme-handbook", sourceLabel: "payments-skills 1.4.0", version: "1.4.0" },
      { source: "team:lending-skills", sourceLabel: "lending-skills" },
      { source: "unknown", sourceLabel: "unknown" },
      // Called by a plugin's name, a skill is that plugin's, whatever the person keeps under the same name; the team's
      // reach a task as a plugin of the task's own; and one of a plugin nobody has is never read as the person's.
      { source: "plugin:payments-skills@acme-handbook", sourceLabel: "payments-skills 1.4.0", version: "1.4.0" },
      { source: "team:lending-skills", sourceLabel: "lending-skills" },
      { source: "unknown", sourceLabel: "unknown" },
    ]);
    expect(servers.map((s) => s.source)).toEqual(["yours", `folder:${at.folder}`, "plugin:payments-skills@acme-handbook", "team:lending-skills", "unknown"]);
  });

  it("given whole sources and single picks turned off, when the launch's names are read, then a plugin is turned off whole and each other source's skills and servers by name", async () => {
    // given
    const at = place();

    // when
    const off = await offNames(at, { sources: ["plugin:payments-skills@acme-handbook", "yours", `folder:${at.folder}`, "team:lending-skills"], skills: [{ source: "unknown", name: "one-more" }, { source: "plugin:docs-kit@acme-handbook", name: "add-endpoint" }], mcpServers: [] });

    // then
    expect(off.plugins).toEqual(["payments-skills@acme-handbook"]);
    expect(off.skills.sort()).toEqual(["add-endpoint", "docs-kit:add-endpoint", "one-more", "release-notes", "review-checklist"]);
    expect(off.mcpServers.sort()).toEqual(["docs", "postgres", "tracker"]);
  });

  it("given a reading whose sources carry descriptions and what their hooks run, when a task keeps it, then it keeps the names alone", () => {
    // given
    const read = [{ id: "plugin:docs-kit@acme-handbook", kind: "plugin" as const, name: "docs-kit", version: "2.0.0", marketplace: "acme-handbook", enabled: true, skills: [{ name: "write-docs", description: "Use when writing docs." }], commands: [{ name: "standup" }], mcpServers: [{ name: "ledger" }], hooks: [{ name: "PreToolUse", commands: ["sh check.sh --token planted-value"] }] }];

    // when
    const kept = setupOf(read);

    // then
    expect(kept).toEqual([{ id: "plugin:docs-kit@acme-handbook", kind: "plugin", name: "docs-kit", version: "2.0.0", marketplace: "acme-handbook", enabled: true, skills: [{ name: "write-docs" }], commands: [{ name: "standup" }], mcpServers: [{ name: "ledger" }], hooks: [{ name: "PreToolUse" }] }]);
    expect(JSON.stringify(kept)).not.toContain("planted-value");
  });

  it("given a use kept twice and one from another source, when they are added, then each name and source is kept once", () => {
    // when
    const first = withUse(undefined, "skills", "add-endpoint", { source: "team:lending-skills", sourceLabel: "lending-skills" })!;
    const again = withUse(first, "skills", "add-endpoint", { source: "team:lending-skills", sourceLabel: "lending-skills" });
    const other = withUse(first, "skills", "add-endpoint", { source: "yours", sourceLabel: "Yours" })!;

    // then
    expect(again).toBeNull();
    expect(other.skills.map((s) => s.source)).toEqual(["team:lending-skills", "yours"]);
  });

  it("given a person's own list and a start's, when they are held against each other, then each item only one of the two holds counts once, a whole source among them, and the same lists count nothing", () => {
    // given
    const own = { skills: [{ source: "yours", name: "review-checklist" }], commands: [{ source: "yours", name: "deploy-check" }], mcpServers: [] };
    const sent = { sources: ["plugin:payments-skills@acme-handbook"], skills: [{ source: "yours", name: "review-checklist" }], mcpServers: [{ source: "yours", name: "docs" }] };

    // then
    expect([offChanges(sent, own), offChanges({ sources: [], ...own }, own), offChanges(undefined, own)]).toEqual([3, 0, 2]);
  });

  it("given a use whose line was written before its source was read and one whose source was read first, when the other half arrives, then each holds its source and the line of its first call alone", () => {
    // given
    const yours = { source: "yours", sourceLabel: "Yours" };

    // when
    const lineFirst = withUse(withUseAt(undefined, "skills", "review-checklist", 7)!, "skills", "review-checklist", yours);
    const sourceFirst = withUseAt(withUse(undefined, "mcpServers", "docs", yours)!, "mcpServers", "docs", 9);

    // then
    expect(lineFirst).toEqual({ skills: [{ name: "review-checklist", ...yours, seq: 7 }], mcpServers: [] });
    expect(sourceFirst).toEqual({ skills: [], mcpServers: [{ name: "docs", ...yours, seq: 9 }] });
    expect(withUseAt(sourceFirst!, "mcpServers", "docs", 12)).toBeNull();
    expect(withUse(sourceFirst!, "mcpServers", "docs", { source: "unknown", sourceLabel: "unknown" })).toBeNull();
  });

  it("given log lines, when each is read for the call it starts, then a skill's and a server's started calls are named and a finished call, another tool and a plain line are not", () => {
    // then
    expect([
      calledIn("tool_call", { tool: "Skill", target: "review-checklist", status: "started" }),
      calledIn("tool_call", { tool: "mcp__docs__search", target: null, status: "started", mcp: { server: "docs", tool: "search" } }),
      calledIn("tool_call", { tool: "Skill", target: "review-checklist", status: "done" }),
      calledIn("tool_call", { tool: "Read", target: "notes.md", status: "started" }),
      calledIn(undefined, null),
    ]).toEqual([{ kind: "skills", name: "review-checklist" }, { kind: "mcpServers", name: "docs" }, null, null, null]);
  });

  it("given a person's setup and a run that leaves out a plugin, a skill and a server of theirs, when what it starts with is counted, then the plugin goes with the commands and the server it brings, and a run that leaves nothing out counts all of it", () => {
    // given
    const setup = {
      commands: ["review-checklist", "deploy-check", "deploy-kit:rollout"].map((name) => ({ name, description: "", argumentHint: "" })),
      plugins: [
        { name: "deploy-kit", marketplace: "acme-tools", version: "1.2.0", enabled: true, scope: "user" },
        { name: "docs-kit", marketplace: "acme-tools", version: "2.0.0", enabled: true, scope: "user" },
      ],
      mcpServers: [
        { name: "docs", kind: "http" as const, scope: "user" as const, asksForValue: false },
        { name: "jira", kind: "http" as const, scope: "user" as const, asksForValue: true },
        { name: "deploys", kind: "unknown" as const, scope: "plugin" as const, asksForValue: null, plugin: "deploy-kit@acme-tools" },
      ],
      claudeMd: true,
    };

    // then
    expect(loadedWithout(setup, { plugins: ["deploy-kit@acme-tools"], skills: ["review-checklist"], mcpServers: ["jira"] })).toEqual({ commands: 1, plugins: 1, mcpServers: 1, claudeMd: true });
    expect(loadedWithout(setup)).toEqual({ commands: 3, plugins: 2, mcpServers: 3, claudeMd: true });
  });

  it("given what an agent said it loaded, a name with a control character among them and a kind it did not report, when it is kept, then the good names stay with each server's state and the unreported kind stays unreported", () => {
    // when
    const kept = startedWithOf({ plugins: ["docs-kit@acme-tools", "bad\u0007name"], skills: null, mcpServers: [{ name: "docs", state: "connected" }, { name: "jira", state: "needs-sign-in" }] });

    // then
    expect(kept).toEqual({ plugins: ["docs-kit@acme-tools"], skills: null, mcpServers: [{ name: "docs", state: "connected" }, { name: "jira", state: "needs-sign-in" }] });
  });
});
