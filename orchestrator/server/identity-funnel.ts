import type { Store } from "./store.js";
import type { SocialProvider } from "./identities.js";

/**
 * What a person did before and around making an organization on a cloud orchestrator, kept apart
 * from every organization's log: someone who signs up and makes none is in no organization, and
 * no organization's owner reads someone else's signup. Only the domain of the address is kept.
 */
/** `operator.viewed` records an operator reading the page; it is no step of anyone's signup. */
export type IdentityEventKind = "signup.started" | "signup.completed" | "org.created" | "invite.accepted" | "directory.joined" | "operator.viewed";

export interface IdentityEvent {
  id: string;
  identityId: string;
  at: string;
  kind: IdentityEventKind;
  provider: SocialProvider;
  emailDomain: string;
  /** The organization the step was in: the one created, or the one an invitation joined. */
  org: string | null;
}

export interface IdentityEventStore {
  recordIdentityEvent(event: IdentityEvent): Promise<void>;
  /** The rows since `since`, oldest first. */
  identityEventsSince(since: string): Promise<IdentityEvent[]>;
  /** Deletes rows older than `before`; says how many. */
  pruneIdentityEvents(before: string): Promise<number>;
}

/** The steps a new organization goes through, in order; a person's last step is the furthest one reached. */
export const FUNNEL_STEPS = ["signed up", "created an organization", "connected a forge", "started a first task", "merged a first request"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/** The organization's own milestones past its creation, read from its event log. */
const ORG_MILESTONES: [FunnelStep, readonly string[]][] = [
  ["connected a forge", ["forge.connected", "forge.set"]],
  ["started a first task", ["task.started"]],
  ["merged a first request", ["request.merged"]],
];

export interface FunnelPerson {
  identityId: string;
  provider: SocialProvider;
  emailDomain: string;
  signedUpAt: string;
  orgCreated: { tenant: string; at: string } | null;
  viaInvite: boolean;
  lastStep: FunnelStep;
}

export interface IdentityFunnel {
  people: FunnelPerson[];
  /** How many of them reached each step. */
  counts: Record<FunnelStep, number>;
}

/** ORCHESTRATOR_IDENTITY_EVENTS_DAYS: how long signup steps are kept; 90 when unset, and the one place that decides it. */
export function identityEventDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORCHESTRATOR_IDENTITY_EVENTS_DAYS?.trim();
  if (!raw) return 90;
  if (!/^[1-9][0-9]{0,3}$/.test(raw)) throw new Error("ORCHESTRATOR_IDENTITY_EVENTS_DAYS is a whole number of days from 1 to 9999");
  return Number(raw);
}

/** The people who signed up since `since`, each with the furthest step they or the organization they made reached. */
export async function identityFunnel(store: Store, since: string): Promise<IdentityFunnel> {
  const byIdentity = new Map<string, IdentityEvent[]>();
  for (const event of await store.identityEventsSince(since)) {
    if (event.kind === "operator.viewed") continue;
    byIdentity.set(event.identityId, [...(byIdentity.get(event.identityId) ?? []), event]);
  }
  const people: FunnelPerson[] = [];
  for (const [identityId, events] of byIdentity) {
    const created = events.find((e) => e.kind === "org.created" && e.org);
    let lastStep: FunnelStep = created ? "created an organization" : "signed up";
    if (created) {
      const firsts = await store.firstEvents(created.org!, ORG_MILESTONES.flatMap(([, kinds]) => kinds));
      for (const [step, kinds] of ORG_MILESTONES) if (kinds.some((k) => firsts[k])) lastStep = step;
    }
    people.push({
      identityId,
      provider: events[0]!.provider,
      emailDomain: events[0]!.emailDomain,
      signedUpAt: events[0]!.at,
      orgCreated: created ? { tenant: created.org!, at: created.at } : null,
      viaInvite: events.some((e) => e.kind === "invite.accepted"),
      lastStep,
    });
  }
  const reached = (step: FunnelStep) => people.filter((p) => FUNNEL_STEPS.indexOf(p.lastStep) >= FUNNEL_STEPS.indexOf(step)).length;
  return { people, counts: Object.fromEntries(FUNNEL_STEPS.map((step) => [step, reached(step)])) as Record<FunnelStep, number> };
}
