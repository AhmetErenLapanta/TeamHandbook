import type { MemberConfig } from "../../../shared/member-config";

/** One thing a draft changes for a member: taken from their sessions, or kept from starting a task. */
export interface DraftEffect { what: string; reason: string }

/** What the draft adds to a member's configuration: each removal or refusal that is new in `after`. */
export function draftEffects(before: MemberConfig, after: MemberConfig): DraftEffect[] {
  const effects: DraftEffect[] = [];
  for (const repo of after.repos) {
    const was = before.repos.find((r) => r.repoId === repo.repoId);
    for (const skill of repo.skills) {
      if (skill.removedBy && !was?.skills.find((s) => s.slug === skill.slug)?.removedBy) effects.push({ what: `The skill ${skill.slug} in ${repo.name}`, reason: skill.removedBy.reason });
    }
    for (const server of repo.mcpServers) {
      const prior = was?.mcpServers.find((m) => m.name === server.name);
      if (server.removedBy && !prior?.removedBy) effects.push({ what: `The MCP server ${server.name} in ${repo.name}`, reason: server.removedBy.reason });
      for (const tool of server.tools) {
        if (!prior?.tools.some((t) => t.resource === tool.resource)) effects.push({ what: `The tool ${tool.tool} on ${server.name} in ${repo.name}`, reason: tool.reason });
      }
    }
    for (const tool of repo.tools) {
      if (!was?.tools.some((t) => t.resource === tool.resource)) effects.push({ what: `${tool.resource.replace(/^tool:/, "")} in ${repo.name}`, reason: tool.reason });
    }
  }
  for (const task of after.tasks) {
    if (task.refusal && !before.tasks.find((t) => t.repoId === task.repoId)?.refusal) effects.push({ what: `Starting a task on ${task.name}`, reason: task.refusal });
  }
  return effects;
}
