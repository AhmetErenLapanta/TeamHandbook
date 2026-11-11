import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { OrchestratorError } from "../errors.js";
import { gitAsync, gitAsyncMaybe } from "../git.js";
import { redactLine } from "../log.js";
import { nonInteractiveEnv } from "../plugin.js";
import type { RepoRecord } from "../store.js";
import { FORGES } from "../../shared/forge-def.js";
import { checkBranch, ForgeHttpError } from "./http.js";
import type { ForgeHttp } from "./http.js";
import { changeCommit, ForgeRefusal, scratch } from "./local.js";
import { forgeState, forgeTime } from "./types.js";
import type { BranchUpdate, ChangeRequest, CommitCheck, ForgeConfig, ForgeProvider, ForgeState, OpenedRequest, PushedBranch, RequestAssignment } from "./types.js";

/**
 * A request opened as the person themselves, in local mode: the branch is pushed by git with the
 * sign-in the person's own `gh` or `glab` holds, and the request is opened by that same CLI. The
 * orchestrator never reads, stores or passes a token; git asks the CLI for it as git's credential
 * helper, and the CLI answers git directly. The commit's author is the person, its committer the
 * orchestrator, as for every change.
 */

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The program is not installed here. */
  missing: boolean;
}

export type CliTool = "gh" | "glab" | "tea";

export type CliRun = (tool: CliTool, args: string[], input?: string) => Promise<CliResult>;

/**
 * The person's environment for their CLI, without the orchestrator's own settings and secrets, and never waiting on a prompt.
 * tea's GITEA_TOKEN and GITEA_INSTANCE_URL stand in for every login it holds, whichever a call names, so they are left out.
 */
export function cliEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(nonInteractiveEnv(process.env)).filter(([name]) => !name.startsWith("ORCHESTRATOR_") && name !== "GITEA_TOKEN" && name !== "GITEA_INSTANCE_URL"));
}

export const runOwnCli: CliRun = (tool, args, input) =>
  new Promise((resolve) => {
    // Run outside any checkout, so the CLI reads no repository's config; every call names its repository.
    const child = execFile(tool, args, { cwd: tmpdir(), env: cliEnv(), timeout: 60_000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const failure = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({ code: failure ? (typeof failure.code === "number" ? failure.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), missing: failure?.code === "ENOENT" });
    });
    child.stdin?.end(input ?? "");
  });

/** The CLI's sign-in to a host: the arguments that name it on every call, and what the person fixes when it is not usable. */
interface SignIn {
  installed: boolean;
  signedIn: boolean;
  as: string[];
  account?: string | null;
  problem?: string;
}

interface Tool {
  tool: CliTool;
  name: string;
  /** Git's credential helper that asks the CLI for the person's sign-in. */
  helper: string;
  install: string;
  login(host: string): string;
  /** Whether the CLI is here and signed in to `host` (with its port), with no call to the forge where the CLI allows it. */
  signIn(host: string, run: CliRun): Promise<SignIn>;
  /** Whether this CLI can be git's credential helper, asked beside its version. */
  helps(run: CliRun, version: Promise<string | null>): Promise<boolean>;
  /** The login the sign-in is the person's as, asked of the CLI, never read from its files. */
  account(host: string, signIn: SignIn, run: CliRun): Promise<string | null>;
  /** A GET of the forge's API, as the sign-in. */
  api(as: string[], path: string): string[];
  /** Null when the CLI's answer is the forge's success; otherwise the HTTP status it failed with. */
  failed(read: CliResult): number | null;
  /** What the CLI's answer says when it fails, for the person to read. */
  told(read: CliResult): string;
  /** The read that finds the request opened from `branch`, and how its answer names it. */
  view(project: string, branch: string, as: string[]): string[];
  pick(body: unknown, branch: string): { number?: unknown; url?: unknown } | null;
  /** A request's state, merge and head, read by its number. */
  state(project: string, number: number, as: string[]): string[];
  /** Opens the request from `branch` into `target`; the description goes in as `input` when the CLI reads it from stdin. */
  create(project: string, branch: string, target: string, title: string, body: string, assignment: RequestAssignment, as: string[]): { args: string[]; input?: string };
  /** Whether the CLI's answer to `create` names the request it opened; tea's prints the description too, which can link another request. */
  answerNames: boolean;
  /** The forge host a repository's API address is for, as its sign-in names it. */
  hostOf(apiUrl: string): string;
  /** Writes a commit status on `sha`, and nothing else, as the sign-in. */
  writeStatus(project: string, sha: string, check: CommitCheck, as: string[]): { args: string[]; input?: string };
  /** What the CLI cannot give a request as it opens, given after; each refusal comes back as a note beside the opened request. */
  assign?(project: string, number: number, assignment: RequestAssignment, as: string[], run: CliRun): Promise<string[]>;
}

/** The forges whose own CLI a person signs in with; a forge without one is never reached this way. */
export type CliForge = "gitlab" | "github" | "gitea";

/** gh and glab name a host without its port. */
const hostname = (host: string) => host.replace(/:\d+$/, "");

/** A request read back through gh or glab: GitHub's number and url, GitLab's iid and web_url. */
const ownRequest = (body: unknown) => {
  const b = body as { number?: unknown; iid?: unknown; url?: unknown; web_url?: unknown } | null;
  return b && { number: b.number ?? b.iid, url: b.url ?? b.web_url };
};

/** gh and glab: `auth status` says whether the CLI is signed in to the host, by its exit code. */
const authStatus =
  (tool: "gh" | "glab") =>
  async (host: string, run: CliRun): Promise<SignIn> => {
    const status = await run(tool, ["auth", "status", "--hostname", hostname(host)]);
    return { installed: !status.missing, signedIn: !status.missing && status.code === 0, as: ["--hostname", hostname(host)] };
  };

/** gh and glab: `auth git-credential --help` answers when the CLI can be git's credential helper. */
const helpsGit = (tool: "gh" | "glab") => async (run: CliRun) => (await run(tool, ["auth", "git-credential", "--help"])).code === 0;

/** gh and glab: the account is the forge's user, read through the CLI's own API call. */
const userField =
  (tool: "gh" | "glab", field: "login" | "username") =>
  async (_host: string, signIn: SignIn, run: CliRun): Promise<string | null> => {
    const read = await run(tool, ["api", ...signIn.as, "user"]);
    if (read.code !== 0) return null;
    const login = String((parsed(read.stdout) as Record<string, unknown> | null)?.[field] ?? "");
    return LOGIN.test(login) ? login : null;
  };

/** gh and glab say why they failed on stderr, and some only on stdout. */
const stderrFirst = (read: CliResult) => read.stderr || read.stdout;

/** gh and glab fail with a nonzero exit, and say the HTTP status in their stderr when the forge refused. */
const exitFailed = (read: CliResult) => (read.code === 0 ? null : Number(/HTTP (\d{3})/.exec(read.stderr)?.[1] ?? 502));

/** The reviewers, labels and assignee gh and glab take as flags. */
const assignmentFlags = (a: RequestAssignment) => [...a.reviewers.flatMap((r) => ["--reviewer", r]), ...a.labels.flatMap((l) => ["--label", l]), ...(a.assignee ? ["--assignee", a.assignee] : [])];

/**
 * tea from 0.15.0, the first that opens a pull request outside a checkout. tea has no sign-in per
 * host: without a login named it uses its default one, whatever host that is for, so every call
 * names the one login whose address is the repository's host, port included, as its credential
 * helper picks one. `tea api` answers 0 for a 4xx or 5xx, so its status line is read instead.
 */
const TEA_SINCE = "0.15.0";

const TEA_STATUS = /^HTTP\/\S+ (\d{3})\b/m;

const teaLogins = (text: string): { name: string; url: string; user: string }[] => {
  try {
    const rows: unknown = JSON.parse(text);
    if (!Array.isArray(rows)) return [];
    // Read whatever case the keys are in: tea 0.16 writes them snake_case, earlier versions as the table's headers.
    const field = (row: Record<string, unknown>, key: string) => String(Object.entries(row).find(([k]) => k.toLowerCase() === key)?.[1] ?? "");
    return rows.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object").map((r) => ({ name: field(r, "name"), url: field(r, "url"), user: field(r, "user") }));
  } catch {
    return [];
  }
};

const TOOLS: Record<CliForge, Tool> = {
  github: {
    tool: "gh",
    name: "GitHub's gh",
    helper: "!gh auth git-credential",
    install: "https://cli.github.com",
    login: (host) => `gh auth login --hostname ${hostname(host)}`,
    signIn: authStatus("gh"),
    helps: helpsGit("gh"),
    account: userField("gh", "login"),
    api: (as, path) => ["api", ...as, path],
    failed: exitFailed,
    told: stderrFirst,
    answerNames: true,
    view: (project, branch) => ["pr", "view", branch, "--repo", project, "--json", "number,url"],
    pick: ownRequest,
    state: (project, number) => ["pr", "view", String(number), "--repo", project, "--json", "state,mergedAt,headRefOid"],
    create: (project, branch, target, title, body, assignment) => ({ args: ["pr", "create", "--repo", project, "--head", branch, "--base", target, "--title", title, "--body-file", "-", ...assignmentFlags(assignment)], input: body }),
    // GitHub's own API is on api.github.com; an Enterprise server's is beside it.
    hostOf: (apiUrl) => (new URL(apiUrl).host === "api.github.com" ? "github.com" : new URL(apiUrl).host),
    writeStatus: (project, sha, check, as) => ({ args: ["api", ...as, "-X", "POST", "-f", `state=${check.state}`, "-f", `context=${check.context}`, "-f", `description=${check.description}`, `repos/${project}/statuses/${sha}`] }),
  },
  gitlab: {
    tool: "glab",
    name: "GitLab's glab",
    helper: "!glab auth git-credential",
    install: "https://gitlab.com/gitlab-org/cli",
    login: (host) => `glab auth login --hostname ${hostname(host)}`,
    signIn: authStatus("glab"),
    helps: helpsGit("glab"),
    account: userField("glab", "username"),
    api: (as, path) => ["api", ...as, path],
    failed: exitFailed,
    told: stderrFirst,
    answerNames: true,
    view: (project, branch) => ["mr", "view", branch, "--repo", project, "--output", "json"],
    pick: ownRequest,
    state: (project, number) => ["mr", "view", String(number), "--repo", project, "--output", "json"],
    create: (project, branch, target, title, body, assignment) => ({ args: ["mr", "create", "--repo", project, "--source-branch", branch, "--target-branch", target, "--title", title, "--description", body, "--remove-source-branch", "--yes", ...assignmentFlags(assignment)] }),
    hostOf: (apiUrl) => new URL(apiUrl).host,
    // GitLab names a failed check "failed", and a check with no verdict is one too, as its driver writes it.
    writeStatus: (project, sha, check, as) => ({
      args: ["api", ...as, "-X", "POST", "-f", `state=${check.state === "failure" || check.state === "error" ? "failed" : check.state}`, "-f", `name=${check.context}`, "-f", `description=${check.description}`, `projects/${encodeURIComponent(project)}/statuses/${sha}`],
    }),
  },
  gitea: {
    tool: "tea",
    name: "Gitea's tea",
    helper: "!tea login helper",
    install: "https://gitea.com/gitea/tea",
    login: (host) => `tea login add --url https://${host}`,
    async signIn(host, run) {
      const listed = await run("tea", ["login", "list", "--output", "json"]);
      if (listed.missing) return { installed: false, signedIn: false, as: [] };
      const version = await versionOf("tea", run);
      if (!version || !atLeast(version, TEA_SINCE)) return { installed: true, signedIn: false, as: [], problem: `your tea is ${version ?? "of a version it does not say"}; the orchestrator needs ${TEA_SINCE} or later, update it (https://gitea.com/gitea/tea)` };
      const here = listed.code === 0 ? teaLogins(listed.stdout).filter((l) => URL.canParse(l.url) && new URL(l.url).host === host) : [];
      if (here.length > 1) return { installed: true, signedIn: false, as: [], problem: `tea holds ${here.length} logins for ${host} (${here.map((l) => l.name).join(", ")}); keep one with \`tea login delete <name>\`, then try again` };
      const one = here[0];
      return one ? { installed: true, signedIn: true, as: [`--login=${one.name}`], account: LOGIN.test(one.user) ? one.user : null } : { installed: true, signedIn: false, as: [] };
    },
    helps: async (_run, version) => {
      const v = await version;
      return v !== null && atLeast(v, "0.10.1");
    },
    account: async (_host, signIn) => signIn.account ?? null,
    api: (as, path) => ["api", "-i", ...as, path],
    failed(read) {
      const status = Number(TEA_STATUS.exec(read.stderr)?.[1] ?? 0);
      if (read.code === 0 && status >= 200 && status < 300) return null;
      return status >= 400 ? status : 502;
    },
    // With -i tea writes every response header to stderr; only the status line and the forge's answer are said.
    told: (read) => [TEA_STATUS.exec(read.stderr)?.[0], read.stdout].filter(Boolean).join(" ") || read.stderr,
    answerNames: false,
    view: (project, _branch, as) => ["api", "-i", ...as, `repos/${project}/pulls?state=open&limit=50`],
    pick(body, branch) {
      const pulls = Array.isArray(body) ? (body as { number?: unknown; html_url?: unknown; head?: { ref?: unknown } }[]) : [];
      const pull = pulls.find((p) => p?.head?.ref === branch);
      return pull ? { number: pull.number, url: pull.html_url } : null;
    },
    state: (project, number, as) => ["api", "-i", ...as, `repos/${project}/pulls/${number}`],
    create: (project, branch, target, title, body, assignment, as) => ({
      args: ["pulls", "create", ...as, "--repo", project, "--head", branch, "--base", target, "--title", title, "--description-file", "-", ...(assignment.labels.length ? ["--labels", assignment.labels.join(",")] : []), ...(assignment.assignee ? ["--assignees", assignment.assignee] : [])],
      input: body,
    }),
    hostOf: (apiUrl) => new URL(apiUrl).host,
    writeStatus: (project, sha, check, as) => ({ args: ["api", "-i", ...as, "-X", "POST", "-d", "@-", `repos/${project}/statuses/${sha}`], input: JSON.stringify({ state: check.state, context: check.context, description: check.description }) }),
    // tea opens a pull request with no reviewers, so they are asked for after, as the person.
    async assign(project, number, assignment, as, run) {
      if (!assignment.reviewers.length) return [];
      const asked = await run("tea", ["api", "-i", ...as, "-X", "POST", "-d", "@-", `repos/${project}/pulls/${number}/requested_reviewers`], JSON.stringify({ reviewers: assignment.reviewers }));
      return TOOLS.gitea.failed(asked) === null ? [] : [`reviewers were not added: ${said(asked.stdout || asked.stderr)}`];
    },
  },
};

export function hasOwnCli(kind: unknown): kind is CliForge {
  return typeof kind === "string" && Object.hasOwn(TOOLS, kind);
}

/** A repository's forge settings when its forge has a CLI of its own, typed so; null otherwise. */
export function cliConfig(config: ForgeConfig | null): (ForgeConfig & { kind: CliForge }) | null {
  return config && hasOwnCli(config.kind) ? { ...config, kind: config.kind } : null;
}

/** Whether the person's own CLI for a forge is here and signed in to a host, with what to run next when it is not; nothing is read but the CLI's answer. */
export interface OwnCliStatus {
  tool: CliTool;
  name: string;
  host: string;
  installed: boolean;
  signedIn: boolean;
  /** The login the CLI is signed in to the host as, when signed in; never its email or token. */
  account: string | null;
  /** The CLI's version as it reports it, for the person to read; null when it is not installed or does not say. */
  version: string | null;
  /** Whether this CLI hands git the person's sign-in, which every fetch and push through it needs. */
  helper: boolean;
  install: string;
  login: string;
}

/**
 * The CLI's state as the Integrations card shows it: whether it is here and signed in, its version
 * and whether it can be git's credential helper, read side by side, then the account it is signed
 * in as. What an older gh or glab lacks is asked of it; tea says it only in its version.
 */
export async function ownCliStatus(kind: CliForge, host: string, run: CliRun = runOwnCli): Promise<OwnCliStatus> {
  const t = TOOLS[kind];
  const asked = versionOf(t.tool, run);
  const [signIn, version, helps] = await Promise.all([t.signIn(host, run), asked, t.helps(run, asked)]);
  const helper = signIn.installed && helps;
  return { tool: t.tool, name: t.name, host, installed: signIn.installed, signedIn: signIn.signedIn, account: signIn.signedIn ? await t.account(host, signIn, run) : null, version, helper, install: t.install, login: t.login(host) };
}

const VERSION = /\b(\d+\.\d+\.\d+)\b/;

/** The version the CLI says, with the terminal colours tea writes even into a pipe taken out first. */
async function versionOf(tool: CliTool, run: CliRun): Promise<string | null> {
  const ran = await run(tool, ["--version"]);
  return ran.code === 0 ? (VERSION.exec(ran.stdout.replace(/\x1b\[[0-9;]*m/g, ""))?.[1] ?? null) : null;
}

function atLeast(version: string, since: string): boolean {
  const [a, b] = [version, since].map((v) => v.split(".").map(Number));
  for (let n = 0; n < 3; n++) if (a![n] !== b![n]) return a![n]! > b![n]!;
  return true;
}

/** How an older CLI says it does not know a flag or command the orchestrator uses. */
const TOO_OLD = /unknown (flag|command|shorthand flag)|flag provided but not defined|unknown json field|accepts at most/i;

/** What the CLI said when it refused, or, when it is too old for what was asked, to update it. */
function cliSaid(t: Tool, ran: CliResult): string {
  const told = t.told(ran);
  return TOO_OLD.test(told) ? `your ${t.tool} does not know what the orchestrator asks of it; update it (${t.install}), then try again` : said(told);
}

/** A forge login as the forges allow one: letters, digits and . _ - alone, so nothing but a name reaches the screen. */
export const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A refusal the person fixes on their own machine: install the CLI, or sign in with it. */
export class OwnCliRefused extends OrchestratorError {
  constructor(message: string) {
    super("own-cli", message, 409);
  }
}

/** The person's sign-in to `host` through their CLI, refused unless it is installed and signed in there, saying which command fixes it. */
async function signedIn(kind: CliForge, host: string, run: CliRun): Promise<SignIn> {
  const t = TOOLS[kind];
  const signIn = await t.signIn(host, run);
  if (!signIn.installed) throw new OwnCliRefused(`${t.name} is not installed on this machine; install it (${t.install}), then sign in with \`${t.login(host)}\``);
  if (signIn.problem) throw new OwnCliRefused(signIn.problem);
  if (!signIn.signedIn) throw new OwnCliRefused(`${t.name} is not signed in to ${host}; sign in with \`${t.login(host)}\`, then try again`);
  return signIn;
}

/** Refuses unless the person's CLI is installed and signed in to `host`, with its port, saying which command fixes it. */
export async function ownCliReady(kind: CliForge, host: string, run: CliRun = runOwnCli): Promise<void> {
  await signedIn(kind, host, run);
}

export const said = (text: string) => redactLine(text.replace(/\p{C}+/gu, " ").trim().slice(0, 300));

/**
 * The forge's REST API read as the person, through `gh api`, `glab api` or `tea api`: a GET alone,
 * for the orchestrator on the person's own machine to check what a runner reports when it holds no
 * token of its own. The sign-in stays with the CLI, as when it opens a request.
 */
export function ownCliReader(kind: CliForge, host: string, run: CliRun = runOwnCli): ForgeHttp {
  const t = TOOLS[kind];
  return {
    async request<T>(method: string, path: string): Promise<T> {
      if (method !== "GET") throw new OwnCliRefused(`the orchestrator reads with your ${t.tool} sign-in alone`);
      const { as } = await signedIn(kind, host, run);
      const read = await run(t.tool, t.api(as, path.replace(/^\/+/, "")));
      const status = t.failed(read);
      if (status !== null) throw new ForgeHttpError(`${t.tool} did not read it: ${cliSaid(t, read)}`, status);
      const body = parsed(read.stdout);
      if (!body) throw new ForgeHttpError(`${t.tool} answered with something other than JSON; update it (${t.install}), then try again`, 502);
      return body as T;
    },
  };
}

/**
 * A read of GitHub's GraphQL API as the person, through `gh api graphql`: what REST does not say,
 * such as a GitHub Project's Status field. Only a query goes: a document that does not start as one,
 * or names a mutation or a subscription anywhere, even in a comment, is refused before gh runs.
 * A string goes as `-f`, which gh never reads a file for; a value starting with @ is refused.
 */
export async function ownCliGraphQL<T>(host: string, query: string, variables: Record<string, string | number | boolean> = {}, run: CliRun = runOwnCli): Promise<T> {
  const t = TOOLS.github;
  const doc = query.trim();
  if (!/^(query\b|\{)/.test(doc) || /\b(mutation|subscription)\b/i.test(doc)) throw new OwnCliRefused("the orchestrator reads with your gh sign-in alone, and sends only a query");
  const fields = Object.entries(variables).flatMap(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new OwnCliRefused(`${name} is not a GraphQL variable name`);
    if (typeof value === "string") {
      if (value.startsWith("@")) throw new OwnCliRefused(`the value of ${name} starts with @, which gh reads as a file`);
      return ["-f", `${name}=${value}`];
    }
    return ["-F", `${name}=${value}`];
  });
  const { as } = await signedIn("github", host, run);
  const read = await run(t.tool, ["api", ...as, "graphql", "-f", `query=${doc}`, ...fields]);
  const status = t.failed(read);
  if (status !== null) throw new ForgeHttpError(`gh did not read it: ${cliSaid(t, read)}`, status);
  const body = parsed(read.stdout) as { data?: T } | null;
  if (!body?.data) throw new ForgeHttpError("gh answered with something other than GraphQL data; update it (https://cli.github.com), then try again", 502);
  return body.data;
}

/** The git settings, as GIT_CONFIG_* variables, that make git ask the person's CLI for credentials, and only it: any helper set before is cleared. */
export function ownCredentialConfig(kind: CliForge): [string, string][] {
  return [["credential.helper", ""], ["credential.helper", TOOLS[kind].helper]];
}

/**
 * `gitEnv` gives git's settings for reaching the repository - the address the orchestrator judged
 * pinned, redirects off, the CLI as the only credential helper - the same a fetch gets.
 */
export function createOwnCliForge(config: ForgeConfig & { kind: CliForge }, workRoot: string, mirror: (repo: RepoRecord) => string, gitEnv: (repo: RepoRecord) => Promise<Record<string, string> | null>, run: CliRun = runOwnCli): ForgeProvider {
  const kind = config.kind;
  const t = TOOLS[kind];

  const REQUEST_URL = /https?:\/\/\S+\/(?:pull|-\/merge_requests)\/(\d+)/;
  const NO_ASSIGNMENT: RequestAssignment = { reviewers: [], labels: [] };
  /** The orchestrator's own check names, the only ones written as the person. */
  const OWN_CHECK = /^teamhandbook\/[a-z][a-z-]{0,39}$/;

  /** The request the CLI just opened for `branch`, read back when its answer does not name it. */
  const openedFor = async (branch: string, as: string[]): Promise<{ number: number; url: string } | null> => {
    const read = await run(t.tool, t.view(config.project, branch, as));
    if (t.failed(read) !== null) return null;
    const found = t.pick(parsed(read.stdout), branch);
    const number = Number(found?.number);
    const url = String(found?.url ?? "");
    return Number.isInteger(number) && number > 0 && /^https?:\/\//.test(url) ? { number, url } : null;
  };

  /** The CLI asked to open the request from `branch`, already on the forge, into `target`. */
  const createRequest = (branch: string, target: string, title: string, body: string, assignment: RequestAssignment, as: string[]) => {
    const { args, input } = t.create(config.project, branch, target, title, body, assignment, as);
    return run(t.tool, args, input);
  };

  /** The number and address of the request the CLI opened, from its answer or read back by branch, with what was refused it after it opened. */
  const opened = async (repo: RepoRecord, answer: CliResult, branch: string, assignment: RequestAssignment, as: string[]): Promise<{ number: number; url: string; notes?: string[] }> => {
    const url = t.answerNames ? (REQUEST_URL.exec(answer.stdout) ?? REQUEST_URL.exec(answer.stderr)) : null;
    const found = url ? { number: Number(url[1]), url: url[0] } : await openedFor(branch, as);
    if (!found) throw new OwnCliRefused(`${t.tool} opened a request for ${branch} in ${repo.name}, but its number was not read; find it among ${repo.name}'s requests on ${FORGES[kind].label}`);
    const notes = t.assign ? await t.assign(config.project, found.number, assignment, as, run) : [];
    return { ...found, ...(notes.length ? { notes } : {}) };
  };

  const targetOf = async (repo: RepoRecord) => ((await gitAsyncMaybe(["symbolic-ref", "--short", "HEAD"], mirror(repo))) ?? "").trim() || "main";

  return {
    kind,
    async open(repo: RepoRecord, change: ChangeRequest): Promise<OpenedRequest> {
      checkBranch(change.branch);
      const { as } = await signedIn(kind, new URL(repo.url).host, run);
      const target = await targetOf(repo);
      const work = await scratch(workRoot, "own-cli-");
      try {
        const headSha = await changeCommit(mirror(repo), work, change, repo.name);
        const env = await gitEnv(repo);
        if (!env) throw new OwnCliRefused(`${repo.name} is not connected to reach with your ${t.tool} sign-in; connect it again under Projects with the token left empty`);
        const taken = await gitAsyncMaybe(["ls-remote", "--heads", repo.url, change.branch], work, { env });
        if (taken === null) throw new OwnCliRefused(`git did not reach ${repo.name} with your ${t.tool} sign-in; check it with \`${t.tool} auth status\``);
        if (taken.trim()) throw new ForgeRefusal(`branch ${change.branch} already exists in ${repo.name}; remove it on ${FORGES[kind].label}, then try again`);
        // No force: a branch someone pushed meanwhile makes git refuse rather than lose their commit.
        await gitAsync(["push", "--porcelain", repo.url, `${headSha}:refs/heads/${change.branch}`], work, undefined, undefined, { env }).catch((err: Error & { stderr?: string }) => {
          throw new OwnCliRefused(`git did not push ${change.branch} to ${repo.name} with your ${t.tool} sign-in: ${said(err.stderr || err.message)}; check it with \`${t.tool} auth status\`, then try again`);
        });

        const assignment = change.assignment ?? NO_ASSIGNMENT;
        const answer = await createRequest(change.branch, target, change.title, change.body, assignment, as);
        if (answer.code !== 0) {
          // No request names the branch, so it is taken back; a retry then starts clean.
          const left = await gitAsync(["push", "--porcelain", repo.url, `:refs/heads/${change.branch}`], work, undefined, undefined, { env }).then(
            () => "the branch was removed again",
            () => `the branch stayed: ${change.branch}`,
          );
          throw new OwnCliRefused(`${t.tool} did not open the request: ${cliSaid(t, answer)}; ${left}; check it with \`${t.tool} auth status\`, then try again`);
        }
        // A request that opened keeps its branch, even when the CLI's answer is not the one expected:
        // taking the branch back would close the request just opened.
        return { ...(await opened(repo, answer, change.branch, assignment, as)), branch: change.branch, headSha };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },

    // The branch as the forge holds it now, read with the person's sign-in; the push goes without
    // force, so a branch someone moved meanwhile makes git refuse rather than lose their commit.
    async updateBranch(repo: RepoRecord, branch: string, update: BranchUpdate): Promise<{ headSha: string }> {
      checkBranch(branch);
      await ownCliReady(kind, new URL(repo.url).host, run);
      const env = await gitEnv(repo);
      if (!env) throw new OwnCliRefused(`${repo.name} is not connected to reach with your ${t.tool} sign-in; connect it again under Projects with the token left empty`);
      const work = await scratch(workRoot, "own-cli-update-");
      try {
        if ((await gitAsyncMaybe(["fetch", "--quiet", repo.url, `refs/heads/${branch}:refs/orchestrator/branch`], work, { env })) === null) {
          throw new ForgeRefusal(`branch ${branch} was not read from ${repo.name}; check it is on ${FORGES[kind].label}, then check your sign-in with \`${t.tool} auth status\``);
        }
        const head = (await gitAsync(["rev-parse", "refs/orchestrator/branch"], work)).trim();
        if (head !== update.expectedHead) throw new ForgeRefusal(`${branch} moved since the change was prepared; read the request again`);
        const headSha = await changeCommit(work, work, { title: update.title, body: "", commitBody: update.commitBody ?? "", branch, baseSha: head, files: update.files, author: update.author }, repo.name);
        await gitAsync(["push", "--porcelain", repo.url, `${headSha}:refs/heads/${branch}`], work, undefined, undefined, { env }).catch((err: Error & { stderr?: string }) => {
          const told = err.stderr || err.message;
          if (/non-fast-forward|fetch first|\[rejected\]/.test(told)) throw new ForgeRefusal(`${branch} moved since the change was prepared; read the request again`);
          throw new OwnCliRefused(`git did not push ${branch} to ${repo.name} with your ${t.tool} sign-in: ${said(told)}; check it with \`${t.tool} auth status\`, then try again`);
        });
        return { headSha };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },

    // The branch is the person's own work, pushed by their runner: it is read, never written or taken back.
    async openForBranch(repo: RepoRecord, pushed: PushedBranch): Promise<OpenedRequest> {
      checkBranch(pushed.branch);
      const { as } = await signedIn(kind, new URL(repo.url).host, run);
      const env = await gitEnv(repo);
      if (!env) throw new OwnCliRefused(`${repo.name} is not connected to reach with your ${t.tool} sign-in; connect it again under Projects with the token left empty`);
      const heads = await gitAsyncMaybe(["ls-remote", "--heads", repo.url, `refs/heads/${pushed.branch}`], tmpdir(), { env });
      if (heads === null) throw new OwnCliRefused(`git did not reach ${repo.name} with your ${t.tool} sign-in; check it with \`${t.tool} auth status\``);
      const headSha = /^([0-9a-f]{40})\s/.exec(heads)?.[1];
      if (!headSha) throw new ForgeRefusal(`branch ${pushed.branch} is not in ${repo.name}; the runner pushes it first`);
      const assignment = pushed.assignment ?? NO_ASSIGNMENT;
      const answer = await createRequest(pushed.branch, pushed.target ?? (await targetOf(repo)), pushed.title, pushed.body, assignment, as);
      if (answer.code !== 0) throw new OwnCliRefused(`${t.tool} did not open the request: ${cliSaid(t, answer)}; the branch stays as it was pushed, so open it again once \`${t.tool} auth status\` says you are signed in`);
      return { ...(await opened(repo, answer, pushed.branch, assignment, as)), branch: pushed.branch, headSha };
    },

    // A commit status alone, in the orchestrator's own checks: a comment, a label or a merge is never written with the person's sign-in.
    async setCommitStatus(sha: string, check: CommitCheck): Promise<void> {
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("a commit status is set on a full commit id");
      if (!OWN_CHECK.test(check.context)) throw new Error(`${check.context} is not one of the orchestrator's own checks`);
      const { as } = await signedIn(kind, t.hostOf(config.apiUrl), run);
      const { args, input } = t.writeStatus(config.project, sha, { ...check, description: check.description.slice(0, 140) }, as);
      const wrote = await run(t.tool, args, input);
      if (t.failed(wrote) !== null) throw new OwnCliRefused(`${t.tool} did not write the ${check.context} check on ${sha.slice(0, 7)}: ${cliSaid(t, wrote)}`);
    },

    async status(repo: RepoRecord, number: number): Promise<ForgeState> {
      const { as } = await signedIn(kind, new URL(repo.url).host, run);
      const read = await run(t.tool, t.state(config.project, number, as));
      if (t.failed(read) !== null) throw new OwnCliRefused(`${t.tool} did not read request ${number}: ${cliSaid(t, read)}`);
      const body = parsed(read.stdout) as { state?: unknown; merged?: unknown; mergedAt?: unknown; merged_at?: unknown; headRefOid?: unknown; sha?: unknown; head?: { sha?: unknown } } | null;
      if (!body) throw new OwnCliRefused(`${t.tool} answered request ${number}'s state with something other than JSON; update it (${t.install}), then try again`);
      const state = String(body.state ?? "").toLowerCase();
      const head = body.headRefOid ?? body.sha ?? body.head?.sha;
      // Gitea says a merged request is closed, and merged beside it.
      if (state === "merged" || body.merged === true) return forgeState("merged", forgeTime(body.mergedAt ?? body.merged_at), head);
      return forgeState(state === "open" || state === "opened" ? "open" : "closed", null, head);
    },
  };
}

function parsed(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}
