import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "./app.js";
import { newId } from "./ids.js";
import { AccountError, agentOf, cleanTeams, CLOUD_SIGN_IN, VIEWER_OWNS_NONE, clientFrom, crossSite, CROSS_SITE, emailKey, joinAs, normalizeEmail, overreach, setSessionCookie, startSession } from "./accounts.js";
import type { AccountStore, UserRecord } from "./accounts.js";
import { hashToken, newToken, reaches, ROLES, secureOrchestrator } from "./auth.js";
import type { OrchestratorEnv, Principal, Role } from "./auth.js";
import { hashPassword, passwordProblem } from "./passwords.js";
import { ssoRequired, ssoRequiredError } from "./domains.js";
import { recordEvent } from "./events.js";
import { tooMany, windowLimiter } from "./limits.js";
import { orgName } from "./organization.js";
import { cloudMode } from "./mode.js";
import { identitySessionOf } from "./cloud-identity.js";

/**
 * An invitation to join the organization: an address, the role and teams it joins with, and
 * the hash of the one-time link that accepts it. The link itself is shown once, to whoever
 * invited, and is never stored; the orchestrator sends no mail, so the inviter passes it on.
 */
export interface InviteRecord {
  tenant: string;
  id: string;
  email: string;
  role: Role;
  teams: string[];
  tokenHash: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

export interface InviteStore {
  /** Saves an invitation, replacing one the same address already had: a resent invitation is a new link and a new week. */
  saveInvite(invite: InviteRecord): Promise<void>;
  listInvites(tenant: string): Promise<InviteRecord[]>;
  getInvite(tenant: string, id: string): Promise<InviteRecord | null>;
  getInviteByToken(tokenHash: string): Promise<InviteRecord | null>;
  /** Deletes and returns the invitation a link names, in one statement: of two acceptances racing, one gets it. */
  takeInviteByToken(tenant: string, tokenHash: string): Promise<InviteRecord | null>;
  /** The same for the unexpired invitation an address has, which single sign-on accepts. */
  takeInviteByEmail(tenant: string, email: string, now: string): Promise<InviteRecord | null>;
  deleteInvite(tenant: string, id: string): Promise<void>;
  /** The unexpired invitations to an address, normalized as saved, across every organization, newest first; a deleted organization's left out. */
  listInvitesByEmail(email: string, now: string): Promise<InviteRecord[]>;
}

/** Seven days, as long as a link sent on a Friday still works the week after. */
export const INVITE_DAYS = 7;
/** Addresses one invitation form takes at once; a list longer than a team is a paste gone wrong. */
export const INVITES_AT_ONCE = 50;

export interface InviteView {
  id: string;
  email: string;
  role: Role;
  teams: string[];
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export function inviteView(invite: InviteRecord, now = new Date()): InviteView {
  const { id, email, role, teams, invitedBy, createdAt, expiresAt } = invite;
  return { id, email, role, teams, invitedBy, createdAt, expiresAt, expired: expiresAt <= now.toISOString() };
}

/**
 * The page an invited person opens. The token travels after the hash, which a browser never
 * sends, and the page hands it to the orchestrator only in a JSON body: a request path ends up in
 * every proxy's access log, and an invitation can carry the owner role.
 */
export function joinLink(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/#/join/${token}`;
}

function freshInvite(tenant: string, email: string, role: Role, teams: string[], by: Principal, now: Date): { invite: InviteRecord; token: string } {
  const token = newToken();
  return {
    token,
    invite: {
      tenant,
      id: newId("inv"),
      email,
      role,
      teams,
      tokenHash: hashToken(token),
      invitedBy: by.email,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000).toISOString(),
    },
  };
}

/** Addresses as people paste them: separated by spaces, commas, semicolons or lines. */
export function splitAddresses(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return [...new Set(text.split(/[\s,;]+/).map(emailKey).filter(Boolean))];
}

export interface Invited {
  invite: InviteView;
  /** The one-time link, shown to the inviter this once. */
  token: string;
}

/**
 * Invites every address in `input.emails` with one role and set of teams. An address that
 * already has an account is skipped and said so; one with a pending invitation gets a new link.
 * Nobody invites into a role above their own.
 */
export async function invite(
  store: AccountStore,
  tenant: string,
  knownTeams: Set<string>,
  input: { emails?: unknown; role?: unknown; teams?: unknown },
  actor: Principal,
  now = new Date(),
): Promise<{ invited: Invited[]; skipped: { email: string; reason: string }[] }> {
  const role = ROLES.includes(input.role as Role) ? (input.role as Role) : null;
  if (!role) throw new AccountError("role is owner, admin, member or viewer");
  const refused = overreach(actor, "member", role);
  if (refused) throw refused;
  const addresses = splitAddresses(input.emails);
  if (!addresses.length) throw new AccountError("enter at least one email address");
  if (addresses.length > INVITES_AT_ONCE) throw new AccountError(`invite at most ${INVITES_AT_ONCE} addresses at once`);
  const emails = addresses.map(normalizeEmail);
  const teams = cleanTeams(input.teams, knownTeams);
  if (role === "viewer" && teams.length) throw new AccountError(VIEWER_OWNS_NONE);
  const invited: Invited[] = [];
  const skipped: { email: string; reason: string }[] = [];
  // A new invitation replaces the address's pending one, so one above the inviter's role is left
  // as it is: an admin re-inviting an address would otherwise revoke an owner's invitation.
  const pending = new Map((await store.listInvites(tenant)).map((i) => [i.email, i]));
  for (const email of emails) {
    if (await store.getUserByEmail(tenant, email)) {
      skipped.push({ email, reason: "already a member" });
      continue;
    }
    const earlier = pending.get(email);
    if (earlier && !reaches(actor.role, earlier.role)) {
      skipped.push({ email, reason: `invited as ${earlier.role}; only an owner changes that invitation` });
      continue;
    }
    const { invite: record, token } = freshInvite(tenant, email, role, teams, actor, now);
    await store.saveInvite(record);
    invited.push({ invite: inviteView(record, now), token });
  }
  return { invited, skipped };
}

async function managedInvite(store: InviteStore, tenant: string, id: string, actor: Principal): Promise<InviteRecord> {
  const found = await store.getInvite(tenant, id);
  if (!found) throw new AccountError("no such invitation", 404);
  const refused = overreach(actor, found.role);
  if (refused) throw refused;
  return found;
}

/** A new link and a new week for a pending invitation; the old link stops working. */
export async function resendInvite(store: InviteStore, tenant: string, id: string, actor: Principal, now = new Date()): Promise<Invited> {
  const found = await managedInvite(store, tenant, id, actor);
  const { invite: record, token } = freshInvite(tenant, found.email, found.role, found.teams, actor, now);
  await store.saveInvite(record);
  return { invite: inviteView(record, now), token };
}

export async function revokeInvite(store: InviteStore, tenant: string, id: string, actor: Principal): Promise<void> {
  await managedInvite(store, tenant, id, actor);
  await store.deleteInvite(tenant, id);
}

// Made when thrown: accounts.ts and this module import each other through app.ts, so a value
// built while the module loads can find AccountError not defined yet.
const gone = () => new AccountError("this invitation link is not valid any more; ask for a new one", 404);

/**
 * What the join page shows before anyone accepts: the address, role and teams of this one
 * invitation and who sent it, by name while they are still a member, so the person knows what
 * they are joining. Never the teams' details or who else is invited.
 */
export async function readInvite(store: AccountStore, tenant: string, token: unknown, now = new Date(), ssoOn = false): Promise<{ email: string; role: Role; teams: string[]; invitedBy: string; expiresAt: string; ssoRequired: boolean }> {
  const found = typeof token === "string" && token ? await store.getInviteByToken(hashToken(token)) : null;
  if (!found || found.tenant !== tenant || found.expiresAt <= now.toISOString()) throw gone();
  const inviter = await store.getUserByEmail(tenant, found.invitedBy);
  return { email: found.email, role: found.role, teams: found.teams, invitedBy: inviter?.name || found.invitedBy, expiresAt: found.expiresAt, ssoRequired: await ssoRequired(store, tenant, ssoOn, found.email, found.role) };
}

/**
 * Accepting by link: the invitation is taken once, then an account is made with the address,
 * role and teams the inviter chose. The person picks only a name and a password.
 */
export async function acceptInvite(
  store: AccountStore,
  tenant: string,
  token: unknown,
  input: { name?: unknown; password?: unknown },
  now = new Date(),
  ssoOn = false,
): Promise<UserRecord> {
  const problem = passwordProblem(input.password);
  if (problem) throw new AccountError(problem);
  if (typeof token !== "string" || !token) throw gone();
  // Read before it is taken, so an invitation refused here stays usable through SSO.
  const peek = await store.getInviteByToken(hashToken(token));
  if (peek && peek.tenant === tenant && (await ssoRequired(store, tenant, ssoOn, peek.email, peek.role))) throw ssoRequiredError(peek.email);
  const found = await store.takeInviteByToken(tenant, hashToken(token));
  if (!found || found.expiresAt <= now.toISOString()) throw gone();
  return joinAs(store, found, { name: input.name, passwordHash: await hashPassword(input.password as string) }, now);
}

function failure(c: Context, err: unknown) {
  if (err instanceof AccountError) return c.json({ error: err.message }, err.status);
  throw err;
}

/** The join page's two calls, answered before anyone is signed in; both take the link's token in a JSON body, never in the path. */
export function joinRoutes(ctx: OrchestratorContext, trustedProxies: string[] = []): Hono {
  const app = new Hono();
  const secure = secureOrchestrator(ctx.publicUrl);
  const from = clientFrom(trustedProxies);
  // A link is 32 random bytes, so these only keep a client from filling the log with guesses.
  const perClient = windowLimiter(30);
  // In cloud an invitation is accepted by signing in with a provider, never with a password set here.
  const cloud = cloudMode();

  app.post("/api/join/read", async (c) => {
    if (crossSite(c, ctx.publicUrl)) return c.json({ error: CROSS_SITE }, 403);
    const verdict = perClient(`join:${from(c)}`);
    if (!verdict.ok) return tooMany(c, verdict, "too many attempts; wait a minute");
    try {
      const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
      const invite = await readInvite(ctx.store, ctx.tenant, body.token, new Date(), Boolean(ctx.oidc));
      const org = await orgName(ctx.store, ctx.tenant);
      if (!cloud) return c.json({ invite, org, sso: Boolean(ctx.oidc) });
      // Whether whoever opened the link is signed in, and as the address it was sent to, so the page offers Join or another sign-in.
      const session = await identitySessionOf(c, ctx.store, secure);
      const identity = session ? await ctx.store.getIdentity(session.identityId) : null;
      return c.json({ invite, org, orgName: org, sso: false, signedIn: Boolean(identity), emailMatches: identity ? identity.email === invite.email : null });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.post("/api/join", async (c) => {
    if (cloud) return c.json({ error: CLOUD_SIGN_IN }, 403);
    if (crossSite(c, ctx.publicUrl)) return c.json({ error: CROSS_SITE }, 403);
    const verdict = perClient(`join:${from(c)}`);
    if (!verdict.ok) return tooMany(c, verdict, "too many attempts; wait a minute");
    try {
      const body = (await c.req.json().catch(() => ({}))) as { token?: unknown; name?: unknown; password?: unknown };
      const user = await acceptInvite(ctx.store, ctx.tenant, body.token, body, new Date(), Boolean(ctx.oidc));
      await recordEvent(ctx, { kind: "user", id: user.id, email: user.email, name: user.name }, "account.joined", { subject: `account:${user.id}`, detail: `accepted an invitation as ${user.role}` });
      setSessionCookie(c, ctx.tenant, await startSession(ctx.store, ctx.tenant, user.id, new Date(), agentOf(c.req.header("user-agent"))), secure);
      return c.json({ ok: true });
    } catch (err) {
      return failure(c, err);
    }
  });

  return app;
}

/** Inviting, resending and revoking, for owners and admins. */
export function inviteRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const store = ctx.store;
  const base = (c: Context) => ctx.publicUrl ?? new URL(c.req.url).origin;
  const knownTeams = async () => new Set((await store.listRepos(ctx.tenant)).map((r) => r.team));
  const withLink = (c: Context, invited: Invited) => ({ ...invited.invite, link: joinLink(base(c), invited.token) });

  app.get("/api/invites", async (c) => {
    const refused = overreach(c.get("user"), "member");
    if (refused) return failure(c, refused);
    return c.json({ invites: (await store.listInvites(ctx.tenant)).map((i) => inviteView(i)) });
  });

  app.post("/api/invites", async (c) => {
    try {
      const result = await invite(store, ctx.tenant, await knownTeams(), await c.req.json().catch(() => ({})), c.get("user"));
      for (const { invite: sent } of result.invited) {
        await recordEvent(ctx, c.get("user"), "invite.sent", { subject: `invite:${sent.id}`, detail: `${sent.email} as ${sent.role}${sent.teams.length ? ` of ${sent.teams.join(", ")}` : ""}` });
      }
      return c.json({ invited: result.invited.map((i) => withLink(c, i)), skipped: result.skipped });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.post("/api/invites/:id/resend", async (c) => {
    try {
      const resent = await resendInvite(store, ctx.tenant, c.req.param("id"), c.get("user"));
      await recordEvent(ctx, c.get("user"), "invite.resent", { subject: `invite:${resent.invite.id}`, detail: `${resent.invite.email}, a new link for seven days` });
      return c.json({ invite: withLink(c, resent) });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.delete("/api/invites/:id", async (c) => {
    try {
      const revoked = await store.getInvite(ctx.tenant, c.req.param("id"));
      await revokeInvite(store, ctx.tenant, c.req.param("id"), c.get("user"));
      await recordEvent(ctx, c.get("user"), "invite.revoked", { subject: `invite:${c.req.param("id")}`, detail: `${revoked?.email ?? "an invitation"} revoked` });
      return c.json({ ok: true });
    } catch (err) {
      return failure(c, err);
    }
  });

  return app;
}
