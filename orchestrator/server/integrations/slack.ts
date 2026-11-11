import type { OrchestratorContext } from "../app.js";
import { ChangeRefused } from "../changes.js";
import { detectSecret } from "../plugin.js";
import { readSecretEnv } from "../secret-env.js";
import { maskSecrets, readSecret, storeSecret } from "../vault.js";
import { OAuthFailed } from "./mcp-oauth.js";
import { readEnabled, saveEnabled } from "./records.js";
import { remoteUrl } from "./remote.js";

export const SLACK = "slack";
export const SLACK_WEBHOOK_SECRET = "integration.slack.webhook";

/** What the orchestrator tells a channel about, by the event log's kind. */
export const SLACK_EVENTS = [
  { kind: "request.opened", label: "Request opened" },
  { kind: "request.merged", label: "Request merged" },
  { kind: "request.closed", label: "Request closed" },
  { kind: "task.succeeded", label: "Task finished" },
  { kind: "task.failed", label: "Task failed" },
  { kind: "health.degraded", label: "Something stopped working" },
  { kind: "health.recovered", label: "It works again" },
] as const;

export type SlackEventKind = (typeof SLACK_EVENTS)[number]["kind"];

export interface SlackConfig {
  events: SlackEventKind[];
}

/** How the last message to the channel went; shown on the card, never with the address. */
export interface Delivery {
  ok: boolean;
  at: string;
  detail: string;
}

/** The event as the log keeps it: its texts already masked of credentials and secrets. */
export interface LoggedEvent {
  tenant: string;
  kind: string;
  repoId: string | null;
  subject: string | null;
  detail: string;
  actor: { name: string | null };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const DELIVERY_TIMEOUT_MS = 5000;

/**
 * The Slack app whoever runs the orchestrator registered once, so that "Add to Slack" can ask for
 * a channel's incoming webhook: Slack takes no client that registers itself. Null until both are set.
 */
export function slackApp(env: NodeJS.ProcessEnv = process.env): { clientId: string; clientSecret: string } | null {
  const clientId = env.ORCHESTRATOR_SLACK_CLIENT_ID?.trim();
  const clientSecret = readSecretEnv(env, "ORCHESTRATOR_SLACK_CLIENT_SECRET");
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Slack's own address; ORCHESTRATOR_SLACK_URL names a stand-in on this machine. */
export const slackBase = (env: NodeJS.ProcessEnv = process.env, local = false): string => remoteUrl(env.ORCHESTRATOR_SLACK_URL ?? "https://slack.com", "Slack's address", local).origin;

/** Slack's approval screen, where the person picks the channel; only the incoming-webhook scope is asked. */
export function slackAuthorizeUrl(base: string, clientId: string, redirectUri: string, state: string): string {
  const url = new URL(`${base}/oauth/v2/authorize`);
  for (const [k, v] of Object.entries({ client_id: clientId, scope: "incoming-webhook", redirect_uri: redirectUri, state })) url.searchParams.set(k, v);
  return url.toString();
}

/** Trades Slack's code for the channel's webhook address; the token Slack also names is not kept. */
async function slackWebhookFor(base: string, app: { clientId: string; clientSecret: string }, code: string, redirectUri: string, send: typeof fetch): Promise<{ webhook: string; channel: string }> {
  let body: { ok?: boolean; error?: string; incoming_webhook?: { url?: string; channel?: string } };
  try {
    const res = await send(`${base}/api/oauth.v2.access`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: redirectUri }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS * 2),
    });
    body = (await res.json()) as typeof body;
  } catch {
    throw new OAuthFailed("Slack did not answer");
  }
  const url = body.incoming_webhook?.url;
  if (!body.ok || typeof url !== "string") throw new OAuthFailed(`Slack refused to add the orchestrator${typeof body.error === "string" ? ` (${body.error.slice(0, 60)})` : ""}`);
  return { webhook: cleanWebhook(url), channel: String(body.incoming_webhook?.channel ?? "").slice(0, 80) };
}

/**
 * The end of "Add to Slack": the channel's webhook address is sealed as a pasted one is, and the
 * events are the card's own if it was set up before, else the ones asked for.
 */
export async function finishSlackAdd(
  ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault" | "audit" | "localMcp">,
  signIn: { user: { id: string; name: string; email: string }; redirectUri: string; slack: { events: string[] } },
  code: string,
  send: typeof fetch = fetch,
): Promise<void> {
  const app = slackApp();
  if (!app) throw new OAuthFailed("the Slack app is no longer set on this orchestrator");
  const found = await slackWebhookFor(slackBase(process.env, Boolean(ctx.localMcp)), app, code, signIn.redirectUri, send);
  const actor = { ...signIn.user, role: "member" as const, ownedTeams: [] };
  const current = await readEnabled<SlackConfig>(ctx, SLACK);
  await storeSecret(ctx.store, ctx.vault ?? null, ctx.tenant, SLACK_WEBHOOK_SECRET, found.webhook, signIn.user.email);
  await recordDelivery(ctx, null);
  const events = current ? current.config.events : cleanSlackEvents(signIn.slack.events);
  await saveEnabled<SlackConfig>(ctx, SLACK, { events }, actor);
  if (ctx.audit) await ctx.audit(actor, current ? "integration.changed" : "integration.enabled", { subject: "integration:slack", detail: `Slack notifications for ${events.join(", ")}, added with Slack's own approval${found.channel ? ` for ${found.channel}` : ""}` });
}
const DELIVERY_KEY = "integration.slack.delivery";

/**
 * A Slack incoming webhook address. The address is the credential - anyone holding it posts to
 * the channel - so it is sealed like a forge token, and it has to be Slack's own: the orchestrator
 * posts to it from the server, and an address anywhere else would have the orchestrator call into
 * whatever network it runs in. Plain http is taken only on this machine, for a stand-in.
 */
export function cleanWebhook(raw: unknown): string {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new ChangeRefused("the webhook address is not a URL");
  }
  if (url.username || url.password) throw new ChangeRefused("the webhook address carries no user name or password");
  const local = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (!local && !(url.protocol === "https:" && url.hostname === "hooks.slack.com" && /^\/(services|triggers|workflows)\//.test(url.pathname))) {
    throw new ChangeRefused("a Slack webhook address starts with https://hooks.slack.com/services/");
  }
  return url.toString();
}

export function cleanSlackEvents(raw: unknown): SlackEventKind[] {
  if (!Array.isArray(raw)) throw new ChangeRefused("events is a list of the events to post");
  const known = new Set<string>(SLACK_EVENTS.map((e) => e.kind));
  const unknown = raw.filter((e) => typeof e !== "string" || !known.has(e));
  if (unknown.length) throw new ChangeRefused(`these are not events the orchestrator posts: ${unknown.map((e) => JSON.stringify(e)).join(", ")}`);
  if (!raw.length) throw new ChangeRefused("pick at least one event to post");
  return SLACK_EVENTS.map((e) => e.kind).filter((k) => raw.includes(k));
}

/**
 * Text as Slack reads it: `&`, `<` and `>` are its control characters, so a request titled
 * `<!channel>` would page everyone in the channel, and `<https://x|y>` would show one address
 * and link another. Escaped, they are shown as typed.
 */
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function slackMessage(event: LoggedEvent): { text: string } {
  const label = SLACK_EVENTS.find((e) => e.kind === event.kind)?.label ?? event.kind;
  const where = event.repoId ? ` in ${event.repoId}` : "";
  const who = event.actor.name ? ` by ${event.actor.name}` : "";
  const detail = detectSecret(event.detail) ? "" : `: ${event.detail}`;
  return { text: slackEscape(`${label}${where}${who}${detail}`) };
}

/**
 * Posts one message, and says how it went in words fit for the card. The answer never carries
 * the address: a failed request's error repeats it more often than not, so every message is
 * masked of it.
 */
export async function postToSlack(webhook: string, message: { text: string }, send: typeof fetch = fetch, timeoutMs = DELIVERY_TIMEOUT_MS, now = () => new Date()): Promise<Delivery> {
  const at = () => now().toISOString();
  try {
    const res = await send(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    if (res.ok) return { ok: true, at: at(), detail: "Delivered." };
    return { ok: false, at: at(), detail: `Slack answered ${res.status}${res.status === 404 || res.status === 410 ? "; the webhook was removed or the address is wrong" : ""}.` };
  } catch (err) {
    const timedOut = (err as Error).name === "TimeoutError";
    return { ok: false, at: at(), detail: timedOut ? `Slack did not answer within ${timeoutMs / 1000} seconds.` : maskSecrets(`The message was not sent: ${(err as Error).message}`, [webhook]).slice(0, 200) };
  }
}

export async function lastDelivery(ctx: Pick<OrchestratorContext, "store" | "tenant">): Promise<Delivery | null> {
  const raw = await ctx.store.getSetting(ctx.tenant, DELIVERY_KEY);
  try {
    return raw === null ? null : (JSON.parse(raw) as Delivery);
  } catch {
    return null;
  }
}

export async function recordDelivery(ctx: Pick<OrchestratorContext, "store" | "tenant">, delivery: Delivery | null): Promise<void> {
  if (delivery) await ctx.store.setSetting(ctx.tenant, DELIVERY_KEY, JSON.stringify(delivery));
  else await ctx.store.deleteSetting(ctx.tenant, DELIVERY_KEY);
}

/**
 * Posts an event the channel asked for. Called after the event is in the log, and never
 * awaited by the action that caused it: a slow or broken Slack does not hold up or fail a
 * merge. What happened is recorded for the card; nothing is retried.
 */
export async function notifySlack(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">, event: LoggedEvent, send: typeof fetch = fetch): Promise<Delivery | null> {
  const enabled = await readEnabled<SlackConfig>(ctx, SLACK);
  if (!enabled || !(enabled.config.events as string[]).includes(event.kind)) return null;
  let webhook: string | null;
  try {
    webhook = await readSecret(ctx.store, ctx.vault ?? null, ctx.tenant, SLACK_WEBHOOK_SECRET);
  } catch (err) {
    const delivery = { ok: false, at: new Date().toISOString(), detail: (err as Error).message };
    await recordDelivery(ctx, delivery);
    return delivery;
  }
  if (!webhook) return null;
  const delivery = await postToSlack(webhook, slackMessage(event), send);
  await recordDelivery(ctx, delivery);
  return delivery;
}

/**
 * A store whose every appended event is also offered to Slack, once it is written. Wrapping the
 * log's one way in keeps the places that record a request or a task unaware of Slack.
 */
export function withSlack<E extends LoggedEvent, S extends { appendEvent(event: E): Promise<void> }>(store: S, ctx: () => Pick<OrchestratorContext, "store" | "tenant" | "vault">, send: typeof fetch = fetch): S {
  const append = store.appendEvent.bind(store);
  store.appendEvent = async (event: E) => {
    await append(event);
    void notifySlack({ ...ctx(), tenant: event.tenant }, event, send).catch((err: Error) => console.error(`slack: ${err.message}`));
  };
  return store;
}
