import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { OrchestratorContext } from "./app.js";
import { manages } from "./auth.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { recordEvent } from "./events.js";
import { localMode } from "./mode.js";
import { route } from "./route-scopes.js";
import { serviceCommand, serviceInstalled, thisHost } from "./service.js";
import { checkForUpdate, installedUpdateHost, startedFrom, updateCommand, updateStatus } from "./update.js";
import type { StartedFrom, UpdateHost } from "./update.js";

/*
 * Updating a local orchestrator from its own Settings, as `handbook-orchestrator update` does from
 * a terminal: it asks for the newest release only when its owner presses Check, prepares a
 * version beside the running one, makes it current on a second press, and restarts the service on
 * a third. Nothing checks on its own, and nothing but the check and the prepare reaches out.
 */

/** Where this orchestrator's install and service are; a test hands a stand-in with no network. */
export interface UpdateDeps {
  /** The install.sh install this process runs from, telling its lines to `say`; null when it is not one. */
  host: (say: (line: string) => void) => UpdateHost | null;
  /** Restarts the service, once the answer that said so has gone. */
  restart: () => void;
  /** How a copy install.sh did not place was taken: a clone and its folder, or npx. */
  startedFrom: () => StartedFrom | null;
}

const VERSION = /^[0-9A-Za-z.+-]+$/;
/** The restart waits this long after its answer, so the answer reaches the screen before the process goes. */
const RESTART_AFTER_MS = 500;

export function thisInstall(): UpdateDeps {
  const service = { installed: () => serviceInstalled(process.platform, homedir()), restart: () => serviceCommand(["restart"], thisHost()) };
  // The bundle is <package>/dist/server.js, so its package is two folders up: a clone's orchestrator/ or npx's copy.
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  return { host: (say) => installedUpdateHost({ say, service }), restart: () => void service.restart(), startedFrom: () => startedFrom(packageRoot) };
}

/** The update routes, a local orchestrator's owner's alone; on a team's or the cloud's there are none. */
export function updateRoutes(ctx: OrchestratorContext, deps: UpdateDeps = thisInstall()): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const owner = (user: Principal) => !user.key && manages(user);
  // One update at a time: a prepare is a 40 MB download, and an apply moves what the next start runs.
  let working = false;
  const notInstalled = { error: "this orchestrator was not installed with install.sh; update it the way you got it", code: "not-installed" };

  const refusal = (user: Principal) => (!localMode() ? { body: { error: "not found" }, status: 404 as const } : !owner(user) ? { body: { error: "only this machine's owner updates its orchestrator", code: "owner-only" }, status: 403 as const } : null);

  route(app, "GET /api/update", async (c) => {
    const refused = refusal(c.get("user"));
    if (refused) return c.json(refused.body, refused.status);
    const host = deps.host(() => {});
    if (!host) return c.json({ installed: false, ...deps.startedFrom() });
    const status = updateStatus(host);
    return c.json({ installed: true, ...status });
  });

  route(app, "POST /api/update/check", async (c) => {
    const refused = refusal(c.get("user"));
    if (refused) return c.json(refused.body, refused.status);
    const host = deps.host(() => {});
    if (!host) return c.json(notInstalled, 409);
    return c.json(await checkForUpdate(host));
  });

  /** Runs one update step with its lines kept for the screen, one step at a time. */
  const step = async (user: Principal, args: string[], what: string) => {
    const said: string[] = [];
    const host = deps.host((line) => said.push(line));
    if (!host) return { body: notInstalled, status: 409 as const };
    if (working) return { body: { error: "an update is already being made; wait for it to finish", code: "update-busy" }, status: 409 as const };
    working = true;
    try {
      const ok = (await updateCommand(args, host)) === 0;
      await recordEvent(ctx, user, `orchestrator.update.${what}`, { subject: "orchestrator", detail: `${ok ? "" : "did not "}${what === "prepared" ? `prepare ${args.at(-1)}` : "switch to the prepared version"}${said.length ? `: ${said.at(-1)!.slice(0, 200)}` : ""}` });
      return { body: { ok, said, ...(what === "applied" ? { restart: host.service.installed() ? "service" : "start-again" } : {}) }, status: 200 as const };
    } finally {
      working = false;
    }
  };

  route(app, "POST /api/update/prepare", async (c) => {
    const refused = refusal(c.get("user"));
    if (refused) return c.json(refused.body, refused.status);
    const body = (await c.req.json().catch(() => ({}))) as { version?: unknown };
    if (typeof body.version !== "string" || !VERSION.test(body.version) || body.version.length > 64) return c.json({ error: "give the version to prepare, as a release names it", code: "bad-version" }, 400);
    const done = await step(c.get("user"), ["--prepare", "--to", body.version], "prepared");
    return c.json(done.body, done.status);
  });

  route(app, "POST /api/update/apply", async (c) => {
    const refused = refusal(c.get("user"));
    if (refused) return c.json(refused.body, refused.status);
    const done = await step(c.get("user"), ["--apply"], "applied");
    return c.json(done.body, done.status);
  });

  route(app, "POST /api/update/restart", async (c) => {
    const refused = refusal(c.get("user"));
    if (refused) return c.json(refused.body, refused.status);
    const host = deps.host(() => {});
    if (!host) return c.json(notInstalled, 409);
    if (!host.service.installed()) return c.json({ refused: "start it again", code: "no-service" }, 409);
    await recordEvent(ctx, c.get("user"), "orchestrator.update.restarted", { subject: "orchestrator", detail: `restarted the service to run the version made current` });
    setTimeout(deps.restart, RESTART_AFTER_MS).unref();
    return c.json({ restarting: true }, 202);
  });

  return app;
}
