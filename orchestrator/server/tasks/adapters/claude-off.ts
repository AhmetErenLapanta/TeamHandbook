import type { AgentOff } from "./contract.js";

/**
 * What a task leaves out of Claude Code, in the task's own settings layer, which outranks the
 * person's user settings key by key (2.1.322: user < project < local < flag < policy): a plugin
 * switched off, a skill or command of their own hidden from the model and from `/name`, and an MCP
 * server never connected. A plugin's skill cannot be hidden this way and is refused instead
 * (claudeOffDenies).
 */
export function claudeOffSettings(off: AgentOff): Record<string, unknown> {
  const own = off.skills.filter((name) => !name.includes(":"));
  return {
    ...(off.plugins.length ? { enabledPlugins: Object.fromEntries(off.plugins.map((id) => [id, false])) } : {}),
    ...(own.length ? { skillOverrides: Object.fromEntries(own.map((name) => [name, "off"])) } : {}),
    ...(off.mcpServers.length ? { deniedMcpServers: off.mcpServers.map((serverName) => ({ serverName })) } : {}),
  };
}

/** The deny rules that refuse what a task leaves out, beside its settings: a skill or command called anyway, and any tool of a server left out. */
export function claudeOffDenies(off: AgentOff): string[] {
  return [...off.skills.map((name) => `Skill(${name})`), ...off.mcpServers.map((server) => `mcp__${server}__*`)];
}

/** Whether a call is to something the task leaves out: a skill or command by its name, or any tool of a server left out. Such a call is refused with no question. */
export function claudeOffCall(off: AgentOff | undefined, tool: string, input: Record<string, unknown>): boolean {
  if (!off) return false;
  if (tool === "Skill") return typeof input.skill === "string" && off.skills.includes(input.skill);
  return off.mcpServers.some((server) => tool.startsWith(`mcp__${server}__`));
}
