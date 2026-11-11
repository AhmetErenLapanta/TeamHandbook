import type { OrchestratorContext } from "../app.js";
import { mirrorDir } from "../app.js";
import { buildChange, MCP_FILE } from "../changes.js";
import type { BuiltChange } from "../changes.js";
import type { RequestRecord } from "../forge/types.js";
import { gitAsyncMaybe } from "../git.js";
import { declaredServers } from "../plugin.js";
import type { RepoRecord } from "../store.js";
import { readEnabled } from "./records.js";

/** The name the orchestrator's MCP server goes by in a team's .mcp.json. */
export const ORCHESTRATOR_MCP_SERVER = "teamhandbook-orchestrator";
export const MCP_PATH = "/mcp";

export const orchestratorMcpId = (repoId: string) => `orchestrator-mcp.${repoId}`;

/**
 * The server as the team's .mcp.json declares it: this orchestrator's address and nothing else. The
 * first time a teammate's Claude Code calls it, the orchestrator answers with where to sign in, and
 * the teammate approves it in the browser as themselves; no key is created or copied, and none
 * sits in a file. An entry from before, naming a key's variable, keeps working.
 */
export function orchestratorMcpEntry(publicUrl: string): Record<string, unknown> {
  return { type: "http", url: `${publicUrl.replace(/\/+$/, "")}${MCP_PATH}` };
}

/** The change that turns the orchestrator's MCP server on for a team: the same server addition a person proposes, so it is checked by the same rule. */
export async function orchestratorMcpChange(mirror: string, head: string, publicUrl: string): Promise<BuiltChange> {
  const built = await buildChange(mirror, head, { kind: "mcp.add", name: ORCHESTRATOR_MCP_SERVER, config: orchestratorMcpEntry(publicUrl) });
  return {
    ...built,
    proposal: "feat(mcp): add the TeamHandbook Orchestrator server",
    topic: "orchestrator-mcp",
    body: [
      ...built.body,
      "",
      "Once this is merged, each teammate's Claude Code reaches the orchestrator through it. Everyone reads their teams, the requests waiting to be merged and their own tasks; a team's owner can also propose changes and start tasks, and every call is written to the orchestrator's event log. Nothing it does merges a request.",
      "",
      "The first time a teammate's Claude Code uses it, it opens the orchestrator in their browser to approve it as themselves; nothing is created or copied by hand.",
    ],
  };
}

export interface OrchestratorMcpRepo {
  repoId: string;
  name: string;
  team: string;
  state: "off" | "requested" | "connected";
  request: Pick<RequestRecord, "number" | "url" | "status"> | null;
  enabledBy: string | null;
  enabledAt: string | null;
}

/** The request the orchestrator opened to turn the server on, as the record keeps it. */
export interface OrchestratorMcpRecord {
  number: number;
}

/**
 * Where one repository stands: connected once the head the orchestrator read declares the server,
 * requested while the request the orchestrator opened for it is open, otherwise off. A team that
 * declared it by hand counts as connected, with nobody named for it.
 */
export async function orchestratorMcpRepo(ctx: OrchestratorContext, repo: RepoRecord): Promise<OrchestratorMcpRepo> {
  const record = await readEnabled<OrchestratorMcpRecord>(ctx, orchestratorMcpId(repo.id));
  const request = record ? await ctx.store.getRequest(ctx.tenant, repo.id, record.config.number) : null;
  const declared = repo.head ? Object.hasOwn(declaredServers(await gitAsyncMaybe(["show", `${repo.head}:${MCP_FILE}`], mirrorDir(ctx, repo.id))), ORCHESTRATOR_MCP_SERVER) : false;
  const state = declared ? "connected" : request?.status === "open" ? "requested" : "off";
  const shown = state !== "off" && record;
  return {
    repoId: repo.id,
    name: repo.name,
    team: repo.team,
    state,
    request: request && state !== "off" ? { number: request.number, url: request.url, status: request.status } : null,
    enabledBy: shown ? record.enabledBy : null,
    enabledAt: shown ? record.enabledAt : null,
  };
}
