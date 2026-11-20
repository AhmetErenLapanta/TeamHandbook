import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "./app.js";
import { manages } from "./auth.js";
import type { OrchestratorEnv } from "./auth.js";
import { ownCliHere } from "./forge/own-cli-here.js";
import { localRepoPath } from "./forge/local.js";
import { recordEvent } from "./events.js";
import { handbookNoticed, handbookOff, markHandbookNoticed, noticeKeyOf, parseOff, saveHandbookOff, withNotices } from "./handbook-defaults.js";
import { lastWindow, withContext, withUsed } from "./handbook-measures.js";
import { usageOf, withNoUse } from "./handbook-usage.js";
import { mcpRows } from "./integrations/mcp-rows.js";
import { handbookReads } from "./short-memory.js";
import { setupOnMachine } from "./machine-folders.js";
import { deleteOwnFile, readForEditing, writeOwnFile } from "./tasks/handbook-files.js";
import { HANDBOOK_MARKETPLACE, HANDBOOK_PLUGIN, PLUGIN_OPS } from "./tasks/plugin-install.js";
import type { PluginOp } from "./tasks/plugin-install.js";
import type { FileKind, FileRefusal } from "./tasks/handbook-files.js";
import { folderTrust } from "./tasks/folder-trust.js";
import { measuredContext } from "./tasks/handbook-context.js";
import { readSkill } from "./tasks/handbook-sources.js";
import { everyTask } from "./tasks/guards.js";
import type { ReadSources } from "./tasks/handbook-sources.js";
import { route } from "./route-scopes.js";
import type { TaskRunner } from "./tasks/runner.js";

/**
 * The one step that puts the handbook plugin in a person's Claude Code, taken when they press
 * Install. Only the person whose orchestrator it is and that nobody else reaches: the plugin
 * lands in their own Claude Code, so a team's server never installs anything on its own.
 */
/** How far back a person's tasks are read: for the window of the last one that said it, and for what they used. */
const MEASURE_DAYS = 30;

export function handbookPluginRoutes(ctx: OrchestratorContext, runner: TaskRunner | undefined): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  // A write forgets what was read before it and after it, so a read that ran during it is not kept either.
  app.use("/api/handbook/*", async (c, next) => {
    const writes = c.req.method !== "GET";
    if (writes) handbookReads.forget();
    await next();
    if (writes) handbookReads.forget();
  });

  route(app, "POST /api/handbook/plugin", async (c) => {
    if (!runner || !manages(c.get("user")) || !(await ownCliHere(ctx))) return c.json({ error: "your Claude Code is reached only by an orchestrator on your own machine that you alone use; type the two commands in Claude Code yourself" }, 409);
    const result = await runner!.installHandbookPlugin();
    await recordEvent(ctx, c.get("user"), "handbook.plugin-command", { subject: "handbook:plugin", detail: `${result.installed ? "ran" : "was refused"} claude plugin marketplace add ${HANDBOOK_MARKETPLACE} and claude plugin install ${HANDBOOK_PLUGIN}` });
    return c.json(result);
  });

  // The person's own Claude Code is reached only where this orchestrator runs their tasks on their machine.
  const here = async (c: Context<OrchestratorEnv>) => Boolean(runner) && manages(c.get("user")) && !c.get("user").key && (await ownCliHere(ctx));
  const openedRepo = async (folder: string) => (await ctx.store.listRepos(ctx.tenant)).find((r) => localRepoPath(r.url) === folder) ?? null;
  const unavailable = { available: false as const, why: "your Claude Code is read only by an orchestrator on your own machine that you alone use" };
  const read = async (folder: string | undefined): Promise<ReadSources | null> => {
    const repo = folder ? await openedRepo(folder) : null;
    const trusted = repo ? (await folderTrust(ctx, repo.id)) === "trusted" : false;
    return handbookReads.read(`sources:${repo ? folder : ""}:${trusted}`, () => (repo ? runner!.handbookSources(folder, trusted) : runner!.handbookSources(undefined)));
  };

  /**
   * On a team's server a person's setup is on their own machine: a `machine` the person owns is asked through its
   * runner, and nobody reads another's. Null when none is named; a refusal when it is not theirs.
   */
  const machineOf = async (c: Context<OrchestratorEnv>): Promise<{ id: string; name: string } | null | "refused"> => {
    const id = c.req.query("machine");
    if (!id) return null;
    const user = c.get("user");
    if (user.key) return "refused";
    const machine = (await ctx.store.listMachines(ctx.tenant, null)).find((m) => m.id === id);
    return machine && machine.userId === user.id ? { id: machine.id, name: machine.name } : "refused";
  };

  // A person's own list of what their agents start without is theirs wherever their setup is read: here, or on a machine of theirs.
  const ownList = async (c: Context<OrchestratorEnv>) => {
    const user = c.get("user");
    if (user.key) return false;
    return (await here(c)) || (await ctx.store.listMachines(ctx.tenant, user.id)).some((m) => m.userId === user.id && !m.revokedAt);
  };

  // What the person's last task counted of the context each item takes, its share of that task's window when it said
  // one, and how many of their recent tasks used it: their tasks are read once for both.
  const measured = async <T extends Parameters<typeof withContext>[0][number]>(c: Context<OrchestratorEnv>, sources: T[]): Promise<T[]> => {
    const user = c.get("user");
    const since = new Date(Date.now() - MEASURE_DAYS * 86_400_000).toISOString();
    const tasks = await everyTask(ctx.store, ctx.tenant, { createdBy: [user.email, user.id], since });
    const counted = await measuredContext(ctx.store, ctx.tenant, user.id);
    // The share is of the window of the task that counted, where its agent said it; else of their newest task's.
    return withNoUse(withUsed(withContext(sources, counted, counted?.window ?? lastWindow(tasks)), usageOf(tasks, MEASURE_DAYS)));
  };

  route(app, "GET /api/handbook/sources", async (c) => {
    const machine = await machineOf(c);
    if (machine === "refused") return c.json({ error: "not found" }, 404);
    if (machine) {
      const answered = await setupOnMachine(ctx, machine.id, { want: "sources", folder: null });
      if ("unread" in answered) return c.json({ available: false, why: answered.unread });
      if (!("sources" in answered)) return c.json({ available: false, why: `${machine.name} did not list your setup` });
      const sources = await measured(c, withNotices(answered.sources, await handbookNoticed(ctx.store, ctx.tenant, c.get("user").id)));
      return c.json({ available: true, sources, machine: machine.name, readAt: new Date().toISOString() });
    }
    if (!(await here(c))) return c.json(unavailable);
    const found = await read(c.req.query("folder") || undefined);
    if (!found) return c.json({ available: false, why: "tasks here do not run as you, so this orchestrator does not read your Claude Code" });
    // One list of servers, Claude Code's and the orchestrator's joined; a plugin's server names the plugin it comes with.
    const rows = await handbookReads.read(`mcp:${c.get("user").id}`, () => mcpRows(ctx, c.get("user")));
    const mcp = rows?.map((row) => {
      const plugins = row.origins.includes("claude-plugin") ? found.sources.filter((s) => s.kind === "plugin" && s.mcpServers.some((m) => m.name.toLowerCase() === row.name.toLowerCase())).map((s) => s.id) : [];
      return plugins.length ? { ...row, plugins } : row;
    });
    // A plugin that runs hooks or servers says how many once, until the person closes the line; tasks start with it either way.
    const sources = await measured(c, withNotices(found.sources, await handbookNoticed(ctx.store, ctx.tenant, c.get("user").id)));
    return c.json({ available: true, sources, ...(mcp ? { mcp } : {}), readAt: new Date().toISOString() });
  });

  const REFUSED: Record<FileRefusal, [string, 400 | 404 | 409]> = {
    "bad-name": ["a name is lower-case letters, digits and dashes (a command's colons are its folders)", 400],
    "too-large": ["the file is larger than 64 KB", 400],
    "looks-secret": ["the text looks like it holds a key or a token; take it out and save again", 400],
    "bad-format": ["a skill's SKILL.md starts with frontmatter naming it as its folder and saying when to use it", 400],
    changed: ["the file changed since you opened it; open it again", 409],
    exists: ["one by that name is there already; open it to change it", 409],
    missing: ["it is not there any more", 404],
    outside: ["that file leads outside its folder, so it is not changed from here", 400],
  };
  /** Only the person's own folder and a project folder they opened: a plugin's files change in its repository. */
  const ownRoot = async (source: string): Promise<string | null> => {
    if (source !== "yours" && !source.startsWith("folder:")) return null;
    const found = await read(source.startsWith("folder:") ? source.slice("folder:".length) : undefined);
    return found?.roots.get(source) ?? null;
  };
  const refusedOnMachine = (c: Context<OrchestratorEnv>, answered: { refused: string; detail?: string }) => {
    const known = REFUSED[answered.refused as FileRefusal];
    return c.json({ error: answered.detail ?? known?.[0] ?? answered.refused }, known?.[1] ?? 409);
  };
  const kindOf = (value: unknown): FileKind | null => (value === "skill" || value === "command" ? value : null);

  // A plugin's switch, update and removal are Claude Code's own commands, on a plugin the inventory lists, at the scope it was installed in.
  route(app, "POST /api/handbook/plugins/:op", async (c) => {
    const op = c.req.param("op") as PluginOp;
    const body = (await c.req.json().catch(() => null)) as { plugin?: unknown } | null;
    const machine = await machineOf(c);
    if (machine === "refused") return c.json({ error: "not found" }, 404);
    if (machine) {
      // The machine checks the plugin against its own inventory and runs Claude Code's command there; installing is from the person's terminal.
      if (op === "install" || !PLUGIN_OPS.includes(op) || typeof body?.plugin !== "string") return c.json({ error: "that is not a change this page makes on your machine" }, 400);
      const answered = await setupOnMachine(ctx, machine.id, { want: "plugin", op, plugin: body.plugin });
      if ("unread" in answered) return c.json({ error: answered.unread }, 409);
      if (!("ok" in answered)) return c.json({ error: "refused" in answered ? String(answered.refused) : `${machine.name} did not run it` }, 409);
      await recordEvent(ctx, c.get("user"), "handbook.plugin-command", { subject: `handbook:${body.plugin}`, detail: `${answered.ok ? "ran" : "was refused"} ${answered.command} on ${machine.name}` });
      return c.json(answered);
    }
    if (!(await here(c))) return c.json({ error: "not found" }, 404);
    const found = PLUGIN_OPS.includes(op) && typeof body?.plugin === "string" ? await read(undefined) : null;
    const plugin = found?.sources.find((s) => s.kind === "plugin" && s.id === body!.plugin);
    if (op === "install") {
      // Only a plugin a marketplace the person's Claude Code already knows offers; a new marketplace is added in their terminal.
      const offered = typeof body?.plugin === "string" ? (await runner!.availablePlugins())?.find((p) => p.id === body.plugin) : undefined;
      if (!offered) return c.json({ error: "that is not a plugin a marketplace your Claude Code knows offers; add the marketplace in your terminal first" }, 404);
      const result = await runner!.pluginOp("install", `${offered.name}@${offered.marketplace}`, "user");
      if (!result) return c.json({ error: "tasks here do not run as you, so this orchestrator does not change your Claude Code" }, 409);
      await recordEvent(ctx, c.get("user"), "handbook.plugin-command", { subject: `handbook:${offered.id}`, detail: `${result.ok ? "ran" : "was refused"} ${result.command}` });
      return c.json(result);
    }
    if (!plugin || !plugin.marketplace || !plugin.scope) return c.json({ error: "that is not a plugin of yours this page changes" }, 404);
    // A plugin installed for one folder is found by Claude Code from that folder: it changes there, in that folder's terminal.
    if (plugin.scope !== "user") return c.json({ error: `${plugin.name} was installed for one folder; change it with claude plugin ${op} in that folder's terminal` }, 409);
    const result = await runner!.pluginOp(op, `${plugin.name}@${plugin.marketplace}`, plugin.scope);
    if (!result) return c.json({ error: "tasks here do not run as you, so this orchestrator does not change your Claude Code" }, 409);
    await recordEvent(ctx, c.get("user"), "handbook.plugin-command", { subject: `handbook:${plugin.id}`, detail: `${result.ok ? "ran" : "was refused"} ${result.command}` });
    return c.json(result);
  });

  // Claude Code's own `plugin marketplace update`, on a click: the one way the page learns of a version the local copy does not have yet.
  route(app, "POST /api/handbook/marketplaces/update", async (c) => {
    const machine = await machineOf(c);
    if (machine === "refused") return c.json({ error: "not found" }, 404);
    if (machine) {
      const answered = await setupOnMachine(ctx, machine.id, { want: "marketplaces" });
      if ("unread" in answered) return c.json({ error: answered.unread }, 409);
      if (!("ok" in answered)) return c.json({ error: "refused" in answered ? String(answered.refused) : `${machine.name} did not run it` }, 409);
      await recordEvent(ctx, c.get("user"), "handbook.plugin-command", { subject: "handbook:marketplaces", detail: `${answered.ok ? "ran" : "was refused"} ${answered.command} on ${machine.name}` });
      return c.json(answered);
    }
    if (!(await here(c))) return c.json({ error: "not found" }, 404);
    const result = await runner!.pluginOp("check", "", "user");
    if (!result) return c.json({ error: "tasks here do not run as you, so this orchestrator does not change your Claude Code" }, 409);
    await recordEvent(ctx, c.get("user"), "handbook.plugin-command", { subject: "handbook:marketplaces", detail: `${result.ok ? "ran" : "was refused"} ${result.command}` });
    return c.json(result);
  });

  route(app, "POST /api/handbook/noticed", async (c) => {
    const machine = await machineOf(c);
    if (machine === "refused") return c.json({ error: "not found" }, 404);
    if (!machine && !(await here(c))) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { plugin?: unknown } | null;
    const asked = typeof body?.plugin !== "string" ? null : machine ? await setupOnMachine(ctx, machine.id, { want: "sources", folder: null }) : await read(undefined);
    const found = asked && "sources" in asked ? asked.sources : null;
    const source = found?.find((s) => s.id === body!.plugin);
    const key = source ? noticeKeyOf(source) : null;
    if (!key) return c.json({ error: "that is not a plugin that runs hooks or servers" }, 404);
    await markHandbookNoticed(ctx.store, ctx.tenant, c.get("user").id, key);
    return c.json({ noticed: key });
  });

  route(app, "GET /api/handbook/plugins/available", async (c) => {
    if (!(await here(c))) return c.json({ error: "not found" }, 404);
    const offered = await runner!.availablePlugins();
    return offered ? c.json({ plugins: offered }) : c.json({ error: "not found" }, 404);
  });

  route(app, "GET /api/handbook/defaults", async (c) => {
    if (!(await ownList(c))) return c.json({ error: "not found" }, 404);
    return c.json({ off: await handbookOff(ctx.store, ctx.tenant, c.get("user").id) });
  });

  route(app, "PUT /api/handbook/defaults", async (c) => {
    if (!(await ownList(c))) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { off?: unknown } | null;
    const off = parseOff(body?.off);
    if (!off) return c.json({ error: "off is the skills, commands and servers to leave out, each a source id and a name of letters, digits, dots, colons, dashes and underscores" }, 400);
    const user = c.get("user");
    await saveHandbookOff(ctx.store, ctx.tenant, user.id, off);
    await recordEvent(ctx, user, "handbook.off-changed", { subject: "handbook:off", detail: `kept ${off.skills.length} skills, ${off.commands.length} commands and ${off.mcpServers.length} servers off for agents started here` });
    return c.json({ off });
  });

  route(app, "GET /api/handbook/file", async (c) => {
    const machine = await machineOf(c);
    if (machine === "refused") return c.json({ error: "not found" }, 404);
    const kind = kindOf(c.req.query("kind"));
    if (machine) {
      if (!kind || c.req.query("source") !== "yours") return c.json({ error: "not found" }, 404);
      const answered = await setupOnMachine(ctx, machine.id, { want: "file", act: "read", source: "yours", kind, name: c.req.query("name") ?? "", folder: null });
      if ("unread" in answered) return c.json({ error: answered.unread }, 409);
      if ("refused" in answered) return refusedOnMachine(c, answered);
      return c.json(answered);
    }
    if (!(await here(c))) return c.json({ error: "not found" }, 404);
    const root = kind ? await ownRoot(c.req.query("source") ?? "") : null;
    if (!kind || !root) return c.json({ error: "not found" }, 404);
    const found = await readForEditing(root, kind, c.req.query("name") ?? "");
    if (found && "refused" in found) return c.json({ error: REFUSED[found.refused][0] }, REFUSED[found.refused][1]);
    return c.json(found ?? { content: null, digest: null });
  });

  route(app, "PUT /api/handbook/file", async (c) => {
    const machine = await machineOf(c);
    if (machine === "refused") return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { source?: unknown; kind?: unknown; name?: unknown; content?: unknown; expectedDigest?: unknown } | null;
    const kind = kindOf(body?.kind);
    if (machine) {
      if (!kind || body?.source !== "yours" || typeof body.name !== "string" || typeof body.content !== "string" || !(body.expectedDigest === null || typeof body.expectedDigest === "string")) return c.json({ error: "say the source (yours), kind, name, text and the digest you opened, or null for a new one" }, 400);
      const answered = await setupOnMachine(ctx, machine.id, { want: "file", act: "write", source: "yours", kind, name: body.name, content: body.content, expectedDigest: body.expectedDigest as string | null, folder: null });
      if ("unread" in answered) return c.json({ error: answered.unread }, 409);
      if ("refused" in answered) return refusedOnMachine(c, answered);
      await recordEvent(ctx, c.get("user"), "handbook.file-saved", { subject: "handbook:yours", detail: `saved the ${kind} ${body.name} on ${machine.name}` });
      return c.json(answered);
    }
    if (!(await here(c))) return c.json({ error: "not found" }, 404);
    const root = kind && typeof body?.source === "string" ? await ownRoot(body.source) : null;
    if (!kind || !root || typeof body?.name !== "string" || typeof body.content !== "string" || !(body.expectedDigest === null || typeof body.expectedDigest === "string")) return c.json({ error: "say the source (yours or this folder), kind, name, text and the digest you opened, or null for a new one" }, 400);
    const saved = await writeOwnFile(root, kind, body.name, body.content, body.expectedDigest as string | null);
    if ("refused" in saved) return c.json({ error: saved.detail ?? REFUSED[saved.refused][0] }, REFUSED[saved.refused][1]);
    await recordEvent(ctx, c.get("user"), "handbook.file-saved", { subject: `handbook:${body.source}`, detail: `saved the ${kind} ${body.name}` });
    return c.json(saved);
  });

  route(app, "DELETE /api/handbook/file", async (c) => {
    const machine = await machineOf(c);
    if (machine === "refused") return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { source?: unknown; kind?: unknown; name?: unknown; expectedDigest?: unknown } | null;
    const kind = kindOf(body?.kind);
    if (machine) {
      if (!kind || body?.source !== "yours" || typeof body.name !== "string" || typeof body.expectedDigest !== "string") return c.json({ error: "say the source, kind, name and the digest you opened" }, 400);
      const answered = await setupOnMachine(ctx, machine.id, { want: "file", act: "delete", source: "yours", kind, name: body.name, expectedDigest: body.expectedDigest, folder: null });
      if ("unread" in answered) return c.json({ error: answered.unread }, 409);
      if ("refused" in answered) return refusedOnMachine(c, answered);
      await recordEvent(ctx, c.get("user"), "handbook.file-deleted", { subject: "handbook:yours", detail: `deleted the ${kind} ${body.name} on ${machine.name}` });
      return c.json(answered);
    }
    if (!(await here(c))) return c.json({ error: "not found" }, 404);
    const root = kind && typeof body?.source === "string" ? await ownRoot(body.source) : null;
    if (!kind || !root || typeof body?.name !== "string" || typeof body.expectedDigest !== "string") return c.json({ error: "say the source, kind, name and the digest you opened" }, 400);
    const done = await deleteOwnFile(root, kind, body.name, body.expectedDigest);
    if ("refused" in done) return c.json({ error: REFUSED[done.refused][0] }, REFUSED[done.refused][1]);
    await recordEvent(ctx, c.get("user"), "handbook.file-deleted", { subject: `handbook:${body.source}`, detail: `deleted the ${kind} ${body.name}` });
    return c.json(done);
  });

  route(app, "GET /api/handbook/skill", async (c) => {
    const machine = await machineOf(c);
    if (machine === "refused") return c.json({ error: "not found" }, 404);
    if (machine) {
      const answered = await setupOnMachine(ctx, machine.id, { want: "skill", source: c.req.query("source") ?? "", name: c.req.query("name") ?? "", folder: null });
      if ("unread" in answered) return c.json({ error: answered.unread }, 409);
      return "content" in answered && typeof answered.content === "string" ? c.json({ content: answered.content }) : c.json({ error: "no such skill" }, 404);
    }
    if (!(await here(c))) return c.json({ error: "not found" }, 404);
    const source = c.req.query("source") ?? "";
    const folder = source.startsWith("folder:") ? source.slice("folder:".length) : undefined;
    const found = await read(folder);
    if (!found) return c.json({ error: "not found" }, 404);
    const answered = await readSkill(found, source, c.req.query("name") ?? "");
    return "content" in answered ? c.json(answered) : c.json({ error: "no such skill" }, 404);
  });
  return app;
}
