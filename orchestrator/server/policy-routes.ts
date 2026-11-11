import { Hono } from "hono";
import type { Context } from "hono";
import { principalOf } from "./accounts.js";
import { memberTags } from "./directory.js";
import type { OrchestratorContext } from "./app.js";
import { mirrorDir } from "./app.js";
import { manages } from "./auth.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { proposedBranch, teamNaming } from "./branches.js";
import { ChangeRefused, prepareBuilt } from "./changes.js";
import type { PreparedChange } from "./changes.js";
import type { RequestRecord } from "./forge/types.js";
import { gitAsyncMaybe, RepositoryGone } from "./git.js";
import { claudeDenyRules, commitMessagePrefix, commitSubject } from "./plugin.js";
import type { Audience, Policy, PolicyDraft } from "./policies.js";
import { budgetsFor, checkPolicy, developerPolicies, inAudience, isDeveloperPolicy, budgetLedger, monthStart, newPolicyId, policyChange, policyEditRefusal, PolicyRefused, spendOf, targetRepos, taskCreators, teamFilePolicy } from "./policies.js";
import { recordEvent } from "./events.js";
import { inRequestTurn, propose, RequestRefused } from "./propose.js";
import type { RepoRecord } from "./store.js";

/**
 * Where the orchestrator keeps its own policies (task budgets and repository access), which take
 * effect at once and never reach a teammate. The store holds the text; it is read back
 * through the same checks a person's draft passes.
 */
export interface PolicyRecord {
  tenant: string;
  id: string;
  name: string;
  audience: string;
  rules: string;
  updatedAt: string;
  updatedBy: string;
}

export interface PolicyStore {
  listPolicies(tenant: string): Promise<PolicyRecord[]>;
  putPolicy(record: PolicyRecord): Promise<void>;
  deletePolicy(tenant: string, id: string): Promise<boolean>;
}

const policyStore = (ctx: OrchestratorContext): PolicyStore | null => {
  const store = ctx.store as Partial<PolicyStore>;
  return store.listPolicies && store.putPolicy && store.deletePolicy ? (store as PolicyStore) : null;
};

/**
 * The orchestrator's own policies as stored. One whose text no longer passes the checks is kept
 * with its rules as written, so the evaluator refuses under a rule it does not know rather
 * than dropping it.
 */
export async function orchestratorPolicies(ctx: OrchestratorContext): Promise<Policy[]> {
  const store = policyStore(ctx);
  if (!store) return [];
  return (await store.listPolicies(ctx.tenant)).map((r) => {
    let parsed: { audience: Audience; rules: Policy["rules"] };
    try {
      parsed = checkPolicy({ name: r.name, audience: JSON.parse(r.audience), rules: JSON.parse(r.rules) });
    } catch {
      parsed = { audience: { kind: "workspace" }, rules: [{ kind: "unreadable" } as unknown as Policy["rules"][number]] };
    }
    return { id: r.id, name: r.name, audience: parsed.audience, rules: parsed.rules, updatedAt: r.updatedAt, updatedBy: r.updatedBy };
  });
}

/**
 * A body that names a policy other than the one the address names is refused rather than read
 * as either: the address decides which team file entry is written, and a mismatch means the
 * screen and the request disagree about what is being changed.
 */
function idMismatch(id: string, raw: unknown): PolicyRefused | null {
  const named = raw && typeof raw === "object" ? (raw as { id?: unknown }).id : undefined;
  return named !== undefined && named !== id ? new PolicyRefused("policy-invalid", `the policy in the body is ${JSON.stringify(named)}, but the address names ${JSON.stringify(id)}`) : null;
}

function refused(c: Context, err: unknown) {
  if (err instanceof RepositoryGone) throw err;
  if (err instanceof PolicyRefused) return c.json({ error: err.message, code: err.code }, err.status);
  if (err instanceof ChangeRefused) return c.json({ error: err.message, code: "change-refused" }, 400);
  if (err instanceof RequestRefused) return c.json({ error: err.message, code: "request-refused" }, 409);
  throw err;
}

interface Plan {
  repo: RepoRecord;
  change: "add" | "change" | "remove";
  built: NonNullable<Awaited<ReturnType<typeof policyChange>>>;
}

/** What saving or removing a developer policy changes, repository by repository; an unchanged repository is left out. */
async function plan(ctx: OrchestratorContext, user: Principal, id: string, draft: PolicyDraft | null): Promise<Plan[]> {
  const { policies } = await developerPolicies(ctx);
  const holding = new Set(policies.find((p) => p.id === id)?.repos ?? []);
  const targets = draft ? await targetRepos(ctx, draft.audience) : [];
  const touched = [...targets, ...(await ctx.store.listRepos(ctx.tenant)).filter((r) => holding.has(r.id) && !targets.some((t) => t.id === r.id))];
  const denied = policyEditRefusal(user, touched);
  if (denied) throw denied;
  const plans: Plan[] = [];
  for (const repo of touched) {
    if (!repo.head) throw new PolicyRefused("not-synced", `${repo.name} has not been read yet`, 409);
    const next = draft && targets.some((t) => t.id === repo.id) ? teamFilePolicy(id, draft) : null;
    const built = await policyChange(mirrorDir(ctx, repo.id), repo.head, id, next);
    if (built) plans.push({ repo, change: !next ? "remove" : holding.has(repo.id) ? "change" : "add", built });
  }
  if (!plans.length) throw new PolicyRefused("unchanged", "nothing changes: every repository already holds this policy as written", 409);
  return plans;
}

/**
 * Opens one request per repository the save changes. Every request is prepared first, with
 * the person's confirmed message and the branch they chose, against the heads they saw; only
 * then do any open, so a message or a branch the forge's rules refuse opens nothing.
 */
async function openRequests(ctx: OrchestratorContext, user: Principal, plans: Plan[], body: { message?: unknown; branches?: unknown; baseShas?: unknown }): Promise<{ requests: RequestRecord[]; failed: { repoId: string; error: string }[] }> {
  const baseShas = (body.baseShas ?? {}) as Record<string, unknown>;
  const branches = (body.branches ?? {}) as Record<string, unknown>;
  const moved = plans.filter((p) => baseShas[p.repo.id] !== p.repo.head);
  if (moved.length) throw new PolicyRefused("stale", `${moved.map((p) => p.repo.name).join(", ")} changed since this page was opened; reload and save again`, 409);
  const prepared: { plan: Plan; change: PreparedChange }[] = [];
  for (const p of plans) {
    const mirror = mirrorDir(ctx, p.repo.id);
    prepared.push({ plan: p, change: await prepareBuilt(mirror, p.repo.head!, p.built, body.message, user.name, await teamNaming(mirror, p.repo.head!), branches[p.repo.id]) });
  }
  const requests: RequestRecord[] = [];
  const failed: { repoId: string; error: string }[] = [];
  for (const { plan: p, change } of prepared) {
    try {
      requests.push(await inRequestTurn(ctx, p.repo.id, () => propose(ctx, p.repo, user, change)));
    } catch (err) {
      if (err instanceof RepositoryGone) throw err;
      failed.push({ repoId: p.repo.id, error: (err as Error).message });
    }
  }
  return { requests, failed };
}

export function policyRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();

  app.get("/api/policies", async (c) => {
    const { policies, problems } = await developerPolicies(ctx);
    return c.json({ policies: [...policies, ...(await orchestratorPolicies(ctx))], problems, orchestratorRulesStored: policyStore(ctx) !== null });
  });

  // What a save would open, repository by repository, for the person to confirm: the commit
  // title the orchestrator proposes and the branch, under each repository's own naming.
  app.post("/api/policies/proposal", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { id?: unknown; policy?: unknown; remove?: unknown };
      const id = typeof body.id === "string" ? body.id : newPolicyId();
      const mismatch = typeof body.id === "string" ? idMismatch(id, body.policy) : null;
      if (mismatch) throw mismatch;
      const draft = body.remove === true ? null : checkPolicy(body.policy);
      if (draft && !isDeveloperPolicy(draft)) return c.json({ applies: "now" });
      const plans = await plan(ctx, c.get("user"), id, draft);
      const repos = await Promise.all(
        plans.map(async (p) => {
          const naming = await teamNaming(mirrorDir(ctx, p.repo.id), p.repo.head!);
          return { repoId: p.repo.id, name: p.repo.name, head: p.repo.head, change: p.change, proposal: commitSubject(commitMessagePrefix(naming.commitPrefix), p.built.proposal), branch: proposedBranch(p.built.topic, naming) };
        }),
      );
      return c.json({ applies: "request", repos });
    } catch (err) {
      return refused(c, err);
    }
  });

  const save = async (c: Context<OrchestratorEnv>, id: string, existing: boolean) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { policy?: unknown; message?: unknown; branches?: unknown; baseShas?: unknown };
      const mismatch = existing ? idMismatch(id, body.policy) : null;
      if (mismatch) throw mismatch;
      const draft = checkPolicy(body.policy);
      const user = c.get("user");
      const kept = existing ? (await orchestratorPolicies(ctx)).find((p) => p.id === id) : undefined;
      if (isDeveloperPolicy(draft)) {
        if (kept) throw new PolicyRefused("policy-mixed", "this policy holds the orchestrator's own rules; a rule that reaches teammates' sessions goes in a policy of its own");
        if (existing && !(await developerPolicies(ctx)).policies.some((p) => p.id === id)) throw new PolicyRefused("unknown-policy", "unknown policy", 404);
        const { requests, failed } = await openRequests(ctx, user, await plan(ctx, user, id, draft), body);
        return c.json({ saved: "request", id, requests, failed }, failed.length && !requests.length ? 409 : 200);
      }
      if (!manages(user)) throw new PolicyRefused("forbidden", "only an owner or an admin sets the orchestrator's own rules", 403);
      const store = policyStore(ctx);
      if (!store) throw new PolicyRefused("policy-store", "This orchestrator's database does not keep its own rules yet; update the orchestrator.", 409);
      if (existing && !kept) throw new PolicyRefused("unknown-policy", "unknown policy", 404);
      const policy: Policy = { id, ...draft, updatedAt: new Date().toISOString(), updatedBy: user.email };
      await store.putPolicy({ tenant: ctx.tenant, id, name: policy.name, audience: JSON.stringify(policy.audience), rules: JSON.stringify(policy.rules), updatedAt: policy.updatedAt!, updatedBy: policy.updatedBy! });
      await recordEvent(ctx, user, "policy.saved", { subject: `policy:${id}`, detail: `${kept ? "changed" : "added"} the orchestrator policy "${policy.name}" for ${audienceText(policy.audience)}: ${policy.rules.map(ruleText).join("; ")}` });
      return c.json({ saved: "applied", policy });
    } catch (err) {
      return refused(c, err);
    }
  };

  app.post("/api/policies", (c) => save(c, newPolicyId(), false));
  app.put("/api/policies/:id", (c) => save(c, c.req.param("id"), true));

  app.delete("/api/policies/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const user = c.get("user");
      const store = policyStore(ctx);
      const kept = (await orchestratorPolicies(ctx)).find((p) => p.id === id);
      if (kept) {
        if (!manages(user)) throw new PolicyRefused("forbidden", "only an owner or an admin sets the orchestrator's own rules", 403);
        await store!.deletePolicy(ctx.tenant, id);
        await recordEvent(ctx, user, "policy.deleted", { subject: `policy:${id}`, detail: `removed the orchestrator policy "${kept.name}"` });
        return c.json({ saved: "applied", removed: id });
      }
      const { policies } = await developerPolicies(ctx);
      if (!policies.some((p) => p.id === id)) throw new PolicyRefused("unknown-policy", "unknown policy", 404);
      const body = (await c.req.json().catch(() => ({}))) as { message?: unknown; branches?: unknown; baseShas?: unknown };
      const { requests, failed } = await openRequests(ctx, user, await plan(ctx, user, id, null), body);
      return c.json({ saved: "request", id, requests, failed }, failed.length && !requests.length ? 409 : 200);
    } catch (err) {
      return refused(c, err);
    }
  });

  // The team's developer policies as Claude Code managed settings, for an organization that
  // enforces them through MDM or its own settings delivery. The orchestrator hands the file over and
  // delivers it nowhere.
  app.get("/api/policies/export", async (c) => {
    if (!manages(c.get("user"))) return c.json({ error: "only an owner or an admin exports the policies", code: "forbidden" }, 403);
    const repoId = c.req.query("repo");
    const { policies } = await developerPolicies(ctx);
    const repo = repoId ? await ctx.store.getRepo(ctx.tenant, repoId) : null;
    if (repoId && !repo?.head) return c.json({ error: "unknown repository", code: "unknown-repository" }, 404);
    const chosen = policies.filter((p) => (repo ? p.repos.includes(repo.id) : p.audience.kind === "workspace"));
    const plugin = repo ? await pluginName(mirrorDir(ctx, repo.id), repo.head!) : undefined;
    const { deny, approximate, notMapped } = claudeDenyRules(chosen.flatMap((p) => teamFilePolicy(p.id, p).rules), plugin);
    const settings = { permissions: { deny } };
    if (c.req.query("download") === "1") {
      return c.body(JSON.stringify(settings, null, 2) + "\n", 200, { "content-type": "application/json; charset=utf-8", "content-disposition": 'attachment; filename="managed-settings.json"' });
    }
    return c.json({ settings, policies: chosen.map((p) => p.id), approximate, notMapped, paths: MANAGED_SETTINGS_PATHS });
  });

  // The monthly task budgets that apply to the person asking: spent this month, what is left,
  // and which policy each comes from, as the start of their next task reads them.
  app.get("/api/policies/current-budgets", async (c) => {
    const user = c.get("user");
    const tags = (await memberTags(ctx.store, ctx.tenant)).get(user.id)?.map((t) => t.tag) ?? [];
    const now = new Date();
    const budgets = budgetsFor(await orchestratorPolicies(ctx), user, tags, await budgetLedger(ctx, now), await ctx.store.listRepos(ctx.tenant), await taskCreators(ctx));
    return c.json({ month: now.toISOString().slice(0, 7), budgets });
  });

  // Who a draft would cover and what tasks under it cost in the last 30 days and this month, before saving.
  app.post("/api/policies/preview", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { audience?: unknown; rules?: unknown };
      const draft = checkPolicy({ name: "preview", audience: body.audience, rules: body.rules });
      const users = await ctx.store.listUsers(ctx.tenant);
      const tagged = await memberTags(ctx.store, ctx.tenant);
      const members = [];
      for (const u of users) {
        const principal = await principalOf(ctx.store, u);
        if (inAudience(draft.audience, principal, tagged.get(u.id)?.map((t) => t.tag) ?? [])) members.push({ id: principal.id, name: principal.name, email: principal.email });
      }
      const repos = isDeveloperPolicy(draft) ? await targetRepos(ctx, draft.audience) : (await ctx.store.listRepos(ctx.tenant)).filter((r) => repoNamed(draft, r.id));
      const emails = members.map((m) => m.email);
      const now = new Date();
      // The last 30 days and this calendar month are two windows: a budget is a month's, and
      // early in a month the two differ by most of the previous one. What skill suggestions cost
      // counts beside the tasks' own, as the budget counts it.
      const spentSince = async (since: string) => spendOf([...(await ctx.store.taskSpendRows(ctx.tenant, { createdBy: emails, since })), ...(await ctx.store.extraSpendRows(ctx.tenant, { createdBy: emails, since }))]);
      const days = await spentSince(new Date(now.getTime() - 30 * 86_400_000).toISOString());
      const month = await spentSince(monthStart(now));
      const usage = (spend: ReturnType<typeof spendOf>) => ({ tasks: spend.tasks, usd: spend.tasks ? spend.usd : null, unknownCost: spend.unknownCost });
      return c.json({
        members: members.map(({ id, name }) => ({ id, name })),
        teams: [...new Set(repos.map((r) => r.team))],
        repos: repos.map((r) => r.id),
        usage30d: usage(days),
        usageThisMonth: usage(month),
      });
    } catch (err) {
      return refused(c, err);
    }
  });

  return app;
}

/** Where Claude Code reads managed settings on each system, for the person placing the file. */
export const MANAGED_SETTINGS_PATHS = {
  macos: "/Library/Application Support/ClaudeCode/managed-settings.json",
  linux: "/etc/claude-code/managed-settings.json",
  windows: "C:\\Program Files\\ClaudeCode\\managed-settings.json",
};

/** The team plugin's name, which a skill rule also names it by in Claude Code; undefined when the manifest does not say. */
async function pluginName(mirror: string, head: string): Promise<string | undefined> {
  try {
    const name = JSON.parse((await gitAsyncMaybe(["show", `${head}:.claude-plugin/plugin.json`], mirror)) ?? "{}").name;
    return typeof name === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Who a policy covers, as the log says it: the kind and the ids, never anything else the draft carried. */
function audienceText(audience: Audience): string {
  return audience.kind === "workspace" ? "the whole organization" : `${audience.kind} ${audience.ids.join(", ")}`;
}

/** One orchestrator rule as the log says it. */
function ruleText(rule: Policy["rules"][number]): string {
  if (rule.kind === "task-budget") return `a task budget of $${rule.monthlyUsd.toFixed(2)} a month ${rule.per === "member" ? "for each member" : "for the audience"}`;
  if (rule.kind === "repo-access") return `${rule.effect === "allow" ? "allows" : "denies"} tasks on ${rule.repos.join(", ")}`;
  if (rule.kind === "task-mode") return `lets tasks on ${rule.repos.join(", ")} run up to ${rule.ceiling}`;
  if (rule.kind === "own-setup") return `${rule.allowed ? "lets" : "keeps"} tasks on ${rule.repos.join(", ")} ${rule.allowed ? "use" : "from"} the starter's own Claude Code setup`;
  return rule.kind;
}

function repoNamed(draft: PolicyDraft, id: string): boolean {
  return draft.rules.some((r) => r.kind === "repo-access" && r.repos.some((p) => new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(id)));
}
