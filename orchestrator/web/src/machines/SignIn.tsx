import { useEffect, useState } from "react";
import { CopyText } from "../Confirm";
import { machinesApi } from "./api";
import type { MachineAgent } from "./api";

export function agentLine(a: MachineAgent): string {
  if (!a.installed) return `${a.label}: not installed`;
  const version = a.version ? ` ${a.version}` : "";
  const update = a.supported === "update" ? ", update it" : a.supported === "unsupported" ? ", too old to run tasks; update it" : "";
  if (a.signIn === "signed-in") return `${a.label}${version}: signed in${update}`;
  if (a.signIn === "signed-out") return `${a.label}${version}: signed out${update}`;
  return `${a.label}${version}: sign-in not known${update}`;
}

/**
 * On one person's own machine, whether the picked agent is signed in there, and the one command
 * that signs it in when it is not. A read that fails says nothing: it informs and never stops a start.
 */
export function SignInLine({ agentId }: { agentId: string }) {
  const [agent, setAgent] = useState<MachineAgent | null>(null);
  useEffect(() => {
    let current = true;
    setAgent(null);
    machinesApi.list().then(
      (r) => current && setAgent(r.machines.find((m) => m.local)?.agents.find((a) => a.id === agentId) ?? null),
      () => current && setAgent(null),
    );
    return () => {
      current = false;
    };
  }, [agentId]);
  if (!agent) return null;
  const signIn = agent.signIn === "signed-out" && agent.signInCommand;
  return (
    <p className={signIn ? "error" : "muted"} role={signIn ? "alert" : "note"} aria-label={`${agent.label} sign-in`}>
      {agentLine(agent)}.
      {signIn ? <> Run <CopyText text={agent.signInCommand!} label={`Copy the sign-in command for ${agent.label}`} /> in a terminal, then start.</> : null}
    </p>
  );
}
