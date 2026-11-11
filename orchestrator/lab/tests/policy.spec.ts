import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { callTool, pluginMcpTool, sessionStart, updateMarketplace } from "../machine.js";
import type { Machine } from "../machine.js";
import { ORGS } from "../orgs.js";
import type { LabRepo } from "../state.js";
import { commitOf, commitOnDefault, fileAt, lab, pluginName, SHAPES, teammateOn, unique } from "./support.js";

/** Whether the plugin in this tree registers a PreToolUse hook at all: the team policy's half on a teammate's machine. */
const registered = Boolean((JSON.parse(readFileSync(join(lab.pluginDist, "..", "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, unknown> }).hooks.PreToolUse);

interface Rule {
  action: string;
  resource: string;
  effect: string;
  reason: string;
}

const teamFile = (repo: LabRepo) => JSON.parse(fileAt(repo, "HEAD", ".teamhandbook.json")!) as Record<string, unknown>;
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** A merge elsewhere that sets the team's policies, then the teammate's marketplace update; returns the commit that carries it. */
function mergePolicy(repo: LabRepo, m: Machine, rules: Rule[] | unknown, subject: string): string {
  const policies = Array.isArray(rules) ? (rules.length ? [{ id: "lab-policy", name: "Lab policy", rules }] : []) : rules;
  commitOnDefault(repo, { ".teamhandbook.json": json({ ...teamFile(repo), policies }) }, subject);
  updateMarketplace(m);
  return commitOf(repo, "HEAD", "%H");
}

/** One MCP server the team ships, or a name for one when it ships none: a policy names a server whether or not it is there. */
function serverOf(repo: LabRepo): { server: string; tool: string } {
  const servers = Object.keys((JSON.parse(fileAt(repo, "HEAD", ".mcp.json") ?? "{}") as { mcpServers?: Record<string, unknown> }).mcpServers ?? {});
  return { server: servers[0] ?? "tracker", tool: "getIssue" };
}

test.describe("the team's policy on a teammate's machine", () => {
  test.skip(!registered, "the plugin registers no PreToolUse hook yet");

  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when a merge adds a policy that denies one MCP tool and one skill, then the plugin's own hook blocks those, naming the reason and the commit, lets another tool and skill run, and once a merge removes it both run again`, async () => {
      // given a team file with no policy, whatever an earlier run left
      const m = teammateOn(org, repo);
      if (Array.isArray(teamFile(repo).policies) && (teamFile(repo).policies as unknown[]).length) mergePolicy(repo, m, [], "chore: lift a policy left behind");
      updateMarketplace(m);
      const plugin = pluginName(repo);
      const { server, tool } = serverOf(repo);
      const skill = ORGS.find((o) => o.name === org.name)!.teams.find((t) => t.id === repo.id)!.skills[0]!.slug;
      const mcpName = pluginMcpTool(plugin, server, tool);
      const otherMcp = pluginMcpTool(plugin, server, "listIssues");
      const session = unique("session");
      const reason = `${unique("Retired")} while the vendor contract is reviewed`;

      // before: nothing is blocked
      expect(callTool(m, session, mcpName, {}, { name: `plugin:${plugin}:${server}`, source: "plugin" }).denied).toBeNull();
      expect(callTool(m, session, "Skill", { skill: `${plugin}:${skill}` }).denied).toBeNull();

      // when a merge adds the policy
      try {
        const sha = mergePolicy(
          repo,
          m,
          [
            { action: "mcp.use", resource: `mcp:${server}/${tool}`, effect: "deny", reason },
            { action: "skill.use", resource: `skill:${skill}`, effect: "deny", reason },
          ],
          "chore: add the team's policy",
        );

        // then the denied tool and skill are blocked, by the plugin's hook, naming why and where it came from
        const blockedMcp = callTool(m, session, mcpName, {}, { name: `plugin:${plugin}:${server}`, source: "plugin" });
        const blockedSkill = callTool(m, session, "Skill", { skill: `${plugin}:${skill}` });
        for (const blocked of [blockedMcp, blockedSkill]) {
          expect(blocked.denied).toContain(`Blocked by the team's policy: ${reason}`);
          expect(blocked.denied).toMatch(new RegExp(`, added in ${sha.slice(0, 7)}[0-9a-f]*\\)\\.$`));
        }
        test.info().annotations.push({ type: "measured", description: `PreToolUse took ${blockedMcp.ms} ms and ${blockedSkill.ms} ms` });
        expect(Math.max(blockedMcp.ms, blockedSkill.ms)).toBeLessThan(1000);

        // and the rule holds a skill of that name from anywhere, while another tool of the same server and another skill run
        expect(callTool(m, session, "Skill", { skill }).denied).toContain(reason);
        expect(callTool(m, session, otherMcp, {}, { name: `plugin:${plugin}:${server}`, source: "plugin" }).denied).toBeNull();
        expect(callTool(m, session, "Skill", { skill: `${plugin}:${unique("other-skill")}` }).denied).toBeNull();

      } finally {
        // when a merge removes the policy
        mergePolicy(repo, m, [], "chore: lift the team's policy");
      }

      // then both run again
      expect(callTool(m, session, mcpName, {}, { name: `plugin:${plugin}:${server}`, source: "plugin" }).denied).toBeNull();
      expect(callTool(m, session, "Skill", { skill: `${plugin}:${skill}` }).denied).toBeNull();
    });
  }

  test("given a teammate whose copy held a valid policy, when a merge breaks the policy's file, then the last valid policy still holds and the teammate is warned; with no valid policy ever, nothing is blocked and the teammate is warned", async () => {
    // given
    const { org, repo } = SHAPES[0]!;
    const m = teammateOn(org, repo);
    const plugin = pluginName(repo);
    const { server, tool } = serverOf(repo);
    const mcpName = pluginMcpTool(plugin, server, tool);
    const reason = unique("Held back");
    mergePolicy(repo, m, [{ action: "mcp.use", resource: `mcp:${server}/${tool}`, effect: "deny", reason }], "chore: add the team's policy");
    expect(callTool(m, unique("session"), mcpName, {}).denied).toContain(reason);

    try {
      // when a merge leaves a policy the plugin cannot read
      mergePolicy(repo, m, "deny everything", "chore: a broken policy");

      // then the last valid one holds, and the session starts by saying so
      expect(callTool(m, unique("session"), mcpName, {}).denied).toContain(reason);
      expect(sessionStart(m, unique("session"))).toMatch(/The team's policy as last read on \d{4}-\d{2}-\d{2} stays in force \(1 rule\(s\)\)/);

      // given a teammate who never had a valid policy
      const newcomer = teammateOn({ ...org, developers: [] }, repo);

      // then nothing is blocked, and the session starts by saying so
      expect(callTool(newcomer, unique("session"), mcpName, {}).denied).toBeNull();
      expect(sessionStart(newcomer, unique("session"))).toContain("No valid policy was read on this machine before, so nothing is blocked");
    } finally {
      mergePolicy(repo, m, [], "chore: lift the team's policy");
    }
  });
});
