import { manages } from "./api";
import type { Principal } from "./api";

/**
 * The pages under Activity and Settings, and which of them a member is shown. Each section's own
 * navigation and the orchestrator search read these lists, so neither offers a member a page that
 * only refuses them. The orchestrator still refuses those pages to a member who types the address.
 */
export const ACTIVITY_PAGES = [
  { id: "usage", label: "Usage" },
  { id: "leaderboard", label: "Leaderboard", for: "team owners" },
  { id: "ai", label: "AI requests" },
  { id: "logs", label: "Logs" },
  { id: "audit", label: "Audit", for: "managers" },
  { id: "news", label: "What's new" },
] as const;

/** Settings' sections in the one order both experiences use; Your account is first and the page Settings opens on. */
export const SETTINGS_SECTIONS = [
  { id: "account", label: "Your account" },
  { id: "code", label: "Where your code lives" },
  { id: "task-limits", label: "Task limits" },
  { id: "members", label: "Members" },
  { id: "service-accounts", label: "Service accounts" },
  { id: "api-keys", label: "API keys" },
  { id: "access", label: "Access" },
  { id: "task-secrets", label: "Task secrets" },
  { id: "agents", label: "Agent readiness" },
  { id: "machines", label: "Your machines" },
  { id: "security", label: "Security" },
  { id: "privacy", label: "Privacy" },
  { id: "organization", label: "Organization" },
  { id: "updates", label: "Updates" },
] as const;

/** What a member uses in Settings, in the order they reach for it: their account, who owns which team, their own keys. */
const MEMBER_SETTINGS: readonly string[] = ["account", "members", "api-keys", "access", "machines"];

/** An orchestrator on one person's own machine has no organization to run and runs tasks right there, so it keeps only what that person sets for themselves and their agents, how long their own records are kept among them. */
const LOCAL_SETTINGS: readonly string[] = ["account", "code", "task-limits", "agents", "task-secrets", "privacy", "updates"];

/** Skill use teammates report, the leaderboard, the organization's audit and the share of a team's requests agents wrote are about a team; one person's own machine has none. */
const TEAM_ACTIVITY: readonly (string | undefined)[] = ["usage", "leaderboard", "audit", "ai"];

export function activityPageInMode(me: Principal, id: string | undefined) {
  return me.mode !== "local" || !TEAM_ACTIVITY.includes(id);
}

export function activityPagesFor(me: Principal) {
  // A team's owner reads the leaderboard of their own teams; the audit log is the organization's.
  return ACTIVITY_PAGES.filter((p) => activityPageInMode(me, p.id) && (!("for" in p) || manages(me) || (p.for === "team owners" && me.ownedTeams.length > 0)));
}

/** Whether this kind of orchestrator has the section at all; one it lacks is not found, whoever asks. */
export function settingsSectionInMode(me: Principal, id: string) {
  if (me.mode === "local") return LOCAL_SETTINGS.includes(id);
  // Connecting a machine hands out a command; one the orchestrator cannot yet answer is not offered.
  // Updating the program is one person's on their own machine; a team's orchestrator is updated where it is deployed.
  return id !== "updates" && (id !== "machines" || me.runners === true);
}

export function settingsSectionsFor(me: Principal) {
  if (me.mode === "local") return SETTINGS_SECTIONS.filter((s) => LOCAL_SETTINGS.includes(s.id));
  const shown = manages(me) ? [...SETTINGS_SECTIONS] : SETTINGS_SECTIONS.filter((s) => MEMBER_SETTINGS.includes(s.id));
  return shown.filter((s) => settingsSectionInMode(me, s.id));
}
