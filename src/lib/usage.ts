import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";
import { teamSkillsDir } from "./init.js";
import { listCandidates } from "./queue.js";
import { handbookHome } from "./session-state.js";
import { listExistingSkills } from "./skill-index.js";

// Claude Code invokes an installed skill through a `Skill` tool call, which reaches
// the PostToolUse hook as { tool_name: "Skill", tool_input: { skill: "<slug>" } }
// (verified empirically against a real session). That is the only honest evidence
// this product can offer that a kept skill did anything at all — everything else it
// counts is a decision the user made themselves.
//
// Local only, and content-free: a slug the user already has on disk, plus a count.
// Nothing here is sent anywhere; it exists so status and the weekly digest can say
// which skills earn their place and which have never fired.

export interface SkillUse {
  count: number;
  lastAt: string;
}

export type SkillUsage = Record<string, SkillUse>;

export function usageFile(home: string = handbookHome()): string {
  return join(home, "skill-usage.json");
}

export function readSkillUsage(home: string = handbookHome()): SkillUsage {
  try {
    const parsed = JSON.parse(readFileSync(usageFile(home), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const usage: SkillUsage = {};
    for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as { count?: unknown; lastAt?: unknown };
      if (typeof entry?.count === "number" && typeof entry?.lastAt === "string") {
        usage[slug] = { count: entry.count, lastAt: entry.lastAt };
      }
    }
    return usage;
  } catch {
    return {};
  }
}

/** Count one invocation of an installed skill. A compact map, not an append-only
 * log: usage is a running total, so it stays a few KB no matter how long you use it. */
export function recordSkillUse(
  slug: string,
  home: string = handbookHome(),
  at: string = new Date().toISOString(),
): void {
  if (!slug) return;
  const usage = readSkillUsage(home);
  const prior = usage[slug];
  usage[slug] = { count: (prior?.count ?? 0) + 1, lastAt: at };
  writeFileAtomic(usageFile(home), JSON.stringify(usage, null, 2) + "\n");
}

export interface UsageSummary {
  fired: number;
  totalUses: number;
  topSkill: { slug: string; count: number } | null;
}

/** The skills TeamHandbook is entitled to report on. Two sources, because the two kinds
 * of user have nothing in common:
 *
 * - what this machine approved and delivered — keyed by the DELIVERED directory, not
 *   the candidate slug, since delivery renames on collision and the rename is what
 *   Claude Code fires;
 * - what arrived from the team marketplace — a teammate who only consumes shared
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
