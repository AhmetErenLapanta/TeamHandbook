import { spawn } from "node:child_process";
import { createVerify, randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import { labEnv, labGit, labGitMaybe } from "./run.js";

/**
 * A stand-in GitLab, GitHub or Gitea for the lab: the REST calls the orchestrator's providers make, and the
 * merge a person makes on the forge, done for real on a bare repository with git plumbing. The
 * same server serves those repositories over git's HTTP protocol, read-only, so the orchestrator's
 * mirror, a teammate's join and doctor, and a teammate's marketplace copy all clone the one
 * address a team would give them. Nothing here talks to a real forge.
 */

export interface FakeForgeConfig {
  kind: "gitlab" | "github" | "gitea";
  port: number;
  token: string;
  /** Holds each repository at <group>/<name>.git. */
  root: string;
  path: string;
  projects: string[];
  users: string[];
  log: string;
  scratch: string;
  /** A project's issues, by project; GitHub lists its pull requests among them. */
  issues?: Record<string, ForgeIssue[]>;
  /** A project's milestones, by project. */
  milestones?: Record<string, ForgeMilestone[]>;
  /** A GitLab project's issue board lists, by project: the label each list gathers, in board order. */
  boardLists?: Record<string, string[]>;
  /** The name a forge user goes by beside their login, as GitLab shows an issue's assignee; the login stands in without one. */
  names?: Record<string, string>;
  /** The GitHub App an orchestrator is registered as, installed on one account. */
  app?: ForgeApp;
}

/** A milestone on the stand-in forge; the orchestrator reads an open one as a sprint. */
export interface ForgeMilestone {
  number: number;
  title: string;
  state: "open" | "closed";
  /** GitLab's start date; GitHub has none. */
  startOn?: string | null;
  dueOn: string | null;
  description: string;
}

/**
 * A GitHub App on the stand-in GitHub: the installation page returns the browser to the app's own
 * callback, the installer's code is traded for a token that lists the installations they reach,
 * and the app's JWT, checked against the public half of its key, mints installation tokens,
 * narrowed to the permissions asked for.
 */
export interface ForgeApp {
  id: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  publicKey: string;
  /** Where GitHub returns the browser after an installation: set on the app, never in the link. */
  callback: string;
  installation: { id: number; account: string; type: "Organization" | "User"; repositories: string[]; installer: string };
}

/** A call made with an installation token, for a test to read at `/lab/app`: what the token was allowed. */
export interface ForgeAppCall {
  method: string;
  path: string;
  /** The permissions the token was minted with; null for one minted with all of the installation's. */
  permissions: Record<string, string> | null;
}

/** An issue on the stand-in GitHub, read-only: its board column is a `status: ...` label, and closed is done. */
export interface ForgeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
  author: string;
  comments: { author: string; body: string }[];
  /** The number of the project's milestone it is in; none is the backlog. */
  milestone?: number;
  /** GitLab's weight, which the orchestrator reads as story points. */
  weight?: number;
}

interface ForgeRequest {
  number: number;
  /** Who opened it: the lab's `x-lab-user` header, standing in for whoever owns the token; the orchestrator never sends one. */
  author: string;
  updatedAt: string;
  source: string;
  target: string;
  title: string;
  description: string;
  state: "opened" | "merged" | "closed";
  labels: string[];
  reviewers: string[];
  assignees: string[];
  removeSource: boolean;
  mergeSha: string | null;
  /** What reviewers said on the forge, as `/lab/review` records a person doing it. */
  reviews: { user: string; state: "APPROVED" | "CHANGES_REQUESTED" }[];
  /** What was said on the request, as `/lab/comment` records it: on a line of a file when `path` is set; `system` is GitLab's own note, `bot` an app's. */
  comments: { id: number; user: string; body: string; at: string; path: string | null; line: number | null; system: boolean; bot: boolean }[];
}

class Answer extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`forge answer ${status}`);
  }
}

/** A comment as GitHub answers it, in a request's conversation or on one of its lines. */
const githubComment = (project: string, pull: ForgeRequest, c: ForgeRequest["comments"][number]) => ({
  id: c.id,
  body: c.body,
  user: { login: c.user, type: c.bot ? "Bot" : "User" },
  updated_at: c.at,
  html_url: `https://github.example.invalid/${project}/pull/${pull.number}#comment-${c.id}`,
  ...(c.path ? { path: c.path, line: c.line } : {}),
});

const FORGE_IDENTITY = { name: "Lab Forge", email: "forge@lab.example.invalid" };

/** git's tree with nothing in it, which an empty repository's first commit is built on. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** A 1x1 PNG, what a Gitea attachment the lab holds answers with. */
const ATTACHMENT_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** A commit status as an orchestrator wrote it, kept for a test to read at `/lab/statuses`. */
export interface ForgeStatus {
  project: string;
  sha: string;
  state: string;
  name: string;
  description: string;
}

export function startFakeForge(config: FakeForgeConfig): Promise<Server> {
  const requests = new Map<string, ForgeRequest[]>(config.projects.map((p) => [p, []]));
  const statuses: ForgeStatus[] = [];
  /** CI runs a test reports with `/lab/check`, in order: a rerun is a second entry of the same name. */
  const checks: { project: string; sha: string; name: string; state: "success" | "failed" | "running"; at: string; id: number }[] = [];
  /** Whether a request's branch merges into its target cleanly, as the forge's mergeability says. */
  const conflicts = (project: string, r: ForgeRequest): boolean => {
    const target = branchHead(project, r.target);
    const source = branchHead(project, r.source);
    if (!target || !source) return false;
    try {
      git(project, ["merge-tree", "--write-tree", target, source]);
      return false;
    } catch {
      return true;
    }
  };
  const userIds = new Map(config.users.map((u, i) => [u, 100 + i]));
  const bareOf = (project: string) => join(config.root, `${project}.git`);
  const git = (project: string, args: string[], options: Parameters<typeof labGit>[3] = {}) => labGit(config.path, args, bareOf(project), { who: FORGE_IDENTITY, ...options });
  const gitMaybe = (project: string, args: string[]) => labGitMaybe(config.path, args, bareOf(project));
  const base = `http://127.0.0.1:${config.port}`;
  const codes = new Map<string, string>();
  const userTokens = new Map<string, string>();
  const minted = new Map<string, { permissions: Record<string, string> | null; expiresAt: number }>();
  const appCalls: ForgeAppCall[] = [];

  const known = (project: string): ForgeRequest[] => {
    const list = requests.get(project);
    if (!list) throw new Answer(404, config.kind === "gitlab" ? { message: "404 Project Not Found" } : { message: "Not Found" });
    return list;
  };
  const defaultBranch = (project: string) => git(project, ["symbolic-ref", "--short", "HEAD"]);
  const branchHead = (project: string, branch: string) => gitMaybe(project, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);

  /** A tree: `base` with each change applied, through an index of its own so two calls never share one. */
  const buildTree = (project: string, base: string, changes: { path: string; content: string | null }[]): string => {
    const scratch = mkdtempSync(join(config.scratch, "index-"));
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    try {
      git(project, ["read-tree", base], { env });
      for (const change of changes) {
        if (change.content === null) {
          // Mode 0 takes the entry out; --force-remove would need a work tree a bare repository lacks.
          git(project, ["update-index", "--index-info"], { env, input: `0 ${"0".repeat(40)}\t${change.path}\n` });
        } else {
          const blob = git(project, ["hash-object", "-w", "--stdin"], { input: change.content });
          git(project, ["update-index", "--add", "--cacheinfo", `100644,${blob},${change.path}`], { env });
        }
      }
      return git(project, ["write-tree"], { env });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  const commitTree = (project: string, tree: string, parents: string[], message: string, author: { name: string; email: string }) =>
    git(project, ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-F", "-"], {
      input: message,
      env: { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email },
    });

  /** What a person pressing Merge does: a merge commit on the target branch, the source branch removed when asked. */
  const merge = (project: string, request: ForgeRequest): string => {
    if (request.state !== "opened") throw new Answer(405, { message: "405 Method Not Allowed" });
    const target = branchHead(project, request.target);
    const source = branchHead(project, request.source);
    if (!target || !source) throw new Answer(406, { message: "the branch is gone" });
    let tree: string;
    try {
      tree = git(project, ["merge-tree", "--write-tree", target, source]).split("\n")[0]!;
    } catch {
      throw new Answer(406, { message: "Branch cannot be merged" });
    }
    const sha = commitTree(project, tree, [target, source], `Merge branch '${request.source}' into '${request.target}'\n\n${request.title}`, FORGE_IDENTITY);
    git(project, ["update-ref", `refs/heads/${request.target}`, sha, target]);
    if (request.removeSource) git(project, ["update-ref", "-d", `refs/heads/${request.source}`]);
    request.state = "merged";
    request.mergeSha = sha;
    request.updatedAt = new Date().toISOString();
    return sha;
  };

  const find = (project: string, number: number): ForgeRequest => {
    const request = known(project).find((r) => r.number === number);
    if (!request) throw new Answer(404, { message: "Not Found" });
    return request;
  };

  const open = (project: string, fields: Omit<ForgeRequest, "number" | "state" | "mergeSha" | "updatedAt" | "reviews" | "comments">): ForgeRequest => {
    const list = known(project);
    if (!branchHead(project, fields.source)) throw new Answer(422, { message: `no branch ${fields.source}` });
    if (list.some((r) => r.state === "opened" && r.source === fields.source)) throw new Answer(409, { message: "Another open merge request already exists for this source branch" });
    const request: ForgeRequest = { ...fields, number: list.length + 1, state: "opened", mergeSha: null, reviews: [], comments: [], updatedAt: new Date().toISOString() };
    list.push(request);
    // As the forges keep it, so a mirror of the repository holds the request's commits.
    git(project, ["update-ref", config.kind === "gitlab" ? `refs/merge-requests/${request.number}/head` : `refs/pull/${request.number}/head`, branchHead(project, fields.source)!]);
    return request;
  };

  // ---- GitLab ----
  const gitlabMr = (project: string, r: ForgeRequest) => ({
    iid: r.number,
    title: r.title,
    description: r.description,
    state: r.state,
    source_branch: r.source,
    target_branch: r.target,
    labels: r.labels,
    reviewers: r.reviewers.map((username) => ({ id: userIds.get(username), username })),
    assignee: r.assignees[0] ? { id: userIds.get(r.assignees[0]), username: r.assignees[0] } : null,
    merge_commit_sha: r.mergeSha,
    sha: branchHead(project, r.source),
    has_conflicts: r.state === "opened" && conflicts(project, r),
    detailed_merge_status: r.state !== "opened" ? "not_open" : conflicts(project, r) ? "conflict" : "mergeable",
    author: { username: r.author },
    updated_at: r.updatedAt,
    web_url: `${base}/${project}/-/merge_requests/${r.number}`,
  });
  const usernameOf = (id: unknown) => [...userIds].find(([, value]) => value === id)?.[0];

  const gitlab = (method: string, parts: string[], query: URLSearchParams, body: Record<string, unknown>, user: string): [number, unknown] => {
    if (parts[0] === "users" && method === "GET") {
      const name = query.get("username") ?? "";
      return [200, userIds.has(name) ? [{ id: userIds.get(name), username: name }] : []];
    }
    if (parts[0] === "projects" && !parts[1] && method === "GET") {
      // Every project the token's account belongs to, the way the orchestrator lists boards.
      return [200, config.projects.map((p, i) => ({ id: i + 1, path_with_namespace: p, web_url: `${base}/${p}` }))];
    }
    if (parts[0] !== "projects" || !parts[1]) throw new Answer(404, { message: "404 Not Found" });
    // A project is named by its path or by its number, as GitLab takes both.
    const project = /^\d+$/.test(parts[1]) ? config.projects[Number(parts[1]) - 1] : parts[1];
    if (!project) throw new Answer(404, { message: "404 Project Not Found" });
    known(project);
    const rest = parts.slice(2);
    const route = `${method} ${rest.join("/")}`;
    if (route === "GET ") return [200, { id: config.projects.indexOf(project) + 1, path_with_namespace: project, default_branch: defaultBranch(project), web_url: `${base}/${project}` }];
    if (route === "GET boards") return [200, [{ id: 1, name: "Development", lists: (config.boardLists?.[project] ?? []).map((name, i) => ({ id: i + 1, position: i, label: { name } })) }]];
    if (route === "GET milestones") {
      const state = query.get("state");
      const listed = (config.milestones?.[project] ?? []).filter((m) => !state || (state === "active") === (m.state === "open"));
      return [200, listed.map((m) => ({ id: m.number, title: m.title, state: m.state === "open" ? "active" : "closed", start_date: m.startOn ?? null, due_date: m.dueOn?.slice(0, 10) ?? null, description: m.description }))];
    }
    // Iterations are a paid GitLab feature; the stand-in is a free one.
    if (route === "GET iterations") throw new Answer(404, { message: "404 Not Found" });
    if (route === "GET issues") {
      const milestones = config.milestones?.[project] ?? [];
      const titled = query.get("milestone");
      const state = query.get("state") ?? "all";
      const listed = (config.issues?.[project] ?? [])
        .filter((i) => state === "all" || (state === "opened") === (i.state === "open"))
        .filter((i) => titled === null || (titled === "None" ? i.milestone === undefined : milestones.find((m) => m.number === i.milestone)?.title === titled));
      const perPage = Math.min(100, Math.max(1, Number(query.get("per_page") ?? 20) || 20));
      const page = Math.max(1, Number(query.get("page") ?? 1) || 1);
      return [200, listed.slice((page - 1) * perPage, page * perPage).map((i) => ({ iid: i.number, title: i.title, state: i.state === "open" ? "opened" : "closed", labels: i.labels, assignees: i.assignees.map((login) => ({ name: config.names?.[login] ?? login, username: login })), weight: i.weight ?? null, issue_type: "issue", web_url: `${base}/${project}/-/issues/${i.number}` }))];
    }
    if (method === "GET" && rest[0] === "repository" && rest[1] === "branches" && rest[2]) {
      const head = branchHead(project, rest[2]);
      if (!head) throw new Answer(404, { message: "404 Branch Not Found" });
      return [200, { name: rest[2], commit: { id: head } }];
    }
    if (method === "DELETE" && rest[0] === "repository" && rest[1] === "branches" && rest[2]) {
      if (!branchHead(project, rest[2])) throw new Answer(404, { message: "404 Branch Not Found" });
      git(project, ["update-ref", "-d", `refs/heads/${rest[2]}`]);
      return [204, null];
    }
    if (method === "GET" && rest[0] === "repository" && rest[1] === "files" && rest[2]) {
      const ref = query.get("ref") ?? defaultBranch(project);
      if (gitMaybe(project, ["cat-file", "-e", `${ref}:${rest[2]}`]) === null) throw new Answer(404, { message: "404 File Not Found" });
      return [200, { file_path: rest[2], ref }];
    }
    if (route === "POST repository/commits") {
      const branch = String(body.branch ?? "");
      if (branchHead(project, branch)) throw new Answer(400, { message: "A branch called this already exists" });
      const start = String(body.start_sha ?? "");
      const actions = (body.actions ?? []) as { action: string; file_path: string; content?: string }[];
      for (const a of actions) {
        const present = gitMaybe(project, ["cat-file", "-e", `${start}:${a.file_path}`]) !== null;
        if (a.action === "create" && present) throw new Answer(400, { message: "A file with this name already exists" });
        if ((a.action === "update" || a.action === "delete") && !present) throw new Answer(400, { message: "A file with this name doesn't exist" });
      }
      const tree = buildTree(project, start, actions.map((a) => ({ path: a.file_path, content: a.action === "delete" ? null : a.content ?? "" })));
      const sha = commitTree(project, tree, [start], String(body.commit_message ?? ""), { name: String(body.author_name ?? "Lab"), email: String(body.author_email ?? "lab@lab.example.invalid") });
      git(project, ["update-ref", `refs/heads/${branch}`, sha, ""]);
      return [201, { id: sha, short_id: sha.slice(0, 8) }];
    }
    if (method === "POST" && rest[0] === "statuses" && rest[1]) {
      statuses.push({ project, sha: rest[1], state: String(body.state ?? ""), name: String(body.name ?? ""), description: String(body.description ?? "") });
      return [201, { sha: rest[1], status: body.state, name: body.name }];
    }
    if (route === "POST merge_requests") {
      const reviewers = ((body.reviewer_ids ?? []) as number[]).map(usernameOf).filter((u): u is string => !!u);
      const assignee = usernameOf(body.assignee_id);
      const request = open(project, {
        source: String(body.source_branch ?? ""),
        target: String(body.target_branch ?? defaultBranch(project)),
        title: String(body.title ?? ""),
        description: String(body.description ?? ""),
        labels: typeof body.labels === "string" && body.labels ? body.labels.split(",") : [],
        reviewers,
        assignees: assignee ? [assignee] : [],
        removeSource: body.remove_source_branch === true,
        author: user,
      });
      return [201, gitlabMr(project, request)];
    }
    if (method === "GET" && rest[0] === "merge_requests" && rest[2] === "notes") {
      const notes = [...find(project, Number(rest[1])).comments].reverse();
      return [200, notes.map((c) => ({ id: c.id, body: c.body, author: { username: c.user, bot: c.bot }, updated_at: c.at, system: c.system, position: c.path ? { new_path: c.path, new_line: c.line } : null }))];
    }
    if (method === "GET" && rest[0] === "merge_requests" && rest[2] === "approvals") {
      const approved = find(project, Number(rest[1])).reviews.filter((v) => v.state === "APPROVED");
      return [200, { approved: approved.length > 0, approvals_left: 0, approved_by: approved.map((v) => ({ user: { username: v.user } })) }];
    }
    if (method === "GET" && rest[0] === "repository" && rest[1] === "commits" && rest[3] === "statuses") {
      const ran = checks.filter((k) => k.project === project && k.sha === rest[2]).map((k) => ({ id: k.id, name: k.name, status: k.state, created_at: k.at, started_at: k.at, pipeline_id: 1, target_url: `${base}/${project}/-/jobs/${k.id}` }));
      const told = statuses.filter((s) => s.project === project && s.sha === rest[2]).map((s, n) => ({ id: 100_000 + n, name: s.name, status: s.state, created_at: null, pipeline_id: null, target_url: null }));
      return [200, [...ran, ...told]];
    }
    if (route === "GET merge_requests") {
      const state = query.get("state") ?? "all";
      const listed = known(project).filter((r) => state === "all" || r.state === state);
      return [200, [...listed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((r) => gitlabMr(project, r))];
    }
    if (method === "GET" && rest[0] === "merge_requests" && rest.length === 2) return [200, gitlabMr(project, find(project, Number(rest[1])))];
    if (method === "PUT" && rest[0] === "merge_requests" && rest[2] === "merge") {
      const request = find(project, Number(rest[1]));
      merge(project, request);
      return [200, gitlabMr(project, request)];
    }
    if (method === "PUT" && rest[0] === "merge_requests" && rest.length === 2) {
      const request = find(project, Number(rest[1]));
      if (body.state_event === "close" && request.state === "opened") request.state = "closed";
      if (body.state_event === "reopen" && request.state === "closed") request.state = "opened";
      request.updatedAt = new Date().toISOString();
      return [200, gitlabMr(project, request)];
    }
    throw new Answer(404, { message: "404 Not Found" });
  };

  // ---- GitHub ----
  const githubIssue = (project: string, i: ForgeIssue) => ({
    id: 900_000 + i.number,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((name) => ({ name })),
    assignees: i.assignees.map((login) => ({ login })),
    user: { login: i.author },
    comments: i.comments.length,
    milestone: milestoneView(project, i.milestone),
    html_url: `${base}/${project}/issues/${i.number}`,
  });
  const milestonesOf = (project: string) => config.milestones?.[project] ?? [];
  const milestoneView = (project: string, number: number | undefined) => {
    const m = milestonesOf(project).find((x) => x.number === number);
    return m ? { number: m.number, title: m.title, state: m.state, due_on: m.dueOn, description: m.description } : null;
  };
  // GitHub's issue list holds its pull requests too, each marked by a pull_request field.
  const pullAsIssue = (project: string, r: ForgeRequest) => ({
    id: 800_000 + r.number,
    number: r.number,
    title: r.title,
    body: r.description,
    state: r.state === "opened" ? "open" : "closed",
    labels: r.labels.map((name) => ({ name })),
    assignees: r.assignees.map((login) => ({ login })),
    user: { login: r.author },
    comments: 0,
    html_url: `${base}/${project}/pull/${r.number}`,
    pull_request: { url: `${base}/api/repos/${project}/pulls/${r.number}`, html_url: `${base}/${project}/pull/${r.number}` },
  });
  const issuesOf = (project: string) => config.issues?.[project] ?? [];
  const githubPull = (project: string, r: ForgeRequest) => ({
    number: r.number,
    title: r.title,
    body: r.description,
    state: r.state === "opened" ? "open" : "closed",
    merged: r.state === "merged",
    merge_commit_sha: r.mergeSha,
    head: { ref: r.source, sha: branchHead(project, r.source) },
    mergeable: r.state === "opened" ? !conflicts(project, r) : null,
    mergeable_state: r.state !== "opened" ? "unknown" : conflicts(project, r) ? "dirty" : "clean",
    base: { ref: r.target },
    labels: r.labels.map((name) => ({ name })),
    requested_reviewers: r.reviewers.map((login) => ({ login })),
    assignees: r.assignees.map((login) => ({ login })),
    user: { login: r.author },
    updated_at: r.updatedAt,
    html_url: `${base}/${project}/pull/${r.number}`,
  });

  const github = (method: string, parts: string[], query: URLSearchParams, body: Record<string, unknown>, user: string): [number, unknown] => {
    if (parts[0] !== "repos" || !parts[1] || !parts[2]) throw new Answer(404, { message: "Not Found" });
    const project = `${parts[1]}/${parts[2]}`;
    known(project);
    const rest = parts.slice(3);
    const route = `${method} ${rest.join("/")}`;
    if (route === "GET ") return [200, { full_name: project, default_branch: defaultBranch(project), html_url: `${base}/${project}` }];
    if (method === "GET" && rest[0] === "git" && rest[1] === "ref" && rest[2] === "heads") {
      const branch = rest.slice(3).join("/");
      const head = branchHead(project, branch);
      if (!head) throw new Answer(404, { message: "Not Found" });
      return [200, { ref: `refs/heads/${branch}`, object: { sha: head, type: "commit" } }];
    }
    if (method === "DELETE" && rest[0] === "git" && rest[1] === "refs" && rest[2] === "heads") {
      const branch = rest.slice(3).join("/");
      if (!branchHead(project, branch)) throw new Answer(422, { message: "Reference does not exist" });
      git(project, ["update-ref", "-d", `refs/heads/${branch}`]);
      return [204, null];
    }
    if (method === "GET" && rest[0] === "git" && rest[1] === "commits" && rest[2]) {
      const tree = gitMaybe(project, ["rev-parse", "--verify", "--quiet", `${rest[2]}^{tree}`]);
      if (!tree) throw new Answer(404, { message: "Not Found" });
      return [200, { sha: rest[2], tree: { sha: tree } }];
    }
    if (route === "POST git/trees") {
      const entries = (body.tree ?? []) as { path: string; content?: string; sha?: string | null }[];
      const sha = buildTree(project, String(body.base_tree ?? ""), entries.map((e) => ({ path: e.path, content: e.sha === null ? null : e.content ?? "" })));
      return [201, { sha }];
    }
    if (route === "POST git/commits") {
      const author = (body.author ?? {}) as { name?: string; email?: string };
      const sha = commitTree(project, String(body.tree ?? ""), (body.parents ?? []) as string[], String(body.message ?? ""), { name: author.name ?? "Lab", email: author.email ?? "lab@lab.example.invalid" });
      return [201, { sha }];
    }
    if (route === "POST git/refs") {
      const ref = String(body.ref ?? "");
      if (!ref.startsWith("refs/heads/")) throw new Answer(422, { message: "Reference name is not a branch" });
      if (branchHead(project, ref.slice("refs/heads/".length))) throw new Answer(422, { message: "Reference already exists" });
      git(project, ["update-ref", ref, String(body.sha ?? ""), ""]);
      return [201, { ref, object: { sha: body.sha } }];
    }
    if (route === "POST pulls") {
      const request = open(project, {
        source: String(body.head ?? ""),
        target: String(body.base ?? defaultBranch(project)),
        title: String(body.title ?? ""),
        description: String(body.body ?? ""),
        labels: [],
        reviewers: [],
        assignees: [],
        removeSource: false,
        author: user,
      });
      return [201, githubPull(project, request)];
    }
    if (route === "GET pulls") {
      const state = query.get("state") ?? "open";
      const listed = known(project).filter((r) => state === "all" || (state === "open") === (r.state === "opened"));
      return [200, [...listed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((r) => githubPull(project, r))];
    }
    if (method === "GET" && rest[0] === "issues" && rest.length === 1) {
      const state = query.get("state") ?? "open";
      const labels = (query.get("labels") ?? "").split(",").map((l) => l.trim()).filter(Boolean);
      const milestone = query.get("milestone");
      const all = [...issuesOf(project).map((i) => githubIssue(project, i)), ...known(project).map((r) => ({ ...pullAsIssue(project, r), milestone: null }))]
        .filter((i) => state === "all" || i.state === state)
        .filter((i) => milestone === null || milestone === "*" ? true : milestone === "none" ? i.milestone === null : i.milestone?.number === Number(milestone))
        .filter((i) => labels.every((l) => i.labels.some((x) => x.name === l)))
        .sort((a, b) => b.number - a.number);
      const perPage = Math.min(100, Math.max(1, Number(query.get("per_page") ?? 30) || 30));
      const page = Math.max(1, Number(query.get("page") ?? 1) || 1);
      return [200, all.slice((page - 1) * perPage, page * perPage)];
    }
    if (method === "GET" && rest[0] === "issues" && rest[1] && (rest.length === 2 || rest[2] === "comments")) {
      const number = Number(rest[1]);
      const issue = issuesOf(project).find((i) => i.number === number);
      const pull = issue ? undefined : known(project).find((r) => r.number === number);
      if (!issue && !pull) throw new Answer(404, { message: "Not Found" });
      if (rest[2] === "comments" && pull) return [200, pull.comments.filter((c) => c.path === null).map((c) => githubComment(project, pull, c))];
      if (rest[2] === "comments") return [200, (issue?.comments ?? []).map((c, n) => ({ id: 700_000 + n, user: { login: c.author }, body: c.body }))];
      return [200, issue ? githubIssue(project, issue) : pullAsIssue(project, pull!)];
    }
    if (method === "GET" && rest[0] === "milestones" && rest.length === 1) {
      const state = query.get("state") ?? "open";
      return [200, milestonesOf(project).filter((m) => state === "all" || m.state === state).map((m) => milestoneView(project, m.number))];
    }
    if (method === "GET" && rest[0] === "labels" && rest.length === 1) {
      return [200, [...new Set(issuesOf(project).flatMap((i) => i.labels))].sort().map((name) => ({ name }))];
    }
    if (method === "POST" && rest[0] === "statuses" && rest[1]) {
      statuses.push({ project, sha: rest[1], state: String(body.state ?? ""), name: String(body.context ?? ""), description: String(body.description ?? "") });
      return [201, { state: body.state, context: body.context }];
    }
    if (method === "GET" && rest[0] === "pulls" && rest.length === 2) return [200, githubPull(project, find(project, Number(rest[1])))];
    if (method === "GET" && rest[0] === "pulls" && rest[2] === "comments") {
      const pull = find(project, Number(rest[1]));
      return [200, pull.comments.filter((c) => c.path !== null).map((c) => githubComment(project, pull, c))];
    }
    if (method === "GET" && rest[0] === "pulls" && rest[2] === "reviews") {
      return [200, find(project, Number(rest[1])).reviews.map((v, n) => ({ id: n + 1, user: { login: v.user }, state: v.state, submitted_at: new Date(Date.UTC(2026, 10, 2, 12, 0, n)).toISOString() }))];
    }
    if (method === "GET" && rest[0] === "commits" && rest[2] === "check-runs") {
      const runs = checks.filter((k) => k.project === project && k.sha === rest[1]);
      return [200, { total_count: runs.length, check_runs: runs.map((k) => ({ id: k.id, name: k.name, status: k.state === "running" ? "in_progress" : "completed", conclusion: k.state === "running" ? null : k.state === "success" ? "success" : "failure", started_at: k.at, html_url: `${base}/${project}/runs/${k.id}`, app: { slug: "lab-ci" } })) }];
    }
    if (method === "GET" && rest[0] === "commits" && rest[2] === "status") {
      return [200, { statuses: statuses.filter((s) => s.project === project && s.sha === rest[1]).map((s, n) => ({ id: n + 1, context: s.name, state: s.state, updated_at: null, target_url: null })) }];
    }
    if (method === "PATCH" && rest[0] === "pulls" && rest.length === 2) {
      const request = find(project, Number(rest[1]));
      if (body.state === "closed" && request.state === "opened") request.state = "closed";
      if (body.state === "open" && request.state === "closed") request.state = "opened";
      request.updatedAt = new Date().toISOString();
      return [200, githubPull(project, request)];
    }
    if (method === "PUT" && rest[0] === "pulls" && rest[2] === "merge") {
      const request = find(project, Number(rest[1]));
      const sha = merge(project, request);
      return [200, { sha, merged: true, message: "Pull Request successfully merged" }];
    }
    if (method === "POST" && rest[0] === "pulls" && rest[2] === "requested_reviewers") {
      const request = find(project, Number(rest[1]));
      const asked = (body.reviewers ?? []) as string[];
      const strangers = asked.filter((u) => !userIds.has(u));
      if (strangers.length) throw new Answer(422, { message: "Reviews may only be requested from collaborators. One or more of the users or teams you specified is not a collaborator of this repository." });
      request.reviewers.push(...asked);
      return [201, githubPull(project, request)];
    }
    if (method === "POST" && rest[0] === "issues" && rest[2] === "labels") {
      const request = find(project, Number(rest[1]));
      request.labels.push(...((body.labels ?? []) as string[]));
      return [200, request.labels.map((name) => ({ name }))];
    }
    if (method === "POST" && rest[0] === "issues" && rest[2] === "assignees") {
      const request = find(project, Number(rest[1]));
      // GitHub drops an assignee it cannot assign without saying so.
      request.assignees.push(...((body.assignees ?? []) as string[]).filter((u) => userIds.has(u)));
      return [201, githubPull(project, request)];
    }
    throw new Answer(404, { message: "Not Found" });
  };

  /** A GitHub call by what its bearer is: the lab's token, the app's JWT, an installer's token, or an installation token. */
  const githubAs = (bearer: string, method: string, parts: string[], query: URLSearchParams, body: Record<string, unknown>, user: string): [number, unknown] => {
    if (bearer === config.token) return github(method, parts, query, body, user);
    const app = config.app;
    const stranger = new Answer(401, { message: "Bad credentials" });
    if (!app) throw stranger;
    const route = `${method} ${parts.join("/")}`;
    if (/^POST app\/installations\/\d+\/access_tokens$/.test(route)) {
      if (!appJwtHolds(app, bearer)) throw stranger;
      if (Number(parts[2]) !== app.installation.id) throw new Answer(404, { message: "Not Found" });
      const permissions = body.permissions && typeof body.permissions === "object" ? (body.permissions as Record<string, string>) : null;
      const token = `ghs_${randomBytes(18).toString("hex")}`;
      const expiresAt = Date.now() + 3_600_000;
      minted.set(token, { permissions, expiresAt });
      return [201, { token, expires_at: new Date(expiresAt).toISOString(), permissions: permissions ?? { contents: "write", issues: "write", metadata: "read", pull_requests: "write" } }];
    }
    if (/^GET app\/installations\/\d+$/.test(route)) {
      if (!appJwtHolds(app, bearer)) throw stranger;
      if (Number(parts[2]) !== app.installation.id) throw new Answer(404, { message: "Not Found" });
      return [200, { id: app.installation.id, account: { login: app.installation.account, type: app.installation.type }, suspended_at: null }];
    }
    if (route === "GET user/installations") {
      const login = userTokens.get(bearer);
      if (!login) throw stranger;
      const i = app.installation;
      const reached = i.installer === login ? [{ id: i.id, app_id: Number(app.id), account: { login: i.account, type: i.type } }] : [];
      return [200, { total_count: reached.length, installations: reached }];
    }
    const held = minted.get(bearer);
    if (!held || held.expiresAt <= Date.now()) throw stranger;
    appCalls.push({ method, path: `/${parts.join("/")}`, permissions: held.permissions });
    if (route === "GET installation/repositories") {
      const perPage = Math.min(100, Math.max(1, Number(query.get("per_page") ?? 30) || 30));
      const page = Math.max(1, Number(query.get("page") ?? 1) || 1);
      const repos = app.installation.repositories.map((full) => ({ full_name: full, html_url: `${base}/${full}`, has_issues: true }));
      return [200, { total_count: repos.length, repositories: repos.slice((page - 1) * perPage, page * perPage) }];
    }
    if (parts[0] !== "repos" || !app.installation.repositories.includes(`${parts[1]}/${parts[2]}`)) throw new Answer(404, { message: "Not Found" });
    const rest = parts.slice(3);
    const readsIssues = method === "GET" && (rest.length === 0 || ["issues", "milestones", "labels"].includes(rest[0]!));
    // A token narrowed to reading issues reads them and nothing else, as GitHub holds it.
    if (held.permissions && !(readsIssues && held.permissions.issues)) throw new Answer(403, { message: "Resource not accessible by integration" });
    return github(method, parts, query, body, user);
  };

  /** The installation page: no page at all, the installer's answer given at once, back to the app's callback. */
  const installPage = (url: URL, res: ServerResponse) => {
    const app = config.app!;
    const state = url.searchParams.get("state");
    if (!state) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("an installation begun from an app carries its state\n");
      return;
    }
    const code = randomBytes(10).toString("hex");
    codes.set(code, app.installation.installer);
    const back = new URL(app.callback);
    for (const [k, v] of Object.entries({ code, installation_id: String(app.installation.id), setup_action: "install", state })) back.searchParams.set(k, v);
    appendFileSync(config.log, `${new Date().toISOString()} GET ${url.pathname} 302\n`);
    res.writeHead(302, { location: back.toString() });
    res.end();
  };

  /** Trades an installer's code for their own token; GitHub answers 200 with an error field when it refuses. */
  const userToken = (raw: string): Record<string, string> => {
    const app = config.app!;
    const form = new URLSearchParams(raw);
    if (form.get("client_id") !== app.clientId || form.get("client_secret") !== app.clientSecret) return { error: "incorrect_client_credentials", error_description: "The client_id and/or client_secret passed are incorrect." };
    const login = codes.get(form.get("code") ?? "");
    if (!login) return { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." };
    const redirect = form.get("redirect_uri");
    if (redirect && redirect !== app.callback) return { error: "redirect_uri_mismatch", error_description: "The redirect_uri MUST match the registered callback URL for this application." };
    codes.delete(form.get("code")!);
    const token = `ghu_${randomBytes(18).toString("hex")}`;
    userTokens.set(token, login);
    return { access_token: token, token_type: "bearer", scope: "" };
  };

  // ---- Gitea ----
  // Gitea 1.20's REST API, the calls server/forge/gitea.ts makes: a branch made at a commit, files
  // written onto its tip as one commit, then the pull request; and what a request reads back.
  const giteaPull = (project: string, r: ForgeRequest) => ({
    number: r.number,
    title: r.title,
    body: r.description,
    state: r.state === "opened" ? "open" : "closed",
    merged: r.state === "merged",
    merged_at: r.state === "merged" ? r.updatedAt : null,
    mergeable: r.state === "opened" && !conflicts(project, r),
    html_url: `${base}/${project}/pulls/${r.number}`,
    head: { ref: r.source, sha: branchHead(project, r.source) ?? r.mergeSha, repo_id: config.projects.indexOf(project) + 1 },
    base: { ref: r.target, repo_id: config.projects.indexOf(project) + 1 },
    user: { login: r.author },
    labels: r.labels.map((name) => ({ name })),
    assignees: r.assignees.map((login) => ({ login })),
    requested_reviewers: r.reviewers.map((login) => ({ login })),
    updated_at: r.updatedAt,
  });
  /** A request's comments on lines, gathered under one review of their own, as Gitea keeps a line comment inside a review. */
  const LINE_REVIEW = 9000;
  const giteaComment = (project: string, r: ForgeRequest, c: ForgeRequest["comments"][number]) => ({
    id: c.id,
    body: c.body,
    user: { login: c.user },
    updated_at: c.at,
    html_url: `${base}/${project}/pulls/${r.number}#issuecomment-${c.id}`,
    ...(c.path ? { path: c.path, position: c.line } : {}),
  });

  /** A project's labels, each with the id Gitea takes them by; a test adds them with /lab/label. */
  const giteaLabels = new Map<string, { id: number; name: string }[]>();
  const labelsOf = (project: string) => giteaLabels.get(project) ?? [];
  /** Webhooks GITEA_ADMIN set, by project, for a test to read at /lab/hooks. */
  const giteaHooks: { id: number; project: string; body: Record<string, unknown> }[] = [];
  /** Attachments a test registers with /lab/attachment, by uuid. */
  const giteaAttachments = new Set<string>();
  const emptyRepo = (project: string) => gitMaybe(project, ["for-each-ref", "--count=1", "--format=%(refname)", "refs/heads"]) === "";
  const giteaRepo = (project: string) => ({ id: config.projects.indexOf(project) + 1, full_name: project, html_url: `${base}/${project}`, clone_url: `${base}/${project}.git`, default_branch: defaultBranch(project), empty: emptyRepo(project), permissions: { admin: true, push: true, pull: true } });
  /** A new, empty repository under `owner`, as GITEA_ADMIN creates the team's. */
  const createGiteaRepo = (owner: string, body: Record<string, unknown>): [number, unknown] => {
    const name = String(body.name ?? "");
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Answer(422, { message: "invalid repository name" });
    const project = `${owner}/${name}`;
    if (requests.has(project)) throw new Answer(409, { message: "The repository with the same name already exists." });
    labGit(config.path, ["init", "-q", "--bare", "-b", "main", bareOf(project)], config.root);
    config.projects.push(project);
    requests.set(project, []);
    return [201, giteaRepo(project)];
  };

  const gitea = (method: string, parts: string[], query: URLSearchParams, body: Record<string, unknown>, user: string): [number, unknown] => {
    if (method === "GET" && parts.join("/") === "user/repos") return [200, config.projects.map(giteaRepo)];
    if (method === "POST" && parts.join("/") === "user/repos") return createGiteaRepo(user, body);
    if (method === "POST" && parts[0] === "orgs" && parts[1] && parts[2] === "repos" && parts.length === 3) return createGiteaRepo(parts[1], body);
    if (parts[0] !== "repos" || !parts[1] || !parts[2]) throw new Answer(404, { message: "The target couldn't be found." });
    const project = `${parts[1]}/${parts[2]}`;
    if (!requests.has(project)) throw new Answer(404, { message: "The target couldn't be found." });
    const rest = parts.slice(3);
    const route = `${method} ${rest.join("/")}`;
    const pull = () => find(project, Number(rest[1]));
    if (route === "GET ") return [200, giteaRepo(project)];
    if (route === "GET branches") return [200, (gitMaybe(project, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"]) ?? "").split("\n").filter(Boolean).map((l) => ({ name: l.split(" ")[0], commit: { id: l.split(" ")[1] } }))];
    if (route === "GET tags") return [200, (gitMaybe(project, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/tags"]) ?? "").split("\n").filter(Boolean).map((l) => ({ name: l.split(" ")[0], commit: { sha: l.split(" ")[1] } }))];
    if (route === "POST hooks") {
      giteaHooks.push({ id: giteaHooks.length + 1, project, body });
      return [201, { id: giteaHooks.length, type: body.type, active: body.active, events: body.events }];
    }
    if (method === "DELETE" && rest[0] === "hooks" && rest[1]) {
      const at = giteaHooks.findIndex((h) => h.project === project && h.id === Number(rest[1]));
      if (at < 0) throw new Answer(404, { message: "Not Found" });
      giteaHooks.splice(at, 1);
      return [204, null];
    }
    if (method === "GET" && rest[0] === "contents" && rest[1]) {
      const path = rest.slice(1).join("/");
      const ref = query.get("ref") ?? defaultBranch(project);
      const type = gitMaybe(project, ["cat-file", "-t", `${ref}:${path}`]);
      if (type === null) throw new Answer(404, { message: "GetContentsOrList" });
      if (type === "tree") return [200, []];
      return [200, { type: "file", path, sha: git(project, ["rev-parse", `${ref}:${path}`]) }];
    }
    if (method === "GET" && rest[0] === "branches" && rest[1]) {
      const head = branchHead(project, rest.slice(1).join("/"));
      if (!head) throw new Answer(404, { message: "Branch Not Found" });
      return [200, { name: rest.slice(1).join("/"), commit: { id: head } }];
    }
    if (method === "DELETE" && rest[0] === "branches" && rest[1]) {
      const branch = rest.slice(1).join("/");
      if (!branchHead(project, branch)) throw new Answer(404, { message: "Branch Not Found" });
      git(project, ["update-ref", "-d", `refs/heads/${branch}`]);
      return [204, null];
    }
    if (route === "POST branches") {
      const branch = String(body.new_branch_name ?? "");
      if (branchHead(project, branch)) throw new Answer(409, { message: "The branch already exists." });
      const at = gitMaybe(project, ["rev-parse", "--verify", "--quiet", `${String(body.old_ref_name ?? "")}^{commit}`]);
      if (!at) throw new Answer(404, { message: "The old branch does not exist" });
      git(project, ["update-ref", `refs/heads/${branch}`, at, ""]);
      return [201, { name: branch, commit: { id: at } }];
    }
    if (route === "POST contents") {
      // Gitea writes onto a branch's tip alone, as one commit of every file named.
      const branch = String(body.branch ?? "");
      const tip = branchHead(project, branch);
      // An empty repository takes its first commit on the branch named, which becomes its default branch.
      const first = !tip && emptyRepo(project);
      if (!tip && !first) throw new Answer(404, { message: "branch does not exist" });
      const files = (body.files ?? []) as { operation: string; path: string; content?: string; sha?: string }[];
      for (const f of files) {
        const present = tip ? gitMaybe(project, ["rev-parse", "--verify", "--quiet", `${tip}:${f.path}`]) : null;
        if (f.operation === "create" && present) throw new Answer(422, { message: `file already exists: ${f.path}` });
        if (f.operation !== "create" && (!present || present !== f.sha)) throw new Answer(422, { message: `sha does not match: ${f.path}` });
      }
      const tree = buildTree(project, tip ?? EMPTY_TREE, files.map((f) => ({ path: f.path, content: f.operation === "delete" ? null : Buffer.from(f.content ?? "", "base64").toString("utf8") })));
      const author = (body.author ?? {}) as { name?: string; email?: string };
      const sha = commitTree(project, tree, tip ? [tip] : [], String(body.message ?? ""), { name: String(author.name ?? "Lab"), email: String(author.email ?? "lab@lab.example.invalid") });
      git(project, ["update-ref", `refs/heads/${branch}`, sha, tip ?? ""]);
      if (first) git(project, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
      return [201, { commit: { sha, parents: tip ? [{ sha: tip }] : [] } }];
    }
    if (method === "POST" && rest[0] === "statuses" && rest[1]) {
      statuses.push({ project, sha: rest[1], state: String(body.state ?? ""), name: String(body.context ?? ""), description: String(body.description ?? "") });
      return [201, { id: statuses.length, status: body.state, context: body.context }];
    }
    if (method === "GET" && rest[0] === "commits" && rest[2] === "statuses") {
      const ran = checks.filter((k) => k.project === project && k.sha === rest[1]).map((k) => ({ id: k.id, context: k.name, status: k.state === "failed" ? "failure" : k.state === "running" ? "pending" : "success", target_url: `${base}/${project}/actions/runs/${k.id}`, updated_at: k.at }));
      const told = statuses.filter((t) => t.project === project && t.sha === rest[1]).map((t, n) => ({ id: 100_000 + n, context: t.name, status: t.state, target_url: null, updated_at: null }));
      return [200, [...ran, ...told]];
    }
    if (route === "GET labels") return [200, labelsOf(project)];
    if (method === "POST" && rest[0] === "issues" && rest[2] === "labels") {
      const request = pull();
      const named = ((body.labels ?? []) as number[]).map((id) => labelsOf(project).find((l) => l.id === id));
      if (named.some((l) => !l)) throw new Answer(422, { message: "label does not exist" });
      request.labels = [...new Set([...request.labels, ...named.map((l) => l!.name)])];
      return [200, request.labels.map((name) => labelsOf(project).find((l) => l.name === name))];
    }
    if (method === "PATCH" && rest[0] === "issues" && rest[1] && rest.length === 2) {
      const request = pull();
      const asked = (body.assignees ?? []) as string[];
      const stranger = asked.find((u) => !userIds.has(u));
      if (stranger) throw new Answer(422, { message: `user does not exist [name: ${stranger}]` });
      request.assignees = asked;
      return [201, { number: request.number, assignees: asked.map((login) => ({ login })) }];
    }
    if (route === "POST pulls") {
      const request = open(project, { source: String(body.head ?? ""), target: String(body.base ?? defaultBranch(project)), title: String(body.title ?? ""), description: String(body.body ?? ""), labels: [], reviewers: [], assignees: [], removeSource: false, author: user });
      return [201, giteaPull(project, request)];
    }
    if (route === "GET pulls") {
      const state = query.get("state") ?? "open";
      const listed = known(project).filter((r) => state === "all" || (state === "open") === (r.state === "opened"));
      return [200, [...listed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((r) => giteaPull(project, r))];
    }
    if (method === "GET" && rest[0] === "pulls" && rest.length === 2) return [200, giteaPull(project, pull())];
    if (method === "POST" && rest[0] === "pulls" && rest[2] === "requested_reviewers") {
      const request = pull();
      request.reviewers = [...new Set([...request.reviewers, ...((body.reviewers ?? []) as string[])])];
      return [201, request.reviewers.map((login) => ({ user: { login } }))];
    }
    if (method === "GET" && rest[0] === "pulls" && rest[2] === "reviews" && rest.length === 3) {
      const request = pull();
      const said = request.reviews.map((v, n) => ({ id: n + 1, user: { login: v.user }, state: v.state === "CHANGES_REQUESTED" ? "REQUEST_CHANGES" : "APPROVED", dismissed: false, submitted_at: request.updatedAt, comments_count: 0 }));
      const onLines = request.comments.filter((c) => c.path);
      return [200, onLines.length ? [...said, { id: LINE_REVIEW, user: { login: onLines[0]!.user }, state: "COMMENT", dismissed: false, submitted_at: onLines[0]!.at, comments_count: onLines.length }] : said];
    }
    if (method === "GET" && rest[0] === "pulls" && rest[2] === "reviews" && Number(rest[3]) === LINE_REVIEW && rest[4] === "comments") {
      const request = pull();
      return [200, request.comments.filter((c) => c.path).map((c) => giteaComment(project, request, c))];
    }
    if (method === "GET" && rest[0] === "issues" && rest[2] === "comments") {
      const request = pull();
      return [200, request.comments.filter((c) => !c.path).map((c) => giteaComment(project, request, c))];
    }
    if (method === "POST" && rest[0] === "pulls" && rest[2] === "merge") {
      merge(project, pull());
      return [200, null];
    }
    if (method === "PATCH" && rest[0] === "pulls" && rest.length === 2) {
      const request = pull();
      if (body.state === "closed" && request.state === "opened") request.state = "closed";
      if (body.state === "open" && request.state === "closed") request.state = "opened";
      request.updatedAt = new Date().toISOString();
      return [201, giteaPull(project, request)];
    }
    throw new Answer(404, { message: "The target couldn't be found." });
  };

  const api = (req: IncomingMessage, res: ServerResponse, raw: string) => {
    const url = new URL(req.url ?? "/", base);
    const prefix = config.kind === "gitlab" ? "/api/v4/" : config.kind === "gitea" ? "/api/v1/" : "/api/";
    let status: number;
    let payload: unknown;
    try {
      if (config.kind === "gitlab" && req.headers["private-token"] !== config.token) throw new Answer(401, { message: "401 Unauthorized" });
      if (config.kind === "gitea" && req.headers.authorization !== `token ${config.token}`) throw new Answer(401, { message: "token is required" });
      // Split on the raw path: GitLab's project id is one segment with its slash encoded.
      const parts = url.pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        throw new Answer(400, { message: "the body is not JSON" });
      }
      const user = typeof req.headers["x-lab-user"] === "string" ? req.headers["x-lab-user"] : "orchestrator-bot";
      const method = req.method ?? "GET";
      [status, payload] = config.kind === "gitlab" ? gitlab(method, parts, url.searchParams, body, user) : config.kind === "gitea" ? gitea(method, parts, url.searchParams, body, user) : githubAs((req.headers.authorization ?? "").replace(/^Bearer /, ""), method, parts, url.searchParams, body, user);
    } catch (err) {
      if (!(err instanceof Answer)) {
        status = 500;
        payload = { message: "the lab forge failed" };
        appendFileSync(config.log, `error ${req.method} ${url.pathname}: ${(err as Error).message}\n`);
      } else {
        status = err.status;
        payload = err.body;
      }
    }
    appendFileSync(config.log, `${new Date().toISOString()} ${req.method} ${url.pathname} ${status}\n`);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 204 ? undefined : JSON.stringify(payload));
  };

  /** git's own smart HTTP, through git http-backend; fetch and clone only, a push is refused. */
  const gitHttp = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", base);
    if (url.searchParams.get("service") === "git-receive-pack" || url.pathname.endsWith("/git-receive-pack")) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("the lab forge takes changes only through its API\n");
      return;
    }
    const header = (name: string) => {
      const value = req.headers[name];
      return typeof value === "string" ? value : "";
    };
    const child = spawn("git", ["http-backend"], {
      env: labEnv(config.path, {
        HOME: config.root,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_PROJECT_ROOT: config.root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: header("content-type"),
        REMOTE_ADDR: "127.0.0.1",
        ...(header("content-length") ? { CONTENT_LENGTH: header("content-length") } : {}),
        ...(header("content-encoding") ? { HTTP_CONTENT_ENCODING: header("content-encoding") } : {}),
        ...(header("git-protocol") ? { GIT_PROTOCOL: header("git-protocol") } : {}),
      }),
      stdio: ["pipe", "pipe", "ignore"],
    });
    req.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let started = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (started) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const text = head.toString("latin1");
      const end = text.search(/\r?\n\r?\n/);
      if (end < 0) return;
      const separator = text.slice(end).startsWith("\r\n\r\n") ? 4 : text.slice(end).startsWith("\r\n") ? 3 : 2;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of text.slice(0, end).split(/\r?\n/)) {
        const at = line.indexOf(":");
        if (at < 0) continue;
        const name = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]) || 200;
        else headers[name] = value;
      }
      started = true;
      res.writeHead(status, headers);
      res.write(head.subarray(end + separator));
    });
    child.on("close", () => {
      if (!started) res.writeHead(500);
      res.end();
    });
  };

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, kind: config.kind }));
      return;
    }
    // A person reviewing on the forge, and CI reporting a run: what the orchestrator reads before a merge.
    if ((path === "/lab/review" || path === "/lab/check" || path === "/lab/comment") && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as Record<string, string | number>;
        if (path === "/lab/comment") {
          const request = find(String(body.project), Number(body.number));
          request.comments.push({ id: 1000 + request.comments.length, user: String(body.user), body: String(body.body), at: String(body.at ?? new Date().toISOString()), path: body.path ? String(body.path) : null, line: body.line ? Number(body.line) : null, system: body.system === "true", bot: body.bot === "true" });
        } else if (path === "/lab/review") find(String(body.project), Number(body.number)).reviews.push({ user: String(body.user), state: body.state === "CHANGES_REQUESTED" ? "CHANGES_REQUESTED" : "APPROVED" });
        else checks.push({ project: String(body.project), sha: String(body.sha), name: String(body.name), state: body.state === "failed" ? "failed" : body.state === "running" ? "running" : "success", at: String(body.at ?? new Date().toISOString()), id: checks.length + 1 });
        res.writeHead(204);
        res.end();
      });
      return;
    }
    // Gitea: a label a test gives a project, the webhooks set on it, and an attachment read with the token.
    if (config.kind === "gitea" && path === "/lab/label" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { project?: string; name?: string };
        const list = giteaLabels.get(String(body.project)) ?? [];
        const label = { id: 500 + list.length + 1, name: String(body.name) };
        giteaLabels.set(String(body.project), [...list, label]);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify(label));
      });
      return;
    }
    if (config.kind === "gitea" && path === "/lab/hooks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hooks: giteaHooks }));
      return;
    }
    if (config.kind === "gitea" && path === "/lab/attachment" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        giteaAttachments.add(String((JSON.parse(raw || "{}") as { uuid?: string }).uuid));
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (config.kind === "gitea" && /^\/attachments\/[0-9a-f-]{36}$/.test(path) && req.method === "GET") {
      // Gitea answers 404, not 401, for an attachment the caller may not read.
      const held = req.headers.authorization === `token ${config.token}` && giteaAttachments.has(path.slice("/attachments/".length));
      appendFileSync(config.log, `${new Date().toISOString()} GET ${path} ${held ? 200 : 404}\n`);
      res.writeHead(held ? 200 : 404, { "content-type": held ? "image/png" : "application/json" });
      res.end(held ? ATTACHMENT_PNG : JSON.stringify({ message: "Not Found" }));
      return;
    }
    if (path === "/lab/statuses") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ statuses }));
      return;
    }
    if (path === "/lab/app") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ calls: appCalls, minted: [...minted.values()].map((m) => m.permissions) }));
      return;
    }
    if (config.app && path === `/apps/${config.app.slug}/installations/new`) {
      installPage(new URL(req.url ?? "/", base), res);
      return;
    }
    if (/^\/[^?]+\.git\//.test(path)) {
      gitHttp(req, res);
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (config.app && path === "/login/oauth/access_token" && req.method === "POST") {
        appendFileSync(config.log, `${new Date().toISOString()} POST ${path}\n`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(userToken(raw)));
        return;
      }
      api(req, res, raw);
    });
  });
  return new Promise((resolve) => server.listen(config.port, "127.0.0.1", () => resolve(server)));
}

/** Whether a bearer is a JWT the app signed with its key, issued for it, lasting ten minutes at most and not lapsed. */
function appJwtHolds(app: ForgeApp, jwt: string): boolean {
  const [head, claims, signature] = jwt.split(".");
  if (!head || !claims || !signature) return false;
  try {
    if (!createVerify("RSA-SHA256").update(`${head}.${claims}`).verify(app.publicKey, Buffer.from(signature, "base64url"))) return false;
    const { iss, iat, exp } = JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as { iss?: unknown; iat?: unknown; exp?: unknown };
    const now = Math.floor(Date.now() / 1000);
    return String(iss) === app.id && typeof iat === "number" && typeof exp === "number" && exp > now && exp - iat <= 600;
  } catch {
    return false;
  }
}

/** Run as `lab.mjs forge <config.json>`: the server lives until down.sh stops it. */
export async function forgeMain(file: string): Promise<void> {
  const config = JSON.parse(readFileSync(file, "utf8")) as FakeForgeConfig;
  await startFakeForge(config);
  appendFileSync(config.log, `${config.kind} listening on 127.0.0.1:${config.port}\n`);
}
