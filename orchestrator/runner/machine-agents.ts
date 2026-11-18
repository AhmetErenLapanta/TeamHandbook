import { claudeCodeAdapter, opencodeAdapter } from "../server/tasks/agents.js";
import type { AgentAdapter } from "../server/tasks/agents.js";
import type { AgentOption } from "../server/tasks/adapters/contract.js";
import type { MachineAgentStatus } from "../server/runner-store.js";
import type { PermissionMode } from "../shared/permission-mode.js";

export interface AgentOffer {
  id: string;
  label: string;
  modes: readonly PermissionMode[];
  options: readonly AgentOption[];
  questions: boolean;
  /** It can start by planning and put the plan to its person before it changes anything. */
  plan: boolean;
}

export function machineAdapters(env: Record<string, string | undefined> = {}): AgentAdapter[] {
  return [claudeCodeAdapter(env.ORCHESTRATOR_CLAUDE_BIN || "claude"), opencodeAdapter(env.ORCHESTRATOR_OPENCODE_BIN || "opencode")];
}

export function offerOf(agent: AgentAdapter, personal: boolean): AgentOffer {
  const modes = (agent.twoWay ? agent.twoWay.capabilities : agent.capabilities).permissionModes.filter((mode) => !personal || mode !== "full-access");
  return { id: agent.id, label: agent.label, modes, options: agent.capabilities.options, questions: agent.twoWay?.capabilities.questions === true, plan: agent.twoWay?.capabilities.plan === true };
}

export interface MachineReadiness {
  ready: boolean;
  state: "ready" | "warnings" | "not-ready";
  first: string | null;
  code: string | null;
  fix: string | null;
}

export function machineOffers(reported: readonly MachineAgentStatus[]): (AgentOffer & { signIn: MachineAgentStatus["signIn"]; readiness: MachineReadiness })[] {
  return machineAdapters().flatMap((agent) => {
    const seen = reported.filter((r) => r.id === agent.id && r.installed);
    if (!seen.length) return [];
    const signIn = seen.some((r) => r.signIn === "signed-in") ? "signed-in" : seen.some((r) => r.signIn === "unknown") ? "unknown" : "signed-out";
    const current = seen.some((r) => r.supported === "ok");
    const readiness: MachineReadiness =
      signIn === "signed-out"
        ? { ready: false, state: "not-ready", first: "not signed in on your machine", code: "signin-missing", fix: agent.probe?.signInCommand ?? null }
        : current
          ? { ready: true, state: "ready", first: null, code: null, fix: null }
          : { ready: true, state: "warnings", first: "version older than checked on your machine", code: "version-older", fix: agent.probe?.updateCommand ?? null };
    return [{ ...offerOf(agent, true), signIn, readiness }];
  });
}
