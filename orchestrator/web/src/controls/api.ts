import { call } from "../api";
import type { Principal, RequestRecord } from "../api";
import type { MemberConfig, MemberConfigPreview } from "../../../shared/member-config";
import type { Audience, Policy, PolicyDraft, Rule } from "./policy";

export interface PolicyList { policies: Policy[]; problems: { repoId: string; problem: string }[]; orchestratorRulesStored: boolean }

/** Who a draft reaches and what tasks under it cost in the last 30 days, worked out before saving. */
export interface PolicyPreview {
  members: { id: string; name: string }[];
  teams: string[];
  repos: string[];
  usage30d: { tasks: number; usd: number | null; unknownCost: number };
}

/** What saving would open on each repository, for the person to confirm, or that it applies at once. */
export type PolicyProposal =
  | { applies: "now" }
  | { applies: "request"; repos: { repoId: string; name: string; head: string; change: "add" | "change" | "remove"; proposal: string; branch: string }[] };

export type PolicySaved =
  | { saved: "request"; id: string; requests: RequestRecord[]; failed: { repoId: string; error: string }[] }
  | { saved: "applied"; policy?: Policy; removed?: string };

export interface RequestConfirmation { message: string; branches: Record<string, string>; baseShas: Record<string, string> }

/** A tag members carry in this organization, from directory sync or set by hand, and how many carry it. */
export interface TagCount { tag: string; members: number }

/** The organization's tags, read from the member page's own list; only an owner or an admin sees them. */
export const tagsApi = {
  catalog: () => call<{ tags: { tag: string; members: unknown[] }[] }>("GET", "/api/tags").then((b) => b.tags.map((t): TagCount => ({ tag: t.tag, members: t.members.length }))),
};

/** What reaches one member, and the same with a policy draft in place. */
export const memberConfigApi = {
  get: (id: string) => call<MemberConfig>("GET", `/api/members/${encodeURIComponent(id)}/config`),
  preview: (id: string, audience: Audience, rules: Rule[]) => call<MemberConfigPreview>("POST", `/api/members/${encodeURIComponent(id)}/config/preview`, { audience, rules }),
};

export const policiesApi = {
  list: () => call<PolicyList>("GET", "/api/policies"),
  preview: (audience: Audience, rules: Rule[]) => call<PolicyPreview>("POST", "/api/policies/preview", { audience, rules }),
  proposal: (id: string | null, policy: PolicyDraft | null) => call<PolicyProposal>("POST", "/api/policies/proposal", policy ? { ...(id ? { id } : {}), policy } : { id, remove: true }),
  save: (id: string | null, policy: PolicyDraft, confirm?: RequestConfirmation) =>
    id ? call<PolicySaved>("PUT", `/api/policies/${encodeURIComponent(id)}`, { policy, ...confirm }) : call<PolicySaved>("POST", "/api/policies", { policy, ...confirm }),
  remove: (id: string, confirm?: RequestConfirmation) => call<PolicySaved>("DELETE", `/api/policies/${encodeURIComponent(id)}`, confirm ?? {}),
};

/** Owners and admins set the orchestrator's own rules; the server holds the same line. */
export const manages = (me: Principal): boolean => me.role === "admin" || me.role === "owner";

/** A service account's principal id carries this prefix; everyone else in a preview is a member. */
export const isServiceAccount = (id: string): boolean => id.startsWith("service:");
