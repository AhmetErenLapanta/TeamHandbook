import { Hono } from "hono";
import { principalOf } from "./accounts.js";
import type { UserRecord } from "./accounts.js";
import { csrfRefusal } from "./auth.js";
import { identitySessionOf, recordStep } from "./cloud-identity.js";
import { RESERVED_TENANTS } from "./config.js";
import { OrchestratorError, errorAnswer } from "./errors.js";
import { recordEvent } from "./events.js";
import { newId } from "./ids.js";
import type { LegalLinks } from "./legal.js";
import { checkedName } from "./organization.js";
import type { OrgRegistry } from "./orgs.js";
import type { Quotas } from "./identities.js";
import type { Store } from "./store.js";

/**
 * A signed-in person creating their organization on a cloud orchestrator, and becoming its owner. An
 * organization's slug is its address and its tenant, given once: one deleted keeps its slug, so
 * links to it never reach a stranger's organization.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}$/;
/** Paths the orchestrator and its web app answer themselves, besides those the configuration file already keeps out. */
const RESERVED_SLUGS = new Set([...RESERVED_TENANTS, "signup", "login", "signin", "logout", "account", "welcome", "orgs", "admin", "static", "health", "metrics", "auth", "join", "invite", "settings", "operator"]);

export interface SignupOptions {
  store: Store;
  secure: boolean;
  registry: OrgRegistry;
  legal: LegalLinks;
  quotas: () => Quotas;
  /** Organizations one identity creates in a day. */
  perDay: number;
}

const refused = (message: string, status: 400 | 403 | 409 | 429 = 400) => new OrchestratorError("signup", message, status);

export function signupRoutes(options: SignupOptions): Hono {
  const { store, legal } = options;
  const app = new Hono();

  app.post("/api/signup/organization", async (c) => {
    const session = await identitySessionOf(c, store, options.secure);
    const identity = session ? await store.getIdentity(session.identityId) : null;
    if (!session || !identity) return c.json({ error: "sign in first" }, 401);
    const csrf = csrfRefusal(c, session.csrf);
    if (csrf) return csrf;
    try {
      if (!legal.termsUrl || !legal.privacyUrl) throw refused("signup is closed until the orchestrator's operator sets its privacy policy and terms of use", 409);
      const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; slug?: unknown; acceptTerms?: unknown };
      if (body.acceptTerms !== true) throw refused("accept the terms of use to create an organization");
      const name = checkedName(body.name);
      const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
      if (!SLUG.test(slug)) throw refused("an organization's address is 2 to 39 lowercase letters, digits and dashes, starting with a letter or a digit");
      if (RESERVED_SLUGS.has(slug)) throw refused(`/${slug} is a path the orchestrator answers itself; pick another address`);
      // An organization this node serves already, such as one the operator lists in the file, is never anyone's to sign up for.
      if (options.registry.list().some((org) => org.ctx.tenant === slug)) throw refused(`/${slug} is taken; pick another address`, 409);
      const now = new Date();
      const at = now.toISOString();
      const owner: UserRecord = { tenant: slug, id: newId("usr"), email: identity.email, name: identity.name, role: "owner", passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: null, createdAt: at, identityId: identity.id };
      // The slug, its owner, its name and the day's count in one step: two signups at once never
      // share a slug or pass the day's limit together.
      const made = await store.createOrg({ tenant: slug, name, createdBy: identity.id, createdAt: at, quotas: options.quotas(), deletedAt: null }, owner, name, { identityId: identity.id, since: new Date(now.getTime() - 86_400_000).toISOString(), limit: options.perDay });
      if (made === "limit") throw refused(`one person creates at most ${options.perDay} organizations a day; try again tomorrow`, 429);
      if (made === "taken") throw refused(`/${slug} is taken; pick another address`, 409);
      await store.acceptTerms(identity.id, legal.termsUrl, at);
      if (!identity.termsAcceptedAt) await recordStep(store, identity, "signup.completed", session.method);
      await recordStep(store, identity, "org.created", session.method, slug);
      const org = await options.registry.get(slug);
      if (org) await recordEvent(org.ctx, await principalOf(store, owner), "org.created", { subject: `org:${slug}`, detail: `${name} created by ${identity.email}, who accepted the terms at ${legal.termsUrl}` });
      return c.json({ tenant: slug, name, next: `/${slug}/welcome` });
    } catch (err) {
      if (err instanceof OrchestratorError) return errorAnswer(c, err);
      throw err;
    }
  });

  return app;
}
