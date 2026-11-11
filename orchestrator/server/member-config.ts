import { Hono } from "hono";
import type { OrchestratorContext } from "./app.js";
import { inConfiguration, mirrorDir } from "./app.js";
import { principalOf } from "./accounts.js";
import { manages } from "./auth.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { memberTags } from "./directory.js";
import { OrchestratorError } from "./errors.js";
import { readInventory } from "./inventory.js";
import { mcpToolPart, patternMatches, policyDenial } from "./plugin.js";
import type { PolicyRule } from "./plugin.js";
import { checkPolicy, isDeveloperPolicy, budgetLedger, PolicyRefused, targetRepos, taskCreators, taskStartRefusal, teamFilePolicy, unnamedMode } from "./policies.js";
import type { PolicyDraft } from "./policies.js";
import { orchestratorPolicies } from "./policy-routes.js";
import type { RepoRecord } from "./store.js";
import { taskPolicy } from "./tasks/task-policy.js";
import type { MemberConfig, Removal, RepoReach } from "../shared/member-config.js";

/**
 * One repository as it reaches a teammate: what it ships, and what its rules take away, read
 * with the same rules and matching a task's agent is given at that commit. `extra` holds
 * statements a draft would add, so a preview is the same reading with the draft in place.
 */
async function reach(ctx: OrchestratorContext, repo: RepoRecord, extra: readonly PolicyRule[]): Promise<RepoReach> {
  const mirror = mirrorDir(ctx, repo.id);
  const inventory = await readInventory(mirror, repo.head!);
  const read = await taskPolicy(mirror, repo.head!);
  const problem = "refused" in read ? read.refused : null;
  const rules = [...("refused" in read ? [] : read), ...extra];
  const removal = (rule: PolicyRule | null): Removal | null => (rule ? { resource: rule.resource, reason: rule.reason } : null);
  const mcpRules = rules.filter((r) => r.action === "mcp.use").map((r) => ({ rule: r, parts: r.resource.slice("mcp:".length).split("/").map(mcpToolPart) }));
  return {
    repoId: repo.id,
    name: repo.name,
    team: repo.team,
    skills: inventory.skills.map((s) => ({ slug: s.slug, removedBy: removal(policyDenial(rules, { tool_name: "Skill", tool_input: { skill: s.slug } })) })),
    mcpServers: inventory.mcpServers.map((m) => {
      const own = mcpRules.filter(({ parts }) => patternMatches(parts[0]!, mcpToolPart(m.name)));
      const whole = own.filter(({ parts }) => parts[1] === undefined || parts[1] === "*").at(-1);
      return {
        name: m.name,
        removedBy: removal(whole?.rule ?? null),
        tools: own.filter(({ parts }) => parts[1] !== undefined && parts[1] !== "*").map(({ rule, parts }) => ({ tool: parts[1]!, ...removal(rule)! })),
      };
    }),
    commands: inventory.commands.map((c) => c.name),
    tools: rules.filter((r) => r.action === "tool.use").map((r) => removal(r)!),
    problem,
  };
}

/** Teams reach a member through the teams they belong to; a repository outside the configuration or never read reaches nobody. */
async function memberConfig(ctx: OrchestratorContext, user: Principal, draft: PolicyDraft | null): Promise<MemberConfig> {
  const repos = await ctx.store.listRepos(ctx.tenant);
  const live = repos.filter((r) => inConfiguration(ctx, r.id) && r.head);
  const tags = (await memberTags(ctx.store, ctx.tenant)).get(user.id)?.map((t) => t.tag) ?? [];
  const developer = draft && isDeveloperPolicy(draft) ? draft : null;
  const drafted = developer ? new Set((await targetRepos(ctx, developer.audience)).map((r) => r.id)) : new Set<string>();
  const statements = developer ? teamFilePolicy("pol_preview", developer).rules : [];
  const own = live.filter((r) => user.ownedTeams.includes(r.team));
  const policies = [...(await orchestratorPolicies(ctx)), ...(draft && !developer ? [draft] : [])];
  const ledger = await budgetLedger(ctx);
  const creators = await taskCreators(ctx);
  return {
    member: { id: user.id, name: user.name, email: user.email },
    teams: [...user.ownedTeams].sort(),
    tags,
    repos: await Promise.all(own.map((r) => reach(ctx, r, drafted.has(r.id) ? statements : []))),
    tasks: live.map((r) => ({ repoId: r.id, name: r.name, refusal: taskStartRefusal(policies, user, tags, r, ledger, repos, creators, unnamedMode(policies, user, tags, r))?.message ?? null })),
  };
}

export function memberConfigRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();

  const memberFor = async (me: Principal, id: string): Promise<Principal> => {
    if (id !== me.id && !manages(me)) throw new OrchestratorError("forbidden", "only an owner or an admin reads another member's configuration", 403);
    const user = (await ctx.store.listUsers(ctx.tenant)).find((u) => u.id === id);
    if (!user) throw new OrchestratorError("not-found", "no such member", 404);
    return principalOf(ctx.store, user);
  };

  // What reaches one member's sessions from their teams, and where the orchestrator lets them start a task.
  app.get("/api/members/:id/config", async (c) => c.json(await memberConfig(ctx, await memberFor(c.get("user"), c.req.param("id")), null)));

  // The same reading with a policy draft in place, for the editor's member preview; nothing is saved.
  app.post("/api/members/:id/config/preview", async (c) => {
    const user = await memberFor(c.get("user"), c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as { audience?: unknown; rules?: unknown };
    let draft: PolicyDraft;
    try {
      draft = checkPolicy({ name: "preview", audience: body.audience, rules: body.rules });
    } catch (err) {
      if (err instanceof PolicyRefused) throw new OrchestratorError(err.code, err.message, err.status);
      throw err;
    }
    return c.json({ before: await memberConfig(ctx, user, null), after: await memberConfig(ctx, user, draft) });
  });

  return app;
}
