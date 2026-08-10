import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";
import { join } from "node:path";
import { handbookHome } from "./session-state.js";
import { readConfigFile } from "./config.js";
import { readCounters } from "./counters.js";
import { loadTeamConfig, teamSkillsDir } from "./init.js";
import { listCandidates } from "./queue.js";
import { listExistingSkills } from "./skill-index.js";
import { workRecurrences } from "./signals.js";

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
  gateErrors: number;
}

function heartbeatSnapshotFile(home: string): string {
  return join(home, "notified-counters.json");
}

/**
 * Detector activity since the previous session-start notice. Advances the
 * snapshot on every call, so each session reports only what happened since the
 * last one — the product's "I'm alive and watching" signal without any noise
 * when nothing happened, plus a push of gate failures the user would otherwise
 * only discover by running status/doctor.
 */
export function heartbeatDelta(home: string = handbookHome()): HeartbeatDelta {
  const current = readCounters(home);
  let prior = { bashFailuresCaptured: 0, pairsResolved: 0, gateErrors: 0 };
  try {
    const parsed = JSON.parse(readFileSync(heartbeatSnapshotFile(home), "utf8"));
    prior = {
      bashFailuresCaptured: Number(parsed?.bashFailuresCaptured) || 0,
      pairsResolved: Number(parsed?.pairsResolved) || 0,
      gateErrors: Number(parsed?.gateErrors) || 0,
    };
  } catch {
    // first heartbeat: baseline from zero
  }
  writeFileAtomic(
    heartbeatSnapshotFile(home),
    JSON.stringify(
      {
        bashFailuresCaptured: current.bashFailuresCaptured,
        pairsResolved: current.pairsResolved,
        gateErrors: current.gateErrors,
      },
      null,
      2,
    ) + "\n",
  );
  return {
    failures: Math.max(0, current.bashFailuresCaptured - prior.bashFailuresCaptured),
    pairs: Math.max(0, current.pairsResolved - prior.pairsResolved),
    gateErrors: Math.max(0, current.gateErrors - prior.gateErrors),
  };
}

// T3: when the same shape of work keeps recurring across sessions, suggest — once
// per shape — turning the procedure into a skill. A suggestion, never automatic
// generation: the user runs /handbook:learn with full session context. The
// threshold trades earliness against confidence; since each shape nudges at most
// once, a low default mainly changes WHEN you're asked, not how often.
const DEFAULT_WORK_NUDGE_THRESHOLD = 2;

export function workNudgeThreshold(home: string = handbookHome()): number {
  const notify = readConfigFile(home).notify as Record<string, unknown> | undefined;
  const value = notify?.workNudgeThreshold;
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_WORK_NUDGE_THRESHOLD;
}

function nudgedWorkFile(home: string): string {
  return join(home, "nudged-work.json");
}

export function pendingWorkNudge(home: string = handbookHome()): string | null {
  let nudged: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(nudgedWorkFile(home), "utf8"));
    if (Array.isArray(parsed)) nudged = parsed.filter((f) => typeof f === "string");
  } catch {
    // nothing nudged yet
  }
  const threshold = workNudgeThreshold(home);
  const due = workRecurrences(home)
    .filter((r) => r.count >= threshold && !nudged.includes(r.fingerprint))
    .sort((a, b) => b.count - a.count);
  const top = due[0];
  if (!top) return null;
  writeFileAtomic(nudgedWorkFile(home), JSON.stringify([...nudged, top.fingerprint], null, 2) + "\n");
  const what = [top.families.slice(0, 3).join(", "), top.exts.slice(0, 3).join(" ")]
    .filter(Boolean)
    .join("; editing ");
  return (
    `handbook: you've done similar work ${top.count} times (${what}) — if that's a ` +
    `repeatable procedure, run /handbook:learn to turn it into a team skill.`
  );
}

// Growth bridge: once the product has proven itself solo (a few approved skills)
// and no team repo is configured, suggest — exactly once, ever — sharing them.
// This is the only moment the product markets its own team layer.
const TEAM_NUDGE_APPROVALS = 3;

function teamNudgeMarkerFile(home: string): string {
  return join(home, "nudged-team");
}

export function pendingTeamNudge(home: string = handbookHome()): string | null {
  if (loadTeamConfig(home)) return null;
  if (existsSync(teamNudgeMarkerFile(home))) return null;
  const approved = listCandidates(home, "approved").length;
  if (approved < TEAM_NUDGE_APPROVALS) return null;
  writeFileAtomic(teamNudgeMarkerFile(home), new Date().toISOString() + "\n");
  return (
    `handbook: ${approved} approved skills live only on this machine — one ` +
    `/handbook:init shares them with your team (teammates get every future merge automatically).`
  );
}

/** Pairs sitting in the pending hand-off, so the notice can say "queued for the
 * gate" instead of the queue looking empty. Counts only `*.json` batches: the runner
 * drains a batch synchronously (rename → read → delete) before it starts calling
 * claude, so there is no on-disk file during the actual scoring — a file-based count
 * can only see the brief pre-drain window, never the scoring itself. Read directly to
 * avoid pulling the pipeline module into the session-start hook bundle. */
export function pendingBatchCount(home: string = handbookHome()): number {
  let entries: string[];
  try {
    entries = readdirSync(join(home, "pending"));
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(home, "pending", entry), "utf8"));
      if (Array.isArray(parsed)) total += parsed.length;
    } catch {
      // malformed / mid-write batch — ignore
    }
  }
  return total;
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
  // up to a couple of "slug — description" previews to make the review prompt concrete
  pendingPreviews?: string[];
  firstRun?: boolean;
  newSkills: string[];
  heartbeat?: HeartbeatDelta | null;
  workNudge?: string | null;
  teamNudge?: string | null;
  scoring?: number;
}

export function buildSessionStartSummary(inputs: SummaryInputs): string | null {
  const {
    pending,
    pendingPreviews = [],
    newSkills,
    firstRun = false,
    heartbeat = null,
    workNudge = null,
    teamNudge = null,
    scoring = 0,
  } = inputs;
  const lines: string[] = [];
  if (firstRun) {
    lines.push(
      "TeamHandbook is active — watching this machine for error→fix moments and procedures worth keeping. " +
        "Scoring runs through your own claude CLI, and nothing is shared or published without your approval. " +
        "Automatic capture waits for an error class to recur, so an empty /handbook:review at first is normal — " +
        "or run /handbook:learn to turn the session you just finished into a skill right now. " +
        "Run /handbook:doctor once to confirm TeamHandbook can reach your claude CLI.",
    );
  }
  if (pending > 0) {
    const noun = pending === 1 ? "candidate skill is" : "candidate skills are";
    const preview = pendingPreviews.length > 0 ? ` (${pendingPreviews.join("; ")})` : "";
    lines.push(
      `handbook: ${pending} ${noun} awaiting your review${preview} — run /handbook:review to approve or reject.`,
    );
  }
  if (scoring > 0 && pending === 0) {
    lines.push(
      `handbook: scoring ${scoring} captured pair${scoring === 1 ? "" : "s"} in the background — check /handbook:review shortly.`,
    );
  }
  if (newSkills.length > 0) {
    const noun = newSkills.length === 1 ? "new skill" : "new skills";
    lines.push(
      `handbook: ${newSkills.length} ${noun} available since your last session here: ${newSkills.join(", ")}.`,
    );
  }
  if (workNudge) lines.push(workNudge);
  if (teamNudge) lines.push(teamNudge);
  // A gate outage is pushed regardless of what else is on screen — the user would
  // otherwise only discover it by running status/doctor.
  if (heartbeat && heartbeat.gateErrors > 0) {
    lines.push(
      `handbook: ${heartbeat.gateErrors} gate run${heartbeat.gateErrors === 1 ? "" : "s"} failed since your last session (claude may be logged out, missing, or rate-limited) — run /handbook:doctor.`,
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
  const pendingCandidates = listCandidates(home, "pending");
  const pendingPreviews = pendingCandidates
    .slice(0, 2)
    .map((c) => `${c.slug} — ${c.description.slice(0, 60)}`);
  // Watch the project's own skills AND (in team mode) the locally-pulled team
  // marketplace — that's where teammates' merged skills actually appear.
  const watchedDirs = [join(cwd, ".claude", "skills")];
  const teamDir = teamSkillsDir(home, marketplacesRootDir);
  if (teamDir) watchedDirs.push(teamDir);
  const newSkills = watchedDirs
    .flatMap((dir) => diffNewSkills(dir, listExistingSkills([dir]).map((s) => s.name), home))
    .sort();
  return buildSessionStartSummary({
    pending: pendingCandidates.length,
    pendingPreviews,
    newSkills,
    firstRun: isFirstRun(home),
    heartbeat: config.heartbeat ? heartbeatDelta(home) : null,
    workNudge: pendingWorkNudge(home),
    teamNudge: pendingTeamNudge(home),
    scoring: pendingBatchCount(home),
  });
}
