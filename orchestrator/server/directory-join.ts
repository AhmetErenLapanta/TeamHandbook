import type { AccountStore, UserRecord } from "./accounts.js";
import { AccountError } from "./accounts.js";
import type { Principal } from "./auth.js";
import type { IdentitySessionRecord, SocialProvider } from "./identities.js";
import type { Store } from "./store.js";

/**
 * Joining a cloud organization without an invitation, by the directory that holds one's account
 * as the provider says at sign-in: Google's Workspace domain, Microsoft's directory id. An owner
 * turns it on from their own session, so the directory is the one their own account is in and
 * nobody names a domain they do not belong to; a DNS record proves nothing about a Microsoft
 * directory, and the provider's word is what the joiner's sign-in is checked against anyway.
 * GitHub names no directory and never joins this way. A sign-in alone joins nobody: the person
 * sees the organizations open to their directory and picks one. Someone the organization or its
 * directory removed comes back only through an invitation.
 */
export const DIRECTORY_PREFIX = "join.directory.";
const REMOVED_PREFIX = "join.removed.";
const DIRECTORY_PROVIDERS: readonly SocialProvider[] = ["google", "microsoft"];

export type JoinRole = "member" | "viewer";

export interface DirectoryJoin {
  provider: SocialProvider;
  directory: string;
  role: JoinRole;
  by: string;
  at: string;
}

export const directoryKey = (provider: SocialProvider, directory: string) => `${DIRECTORY_PREFIX}${provider}:${directory}`;

/** The directory an organization lets join, or null. */
export async function directoryJoinOf(store: Pick<AccountStore, "listSettings">, tenant: string): Promise<DirectoryJoin | null> {
  const row = (await store.listSettings(tenant, DIRECTORY_PREFIX))[0];
  return row ? (JSON.parse(row.value) as DirectoryJoin) : null;
}

/**
 * Lets the directory of the owner's own sign-in join, with the role a joiner gets, or turns it off.
 * Only an owner signed in, never a key; a joiner is a member or a viewer, never more.
 */
export async function setDirectoryJoin(store: Pick<AccountStore, "listSettings" | "setSetting" | "deleteSetting">, tenant: string, actor: Principal, session: IdentitySessionRecord | null, input: { on?: unknown; role?: unknown }, now = new Date()): Promise<DirectoryJoin | null> {
  if (actor.key) throw new AccountError("an API key cannot change who joins the organization", 403);
  if (actor.role !== "owner") throw new AccountError("only an owner lets a directory join", 403);
  const role = input.role ?? "member";
  if (role !== "member" && role !== "viewer") throw new AccountError("someone who joins by their directory is a member or a viewer");
  if (input.on === true && (!session || !session.domain || !DIRECTORY_PROVIDERS.includes(session.method))) {
    throw new AccountError("sign in with a Google Workspace or Microsoft work account first; the organization lets in the directory your own account is in", 409);
  }
  for (const row of await store.listSettings(tenant, DIRECTORY_PREFIX)) await store.deleteSetting(tenant, row.key);
  if (input.on !== true) return null;
  const join: DirectoryJoin = { provider: session!.method, directory: session!.domain!, role, by: actor.email, at: now.toISOString() };
  await store.setSetting(tenant, directoryKey(join.provider, join.directory), JSON.stringify(join));
  return join;
}

/** The organizations whose owners let this session's directory join; none for a session whose provider names no directory. */
export async function tenantsJoinableBy(store: Pick<Store, "tenantsWithSetting">, session: IdentitySessionRecord): Promise<string[]> {
  if (!session.domain || !DIRECTORY_PROVIDERS.includes(session.method)) return [];
  return store.tenantsWithSetting(directoryKey(session.method, session.domain));
}

/** Notes that the organization or its directory removed this account, so its identity does not join again by its directory. */
export async function markRemoved(store: Pick<AccountStore, "setSetting">, tenant: string, user: Pick<UserRecord, "identityId">, now = new Date()): Promise<void> {
  if (user.identityId) await store.setSetting(tenant, `${REMOVED_PREFIX}${user.identityId}`, now.toISOString());
}

/** An invitation accepted brings the identity back, so a later directory join is theirs again too. */
export async function clearRemoved(store: Pick<AccountStore, "deleteSetting">, tenant: string, identityId: string): Promise<void> {
  await store.deleteSetting(tenant, `${REMOVED_PREFIX}${identityId}`);
}

export async function wasRemoved(store: Pick<AccountStore, "getSetting">, tenant: string, identityId: string): Promise<boolean> {
  return (await store.getSetting(tenant, `${REMOVED_PREFIX}${identityId}`)) !== null;
}
