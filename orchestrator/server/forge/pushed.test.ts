import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import { openSqliteStore } from "../store.js";
import { forgeTokenName } from "../propose.js";
import { createVault, storeSecret } from "../vault.js";
import type { CliResult, CliRun } from "./own-cli.js";
import { dropFromRequest, openRequestOnForge, originRequest, remoteForge, requestForPushedBranch, requestOnForge, updateRequestBranch } from "./pushed.js";
import { principalOf, setupFirstOwner } from "../accounts.js";
import { copyOf } from "../test-fixtures.js";
import { plainGitServer } from "./stand-in-git.js";

const IDENTITY = ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" }).trim();

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

/** A stand-in glab: answers by its first two arguments and records every call. */
function glab(answers: Record<string, Partial<CliResult>>) {
  const calls: string[][] = [];
  const run: CliRun = async (_tool, args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "", missing: false, ...answers[args.slice(0, 2).join(" ")] };
  };
  return { run, calls };
}

/**
 * The person's clone, read by path, with a branch their runner pushed into it, and its origin:
 * a bare repository behind `web`, or the address given.
 */
async function personsClone(origin: (web: string, root: string) => string | null) {
  const root = mkdtempSync(join(tmpdir(), "pushed-"));
  const served = join(root, "served");
  mkdirSync(join(served, "acme"), { recursive: true });
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "skills\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "first");
  const forgeRepo = join(served, "acme", "skills.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, forgeRepo]);
  const web = await plainGitServer(served, servers);
  const clone = join(root, "clone");
  execFileSync("git", ["clone", "-q", forgeRepo, clone]);
  const remote = origin(web, root);
  if (remote) git(clone, "remote", "set-url", "origin", remote);
  else git(clone, "remote", "remove", "origin");
  const base = git(clone, "rev-parse", "main");
  const head = git(clone, "commit-tree", "main^{tree}", "-p", base, "-m", "the runner's commit");
  git(clone, "update-ref", "refs/heads/handbook/pushed", head);

  const store = openSqliteStore(":memory:");
  const repo = await store.upsertRepo({ tenant: "solo", id: "skills", team: "Me", name: "skills", url: clone });
  const ctx = {
    store,
    dataDir: join(root, "data"),
    tenant: "solo",
    allowedHosts: null,
    vault: createVault(randomBytes(32)),
    ownForgeCli: true,
    privateNetworkForges: true,
    resolveHost: async () => ["127.0.0.1"],
    forgeApps: { gitlab: { kind: "gitlab" as const, webUrl: web, apiUrl: `${web}/api/v4`, clientId: "stand-in", clientSecret: "stand-in-secret" } },
  } as OrchestratorContext;
  return { ctx, repo, clone, forgeRepo, web, base, head };
}

const pushed = (base: string) => ({ title: "Add the pushed skill", body: "Written on the person's machine.", branch: "handbook/pushed", baseSha: base });

describe("a request for a branch pushed into a repository read by path, at the task's end", () => {
  it("given glab signed in and an origin on GitLab over https, when the request is asked for, then only the local request is recorded, and nothing is pushed or asked of glab", async () => {
    const { ctx, repo, forgeRepo, base, head } = await personsClone((w) => `${w}/acme/skills.git`);
    const { run, calls } = glab({});

    const answer = await requestForPushedBranch(ctx, repo, pushed(base), run);

    expect(answer).toEqual({ opened: { number: 1, url: "local://requests/skills/1", branch: "handbook/pushed", headSha: head } });
    expect(git(forgeRepo, "branch", "--list", "handbook/*")).toBe("");
    expect(calls).toEqual([]);
  });
});

describe("the request on a path repository's GitLab origin, when the person asks for it", () => {
  it("given glab signed in, when it is asked for, then the branch is pushed to the origin with the person's sign-in and opened there", async () => {
    const { ctx, repo, clone, forgeRepo, web, base, head } = await personsClone((w) => `${w}/acme/skills.git`);
    const { run, calls } = glab({ "mr create": { stdout: `${web}/acme/skills/-/merge_requests/4\n` } });

    const answer = await originRequest(ctx, clone, repo, pushed(base), run);

    expect(answer).toEqual({ opened: { number: 4, url: `${web}/acme/skills/-/merge_requests/4`, branch: "handbook/pushed", headSha: head } });
    expect(git(forgeRepo, "rev-parse", "refs/heads/handbook/pushed")).toBe(head);
    expect(calls.find((c) => c[0] === "mr")!.slice(0, 8)).toEqual(["mr", "create", "--repo", "acme/skills", "--source-branch", "handbook/pushed", "--target-branch", "main"]);
  });

  it("given glab not signed in, when it is asked for, then nothing is pushed and GitLab's own page that opens it comes back with the command that signs in", async () => {
    const { ctx, repo, clone, forgeRepo, web, base } = await personsClone((w) => `${w}/acme/skills.git`);
    const { run } = glab({ "auth status": { code: 1 } });

    const answer = await originRequest(ctx, clone, repo, pushed(base), run);

    expect(answer).toEqual({ createUrl: `${web}/acme/skills/-/merge_requests/new?merge_request%5Bsource_branch%5D=handbook%2Fpushed&merge_request%5Btarget_branch%5D=main`, reason: expect.stringContaining("glab auth login --hostname 127.0.0.1") });
    expect(git(forgeRepo, "branch", "--list", "handbook/*")).toBe("");
  });

  it("given glab refusing the merge request, when it is asked for, then the pushed branch stays and the page that opens it comes back with glab's reason", async () => {
    const { ctx, repo, clone, forgeRepo, base, head } = await personsClone((w) => `${w}/acme/skills.git`);
    const { run } = glab({ "mr create": { code: 1, stderr: "403 Forbidden" } });

    const answer = await originRequest(ctx, clone, repo, pushed(base), run);

    expect(answer).toEqual({ createUrl: expect.stringContaining("merge_requests/new"), reason: expect.stringContaining("403 Forbidden") });
    expect(git(forgeRepo, "rev-parse", "refs/heads/handbook/pushed")).toBe(head);
  });

  it("given an origin reached over ssh, when it is asked for, then the page comes back with the push to run, since an ssh push is not held to an address judged here", async () => {
    const { ctx, repo, clone, base } = await personsClone(() => "git@gitlab.com:acme/skills.git");
    const { run, calls } = glab({});

    const answer = await originRequest(ctx, clone, repo, pushed(base), run);

    expect(answer).toEqual({ createUrl: "https://gitlab.com/acme/skills/-/merge_requests/new?merge_request%5Bsource_branch%5D=handbook%2Fpushed&merge_request%5Btarget_branch%5D=main", reason: expect.stringContaining("git push origin handbook/pushed") });
    expect(calls).toEqual([]);
  });

  it("given a clone with no origin, or an orchestrator more than one person reaches, when it is asked for, then there is none and glab is not asked", async () => {
    const none = await personsClone(() => null);
    expect(await originRequest(none.ctx, none.clone, none.repo, pushed(none.base), glab({}).run)).toBeNull();

    const team = await personsClone((w) => `${w}/acme/skills.git`);
    const { run, calls } = glab({});
    expect(await originRequest({ ...team.ctx, ownForgeCli: false }, team.clone, team.repo, pushed(team.base), run)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("a path repository's request opened on its forge because the person pressed for it", () => {
  /** The person's clone with its local request open at the task's end, as the orchestrator checked it, and its one account. */
  async function opened(origin: (web: string, root: string) => string | null) {
    const made = await personsClone(origin);
    const ada = await principalOf(made.ctx.store, await setupFirstOwner(made.ctx.store, "solo", "setup-code", { code: "setup-code", email: "ada@example.invalid", password: "correct horse battery" }));
    const answer = await requestForPushedBranch(made.ctx, made.repo, pushed(made.base));
    if (!("opened" in answer)) throw new Error("no local request");
    const request = { ...answer.opened, tenant: "solo", repoId: made.repo.id, title: "Add the pushed skill", status: "open" as const, provider: "local" as const, createdAt: new Date().toISOString(), createdBy: "ada@example.invalid", checkedHead: made.head };
    await made.ctx.store.saveRequest(request);
    return { ...made, request, ada };
  }

  it("given glab signed in and a GitLab origin, when the person presses, then the branch is pushed and the merge request opened there, and a second press answers the same one without asking glab again", async () => {
    const { ctx, repo, request, forgeRepo, web, head, ada } = await opened((w) => `${w}/acme/skills.git`);
    const { run, calls } = glab({ "mr create": { stdout: `${web}/acme/skills/-/merge_requests/12\n` } });
    expect(await requestOnForge(ctx, repo, request.number)).toEqual({ forge: "gitlab", url: null, number: null });

    const first = await openRequestOnForge(ctx, repo, request, ada, run);
    const asked = calls.length;
    const second = await openRequestOnForge(ctx, repo, request, ada, run);

    expect(first).toEqual({ number: 12, url: `${web}/acme/skills/-/merge_requests/12` });
    expect(second).toEqual(first);
    expect(calls.length).toBe(asked);
    expect(git(forgeRepo, "rev-parse", "refs/heads/handbook/pushed")).toBe(head);
    expect(await requestOnForge(ctx, repo, request.number)).toEqual({ forge: "gitlab", ...first });
  });

  it("given the branch moved after the orchestrator checked it, when the person presses, then it is refused as moved and nothing is pushed", async () => {
    const { ctx, repo, request, clone, forgeRepo, ada } = await opened((w) => `${w}/acme/skills.git`);
    git(clone, "update-ref", "refs/heads/handbook/pushed", git(clone, "commit-tree", "main^{tree}", "-p", request.headSha, "-m", "not checked"));
    const { run, calls } = glab({});

    const pressing = openRequestOnForge(ctx, repo, request, ada, run);

    await expect(pressing).rejects.toMatchObject({ code: "moved", status: 409 });
    expect(calls).toEqual([]);
    expect(git(forgeRepo, "branch", "--list", "handbook/*")).toBe("");
  });

  it("given an origin reached over ssh, when the person presses, then nothing is pushed and the refusal carries GitLab's own page that opens it", async () => {
    const { ctx, repo, request, ada } = await opened(() => "git@gitlab.com:acme/skills.git");

    const pressing = openRequestOnForge(ctx, repo, request, ada, glab({}).run);

    await expect(pressing).rejects.toMatchObject({ code: "not-opened", status: 409, createUrl: expect.stringContaining("https://gitlab.com/acme/skills/-/merge_requests/new") });
  });

  it("given an orchestrator more than one person reaches, when the request is read and pressed, then no button is offered and the press is refused before glab is asked", async () => {
    const { ctx, repo, request, ada } = await opened((w) => `${w}/acme/skills.git`);
    const team = { ...ctx, ownForgeCli: false };
    const { run, calls } = glab({});

    expect(await requestOnForge(team, repo, request.number)).toEqual({ forge: null, url: null, number: null });
    await expect(openRequestOnForge(team, repo, request, ada, run)).rejects.toMatchObject({ code: "not-one-person", status: 409 });
    expect(calls).toEqual([]);
  });
});

describe("the forge a remote is on, as the screen names its request", () => {
  it("given remotes on GitLab, GitHub, the organization's own GitLab and elsewhere, when each is read, then GitLab and GitHub are named and the rest is none", () => {
    const ctx = { forgeApps: { gitlab: { kind: "gitlab" as const, webUrl: "https://git.acme.invalid", apiUrl: "https://git.acme.invalid/api/v4", clientId: "c", clientSecret: "s" } } };

    const named = ["git@gitlab.com:acme/alpha.git", "https://github.com/acme/beta.git", "https://git.acme.invalid/payments/gamma.git", "https://git.example.invalid/acme/delta.git", "https://github.com/acme"].map((remote) => remoteForge(ctx, remote));

    expect(named).toEqual(["gitlab", "github", "gitlab", null, null]);
  });
});

describe("a request for a branch a runner pushed to a repository connected with a token", () => {
  /** A GitHub that has the runner's branch and answers the pull request with `pull`. */
  async function connectedGitHub(pull: { status: number; body: unknown }) {
    const posted: unknown[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const answer =
          req.method === "GET" && req.url === "/repos/acme/skills/git/ref/heads/handbook/pushed" ? { status: 200, body: { object: { sha: "d".repeat(40) } } }
          : req.method === "GET" && req.url === "/repos/acme/skills" ? { status: 200, body: { default_branch: "main" } }
          : req.method === "POST" && req.url === "/repos/acme/skills/pulls" ? (posted.push(JSON.parse(raw)), pull)
          : { status: 404, body: { message: "Not Found" } };
        res.statusCode = answer.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(answer.body));
      });
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const store = openSqliteStore(":memory:");
    const vault = createVault(randomBytes(32));
    const repo = await store.upsertRepo({ tenant: "acme", id: "skills", team: "Payments", name: "skills", url: "https://github.example.invalid/acme/skills.git" });
    const config = { repoId: "skills", kind: "github" as const, apiUrl, project: "acme/skills" };
    await store.setForgeConfig("acme", config);
    await storeSecret(store, vault, "acme", forgeTokenName(config), "stand-in-token", "ada@example.invalid");
    const ctx = { store, vault, tenant: "acme", dataDir: mkdtempSync(join(tmpdir(), "pushed-token-")), allowedHosts: null, addedRepos: new Map() } as unknown as OrchestratorContext;
    return { ctx, repo, posted };
  }

  it("given GitHub opening it, when the request is asked for, then the pull request is opened with the repository's token from the branch as pushed", async () => {
    const { ctx, repo, posted } = await connectedGitHub({ status: 201, body: { number: 5, html_url: "https://github.example.invalid/acme/skills/pull/5" } });

    const answer = await requestForPushedBranch(ctx, repo, pushed("a".repeat(40)));

    expect(answer).toEqual({ opened: { number: 5, url: "https://github.example.invalid/acme/skills/pull/5", branch: "handbook/pushed", headSha: "d".repeat(40) } });
    expect(posted).toEqual([{ title: "Add the pushed skill", head: "handbook/pushed", base: "main", body: "Written on the person's machine." }]);
  });

  it("given GitHub refusing the pull request, when the request is asked for, then GitHub's own page that opens it comes back with GitHub's reason, since the branch is there", async () => {
    const { ctx, repo } = await connectedGitHub({ status: 403, body: { message: "Resource not accessible by integration" } });

    const answer = await requestForPushedBranch(ctx, repo, pushed("a".repeat(40)));

    expect(answer).toEqual({ createUrl: "https://github.example.invalid/acme/skills/compare/main...handbook/pushed?expand=1", reason: expect.stringContaining("Resource not accessible by integration") });
  });
});

describe("a pushed branch with nothing past the base", () => {
  it("given a runner that pushed its branch at the task's base itself, when its request is asked for, then it is refused, since it would read as merged at once", async () => {
    const { ctx, repo, clone, base } = await personsClone(() => null);
    git(clone, "update-ref", "refs/heads/handbook/empty", base);
    await expect(requestForPushedBranch(ctx, repo, { ...pushed(base), branch: "handbook/empty" }, glab({}).run)).rejects.toThrow(/has no commit beyond the one the task started from/);
  });
});

describe("updating a request's branch for a task a runner leases", () => {
  it("given a runner that no longer holds the task, when the branch is to be updated, then it is refused and the branch is not touched", async () => {
    const { ctx, repo, clone, head } = await personsClone(() => null);
    await expect(updateRequestBranch(ctx, repo, "handbook/pushed", { files: [{ path: "x.md", content: "x\n" }], title: "t", author: { name: "Ada", email: "ada@example.invalid" }, expectedHead: head }, async () => false)).rejects.toThrow(/no longer holds the task/);
    expect(git(clone, "rev-parse", "refs/heads/handbook/pushed")).toBe(head);
  });

  it("given a runner that holds the task, when the branch of a repository read by path is updated, then the local forge moves it forward", async () => {
    const { ctx, repo, clone, head } = await personsClone(() => null);
    const { headSha } = await updateRequestBranch(ctx, repo, "handbook/pushed", { files: [{ path: "x.md", content: "x\n" }], title: "Address the review", author: { name: "Ada", email: "ada@example.invalid" }, expectedHead: head }, async () => true);
    expect(git(clone, "rev-parse", "refs/heads/handbook/pushed")).toBe(headSha);
    expect(git(clone, "rev-parse", `${headSha}^`)).toBe(head);
  });
});


describe("a file taken out of an open request", () => {
  /**
   * A team repository on this machine whose request branch changes README.md and adds skills/new.md
   * on top of the task's base: made once for the file and copied for each test.
   */
  async function request() {
    const { root, made } = await copyOf("pushed:drop", "drop-", async (at) => {
      const seed = join(at, "seed");
      mkdirSync(join(seed, "skills"), { recursive: true });
      git(seed, "init", "-q", "-b", "main");
      writeFileSync(join(seed, "README.md"), "skills\n");
      writeFileSync(join(seed, "skills", "kept.md"), "kept\n");
      git(seed, "add", ".");
      git(seed, "commit", "-q", "-m", "first");
      const base = git(seed, "rev-parse", "HEAD");
      git(seed, "switch", "-q", "-c", "handbook/task");
      writeFileSync(join(seed, "README.md"), "skills, as the task left them\n");
      writeFileSync(join(seed, "skills", "new.md"), "new\n");
      git(seed, "add", ".");
      git(seed, "commit", "-q", "-m", "the task's change");
      // The repository's own HEAD stays on main, as a team repository's does; the request's branch is not checked out.
      git(seed, "switch", "-q", "main");
      const bare = join(at, "skills.git");
      execFileSync("git", ["clone", "-q", "--bare", seed, bare]);
      return { bare, base, head: git(bare, "rev-parse", "handbook/task") };
    });
    const store = openSqliteStore(":memory:");
    const ctx: OrchestratorContext = { store, dataDir: join(root, "data"), tenant: "solo" };
    const repo = await store.upsertRepo({ tenant: "solo", id: "skills", team: "Me", name: "skills", url: made.bare });
    return { ctx, repo, ...made };
  }

  it("given a request that changes a file, when that file is taken out, then one commit by the orchestrator puts it back as the base held it and leaves the rest of the change", async () => {
    const { ctx, repo, bare, base, head } = await request();

    const dropped = await dropFromRequest(ctx, repo, { branch: "handbook/task", path: "README.md", baseSha: base, expectedHead: head });

    expect(dropped).toEqual({ head: git(bare, "rev-parse", "handbook/task") });
    expect(git(bare, "rev-parse", "handbook/task^")).toBe(head);
    expect(git(bare, "log", "-1", "--format=%s|%an", "handbook/task")).toBe("Drop README.md from the request|TeamHandbook Orchestrator");
    expect(git(bare, "show", "handbook/task:README.md")).toBe("skills");
    expect(git(bare, "show", "handbook/task:skills/new.md")).toBe("new");
  });

  it("given a request that adds a file, when it is taken out, then the branch no longer holds it", async () => {
    const { ctx, repo, bare, base, head } = await request();

    const dropped = await dropFromRequest(ctx, repo, { branch: "handbook/task", path: "skills/new.md", baseSha: base, expectedHead: head });

    expect(dropped).toHaveProperty("head");
    expect(git(bare, "ls-tree", "--name-only", "-r", "handbook/task")).toBe("README.md\nskills/kept.md");
  });

  it("given a path the request does not change, or a branch that moved since it was read, when it is taken out, then no commit is made and each says why", async () => {
    const { ctx, repo, bare, base, head } = await request();

    const untouched = await dropFromRequest(ctx, repo, { branch: "handbook/task", path: "skills/kept.md", baseSha: base, expectedHead: head });
    const stale = await dropFromRequest(ctx, repo, { branch: "handbook/task", path: "README.md", baseSha: base, expectedHead: base });

    expect(untouched).toMatchObject({ code: "not-on-branch" });
    expect(stale).toMatchObject({ code: "moved" });
    expect(git(bare, "rev-parse", "handbook/task")).toBe(head);
  });

  it("given a path that climbs out, reaches into .git in any case, or a commit id that is not whole, when it is taken out, then it is refused and the branch does not move", async () => {
    const { ctx, repo, bare, base, head } = await request();

    for (const path of ["../outside", ".git/config", ".GIT/hooks/post-merge", "skills/../README.md", ""]) {
      expect(await dropFromRequest(ctx, repo, { branch: "handbook/task", path, baseSha: base, expectedHead: head })).toMatchObject({ code: "refused" });
    }
    expect(await dropFromRequest(ctx, repo, { branch: "handbook/task", path: "README.md", baseSha: base.slice(0, 7), expectedHead: head })).toMatchObject({ code: "refused" });
    expect(git(bare, "rev-parse", "handbook/task")).toBe(head);
  });
});
