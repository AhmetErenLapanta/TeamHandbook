import type { ActivitySummary, OrchestratorEvent, CurrentBudgets, EventPage, EventRecord, Leaderboard, Onboarding, Org, OrgList, RequestStatus, TaskStatus, UsageCount, UsageReport } from "../../shared/activity";
import type { PermissionMode } from "../../shared/permission-mode";
import type { HostedForge } from "../../shared/forge-def";
import type { AgentQuestion, QuestionAnswers } from "./questions";
import type { ChangedFile } from "./request-reads";
import { sentence } from "./said";

export type { ActivitySummary, OrchestratorEvent, CurrentBudgets, EventPage, EventRecord, Leaderboard, Onboarding, Org, OrgList, RequestStatus, TaskStatus, UsageCount, UsageReport };

export interface RepoRecord {
  id: string;
  team: string;
  name: string;
  url: string;
  head: string | null;
  syncedAt: string | null;
  error: string | null;
  /** False once the orchestrator's configuration no longer lists it: kept and readable, not synced or changed. */
  configured?: boolean;
  kind?: "skills" | "code";
  /** The skills project a code project's tasks read, or null for none. */
  skillsFrom?: string | null;
  /** Where it was connected: listed in the configuration file, or connected from the screen. */
  source?: "file" | "orchestrator";
  /** What the repositories list shows a lead: what it shares, what waits in it, and whether its setup asks for anything. */
  summary?: { skills: number; mcpServers: number; commands: number; waiting: number; health: "fine" | "attention" | "problem" | null };
}

export interface SkillItem { slug: string; name: string; description: string; files: string[]; problem?: string; format: string[] }
/** The skills that answer the same requests as one skill, most overlapping first, and how many past those. */
export interface SkillOverlap { names: string[]; more: number }
export interface McpItem { name: string; transport: string; target: string; envNames: string[]; shareable: boolean; refusal?: string; inTasks?: { usable: boolean; detail: string; signIn: boolean } }
export interface CommandItem { name: string; description: string; file: string }
export interface TeamRecord { commitPrefix?: string; commitPrefixProblem?: string; branchExample?: string; reviewers?: string[]; labels?: string[]; scaffoldVersion?: string; usageEndpoint?: string; problem?: string }
/** `heldHead` is a push after the request opened that has not passed the team's rules; `heldReason` says why, and the request does not merge until a later push passes. */
export interface RequestRecord { repoId: string; number: number; url: string; branch: string; title: string; status: RequestStatus; provider: string; createdAt: string; createdBy: string; notes?: string[]; checkedHead?: string; heldHead?: string; heldReason?: string }
export interface RequestPage { requests: RequestRecord[]; total: number; counts: Record<RequestStatus, number>; pageSize: number; next: string | null }

export type ChangeInput =
  | { kind: "skill.add" | "skill.edit"; slug: string; content: string }
  | { kind: "skill.delete"; slug: string }
  | { kind: "mcp.add"; name: string; config: Record<string, unknown> }
  | { kind: "mcp.edit"; name: string; config: Record<string, unknown> }
  | { kind: "mcp.remove"; name: string }
  | { kind: "command.add" | "command.edit"; name: string; content: string }
  | { kind: "command.delete"; name: string }
  | { kind: "team.settings"; reviewers: string[]; labels: string[] }
  | { kind: "team.naming"; commitPrefix: string; branchExample: string };

/** What the orchestrator proposes before a request opens: the commit message, and the branch named the team's way (with `<TICKET>` left in when the team's branches start with one). */
export interface Proposal { proposal: string; branch: string }

export interface ForgeConfig { kind: HostedForge; apiUrl: string; project: string }
export interface ForgeSettings { config: ForgeConfig | null; token: { set: boolean; updatedAt?: string; updatedBy?: string }; vault: boolean; forges?: HostedForge[] }
export interface Inventory {
  head: string;
  plugin: { name?: string; version?: string; versionedByCommit: boolean };
  marketplace: { name?: string; plugins: string[] };
  skills: SkillItem[];
  mcpServers: McpItem[];
  commands: CommandItem[];
  team: TeamRecord | null;
  setup: SetupFinding[];
}
/** One thing the setup panel says: what is so, and what to do when something is to be done. */
export interface SetupFinding { level: "ok" | "attention" | "problem" | "suggestion"; title: string; detail?: string; next?: string; more?: string; refresh?: true }
/** Whether the repository's page refreshes the scaffold itself, or why it does not. */
export type ScaffoldRefresh = { available: true } | { problem: string };
/** A request open on the team repository, or a local branch not merged yet; `byOrchestrator` when the orchestrator opened it. */
export interface PendingShare { number: number | null; title: string; branch: string; url: string | null; author: string; updatedAt: string; fromFork: boolean; byOrchestrator: boolean; scan?: PendingScan | null }
/** A waiting request read against the plugin's share rules on the orchestrator's own copy, before anyone merges it. */
export interface PendingScan {
  state: "clean" | "attention" | "refused" | "unread";
  head: string | null;
  findings: { level: "refused" | "attention"; path: string; detail: string; check?: string; risk?: "high" | "medium"; line?: number; evidence?: string }[];
  reason?: string;
}
/** What a usage request does: ask a team to report, move its reports to a new address, or stop asking. */
export type UsageAction = "ask" | "rotate" | "stop";
/** What teammates type in Claude Code to join a repository, or why the page shows nothing to type. */
export type JoinMessage = { url: string; use: string[]; contribute: string } | { problem: string };
export interface HistoryEntry { sha: string; date: string; author: string; subject: string }

export type Role = "owner" | "admin" | "member" | "viewer";
export interface Principal {
  id: string; name: string; email: string; role: Role; ownedTeams: string[]; forgeLogin?: string;
  /** How the orchestrator runs; missing on an orchestrator from before the cloud mode, which runs self-hosted. */
  mode?: "local" | "cloud" | "self-hosted";
  /** Set once people's machines can be connected to run its tasks; until then no screen offers to connect one. */
  runners?: boolean;
  /** Whether this orchestrator runs tasks on its own machine; missing on one from before, which no screen asks to connect a computer. */
  tasksRunHere?: boolean;
  /** Whether repositories are connected by a path under ORCHESTRATOR_LOCAL_REPOS_ROOT on this orchestrator's server; missing on one from before, which offers the path. */
  pathRepos?: boolean;
  /** The most a key this person mints carries, from their role; missing on an orchestrator from before, which caps every key at KEY_MOST. */
  keyCeiling?: Scopes;
}

/** Owners and admins manage the organization; the server's rule, repeated so the screen offers only what it would accept. */
export function manages(me: Principal): boolean {
  return me.role === "owner" || me.role === "admin";
}
export interface UserView { id: string; email: string; name: string; role: Role; ownedTeams: string[]; forgeLogin: string | null; signIn: string[]; createdAt: string }
export interface TeamView { team: string; repos: string[]; owners: { id: string; name: string }[]; canEdit: boolean }
export interface AuthConfig { setupNeeded: boolean; sso: boolean; privacyUrl?: string | null; termsUrl?: string | null }

/** A refusal the orchestrator gave: its message for a person, and the code and status a screen can branch on. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    /** The refusal's whole answer, for a screen that shows more of it than the message, such as steps to take. */
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Thrown for a 401, so the shell can show the sign-in screen instead of an error. */
export class SignedOut extends ApiError {
  constructor(message: string) {
    super(message, "signed-out", 401);
  }
}
/** Thrown for a 404, so a screen can tell a page this orchestrator does not offer from a failure. */
export class NotFound extends ApiError {
  constructor(message: string, code = "not-found") {
    super(message, code, 404);
  }
}

/** The audit filters: a repository, an event kind or its prefix (`request.`), and a day range. */
export interface AuditFilter { repo?: string; kind?: string; since?: string; until?: string }

function auditQuery(filter: AuditFilter, after: string | null): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
  if (after) params.set("after", after);
  return params;
}

// The token every change has to carry back in a header; /api/me hands it out with the session.
let csrf = "";
// Requests go to the organization on screen: the default one answers unprefixed paths, every
// other one under /api/orgs/<tenant>/, with a session of its own.
let base = "/api";

/** Fired when the organization's guide changes here, so every part of the page showing it reads it again. */
export const ONBOARDING_CHANGED = "orchestrator:onboarding";

export function setOrg(org: string | null, defaultOrg: string | null): void {
  base = !org || org === defaultOrg ? "/api" : `/api/orgs/${encodeURIComponent(org)}`;
}

/** An API path in the organization on screen, for calls and for links that leave the page (exports, SSO). */
export function apiPath(path: string): string {
  return path === "/api/orgs" ? path : `${base}${path.slice("/api".length)}`;
}

export function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  return send<T>(method, apiPath(path), body, csrf);
}

async function send<T>(method: string, url: string, body: unknown, token: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-csrf-token"] = token;
  // A dropped connection and a failure without a reason of its own say what happened and
  // what to do next, rather than the browser's "Failed to fetch" or a bare status text.
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => {
    throw new Error("The orchestrator did not answer. Check that it is running and reachable from here, then try again.");
  });
  const payload = await res.json().catch(() => ({}));
  // Every reason the server gives reaches the page as a sentence, so no screen shows one in lower case or runs it into the next.
  const reason = typeof payload.error === "string" && payload.error.trim() ? sentence(payload.error) : null;
  if (res.status === 401) throw new SignedOut(reason ?? "Sign in first.");
  const code = typeof payload.code === "string" ? payload.code : "error";
  if (res.status === 404) throw new NotFound(reason ?? "Not found.", code === "error" ? "not-found" : code);
  if (!res.ok) throw new ApiError(reason ?? `The orchestrator failed to answer (${res.status} ${res.statusText}). Try again; when it keeps failing, the orchestrator's log says why.`, code, res.status, payload);
  return payload as T;
}

function get<T>(path: string): Promise<T> {
  return call<T>("GET", path);
}

export type SignInProvider = "google" | "github" | "microsoft";
/** A cloud orchestrator's sign-in, answered before any organization; a self-hosted orchestrator has none. */
export interface IdentityConfig { providers: SignInProvider[]; privacyUrl: string | null; termsUrl: string | null; signupOpen: boolean; helpUrl?: string | null; mode?: "cloud"; readmeUrl?: string | null }
/** What a local orchestrator answers in place of a sign-in configuration: its one person signs in from the address its command prints. */
export interface LocalConfig { mode: "local" }
/** A self-hosted orchestrator signs people in per organization, so it has no sign-in of its own. */
interface SelfHostedConfig { mode: "self-hosted" }
export interface IdentityView {
  identity: { email: string; name: string; signedInWith: SignInProvider };
  logins: { provider: SignInProvider; email: string; addedAt: string }[];
  memberships: { tenant: string; name: string; role: Role; reachable: boolean }[];
  csrf: string;
}

export interface JoinedOrg { tenant: string; orgName: string; next: string }
export interface PendingInvitation { id: string; orgName: string; invitedBy: string; role: Role; teams: string[]; expiresAt: string }
/** An organization whose owner lets the directory of this session's account join, open with one click. */
export interface JoinableOrg { tenant: string; orgName: string; role: "member" | "viewer" }

/** The person signed in to a cloud orchestrator, across its organizations: these paths never carry an organization. */
export const identityApi = {
  /** Null on a self-hosted orchestrator, which says so, or one from before that answers no such path. */
  config: () =>
    send<IdentityConfig | LocalConfig | SelfHostedConfig>("GET", "/api/identity/config", undefined, "").then(
      (config) => (config.mode === "self-hosted" ? null : config),
      (e: Error) => {
        if (e instanceof NotFound) return null;
        throw e;
      },
    ),
  me: () => send<IdentityView>("GET", "/api/identity", undefined, ""),
  /** Where to send the browser to add a provider as a way to sign in; refused with code "reauth" when the sign-in is older than ten minutes. */
  addLogin: (provider: SignInProvider, token: string) => send<{ url: string }>("POST", `/api/identity/logins/${provider}`, undefined, token),
  removeLogin: (provider: SignInProvider, token: string) => send<void>("DELETE", `/api/identity/logins/${provider}`, undefined, token),
  /** An account under another address, waiting for the person to confirm it is theirs. */
  awaitingLogin: (link: string) => send<{ provider: SignInProvider; email: string }>("GET", `/api/identity/logins/confirm/${encodeURIComponent(link)}`, undefined, ""),
  confirmLogin: (link: string, token: string) => send<{ provider: SignInProvider }>("POST", `/api/identity/logins/confirm/${encodeURIComponent(link)}`, undefined, token),
  createOrganization: (input: { name: string; slug: string; acceptTerms: boolean }, token: string) => send<{ tenant: string; name: string; next: string }>("POST", "/api/signup/organization", input, token),
  signOut: (token: string) => send<{ ok: true }>("POST", "/api/identity/logout", undefined, token),
  /** The operator's page; a 404 for anyone who is not an operator, as for an address that does not exist. */
  operatorFunnel: <T>(days: number) => send<T>("GET", `/api/operator/funnel?days=${days}`, undefined, ""),
  /** Taking an invitation as the identity signed in now, without another round through its provider. */
  join: (invite: string, token: string) => send<JoinedOrg>("POST", "/api/identity/join", { token: invite }, token),
  /** The organizations and pending invitations of the identity signed in now; a self-hosted orchestrator answers 404. */
  orgs: () => send<{ orgs: { tenant: string; orgName: string; role: Role }[]; invitations: PendingInvitation[]; joinable: JoinableOrg[] }>("GET", "/api/me/orgs", undefined, ""),
  joinByDirectory: (tenant: string, token: string) => send<JoinedOrg>("POST", `/api/me/joinable/${encodeURIComponent(tenant)}`, undefined, token),
  acceptInvitation: (id: string, token: string) => send<JoinedOrg>("POST", `/api/me/invitations/${encodeURIComponent(id)}/accept`, undefined, token),
  declineInvitation: (id: string, token: string) => send<void>("DELETE", `/api/me/invitations/${encodeURIComponent(id)}`, undefined, token),
};

export interface SessionListing { id: string; createdAt: string | null; lastSeenAt: string | null; userAgent: string | null; expiresAt: string; current: boolean }
export interface AppGrant { id: string; clientName: string; scopes: string[]; createdAt: string }

/** Where this person is signed in and which apps they approved, and ending either. */
export const accessApi = {
  sessions: () => get<{ sessions: SessionListing[] }>("/api/me/sessions").then((b) => b.sessions),
  end: (id: string) => call<{ ok: true }>("DELETE", `/api/me/sessions/${encodeURIComponent(id)}`),
  apps: () => get<{ apps: AppGrant[] }>("/api/me/apps").then((b) => b.apps),
  takeBack: (id: string) => call<{ ok: true }>("DELETE", `/api/me/apps/${encodeURIComponent(id)}`),
};

export const auth = {
  config: () => get<AuthConfig>("/api/auth/config"),
  me: async () => {
    const body = await get<{ user: Principal; csrf: string }>("/api/me");
    csrf = body.csrf;
    return body.user;
  },
  login: (email: string, password: string) => call("POST", "/api/auth/login", { email, password }),
  setup: (input: { code: string; email: string; name: string; password: string }) => call("POST", "/api/auth/setup", input),
  logout: () => call("POST", "/api/auth/logout"),
  changePassword: (current: string, next: string) => call("POST", "/api/me/password", { current, next }),
};

export const people = {
  users: () => get<{ users: UserView[] }>("/api/users").then((b) => b.users),
  teams: () => get<{ teams: TeamView[] }>("/api/teams").then((b) => b.teams),
  create: (input: { email: string; name: string; role: Role; password?: string; teams?: string[]; forgeLogin?: string }) =>
    call<{ user: UserView }>("POST", "/api/users", input).then((b) => b.user),
  update: (id: string, input: Partial<{ name: string; role: Role; password: string; teams: string[]; forgeLogin: string }>) =>
    call<{ user: UserView }>("PATCH", `/api/users/${id}`, input).then((b) => b.user),
  remove: (id: string) => call("DELETE", `/api/users/${id}`),
};

export interface InviteView { id: string; email: string; role: Role; teams: string[]; invitedBy: string; createdAt: string; expiresAt: string; expired: boolean }
export type SentInvite = InviteView & { link: string };
export interface MemberPage {
  member: UserView;
  tags: MemberTag[];
  requests: RequestRecord[];
  tasks: { id: string; repoId: string; title: string; status: string; createdAt: string; requestNumber: number | null }[];
  totals: { requests: number; tasks: number };
}

export const members = {
  page: (id: string) => get<MemberPage>(`/api/members/${id}`),
  invites: () => get<{ invites: InviteView[] }>("/api/invites").then((b) => b.invites),
  invite: (input: { emails: string; role: Role; teams: string[] }) => call<{ invited: SentInvite[]; skipped: { email: string; reason: string }[] }>("POST", "/api/invites", input),
  resend: (id: string) => call<{ invite: SentInvite }>("POST", `/api/invites/${id}/resend`).then((b) => b.invite),
  revoke: (id: string) => call("DELETE", `/api/invites/${id}`),
  leave: () => call("POST", "/api/me/leave"),
};

export const RESOURCES = ["repositories", "requests", "tasks", "usage", "members", "settings", "keys"] as const;
export type Resource = (typeof RESOURCES)[number];
export type Access = "none" | "read" | "write";
export type Scopes = Record<Resource, Access>;
/** The most a key gets per resource; the server's MOST, repeated so the form offers only what it accepts. */
export const KEY_MOST: Scopes = { repositories: "write", requests: "write", tasks: "write", usage: "read", members: "read", settings: "read", keys: "write" };
export interface KeyView {
  id: string; name: string; prefix: string; owner: { kind: "user" | "service"; id: string }; scopes: Scopes; createdBy: string; createdAt: string;
  expiresAt: string | null; lastUsedAt: string | null; status: "active" | "expired" | "revoked";
}
export interface ServiceAccountView { id: string; name: string; principalId: string; ownedTeams: string[]; createdBy: string; createdAt: string; activeKeys: number; lastUsedAt: string | null }

export const keysApi = {
  list: (serviceAccount?: string) => get<{ keys: KeyView[] }>(`/api/keys${serviceAccount ? `?serviceAccount=${serviceAccount}` : ""}`).then((b) => b.keys),
  create: (input: { name: string; scopes: Partial<Scopes>; expiresInDays: number | null; serviceAccountId?: string }) => call<{ key: KeyView; secret: string }>("POST", "/api/keys", input),
  revoke: (id: string) => call("DELETE", `/api/keys/${id}`),
  serviceAccounts: () => get<{ serviceAccounts: ServiceAccountView[] }>("/api/service-accounts").then((b) => b.serviceAccounts),
  createServiceAccount: (input: { name: string; teams: string[] }) => call<{ serviceAccount: ServiceAccountView }>("POST", "/api/service-accounts", input).then((b) => b.serviceAccount),
  updateServiceAccount: (id: string, input: Partial<{ name: string; teams: string[] }>) => call("PATCH", `/api/service-accounts/${id}`, input),
  removeServiceAccount: (id: string) => call("DELETE", `/api/service-accounts/${id}`),
};

export interface MemberTag { tag: string; source: "manual" | "directory" }
export interface DirectoryView { sso: { issuer: string; groupsClaim: string } | null; groups: { group: string; members: number; tag: string | null }[] }
export interface TagPreview { changes: { member: { id: string; name: string; email: string }; gains: string[]; loses: string[] }[]; fingerprint: string }

export interface SsoDomain { domain: string; verified: boolean; verifiedAt: string | null; addedBy: string; addedAt: string; record: { name: string; value: string } }

export interface DirectoryJoin { provider: "google" | "microsoft"; directory: string; role: "member" | "viewer"; by: string; at: string }

/** Who joins a cloud organization without an invitation: the directory of the owner's own account, or nobody. */
export const directoryJoin = {
  read: () => get<{ join: DirectoryJoin | null; yours: { provider: "google" | "microsoft"; directory: string } | null }>("/api/directory-join"),
  set: (on: boolean, role: "member" | "viewer" = "member") => call<{ join: DirectoryJoin | null }>("PUT", "/api/directory-join", { on, role }).then((b) => b.join),
};

export const ssoDomains = {
  list: () => get<{ sso: boolean; domains: SsoDomain[] }>("/api/sso/domains"),
  add: (domain: string) => call<{ domain: SsoDomain }>("POST", "/api/sso/domains", { domain }).then((b) => b.domain),
  verify: (domain: string) => call<{ domain: SsoDomain }>("POST", `/api/sso/domains/${encodeURIComponent(domain)}/verify`).then((b) => b.domain),
  remove: (domain: string) => call("DELETE", `/api/sso/domains/${encodeURIComponent(domain)}`),
};

export const directory = {
  read: () => get<DirectoryView>("/api/directory"),
  preview: (mapping: { group: string; tag: string }[]) => call<TagPreview>("POST", "/api/directory/preview", { mapping }),
  apply: (mapping: { group: string; tag: string }[], fingerprint: string) => call<TagPreview>("PUT", "/api/directory", { mapping, fingerprint }),
  setTags: (id: string, tags: string[]) => call<{ tags: MemberTag[] }>("PUT", `/api/members/${id}/tags`, { tags }).then((b) => b.tags),
};

export interface PrivacyView {
  privacy: { leaderboard: "admins" | "members"; taskLogDays: number; usageDays: number };
  usage: { repoId: string; name: string; team: string; reporting: boolean | null }[];
}

export interface OrganizationView { tenant: string; name: string }

export const organizationApi = {
  read: () => get<OrganizationView>("/api/org"),
  rename: (name: string) => call<OrganizationView>("PUT", "/api/org", { name }),
};

/** The two limits a task stops at, whichever comes first; null is no limit. */
export interface TaskLimits { maxUsd: number | null; maxMinutes: number | null }

export const taskLimitsApi = {
  read: () => get<TaskLimits>("/api/settings/task-limits"),
  change: (limits: TaskLimits) => call<TaskLimits>("PUT", "/api/settings/task-limits", limits),
};

export const privacyApi = {
  read: () => get<PrivacyView>("/api/privacy"),
  change: (input: Partial<PrivacyView["privacy"]>) => call<{ privacy: PrivacyView["privacy"] }>("PUT", "/api/privacy", input).then((b) => b.privacy),
};

export interface DeletionSummary {
  tenant: string; email: string; role: Role; ownedTeams: string[]; activeKeys: number; openRequests: number;
  unfinishedTasks: { id: string; title: string; status: string }[]; blocked: string | null;
}

/**
 * A call in one named organization with that organization's own session and CSRF token, for
 * the account page, which acts in every organization this browser is signed in to.
 */
async function inOrg<T>(tenant: string, defaultOrg: string, method: string, path: string, body?: unknown): Promise<T> {
  const prefix = tenant === defaultOrg ? "/api" : `/api/orgs/${encodeURIComponent(tenant)}`;
  const send = async (m: string, p: string, b?: unknown, token?: string) => {
    const res = await fetch(`${prefix}${p}`, {
      method: m,
      headers: { ...(b === undefined ? {} : { "content-type": "application/json" }), ...(token ? { "x-csrf-token": token } : {}) },
      body: b === undefined ? undefined : JSON.stringify(b),
    }).catch(() => {
      throw new Error("The orchestrator did not answer. Check that it is running and reachable from here, then try again.");
    });
    const payload = await res.json().catch(() => ({}));
    if (res.status === 401) throw new SignedOut(payload.error ?? "sign in first");
    if (!res.ok) throw new ApiError(payload.error ?? `The orchestrator failed to answer (${res.status} ${res.statusText}).`, typeof payload.code === "string" ? payload.code : "error", res.status);
    return payload;
  };
  if (method === "GET") return send(method, path) as Promise<T>;
  const { csrf: token } = (await send("GET", "/me")) as { csrf: string };
  return send(method, path, body, token) as Promise<T>;
}

export const account = {
  /** The organizations this browser is signed in to; an orchestrator without organizations answers with just the one on screen. */
  orgs: async (): Promise<OrgList> => (await api.orgs()) ?? { default: "", orgs: [] },
  rename: (tenant: string, defaultOrg: string, name: string) => inOrg<{ user: Principal }>(tenant, defaultOrg, "PATCH", "/me", { name }),
  summary: (tenant: string, defaultOrg: string) => inOrg<{ summary: DeletionSummary }>(tenant, defaultOrg, "GET", "/me/deletion").then((b) => b.summary),
  remove: (tenant: string, defaultOrg: string, confirm: string) => inOrg(tenant, defaultOrg, "POST", "/me/deletion", { confirm }),
};

/** `reference` is a 1Password item the orchestrator reads when a task starts, in place of a sealed value. */
export interface TaskSecretView { scope: "team" | "repo"; target: string; name: string; updatedAt: string; updatedBy: string; reference?: string }

export const taskSecrets = {
  /** `op` names the 1Password vaults this orchestrator reads, null when it reads none. */
  list: () => get<{ secrets: TaskSecretView[]; vault: boolean; op?: string[] | null }>("/api/task-secrets"),
  set: (input: { scope: "team" | "repo"; target: string; name: string } & ({ value: string } | { secret: { provider: "op"; reference: string } })) => call<{ secret: TaskSecretView }>("PUT", "/api/task-secrets", input).then((b) => b.secret),
  remove: (input: { scope: "team" | "repo"; target: string; name: string }) => call("DELETE", "/api/task-secrets", input),
};

export interface ScimStatus { baseUrl: string; token: { prefix: string; createdBy: string; createdAt: string; lastUsedAt: string | null } | null }

export const scim = {
  read: () => get<ScimStatus>("/api/scim"),
  create: () => call<{ token: string; baseUrl: string }>("POST", "/api/scim/token"),
  remove: () => call("DELETE", "/api/scim/token"),
};

export const join = {
  read: (token: string) => call<{ invite: { email: string; role: Role; teams: string[]; invitedBy: string; expiresAt: string; ssoRequired: boolean }; org: string; sso: boolean; signedIn?: boolean; emailMatches?: boolean | null }>("POST", "/api/join/read", { token }),
  accept: (token: string, input: { name: string; password: string }) => call("POST", "/api/join", { token, ...input }),
};

export const api = {
  summary: () => get<ActivitySummary>("/api/activity/summary"),
  onboarding: () => get<Onboarding>("/api/activity/onboarding"),
  changeOnboarding: (change: Partial<Onboarding>) =>
    call<Onboarding>("PUT", "/api/activity/onboarding", change).then((next) => {
      window.dispatchEvent(new Event(ONBOARDING_CHANGED));
      return next;
    }),
  usageReport: (days: number, repoId?: string) => get<UsageReport>(`/api/activity/usage?${new URLSearchParams({ days: String(days), ...(repoId ? { repo: repoId } : {}) })}`),
  usageExport: (days: number, format: "csv" | "json", repoId?: string) => apiPath(`/api/activity/usage/export?${new URLSearchParams({ days: String(days), format, ...(repoId ? { repo: repoId } : {}) })}`),
  leaderboard: (days: number) => get<Leaderboard>(`/api/activity/leaderboard?days=${days}`),
  /** Null while the orchestrator does not record an audit trail yet. */
  audit: (filter: AuditFilter, after: string | null) =>
    get<EventPage>(`/api/events?${auditQuery(filter, after)}`).catch((e: Error) => {
      if (e instanceof NotFound) return null;
      throw e;
    }),
  event: (id: string) => get<EventRecord>(`/api/events/${encodeURIComponent(id)}`),
  auditExport: (filter: AuditFilter, format: "csv" | "jsonl") => apiPath(`/api/events/export?${auditQuery(filter, null)}&format=${format}`),
  /** Before any sign-in no organization is named, and an orchestrator without organizations answers 401 here. */
  orgs: () =>
    get<OrgList>("/api/orgs").catch((e: Error) => {
      if (e instanceof SignedOut) return null;
      throw e;
    }),
  repos: () => get<{ repos: RepoRecord[] }>("/api/repos").then((b) => b.repos),
  inventory: (id: string) => get<{ repo: RepoRecord; inventory: Inventory; join: JoinMessage; refresh: ScaffoldRefresh }>(`/api/repos/${id}/inventory`),
  history: (id: string, path?: string) =>
    get<{ history: HistoryEntry[] }>(`/api/repos/${id}/history${path ? `?path=${encodeURIComponent(path)}` : ""}`).then((b) => b.history),
  sync: (id: string) => call<{ head: string }>("POST", `/api/repos/${id}/sync`),
  disconnect: (id: string) => call<{ disconnected: string }>("DELETE", `/api/repos/${id}`),
  connectRepo: (body: Record<string, string>) => call<{ repo: RepoRecord }>("POST", "/api/repos", body).then((b) => b.repo),
  usage: (id: string) => get<{ days: number; usage: UsageCount[]; shown: boolean }>(`/api/usage?repo=${id}`),
  overlaps: (id: string) => get<{ head: string; overlaps: Record<string, SkillOverlap> }>(`/api/repos/${id}/overlaps`),
  pending: (id: string) => get<{ pending: PendingShare[] | null; reason?: string }>(`/api/repos/${id}/pending`),
  requests: (query: { repoId?: string; status?: RequestStatus | null; after: string | null }) => {
    const params = new URLSearchParams({ ...(query.after ? { after: query.after } : {}), ...(query.repoId ? { repo: query.repoId } : {}), ...(query.status ? { status: query.status } : {}) });
    return get<RequestPage>(`/api/requests?${params}`);
  },
  skill: (id: string, slug: string) => get<{ head: string; content: string }>(`/api/repos/${id}/skills/${slug}`),
  command: (id: string, name: string) => get<{ head: string; content: string }>(`/api/repos/${id}/commands/${encodeURIComponent(name)}`),
  mcpServer: (id: string, name: string) => get<{ head: string; config: Record<string, unknown> }>(`/api/repos/${id}/mcp-servers/${encodeURIComponent(name)}`),
  proposal: (id: string, change: ChangeInput) => call<Proposal>("POST", `/api/repos/${id}/changes/proposal`, { change }),
  propose: (id: string, baseSha: string, change: ChangeInput, message: string, branch: string) =>
    call<{ request: RequestRecord }>("POST", `/api/repos/${id}/changes`, { baseSha, change, message, branch }).then((b) => b.request),
  requestDescription: (id: string, number: number) => get<{ description: string | null; url: string }>(`/api/repos/${id}/requests/${number}/description`),
  requestAction: (id: string, number: number, action: "merge" | "close" | "refresh") =>
    call<{ request: RequestRecord }>("POST", `/api/repos/${id}/requests/${number}/${action}`).then((b) => b.request),
  /** Where a request opens on its repository's forge: none without a GitLab or GitHub remote, its address once opened there. */
  onForge: (id: string, number: number) => get<{ forge: "gitlab" | "github" | null; url: string | null; number: number | null }>(`/api/repos/${id}/requests/${number}/on-forge`),
  openOnForge: (id: string, number: number) => call<{ url: string; number: number | null }>("POST", `/api/repos/${id}/requests/${number}/on-forge`),
  forge: (id: string) => get<ForgeSettings>(`/api/repos/${id}/forge`),
  saveForge: (id: string, input: ForgeConfig & { token?: string }) => call("PUT", `/api/repos/${id}/forge`, input),
  removeForge: (id: string) => call("DELETE", `/api/repos/${id}/forge`),
  usageProposal: (id: string, action: UsageAction) => call<Proposal>("POST", `/api/repos/${id}/usage/proposal`, { action }),
  proposeUsage: (id: string, baseSha: string, message: string, branch: string, action: UsageAction) => call<{ request: RequestRecord }>("POST", `/api/repos/${id}/usage/propose`, { action, baseSha, message, branch }).then((b) => b.request),
};

export type TaskTemplate = { kind: "skill.write" | "skill.improve"; skill: string } | { kind: "scaffold.refresh"; commitVersioning: boolean };
export interface TaskCost { usd: number | null; inputTokens: number | null; outputTokens: number | null }
export interface TaskRecord {
  id: string; repoId: string; team: string; title: string; description: string; issueUrl: string | null; issueKey: string | null; agent: string; status: TaskStatus;
  createdBy: string; createdAt: string; startedAt: string | null; finishedAt: string | null; baseSha: string | null;
  tests: "passed" | "failed" | "skipped" | null; cost: TaskCost; requestNumber: number | null; error: string | null;
  template: TaskTemplate | null; queuePosition: number | null; request: { status: "open" | "merged" | "closed"; provider: string; branch: string; url: string; heldReason?: string } | null;
  /** The people the task is shared with to read, by id. */
  sharedWith?: string[];
  /** For a task in a folder of the person's own, whether that folder's Claude Code settings load; null where the orchestrator clones. */
  folderTrust?: "unasked" | "trusted" | "declined" | null;
  /** How far the agent acts without asking, as the task was started with. */
  mode?: PermissionMode;
  /** The project's skills and MCP servers the task was started with, each skill at the head its source had then. */
  tools?: { skills: { source: string; name: string; head?: string | null }[]; mcpServers: string[] } | null;
  /** The repositories a task over several changes, in the order they run; null for a task on one. Empty while it is still planning. */
  targets?: TaskTarget[] | null;
  /** Set when a part of the task reported no cost, so the cost is what the others reported. */
  costPartial?: true;
  /** How a task over several repositories picked them: planned by the orchestrator, or named by a person. */
  targetMode?: "orchestrator" | "pinned" | null;
  /** The team skills the agent was told to use first, by name. */
  skills?: string[] | null;
  /**
   * What a task on a person's machine waits for: the machine to come online, a machine to be
   * connected at all, a usage limit to reset (`resetAt`), or a sign-in on the machine (`agentId`).
   */
  waitingFor?: "machine" | "connect" | "limit" | "sign-in" | null;
  resetAt?: string | null;
  agentId?: string | null;
  /** What the agent asked its person while running, newest last. */
  requests?: TaskRequest[];
  /** What a follow-up from its starter does now: reaches the agent at work, waits for its turn to end, or continues a finished run; null takes none. */
  followUp?: "steer" | "queue" | "continue" | null;
  /** Where the task stands as every screen says it, and its first forge request, as the orchestrator reads them. */
  state?: import("./task-state").TaskState;
  forge?: import("./task-state").TaskForge | null;
  /** How the task ended: a request on a Git project, or `changes` made in place in a folder without Git. */
  result?: "request" | "changes" | null;
  /** For `changes`: how many files, and once undone, who did and which files they had edited since and were kept. */
  /** What a task in a folder without Git changed, and whether its person undid or kept it; either is final. */
  changes?: { files: (ChangedFile & { state?: "undone" })[]; undone: { at: string; by: string; kept: string[]; reason?: string } | null; kept?: { at: string; by: string } | null } | null;
  /** What the task chose of its agent's options. */
  choices?: AgentChoices | null;
  /** Where the task stands, worked out by the orchestrator from the task and its requests. */
  phase?: "planned" | "working" | "tests" | "request" | "review" | "merged" | "failed";
  /** Present when the task ran on its starter's own machine; absent for one the orchestrator ran. */
  runner?: "local";
  /** Why an interrupted task stopped: its person's machine went away, or the orchestrator running it restarted. */
  interruptedBy?: "machine" | "restart" | null;
  /** The machine a task ran on, by its person's name for it, where a change stayed on it. */
  ranOn?: string | null;
  /** What a task run as its person here loaded of their own Claude Code, counted. */
  loaded?: LoadedCounts;
  /** How many tokens the run's context held when it started. */
  context?: { tokens: number } | null;
  /** Where a task on one person's own orchestrator works: the folder picked from what it asked, or the one used last (`fallback`). `reason` is the model's own words and is never shown. */
  routing?: { path: string; reason: string; fallback: boolean; loaded?: { skills: number; claudeMd: boolean; memory: boolean } } | null;
  /** The MCP servers of the person's own Claude Code that asked for a sign-in the run was not given; absent when none did. */
  mcpNeedsSignIn?: string[];
  /** What a run stopped to ask; `answer` is filled once its starter has answered. */
  question?: { text: string; options: string[]; answer?: string } | null;
  /** Follow-ups teammates reviewing the request suggested: its starter sees every one, anyone else only their own. */
  suggestions?: TaskSuggestion[];
  /** Whether the reader may suggest a follow-up now: a teammate who did not start the task, while its request is open and it takes one. */
  suggests?: boolean;
  startedBy?: { name: string };
  /** Whether the orchestrator can read a plan this stopped task put to its starter, to approve and go on from. */
  planToApprove?: boolean;
  /** How long the agent ran, as the orchestrator counts it without the time its cards waited; absent on a task still running or from before it was kept. */
  ranMs?: number;
  /** What its starter wrote to the agent that has not reached it yet, the oldest first: each can still be changed or taken back. */
  messages?: QueuedMessage[];
  /** What the task waits on a person for, when the agent asked; absent while it waits on nobody. */
  attention?: "approval" | "answer" | "limited" | null;
}
/** A message of the starter's that waits for the agent's next step. */
export interface QueuedMessage { id: string; text: string; quotes: { path: string; lines: string; text: string }[] | null; createdAt: string }
/** A follow-up a teammate suggested; it reaches the agent only once the task's starter continues with it. */
export interface TaskSuggestion {
  id: string;
  by: { name: string };
  text: string;
  quotes: { path: string; lines: string; text: string }[] | null;
  createdAt: string;
  status: "waiting" | "continued" | "dismissed" | "expired";
  canAnswer: boolean;
}
/** A question the agent put to the person who started the task, and its answer once given. */
/** A permission the agent asks while it works; its payload is masked on the machine and again by the orchestrator. */
export interface TaskRequest {
  id: string;
  kind: "command" | "file-read" | "file-change" | "mcp" | "permission" | "question" | "secret" | "plan";
  payload: { tool?: string; summary?: string; questions?: AgentQuestion[]; plan?: string };
  /** `withdrawn`: the agent took it back, so it takes no answer. */
  status: "pending" | "answered" | "expired" | "withdrawn";
  /** `not_resumable`: the agent's session ended, so an answer no longer reaches it. */
  responseCapability: "live" | "not_resumable";
  answer: { decision: RequestDecision; note?: string } | { answers: QuestionAnswers } | null;
  answeredBy: string | null;
  createdAt: string;
  /** When it was answered, and when it would have run out; the time between its card and the answer is the person's, not the agent's. */
  answeredAt?: string | null;
  expiresAt?: string | null;
}
/** allow_for_task lasts until the task ends; no decision outlives the task it was given in. */
export type RequestDecision = "allow_once" | "allow_for_task" | "deny";
/** A skill the agent proposes for a piece of work, and why, beside every skill the work may be started with. */
export interface SkillSuggestions {
  suggestions: { skill: string; reason: string }[];
  skills: { name: string; description: string }[];
  /** Why nothing was suggested when no agent could be asked; the skills are still offered. */
  note?: string;
}
/** The most skills one task is started with. */
export const MOST_SKILLS = 5;
export interface LoadedCounts { commands: number; plugins: number; mcpServers: number; claudeMd: boolean }
export type TargetStatus = "planned" | "working" | "tests" | "request" | "failed" | "skipped" | "local";
export interface TaskTarget {
  repoId: string; name: string; status: TargetStatus; reason: string; tests: "passed" | "failed" | "skipped" | null; error: string | null;
  request: { number: number; url: string; status: RequestStatus } | null;
  /** In a folder: where the repository is in it, "" for the folder itself, and the task's branch there. */
  path?: string | null; branch?: string | null;
  /** The forge its remote is on, for a change kept on a machine; null with none. */
  forge?: "gitlab" | "github" | null;
}
/** How a task over several repositories picks them: the orchestrator plans it from the issue, or a person names them. */
export type TaskTargets = "orchestrator" | string[];
/** `kind` and `data`: on an agent's event, its type and the event as the orchestrator masked it (CANLI-GOREV-sozlesme.md); never trusted as a shape. */
export interface TaskLogLine { seq: number; at: string; text: string; kind?: string; data?: Record<string, unknown> }
/** `first` is the first failure, else the first warning, in a few fixed words; what the checks found is in the admin's readiness report. */
export interface AgentSummary { ready: boolean; state: "ready" | "warnings" | "not-ready"; first?: string | null }
/** A choice an agent offers for its runs, in values its own CLI takes; one it does not declare is not offered. */
export interface AgentOption { id: "model" | "effort"; label: string; choices: { value: string; label: string }[] }
/** What a task chose of its agent's options; one left out runs with the agent's own default. */
export type AgentChoices = Partial<Record<AgentOption["id"], string>>;
export interface TaskOptions { agents: { id: string; label: string; plan?: boolean; readiness: AgentSummary | null; options?: AgentOption[]; personal?: { commands: { name: string; description: string; argumentHint?: string | null }[]; plugins: { name: string; marketplace?: string | null; version?: string | null; enabled: boolean; scope?: string }[]; mcpServers?: { name: string; kind: "stdio" | "http" | "unknown"; scope?: string; asksForValue: boolean | null }[]; claudeMd?: boolean; readAt: string } | null }[]; repos: { id: string; name: string; team: string; kind: "skills" | "code"; forge?: "gitlab" | "github" | null; ticketExample: string | null; ownSetup?: boolean; result?: "changes" | "request"; machine?: string }[]; readinessReport: boolean; profile: { personal: false } | { personal: true; note: string; refused: string | null };
  /** The code repositories a task may span, when there are two or more of them. */
  multiRepo?: { candidates: { id: string; name: string; team: string }[]; maxTargets: number } | null }
export type CheckStatus = "ok" | "warn" | "fail" | "unknown";
export interface Readiness { checkedAt: string; agents: { id: string; label: string; ready: boolean; checks: { name: string; status: CheckStatus; detail: string }[] }[] }


export interface TaskStartInput { planFirst?: boolean; title: string; description: string; issueUrl: string; repoId?: string; path?: string; withoutIssueText?: boolean; agent: string; template: TaskTemplate | null; targets?: TaskTargets; skills?: string[]; choices?: AgentChoices; mode?: PermissionMode; projectSkills?: { source: string; name: string }[]; mcpServers?: string[]; mcpConfirmed?: string[] }

/** What the orchestrator finds for words: the tasks whose title or issue key holds them and, for three letters or more, those whose log does. */
export const searchApi = {
  tasks: (q: string) => get<{ tasks: SearchedTask[]; inLog: SearchedTask[] }>(`/api/search?${new URLSearchParams({ q })}`),
};
export interface SearchedTask { id: string; title: string; repoId: string; status: string }

export const tasksApi = {
  budgets: () => get<CurrentBudgets>("/api/policies/current-budgets"),
  options: () => get<TaskOptions>("/api/tasks/options"),
  /** A page of tasks, newest first, and the cursor of the next; null for the first page. */
  page: (after: string | null, since?: string) => {
    const query = new URLSearchParams({ ...(after ? { after } : {}), ...(since ? { since } : {}) }).toString();
    return get<{ tasks: TaskRecord[]; next: string | null }>(query ? `/api/tasks?${query}` : "/api/tasks");
  },
  /** Every task started since a time, read a page at a time. */
  since: async (since: string) => {
    const tasks: TaskRecord[] = [];
    for (let after: string | null = null; ; ) {
      const page = await tasksApi.page(after, since);
      tasks.push(...page.tasks);
      if (!page.next) return tasks;
      after = page.next;
    }
  },
  /** The task and its log after a line, a page at a time: `next` is the line to read on from, null on the last page. */
  get: (id: string, after: number) => get<{ task: TaskRecord; log: TaskLogLine[]; outputCut: boolean; next?: number | null }>(`/api/tasks/${id}?after=${after}`),
  eventsUrl: (id: string, after: number) => `/api/tasks/${id}/events?after=${after}`,
  start: (input: TaskStartInput) => call<{ task: TaskRecord }>("POST", "/api/tasks", input).then((b) => b.task),
  cancel: (id: string) => call<{ task: TaskRecord }>("POST", `/api/tasks/${id}/cancel`).then((b) => b.task),
  /** The starter's answer to what a stopped run asked; the task goes back in line and takes it. */
  answerStopped: (id: string, answer: string) => call<{ task: TaskRecord }>("POST", `/api/tasks/${encodeURIComponent(id)}/answer`, { answer }).then((b) => b.task),
  /** Stops the task and starts it again in another folder; the answer is the new task. */
  move: (id: string, path: string) => call<{ task: TaskRecord }>("POST", `/api/tasks/${encodeURIComponent(id)}/move`, { path }),
  /** Answers what the agent asked; only the person who started the task may, and the first answer stands. */
  /** Every question of a question request answered by its key, sent once. */
  answerQuestions: (id: string, requestId: string, answers: QuestionAnswers) =>
    call<TaskRequest>("POST", `/api/tasks/${id}/requests/${encodeURIComponent(requestId)}`, { answer: { answers }, commandId: crypto.randomUUID() }),
  /** The plan the agent made before it changed anything: started with as it is, with the person's own version, or declined. */
  answerPlan: (id: string, requestId: string, decision: "allow_once" | "deny", plan?: string) =>
    call<TaskRequest>("POST", `/api/tasks/${id}/requests/${encodeURIComponent(requestId)}`, { answer: { decision, ...(plan ? { plan } : {}) }, commandId: crypto.randomUUID() }),
  answer: (id: string, requestId: string, decision: RequestDecision, note?: string) =>
    call<TaskRequest>("POST", `/api/tasks/${id}/requests/${encodeURIComponent(requestId)}`, { answer: { decision, ...(decision === "deny" && note ? { note } : {}) }, commandId: crypto.randomUUID() }),
  /** Continues an interrupted task on the same machine and the same agent session. */
  /** A retry with the same commandId is the same message, sent once. */
  message: (id: string, input: { text: string; quotes: { path: string; lines: string; text: string }[] }, commandId: string) =>
    call<{ followUp: TaskRecord["followUp"] }>("POST", `/api/tasks/${id}/messages`, { text: input.text, ...(input.quotes.length ? { quotes: input.quotes } : {}), commandId }).then((b) => b.followUp),
  /** Changes the words, and the quotes when given, of a message that has not reached the agent; refused once it has. */
  editMessage: (id: string, messageId: string, input: { text: string; quotes?: QueuedMessage["quotes"] }) =>
    call<{ message: QueuedMessage }>("PATCH", `/api/tasks/${id}/messages/${encodeURIComponent(messageId)}`, input).then((b) => b.message),
  /** Takes back a message that has not reached the agent. */
  removeMessage: (id: string, messageId: string) => call<{ removed: true }>("DELETE", `/api/tasks/${id}/messages/${encodeURIComponent(messageId)}`),
  /** A teammate's follow-up, kept for the task's starter; a retry with the same commandId is the same suggestion. */
  suggest: (id: string, input: { text: string; quotes: { path: string; lines: string; text: string }[] }, commandId: string) =>
    call<{ suggestion: { id: string; status: TaskSuggestion["status"] } }>("POST", `/api/tasks/${id}/suggestions`, { text: input.text, ...(input.quotes.length ? { quotes: input.quotes } : {}), commandId }),
  /** The starter's answer to a teammate's follow-up; a second click is the same answer. */
  answerSuggestion: (id: string, suggestion: string, answer: "continue" | "dismiss") =>
    call<{ suggestion: { id: string; status: TaskSuggestion["status"] } }>("POST", `/api/tasks/${id}/suggestions/${encodeURIComponent(suggestion)}/${answer}`),
  /** Takes one file out of the task's open request: it goes back as the task's base had it, in one commit, and the request is checked again. */
  dropFromRequest: (id: string, path: string) => call<{ head: string }>("POST", `/api/tasks/${id}/request/drop`, { path }),
  /** Puts the files a task changed in place back as they were; a file edited since is kept as it is. */
  undo: (id: string, only: { paths?: string[]; reason?: string } = {}) => call<{ task: TaskRecord; undone: string[]; kept: string[] }>("POST", `/api/tasks/${id}/undo`, { commandId: crypto.randomUUID(), ...only }),
  keep: (id: string) => call<{ task: TaskRecord }>("POST", `/api/tasks/${id}/keep`, { commandId: crypto.randomUUID() }).then((b) => b.task),
  /** Pushes a change a machine kept on its branch and opens its request on the repository's forge; the task's starter alone. */
  openKept: (id: string, position: number) => call<{ target: TaskTarget }>("POST", `/api/tasks/${id}/targets/${position}/on-forge`),
  continue: (id: string) => call<{ task: TaskRecord }>("POST", `/api/tasks/${id}/continue`, { commandId: crypto.randomUUID() }).then((b) => b.task),
  /** A stopped task goes on carrying out the plan it had not yet had an answer on; refused with no-plan when it holds none. */
  continueWithPlan: (id: string, plan?: string) => call<{ task: TaskRecord }>("POST", `/api/tasks/${id}/continue`, { commandId: crypto.randomUUID(), approvePlan: true, ...(plan ? { plan } : {}) }).then((b) => b.task),
  /** The skills that fit one piece of work; asks the agent, so a person gets a few a minute. */
  suggestSkills: (input: { agent: string; repoId: string; issueUrl?: string; description?: string; targets?: TaskTargets }) =>
    call<SkillSuggestions>("POST", "/api/tasks/skill-suggestions", input),
  /** The same for up to 20 pieces of work at once, counted as one ask; each answers or says why not. */
  suggestSkillsFor: (input: { agent: string; items: { repoId: string; issueUrl?: string; targets?: TaskTargets }[] }) =>
    call<{ results: ({ index: number } & (SkillSuggestions | { error: string }))[] }>("POST", "/api/tasks/skill-suggestions", input),
  /** Starts up to 20 tasks at once, each checked on its own: one refused does not stop the others. */
  startMany: (input: { agent: string; items: { issueUrl: string; repoId: string; targets?: TaskTargets; skills?: string[]; choices?: AgentChoices }[] }) =>
    call<{ started: TaskRecord[]; refused: { index: number; error: string; code?: string }[] }>("POST", "/api/tasks/batch", input),
  readiness: (fresh: boolean) => get<Readiness>(`/api/agents/readiness${fresh ? "?fresh=1" : ""}`),
};

export type IntegrationState = "off" | "connected" | "requested";
interface CardBase { state: IntegrationState; enabledBy: string | null; enabledAt: string | null }
export interface ForgeConnection { via: "app" | "oauth"; account: string; by: string; at: string; repos: number; problem: string | null; manageUrl?: string | null }
/** One forge host the organization reaches, as GET /api/forge/hosts reads it from what the organization keeps. */
export interface ForgeHost { kind: "gitlab" | "github"; webUrl: string; apiUrl: string; connection: ForgeConnection | null; ownApplication: boolean; repos: { id: string; via: "connection" | "token" }[]; credentials: { tokenPage: string; scopes: readonly string[] } }
/** What the forge says of the organization's connection when asked; asking changes nothing there. */
export interface ForgeCheck { ok: boolean; account: string | null; granted: string[]; missing: string[]; version: string | null; problem: string | null }
/** What a person does on the forge itself when the orchestrator cannot, in order, each with the page it is done on. */
export interface ForgeStep { text: string; url: string | null }
/** The person's own gh or glab on their machine, in local mode: whether it is here and signed in, and what to run when it is not. */
export interface OwnCli { tool: "gh" | "glab"; name: string; host: string; installed: boolean; signedIn: boolean; account: string | null; install: string; login: string; repos: string[] }
export interface ForgeCard extends CardBase { id: "gitlab" | "github"; repos: { repoId: string; name: string; project: string; apiUrl: string; setBy: string; setAt: string }[]; connection: ForgeConnection | null; ownCli: OwnCli | null }
export interface ForgeRepo { fullName: string; url: string; connected: string | null; empty: boolean }
export interface OrgGitLabApp { webUrl: string; clientId: string; by: string; at: string }

/** The person's own gh or glab signing in through the browser, as the card follows it. */
export type CliSignIn = { state: "idle" } | { state: "waiting"; code: string | null; url: string | null; note?: string } | { state: "done"; account: string | null } | { state: "failed"; error: string; installed: boolean };
/** Whether this orchestrator signs the person's own CLI in from the card, and where that stands; `why` says why not. */
/** `org`: whether the orchestrator can connect the organization to the forge, and what is missing when not; null for anyone but an owner or an admin. */
export type DeviceSignIn = { state: "idle" } | { state: "waiting"; code: string; url: string } | { state: "done"; account: string; host: string } | { state: "failed"; error: string };
export interface ForgeSignIn { offered: boolean; why: string | null; org: { available: boolean; missing: string[] } | null; cli: OwnCli | null; installLine: string | null; signIn: CliSignIn; device: { offered: boolean; signIn: DeviceSignIn } | null }

/** The organization's one-click connection to GitLab or GitHub, its repositories there, and the team repository it makes. */
export const forgeApi = {
  signInState: (kind: "gitlab" | "github") => get<ForgeSignIn>(`/api/forge/${kind}/sign-in`),
  signIn: (kind: "gitlab" | "github") => call<ForgeSignIn>("POST", `/api/forge/${kind}/sign-in`, {}),
  deviceSignIn: (kind: "gitlab" | "github") => call<{ signIn: DeviceSignIn }>("POST", `/api/forge/${kind}/device`, {}),
  deviceSignOut: (kind: "gitlab" | "github") => call<{ signIn: DeviceSignIn }>("DELETE", `/api/forge/${kind}/device`),
  connection: (kind: "gitlab" | "github") => get<{ connection: ForgeConnection | null; available: boolean; missing: string[] }>(`/api/forge/${kind}/connection`),
  connect: (kind: "gitlab" | "github") => call<{ authorizeUrl: string }>("POST", `/api/forge/${kind}/connect`, {}),
  disconnect: (kind: "gitlab" | "github") => call<{ ok: true; note?: string }>("DELETE", `/api/forge/${kind}/connection`),
  repos: (kind: "gitlab" | "github") => get<{ repos: ForgeRepo[] }>(`/api/forge/${kind}/repos`),
  connectRepo: (kind: "gitlab" | "github", input: { fullName: string; team: string }) => call<{ repo: RepoRecord }>("POST", `/api/forge/${kind}/repos/connect`, input),
  teamRepo: (kind: "gitlab" | "github", input: { name: string; team: string; visibility: string; namespace?: string } | { existing: string; team: string }) =>
    call<{ repo: RepoRecord & { url: string }; webhook: string }>("POST", `/api/forge/${kind}/team-repo`, input),
  gitlabApp: () => get<{ app: OrgGitLabApp | null; redirectUri: string | null; operator: boolean }>("/api/forge/gitlab/app"),
  saveGitlabApp: (input: { url: string; clientId: string; clientSecret: string }) => call<{ app: OrgGitLabApp }>("PUT", "/api/forge/gitlab/app", input),
  removeGitlabApp: () => call<{ ok: true }>("DELETE", "/api/forge/gitlab/app"),
  hosts: () => get<{ hosts: ForgeHost[] }>("/api/forge/hosts"),
  check: (kind: "gitlab" | "github") => get<{ check: ForgeCheck }>(`/api/forge/${kind}/connection/check`),
};
export interface Delivery { ok: boolean; at: string; detail: string }
export interface SlackCard extends CardBase { id: "slack"; events: string[]; delivery: Delivery | null; addable: boolean; redirectUri: string | null }
export interface TrackerConfig { kind: "jira" | "gitlab" | "github" | "linear"; url: string; email?: string }
export interface TrackerCard extends CardBase { id: "tracker"; config: TrackerConfig | null; token: { setAt: string; setBy: string } | null; writeBack: false }
export interface OrchestratorMcpRepo { repoId: string; name: string; team: string; state: IntegrationState; request: { number: number; url: string; status: RequestStatus } | null; enabledBy: string | null; enabledAt: string | null; canChange: boolean }
export interface OrchestratorMcpCard extends CardBase { id: "orchestrator-mcp"; endpoint: string | null; entry: Record<string, unknown> | null; missing: string[]; repos: OrchestratorMcpRepo[] }
export type IntegrationCard = ForgeCard | SlackCard | TrackerCard | OrchestratorMcpCard;
/** `local` is one person's orchestrator on their own machine: the page offers what they connect for themselves. */
/** A service connected in one step through its own MCP server, as the person; `server` once they added it. */
/** An MCP server of the person's own Claude Code, by name, kind and where it is defined alone; `service` when Integrations connects it in one step. */
export interface CatalogService { id: string; name: string; about: string; server: { name: string; connected: boolean; tools: number } | null }
export interface Integrations { integrations: IntegrationCard[]; canManage: boolean; vault: boolean; slackEvents: { kind: string; label: string }[]; local: boolean; writes: boolean; jira: { mcp: { name: string; connected: boolean } | null }; catalog: CatalogService[]; claudeCodeServers: number | null; signIn: boolean }

export const integrationsApi = {
  list: () => get<Integrations>("/api/integrations"),
  saveSlack: (input: { webhookUrl?: string; events: string[] }) => call("PUT", "/api/integrations/slack", input),
  testSlack: () => call<{ delivery: Delivery }>("POST", "/api/integrations/slack/test").then((b) => b.delivery),
  removeSlack: () => call("DELETE", "/api/integrations/slack"),
  saveTracker: (input: TrackerConfig & { token?: string }) => call("PUT", "/api/integrations/tracker", input),
  saveWrites: (on: boolean) => call("PUT", "/api/integrations/writes", { on }),
  addSlack: () => call<{ authorizeUrl: string }>("POST", "/api/integrations/slack/add").then((b) => b.authorizeUrl),
  signInJira: () => call<{ authorizeUrl: string }>("POST", "/api/integrations/jira/sign-in").then((b) => b.authorizeUrl),
  /** The one-step sign-in an unread issue offers (IssuePreview.connect): the address to send the browser to. */
  signInService: (id: "jira" | "linear" | "gitlab") => (id === "jira" ? integrationsApi.signInJira() : id === "gitlab" ? call<{ authorizeUrl: string }>("POST", "/api/integrations/gitlab/sign-in").then((b) => b.authorizeUrl) : integrationsApi.signInCatalog(id)),
  signInCatalog: (id: string) => call<{ authorizeUrl: string }>("POST", `/api/integrations/catalog/${encodeURIComponent(id)}/sign-in`).then((b) => b.authorizeUrl),
  removeTracker: () => call("DELETE", "/api/integrations/tracker"),
  mcpProposal: (repoId: string) => call<Proposal & { baseSha: string }>("POST", `/api/integrations/orchestrator-mcp/${repoId}/proposal`),
  proposeMcp: (repoId: string, baseSha: string, message: string, branch: string) =>
    call<{ request: RequestRecord }>("POST", `/api/integrations/orchestrator-mcp/${repoId}/propose`, { baseSha, message, branch }).then((b) => b.request),
};

export interface PersonalServer {
  name: string; description: string; transport: "http" | "stdio"; url?: string; command?: string; args?: string[]; auth: "none" | "token" | "oauth"; tools: string[]; addedAt: string;
  /** The tools as the server described them when they were last loaded. */
  known?: Record<string, { writes: boolean }>;
  /** Of the tools a task may use, the ones that can change something. */
  writing: string[];
  credential: null | { set: boolean; setAt?: string | null; expiresAt?: string | null; refreshable?: boolean };
}
export interface PersonalServers { servers: PersonalServer[]; signIn: boolean; vault: boolean }
export type NewPersonalServer = { name: string; description: string; transport: "http" | "stdio"; url?: string; command?: string; args?: string[]; auth: "none" | "token" | "oauth"; token?: string };

export const myMcpApi = {
  list: () => get<PersonalServers>("/api/me/mcp-servers"),
  add: (input: NewPersonalServer) => call("POST", "/api/me/mcp-servers", input),
  update: (name: string, input: { tools?: string[]; token?: string }) => call("PATCH", `/api/me/mcp-servers/${encodeURIComponent(name)}`, input),
  remove: (name: string) => call("DELETE", `/api/me/mcp-servers/${encodeURIComponent(name)}`),
  connect: (name: string) => call<{ authorizeUrl: string }>("POST", `/api/me/mcp-servers/${encodeURIComponent(name)}/connect`).then((b) => b.authorizeUrl),
  disconnect: (name: string) => call("POST", `/api/me/mcp-servers/${encodeURIComponent(name)}/disconnect`),
  tools: (name: string) => get<{ tools: { name: string; description: string; writes: boolean; reads: boolean }[] }>(`/api/me/mcp-servers/${encodeURIComponent(name)}/tools`).then((b) => b.tools),
};

export interface AiStats { merged: number; aiAssisted: number; share: number | null; hoursToMerge: { ai: { median: number; p90: number } | null; other: { median: number; p90: number } | null } }
export interface AiAnalytics {
  days: number; since: string; total: AiStats;
  byAgent: { agent: string; label: string; requests: number }[];
  byTeam: ({ team: string } & AiStats)[];
  byRepo: ({ repoId: string; team: string } & AiStats)[];
  byPerson: ({ name: string; email: string } & AiStats)[] | null;
  truncated: string[];
}

export const aiRequestsApi = {
  read: (days: number) => get<AiAnalytics>(`/api/analytics/ai-requests?days=${days}`),
};

export interface TeamMcpServer {
  key: string; name: string; url: string;
  repos: { id: string; name: string; team: string }[];
  everyone: { by: string; at: string; tools: string[]; writing: string[] } | null;
  tools: string[];
  mine: { added: boolean; tools: string[] } | null;
}

export const teamMcpApi = {
  list: () => get<{ servers: TeamMcpServer[]; canManage: boolean }>("/api/team-mcp-servers"),
  connectForEveryone: (key: string) => call<{ authorizeUrl: string }>("POST", `/api/team-mcp-servers/${key}/connect`).then((b) => b.authorizeUrl),
  disconnectForEveryone: (key: string) => call("DELETE", `/api/team-mcp-servers/${key}/connection`),
  tools: (key: string) => get<{ tools: { name: string; description: string; writes: boolean; reads: boolean }[] }>(`/api/team-mcp-servers/${key}/tools`).then((b) => b.tools),
  saveTools: (key: string, tools: string[]) => call("PATCH", `/api/team-mcp-servers/${key}`, { tools }),
};

/** How a task would read an issue, and its key, title and status when they could be read. */
export interface IssuePreview { url: string; key: string | null; title: string | null; status: string | null; reach: string; connect?: { id: "jira" | "linear" | "gitlab"; name: string } | null }

export const issuesApi = {
  preview: (url: string) => get<IssuePreview>(`/api/issues/preview?url=${encodeURIComponent(url)}`),
};
