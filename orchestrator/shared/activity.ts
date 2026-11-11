// Shapes the server answers with and the screens read, imported by both sides so neither
// keeps a copy that drifts.

import type { TaskPhase } from "./work.js";

export type RequestStatus = "open" | "merged" | "closed";
/** `interrupted`: stopped part way, by a closed machine, a usage limit or a sign-in; the person continues or cancels it. */
export type TaskStatus = "queued" | "running" | "needs-review" | "failed" | "cancelled" | "interrupted";

/** An organization this browser holds a session in, with the person's name and role there. */
/** `name` and `role` are the signed-in person's in that org; `orgName` is the name the org is shown by. */
export interface Org { tenant: string; orgName?: string; name: string; role: "owner" | "admin" | "member" | "viewer" }
/** The organizations to offer, and the one unprefixed API paths answer for. */
export interface OrgList { default: string; orgs: Org[] }

export interface UsageCount { repoId: string; skill: string; count: number; lastHour: string }

/** What the Activity overview reads in one call: the getting-started checks and the tiles. */
export interface ActivitySummary {
  repos: number;
  requests: Record<RequestStatus, number>;
  members: number;
  usage: { days: number; total: number; top: UsageCount[] };
  /** Each recent task carries what the task list reads a person's decision from, so both name it alike. */
  tasks: { total: number; recent: { id: string; title: string; team: string; status: TaskStatus; createdAt: string; phase: TaskPhase; result: "request" | "changes" | null; changes: { undone: boolean; kept: boolean } | null; request: { status: RequestStatus } | null; requests: { status: RequestStatus }[] }[] };
  /** Repositories read from GitLab or GitHub rather than a path on this machine, and how many of them have forge access set. */
  forges: { hosted: number; connected: number };
  /** Whether an issue tracker is connected: Jira, or GitLab or GitHub issues. */
  tracker: boolean;
}

export const USAGE_WINDOWS = [7, 30, 90] as const;

/** Skill use over a window: a total per day for the chart, and the same counts by team and by skill. */
export interface UsageReport {
  days: number;
  series: { day: string; count: number }[];
  total: number;
  byTeam: { team: string; count: number }[];
  bySkill: { repoId: string; repo: string; team: string; skill: string; count: number }[];
  /** Set when the breakdown covers only the teams this person can change, not the whole organization. */
  scope?: { teams: string[] };
}

/** Teams and skills ranked by use. People are not ranked: a usage report carries no name. */
export interface Leaderboard {
  days: number;
  teams: { team: string; count: number; skills: number }[];
  skills: { repoId: string; repo: string; team: string; skill: string; count: number }[];
  /** Set when the ranking covers only the teams this person can change. */
  scope?: { teams: string[] };
}

/** Something done in the orchestrator, from its append-only event log: who did it, to which repository and thing. */
export interface OrchestratorEvent {
  id: string;
  at: string;
  kind: string;
  actor: { kind: "user" | "service" | "orchestrator"; id: string | null; email: string | null; name: string | null };
  repoId: string | null;
  subject: string | null;
  detail: string;
  /** Field by field, where the event changed a setting. */
  changes?: { field: string; from: string | null; to: string | null }[];
  /** Who did what, as a person says it ("Lee Lead set up the orchestrator"); the log's list and one entry carry it. */
  summary?: string;
}
export interface EventPage { events: OrchestratorEvent[]; next: string | null; retentionDays: number | null }
/** One event, with the address that opens it again to share. */
export interface EventRecord { event: OrchestratorEvent; link: string }

/** The getting-started steps a person marks by hand, since the orchestrator cannot see them happen. */
export const MARKED_STEPS = ["join"] as const;
export type MarkedStep = (typeof MARKED_STEPS)[number];

/** The steps of a cloud organization's welcome an owner or admin can leave for later. */
export const SKIPPABLE_STEPS = ["forge", "repo", "members", "start", "agent", "task"] as const;
export type SkippedStep = (typeof SKIPPABLE_STEPS)[number];

/** The organization's getting-started guide: hidden or shown, the steps marked done and those left for later, for everyone in it. */
export interface Onboarding { dismissed: boolean; marked: MarkedStep[]; skipped: SkippedStep[] }

/** Where the person asking stands against each monthly task budget that applies to them, this calendar month (UTC). */
export interface CurrentBudgets {
  month: string;
  budgets: { policyId: string | null; policy: string; per: "audience" | "member"; monthlyUsd: number; spentUsd: number; leftUsd: number; reached: boolean; unknownCost: number }[];
}

/** What one person's tasks came to over the window, as a team's lead reads it. */
export interface PersonOutcomes {
  email: string;
  name: string | null;
  tasks: number;
  /** Requests merged and closed unmerged. */
  merged: number;
  closed: number;
  /** Changes in a folder without git kept by their person, and undone. */
  kept: number;
  undone: number;
  failed: number;
  /** What their tasks cost in US dollars, over the tasks whose cost is known; `unknownCost` counts the others. */
  usd: number;
  unknownCost: number;
}

/** The team view's answer: each person's tasks started in the last `days` days, since `since`. */
export interface PeopleOutcomes {
  days: number;
  since: string;
  people: PersonOutcomes[];
}
