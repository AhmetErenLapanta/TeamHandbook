import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";
import { join } from "node:path";
import { handbookHome } from "./session-state.js";
import { readConfigFile } from "./config.js";
import { readCounters } from "./counters.js";
import { teamSkillsDir } from "./init.js";
import { listCandidates } from "./queue.js";
import { listExistingSkills } from "./skill-index.js";

export interface NotifyConfig {
  sessionStart: boolean;
  heartbeat: boolean;
}

export const defaultNotifyConfig: NotifyConfig = {
  sessionStart: true,
  heartbeat: true,
};

export function loadNotifyConfig(home: string = handbookHome()): NotifyConfig {
  const notify = readConfigFile(home).notify as Record<string, unknown> | undefined;
  return {
    sessionStart: notify?.sessionStart !== false,
    heartbeat: notify?.heartbeat !== false,
  };
}

function welcomeMarkerFile(home: string): string {
  return join(home, "welcomed");
}

/** True exactly once: the first session after install. Marks itself as shown. */
export function isFirstRun(home: string = handbookHome()): boolean {
  const marker = welcomeMarkerFile(home);
  if (existsSync(marker)) return false;
  writeFileAtomic(marker, new Date().toISOString() + "\n");
  return true;
}

export interface HeartbeatDelta {
  failures: number;
  pairs: number;
}

function heartbeatSnapshotFile(home: string): string {
  return join(home, "notified-counters.json");
}

/**
 * Detector activity since the previous session-start notice. Advances the
 * snapshot on every call, so each session reports only what happened since the
 * last one — the product's "I'm alive and watching" signal without any noise
 * when nothing happened.
 */
export function heartbeatDelta(home: string = handbookHome()): HeartbeatDelta {
  const current = readCounters(home);
  let prior = { bashFailuresCaptured: 0, pairsResolved: 0 };
  try {
    const parsed = JSON.parse(readFileSync(heartbeatSnapshotFile(home), "utf8"));
    prior = {
      bashFailuresCaptured: Number(parsed?.bashFailuresCaptured) || 0,
      pairsResolved: Number(parsed?.pairsResolved) || 0,
    };
  } catch {
    // first heartbeat: baseline from zero
  }
  writeFileAtomic(
    heartbeatSnapshotFile(home),
    JSON.stringify(
      { bashFailuresCaptured: current.bashFailuresCaptured, pairsResolved: current.pairsResolved },
      null,
      2,
    ) + "\n",
  );
  return {
    failures: Math.max(0, current.bashFailuresCaptured - prior.bashFailuresCaptured),
    pairs: Math.max(0, current.pairsResolved - prior.pairsResolved),
  };
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
  writeFileAtomic(seenSkillsFile(home), JSON.stringify(state, null, 2) + "\n");
  if (!Array.isArray(prior)) return [];
  const priorSet = new Set(prior);
  return currentNames.filter((name) => !priorSet.has(name)).sort();
}

export interface SummaryInputs {
  pending: number;
  newSkills: string[];
  firstRun?: boolean;
  heartbeat?: HeartbeatDelta | null;
}

export function buildSessionStartSummary(inputs: SummaryInputs): string | null {
  const { pending, newSkills, firstRun = false, heartbeat = null } = inputs;
  const lines: string[] = [];
  if (firstRun) {
    lines.push(
      "TeamHandbook is active — watching this machine for error→fix moments worth keeping. " +
        "Nothing leaves your machine without your approval. Run /handbook:status anytime.",
    );
  }
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
  // The heartbeat fills the silence between candidates, but never competes with a
  // stronger line: shown only when there was real activity and nothing else to say.
  if (!firstRun && lines.length === 0 && heartbeat && (heartbeat.failures > 0 || heartbeat.pairs > 0)) {
    const parts: string[] = [];
    if (heartbeat.failures > 0) {
      parts.push(`${heartbeat.failures} failure${heartbeat.failures === 1 ? "" : "s"} watched`);
    }
    if (heartbeat.pairs > 0) {
      parts.push(`${heartbeat.pairs} error→fix pair${heartbeat.pairs === 1 ? "" : "s"} captured`);
    }
    lines.push(`handbook: since your last session — ${parts.join(", ")}.`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

export function sessionStartNotice(
  cwd: string,
  home: string = handbookHome(),
  marketplacesRootDir?: string,
): string | null {
  const config = loadNotifyConfig(home);
  if (!config.sessionStart) return null;
  const pending = listCandidates(home, "pending").length;
  // Watch the project's own skills AND (in team mode) the locally-pulled team
  // marketplace — that's where teammates' merged skills actually appear.
  const watchedDirs = [join(cwd, ".claude", "skills")];
  const teamDir = teamSkillsDir(home, marketplacesRootDir);
  if (teamDir) watchedDirs.push(teamDir);
  const newSkills = watchedDirs
    .flatMap((dir) => diffNewSkills(dir, listExistingSkills([dir]).map((s) => s.name), home))
    .sort();
  return buildSessionStartSummary({
    pending,
    newSkills,
    firstRun: isFirstRun(home),
    heartbeat: config.heartbeat ? heartbeatDelta(home) : null,
  });
}
