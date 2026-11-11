import type { OrchestratorContext } from "./app.js";
import { AccountError } from "./accounts.js";
import { manages } from "./auth.js";
import type { Principal } from "./auth.js";
import type { OrchestratorEvent } from "./events.js";
import { readTracker } from "./integrations/tracker.js";
import type { Journey, Milestone, MilestoneId, PersonStage, Stage } from "../shared/journey.js";

/** Each milestone and the event kinds that reach it, in the order an organization gets there. */
const MILESTONES: { id: MilestoneId; kinds: string[]; subject?: string }[] = [
  { id: "org", kinds: ["org.created", "orchestrator.setup"] },
  { id: "forge", kinds: ["forge.connected", "forge.set"] },
  { id: "repo", kinds: ["repo.connected"] },
  { id: "invited", kinds: ["invite.sent"] },
  { id: "joined", kinds: ["account.joined"] },
  { id: "tracker", kinds: ["integration.enabled"], subject: "integration:tracker" },
  { id: "task", kinds: ["task.started"] },
  { id: "request", kinds: ["request.opened"] },
  { id: "merged", kinds: ["request.merged"] },
];

/** What a person has done, furthest first: the first of these they reached is their stage. */
const STAGES: { stage: Stage; kind: string }[] = [
  { stage: "merged a request", kind: "request.merged" },
  { stage: "opened a request", kind: "request.opened" },
  { stage: "started a task", kind: "task.started" },
];

const PAGE = 500;

/**
 * The oldest event of one kind about one subject. Only the tracker step reads this way, since
 * integration.enabled names every integration; its subject keeps the walk to a handful of rows.
 */
async function oldestAbout(ctx: Pick<OrchestratorContext, "store" | "tenant">, kind: string, subject: string): Promise<OrchestratorEvent | null> {
  let found: OrchestratorEvent | null = null;
  let after = null;
  do {
    const page = await ctx.store.eventPage(ctx.tenant, { kindPrefix: kind, subject }, after, PAGE);
    for (const e of page.events) if (e.kind === kind) found = e;
    after = page.next;
  } while (after);
  return found;
}

/** Each person's newest sign-in, from the newest page of sign-ins: one not on it signed in long ago or never. */
async function lastSignIns(ctx: Pick<OrchestratorContext, "store" | "tenant">): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const page = await ctx.store.eventPage(ctx.tenant, { kindPrefix: "account.signin" }, null, PAGE);
  for (const e of page.events) if (e.kind === "account.signin" && e.actor.id && !seen.has(e.actor.id)) seen.set(e.actor.id, e.at);
  return seen;
}

/**
 * Where the organization stands in getting set up and where each person in it stands, for an
 * owner or an admin signed in: an invitation nobody took up is a teammate the setup lost, so
 * those come first. It names kinds, times and people, never an event's detail.
 */
export async function journey(ctx: Pick<OrchestratorContext, "store" | "tenant">, actor: Principal, now = new Date()): Promise<Journey> {
  if (actor.key || !manages(actor)) throw new AccountError("only an owner or an admin signed in to the orchestrator reads who is where", 403);
  const plain = MILESTONES.filter((m) => !m.subject).flatMap((m) => m.kinds);
  const [users, invites, repos, tracker, tasks, requests, signIns, firsts, byActor] = await Promise.all([
    ctx.store.listUsers(ctx.tenant),
    ctx.store.listInvites(ctx.tenant),
    ctx.store.listRepos(ctx.tenant),
    readTracker(ctx),
    ctx.store.taskPage(ctx.tenant, {}, null, 1),
    ctx.store.requestPage(ctx.tenant, {}, null, 1),
    lastSignIns(ctx),
    ctx.store.firstEvents(ctx.tenant, plain),
    ctx.store.firstEventsByActor(ctx.tenant, [...STAGES.map((s) => s.kind), "account.joined"]),
  ]);
  const forgeAccess = (await Promise.all(repos.map((r) => ctx.store.getForgeConfig(ctx.tenant, r.id)))).some(Boolean);
  const { open, merged, closed } = requests.counts;
  // What the organization already has counts too: the log starts later than a repository the
  // configuration file lists, a teammate added by hand, or a task from before tasks were logged.
  const has: Record<MilestoneId, boolean> = {
    org: true,
    forge: forgeAccess,
    repo: repos.length > 0,
    invited: invites.length > 0,
    joined: users.length > 1,
    tracker: tracker !== null,
    task: tasks.tasks.length > 0,
    request: open + merged + closed > 0,
    merged: merged > 0,
  };
  const milestones: Milestone[] = [];
  for (const m of MILESTONES) {
    const events = m.subject ? [await oldestAbout(ctx, m.kinds[0]!, m.subject)].filter((e): e is OrchestratorEvent => e !== null) : m.kinds.flatMap((k) => (firsts[k] ? [firsts[k]!] : []));
    const first = events.sort((a, b) => a.at.localeCompare(b.at))[0];
    milestones.push({ id: m.id, done: Boolean(first) || has[m.id], at: first?.at ?? null, by: first ? first.actor.name ?? first.actor.email : null });
  }
  const people: PersonStage[] = users.map((u) => {
    const done = byActor[u.id] ?? {};
    const at = STAGES.findIndex((s) => done[s.kind]);
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      stage: at === -1 ? "joined" : STAGES[at]!.stage,
      since: at === -1 ? u.createdAt : done[STAGES[at]!.kind]!.at,
      // An account added by hand joined when it was made; an invitation taken up says when.
      joinedAt: done["account.joined"]?.at ?? u.createdAt,
      firstTaskAt: done["task.started"]?.at ?? null,
      firstRequestAt: done["request.opened"]?.at ?? null,
      lastSeen: signIns.get(u.id) ?? null,
    };
  });
  const invited = invites
    .filter((i) => i.expiresAt > now.toISOString())
    .map((i) => ({ email: i.email, at: i.createdAt, expiresAt: i.expiresAt }))
    .sort((a, b) => a.at.localeCompare(b.at));
  return { milestones, people, invited };
}
