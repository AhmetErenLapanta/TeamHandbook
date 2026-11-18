import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "./app.js";
import { canEditTeam } from "./auth.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { machineReportKey, runnerOf } from "./machines.js";
import { detectSecret } from "./plugin.js";
import { route } from "./route-scopes.js";

/**
 * A person's handbooks on a team's orchestrator: the server reads nobody's home folder, so what a
 * person's Claude Code loads is what their own connected machine reports, names only, and only that
 * person reads it; an admin reads their own and nobody else's. The person's setup itself stays on
 * their machine: this server keeps no layout of its own for them.
 */
export interface ReportedSource {
  id: string;
  kind: "yours" | "folder" | "plugin" | "team-repo";
  name: string;
  version?: string;
  marketplace?: string;
  enabled: boolean;
  skills: { name: string; description?: string }[];
  commands: { name: string }[];
  mcpServers: { name: string }[];
  hooks: { name: string }[];
  claudeMd?: boolean;
}

const KINDS = new Set(["yours", "folder", "plugin", "team-repo"]);
const SOURCES_MAX = 100;
const ITEMS_MAX = 2000;
const TEXT_MAX = 300;
/** The most a report is kept at, whatever its parts add up to. */
const REPORT_BYTES = 1024 * 1024;

const text = (value: unknown, max = TEXT_MAX): string | null => (typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : null);

/** A list of named things, each kept with its name and, for a skill, its one sentence; anything else a machine sends is dropped. */
function names(raw: unknown, withDescription = false): { name: string; description?: string }[] | null {
  if (!Array.isArray(raw) || raw.length > ITEMS_MAX) return null;
  const kept: { name: string; description?: string }[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    const name = text(item?.name);
    if (!name) return null;
    // A sentence that looks like it holds a secret is dropped here too, whatever the machine checked.
    const said = withDescription ? text(item.description, 1000) : null;
    const description = said && !detectSecret(said) ? said : null;
    kept.push(description ? { name, description } : { name });
  }
  return kept;
}

/** What a machine reported, as names only, or null when any part is not the shape a report is. */
export function cleanSources(raw: unknown): ReportedSource[] | null {
  if (!Array.isArray(raw) || raw.length > SOURCES_MAX) return null;
  const sources: ReportedSource[] = [];
  for (const s of raw as Record<string, unknown>[]) {
    const id = text(s?.id, 1024);
    const name = text(s?.name);
    const skills = names(s?.skills, true);
    const commands = names(s?.commands);
    const mcpServers = names(s?.mcpServers);
    const hooks = names(s?.hooks);
    if (!id || !name || !KINDS.has(s.kind as string) || typeof s.enabled !== "boolean" || !skills || !commands || !mcpServers || !hooks) return null;
    const version = s.version === undefined ? null : text(s.version, 64);
    const marketplace = s.marketplace === undefined ? null : text(s.marketplace);
    if ((s.version !== undefined && !version) || (s.marketplace !== undefined && !marketplace)) return null;
    sources.push({
      id, kind: s.kind as ReportedSource["kind"], name, ...(version ? { version } : {}), ...(marketplace ? { marketplace } : {}), enabled: s.enabled,
      skills, commands: commands.map(({ name: n }) => ({ name: n })), mcpServers: mcpServers.map(({ name: n }) => ({ name: n })), hooks: hooks.map(({ name: n }) => ({ name: n })),
      ...(typeof s.claudeMd === "boolean" ? { claudeMd: s.claudeMd } : {}),
    });
  }
  return sources;
}

/** Who changes a team's handbook: the organization's owners and admins and that team's own owners, signed in; a member reads it. */
export function changesTeamHandbook(user: Principal, team: string): boolean {
  return !user.key && canEditTeam(user, team);
}

/** A connected machine reporting what its person's Claude Code loads, signed and before any session: kept for that person alone, under that machine. */
export function handbookRunnerRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  route(app, "POST /api/runner/handbooks", async (c) => {
    const who = await runnerOf(c, ctx);
    if (who instanceof Response) return who;
    const sources = cleanSources(((await c.req.json().catch(() => null)) as { sources?: unknown } | null)?.sources);
    if (!sources) return c.json({ error: "a report is a list of handbooks, each with its id, kind, name, whether it is on, and the names of its skills, commands, servers and hooks" }, 400);
    const kept = JSON.stringify({ readAt: new Date().toISOString(), sources });
    if (Buffer.byteLength(kept) > REPORT_BYTES) return c.json({ error: `a report is kept at most ${REPORT_BYTES} bytes` }, 413);
    await ctx.store.setSetting(ctx.tenant, machineReportKey(who.machine.userId, who.machine.id), kept);
    return c.body(null, 204);
  });
  return app;
}

/** What a signed-in person reads of their own handbooks here. */
export function handbookTeamRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const person = (c: Context<OrchestratorEnv>) => (c.get("user").key ? null : c.get("user"));
  const NO_KEY = { error: "an API key cannot read or change a person's handbooks" };

  // What the caller's own connected machines last reported; nobody else's, whatever their role.
  route(app, "GET /api/handbook/machines", async (c) => {
    const user = person(c);
    if (!user) return c.json(NO_KEY, 403);
    const reports = [];
    for (const machine of (await ctx.store.listMachines(ctx.tenant, user.id)).filter((m) => m.userId === user.id && !m.revokedAt)) {
      const kept = await ctx.store.getSetting(ctx.tenant, machineReportKey(user.id, machine.id));
      if (kept) reports.push({ machine: { id: machine.id, name: machine.name }, ...(JSON.parse(kept) as { readAt: string; sources: ReportedSource[] }) });
    }
    return c.json({ reports });
  });

  return app;
}
