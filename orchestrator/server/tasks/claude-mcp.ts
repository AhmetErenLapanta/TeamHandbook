/** The changes to a person's own MCP servers the orchestrator makes with Claude Code's own command, at their click. */
const MCP_COMMANDS = new Set(["add", "remove"]);
export const MCP_COMMAND_MS = 60_000;

/** Whether arguments are a change this orchestrator makes: `mcp add ...` or `mcp remove ...`, as Claude Code takes them. */
export const mcpChange = (args: readonly string[]): boolean => args[0] === "mcp" && MCP_COMMANDS.has(args[1] ?? "");
