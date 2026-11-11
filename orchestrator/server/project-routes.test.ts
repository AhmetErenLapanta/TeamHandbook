import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { connectRepo } from "./connect.js";
import { projectRoutes } from "./project-routes.js";
import { openSqliteStore } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OWNER: Principal = { id: "usr_a", name: "Ada", email: "ada@example.invalid", role: "owner", ownedTeams: [] };

/** A local orchestrator on a machine whose home holds two folders called notes and a hidden one. */
function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "th-project-routes-")));
  dirs.push(root);
  const home = join(root, "home");
  for (const dir of [join(home, "notes"), join(home, "work", "notes"), join(home, ".config", "x")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, "notes", "todo.md"), "x\n");
  vi.stubEnv("HOME", home);
  vi.stubEnv("ORCHESTRATOR_MODE", "local");
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: "default", addedRepos: new Map(), localReposRoot: home };
  const app = new Hono<OrchestratorEnv>();
  app.use("*", async (c, next) => {
    c.set("user", OWNER);
    await next();
  });
  app.route("/", projectRoutes(ctx));
  const call = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { home, ctx, call };
}

describe("opening a folder as a project", () => {
  it("given two folders of one name, the same folder twice and a hidden one, when each is opened, then each gets its own id, the second opening finds the first, the hidden one is refused by its code, and the list comes back to the last opened", async () => {
    // given
    const { home, call } = machine();

    // when
    const first = await (await call("POST", "/api/projects", { path: join(home, "notes") })).json();
    const second = await (await call("POST", "/api/projects", { path: join(home, "work", "notes") })).json();
    const again = await (await call("POST", "/api/projects", { path: join(home, "notes") })).json();
    const hidden = await call("POST", "/api/projects", { path: join(home, ".config", "x") });
    const listed = await (await call("GET", "/api/projects")).json();
    const renamed = await (await call("PATCH", `/api/projects/${second.project.id}`, { name: "Work notes" })).json();
    const badName = await call("PATCH", `/api/projects/${second.project.id}`, { name: "a\u0007b" });

    // then
    expect([first.project.id, first.project.team, first.existing, first.project.facts]).toEqual(["notes", "Mine", false, { git: "none", origin: null, name: "notes", kind: "code", empty: false }]);
    expect([second.project.id, again.project.id, again.existing]).toEqual(["notes-2", "notes", true]);
    expect([hidden.status, (await hidden.json()).code]).toEqual([400, "hidden"]);
    expect(listed.last).toBe("notes");
    expect(listed.projects.map((p: { id: string }) => p.id).sort()).toEqual(["notes", "notes-2"]);
    expect(renamed.project.name).toBe("Work notes");
    expect(badName.status).toBe(400);
  });

  it("given the home itself, hidden folders, Library and a folder around the orchestrator's data, when each is opened as a project and connected by path, then both refuse each with the same code", async () => {
    // given
    const { home, ctx, call } = machine();
    ctx.dataDir = join(home, "work", "orchestrator-data");
    for (const dir of [join(home, ".ssh"), join(home, "Library", "x"), ctx.dataDir]) mkdirSync(dir, { recursive: true });
    const paths = [home, join(home, ".ssh"), join(home, ".config", "x"), join(home, "Library", "x"), join(home, "work")];

    // when
    const opened = await Promise.all(paths.map(async (path) => (await call("POST", "/api/projects", { path })).json()));
    const connected = await Promise.all(paths.map((path) => connectRepo(ctx, OWNER, { forge: "path", url: path }).then(() => ({ status: 200, code: "connected" }), (err: { status: number; code: string }) => err)));

    // then
    expect(opened.map((answer: { code: string }) => answer.code)).toEqual(["home-itself", "hidden", "hidden", "library", "data-dir"]);
    expect(connected.map((err) => [err.status, err.code])).toEqual(opened.map((answer: { code: string }) => [400, answer.code]));
    expect(await ctx.store.listRepos(ctx.tenant)).toEqual([]);
  });

  it("given a folder opened as a project, when it is connected by path again, by its own path and through a link to it, then each is refused as already connected and the folder stays one project", async () => {
    // given
    const { home, ctx, call } = machine();
    await call("POST", "/api/projects", { path: join(home, "notes") });
    symlinkSync(join(home, "notes"), join(home, "work", "notes-link"));

    // when
    const attempts = await Promise.all([join(home, "notes"), join(home, "work", "notes-link")].map((url) => connectRepo(ctx, OWNER, { forge: "path", url, id: "other" }).then(() => ({ status: 200, code: "connected" }), (err: { status: number; code: string }) => err)));

    // then
    expect(attempts.map((err) => [err.status, err.code])).toEqual([[409, "already-connected"], [409, "already-connected"]]);
    expect((await ctx.store.listRepos(ctx.tenant)).map((r) => r.id)).toEqual(["notes"]);
  });

  it("given a code project and a skills project, when the code project is pointed at the skills one, at itself, at none and at an unknown one, and the skills project at the code one, then only a skills project or none is taken, each refusal by its code", async () => {
    // given
    const { home, ctx, call } = machine();
    mkdirSync(join(home, "team-skills", ".claude-plugin"), { recursive: true });
    writeFileSync(join(home, "team-skills", ".claude-plugin", "marketplace.json"), "{}");
    await call("POST", "/api/projects", { path: join(home, "notes") });
    await call("POST", "/api/projects", { path: join(home, "team-skills") });
    const change = async (id: string, body: unknown) => {
      const res = await call("PATCH", `/api/projects/${id}`, body);
      return [res.status, res.status === 200 ? ctx.addedRepos!.get(id)!.skillsFrom : (await res.json()).code];
    };

    // when
    const pointed = await change("notes", { skillsFrom: "team-skills" });
    const itself = await change("notes", { skillsFrom: "notes" });
    const unknown = await change("notes", { skillsFrom: "gone" });
    const backwards = await change("team-skills", { skillsFrom: "notes" });
    const cleared = await change("notes", { skillsFrom: null });
    const nothing = await change("notes", {});

    // then
    expect([pointed, itself, unknown, backwards, cleared, nothing]).toEqual([[200, "team-skills"], [400, "not-a-skills-project"], [400, "not-a-skills-project"], [400, "not-a-code-project"], [200, null], [400, "nothing-to-change"]]);
  });

  it("given a team's orchestrator, when a folder is opened, then there is no such route", async () => {
    const { home, call } = machine();
    vi.stubEnv("ORCHESTRATOR_MODE", "self-hosted");
    expect((await call("POST", "/api/projects", { path: join(home, "notes") })).status).toBe(404);
  });
});
