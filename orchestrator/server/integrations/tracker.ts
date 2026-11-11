import type { OrchestratorContext } from "../app.js";
import { ChangeRefused } from "../changes.js";
import { readEnabled } from "./records.js";

export const TRACKER = "tracker";

export type TrackerKind = "jira" | "gitlab" | "github" | "linear";

/**
 * The team's issue tracker: where an issue key a task names points, and, with a token, where
 * the orchestrator reads the issue a task works on so the agent gets its text. The token is sealed
 * in the vault and only ever sent to this address; the orchestrator never writes to an issue, and
 * the card says so.
 */
export interface TrackerConfig {
  kind: TrackerKind;
  url: string;
  /** The account a Jira API token belongs to; Jira's basic authentication pairs the two. */
  email?: string;
}

export const TRACKER_TOKEN_SECRET = "integration.tracker.token";

const DEFAULT_URL: Record<TrackerKind, string | null> = { jira: null, gitlab: "https://gitlab.com", github: "https://github.com", linear: null };
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const EMAIL = /^[^\s@]+@[^\s@]+$/;

export function cleanTracker(body: Record<string, unknown>): TrackerConfig {
  const kind = body.kind;
  if (kind !== "jira" && kind !== "gitlab" && kind !== "github" && kind !== "linear") throw new ChangeRefused("the tracker is jira, gitlab, github or linear");
  const given = typeof body.url === "string" && body.url.trim() ? body.url.trim() : DEFAULT_URL[kind];
  if (!given) throw new ChangeRefused(kind === "linear" ? "enter your Linear workspace's address, such as https://linear.app/acme" : "enter the address of your Jira site, such as https://acme.atlassian.net");
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new ChangeRefused("the tracker address is not a URL");
  }
  // A token is sent to this address, so it travels over TLS, except to this machine itself.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new ChangeRefused("the tracker address has to be https");
  if (url.username || url.password || url.search || url.hash) throw new ChangeRefused("the tracker address is the site alone, with no credentials, query or fragment");
  // A Linear workspace is read through Linear's own API, so its address is linear.app's, or a stand-in on this machine.
  if (kind === "linear" && url.hostname !== "linear.app" && !LOOPBACK.has(url.hostname)) throw new ChangeRefused("a Linear workspace's address is https://linear.app/<workspace>");
  // Every workspace shares linear.app, so the workspace is the address's first segment alone: an issue is read only when its link is in it.
  const workspace = url.pathname.split("/")[1];
  if (kind === "linear" && !workspace) throw new ChangeRefused("a Linear workspace's address is https://linear.app/<workspace>");
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (email && (kind !== "jira" || !EMAIL.test(email) || email.length > 254)) throw new ChangeRefused(kind === "jira" ? "the email is the address of the Jira account the token belongs to" : "only a Jira site takes an email");
  return { kind, url: kind === "linear" ? `${url.origin}/${workspace}` : url.toString().replace(/\/+$/, ""), ...(email ? { email } : {}) };
}

/** Whether a stored token still belongs to the settings: the same tracker, site and account. */
export function sameTracker(a: TrackerConfig | null | undefined, b: TrackerConfig): boolean {
  return Boolean(a) && a!.kind === b.kind && a!.url === b.url && (a!.email ?? "") === (b.email ?? "");
}

const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const PROJECT_KEY = /^((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)#(\d+)$/;

/**
 * The issue a task names, as an address: a full link is kept as given, and a key (`PAY-142`,
 * `group/project#12`, `owner/repo#12`) is made a link on the connected tracker. A key with no
 * tracker, or one in another tracker's form, is refused with what to write instead.
 */
export function issueAddress(given: string, tracker: TrackerConfig | null): string {
  const value = given.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (!tracker) throw new ChangeRefused("paste the issue's full link, or connect the issue tracker under Integrations to name issues by key");
  if (tracker.kind === "jira") {
    if (!JIRA_KEY.test(value)) throw new ChangeRefused("a Jira issue is named by its key, such as PAY-142, or by its full link");
    return `${tracker.url}/browse/${value}`;
  }
  if (tracker.kind === "linear") {
    if (!JIRA_KEY.test(value)) throw new ChangeRefused("a Linear issue is named by its identifier, such as ENG-123, or by its full link");
    return `${tracker.url}/issue/${value}`;
  }
  const match = PROJECT_KEY.exec(value);
  if (!match || (tracker.kind === "github" && match[1]!.split("/").length !== 2)) {
    throw new ChangeRefused(tracker.kind === "github" ? "a GitHub issue is named owner/repo#12, or by its full link" : "a GitLab issue is named group/project#12, or by its full link");
  }
  return tracker.kind === "github" ? `${tracker.url}/${match[1]}/issues/${match[2]}` : `${tracker.url}/${match[1]}/-/issues/${match[2]}`;
}

export async function readTracker(ctx: Pick<OrchestratorContext, "store" | "tenant">): Promise<TrackerConfig | null> {
  return (await readEnabled<TrackerConfig>(ctx, TRACKER))?.config ?? null;
}
