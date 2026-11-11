import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { localDescriptionRef, localRepoPath } from "../forge/local.js";
import { git } from "../git.js";
import { seededContext, storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { createTaskRunner } from "./runner.js";
import type { TaskTemplate } from "./types.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const MANIFEST = ".claude-plugin/plugin.json";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The seeded Payments repository with its plugin at 0.1.5, and teammates adding it at an address its scaffold does not name yet. */
async function versioned(): Promise<{ ctx: OrchestratorContext; bare: string; root: string }> {
  const { ctx, root, config } = await seededContext("orchestrator-request-turn-", ["payments-skills"]);
  await storePrincipals(ctx, ADMIN);
  dirs.push(root);
  ctx.memberUrls = new Map([["payments-skills", "https://git.example.com/acme/payments-skills.git"]]);
  const entry = config.repos.find((r) => r.id === "payments-skills")!;
  const bare = localRepoPath(entry.url)!;
  const work = mkdtempSync(join(root, "work-"));
  git(["clone", "--quiet", bare, work], work);
  const file = join(work, MANIFEST);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), version: "0.1.5" }, null, 2) + "\n");
  git(["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "commit", "--quiet", "-am", "chore: version the plugin"], work);
  git(["fetch", "--quiet", work, "main:main"], bare);
  await syncRepo(ctx, "payments-skills");
  return { ctx, bare, root };
}

/**
 * A stand-in agent that adds a note and then waits until `peers` agents have started, so every
 * run ends at the same moment and each request is prepared while the others are.
 */
function together(root: string, peers: number): string {
  const gate = join(root, "started");
  mkdirSync(gate);
  const file = join(root, "together.mjs");
  writeFileSync(
    file,
    `import { readdirSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(gate, "x"))} + process.pid, "");\nwriteFileSync("note-" + process.pid + ".md", "x\\n");\nwhile (readdirSync(${JSON.stringify(gate)}).length < ${peers}) await new Promise((r) => setTimeout(r, 20));\nconsole.log(JSON.stringify({ type: "result", summary: "Done." }));\n`,
  );
  return file;
}

async function startedTogether(ctx: OrchestratorContext, root: string, starts: { title: string; agent: string; template?: TaskTemplate }[], testCommand: string | null = null) {
  const peers = starts.filter((s) => s.agent === "fake").length;
  const tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(together(root, peers))], isolation: { mode: "process", network: "open" }, testCommand: () => testCommand, hostEnv: { PATH: process.env.PATH }, concurrency: starts.length });
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const started = await Promise.all(starts.map((s) => tasks.start({ repo, description: "", user: ADMIN, ...s })));
  await tasks.idle();
  return Promise.all(started.map(async (t) => (await ctx.store.getTask(ctx.tenant, t.id))!));
}

const versionOn = (bare: string, branch: string) => JSON.parse(git(["show", `${branch}:${MANIFEST}`], bare)).version as string;

describe("requests prepared at one moment for one repository", () => {
  it("given two tasks whose agents finish together, when both open their requests, then each raises the plugin to its own version", async () => {
    // given
    const { ctx, bare, root } = await versioned();

    // when
    const done = await startedTogether(ctx, root, [
      { title: "Add one note", agent: "fake" },
      { title: "Add another note", agent: "fake" },
    ]);

    // then
    expect(done.map((t) => t.status)).toEqual(["needs-review", "needs-review"]);
    expect(done.map((t) => versionOn(bare, `task/${t.id}`)).sort()).toEqual(["0.1.6", "0.1.7"]);
  });

  it("given a scaffold refresh whose tests end only once a task's request is open, when it opens its own, then its version is read in its turn and passes the task's", async () => {
    // given: the refresh's checkout holds no note, so its test step after the agent waits for the task's branch; the
    // check's first run, before any agent, passes at once, marked in the task's own temp directory, not in its change
    const { ctx, bare, root } = await versioned();
    const waitForTask = `[ -f "$TMPDIR/checked" ] || { touch "$TMPDIR/checked"; exit 0; }; ls note-*.md >/dev/null 2>&1 && exit 0; until git -C ${JSON.stringify(bare)} for-each-ref refs/heads/task | grep -q .; do sleep 0.05; done`;

    // when
    const done = await startedTogether(
      ctx,
      root,
      [
        { title: "Add a note", agent: "fake" },
        { title: "Refresh", agent: "orchestrator", template: { kind: "scaffold.refresh", commitVersioning: false } },
      ],
      waitForTask,
    );

    // then
    expect(done.map((t) => t.status)).toEqual(["needs-review", "needs-review"]);
    expect(done.map((t) => versionOn(bare, `task/${t.id}`)).sort()).toEqual(["0.1.6", "0.1.7"]);
    const refresh = `task/${done[1]!.id}`;
    expect(git(["notes", "--ref", localDescriptionRef(refresh), "show", refresh], bare)).toContain(`Raises the plugin to version ${versionOn(bare, refresh)}`);
  });
});
