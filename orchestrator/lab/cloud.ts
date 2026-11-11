import { randomBytes } from "node:crypto";
import type { ForgeIssue, ForgeMilestone } from "./forge.js";
import type { ProviderClient, ProviderName, ProviderPerson } from "./sign-in-providers.js";
import { MICROSOFT_CONSUMERS } from "./sign-in-providers.js";

/**
 * The people who sign up to a cloud orchestrator in the lab, by the provider each signs in with, and
 * the orchestrator's client at each provider. Two of them start organizations of their own; the others
 * are the edges a sign-up has to refuse or handle: an address Google has not verified, a GitHub
 * account with no verified address, a personal Microsoft account with no email claim.
 */

/** The directory id of the work tenant the lab's Microsoft person belongs to. */
export const MICROSOFT_WORK_TENANT = "7d1f4c52-0b9e-4a36-9c11-5e2f8a0c3b47";

export const SIGN_IN_PEOPLE: Record<ProviderName, ProviderPerson[]> = {
  google: [
    { id: "104857600123456789012", name: "Ada Okafor", email: "ada@okafor-labs.example.invalid", verified: true, domain: "okafor-labs.example.invalid" },
    { id: "104857600123456789099", name: "Gus Unverified", email: "gus@mail.example.invalid", verified: false },
    { id: "104857600123456789077", name: "Mia Kaya", email: "mia@kaya-keys.example.invalid", verified: true, domain: "kaya-keys.example.invalid" },
    // Kept out of every scenario: a person trying the cloud orchestrator by hand signs up as her, with no organization and no invitation.
    { id: "104857600123456789055", name: "Dana Novak", email: "dana@novak-studio.example.invalid", verified: true, domain: "novak-studio.example.invalid" },
  ],
  github: [
    { id: "4401", name: "Ben Ortiz", login: "ben-ortiz", email: "ben@ortiz-builds.example.invalid", verified: true },
    { id: "4402", name: "Nia Private", login: "nia-private", email: "nia@unconfirmed.example.invalid", verified: false },
  ],
  microsoft: [
    { id: "3f2b9d1a-6c4e-4b8f-a7d2-1e5c9b0a4f63", name: "Cem Aydin", login: "cem@aydin-works.example.invalid", email: "cem@aydin-works.example.invalid", verified: true, domain: MICROSOFT_WORK_TENANT },
    { id: "8a1c3e5f-2b4d-4f6a-9c8e-0d2f4b6a8c1e", name: "Dee Personal", login: "dee.personal@outlook.example.invalid", email: null, verified: false, domain: MICROSOFT_CONSUMERS },
  ],
};

/** Where a provider sends a test that drives the sign-in itself, outside any orchestrator. */
export const TEST_REDIRECT = "http://127.0.0.1:1/callback";

/**
 * The orchestrator's client at each provider. The redirect addresses are the test's own and, for each
 * orchestrator of the lab, the path the orchestrator's sign-in returns to; that path is set where the cloud
 * sign-in is designed, and here until then.
 */
export function signInClients(orchestratorUrls: string[]): Record<ProviderName, ProviderClient[]> {
  const client = (provider: ProviderName): ProviderClient => ({
    id: provider === "github" ? `Iv1.${randomBytes(8).toString("hex")}` : provider === "google" ? `${randomBytes(6).toString("hex")}.apps.lab.example.invalid` : randomBytes(16).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5"),
    secret: randomBytes(20).toString("hex"),
    redirects: [TEST_REDIRECT, ...orchestratorUrls.map((url) => `${url}/api/auth/${provider}/callback`)],
  });
  return { google: [client("google")], github: [client("github")], microsoft: [client("microsoft")] };
}

/**
 * Issues on the stand-in GitHub, for a team that keeps its work there: the repository is a board,
 * an open milestone a sprint, an issue in no milestone the backlog, and a closed issue is done;
 * the `status: ...` labels are the team's own. Numbered from 101, so they never take a number the
 * lab's pull requests are given; GitHub lists both together.
 */
export const GITHUB_ISSUES: Record<string, ForgeIssue[]> = {
  "initech/web-skills": [
    { number: 101, title: "Expose the order-history endpoint to customers", body: "Customers see past orders.\n\nAcceptance criteria: the route answers a customer's orders, newest first.", state: "open", labels: ["status: ready", "customer-api"], assignees: [], author: "kai", comments: [{ author: "lee", body: "Page it by 20." }], milestone: 3 },
    { number: 102, title: "Expose the saved-cards endpoint to customers", body: "Customers pick a saved card at checkout.", state: "open", labels: ["status: in progress", "customer-api"], assignees: ["kai"], author: "kai", comments: [], milestone: 3 },
    { number: 103, title: "The cart total rounds half a cent down", body: "A total of 10.005 shows 10.00.", state: "open", labels: ["status: in review", "bug"], assignees: ["lee"], author: "lee", comments: [], milestone: 3 },
    { number: 104, title: "Expose the wish-list endpoint to customers", body: "Shipped last sprint.", state: "closed", labels: ["customer-api"], assignees: ["kai"], author: "kai", comments: [], milestone: 2 },
    { number: 105, title: "Show prices in the customer's currency", body: "Prices follow the customer's country.", state: "open", labels: ["customer-api"], assignees: [], author: "lee", comments: [] },
  ],
};

/** The milestones of those issues: November's is open, October's closed with what shipped in it. */
export const GITHUB_MILESTONES: Record<string, ForgeMilestone[]> = {
  "initech/web-skills": [
    { number: 3, title: "Web, November", state: "open", dueOn: "2026-11-27T17:00:00Z", description: "Customers see their orders and saved cards" },
    { number: 2, title: "Web, October", state: "closed", dueOn: "2026-10-30T17:00:00Z", description: "The wish list ships" },
  ],
};

/**
 * Issues on the stand-in GitLab, for the Data team: the project is a board whose lists are its
 * Doing and Review labels between Open and Closed, an active milestone is a sprint, an issue in
 * no milestone is the backlog, and its weight is the story points. Numbered from 101, past the
 * merge requests the lab opens.
 */
export const GITLAB_ISSUES: Record<string, ForgeIssue[]> = {
  "globex/data-skills": [
    { number: 101, title: "Backfill the daily revenue table", body: "Two months are missing.", state: "open", labels: ["Doing"], assignees: ["hana"], author: "hana", comments: [], milestone: 11, weight: 3 },
    { number: 102, title: "Alert when an import stalls", body: "Page the data on-call after an hour.", state: "open", labels: ["Review", "priority::high"], assignees: [], author: "ivan", comments: [], milestone: 11, weight: 2 },
    { number: 103, title: "Document the warehouse schema", body: "One page per table.", state: "open", labels: [], assignees: [], author: "hana", comments: [], milestone: 11, weight: 1 },
    { number: 104, title: "Move the nightly export to the new bucket", body: "Done in October.", state: "closed", labels: [], assignees: ["ivan"], author: "ivan", comments: [], milestone: 10, weight: 2 },
    { number: 105, title: "Archive last year's raw files", body: "Keep them a year in cold storage.", state: "open", labels: ["blocked"], assignees: [], author: "hana", comments: [] },
  ],
};

/** The Data team's GitLab users by login, with the names their issues show. */
export const GITLAB_NAMES: Record<string, string> = { hana: "Hana Data", ivan: "Ivan Infra" };

export const GITLAB_MILESTONES: Record<string, ForgeMilestone[]> = {
  "globex/data-skills": [
    { number: 11, title: "Data, November", state: "open", startOn: "2026-11-02", dueOn: "2026-11-16", description: "Revenue is complete and imports page someone" },
    { number: 10, title: "Data, October", state: "closed", startOn: "2026-10-05", dueOn: "2026-10-30", description: "Exports move" },
  ],
};

export const GITLAB_BOARD_LISTS: Record<string, string[]> = { "globex/data-skills": ["Doing", "Review"] };
