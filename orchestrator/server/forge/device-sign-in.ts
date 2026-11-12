import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { readSecret, storeSecret } from "../vault.js";
import type { AppForge } from "./oauth.js";
import { LOGIN, said } from "./own-cli.js";

/*
 * A person signs in to GitHub or GitLab.com from the card with a one-time code, through the
 * orchestrator's own registered application, as gh and glab sign in through theirs: the
 * application has no secret, so its id ships with a release and nothing has to be installed or
 * registered by an operator. The token the forge gives back is sealed in the vault under the
 * person's own name and is never shown again.
 */

/** The orchestrator's own applications, empty until the publisher registers them; the card then keeps today's way. */
export const RELEASE_DEVICE_CLIENTS: Record<AppForge, string> = { github: "", gitlab: "" };

/** The application a person signs in through: the operator's own when they name one, else the release's; null when there is none. */
export function deviceClientId(kind: AppForge, env: Record<string, string | undefined> = process.env): string | null {
  return env[`ORCHESTRATOR_FORGE_${kind.toUpperCase()}_DEVICE_CLIENT_ID`]?.trim() || RELEASE_DEVICE_CLIENTS[kind] || null;
}

/** Where each forge's device sign-in answers, on its public host; a test hands stand-in addresses instead. */
export interface DeviceEndpoints {
  host: string;
  code: string;
  token: string;
  user: string;
}

export const DEVICE_ENDPOINTS: Record<AppForge, DeviceEndpoints> = {
  github: { host: "github.com", code: "https://github.com/login/device/code", token: "https://github.com/login/oauth/access_token", user: "https://api.github.com/user" },
  gitlab: { host: "gitlab.com", code: "https://gitlab.com/oauth/authorize_device", token: "https://gitlab.com/oauth/token", user: "https://gitlab.com/api/v4/user" },
};

/** What a request opened as the person needs: on GitHub its repositories and the organizations it can see, on GitLab its API and pushing over https. */
const SCOPES: Record<AppForge, string> = { github: "repo read:org", gitlab: "api write_repository" };

export type DeviceSignIn =
  | { state: "idle" }
  | { state: "waiting"; code: string; url: string }
  | { state: "done"; account: string; host: string }
  | { state: "failed"; error: string };

interface Pending {
  state: DeviceSignIn;
  stop: () => void;
}

const pending = new Map<string, Pending>();
const keyOf = (tenant: string, userId: string, kind: AppForge) => `${tenant} ${userId} ${kind}`;
export const personTokenName = (kind: AppForge, userId: string) => `forge-person:${kind}:${userId}`;
export const signedInKey = (kind: AppForge, userId: string) => `forge.person.${kind}.${userId}`;

type Ctx = Pick<OrchestratorContext, "store" | "tenant" | "vault">;

/** The person's sign-in as it stands: waiting with its code, failed, or the account it holds, which outlives a restart. */
export async function deviceSignInState(ctx: Ctx, user: Pick<Principal, "id">, kind: AppForge): Promise<DeviceSignIn> {
  const now = pending.get(keyOf(ctx.tenant, user.id, kind))?.state;
  if (now && now.state !== "done") return now;
  const kept = await ctx.store.getSetting(ctx.tenant, signedInKey(kind, user.id));
  if (!kept) return { state: "idle" };
  const { account, host } = JSON.parse(kept) as { account: string; host: string };
  return { state: "done", account, host };
}

/** The token the person signed in with, for a request opened as them; null when they did not sign in here. */
export async function personForgeToken(ctx: Ctx, userId: string, kind: AppForge): Promise<string | null> {
  return readSecret(ctx.store, ctx.vault ?? null, ctx.tenant, personTokenName(kind, userId));
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

async function json(answer: Response): Promise<Record<string, unknown>> {
  return ((await answer.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

/**
 * Starts the person's sign-in, or answers the one already waiting: the forge gives a code for the
 * person to enter on its own page, and the orchestrator asks the forge, at the pace it names,
 * whether they did. A code the forge stops waiting on, or a refusal, fails it with the forge's word.
 */
export async function startDeviceSignIn(ctx: Ctx, user: Pick<Principal, "id" | "email">, kind: AppForge, clientId: string, endpoints: DeviceEndpoints = DEVICE_ENDPOINTS[kind], send: typeof fetch = fetch): Promise<DeviceSignIn> {
  const key = keyOf(ctx.tenant, user.id, kind);
  const now = pending.get(key);
  if (now?.state.state === "waiting") return now.state;
  if (!ctx.vault) return { state: "failed", error: "whoever runs the orchestrator sets ORCHESTRATOR_SECRET_KEY first: the token is sealed with it" };
  const headers = { accept: "application/json", "content-type": "application/x-www-form-urlencoded" };
  const asked = await send(endpoints.code, { method: "POST", headers, body: form({ client_id: clientId, scope: SCOPES[kind] }) }).catch((err: Error) => err);
  const body = asked instanceof Error ? {} : await json(asked);
  const code = typeof body.user_code === "string" ? body.user_code : null;
  const url = typeof body.verification_uri === "string" ? body.verification_uri : null;
  const deviceCode = typeof body.device_code === "string" ? body.device_code : null;
  // The page is offered as a link only when it is https on the forge's own host, as the CLI sign-in's is.
  if (!code || !url || !deviceCode || !URL.canParse(url) || new URL(url).protocol !== "https:" || new URL(url).host !== endpoints.host) {
    const reason = asked instanceof Error ? asked.message : typeof body.error_description === "string" ? body.error_description : typeof body.error === "string" ? body.error : `it answered ${asked.status}`;
    return { state: "failed", error: `${endpoints.host} did not start the sign-in: ${said(reason)}` };
  }
  // At least a second between asks: a forge answering 0 would otherwise be asked in a tight loop.
  let interval = Math.max(1, Number(body.interval ?? 5)) * 1000;
  const expiresAt = Date.now() + Math.max(1, Number(body.expires_in ?? 900)) * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const entry: Pending = { state: { state: "waiting", code, url }, stop: () => clearTimeout(timer) };
  pending.set(key, entry);
  const fail = (error: string) => {
    entry.state = { state: "failed", error };
  };
  const poll = async (): Promise<void> => {
    if (entry.state.state !== "waiting") return;
    if (Date.now() > expiresAt) return fail(`the code was not entered on ${endpoints.host} in time; press Sign in again`);
    const answer = await send(endpoints.token, { method: "POST", headers, body: form({ client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }) }).catch(() => null);
    const answered = answer ? await json(answer) : {};
    const token = typeof answered.access_token === "string" ? answered.access_token : null;
    if (!token) {
      const error = typeof answered.error === "string" ? answered.error : "authorization_pending";
      if (error === "slow_down") interval += 5_000;
      else if (error !== "authorization_pending") return fail(`${endpoints.host} did not sign you in: ${said(typeof answered.error_description === "string" ? answered.error_description : error)}; press Sign in again`);
      timer = setTimeout(() => void poll(), interval);
      timer.unref();
      return;
    }
    const me = await send(endpoints.user, { headers: { accept: "application/json", authorization: `Bearer ${token}` } }).then(json, () => ({}) as Record<string, unknown>);
    const login = kind === "github" ? me.login : me.username;
    if (typeof login !== "string" || !LOGIN.test(login)) return fail(`${endpoints.host} signed you in but did not say as whom; press Sign in again`);
    await storeSecret(ctx.store, ctx.vault ?? null, ctx.tenant, personTokenName(kind, user.id), token, user.email);
    await ctx.store.setSetting(ctx.tenant, signedInKey(kind, user.id), JSON.stringify({ account: login, host: endpoints.host }));
    entry.state = { state: "done", account: login, host: endpoints.host };
  };
  timer = setTimeout(() => void poll(), interval);
  timer.unref();
  return entry.state;
}

/**
 * Forgets the person's sign-in to one forge, or to both: the sealed token and the account, and a
 * sign-in still waiting. Their own Sign out, and an account the directory turns off, come here; a
 * deleted account loses them with the rest of what it held (store.deleteUser).
 */
export async function forgetPersonForge(store: { deleteSecret(tenant: string, name: string): Promise<unknown>; deleteSetting(tenant: string, key: string): Promise<void> }, tenant: string, userId: string, kinds: readonly AppForge[] = ["github", "gitlab"]): Promise<void> {
  for (const kind of kinds) {
    pending.get(keyOf(tenant, userId, kind))?.stop();
    pending.delete(keyOf(tenant, userId, kind));
    await store.deleteSecret(tenant, personTokenName(kind, userId));
    await store.deleteSetting(tenant, signedInKey(kind, userId));
  }
}

/** Stops every sign-in still waiting, as the orchestrator stops. */
export function stopDeviceSignIns(): void {
  for (const entry of pending.values()) entry.stop();
}
