/** Claude Code's hook events in the words a person reads them; an event not listed is shown by its own name. */
const WHEN: Record<string, string> = {
  PreToolUse: "before each tool call",
  PostToolUse: "after each tool call",
  UserPromptSubmit: "on each prompt",
  SessionStart: "when a session starts",
  SessionEnd: "when a session ends",
  Stop: "when the agent stops",
  SubagentStop: "when a subagent stops",
  Notification: "on each notification",
  PreCompact: "before the conversation is compacted",
};

export const whenOf = (event: string) => WHEN[event] ?? event;

const counted = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : null);

/** "1 hook (after each tool call) and 1 MCP server": what a plugin runs, in one phrase; empty when it runs neither. */
export function runsSaid(hooks: { name: string }[], mcpServers: string[]): string {
  const events = hooks.length ? ` (${hooks.map((h) => whenOf(h.name)).join(", ")})` : "";
  return [hooks.length ? `${counted(hooks.length, "hook", "hooks")}${events}` : null, counted(mcpServers.length, "MCP server", "MCP servers")].filter(Boolean).join(" and ");
}

/**
 * What a plugin runs, named before a press installs or updates it: each hook's event with its commands as the
 * orchestrator shows them (a secret withheld, the rest masked and cut) and each MCP server by name.
 */
export function PluginRuns({ hooks, mcpServers }: { hooks: { name: string; commands: string[] }[]; mcpServers: string[] }) {
  if (!hooks.length && !mcpServers.length) return null;
  return (
    <dl className="plugin-changes">
      {hooks.length ? (
        <>
          <dt>Hooks</dt>
          <dd>{hooks.map((h) => <div key={h.name}>{whenOf(h.name)}: <span className="mono">{h.commands.join("; ") || "no command"}</span></div>)}</dd>
        </>
      ) : null}
      {mcpServers.length ? <><dt>MCP servers</dt><dd className="mono">{mcpServers.join(", ")}</dd></> : null}
    </dl>
  );
}
