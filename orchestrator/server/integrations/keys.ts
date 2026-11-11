import type { AccountStore } from "../accounts.js";
import type { Principal } from "../auth.js";
import { findKey, keyPrincipal } from "../keys.js";
import type { Store } from "../store.js";
import { oauthPrincipal, oauthTenant } from "./oauth-server.js";

type SettingsStore = Pick<Store, "getSetting">;

/**
 * Turns the bearer key an MCP client sends into the person or service account it belongs to,
 * or null for a key that is unknown, revoked or expired. Keys, their scopes and their last
 * use belong to the people settings; the MCP server only asks.
 */
export interface ApiKeyResolver {
  resolve(bearer: string): Promise<Principal | null>;
}

/** Last use is written at most once a minute per key, as the API's own key sign-in does. */
const TOUCH_MS = 60_000;

/** The orchestrator's own API keys and the tokens its authorization server issued: the principal either acts as, carrying its scopes. */
export function storeKeys(store: AccountStore & SettingsStore, tenant: string): ApiKeyResolver {
  return {
    async resolve(bearer) {
      const now = new Date();
      if (oauthTenant(bearer) !== null) return oauthPrincipal({ store: store as Store, tenant }, bearer, now);
      const key = await findKey(store, tenant, bearer, now);
      if (!key) return null;
      const principal = await keyPrincipal(store, key);
      if (!principal) return null;
      if (!key.lastUsedAt || now.getTime() - Date.parse(key.lastUsedAt) >= TOUCH_MS) await store.touchKey(tenant, key.id, now.toISOString());
      return { ...principal, key: { id: key.id, owner: key.owner, scopes: key.scopes, expiresAt: key.expiresAt } };
    },
  };
}
