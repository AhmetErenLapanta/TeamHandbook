import { call } from "../api";
import type { Proposal } from "../api";

/** One of the person's own skills, servers or commands, as the team repository would take it. */
export interface OwnItem {
  name: string;
  description: string;
  /** The team already carries the name, so ticking it updates the team's copy. */
  inTeam: boolean;
  addable: boolean;
  why?: string;
}

export type OwnHandbook = { available: true; skills: OwnItem[]; mcpServers: OwnItem[]; commands: OwnItem[] } | { available: false; why: string };

/** The names picked from each of the three lists. */
export interface Picked {
  skills: string[];
  mcpServers: string[];
  commands: string[];
}

export const handbookApi = {
  own: (repoId: string) => call<OwnHandbook>("GET", `/api/handbook/own?repo=${encodeURIComponent(repoId)}`),
  proposal: (repoId: string, picked: Picked) => call<Proposal>("POST", `/api/repos/${encodeURIComponent(repoId)}/handbook/proposal`, picked),
  propose: (repoId: string, picked: Picked, message: string, branch: string, baseSha: string) =>
    call<{ request: { number: number; url: string } }>("POST", `/api/repos/${encodeURIComponent(repoId)}/handbook`, { ...picked, message, branch, baseSha }).then((r) => r.request),
};
