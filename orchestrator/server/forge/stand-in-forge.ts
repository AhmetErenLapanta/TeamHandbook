import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A GitLab or GitHub on this machine for the tests of the forge connection: the REST calls that
 * list, create and scaffold a repository and set its webhook, done for real on bare repositories
 * with git plumbing, and git's smart HTTP to read them, only with the token the stand-in issued.
 * Nothing here talks to a real forge. Test code only: no server module imports it.
 */
export interface StandInForge {
  kind: "gitlab" | "github";
  /** http://127.0.0.1:<port>: the web address; the API is under /api/v4 (GitLab) or /api (GitHub). */
  webUrl: string;
  host: string;
  /** The one token the stand-in accepts, as the API's bearer and as git's password. */
  token: string;
  /** Every API call, in order. */
  calls: { method: string; path: string; body: unknown }[];
  /** Webhooks set, by repository. */
  hooks: Map<string, unknown>;
  /** Makes an empty repository (no branch) or one with a commit, reachable by the connection. */
  addRepo(fullName: string, options?: { withCommit?: boolean; tagOnly?: boolean }): void;
  /** The files on a repository's default branch, and its commits from the newest, as git reads them. */
  read(fullName: string): { files: Record<string, string>; commits: { subject: string; author: string; parents: number }[] };
  /** Pushes a commit onto a branch out of band, as a person with access would. */
  pushAside(fullName: string, branch: string): void;
  /** Opens a request from `branch`, pushed with a commit as `author` would from their own machine; answers its number. */
  openRequest(fullName: string, request: { branch: string; author: string; fromFork?: boolean }): number;
  /** The GitHub account the app's installation is on, as GitHub answers the app for it; GitLab ignores it. */
  installationAccount: string;
  /** Whether the GitHub account is an organization; GitLab ignores it. */
  organization: boolean;
  close(): Promise<void>;
}

class Answer extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(String(status));
  }
}

const ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_COMMITTER_NAME: "Stand-in Forge", GIT_COMMITTER_EMAIL: "forge@example.invalid", GIT_AUTHOR_NAME: "Stand-in Forge", GIT_AUTHOR_EMAIL: "forge@example.invalid" };

/**
 * The stand-in's sign-in, approved at once as the browser arrives: GitLab's authorize page and
 * GitHub's installation page send the browser straight back to the orchestrator with a code, and the
 * code is traded for the stand-in's one token. A browser test drives the real redirects with it.
 */
const SIGNED_IN_AS = { gitlab: "ada-gl", github: "acme-org" } as const;
const INSTALLATION_ID = 5;

export async function startStandInForge(kind: "gitlab" | "github", port = 0, callback?: string): Promise<StandInForge> {
  const root = mkdtempSync(join(tmpdir(), "stand-in-forge-"));
  const token = `${kind === "gitlab" ? "glpat" : "ghs"}-stand-in-${Math.random().toString(36).slice(2, 10)}`;
  const projects = new Map<string, { id: number; fullName: string }>();
  const requests: { fullName: string; number: number; branch: string; author: string; fromFork: boolean; sha: string }[] = [];
  let nextId = 1;
  const bareOf = (fullName: string) => join(root, `${fullName}.git`);
  const git = (fullName: string, args: string[], options: { input?: string; env?: Record<string, string> } = {}) =>
    execFileSync("git", args, { cwd: bareOf(fullName), env: { ...process.env, ...ENV, ...options.env }, input: options.input, encoding: "utf8" }).trim();
  const head = (fullName: string, branch: string) => {
    try {
      return git(fullName, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    } catch {
      return null;
    }
  };
  const branches = (fullName: string) => (git(fullName, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]) || "").split("\n").filter(Boolean);
  const tags = (fullName: string) => (git(fullName, ["for-each-ref", "--format=%(refname:short)", "refs/tags"]) || "").split("\n").filter(Boolean);
  const buildTree = (fullName: string, base: string | null, files: [string, string][]) => {
    const scratch = mkdtempSync(join(root, ".index-"));
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    try {
      if (base) git(fullName, ["read-tree", base], { env });
      for (const [path, content] of files) {
        const blob = git(fullName, ["hash-object", "-w", "--stdin"], { input: content });
        git(fullName, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
      }
      return git(fullName, ["write-tree"], { env });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  const commit = (fullName: string, tree: string, parents: string[], message: string, author?: { name: string; email: string }) =>
    git(fullName, ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-F", "-"], { input: message, env: author ? { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email } : {} });

  const forge: StandInForge = {
    kind,
    webUrl: "",
    host: "",
    token,
    calls: [],
    hooks: new Map(),
    organization: true,
    installationAccount: SIGNED_IN_AS.github,
    addRepo(fullName, options = {}) {
      mkdirSync(bareOf(fullName), { recursive: true });
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", bareOf(fullName)], { env: { ...process.env, ...ENV } });
      projects.set(fullName, { id: nextId++, fullName });
      if (options.withCommit || options.tagOnly) {
        const first = commit(fullName, buildTree(fullName, null, [["README.md", "already here\n"]]), [], "someone's first commit");
        git(fullName, ["update-ref", options.tagOnly ? "refs/tags/v1" : "refs/heads/main", first]);
      }
    },
    read(fullName) {
      const tip = head(fullName, "main");
      if (!tip) return { files: {}, commits: [] };
      const paths = git(fullName, ["ls-tree", "-r", "--name-only", tip]).split("\n").filter(Boolean);
      const files = Object.fromEntries(paths.map((p) => [p, git(fullName, ["show", `${tip}:${p}`])]));
      const commits = git(fullName, ["log", "--format=%s%x09%an%x09%P", tip]).split("\n").map((line) => {
        const [subject, author, parents] = line.split("\t");
        return { subject: subject!, author: author!, parents: parents ? parents.split(" ").filter(Boolean).length : 0 };
      });
      return { files, commits };
    },
    openRequest(fullName, request) {
      forge.pushAside(fullName, request.branch);
      const number = requests.filter((r) => r.fullName === fullName).length + 1;
      requests.push({ fullName, number, branch: request.branch, author: request.author, fromFork: Boolean(request.fromFork), sha: head(fullName, request.branch)! });
      return number;
    },
    pushAside(fullName, branch) {
      const tip = head(fullName, branch);
      git(fullName, ["update-ref", `refs/heads/${branch}`, commit(fullName, buildTree(fullName, tip, [["ASIDE.md", "pushed aside\n"]]), tip ? [tip] : [], "pushed aside")]);
    },
    close: () => new Promise((resolve) => server.close(() => (rmSync(root, { recursive: true, force: true }), resolve()))),
  };

  const authorized = (req: IncomingMessage) => {
    const header = req.headers.authorization ?? "";
    if (header === `Bearer ${token}`) return true;
    const basic = /^Basic (.+)$/.exec(header);
    return Boolean(basic && Buffer.from(basic[1]!, "base64").toString().split(":")[1] === token);
  };

  const project = (idOrPath: string) => {
    const found = /^[0-9]+$/.test(idOrPath) ? [...projects.values()].find((p) => p.id === Number(idOrPath)) : projects.get(decodeURIComponent(idOrPath));
    if (!found) throw new Answer(404, { message: "404 Project Not Found" });
    return found;
  };
  const cloneUrl = (fullName: string) => `${forge.webUrl}/${fullName}.git`;

  const gitlab = (method: string, path: string, query: URLSearchParams, body: Record<string, unknown>): [number, unknown] => {
    if (method === "GET" && path === "/user") return [200, { id: 1, username: SIGNED_IN_AS.gitlab }];
    if (method === "GET" && path === "/projects") return [200, [...projects.values()].reverse().map((p) => ({ id: p.id, path_with_namespace: p.fullName, http_url_to_repo: cloneUrl(p.fullName), empty_repo: branches(p.fullName).length === 0 }))];
    if (method === "POST" && path === "/projects") {
      const fullName = `${body.namespace_id ? "acme-group" : "ada-gl"}/${String(body.path)}`;
      if (projects.has(fullName)) throw new Answer(400, { message: { path: ["has already been taken"] } });
      forge.addRepo(fullName);
      const p = projects.get(fullName)!;
      return [201, { id: p.id, path_with_namespace: fullName, http_url_to_repo: cloneUrl(fullName) }];
    }
    const ns = /^\/namespaces\/(.+)$/.exec(path);
    if (method === "GET" && ns) return decodeURIComponent(ns[1]!) === "acme-group" ? [200, { id: 900, full_path: "acme-group" }] : [404, { message: "404 Namespace Not Found" }];
    const m = /^\/projects\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) throw new Answer(404, { message: "404 Not Found" });
    const p = project(m[1]!);
    const rest = m[2] ?? "";
    if (method === "GET" && rest === "") return [200, { id: p.id, path_with_namespace: p.fullName, empty_repo: branches(p.fullName).length === 0, default_branch: branches(p.fullName)[0] ?? null }];
    if (method === "GET" && rest === "/repository/branches") return [200, branches(p.fullName).slice(0, Number(query.get("per_page") ?? 20)).map((name) => ({ name }))];
    if (method === "GET" && rest === "/repository/tags") return [200, tags(p.fullName).slice(0, Number(query.get("per_page") ?? 20)).map((name) => ({ name }))];
    if (method === "POST" && rest === "/repository/commits") {
      const branch = String(body.branch);
      const tip = head(p.fullName, branch);
      const actions = body.actions as { action: string; file_path: string; content: string }[];
      const tree = buildTree(p.fullName, tip, actions.map((a) => [a.file_path, a.content]));
      const sha = commit(p.fullName, tree, tip ? [tip] : [], String(body.commit_message), { name: String(body.author_name), email: String(body.author_email) });
      git(p.fullName, ["update-ref", `refs/heads/${branch}`, sha]);
      return [201, { id: sha, parent_ids: tip ? [tip] : [] }];
    }
    if (method === "POST" && rest === "/hooks") {
      forge.hooks.set(p.fullName, body);
      return [201, { id: 1 }];
    }
    if (method === "DELETE" && rest === "/hooks/1" && forge.hooks.delete(p.fullName)) return [204, null];
    const mr = /^\/merge_requests\/([0-9]+)$/.exec(rest);
    const opened = mr && requests.find((r) => r.fullName === p.fullName && r.number === Number(mr[1]));
    if (method === "GET" && opened) {
      return [200, { iid: opened.number, source_branch: opened.branch, source_project_id: opened.fromFork ? 999 : p.id, target_project_id: p.id, author: { username: opened.author }, sha: opened.sha, web_url: `${forge.webUrl}/${p.fullName}/-/merge_requests/${opened.number}`, state: "opened" }];
    }
    throw new Answer(404, { message: "404 Not Found" });
  };

  const github = (method: string, path: string, query: URLSearchParams, body: Record<string, unknown>): [number, unknown] => {
    if (method === "GET" && /^\/app\/installations\/[0-9]+$/.test(path)) return [200, { id: Number(path.split("/").pop()), account: { login: forge.installationAccount }, suspended_at: null }];
    if (method === "POST" && /^\/app\/installations\/[0-9]+\/access_tokens$/.test(path)) return [201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() }];
    if (method === "GET" && path === "/user/installations") return [200, { total_count: 1, installations: [{ id: INSTALLATION_ID, account: { login: SIGNED_IN_AS.github, type: forge.organization ? "Organization" : "User" } }] }];
    if (method === "GET" && path === "/installation/repositories") return [200, { repositories: [...projects.values()].map((p) => ({ full_name: p.fullName, clone_url: cloneUrl(p.fullName), size: branches(p.fullName).length ? 1 : 0 })) }];
    const org = /^\/orgs\/([^/]+)\/repos$/.exec(path);
    if (method === "POST" && org) {
      if (!forge.organization) throw new Answer(404, { message: "Not Found" });
      const fullName = `${decodeURIComponent(org[1]!)}/${String(body.name)}`;
      if (projects.has(fullName)) throw new Answer(422, { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] });
      forge.addRepo(fullName);
      return [201, { full_name: fullName, clone_url: cloneUrl(fullName) }];
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) throw new Answer(404, { message: "Not Found" });
    const p = project(`${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`);
    const rest = m[3] ?? "";
    const empty = branches(p.fullName).length === 0;
    if (method === "GET" && rest === "") return [200, { full_name: p.fullName, default_branch: "main" }];
    if (method === "GET" && rest === "/branches") return [200, branches(p.fullName).slice(0, Number(query.get("per_page") ?? 30)).map((name) => ({ name }))];
    if (method === "GET" && rest === "/tags") return [200, tags(p.fullName).slice(0, Number(query.get("per_page") ?? 30)).map((name) => ({ name }))];
    const contents = /^\/contents\/(.+)$/.exec(rest);
    if (method === "PUT" && contents) {
      const branch = String(body.branch ?? "main");
      const tip = head(p.fullName, branch);
      const file = decodeURIComponent(contents[1]!);
      if (tip && git(p.fullName, ["ls-tree", "--name-only", tip, file])) throw new Answer(422, { message: "\"sha\" wasn't supplied." });
      const tree = buildTree(p.fullName, tip, [[file, Buffer.from(String(body.content), "base64").toString()]]);
      const author = body.author as { name: string; email: string };
      const sha = commit(p.fullName, tree, tip ? [tip] : [], String(body.message), author);
      git(p.fullName, ["update-ref", `refs/heads/${branch}`, sha]);
      return [201, { commit: { sha, tree: { sha: tree }, parents: tip ? [{ sha: tip }] : [] } }];
    }
    // GitHub's Git Data API refuses a repository with no commit at all.
    if (empty && rest.startsWith("/git/")) throw new Answer(409, { message: "Git Repository is empty." });
    if (method === "POST" && rest === "/git/trees") {
      const entries = body.tree as { path: string; content: string }[];
      return [201, { sha: buildTree(p.fullName, String(body.base_tree), entries.map((e) => [e.path, e.content])) }];
    }
    if (method === "POST" && rest === "/git/commits") {
      return [201, { sha: commit(p.fullName, String(body.tree), body.parents as string[], String(body.message), body.author as { name: string; email: string }) }];
    }
    const ref = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
    if (method === "PATCH" && ref) {
      const branch = decodeURIComponent(ref[1]!);
      const tip = head(p.fullName, branch);
      const sha = String(body.sha);
      const forward = tip !== null && git(p.fullName, ["merge-base", tip, sha]) === tip;
      if (!forward && body.force !== true) throw new Answer(422, { message: "Update is not a fast forward" });
      git(p.fullName, ["update-ref", `refs/heads/${branch}`, sha]);
      return [200, { object: { sha } }];
    }
    if (method === "POST" && rest === "/hooks") {
      forge.hooks.set(p.fullName, body);
      return [201, { id: 1 }];
    }
    if (method === "DELETE" && rest === "/hooks/1" && forge.hooks.delete(p.fullName)) return [204, null];
    const pull = /^\/pulls\/([0-9]+)$/.exec(rest);
    const opened = pull && requests.find((r) => r.fullName === p.fullName && r.number === Number(pull[1]));
    if (method === "GET" && opened) {
      return [200, { number: opened.number, head: { ref: opened.branch, sha: opened.sha, repo: { full_name: opened.fromFork ? `${opened.author}/fork` : p.fullName } }, base: { repo: { full_name: p.fullName } }, user: { login: opened.author }, html_url: `${forge.webUrl}/${p.fullName}/pull/${opened.number}`, state: "open" }];
    }
    throw new Answer(404, { message: "Not Found" });
  };

  /** git's own smart HTTP, read-only, through git http-backend. */
  const gitHttp = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.searchParams.get("service") === "git-receive-pack" || url.pathname.endsWith("/git-receive-pack")) {
      res.writeHead(403);
      res.end();
      return;
    }
    const header = (name: string) => (typeof req.headers[name] === "string" ? (req.headers[name] as string) : "");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        ...ENV,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: header("content-type"),
        REMOTE_ADDR: "127.0.0.1",
        ...(header("content-length") ? { CONTENT_LENGTH: header("content-length") } : {}),
        ...(header("git-protocol") ? { GIT_PROTOCOL: header("git-protocol") } : {}),
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    req.pipe(child.stdin);
    let headBuf = Buffer.alloc(0);
    let started = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (started) return void res.write(chunk);
      headBuf = Buffer.concat([headBuf, chunk]);
      const text = headBuf.toString("latin1");
      const end = text.search(/\r?\n\r?\n/);
      if (end < 0) return;
      const separator = text.slice(end).startsWith("\r\n\r\n") ? 4 : 2;
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
      res.write(headBuf.subarray(end + separator));
    });
    child.stdout.on("end", () => res.end());
  };

  const signIn = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    const redirect = (to: string) => {
      res.writeHead(302, { location: to });
      res.end();
    };
    if (kind === "gitlab" && req.method === "GET" && url.pathname === "/oauth/authorize") {
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", "stand-in-code");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      redirect(back.toString());
      return true;
    }
    if (kind === "github" && req.method === "GET" && /^\/apps\/[^/]+\/installations\/new$/.test(url.pathname) && callback) {
      const back = new URL(callback);
      for (const [k, v] of Object.entries({ code: "stand-in-code", installation_id: String(INSTALLATION_ID), setup_action: "install", state: url.searchParams.get("state") ?? "" })) back.searchParams.set(k, v);
      redirect(back.toString());
      return true;
    }
    const tokenPath = kind === "gitlab" ? "/oauth/token" : "/login/oauth/access_token";
    if (req.method === "POST" && (url.pathname === tokenPath || url.pathname === "/oauth/revoke")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(url.pathname === "/oauth/revoke" ? {} : { access_token: token, refresh_token: "stand-in-refresh", expires_in: 7200, token_type: "bearer" }));
      return true;
    }
    return false;
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (signIn(req, res, url)) return;
    if (!url.pathname.startsWith("/api/")) {
      if (!authorized(req)) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="stand-in"' });
        return void res.end();
      }
      return gitHttp(req, res, url);
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const path = url.pathname.replace(kind === "gitlab" ? /^\/api\/v4/ : /^\/api/, "");
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      forge.calls.push({ method: req.method ?? "GET", path, body });
      let status: number;
      let payload: unknown;
      try {
        // Only minting an installation token is done with the app's own credential.
        if (!authorized(req) && !path.startsWith("/app/")) throw new Answer(401, { message: "401 Unauthorized" });
        [status, payload] = (kind === "gitlab" ? gitlab : github)(req.method ?? "GET", path, url.searchParams, body);
      } catch (err) {
        if (!(err instanceof Answer)) throw err;
        [status, payload] = [err.status, err.body];
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 204 ? undefined : JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const bound = (server.address() as AddressInfo).port;
  forge.webUrl = `http://127.0.0.1:${bound}`;
  forge.host = `127.0.0.1:${bound}`;
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return forge;
}
