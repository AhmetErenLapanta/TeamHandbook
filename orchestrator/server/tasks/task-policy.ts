import { resolve } from "node:path";
import { teamFile } from "../changes.js";
import type { TeamSetup } from "../inventory.js";
import { mcpToolPart, policiesProblem, policyDenial, policyRules } from "../plugin.js";
import type { PolicyRule, TeamFilePolicy } from "../plugin.js";
import { shadowUndo } from "../shadow-git.js";
import type { ShadowPlace } from "../shadow-git.js";
import type { McpTool } from "./agents.js";

/** The file tools a task's agent has, each of which a policy can take away whole. */
const FILE_TOOLS = ["Read", "Edit", "Glob", "Grep"] as const;

/**
 * The team's policies as the repository holds them at the commit the task checks out. A file
 * whose policies a teammate's plugin would not read refuses the task rather than run the
 * agent with nothing held back: the orchestrator keeps no earlier copy to fall back on.
 */
export async function taskPolicy(mirror: string, baseSha: string): Promise<PolicyRule[] | { refused: string }> {
  const { json } = await teamFile(mirror, baseSha);
  if (json.policies === undefined) return [];
  const problem = policiesProblem(json.policies);
  return problem ? { refused: `the team's policies cannot be read (${problem}), so the agent is not given the team's setup` } : policyRules(json.policies as TeamFilePolicy[]);
}

/**
 * The team's setup with what the policies take away left out, by the same matching a
 * teammate's session uses: a denied skill is not installed, a denied MCP tool is not allowed,
 * and a file tool denied whole is not given. A rule on some paths of a file tool is held at
 * the end instead, on the files the agent changed; one on reading some paths cannot be held
 * that way, and the log says so.
 */
export function narrowSetup(rules: readonly PolicyRule[], team: TeamSetup, allowed: readonly McpTool[]): { team: TeamSetup; allowed: McpTool[]; deniedTools: string[]; notes: string[] } {
  if (!rules.length) return { team, allowed: [...allowed], deniedTools: [], notes: [] };
  const notes: string[] = [];
  const skills = team.skills.filter((s) => !policyDenial(rules, { tool_name: "Skill", tool_input: { skill: s.slug } }));
  const droppedSkills = team.skills.filter((s) => !skills.includes(s)).map((s) => s.slug);
  if (droppedSkills.length) notes.push(`Left out by the team's policies, skills: ${droppedSkills.join(", ")}.`);
  const kept = allowed.filter((t) => !policyDenial(rules, { tool_name: `mcp__${mcpToolPart(t.server)}__${mcpToolPart(t.tool)}`, tool_input: {} }));
  const droppedTools = allowed.filter((t) => !kept.includes(t)).map((t) => `${t.server}/${t.tool}`);
  if (droppedTools.length) notes.push(`Left out by the team's policies, MCP tools: ${droppedTools.join(", ")}.`);
  const deniedTools = FILE_TOOLS.filter((tool) => rules.some((r) => r.resource === `tool:${tool}:*`));
  if (deniedTools.length) notes.push(`Left out by the team's policies, tools: ${deniedTools.join(", ")}.`);
  const unheld = rules.filter((r) => /^tool:(Read|Glob|Grep):/.test(r.resource) && !deniedTools.some((t) => r.resource === `tool:${t}:*`));
  if (unheld.length) notes.push(`Not held in a task, the agent reads its own checkout: ${unheld.map((r) => r.resource).join(", ")}.`);
  return { team: { ...team, skills }, allowed: kept, deniedTools, notes };
}

/** The team's reason for refusing the agent's change to a file a policy keeps from being edited, or null. */
export function editRefusal(rules: readonly PolicyRule[], paths: readonly string[], work: string): string | null {
  for (const path of paths) {
    const rule = policyDenial(rules, { tool_name: "Edit", tool_input: { file_path: resolve(work, path) }, cwd: work }) ?? policyDenial(rules, { tool_name: "Edit", tool_input: { file_path: path } });
    if (rule) return `The agent changed ${path}, which the team's policy keeps from being edited: ${rule.reason}. No request was opened.`;
  }
  return null;
}

/**
 * The team's policy on a change made in place, where the edit is already in the folder: a change
 * to a file the policy keeps from being edited is taken back from the shadow, and the task fails
 * saying so. Null when the policy allows every file changed. The same on the orchestrator and on a
 * person's machine, so the two refuse a change alike.
 */
export async function refusedInPlace(rules: readonly PolicyRule[], paths: readonly string[], place: ShadowPlace, before: string, after: string): Promise<{ failed: string; undone: { kept: string[] } | null } | null> {
  const held = editRefusal(rules, paths, place.folder);
  if (!held) return null;
  const undone = await shadowUndo(place, before, after);
  const by = "refused" in undone ? `It could not be undone: ${undone.refused}.` : `Its change was undone${undone.kept.length ? `, except ${undone.kept.join(", ")}, changed again since` : ""}.`;
  return { failed: `${held.replace(/ No request was opened\.$/, "")} ${by}`, undone: "refused" in undone ? null : { kept: undone.kept } };
}
