import type { SecretProviderKind, SettingsSecretValue } from "../shared/secret-providers.js";
import { AccountError } from "./accounts.js";
import { manages } from "./auth.js";
import type { Principal } from "./auth.js";
import { opVaultOf, opVaults, SECRET_PROVIDERS } from "./secret-providers.js";
import type { SecretProvider } from "./secret-providers.js";

/** The longest value a setting keeps in the vault: a token or a key file, never a dump. */
const MOST_LITERAL = 64 * 1024;

/**
 * The secret value a setting takes, checked before it is kept: only an owner or an admin signed
 * in writes one, never an API key or an agent; a value written as itself goes to the vault; a
 * reference names a provider this orchestrator runs, in the shape that provider reads, and a vault
 * reference only a task secret within `reach`, the name prefixes the setting's own scope reads.
 * Anything else is refused here rather than kept and left unread at the moment a task needs it.
 */
export function secretSettingValue(actor: Principal, input: unknown, reach: readonly string[], providers: Readonly<Record<string, SecretProvider>> = SECRET_PROVIDERS, env: NodeJS.ProcessEnv = process.env): SettingsSecretValue {
  if (actor.key) throw new AccountError("an API key cannot set a secret", 403);
  if (!manages(actor)) throw new AccountError("only an owner or an admin sets a secret", 403);
  const given = (input ?? {}) as Record<string, unknown>;
  const fields = Object.keys(given).sort().join(",");
  if (fields === "literal") {
    if (typeof given.literal !== "string" || !given.literal || given.literal.length > MOST_LITERAL) throw new AccountError(`a secret's value is 1 to ${MOST_LITERAL} characters`);
    return { literal: given.literal };
  }
  if (fields !== "provider,reference") throw new AccountError("a secret is either { literal } or { provider, reference }");
  const kind = given.provider;
  const provider = typeof kind === "string" && Object.hasOwn(providers, kind) ? providers[kind]! : null;
  if (!provider) throw new AccountError(`this orchestrator reads secrets through ${Object.keys(providers).join(" or ")}, not ${String(kind)}`);
  const reference = typeof given.reference === "string" ? given.reference.trim() : "";
  if (!provider.definition.isReference(reference)) throw new AccountError(`a ${provider.definition.kind} reference looks like ${provider.definition.placeholder}`);
  // A prefix is a whole name part ending in a dot: "task.secret.team.Pay" would otherwise reach the Payments team's secrets.
  if (provider.definition.kind === "vault" && !reach.some((prefix) => prefix.startsWith("task.secret.") && prefix.endsWith(".") && reference.startsWith(prefix))) {
    throw new AccountError("that task secret is not one this setting reaches; name one of its own team or repositories");
  }
  // The read leaves a reference to any other vault unread; said here, it is said while someone is looking.
  if (provider.definition.kind === "op" && !opVaults(env).has(opVaultOf(reference) ?? "")) throw new AccountError("that vault is not one this orchestrator reads");
  return { provider: provider.definition.kind as SecretProviderKind, reference };
}
