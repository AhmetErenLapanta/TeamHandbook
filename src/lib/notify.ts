import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handbookHome } from "./session-state.js";
import { readConfigFile } from "./config.js";
import { listCandidates } from "./queue.js";
import { listExistingSkills } from "./skill-index.js";

export interface NotifyConfig {
  sessionStart: boolean;
}

export const defaultNotifyConfig: NotifyConfig = {
  sessionStart: true,
};

export function loadNotifyConfig(home: string = handbookHome()): NotifyConfig {
  const notify = readConfigFile(home).notify as Record<string, unknown> | undefined;
  return { sessionStart: notify?.sessionStart !== false };
}

export function seenSkillsFile(home: string = handbookHome()): string {
  return join(home, "seen-skills.json");
}

type SeenSkills = Record<string, string[]>;

function readSeenSkills(home: string): SeenSkills {
  try {
    const parsed = JSON.parse(readFileSync(seenSkillsFile(home), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

export function diffNewSkills(
  dir: string,
  currentNames: string[],
  home: string = handbookHome(),
): string[] {
  const state = readSeenSkills(home);
  const prior = state[dir];
  state[dir] = [...currentNames].sort();
  mkdirSync(home, { recursive: true });
  writeFileSync(seenSkillsFile(home), JSON.stringify(state, null, 2) + "\n");
  if (!Array.isArray(prior)) return [];
  const priorSet = new Set(prior);
  return currentNames.filter((name) => !priorSet.has(name)).sort();
}

export function buildSessionStartSummary(pending: number, newSkills: string[]): string | null {
  const lines: string[] = [];
  if (pending > 0) {
    const noun = pending === 1 ? "candidate skill is" : "candidate skills are";
    lines.push(
      `handbook: ${pending} ${noun} awaiting your review — run /handbook:review to approve or reject.`,
    );
  }
  if (newSkills.length > 0) {
    const noun = newSkills.length === 1 ? "new skill" : "new skills";
    lines.push(
      `handbook: ${newSkills.length} ${noun} available since your last session here: ${newSkills.join(", ")}.`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

export function sessionStartNotice(cwd: string, home: string = handbookHome()): string | null {
  if (!loadNotifyConfig(home).sessionStart) return null;
  const pending = listCandidates(home, "pending").length;
  const skillsDir = join(cwd, ".claude", "skills");
  const current = listExistingSkills([skillsDir]).map((s) => s.name);
  return buildSessionStartSummary(pending, diffNewSkills(skillsDir, current, home));
}
