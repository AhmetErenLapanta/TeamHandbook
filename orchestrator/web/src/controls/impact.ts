import type { ChangeInput, SkillOverlap, TeamView, UsageCount } from "../api";
import type { Policy } from "./policy";

/** What a change to a skill, MCP server or command touches, gathered before its request opens. */
export interface ChangeImpact {
  subject: string;
  removing: boolean;
  team: string | null;
  overlap: SkillOverlap | null;
  usage: { count: number; days: number; lastHour: string | null } | null;
  policies: { id: string; name: string }[];
}

/** A whole-value wildcard, as the team file's policy rules match: `*` stands for any run of characters. */
export function patternMatches(pattern: string, value: string): boolean {
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`).test(value);
}

function resourceOf(change: ChangeInput): { subject: string; resource: string | null; removing: boolean; skill: string | null } | null {
  switch (change.kind) {
    case "skill.add":
    case "skill.edit":
    case "skill.delete":
      return { subject: change.slug, resource: `skill:${change.slug}`, removing: change.kind === "skill.delete", skill: change.slug };
    case "mcp.add":
    case "mcp.edit":
    case "mcp.remove":
      return { subject: change.name, resource: `mcp:${change.name}`, removing: change.kind === "mcp.remove", skill: null };
    case "command.add":
    case "command.edit":
    case "command.delete":
      return { subject: `/${change.name}`, resource: null, removing: change.kind === "command.delete", skill: null };
    default:
      return null;
  }
}

/** The impact of one change, from what the orchestrator already holds; null for a change to the team's settings. */
export function changeImpact(repoId: string, change: ChangeInput, held: { teams: TeamView[]; usage: UsageCount[]; usageDays: number; overlaps: Record<string, SkillOverlap>; policies: Policy[] }): ChangeImpact | null {
  const target = resourceOf(change);
  if (!target) return null;
  const team = held.teams.find((t) => t.repos.includes(repoId)) ?? null;
  const counts = target.skill ? held.usage.filter((u) => u.repoId === repoId && u.skill === target.skill) : [];
  const policies = target.resource
    ? held.policies.filter((p) => (!p.repos || p.repos.includes(repoId)) && p.rules.some((r) => "resources" in r && r.resources.some((pattern) => patternMatches(pattern, target.resource!) || pattern.startsWith(`${target.resource}/`))))
    : [];
  return {
    subject: target.subject,
    removing: target.removing,
    team: team?.team ?? null,
    overlap: target.skill ? held.overlaps[target.skill] ?? null : null,
    usage: target.skill ? { count: counts.reduce((n, u) => n + u.count, 0), days: held.usageDays, lastHour: counts.map((u) => u.lastHour).sort().at(-1) ?? null } : null,
    policies: policies.map((p) => ({ id: p.id, name: p.name })),
  };
}
