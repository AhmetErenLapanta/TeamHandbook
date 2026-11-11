import { serverProblem } from "../skill-rules.js";
import type { AgentAdapter, McpTool } from "./agents.js";

/** What of an agent decides whether it gets a team's MCP server in a task. */
export type McpPlacing = Pick<AgentAdapter, "label" | "placesMcp" | "mcpProblem" | "probe">;

export type ServerForAgent =
  | { usable: true; tools: McpTool[] }
  | { usable: false; why: "no-mcp" | "agent-problem" | "no-tool"; detail: string };

/**
 * Whether one shareable server of the team's reaches one agent in a task, and with which
 * tools: the rule a task's setup applies, and the one the readiness check and the repository
 * page report. An agent the orchestrator cannot hold to named tools gets no server; one whose
 * adapter refuses a definition gets none of that one; and a server none of whose tools the
 * repository's `mcpTools` names is not placed, since an agent starts every server it is given.
 */
export function serverForAgent(name: string, server: Record<string, unknown>, allowed: readonly McpTool[], agent: McpPlacing): ServerForAgent {
  if (!agent.placesMcp) {
    return { usable: false, why: "no-mcp", detail: `${agent.label} gets no MCP server${agent.probe?.mcpSetting ? ` without ${agent.probe.mcpSetting}` : ", as it cannot be held to named tools"}` };
  }
  const problem = agent.mcpProblem?.(name, server) ?? null;
  if (problem) return { usable: false, why: "agent-problem", detail: `left out for ${agent.label}: ${problem}` };
  const tools = allowed.filter((t) => t.server === name);
  if (!tools.length) return { usable: false, why: "no-tool", detail: "no tool of it is allowed for tasks; name one in the repository's mcpTools in orchestrator.json" };
  return { usable: true, tools };
}

/** A remote server whose headers name no credential, so the server's own sign-in is all it has. */
function signsInByBrowser(server: Record<string, unknown>): boolean {
  if (typeof server.url !== "string") return false;
  const headers = server.headers;
  const values = headers && typeof headers === "object" && !Array.isArray(headers) ? Object.values(headers) : [];
  return !values.some((v) => typeof v === "string" && v.includes("${"));
}

/** One server as a task sees it; `signIn` marks a usable server that sends no credential. */
export interface McpInTask {
  usable: boolean;
  detail: string;
  signIn: boolean;
}

/**
 * Each server of a team's `.mcp.json` as a task sees it, for the repository's page: usable
 * when the share rule lets it travel and at least one offered agent gets it with a named tool.
 * A remote server that sends no credential is usable only if it asks for no sign-in, which
 * nothing here can tell; the detail says so and `signIn` carries it rather than guessing either way.
 */
export function mcpInTasks(agents: readonly McpPlacing[], allowed: readonly McpTool[], servers: Record<string, unknown>): Record<string, McpInTask> {
  const verdicts: Record<string, McpInTask> = {};
  for (const [name, config] of Object.entries(servers)) {
    const shared = serverProblem(name, config);
    if ("refused" in shared) {
      verdicts[name] = { usable: false, detail: shared.refused, signIn: false };
      continue;
    }
    const server = config as Record<string, unknown>;
    const each = agents.map((agent) => ({ agent, verdict: serverForAgent(name, server, allowed, agent) }));
    const usable = each.filter((e) => e.verdict.usable);
    const notUsable = [...new Set(each.flatMap((e) => (e.verdict.usable ? [] : [e.verdict.detail])))];
    if (!usable.length) {
      verdicts[name] = { usable: false, detail: notUsable.join("; ") || "no agent is offered for tasks", signIn: false };
      continue;
    }
    const tools = (usable[0]!.verdict as { tools: McpTool[] }).tools.map((t) => t.tool);
    const parts = [`${tools.join(", ")} for ${usable.map((e) => e.agent.label).join(" and ")}`, ...notUsable];
    const signIn = signsInByBrowser(server);
    if (signIn) parts.push("it sends no credential, so a server that asks for a sign-in fails in a task: nobody is there to finish one in a browser");
    verdicts[name] = { usable: true, detail: parts.join("; "), signIn };
  }
  return verdicts;
}
