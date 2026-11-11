import type { AgentOption } from "./contract.js";

/**
 * What the orchestrator knows of each agent CLI, kept in the repository and changed only by a
 * commit: the versions each way of driving it was checked against by reading that CLI, and what
 * the task form offers for it. Readiness and the runner's doctor compare an installed CLI with
 * these; nothing here is fetched.
 */
export interface DriverManifest {
  /** The version whose one-shot flags and output the adapter was checked against. */
  checkedVersion: string;
  /** The version a two-way session (stream-json both ways, questions over stdio) was checked against. */
  twoWayVersion?: string;
  /** The version whose behaviour holding the agent to named MCP tools rests on. */
  mcpVersion?: string;
  options: readonly AgentOption[];
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export const MANIFEST = {
  "claude-code": {
    checkedVersion: "2.1.309",
    twoWayVersion: "2.1.316",
    options: [
      // Aliases, each the latest model of its family, so the list stays right as models change.
      { id: "model", label: "Model", choices: [{ value: "fable", label: "Fable" }, { value: "opus", label: "Opus" }, { value: "sonnet", label: "Sonnet" }] },
      { id: "effort", label: "Effort", choices: EFFORTS.map((value) => ({ value, label: value === "xhigh" ? "Extra high" : value[0]!.toUpperCase() + value.slice(1) })) },
    ],
  },
  opencode: {
    checkedVersion: "1.18.31",
    mcpVersion: "1.18.31",
    // A model is any `provider/model` the person's OpenCode knows, so there is no list to offer.
    options: [],
  },
} as const satisfies Record<string, DriverManifest>;
