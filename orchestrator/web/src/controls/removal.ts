import { call } from "../api";
import type { ChangeInput } from "../api";
import type { PolicyDraft } from "./policy";

export type RemovableKind = "skill" | "mcp";

/** What removing a skill or an MCP server from a team repository takes away, read before the request opens. */
export interface RemovalImpact {
  subject: string;
  /** Skill use over the last 30 days; `counted` false means the team does not report use, not that nobody used it. Null for a server. */
  usage: { counted: boolean; days: number; count: number; lastHour: string | null; daily: { day: string; count: number }[] } | null;
  /** Team policies on this repository that already block it. */
  blockedBy: { id: string; name: string }[];
  remove: ChangeInput;
  /** The team policy that blocks it and keeps its files, saved through the policy flow as it stands; null when a policy blocks it already. */
  disable: PolicyDraft | null;
}

export const removalApi = {
  impact: (repoId: string, kind: RemovableKind, name: string) =>
    call<RemovalImpact>("GET", `/api/repos/${encodeURIComponent(repoId)}/removal?${new URLSearchParams({ [kind]: name })}`),
};

/** The use line under a removal: a team that does not report use is said to be not counted, never unused. */
export function usageLine(usage: NonNullable<RemovalImpact["usage"]>): string {
  if (!usage.counted) return "This team does not report skill use, so recent use is not counted.";
  if (!usage.count) return `No reported use in the last ${usage.days} days.`;
  const last = usage.lastHour ? `, last on ${usage.lastHour.slice(0, 10)}` : "";
  return `Used ${usage.count.toLocaleString("en-US")} ${usage.count === 1 ? "time" : "times"} in the last ${usage.days} days${last}.`;
}
