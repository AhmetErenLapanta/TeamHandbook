import { call } from "../api";

/** One agent CLI on a machine, as the runner's read-only probe found it; no account detail leaves the machine. */
export interface MachineAgent {
  id: string;
  label: string;
  installed: boolean;
  version: string | null;
  /** "unsupported": below the lowest version the runner drives. */
  supported: "ok" | "update" | "unsupported";
  signIn: "signed-in" | "signed-out" | "unknown";
  /** What to run on that machine to sign in, when signed out. */
  signInCommand: string | null;
}

/** A machine that runs its person's tasks; on a local orchestrator the one row is this machine. */
export interface Machine {
  id: string;
  name: string;
  platform: string;
  runnerVersion: string | null;
  lastSeenAt: string | null;
  online: boolean;
  /** Holding back while on battery, until it is plugged in or the person says go. */
  paused: boolean;
  local: boolean;
  /** The person it belongs to, shown to an admin reading everyone's. */
  owner?: string;
  agents: MachineAgent[];
}

export const machinesApi = {
  list: () => call<{ machines: Machine[] }>("GET", "/api/machines"),
  pair: () => call<{ code: string; expiresAt: string; command: string }>("POST", "/api/machines/pair"),
  remove: (id: string) => call<unknown>("DELETE", `/api/machines/${encodeURIComponent(id)}`),
};
