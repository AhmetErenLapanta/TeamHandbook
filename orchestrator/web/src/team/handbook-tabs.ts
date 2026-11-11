export type HandbookTab = "skills" | "mcp" | "commands";

export const HANDBOOK_TABS: { id: HandbookTab; label: string }[] = [
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP servers" },
  { id: "commands", label: "Commands" },
];
