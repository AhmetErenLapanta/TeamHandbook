import type { SessionListing, UserRecord } from "./accounts.js";

/**
 * A person on a cloud orchestrator: one identity, signing in with one or more providers, a member of
 * any number of organizations. A membership is the organization's own account row (role, teams,
 * sign-in record), tied to the identity, so everything an organization decides about its members
 * reads the same as on an orchestrator it runs itself. A self-hosted orchestrator keeps none of this.
 */
export type SocialProvider = "google" | "github" | "microsoft";

export interface IdentityRecord {
  id: string;
  /** The address every provider of this identity verified, kept lower-case; two identities never share one. */
  email: string;
  name: string;
  emailVerifiedAt: string;
  /** The terms address shown when this person created an organization, and when they accepted it. */
  termsUrl: string | null;
  termsAcceptedAt: string | null;
  createdAt: string;
}

export interface IdentityLogin {
  provider: SocialProvider;
  /** The provider's own stable id for the account: Google's and Microsoft's subject, GitHub's numeric user id. */
  subject: string;
  identityId: string;
  email: string;
  addedAt: string;
}

export interface IdentitySessionRecord {
  tokenHash: string;
  identityId: string;
  csrf: string;
  /** How this session signed in, which an organization's accepted sign-in methods are checked against. */
  method: SocialProvider;
  /** What the provider says holds the account: Google's Workspace domain, Microsoft's directory id. */
  domain: string | null;
  authenticatedAt: string;
  expiresAt: string;
  /** The browser and system family it signed in from, cut to 120 characters. */
  userAgent?: string | null;
}

/** A sign-in on its way to a provider and back, kept here so nothing the provider echoes decides where it lands. */
export interface PendingSignIn {
  state: string;
  provider: SocialProvider;
  purpose: "sign-in" | "link";
  nonce: string;
  verifier: string;
  /** For linking, the identity whose session started it; the answer is refused for any other. */
  identityId: string | null;
  /** The invitation the person came from, accepted once they are signed in. */
  inviteId: string | null;
  /**
   * The provider's account a link is waiting to be confirmed for, when its verified email is not
   * the identity's: kept beside the state until the person confirms on their own screen; absent reads as none.
   */
  account?: PendingAccount | null;
  expiresAt: string;
}

export interface PendingAccount {
  subject: string;
  email: string;
  name: string;
}

export interface Quotas {
  members: number | null;
  tasksPerMonth: number | null;
  concurrentTasks: number | null;
}

/** What an organization's plan opens on a cloud orchestrator, in order: each plan has what the ones before it have. */
export const PLANS = ["free", "pro"] as const;
export type Plan = (typeof PLANS)[number];

export interface OrgRecord {
  tenant: string;
  name: string;
  /** The identity that created it. */
  createdBy: string;
  createdAt: string;
  quotas: Quotas;
  /** Free when left out. */
  plan?: Plan;
  /** Set once the organization is deleted; its slug is never given out again. */
  deletedAt: string | null;
}

export interface IdentityStore {
  /** Saves a new identity with its first sign-in; false when the address or the login belongs to another identity already. */
  insertIdentity(identity: IdentityRecord, login: IdentityLogin): Promise<boolean>;
  getIdentity(id: string): Promise<IdentityRecord | null>;
  getIdentityByEmail(email: string): Promise<IdentityRecord | null>;
  getIdentityByLogin(provider: SocialProvider, subject: string): Promise<IdentityRecord | null>;
  listLogins(identityId: string): Promise<IdentityLogin[]>;
  /** False when that provider account is tied to an identity already. */
  addLogin(login: IdentityLogin): Promise<boolean>;
  /** False when it is the identity's last way in, which is never removed, or not the identity's at all. */
  removeLogin(identityId: string, provider: SocialProvider, subject: string): Promise<boolean>;
  acceptTerms(identityId: string, url: string, at: string): Promise<void>;
  saveIdentitySession(session: IdentitySessionRecord): Promise<void>;
  getIdentitySession(tokenHash: string): Promise<IdentitySessionRecord | null>;
  deleteIdentitySession(tokenHash: string): Promise<void>;
  listIdentitySessions(identityId: string, current?: string): Promise<SessionListing[]>;
  /** False when no session of this identity has that id. */
  deleteIdentitySessionById(identityId: string, id: string): Promise<boolean>;
  /** Marks a session seen; with `expiresAt`, also moves its expiry there when that is later. */
  touchIdentitySession(tokenHash: string, at: string, expiresAt?: string): Promise<void>;
  savePendingSignIn(pending: PendingSignIn): Promise<void>;
  /** Deletes and returns the pending sign-in a state names, once, unexpired. */
  takePendingSignIn(state: string, now: string): Promise<PendingSignIn | null>;
  /** The organization account this identity holds in a tenant. */
  getUserByIdentity(tenant: string, identityId: string): Promise<UserRecord | null>;
  /** Every organization account this identity holds, across tenants. */
  listMemberships(identityId: string): Promise<UserRecord[]>;
  /** The organization's accounts, a suspended one included, since it still holds a seat. */
  countMembers(tenant: string): Promise<number>;
  /** Adds the account only while the organization holds fewer than `members`, null for no limit; false when it is full. */
  insertMember(user: UserRecord, members: number | null): Promise<boolean>;
  /** False when the slug is taken, by a live organization or a deleted one. */
  insertOrg(org: OrgRecord): Promise<boolean>;
  /**
   * Signup's one step: the organization, its first owner and its name, or nothing. "limit" when
   * the identity has created `perDay.limit` organizations since `perDay.since`, "taken" when the
   * slug is, deleted ones included, or the tenant already has an owner or a claimed setup.
   */
  createOrg(org: OrgRecord, owner: UserRecord, name: string, perDay: { identityId: string; since: string; limit: number }): Promise<"created" | "taken" | "limit">;
  /** A deleted organization too, so its slug reads as taken. */
  getOrg(tenant: string): Promise<OrgRecord | null>;
  /** The organizations still served, without the deleted ones. */
  listOrgs(): Promise<OrgRecord[]>;
  /** Deleted ones count: deleting is not a way past the limit. */
  countOrgsCreatedSince(identityId: string, since: string): Promise<number>;
  setOrgQuotas(tenant: string, quotas: Quotas): Promise<void>;
  setOrgPlan(tenant: string, plan: Plan): Promise<void>;
  /** Leaves the row as a tombstone holding the slug; false when there is no live organization by it. */
  deleteOrg(tenant: string, at: string): Promise<boolean>;
}
