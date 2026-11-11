import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "../app.js";
import { inConfiguration, mirrorDir, NOT_CONFIGURED, syncError } from "../app.js";
import { canEditTeam } from "../auth.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { proposedBranch, teamNaming } from "../branches.js";
import { ChangeRefused, prepareBuilt } from "../changes.js";
import { ForgeRefusal } from "../forge/local.js";
import { RepositoryGone } from "../git.js";
import { commitMessagePrefix, commitSubject } from "../plugin.js";
import { forgeTokenName, inRequestTurn, propose, RequestRefused } from "../propose.js";
import type { RepoRecord } from "../store.js";
import { NO_VAULT, readSecret, storeSecret } from "../vault.js";
import { auditChange, auditRequired, NoEventLog } from "./audit.js";
import { orchestratorMcpChange, orchestratorMcpEntry, orchestratorMcpId, orchestratorMcpRepo, MCP_PATH } from "./orchestrator-mcp.js";
import type { OrchestratorMcpRecord, OrchestratorMcpRepo } from "./orchestrator-mcp.js";
import { managesIntegrations, readEnabled, removeEnabled, saveEnabled } from "./records.js";
import { cleanSlackEvents, cleanWebhook, lastDelivery, postToSlack, recordDelivery, SLACK, SLACK_EVENTS, SLACK_WEBHOOK_SECRET, slackApp, slackEscape } from "./slack.js";
import type { Delivery, SlackConfig } from "./slack.js";
import { forgeConnectionView } from "../forge/oauth.js";
import type { ForgeConnection } from "../forge/oauth.js";
import { FORGES } from "../../shared/forge-def.js";
import { ownCliStatus, runOwnCli } from "../forge/own-cli.js";
import type { CliRun, OwnCliStatus } from "../forge/own-cli.js";
import { localMode } from "../mode.js";
import { saveWrites, writesOn } from "../work/writes.js";
import { atlassianServer, beginSlackAdd, catalogFor, OAUTH_CALLBACK, signsIn } from "./personal-mcp.js";
import { claudeCodeServers } from "./claude-code-servers.js";
import { cleanTracker, sameTracker, TRACKER, TRACKER_TOKEN_SECRET } from "./tracker.js";
import type { TrackerConfig } from "./tracker.js";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

type State = "off" | "connected" | "requested";

export interface ForgeCard {
  id: "gitlab" | "github";
  state: State;
  enabledBy: string | null;
  enabledAt: string | null;
  repos: { repoId: string; name: string; project: string; apiUrl: string; setBy: string; setAt: string }[];
  /** The organization's one-click connection to this forge, for its managers; null when there is none or for anyone else. */
  connection: ForgeConnection | null;
  /** In local mode: the person's own gh or glab, and the repositories whose requests open with it; null otherwise. */
  ownCli: (OwnCliStatus & { repos: string[] }) | null;
}

export interface SlackCard {
  id: "slack";
  state: State;
  enabledBy: string | null;
  enabledAt: string | null;
  events: string[];
  delivery: Delivery | null;
  /** Slack's own approval screen is offered: a Slack app is set and a sign-in has an address to return to. */
  addable: boolean;
  /** The address Slack sends the approval back to, which the Slack app lists; for whoever runs the orchestrator. */
  redirectUri: string | null;
}

export interface TrackerCard {
  id: "tracker";
  state: State;
  enabledBy: string | null;
  enabledAt: string | null;
  config: TrackerConfig | null;
  /** When a token is stored, the orchestrator reads the issue a task works on and gives the agent its text. */
  token: { setAt: string; setBy: string } | null;
  writeBack: false;
}

export interface OrchestratorMcpCard {
  id: "orchestrator-mcp";
  state: State;
  enabledBy: string | null;
  enabledAt: string | null;
  endpoint: string | null;
  entry: Record<string, unknown> | null;
  /** What this orchestrator lacks before teammates can use the server; empty when nothing does. */
  missing: string[];
  repos: (OrchestratorMcpRepo & { canChange: boolean })[];
}

export type IntegrationCard = ForgeCard | SlackCard | TrackerCard | OrchestratorMcpCard;

function first<T extends { at: string | null; by: string | null }>(items: T[]): { enabledBy: string | null; enabledAt: string | null } {
  const earliest = items.filter((i) => i.at).sort((a, b) => a.at!.localeCompare(b.at!))[0];
  return { enabledBy: earliest?.by ?? null, enabledAt: earliest?.at ?? null };
}

/** What stops teammates from using the orchestrator's MCP server, in the order an admin fixes them. */
export function orchestratorMcpMissing(ctx: OrchestratorContext): string[] {
  const missing: string[] = [];
  if (!ctx.publicUrl) missing.push("Set ORCHESTRATOR_PUBLIC_URL to the address teammates reach this orchestrator at; the server's address in the team repository is built from it.");
  if (!ctx.vault) missing.push("Set ORCHESTRATOR_SECRET_KEY: the orchestrator signs teammates' Claude Code in with it.");
  if (!ctx.apiKeys) missing.push("API keys are not available on this orchestrator yet, so the server lets nobody in.");
  if (!ctx.audit) missing.push("This orchestrator keeps no event log yet, and the server runs no call the log does not record.");
  return missing;
}

export async function integrationCards(ctx: OrchestratorContext, user: Principal, run: CliRun = runOwnCli): Promise<IntegrationCard[]> {
  const repos = await ctx.store.listRepos(ctx.tenant);
  const forges = (
    await Promise.all(
      repos.map(async (repo) => {
        const config = await ctx.store.getForgeConfig(ctx.tenant, repo.id);
        if (!config) return null;
        const token = await ctx.store.secretSetAt(ctx.tenant, forgeTokenName(config));
        return { repo, config, setBy: token?.updatedBy ?? "", setAt: token?.updatedAt ?? "" };
      }),
    )
  ).filter((f) => f !== null);
  // Where a repository's requests go, and who entered its token, are the managers' to read, as
  // the forge settings themselves are; anyone else reads which repositories use the forge.
  const manager = managesIntegrations(user);
  const local = localMode();
  const forgeCard = async (kind: "gitlab" | "github"): Promise<ForgeCard> => {
    const mine = forges.filter((f) => f.config.kind === kind).map((f) => (manager ? f : { ...f, config: { ...f.config, apiUrl: "", project: "" }, setBy: "" }));
    const connection = await forgeConnectionView(ctx, kind);
    // On one person's machine a request opens with their own CLI; its host is the first such repository's, else the forge's own.
    const viaCli = local ? [...(ctx.addedRepos ?? new Map()).values()].filter((a) => a.viaOwnCli && a.forge === kind) : [];
    const host = viaCli.map((a) => forges.find((f) => f.repo.id === a.id)?.config.apiUrl).filter((u): u is string => Boolean(u)).map((u) => new URL(u).hostname.replace(/^api\./, ""))[0] ?? FORGES[kind].homeHosts[0]!;
    const ownCli = local ? { ...(await ownCliStatus(kind, host, run)), repos: viaCli.map((a) => a.id) } : null;
    return {
      id: kind,
      state: mine.length || connection || ownCli?.signedIn ? "connected" : "off",
      ...first([...(connection ? [{ at: connection.at, by: connection.by }] : []), ...mine.map((f) => ({ at: f.setAt || null, by: f.setBy || null }))]),
      repos: mine.map((f) => ({ repoId: f.repo.id, name: f.repo.name, project: f.config.project, apiUrl: f.config.apiUrl, setBy: f.setBy, setAt: f.setAt })),
      connection: manager ? connection : null,
      ownCli,
    };
  };

  const slack = await readEnabled<SlackConfig>(ctx, SLACK);
  const tracker = await readEnabled<TrackerConfig>(ctx, TRACKER);
  const trackerToken = await ctx.store.secretSetAt(ctx.tenant, TRACKER_TOKEN_SECRET);
  const mcpRepos = await Promise.all(repos.map(async (repo) => ({ ...(await orchestratorMcpRepo(ctx, repo)), canChange: canEditTeam(user, repo.team) })));
  const mcpState: State = mcpRepos.some((r) => r.state === "connected") ? "connected" : mcpRepos.some((r) => r.state === "requested") ? "requested" : "off";

  return [
    await forgeCard("gitlab"),
    await forgeCard("github"),
    {
      id: "slack",
      state: slack ? "connected" : "off",
      enabledBy: slack?.enabledBy ?? null,
      enabledAt: slack?.enabledAt ?? null,
      events: slack?.config.events ?? [],
      delivery: slack ? await lastDelivery(ctx) : null,
      addable: slackApp() !== null && signsIn(ctx),
      redirectUri: manager && ctx.publicUrl ? `${ctx.publicUrl.replace(/\/+$/, "")}${OAUTH_CALLBACK}` : null,
    },
    {
      id: "tracker",
      state: tracker ? "connected" : "off",
      enabledBy: tracker?.enabledBy ?? null,
      enabledAt: tracker?.enabledAt ?? null,
      config: tracker?.config ?? null,
      token: trackerToken && tracker ? { setAt: trackerToken.updatedAt, setBy: trackerToken.updatedBy } : null,
      writeBack: false,
    },
    {
      id: "orchestrator-mcp",
      state: mcpState,
      ...first(mcpRepos.filter((r) => r.state === mcpState).map((r) => ({ at: r.enabledAt, by: r.enabledBy }))),
      endpoint: ctx.publicUrl ? `${ctx.publicUrl.replace(/\/+$/, "")}${MCP_PATH}` : null,
      entry: ctx.publicUrl ? orchestratorMcpEntry(ctx.publicUrl) : null,
      missing: orchestratorMcpMissing(ctx),
      repos: mcpRepos,
    },
  ];
}

function refused(c: Context, err: unknown) {
  if (err instanceof RepositoryGone) throw err;
  if (err instanceof ChangeRefused) return c.json({ error: err.message }, 400);
  if (err instanceof RequestRefused || err instanceof ForgeRefusal) return c.json({ error: err.message }, 409);
  return c.json({ error: syncError(err) }, 502);
}

/**
 * The Integrations page: the forges requests open on, the Slack channel told about them, the
 * issue tracker tasks link to, and the orchestrator's own MCP server. Anyone signed in reads it;
 * an admin changes the organization's integrations, and turning the MCP server on for a team
 * takes the same right as any other change to that team's repository.
 */
export function integrationRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const adminOnly = (c: Context<OrchestratorEnv>) => (managesIntegrations(c.get("user")) ? null : c.json({ error: "only an admin changes the organization's integrations" }, 403));

  app.get("/api/integrations", async (c) => {
    const user = c.get("user");
    // On one person's own machine the page offers what that person connects for themselves; what a team shares stays off it.
    return c.json({ integrations: await integrationCards(ctx, user), canManage: managesIntegrations(user), vault: Boolean(ctx.vault), slackEvents: SLACK_EVENTS, local: localMode(), writes: await writesOn(ctx), jira: { mcp: await atlassianServer(ctx, user.id) }, catalog: await catalogFor(ctx, user.id), claudeCodeServers: claudeCodeServers(ctx, user), signIn: signsIn(ctx) });
  });

  // Whether moving a card on Work moves its issue in Jira. Off until an owner or an admin turns it
  // on here, so nothing changes in a team's tracker unasked; a task's agent never changes an issue.
  app.put("/api/integrations/writes", async (c) => {
    const denied = adminOnly(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as { on?: unknown };
    if (typeof body.on !== "boolean") return c.json({ error: "send on, true or false" }, 400);
    const user = c.get("user");
    if (body.on) {
      // Letting anything change a tracker is written to the event log first: with no log, it stays off.
      try {
        await auditRequired(ctx, user, "integration.changed", { subject: "integration:tracker-writes", detail: "turned on moving Jira issues when a card moves on Work" });
      } catch (err) {
        if (err instanceof NoEventLog) return c.json({ error: "Changing issues stays off on an orchestrator that keeps no event log, as every change it makes is logged first." }, 409);
        throw err;
      }
      await saveWrites(ctx, true);
    } else {
      await saveWrites(ctx, false);
      await auditChange(ctx, user, "integration.changed", { subject: "integration:tracker-writes", detail: "turned off moving Jira issues when a card moves on Work" });
    }
    return c.json({ writes: await writesOn(ctx) });
  });

  app.put("/api/integrations/slack", async (c) => {
    const denied = adminOnly(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const user = c.get("user");
    try {
      const events = cleanSlackEvents(body.events);
      const current = await readEnabled<SlackConfig>(ctx, SLACK);
      const given = typeof body.webhookUrl === "string" && body.webhookUrl.trim() !== "";
      if (!given && !current) throw new ChangeRefused("paste the channel's incoming webhook address");
      if (given) {
        const webhook = cleanWebhook(body.webhookUrl);
        if (!ctx.vault) throw new ChangeRefused(NO_VAULT);
        await storeSecret(ctx.store, ctx.vault, ctx.tenant, SLACK_WEBHOOK_SECRET, webhook, user.email);
        await recordDelivery(ctx, null);
      }
      const saved = await saveEnabled<SlackConfig>(ctx, SLACK, { events }, user);
      await auditChange(ctx, user, current ? "integration.changed" : "integration.enabled", {
        subject: "integration:slack",
        detail: `Slack notifications for ${events.join(", ")}${given && current ? ", with a new webhook" : ""}`,
      });
      return c.json({ slack: saved });
    } catch (err) {
      return refused(c, err);
    }
  });

  app.post("/api/integrations/slack/add", async (c) => {
    const denied = adminOnly(c);
    if (denied) return denied;
    return beginSlackAdd(ctx, c, c.get("user"), SLACK_EVENTS.map((e) => e.kind));
  });

  app.post("/api/integrations/slack/test", async (c) => {
    const denied = adminOnly(c);
    if (denied) return denied;
    const user = c.get("user");
    if (!(await readEnabled<SlackConfig>(ctx, SLACK))) return c.json({ error: "Slack is not set up. Set Slack up on its card under Integrations, then send the test message." }, 409);
    try {
      const webhook = await readSecret(ctx.store, ctx.vault ?? null, ctx.tenant, SLACK_WEBHOOK_SECRET);
      if (!webhook) return c.json({ error: "no webhook address is stored; paste it again" }, 409);
      const delivery = await postToSlack(webhook, { text: slackEscape(`A test message from the TeamHandbook Orchestrator, sent by ${user.name}.`) });
      await recordDelivery(ctx, delivery);
      await auditChange(ctx, user, "integration.tested", { subject: "integration:slack", detail: delivery.ok ? "sent a test message to Slack" : `a test message to Slack failed: ${delivery.detail}` });
      return c.json({ delivery });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  app.delete("/api/integrations/slack", async (c) => {
    const denied = adminOnly(c);
    if (denied) return denied;
    await ctx.store.deleteSecret(ctx.tenant, SLACK_WEBHOOK_SECRET);
    await removeEnabled(ctx, SLACK);
    await recordDelivery(ctx, null);
    await auditChange(ctx, c.get("user"), "integration.disabled", { subject: "integration:slack", detail: "turned off Slack notifications and removed the webhook" });
    return c.json({ ok: true });
  });

  // A token goes with the tracker, site and account it was entered for, as a forge token does:
  // changing any of them needs the token again, and a change sent without one is refused.
  app.put("/api/integrations/tracker", async (c) => {
    const denied = adminOnly(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const user = c.get("user");
    try {
      const config = cleanTracker(body);
      const current = await readEnabled<TrackerConfig>(ctx, TRACKER);
      const token = body.token;
      const stored = await ctx.store.secretSetAt(ctx.tenant, TRACKER_TOKEN_SECRET);
      if (token !== undefined && token !== "") {
        if (typeof token !== "string" || token.length < 8 || token.length > 512 || /\s/.test(token)) throw new ChangeRefused("that token is not in a form a tracker issues");
        if (config.kind === "github") throw new ChangeRefused("the orchestrator reads Jira and GitLab issues; a GitHub tracker links issues only");
        if (config.kind === "jira" && !config.email) throw new ChangeRefused("a Jira API token needs the email of the account it belongs to");
        if (!ctx.vault) throw new ChangeRefused(NO_VAULT);
        await storeSecret(ctx.store, ctx.vault, ctx.tenant, TRACKER_TOKEN_SECRET, token, user.email);
      } else if (stored && !sameTracker(current?.config, config)) {
        throw new ChangeRefused("the tracker, its address or the account changed; enter the token again, or disconnect to link issues without reading them");
      }
      const saved = await saveEnabled<TrackerConfig>(ctx, TRACKER, config, user);
      await auditChange(ctx, user, current ? "integration.changed" : "integration.enabled", {
        subject: "integration:tracker",
        detail: `issue tracker ${config.kind} at ${config.url}${token ? ", with a new token" : ""}`,
      });
      return c.json({ tracker: saved });
    } catch (err) {
      return refused(c, err);
    }
  });

  app.delete("/api/integrations/tracker", async (c) => {
    const denied = adminOnly(c);
    if (denied) return denied;
    await ctx.store.deleteSecret(ctx.tenant, TRACKER_TOKEN_SECRET);
    // A webhook secret made before boards were read for changes instead; nothing reads it now.
    await ctx.store.deleteSecret(ctx.tenant, "integration.tracker.webhook");
    await removeEnabled(ctx, TRACKER);
    await auditChange(ctx, c.get("user"), "integration.disabled", { subject: "integration:tracker", detail: "disconnected the issue tracker and removed its token and webhook secret" });
    return c.json({ ok: true });
  });

  // Turning the orchestrator's MCP server on for a team is a change to its repository, so it goes
  // the way every change goes: the orchestrator proposes the message, the person confirms it, and a
  // request opens that a person merges.
  const mcpRepo = async (c: Context<OrchestratorEnv>): Promise<(RepoRecord & { head: string }) | Response> => {
    const id = c.req.param("id") ?? "";
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo) return c.json({ error: "unknown repository" }, 404);
    if (!canEditTeam(c.get("user"), repo.team)) return c.json({ error: `only an admin or an owner of ${repo.team} can change this repository` }, 403);
    if (!inConfiguration(ctx, id)) return c.json({ error: NOT_CONFIGURED }, 409);
    const missing = orchestratorMcpMissing(ctx);
    if (missing.length) return c.json({ error: missing[0] }, 409);
    if (!repo.head) return c.json({ error: "this repository has not been read yet" }, 409);
    const state = await orchestratorMcpRepo(ctx, repo);
    if (state.state === "connected") return c.json({ error: `${repo.name} already declares the orchestrator's MCP server` }, 409);
    if (state.state === "requested") return c.json({ error: `request #${state.request!.number} already adds the orchestrator's MCP server to ${repo.name}; merge or close it first` }, 409);
    return repo as RepoRecord & { head: string };
  };

  app.post("/api/integrations/orchestrator-mcp/:id/proposal", async (c) => {
    const repo = await mcpRepo(c);
    if (repo instanceof Response) return repo;
    try {
      const mirror = mirrorDir(ctx, repo.id);
      const naming = await teamNaming(mirror, repo.head);
      const built = await orchestratorMcpChange(mirror, repo.head, ctx.publicUrl!);
      return c.json({ baseSha: repo.head, proposal: commitSubject(commitMessagePrefix(naming.commitPrefix), built.proposal), branch: proposedBranch(built.topic, naming) });
    } catch (err) {
      return refused(c, err);
    }
  });

  app.post("/api/integrations/orchestrator-mcp/:id/propose", async (c) => {
    const repo = await mcpRepo(c);
    if (repo instanceof Response) return repo;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.baseSha !== repo.head) return c.json({ error: "the repository changed since this page was opened; reload and set it up again" }, 409);
    const user = c.get("user");
    try {
      const mirror = mirrorDir(ctx, repo.id);
      const request = await inRequestTurn(ctx, repo.id, async () => {
        const prepared = await prepareBuilt(mirror, repo.head, await orchestratorMcpChange(mirror, repo.head, ctx.publicUrl!), body.message, user.name, await teamNaming(mirror, repo.head), body.branch);
        return propose(ctx, repo, user, prepared);
      });
      await removeEnabled(ctx, orchestratorMcpId(repo.id));
      await saveEnabled<OrchestratorMcpRecord>(ctx, orchestratorMcpId(repo.id), { number: request.number }, user);
      await auditChange(ctx, user, "integration.enabled", { repoId: repo.id, subject: "integration:orchestrator-mcp", detail: `requested the orchestrator's MCP server for ${repo.name} in request #${request.number}` });
      return c.json({ request });
    } catch (err) {
      return refused(c, err);
    }
  });

  return app;
}
