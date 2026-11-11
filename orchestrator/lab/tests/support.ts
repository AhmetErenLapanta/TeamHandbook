import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { orchestratorBuildAt as buildAt } from "../build-at.js";
import { OrchestratorClient } from "../client.js";
import { addMarketplace, createMachine, joinTeam, machineOf } from "../machine.js";
import type { Machine } from "../machine.js";
import { commitOnBranch, commitOnDefault as commitFiles } from "../repos.js";
import { labEnv, labGit, labGitMaybe } from "../run.js";
import { ownerKey, readLab, stateFile, userOf } from "../state.js";
import type { LabOrg, LabRepo } from "../state.js";

/** The running lab. Read once per worker; `npm run lab` writes it. */
export const lab = readLab();

/** The three stand-in organizations; an extra one is read only where its repositories are not changed. */
export const builtIn = lab.orgs.filter((o) => !o.extra && !o.fixture);

/** An organization's name in a test title: an extra one's own name never appears in one. */
export function orgLabel(org: LabOrg): string {
  return org.extra ? `extra organization ${lab.orgs.filter((o) => o.extra).indexOf(org) + 1}` : org.name;
}

const sessions = new Map<string, Promise<OrchestratorClient>>();

/** The organization's person, signed in to its orchestrator. */
export function as(org: LabOrg, key: string): Promise<OrchestratorClient> {
  const id = `${org.name}/${key}`;
  if (!sessions.has(id)) sessions.set(id, OrchestratorClient.signIn(org.url, userOf(org, key).email, lab.password));
  return sessions.get(id)!;
}

export function ownerOf(org: LabOrg, repo: LabRepo): Promise<OrchestratorClient> {
  return as(org, ownerKey(repo.team));
}

/** Who merges or closes on the orchestrator: the team's owner, or an admin for a team the lab gives no owner. */
function reviewerOf(org: LabOrg, repo: LabRepo): Promise<OrchestratorClient> {
  return org.users.some((u) => u.key === ownerKey(repo.team)) ? ownerOf(org, repo) : as(org, "org-admin");
}

export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export async function headOf(org: LabOrg, repo: LabRepo): Promise<string> {
  const { repos } = await (await as(org, "admin")).ok<{ repos: { id: string; head: string }[] }>("GET", "/api/repos");
  return repos.find((r) => r.id === repo.id)!.head;
}

export interface OpenedRequest {
  number: number;
  branch: string;
  title: string;
  url: string;
  status: string;
  notes?: string[];
}

/**
 * The branch the orchestrator proposes, with the ticket filled in where the team's example leaves
 * one to the person, as someone on the screen would: the example's own key with another number.
 */
export function filledBranch(repo: LabRepo, proposed: string): string {
  const key = /^([A-Z][A-Z0-9]*)-\d+/.exec(repo.branchExample ?? "")?.[1] ?? "LAB";
  return proposed.replace("<TICKET>", `${key}-${100 + Math.floor(Math.random() * 900)}`);
}

/** A change proposed through the orchestrator as `client`, against the head the orchestrator holds now, on the branch it proposes. */
export async function propose(client: OrchestratorClient, org: LabOrg, repo: LabRepo, change: unknown, message: string): Promise<{ status: number; request?: OpenedRequest; error?: string }> {
  const proposal = await client.call<{ branch?: string; error?: string }>("POST", `/api/repos/${repo.id}/changes/proposal`, { change });
  if (proposal.status !== 200) return { status: proposal.status, ...(proposal.json.error ? { error: proposal.json.error } : {}) };
  const reply = await client.call<{ request?: OpenedRequest; error?: string }>("POST", `/api/repos/${repo.id}/changes`, { baseSha: await headOf(org, repo), change, message, branch: filledBranch(repo, proposal.json.branch!) });
  return { status: reply.status, ...reply.json };
}

/**
 * A usage request - asking the team to report skill use, giving it a new address, or stopping -
 * with the message and branch the orchestrator proposes, as the screen sends it.
 */
export async function proposeUsage(client: OrchestratorClient, org: LabOrg, repo: LabRepo, action: "ask" | "rotate" | "stop" = "ask"): Promise<{ status: number; request?: OpenedRequest & { branch: string }; error?: string }> {
  const proposal = await client.ok<{ proposal: string; branch: string }>("POST", `/api/repos/${repo.id}/usage/proposal`, { action });
  const reply = await client.call<{ request?: OpenedRequest; error?: string }>("POST", `/api/repos/${repo.id}/usage/propose`, { action, baseSha: await headOf(org, repo), message: proposal.proposal, branch: filledBranch(repo, proposal.branch) });
  return { status: reply.status, ...reply.json };
}

/** A file of the team repository at a branch or commit, as the forge holds it. */
export function fileAt(repo: LabRepo, ref: string, path: string): string | null {
  return labGitMaybe(lab.path, ["show", `${ref}:${path}`], repo.bare);
}

export function commitOf(repo: LabRepo, ref: string, format: string): string {
  return labGit(lab.path, ["log", "-1", `--format=${format}`, ref], repo.bare);
}

export function defaultHead(repo: LabRepo): string {
  return labGit(lab.path, ["rev-parse", "HEAD"], repo.bare);
}

/** The request as the hosted forge records it, in one shape for GitLab and GitHub. */
export async function onForge(repo: LabRepo, number: number): Promise<{ state: string; source: string; labels: string[]; reviewers: string[]; assignees: string[] }> {
  if (repo.forge === "gitlab") {
    const mr = (await forgeCall(repo, "GET", `/projects/${encodeURIComponent(repo.project!)}/merge_requests/${number}`)) as {
      state: string;
      source_branch: string;
      labels: string[];
      reviewers: { username: string }[];
      assignee: { username: string } | null;
    };
    return { state: mr.state, source: mr.source_branch, labels: mr.labels, reviewers: mr.reviewers.map((r) => r.username), assignees: mr.assignee ? [mr.assignee.username] : [] };
  }
  const pull = (await forgeCall(repo, "GET", `/repos/${repo.project}/pulls/${number}`)) as {
    state: string;
    merged: boolean;
    head: { ref: string };
    labels: { name: string }[];
    requested_reviewers: { login: string }[];
    assignees: { login: string }[];
  };
  return { state: pull.merged ? "merged" : pull.state === "open" ? "opened" : "closed", source: pull.head.ref, labels: pull.labels.map((l) => l.name), reviewers: pull.requested_reviewers.map((r) => r.login), assignees: pull.assignees.map((a) => a.login) };
}

/** A request's description as its forge keeps it: a git note beside the branch on the local forge. */
export async function descriptionOf(repo: LabRepo, number: number, branch: string): Promise<string> {
  if (repo.forge === "local") return labGit(lab.path, ["notes", "--ref", `refs/notes/orchestrator/${branch}`, "show", `refs/heads/${branch}`], repo.bare);
  if (repo.forge === "gitlab") return ((await forgeCall(repo, "GET", `/projects/${encodeURIComponent(repo.project!)}/merge_requests/${number}`)) as { description: string }).description;
  return ((await forgeCall(repo, "GET", `/repos/${repo.project}/pulls/${number}`)) as { body: string }).body;
}

export async function forgeCall(repo: LabRepo, method: string, path: string, body?: unknown, user?: string): Promise<unknown> {
  const forge = lab.forges.find((f) => f.kind === repo.forge)!;
  const auth: Record<string, string> = repo.forge === "gitlab" ? { "private-token": forge.token } : { authorization: `Bearer ${forge.token}` };
  const res = await fetch(`${forge.api}${path}`, {
    method,
    headers: { ...auth, ...(user ? { "x-lab-user": user } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`the lab's ${repo.forge} answered ${res.status} on ${method} ${path}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/**
 * A person merging the request where it lives: on the orchestrator for the local forge, on the
 * forge itself for GitLab and GitHub, after which the orchestrator reads the decision back with
 * Refresh, as a person on the repository's screen would.
 */
export async function merge(org: LabOrg, repo: LabRepo, number: number): Promise<void> {
  const owner = await reviewerOf(org, repo);
  if (repo.forge === "local") {
    await owner.ok("POST", `/api/repos/${repo.id}/requests/${number}/merge`);
    return;
  }
  if (repo.forge === "gitlab") await forgeCall(repo, "PUT", `/projects/${encodeURIComponent(repo.project!)}/merge_requests/${number}/merge`, {});
  else await forgeCall(repo, "PUT", `/repos/${repo.project}/pulls/${number}/merge`, {});
  await owner.ok("POST", `/api/repos/${repo.id}/requests/${number}/refresh`);
}

/** Closing a request the test opened only to look at it, so it never holds a later test's merge back. */
export async function close(org: LabOrg, repo: LabRepo, number: number): Promise<void> {
  const owner = await reviewerOf(org, repo);
  if (repo.forge === "local") {
    await owner.ok("POST", `/api/repos/${repo.id}/requests/${number}/close`);
    return;
  }
  if (repo.forge === "gitlab") await forgeCall(repo, "PUT", `/projects/${encodeURIComponent(repo.project!)}/merge_requests/${number}`, { state_event: "close" });
  else await forgeCall(repo, "PATCH", `/repos/${repo.project}/pulls/${number}`, { state: "closed" });
  await owner.ok("POST", `/api/repos/${repo.id}/requests/${number}/refresh`);
}

export function pluginName(repo: LabRepo): string {
  return JSON.parse(fileAt(repo, "HEAD", ".claude-plugin/plugin.json") ?? "{}").name as string;
}

/** A change a teammate merged on the forge, outside the orchestrator: one commit on the default branch. */
export function commitOnDefault(repo: LabRepo, files: Record<string, string | null>, subject: string): void {
  commitFiles(lab.path, repo.bare, files, subject, { name: "Lab Teammate", email: "teammate@lab.example.invalid" }, lab.dir);
}

/** `files` changed on the default branch while `check` runs, then put back by a second commit; the orchestrator syncs after each. */
export async function whileChanged(org: LabOrg, repo: LabRepo, files: Record<string, string | null>, check: () => Promise<void>): Promise<void> {
  const before = Object.fromEntries(Object.keys(files).map((path) => [path, fileAt(repo, "HEAD", path)]));
  const admin = await as(org, "admin");
  commitOnDefault(repo, files, "A teammate's change");
  await admin.ok("POST", `/api/repos/${repo.id}/sync`);
  try {
    await check();
  } finally {
    commitOnDefault(repo, before, "Put the teammate's change back");
    await admin.ok("POST", `/api/repos/${repo.id}/sync`);
  }
}

export interface ShownTask {
  id: string;
  title: string;
  status: string;
  agent: string;
  requestNumber: number | null;
  error: string | null;
  request: { status: string; provider: string; branch: string } | null;
}

/** Whether the team's branch rule starts a branch with a ticket that only an issue can give a task. */
export function needsTicket(repo: LabRepo): boolean {
  return /^[A-Z][A-Z0-9]*-\d+/.test(repo.branchExample ?? "") && !/^[A-Z][A-Z0-9]*-\d+$/.test(repo.commitPrefix ?? "");
}

/**
 * A task for the stand-in agent, followed until it waits for review or ends; `extra` adds to
 * what the form sends. On a repository whose branches start with a ticket, the task names an
 * issue, as a person working there would.
 */
export async function runToReview(owner: OrchestratorClient, repo: LabRepo, title: string, extra: Record<string, unknown> = {}): Promise<ShownTask> {
  const key = /^([A-Z][A-Z0-9]*)-/.exec(repo.branchExample ?? "")?.[1];
  const issue = needsTicket(repo) && extra.issueUrl === undefined ? { issueUrl: `https://tracker.example.invalid/browse/${key}-${100 + Math.floor(Math.random() * 900)}` } : {};
  const started = await owner.call<{ task: ShownTask; error?: string }>("POST", "/api/tasks", { title, description: "Add a skill named after this task.", repoId: repo.id, agent: "fake", ...issue, ...extra });
  if (started.status !== 201) throw new Error(`the task was not started: ${started.status} ${started.json.error}`);
  let task = started.json.task;
  for (let i = 0; i < 240 && !["needs-review", "failed", "cancelled"].includes(task.status); i++) {
    await new Promise((r) => setTimeout(r, 250));
    task = (await owner.ok<{ task: ShownTask }>("GET", `/api/tasks/${task.id}`)).task;
  }
  return task;
}

export function pick(orgName: string, repoId: string): { org: LabOrg; repo: LabRepo } {
  const org = lab.orgs.find((o) => o.name === orgName)!;
  return { org, repo: org.repos.find((r) => r.id === repoId)! };
}

/**
 * The four shapes a team repository comes in: a version number, a version by commit, a ticket
 * key in the commit prefix and branch example, and a default branch that is master.
 */
export const SHAPES = [
  { shape: "versioned by number", ...pick("acme", "payments-skills") },
  { shape: "versioned by commit", ...pick("acme", "platform-skills") },
  { shape: "named by ticket key", ...pick("vandelay", "imports-skills") },
  { shape: "on master", ...pick("vandelay", "exports-skills") },
];

/** The repository's teammate, or a new one who joins and adds the marketplace now. */
export function teammateOn(org: LabOrg, repo: LabRepo): Machine {
  const dev = org.developers.find((d) => d.repo === repo.id);
  if (dev) return machineOf(lab, dev);
  const m = machineOf(lab, createMachine(join(org.dir, "devs"), unique("teammate")));
  if (joinTeam(m, repo.url).status !== 0) throw new Error(`a new teammate could not join ${repo.id}`);
  addMarketplace(m);
  return m;
}

/**
 * A teammate's share, opened from their own machine rather than the orchestrator: a branch in the
 * team repository and, on a hosted forge, a request on it under the teammate's login. On the
 * local forge the branch is all a share leaves.
 */
export async function teammateShare(repo: LabRepo, login: string, files: Record<string, string>, subject: string): Promise<{ branch: string; number: number | null }> {
  const branch = `share/${unique(login)}`;
  commitOnBranch(lab.path, repo.bare, branch, files, subject, { name: login, email: `${login}@dev.example.invalid` }, lab.dir);
  if (repo.forge === "local") return { branch, number: null };
  const target = labGit(lab.path, ["symbolic-ref", "--short", "HEAD"], repo.bare);
  const opened =
    repo.forge === "gitlab"
      ? ((await forgeCall(repo, "POST", `/projects/${encodeURIComponent(repo.project!)}/merge_requests`, { source_branch: branch, target_branch: target, title: subject }, login)) as { iid: number }).iid
      : ((await forgeCall(repo, "POST", `/repos/${repo.project}/pulls`, { head: branch, base: target, title: subject }, login)) as { number: number }).number;
  return { branch, number: opened };
}

/** Takes a teammate's share back: closed on a hosted forge, its branch deleted on the local one. */
export async function withdrawShare(repo: LabRepo, share: { branch: string; number: number | null }): Promise<void> {
  if (repo.forge === "local") labGit(lab.path, ["update-ref", "-d", `refs/heads/${share.branch}`], repo.bare);
  else if (repo.forge === "gitlab") await forgeCall(repo, "PUT", `/projects/${encodeURIComponent(repo.project!)}/merge_requests/${share.number}`, { state_event: "close" });
  else await forgeCall(repo, "PATCH", `/repos/${repo.project}/pulls/${share.number}`, { state: "closed" });
}

export interface TenantOrchestrator {
  tenant: string;
  url: string;
  admin: OrchestratorClient;
  stop: () => void;
}

export interface OrchestratorProcess {
  url: string;
  /** Where it writes what it prints. */
  log: string;
  /** Its process, for a signal an operator sends it. */
  pid: number;
  /** Whether it is still running: an orchestrator refusing its configuration stops at start. */
  running: () => boolean;
  /** Stops it with SIGTERM and waits until it has let go of its data directory and its tenant. */
  stop: () => Promise<void>;
}

/** A repository's head once the orchestrator has read it: a change proposed before then answers 409. */
export async function readHead(client: OrchestratorClient, repoId: string): Promise<string> {
  for (let i = 0; i < 480; i++) {
    const head = (await client.ok<{ repos: { id: string; head: string | null }[] }>("GET", "/api/repos")).repos.find((r) => r.id === repoId)?.head;
    if (head) return head;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the orchestrator did not read ${repoId}`);
}

/**
 * The orchestrator each port was last given to and is still serving: a scenario that fails before
 * it stops its own leaves it on the port, where the next scenario's setup would meet it instead.
 */
const onPort = new Map<number, OrchestratorProcess>();

/**
 * One orchestrator process the lab did not start itself: on `dataDir`, serving `tenant`, on SQLite
 * there or on the lab's shared Postgres. `server` is the orchestrator's own build unless a spec
 * hands it another, an older release's say. It connects `repos`, as a configuration file would.
 */
export async function startOrchestratorProcess(options: {
  port: number;
  tenant: string;
  dataDir: string;
  store: "sqlite" | "postgres";
  setupCode: string;
  repos?: { id: string; team: string; url: string }[];
  build?: string;
  /** A Postgres database of its own instead of the lab's shared one. */
  databaseUrl?: string;
  /** Several orgs in place of `tenant` and `repos`; `tenant` then only names the log. */
  orgs?: { tenant: string; repos: { id: string; team: string; url: string }[] }[];
  /** More of the orchestrator's environment. */
  env?: Record<string, string>;
}): Promise<OrchestratorProcess> {
  const left = onPort.get(options.port);
  if (left?.running()) {
    console.warn(`lab: an orchestrator an earlier scenario left on port ${options.port} is stopped first`);
    await left.stop();
  }
  const build = options.build ?? lab.orchestratorDir;
  const dir = dirname(options.dataDir);
  const url = `http://127.0.0.1:${options.port}`;
  for (const sub of ["home", "tmp"]) mkdirSync(join(dir, sub), { recursive: true });
  mkdirSync(options.dataDir, { recursive: true });
  const named = (repos: { id: string; team: string; url: string }[] = []) => repos.map((r) => ({ ...r, name: r.id }));
  const config = options.orgs ? { orgs: options.orgs.map((o) => ({ ...o, repos: named(o.repos) })) } : { tenant: options.tenant, repos: named(options.repos) };
  writeFileSync(join(dir, "orchestrator.json"), JSON.stringify(config) + "\n");
  const log = join(lab.dir, "logs", `orchestrator-${options.tenant}.log`);
  const out = openSync(log, "a");
  const child = spawn("node", [join(build, "dist", "server.js"), lab.dir], {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: build,
    env: labEnv(lab.path, {
      HOME: join(dir, "home"),
      TMPDIR: join(dir, "tmp"),
      ORCHESTRATOR_DATA_DIR: options.dataDir,
      ORCHESTRATOR_CONFIG: join(dir, "orchestrator.json"),
      ORCHESTRATOR_PORT: String(options.port),
      ORCHESTRATOR_PUBLIC_URL: url,
      ORCHESTRATOR_MODE: "self-hosted",
      ORCHESTRATOR_SERVER_TASKS: "1",
      ORCHESTRATOR_AUTH: "local",
      ORCHESTRATOR_SETUP_TOKEN: options.setupCode,
      // One key per data directory, so an orchestrator started again on it opens the tokens it sealed.
      ORCHESTRATOR_SECRET_KEY: createHash("sha256").update(options.dataDir).digest("base64"),
      ORCHESTRATOR_AGENTS: "fake",
      ORCHESTRATOR_WEB_ROOT: join(build, "dist", "web"),
      ...(options.store === "postgres" ? { ORCHESTRATOR_DATABASE_URL: options.databaseUrl ?? lab.postgres!.url } : {}),
      ...options.env,
    }),
  });
  child.unref();
  // Recorded with the lab's own processes, so lab:down stops it even if the spec dies first.
  const state = JSON.parse(readFileSync(stateFile(lab.dir), "utf8"));
  state.processes.push({ name: `orchestrator-${options.tenant}`, pid: child.pid });
  writeFileSync(stateFile(lab.dir), JSON.stringify(state, null, 2) + "\n");
  let running = true;
  const exited = new Promise<void>((resolve) =>
    child.on("exit", () => {
      running = false;
      resolve();
    }),
  );
  for (let i = 0; i < 240 && running && !(await fetch(`${url}/api/health`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 250));
  const started: OrchestratorProcess = {
    url,
    log,
    pid: child.pid!,
    running: () => running,
    stop: async () => {
      if (running) process.kill(child.pid!, "SIGTERM");
      await exited;
    },
  };
  onPort.set(options.port, started);
  return started;
}

/**
 * A second tenant's orchestrator on the lab's shared Postgres, started for one spec: the tenant column
 * is what keeps organizations apart there, and one tenant alone never tests it. `spare` picks one
 * of the two ports `npm run lab` keeps free after the last organization's, so two specs never
 * reach for the same one.
 */
export async function startTenantOrchestrator(spare: 1 | 2, repos: { id: string; team: string; url: string }[] = []): Promise<TenantOrchestrator> {
  if (!lab.postgres) throw new Error("this lab has no Postgres");
  const tenant = unique("shadow");
  const code = unique("shadow-setup");
  const started = await startOrchestratorProcess({ port: spareOrchestratorPort(spare), tenant, dataDir: join(lab.dir, "shadow", tenant, "data"), store: "postgres", setupCode: code, repos });
  const admin = await OrchestratorClient.setup(started.url, code, { email: `admin@${tenant}.example.invalid`, name: "Shadow Admin" }, lab.password);
  return { tenant, url: started.url, admin, stop: () => void started.stop() };
}

/** One of the two ports `npm run lab` keeps free after the last organization's orchestrator. */
export function spareOrchestratorPort(spare: 1 | 2): number {
  return Math.max(...lab.orgs.map((o) => o.port)) + spare;
}

/** The orchestrator as `ref` of this repository built it, in the lab directory, once per ref (lab/build-at.ts). */
export const orchestratorBuildAt = (ref: string): string => buildAt(lab, ref);

/** Signed in as `name`: the account menu of the orchestrator's top bar, or the team sidebar of the shell before it. */
const signedInAs = (page: Page, name: string) => page.getByRole("button", { name: `Account: ${name}` }).or(page.getByRole("navigation", { name: "Teams" }).filter({ hasText: name }));

export async function expectSignedIn(page: Page, name: string): Promise<void> {
  await expect(signedInAs(page, name)).toBeVisible();
}

/** A repository's page, opened by its address, once its heading names it. */
/** A repository's page, on its Overview or on one of its other tabs. */
export async function openRepo(page: Page, org: LabOrg, repoId: string, tab?: "Skills" | "MCP servers" | "Commands" | "Requests" | "Settings"): Promise<void> {
  await page.goto(`${org.url}/#/repo/${repoId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(repoId);
  if (tab) await page.getByRole("navigation", { name: `${repoId} sections` }).getByRole("link", { name: tab, exact: true }).click();
}

/** A task's page, at `/<org>/tasks/<id>` or `#/tasks/<id>` before it; the id is the last part. */
export const TASK_PAGE = /(?:#\/|\/[a-z0-9-]+\/)tasks\/(tsk_[0-9a-z]{26}|[a-f0-9]{12})$/;

/** Signs in on the orchestrator's own page as one of the organization's people. */
export async function signInOnPage(page: Page, org: LabOrg, key: string): Promise<void> {
  const user = userOf(org, key);
  await page.goto(org.url);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(lab.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // The whole suite signs the same people in again and again, past the orchestrator's limit on
  // attempts a minute; the page says so, and one more try after that minute is a person's too.
  const limited = page.getByRole("alert").filter({ hasText: "too many attempts; wait a minute" });
  await expect(signedInAs(page, user.name).or(limited)).toBeVisible();
  if (await limited.isVisible()) {
    await page.waitForTimeout(61_000);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expectSignedIn(page, user.name);
  // The page reads what it lands on after sign-in; a read still on its way can replace the next page.
  await page.waitForLoadState("networkidle");
}

/** A new, empty database in the lab's Postgres container, for an orchestrator that needs one nobody else opened. */
export function freshDatabase(): string {
  const name = unique("lab_db").replace(/-/g, "_");
  const made = spawnSync("docker", ["exec", lab.postgres!.container, "createdb", "-U", "lab", name], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`createdb failed: ${made.stderr}`);
  return lab.postgres!.url.replace(/\/lab$/, `/${name}`);
}
