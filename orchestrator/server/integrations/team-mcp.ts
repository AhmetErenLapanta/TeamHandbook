import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "../app.js";
import { mirrorDir } from "../app.js";
import { manages } from "../auth.js";
import type { OrchestratorEnv } from "../auth.js";
import { ChangeRefused } from "../changes.js";
import { readTeamSetupAsync } from "../inventory.js";
import { auditChange } from "./audit.js";
import { listTools, McpCallFailed } from "./mcp-client.js";
import { oauthRefusal } from "./mcp-oauth.js";
import {
  beginSignIn,
  cleanTools,
  dropOrgConnection,
  needsSignIn,
  orgSecretName,
  personalServers,
  pickedWrites,
  readOrgConnection,
  readOrgServer,
  saveOrgServer,
  sealedAccess,
  secretName,
  teamServerKey,
  surelyReads,
  toolWrites,
} from "./personal-mcp.js";

/** A server the team repositories declare that signs people in, once for every repository that declares it at the same address. */
export interface TeamServer {
  key: string;
  name: string;
  url: string;
  repos: { id: string; name: string; team: string }[];
}

/** The servers the connected repositories declare that a task can reach only with someone's sign-in. */
export async function teamServers(ctx: OrchestratorContext): Promise<TeamServer[]> {
  const found = new Map<string, TeamServer>();
  for (const repo of await ctx.store.listRepos(ctx.tenant)) {
    if (!repo.head) continue;
    const setup = await readTeamSetupAsync(mirrorDir(ctx, repo.id), repo.head);
    for (const [name, config] of Object.entries(setup.mcpServers)) {
      if (!needsSignIn(config)) continue;
      const key = teamServerKey(name, config.url);
      const entry = found.get(key) ?? { key, name, url: config.url, repos: [] };
      entry.repos.push({ id: repo.id, name: repo.name, team: repo.team });
      found.set(key, entry);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function refused(c: Context, err: unknown) {
  if (err instanceof ChangeRefused) return c.json({ error: err.message }, 400);
  const said = oauthRefusal(err) ?? (err instanceof McpCallFailed ? err.message : null);
  if (said !== null) return c.json({ error: said }, 400);
  throw err;
}

/**
 * Integrations' Team MCP servers: the servers the team repositories declare that sign people
 * in, how each reaches a task, and the ways to connect one. Anyone connects one for the tasks
 * they start, as a server of their own at the same address. An owner or admin connects one for
 * everyone's tasks, as the account they sign in with, and picks the tools those tasks may call;
 * a starter's own sign-in is used before it.
 */
export function teamMcpRoutes(ctx: OrchestratorContext, send: typeof fetch = fetch): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();

  const find = async (c: Context<OrchestratorEnv>) => (await teamServers(ctx)).find((s) => s.key === c.req.param("key")) ?? null;
  const managed = (c: Context<OrchestratorEnv>) => (manages(c.get("user")) ? null : c.json({ error: "only an owner or an admin connects a team's server for everyone's tasks" }, 403));

  app.get("/api/team-mcp-servers", async (c) => {
    const user = c.get("user");
    const mine = await personalServers(ctx, user.id);
    const servers = await Promise.all(
      (await teamServers(ctx)).map(async (s) => {
        const org = await readOrgServer(ctx, s.key);
        const connection = await readOrgConnection(ctx, s.key);
        const own = mine.find((m) => m.name === s.name && m.url !== undefined && teamServerKey(m.name, m.url) === s.key);
        return {
          ...s,
          everyone: connection ? { by: connection.by, at: connection.at, tools: org?.tools ?? [], writing: (org?.tools ?? []).filter((t) => pickedWrites(org ?? {}, t)) } : null,
          tools: org?.tools ?? [],
          mine: own ? { added: true, tools: own.tools } : null,
        };
      }),
    );
    return c.json({ servers, canManage: manages(user) });
  });

  app.post("/api/team-mcp-servers/:key/connect", async (c) => {
    const denied = managed(c);
    if (denied) return denied;
    const server = await find(c);
    if (!server) return c.json({ error: "no team repository declares that server" }, 404);
    if (!(await readOrgServer(ctx, server.key))) await saveOrgServer(ctx, server.key, { name: server.name, url: server.url, tools: [] });
    return beginSignIn(ctx, c, c.get("user"), server, server.key, send);
  });

  app.delete("/api/team-mcp-servers/:key/connection", async (c) => {
    const denied = managed(c);
    if (denied) return denied;
    const server = await find(c);
    if (!server) return c.json({ error: "no team repository declares that server" }, 404);
    await dropOrgConnection(ctx, server.key);
    await auditChange(ctx, c.get("user"), "mcp.org.disconnected", { subject: `mcp:${server.name}`, detail: `disconnected the team's MCP server ${server.name} from everyone's tasks` });
    return c.json({ ok: true });
  });

  // The tools are read with the organization's sign-in, or else the asker's own, whichever there is.
  app.get("/api/team-mcp-servers/:key/tools", async (c) => {
    const denied = managed(c);
    if (denied) return denied;
    const server = await find(c);
    if (!server) return c.json({ error: "no team repository declares that server" }, 404);
    try {
      const credential = (await sealedAccess(ctx, orgSecretName(server.key), send)) ?? (await sealedAccess(ctx, secretName(c.get("user").id, server.name, "oauth"), send));
      if (!credential) return c.json({ error: "connect the server first, for everyone's tasks or your own" }, 409);
      const tools = await listTools(server.url, { authorization: `Bearer ${credential}` }, send);
      const known = Object.fromEntries(tools.map((t) => [t.name, { writes: toolWrites(t.name, t.annotations) }]));
      const org = (await readOrgServer(ctx, server.key)) ?? { name: server.name, url: server.url, tools: [] };
      await saveOrgServer(ctx, server.key, { ...org, known });
      return c.json({ tools: tools.map((t) => ({ name: t.name, description: t.description, writes: known[t.name]!.writes, reads: surelyReads(t.name, t.annotations) })) });
    } catch (err) {
      return refused(c, err);
    }
  });

  app.patch("/api/team-mcp-servers/:key", async (c) => {
    const denied = managed(c);
    if (denied) return denied;
    const server = await find(c);
    if (!server) return c.json({ error: "no team repository declares that server" }, 404);
    try {
      const tools = cleanTools(((await c.req.json().catch(() => ({}))) as { tools?: unknown }).tools);
      const org = (await readOrgServer(ctx, server.key)) ?? { name: server.name, url: server.url, tools: [] };
      await saveOrgServer(ctx, server.key, { ...org, tools });
      const writing = tools.filter((t) => pickedWrites(org, t));
      await auditChange(ctx, c.get("user"), "mcp.org.tools", {
        subject: `mcp:${server.name}`,
        detail: `allowed ${tools.length} tool(s) of the team's MCP server ${server.name} in everyone's tasks${writing.length ? `, ${writing.length} of them able to change things (${writing.join(", ").slice(0, 200)})` : ""}`,
      });
      return c.json({ tools });
    } catch (err) {
      return refused(c, err);
    }
  });

  return app;
}
