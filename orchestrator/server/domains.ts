import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "./app.js";
import { AccountError } from "./accounts.js";
import type { AccountStore } from "./accounts.js";
import { suspended } from "./scim.js";
import { manages } from "./auth.js";
import type { OrchestratorEnv, Principal, Role } from "./auth.js";
import { recordEvent } from "./events.js";

/**
 * Email domains an organization proves it holds, with a DNS TXT record. Once a domain is
 * verified and single sign-on is set up, everyone at that domain signs in through the identity
 * provider: a password no longer opens their account, so someone the provider closes is out
 * here too. Owners keep their password, so a broken provider cannot lock the organization out.
 * Without single sign-on nothing is enforced, for the same reason.
 */
export interface DomainRecord {
  tenant: string;
  domain: string;
  /** Published in DNS, so not a secret; it proves whoever adds the record controls the zone. */
  token: string;
  addedBy: string;
  addedAt: string;
  verifiedAt: string | null;
}

export interface DomainStore {
  saveDomain(domain: DomainRecord): Promise<void>;
  listDomains(tenant: string): Promise<DomainRecord[]>;
  markDomainVerified(tenant: string, domain: string, at: string): Promise<void>;
  deleteDomain(tenant: string, domain: string): Promise<void>;
}

/** Looks up a name's TXT records; injected so tests answer from a table instead of DNS. */
export type TxtResolver = (name: string) => Promise<string[][]>;

export const RECORD_PREFIX = "_teamhandbook-orchestrator";
export const RECORD_VALUE = "teamhandbook-orchestrator-verification=";

const DOMAIN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function cleanDomain(input: unknown): string {
  const text = typeof input === "string" ? input.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!DOMAIN.test(text)) throw new AccountError("enter a domain such as example.com");
  return text;
}

export function recordName(domain: string): string {
  return `${RECORD_PREFIX}.${domain}`;
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * Whether an address is at a domain or under it: whoever runs a domain's DNS runs its
 * subdomains', so a verified domain covers them too.
 */
export function atDomain(email: string, domain: string): boolean {
  const at = domainOf(email);
  return at === domain || at.endsWith(`.${domain}`);
}

async function atVerifiedDomain(store: DomainStore, tenant: string, email: string): Promise<boolean> {
  return (await store.listDomains(tenant)).some((d) => d.verifiedAt && atDomain(email, d.domain));
}

/**
 * Whether this address has to sign in through single sign-on: its domain is verified, single
 * sign-on is set up, and the account is not an owner's. `role` is null for an address with no
 * account, which is treated as a member's.
 */
export async function ssoRequired(store: DomainStore, tenant: string, ssoOn: boolean, email: string, role: Role | null): Promise<boolean> {
  if (!ssoOn || role === "owner") return false;
  return atVerifiedDomain(store, tenant, email);
}

/**
 * Whether a member's own API key or an app they approved is refused: the directory turned the
 * account off, or they are at a verified domain and not an owner. Unlike a sign-in this does not wait for single sign-on to be set up
 * here, since a key or a token is exactly what someone the provider closed keeps using; a
 * domain is only ever verified while single sign-on is set up.
 */
export async function keyRefused(store: DomainStore & Pick<AccountStore, "getSetting">, tenant: string, user: { id: string; email: string; role: Role }): Promise<boolean> {
  if (await suspended(store, tenant, user.id)) return true;
  return user.role !== "owner" && (await atVerifiedDomain(store, tenant, user.email));
}

/** Whether an address the identity provider vouches for, with no account and no invitation, joins: on any domain until one is verified, then only on a verified one or under it. */
export async function joinsWithoutInvitation(store: DomainStore, tenant: string, email: string): Promise<boolean> {
  const verified = (await store.listDomains(tenant)).filter((d) => d.verifiedAt);
  return !verified.length || verified.some((d) => atDomain(email, d.domain));
}

export function ssoRequiredError(email: string): AccountError {
  return new AccountError(`addresses at ${domainOf(email)} sign in with SSO`, 403);
}

function ownersOnly(actor: Principal): AccountError | null {
  if (actor.key) return new AccountError("an API key cannot change SSO domains", 403);
  return actor.role === "owner" ? null : new AccountError("only an owner manages SSO domains", 403);
}

export async function addDomain(store: AccountStore, tenant: string, actor: Principal, input: unknown, ssoOn: boolean, now = new Date()): Promise<DomainRecord> {
  const refused = ownersOnly(actor);
  if (refused) throw refused;
  if (!ssoOn) throw new AccountError("set up single sign-on before adding a domain; without it nobody at the domain could sign in", 409);
  const domain = cleanDomain(input);
  if ((await store.listDomains(tenant)).some((d) => d.domain === domain)) throw new AccountError(`${domain} is already added`, 409);
  const record: DomainRecord = { tenant, domain, token: randomBytes(16).toString("hex"), addedBy: actor.email, addedAt: now.toISOString(), verifiedAt: null };
  await store.saveDomain(record);
  return record;
}

/**
 * Reads the domain's TXT record and, when it carries this domain's token, marks the domain
 * verified and ends the sessions of everyone at it but owners, who sign in again through SSO.
 */
export async function verifyDomain(store: AccountStore, tenant: string, actor: Principal, domain: string, resolve: TxtResolver, now = new Date()): Promise<DomainRecord> {
  const refused = ownersOnly(actor);
  if (refused) throw refused;
  const found = (await store.listDomains(tenant)).find((d) => d.domain === domain);
  if (!found) throw new AccountError("no such domain", 404);
  let records: string[][];
  try {
    records = await resolve(recordName(domain));
  } catch {
    records = [];
  }
  if (!records.some((parts) => parts.join("") === `${RECORD_VALUE}${found.token}`)) {
    throw new AccountError(`no TXT record at ${recordName(domain)} carries this domain's value yet; DNS changes can take a while to show`, 409);
  }
  if (!found.verifiedAt) {
    await store.markDomainVerified(tenant, domain, now.toISOString());
    for (const user of await store.listUsers(tenant)) {
      if (user.role !== "owner" && atDomain(user.email, domain)) await store.deleteSessions(tenant, user.id);
    }
  }
  return { ...found, verifiedAt: found.verifiedAt ?? now.toISOString() };
}

export async function removeDomain(store: AccountStore, tenant: string, actor: Principal, domain: string): Promise<void> {
  const refused = ownersOnly(actor);
  if (refused) throw refused;
  if (!(await store.listDomains(tenant)).some((d) => d.domain === domain)) throw new AccountError("no such domain", 404);
  await store.deleteDomain(tenant, domain);
}

function failure(c: Context, err: unknown) {
  if (err instanceof AccountError) return c.json({ error: err.message }, err.status);
  throw err;
}

function view(d: DomainRecord) {
  return { domain: d.domain, verified: Boolean(d.verifiedAt), verifiedAt: d.verifiedAt, addedBy: d.addedBy, addedAt: d.addedAt, record: { name: recordName(d.domain), value: `${RECORD_VALUE}${d.token}` } };
}

export function domainRoutes(ctx: OrchestratorContext, resolve: TxtResolver = resolveTxt): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const store = ctx.store;

  app.get("/api/sso/domains", async (c) => {
    if (!manages(c.get("user"))) return c.json({ error: "only an owner or an admin sees SSO domains" }, 403);
    return c.json({ sso: Boolean(ctx.oidc), domains: (await store.listDomains(ctx.tenant)).map(view) });
  });

  app.post("/api/sso/domains", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { domain?: unknown };
      const added = await addDomain(store, ctx.tenant, c.get("user"), body.domain, Boolean(ctx.oidc));
      await recordEvent(ctx, c.get("user"), "sso.domain.added", { subject: `domain:${added.domain}`, detail: `${added.domain}, waiting for its TXT record` });
      return c.json({ domain: view(added) });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.post("/api/sso/domains/:domain/verify", async (c) => {
    try {
      const verified = await verifyDomain(store, ctx.tenant, c.get("user"), c.req.param("domain"), resolve);
      await recordEvent(ctx, c.get("user"), "sso.domain.verified", { subject: `domain:${verified.domain}`, detail: `${verified.domain} verified; everyone at it but owners signs in with SSO` });
      return c.json({ domain: view(verified) });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.delete("/api/sso/domains/:domain", async (c) => {
    try {
      await removeDomain(store, ctx.tenant, c.get("user"), c.req.param("domain"));
      await recordEvent(ctx, c.get("user"), "sso.domain.removed", { subject: `domain:${c.req.param("domain")}`, detail: `${c.req.param("domain")} removed; passwords work there again` });
      return c.json({ ok: true });
    } catch (err) {
      return failure(c, err);
    }
  });

  return app;
}
