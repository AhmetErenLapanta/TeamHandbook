/**
 * What the orchestrator knows of each hosted forge apart from talking to it: its name and its word for
 * a request, where its API sits beside a repository's address, which hosts it can be on, the user
 * git names with a token, and what it can say about a request. Pure data and functions, so the
 * screen reads the same definitions the server drives. A forge is added here and in its driver;
 * every per-forge table is a Record over HOSTED_FORGES, so one left out fails the type check.
 */

export const HOSTED_FORGES = ["gitlab", "github", "gitea"] as const;

export type HostedForge = (typeof HOSTED_FORGES)[number];

export interface ForgeCapabilities {
  /** What the forge calls a request. */
  term: "merge request" | "pull request";
  /** GitLab's reviewers approve or say nothing; GitHub's also ask for changes. */
  review: "approve-only" | "approve-or-request-changes";
  /**
   * Whether no check at all means the repository runs no CI: GitLab makes a pipeline when a push
   * lands if the project has CI, so nothing means none; a GitHub app can report minutes later.
   */
  checksAlwaysReport: boolean;
  /** Where the forge keeps a request's description template, in the order it picks one. */
  templates: string[];
}

export interface ForgeDefinition {
  kind: HostedForge;
  label: "GitLab" | "GitHub" | "Gitea";
  capabilities: ForgeCapabilities;
  /** How a repository's path reads on this forge, for the screen's hints. */
  projectShape: "group/project" | "owner/repository";
  /** The hosts that are this forge's own service, recognised without asking. */
  homeHosts: readonly string[];
  /** The user name git sends with a token in an Authorization header. */
  gitUser: "oauth2" | "x-access-token";
  /** Whether a repository on this host can be on this forge: GitLab runs anywhere, GitHub on github.com. */
  allowsHost(hostname: string): boolean;
  /** The forge's API root for a repository whose address has this origin. */
  apiUrlFor(origin: URL): string;
  /** The ref the forge keeps a request's commits under, which a mirror fetches: readable even for a request from a fork. */
  requestRef(number: number): string;
  /**
   * The forge's own page that opens a request from a pushed branch, filled in: what a runner on a
   * machine with no signed-in gh or glab puts on the task's page for the person to press.
   */
  newRequestUrl(webUrl: string, project: string, branch: string, target: string): string;
  /** Where a person makes the token a repository connected by hand needs, and what it has to allow. */
  credentials: { tokenPage(webUrl: string): string; scopes: readonly string[] };
  /** The visibilities a new team repository can have on this forge, in the order the form offers them. */
  visibilities: readonly Visibility[];
  /** The parent a new repository can sit under, which the form asks for; null where the signed-in account owns it. */
  group: RepositoryGroup | null;
  /** What a person does when the connected account lists no repository: give it access to the team's repository. */
  emptyListHint: string;
}

export type Visibility = "private" | "internal" | "public";

export interface RepositoryGroup {
  label: string;
  placeholder: string;
  /** What the field means, for the form's help: where the repository is made, and where when it is left empty. */
  meaning: string;
}

/** A path whose slashes stay, each segment encoded on its own. */
const segments = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Hosts on this machine, where a forge is only ever a stand-in. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const FORGES: Record<HostedForge, ForgeDefinition> = {
  gitlab: {
    kind: "gitlab",
    label: "GitLab",
    capabilities: { term: "merge request", review: "approve-only", checksAlwaysReport: true, templates: [".gitlab/merge_request_templates/Default.md", ".gitlab/merge_request_templates/*.md"] },
    projectShape: "group/project",
    homeHosts: ["gitlab.com"],
    gitUser: "oauth2",
    allowsHost: () => true,
    apiUrlFor: (origin) => `${origin.origin}/api/v4`,
    requestRef: (number) => `refs/merge-requests/${number}/head`,
    newRequestUrl: (webUrl, project, branch, target) =>
      `${webUrl.replace(/\/+$/, "")}/${segments(project)}/-/merge_requests/new?${new URLSearchParams({ "merge_request[source_branch]": branch, "merge_request[target_branch]": target })}`,
    // GitLab has no narrower scope that opens merge requests than api.
    credentials: { tokenPage: (webUrl) => `${webUrl.replace(/\/+$/, "")}/-/user_settings/personal_access_tokens?name=TeamHandbook&scopes=api`, scopes: ["api"] },
    visibilities: ["private", "internal", "public"],
    group: { label: "Group (optional)", placeholder: "acme/platform", meaning: "The group or subgroup the repository is made in; left empty, the connected account's own namespace holds it." },
    emptyListHint: "Give the GitLab account you connected access to the team's repository, then read the list again.",
  },
  github: {
    kind: "github",
    label: "GitHub",
    capabilities: { term: "pull request", review: "approve-or-request-changes", checksAlwaysReport: false, templates: [".github/pull_request_template.md", "pull_request_template.md", "docs/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE/*.md"] },
    projectShape: "owner/repository",
    homeHosts: ["github.com"],
    gitUser: "x-access-token",
    allowsHost: (hostname) => hostname === "github.com" || LOOPBACK_HOSTS.has(hostname),
    apiUrlFor: (origin) => (LOOPBACK_HOSTS.has(origin.hostname) ? `${origin.origin}/api` : "https://api.github.com"),
    requestRef: (number) => `refs/pull/${number}/head`,
    newRequestUrl: (webUrl, project, branch, target) => `${webUrl.replace(/\/+$/, "")}/${segments(project)}/compare/${segments(target)}...${segments(branch)}?expand=1`,
    credentials: { tokenPage: (webUrl) => `${webUrl.replace(/\/+$/, "")}/settings/personal-access-tokens/new`, scopes: ["Contents: read and write", "Pull requests: read and write", "Commit statuses: read and write", "Metadata: read"] },
    visibilities: ["private", "public"],
    group: null,
    emptyListHint: "Where the app is installed on chosen repositories only, add the team's repository to its installation on GitHub, then read the list again.",
  },
  /*
   * Gitea, and Forgejo, which keeps Gitea's API, from 1.20, where a branch is made at a commit and
   * files are written to an empty repository. Read from Gitea 1.22's source: git takes the token as
   * the password beside any user name; a description template is looked for at the root, then under
   * .gitea/, then .github/.
   */
  gitea: {
    kind: "gitea",
    label: "Gitea",
    capabilities: {
      term: "pull request",
      review: "approve-or-request-changes",
      checksAlwaysReport: false,
      templates: ["PULL_REQUEST_TEMPLATE.md", "pull_request_template.md", ".gitea/PULL_REQUEST_TEMPLATE.md", ".gitea/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", ".github/pull_request_template.md"],
    },
    projectShape: "owner/repository",
    homeHosts: ["gitea.com", "codeberg.org"],
    gitUser: "oauth2",
    allowsHost: () => true,
    apiUrlFor: (origin) => `${origin.origin}/api/v1`,
    requestRef: (number) => `refs/pull/${number}/head`,
    newRequestUrl: (webUrl, project, branch, target) => `${webUrl.replace(/\/+$/, "")}/${segments(project)}/compare/${segments(target)}...${segments(branch)}`,
    credentials: { tokenPage: (webUrl) => `${webUrl.replace(/\/+$/, "")}/user/settings/applications`, scopes: ["write:repository", "write:issue", "read:user"] },
    visibilities: ["private", "public"],
    group: { label: "Organization (optional)", placeholder: "acme", meaning: "The organization the repository is made in; left empty, the account whose token is connected owns it." },
    emptyListHint: "Give the Gitea account whose token is connected access to the team's repository, then read the list again.",
  },
};

/** A request as its forge names it on a link, the only place a forge's own word appears: "Merge request !12 on GitLab". */
export function forgeRequestName(kind: HostedForge, number: number): string {
  const { term } = FORGES[kind].capabilities;
  return `${term.charAt(0).toUpperCase()}${term.slice(1)} ${kind === "gitlab" ? "!" : "#"}${number} on ${FORGES[kind].label}`;
}

export function isHostedForge(value: unknown): value is HostedForge {
  return typeof value === "string" && (HOSTED_FORGES as readonly string[]).includes(value);
}

/**
 * The forges in the order an address is claimed by one: a host only one forge can be on first
 * (github.com), then the forge that runs anywhere. The order a repository's forge is recognised
 * in is the same here, and kept apart so a forge that shares URL shapes with another can differ.
 */
export const CLAIM_ORDER: readonly HostedForge[] = ["github", "gitea", "gitlab"];

/**
 * The forge a repository address is on when its host says so without asking anyone: a forge's own
 * service, or a host the orchestrator already reaches a forge at (an operator's or an org's GitLab). Null for any other host, which the person names.
 */
export function recognizeForge(address: string, knownHosts: Partial<Record<HostedForge, readonly string[]>> = {}): HostedForge | null {
  let host: string;
  try {
    host = new URL(address).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const kind of CLAIM_ORDER) {
    if ([...FORGES[kind].homeHosts, ...(knownHosts[kind] ?? [])].some((h) => h.toLowerCase() === host)) return kind;
  }
  return null;
}
