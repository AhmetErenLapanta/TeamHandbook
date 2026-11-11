import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { vi } from "vitest";
import { seed } from "../demo/seed.js";
import { mirrorDir, syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { Principal } from "./auth.js";
import { openSqliteStore } from "./store.js";
import type { RepoRecord } from "./store.js";

/**
 * Repositories and the orchestrator's mirrors of them, made once per test process and copied for
 * each test. Making the demo's runs about forty git processes, and on a machine whose endpoint
 * protection checks every process start that costs most of a minute each time; a copy of the
 * same folders runs none and leaves the same repositories, mirrors and heads.
 */
interface Template<T> {
  root: string;
  made: T;
}

const templates = new Map<string, Promise<Template<unknown>>>();

/** The files that name a folder by its path: an orchestrator's configuration and a git repository's own. */
const NAMING = ["orchestrator.json", "config"];

/** Every naming file under `dir` that holds `from`, rewritten to hold `to`. */
function repoint(dir: string, from: string, to: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !NAMING.includes(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    const text = readFileSync(file, "utf8");
    if (text.includes(from)) writeFileSync(file, text.split(from).join(to));
  }
}

/**
 * A fresh copy of what `build` made under a root of its own, built the first time `name` is
 * asked for. `build` gets the template's root and returns what a test needs to know of it, with
 * every path in it under that root; the copy hands it back with those paths under the new root.
 */
export async function copyOf<T>(name: string, prefix: string, build: (root: string) => Promise<T>, parent: string = tmpdir()): Promise<{ root: string; made: T }> {
  let template = templates.get(name) as Promise<Template<T>> | undefined;
  if (!template) {
    template = (async () => {
      const root = mkdtempSync(join(tmpdir(), "orchestrator-template-"));
      process.once("exit", () => rmSync(root, { recursive: true, force: true }));
      return { root, made: await build(root) };
    })();
    templates.set(name, template);
  }
  const { root: from, made } = await template;
  const root = mkdtempSync(join(parent, prefix));
  cpSync(from, root, { recursive: true });
  repoint(root, from, root);
  return { root, made: JSON.parse(JSON.stringify(made).split(from).join(root)) as T };
}

interface DemoTemplate {
  configFile: string;
  config: { tenant: string; repos: (Omit<RepoRecord, "tenant" | "head" | "syncedAt" | "error"> & Record<string, unknown>)[] };
  heads: Record<string, string>;
}

/** The demo's team repositories as `seed` leaves them, and the orchestrator's mirrors of them under `data/` as a sync of each leaves them. */
function demoCopy(prefix: string, defaultBranch: string, parent: string) {
  return copyOf<DemoTemplate>(`demo:${defaultBranch}`, prefix, async (root) => {
    const { configFile } = seed(join(root, "demo"), defaultBranch);
    const config = JSON.parse(readFileSync(configFile, "utf8")) as DemoTemplate["config"];
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
    const heads: Record<string, string> = {};
    for (const repo of config.repos) {
      await ctx.store.upsertRepo({ ...repo, tenant: config.tenant });
      const synced = await syncRepo(ctx, repo.id);
      if (!("head" in synced)) throw new Error(`the seeded ${repo.id} did not sync: ${synced.error}`);
      heads[repo.id] = synced.head;
    }
    return { configFile, config, heads };
  }, parent);
}

/**
 * The seeded demo as an orchestrator's context: its repositories recorded in a fresh in-memory store
 * at the heads their copied mirrors hold, as after a sync; `repos` narrows which are connected.
 * `parent` is where the copy goes: a test whose task opens a proxy needs a short one, since a
 * socket's path has a limit.
 */
export async function seededContext(prefix = "orchestrator-test-", repos?: readonly string[], defaultBranch = "main", parent: string = tmpdir()): Promise<{ ctx: OrchestratorContext; root: string; configFile: string; config: DemoTemplate["config"] }> {
  const { root, made } = await demoCopy(prefix, defaultBranch, parent);
  const { config, heads, configFile } = made;
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  for (const repo of config.repos) {
    if (repos && !repos.includes(repo.id)) {
      rmSync(mirrorDir(ctx, repo.id), { recursive: true, force: true });
      continue;
    }
    await ctx.store.upsertRepo({ ...repo, tenant: config.tenant });
    await ctx.store.recordSync(ctx.tenant, repo.id, { head: heads[repo.id]! });
  }
  return { ctx, root, configFile, config };
}

/**
 * `principals` as accounts on record, a person's or a service account's by its id, with the teams
 * each owns: a task reads its starter again as its agent starts, and a starter the orchestrator
 * holds no account for is gone, so it never runs.
 */
export async function storePrincipals(ctx: Pick<OrchestratorContext, "store" | "tenant">, ...principals: Principal[]): Promise<void> {
  for (const p of principals) {
    const createdAt = new Date().toISOString();
    if (p.id.startsWith("service:")) await ctx.store.saveServiceAccount({ tenant: ctx.tenant, id: p.id.slice("service:".length), name: p.name, createdBy: "owner@example.invalid", createdAt });
    else await ctx.store.insertUser({ tenant: ctx.tenant, id: p.id, email: p.email, name: p.name, role: p.role, passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: p.forgeLogin ?? null, createdAt });
    if (p.ownedTeams.length) await ctx.store.setOwnedTeams(ctx.tenant, p.id, p.ownedTeams);
  }
}

/**
 * A stand-in for 1Password's `op` CLI under `dir`, holding `items` by reference, set up as the
 * orchestrator's op with a service account token and the vault Payments. It reads `inject` and
 * `read` as the real one does and exits 1 for an item it does not hold. An `op` first on PATH
 * refuses to run, so a lookup that missed ORCHESTRATOR_OP_BIN fails rather than reaching a real one.
 */
export function fakeOpCli(dir: string, items: Record<string, string>): void {
  const refusing = join(dir, "refusing-bin");
  mkdirSync(refusing, { recursive: true });
  writeFileSync(join(refusing, "op"), "#!/bin/sh\necho 'a test reached op on PATH' >&2\nexit 97\n");
  const bin = join(dir, "fake-op.mjs");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const items = ${JSON.stringify(items)};
const args = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8").on("data", (chunk) => (input += chunk)).on("end", () => {
  if (args.includes("read")) {
    const ref = args.at(-1);
    if (!(ref in items)) process.exit(1);
    process.stdout.write(items[ref]);
    return;
  }
  let missing = false;
  const out = input.replace(/\\{\\{ (op:\\/\\/[^}]+?) \\}\\}/g, (_all, ref) => (ref in items ? items[ref] : ((missing = true), "")));
  if (missing) process.exit(1);
  process.stdout.write(out);
});
`,
  );
  chmodSync(bin, 0o755);
  chmodSync(join(refusing, "op"), 0o755);
  vi.stubEnv("PATH", `${refusing}${delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("ORCHESTRATOR_OP_BIN", bin);
  vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "ops_stand-in-token");
  vi.stubEnv("ORCHESTRATOR_1PASSWORD_VAULTS", "Payments");
}

/**
 * A stand-in for the claude CLI under `dir`, never the real one: it records its arguments into
 * `$HOME/claude-argv.json` and answers as one print-mode run that changed nothing.
 */
export function claudeArgvStandIn(dir: string): string {
  const bin = join(dir, "claude-stand-in.mjs");
  writeFileSync(
    bin,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
// The orchestrator's own read of the person's setup runs this same program at any moment of a run: its plugin list is
// answered with none, its session with nothing, and neither writes over the arguments the task's call left.
if (process.argv[2] === "plugin") {
  console.log("[]");
  process.exit(0);
}
// A two-way session keeps its input open for the next message, so only its first line is read before the turn ends.
const firstLine = async () => { for await (const line of createInterface({ input: process.stdin })) return line; return ""; };
const heard = process.argv.includes("--input-format") ? await firstLine() : readFileSync(0, "utf8");
if (heard.includes("teamhandbook-probe-initialize")) process.exit(0);
writeFileSync(process.env.HOME + "/claude-argv.json", JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Done.", total_cost_usd: 0 }));
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}
