import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "./app.js";
import { AccountError } from "./accounts.js";
import { manages } from "./auth.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { recordEvent } from "./events.js";
import { NO_VAULT, readSecret, storeSecret } from "./vault.js";
import type { SecretReference } from "../shared/secret-providers.js";
import { opVaults, referenceKey, SECRET_PROVIDERS, secretResolver } from "./secret-providers.js";
import type { SecretProvider } from "./secret-providers.js";
import { secretSettingValue } from "./secret-writes.js";

/**
 * Secrets a task's agent gets as environment variables, for one team's repositories or for one
 * repository. An owner or an admin writes a value once on the screen; after that the orchestrator
 * shows its name, when it changed and by whom, never the value. Each value is sealed in the
 * vault under its own name, so a sealed value copied to another name or tenant does not open.
 * A secret can instead name where its value is read, a 1Password item, which is kept sealed in
 * its place and read each time a task starts.
 */
export type SecretScope = "team" | "repo";

export interface TaskSecretView {
  scope: SecretScope;
  /** The team's name or the repository's id. */
  target: string;
  name: string;
  updatedAt: string;
  updatedBy: string;
  /** Where the value is read when a task starts, for a secret that names one instead of holding it. */
  reference?: SecretReference;
}

const PREFIX = "task.secret.";
const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Values longer than this are files, not secrets an environment variable carries. */
export const MAX_SECRET_BYTES = 8192;
/** The shortest value the task log's redactor masks; a shorter one would reach the log as written. */
export const MIN_SECRET_LENGTH = 8;
/**
 * Starts a sealed value that is a reference rather than the secret itself: a value written on
 * the screen never holds a NUL, so no value can be read back as a reference.
 */
const REFERENCE = "\0reference:";
/**
 * Where a task secret is read from besides the vault. The vault itself is left out: a task
 * secret naming another would only give it a second name, and the vault's read returns the
 * other's sealed row as it is, a reference included.
 */
export const TASK_SECRET_PROVIDERS: Readonly<Record<string, SecretProvider>> = { op: SECRET_PROVIDERS.op };

/** A task secret named by reference whose value was not read; the task it was for does not start. */
export class UnreadTaskSecret extends Error {}

/**
 * Names a task's process depends on, which a secret would quietly replace: where programs are
 * found and loaded from, who and where the process is, and the credentials the agent signs in
 * to its model with, which the operator sets.
 */
const RESERVED = new Set(["PATH", "HOME", "SHELL", "USER", "LOGNAME", "PWD", "TMPDIR", "TEMP", "TMP", "LANG", "TERM", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "GIT_DIR", "GIT_WORK_TREE", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"]);
const RESERVED_PREFIXES = ["LD_", "DYLD_", "GIT_CONFIG", "ORCHESTRATOR_", "TEAMHANDBOOK_"];

export function cleanSecretName(name: unknown): string {
  const text = typeof name === "string" ? name.trim() : "";
  if (!NAME.test(text)) throw new AccountError("a secret's name is an environment variable name: capital letters, digits and underscores, up to 64");
  if (RESERVED.has(text) || RESERVED_PREFIXES.some((p) => text.startsWith(p))) throw new AccountError(`${text} is set by the orchestrator or the system for every task; pick another name`);
  return text;
}

function cleanValue(value: unknown): string {
  if (typeof value !== "string" || !value) throw new AccountError("enter the secret's value");
  if (value.includes("\0")) throw new AccountError("a secret's value cannot hold a NUL character");
  if (value.length < MIN_SECRET_LENGTH) throw new AccountError(`a secret's value is at least ${MIN_SECRET_LENGTH} characters; a shorter one could not be masked in the task's log`);
  if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new AccountError(`a secret's value is at most ${MAX_SECRET_BYTES} bytes`);
  return value;
}

/** A team's name with every dot encoded too, so the dots in a key only ever separate its parts. */
export function secretKey(scope: SecretScope, target: string, name: string): string {
  return `${PREFIX}${scope}.${encodeURIComponent(target).replaceAll(".", "%2E")}.${name}`;
}

function parseKey(key: string): { scope: SecretScope; target: string; name: string } | null {
  const rest = key.slice(PREFIX.length);
  const match = /^(team|repo)\.([^.]+)\.([A-Z0-9_]+)$/.exec(rest);
  if (!match) return null;
  return { scope: match[1] as SecretScope, target: decodeURIComponent(match[2]!), name: match[3]! };
}

async function cleanTarget(ctx: OrchestratorContext, scope: unknown, target: unknown): Promise<{ scope: SecretScope; target: string }> {
  if (scope !== "team" && scope !== "repo") throw new AccountError("a secret belongs to a team or to a repository");
  const repos = await ctx.store.listRepos(ctx.tenant);
  const known = scope === "team" ? repos.some((r) => r.team === target) : repos.some((r) => r.id === target);
  if (typeof target !== "string" || !known) throw new AccountError(scope === "team" ? `no connected repository belongs to the team ${String(target)}` : `no connected repository is ${String(target)}`, 404);
  return { scope, target };
}

function managersOnly(actor: Principal): AccountError | null {
  if (actor.key) return new AccountError("an API key cannot read or change task secrets", 403);
  return manages(actor) ? null : new AccountError("only an owner or an admin manages task secrets", 403);
}

const referenceIn = (sealed: string | null): SecretReference | null => (sealed?.startsWith(REFERENCE) ? (JSON.parse(sealed.slice(REFERENCE.length)) as SecretReference) : null);

export async function listTaskSecrets(ctx: OrchestratorContext): Promise<TaskSecretView[]> {
  const views: TaskSecretView[] = [];
  for (const s of await ctx.store.listSecrets(ctx.tenant, PREFIX)) {
    const parsed = parseKey(s.name);
    if (!parsed) continue;
    const reference = referenceIn(await readSecret(ctx.store, ctx.vault ?? null, ctx.tenant, s.name).catch(() => null));
    views.push({ ...parsed, updatedAt: s.updatedAt, updatedBy: s.updatedBy, ...(reference ? { reference } : {}) });
  }
  return views;
}

/** The 1Password vaults a task secret names its items in, or null when this orchestrator reads none: no service account token, or no vault named. */
export function opReach(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const vaults = [...opVaults(env)];
  return env.OP_SERVICE_ACCOUNT_TOKEN && vaults.length ? vaults : null;
}

/** A task secret is a `value`, or a `secret` naming where it is read: `{ provider: "op", reference: "op://vault/item/field" }`. */
export async function setTaskSecret(ctx: OrchestratorContext, actor: Principal, input: { scope?: unknown; target?: unknown; name?: unknown; value?: unknown; secret?: unknown }): Promise<TaskSecretView> {
  const refused = managersOnly(actor);
  if (refused) throw refused;
  if (!ctx.vault) throw new AccountError(NO_VAULT, 409);
  const { scope, target } = await cleanTarget(ctx, input.scope, input.target);
  const name = cleanSecretName(input.name);
  if ((input.value === undefined) === (input.secret === undefined)) throw new AccountError("a secret is either a value or a secret naming where it is read, not both");
  const given = input.secret === undefined ? null : secretSettingValue(actor, input.secret, [], TASK_SECRET_PROVIDERS);
  const reference = given && "provider" in given ? given : null;
  const value = reference ? `${REFERENCE}${JSON.stringify({ provider: reference.provider, reference: reference.reference })}` : cleanValue(given && "literal" in given ? given.literal : input.value);
  await storeSecret(ctx.store, ctx.vault, ctx.tenant, secretKey(scope, target, name), value, actor.email);
  const at = await ctx.store.secretSetAt(ctx.tenant, secretKey(scope, target, name));
  return { scope, target, name, updatedAt: at!.updatedAt, updatedBy: at!.updatedBy, ...(reference ? { reference } : {}) };
}

export async function deleteTaskSecret(ctx: OrchestratorContext, actor: Principal, input: { scope?: unknown; target?: unknown; name?: unknown }): Promise<void> {
  const refused = managersOnly(actor);
  if (refused) throw refused;
  if (input.scope !== "team" && input.scope !== "repo") throw new AccountError("a secret belongs to a team or to a repository");
  const key = secretKey(input.scope, String(input.target ?? ""), cleanSecretName(input.name));
  if (!(await ctx.store.secretSetAt(ctx.tenant, key))) throw new AccountError("no such secret", 404);
  await ctx.store.deleteSecret(ctx.tenant, key);
}

/**
 * The secrets a task on `repoId`, of `team`, runs with: the team's, then the repository's, a
 * repository's value replacing the team's of the same name. Read when the task starts, so a
 * value changed later reaches the next task. A value the vault cannot open stops the task
 * rather than starting it without what it was meant to have. A secret named by reference is read
 * now, and one not read, or read as a value no task secret could be, throws UnreadTaskSecret: a
 * check that masks the task's secrets would otherwise pass what it could not see.
 */
export async function secretsForTask(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">, repoId: string, team: string, providers: Readonly<Record<string, SecretProvider>> = TASK_SECRET_PROVIDERS): Promise<{ name: string; value: string }[]> {
  const all = await ctx.store.listSecrets(ctx.tenant, PREFIX);
  const byName = new Map<string, string | SecretReference>();
  for (const scope of ["team", "repo"] as const) {
    const target = scope === "team" ? team : repoId;
    for (const s of all) {
      const parsed = parseKey(s.name);
      if (!parsed || parsed.scope !== scope || parsed.target !== target) continue;
      const value = await readSecret(ctx.store, ctx.vault ?? null, ctx.tenant, s.name);
      if (value === null) continue;
      byName.set(parsed.name, referenceIn(value) ?? value);
    }
  }
  const references = [...byName.values()].filter((v): v is SecretReference => typeof v !== "string");
  const read = references.length ? await secretResolver({ store: ctx.store, vault: ctx.vault ?? null, tenant: ctx.tenant }, providers).resolve(references) : new Map<string, string | undefined>();
  return [...byName].sort(([a], [b]) => a.localeCompare(b)).map(([name, held]) => {
    if (typeof held === "string") return { name, value: held };
    const value = read.get(referenceKey(held));
    if (!value || value.includes("\0") || Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new UnreadTaskSecret(`the task secret ${name} is read from ${held.reference}, and that read returned no value a task secret can be`);
    return { name, value };
  });
}

function failure(c: Context, err: unknown) {
  if (err instanceof AccountError) return c.json({ error: err.message }, err.status);
  throw err;
}

export function taskSecretRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();

  app.get("/api/task-secrets", async (c) => {
    const refused = managersOnly(c.get("user"));
    if (refused) return failure(c, refused);
    return c.json({ secrets: await listTaskSecrets(ctx), vault: Boolean(ctx.vault), op: opReach() });
  });

  app.put("/api/task-secrets", async (c) => {
    try {
      const saved = await setTaskSecret(ctx, c.get("user"), await c.req.json().catch(() => ({})));
      await recordEvent(ctx, c.get("user"), "task-secret.set", { repoId: saved.scope === "repo" ? saved.target : null, subject: `secret:${saved.name}`, detail: `${saved.name} for ${saved.scope === "team" ? "team" : "repository"} ${saved.target}; ${saved.reference ? `read from ${saved.reference.reference}` : "the value is not recorded"}` });
      return c.json({ secret: saved });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.delete("/api/task-secrets", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { scope?: unknown; target?: unknown; name?: unknown };
      await deleteTaskSecret(ctx, c.get("user"), body);
      await recordEvent(ctx, c.get("user"), "task-secret.deleted", { repoId: body.scope === "repo" ? String(body.target) : null, subject: `secret:${String(body.name)}`, detail: `${String(body.name)} for ${body.scope === "team" ? "team" : "repository"} ${String(body.target)} deleted` });
      return c.json({ ok: true });
    } catch (err) {
      return failure(c, err);
    }
  });

  return app;
}
