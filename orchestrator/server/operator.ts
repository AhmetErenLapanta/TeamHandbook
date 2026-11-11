import { Hono } from "hono";
import { identitySessionOf } from "./cloud-identity.js";
import { identityEventDays, identityFunnel } from "./identity-funnel.js";
import type { IdentityFunnel } from "./identity-funnel.js";
import { newId } from "./ids.js";
import type { Store } from "./store.js";

/**
 * ORCHESTRATOR_OPERATOR_EMAILS: the addresses, comma separated, of the people who run a cloud
 * orchestrator. An operator is an identity that signed in through a provider with one of these
 * addresses verified; there is no operator account or key of its own to leak.
 */
export function operatorEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const listed = (env.ORCHESTRATOR_OPERATOR_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const odd = listed.find((e) => !/^[^\s@]+@[^\s@]+$/.test(e));
  if (odd) throw new Error(`ORCHESTRATOR_OPERATOR_EMAILS holds ${JSON.stringify(odd)}, which is not an email address`);
  return new Set(listed);
}

const DAY = 86_400_000;

/**
 * The operator's page on a cloud orchestrator, outside every organization: who signed up, and
 * how far each got. Anyone who is not an operator, and everyone when no operator is listed, gets
 * the same 404 as an address that does not exist, so the page does not say it is there. Each
 * read is recorded beside the signups, never in an organization's log, which every owner reads.
 */
export function operatorRoutes({ store, secure, operators }: { store: Store; secure: boolean; operators: ReadonlySet<string> }): Hono {
  const app = new Hono();
  app.get("/api/operator/funnel", async (c) => {
    const session = operators.size ? await identitySessionOf(c, store, secure) : null;
    const identity = session ? await store.getIdentity(session.identityId) : null;
    if (!session || !identity?.emailVerifiedAt || !operators.has(identity.email.toLowerCase())) return c.json({ error: "not found" }, 404);
    const kept = identityEventDays();
    const asked = Number(c.req.query("days") ?? 30);
    const days = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, kept) : 30;
    const now = new Date();
    await store.recordIdentityEvent({ id: newId("evt", now.getTime()), identityId: identity.id, at: now.toISOString(), kind: "operator.viewed", provider: session.method, emailDomain: identity.email.split("@")[1] ?? "", org: null });
    return c.json<IdentityFunnel & { days: number; keptDays: number }>({ ...(await identityFunnel(store, new Date(now.getTime() - days * DAY).toISOString())), days, keptDays: kept });
  });
  return app;
}
