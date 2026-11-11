import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../auth.js";
import { localDescriptionRef, localRepoPath } from "../forge/local.js";
import { git } from "../git.js";
import { secretKey, setTaskSecret } from "../task-secrets.js";
import { createVault, storeSecret } from "../vault.js";
import { fakeAgentAdapter } from "./agents.js";
import { createTaskRunner } from "./runner.js";
import type { RunnerOptions } from "./runner.js";
import { fakeOpCli, seededContext, storePrincipals } from "../test-fixtures.js";
import type { SecretReference } from "../../shared/secret-providers.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const TEAM_VALUE = "team-registry-token-0123456789";
const REPO_VALUE = "repo-registry-token-9876543210";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The seeded Payments repository with a vault, its team's NPM_TOKEN and the repository's own, a value or an item it is read from, and an agent running `body`. */
async function withSecrets(body: string, overrides: Partial<RunnerOptions> = {}, repoValue: string | SecretReference = REPO_VALUE) {
  const { ctx, root, config } = await seededContext("orchestrator-task-secrets-", ["payments-skills"]);
  await storePrincipals(ctx, ADMIN);
  dirs.push(root);
  ctx.vault = createVault(randomBytes(32));
  const entry = config.repos.find((r) => r.id === "payments-skills")!;
  await setTaskSecret(ctx, ADMIN, { scope: "team", target: "Payments", name: "NPM_TOKEN", value: TEAM_VALUE });
  // The saving path refuses a value too short to mask; one stored before that rule is written
  // straight into the vault, as it would sit there, so the start's own refusal is what is tested.
  if (typeof repoValue !== "string") await setTaskSecret(ctx, ADMIN, { scope: "repo", target: "payments-skills", name: "NPM_TOKEN", secret: repoValue });
  else if (repoValue.length < 8) await storeSecret(ctx.store, ctx.vault!, ctx.tenant, secretKey("repo", "payments-skills", "NPM_TOKEN"), repoValue, ADMIN.email);
  else await setTaskSecret(ctx, ADMIN, { scope: "repo", target: "payments-skills", name: "NPM_TOKEN", value: repoValue });
  const script = join(root, "agent.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";\n${body}\nconsole.log(JSON.stringify({ type: "result", summary: "Done." }));\n`);
  const tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(script)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH }, ...overrides });
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const started = await tasks.start({ repo, title: "Bump the registry", description: "", agent: "fake", user: ADMIN });
  await tasks.idle();
  const task = (await ctx.store.getTask(ctx.tenant, started.id))!;
  const log = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
  return { ctx, task, log, bare: localRepoPath(entry.url)! };
}

describe("the vault's task secrets in a task", () => {
  it("given a team secret and the repository's own of the same name, when the agent runs, then it has the repository's value, the log masks it and names it only, and the request never carries it", async () => {
    // when
    const { ctx, task, log, bare } = await withSecrets(
      `console.log(JSON.stringify({ type: "log", text: "token is " + process.env.NPM_TOKEN }));\nwriteFileSync("seen.md", String(process.env.NPM_TOKEN === ${JSON.stringify(REPO_VALUE)}) + "\\n");`,
    );

    // then
    expect(task.status).toBe("needs-review");
    expect(log).toContain("The task runs with these task secrets, by name: NPM_TOKEN.");
    expect(log).toContain("token is [redacted:credential]");
    expect(log.join("\n")).not.toContain(REPO_VALUE);
    const branch = `task/${task.id}`;
    expect(git(["show", `${branch}:seen.md`], bare).trim()).toBe("true");
    expect(git(["notes", "--ref", localDescriptionRef(branch), "show", branch], bare)).not.toContain(REPO_VALUE);
    const events = await ctx.store.eventPage(ctx.tenant, {}, null, 50);
    expect(JSON.stringify(events)).toContain("ran with the task secrets NPM_TOKEN");
    expect(JSON.stringify(events)).not.toContain(REPO_VALUE);
  });

  it("given an agent that writes a secret's value into a file, when the task ends, then no request opens", async () => {
    // when
    const { ctx, task } = await withSecrets(`writeFileSync(".npmrc", "//registry.npmjs.org/:_authToken=" + process.env.NPM_TOKEN + "\\n");`);

    // then
    expect(task.status).toBe("failed");
    expect(await ctx.store.listRequests(ctx.tenant)).toEqual([]);
  });

  it("given a secret whose name the orchestrator also passes to tasks, when the task starts, then it does not run and names the variable", async () => {
    // when
    const { task, log } = await withSecrets(`writeFileSync("note.md", "x\\n");`, { passEnv: ["NPM_TOKEN"], hostEnv: { PATH: process.env.PATH, NPM_TOKEN: "host-registry-token-555555" } });

    // then
    expect(task).toMatchObject({ status: "failed", error: "The task did not run: NPM_TOKEN is set both as a task secret and on the orchestrator (ORCHESTRATOR_TASK_ENV_PASS or the agent's credential); remove one of them." });
    expect(log.some((l) => l.startsWith("Starting"))).toBe(false);
  });
});

describe("a task secret too short to mask", () => {
  it("given a repository's secret of five characters stored before the vault refused short values, when the task starts, then it does not run and says the value is too short", async () => {
    // when
    const { task, log } = await withSecrets(`writeFileSync("note.md", "x\\n");`, {}, "ab12c");

    // then
    expect(task).toMatchObject({ status: "failed", error: "The task did not run: the task secret NPM_TOKEN is shorter than 8 characters, too short to mask in what the task writes; set a longer value." });
    expect(log.join("\n")).not.toContain("ab12c");
  });
});

describe("a task secret read from 1Password as the task starts", () => {
  const ITEM: SecretReference = { provider: "op", reference: "op://Payments/npm/credential" };
  const ITEM_VALUE = "op-registry-token-2468013579";
  const opHolding = (items: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "orchestrator-task-op-"));
    dirs.push(dir);
    fakeOpCli(dir, items);
  };

  it("given the repository's NPM_TOKEN named by an item op holds, when the agent runs, then it has the item's value and the log masks it", async () => {
    // given
    opHolding({ [ITEM.reference]: ITEM_VALUE });

    // when
    const { task, log, bare } = await withSecrets(`console.log(JSON.stringify({ type: "log", text: "token is " + process.env.NPM_TOKEN }));\nwriteFileSync("seen.md", String(process.env.NPM_TOKEN === ${JSON.stringify(ITEM_VALUE)}) + "\\n");`, {}, ITEM);

    // then
    expect(task.status).toBe("needs-review");
    expect(git(["show", `task/${task.id}:seen.md`], bare).trim()).toBe("true");
    expect(log).toContain("token is [redacted:credential]");
    expect(log.join("\n")).not.toContain(ITEM_VALUE);
  });

  it("given the repository's NPM_TOKEN named by an item op does not hold, when the task starts, then it does not run and names the secret and the item", async () => {
    // given
    opHolding({});

    // when
    const { task } = await withSecrets(`writeFileSync("note.md", "x\\n");`, {}, ITEM);

    // then
    expect(task).toMatchObject({ status: "failed", error: `The task did not run: the task secret NPM_TOKEN is read from ${ITEM.reference}, and that read returned no value a task secret can be.` });
  });
});
