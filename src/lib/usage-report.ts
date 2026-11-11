import { appendFileSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { configIsBroken, readConfigFile } from "./config.js";
import type { HookInput } from "./hook-io.js";
import { loadTeamConfig, marketplacesRoot, TEAM_PREFIX_FILE } from "./init.js";
import { handbookHome } from "./session-state.js";
import { sessionDetectEnabled } from "./session-workflow.js";

// Reporting which team skills get used to the team's orchestrator. It takes two answers, and both
// are needed before a byte leaves the machine:
//   - the team's: `usage.endpoint` in the team repository's .teamhandbook.json, which arrives
//     on this machine only through a merge the team approved;
//   - this developer's: `"usage": { "shareWith": "<that exact address>" }` in their own
//     config.json. The answer names the address it was given for, so it never carries over to
//     another team or to an address the team changes later: those are asked again. Absent, or
//     naming another address, is undecided, and undecided sends nothing.
// The session-recording switch stops it too, as it stops the local usage count.
//
// What travels is a team skill's directory name and the hour it was used. Only a skill the
// team plugin itself ships is ever queued, under the plugin's own namespace: a personal or a
// project skill, the skill's arguments, a path, a session, a user or a machine never are.

export const OUTBOX_LIMIT = 500;
export const FLUSH_TIMEOUT_MS = 3_000;
/** The orchestrator's own addresses are well under this; anything longer is not one of them. */
export const ENDPOINT_MAX = 256;
/** As far back as the orchestrator accepts a count; an older use would make the orchestrator refuse the whole batch. */
export const OUTBOX_MAX_AGE_MS = 31 * 24 * 3_600_000;
/** A claimed queue a killed turn left behind is dropped unsent after this long. */
const CLAIM_STALE_MS = 10 * 60_000;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

export interface TeamUsageRequest {
  endpoint: string;
  plugin: string;
  skills: Set<string>;
}

export type UsageConsent = "agreed" | "declined" | "undecided";

export interface QueuedUse {
  skill: string;
  hour: string;
}

/**
 * Only an https address, or plain http to this machine itself. A team file is shared content;
 * an http address elsewhere would send the counts across a network in the clear. The address is
 * also printed into the session-start line the model reads, so it must be written exactly as a
 * URL normalizes it: whitespace, a line break or a control character is text riding along with
 * the address, and such a value is no address at all.
 */
export function allowedEndpoint(value: string): boolean {
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // A query or a fragment is room for text the address does not need, and the line it is
  // printed on is read by the model; so is a very long path.
  if (url.href !== value || url.username || url.password || url.search || url.hash || value.length > ENDPOINT_MAX) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The team's request, read from this machine's copy of the team repository, or null when it made none. */
export function teamUsageRequest(home: string = handbookHome(), root: string = marketplacesRoot()): TeamUsageRequest | null {
  const team = loadTeamConfig(home);
  if (!team) return null;
  const copy = join(root, team.marketplaceName);
  const usage = readJsonObject(join(copy, TEAM_PREFIX_FILE))?.usage as { endpoint?: unknown } | undefined;
  const endpoint = usage?.endpoint;
  if (typeof endpoint !== "string" || !allowedEndpoint(endpoint)) return null;
  const plugin = readJsonObject(join(copy, ".claude-plugin", "plugin.json"))?.name;
  if (typeof plugin !== "string" || !SLUG.test(plugin)) return null;
  let skills: string[] = [];
  try {
    skills = readdirSync(join(copy, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SLUG.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  return { endpoint, plugin, skills: new Set(skills) };
}

/** This developer's answer for one team address: agreed only when the answer names exactly that address. */
export function usageConsent(endpoint: string, home: string = handbookHome()): UsageConsent {
  // A config file that cannot be read is not an answer, and the privacy switches fail closed.
  if (configIsBroken(home)) return "undecided";
  const share = (readConfigFile(home).usage as { shareWith?: unknown } | undefined)?.shareWith;
  return share === endpoint ? "agreed" : share === false ? "declined" : "undecided";
}

function reportingRequest(home: string, root: string): TeamUsageRequest | null {
  if (!sessionDetectEnabled(home)) return null;
  const request = teamUsageRequest(home, root);
  return request && usageConsent(request.endpoint, home) === "agreed" ? request : null;
}

export function outboxFile(home: string = handbookHome()): string {
  return join(home, "usage-outbox.jsonl");
}

interface QueuedLine extends QueuedUse {
  /** The address this use was agreed for; a use never travels to any other. */
  endpoint: string;
}

function readQueue(file: string): QueuedLine[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    try {
      const e = JSON.parse(line) as Partial<QueuedLine>;
      return typeof e?.endpoint === "string" && typeof e.skill === "string" && typeof e.hour === "string"
        ? [{ endpoint: e.endpoint, skill: e.skill, hour: e.hour }]
        : [];
    } catch {
      return [];
    }
  });
}

/**
 * Queue one use of a team skill. Claude Code calls a plugin's skill by `<plugin>:<skill>`; a
 * name without the team plugin's prefix, or one the team copy does not ship, is not queued -
 * that is how a personal skill with the same name as a team skill stays on this machine.
 * One line is appended, so parallel tool hooks never overwrite each other's uses.
 */
export function queueTeamSkillUse(
  input: HookInput,
  home: string = handbookHome(),
  root: string = marketplacesRoot(),
  at: string = new Date().toISOString(),
): void {
  const called = input.tool_input?.skill;
  if (typeof called !== "string") return;
  const request = reportingRequest(home, root);
  if (!request) return;
  const prefix = `${request.plugin}:`;
  if (!called.startsWith(prefix)) return;
  const slug = called.slice(prefix.length);
  if (!SLUG.test(slug) || !request.skills.has(slug)) return;
  appendFileSync(outboxFile(home), JSON.stringify({ endpoint: request.endpoint, skill: slug, hour: at.slice(0, 13) }) + "\n");
}

export type Poster = (url: string, body: string, timeoutMs: number) => Promise<boolean>;

async function postJson(url: string, body: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    return res.ok;
  } catch {
    return false;
  }
}

function recentHour(hour: string, now: number): boolean {
  if (!HOUR.test(hour)) return false;
  const at = Date.parse(`${hour}:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 13) === hour && now - at <= OUTBOX_MAX_AGE_MS && at - now <= 3_600_000;
}

/** A queue a turn claimed and never finished with - the turn was killed mid-send - is dropped, never resent. */
function sweepStaleClaims(home: string, now: number): void {
  const prefix = `${outboxFile(home).split("/").pop()}.sending-`;
  let names: string[] = [];
  try {
    names = readdirSync(home).filter((name) => name.startsWith(prefix));
  } catch {
    return;
  }
  for (const name of names) {
    try {
      if (now - statSync(join(home, name)).mtimeMs > CLAIM_STALE_MS) rmSync(join(home, name), { force: true });
    } catch {
      // gone already
    }
  }
}

/**
 * Send what is queued, once per turn. The queue is claimed first by renaming it, so two turns
 * ending together never send the same uses twice. Only uses agreed for the address the team
 * asks for now, for a skill the team still ships, within the window the orchestrator accepts, go -
 * each rebuilt from its name and hour, whatever else a hand-edited line holds. Anything no
 * longer reportable when the turn ends - consent withdrawn, the team's key removed or changed,
 * recording switched off - is deleted unsent. A failed send puts the claimed uses back, the
 * newest 500, for the next turn; a hook never waits longer than the timeout.
 */
export async function flushTeamUsage(
  home: string = handbookHome(),
  root: string = marketplacesRoot(),
  post: Poster = postJson,
  now: number = Date.now(),
): Promise<void> {
  sweepStaleClaims(home, now);
  const claimed = `${outboxFile(home)}.sending-${process.pid}-${now}`;
  try {
    renameSync(outboxFile(home), claimed);
  } catch {
    return;
  }
  try {
    const request = reportingRequest(home, root);
    if (!request) return;
    const sendable = readQueue(claimed)
      .filter((e) => e.endpoint === request.endpoint && request.skills.has(e.skill) && recentHour(e.hour, now))
      .slice(-OUTBOX_LIMIT)
      .map((e) => ({ skill: e.skill, hour: e.hour }));
    if (!sendable.length) return;
    if (await post(request.endpoint, JSON.stringify({ events: sendable }), FLUSH_TIMEOUT_MS)) return;
    appendFileSync(outboxFile(home), sendable.map((e) => JSON.stringify({ endpoint: request.endpoint, ...e }) + "\n").join(""));
  } finally {
    rmSync(claimed, { force: true });
  }
}

/** The one line a session starts with while the team has asked and this developer has not answered. */
export function usageNotice(home: string = handbookHome(), root: string = marketplacesRoot()): string | null {
  if (!sessionDetectEnabled(home)) return null;
  const request = teamUsageRequest(home, root);
  if (!request || usageConsent(request.endpoint, home) !== "undecided") return null;
  return (
    `TeamHandbook: your team asks to see which ${request.plugin} skills get used, by skill name and hour, ` +
    `sent to ${request.endpoint} and nothing else. To agree, add "usage": { "shareWith": ${JSON.stringify(request.endpoint)} } ` +
    `to ${join(home, "config.json")}; "shareWith": false declines and stops this note.`
  );
}
