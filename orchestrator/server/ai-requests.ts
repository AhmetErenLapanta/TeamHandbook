import { Hono } from "hono";
import type { OrchestratorContext } from "./app.js";
import { mirrorDir } from "./app.js";
import { manages } from "./auth.js";
import type { OrchestratorEnv } from "./auth.js";
import { gitAsyncMaybe } from "./git.js";
import { detectSecret } from "./plugin.js";

export const AI_DAYS = 30;
const MAX_DAYS = 365;
/** Merged requests read per repository and window; past it the answer says it stopped. */
export const MAX_MERGES = 2000;

/** The coding agents a commit names in its trailers or its closing line, by the words each writes. */
export const AGENTS: { id: string; label: string; pattern: RegExp }[] = [
  { id: "claude-code", label: "Claude Code", pattern: /^co-authored-by:\s*claude\b.*$|^.*generated with \[?claude code\]?.*$|noreply@anthropic\.com/im },
  { id: "copilot", label: "GitHub Copilot", pattern: /^co-authored-by:\s*copilot\b.*$|^co-authored-by:.*\bcopilot@users\.noreply\.github\.com/im },
  { id: "cursor", label: "Cursor", pattern: /^co-authored-by:\s*cursor\b.*$|cursoragent@cursor\.com/im },
  { id: "codex", label: "Codex", pattern: /^co-authored-by:\s*codex\b.*$|^.*generated with \[?codex\]?.*$/im },
];

/** A request merged into a repository's default branch, as its history tells it. */
export interface MergedRequest {
  repoId: string;
  /** `!12` on GitLab, `#12` on GitHub. */
  ref: string;
  mergedAt: string;
  /** The first commit of the request, when the history keeps the branch's commits; null for a squash. */
  startedAt: string | null;
  author: { name: string; email: string };
  agents: string[];
}

const MERGE_REQUEST = /^See merge request (?:\S+)?!(\d+)\s*$/m;
const PULL_REQUEST = /^Merge pull request #(\d+) from /;
const SQUASHED = /\(#(\d+)\)\s*$/;

function agentsIn(text: string): string[] {
  return AGENTS.filter((a) => a.pattern.test(text)).map((a) => a.id);
}

/** A name or address as the page shows it: one that reads like a secret is withheld, not shown. */
function shownText(text: string): string {
  const flat = text.replace(/\p{C}+/gu, " ").trim().slice(0, 200);
  return detectSecret(flat) ? "[withheld]" : flat;
}

const FIELD = "\x1f";
const RECORD = "\x1e";

interface LoggedCommit {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committedAt: string;
  message: string;
}

async function logOf(mirror: string, args: string[]): Promise<LoggedCommit[]> {
  const format = ["%H", "%P", "%an", "%ae", "%aI", "%cI", "%B"].join(FIELD) + RECORD;
  const out = (await gitAsyncMaybe(["log", `--format=${format}`, ...args], mirror)) ?? "";
  return out.split(RECORD).map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r) => {
    const [sha, parents, authorName, authorEmail, authoredAt, committedAt, message] = r.split(FIELD) as string[];
    return { sha: sha!, parents: (parents ?? "").split(" ").filter(Boolean), authorName: authorName ?? "", authorEmail: authorEmail ?? "", authoredAt: authoredAt ?? "", committedAt: committedAt ?? "", message: message ?? "" };
  });
}

/**
 * The requests merged into the default branch since `since`, read from the history the orchestrator
 * already mirrors and from nothing else: a merge commit that names its merge request (GitLab) or
 * pull request (GitHub), or a commit squashed with the request's number at the end of its title.
 * A request counts as AI-assisted when one of its commits carries an agent's trailer. Nothing is
 * kept: the history is read again at each look.
 */
export async function mergedRequests(mirror: string, head: string, repoId: string, since: string): Promise<{ requests: MergedRequest[]; truncated: boolean }> {
  const merges = await logOf(mirror, ["--first-parent", `--since=${since}`, `-n${MAX_MERGES + 1}`, head]);
  const requests: MergedRequest[] = [];
  for (const merge of merges.slice(0, MAX_MERGES)) {
    const number = MERGE_REQUEST.exec(merge.message)?.[1] ?? PULL_REQUEST.exec(merge.message)?.[1] ?? null;
    const squashed = merge.parents.length === 1 ? SQUASHED.exec(merge.message.split("\n")[0] ?? "")?.[1] ?? null : null;
    if (merge.parents.length > 1 && number) {
      const branch = await logOf(mirror, ["--no-merges", `${merge.parents[0]}..${merge.parents[1]}`]);
      const first = branch.at(-1);
      requests.push({
        repoId,
        ref: MERGE_REQUEST.test(merge.message) ? `!${number}` : `#${number}`,
        mergedAt: merge.committedAt,
        startedAt: first?.authoredAt ?? null,
        author: { name: shownText(first?.authorName ?? merge.authorName), email: shownText(first?.authorEmail ?? merge.authorEmail) },
        agents: [...new Set([...branch, merge].flatMap((c) => agentsIn(c.message)))],
      });
    } else if (merge.parents.length === 1 && (squashed || MERGE_REQUEST.test(merge.message))) {
      requests.push({
        repoId,
        ref: squashed ? `#${squashed}` : `!${MERGE_REQUEST.exec(merge.message)![1]}`,
        mergedAt: merge.committedAt,
        // A squash keeps one commit; when its author wrote it is not when the work began.
        startedAt: null,
        author: { name: shownText(merge.authorName), email: shownText(merge.authorEmail) },
        agents: agentsIn(merge.message),
      });
    }
  }
  return { requests, truncated: merges.length > MAX_MERGES };
}

export interface AiStats {
  merged: number;
  aiAssisted: number;
  /** Of the merged requests, the share AI-assisted; null while none merged. */
  share: number | null;
  /** Hours from a request's first commit to its merge, for those whose history keeps both. */
  hoursToMerge: { ai: { median: number; p90: number } | null; other: { median: number; p90: number } | null };
}

const hours = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 3_600_000;

function quantiles(values: number[]): { median: number; p90: number } | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => Math.round(sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))]! * 10) / 10;
  return { median: at(0.5), p90: at(0.9) };
}

export function aiStats(requests: readonly MergedRequest[]): AiStats {
  const ai = requests.filter((r) => r.agents.length);
  const waits = (list: readonly MergedRequest[]) => list.flatMap((r) => (r.startedAt ? [hours(r.startedAt, r.mergedAt)] : [])).filter((h) => h >= 0);
  return {
    merged: requests.length,
    aiAssisted: ai.length,
    share: requests.length ? Math.round((ai.length / requests.length) * 1000) / 1000 : null,
    hoursToMerge: { ai: quantiles(waits(ai)), other: quantiles(waits(requests.filter((r) => !r.agents.length))) },
  };
}

export interface AiAnalytics {
  days: number;
  since: string;
  total: AiStats;
  byAgent: { agent: string; label: string; requests: number }[];
  byTeam: ({ team: string } & AiStats)[];
  byRepo: ({ repoId: string; team: string } & AiStats)[];
  /** Per person, by commit author; shown to owners and admins only, null for anyone else. */
  byPerson: ({ name: string; email: string } & AiStats)[] | null;
  /** Repositories whose window held more merged requests than are read. */
  truncated: string[];
}

export async function aiAnalytics(ctx: OrchestratorContext, days: number, people: boolean, now = new Date()): Promise<AiAnalytics> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const repos = (await ctx.store.listRepos(ctx.tenant)).filter((r) => r.head);
  const all: MergedRequest[] = [];
  const truncated: string[] = [];
  for (const repo of repos) {
    const read = await mergedRequests(mirrorDir(ctx, repo.id), repo.head!, repo.id, since);
    all.push(...read.requests);
    if (read.truncated) truncated.push(repo.id);
  }
  const teamOf = new Map(repos.map((r) => [r.id, r.team]));
  const teams = [...new Set(repos.map((r) => r.team))].sort();
  const persons = [...new Map(all.map((r) => [r.author.email.toLowerCase(), r.author])).values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    days,
    since,
    total: aiStats(all),
    byAgent: AGENTS.map((a) => ({ agent: a.id, label: a.label, requests: all.filter((r) => r.agents.includes(a.id)).length })),
    byTeam: teams.map((team) => ({ team, ...aiStats(all.filter((r) => teamOf.get(r.repoId) === team)) })),
    byRepo: repos.map((r) => ({ repoId: r.id, team: r.team, ...aiStats(all.filter((x) => x.repoId === r.id)) })),
    byPerson: people ? persons.map((p) => ({ ...p, ...aiStats(all.filter((r) => r.author.email.toLowerCase() === p.email.toLowerCase())) })) : null,
    truncated,
  };
}

/**
 * The share of merged requests a coding agent helped write, read from each team repository's
 * own history. Anyone signed in reads the totals and the teams and repositories; who wrote them
 * is shown to those who manage the organization.
 */
export function aiRequestRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  app.get("/api/analytics/ai-requests", async (c) => {
    const given = c.req.query("days");
    const days = given === undefined ? AI_DAYS : Number(given);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) return c.json({ error: `days is a whole number from 1 to ${MAX_DAYS}` }, 400);
    return c.json(await aiAnalytics(ctx, days, manages(c.get("user"))));
  });
  return app;
}
