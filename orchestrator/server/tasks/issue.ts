import type { TrackerConfig } from "../integrations/tracker.js";
import { detectSecret } from "../plugin.js";

export type IssueKind = "jira" | "github" | "gitlab" | "linear" | "other";

export interface IssueLink {
  url: string;
  kind: IssueKind;
  /** `PAY-142`, `acme/payments#12`, or null for an address the orchestrator does not recognise. */
  key: string | null;
  /** The key as it goes into a branch name, or null with no key. */
  branchToken: string | null;
}

export const MAX_ISSUE_URL = 500;

const JIRA = /^\/browse\/([A-Z][A-Z0-9]+-\d+)\/?$/;
const LINEAR = /^\/[^/]+\/issue\/([A-Z][A-Z0-9]*-\d+)(?:\/|$)/;
const GITHUB = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/;
const GITLAB = /^\/((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+)\/-\/issues\/(\d+)\/?$/;

function token(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The issue a task points at, read from its address alone. The orchestrator never fetches it -
 * the agent reads it through one of the team's MCP servers - so the address only has to be
 * one worth handing to an agent and quoting in a request: https, no credentials in it, and
 * nothing in it that looks like a secret, since it is written into the prompt, the log and
 * the request body. An https address of a tracker the orchestrator does not recognise is kept,
 * with no key. A link on the connected tracker's own site takes the tracker's scheme: the
 * tracker card already allowed plain http only for a tracker on this machine.
 */
export function parseIssueLink(raw: string, tracker: Pick<TrackerConfig, "url"> | null = null): IssueLink | { error: string } {
  const value = raw.trim();
  if (value.length > MAX_ISSUE_URL) return { error: `an issue link is at most ${MAX_ISSUE_URL} characters` };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: "the issue link is not an address" };
  }
  const site = tracker ? new URL(tracker.url) : null;
  if (url.protocol !== "https:" && !(site && url.origin === site.origin)) {
    return { error: site && site.protocol !== "https:" ? `an issue link starts with https://, or with ${site.origin}/, the connected tracker's address` : "an issue link starts with https://" };
  }
  // The limit holds for the address as stored, after URL encoding has lengthened it.
  if (url.toString().length > MAX_ISSUE_URL) return { error: `an issue link is at most ${MAX_ISSUE_URL} characters` };
  if (url.username || url.password) return { error: "an issue link carries no user name or password" };
  const secret = detectSecret(value);
  if (secret) return { error: `the issue link looks like it holds a secret (${secret})` };
  const path = url.pathname;
  // Linear names an issue by its identifier under the workspace: linear.app/<workspace>/issue/ENG-123/<title>.
  const linear = url.hostname === "linear.app" || (site && url.origin === site.origin) ? LINEAR.exec(path) : null;
  if (linear) return { url: url.toString(), kind: "linear", key: linear[1]!, branchToken: linear[1]! };
  const jira = JIRA.exec(path);
  if (jira) return { url: url.toString(), kind: "jira", key: jira[1]!, branchToken: jira[1]! };
  // GitHub has no /-/ in its paths; the shape there is not a GitLab issue.
  const gitlab = url.hostname === "github.com" ? null : GITLAB.exec(path);
  if (gitlab) {
    const project = gitlab[1]!;
    return { url: url.toString(), kind: "gitlab", key: `${project}#${gitlab[2]}`, branchToken: `${token(project.split("/").pop()!)}-${gitlab[2]}` };
  }
  const github = GITHUB.exec(path);
  if (github) return { url: url.toString(), kind: "github", key: `${github[1]}/${github[2]}#${github[3]}`, branchToken: `${token(github[2]!)}-${github[3]}` };
  return { url: url.toString(), kind: "other", key: null, branchToken: null };
}
