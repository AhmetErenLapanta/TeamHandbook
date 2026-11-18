import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { readSecret, storeSecret } from "../vault.js";
import { FORGES } from "../../shared/forge-def.js";
import { ConnectionUnusable, ForgeSignInFailed, forgeTokens, lasting, postForm, renewOnce } from "./oauth.js";
import type { AppForge, ForgeTokens } from "./oauth.js";
import { LOGIN, said } from "./own-cli.js";

/*
 * A person signs in to GitHub or GitLab.com from the card with a one-time code, through the
 * orchestrator's own registered application, as gh and glab sign in through theirs: the
 * application has no secret, so its id ships with a release and nothing has to be installed or
 * registered by an operator. The tokens the forge gives back are sealed in the vault under the
 * person's own name and are never shown again. GitLab.com's access token lapses after two hours,
 * and GitHub's after eight when the application keeps "Expire user access tokens" ticked, as it is
 * by default; each then gives a refresh token, which renews it on the person's next press.
 */

/** The orchestrator's own applications, registered by the publisher: an id is public and carries no secret. A forge with none keeps today's way on the card. */
export const RELEASE_DEVICE_CLIENTS: Record<AppForge, string> = { github: "Ov23liQ8aEvWzyO7lqWs", gitlab: "" };

/** The application a person signs in through: the operator's own when they name one, else the release's; null when there is none or the operator set `off`. */
export function deviceClientId(kind: AppForge, env: Record<string, string | undefined> = process.env): string | null {
  const named = env[`ORCHESTRATOR_FORGE_${kind.toUpperCase()}_DEVICE_CLIENT_ID`]?.trim();
  if (named?.toLowerCase() === "off") return null;
  return named || RELEASE_DEVICE_CLIENTS[kind] || null;
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

/** What the card names the sign-in by; `problem` is why it has to be made again, kept until the person signs in again or out. */
interface SignedIn {
  account: string;
  host: string;
  problem?: string;
}

async function signedInOf(ctx: Ctx, userId: string, kind: AppForge): Promise<SignedIn | null> {
  const kept = await ctx.store.getSetting(ctx.tenant, signedInKey(kind, userId));
  return kept ? (JSON.parse(kept) as SignedIn) : null;
}

/** The person's sign-in as it stands: waiting with its code, failed, or the account it holds, which outlives a restart. */
export async function deviceSignInState(ctx: Ctx, user: Pick<Principal, "id">, kind: AppForge): Promise<DeviceSignIn> {
  const now = pending.get(keyOf(ctx.tenant, user.id, kind))?.state;
  if (now && now.state !== "done") return now;
  const kept = await signedInOf(ctx, user.id, kind);
  if (!kept) return { state: "idle" };
  return kept.problem ? { state: "failed", error: kept.problem } : { state: "done", account: kept.account, host: kept.host };
}

/** The tokens sealed for the person; a token sealed before refresh tokens were kept reads as one that does not lapse. */
async function sealedTokens(ctx: Ctx, userId: string, kind: AppForge): Promise<ForgeTokens | null> {
  const raw = await readSecret(ctx.store, ctx.vault ?? null, ctx.tenant, personTokenName(kind, userId));
  if (!raw) return null;
  const read = (() => {
    try {
      return JSON.parse(raw) as Partial<ForgeTokens>;
    } catch {
      return null;
    }
  })();
  return typeof read?.accessToken === "string" ? { accessToken: read.accessToken, refreshToken: read.refreshToken ?? null, expiresAt: read.expiresAt ?? null } : { accessToken: raw, refreshToken: null, expiresAt: null };
}

/**
 * Whether the person holds a sign-in a press can use, read from what is sealed alone: an offer on a
 * screen asks nothing of the forge, and a token that lapsed is renewed only when they press. A
 * forge whose code sign-in the operator turned off offers none, however the person signed in before.
 */
export async function personSignedIn(ctx: Ctx, userId: string, kind: AppForge, now = new Date(), clientId: string | null = deviceClientId(kind)): Promise<boolean> {
  if (!clientId) return false;
  const kept = await signedInOf(ctx, userId, kind);
  const tokens = kept && !kept.problem ? await sealedTokens(ctx, userId, kind) : null;
  return Boolean(tokens && (lasting(tokens, now) || tokens.refreshToken));
}

/**
 * The person's token while it lasts, for a read in the background: nothing is renewed and the forge
 * is not asked, so a token that lapsed stays lapsed until the person presses. Null where the operator
 * turned the code sign-in off, the person has to sign in again, or the token lapsed.
 */
export async function personLastingToken(ctx: Ctx, userId: string, kind: AppForge, now = new Date(), clientId: string | null = deviceClientId(kind)): Promise<string | null> {
  if (!clientId) return null;
  const kept = await signedInOf(ctx, userId, kind);
  const tokens = kept && !kept.problem ? await sealedTokens(ctx, userId, kind) : null;
  return tokens && lasting(tokens, now) ? tokens.accessToken : null;
}

/** Where a renewal answers and with which application; a test hands stand-ins and its own clock. */
export interface Renewal {
  endpoints?: DeviceEndpoints;
  clientId?: string | null;
  send?: typeof fetch;
  now?: Date;
}

/**
 * The token the person signed in with, for a request opened as them because they pressed; null when
 * they did not sign in here or have to sign in again. One that lapses within minutes is renewed
 * first with the sealed refresh token, and one the forge answers 401 for is renewed once, before
 * anything is pushed or opened with it. Both forges spend a refresh token on use, so one renewal
 * runs at a time per person (renewOnce). A renewal the forge refuses forgets the tokens and the card
 * says to sign in again; a forge that did not answer leaves them as they were. Where the operator
 * turned the forge's code sign-in off, no token is used, one that does not lapse included.
 */
export async function personForgeToken(ctx: Ctx, user: Pick<Principal, "id" | "email">, kind: AppForge, given: Renewal = {}): Promise<string | null> {
  const clientId = given.clientId === undefined ? deviceClientId(kind) : given.clientId;
  if (!clientId) return null;
  const renewal = { ...given, clientId };
  const token = await lastingToken(ctx, user, kind, renewal, null);
  if (!token) return null;
  const endpoints = renewal.endpoints ?? DEVICE_ENDPOINTS[kind];
  const asked = await (renewal.send ?? fetch)(endpoints.user, { headers: { accept: "application/json", authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
  return asked?.status === 401 ? lastingToken(ctx, user, kind, renewal, token) : token;
}

async function lastingToken(ctx: Ctx, user: Pick<Principal, "id" | "email">, kind: AppForge, renewal: Renewal & { clientId: string }, refused: string | null): Promise<string | null> {
  const now = renewal.now ?? new Date();
  const usable = (tokens: ForgeTokens | null) => (tokens && tokens.accessToken !== refused && lasting(tokens, now) ? tokens.accessToken : null);
  const kept = await signedInOf(ctx, user.id, kind);
  const tokens = kept && !kept.problem ? await sealedTokens(ctx, user.id, kind) : null;
  if (!tokens) return null;
  const ready = usable(tokens);
  if (ready) return ready;
  const sealed = async () => usable(await sealedTokens(ctx, user.id, kind));
  return renewOnce(ctx, `forge.renewing.person.${kind}.${user.id}`, sealed, () => renewPersonToken(ctx, user, kind, renewal, now, refused), `your ${FORGES[kind].label} sign-in is being renewed; press again in a minute`);
}

async function renewPersonToken(ctx: Ctx, user: Pick<Principal, "id" | "email">, kind: AppForge, renewal: Renewal & { clientId: string }, now: Date, refused: string | null): Promise<string | null> {
  const label = FORGES[kind].label;
  const kept = await signedInOf(ctx, user.id, kind);
  const tokens = kept && !kept.problem ? await sealedTokens(ctx, user.id, kind) : null;
  if (!kept || !tokens) return null;
  if (tokens.accessToken !== refused && lasting(tokens, now)) return tokens.accessToken;
  const why = refused ? `${label} no longer accepts your sign-in` : `your ${label} sign-in lapsed`;
  if (!tokens.refreshToken) return signInAgain(ctx, user.id, kind, kept, `${why} and gave no way to renew it; press Sign in again`);
  const endpoints = renewal.endpoints ?? DEVICE_ENDPOINTS[kind];
  try {
    // The application has no secret: a token from the code sign-in is renewed with its id alone.
    const body = await postForm(endpoints.token, { grant_type: "refresh_token", client_id: renewal.clientId, refresh_token: tokens.refreshToken }, [tokens.refreshToken, tokens.accessToken], renewal.send ?? fetch, label);
    const fresh = forgeTokens(body, now, tokens.refreshToken, label);
    await storeSecret(ctx.store, ctx.vault ?? null, ctx.tenant, personTokenName(kind, user.id), JSON.stringify(fresh), user.email);
    return fresh.accessToken;
  } catch (err) {
    if (!(err instanceof ForgeSignInFailed)) throw err;
    // An answer naming an error is the forge's refusal: the refresh token is spent, revoked or past its time.
    if ((err as ForgeSignInFailed & { code?: string }).code) return signInAgain(ctx, user.id, kind, kept, `${why} (${err.message}); press Sign in again`);
    throw new ConnectionUnusable(`your ${label} sign-in was not renewed: ${err.message}; press again in a minute`);
  }
}

/** Forgets tokens the forge will not renew, and keeps why, so the card asks for the sign-in again. */
async function signInAgain(ctx: Ctx, userId: string, kind: AppForge, kept: SignedIn, problem: string): Promise<null> {
  await ctx.store.deleteSecret(ctx.tenant, personTokenName(kind, userId));
  await ctx.store.setSetting(ctx.tenant, signedInKey(kind, userId), JSON.stringify({ ...kept, problem }));
  return null;
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
    await storeSecret(ctx.store, ctx.vault ?? null, ctx.tenant, personTokenName(kind, user.id), JSON.stringify(forgeTokens(answered, new Date(), null, FORGES[kind].label)), user.email);
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
