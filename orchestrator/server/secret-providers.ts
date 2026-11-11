import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretProviderKind, SecretReference } from "../shared/secret-providers.js";
import type { SecretStore, Vault } from "./vault.js";
import { readSecret } from "./vault.js";

/** What a provider reads in: one organization's vault, and the process's environment. */
export interface SecretScope {
  store: SecretStore;
  vault: Vault | null;
  tenant: string;
  env?: NodeJS.ProcessEnv;
  /**
   * The task secrets within reach of the one who wrote the reference, as name prefixes: a team's setting
   * reaches that team's and its repositories' task secrets, never another team's. None given, the
   * vault answers nothing.
   */
  vaultPrefixes?: readonly string[];
}

export interface SecretProviderDefinition {
  kind: SecretProviderKind;
  /** Whether a reference has the shape this provider reads; one that does not is never sent to it. */
  isReference(reference: string): boolean;
  /** What the screen shows as an example of a reference. */
  placeholder: string;
}

export interface SecretProviderDriver {
  /** The value of each reference, undefined for one it cannot read; it never throws, so one unreadable value does not hide the rest. */
  read(scope: SecretScope, references: readonly string[]): Promise<Map<string, string | undefined>>;
}

export interface SecretProvider {
  definition: SecretProviderDefinition;
  driver: SecretProviderDriver;
}

export function defineSecretProvider(definition: SecretProviderDefinition, driver: SecretProviderDriver): SecretProvider {
  return { definition, driver };
}

// Only variables named for the purpose are read: a reference to any other name would let a
// setting read ORCHESTRATOR_SECRET_KEY or the database address out of the orchestrator's own environment.
const ENV_PREFIX = "TEAMHANDBOOK_SECRET_";
const ENV_NAME = new RegExp(`^${ENV_PREFIX}[A-Z0-9_]{1,64}$`);
// Only task secrets are named by reference: the vault also holds forge connections, tracker
// tokens, Slack addresses and key secrets, and no reference reaches those.
const TASK_SECRET = /^task\.secret\.[A-Za-z0-9.:_%-]{1,240}$/;

const vaultProvider = defineSecretProvider(
  { kind: "vault", isReference: (reference) => TASK_SECRET.test(reference), placeholder: "task.secret.team.Payments.NPM_TOKEN" },
  {
    async read(scope, references) {
      const values = new Map<string, string | undefined>();
      // A prefix ends at a dot, as a write's does, so the Pay team's reaches none of Payments' secrets.
      const allowed = (name: string) => (scope.vaultPrefixes ?? []).some((prefix) => prefix.startsWith("task.secret.") && prefix.endsWith(".") && name.startsWith(prefix));
      for (const name of references) values.set(name, allowed(name) ? ((await readSecret(scope.store, scope.vault, scope.tenant, name).catch(() => null)) ?? undefined) : undefined);
      return values;
    },
  },
);

const envProvider = defineSecretProvider(
  { kind: "env", isReference: (reference) => ENV_NAME.test(reference), placeholder: `${ENV_PREFIX}NPM_TOKEN` },
  {
    async read(scope, references) {
      const env = scope.env ?? process.env;
      return new Map(references.map((name) => [name, env[name] || undefined]));
    },
  },
);

/** How long one call to `op` gets before its values count as unread. */
const OP_TIMEOUT_MS = 45_000;
// A vault, an item, an optional section and a field, in characters that cannot close the
// template's braces or start a new line: a reference is put in an `op inject` template as written.
const OP_PART = "[A-Za-z0-9 ._-]{1,100}";
const OP_REFERENCE = new RegExp(`^op://(${OP_PART})/${OP_PART}(?:/${OP_PART}){1,2}$`);

export type OpRun = (bin: string, args: readonly string[], env: Record<string, string>, input: string) => Promise<{ code: number | null; stdout: string }>;

const runOp: OpRun = (bin, args, env, input) =>
  new Promise((resolve) => {
    const child = spawn(bin, [...args], { env, stdio: ["pipe", "pipe", "ignore"], timeout: OP_TIMEOUT_MS });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => void (stdout.length < 1_048_576 && (stdout += chunk)));
    child.on("error", () => resolve({ code: null, stdout: "" }));
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(input);
  });

/** The 1Password vaults this orchestrator reads, as its operator names them in ORCHESTRATOR_1PASSWORD_VAULTS. */
export function opVaults(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.ORCHESTRATOR_1PASSWORD_VAULTS ?? "").split(",").map((v) => v.trim()).filter(Boolean));
}

/** The vault an op:// reference names, or null for one that is not a reference. */
export function opVaultOf(reference: string): string | null {
  return OP_REFERENCE.exec(reference)?.[1] ?? null;
}

/**
 * 1Password, read on the orchestrator's machine only, with the service account token its operator
 * set (OP_SERVICE_ACCOUNT_TOKEN) and only from the vaults they name in ORCHESTRATOR_1PASSWORD_VAULTS:
 * a reference to any other vault is not read, so a setting cannot reach what the account holds for
 * something else. A runner on a person's machine never reads their own 1Password session. The values
 * come in one `op inject` with a separator nobody can guess, and one by one with `op read` when
 * that fails, which it does as a whole for a single missing item; the CLI keeps no cache.
 */
export function opProvider(run: OpRun = runOp): SecretProvider {
  return defineSecretProvider(
    { kind: "op", isReference: (reference) => OP_REFERENCE.test(reference), placeholder: "op://Payments/npm/credential" },
    {
      async read(scope, references) {
        const env = scope.env ?? process.env;
        const token = env.OP_SERVICE_ACCOUNT_TOKEN;
        const vaults = opVaults(env);
        const values = new Map<string, string | undefined>(references.map((r) => [r, undefined]));
        const wanted = references.filter((r) => vaults.has(opVaultOf(r) ?? ""));
        if (!token || !wanted.length) return values;
        const config = await mkdtemp(join(tmpdir(), "th-op-"));
        try {
          const opEnv = { PATH: env.PATH ?? "/usr/bin:/bin", OP_SERVICE_ACCOUNT_TOKEN: token, OP_CONFIG_DIR: config };
          const bin = env.ORCHESTRATOR_OP_BIN || "op";
          const sep = `--${randomBytes(16).toString("hex")}--`;
          const injected = await run(bin, ["--cache=false", "inject"], opEnv, wanted.map((r, i) => `${sep}${i}\n{{ ${r} }}\n`).join("") + sep);
          if (injected.code === 0) {
            for (const part of injected.stdout.split(sep).slice(1, -1)) {
              const at = part.indexOf("\n");
              const ref = wanted[Number(part.slice(0, at))];
              if (ref) values.set(ref, part.slice(at + 1, -1) || undefined);
            }
            return values;
          }
          for (const ref of wanted) {
            const one = await run(bin, ["--cache=false", "read", "--no-newline", ref], opEnv, "");
            values.set(ref, one.code === 0 && one.stdout ? one.stdout : undefined);
          }
          return values;
        } finally {
          await rm(config, { recursive: true, force: true });
        }
      },
    },
  );
}

/** The providers a reference is read through, by kind; the shared list of kinds is what the screens offer. */
export const SECRET_PROVIDERS: Record<SecretProviderKind, SecretProvider> = { vault: vaultProvider, env: envProvider, op: opProvider() };

export const referenceKey = (ref: SecretReference) => `${ref.provider}:${ref.reference}`;

/**
 * Reads references in one batch per provider, one read at a time per provider, and keeps every
 * answer, an unreadable one too, until `invalidate`: a task that names a secret five times reads
 * it once, and a setting changed is read again only when the caller says so.
 */
export function secretResolver(scope: SecretScope, providers: Readonly<Record<string, SecretProvider>> = SECRET_PROVIDERS) {
  const kept = new Map<string, string | undefined>();
  const turns = new Map<string, Promise<unknown>>();
  const inTurn = <T>(kind: string, work: () => Promise<T>): Promise<T> => {
    const run = (turns.get(kind) ?? Promise.resolve()).then(work, work);
    turns.set(kind, run.catch(() => undefined));
    return run;
  };
  return {
    async resolve(refs: readonly SecretReference[]): Promise<Map<string, string | undefined>> {
      const wanted = new Map<string, Set<string>>();
      for (const ref of refs) {
        if (kept.has(referenceKey(ref))) continue;
        const provider = providers[ref.provider];
        // A reference to no provider, or in a shape its provider does not read, stays unread.
        if (!provider || !provider.definition.isReference(ref.reference)) {
          kept.set(referenceKey(ref), undefined);
          continue;
        }
        wanted.set(ref.provider, (wanted.get(ref.provider) ?? new Set()).add(ref.reference));
      }
      await Promise.all(
        [...wanted].map(([kind, names]) =>
          inTurn(kind, async () => {
            const values = await providers[kind]!.driver.read(scope, [...names]).catch(() => new Map<string, string | undefined>());
            for (const name of names) kept.set(`${kind}:${name}`, values.get(name));
          }),
        ),
      );
      return new Map(refs.map((ref) => [referenceKey(ref), kept.get(referenceKey(ref))]));
    },
    /** Forgets one reference's answer, or every answer. */
    invalidate(ref?: SecretReference): void {
      if (ref) kept.delete(referenceKey(ref));
      else kept.clear();
    },
  };
}

