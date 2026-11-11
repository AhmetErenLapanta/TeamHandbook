import { Hono } from "hono";
import type { DetectedVerification, ProjectVerification } from "../../shared/verification.js";
import type { OrchestratorContext } from "../app.js";
import { mirrorDir } from "../app.js";
import { manages } from "../auth.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { recordEvent } from "../events.js";
import { checksOnMachine } from "../machine-folders.js";
import { machineFolderOf } from "../projects.js";
import { route } from "../route-scopes.js";
import type { RepoRecord } from "../store.js";
import { seesTask } from "./guards.js";
import { inPlaceFolder } from "./folder-trust.js";
import { detectVerification } from "./verify-detect.js";
import { approvedVerification, approveVerification, changedSince, commitReader, folderReader, forgetVerification, readEvidence } from "./verify.js";
import type { StepChoice } from "./verify.js";

/** What a project's files name as its checks, read where its tasks will find them: on the machine its folder is on, in the folder worked on in place, or at the commit its mirror is at. */
async function projectChecks(ctx: OrchestratorContext, repo: RepoRecord): Promise<{ detected: DetectedVerification } | { unread: string }> {
  if (machineFolderOf(repo.url)) return checksOnMachine(ctx, repo);
  const folder = await inPlaceFolder(repo);
  if (folder) return { detected: await detectVerification(folderReader(folder)) };
  if (!repo.head) return { unread: "the orchestrator has not read this project yet" };
  return { detected: await detectVerification(commitReader(mirrorDir(ctx, repo.id), repo.head)) };
}

export async function projectVerification(ctx: OrchestratorContext, repo: RepoRecord): Promise<ProjectVerification> {
  const configured = ctx.testCommands?.get(repo.id) ?? null;
  const approved = await approvedVerification(ctx.store, ctx.tenant, repo.id);
  const found = await projectChecks(ctx, repo);
  if ("unread" in found) return { configured, approved, detected: null, unread: found.unread, changed: [] };
  return { configured, approved, detected: found.detected, unread: null, changed: approved ? changedSince(approved, found.detected) : [] };
}

/**
 * Whether a folder on a person's machine is this person's own: it is theirs alone, as its folder
 * list is, and its checks say what its files hold (a script's body among them), so only that person,
 * signed in rather than by a key, reads or approves them; an owner or an admin included, no one else.
 */
async function ownsMachineFolder(ctx: OrchestratorContext, user: Principal, machineId: string): Promise<boolean> {
  if (user.key) return false;
  return (await ctx.store.listMachines(ctx.tenant, user.id)).some((machine) => machine.id === machineId && machine.userId === user.id);
}

function stepChoice(value: unknown): StepChoice | null {
  if (typeof value !== "object" || value === null) return null;
  const { source, command, digest } = value as Record<string, unknown>;
  return typeof source === "string" && typeof command === "string" && typeof digest === "string" ? { source, command, digest } : null;
}

/**
 * A project's check as its files name it, approved once by the project's owner and kept as the
 * project's setting, and each task's evidence of it. Approving is a person's act, never a key's: a
 * check runs as its person on every task after it.
 */
export function verifyRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const owner = (user: Principal) => !user.key && manages(user);
  /** The project whose checks this person reads, null when there is none for them: a folder on someone else's machine is not found. */
  const projectOf = async (user: Principal, id: string): Promise<RepoRecord | null> => {
    const repo = await ctx.store.getRepo(ctx.tenant, id);
    if (!repo) return null;
    const folder = machineFolderOf(repo.url);
    return !folder || (await ownsMachineFolder(ctx, user, folder.machineId)) ? repo : null;
  };
  /** Who approves a project's checks: its person for their own machine's folder, an owner or an admin for any other. */
  const approves = (user: Principal, repo: RepoRecord) => Boolean(machineFolderOf(repo.url)) || owner(user);

  route(app, "GET /api/projects/:id/verification", async (c) => {
    const repo = await projectOf(c.get("user"), c.req.param("id") ?? "");
    if (!repo) return c.json({ error: "unknown project" }, 404);
    return c.json(await projectVerification(ctx, repo));
  });

  route(app, "PUT /api/projects/:id/verification", async (c) => {
    const user = c.get("user");
    const repo = await projectOf(user, c.req.param("id") ?? "");
    if (!repo) return c.json({ error: "unknown project" }, 404);
    if (!approves(user, repo)) return c.json({ error: "only an owner or an admin approves a project's checks" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { checks?: unknown; setup?: unknown };
    const checks = Array.isArray(body.checks) ? body.checks.map(stepChoice) : [];
    const setup = body.setup === null || body.setup === undefined ? null : stepChoice(body.setup);
    if (!checks.length || checks.some((check) => !check) || (body.setup != null && !setup)) return c.json({ error: "give the checks, and the setup or null, each as its source, command and digest", code: "bad-choice" }, 400);
    const found = await projectChecks(ctx, repo);
    if ("unread" in found) return c.json({ error: found.unread, code: "unread" }, 409);
    const approved = await approveVerification(ctx.store, ctx.tenant, repo.id, found.detected, { checks: checks as StepChoice[], setup }, user.name);
    if ("refused" in approved) return c.json({ error: approved.refused, code: "changed" }, 409);
    await recordEvent(ctx, user, "repo.check-approved", { repoId: repo.id, subject: `repo:${repo.id}`, detail: `approved ${approved.checks.map((check) => check.command).join(" and ")}${approved.setup ? ` after ${approved.setup.command}` : ""} as the checks every task on ${repo.name} runs` });
    return c.json(await projectVerification(ctx, repo));
  });

  route(app, "DELETE /api/projects/:id/verification", async (c) => {
    const user = c.get("user");
    const repo = await projectOf(user, c.req.param("id") ?? "");
    if (!repo) return c.json({ error: "unknown project" }, 404);
    if (!approves(user, repo)) return c.json({ error: "only an owner or an admin approves a project's checks" }, 403);
    await forgetVerification(ctx.store, ctx.tenant, repo.id);
    await recordEvent(ctx, user, "repo.check-forgotten", { repoId: repo.id, subject: `repo:${repo.id}`, detail: `took back the approved checks of ${repo.name}; its tasks run none` });
    return c.json(await projectVerification(ctx, repo));
  });

  route(app, "GET /api/tasks/:id/verification", async (c) => {
    const task = await ctx.store.getTask(ctx.tenant, c.req.param("id") ?? "");
    if (!task || !seesTask(c.get("user"), task)) return c.json({ error: "unknown task" }, 404);
    const repoIds = task.targets?.length ? task.targets.map((target) => target.repoId) : [task.repoId];
    const verifications = (await Promise.all(repoIds.map(async (repoId) => ({ repoId, verification: await readEvidence(ctx.store, ctx.tenant, task.id, repoId) })))).filter((v) => v.verification);
    return c.json({ verifications });
  });

  return app;
}
