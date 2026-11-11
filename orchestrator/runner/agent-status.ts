import { execFile } from "node:child_process";
import type { MachineAgentStatus } from "../server/runner-store.js";
import type { AgentAdapter } from "../server/tasks/agents.js";
import { PROBE_TIMEOUT_MS, compare, version } from "../server/tasks/readiness.js";

/** One read-only run of an agent's CLI: what it printed and how it ended; a program that is not there ends with no code. */
export type ProbeRun = (program: string, args: readonly string[]) => Promise<{ code: number | null; stdout: string }>;

const runCli: ProbeRun = (program, args) =>
  new Promise((resolve) => {
    execFile(program, [...args], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: process.env }, (error, stdout) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });

/**
 * What this machine tells the orchestrator about each agent it could run: whether it is there,
 * its version against the one the orchestrator was checked with, and whether it is signed in,
 * in words only. The CLI's own status commands are read-only, and the account's email, its
 * organization and its kind of plan never leave the machine.
 */
export async function agentStatus(adapters: readonly AgentAdapter[], run: ProbeRun = runCli): Promise<MachineAgentStatus[]> {
  return Promise.all(
    adapters.flatMap((adapter) => {
      const probe = adapter.probe;
      if (!probe) return [];
      return [
        (async (): Promise<MachineAgentStatus> => {
          const said = await run(probe.program, ["--version"]);
          const seen = said.code === 0 ? version(said.stdout) : null;
          if (!seen) return { id: adapter.id, installed: false, version: null, supported: "update", signIn: "unknown" };
          const supported = compare(seen, version(probe.checkedVersion)!) < 0 ? "update" : "ok";
          if (!probe.signIn) return { id: adapter.id, installed: true, version: seen.join("."), supported, signIn: "unknown" };
          const status = await run(probe.program, probe.signIn.args);
          const read = status.code === null ? null : probe.signIn.read(status.stdout);
          return { id: adapter.id, installed: true, version: seen.join("."), supported, signIn: read === null ? "unknown" : read.present ? "signed-in" : "signed-out" };
        })(),
      ];
    }),
  );
}
