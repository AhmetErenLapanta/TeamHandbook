import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSecretEnv } from "./secret-env.js";

/**
 * Forge tokens at rest. The database holds only ciphertext; the key comes from
 * ORCHESTRATOR_SECRET_KEY and never enters the database, so a copied database file opens no
 * forge. Each value is bound to its tenant and name as additional data: a ciphertext moved
 * to another row fails to open instead of handing one team's token to another.
 *
 * No message this module produces carries a value, sealed or plain.
 */
export interface SecretStore {
  putSecret(tenant: string, name: string, sealed: string, by: string): Promise<void>;
  getSecret(tenant: string, name: string): Promise<string | null>;
  secretSetAt(tenant: string, name: string): Promise<{ updatedAt: string; updatedBy: string } | null>;
  deleteSecret(tenant: string, name: string): Promise<void>;
  /** The names starting with `prefix`, with when and by whom each was set; never a sealed value. */
  listSecrets(tenant: string, prefix: string): Promise<{ name: string; updatedAt: string; updatedBy: string }[]>;
}

export interface Vault {
  seal(tenant: string, name: string, value: string): string;
  open(tenant: string, name: string, sealed: string): string;
  /** An HMAC of `data` under a key derived from the vault's for `purpose` alone, so a signature made for one purpose never verifies for another. */
  mac(purpose: string, data: string): string;
}

const VERSION = "v1";

/** 32 bytes, written as 64 hex characters or as base64. Anything else is refused rather than stretched. */
export function parseSecretKey(raw: string): Buffer {
  const text = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/]{43}=?$/.test(text)) return Buffer.from(text, "base64");
  throw new Error("ORCHESTRATOR_SECRET_KEY must be 32 bytes, as 64 hex characters or base64 (openssl rand -base64 32)");
}

function aad(tenant: string, name: string): Buffer {
  return Buffer.from(`${tenant}\u0000${name}`, "utf8");
}

export function createVault(key: Buffer): Vault {
  if (key.length !== 32) throw new Error("the vault key must be 32 bytes");
  return {
    seal(tenant, name, value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad(tenant, name));
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
    },
    mac(purpose, data) {
      const derived = Buffer.from(hkdfSync("sha256", key, "teamhandbook-orchestrator", purpose, 32));
      return createHmac("sha256", derived).update(data).digest("base64url");
    },
    open(tenant, name, sealed) {
      const [version, iv, tag, body] = sealed.split(".");
      if (version !== VERSION || !iv || !tag || body === undefined) throw new Error(`the stored ${name} is not in a format this orchestrator reads`);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
        decipher.setAAD(aad(tenant, name));
        decipher.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
      } catch {
        throw new Error(`the stored ${name} does not open: ORCHESTRATOR_SECRET_KEY is not the key it was sealed with, or the row was altered`);
      }
    },
  };
}

/** The vault the environment configures, or null when no key is set: then no token can be stored at all. */
export function vaultFromEnv(env: NodeJS.ProcessEnv = process.env): Vault | null {
  const key = readSecretEnv(env, "ORCHESTRATOR_SECRET_KEY");
  return key ? createVault(parseSecretKey(key)) : null;
}

export const NO_VAULT = "this orchestrator keeps no sign-ins, tokens or other secrets until whoever runs it sets ORCHESTRATOR_SECRET_KEY (32 random bytes, as from openssl rand -base64 32) and starts it again";

/** Where a single person's orchestrator keeps the key it made for itself, in its data directory. */
export const GENERATED_KEY_FILE = "secret.key";

/** Where the vault's key came from: the environment, a file this orchestrator made for one person, or nowhere. */
export type VaultSource = "set" | "generated" | "none";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Whether only the person at this machine reaches this orchestrator: it listens on a loopback address,
 * gives no public address elsewhere, names no proxy that forwards others to it, and is the
 * built-in admin's or holds at most one account. A proxy decides it alone: a shared orchestrator's
 * first start has no account yet, and a key made then would be gone from the decision at the
 * next start, leaving what it sealed unopened.
 */
export function singlePersonOrchestrator(at: { host: string; publicUrl: string | undefined; devAdmin: boolean; accounts: number; proxied: boolean }): boolean {
  return reachedHereOnly(at) && (at.devAdmin || at.accounts <= 1);
}

/**
 * Whether the orchestrator opens requests with its person's own gh or glab sign-in: a local one, and a
 * self-hosted one run as dev-admin that only this machine reaches, where no account signs in and
 * everyone is its one admin. With accounts a second person signs in beside the first and would act
 * as them on the forge, so it is never offered there; the cloud never offers it.
 */
export function ownForgeCliOffered(at: { local: boolean; cloud: boolean; devAdmin: boolean; host: string; publicUrl: string | undefined; proxied: boolean }): boolean {
  return at.local || (!at.cloud && at.devAdmin && reachedHereOnly(at));
}

/** Whether only this machine reaches the orchestrator, whoever holds an account on it: a loopback address, no public address elsewhere, no proxy. */
export function reachedHereOnly(at: { host: string; publicUrl: string | undefined; proxied: boolean }): boolean {
  const publicHere = !at.publicUrl || (URL.canParse(at.publicUrl) && LOOPBACK.has(new URL(at.publicUrl).hostname));
  return LOOPBACK.has(at.host) && publicHere && !at.proxied;
}

/**
 * The vault for this start. ORCHESTRATOR_SECRET_KEY (or its _FILE) always wins. Without it, an orchestrator
 * that only its one user reaches (`local`) makes a key of its own once, in its data directory,
 * readable by its user alone, and keeps using it: the data directory is that person's own disk, as
 * the database beside it is. An orchestrator others reach gets no key it did not ask for: a key next to
 * the database it seals would open with any copy of that directory. One made earlier, while the
 * orchestrator was a single person's, is named in `said` and used only when the operator points
 * ORCHESTRATOR_SECRET_KEY_FILE at it.
 */
export function vaultFor(env: NodeJS.ProcessEnv, dataDir: string, local: boolean): { vault: Vault | null; source: VaultSource; said: string | null } {
  const given = readSecretEnv(env, "ORCHESTRATOR_SECRET_KEY");
  if (given) return { vault: createVault(parseSecretKey(given)), source: "set", said: null };
  const file = join(dataDir, GENERATED_KEY_FILE);
  if (!local) {
    const made = existsSync(file) ? ` A key this orchestrator made while it was one person's is at ${file}; set ORCHESTRATOR_SECRET_KEY_FILE to it to keep opening what it sealed.` : "";
    return { vault: null, source: "none", said: `${NO_VAULT}.${made}` };
  }
  let made = false;
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    made = true;
  }
  if ((statSync(file).mode & 0o077) !== 0) throw new Error(`${file} is readable by others than this orchestrator's user; chmod 600 it, or set ORCHESTRATOR_SECRET_KEY`);
  const vault = createVault(parseSecretKey(readFileSync(file, "utf8")));
  const how = made ? "made a key" : "uses the key it made";
  return { vault, source: "generated", said: `secrets: no ORCHESTRATOR_SECRET_KEY is set, so this orchestrator, reached by one person on this machine, ${how} at ${file} (readable by its user alone). Set ORCHESTRATOR_SECRET_KEY before others reach it.` };
}

export async function storeSecret(store: SecretStore, vault: Vault | null, tenant: string, name: string, value: string, by: string): Promise<void> {
  if (!vault) throw new Error(NO_VAULT);
  await store.putSecret(tenant, name, vault.seal(tenant, name, value), by);
}

/** An orchestrator restored without its key finds tokens it cannot open; it says so rather than that it keeps none. */
export const SEALED_WITHOUT_KEY = "a forge token is stored for this repository, but ORCHESTRATOR_SECRET_KEY is not set; start the orchestrator with the key it was sealed with, or save the token again";

export async function readSecret(store: SecretStore, vault: Vault | null, tenant: string, name: string): Promise<string | null> {
  const sealed = await store.getSecret(tenant, name);
  if (sealed === null) return null;
  if (!vault) throw new Error(SEALED_WITHOUT_KEY);
  return vault.open(tenant, name, sealed);
}

/**
 * Text bound for a screen, a log or an error that has been near a secret: every occurrence
 * of the value is masked. A forge echoes a token back more often than one would expect
 * (a URL in an error, a header in a debug body), so this runs on everything a provider says.
 */
export function maskSecrets(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  return out;
}
