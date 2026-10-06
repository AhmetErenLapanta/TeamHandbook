import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";
import type { HookInput } from "./hook-io.js";
import { teamSkillsDir } from "./init.js";
import { listCandidates } from "./queue.js";
import { handbookHome } from "./session-state.js";
import { sessionDetectEnabled } from "./session-workflow.js";
import { listExistingSkills } from "./skill-index.js";

// Claude Code invokes an installed skill through a `Skill` tool call, which reaches
// the PostToolUse hook as { tool_name: "Skill", tool_input: { skill: "<slug>" } }
// (verified empirically against a real session). That is the only honest evidence
// this product can offer that a kept skill did anything at all - everything else it
// counts is a decision the user made themselves.
//
// Local only, and content-free: a slug the user already has on disk, plus a running count,
// the time of the last call and how many calls fell on each of the last 30 days. The call's
// arguments are the user's own words and never reach this file. Nothing here is sent anywhere;
// it exists so status and the weekly digest can say which skills earn their place and which
// have never fired.

export interface SkillUse {
  count: number;
  lastAt: string;
  /** Calls per UTC day, pruned to the last USAGE_DAYS: "used n times this month" without a log. */
  days?: Record<string, number>;
}

export type SkillUsage = Record<string, SkillUse>;

/** The window status reports usage over, and the most a usage entry ever remembers by day. */
export const USAGE_DAYS = 30;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What a skill is called by. The hook hands over whatever the model put in `skill`, and the
 * record promises a name: a value with a space or a quote in it is text, not a name, and is
 * dropped rather than kept.
 */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export function usageFile(home: string = handbookHome()): string {
  return join(home, "skill-usage.json");
}

export function readSkillUsage(home: string = handbookHome()): SkillUsage {
  try {
    const parsed = JSON.parse(readFileSync(usageFile(home), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const usage: SkillUsage = {};
    for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as { count?: unknown; lastAt?: unknown; days?: unknown };
      if (typeof entry?.count === "number" && typeof entry?.lastAt === "string") {
        const days = dayCounts(entry.days);
        usage[slug] = { count: entry.count, lastAt: entry.lastAt, ...(days ? { days } : {}) };
      }
    }
    return usage;
  } catch {
    return {};
  }
}

function dayCounts(value: unknown): Record<string, number> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const days: Record<string, number> = {};
  for (const [day, count] of Object.entries(value as Record<string, unknown>)) {
    if (DAY.test(day) && typeof count === "number") days[day] = count;
  }
  return days;
}

function dayOf(at: string): string {
  return at.slice(0, 10);
}

function windowStart(at: string, days: number): string {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms - (days - 1) * 86_400_000).toISOString().slice(0, 10) : dayOf(at);
}

/** Count one invocation of an installed skill. A compact map, not an append-only
 * log: usage is a running total plus at most a month of day counts, so it stays a few
 * KB no matter how long you use it.
 *
 * Off whenever session recording is off, through the same switch: someone who told the
 * product not to keep track of their sessions has not agreed to it keeping track of which
 * skills those sessions reached for. */
export function recordSkillUse(
  slug: string,
  home: string = handbookHome(),
  at: string = new Date().toISOString(),
): void {
  if (!SKILL_NAME.test(slug) || !sessionDetectEnabled(home)) return;
  const usage = readSkillUsage(home);
  const prior = usage[slug];
  const since = windowStart(at, USAGE_DAYS);
  const days = Object.fromEntries(Object.entries(prior?.days ?? {}).filter(([day]) => day >= since));
  days[dayOf(at)] = (days[dayOf(at)] ?? 0) + 1;
  usage[slug] = { count: (prior?.count ?? 0) + 1, lastAt: at, days };
  writeFileAtomic(usageFile(home), JSON.stringify(usage, null, 2) + "\n");
}

/**
 * The hook's whole payload goes in and only the name comes out. `tool_input.args` is what the
 * user asked the skill to do, in their own words, which is the most sensitive thing this hook
 * ever sees; taking the payload here rather than a name keeps that choice in one tested place.
 */
export function recordSkillCall(input: HookInput, home: string = handbookHome(), at: string = new Date().toISOString()): void {
  recordSkillUse(typeof input.tool_input?.skill === "string" ? input.tool_input.skill : "", home, at);
}

/** How many times a skill fired in the `days` days up to and including `now`'s day. */
export function usesSince(use: SkillUse | undefined, now: string = new Date().toISOString(), days = USAGE_DAYS): number {
  if (!use?.days) return 0;
  const since = windowStart(now, days);
  const today = dayOf(now);
  return Object.entries(use.days).reduce((sum, [day, count]) => (day >= since && day <= today ? sum + count : sum), 0);
}

export interface UsageSummary {
  fired: number;
  totalUses: number;
  topSkill: { slug: string; count: number } | null;
}

/** The skills TeamHandbook is entitled to report on. Two sources, because the two kinds
 * of user have nothing in common:
 *
 * - what this machine approved and delivered - keyed by the DELIVERED directory, not
 *   the candidate slug, since delivery renames on collision and the rename is what
 *   Claude Code fires;
 * - what arrived from the team marketplace - a teammate who only consumes shared
 *   skills approves nothing locally, and is exactly who the team feature exists for.
 *
 * Skills from elsewhere (other plugins, hand-written ones) are deliberately excluded:
 * counting them would inflate TeamHandbook's apparent value with work it didn't do. */
export function handbookSkills(home: string = handbookHome()): string[] {
  const delivered = listCandidates(home, "approved")
    .filter((c) => c.deliveredMode === "personal" || c.deliveredMode === "solo")
    .map((c) => (c.deliveredTo ? basename(c.deliveredTo) : c.slug));
  const teamDir = teamSkillsDir(home);
  const fromTeam = teamDir ? listExistingSkills([teamDir]).map((s) => s.name) : [];
  return [...new Set([...delivered, ...fromTeam])];
}

/** What to tell the user: how many of THEIR skills have actually fired. `known` is
 * the set of skills currently installed, so a skill they deleted stops being counted
 * against them. */
export function summarizeUsage(usage: SkillUsage, known: string[]): UsageSummary {
  const relevant = known.filter((slug) => usage[slug]);
  const totalUses = relevant.reduce((sum, slug) => sum + usage[slug]!.count, 0);
  const top = relevant
    .map((slug) => ({ slug, count: usage[slug]!.count }))
    .sort((a, b) => b.count - a.count)[0];
  return { fired: relevant.length, totalUses, topSkill: top ?? null };
}
