import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";
import { join } from "node:path";
import { handbookHome } from "./session-state.js";
import { configIsBroken, readConfigFile } from "./config.js";
import { readCounters } from "./counters.js";
import { loadTeamConfig, teamSkillsDir } from "./init.js";
import { listCandidates } from "./queue.js";
import type { CandidateMeta } from "./queue.js";
import { readSkillUsage, handbookSkills, summarizeUsage } from "./usage.js";
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

// Growth bridge: once the product has proven itself solo (a few approved skills)
// and no team repo is configured, suggest — exactly once, ever — sharing them.
// This is the only moment the product markets its own team layer.
const TEAM_NUDGE_APPROVALS = 3;

function teamNudgeMarkerFile(home: string): string {
  return join(home, "nudged-team");
}

function digestMarkerFile(home: string): string {
  return join(home, "last-digest");
}

const DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Once a week: what your Claude actually learned. The single line that makes the
 * learning VISIBLE — the difference between a tool that quietly works and one you
 * can feel working. Silent when the week produced nothing, and never more than
 * once per interval.
 */
export function weeklyDigest(home: string = handbookHome(), now: number = Date.now()): string | null {
  const marker = digestMarkerFile(home);
  let since = 0;
  try {
    since = Date.parse(readFileSync(marker, "utf8").trim());
  } catch {
    // first ever call: start the clock, report nothing (a digest of "since install"
    // would double up with the welcome)
    writeFileAtomic(marker, new Date(now).toISOString() + "\n");
    return null;
  }
  if (!Number.isFinite(since) || now - since < DIGEST_INTERVAL_MS) return null;
  writeFileAtomic(marker, new Date(now).toISOString() + "\n");

  const decided = listCandidates(home).filter(
    (c) => c.decidedAt && Date.parse(c.decidedAt) >= since,
  );
  const kept = decided.filter(
    (c) => c.status === "approved" && (c.deliveredMode === "personal" || c.deliveredMode === "solo"),
  ).length;
  const shared = decided.filter((c) => c.status === "approved" && c.deliveredMode === "team").length;
  const pending = listCandidates(home, "pending").length;
  if (kept + shared + pending === 0) return null;

  const parts: string[] = [];
  if (kept > 0) parts.push(`${kept} skill${kept === 1 ? "" : "s"} kept`);
  if (shared > 0) parts.push(`${shared} shared with the team`);
  if (pending > 0) parts.push(`${pending} waiting for your call`);
  // decisions are the user's own clicks; usage is the only line that reports back
  // something they did NOT do — whether a kept skill actually fired
  const usage = summarizeUsage(readSkillUsage(home), handbookSkills(home));
  if (usage.totalUses > 0) {
    parts.push(
      `your skills fired ${usage.totalUses} time${usage.totalUses === 1 ? "" : "s"}` +
        (usage.topSkill ? ` (${usage.topSkill.slug} most of all)` : ""),
    );
  }
  return `TeamHandbook - your week: ${parts.join(", ")}. Run /handbook:status for the full picture.`;
}

export function pendingTeamNudge(home: string = handbookHome()): string | null {
  if (loadTeamConfig(home)) return null;
  if (existsSync(teamNudgeMarkerFile(home))) return null;
  const approved = listCandidates(home, "approved").length;
  if (approved < TEAM_NUDGE_APPROVALS) return null;
  writeFileAtomic(teamNudgeMarkerFile(home), new Date().toISOString() + "\n");
  return (
    `handbook: ${approved} approved skills live only on this machine - one ` +
    `/handbook:init shares them with your team (teammates get every future merge automatically).`
  );
}

/** Sessions waiting for, or currently in, the background harvest. A runner holds its
 * claim (`<job>.json.claimed-<pid>`) for the whole harvest, so both shapes count:
 * queued and in flight. Read directly to avoid pulling the pipeline module into the
 * session-start hook bundle. */
export function pendingHarvestCount(home: string = handbookHome()): number {
  let entries: string[];
  try {
    entries = readdirSync(join(home, "pending"));
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.includes(".json")) continue; // *.json and *.json.claimed-<pid>
    try {
      const parsed = JSON.parse(readFileSync(join(home, "pending", entry), "utf8"));
      if (parsed && typeof parsed === "object" && typeof parsed.sessionId === "string") total += 1;
    } catch {
      // malformed / mid-write job — ignore
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
  // the highest repeat count among the pending queue — a lesson taught again while
  // its candidate sits unreviewed
  pendingRepeats?: number;
  // freshly harvested lessons awaiting the keep/share/skip decision — the headline
  harvested?: {
    // days since the oldest pending harvested candidate was written
    oldestDays?: number;
    name: string;
    kind: string;
    total: number | null;
    more: number;
    // sessions this was already taught in — the promise on the tin, made visible
    taughtBefore?: number;
  } | null;
  // the last harvest ran and honestly found nothing worth keeping. Silence here
  // reads as "the product is broken", which is the point most users would quit.
  harvestedNothing?: boolean;
  firstRun?: boolean;
  newSkills: string[];
  heartbeat?: HeartbeatDelta | null;
  teamNudge?: string | null;
  digest?: string | null;
  // config.json exists but is unparseable — the kill switches failed closed
  configBroken?: boolean;
  scoring?: number;
}

export function buildSessionStartSummary(inputs: SummaryInputs): string | null {
  const {
    pending,
    pendingPreviews = [],
    harvested = null,
    harvestedNothing = false,
    newSkills,
    firstRun = false,
    heartbeat = null,
    teamNudge = null,
    digest = null,
    scoring = 0,
  } = inputs;
  const lines: string[] = [];
  if (inputs.configBroken) {
    lines.push(
      "handbook: ~/.teamhandbook/config.json could not be parsed - automatic harvesting is " +
        "OFF until it is valid JSON (failing closed on purpose). Run /handbook:doctor.",
    );
  }
  if (firstRun) {
    lines.push(
      "TeamHandbook is active - it learns from the corrections you give, the procedures you complete, " +
        "and the traps you hit. After each session where you did real work, it reads that session " +
        "(your prompts included, secrets redacted) through your OWN claude CLI and tells you at your " +
        "next session start what it learned - you decide whether to keep it, put it in the repo, or " +
        "share it with the team. Nothing installs or ships without your say-so. Turn the reading off " +
        'entirely with ~/.teamhandbook/config.json → {"harvest": {"enabled": false}}. ' +
        "Want to see the whole loop in two minutes instead of waiting? Run /handbook:demo. " +
        "And /handbook:doctor once confirms TeamHandbook can reach your claude CLI.",
    );
  }
  // The harvest headline: what TeamHandbook just learned, and the one question that
  // matters — who gets it: just you, this project, or the whole team? All three are
  // named, because a destination the notice never mentions is one nobody picks.
  if (harvested) {
    const score = harvested.total !== null ? `, ${harvested.total}/10` : "";
    const more = harvested.more > 0 ? ` (+${harvested.more} more)` : "";
    // The whole promise is "what you say twice, you say once". When it really is
    // the second time, lead with that — it is the moment the product justifies
    // itself, and it is the developer's own evidence, not a score they must trust.
    const repeats = (harvested.taughtBefore ?? 0) + 1;
    // A queue that has been growing for days is a different message from a single
    // fresh lesson, and the notice has to compete for attention with whatever else
    // prints at session start. Lead with the count once there is more than one, and
    // say how long the oldest has waited once that stops being "just now": both are
    // facts the developer can act on, and neither nags when there is nothing to nag
    // about.
    const waited = harvested.oldestDays ?? 0;
    const waiting = waited >= 2 ? `, the oldest waiting ${waited} days` : "";
    const lead =
      repeats > 1
        ? `TeamHandbook learned something you have now told Claude in ${repeats} sessions`
        : harvested.more > 0
          ? `TeamHandbook has ${harvested.more + 1} skills waiting for your call${waiting}, newest first`
          : "TeamHandbook learned from your last session";
    lines.push(
      `${lead}: "${harvested.name}" (${harvested.kind}${score})${more} - keep it for yourself, add it to this project, or share it with the team: run /handbook:review.`,
    );
  }
  if (pending > 0) {
    const noun = pending === 1 ? "candidate skill is" : "candidate skills are";
    const preview = pendingPreviews.length > 0 ? ` (${pendingPreviews.join("; ")})` : "";
    // a lesson still waiting while the developer keeps re-teaching it is the one
    // queue item worth interrupting for
    const repeated = inputs.pendingRepeats ?? 0;
    const nag =
      repeated > 0
        ? ` - you have told Claude one of these in ${repeated} sessions now, and it is still waiting: run /handbook:review.`
        : " — run /handbook:review to approve or reject.";
    lines.push(`handbook: ${pending} ${noun} awaiting your review${preview}${nag}`);
  }
  if (harvestedNothing && !harvested && pending === 0 && scoring === 0) {
    lines.push(
      "handbook: read your last session and found nothing worth keeping — that's a normal " +
        "answer, not a failure. Run /handbook:learn if there was something it missed.",
    );
  }
  if (scoring > 0 && pending === 0 && !harvested) {
    lines.push(
      `handbook: harvesting your last session${scoring === 1 ? "" : ` (${scoring} sessions)`} in the background — check /handbook:review shortly.`,
    );
  }
  if (newSkills.length > 0) {
    const noun = newSkills.length === 1 ? "new skill" : "new skills";
    lines.push(
      `handbook: ${newSkills.length} ${noun} available since your last session here: ${newSkills.join(", ")}.`,
    );
  }
  if (teamNudge) lines.push(teamNudge);
  if (digest) lines.push(digest);
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

/** Did the most recent run actually harvest a session and write nothing? Reading the
 * run log directly keeps the pipeline module out of the session-start bundle. */
function lastHarvestFoundNothing(home: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(home, "pipeline.log"), "utf8");
  } catch {
    return false;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const run = JSON.parse(lines[i]!);
      if (!run?.harvest) continue; // manual runs don't answer this question
      return !run.harvest.skipped && Array.isArray(run.written) && run.written.length === 0 && !run.errored;
    } catch {
      // skip malformed lines
    }
  }
  return false;
}

/** How long the oldest of these has been waiting, in whole days. */
function oldestPendingDays(candidates: CandidateMeta[], now: number = Date.now()): number {
  const times = candidates
    .map((c) => Date.parse(c.createdAt))
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) return 0;
  return Math.floor((now - Math.min(...times)) / 86_400_000);
}

export function sessionStartNotice(
  cwd: string,
  home: string = handbookHome(),
  marketplacesRootDir?: string,
): string | null {
  const config = loadNotifyConfig(home);
  if (!config.sessionStart) return null;
  const pendingCandidates = listCandidates(home, "pending");
  // Freshly harvested lessons get the headline treatment (keep/share/skip); other
  // pending candidates (manual learns, older items) keep the plain review prompt.
  const harvestedPending = pendingCandidates.filter((c) => c.origin === "harvest");
  const rest = pendingCandidates.filter((c) => c.origin !== "harvest");
  // A lesson the developer keeps re-teaching outranks a higher-scoring one they
  // said once: repetition is their own evidence that it matters, and it is the
  // whole promise on the tin.
  const top = harvestedPending.sort(
    (a, b) =>
      (b.taughtBefore ?? 0) - (a.taughtBefore ?? 0) || (b.gate?.total ?? -1) - (a.gate?.total ?? -1),
  )[0];
  const harvested = top
    ? {
        name: top.slug,
        kind: top.kind ?? "skill",
        total: top.gate?.total ?? null,
        more: harvestedPending.length - 1,
        oldestDays: oldestPendingDays(harvestedPending),
        ...(top.taughtBefore ? { taughtBefore: top.taughtBefore } : {}),
      }
    : null;
  const pendingRepeats = Math.max(0, ...rest.map((c) => (c.taughtBefore ? c.taughtBefore + 1 : 0)));
  const pendingPreviews = rest
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
    pending: rest.length,
    pendingPreviews,
    pendingRepeats,
    harvested,
    newSkills,
    firstRun: isFirstRun(home),
    heartbeat: config.heartbeat ? heartbeatDelta(home) : null,
    teamNudge: pendingTeamNudge(home),
    harvestedNothing: lastHarvestFoundNothing(home),
    digest: weeklyDigest(home),
    configBroken: configIsBroken(home),
    scoring: pendingHarvestCount(home),
  });
}
