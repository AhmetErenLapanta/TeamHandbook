import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { tasksApi } from "./api";
import type { Readiness, TaskOptions } from "./api";
import { useAgents } from "./setup-steps";
import { here } from "./router";

/** The first check that failed for an agent, from the readiness report. */
export function failing(report: Readiness | null, id: string): { name: string; detail: string } | null {
  return report?.agents.find((a) => a.id === id)?.checks.find((c) => c.status === "fail") ?? null;
}

/** What each agent is started with in a terminal to sign in. */
const SIGN_IN: Record<string, string> = { "claude-code": "claude", opencode: "opencode auth login" };

/**
 * What the person does next for an agent that is not ready, in their words rather than the
 * check's: install it, sign it in, update it, or look closer on Agent readiness.
 */
export function nextStep(label: string, id: string, check: { name: string } | null): ReactNode {
  if (check?.name === "Program") return <>{label} is not on this machine. Install it, then press Check again.</>;
  if (check?.name === "Version") return <>{label} is older than this orchestrator works with. Update it, then press Check again.</>;
  if (check && /^(Sign-in|Credential)/.test(check.name)) return <>{label} is not signed in. Open a terminal, type <code>{SIGN_IN[id] ?? label}</code> and sign in, then press Check again.</>;
  return <>{label} is not ready yet; <a href={here("settings", "agents")}>Agent readiness</a> shows each check.</>;
}

/** The agent a person is told about when none is ready: an installed one before one that is not on the machine. */
function firstToFix(agents: TaskOptions["agents"], report: Readiness | null): TaskOptions["agents"][number] | undefined {
  return agents.find((a) => failing(report, a.id)?.name !== "Program") ?? agents[0];
}

/**
 * One line for the task box on one person's orchestrator: nothing while the check runs or once an
 * agent is ready, otherwise what to do for it and Check again. It informs; it never stops a start.
 */
export function AgentLine() {
  const [agents, readAgents] = useAgents(true);
  // Why an agent is not ready, check by check; asked afresh when the person says they fixed it.
  const [report, setReport] = useState<Readiness | null>(null);
  const readReport = (fresh: boolean) => {
    tasksApi.readiness(fresh).then(setReport, () => setReport(null));
  };
  useEffect(() => readReport(false), []);
  if (!agents || agents.some((a) => a.readiness?.ready) || agents.every((a) => !a.readiness)) return null;
  const agent = firstToFix(agents, report);
  if (!agent) return null;
  const check = () => {
    readReport(true);
    readAgents();
  };
  return (
    <p role="status">
      {nextStep(agent.label, agent.id, failing(report, agent.id))} <button type="button" className="secondary small" onClick={check}>Check again</button>
    </p>
  );
}
