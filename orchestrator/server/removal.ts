import { Hono } from "hono";
import type { OrchestratorContext } from "./app.js";
import { inConfiguration, mirrorDir, NOT_CONFIGURED } from "./app.js";
import type { OrchestratorEnv } from "./auth.js";
import { canEditTeam } from "./auth.js";
import type { ChangeInput } from "./changes.js";
import { readInventory, readTeamRecordAsync } from "./inventory.js";
import { patternMatches } from "./plugin.js";
import type { PolicyDraft } from "./policies.js";
import { developerPolicies } from "./policies.js";

/** How far back a removal looks for use, as the orchestrator's other usage views default to. */
export const REMOVAL_DAYS = 30;

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface RemovalImpact {
  subject: string;
  /**
   * Skill use in the last 30 days, as teammates' machines reported it: `counted` is false when
   * the team is not asked to report, so no count means nobody knows rather than nobody used
   * it. An MCP server's use is never reported, so it is null for one.
   */
  usage: { counted: boolean; days: number; count: number; lastHour: string | null; daily: { day: string; count: number }[] } | null;
  /** The team policies that already block it, whose removal would allow it again. */
  blockedBy: { id: string; name: string }[];
  /** The change that deletes it, as `POST /api/repos/:id/changes` takes it. */
  remove: ChangeInput;
  /**
   * The team policy that blocks it in every teammate's session and leaves it in the
   * repository, as `POST /api/policies` takes it; null when a policy blocks it already.
   */
  disable: PolicyDraft | null;
}

/**
 * What removing one skill or MCP server from a repository takes away, and the policy that
 * would block it instead. Use is read from the counts teammates' machines already send, and
 * nothing is changed: removing opens a request, and disabling opens one through the policy
 * routes, so each is reviewed as any other change is.
 */
export function removalRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();

  app.get("/api/repos/:id/removal", async (c) => {
    const id = c.req.param("id");
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo) return c.json({ error: "unknown repository" }, 404);
    if (!canEditTeam(c.get("user"), repo.team)) return c.json({ error: "only an admin or this team's owner removes from this repository" }, 403);
    if (!inConfiguration(ctx, id)) return c.json({ error: NOT_CONFIGURED }, 409);
    if (!repo.head) return c.json({ error: "this repository has not been read yet" }, 409);
    const skill = c.req.query("skill");
    const mcp = c.req.query("mcp");
    if ((skill === undefined) === (mcp === undefined)) return c.json({ error: "name one skill or one MCP server" }, 400);

    const mirror = mirrorDir(ctx, id);
    const inventory = await readInventory(mirror, repo.head, c.req.raw.signal);
    const found = skill !== undefined ? inventory.skills.some((s) => s.slug === skill) : inventory.mcpServers.some((m) => m.name === mcp);
    if (!found) return c.json({ error: skill !== undefined ? `there is no skill ${skill} in this repository` : `there is no MCP server ${mcp} in this repository` }, 404);
    const name = (skill ?? mcp)!;
    const subject = skill !== undefined ? `skill:${name}` : `mcp:${name}`;

    const { policies } = await developerPolicies(ctx);
    const blockedBy = policies
      .filter((p) => p.repos.includes(id))
      .filter((p) => p.rules.some((r) => (r.kind === (skill !== undefined ? "skill-access" : "mcp-access")) && "resources" in r && r.resources.some((pattern) => blocks(pattern, subject))))
      .map((p) => ({ id: p.id, name: p.name }));

    let usage: RemovalImpact["usage"] = null;
    if (skill !== undefined) {
      const since = new Date(Date.now() - REMOVAL_DAYS * 86_400_000).toISOString().slice(0, 13);
      const total = (await ctx.store.usage(ctx.tenant, since, id)).find((u) => u.skill === skill);
      const daily = (await ctx.store.usageDaily(ctx.tenant, since, id)).filter((u) => u.skill === skill).map((u) => ({ day: u.day, count: u.count }));
      const counted = Boolean((await readTeamRecordAsync(mirror, repo.head))?.usageEndpoint);
      usage = { counted, days: REMOVAL_DAYS, count: total?.count ?? 0, lastHour: total?.lastHour ?? null, daily };
    }

    const impact: RemovalImpact = {
      subject,
      usage,
      blockedBy,
      remove: skill !== undefined ? { kind: "skill.delete", slug: name } : { kind: "mcp.remove", name },
      disable: blockedBy.length
        ? null
        : {
            name: `Disable ${name}`,
            audience: { kind: "teams", ids: [repo.team] },
            rules: [{ kind: skill !== undefined ? "skill-access" : "mcp-access", effect: "deny", resources: [subject], reason: `${name} is disabled for ${repo.team}; ask the team's owner to turn it back on` }],
          },
    };
    return c.json(impact);
  });

  return app;
}

/** Whether a rule's resource pattern blocks this subject: a server rule `mcp:x` holds every tool of x, and `mcp:x/tool` only that tool. */
function blocks(pattern: string, subject: string): boolean {
  if (!subject.startsWith("mcp:")) return patternMatches(pattern, subject);
  return !pattern.includes("/") && patternMatches(pattern, subject);
}
