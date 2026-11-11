import type { OrchestratorContext } from "./app.js";
import { newId } from "./ids.js";
import { inConfiguration, mirrorDir } from "./app.js";
import type { Principal } from "./auth.js";
import { canEditTeam } from "./auth.js";
import { ChangeRefused, teamFile } from "./changes.js";
import type { BuiltChange } from "./changes.js";
import { memberTags } from "./directory.js";
import { gitAsyncMaybe } from "./git.js";
import { serviceId } from "./keys.js";
import { policiesProblem, POLICY_MAX_RESOURCES, POLICY_MAX_RULES, POLICY_NAME_MAX, ruleProblem, TEAM_PREFIX_FILE } from "./plugin.js";
import type { PolicyAction, PolicyRule, TeamFilePolicy } from "./plugin.js";
import type { RepoRecord } from "./store.js";
import type { TaskSpendRow } from "./tasks/types.js";
import { DEFAULT_MODE, isPermissionMode, lowerMode, MODE_LABEL, modeRank, PERMISSION_MODES } from "../shared/permission-mode.js";
import type { PermissionMode } from "../shared/permission-mode.js";

export const AUDIENCE_KINDS = ["workspace", "teams", "members", "except-members", "tags", "except-tags", "service-accounts"] as const;
export type Audience = { kind: "workspace" } | { kind: Exclude<(typeof AUDIENCE_KINDS)[number], "workspace">; ids: string[] };

/** Rules that reach teammates' sessions through the team file, and only take away. */
export const DEVELOPER_KINDS = { "skill-access": "skill.use", "mcp-access": "mcp.use", "tool-access": "tool.use" } as const satisfies Record<string, PolicyAction>;
export type DeveloperKind = keyof typeof DEVELOPER_KINDS;

export type PolicyRuleInput =
  | { kind: DeveloperKind; effect: "deny"; resources: string[]; reason: string }
  | { kind: "task-budget"; monthlyUsd: number; per: "audience" | "member" }
  | { kind: "repo-access"; effect: "allow" | "deny"; repos: string[] }
  | { kind: "task-mode"; ceiling: PermissionMode; repos: string[] }
  | { kind: "own-setup"; allowed: boolean; repos: string[] };

export interface Policy {
  id: string;
  name: string;
  audience: Audience;
  rules: PolicyRuleInput[];
  updatedAt: string | null;
  updatedBy: string | null;
}

/** A policy as a person sends it: everything but what the orchestrator keeps itself. */
export type PolicyDraft = Pick<Policy, "name" | "audience" | "rules">;

export class PolicyRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
    /** The policy whose rule refused, when one did. */
    readonly policy: { id: string | null; name: string } | null = null,
  ) {
    super(message);
  }
}

const REPO_PATTERN = /^[A-Za-z0-9*._-]{1,64}$/;
const AUDIENCE_ID = /^[^\p{C}]{1,200}$/u;
const MAX_IDS = 100;

const isDeveloperKind = (kind: unknown): kind is DeveloperKind => typeof kind === "string" && Object.hasOwn(DEVELOPER_KINDS, kind);

function invalid(message: string): PolicyRefused {
  return new PolicyRefused("policy-invalid", message);
}

function stringList(value: unknown, max: number, what: string, at: string): string[] {
  if (!Array.isArray(value) || !value.length || !value.every((v) => typeof v === "string")) throw invalid(`${at}: ${what} is a list of at least one`);
  if (value.length > max) throw invalid(`${at}: ${what} holds more than ${max}`);
  return [...new Set(value as string[])];
}

function checkAudience(raw: unknown): Audience {
  const audience = (raw ?? {}) as { kind?: unknown; ids?: unknown };
  if (typeof audience.kind !== "string" || !(AUDIENCE_KINDS as readonly string[]).includes(audience.kind)) throw invalid(`the audience is one of ${AUDIENCE_KINDS.join(", ")}`);
  if (audience.kind === "workspace") return { kind: "workspace" };
  const ids = stringList(audience.ids, MAX_IDS, "its ids", "the audience");
  if (!ids.every((id) => AUDIENCE_ID.test(id))) throw invalid("the audience: an id is at most 200 characters with no control character");
  return { kind: audience.kind as Exclude<Audience["kind"], "workspace">, ids };
}

function checkRule(raw: unknown, index: number): PolicyRuleInput {
  const at = `rule ${index + 1}`;
  const rule = (raw ?? {}) as Record<string, unknown>;
  if (isDeveloperKind(rule.kind)) {
    if (rule.effect !== "deny") throw invalid(`${at}: a rule that reaches teammates' sessions only denies; a capability is given by adding it in a reviewed request`);
    const resources = stringList(rule.resources, POLICY_MAX_RESOURCES, "its resources", at);
    const reason = typeof rule.reason === "string" ? rule.reason.trim() : "";
    for (const resource of resources) {
      const problem = ruleProblem({ action: DEVELOPER_KINDS[rule.kind], resource, effect: "deny", reason });
      if (problem) throw invalid(`${at}: ${problem}`);
    }
    return { kind: rule.kind, effect: "deny", resources, reason };
  }
  if (rule.kind === "task-budget") {
    const usd = rule.monthlyUsd;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0 || usd > 1_000_000) throw invalid(`${at}: enter a monthly limit above 0 and at most 1000000 dollars`);
    if (rule.per !== "audience" && rule.per !== "member") throw invalid(`${at}: the limit is for the whole audience or for each member`);
    return { kind: "task-budget", monthlyUsd: Math.round(usd * 100) / 100, per: rule.per };
  }
  if (rule.kind === "repo-access") {
    if (rule.effect !== "allow" && rule.effect !== "deny") throw invalid(`${at}: repository access allows or denies`);
    const repos = stringList(rule.repos, MAX_IDS, "its repositories", at);
    if (!repos.every((r) => REPO_PATTERN.test(r))) throw invalid(`${at}: a repository is named by its id, letters, digits, . _ - and *`);
    return { kind: "repo-access", effect: rule.effect, repos };
  }
  if (rule.kind === "task-mode") {
    if (!isPermissionMode(rule.ceiling)) throw invalid(`${at}: the ceiling is one of ${PERMISSION_MODES.join(", ")}`);
    const repos = stringList(rule.repos, MAX_IDS, "its repositories", at);
    if (!repos.every((r) => REPO_PATTERN.test(r))) throw invalid(`${at}: a repository is named by its id, letters, digits, . _ - and *`);
    return { kind: "task-mode", ceiling: rule.ceiling, repos };
  }
  if (rule.kind === "own-setup") {
    if (typeof rule.allowed !== "boolean") throw invalid(`${at}: the starter's own setup is allowed or not`);
    const repos = stringList(rule.repos, MAX_IDS, "its repositories", at);
    if (!repos.every((r) => REPO_PATTERN.test(r))) throw invalid(`${at}: a repository is named by its id, letters, digits, . _ - and *`);
    return { kind: "own-setup", allowed: rule.allowed, repos };
  }
  throw invalid(`${at}: its kind is not one of ${[...Object.keys(DEVELOPER_KINDS), "task-budget", "repo-access", "task-mode", "own-setup"].join(", ")}`);
}

/**
 * A policy as the orchestrator keeps it, or the reason it is not one. Rules that reach teammates'
 * sessions apply to whole teams, since a teammate's machine does not say who is at it; and a
 * policy holds those or the orchestrator's own rules, not both, since saving one opens a request
 * and saving the other takes effect at once.
 */
export function checkPolicy(raw: unknown): PolicyDraft {
  const draft = (raw ?? {}) as Record<string, unknown>;
  const name = typeof draft.name === "string" ? draft.name.trim() : "";
  if (!name) throw invalid("name the policy to continue");
  if (name.length > POLICY_NAME_MAX || /\p{C}/u.test(name)) throw invalid(`a policy's name is at most ${POLICY_NAME_MAX} characters with no control character`);
  const audience = checkAudience(draft.audience);
  if (!Array.isArray(draft.rules) || !draft.rules.length) throw invalid("add a rule to continue");
  if (draft.rules.length > POLICY_MAX_RULES) throw invalid(`a policy holds at most ${POLICY_MAX_RULES} rules`);
  const rules = draft.rules.map(checkRule);
  const developer = rules.filter((r) => isDeveloperKind(r.kind)).length;
  if (developer && developer < rules.length) {
    throw new PolicyRefused("policy-mixed", "Rules that reach teammates' sessions are saved as a request and the orchestrator's own rules apply at once; put them in two policies.");
  }
  if (developer && audience.kind !== "workspace" && audience.kind !== "teams") {
    throw new PolicyRefused("policy-audience", "Rules that reach teammates' sessions apply to whole teams: a teammate's machine does not say who is at it.");
  }
  return { name, audience, rules };
}

export const isDeveloperPolicy = (policy: Pick<Policy, "rules">): boolean => policy.rules.some((r) => isDeveloperKind(r.kind));

/** A new policy's id: time first, so ids sort in the order policies were made. */
export function newPolicyId(now: number = Date.now()): string {
  return newId("pol", now);
}

/** The statements the team file carries for a developer policy: one per resource, each with its rule's reason. */
export function teamFilePolicy(id: string, draft: PolicyDraft): TeamFilePolicy {
  const rules: PolicyRule[] = draft.rules.flatMap((r) =>
    isDeveloperKind(r.kind) && "resources" in r ? r.resources.map((resource) => ({ action: DEVELOPER_KINDS[r.kind as DeveloperKind], resource, effect: "deny" as const, reason: (r as { reason: string }).reason })) : [],
  );
  return { id, name: draft.name, rules };
}

/** The team file's statements read back as rules: neighbours with the same action and reason are one rule. */
export function rulesFromStatements(statements: readonly PolicyRule[]): PolicyRuleInput[] {
  const kinds = Object.fromEntries(Object.entries(DEVELOPER_KINDS).map(([kind, action]) => [action, kind as DeveloperKind]));
  const rules: (PolicyRuleInput & { kind: DeveloperKind })[] = [];
  for (const s of statements) {
    const last = rules.at(-1);
    if (last && last.kind === kinds[s.action] && last.reason === s.reason) last.resources.push(s.resource);
    else rules.push({ kind: kinds[s.action]!, effect: "deny", resources: [s.resource], reason: s.reason });
  }
  return rules;
}

interface RepoPolicies {
  repo: RepoRecord;
  policies: TeamFilePolicy[];
}

/** Each configured repository's policies as its team file holds them at the head the orchestrator read. */
async function readRepoPolicies(ctx: OrchestratorContext): Promise<{ read: RepoPolicies[]; problems: { repoId: string; problem: string }[] }> {
  const repos = (await ctx.store.listRepos(ctx.tenant)).filter((r) => inConfiguration(ctx, r.id) && r.head);
  const read: RepoPolicies[] = [];
  const problems: { repoId: string; problem: string }[] = [];
  for (const repo of repos) {
    try {
      const { json } = await teamFile(mirrorDir(ctx, repo.id), repo.head!);
      const policies = json.policies ?? [];
      const problem = policiesProblem(policies);
      if (problem) problems.push({ repoId: repo.id, problem: `the policies in ${TEAM_PREFIX_FILE} are not valid: ${problem}` });
      else read.push({ repo, policies: policies as TeamFilePolicy[] });
    } catch (err) {
      problems.push({ repoId: repo.id, problem: (err as Error).message });
    }
  }
  return { read, problems };
}

/** The commit that last changed a policy in a repository: its time and author. */
async function lastChange(ctx: OrchestratorContext, repo: RepoRecord, id: string): Promise<{ at: string; by: string } | null> {
  const out = await gitAsyncMaybe(["log", "-1", "--format=%cI%x00%an", `-S${JSON.stringify(id)}`, repo.head!, "--", TEAM_PREFIX_FILE], mirrorDir(ctx, repo.id));
  const [at, by] = (out ?? "").trim().split("\0");
  return at && by ? { at, by } : null;
}

/**
 * The developer policies across the configured repositories, joined by id. A policy every
 * repository carries is the workspace's; one only some carry belongs to their teams.
 */
export async function developerPolicies(ctx: OrchestratorContext): Promise<{ policies: (Policy & { repos: string[] })[]; problems: { repoId: string; problem: string }[] }> {
  const { read, problems } = await readRepoPolicies(ctx);
  const configured = (await ctx.store.listRepos(ctx.tenant)).filter((r) => inConfiguration(ctx, r.id));
  const byId = new Map<string, { policy: TeamFilePolicy; repos: RepoRecord[] }>();
  for (const { repo, policies } of read) {
    for (const policy of policies) {
      const seen = byId.get(policy.id);
      if (seen) seen.repos.push(repo);
      else byId.set(policy.id, { policy, repos: [repo] });
    }
  }
  const policies: (Policy & { repos: string[] })[] = [];
  for (const { policy, repos } of byId.values()) {
    const everywhere = repos.length === configured.length;
    const changes = (await Promise.all(repos.map((r) => lastChange(ctx, r, policy.id)))).filter((c): c is { at: string; by: string } => c !== null);
    const latest = changes.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
    policies.push({
      id: policy.id,
      name: policy.name,
      audience: everywhere ? { kind: "workspace" } : { kind: "teams", ids: [...new Set(repos.map((r) => r.team))] },
      rules: rulesFromStatements(policy.rules),
      updatedAt: latest?.at ?? null,
      updatedBy: latest?.by ?? null,
      repos: repos.map((r) => r.id),
    });
  }
  return { policies, problems };
}

/** The configured repositories a developer policy with this audience is written to. */
export async function targetRepos(ctx: OrchestratorContext, audience: Audience): Promise<RepoRecord[]> {
  const configured = (await ctx.store.listRepos(ctx.tenant)).filter((r) => inConfiguration(ctx, r.id));
  if (audience.kind === "workspace") return configured;
  if (audience.kind !== "teams") return [];
  const teams = new Set(configured.map((r) => r.team));
  const unknown = audience.ids.filter((id) => !teams.has(id));
  if (unknown.length) throw invalid(`the audience names ${unknown.join(", ")}, which has no repository in the orchestrator`);
  return configured.filter((r) => audience.ids.includes(r.team));
}

/** Whether a person may change a developer policy in every repository it touches. */
export function policyEditRefusal(user: Principal, repos: readonly RepoRecord[]): PolicyRefused | null {
  const denied = repos.filter((r) => !canEditTeam(user, r.team));
  return denied.length ? new PolicyRefused("forbidden", `only an admin or an owner of ${[...new Set(denied.map((r) => r.team))].join(", ")} can change this policy`, 403) : null;
}

function describe(policy: TeamFilePolicy): string[] {
  return policy.rules.map((r) => `- Blocks \`${r.resource}\` (${r.action}): ${r.reason}`);
}

/**
 * The team file with one policy put in place, added, or taken out, every other key and
 * policy kept. A file whose policies are already invalid is refused rather than rewritten:
 * the orchestrator would otherwise drop rules it cannot read.
 */
export async function policyChange(mirror: string, head: string, id: string, next: TeamFilePolicy | null): Promise<BuiltChange | null> {
  const { existing, json } = await teamFile(mirror, head);
  const current = json.policies ?? [];
  const problem = policiesProblem(current);
  if (problem) throw new ChangeRefused(`the policies in ${TEAM_PREFIX_FILE} are not valid (${problem}); fix them in the repository first, the orchestrator will not overwrite rules it cannot read`);
  const policies = current as TeamFilePolicy[];
  const at = policies.findIndex((p) => p.id === id);
  const was = at >= 0 ? policies[at]! : null;
  if (!next && !was) return null;
  const updated = next ? (was ? policies.map((p, i) => (i === at ? next : p)) : [...policies, next]) : policies.filter((_, i) => i !== at);
  // The file this writes is held to the plugin's own rule too: once merged, a policy the plugin
  // does not read makes every teammate's plugin set all the team's policies aside.
  const after = policiesProblem(updated);
  if (after) throw new ChangeRefused(`this change would leave the policies in ${TEAM_PREFIX_FILE} not valid (${after}); nothing is opened`);
  const result: Record<string, unknown> = { ...json, policies: updated };
  if (!updated.length) delete result.policies;
  const content = JSON.stringify(result, null, 2) + "\n";
  if (content === existing) return null;
  const name = (next ?? was)!.name;
  const verb = !next ? "remove" : was ? "change" : "add";
  return {
    files: [{ path: TEAM_PREFIX_FILE, content }],
    proposal: `chore: ${verb} the team policy ${name}`,
    body: next
      ? [`The team policy "${name}" (${id}) ${was ? "now reads" : "is added"}:`, "", ...describe(next), "", "It reaches every teammate's session once this is merged and their copy of the plugin updates."]
      : [`The team policy "${name}" (${id}) is removed; what it blocked is allowed again once this is merged and teammates' copies update.`],
    topic: `policy-${id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
  };
}

/**
 * Whether one member is in an audience. `tags` are the member's own, from the directory's
 * groups and the tags an admin set: a member with none of an audience's tags is outside a
 * `tags` audience and inside an `except-tags` one.
 */
export function inAudience(audience: Audience, user: Principal, tags: readonly string[]): boolean {
  switch (audience.kind) {
    case "workspace":
      return true;
    case "teams":
      return user.ownedTeams.some((t) => audience.ids.includes(t));
    case "members":
      return audience.ids.includes(user.id) || audience.ids.includes(user.email);
    case "except-members":
      return !audience.ids.includes(user.id) && !audience.ids.includes(user.email);
    case "service-accounts":
      return user.id.startsWith("service:") && (audience.ids.includes(user.id) || audience.ids.includes(user.id.slice(8)));
    case "tags":
      return audience.ids.some((tag) => tags.includes(tag));
    case "except-tags":
      return !audience.ids.some((tag) => tags.includes(tag));
  }
}

const matchesRepo = (pattern: string, id: string) => new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(id);

/** Where this calendar month (UTC) starts, the window a monthly budget counts. */
export function monthStart(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
}

/** How far back the largest cost a task reported is read, to hold a share of a budget for each task not yet finished. */
export const LARGEST_COST_DAYS = 90;

/**
 * What every budget reads, summed by the store per repository, team and starter: this
 * calendar month's spend, skill suggestions' included, the tasks still waiting or running,
 * whose cost nobody knows yet, and the largest cost a task reported lately, which each of
 * those holds.
 */
export interface BudgetLedger {
  spent: TaskSpendRow[];
  held: TaskSpendRow[];
  largest: TaskSpendRow[];
}

export async function budgetLedger(ctx: Pick<OrchestratorContext, "store" | "tenant">, now: Date = new Date()): Promise<BudgetLedger> {
  const [spent, extra, held, largest] = await Promise.all([
    ctx.store.taskSpendRows(ctx.tenant, { since: monthStart(now) }),
    ctx.store.extraSpendRows(ctx.tenant, { since: monthStart(now) }),
    ctx.store.taskSpendRows(ctx.tenant, { statuses: ["queued", "running"] }),
    ctx.store.taskSpendRows(ctx.tenant, { since: new Date(now.getTime() - LARGEST_COST_DAYS * 86_400_000).toISOString() }),
  ]);
  // A suggestion that reported no cost is no task that did, which is what `unknownCost` counts.
  return { spent: [...spent, ...extra.map((r) => ({ ...r, unknownCost: 0 }))], held, largest };
}

/** The ledger as a task that is itself running reads it: without the share it holds. */
export function withoutTask(ledger: BudgetLedger, task: Pick<TaskSpendRow, "repoId" | "team" | "createdBy">): BudgetLedger {
  const own = (r: TaskSpendRow) => r.repoId === task.repoId && r.team === task.team && r.createdBy === task.createdBy;
  return { ...ledger, held: ledger.held.map((r) => (own(r) ? { ...r, tasks: Math.max(0, r.tasks - 1) } : r)) };
}

/** What tasks cost as their agents reported it, and how many reported nothing. */
export function spendOf(rows: readonly TaskSpendRow[]): { usd: number; tasks: number; unknownCost: number } {
  return {
    usd: Math.round(rows.reduce((sum, r) => sum + r.usd, 0) * 100) / 100,
    tasks: rows.reduce((n, r) => n + r.tasks, 0),
    unknownCost: rows.reduce((n, r) => n + r.unknownCost, 0),
  };
}

/** Where one person stands against one monthly budget this calendar month (UTC). */
export interface BudgetStanding {
  policyId: string | null;
  policy: string;
  per: "audience" | "member";
  monthlyUsd: number;
  spentUsd: number;
  /** What the tasks still waiting or running hold of it, and how many there are. */
  reservedUsd: number;
  heldTasks: number;
  leftUsd: number;
  reached: boolean;
  /** This month's tasks that reported no cost, which the spend leaves out. */
  unknownCost: number;
}

type OrchestratorRules = { id?: string; name: string; audience: Audience; rules: readonly { kind: string }[] };

/**
 * A task not yet finished has cost nothing anyone knows, so it holds the largest cost a task
 * under the same budget reported lately; while none has reported one, it holds all that is
 * left, and the budget runs one task at a time. Otherwise a batch of tasks, all read against
 * the same spend, would start together and spend the budget many times over.
 */
function budgetStanding(policy: OrchestratorRules, rule: Extract<PolicyRuleInput, { kind: "task-budget" }>, user: Principal, ledger: BudgetLedger, repos: readonly RepoRecord[], creators: Creators): BudgetStanding {
  const under = (t: TaskSpendRow) => (rule.per === "member" ? t.createdBy === user.email : spentByAudience(policy.audience, t, repos, creators));
  const spend = spendOf(ledger.spent.filter(under));
  const heldTasks = ledger.held.filter(under).reduce((n, r) => n + r.tasks, 0);
  const largest = Math.max(0, ...ledger.largest.filter(under).map((r) => r.largestUsd));
  const each = largest > 0 ? largest : Math.max(0, rule.monthlyUsd - spend.usd);
  const reservedUsd = Math.round(heldTasks * each * 100) / 100;
  return {
    policyId: policy.id ?? null,
    policy: policy.name,
    per: rule.per,
    monthlyUsd: rule.monthlyUsd,
    spentUsd: spend.usd,
    reservedUsd,
    heldTasks,
    leftUsd: Math.max(0, Math.round((rule.monthlyUsd - spend.usd - reservedUsd) * 100) / 100),
    reached: spend.usd + reservedUsd >= rule.monthlyUsd,
    unknownCost: spend.unknownCost,
  };
}

/** Every monthly task budget that applies to this person, as the start of their next task would read it, from `budgetLedger`. */
export function budgetsFor(policies: readonly OrchestratorRules[], user: Principal, tags: readonly string[], ledger: BudgetLedger, repos: readonly RepoRecord[], creators: Creators): BudgetStanding[] {
  return policies
    .filter((p) => inAudience(p.audience, user, tags))
    .flatMap((p) => p.rules.filter((r) => r.kind === "task-budget").map((r) => budgetStanding(p, r as Extract<PolicyRuleInput, { kind: "task-budget" }>, user, ledger, repos, creators)));
}

/**
 * The lowest permission mode the orchestrator's policies let this person's tasks on this repository
 * run in, and the policy that sets it; null when no policy sets one. Every ceiling that covers
 * the person and names the repository holds, so the lowest of them is the one that counts.
 */
export function ceilingFor(policies: readonly OrchestratorRules[], user: Principal, tags: readonly string[], repo: Pick<RepoRecord, "id">): { mode: PermissionMode; policy: { id: string | null; name: string } } | null {
  let lowest: { mode: PermissionMode; policy: { id: string | null; name: string } } | null = null;
  for (const policy of policies) {
    if (!inAudience(policy.audience, user, tags)) continue;
    for (const rule of policy.rules) {
      if (rule.kind !== "task-mode") continue;
      const r = rule as Extract<PolicyRuleInput, { kind: "task-mode" }>;
      if (!r.repos.some((p) => matchesRepo(p, repo.id))) continue;
      if (!lowest || modeRank(r.ceiling) < modeRank(lowest.mode)) lowest = { mode: r.ceiling, policy: { id: policy.id ?? null, name: policy.name } };
    }
  }
  return lowest;
}

/**
 * Whether a task on this repository runs with its starter's own Claude Code setup on their machine
 * (memory, CLAUDE.md, skills, plugins, MCP servers, hooks, settings), or with their sign-in and the
 * team's skills alone. Allowed unless a rule covering the person and the repository says not; a
 * "not" holds over any "allowed", as a ceiling does.
 */
export function ownSetupFor(policies: readonly OrchestratorRules[], user: Principal, tags: readonly string[], repo: Pick<RepoRecord, "id">): { allowed: boolean; policy: { id: string | null; name: string } | null } {
  for (const policy of policies) {
    if (!inAudience(policy.audience, user, tags)) continue;
    for (const rule of policy.rules) {
      if (rule.kind !== "own-setup") continue;
      const r = rule as Extract<PolicyRuleInput, { kind: "own-setup" }>;
      if (!r.allowed && r.repos.some((p) => matchesRepo(p, repo.id))) return { allowed: false, policy: { id: policy.id ?? null, name: policy.name } };
    }
  }
  return { allowed: true, policy: null };
}

/** The mode a start that names none runs in under the ceiling that covers it: Auto, or the ceiling where it is lower. */
export function unnamedMode(policies: readonly OrchestratorRules[], user: Principal, tags: readonly string[], repo: Pick<RepoRecord, "id">): PermissionMode {
  const ceiling = ceilingFor(policies, user, tags, repo);
  return ceiling ? lowerMode(DEFAULT_MODE, ceiling.mode) : DEFAULT_MODE;
}

/**
 * Why the orchestrator's own policies refuse this person a task on this repository, or null. A
 * rule of a kind this orchestrator does not know refuses rather than passes: a newer orchestrator's
 * rule read as nothing would lift what it was written to hold. Repository access is decided
 * by the last matching rule, and a repository no rule names stays open. A budget counts what
 * agents reported this calendar month (UTC) and what the tasks not yet finished hold of it
 * (`budgetLedger`); a finished task that reported no cost does not count. A task is refused above
 * the lowest ceiling that covers it, read in the mode it names or, naming none, the one it runs
 * in: a saved ceiling holds for every start, never only for callers that pass a mode.
 */
export function taskStartRefusal(policies: readonly OrchestratorRules[], user: Principal, tags: readonly string[], repo: RepoRecord, ledger: BudgetLedger, repos: readonly RepoRecord[], creators: Creators, mode?: PermissionMode): PolicyRefused | null {
  let access: { effect: "allow" | "deny"; policy: { id: string | null; name: string } } | null = null;
  for (const policy of policies) {
    if (!inAudience(policy.audience, user, tags)) continue;
    for (const rule of policy.rules) {
      if (rule.kind === "repo-access") {
        const r = rule as Extract<PolicyRuleInput, { kind: "repo-access" }>;
        if (r.repos.some((p) => matchesRepo(p, repo.id))) access = { effect: r.effect, policy: { id: policy.id ?? null, name: policy.name } };
      } else if (rule.kind === "task-budget") {
        const standing = budgetStanding(policy, rule as Extract<PolicyRuleInput, { kind: "task-budget" }>, user, ledger, repos, creators);
        if (standing.reached) {
          const held = standing.heldTasks ? `, and $${standing.reservedUsd.toFixed(2)} is held for ${standing.heldTasks} task${standing.heldTasks === 1 ? "" : "s"} still waiting or running` : "";
          return new PolicyRefused("task-budget", `The task budget in "${policy.name}" is spent: $${standing.spentUsd.toFixed(2)} of $${standing.monthlyUsd.toFixed(2)} this month${standing.per === "member" ? " for you" : ""}${held}.`, 409, { id: policy.id ?? null, name: policy.name });
        }
      } else if (rule.kind !== "task-mode" && rule.kind !== "own-setup" && !isDeveloperKind(rule.kind)) {
        return new PolicyRefused("policy-unknown", `"${policy.name}" holds a rule of a kind this orchestrator does not know (${JSON.stringify(rule.kind)}), so no task starts under it until the orchestrator is updated or the rule is removed.`, 409, { id: policy.id ?? null, name: policy.name });
      }
    }
  }
  if (access?.effect === "deny") return new PolicyRefused("repo-access", `"${access.policy.name}" does not let you start tasks on ${repo.name}.`, 403, access.policy);
  const asked = mode ?? DEFAULT_MODE;
  const ceiling = ceilingFor(policies, user, tags, repo);
  if (ceiling && modeRank(asked) > modeRank(ceiling.mode)) {
    // Lowering is always free, so the refusal names the mode to choose instead; an agent that
    // cannot ask its starter is refused that mode where the task starts, not here.
    return new PolicyRefused("task-mode", `"${ceiling.policy.name}" lets tasks on ${repo.name} run up to ${MODE_LABEL[ceiling.mode]}; this task ${mode ? "asked for" : "runs in"} ${MODE_LABEL[asked]}. Start it in ${MODE_LABEL[ceiling.mode]} or below.`, 403, ceiling.policy);
  }
  return null;
}

function spentByAudience(audience: Audience, task: Pick<TaskSpendRow, "createdBy" | "repoId" | "team">, repos: readonly RepoRecord[], creators: Creators): boolean {
  const creator = creators.get(task.createdBy);
  const named = audience.kind !== "workspace" && (audience.ids.includes(task.createdBy) || (creator !== undefined && audience.ids.includes(creator.id)));
  const tagged = audience.kind !== "workspace" && creator !== undefined && audience.ids.some((tag) => creator.tags.includes(tag));
  switch (audience.kind) {
    case "workspace":
      return true;
    case "teams":
      return audience.ids.includes(repos.find((r) => r.id === task.repoId)?.team ?? task.team);
    case "members":
      return named;
    case "except-members":
      return !named;
    case "tags":
      return tagged;
    case "except-tags":
      return !tagged;
    case "service-accounts":
      return creator !== undefined && creator.id.startsWith("service:") && (audience.ids.includes(creator.id) || audience.ids.includes(creator.id.slice(8)));
  }
}

/** Who started each task, by the address a task records: a person's id and tags, or a service account's id. */
export type Creators = ReadonlyMap<string, { id: string; tags: readonly string[] }>;

/** The organization's people and service accounts by the address their tasks record, for counting an audience's spend. */
export async function taskCreators(ctx: OrchestratorContext): Promise<Creators> {
  const tags = await memberTags(ctx.store, ctx.tenant);
  const creators = new Map<string, { id: string; tags: readonly string[] }>();
  for (const u of await ctx.store.listUsers(ctx.tenant)) creators.set(u.email, { id: u.id, tags: tags.get(u.id)?.map((t) => t.tag) ?? [] });
  for (const a of await ctx.store.listServiceAccounts(ctx.tenant)) creators.set(`${a.id}@service-account.invalid`, { id: serviceId(a.id), tags: [] });
  return creators;
}

