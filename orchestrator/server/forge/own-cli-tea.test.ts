import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { principalOf, setupFirstOwner } from "../accounts.js";
import type { OrchestratorContext } from "../app.js";
import { connectRepo } from "../connect.js";
import { openSqliteStore } from "../store.js";
import type { RepoRecord } from "../store.js";
import { createVault } from "../vault.js";
import { ForgeHttpError } from "./http.js";
import { createOwnCliForge, ownCliReader, ownCliStatus, OwnCliRefused } from "./own-cli.js";
import type { CliForge, CliResult, CliRun } from "./own-cli.js";
import { plainGitServer } from "./stand-in-git.js";
import type { ChangeRequest, ForgeConfig } from "./types.js";

const IDENTITY = ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" }).trim();

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

const GITEA: ForgeConfig & { kind: CliForge } = { repoId: "skills", kind: "gitea", apiUrl: "http://127.0.0.1/api/v1", project: "acme/skills" };
const HTTP_ONLY = async () => ({ GIT_ALLOW_PROTOCOL: "http" });
const BRANCH = "handbook/add-retry";

/** The team's repository served over git's HTTP on this machine, as a Gitea's would be, and the orchestrator's mirror of it. */
async function repository() {
  const root = mkdtempSync(join(tmpdir(), "own-tea-"));
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "skills\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "first");
  mkdirSync(join(root, "served", "acme"), { recursive: true });
  const origin = join(root, "served", "acme", "skills.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin]);
  const mirror = join(root, "mirror.git");
  execFileSync("git", ["clone", "-q", "--bare", origin, mirror]);
  const web = await plainGitServer(join(root, "served"), servers);
  const host = new URL(web).host;
  const repo = { tenant: "solo", id: "skills", team: "Me", name: "skills", url: `${web}/acme/skills.git`, head: git(mirror, "rev-parse", "HEAD"), error: null, syncedAt: null } as RepoRecord;
  return { origin, mirror, repo, host, head: repo.head! };
}

interface Login {
  name: string;
  url: string;
  user: string;
}

/**
 * A stand-in tea: its logins as `tea login list --output json` lists them, its version line with the
 * terminal colours tea writes even into a pipe, and `tea api` answers by path, always exit 0 with the
 * status on stderr as `-i` writes it. Every call is recorded.
 */
function tea(o: { logins: Login[]; version?: string; api?: (path: string, method: string, input?: string) => { status: number; body: unknown } | undefined; create?: Partial<CliResult> }) {
  const calls: { tool: string; args: string[]; input?: string }[] = [];
  const ok = (stdout: string, stderr = ""): CliResult => ({ code: 0, stdout, stderr, missing: false });
  const run: CliRun = async (tool, args, input) => {
    calls.push({ tool, args, ...(input ? { input } : {}) });
    if (tool !== "tea") return { code: 1, stdout: "", stderr: "", missing: true };
    if (args[0] === "--version") return ok(`Version: \x1b[1m${o.version ?? "0.16.0"}\x1b[0m\tgolang: 1.22.5\n`);
    if (args[0] === "login" && args[1] === "list") return ok(JSON.stringify(o.logins.map((l) => ({ name: l.name, url: l.url, ssh_host: "", user: l.user, default: "false" }))));
    if (args[0] === "api") {
      const method = args.includes("-X") ? args[args.indexOf("-X") + 1]! : "GET";
      const answer = o.api?.(args.at(-1)!, method, input) ?? { status: 404, body: { message: "Not Found" } };
      return ok(JSON.stringify(answer.body), `HTTP/1.1 ${answer.status} Stand In\n`);
    }
    // tea prints the request as markdown, its description included: a link there names another request.
    if (args[0] === "pulls" && args[1] === "create") return { ...ok("# Add the retry skill\n\nSee http://127.0.0.1/acme/skills/pulls/12 for the first try.\n"), ...o.create };
    return { code: 1, stdout: "", stderr: "unknown command", missing: false };
  };
  return { run, calls };
}

const change = (head: string, reviewers: string[] = ["grace"]): ChangeRequest => ({
  title: "Add the retry skill",
  body: "Adds a skill for retrying.\n\nSee /acme/skills/pulls/12 for the first try.",
  branch: BRANCH,
  baseSha: head,
  files: [{ path: "skills/retry/SKILL.md", content: "# Retry\n" }],
  author: { name: "Ada Lovelace", email: "ada@example.invalid" },
  assignment: { reviewers, labels: ["skills"] },
});

/** The open pull requests Gitea lists: an older one on another branch, and the one tea just opened. */
const listed = (host: string) => [
  { number: 12, html_url: `http://${host}/acme/skills/pulls/12`, head: { ref: "handbook/first-try" } },
  { number: 7, html_url: `http://${host}/acme/skills/pulls/7`, head: { ref: BRANCH } },
];

describe("a request opened with the person's own tea", () => {
  it("given tea signed in to the repository's host and port among logins for others, when a change is opened, then git pushes the branch, tea opens it naming that login, its number is read back by the branch, and the reviewers are asked for after", async () => {
    const { origin, mirror, repo, host, head } = await repository();
    const reviewers: unknown[] = [];
    const { run, calls } = tea({
      logins: [
        { name: "work", url: "https://gitea.example.invalid", user: "ada" },
        { name: "other-port", url: `http://${host.replace(/:\d+$/, ":1")}`, user: "ada" },
        { name: "mine", url: `http://${host}`, user: "ada" },
      ],
      api: (path, method, input) => {
        if (method === "GET" && path === "repos/acme/skills/pulls?state=open&limit=50") return { status: 200, body: listed(host) };
        if (method === "POST" && path === "repos/acme/skills/pulls/7/requested_reviewers") {
          reviewers.push(JSON.parse(input!));
          return { status: 201, body: [] };
        }
        return undefined;
      },
    });

    const opened = await createOwnCliForge(GITEA, mkdtempSync(join(tmpdir(), "own-tea-work-")), () => mirror, HTTP_ONLY, run).open(repo, change(head));

    expect(opened).toMatchObject({ number: 7, url: `http://${host}/acme/skills/pulls/7`, branch: BRANCH });
    expect(opened).not.toHaveProperty("notes");
    expect(git(origin, "log", "-1", "--format=%an|%s", `refs/heads/${BRANCH}`)).toBe("Ada Lovelace|Add the retry skill");
    const create = calls.find((c) => c.args[0] === "pulls")!;
    expect(create.args).toEqual(["pulls", "create", "--login=mine", "--repo", "acme/skills", "--head", BRANCH, "--base", "main", "--title", "Add the retry skill", "--description-file", "-", "--labels", "skills"]);
    expect(create.input).toBe(change(head).body);
    expect(calls.filter((c) => c.args[0] === "api").map((c) => c.args.slice(0, 3))).toEqual([
      ["api", "-i", "--login=mine"],
      ["api", "-i", "--login=mine"],
    ]);
    expect(reviewers).toEqual([{ reviewers: ["grace"] }]);
  });

  it("given Gitea refusing the reviewers, when a change is opened, then the request is still returned, with the refusal beside it", async () => {
    const { mirror, repo, host, head } = await repository();
    const { run } = tea({
      logins: [{ name: "mine", url: `http://${host}`, user: "ada" }],
      api: (path, method) => {
        if (method === "GET") return { status: 200, body: listed(host) };
        return { status: 422, body: { message: "grace is not a collaborator" } };
      },
    });

    const opened = await createOwnCliForge(GITEA, mkdtempSync(join(tmpdir(), "own-tea-work-")), () => mirror, HTTP_ONLY, run).open(repo, change(head));

    expect(opened.number).toBe(7);
    expect(opened.notes).toEqual([expect.stringMatching(/^reviewers were not added: .*grace is not a collaborator/)]);
  });

  it("given two tea logins for the repository's host, when a change is opened, then it is refused naming both, and nothing is pushed or opened", async () => {
    const { origin, mirror, repo, host, head } = await repository();
    const { run, calls } = tea({ logins: [{ name: "mine", url: `http://${host}`, user: "ada" }, { name: "mine-too", url: `http://${host}/`, user: "ada" }] });

    const opening = createOwnCliForge(GITEA, mkdtempSync(join(tmpdir(), "own-tea-work-")), () => mirror, HTTP_ONLY, run).open(repo, change(head));

    await expect(opening).rejects.toThrow(/tea holds 2 logins for .* \(mine, mine-too\); keep one/);
    expect(git(origin, "branch", "--list", BRANCH)).toBe("");
    expect(calls.some((c) => c.args[0] === "pulls")).toBe(false);
  });

  it("given tea signed in only to the same host on another port, when a change is opened, then it is not signed in there and says how to sign in", async () => {
    const { mirror, repo, host, head } = await repository();
    const { run } = tea({ logins: [{ name: "other-port", url: `http://${host.replace(/:\d+$/, ":1")}`, user: "ada" }] });

    const opening = createOwnCliForge(GITEA, mkdtempSync(join(tmpdir(), "own-tea-work-")), () => mirror, HTTP_ONLY, run).open(repo, change(head));

    await expect(opening).rejects.toThrow(new OwnCliRefused(`Gitea's tea is not signed in to ${host}; sign in with \`tea login add --url https://${host}\`, then try again`));
  });

  it("given tea older than 0.15.0, when a change is opened, then it says to update tea, and nothing is pushed", async () => {
    const { origin, mirror, repo, host, head } = await repository();
    const { run } = tea({ version: "0.14.0", logins: [{ name: "mine", url: `http://${host}`, user: "ada" }] });

    const opening = createOwnCliForge(GITEA, mkdtempSync(join(tmpdir(), "own-tea-work-")), () => mirror, HTTP_ONLY, run).open(repo, change(head));

    await expect(opening).rejects.toThrow(/your tea is 0\.14\.0; the orchestrator needs 0\.15\.0 or later, update it/);
    expect(git(origin, "branch", "--list", BRANCH)).toBe("");
  });
});

describe("reading a Gitea request with the person's own tea", () => {
  it("given a merged pull request, which Gitea says is closed and merged, when its state is read, then it is merged with its time and head", async () => {
    const { mirror, repo, host } = await repository();
    const { run } = tea({ logins: [{ name: "mine", url: `http://${host}`, user: "ada" }], api: (path) => (path === "repos/acme/skills/pulls/7" ? { status: 200, body: { state: "closed", merged: true, merged_at: "2026-11-03T12:00:00Z", head: { sha: "a".repeat(40) } } } : undefined) });

    const state = await createOwnCliForge(GITEA, mkdtempSync(join(tmpdir(), "own-tea-work-")), () => mirror, HTTP_ONLY, run).status!(repo, 7);

    expect(state).toMatchObject({ status: "merged", mergedAt: "2026-11-03T12:00:00.000Z" });
  });

  it("given tea answering 404 with exit 0, as it does, when the API is read through it, then the read fails with that status, not as an answer", async () => {
    const { host } = await repository();
    const { run } = tea({ logins: [{ name: "mine", url: `http://${host}`, user: "ada" }] });

    const read = ownCliReader("gitea", host, run).request("GET", "/repos/acme/skills/pulls/99");

    await expect(read).rejects.toBeInstanceOf(ForgeHttpError);
    await expect(read).rejects.toMatchObject({ status: 404 });
  });

  it("given tea 0.16.0 with a login for the host, when its state is read, then its version comes out of the colours, it can be git's helper, and the account is the login's user, with no call to the forge", async () => {
    const { run, calls } = tea({ logins: [{ name: "mine", url: "https://git.example.invalid:3000", user: "ada" }] });

    const status = await ownCliStatus("gitea", "git.example.invalid:3000", run);

    expect(status).toMatchObject({ tool: "tea", installed: true, signedIn: true, account: "ada", version: "0.16.0", helper: true, login: "tea login add --url https://git.example.invalid:3000" });
    expect(calls.some((c) => c.args[0] === "api")).toBe(false);
  });
});

describe("connecting a Gitea repository on one person's machine with no tea there", () => {
  it("given tea not installed and a token entered, when a Gitea repository is connected, then it is reached with the token as before, not through tea", async () => {
    const { repo } = await repository();
    // A PATH holding git alone, so no tea of this machine's is found.
    const bin = mkdtempSync(join(tmpdir(), "no-tea-"));
    symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"));
    vi.stubEnv("PATH", bin);
    const store = openSqliteStore(":memory:");
    const ctx: OrchestratorContext = { store, dataDir: join(mkdtempSync(join(tmpdir(), "own-tea-connect-")), "data"), tenant: "acme", allowedHosts: null, vault: createVault(randomBytes(32)), addedRepos: new Map(), privateNetworkForges: true, ownForgeCli: true, resolveHost: async () => ["127.0.0.1"] };
    const owner = await principalOf(store, await setupFirstOwner(store, "acme", "setup-code", { code: "setup-code", email: "ada@example.invalid", password: "correct horse battery" }));

    await connectRepo(ctx, owner, { forge: "gitea", url: repo.url, token: "gitea-stand-in-token-0123456789", team: "Payments" });

    expect(ctx.addedRepos!.get("skills")).not.toHaveProperty("viaOwnCli");
    expect(await ctx.store.getForgeConfig("acme", "skills")).toMatchObject({ kind: "gitea", project: "acme/skills" });
    expect(await ctx.store.listSecrets("acme", "")).not.toEqual([]);
  });
});
