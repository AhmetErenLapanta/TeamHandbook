import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AccountStore, OidcLogin, SessionListing, SessionRecord, UserRecord } from "./accounts.js";
import type { DomainRecord } from "./domains.js";
import type { InviteRecord } from "./invites.js";
import type { KeyRecord, Scopes, ServiceAccountRecord } from "./keys.js";
import type { PrivacyStore } from "./privacy.js";
import type { Role } from "./auth.js";
import type { ForgeConfig, ForgeConfigStore, ForgeKind, RequestRecord, RequestStatus } from "./forge/types.js";
import type { OrchestratorEvent, EventCursor, EventFilter, EventStore } from "./events.js";
import type { DailyUsage, UsageCount, UsageStore } from "./usage.js";
import type { SecretStore } from "./vault.js";
import { taskWritten } from "./tasks/log-bus.js";
import { USED_SKILLS_MAX } from "./tasks/types.js";
import type { TaskChanges, TaskFilter, TaskLoaded, TaskLogLine, TaskPatch, TaskRecord, TaskStatus, TaskStore, TaskTarget, TaskTargetPatch, TaskShare, TaskTargetStatus, TaskToolChoice, TestOutcome } from "./tasks/types.js";
import type { IdentityLogin, IdentityRecord, IdentitySessionRecord, IdentityStore, OrgRecord, PendingAccount, PendingSignIn, Plan, Quotas } from "./identities.js";
import type { CommandReceipt, EffectRecord, EffectReplay, EffectStatus, EffectStore } from "./effects.js";
import { answerProblem } from "./task-requests.js";
import type { IdentityEvent, IdentityEventStore } from "./identity-funnel.js";
import type { AttachmentRecord, AttachmentStore } from "./attachment-store.js";
import type { ResponseCapability, TaskAnswer, TaskRequestKind, TaskRequestRecord, TaskRequestStatus, TaskRequestStore } from "./task-requests.js";
import type { MachineAgentStatus, MachineFeature, MachineRecord, RunnerStore, TaskLease } from "./runner-store.js";
import type { FollowUpQuote, FollowUpRecord, FollowUpSource, FollowUpStatus, FollowUpStore } from "./task-followups.js";
import { Redactor } from "./tasks/redact.js";
import { detectSecret } from "./plugin.js";
import { newId } from "./ids.js";

/**
 * What the orchestrator keeps. Git is the source of truth for every team's setup; this store
 * holds only what git cannot: which repositories a tenant connected, who may sign in,
 * settings, and each task's outcome with its redacted log. A lost database is rebuilt by reconnecting the repositories - no skill, server
 * or command lives only here.
 */
export interface RepoRecord {
  id: string;
  tenant: string;
  team: string;
  name: string;
  url: string;
  head: string | null;
  syncedAt: string | null;
  error: string | null;
}

/** A policy the orchestrator applies itself, kept as the text its owner wrote; the task runner reads and checks it. */
export interface PolicyRecord {
  tenant: string;
  id: string;
  name: string;
  /** JSON text. */
  audience: string;
  /** JSON text. */
  rules: string;
  updatedAt: string;
  updatedBy: string;
}

export interface Store extends UsageStore, AccountStore, SecretStore, ForgeConfigStore, TaskStore, EventStore, PrivacyStore, IdentityStore, EffectStore, TaskRequestStore, IdentityEventStore, AttachmentStore, RunnerStore, FollowUpStore {
  listPolicies(tenant: string): Promise<PolicyRecord[]>;
  /** Inserts or replaces the policy with this tenant and id. */
  putPolicy(policy: PolicyRecord): Promise<void>;
  /** False when there was none. */
  deletePolicy(tenant: string, id: string): Promise<boolean>;
  /**
   * Runs `work` while no other orchestrator on this database runs work for the same repository
   * address; present only where orchestrators of several tenants share a database. One SQLite
   * store is one orchestrator, whose own turns already keep its requests apart.
   */
  holdRepository?<T>(address: string, work: () => Promise<T>): Promise<T>;
  /**
   * Writes a consistent copy of the whole database to `file` while the orchestrator runs; present only
   * on SQLite. A Postgres database is copied by pg_dump, which reads one snapshot itself.
   */
  snapshotTo?(file: string): Promise<void>;
  getSetting(tenant: string, key: string): Promise<string | null>;
  /** Every organization that holds a setting of this key, whatever its value: the one cross-organization read of settings, by exact key. */
  tenantsWithSetting(key: string): Promise<string[]>;
  setSetting(tenant: string, key: string, value: string): Promise<void>;
  deleteSetting(tenant: string, key: string): Promise<void>;
  /**
   * Takes the setting `key` as a lease until `until` (an ISO time) when nobody holds it or its
   * holder's lease has run out at `now`; false while someone else's runs. Two orchestrator processes on
   * one database - the web and the task runner - take one renewal of a spent-on-use token in turn.
   */
  claimLease(tenant: string, key: string, holder: string, until: string, now: string): Promise<boolean>;
  listRepos(tenant: string): Promise<RepoRecord[]>;
  getRepo(tenant: string, id: string): Promise<RepoRecord | null>;
  upsertRepo(repo: Pick<RepoRecord, "id" | "tenant" | "team" | "name" | "url">): Promise<RepoRecord>;
  recordSync(tenant: string, id: string, result: { head: string } | { error: string }): Promise<void>;
  /** Forgets a repository and the ingest id that wrote to it; its requests, numbers, tasks and counts stay. */
  removeRepo(tenant: string, id: string): Promise<void>;
  /**
   * Reserves the number the local forge gives its next request in a repository. One
   * statement increments a counter and returns it, so requests opened at once each get
   * their own number, and the branch is made only after the number is held.
   */
  nextRequestNumber(tenant: string, repoId: string): Promise<number>;
  saveRequest(request: RequestRecord): Promise<void>;
  listRequests(tenant: string, repoId?: string): Promise<RequestRecord[]>;
  /**
   * One page of the requests a screen shows, newest first, the rows after `after`, and how many
   * each status holds before the status filter.
   */
  /**
   * `seenBy` keeps a page to what one person reads: a request a task opened as its task is read,
   * by the task's team's owners and the people who started it; any other, those of these
   * repositories and those these people opened.
   */
  requestPage(tenant: string, filter: { repoId?: string; status?: RequestStatus; seenBy?: RequestReader }, after: RequestCursor | null, limit: number): Promise<RequestPage>;
  /** Every tenant's requests, for the same start-up work. */
  allRequests(): Promise<RequestRecord[]>;
  getRequest(tenant: string, repoId: string, number: number): Promise<RequestRecord | null>;
  /** Sets where a request stands; a merged one keeps `mergedAt` (now when not given), any other status none. */
  setRequestStatus(tenant: string, repoId: string, number: number, status: RequestStatus, mergedAt?: string | null): Promise<void>;
  /**
   * What the check of a request's head found. A head that passed is kept as checked and lifts a
   * hold on any other head; one that failed holds the request, with why, until another passes.
   */
  recordRequestCheck(tenant: string, repoId: string, number: number, check: { head: string; passed: true } | { head: string; passed: false; reason: string }): Promise<void>;
  /** Moves a request from one status to another only if it is still in the first; false when it was not. */
  transitionRequest(tenant: string, repoId: string, number: number, from: RequestStatus, to: RequestStatus, mergedAt?: string | null): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Where a page of requests ends, by the order pages are read in: created, then repository,
 * then number. The next page starts after this row rather than after a count of rows, so a
 * request opened, merged or closed between two pages neither repeats a row nor skips one.
 */
/** Who reads a request page: the repositories whose teams' work they read, the teams whose tasks they read, and their own email and id. */
export interface RequestReader {
  repoIds: readonly string[];
  taskTeams: readonly string[];
  people: readonly string[];
}

export interface RequestCursor {
  createdAt: string;
  repoId: string;
  number: number;
}

export interface RequestPage {
  requests: RequestRecord[];
  /** How many requests the filter matches, across every page. */
  total: number;
  counts: Record<RequestStatus, number>;
  /** Where the next page starts; null on the last page. */
  next: RequestCursor | null;
}

/** The tables of the first shape, as every later migration finds them. */
const BASE_TABLES = `
CREATE TABLE IF NOT EXISTS repos (
  tenant TEXT NOT NULL,
  id TEXT NOT NULL,
  team TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  head TEXT,
  synced_at TEXT,
  error TEXT,
  PRIMARY KEY (tenant, id)
);
CREATE TABLE IF NOT EXISTS requests (
  tenant TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  provider TEXT NOT NULL,
  url TEXT NOT NULL,
  branch TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (tenant, repo_id, number)
);
CREATE TABLE IF NOT EXISTS request_numbers (
  tenant TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  last INTEGER NOT NULL,
  PRIMARY KEY (tenant, repo_id)
);
CREATE TABLE IF NOT EXISTS settings (
  tenant TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (tenant, key)
);
CREATE TABLE IF NOT EXISTS ingest_ids (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  UNIQUE (tenant, repo_id)
);
CREATE TABLE IF NOT EXISTS usage_counts (
  tenant TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  skill TEXT NOT NULL,
  hour TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (tenant, repo_id, skill, hour)
);
CREATE TABLE IF NOT EXISTS users (
  tenant TEXT NOT NULL,
  id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT,
  oidc_issuer TEXT,
  oidc_subject TEXT,
  forge_login TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (tenant, email);
CREATE UNIQUE INDEX IF NOT EXISTS users_oidc ON users (tenant, oidc_issuer, oidc_subject);
CREATE TABLE IF NOT EXISTS team_owners (
  tenant TEXT NOT NULL,
  user_id TEXT NOT NULL,
  team TEXT NOT NULL,
  PRIMARY KEY (tenant, user_id, team)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  user_id TEXT NOT NULL,
  csrf TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oidc_logins (
  state TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS secrets (
  tenant TEXT NOT NULL,
  name TEXT NOT NULL,
  sealed TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (tenant, name)
);
CREATE TABLE IF NOT EXISTS forges (
  tenant TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  api_url TEXT NOT NULL,
  project TEXT NOT NULL,
  PRIMARY KEY (tenant, repo_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  tenant TEXT NOT NULL,
  id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  team TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  issue_url TEXT,
  issue_key TEXT,
  agent TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  base_sha TEXT,
  tests TEXT,
  cost_usd DOUBLE PRECISION,
  input_tokens INTEGER,
  output_tokens INTEGER,
  request_number INTEGER,
  error TEXT,
  log_seq INTEGER NOT NULL DEFAULT 0,
  pgid INTEGER,
  branch TEXT,
  template TEXT,
  PRIMARY KEY (tenant, id)
);
CREATE TABLE IF NOT EXISTS task_log (
  tenant TEXT NOT NULL,
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (tenant, task_id, seq)
);
`;

const EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS events (
  tenant TEXT NOT NULL,
  id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  actor_email TEXT,
  actor_name TEXT,
  repo_id TEXT,
  subject TEXT,
  detail TEXT NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS events_at ON events (tenant, at, id);
`;

/** Invitations, service accounts with their keys, and the groups and tags a directory gives members. */
const IDENTITY_TABLES = `
CREATE TABLE IF NOT EXISTS invites (
  tenant TEXT NOT NULL,
  id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  teams TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS invites_email ON invites (tenant, email);
CREATE UNIQUE INDEX IF NOT EXISTS invites_token ON invites (token_hash);
CREATE TABLE IF NOT EXISTS service_accounts (
  tenant TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE TABLE IF NOT EXISTS api_keys (
  tenant TEXT NOT NULL,
  id TEXT NOT NULL,
  prefix TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (tenant, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_prefix ON api_keys (prefix);
CREATE INDEX IF NOT EXISTS api_keys_owner ON api_keys (tenant, owner_kind, owner_id);
CREATE TABLE IF NOT EXISTS member_groups (
  tenant TEXT NOT NULL,
  user_id TEXT NOT NULL,
  grp TEXT NOT NULL,
  PRIMARY KEY (tenant, user_id, grp)
);
CREATE TABLE IF NOT EXISTS group_tags (
  tenant TEXT NOT NULL,
  grp TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (tenant, grp)
);
CREATE TABLE IF NOT EXISTS member_tags (
  tenant TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (tenant, user_id, tag)
);
`;

const DOMAINS_TABLE = `
CREATE TABLE IF NOT EXISTS sso_domains (
  tenant TEXT NOT NULL,
  domain TEXT NOT NULL,
  token TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  verified_at TEXT,
  PRIMARY KEY (tenant, domain)
);
`;

const CLOUD_IDENTITY_TABLES = `
CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  email_verified_at TEXT NOT NULL,
  terms_url TEXT,
  terms_accepted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS identities_email ON identities (email);
CREATE TABLE IF NOT EXISTS identity_logins (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  email TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS identity_logins_identity ON identity_logins (identity_id);
CREATE TABLE IF NOT EXISTS identity_sessions (
  token_hash TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  csrf TEXT NOT NULL,
  method TEXT NOT NULL,
  domain TEXT,
  authenticated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_sign_ins (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  identity_id TEXT,
  invite_id TEXT,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orgs (
  tenant TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  quotas TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS orgs_created_by ON orgs (created_by, created_at);
`;

const POLICIES_TABLE = `
CREATE TABLE IF NOT EXISTS policies (
  tenant TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  audience TEXT NOT NULL,
  rules TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (tenant, id)
);
`;

/**
 * The event log keeps every row it was given: no statement of the orchestrator changes one, and none
 * deletes one younger than EVENT_FLOOR_DAYS, a retention set shorter included. Written into the
 * database as triggers, so it holds for any statement on the table, not only for the store's own.
 */
export const EVENT_FLOOR_DAYS = 30;

const SQLITE_EVENT_GUARDS = `
CREATE TRIGGER IF NOT EXISTS events_append_only BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'the event log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_kept BEFORE DELETE ON events
WHEN OLD.at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${EVENT_FLOOR_DAYS} days')
BEGIN SELECT RAISE(ABORT, 'an event younger than ${EVENT_FLOOR_DAYS} days is kept'); END;
`;

export const POSTGRES_EVENT_GUARDS = `
CREATE OR REPLACE FUNCTION console_events_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'the event log is append-only'; END IF;
  IF OLD.at > to_char((now() AT TIME ZONE 'UTC') - interval '${EVENT_FLOOR_DAYS} days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
    RAISE EXCEPTION 'an event younger than ${EVENT_FLOOR_DAYS} days is kept';
  END IF;
  RETURN OLD;
END
$guard$;
CREATE OR REPLACE TRIGGER events_guard BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION console_events_guard();
`;

/**
 * The few calls every query needs, so SQLite and Postgres run the same statements. A
 * statement is written once with `?` placeholders; a driver that numbers its parameters
 * rewrites them. Column aliases are quoted because Postgres folds an unquoted alias to
 * lower case.
 */
export type SqlValue = string | number | null;

export interface SqlDriver {
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  run(sql: string, params?: SqlValue[]): Promise<number>;
  /** Runs `fn` on one connection inside BEGIN/COMMIT, rolling back when it throws. */
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

async function one<T>(db: SqlDriver, sql: string, params: SqlValue[]): Promise<T | null> {
  return (await db.all<T>(sql, params))[0] ?? null;
}

interface EventRow {
  tenant: string;
  id: string;
  at: string;
  kind: string;
  actor_kind: OrchestratorEvent["actor"]["kind"];
  actor_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  repo_id: string | null;
  subject: string | null;
  detail: string;
}

/** The oldest row of each kind, or of each kind per actor, read through events_first rather than the whole log. */
function firstEventRows(db: SqlDriver, tenant: string, kinds: readonly string[], byActor: boolean): Promise<EventRow[]> {
  if (!kinds.length) return Promise.resolve([]);
  const partition = byActor ? "kind, actor_id" : "kind";
  return db.all<EventRow>(
    `SELECT * FROM (SELECT e.*, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY at, id) AS place FROM events e
       WHERE tenant = ? AND kind IN (${kinds.map(() => "?").join(", ")})${byActor ? " AND actor_id IS NOT NULL" : ""}) first WHERE place = 1 ORDER BY at, id`,
    [tenant, ...kinds],
  );
}

function toEvent(row: EventRow): OrchestratorEvent {
  return {
    tenant: row.tenant,
    id: row.id,
    at: row.at,
    kind: row.kind,
    actor: { kind: row.actor_kind, id: row.actor_id, email: row.actor_email, name: row.actor_name },
    repoId: row.repo_id,
    subject: row.subject,
    detail: row.detail,
  };
}

const REQUEST_CHECK_COLUMNS = ["checked_head", "held_head", "held_reason"];

const TASK_SHARES_TABLE = `CREATE TABLE IF NOT EXISTS task_shares (
  tenant TEXT NOT NULL,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  shared_by TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (tenant, task_id, user_id)
)`;

/** A write to a task, said in this process once it is committed, so a page following the task reads it at once. */
async function written<T>(tenant: string, taskId: string, write: Promise<T>): Promise<T> {
  const result = await write;
  taskWritten(tenant, taskId);
  return result;
}

/**
 * A session seen in use lasts on: its expiry moves to the one given, only ever later, so a touch
 * never shortens it, and an ended session, whose row is gone, is not brought back. ISO times
 * compare as text, alike on SQLite and Postgres.
 */
const LATER_EXPIRY = (expiresAt: string | undefined) => (expiresAt ? ", expires_at = CASE WHEN expires_at < ? THEN ? ELSE expires_at END" : "");

/**
 * Settles a task's change in a folder once, undone or kept, never both. The task's row is held
 * while it is read and written, so of two at once, an undo and a keep included, one records itself.
 */
async function settleTaskChanges(db: SqlDriver, tenant: string, id: string, settled: Pick<TaskChanges, "undone"> | Required<Pick<TaskChanges, "kept">>): Promise<boolean> {
  return db.transaction(async (tx) => {
    const row = await one<{ changes: string | null }>(tx, "UPDATE tasks SET id = id WHERE tenant = ? AND id = ? RETURNING changes", [tenant, id]);
    const changes = row?.changes ? (JSON.parse(row.changes) as TaskChanges & { before: string; after: string }) : null;
    if (!changes || changes.undone || changes.kept) return false;
    await tx.run("UPDATE tasks SET changes = ? WHERE tenant = ? AND id = ?", [JSON.stringify({ ...changes, ...settled }), tenant, id]);
    return true;
  });
}

interface RequestRow {
  merged_at?: string | null;
  checked_head?: string | null;
  held_head?: string | null;
  held_reason?: string | null;
  tenant: string;
  repo_id: string;
  number: number;
  provider: string;
  url: string;
  branch: string;
  head_sha: string;
  title: string;
  status: string;
  created_at: string;
  created_by: string;
}

function toRequest(row: RequestRow): RequestRecord {
  return {
    tenant: row.tenant,
    repoId: row.repo_id,
    number: row.number,
    provider: row.provider as ForgeKind,
    url: row.url,
    branch: row.branch,
    headSha: row.head_sha,
    title: row.title,
    status: row.status as RequestStatus,
    createdAt: row.created_at,
    createdBy: row.created_by,
    ...(row.merged_at ? { mergedAt: row.merged_at } : {}),
    ...(row.checked_head ? { checkedHead: row.checked_head } : {}),
    ...(row.held_head ? { heldHead: row.held_head, heldReason: row.held_reason ?? "" } : {}),
  };
}

const mergedTime = (status: RequestStatus, at: string | null | undefined): string | null => (status === "merged" ? (at ?? new Date().toISOString()) : null);

interface TaskRow {
  tenant: string;
  id: string;
  repo_id: string;
  team: string;
  title: string;
  description: string;
  issue_url: string | null;
  issue_key: string | null;
  agent: string;
  status: string;
  created_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  base_sha: string | null;
  tests: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  request_number: number | null;
  error: string | null;
  template: string | null;
  target_mode?: string | null;
  stage?: string | null;
  skills?: string | null;
  tools?: string | null;
  loaded?: string | null;
  used_skills?: string | null;
  context_tokens?: number | string | null;
  run_started_at?: string | null;
  routing?: string | null;
  question?: string | null;
  mcp_needs_sign_in?: string | null;
  plan_first?: number | null;
  limit_reset_at?: string | null;
  ran_ms?: number | string | null;
  mode?: string | null;
  parent_id?: string | null;
  result?: string | null;
  changes?: string | null;
  depth?: number | string | null;
  runner?: string | null;
  choices?: string | null;
}

interface TargetRow {
  task_id: string;
  repo_id: string;
  status: string;
  reason: string;
  path?: string | null;
  head?: string | null;
  origin?: string | null;
  target_branch?: string | null;
  description?: string | null;
  forge_request?: string | null;
  base_sha: string | null;
  branch: string | null;
  tests: string | null;
  request_number: number | string | null;
  error: string | null;
  cost_usd: number | string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
}

const numberOrNull = (v: number | string | null): number | null => (v === null ? null : Number(v));

function toTarget(row: TargetRow): TaskTarget {
  return {
    repoId: row.repo_id,
    status: row.status as TaskTargetStatus,
    reason: row.reason,
    ...(row.path !== null && row.path !== undefined ? { path: row.path } : {}),
    ...(row.head ? { head: row.head } : {}),
    ...(row.origin ? { origin: row.origin } : {}),
    ...(row.target_branch ? { targetBranch: row.target_branch } : {}),
    ...(row.description ? { description: JSON.parse(row.description) as { title: string; body: string } } : {}),
    ...(row.forge_request ? { forgeRequest: JSON.parse(row.forge_request) as NonNullable<TaskTarget["forgeRequest"]> } : {}),
    baseSha: row.base_sha,
    branch: row.branch,
    tests: row.tests as TestOutcome | null,
    requestNumber: numberOrNull(row.request_number),
    error: row.error,
    cost: { usd: numberOrNull(row.cost_usd), inputTokens: numberOrNull(row.input_tokens), outputTokens: numberOrNull(row.output_tokens) },
  };
}

function targetColumns(patch: TaskTargetPatch): Record<string, SqlValue> {
  const columns: Record<string, SqlValue> = {};
  if (patch.repoId !== undefined) columns.repo_id = patch.repoId;
  if (patch.status !== undefined) columns.status = patch.status;
  if (patch.reason !== undefined) columns.reason = patch.reason;
  if (patch.baseSha !== undefined) columns.base_sha = patch.baseSha;
  if (patch.branch !== undefined) columns.branch = patch.branch;
  if (patch.tests !== undefined) columns.tests = patch.tests;
  if (patch.requestNumber !== undefined) columns.request_number = patch.requestNumber;
  if (patch.error !== undefined) columns.error = patch.error;
  if (patch.forgeRequest !== undefined) columns.forge_request = JSON.stringify(patch.forgeRequest);
  if (patch.cost !== undefined) {
    columns.cost_usd = patch.cost.usd;
    columns.input_tokens = patch.cost.inputTokens;
    columns.output_tokens = patch.cost.outputTokens;
  }
  return columns;
}

/** A task's target rows, matched with the same tenant and task as the outer tasks row. */
const TARGET_OF = "EXISTS (SELECT 1 FROM task_targets g WHERE g.tenant = tasks.tenant AND g.task_id = tasks.id";

/** A task filter as SQL, the same for SQLite and Postgres; an empty list of names matches nothing. */
function taskWhere(tenant: string, f: TaskFilter): { sql: string; params: SqlValue[] } {
  const clauses = ["tenant = ?"];
  const params: SqlValue[] = [tenant];
  const among = (column: string, values: readonly string[]) => (values.length ? (params.push(...values), `${column} IN (${values.map(() => "?").join(", ")})`) : "1 = 0");
  // A task over several repositories reaches each of them, so a repository and a request number
  // match the task's own pair or one of its targets' - always as a pair from one row, so a task
  // whose target A opened #3 does not pass for #3 in B. A status is the task's own: a target's
  // progress is not one.
  if (f.repoId !== undefined && f.requestNumber !== undefined) {
    clauses.push(`((repo_id = ? AND request_number = ?) OR ${TARGET_OF} AND g.repo_id = ? AND g.request_number = ?))`);
    params.push(f.repoId, f.requestNumber, f.repoId, f.requestNumber);
  } else if (f.repoId !== undefined) {
    clauses.push(`(repo_id = ? OR ${TARGET_OF} AND g.repo_id = ?))`);
    params.push(f.repoId, f.repoId);
  } else if (f.requestNumber !== undefined) {
    clauses.push(`(request_number = ? OR ${TARGET_OF} AND g.request_number = ?))`);
    params.push(f.requestNumber, f.requestNumber);
  }
  if (f.visibleTo) {
    // Each part adds its parameters as it is written, in the order the SQL names them.
    const teams = among("team", f.visibleTo.teams);
    const creators = among("created_by", f.visibleTo.creators);
    const shared = f.visibleTo.sharedWith === undefined ? "" : (params.push(f.visibleTo.sharedWith), " OR EXISTS (SELECT 1 FROM task_shares s WHERE s.tenant = tasks.tenant AND s.task_id = tasks.id AND s.user_id = ?)");
    clauses.push(`(${teams} OR ${creators}${shared})`);
  }
  if (f.createdBy) clauses.push(among("created_by", f.createdBy));
  if (f.statuses) clauses.push(among("status", f.statuses));
  if (f.issueKeys) clauses.push(among("issue_key", f.issueKeys));
  if (f.since !== undefined) clauses.push("created_at >= ?"), params.push(f.since);
  if (f.finishedSince !== undefined) clauses.push("finished_at >= ?"), params.push(f.finishedSince);
  if (f.requestOpenedSince !== undefined) {
    clauses.push(
      `(EXISTS (SELECT 1 FROM requests r WHERE r.tenant = tasks.tenant AND r.repo_id = tasks.repo_id AND r.number = tasks.request_number AND r.created_at >= ?) OR ${TARGET_OF} AND EXISTS (SELECT 1 FROM requests r WHERE r.tenant = g.tenant AND r.repo_id = g.repo_id AND r.number = g.request_number AND r.created_at >= ?)))`,
    );
    params.push(f.requestOpenedSince, f.requestOpenedSince);
  }
  // SQLite's LIKE ignores the case of ASCII letters and Postgres's does not, so the match is a
  // superset on one of them; the escape keeps a % or _ in the text from matching anything.
  if (f.descriptionHas !== undefined) clauses.push("description LIKE ? ESCAPE '\\'"), params.push(`%${f.descriptionHas.replace(/[\\%_]/g, "\\$&")}%`);
  // A search box's words: the same on both stores, whatever the case.
  if (f.titleHas !== undefined) {
    const like = `%${f.titleHas.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
    clauses.push("(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(issue_key, '')) LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  if (f.logHas !== undefined) {
    clauses.push("EXISTS (SELECT 1 FROM task_log l WHERE l.tenant = tasks.tenant AND l.task_id = tasks.id AND LOWER(l.text) LIKE ? ESCAPE '\\')");
    params.push(`%${f.logHas.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
  }
  return { sql: clauses.join(" AND "), params };
}

function toTask(row: TaskRow): TaskRecord {
  return {
    tenant: row.tenant,
    id: row.id,
    repoId: row.repo_id,
    team: row.team,
    title: row.title,
    description: row.description,
    issueUrl: row.issue_url,
    issueKey: row.issue_key,
    agent: row.agent,
    status: row.status as TaskStatus,
    createdBy: row.created_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    baseSha: row.base_sha,
    tests: row.tests as TestOutcome | null,
    cost: { usd: row.cost_usd, inputTokens: row.input_tokens, outputTokens: row.output_tokens },
    requestNumber: row.request_number,
    error: row.error,
    template: row.template ? (JSON.parse(row.template) as TaskRecord["template"]) : null,
    // A task over one repository carries neither, which reads as null; one over several has its
    // targets put in by withTargets, [] while they are planned.
    ...(row.target_mode ? { targetMode: row.target_mode as NonNullable<TaskRecord["targetMode"]>, targets: [] } : {}),
    // Absent rather than null when unset, as targets are, so a task without them reads as it did before.
    ...(row.stage ? { stage: row.stage as NonNullable<TaskRecord["stage"]> } : {}),
    ...(row.skills ? { skills: JSON.parse(row.skills) as string[] } : {}),
    ...(row.tools ? { tools: JSON.parse(row.tools) as TaskToolChoice } : {}),
    ...(row.loaded ? { loaded: JSON.parse(row.loaded) as TaskLoaded } : {}),
    ...(row.used_skills ? { usedSkills: JSON.parse(row.used_skills) as string[] } : {}),
    ...(row.context_tokens !== null && row.context_tokens !== undefined ? { context: { tokens: Number(row.context_tokens) } } : {}),
    ...(row.run_started_at ? { runStartedAt: row.run_started_at } : {}),
    ...(row.routing ? { routing: JSON.parse(row.routing) as NonNullable<TaskRecord["routing"]> } : {}),
    ...(row.question ? { question: JSON.parse(row.question) as NonNullable<TaskRecord["question"]> } : {}),
    ...(row.mcp_needs_sign_in ? { mcpNeedsSignIn: JSON.parse(row.mcp_needs_sign_in) as string[] } : {}),
    ...(row.plan_first ? { planFirst: true } : {}),
    ...(row.limit_reset_at ? { limitResetAt: row.limit_reset_at } : {}),
    ...(row.ran_ms !== null && row.ran_ms !== undefined ? { ranMs: Number(row.ran_ms) } : {}),
    ...(row.mode ? { mode: row.mode as NonNullable<TaskRecord["mode"]> } : {}),
    ...(row.parent_id ? { parentId: row.parent_id, depth: Number(row.depth) } : {}),
    ...(row.runner === "local" ? { runner: "local" as const } : {}),
    ...(row.choices ? { choices: JSON.parse(row.choices) as NonNullable<TaskRecord["choices"]> } : {}),
    ...(row.result ? { result: row.result as NonNullable<TaskRecord["result"]> } : {}),
    // The snapshots stay here: a page is shown the files and the undo, never the ids to read the shadow by.
    ...(row.changes ? { changes: (({ files, undone, kept }) => ({ files, undone, ...(kept ? { kept } : {}) }))(JSON.parse(row.changes) as TaskChanges) } : {}),
  };
}

/**
 * Puts each task's targets in, in position order, read a slice of tasks at a time: a task over
 * several repositories always has them, and a task in a folder of several gets them once its run
 * reports the repositories it changed.
 */
async function withTargets(db: SqlDriver, tenant: string, tasks: TaskRecord[]): Promise<TaskRecord[]> {
  const ids = tasks.map((t) => t.id);
  for (let at = 0; at < ids.length; at += 500) {
    const slice = ids.slice(at, at + 500);
    const rows = await db.all<TargetRow>(`SELECT * FROM task_targets WHERE tenant = ? AND task_id IN (${slice.map(() => "?").join(", ")}) ORDER BY task_id, position`, [tenant, ...slice]);
    for (const task of tasks) {
      if (!slice.includes(task.id)) continue;
      const own = rows.filter((r) => r.task_id === task.id);
      if (task.targets || own.length) task.targets = own.map(toTarget);
    }
  }
  // Who each is shared with, read with it so a page shows it and the read rule sees it.
  const all = tasks.map((t) => t.id);
  for (let at = 0; at < all.length; at += 500) {
    const slice = all.slice(at, at + 500);
    const rows = await db.all<{ task_id: string; user_id: string }>(`SELECT task_id, user_id FROM task_shares WHERE tenant = ? AND task_id IN (${slice.map(() => "?").join(", ")}) ORDER BY task_id, at, user_id`, [tenant, ...slice]);
    for (const row of rows) {
      const task = tasks.find((t) => t.id === row.task_id)!;
      (task.sharedWith ??= []).push(row.user_id);
    }
  }
  return tasks;
}

function taskColumns(patch: TaskPatch): Record<string, SqlValue> {
  const columns: Record<string, SqlValue> = {};
  if (patch.status !== undefined) columns.status = patch.status;
  if (patch.startedAt !== undefined) columns.started_at = patch.startedAt;
  if (patch.finishedAt !== undefined) columns.finished_at = patch.finishedAt;
  if (patch.baseSha !== undefined) columns.base_sha = patch.baseSha;
  if (patch.tests !== undefined) columns.tests = patch.tests;
  if (patch.requestNumber !== undefined) columns.request_number = patch.requestNumber;
  if (patch.error !== undefined) columns.error = patch.error;
  if (patch.stage !== undefined) columns.stage = patch.stage;
  if (patch.result !== undefined) columns.result = patch.result;
  if (patch.loaded !== undefined) columns.loaded = patch.loaded ? JSON.stringify(patch.loaded) : null;
  if (patch.routing !== undefined) columns.routing = patch.routing ? JSON.stringify(patch.routing) : null;
  if (patch.question !== undefined) columns.question = patch.question ? JSON.stringify(patch.question) : null;
  if (patch.mcpNeedsSignIn !== undefined) columns.mcp_needs_sign_in = patch.mcpNeedsSignIn.length ? JSON.stringify(patch.mcpNeedsSignIn) : null;
  if (patch.planFirst !== undefined) columns.plan_first = patch.planFirst ? 1 : 0;
  if (patch.cost !== undefined) {
    columns.cost_usd = patch.cost.usd;
    columns.input_tokens = patch.cost.inputTokens;
    columns.output_tokens = patch.cost.outputTokens;
  }
  return columns;
}

interface RepoRow {
  tenant: string;
  id: string;
  team: string;
  name: string;
  url: string;
  head: string | null;
  synced_at: string | null;
  error: string | null;
}

interface UserRow {
  tenant: string;
  id: string;
  email: string;
  name: string;
  role: string;
  password_hash: string | null;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  forge_login: string | null;
  created_at: string;
  identity_id?: string | null;
  sessions_revoked_at?: string | null;
}

function toUser(row: UserRow): UserRecord {
  return {
    tenant: row.tenant,
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as Role,
    passwordHash: row.password_hash,
    oidcIssuer: row.oidc_issuer,
    oidcSubject: row.oidc_subject,
    forgeLogin: row.forge_login,
    createdAt: row.created_at,
    identityId: row.identity_id ?? null,
    sessionsRevokedAt: row.sessions_revoked_at ?? null,
  };
}

interface OrgRow {
  tenant: string;
  name: string;
  created_by: string;
  created_at: string;
  quotas: string;
  plan?: string;
  deleted_at: string | null;
}

function toOrg(row: OrgRow): OrgRecord {
  return { tenant: row.tenant, name: row.name, createdBy: row.created_by, createdAt: row.created_at, quotas: { members: null, tasksPerMonth: null, concurrentTasks: null, ...(JSON.parse(row.quotas) as Partial<Quotas>) }, plan: (row.plan ?? "free") as Plan, deletedAt: row.deleted_at };
}

class IdentityTaken extends Error {}

class OrgRefused extends Error {
  constructor(readonly outcome: "taken" | "limit") {
    super(outcome);
  }
}

const IDENTITY_COLUMNS = 'id, email, name, email_verified_at AS "emailVerifiedAt", terms_url AS "termsUrl", terms_accepted_at AS "termsAcceptedAt", created_at AS "createdAt"';
const LOGIN_COLUMNS = 'provider, subject, identity_id AS "identityId", email, added_at AS "addedAt"';

const USER_COLUMNS: Record<string, string> = {
  name: "name",
  passwordHash: "password_hash",
  forgeLogin: "forge_login",
  oidcIssuer: "oidc_issuer",
  oidcSubject: "oidc_subject",
};

interface InviteRow {
  tenant: string;
  id: string;
  email: string;
  role: string;
  teams: string;
  token_hash: string;
  invited_by: string;
  created_at: string;
  expires_at: string;
}

function toInvite(row: InviteRow): InviteRecord {
  return {
    tenant: row.tenant,
    id: row.id,
    email: row.email,
    role: row.role as Role,
    teams: JSON.parse(row.teams) as string[],
    tokenHash: row.token_hash,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

interface KeyRow {
  tenant: string;
  id: string;
  prefix: string;
  secret_hash: string;
  name: string;
  owner_kind: string;
  owner_id: string;
  scopes: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  minted_by: string | null;
}

function toKey(row: KeyRow): KeyRecord {
  return {
    tenant: row.tenant,
    id: row.id,
    prefix: row.prefix,
    secretHash: row.secret_hash,
    name: row.name,
    owner: { kind: row.owner_kind as KeyRecord["owner"]["kind"], id: row.owner_id },
    scopes: JSON.parse(row.scopes) as Scopes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    mintedBy: row.minted_by,
  };
}

const SERVICE_ACCOUNT_COLUMNS = 'tenant, id, name, created_by AS "createdBy", created_at AS "createdAt"';

function toRecord(row: RepoRow): RepoRecord {
  return {
    id: row.id,
    tenant: row.tenant,
    team: row.team,
    name: row.name,
    url: row.url,
    head: row.head,
    syncedAt: row.synced_at,
    error: row.error,
  };
}

export function createStore(db: SqlDriver): Store {
  return {
    async listRepos(tenant) {
      return (await db.all<RepoRow>("SELECT * FROM repos WHERE tenant = ? ORDER BY team, name", [tenant])).map(toRecord);
    },
    async getRepo(tenant, id) {
      const row = await one<RepoRow>(db, "SELECT * FROM repos WHERE tenant = ? AND id = ?", [tenant, id]);
      return row ? toRecord(row) : null;
    },
    async upsertRepo(repo) {
      await db.run(
        `INSERT INTO repos (tenant, id, team, name, url) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant, id) DO UPDATE SET team = excluded.team, name = excluded.name, url = excluded.url`,
        [repo.tenant, repo.id, repo.team, repo.name, repo.url],
      );
      return (await this.getRepo(repo.tenant, repo.id))!;
    },
    async removeRepo(tenant, id) {
      await db.transaction(async (tx) => {
        await tx.run("DELETE FROM ingest_ids WHERE tenant = ? AND repo_id = ?", [tenant, id]);
        await tx.run("DELETE FROM repos WHERE tenant = ? AND id = ?", [tenant, id]);
      });
    },
    async recordSync(tenant, id, result) {
      if ("head" in result) {
        await db.run("UPDATE repos SET head = ?, synced_at = ?, error = NULL WHERE tenant = ? AND id = ?", [result.head, new Date().toISOString(), tenant, id]);
      } else {
        await db.run("UPDATE repos SET error = ?, synced_at = ? WHERE tenant = ? AND id = ?", [result.error, new Date().toISOString(), tenant, id]);
      }
    },
    async nextRequestNumber(tenant, repoId) {
      // The first reservation starts after any request already recorded, so a database from
      // before the counter existed carries on from its highest number.
      const row = await one<{ last: number | string }>(
        db,
        `INSERT INTO request_numbers (tenant, repo_id, last)
         SELECT ?, ?, COALESCE(MAX(number), 0) + 1 FROM requests WHERE tenant = ? AND repo_id = ?
         ON CONFLICT (tenant, repo_id) DO UPDATE SET last = request_numbers.last + 1
         RETURNING last`,
        [tenant, repoId, tenant, repoId],
      );
      return Number(row!.last);
    },
    async saveRequest(r) {
      await db.run(
        `INSERT INTO requests (tenant, repo_id, number, provider, url, branch, head_sha, title, status, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.tenant, r.repoId, r.number, r.provider, r.url, r.branch, r.headSha, r.title, r.status, r.createdAt, r.createdBy],
      );
    },
    async listRequests(tenant, repoId) {
      const rows = repoId
        ? await db.all<RequestRow>("SELECT * FROM requests WHERE tenant = ? AND repo_id = ? ORDER BY created_at DESC, number DESC", [tenant, repoId])
        : await db.all<RequestRow>("SELECT * FROM requests WHERE tenant = ? ORDER BY created_at DESC, number DESC", [tenant]);
      return rows.map(toRequest);
    },
    async requestPage(tenant, { repoId, status, seenBy }, after, limit) {
      // An empty list matches nothing (Postgres takes no empty IN): a person who reads no team's repository still sees what they opened.
      const among = (column: string, n: number) => (n ? `${column} IN (${Array.from({ length: n }, () => "?").join(", ")})` : "1 = 0");
      // The tasks that opened this request, on their own repository or on one of their targets, as the task filter pairs them.
      const openers = "SELECT 1 FROM tasks t WHERE t.tenant = requests.tenant AND ((t.repo_id = requests.repo_id AND t.request_number = requests.number) OR EXISTS (SELECT 1 FROM task_targets g WHERE g.tenant = t.tenant AND g.task_id = t.id AND g.repo_id = requests.repo_id AND g.request_number = requests.number))";
      const seen = seenBy
        ? ` AND ((NOT EXISTS (${openers}) AND (${among("repo_id", seenBy.repoIds.length)} OR ${among("created_by", seenBy.people.length)})) OR EXISTS (${openers} AND (${among("t.team", seenBy.taskTeams.length)} OR ${among("t.created_by", seenBy.people.length)})))`
        : "";
      const where = `tenant = ?${repoId ? " AND repo_id = ?" : ""}${seen}`;
      const params: SqlValue[] = [tenant, ...(repoId ? [repoId] : []), ...(seenBy ? [...seenBy.repoIds, ...seenBy.people, ...seenBy.taskTeams, ...seenBy.people] : [])];
      const counts: Record<RequestStatus, number> = { open: 0, merged: 0, closed: 0 };
      for (const row of await db.all<{ status: RequestStatus; n: number | string }>(`SELECT status, COUNT(*) AS n FROM requests WHERE ${where} GROUP BY status`, params)) {
        if (row.status in counts) counts[row.status] = Number(row.n);
      }
      const later = after ? " AND (created_at < ? OR (created_at = ? AND (repo_id > ? OR (repo_id = ? AND number < ?))))" : "";
      const rows = await db.all<RequestRow>(
        `SELECT * FROM requests WHERE ${where}${status ? " AND status = ?" : ""}${later} ORDER BY created_at DESC, repo_id, number DESC LIMIT ?`,
        [...params, ...(status ? [status] : []), ...(after ? [after.createdAt, after.createdAt, after.repoId, after.repoId, after.number] : []), limit + 1],
      );
      const requests = rows.slice(0, limit).map(toRequest);
      const last = requests.at(-1);
      return {
        requests,
        total: status ? counts[status] : counts.open + counts.merged + counts.closed,
        counts,
        next: rows.length > limit && last ? { createdAt: last.createdAt, repoId: last.repoId, number: last.number } : null,
      };
    },
    async allRequests() {
      return (await db.all<RequestRow>("SELECT * FROM requests ORDER BY tenant, repo_id, number")).map(toRequest);
    },
    async getRequest(tenant, repoId, number) {
      const row = await one<RequestRow>(db, "SELECT * FROM requests WHERE tenant = ? AND repo_id = ? AND number = ?", [tenant, repoId, number]);
      return row ? toRequest(row) : null;
    },
    async recordRequestCheck(tenant, repoId, number, check) {
      if (check.passed) {
        await db.run(
          "UPDATE requests SET checked_head = ?, held_head = CASE WHEN held_head = ? THEN held_head ELSE NULL END, held_reason = CASE WHEN held_head = ? THEN held_reason ELSE NULL END WHERE tenant = ? AND repo_id = ? AND number = ?",
          [check.head, check.head, check.head, tenant, repoId, number],
        );
      } else await db.run("UPDATE requests SET held_head = ?, held_reason = ? WHERE tenant = ? AND repo_id = ? AND number = ?", [check.head, check.reason, tenant, repoId, number]);
    },
    async transitionRequest(tenant, repoId, number, from, to, mergedAt) {
      return (await db.run("UPDATE requests SET status = ?, merged_at = ? WHERE tenant = ? AND repo_id = ? AND number = ? AND status = ?", [to, mergedTime(to, mergedAt), tenant, repoId, number, from])) === 1;
    },
    async setRequestStatus(tenant, repoId, number, status, mergedAt) {
      await db.run("UPDATE requests SET status = ?, merged_at = ? WHERE tenant = ? AND repo_id = ? AND number = ?", [status, mergedTime(status, mergedAt), tenant, repoId, number]);
    },
    async ingestId(tenant, repoId) {
      return (await one<{ id: string }>(db, "SELECT id FROM ingest_ids WHERE tenant = ? AND repo_id = ?", [tenant, repoId]))?.id ?? null;
    },
    async setIngestId(tenant, repoId, id) {
      await db.run("INSERT INTO ingest_ids (id, tenant, repo_id) VALUES (?, ?, ?) ON CONFLICT (tenant, repo_id) DO UPDATE SET id = excluded.id", [id, tenant, repoId]);
    },
    async dropIngestId(tenant, repoId) {
      await db.run("DELETE FROM ingest_ids WHERE tenant = ? AND repo_id = ?", [tenant, repoId]);
    },
    async repoForIngest(id) {
      return one<{ tenant: string; repoId: string }>(db, 'SELECT tenant, repo_id AS "repoId" FROM ingest_ids WHERE id = ?', [id]);
    },
    async addUsage(tenant, repoId, skill, hour, count) {
      await db.run(
        `INSERT INTO usage_counts (tenant, repo_id, skill, hour, count) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant, repo_id, skill, hour) DO UPDATE SET count = usage_counts.count + excluded.count`,
        [tenant, repoId, skill, hour, count],
      );
    },
    async usage(tenant, sinceHour, repoId) {
      const sql = `SELECT repo_id AS "repoId", skill, SUM(count) AS count, MAX(hour) AS "lastHour" FROM usage_counts
                   WHERE tenant = ? AND hour >= ? ${repoId ? "AND repo_id = ?" : ""} GROUP BY repo_id, skill ORDER BY count DESC, skill`;
      const rows = await db.all<UsageCount>(sql, repoId ? [tenant, sinceHour, repoId] : [tenant, sinceHour]);
      return rows.map((row) => ({ ...row, count: Number(row.count) }));
    },
    async usageDaily(tenant, sinceHour, repoId) {
      const sql = `SELECT repo_id AS "repoId", skill, SUBSTR(hour, 1, 10) AS day, SUM(count) AS count FROM usage_counts
                   WHERE tenant = ? AND hour >= ? ${repoId ? "AND repo_id = ?" : ""} GROUP BY repo_id, skill, SUBSTR(hour, 1, 10) ORDER BY day, repo_id, skill`;
      const rows = await db.all<DailyUsage>(sql, repoId ? [tenant, sinceHour, repoId] : [tenant, sinceHour]);
      return rows.map((row) => ({ ...row, count: Number(row.count) }));
    },
    async countUsers(tenant) {
      return Number((await one<{ n: number | string }>(db, "SELECT COUNT(*) AS n FROM users WHERE tenant = ?", [tenant]))?.n ?? 0);
    },
    async claimSetup(user) {
      // The setup marker's primary key makes this one-time: of two first-owner requests
      // racing, the second insert conflicts and adds nothing. An account that already exists
      // (a member, say) does not block it; an owner does.
      return db
        .transaction(async (tx) => {
          const claimed = await tx.run("INSERT INTO settings (tenant, key, value) VALUES (?, 'setup.claimed', ?) ON CONFLICT (tenant, key) DO NOTHING", [user.tenant, user.id]);
          if (!claimed) return false;
          if (Number((await one<{ n: number | string }>(tx, "SELECT COUNT(*) AS n FROM users WHERE tenant = ? AND role = 'owner'", [user.tenant]))?.n ?? 0) > 0) {
            throw new Error("setup is already done");
          }
          await insertUser(tx, user);
          return true;
        })
        .catch((err: Error) => {
          if (err.message === "setup is already done") return false;
          throw err;
        });
    },
    async countOwners(tenant) {
      return countOwners(db, tenant);
    },
    async turnOffUser(tenant, id, at) {
      return db.transaction(async (tx) => {
        await ownerTurn(tx, tenant);
        if (await lastOwner(tx, tenant, id)) return false;
        await tx.run("INSERT INTO settings (tenant, key, value) VALUES (?, ?, ?) ON CONFLICT (tenant, key) DO UPDATE SET value = excluded.value", [tenant, `${OFF_PREFIX}${id}`, at]);
        return true;
      });
    },
    async setRole(tenant, id, role) {
      return db.transaction(async (tx) => {
        await ownerTurn(tx, tenant);
        if (role !== "owner" && (await lastOwner(tx, tenant, id))) return false;
        await tx.run("UPDATE users SET role = ? WHERE tenant = ? AND id = ?", [role, tenant, id]);
        return true;
      });
    },
    async purgeExpired(now) {
      await db.run("DELETE FROM sessions WHERE expires_at <= ?", [now]);
      await db.run("DELETE FROM oidc_logins WHERE expires_at <= ?", [now]);
      await db.run("DELETE FROM identity_sessions WHERE expires_at <= ?", [now]);
      await db.run("DELETE FROM identity_sign_ins WHERE expires_at <= ?", [now]);
    },
    async insertUser(user) {
      await insertUser(db, user);
    },
    async getUser(tenant, id) {
      const row = await one<UserRow>(db, "SELECT * FROM users WHERE tenant = ? AND id = ?", [tenant, id]);
      return row ? toUser(row) : null;
    },
    async getUserByEmail(tenant, email) {
      const row = await one<UserRow>(db, "SELECT * FROM users WHERE tenant = ? AND email = ?", [tenant, email]);
      return row ? toUser(row) : null;
    },
    async getUserByOidc(tenant, issuer, subject) {
      const row = await one<UserRow>(db, "SELECT * FROM users WHERE tenant = ? AND oidc_issuer = ? AND oidc_subject = ?", [tenant, issuer, subject]);
      return row ? toUser(row) : null;
    },
    async listUsers(tenant) {
      return (await db.all<UserRow>("SELECT * FROM users WHERE tenant = ? ORDER BY name, email", [tenant])).map(toUser);
    },
    async updateUser(tenant, id, patch) {
      const fields = Object.entries(patch).filter(([key, value]) => USER_COLUMNS[key] && value !== undefined);
      if (!fields.length) return;
      await db.run(`UPDATE users SET ${fields.map(([key]) => `${USER_COLUMNS[key]} = ?`).join(", ")} WHERE tenant = ? AND id = ?`, [
        ...fields.map(([, value]) => value as SqlValue),
        tenant,
        id,
      ]);
    },
    async deleteUser(tenant, id) {
      return db.transaction(async (tx) => {
        await ownerTurn(tx, tenant);
        if (await lastOwner(tx, tenant, id)) return false;
        await tx.run("DELETE FROM sessions WHERE tenant = ? AND user_id = ?", [tenant, id]);
        await tx.run("DELETE FROM team_owners WHERE tenant = ? AND user_id = ?", [tenant, id]);
        await tx.run("DELETE FROM api_keys WHERE tenant = ? AND owner_kind = 'user' AND owner_id = ?", [tenant, id]);
        await tx.run("DELETE FROM member_groups WHERE tenant = ? AND user_id = ?", [tenant, id]);
        await tx.run("DELETE FROM member_tags WHERE tenant = ? AND user_id = ?", [tenant, id]);
        await tx.run("DELETE FROM task_shares WHERE tenant = ? AND user_id = ?", [tenant, id]);
        // Their own MCP servers and the credentials sealed for them, and every app they approved
        // with the tokens it holds: a deleted account keeps nothing that still opens something.
        const own = `mcp.personal.${id}`;
        await tx.run("DELETE FROM secrets WHERE tenant = ? AND substr(name, 1, ?) = ?", [tenant, own.length + 1, `${own}.`]);
        await tx.run("DELETE FROM settings WHERE tenant = ? AND key = ?", [tenant, own]);
        // The forge sign-ins they made with a one-time code (forge/device-sign-in.ts): the token writes to every repository they can.
        for (const kind of ["github", "gitlab"]) {
          await tx.run("DELETE FROM secrets WHERE tenant = ? AND name = ?", [tenant, `forge-person:${kind}:${id}`]);
          await tx.run("DELETE FROM settings WHERE tenant = ? AND key = ?", [tenant, `forge.person.${kind}.${id}`]);
        }
        await dropGrants(tx, tenant, id);
        await tx.run("DELETE FROM settings WHERE tenant = ? AND key = ?", [tenant, `scim.user.${id}`]);
        await tx.run("DELETE FROM settings WHERE tenant = ? AND key = ?", [tenant, `${OFF_PREFIX}${id}`]);
        await tx.run("DELETE FROM users WHERE tenant = ? AND id = ?", [tenant, id]);
        return true;
      });
    },
    async ownedTeams(tenant, userId) {
      return (await db.all<{ team: string }>("SELECT team FROM team_owners WHERE tenant = ? AND user_id = ? ORDER BY team", [tenant, userId])).map((r) => r.team);
    },
    async setOwnedTeams(tenant, userId, teams) {
      await db.transaction(async (tx) => {
        await tx.run("DELETE FROM team_owners WHERE tenant = ? AND user_id = ?", [tenant, userId]);
        for (const team of new Set(teams)) await tx.run("INSERT INTO team_owners (tenant, user_id, team) VALUES (?, ?, ?)", [tenant, userId, team]);
      });
    },
    async teamOwners(tenant) {
      return db.all<{ userId: string; team: string }>('SELECT user_id AS "userId", team FROM team_owners WHERE tenant = ? ORDER BY team, user_id', [tenant]);
    },
    async saveDomain(d) {
      await db.run("INSERT INTO sso_domains (tenant, domain, token, added_by, added_at, verified_at) VALUES (?, ?, ?, ?, ?, ?)", [d.tenant, d.domain, d.token, d.addedBy, d.addedAt, d.verifiedAt]);
    },
    async listDomains(tenant) {
      return db.all<DomainRecord>(
        'SELECT tenant, domain, token, added_by AS "addedBy", added_at AS "addedAt", verified_at AS "verifiedAt" FROM sso_domains WHERE tenant = ? ORDER BY domain',
        [tenant],
      );
    },
    async markDomainVerified(tenant, domain, at) {
      await db.run("UPDATE sso_domains SET verified_at = ? WHERE tenant = ? AND domain = ? AND verified_at IS NULL", [at, tenant, domain]);
    },
    async deleteDomain(tenant, domain) {
      await db.run("DELETE FROM sso_domains WHERE tenant = ? AND domain = ?", [tenant, domain]);
    },
    async saveInvite(i) {
      await db.transaction(async (tx) => {
        await tx.run("DELETE FROM invites WHERE tenant = ? AND email = ?", [i.tenant, i.email]);
        await tx.run(
          "INSERT INTO invites (tenant, id, email, role, teams, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [i.tenant, i.id, i.email, i.role, JSON.stringify(i.teams), i.tokenHash, i.invitedBy, i.createdAt, i.expiresAt],
        );
      });
    },
    async listInvites(tenant) {
      return (await db.all<InviteRow>("SELECT * FROM invites WHERE tenant = ? ORDER BY created_at DESC, email", [tenant])).map(toInvite);
    },
    async getInvite(tenant, id) {
      const row = await one<InviteRow>(db, "SELECT * FROM invites WHERE tenant = ? AND id = ?", [tenant, id]);
      return row ? toInvite(row) : null;
    },
    async getInviteByToken(tokenHash) {
      const row = await one<InviteRow>(db, "SELECT * FROM invites WHERE token_hash = ?", [tokenHash]);
      return row ? toInvite(row) : null;
    },
    async takeInviteByToken(tenant, tokenHash) {
      const row = await one<InviteRow>(db, "DELETE FROM invites WHERE tenant = ? AND token_hash = ? RETURNING *", [tenant, tokenHash]);
      return row ? toInvite(row) : null;
    },
    async takeInviteByEmail(tenant, email, now) {
      const row = await one<InviteRow>(db, "DELETE FROM invites WHERE tenant = ? AND email = ? AND expires_at > ? RETURNING *", [tenant, email, now]);
      return row ? toInvite(row) : null;
    },
    async listInvitesByEmail(email, now) {
      return (
        await db.all<InviteRow>(
          "SELECT i.* FROM invites i WHERE i.email = ? AND i.expires_at > ? AND NOT EXISTS (SELECT 1 FROM orgs o WHERE o.tenant = i.tenant AND o.deleted_at IS NOT NULL) ORDER BY i.created_at DESC, i.tenant",
          [email, now],
        )
      ).map(toInvite);
    },
    async deleteInvite(tenant, id) {
      await db.run("DELETE FROM invites WHERE tenant = ? AND id = ?", [tenant, id]);
    },
    async saveKey(k) {
      await db.run(
        `INSERT INTO api_keys (tenant, id, prefix, secret_hash, name, owner_kind, owner_id, scopes, created_by, created_at, expires_at, last_used_at, revoked_at, minted_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [k.tenant, k.id, k.prefix, k.secretHash, k.name, k.owner.kind, k.owner.id, JSON.stringify(k.scopes), k.createdBy, k.createdAt, k.expiresAt, k.lastUsedAt, k.revokedAt, k.mintedBy],
      );
    },
    async keyByPrefix(prefix) {
      const row = await one<KeyRow>(db, "SELECT * FROM api_keys WHERE prefix = ?", [prefix]);
      return row ? toKey(row) : null;
    },
    async getKey(tenant, id) {
      const row = await one<KeyRow>(db, "SELECT * FROM api_keys WHERE tenant = ? AND id = ?", [tenant, id]);
      return row ? toKey(row) : null;
    },
    async listKeys(tenant, owner) {
      return (await db.all<KeyRow>("SELECT * FROM api_keys WHERE tenant = ? AND owner_kind = ? AND owner_id = ? ORDER BY created_at DESC, id", [tenant, owner.kind, owner.id])).map(toKey);
    },
    async revokeKey(tenant, id, at) {
      // A leaked key that minted keys before anyone noticed would leave them working; each
      // generation is found from the one before, and all of them go in the same transaction.
      await db.transaction(async (tx) => {
        let generation = [id];
        while (generation.length) {
          const marks = generation.map(() => "?").join(", ");
          await tx.run(`UPDATE api_keys SET revoked_at = ? WHERE tenant = ? AND id IN (${marks}) AND revoked_at IS NULL`, [at, tenant, ...generation]);
          generation = (await tx.all<{ id: string }>(`SELECT id FROM api_keys WHERE tenant = ? AND minted_by IN (${marks})`, [tenant, ...generation])).map((r) => r.id);
        }
      });
    },
    async touchKey(tenant, id, at) {
      await db.run("UPDATE api_keys SET last_used_at = ? WHERE tenant = ? AND id = ?", [at, tenant, id]);
    },
    async saveServiceAccount(a) {
      await db.run("INSERT INTO service_accounts (tenant, id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)", [a.tenant, a.id, a.name, a.createdBy, a.createdAt]);
    },
    async getServiceAccount(tenant, id) {
      return one<ServiceAccountRecord>(db, `SELECT ${SERVICE_ACCOUNT_COLUMNS} FROM service_accounts WHERE tenant = ? AND id = ?`, [tenant, id]);
    },
    async listServiceAccounts(tenant) {
      return db.all<ServiceAccountRecord>(`SELECT ${SERVICE_ACCOUNT_COLUMNS} FROM service_accounts WHERE tenant = ? ORDER BY name, id`, [tenant]);
    },
    async renameServiceAccount(tenant, id, name) {
      await db.run("UPDATE service_accounts SET name = ? WHERE tenant = ? AND id = ?", [name, tenant, id]);
    },
    async deleteServiceAccount(tenant, id) {
      await db.transaction(async (tx) => {
        await tx.run("DELETE FROM api_keys WHERE tenant = ? AND owner_kind = 'service' AND owner_id = ?", [tenant, id]);
        await tx.run("DELETE FROM team_owners WHERE tenant = ? AND user_id = ?", [tenant, `service:${id}`]);
        await tx.run("DELETE FROM service_accounts WHERE tenant = ? AND id = ?", [tenant, id]);
      });
    },
    async setMemberGroups(tenant, userId, groups) {
      await db.transaction(async (tx) => {
        await tx.run("DELETE FROM member_groups WHERE tenant = ? AND user_id = ?", [tenant, userId]);
        for (const group of new Set(groups)) await tx.run("INSERT INTO member_groups (tenant, user_id, grp) VALUES (?, ?, ?)", [tenant, userId, group]);
      });
    },
    async memberGroups(tenant) {
      return db.all<{ userId: string; group: string }>('SELECT user_id AS "userId", grp AS "group" FROM member_groups WHERE tenant = ? ORDER BY grp, user_id', [tenant]);
    },
    async groupTags(tenant) {
      return db.all<{ group: string; tag: string }>('SELECT grp AS "group", tag FROM group_tags WHERE tenant = ? ORDER BY grp', [tenant]);
    },
    async setGroupTags(tenant, mapping) {
      await db.transaction(async (tx) => {
        await tx.run("DELETE FROM group_tags WHERE tenant = ?", [tenant]);
        for (const { group, tag } of mapping) await tx.run("INSERT INTO group_tags (tenant, grp, tag) VALUES (?, ?, ?)", [tenant, group, tag]);
      });
    },
    async manualTags(tenant) {
      return db.all<{ userId: string; tag: string }>('SELECT user_id AS "userId", tag FROM member_tags WHERE tenant = ? ORDER BY tag, user_id', [tenant]);
    },
    async setManualTags(tenant, userId, tags) {
      await db.transaction(async (tx) => {
        await tx.run("DELETE FROM member_tags WHERE tenant = ? AND user_id = ?", [tenant, userId]);
        for (const tag of new Set(tags)) await tx.run("INSERT INTO member_tags (tenant, user_id, tag) VALUES (?, ?, ?)", [tenant, userId, tag]);
      });
    },
    async purgeTaskLog(tenant, before) {
      return db.run("DELETE FROM task_log WHERE tenant = ? AND at < ?", [tenant, before]);
    },
    async purgeUsage(tenant, beforeHour) {
      return db.run("DELETE FROM usage_counts WHERE tenant = ? AND hour < ?", [tenant, beforeHour]);
    },
    async saveSession(s) {
      const at = s.createdAt ?? new Date().toISOString();
      await db.run("INSERT INTO sessions (token_hash, tenant, user_id, csrf, expires_at, id, created_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
        s.tokenHash, s.tenant, s.userId, s.csrf, s.expiresAt, newId("ses"), at, at, agentOf(s.userAgent),
      ]);
    },
    async listSessions(tenant, userId, current) {
      return (await db.all<SessionListingRow>(`SELECT ${LISTING_COLUMNS} FROM sessions WHERE tenant = ? AND user_id = ? ORDER BY COALESCE(last_seen_at, created_at, expires_at) DESC, id`, [tenant, userId])).map((r) => toListing(r, current));
    },
    async deleteSessionById(tenant, userId, id) {
      return (await db.run("DELETE FROM sessions WHERE tenant = ? AND user_id = ? AND id = ?", [tenant, userId, id])) > 0;
    },
    async touchSession(tokenHash, at, expiresAt) {
      await db.run(`UPDATE sessions SET last_seen_at = ?${LATER_EXPIRY(expiresAt)} WHERE token_hash = ?`, [at, ...(expiresAt ? [expiresAt, expiresAt] : []), tokenHash]);
    },
    async getSession(tokenHash) {
      return one<SessionRecord>(
        db,
        'SELECT token_hash AS "tokenHash", tenant, user_id AS "userId", csrf, expires_at AS "expiresAt", created_at AS "createdAt" FROM sessions WHERE token_hash = ?',
        [tokenHash],
      );
    },
    async deleteSession(tokenHash) {
      await db.run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
    },
    async deleteSessions(tenant, userId, except) {
      await db.run("DELETE FROM sessions WHERE tenant = ? AND user_id = ? AND token_hash <> ?", [tenant, userId, except ?? ""]);
      // A cloud identity's one session serves every organization it belongs to, so ending this
      // account's sessions is a time its identity session has to be newer than to reach this one.
      await db.run("UPDATE users SET sessions_revoked_at = ? WHERE tenant = ? AND id = ?", [new Date().toISOString(), tenant, userId]);
    },
    async insertIdentity(identity, login) {
      // Only a taken address or login reads as false; any other failure is thrown, so a database
      // that did not answer is never told to the person as an account that already exists.
      return db
        .transaction(async (tx) => {
          const added = await tx.run(
            "INSERT INTO identities (id, email, name, email_verified_at, terms_url, terms_accepted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (email) DO NOTHING",
            [identity.id, identity.email.toLowerCase(), identity.name, identity.emailVerifiedAt, identity.termsUrl, identity.termsAcceptedAt, identity.createdAt],
          );
          if (!added) throw new IdentityTaken();
          const linked = await tx.run("INSERT INTO identity_logins (provider, subject, identity_id, email, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (provider, subject) DO NOTHING", [login.provider, login.subject, identity.id, login.email.toLowerCase(), login.addedAt]);
          if (!linked) throw new IdentityTaken();
          return true;
        })
        .catch((err: unknown) => {
          if (err instanceof IdentityTaken) return false;
          throw err;
        });
    },
    async getIdentity(id) {
      return one<IdentityRecord>(db, `SELECT ${IDENTITY_COLUMNS} FROM identities WHERE id = ?`, [id]);
    },
    async getIdentityByEmail(email) {
      return one<IdentityRecord>(db, `SELECT ${IDENTITY_COLUMNS} FROM identities WHERE email = ?`, [email.toLowerCase()]);
    },
    async getIdentityByLogin(provider, subject) {
      return one<IdentityRecord>(db, `SELECT ${IDENTITY_COLUMNS} FROM identities WHERE id = (SELECT identity_id FROM identity_logins WHERE provider = ? AND subject = ?)`, [provider, subject]);
    },
    async listLogins(identityId) {
      return db.all<IdentityLogin>(`SELECT ${LOGIN_COLUMNS} FROM identity_logins WHERE identity_id = ? ORDER BY added_at`, [identityId]);
    },
    async addLogin(login) {
      return (await db.run("INSERT INTO identity_logins (provider, subject, identity_id, email, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (provider, subject) DO NOTHING", [login.provider, login.subject, login.identityId, login.email.toLowerCase(), login.addedAt])) > 0;
    },
    async removeLogin(identityId, provider, subject) {
      // The write to the identity's own row holds it until the transaction ends, as ownerTurn does
      // for owners: two removals at once read the count one after the other, so neither leaves
      // the identity with no way in. A count inside the DELETE alone does not, under Postgres.
      return db.transaction(async (tx) => {
        await tx.run("UPDATE identities SET id = id WHERE id = ?", [identityId]);
        return (
          (await tx.run(
            "DELETE FROM identity_logins WHERE identity_id = ? AND provider = ? AND subject = ? AND (SELECT COUNT(*) FROM identity_logins WHERE identity_id = ?) > 1",
            [identityId, provider, subject, identityId],
          )) > 0
        );
      });
    },
    async acceptTerms(identityId, url, at) {
      await db.run("UPDATE identities SET terms_url = ?, terms_accepted_at = ? WHERE id = ?", [url, at, identityId]);
    },
    async saveIdentitySession(s) {
      await db.run("INSERT INTO identity_sessions (token_hash, identity_id, csrf, method, domain, authenticated_at, expires_at, id, created_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
        s.tokenHash, s.identityId, s.csrf, s.method, s.domain, s.authenticatedAt, s.expiresAt, newId("ses"), s.authenticatedAt, s.authenticatedAt, agentOf(s.userAgent),
      ]);
    },
    async listIdentitySessions(identityId, current) {
      return (await db.all<SessionListingRow>(`SELECT ${LISTING_COLUMNS} FROM identity_sessions WHERE identity_id = ? ORDER BY COALESCE(last_seen_at, created_at, expires_at) DESC, id`, [identityId])).map((r) => toListing(r, current));
    },
    async deleteIdentitySessionById(identityId, id) {
      return (await db.run("DELETE FROM identity_sessions WHERE identity_id = ? AND id = ?", [identityId, id])) > 0;
    },
    async touchIdentitySession(tokenHash, at, expiresAt) {
      await db.run(`UPDATE identity_sessions SET last_seen_at = ?${LATER_EXPIRY(expiresAt)} WHERE token_hash = ?`, [at, ...(expiresAt ? [expiresAt, expiresAt] : []), tokenHash]);
    },
    async getIdentitySession(tokenHash) {
      return one<IdentitySessionRecord>(
        db,
        'SELECT token_hash AS "tokenHash", identity_id AS "identityId", csrf, method, domain, authenticated_at AS "authenticatedAt", expires_at AS "expiresAt" FROM identity_sessions WHERE token_hash = ?',
        [tokenHash],
      );
    },
    async deleteIdentitySession(tokenHash) {
      await db.run("DELETE FROM identity_sessions WHERE token_hash = ?", [tokenHash]);
    },
    async savePendingSignIn(p) {
      await db.run("INSERT INTO identity_sign_ins (state, provider, purpose, nonce, verifier, identity_id, invite_id, account, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [p.state, p.provider, p.purpose, p.nonce, p.verifier, p.identityId, p.inviteId, p.account ? JSON.stringify(p.account) : null, p.expiresAt]);
    },
    async takePendingSignIn(state, now) {
      // One DELETE that returns the row, as invites and OIDC sign-ins are taken: of two callbacks
      // with the same state at once, only the one whose DELETE removed it gets it back. An expired
      // one is removed all the same and returned to nobody.
      const found = await one<Omit<PendingSignIn, "account"> & { account: string | null }>(
        db,
        'DELETE FROM identity_sign_ins WHERE state = ? RETURNING state, provider, purpose, nonce, verifier, identity_id AS "identityId", invite_id AS "inviteId", account, expires_at AS "expiresAt"',
        [state],
      );
      return found && found.expiresAt > now ? { ...found, account: found.account ? (JSON.parse(found.account) as PendingAccount) : null } : null;
    },
    async getUserByIdentity(tenant, identityId) {
      const row = await one<UserRow>(db, "SELECT * FROM users WHERE tenant = ? AND identity_id = ?", [tenant, identityId]);
      return row ? toUser(row) : null;
    },
    async countMembers(tenant) {
      return countMembers(db, tenant);
    },
    async insertMember(user, members) {
      // The turn row holds the organization until the transaction ends, so two people joining at
      // once are counted one after the other and the second finds it full.
      return db.transaction(async (tx) => {
        await ownerTurn(tx, user.tenant);
        if (members !== null && (await countMembers(tx, user.tenant)) >= members) return false;
        await insertUser(tx, user);
        return true;
      });
    },
    async listMemberships(identityId) {
      return (await db.all<UserRow>("SELECT * FROM users WHERE identity_id = ? ORDER BY tenant", [identityId])).map(toUser);
    },
    async insertOrg(org) {
      return (await db.run("INSERT INTO orgs (tenant, name, created_by, created_at, quotas, plan, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant) DO NOTHING", [org.tenant, org.name, org.createdBy, org.createdAt, JSON.stringify(org.quotas), org.plan ?? "free", org.deletedAt])) > 0;
    },
    async createOrg(org, owner, name, perDay) {
      // The write to the identity's own row holds it until the transaction ends, so two signups
      // by one person at once are counted one after the other against the day's limit.
      return db
        .transaction(async (tx) => {
          await tx.run("UPDATE identities SET id = id WHERE id = ?", [perDay.identityId]);
          const made = Number((await one<{ n: number | string }>(tx, "SELECT COUNT(*) AS n FROM orgs WHERE created_by = ? AND created_at >= ?", [perDay.identityId, perDay.since]))?.n ?? 0);
          if (made >= perDay.limit) throw new OrgRefused("limit");
          const inserted = await tx.run("INSERT INTO orgs (tenant, name, created_by, created_at, quotas, plan, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant) DO NOTHING", [org.tenant, org.name, org.createdBy, org.createdAt, JSON.stringify(org.quotas), org.plan ?? "free", org.deletedAt]);
          if (!inserted) throw new OrgRefused("taken");
          const claimed = await tx.run("INSERT INTO settings (tenant, key, value) VALUES (?, 'setup.claimed', ?) ON CONFLICT (tenant, key) DO NOTHING", [owner.tenant, owner.id]);
          if (!claimed) throw new OrgRefused("taken");
          if (Number((await one<{ n: number | string }>(tx, "SELECT COUNT(*) AS n FROM users WHERE tenant = ? AND role = 'owner'", [owner.tenant]))?.n ?? 0) > 0) throw new OrgRefused("taken");
          await insertUser(tx, owner);
          await tx.run("INSERT INTO settings (tenant, key, value) VALUES (?, 'org.name', ?) ON CONFLICT (tenant, key) DO UPDATE SET value = excluded.value", [org.tenant, name]);
          return "created" as const;
        })
        .catch((err: unknown) => {
          if (err instanceof OrgRefused) return err.outcome;
          throw err;
        });
    },
    async getOrg(tenant) {
      const row = await one<OrgRow>(db, "SELECT * FROM orgs WHERE tenant = ?", [tenant]);
      return row ? toOrg(row) : null;
    },
    async listOrgs() {
      return (await db.all<OrgRow>("SELECT * FROM orgs WHERE deleted_at IS NULL ORDER BY tenant", [])).map(toOrg);
    },
    async countOrgsCreatedSince(identityId, since) {
      return Number((await one<{ n: number | string }>(db, "SELECT COUNT(*) AS n FROM orgs WHERE created_by = ? AND created_at >= ?", [identityId, since]))?.n ?? 0);
    },
    async setOrgPlan(tenant, plan) {
      await db.run("UPDATE orgs SET plan = ? WHERE tenant = ?", [plan, tenant]);
    },
    async setOrgQuotas(tenant, quotas) {
      await db.run("UPDATE orgs SET quotas = ? WHERE tenant = ?", [JSON.stringify(quotas), tenant]);
    },
    async deleteOrg(tenant, at) {
      return (await db.run("UPDATE orgs SET deleted_at = ? WHERE tenant = ? AND deleted_at IS NULL", [at, tenant])) > 0;
    },
    async saveOidcLogin(login) {
      await db.run("INSERT INTO oidc_logins (state, tenant, nonce, verifier, expires_at) VALUES (?, ?, ?, ?, ?)", [
        login.state,
        login.tenant,
        login.nonce,
        login.verifier,
        login.expiresAt,
      ]);
    },
    async takeOidcLogin(state) {
      // Deleted and returned in one statement: of two callbacks racing on a state, one gets the row.
      return one<OidcLogin>(db, 'DELETE FROM oidc_logins WHERE state = ? RETURNING state, tenant, nonce, verifier, expires_at AS "expiresAt"', [state]);
    },
    async putSecret(tenant, name, sealed, by) {
      await db.run(
        `INSERT INTO secrets (tenant, name, sealed, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant, name) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [tenant, name, sealed, new Date().toISOString(), by],
      );
    },
    async getSecret(tenant, name) {
      return (await one<{ sealed: string }>(db, "SELECT sealed FROM secrets WHERE tenant = ? AND name = ?", [tenant, name]))?.sealed ?? null;
    },
    async secretSetAt(tenant, name) {
      return one<{ updatedAt: string; updatedBy: string }>(db, 'SELECT updated_at AS "updatedAt", updated_by AS "updatedBy" FROM secrets WHERE tenant = ? AND name = ?', [tenant, name]);
    },
    async listSecrets(tenant, prefix) {
      return db.all<{ name: string; updatedAt: string; updatedBy: string }>(
        'SELECT name, updated_at AS "updatedAt", updated_by AS "updatedBy" FROM secrets WHERE tenant = ? AND substr(name, 1, ?) = ? ORDER BY name',
        [tenant, prefix.length, prefix],
      );
    },
    async deleteSecret(tenant, name) {
      await db.run("DELETE FROM secrets WHERE tenant = ? AND name = ?", [tenant, name]);
    },
    async getForgeConfig(tenant, repoId) {
      return one<ForgeConfig>(db, 'SELECT repo_id AS "repoId", kind, api_url AS "apiUrl", project FROM forges WHERE tenant = ? AND repo_id = ?', [tenant, repoId]);
    },
    async setForgeConfig(tenant, config) {
      await db.run(
        `INSERT INTO forges (tenant, repo_id, kind, api_url, project) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant, repo_id) DO UPDATE SET kind = excluded.kind, api_url = excluded.api_url, project = excluded.project`,
        [tenant, config.repoId, config.kind, config.apiUrl, config.project],
      );
    },
    async deleteForgeConfig(tenant, repoId) {
      await db.run("DELETE FROM forges WHERE tenant = ? AND repo_id = ?", [tenant, repoId]);
    },
    async createTask(t) {
      await insertTask(db, t);
    },
    async getTask(tenant, id) {
      const row = await one<TaskRow>(db, "SELECT * FROM tasks WHERE tenant = ? AND id = ?", [tenant, id]);
      return row ? (await withTargets(db, tenant, [toTask(row)]))[0]! : null;
    },
    async commitCommand(command) {
      return db.transaction(async (tx) => {
        if (command.receipt) {
          const r = command.receipt;
          // A second command with the same id waits here on the first one's row, and once that
          // commits finds it: of two at once, one writes and the other gets its answer back.
          const kept = await tx.run(
            "INSERT INTO command_receipts (tenant, actor_id, command_id, kind, task_id, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant, actor_id, command_id) DO NOTHING",
            [command.tenant, r.actorId, r.commandId, r.kind, command.taskId, r.result, command.at],
          );
          if (!kept) return { replayed: true, receipt: await receiptOf(tx, command.tenant, r.actorId, r.commandId), effects: [] };
        }
        if (command.createTask) await insertTask(tx, command.createTask);
        // The write to the task's own row holds it until this transaction ends, so two commands on
        // one task number their effects one after the other: the task has one writer at a time.
        await tx.run("UPDATE tasks SET id = id WHERE tenant = ? AND id = ?", [command.tenant, command.taskId]);
        if (command.taskPatch) {
          const columns = taskColumns(command.taskPatch);
          const names = Object.keys(columns);
          if (names.length) await tx.run(`UPDATE tasks SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE tenant = ? AND id = ?`, [...Object.values(columns), command.tenant, command.taskId]);
        }
        for (const event of command.events ?? []) await insertEvent(tx, event);
        const effects: EffectRecord[] = [];
        const last = Number((await one<{ n: number | string | null }>(tx, "SELECT MAX(seq) AS n FROM task_effects WHERE tenant = ? AND task_id = ?", [command.tenant, command.taskId]))?.n ?? 0);
        for (const [i, effect] of (command.effects ?? []).entries()) {
          const payload = JSON.stringify(effect.payload);
          // The outbox is a persistence boundary: an effect carries the names of secrets, never one.
          const secret = detectSecret(payload);
          if (secret) throw new Error(`the ${effect.kind} effect's payload holds what looks like a ${secret}; an effect carries names and references, never a secret`);
          const row: EffectRow = { tenant: command.tenant, id: newId("eff"), task_id: command.taskId, seq: last + i + 1, kind: effect.kind, payload, replay: effect.replay, status: "pending", attempts: 0, claimed_by: null, lease_until: null, due_at: command.at, last_error: null, result: null, created_at: command.at, settled_at: null };
          await tx.run(
            "INSERT INTO task_effects (tenant, id, task_id, seq, kind, payload, replay, status, attempts, claimed_by, lease_until, due_at, last_error, result, created_at, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [row.tenant, row.id, row.task_id, row.seq, row.kind, row.payload, row.replay, row.status, row.attempts, row.claimed_by, row.lease_until, row.due_at, row.last_error, row.result, row.created_at, row.settled_at],
          );
          effects.push(toEffect(row));
        }
        return { replayed: false, receipt: command.receipt ? await receiptOf(tx, command.tenant, command.receipt.actorId, command.receipt.commandId) : null, effects };
      });
    },
    async getReceipt(tenant, actorId, commandId) {
      return receiptOf(db, tenant, actorId, commandId);
    },
    async claimEffect(by, now, until, tenants) {
      if (tenants && !tenants.length) return null;
      const scope = tenants ? ` AND e.tenant IN (${tenants.map(() => "?").join(", ")})` : "";
      // No SKIP LOCKED, so the same SQL runs on both databases: the candidates are read, then
      // each is taken by an UPDATE that repeats the lease check, which only one claimant passes.
      const candidates = await db.all<{ tenant: string; id: string }>(
        `SELECT e.tenant, e.id FROM task_effects e WHERE e.status = 'pending' AND e.due_at <= ? AND (e.lease_until IS NULL OR e.lease_until < ?)${scope}
           AND NOT EXISTS (SELECT 1 FROM task_effects p WHERE p.tenant = e.tenant AND p.task_id = e.task_id AND p.seq < e.seq AND p.status = 'pending')
         ORDER BY e.due_at, e.seq LIMIT 8`,
        [now, now, ...(tenants ?? [])],
      );
      for (const c of candidates) {
        const row = await one<EffectRow>(
          db,
          "UPDATE task_effects SET claimed_by = ?, lease_until = ?, attempts = attempts + 1 WHERE tenant = ? AND id = ? AND status = 'pending' AND (lease_until IS NULL OR lease_until < ?) RETURNING *",
          [by, until, c.tenant, c.id, now],
        );
        if (row) return toEffect(row);
      }
      return null;
    },
    async renewEffect(tenant, id, by, until) {
      return (await db.run("UPDATE task_effects SET lease_until = ? WHERE tenant = ? AND id = ? AND claimed_by = ? AND status = 'pending'", [until, tenant, id, by])) > 0;
    },
    async settleEffect(tenant, id, by, outcome, now) {
      const held = "WHERE tenant = ? AND id = ? AND claimed_by = ? AND status = 'pending'";
      if ("done" in outcome) return (await db.run(`UPDATE task_effects SET status = 'done', result = ?, lease_until = NULL, settled_at = ? ${held}`, [outcome.done, now, tenant, id, by])) > 0;
      if ("failed" in outcome) return (await db.run(`UPDATE task_effects SET status = 'failed', last_error = ?, lease_until = NULL, settled_at = ? ${held}`, [outcome.failed, now, tenant, id, by])) > 0;
      return (await db.run(`UPDATE task_effects SET due_at = ?, last_error = ?, claimed_by = NULL, lease_until = NULL ${held}`, [outcome.retryAt, outcome.error, tenant, id, by])) > 0;
    },
    async taskEffects(tenant, taskId) {
      return (await db.all<EffectRow>("SELECT * FROM task_effects WHERE tenant = ? AND task_id = ? ORDER BY seq", [tenant, taskId])).map(toEffect);
    },
    async recoverEffects(tenant, now) {
      return db.transaction(async (tx) => ({
        cancelled: await tx.run("UPDATE task_effects SET status = 'cancelled', claimed_by = NULL, lease_until = NULL, last_error = 'the process that queued it stopped', settled_at = ? WHERE tenant = ? AND status = 'pending' AND replay = 'process-bound'", [now, tenant]),
        requeued: await tx.run("UPDATE task_effects SET claimed_by = NULL, lease_until = NULL WHERE tenant = ? AND status = 'pending' AND replay = 'replay-safe' AND claimed_by IS NOT NULL", [tenant]),
      }));
    },
    async recordTaskRequest(r) {
      const payload = JSON.stringify(r.payload);
      const secret = detectSecret(payload);
      if (secret) throw new Error(`the ${r.kind} request's payload holds what looks like a ${secret}; a request carries names and references, never a secret`);
      const created = await db.run(
        "INSERT INTO task_requests (tenant, id, task_id, target_position, source_key, kind, payload, status, response_capability, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'live', ?, ?) ON CONFLICT (tenant, task_id, source_key) DO NOTHING",
        [r.tenant, r.id, r.taskId, r.targetPosition, r.sourceKey, r.kind, payload, r.createdAt, r.expiresAt],
      );
      const row = (await one<TaskRequestRow>(db, "SELECT * FROM task_requests WHERE tenant = ? AND task_id = ? AND source_key = ?", [r.tenant, r.taskId, r.sourceKey]))!;
      return { created: created > 0, request: toTaskRequest(row) };
    },
    async answerTaskRequest(tenant, id, answer, by, via, now) {
      const asked = await one<{ kind: string; payload: string }>(db, "SELECT kind, payload FROM task_requests WHERE tenant = ? AND id = ?", [tenant, id]);
      if (!asked) return null;
      const problem = answerProblem({ kind: asked.kind as TaskRequestKind, payload: JSON.parse(asked.payload) as Record<string, unknown> }, answer);
      if (problem) throw new Error(problem.message);
      // One conditional UPDATE: of two browsers answering at once, the second finds it answered.
      const row = await one<TaskRequestRow>(
        db,
        "UPDATE task_requests SET status = 'answered', answer = ?, answered_by = ?, answered_via = ?, answered_at = ? WHERE tenant = ? AND id = ? AND status = 'pending' AND response_capability = 'live' AND (expires_at IS NULL OR expires_at > ?) RETURNING *",
        // A note goes to the agent and stays in the record, so it is masked like a log line first.
        [JSON.stringify("note" in answer && answer.note !== undefined ? { ...answer, note: new Redactor().line(answer.note) } : answer), by, via, now, tenant, id, now],
      );
      return row ? toTaskRequest(row) : null;
    },
    async taskRequests(tenant, taskId) {
      return (await db.all<TaskRequestRow>("SELECT * FROM task_requests WHERE tenant = ? AND task_id = ? ORDER BY created_at, id", [tenant, taskId])).map(toTaskRequest);
    },
    async expireTaskRequests(now) {
      return db.run("UPDATE task_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?", [now]);
    },
    async endTaskRequests(tenant, taskId, now) {
      return db.run("UPDATE task_requests SET status = 'expired', response_capability = 'not_resumable', answered_at = ? WHERE tenant = ? AND task_id = ? AND status = 'pending'", [now, tenant, taskId]);
    },
    async savePairing(p) {
      await db.run("INSERT INTO machine_pairings (tenant, code_hash, user_id, expires_at) VALUES (?, ?, ?, ?)", [p.tenant, p.codeHash, p.userId, p.expiresAt]);
    },
    async takePairing(tenant, codeHash, now) {
      // One conditional UPDATE: of two machines claiming one code at once, the second finds it used.
      const row = await one<{ user_id: string }>(db, "UPDATE machine_pairings SET used_at = ? WHERE tenant = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id", [now, tenant, codeHash, now]);
      return row ? { userId: row.user_id } : null;
    },
    async countOpenPairings(tenant, userId, now) {
      return Number((await one<{ n: number | string }>(db, "SELECT COUNT(*) AS n FROM machine_pairings WHERE tenant = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?", [tenant, userId, now]))?.n ?? 0);
    },
    async insertMachine(m, runners) {
      return db.transaction(async (tx) => {
        // The organization's turn row holds it, so two machines connecting at once are counted one after the other.
        await turn(tx, m.tenant, "machines.turn");
        if (runners !== null && Number((await one<{ n: number | string }>(tx, "SELECT COUNT(*) AS n FROM machines WHERE tenant = ? AND revoked_at IS NULL", [m.tenant]))?.n ?? 0) >= runners) return false;
        await tx.run(
          "INSERT INTO machines (tenant, id, user_id, name, platform, public_key, token_hash, agents, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [m.tenant, m.id, m.userId, m.name, m.platform, m.publicKey, m.tokenHash, JSON.stringify(m.agents), m.createdAt, m.lastSeenAt, m.revokedAt],
        );
        return true;
      });
    },
    async machineByToken(tokenHash) {
      const row = await one<MachineRow>(db, "SELECT * FROM machines WHERE token_hash = ? AND revoked_at IS NULL", [tokenHash]);
      return row ? toMachine(row) : null;
    },
    async listMachines(tenant, userId) {
      const rows = userId === null
        ? await db.all<MachineRow>("SELECT * FROM machines WHERE tenant = ? ORDER BY created_at, id", [tenant])
        : await db.all<MachineRow>("SELECT * FROM machines WHERE tenant = ? AND user_id = ? ORDER BY created_at, id", [tenant, userId]);
      return rows.map(toMachine);
    },
    async revokeMachine(tenant, id, at) {
      return db.transaction(async (tx) => {
        if (!(await tx.run("UPDATE machines SET revoked_at = ? WHERE tenant = ? AND id = ? AND revoked_at IS NULL", [at, tenant, id]))) return false;
        const held = "SELECT id FROM tasks WHERE tenant = ? AND claimed_by = ? AND runner = 'local' AND status = 'running'";
        await tx.run(`UPDATE task_requests SET status = 'expired', response_capability = 'not_resumable', answered_at = ? WHERE tenant = ? AND status = 'pending' AND task_id IN (${held})`, [at, tenant, tenant, id]);
        await tx.run("UPDATE tasks SET status = 'interrupted', stage = NULL, lease_id = NULL, lease_until = NULL, stop_requested_at = NULL, error = ? WHERE tenant = ? AND claimed_by = ? AND runner = 'local' AND status = 'running'", [MACHINE_REVOKED, tenant, id]);
        return true;
      });
    },
    async touchMachine(tenant, id, at, agents, features) {
      await db.run("UPDATE machines SET last_seen_at = ?, agents = COALESCE(?, agents), features = COALESCE(?, features) WHERE tenant = ? AND id = ? AND revoked_at IS NULL", [at, agents ? JSON.stringify(agents) : null, features ? JSON.stringify(features) : null, tenant, id]);
    },
    async takeNonce(tenant, machineId, nonce, until) {
      return (await db.run("INSERT INTO runner_nonces (tenant, machine_id, nonce, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (tenant, machine_id, nonce) DO NOTHING", [tenant, machineId, nonce, until])) > 0;
    },
    async pruneRunnerRows(now) {
      return db.transaction(async (tx) => (await tx.run("DELETE FROM runner_nonces WHERE expires_at <= ?", [now])) + (await tx.run("DELETE FROM machine_pairings WHERE used_at IS NOT NULL OR expires_at <= ?", [now])));
    },
    async claimLocalTask(tenant, person, holder, leaseId, until, now, concurrent = null) {
      // A task on a folder of one of its person's machines is that machine's alone: another of
      // theirs is given their other tasks, never one in a folder it does not have.
      const prefix = `machine:${holder}:`;
      const onThisMachine = "NOT EXISTS (SELECT 1 FROM repos r WHERE r.tenant = tasks.tenant AND r.id = tasks.repo_id AND r.url LIKE 'machine:%' AND substr(r.url, 1, ?) <> ?)";
      // A task whose agent session is kept goes on where that session is: the machine that held it.
      const sessionHere = "(tasks.native_session IS NULL OR tasks.claimed_by IS NULL OR tasks.claimed_by = ?)";
      // A runner asks every second or so; most asks find nothing and write nothing.
      const waiting = await one<{ id: string }>(db, `SELECT id FROM tasks WHERE tenant = ? AND status = 'queued' AND runner = 'local' AND created_by = ? AND ${onThisMachine} AND ${sessionHere} LIMIT 1`, [tenant, person, prefix.length, prefix, holder]);
      if (!waiting) return null;
      return db.transaction(async (tx) => {
        // The organization's turn row holds it, so two claims at once count its running tasks one
        // after the other and the second finds the limit reached.
        if (concurrent !== null) await turn(tx, tenant, "tasks.turn");
        if (concurrent !== null && Number((await one<{ n: number | string }>(tx, "SELECT COUNT(*) AS n FROM tasks WHERE tenant = ? AND status = 'running'", [tenant]))?.n ?? 0) >= concurrent) return null;
        const row = await one<TaskRow>(
          tx,
          `UPDATE tasks SET status = 'running', claimed_by = ?, lease_id = ?, lease_until = ?, stop_requested_at = NULL, stop_reason = NULL, started_at = COALESCE(started_at, ?), run_started_at = ?
           WHERE tenant = ? AND status = 'queued' AND id = (SELECT id FROM tasks WHERE tenant = ? AND status = 'queued' AND runner = 'local' AND created_by = ? AND ${onThisMachine} AND ${sessionHere} ORDER BY created_at, id LIMIT 1)
             AND NOT EXISTS (SELECT 1 FROM machines WHERE tenant = ? AND id = ? AND revoked_at IS NOT NULL) RETURNING *`,
          // A machine disconnected while its poll waited is given nothing: its next call is refused, and a task it took would wait out the lease unstarted.
          [holder, leaseId, until, now, now, tenant, tenant, person, prefix.length, prefix, holder, tenant, holder],
        );
        if (!row) return null;
        const last = await one<{ n: number | string | null }>(tx, "SELECT MAX(source_n) AS n FROM task_log WHERE tenant = ? AND task_id = ?", [tenant, row.id]);
        return { task: (await withTargets(tx, tenant, [toTask(row)]))[0]!, nextEvent: Number(last?.n ?? 0) + 1 };
      });
    },
    async renewLease(tenant, taskId, leaseId, until, now) {
      return (await db.run("UPDATE tasks SET lease_until = ? WHERE tenant = ? AND id = ? AND lease_id = ? AND status = 'running' AND lease_until > ?", [until, tenant, taskId, leaseId, now])) > 0;
    },
    async heldTasks(tenant, holder, now) {
      const rows = await db.all<{ id: string; lease_id: string; stop_requested_at: string | null }>("SELECT id, lease_id, stop_requested_at FROM tasks WHERE tenant = ? AND claimed_by = ? AND status = 'running' AND lease_id IS NOT NULL AND lease_until > ? ORDER BY created_at, id", [tenant, holder, now]);
      return rows.map((r) => ({ taskId: r.id, leaseId: r.lease_id, stopRequested: r.stop_requested_at !== null }));
    },
    async setTaskChanges(tenant, id, changes) {
      await db.run("UPDATE tasks SET result = 'changes', changes = ? WHERE tenant = ? AND id = ?", [JSON.stringify(changes), tenant, id]);
    },
    async taskChangeSnapshots(tenant, id) {
      const row = await one<{ changes: string | null }>(db, "SELECT changes FROM tasks WHERE tenant = ? AND id = ?", [tenant, id]);
      if (!row?.changes) return null;
      const { before, after } = JSON.parse(row.changes) as { before: string; after: string };
      return { before, after };
    },
    async markTaskChangesUndone(tenant, id, undone) {
      return settleTaskChanges(db, tenant, id, { undone });
    },
    async noteUsedSkill(tenant, id, name) {
      await db.transaction(async (tx) => {
        // The row is locked first: two calls close together would otherwise both read the same list and the second write would drop the first name.
        await tx.run("UPDATE tasks SET id = id WHERE tenant = ? AND id = ?", [tenant, id]);
        const row = await one<{ used_skills: string | null }>(tx, "SELECT used_skills FROM tasks WHERE tenant = ? AND id = ?", [tenant, id]);
        const held = row?.used_skills ? (JSON.parse(row.used_skills) as string[]) : [];
        if (!row || held.includes(name) || held.length >= USED_SKILLS_MAX) return;
        await tx.run("UPDATE tasks SET used_skills = ? WHERE tenant = ? AND id = ?", [JSON.stringify([...held, name]), tenant, id]);
      });
    },
    async noteTaskContext(tenant, id, tokens) {
      await db.run("UPDATE tasks SET context_tokens = ? WHERE tenant = ? AND id = ? AND context_tokens IS NULL", [tokens, tenant, id]);
    },
    async markTaskFilesUndone(tenant, id, paths, undone) {
      return db.transaction(async (tx) => {
        const row = await one<{ changes: string | null }>(tx, "UPDATE tasks SET id = id WHERE tenant = ? AND id = ? RETURNING changes", [tenant, id]);
        const changes = row?.changes ? (JSON.parse(row.changes) as TaskChanges & { before: string; after: string }) : null;
        if (!changes || changes.undone || changes.kept) return false;
        const files = changes.files.map((file) => (paths.includes(file.path) ? { ...file, state: "undone" as const } : file));
        const settled = files.every((file) => file.state === "undone") ? { undone } : {};
        await tx.run("UPDATE tasks SET changes = ? WHERE tenant = ? AND id = ?", [JSON.stringify({ ...changes, files, ...settled }), tenant, id]);
        return true;
      });
    },
    async markTaskChangesKept(tenant, id, kept) {
      return settleTaskChanges(db, tenant, id, { kept });
    },
    async addTaskShare(share) {
      return (await db.run("INSERT INTO task_shares (tenant, task_id, user_id, shared_by, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant, task_id, user_id) DO NOTHING", [share.tenant, share.taskId, share.userId, share.sharedBy, share.at])) > 0;
    },
    async removeTaskShare(tenant, taskId, userId) {
      return (await db.run("DELETE FROM task_shares WHERE tenant = ? AND task_id = ? AND user_id = ?", [tenant, taskId, userId])) > 0;
    },
    async listTaskShares(tenant, taskId) {
      return db.all<TaskShare>('SELECT tenant, task_id AS "taskId", user_id AS "userId", shared_by AS "sharedBy", at FROM task_shares WHERE tenant = ? AND task_id = ? ORDER BY at, user_id', [tenant, taskId]);
    },
    async takeProjectLock(tenant, projectId, taskId, at) {
      // The task that holds it takes it again, as an interrupted one that keeps its folder does when it goes on.
      return (await db.run("INSERT INTO project_locks (tenant, project_id, task_id, taken_at) VALUES (?, ?, ?, ?) ON CONFLICT (tenant, project_id) DO UPDATE SET taken_at = excluded.taken_at WHERE project_locks.task_id = excluded.task_id", [tenant, projectId, taskId, at])) > 0;
    },
    async releaseProjectLock(tenant, projectId, taskId) {
      await db.run("DELETE FROM project_locks WHERE tenant = ? AND project_id = ? AND task_id = ?", [tenant, projectId, taskId]);
    },
    async releaseStaleProjectLocks(tenant) {
      return db.run("DELETE FROM project_locks WHERE tenant = ? AND task_id NOT IN (SELECT id FROM tasks WHERE tenant = ? AND status IN ('queued', 'running', 'interrupted'))", [tenant, tenant]);
    },
    async cancelLocalTask(tenant, taskId, at) {
      return db.transaction(async (tx) => {
        // Conditional on no lease, so a cancel and a machine's claim of the same task never both win.
        const cancelled = await tx.run("UPDATE tasks SET status = 'cancelled', stage = NULL, finished_at = ? WHERE tenant = ? AND id = ? AND runner = 'local' AND status IN ('queued', 'interrupted') AND lease_id IS NULL", [at, tenant, taskId]);
        if (cancelled) await tx.run("UPDATE task_requests SET status = 'expired', response_capability = 'not_resumable', answered_at = ? WHERE tenant = ? AND task_id = ? AND status = 'pending'", [at, tenant, taskId]);
        return cancelled > 0;
      });
    },
    async continueLocalTask(tenant, taskId, receipt, at) {
      return db.transaction(async (tx) => {
        // Conditional on no lease, as a cancel is; the receipt is written only with the change it answers.
        // Its person going on lets go of a usage limit's reset it waited for: the run they asked for is the one that goes on.
        const queued = await tx.run("UPDATE tasks SET status = 'queued', stage = NULL, error = NULL, limit_reset_at = NULL, limit_at = NULL WHERE tenant = ? AND id = ? AND runner = 'local' AND status = 'interrupted' AND lease_id IS NULL", [tenant, taskId]);
        if (queued && receipt) {
          await tx.run(
            "INSERT INTO command_receipts (tenant, actor_id, command_id, kind, task_id, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant, actor_id, command_id) DO NOTHING",
            [tenant, receipt.actorId, receipt.commandId, receipt.kind, taskId, receipt.result, at],
          );
        }
        return queued > 0;
      });
    },
    async limitedTasks(tenant, before) {
      const rows = await db.all<{ id: string; limit_reset_at: string; limit_at: string | null; auto_continues: number | string | null }>(
        "SELECT id, limit_reset_at, limit_at, auto_continues FROM tasks WHERE tenant = ? AND runner = 'local' AND status = 'interrupted' AND lease_id IS NULL AND limit_reset_at IS NOT NULL AND limit_reset_at <= ? ORDER BY limit_reset_at, id",
        [tenant, before],
      );
      return rows.map((r) => ({ taskId: r.id, resetAt: r.limit_reset_at, limitAt: r.limit_at, goneOn: Number(r.auto_continues ?? 0) }));
    },
    async dropLimit(tenant, taskId, resetAt) {
      return (await db.run("UPDATE tasks SET limit_reset_at = NULL, limit_at = NULL WHERE tenant = ? AND id = ? AND limit_reset_at = ?", [tenant, taskId, resetAt])) > 0;
    },
    async continueAfterLimit(tenant, taskId, resetAt) {
      // One write, conditional on the reset it waited for: of two orchestrators sweeping one database, one puts it back.
      return (
        (await db.run(
          "UPDATE tasks SET status = 'queued', stage = NULL, error = NULL, limit_reset_at = NULL, limit_at = NULL, auto_continues = COALESCE(auto_continues, 0) + 1, limit_goes_on = 1 WHERE tenant = ? AND id = ? AND runner = 'local' AND status = 'interrupted' AND lease_id IS NULL AND limit_reset_at = ?",
          [tenant, taskId, resetAt],
        )) > 0
      );
    },
    async takeLimitContinue(tenant, taskId) {
      return (await db.run("UPDATE tasks SET limit_goes_on = 0 WHERE tenant = ? AND id = ? AND limit_goes_on = 1", [tenant, taskId])) > 0;
    },
    async requestStop(tenant, taskId, at, reason = null) {
      // Kept on the task rather than in one process, so the runner hears it from whichever
      // instance it polls, and after a restart of the orchestrator as before it.
      return (await db.run("UPDATE tasks SET stop_requested_at = COALESCE(stop_requested_at, ?), stop_reason = COALESCE(stop_reason, ?) WHERE tenant = ? AND id = ? AND status = 'running' AND lease_id IS NOT NULL", [at, reason, tenant, taskId])) > 0;
    },
    async updateLeasedTask(tenant, taskId, leaseId, patch) {
      const columns = taskColumns({ stage: patch.stage, baseSha: patch.baseSha, tests: patch.tests });
      if (patch.branch !== undefined) columns.branch = patch.branch;
      if (patch.nativeSession !== undefined) columns.native_session = patch.nativeSession;
      if (patch.turnEstimate !== undefined) columns.turn_estimate_usd = patch.turnEstimate;
      // A turn's own cost replaces the estimate of it.
      else if (patch.addCost) columns.turn_estimate_usd = null;
      const set = Object.keys(columns).map((n) => `${n} = ?`);
      const values: SqlValue[] = Object.values(columns);
      // A part the agent did not report stays as it was; the first one it reports starts the sum.
      if (patch.addCost) {
        for (const [column, part] of [["cost_usd", patch.addCost.usd], ["input_tokens", patch.addCost.inputTokens], ["output_tokens", patch.addCost.outputTokens]] as const) {
          if (part === null) continue;
          set.push(`${column} = COALESCE(${column}, 0) + ?`);
          values.push(part);
        }
      }
      return written(tenant, taskId, db.run(`UPDATE tasks SET ${set.length ? set.join(", ") : "id = id"} WHERE tenant = ? AND id = ? AND lease_id = ? AND status = 'running'`, [...values, tenant, taskId, leaseId])).then((n) => n > 0);
    },
    async finishLeasedTask(tenant, taskId, leaseId, end, now) {
      return written(tenant, taskId, db.transaction(async (tx) => {
        // An interrupted task is not finished: it keeps its machine and session for Continue. One that ended keeps no
        // session, as its machine kept no checkout for it: a follow-up starts a session of its own from the request.
        // A run its person asked to stop ends cancelled, whatever its runner calls the end: it is no cut-off run for a
        // restart to put back in line. Each expression reads the row as it was, stop_requested_at included.
        const interrupted = end.status === "interrupted";
        const cutOff = "? = 'interrupted' AND stop_requested_at IS NULL";
        // A run that ends for review keeps the stage "request" until what follows its end (its request opened, its
        // change kept) is done, so a page that reads it finished does not stop following it before then.
        // A run cut off at its plan's usage limit waits for the reset, from now; any other end waits for none.
        const limit = interrupted ? (end.limitResetAt ?? null) : null;
        // A run cut off before its turn reported keeps the agent's estimate of that turn as part of its cost; one that ended
        // for review on its own had the turn's cost reported, so an estimate left over from it adds nothing.
        await tx.run(
          "UPDATE tasks SET cost_usd = COALESCE(cost_usd, 0) + turn_estimate_usd WHERE tenant = ? AND id = ? AND lease_id = ? AND status = 'running' AND turn_estimate_usd > 0 AND (stop_requested_at IS NOT NULL OR ? <> 'needs-review')",
          [tenant, taskId, leaseId, end.status],
        );
        const ended = await tx.run(
          `UPDATE tasks SET status = CASE WHEN ? = 'interrupted' AND stop_requested_at IS NOT NULL THEN 'cancelled' ELSE ? END, error = CASE WHEN stop_requested_at IS NOT NULL AND stop_reason IS NOT NULL THEN stop_reason ELSE ? END, stop_reason = NULL, native_session = CASE WHEN ${cutOff} THEN COALESCE(?, native_session) ELSE NULL END, branch = COALESCE(?, branch), stage = CASE WHEN ? = 'needs-review' THEN 'request' ELSE NULL END, finished_at = CASE WHEN ${cutOff} THEN NULL ELSE ? END, lease_id = NULL, lease_until = NULL, stop_requested_at = NULL, turn_estimate_usd = NULL, ran_ms = COALESCE(ran_ms, 0) + ?, limit_reset_at = CASE WHEN ${cutOff} THEN ? ELSE NULL END, limit_at = CASE WHEN ${cutOff} THEN ? ELSE NULL END WHERE tenant = ? AND id = ? AND lease_id = ? AND status = 'running'`,
          [end.status, end.status, end.error, end.status, interrupted ? end.nativeSession : null, end.branch, end.status, end.status, now, Math.round(end.ranMs ?? 0), end.status, limit, end.status, limit ? now : null, tenant, taskId, leaseId],
        );
        // The agent that asked has stopped with the run, so nobody is left to hear an answer.
        if (ended) await tx.run("UPDATE task_requests SET status = 'expired', response_capability = 'not_resumable', answered_at = ? WHERE tenant = ? AND task_id = ? AND status = 'pending'", [now, tenant, taskId]);
        return ended > 0;
      }));
    },
    async expireLeases(now) {
      // The machine and the session stay on an interrupted task: Continue resumes it there. Its
      // pending questions end with the lease, which is what a question without a deadline waits on.
      return db.transaction(async (tx) => {
        await tx.run("UPDATE task_requests SET status = 'expired', response_capability = 'not_resumable', answered_at = ? WHERE status = 'pending' AND (tenant, task_id) IN (SELECT tenant, id FROM tasks WHERE status = 'running' AND lease_until < ?)", [now, now]);
        return {
          interrupted: await tx.run("UPDATE tasks SET status = 'interrupted', stage = NULL, lease_id = NULL, lease_until = NULL, stop_requested_at = NULL, error = ? WHERE runner = 'local' AND status = 'running' AND lease_until < ?", [MACHINE_SILENT, now]),
          failed: await tx.run("UPDATE tasks SET status = 'failed', stage = NULL, lease_id = NULL, lease_until = NULL, stop_requested_at = NULL, error = ?, finished_at = ? WHERE runner = 'server' AND status = 'running' AND lease_until < ?", [RUNNER_SILENT, now, now]),
        };
      });
    },
    async taskLease(tenant, taskId) {
      const row = await one<{ runner: string; claimed_by: string | null; lease_id: string | null; lease_until: string | null; native_session: string | null; branch: string | null; run_started_at: string | null }>(
        db,
        "SELECT runner, claimed_by, lease_id, lease_until, native_session, branch, run_started_at FROM tasks WHERE tenant = ? AND id = ?",
        [tenant, taskId],
      );
      return row ? { runner: row.runner as TaskLease["runner"], claimedBy: row.claimed_by, leaseId: row.lease_id, leaseUntil: row.lease_until, nativeSession: row.native_session, branch: row.branch, runStartedAt: row.run_started_at } : null;
    },
    async appendRunnerEvents(tenant, taskId, leaseId, events) {
      return written(tenant, taskId, db.transaction(async (tx) => {
        // The lease check and the row lock in one write: a runner whose lease is gone writes
        // nothing, and two batches for one task read and number their lines one after the other.
        if (!(await tx.run("UPDATE tasks SET id = id WHERE tenant = ? AND id = ? AND lease_id = ? AND status = 'running'", [tenant, taskId, leaseId]))) return false;
        const batch = [...new Map(events.map((e) => [e.n, e])).values()];
        const kept = new Set<number>();
        for (let from = 0; from < batch.length; from += 500) {
          const slice = batch.slice(from, from + 500).map((e) => e.n);
          const rows = await tx.all<{ source_n: number | string }>(`SELECT source_n FROM task_log WHERE tenant = ? AND task_id = ? AND source_n IN (${slice.map(() => "?").join(", ")})`, [tenant, taskId, ...slice]);
          for (const r of rows) kept.add(Number(r.source_n));
        }
        const fresh = batch.filter((e) => !kept.has(e.n));
        if (!fresh.length) return true;
        const row = await one<{ log_seq: number | string }>(tx, "UPDATE tasks SET log_seq = log_seq + ? WHERE tenant = ? AND id = ? RETURNING log_seq", [fresh.length, tenant, taskId]);
        const last = Number(row!.log_seq) - fresh.length;
        const at = new Date().toISOString();
        // The machine is not trusted to have redacted: every line passes the orchestrator's own
        // redaction, and an event that holds what looks like a secret is withheld, never stored.
        const redactor = new Redactor();
        for (const [i, e] of fresh.entries()) {
          const data = JSON.stringify(e.data);
          const secret = detectSecret(data);
          const text = secret ? `[redacted:${secret}] the event was withheld` : redactor.line(e.text);
          await tx.run("INSERT INTO task_log (tenant, task_id, seq, at, text, kind, data, source_n) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [tenant, taskId, last + i + 1, at, text, e.kind, secret ? null : data, e.n]);
        }
        return true;
      }));
    },
    async addFollowUp(f) {
      const quotes = f.quotes ? JSON.stringify(f.quotes) : null;
      // A persistence boundary: the text is masked before it gets here, and one that still looks like a secret is refused.
      const secret = detectSecret(f.text) ?? (quotes ? detectSecret(quotes) : null);
      if (secret) throw new Error(`the follow-up holds what looks like a ${secret}; it is kept masked, never with a secret`);
      const created = await db.run(
        "INSERT INTO task_followups (tenant, id, task_id, source, key, text, quotes, status, created_at, delivered_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT (tenant, task_id, key) DO NOTHING",
        [f.tenant, f.id, f.taskId, f.source, f.key, f.text, quotes, f.source === "reviewer" ? "proposed" : "pending", f.createdAt, f.createdBy],
      );
      const row = (await one<FollowUpRow>(db, "SELECT * FROM task_followups WHERE tenant = ? AND task_id = ? AND key = ?", [f.tenant, f.taskId, f.key]))!;
      return { created: created > 0, followUp: toFollowUp(row) };
    },
    async pendingFollowUps(tenant, taskId) {
      return (await db.all<FollowUpRow>("SELECT * FROM task_followups WHERE tenant = ? AND task_id = ? AND status = 'pending' ORDER BY created_at, id", [tenant, taskId])).map(toFollowUp);
    },
    async taskFollowUps(tenant, taskId) {
      return (await db.all<FollowUpRow>("SELECT * FROM task_followups WHERE tenant = ? AND task_id = ? ORDER BY created_at, id", [tenant, taskId])).map(toFollowUp);
    },
    async editFollowUp(tenant, taskId, id, text, quotes) {
      const kept = quotes ? JSON.stringify(quotes) : null;
      const secret = detectSecret(text) ?? (kept ? detectSecret(kept) : null);
      if (secret) throw new Error(`the follow-up holds what looks like a ${secret}; it is kept masked, never with a secret`);
      // Quotes left out stay as they were: a change of the words alone keeps what they point at.
      const [set, values] = quotes === undefined ? ["text = ?", [text]] : ["text = ?, quotes = ?", [text, kept]];
      return (await db.run(`UPDATE task_followups SET ${set} WHERE tenant = ? AND task_id = ? AND id = ? AND source = 'person' AND status = 'pending'`, [...values, tenant, taskId, id])) === 1;
    },
    async dropFollowUp(tenant, taskId, id) {
      return (await db.run("UPDATE task_followups SET status = 'dismissed' WHERE tenant = ? AND task_id = ? AND id = ? AND source = 'person' AND status = 'pending'", [tenant, taskId, id])) === 1;
    },
    async markFollowUpsDelivered(tenant, ids, at) {
      if (!ids.length) return 0;
      return db.run(`UPDATE task_followups SET status = 'delivered', delivered_at = ? WHERE tenant = ? AND status = 'pending' AND id IN (${ids.map(() => "?").join(", ")})`, [at, tenant, ...ids]);
    },
    async closeFollowUps(tenant, taskId, at) {
      return db.run("UPDATE task_followups SET status = 'closed', delivered_at = ? WHERE tenant = ? AND task_id = ? AND status = 'pending'", [at, tenant, taskId]);
    },
    async deliveredFollowUpCounts(tenant, taskIds, sources) {
      const counts = new Map<string, number>();
      if (!sources.length) return counts;
      // In parts, so a long window stays under the bound-parameter limit of either database.
      for (let i = 0; i < taskIds.length; i += 500) {
        const part = taskIds.slice(i, i + 500);
        const rows = await db.all<{ task_id: string; n: number | string }>(
          `SELECT task_id, COUNT(*) AS n FROM task_followups WHERE tenant = ? AND status = 'delivered' AND source IN (${sources.map(() => "?").join(", ")}) AND task_id IN (${part.map(() => "?").join(", ")}) GROUP BY task_id`,
          [tenant, ...sources, ...part],
        );
        for (const row of rows) counts.set(row.task_id, Number(row.n));
      }
      return counts;
    },
    async answerFollowUp(tenant, taskId, id, to) {
      return (await db.run("UPDATE task_followups SET status = ? WHERE tenant = ? AND task_id = ? AND id = ? AND status = 'proposed'", [to, tenant, taskId, id])) === 1;
    },
    async reviewerFollowUps(tenant, taskIds) {
      const rows: FollowUpRow[] = [];
      for (let i = 0; i < taskIds.length; i += 500) {
        const part = taskIds.slice(i, i + 500);
        rows.push(...(await db.all<FollowUpRow>(`SELECT * FROM task_followups WHERE tenant = ? AND source = 'reviewer' AND task_id IN (${part.map(() => "?").join(", ")}) ORDER BY created_at, id`, [tenant, ...part])));
      }
      return rows.map(toFollowUp);
    },
    async waitingSuggestionTasks(tenant, taskIds) {
      const waiting = new Set<string>();
      for (let i = 0; i < taskIds.length; i += 500) {
        const part = taskIds.slice(i, i + 500);
        const rows = await db.all<{ task_id: string }>(
          `SELECT DISTINCT f.task_id FROM task_followups f JOIN tasks t ON t.tenant = f.tenant AND t.id = f.task_id JOIN requests r ON r.tenant = t.tenant AND r.repo_id = t.repo_id AND r.number = t.request_number WHERE f.tenant = ? AND (f.status = 'proposed' OR (f.status = 'pending' AND f.source = 'watch')) AND r.status = 'open' AND f.task_id IN (${part.map(() => "?").join(", ")})`,
          [tenant, ...part],
        );
        for (const row of rows) waiting.add(row.task_id);
      }
      return waiting;
    },
    async withdrawTaskRequest(tenant, taskId, sourceKey, now) {
      const row = await one<TaskRequestRow>(
        db,
        "UPDATE task_requests SET status = 'withdrawn', response_capability = 'not_resumable', answered_at = ? WHERE tenant = ? AND task_id = ? AND source_key = ? AND status = 'pending' RETURNING *",
        [now, tenant, taskId, sourceKey],
      );
      return row ? toTaskRequest(row) : null;
    },
    async insertAttachment(a, limits) {
      return db.transaction(async (tx) => {
        // The organization's turn row holds it, so two uploads at once are counted one after the other.
        await tx.run("INSERT INTO settings (tenant, key, value) VALUES (?, 'attachments.turn', '') ON CONFLICT (tenant, key) DO UPDATE SET value = excluded.value", [a.tenant]);
        const onTask = Number((await one<{ n: number | string }>(tx, "SELECT COUNT(*) AS n FROM task_attachments WHERE tenant = ? AND task_id = ?", [a.tenant, a.taskId]))?.n ?? 0);
        if (onTask >= limits.perTask) return "task-full" as const;
        const held = Number((await one<{ n: number | string | null }>(tx, "SELECT SUM(size) AS n FROM task_attachments WHERE tenant = ?", [a.tenant]))?.n ?? 0);
        if (held + a.size > limits.tenantBytes) return "tenant-full" as const;
        await tx.run("INSERT INTO task_attachments (tenant, id, task_id, name, mime, size, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [a.tenant, a.id, a.taskId, a.name, a.mime, a.size, a.sha256, a.createdBy, a.createdAt]);
        return "kept" as const;
      });
    },
    async getAttachment(tenant, id) {
      const row = await one<AttachmentRow>(db, "SELECT * FROM task_attachments WHERE tenant = ? AND id = ?", [tenant, id]);
      return row ? toAttachment(row) : null;
    },
    async taskAttachments(tenant, taskId) {
      return (await db.all<AttachmentRow>("SELECT * FROM task_attachments WHERE tenant = ? AND task_id = ? ORDER BY created_at, id", [tenant, taskId])).map(toAttachment);
    },
    async deleteAttachment(tenant, id) {
      return (await db.run("DELETE FROM task_attachments WHERE tenant = ? AND id = ?", [tenant, id])) > 0;
    },
    async attachmentsBefore(tenant, before) {
      return (await db.all<AttachmentRow>("SELECT * FROM task_attachments WHERE tenant = ? AND created_at < ? ORDER BY created_at, id", [tenant, before])).map(toAttachment);
    },
    async recordIdentityEvent(e) {
      await db.run("INSERT INTO identity_events (id, identity_id, at, kind, provider, email_domain, org) VALUES (?, ?, ?, ?, ?, ?, ?)", [e.id, e.identityId, e.at, e.kind, e.provider, e.emailDomain.toLowerCase(), e.org]);
    },
    async identityEventsSince(since) {
      return db.all<IdentityEvent>(
        'SELECT id, identity_id AS "identityId", at, kind, provider, email_domain AS "emailDomain", org FROM identity_events WHERE at >= ? ORDER BY at, id',
        [since],
      );
    },
    async pruneIdentityEvents(before) {
      return db.run("DELETE FROM identity_events WHERE at < ?", [before]);
    },
    async pruneEffects(before, limit) {
      return db.run(
        "DELETE FROM task_effects WHERE (tenant, id) IN (SELECT tenant, id FROM task_effects WHERE status IN ('done', 'cancelled') AND settled_at < ? ORDER BY settled_at, id LIMIT ?)",
        [before, limit],
      );
    },
    async setTaskTargets(tenant, taskId, targets) {
      await db.transaction(async (tx) => {
        await tx.run("DELETE FROM task_targets WHERE tenant = ? AND task_id = ?", [tenant, taskId]);
        for (const [position, t] of targets.entries()) {
          await tx.run(
            `INSERT INTO task_targets (tenant, task_id, position, repo_id, status, reason, path, head, origin, target_branch, description, forge_request, base_sha, branch, tests, request_number, error, cost_usd, input_tokens, output_tokens)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [tenant, taskId, position, t.repoId, t.status, t.reason, t.path ?? null, t.head ?? null, t.origin ?? null, t.targetBranch ?? null, t.description ? JSON.stringify(t.description) : null, t.forgeRequest ? JSON.stringify(t.forgeRequest) : null, t.baseSha, t.branch, t.tests, t.requestNumber, t.error, t.cost.usd, t.cost.inputTokens, t.cost.outputTokens],
          );
        }
      });
    },
    async updateTaskTarget(tenant, taskId, position, patch) {
      const columns = targetColumns(patch);
      const names = Object.keys(columns);
      if (!names.length) return;
      await db.run(`UPDATE task_targets SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE tenant = ? AND task_id = ? AND position = ?`, [...Object.values(columns), tenant, taskId, position]);
    },
    async taskPage(tenant, filter, after, limit) {
      const { sql, params } = taskWhere(tenant, filter);
      const later = after ? " AND (created_at < ? OR (created_at = ? AND id > ?))" : "";
      const rows = await db.all<TaskRow>(`SELECT * FROM tasks WHERE ${sql}${later} ORDER BY created_at DESC, id LIMIT ?`, [...params, ...(after ? [after.createdAt, after.createdAt, after.id] : []), limit + 1]);
      const tasks = await withTargets(db, tenant, rows.slice(0, limit).map(toTask));
      const last = tasks.at(-1);
      return { tasks, next: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null };
    },
    async taskSpendRows(tenant, filter) {
      const { sql, params } = taskWhere(tenant, filter);
      const rows = await db.all<{ repo_id: string; team: string; created_by: string; usd: number | string | null; n: number | string; unknown: number | string | null; largest: number | string | null }>(
        `SELECT repo_id, team, created_by, SUM(cost_usd) AS usd, COUNT(*) AS n, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown, MAX(cost_usd) AS largest FROM tasks WHERE ${sql} GROUP BY repo_id, team, created_by ORDER BY repo_id, team, created_by`,
        params,
      );
      return rows.map((r) => ({ repoId: r.repo_id, team: r.team, createdBy: r.created_by, usd: Number(r.usd ?? 0), tasks: Number(r.n), unknownCost: Number(r.unknown ?? 0), largestUsd: Number(r.largest ?? 0) }));
    },
    async recordExtraSpend(e) {
      await db.run(
        "INSERT INTO task_extra_spend (tenant, id, created_by, repo_id, team, at, kind, usd, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant, id) DO NOTHING",
        [e.tenant, e.id, e.createdBy, e.repoId, e.team, e.at, e.kind, e.usd, e.inputTokens, e.outputTokens],
      );
    },
    async taskChildren(tenant, parentId) {
      const rows = await db.all<TaskRow>("SELECT * FROM tasks WHERE tenant = ? AND parent_id = ? ORDER BY created_at, id", [tenant, parentId]);
      return withTargets(db, tenant, rows.map(toTask));
    },
    async taskDescendants(tenant, taskId) {
      // One query on both databases: the tree is walked down from the task, never up to its parent or across to a sibling.
      const rows = await db.all<TaskRow>(
        `WITH RECURSIVE below (id) AS (
           SELECT id FROM tasks WHERE tenant = ? AND parent_id = ?
           UNION SELECT t.id FROM tasks t JOIN below b ON t.parent_id = b.id WHERE t.tenant = ?
         )
         SELECT * FROM tasks WHERE tenant = ? AND id IN (SELECT id FROM below) ORDER BY created_at, id`,
        [tenant, taskId, tenant, tenant],
      );
      return withTargets(db, tenant, rows.map(toTask));
    },
    async extraSpendRows(tenant, filter) {
      const where = ["tenant = ?"];
      const params: SqlValue[] = [tenant];
      if (filter.since !== undefined) {
        where.push("at >= ?");
        params.push(filter.since);
      }
      if (filter.createdBy) {
        if (!filter.createdBy.length) return [];
        where.push(`created_by IN (${filter.createdBy.map(() => "?").join(", ")})`);
        params.push(...filter.createdBy);
      }
      const rows = await db.all<{ repo_id: string; team: string; created_by: string; usd: number | string | null; unknown: number | string | null; largest: number | string | null }>(
        `SELECT repo_id, team, created_by, SUM(usd) AS usd, SUM(CASE WHEN usd IS NULL THEN 1 ELSE 0 END) AS unknown, MAX(usd) AS largest FROM task_extra_spend WHERE ${where.join(" AND ")} GROUP BY repo_id, team, created_by ORDER BY repo_id, team, created_by`,
        params,
      );
      return rows.map((r) => ({ repoId: r.repo_id, team: r.team, createdBy: r.created_by, usd: Number(r.usd ?? 0), tasks: 0, unknownCost: Number(r.unknown ?? 0), largestUsd: Number(r.largest ?? 0) }));
    },
    async listTasks(tenant, repoId) {
      const rows = repoId
        ? await db.all<TaskRow>("SELECT * FROM tasks WHERE tenant = ? AND repo_id = ? ORDER BY created_at DESC, id", [tenant, repoId])
        : await db.all<TaskRow>("SELECT * FROM tasks WHERE tenant = ? ORDER BY created_at DESC, id", [tenant]);
      return withTargets(db, tenant, rows.map(toTask));
    },
    async updateTask(tenant, id, patch) {
      const columns = taskColumns(patch);
      const names = Object.keys(columns);
      if (!names.length) return;
      await db.run(`UPDATE tasks SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE tenant = ? AND id = ?`, [...Object.values(columns), tenant, id]);
      taskWritten(tenant, id);
    },
    async appendTaskLog(tenant, id, lines) {
      if (!lines.length) return;
      const at = new Date().toISOString();
      // The numbers come from a counter on the task's row: the UPDATE locks that row until the
      // transaction ends, so a second writer waits and takes the numbers after the first's.
      // MAX(seq) + 1 read inside the transaction does not: two writers read the same maximum.
      await db.transaction(async (tx) => {
        const row = await one<{ log_seq: number | string }>(tx, "UPDATE tasks SET log_seq = log_seq + ? WHERE tenant = ? AND id = ? RETURNING log_seq", [lines.length, tenant, id]);
        if (!row) throw new Error(`unknown task ${id}`);
        const last = Number(row.log_seq) - lines.length;
        for (const [i, line] of lines.entries()) {
          if (typeof line === "string") {
            await tx.run("INSERT INTO task_log (tenant, task_id, seq, at, text) VALUES (?, ?, ?, ?, ?)", [tenant, id, last + i + 1, at, line]);
            continue;
          }
          // An event is held to the rule a machine's are (appendRunnerEvents): one that holds what looks like a secret is withheld.
          const data = JSON.stringify(line.data);
          const secret = detectSecret(data);
          await tx.run("INSERT INTO task_log (tenant, task_id, seq, at, text, kind, data) VALUES (?, ?, ?, ?, ?, ?, ?)", [tenant, id, last + i + 1, at, secret ? `[redacted:${secret}] the event was withheld` : line.text, line.kind, secret ? null : data]);
        }
      });
      taskWritten(tenant, id);
    },
    async taskLog(tenant, id, afterSeq) {
      const rows = await db.all<{ seq: number | string; at: string; text: string; kind: string; data: string | null }>("SELECT seq, at, text, kind, data FROM task_log WHERE tenant = ? AND task_id = ? AND seq > ? ORDER BY seq", [tenant, id, afterSeq]);
      return rows.map((r) => ({
        seq: Number(r.seq),
        at: r.at,
        text: r.text,
        ...(r.kind !== "log" ? { kind: r.kind as NonNullable<TaskLogLine["kind"]> } : {}),
        ...(r.data ? { data: JSON.parse(r.data) as Record<string, unknown> } : {}),
      }));
    },
    async setTaskProcess(tenant, id, pgid) {
      await db.run("UPDATE tasks SET pgid = ? WHERE tenant = ? AND id = ?", [pgid, tenant, id]);
    },
    async setTaskBranch(tenant, id, branch) {
      await db.run("UPDATE tasks SET branch = ? WHERE tenant = ? AND id = ?", [branch, tenant, id]);
    },
    async unfinishedTasks(tenant, runner) {
      const which = runner ? " AND t.runner = ?" : "";
      const rows = await db.all<{ id: string; repo_id: string; pgid: number | string | null; branch: string | null }>(
        `SELECT t.id, t.repo_id, t.pgid, t.branch FROM tasks t WHERE t.tenant = ? AND t.status IN ('queued', 'running')${which}`,
        [tenant, ...(runner ? [runner] : [])],
      );
      const targets = await db.all<{ task_id: string; repo_id: string; branch: string | null }>(
        `SELECT g.task_id, g.repo_id, g.branch FROM task_targets g JOIN tasks t ON t.tenant = g.tenant AND t.id = g.task_id WHERE g.tenant = ? AND t.status IN ('queued', 'running')${which} ORDER BY g.task_id, g.position`,
        [tenant, ...(runner ? [runner] : [])],
      );
      return rows.map((r) => ({
        id: r.id,
        repoId: r.repo_id,
        pgid: r.pgid === null ? null : Number(r.pgid),
        branch: r.branch,
        targets: targets.filter((g) => g.task_id === r.id).map((g) => ({ repoId: g.repo_id, branch: g.branch })),
      }));
    },
    async interruptTasks(tenant, reason) {
      // A task on a person's machine runs there through a restart here; its lease decides its end.
      return db.run("UPDATE tasks SET status = 'failed', error = ?, finished_at = ? WHERE tenant = ? AND status IN ('queued', 'running') AND runner = 'server'", [
        reason,
        new Date().toISOString(),
        tenant,
      ]);
    },
    async listPolicies(tenant) {
      return db.all<PolicyRecord>(
        'SELECT tenant, id, name, audience, rules, updated_at AS "updatedAt", updated_by AS "updatedBy" FROM policies WHERE tenant = ? ORDER BY name, id',
        [tenant],
      );
    },
    async putPolicy(p) {
      await db.run(
        "INSERT INTO policies (tenant, id, name, audience, rules, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant, id) DO UPDATE SET name = excluded.name, audience = excluded.audience, rules = excluded.rules, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
        [p.tenant, p.id, p.name, p.audience, p.rules, p.updatedAt, p.updatedBy],
      );
    },
    async deletePolicy(tenant, id) {
      return (await db.run("DELETE FROM policies WHERE tenant = ? AND id = ?", [tenant, id])) > 0;
    },
    async setUserEmail(tenant, id, email) {
      await db.run("UPDATE users SET email = ? WHERE tenant = ? AND id = ?", [email, tenant, id]);
    },
    async dropOauthGrants(tenant, userId) {
      await db.transaction((tx) => dropGrants(tx, tenant, userId));
    },
    async listSettings(tenant, prefix) {
      return db.all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE tenant = ? AND substr(key, 1, ?) = ? ORDER BY key", [tenant, prefix.length, prefix]);
    },
    async tenantsWithSetting(key) {
      return (await db.all<{ tenant: string }>("SELECT tenant FROM settings WHERE key = ? ORDER BY tenant", [key])).map((r) => r.tenant);
    },
    async getSetting(tenant, key) {
      return (await one<{ value: string }>(db, "SELECT value FROM settings WHERE tenant = ? AND key = ?", [tenant, key]))?.value ?? null;
    },
    async setSetting(tenant, key, value) {
      await db.run("INSERT INTO settings (tenant, key, value) VALUES (?, ?, ?) ON CONFLICT (tenant, key) DO UPDATE SET value = excluded.value", [tenant, key, value]);
    },
    async deleteSetting(tenant, key) {
      await db.run("DELETE FROM settings WHERE tenant = ? AND key = ?", [tenant, key]);
    },
    async claimLease(tenant, key, holder, until, now) {
      // The value starts with the lease's end as an ISO time, so comparing values compares ends.
      const taken = await db.run(
        "INSERT INTO settings (tenant, key, value) VALUES (?, ?, ?) ON CONFLICT (tenant, key) DO UPDATE SET value = excluded.value WHERE settings.value < ?",
        [tenant, key, `${until} ${holder}`, now],
      );
      return taken > 0;
    },
    async appendEvent(event) {
      await insertEvent(db, event);
    },
    async getEvent(tenant, id) {
      const row = await one<EventRow>(db, "SELECT * FROM events WHERE tenant = ? AND id = ?", [tenant, id]);
      return row ? toEvent(row) : null;
    },
    async firstEvents(tenant, kinds) {
      const first: Record<string, OrchestratorEvent> = {};
      for (const row of await firstEventRows(db, tenant, kinds, false)) first[row.kind] = toEvent(row);
      return first;
    },
    async firstEventsByActor(tenant, kinds) {
      const first: Record<string, Record<string, OrchestratorEvent>> = {};
      for (const row of await firstEventRows(db, tenant, kinds, true)) (first[row.actor_id!] ??= {})[row.kind] = toEvent(row);
      return first;
    },
    async eventPage(tenant, filter, after, limit) {
      const clauses = ["tenant = ?"];
      const params: SqlValue[] = [tenant];
      if (filter.repoId) clauses.push("repo_id = ?"), params.push(filter.repoId);
      if (filter.subject) clauses.push("subject = ?"), params.push(filter.subject);
      if (filter.kindPrefix) clauses.push("kind LIKE ?"), params.push(`${filter.kindPrefix.replace(/[%_\\]/g, "")}%`);
      if (filter.since) clauses.push("at >= ?"), params.push(filter.since);
      if (filter.until) clauses.push("at < ?"), params.push(filter.until);
      if (after) clauses.push("(at < ? OR (at = ? AND id < ?))"), params.push(after.at, after.at, after.id);
      const rows = await db.all<EventRow>(`SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`, [...params, limit + 1]);
      const events = rows.slice(0, limit).map(toEvent);
      const last = events.at(-1);
      return { events, next: rows.length > limit && last ? { at: last.at, id: last.id } : null };
    },
    async purgeEvents(tenant, before) {
      return db.run("DELETE FROM events WHERE tenant = ? AND at < ?", [tenant, before]);
    },
    async close() {
      await db.close();
    },
  };
}

/** Every app a person approved and the tokens it holds, found by the person each row names. */
async function dropGrants(tx: SqlDriver, tenant: string, userId: string): Promise<void> {
  const approved = await tx.all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE tenant = ? AND (substr(key, 1, 12) = 'oauth.grant.' OR substr(key, 1, 12) = 'oauth.token.')", [tenant]);
  for (const row of approved) {
    let owner: unknown = null;
    try {
      owner = (JSON.parse(row.value) as { userId?: unknown }).userId;
    } catch {
      owner = null;
    }
    if (owner === userId) await tx.run("DELETE FROM settings WHERE tenant = ? AND key = ?", [tenant, row.key]);
  }
}

/** The settings row that says the directory turned an account off; the owner count leaves such owners out. */
export const OFF_PREFIX = "scim.off.";

/**
 * Owners the directory has not turned off. One turned off cannot sign in or change a role, so
 * counting them would let the directory turn off every owner one after another.
 */
async function countOwners(db: SqlDriver, tenant: string): Promise<number> {
  return Number(
    (
      await one<{ n: number | string }>(
        db,
        `SELECT COUNT(*) AS n FROM users u WHERE u.tenant = ? AND u.role = 'owner'
         AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.tenant = u.tenant AND s.key = '${OFF_PREFIX}' || u.id)`,
        [tenant],
      )
    )?.n ?? 0,
  );
}

/**
 * The organization's turn for a change that can take away an owner, taken first in its
 * transaction: an upsert of one row, which Postgres keeps locked until the transaction ends.
 * Two owners demoting each other at once both counted two owners when each read before the
 * other wrote, and left none; with the turn the second waits and counts after the first.
 */
/** Writes the organization's row for `key`, which holds it until the transaction ends: whatever counts under it is counted one at a time. */
async function turn(tx: SqlDriver, tenant: string, key: string): Promise<void> {
  await tx.run("INSERT INTO settings (tenant, key, value) VALUES (?, ?, '') ON CONFLICT (tenant, key) DO UPDATE SET value = excluded.value", [tenant, key]);
}

interface FollowUpRow {
  tenant: string;
  id: string;
  task_id: string;
  source: string;
  key: string;
  text: string;
  quotes: string | null;
  status: string;
  created_at: string;
  delivered_at: string | null;
  created_by: string;
}

function toFollowUp(row: FollowUpRow): FollowUpRecord {
  return {
    tenant: row.tenant,
    id: row.id,
    taskId: row.task_id,
    source: row.source as FollowUpSource,
    key: row.key,
    text: row.text,
    quotes: row.quotes ? (JSON.parse(row.quotes) as FollowUpQuote[]) : null,
    status: row.status as FollowUpStatus,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    createdBy: row.created_by,
  };
}

const MACHINE_REVOKED = "The machine running this task was disconnected.";
const MACHINE_SILENT = "Your machine stopped answering before this task finished.";
const RUNNER_SILENT = "The runner holding this task stopped answering.";

interface MachineRow {
  tenant: string;
  id: string;
  user_id: string;
  name: string;
  platform: string;
  public_key: string;
  agents: string;
  features?: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

function toMachine(row: MachineRow): MachineRecord {
  return {
    tenant: row.tenant,
    id: row.id,
    userId: row.user_id,
    name: row.name,
    platform: row.platform,
    publicKey: row.public_key,
    agents: JSON.parse(row.agents) as MachineAgentStatus[],
    ...(row.features ? { features: JSON.parse(row.features) as MachineFeature[] } : {}),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

async function ownerTurn(tx: SqlDriver, tenant: string): Promise<void> {
  await tx.run("INSERT INTO settings (tenant, key, value) VALUES (?, 'owners.turn', '') ON CONFLICT (tenant, key) DO UPDATE SET value = excluded.value", [tenant]);
}

/** Whether this account is the last owner still on; an owner already turned off is not counted, and removing one takes nobody away. */
async function lastOwner(tx: SqlDriver, tenant: string, id: string): Promise<boolean> {
  const row = await one<{ role: string; off: number | string }>(
    tx,
    `SELECT role, (SELECT COUNT(*) FROM settings s WHERE s.tenant = u.tenant AND s.key = '${OFF_PREFIX}' || u.id) AS off FROM users u WHERE u.tenant = ? AND u.id = ?`,
    [tenant, id],
  );
  return row?.role === "owner" && Number(row.off) === 0 && (await countOwners(tx, tenant)) <= 1;
}

async function countMembers(db: SqlDriver, tenant: string): Promise<number> {
  return Number((await one<{ n: number | string }>(db, "SELECT COUNT(*) AS n FROM users WHERE tenant = ?", [tenant]))?.n ?? 0);
}

async function insertTask(db: SqlDriver, t: TaskRecord): Promise<void> {
  await db.run(
    `INSERT INTO tasks (tenant, id, repo_id, team, title, description, issue_url, issue_key, agent, status, created_by, created_at,
       started_at, finished_at, base_sha, tests, cost_usd, input_tokens, output_tokens, request_number, error, template, target_mode, stage, skills, mode, parent_id, depth, runner, choices, tools, plan_first)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t.tenant, t.id, t.repoId, t.team, t.title, t.description, t.issueUrl, t.issueKey, t.agent, t.status, t.createdBy, t.createdAt,
      t.startedAt, t.finishedAt, t.baseSha, t.tests, t.cost.usd, t.cost.inputTokens, t.cost.outputTokens, t.requestNumber, t.error,
      t.template ? JSON.stringify(t.template) : null, t.targetMode ?? null, t.stage ?? null, t.skills ? JSON.stringify(t.skills) : null, t.mode ?? null, t.parentId ?? null, t.parentId ? (t.depth ?? 1) : 0, t.runner ?? "server", t.choices && Object.keys(t.choices).length ? JSON.stringify(t.choices) : null, t.tools && (t.tools.skills.length || t.tools.mcpServers.length) ? JSON.stringify(t.tools) : null, t.planFirst ? 1 : null],
  );
}

async function insertEvent(db: SqlDriver, event: OrchestratorEvent): Promise<void> {
  await db.run(
    "INSERT INTO events (tenant, id, at, kind, actor_kind, actor_id, actor_email, actor_name, repo_id, subject, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [event.tenant, event.id, event.at, event.kind, event.actor.kind, event.actor.id, event.actor.email, event.actor.name, event.repoId, event.subject, event.detail],
  );
}

interface EffectRow {
  tenant: string;
  id: string;
  task_id: string;
  seq: number | string;
  kind: string;
  payload: string;
  replay: string;
  status: string;
  attempts: number | string;
  claimed_by: string | null;
  lease_until: string | null;
  due_at: string;
  last_error: string | null;
  result: string | null;
  created_at: string;
  settled_at: string | null;
}

function toEffect(row: EffectRow): EffectRecord {
  return {
    tenant: row.tenant,
    id: row.id,
    taskId: row.task_id,
    seq: Number(row.seq),
    kind: row.kind,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    replay: row.replay as EffectReplay,
    status: row.status as EffectStatus,
    attempts: Number(row.attempts),
    claimedBy: row.claimed_by,
    leaseUntil: row.lease_until,
    dueAt: row.due_at,
    lastError: row.last_error,
    result: row.result,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

interface AttachmentRow {
  tenant: string;
  id: string;
  task_id: string;
  name: string;
  mime: string;
  size: number | string;
  sha256: string;
  created_by: string;
  created_at: string;
}

function toAttachment(row: AttachmentRow): AttachmentRecord {
  return { tenant: row.tenant, id: row.id, taskId: row.task_id, name: row.name, mime: row.mime, size: Number(row.size), sha256: row.sha256, createdBy: row.created_by, createdAt: row.created_at };
}

const LISTING_COLUMNS = "id, created_at, last_seen_at, user_agent, expires_at, token_hash";

interface SessionListingRow {
  id: string;
  created_at: string | null;
  last_seen_at: string | null;
  user_agent: string | null;
  expires_at: string;
  token_hash: string;
}

function toListing(row: SessionListingRow, current: string | undefined): SessionListing {
  return { id: row.id, createdAt: row.created_at, lastSeenAt: row.last_seen_at, userAgent: row.user_agent, expiresAt: row.expires_at, current: row.token_hash === current };
}

/** At most 120 characters of what the browser said it is, so a long or crafted header is not kept whole. */
function agentOf(userAgent: string | null | undefined): string | null {
  const agent = userAgent?.trim();
  return agent ? agent.slice(0, 120) : null;
}

interface TaskRequestRow {
  tenant: string;
  id: string;
  task_id: string;
  target_position: number | string | null;
  source_key: string;
  kind: string;
  payload: string;
  status: string;
  response_capability: string;
  answer: string | null;
  answered_by: string | null;
  answered_via: string | null;
  created_at: string;
  answered_at: string | null;
  expires_at: string | null;
}

function toTaskRequest(row: TaskRequestRow): TaskRequestRecord {
  return {
    tenant: row.tenant,
    id: row.id,
    taskId: row.task_id,
    targetPosition: row.target_position === null ? null : Number(row.target_position),
    sourceKey: row.source_key,
    kind: row.kind as TaskRequestKind,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    status: row.status as TaskRequestStatus,
    responseCapability: row.response_capability as ResponseCapability,
    answer: row.answer ? (JSON.parse(row.answer) as TaskAnswer) : null,
    answeredBy: row.answered_by,
    answeredVia: row.answered_via as TaskRequestRecord["answeredVia"],
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    expiresAt: row.expires_at,
  };
}

function receiptOf(db: SqlDriver, tenant: string, actorId: string, commandId: string): Promise<CommandReceipt | null> {
  return one<CommandReceipt>(
    db,
    'SELECT tenant, actor_id AS "actorId", command_id AS "commandId", kind, task_id AS "taskId", result, created_at AS "createdAt" FROM command_receipts WHERE tenant = ? AND actor_id = ? AND command_id = ?',
    [tenant, actorId, commandId],
  );
}

async function insertUser(db: SqlDriver, u: UserRecord): Promise<void> {
  await db.run(
    `INSERT INTO users (tenant, id, email, name, role, password_hash, oidc_issuer, oidc_subject, forge_login, created_at, identity_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [u.tenant, u.id, u.email, u.name, u.role, u.passwordHash, u.oidcIssuer, u.oidcSubject, u.forgeLogin, u.createdAt, u.identityId ?? null],
  );
}

/**
 * node:sqlite is synchronous and the process holds one connection, so a transaction is
 * BEGIN IMMEDIATE on that connection around the callback. A statement from another request
 * that arrives while one is open waits for it: run on the same connection, it would commit
 * or roll back with someone else's work.
 */
export function sqliteDriver(db: DatabaseSync): SqlDriver {
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  const direct = {
    async all<T>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).all(...params) as unknown as T[];
    },
    async run(sql: string, params: SqlValue[] = []) {
      return Number(db.prepare(sql).run(...params).changes);
    },
  };
  const idle = async () => {
    while (pending) await chain;
  };
  const tx: SqlDriver = {
    ...direct,
    transaction: (fn) => fn(tx),
    exec: async (sql) => void db.exec(sql),
    close: async () => undefined,
  };
  return {
    async all<T>(sql: string, params: SqlValue[] = []) {
      await idle();
      return direct.all<T>(sql, params);
    },
    async run(sql, params = []) {
      await idle();
      return direct.run(sql, params);
    },
    transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
      pending++;
      const running = chain.then(async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const value = await fn(tx);
          db.exec("COMMIT");
          return value;
        } catch (err) {
          // SQLite ends the transaction itself on some failures, a full disk among them; a
          // ROLLBACK after that fails with "no transaction is active" and would stand in for
          // the error that says what went wrong.
          if (db.isTransaction !== false) db.exec("ROLLBACK");
          throw err;
        }
      });
      chain = running.then(
        () => undefined,
        () => undefined,
      ).finally(() => {
        pending--;
      });
      return running;
    },
    async exec(sql) {
      await idle();
      db.exec(sql);
    },
    async close() {
      await idle();
      db.close();
    },
  };
}

/** The columns the tasks table gained after it first shipped, for a database an older orchestrator created. */
const TASK_COLUMNS: { column: string; type: string }[] = [
  { column: "log_seq", type: "INTEGER NOT NULL DEFAULT 0" },
  { column: "issue_url", type: "TEXT" },
  { column: "issue_key", type: "TEXT" },
  { column: "pgid", type: "INTEGER" },
  { column: "branch", type: "TEXT" },
  { column: "template", type: "TEXT" },
];

/**
 * One step of the database's shape. Each runs once, in order, for a database whose recorded
 * version is below it, and each is written to be harmless on a database that already has what
 * it adds - a database from before versions were recorded runs them all. A shipped step is
 * never edited (store.contract.test.ts holds each one's text); a change is a new step. SQLite
 * runs a step as the store opens; Postgres, over its connection.
 */
export interface Migration {
  version: number;
  name: string;
  /**
   * `expand` only adds - a table, a nullable column, an index - so an orchestrator from before it
   * still reads and writes the database correctly; `contract` drops, renames, rewrites rows or
   * tightens, and an orchestrator from before it stops. A rollback to the previous image, and the
   * old orchestrator still serving while a release moves the schema, both rest on this mark.
   */
  kind: "expand" | "contract";
  sqlite(db: DatabaseSync): void;
  postgres(db: SqlDriver): Promise<void>;
}

const ROLE_REWRITE = ["UPDATE users SET role = 'member' WHERE role = 'owner'", "UPDATE users SET role = 'owner' WHERE role = 'admin'"];

const TASK_INDEXES = `
CREATE INDEX IF NOT EXISTS tasks_newest ON tasks (tenant, created_at, id);
CREATE INDEX IF NOT EXISTS tasks_creator ON tasks (tenant, created_by, created_at);
CREATE INDEX IF NOT EXISTS tasks_request ON tasks (tenant, repo_id, request_number);
`;

const EFFECT_TABLES = `
CREATE TABLE IF NOT EXISTS task_effects (
  tenant TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  replay TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  claimed_by TEXT,
  lease_until TEXT,
  due_at TEXT NOT NULL,
  last_error TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  PRIMARY KEY (tenant, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS task_effects_order ON task_effects (tenant, task_id, seq);
CREATE INDEX IF NOT EXISTS task_effects_due ON task_effects (status, due_at);
CREATE TABLE IF NOT EXISTS command_receipts (
  tenant TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  task_id TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant, actor_id, command_id)
);
`;

// A session written before ids existed gets one here, from a random value, so every listed session can be ended by id.
const SESSION_LISTING_SQLITE = ["sessions", "identity_sessions"].map((table) => `UPDATE ${table} SET id = 'ses_' || lower(hex(randomblob(13))) WHERE id IS NULL; CREATE UNIQUE INDEX IF NOT EXISTS ${table}_id ON ${table} (id);`).join("\n");
const SESSION_LISTING_POSTGRES = ["sessions", "identity_sessions"]
  .map((table) => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS id TEXT; ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS created_at TEXT; ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS last_seen_at TEXT; ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS user_agent TEXT;
UPDATE ${table} SET id = 'ses_' || substr(md5(random()::text || token_hash), 1, 26) WHERE id IS NULL; CREATE UNIQUE INDEX IF NOT EXISTS ${table}_id ON ${table} (id);`)
  .join("\n");

// Tenant-less on purpose: a signup belongs to no organization yet, and none of them reads it.
const IDENTITY_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS identity_events (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  email_domain TEXT NOT NULL,
  org TEXT
);
CREATE INDEX IF NOT EXISTS identity_events_at ON identity_events (at, id);
`;

const ATTACHMENTS_TABLE = `
CREATE TABLE IF NOT EXISTS task_attachments (
  tenant TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS task_attachments_task ON task_attachments (tenant, task_id);
`;

const RUNNER_TABLES = `
CREATE TABLE IF NOT EXISTS machines (
  tenant TEXT NOT NULL,
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  public_key TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  agents TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (tenant, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS machines_token ON machines (token_hash);
CREATE INDEX IF NOT EXISTS machines_user ON machines (tenant, user_id);
CREATE TABLE IF NOT EXISTS machine_pairings (
  tenant TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY (tenant, code_hash)
);
CREATE TABLE IF NOT EXISTS runner_nonces (
  tenant TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (tenant, machine_id, nonce)
);
CREATE INDEX IF NOT EXISTS runner_nonces_expiry ON runner_nonces (expires_at);
`;

const RUNNER_INDEXES = `
CREATE INDEX IF NOT EXISTS tasks_claim ON tasks (tenant, status, runner, created_by, created_at);
CREATE INDEX IF NOT EXISTS tasks_lease ON tasks (status, lease_until);
CREATE UNIQUE INDEX IF NOT EXISTS task_log_source ON task_log (tenant, task_id, source_n);
`;

const RUNNER_TASK_COLUMNS: [string, string, string][] = [
  ["tasks", "runner", "TEXT NOT NULL DEFAULT 'server'"],
  ["tasks", "claimed_by", "TEXT"],
  ["tasks", "lease_id", "TEXT"],
  ["tasks", "lease_until", "TEXT"],
  ["tasks", "native_session", "TEXT"],
  ["task_log", "kind", "TEXT NOT NULL DEFAULT 'log'"],
  ["task_log", "data", "TEXT"],
  ["task_log", "source_n", "INTEGER"],
];

const FOLLOW_UPS_TABLE = `
CREATE TABLE IF NOT EXISTS task_followups (
  tenant TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  text TEXT NOT NULL,
  quotes TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  created_by TEXT NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS task_followups_key ON task_followups (tenant, task_id, key);
`;

const PROJECT_LOCKS_TABLE = `
CREATE TABLE IF NOT EXISTS project_locks (
  tenant TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  PRIMARY KEY (tenant, project_id)
);
`;

const SETTINGS_BY_KEY = "CREATE INDEX IF NOT EXISTS settings_key ON settings (key);";

const TASK_PARENT_INDEX = "CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (tenant, parent_id);";

const TASK_REQUESTS_TABLE = `
CREATE TABLE IF NOT EXISTS task_requests (
  tenant TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  target_position INTEGER,
  source_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  response_capability TEXT NOT NULL,
  answer TEXT,
  answered_by TEXT,
  answered_via TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS task_requests_source ON task_requests (tenant, task_id, source_key);
CREATE INDEX IF NOT EXISTS task_requests_pending ON task_requests (status, expires_at);
`;

const EVENTS_BY_KIND = "CREATE INDEX IF NOT EXISTS events_first ON events (tenant, kind, at, id);";

const EXTRA_SPEND_TABLE = `
CREATE TABLE IF NOT EXISTS task_extra_spend (
  tenant TEXT NOT NULL,
  id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  team TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  usd DOUBLE PRECISION,
  input_tokens INTEGER,
  output_tokens INTEGER,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS task_extra_spend_at ON task_extra_spend (tenant, at);
CREATE INDEX IF NOT EXISTS invites_address ON invites (email);
`;

const TASK_TARGETS_TABLE = `
CREATE TABLE IF NOT EXISTS task_targets (
  tenant TEXT NOT NULL,
  task_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  repo_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  base_sha TEXT,
  branch TEXT,
  tests TEXT,
  request_number INTEGER,
  error TEXT,
  cost_usd DOUBLE PRECISION,
  input_tokens INTEGER,
  output_tokens INTEGER,
  PRIMARY KEY (tenant, task_id, position)
);
CREATE INDEX IF NOT EXISTS task_targets_request ON task_targets (tenant, repo_id, request_number);
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, kind: "contract", name: "the first tables", sqlite: (db) => db.exec(BASE_TABLES), postgres: (db) => db.exec(BASE_TABLES) },
  {
    version: 2,
    kind: "expand",
    name: "task columns added after the first shape",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      for (const { column, type } of TASK_COLUMNS) if (!have.has(column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${type}`);
    },
    async postgres(db) {
      for (const { column, type } of TASK_COLUMNS) await db.exec(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ${column} ${type}`);
    },
  },
  {
    version: 3,
    kind: "expand",
    name: "the append-only event log",
    sqlite: (db) => db.exec(EVENTS_TABLE + SQLITE_EVENT_GUARDS),
    postgres: async (db) => {
      await db.exec(EVENTS_TABLE);
      await db.exec(POSTGRES_EVENT_GUARDS);
    },
  },
  {
    // Also parts the role from owning a team: until then "owner" meant a team's owner and "admin"
    // ran the organization. A team owner becomes a member who keeps their teams, and an admin
    // becomes an owner, so nobody loses a right they had and every organization that had an
    // admin keeps someone who can change every role.
    version: 4,
    kind: "contract",
    name: "invitations, service accounts, keys, directory groups, and the owner role",
    sqlite: (db) => db.exec(IDENTITY_TABLES + ROLE_REWRITE.map((sql) => `${sql};`).join("\n")),
    postgres: async (db) => {
      await db.exec(IDENTITY_TABLES);
      for (const sql of ROLE_REWRITE) await db.run(sql);
    },
  },
  { version: 5, kind: "expand", name: "policies the orchestrator applies itself", sqlite: (db) => db.exec(POLICIES_TABLE), postgres: (db) => db.exec(POLICIES_TABLE) },
  {
    // Revoking a key revokes every key it minted, which needs each key to name the one that made it.
    version: 6,
    kind: "expand",
    name: "keys remember the key that minted them",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(api_keys)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("minted_by")) db.exec("ALTER TABLE api_keys ADD COLUMN minted_by TEXT");
    },
    postgres: (db) => db.exec("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS minted_by TEXT"),
  },
  {
    // How long a request waited to merge is the analytics' measure, and the status alone does not say when.
    version: 7,
    kind: "expand",
    name: "requests remember when they were merged",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(requests)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("merged_at")) db.exec("ALTER TABLE requests ADD COLUMN merged_at TEXT");
    },
    postgres: (db) => db.exec("ALTER TABLE requests ADD COLUMN IF NOT EXISTS merged_at TEXT"),
  },
  { version: 8, kind: "expand", name: "email domains verified for single sign-on", sqlite: (db) => db.exec(DOMAINS_TABLE), postgres: (db) => db.exec(DOMAINS_TABLE) },
  // The task list is read a page at a time, newest first, and a budget sums one window of it;
  // without these each read walks every task the organization ever ran.
  { version: 9, kind: "expand", name: "tasks read newest first and by who started them", sqlite: (db) => db.exec(TASK_INDEXES), postgres: (db) => db.exec(TASK_INDEXES) },
  {
    // A task over several repositories keeps each one's run beside the task, and says how they were chosen.
    version: 10,
    kind: "expand",
    name: "tasks over several repositories",
    sqlite(db) {
      db.exec(TASK_TARGETS_TABLE);
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("target_mode")) db.exec("ALTER TABLE tasks ADD COLUMN target_mode TEXT");
    },
    postgres: async (db) => {
      await db.exec(TASK_TARGETS_TABLE);
      await db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS target_mode TEXT");
    },
  },
  {
    // The sprint board shows where a running task is, and Run again starts it with the same skills.
    version: 11,
    kind: "expand",
    name: "tasks remember their stage and skills",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("stage")) db.exec("ALTER TABLE tasks ADD COLUMN stage TEXT");
      if (!have.has("skills")) db.exec("ALTER TABLE tasks ADD COLUMN skills TEXT");
    },
    postgres: async (db) => {
      await db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stage TEXT");
      await db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS skills TEXT");
    },
  },
  {
    // A cloud orchestrator's people: one identity across organizations, each membership an organization's account.
    version: 12,
    kind: "expand",
    name: "identities and the organizations they create",
    sqlite(db) {
      db.exec(CLOUD_IDENTITY_TABLES);
      const have = new Set((db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("identity_id")) db.exec("ALTER TABLE users ADD COLUMN identity_id TEXT");
      if (!have.has("sessions_revoked_at")) db.exec("ALTER TABLE users ADD COLUMN sessions_revoked_at TEXT");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_identity ON users (tenant, identity_id)");
    },
    postgres: async (db) => {
      await db.exec(CLOUD_IDENTITY_TABLES);
      await db.exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_id TEXT");
      await db.exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_revoked_at TEXT");
      await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_identity ON users (tenant, identity_id)");
    },
  },
  {
    // A skill suggestion spends on the model outside any task, and the budgets count it beside
    // tasks; an identity's invitations are read by address across organizations.
    version: 13,
    kind: "expand",
    name: "model spend outside tasks, and invitations by address",
    sqlite: (db) => db.exec(EXTRA_SPEND_TABLE),
    postgres: (db) => db.exec(EXTRA_SPEND_TABLE),
  },
  {
    // Who has reached which step of an organization's setup is read from the first event of each kind.
    version: 14,
    kind: "expand",
    name: "events read by kind",
    sqlite: (db) => db.exec(EVENTS_BY_KIND),
    postgres: (db) => db.exec(EVENTS_BY_KIND),
  },
  {
    // A cloud organization's plan decides which features open for it; every one starts on Free.
    version: 15,
    kind: "expand",
    name: "organizations carry a plan",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(orgs)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("plan")) db.exec("ALTER TABLE orgs ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'");
    },
    postgres: (db) => db.exec("ALTER TABLE orgs ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free'"),
  },
  {
    // A task's side effects are written with the command that asks for them and carried out after,
    // and a command sent twice is answered once.
    version: 16,
    kind: "expand",
    name: "task effects and command receipts",
    sqlite: (db) => db.exec(EFFECT_TABLES),
    postgres: (db) => db.exec(EFFECT_TABLES),
  },
  {
    // A task says how far its agent goes without asking, under the organization's ceiling.
    version: 17,
    kind: "expand",
    name: "tasks carry a permission mode",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("mode")) db.exec("ALTER TABLE tasks ADD COLUMN mode TEXT");
    },
    postgres: (db) => db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS mode TEXT"),
  },
  {
    // What an agent asks while it works is kept before anyone answers it, so any browser answers it once.
    version: 18,
    kind: "expand",
    name: "questions agents ask while they work",
    sqlite: (db) => db.exec(TASK_REQUESTS_TABLE),
    postgres: (db) => db.exec(TASK_REQUESTS_TABLE),
  },
  {
    // A person lists the browsers they are signed in from and ends one by its id, not by its token.
    version: 19,
    kind: "expand",
    name: "sessions listed by id",
    sqlite(db) {
      for (const table of ["sessions", "identity_sessions"]) {
        const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
        for (const column of ["id", "created_at", "last_seen_at", "user_agent"]) if (!have.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      }
      db.exec(SESSION_LISTING_SQLITE);
    },
    postgres: (db) => db.exec(SESSION_LISTING_POSTGRES),
  },
  {
    // A task an agent delegates records the task that asked for it and how deep it sits.
    version: 20,
    kind: "expand",
    name: "tasks delegated by tasks",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("parent_id")) db.exec("ALTER TABLE tasks ADD COLUMN parent_id TEXT");
      if (!have.has("depth")) db.exec("ALTER TABLE tasks ADD COLUMN depth INTEGER NOT NULL DEFAULT 0");
      db.exec(TASK_PARENT_INDEX);
    },
    postgres: async (db) => {
      await db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_id TEXT");
      await db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS depth INTEGER NOT NULL DEFAULT 0");
      await db.exec(TASK_PARENT_INDEX);
    },
  },
  {
    // Who signed up and how far their organization got, kept for the operator apart from every organization.
    version: 21,
    kind: "expand",
    name: "signup steps",
    sqlite: (db) => db.exec(IDENTITY_EVENTS_TABLE),
    postgres: (db) => db.exec(IDENTITY_EVENTS_TABLE),
  },
  {
    // An organization that lets people join by their directory is found by its setting's key.
    version: 22,
    kind: "expand",
    name: "settings read by key",
    sqlite: (db) => db.exec(SETTINGS_BY_KEY),
    postgres: (db) => db.exec(SETTINGS_BY_KEY),
  },
  {
    // A file a person attaches to a task is recorded beside it; its bytes stay in the data directory.
    version: 23,
    kind: "expand",
    name: "task attachments",
    sqlite: (db) => db.exec(ATTACHMENTS_TABLE),
    postgres: (db) => db.exec(ATTACHMENTS_TABLE),
  },
  {
    // A person's machine runs their tasks under a lease it renews; a task it held when the lease
    // ran out waits for Continue there, and its events are numbered by the machine, written once.
    version: 24,
    kind: "expand",
    name: "machines and the tasks they lease",
    sqlite(db) {
      db.exec(RUNNER_TABLES);
      for (const [table, column, type] of RUNNER_TASK_COLUMNS) {
        const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
        if (!have.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
      db.exec(RUNNER_INDEXES);
    },
    postgres: async (db) => {
      await db.exec(RUNNER_TABLES);
      for (const [table, column, type] of RUNNER_TASK_COLUMNS) await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
      await db.exec(RUNNER_INDEXES);
    },
  },
  {
    // A task keeps the agent options it ran with, so Run again sends the same.
    version: 25,
    kind: "expand",
    name: "tasks carry their agent's options",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("choices")) db.exec("ALTER TABLE tasks ADD COLUMN choices TEXT");
    },
    postgres: (db) => db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS choices TEXT"),
  },
  {
    // A question from an agent on a person's machine has no deadline of its own: it waits as long
    // as the machine holds the task. SQLite drops a NOT NULL only by copying the table.
    version: 26,
    kind: "expand",
    name: "questions that wait without a deadline",
    sqlite(db) {
      const column = (db.prepare("PRAGMA table_info(task_requests)").all() as { name: string; notnull: number }[]).find((c) => c.name === "expires_at");
      if (!column?.notnull) return;
      db.exec(`${TASK_REQUESTS_TABLE.replace("task_requests (", "task_requests_next (").replace("expires_at TEXT NOT NULL", "expires_at TEXT").replace(/CREATE (UNIQUE )?INDEX[^;]*;/g, "")}
        INSERT INTO task_requests_next SELECT * FROM task_requests;
        DROP TABLE task_requests;
        ALTER TABLE task_requests_next RENAME TO task_requests;
        ${TASK_REQUESTS_TABLE.replace(/CREATE TABLE[^;]*;/, "")}`);
    },
    postgres: (db) => db.exec("ALTER TABLE task_requests ALTER COLUMN expires_at DROP NOT NULL"),
  },
  {
    // A link whose provider email is not the identity's waits for the person to confirm it, with
    // the provider's account kept beside its state until then.
    version: 27,
    kind: "expand",
    name: "pending links keep the account they wait to confirm",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(identity_sign_ins)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("account")) db.exec("ALTER TABLE identity_sign_ins ADD COLUMN account TEXT");
    },
    postgres: (db) => db.exec("ALTER TABLE identity_sign_ins ADD COLUMN IF NOT EXISTS account TEXT"),
  },
  {
    // A Stop for a task a machine runs is kept on the task until the run ends, so it reaches the
    // runner through any instance and across a restart.
    version: 28,
    kind: "expand",
    name: "stops asked for tasks a machine runs",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("stop_requested_at")) db.exec("ALTER TABLE tasks ADD COLUMN stop_requested_at TEXT");
    },
    postgres: (db) => db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stop_requested_at TEXT"),
  },
  {
    // What reaches a running task after it started is kept before it is delivered, once per key,
    // so a second web node or a restarted sweep writes it once.
    version: 29,
    kind: "expand",
    name: "follow-ups waiting for a running task",
    sqlite: (db) => db.exec(FOLLOW_UPS_TABLE),
    postgres: (db) => db.exec(FOLLOW_UPS_TABLE),
  },
  {
    // A task in a folder without git works there in place, one at a time, and leaves changes
    // rather than a request, read between two snapshots of the folder's shadow.
    version: 30,
    kind: "expand",
    name: "tasks working in a folder in place",
    sqlite(db) {
      db.exec(PROJECT_LOCKS_TABLE);
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      for (const column of ["result", "changes"]) if (!have.has(column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
    },
    postgres: async (db) => {
      await db.exec(PROJECT_LOCKS_TABLE);
      for (const column of ["result", "changes"]) await db.exec(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ${column} TEXT`);
    },
  },
  {
    // A task's request is checked again each time its head moves: the last head that passed, and
    // the head that failed with why, which holds the request until a later head passes.
    version: 31,
    kind: "expand",
    name: "the check of a request's head",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(requests)").all() as { name: string }[]).map((c) => c.name));
      for (const column of REQUEST_CHECK_COLUMNS) if (!have.has(column)) db.exec(`ALTER TABLE requests ADD COLUMN ${column} TEXT`);
    },
    postgres: async (db) => {
      for (const column of REQUEST_CHECK_COLUMNS) await db.exec(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS ${column} TEXT`);
    },
  },
  {
    // A task keeps what its starter picked of the project's own skill sources and MCP servers.
    version: 32,
    kind: "expand",
    name: "a task's pick of its project's skills and MCP servers",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("tools")) db.exec("ALTER TABLE tasks ADD COLUMN tools TEXT");
    },
    postgres: (db) => db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tools TEXT"),
  },
  {
    // A task shared with a member of its organization to read; nobody outside it.
    version: 33,
    kind: "expand",
    name: "tasks shared with a member to read",
    sqlite: (db) => db.exec(TASK_SHARES_TABLE),
    postgres: (db) => db.exec(TASK_SHARES_TABLE),
  },
  {
    // What the person's own Claude Code loaded into a task's run, by count; and where in the task's folder each of its
    // repositories is, so a change kept on a person's machine is named by its place there.
    version: 34,
    kind: "expand",
    name: "what a person's own setup loaded into a task's run, and each target's place in its folder",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("loaded")) db.exec("ALTER TABLE tasks ADD COLUMN loaded TEXT");
      const targets = new Set((db.prepare("PRAGMA table_info(task_targets)").all() as { name: string }[]).map((c) => c.name));
      if (!targets.has("path")) db.exec("ALTER TABLE task_targets ADD COLUMN path TEXT");
    },
    async postgres(db) {
      await db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS loaded TEXT");
      await db.exec("ALTER TABLE task_targets ADD COLUMN IF NOT EXISTS path TEXT");
    },
  },
  {
    // How many tokens a task's first agent request carried: the context a cost line names.
    version: 35,
    kind: "expand",
    name: "the context a task's run started from",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("context_tokens")) db.exec("ALTER TABLE tasks ADD COLUMN context_tokens INTEGER");
    },
    postgres: (db) => db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS context_tokens INTEGER"),
  },
  {
    // What a change kept on a person's machine needs for a later push and request: its head, its remote and that
    // remote's default branch, and the request's words.
    version: 36,
    kind: "expand",
    name: "a kept change's head, remote and request words",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(task_targets)").all() as { name: string }[]).map((c) => c.name));
      for (const column of ["head", "origin", "target_branch", "description"]) if (!have.has(column)) db.exec(`ALTER TABLE task_targets ADD COLUMN ${column} TEXT`);
    },
    async postgres(db) {
      for (const column of ["head", "origin", "target_branch", "description"]) await db.exec(`ALTER TABLE task_targets ADD COLUMN IF NOT EXISTS ${column} TEXT`);
    },
  },
  {
    // Why a task was asked to stop when the orchestrator asked it (a limit), and when its current run started.
    version: 37,
    kind: "expand",
    name: "a stop's reason and the run's start",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      for (const column of ["stop_reason", "run_started_at"]) if (!have.has(column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
    },
    async postgres(db) {
      for (const column of ["stop_reason", "run_started_at"]) await db.exec(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ${column} TEXT`);
    },
  },
  {
    // Where the orchestrator sent a task started with no project named, and why.
    version: 38,
    kind: "expand",
    name: "where a task was sent",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("routing")) db.exec("ALTER TABLE tasks ADD COLUMN routing TEXT");
    },
    postgres: (db) => db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS routing TEXT"),
  },
  {
    // What a stopped run asked its starter, and the answer the next run takes.
    version: 39,
    kind: "expand",
    name: "a task's question to its starter",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("question")) db.exec("ALTER TABLE tasks ADD COLUMN question TEXT");
    },
    postgres: (db) => db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS question TEXT"),
  },
  {
    // The person's own MCP servers a task's agent found waiting for a sign-in.
    version: 40,
    kind: "expand",
    name: "the servers a task found waiting for a sign-in",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("mcp_needs_sign_in")) db.exec("ALTER TABLE tasks ADD COLUMN mcp_needs_sign_in TEXT");
    },
    postgres: (db) => db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS mcp_needs_sign_in TEXT"),
  },
  {
    // A task started to plan first: its agent changes nothing until its starter approves the plan.
    version: 41,
    kind: "expand",
    name: "a task that plans first",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("plan_first")) db.exec("ALTER TABLE tasks ADD COLUMN plan_first INTEGER");
    },
    postgres: (db) => db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_first INTEGER"),
  },
  {
    // A task on a person's machine cut off at their plan's usage limit: when it resets, when it was hit, how many times
    // the task went on by itself after one, and that its next run is such a going on.
    version: 42,
    kind: "expand",
    name: "a task waiting for its usage limit to reset",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("limit_reset_at")) db.exec("ALTER TABLE tasks ADD COLUMN limit_reset_at TEXT");
      if (!have.has("limit_at")) db.exec("ALTER TABLE tasks ADD COLUMN limit_at TEXT");
      if (!have.has("auto_continues")) db.exec("ALTER TABLE tasks ADD COLUMN auto_continues INTEGER");
      if (!have.has("limit_goes_on")) db.exec("ALTER TABLE tasks ADD COLUMN limit_goes_on INTEGER");
    },
    postgres: (db) =>
      db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS limit_reset_at TEXT, ADD COLUMN IF NOT EXISTS limit_at TEXT, ADD COLUMN IF NOT EXISTS auto_continues INTEGER, ADD COLUMN IF NOT EXISTS limit_goes_on INTEGER"),
  },  {
    // The agent's estimate of the turn it is in on a machine, so a run cut off before the turn reported still counts it.
    version: 43,
    kind: "expand",
    name: "the estimate of a machine's turn in progress",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("turn_estimate_usd")) db.exec("ALTER TABLE tasks ADD COLUMN turn_estimate_usd REAL");
    },
    postgres: (db) => db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS turn_estimate_usd DOUBLE PRECISION"),
  },  {
    // How long a task's agent worked over its runs on a machine, its cards' waits left out, for the time its page says.
    version: 44,
    kind: "expand",
    name: "the time a task's agent worked",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("ran_ms")) db.exec("ALTER TABLE tasks ADD COLUMN ran_ms INTEGER");
    },
    postgres: (db) => db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ran_ms BIGINT"),
  },
  {
    // The skills a task's agent called, by name, for the line that says what a task used and for what a skill is measured on.
    version: 45,
    kind: "expand",
    name: "the skills a task's agent called",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("used_skills")) db.exec("ALTER TABLE tasks ADD COLUMN used_skills TEXT");
    },
    postgres: (db) => db.exec("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS used_skills TEXT"),
  },  {
    // What of the handed-out work a machine's runner says it understands, so a newer part goes only to one that does.
    version: 46,
    kind: "expand",
    name: "what a machine's runner understands",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(machines)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("features")) db.exec("ALTER TABLE machines ADD COLUMN features TEXT");
    },
    postgres: (db) => db.exec("ALTER TABLE machines ADD COLUMN IF NOT EXISTS features TEXT"),
  },  {
    // A request opened with its person's own sign-in on a forge the organization never connected, kept on its target.
    version: 47,
    kind: "expand",
    name: "a request opened on a forge the organization never connected",
    sqlite(db) {
      const have = new Set((db.prepare("PRAGMA table_info(task_targets)").all() as { name: string }[]).map((c) => c.name));
      if (!have.has("forge_request")) db.exec("ALTER TABLE task_targets ADD COLUMN forge_request TEXT");
    },
    postgres: (db) => db.exec("ALTER TABLE task_targets ADD COLUMN IF NOT EXISTS forge_request TEXT"),
  },
];

/**
 * The shape of the database this orchestrator writes: its last migration. A database keeps the
 * highest version that opened it, so an older orchestrator started on it afterwards - a rolled-back
 * image - stops with a reason instead of writing beside columns and rows it does not know. A
 * database from before the count reads as version 0 and runs every step.
 */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Brings a Postgres database up to SCHEMA_VERSION in one transaction that holds the version
 * table, reading the version again under that lock: two orchestrators starting together run each
 * step once, which matters for a step that rewrites rows.
 */
export async function migratePostgres(db: SqlDriver): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.exec(SCHEMA_FLOOR_TABLE);
    await tx.exec("LOCK TABLE schema_version IN EXCLUSIVE MODE");
    const stored = Number((await tx.all<{ version: number | null }>("SELECT MAX(version) AS version FROM schema_version"))[0]?.version ?? 0);
    for (const step of MIGRATIONS.filter((m) => m.version > stored)) await step.postgres(tx);
    if (stored > SCHEMA_VERSION || (stored === SCHEMA_VERSION && (await readSchemaFloor(tx)) !== null)) return;
    await tx.run("DELETE FROM schema_floor");
    await tx.run("INSERT INTO schema_floor (version) VALUES (?)", [readableFrom(SCHEMA_VERSION)]);
    await tx.run("DELETE FROM schema_version");
    await tx.run("INSERT INTO schema_version (version) VALUES (?)", [SCHEMA_VERSION]);
  });
}

export const SCHEMA_VERSION_TABLE = "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);";

/**
 * Beside the version, the oldest orchestrator schema that reads the database. An orchestrator older than
 * the one that moved it does not know the migrations above its own, so it learns from here
 * whether every one of them only added.
 */
export const SCHEMA_FLOOR_TABLE = "CREATE TABLE IF NOT EXISTS schema_floor (version INTEGER NOT NULL);";

/** The oldest orchestrator schema that reads a database at `version`: the last `contract` migration up to it. */
export function readableFrom(version: number): number {
  return Math.max(0, ...MIGRATIONS.filter((m) => m.kind === "contract" && m.version <= version).map((m) => m.version));
}

/** The floor a database records; null for one no orchestrator wrote a floor into, which an older orchestrator does not read. */
export async function readSchemaFloor(db: SqlDriver): Promise<number | null> {
  const floor = (await db.all<{ version: number | null }>("SELECT MAX(version) AS version FROM schema_floor"))[0]?.version;
  return floor === null || floor === undefined ? null : Number(floor);
}

/** Whether this orchestrator reads a database a newer orchestrator moved, by the floor that orchestrator wrote. */
export function readsNewerSchema(floor: number | null): boolean {
  return floor !== null && floor <= SCHEMA_VERSION;
}

export function readingNewerSchema(stored: number): string {
  return `start: this database is at schema ${stored}, newer than this orchestrator's ${SCHEMA_VERSION}; every change since ${SCHEMA_VERSION} only adds, so this orchestrator reads it as it is`;
}

export function newerSchema(stored: number): string {
  return `this database was last opened by a newer orchestrator (schema ${stored}; this one reads up to ${SCHEMA_VERSION}); start the newer image again, or restore the backup taken before the upgrade`;
}

/** SQLite's copy of a whole database as one read, taken while other connections write; the file must not exist yet. */
function vacuumInto(file: string): string {
  return `VACUUM INTO '${file.replace(/'/g, "''")}'`;
}

export interface SqliteOptions {
  /** Where the copy taken before a schema upgrade goes; beside the database file when not given. */
  backupDir?: string;
  say?: (line: string) => void;
}

export function openSqliteStore(file: string, options: SqliteOptions = {}): Store {
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // It holds the sessions and the sealed tokens: the file is made 0600 before SQLite opens it,
    // whatever the umask, so the journal files SQLite makes take the same mode, and a file an
    // earlier start left open is closed again.
    closeSync(openSync(file, "a", 0o600));
    for (const kept of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(kept)) chmodSync(kept, 0o600);
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_VERSION_TABLE + SCHEMA_FLOOR_TABLE);
  const stored = Number((db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number | null }).version ?? 0);
  const floorRow = (db.prepare("SELECT MAX(version) AS version FROM schema_floor").get() as { version: number | null }).version;
  const floor = floorRow === null ? null : Number(floorRow);
  if (stored > SCHEMA_VERSION) {
    if (!readsNewerSchema(floor)) {
      db.close();
      throw new Error(newerSchema(stored));
    }
    options.say?.(readingNewerSchema(stored));
  }
  // A database an earlier orchestrator wrote is copied before its shape moves, so the way back from an
  // upgrade exists even when nobody took a backup. A copy that is not written stops the start
  // with nothing changed: moving the shape without it would leave no way back.
  // A database from before versions were recorded reads as 0 like a new one, and is told apart by its tables.
  const written = stored > 0 || db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT IN ('schema_version', 'schema_floor') LIMIT 1").get() !== undefined;
  if (written && stored < SCHEMA_VERSION && file !== ":memory:") {
    const dir = options.backupDir ?? join(dirname(file), "backups");
    const copy = join(dir, `before-schema-${SCHEMA_VERSION}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      db.exec(vacuumInto(copy));
      chmodSync(copy, 0o600);
    } catch (err) {
      db.close();
      throw new Error(`the copy taken before moving this database from schema ${stored} to ${SCHEMA_VERSION} was not written (${(err as Error).message}); nothing was changed`);
    }
    options.say?.(`start: copied the database at schema ${stored} to ${copy} before moving it to schema ${SCHEMA_VERSION}`);
  }
  // The floor moves with each step, so a start cut off between steps never tells an older orchestrator
  // that a contract step it does not know only added.
  for (const step of MIGRATIONS.filter((m) => m.version > stored)) {
    step.sqlite(db);
    db.exec(`DELETE FROM schema_floor; INSERT INTO schema_floor (version) VALUES (${readableFrom(step.version)}); DELETE FROM schema_version; INSERT INTO schema_version (version) VALUES (${step.version});`);
  }
  if (stored === SCHEMA_VERSION && floor === null) db.exec(`INSERT INTO schema_floor (version) VALUES (${readableFrom(SCHEMA_VERSION)});`);
  const driver = sqliteDriver(db);
  // Run through the driver, which waits for any open transaction: VACUUM INTO refuses to run inside one.
  return Object.assign(createStore(driver), { snapshotTo: (copy: string) => driver.exec(vacuumInto(copy)) });
}

