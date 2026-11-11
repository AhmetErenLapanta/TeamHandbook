import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { principalOf, setupFirstOwner } from "../accounts.js";
import { mirrorDir } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import { connectRepo, gitAccess } from "../connect.js";
import { providerFor } from "../propose.js";
import { requestForPushedBranch } from "./pushed.js";
import { openSqliteStore } from "../store.js";
import type { RepoRecord } from "../store.js";
import { createVault } from "../vault.js";
import { startStandInForge } from "./stand-in-forge.js";
import { createOwnCliForge, ownCliGraphQL, ownCliStatus, OwnCliRefused } from "./own-cli.js";
import type { CliForge, CliResult, CliRun } from "./own-cli.js";
import type { ChangeRequest, ForgeConfig } from "./types.js";
import { copyOf } from "../test-fixtures.js";

const IDENTITY = ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" }).trim();

/**
 * The team's repository as a bare "origin" on this machine, and the orchestrator's mirror of it:
 * made once for the file and copied for each test, as making them runs a git process at every step.
 */
async function repositories() {
  const { root, made } = await copyOf("own-cli:origin", "own-cli-", async (at) => {
    const seed = join(at, "seed");
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "README.md"), "skills\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "first");
    const origin = join(at, "origin.git");
    execFileSync("git", ["clone", "-q", "--bare", seed, origin]);
    const mirror = join(at, "mirror.git");
    execFileSync("git", ["clone", "-q", "--bare", origin, mirror]);
    return { origin, mirror, head: git(mirror, "rev-parse", "HEAD") };
  });
  const { origin, mirror, head } = made;
  const repo: RepoRecord = { tenant: "solo", id: "skills", team: "Me", name: "skills", url: `file://${origin}`, head, error: null, syncedAt: null } as RepoRecord;
  return { root, origin, mirror, repo, head };
}

/** A stand-in gh or glab: answers from `answers` by its first two arguments and records every call. */
function cli(answers: Record<string, Partial<CliResult>>) {
  const calls: { tool: string; args: string[]; input?: string }[] = [];
  const run: CliRun = async (tool, args, input) => {
    calls.push({ tool, args, ...(input ? { input } : {}) });
    return { code: 0, stdout: "", stderr: "", missing: false, ...answers[`${tool} ${args.slice(0, 2).join(" ")}`] };
  };
  return { run, calls };
}

const change = (head: string): ChangeRequest => ({ title: "Add the retry skill", body: "Adds a skill for retrying.", branch: "handbook/add-retry", baseSha: head, files: [{ path: "skills/retry/SKILL.md", content: "# Retry\n" }], author: { name: "Ada Lovelace", email: "ada@example.invalid" }, assignment: { reviewers: ["grace"], labels: ["skills"] } });

/** git's settings for a repository on this machine, as gitAccess gives them for one on a forge: only its protocol allowed. */
const FILE_ONLY = async () => ({ GIT_ALLOW_PROTOCOL: "file" });

const GITHUB: ForgeConfig & { kind: CliForge } = { repoId: "skills", kind: "github", apiUrl: "https://api.github.com", project: "acme/skills" };
const GITLAB: ForgeConfig & { kind: CliForge } = { repoId: "skills", kind: "gitlab", apiUrl: "https://gitlab.com/api/v4", project: "acme/skills" };

describe("a request opened with the person's own gh or glab", () => {
  it("given gh signed in, when a change is opened, then git pushes the branch as the person and gh opens the pull request, with no token anywhere", async () => {
    const { root, origin, mirror, repo, head } = await repositories();
    const { run, calls } = cli({ "gh pr create": { stdout: "https://github.com/acme/skills/pull/7\n" } });

    const opened = await createOwnCliForge(GITHUB, root, () => mirror, FILE_ONLY, run).open(repo, change(head));

    expect(opened).toMatchObject({ number: 7, url: "https://github.com/acme/skills/pull/7", branch: "handbook/add-retry" });
    expect(git(origin, "log", "-1", "--format=%an|%s", "refs/heads/handbook/add-retry")).toBe("Ada Lovelace|Add the retry skill");
    const create = calls.find((c) => c.args[0] === "pr")!;
    expect(create.args).toEqual(["pr", "create", "--repo", "acme/skills", "--head", "handbook/add-retry", "--base", "main", "--title", "Add the retry skill", "--body-file", "-", "--reviewer", "grace", "--label", "skills"]);
    expect(create.input).toBe("Adds a skill for retrying.");
    expect(JSON.stringify(calls)).not.toMatch(/token/i);
  });

  it("given gh not installed, when a change is opened, then it says to install it and how to sign in, and nothing is pushed", async () => {
    const { root, origin, mirror, repo, head } = await repositories();
    const { run } = cli({ "gh auth status": { code: 1, missing: true } });

    await expect(createOwnCliForge(GITHUB, root, () => mirror, FILE_ONLY, run).open(repo, change(head))).rejects.toThrow(/gh is not installed.*gh auth login --hostname/);
    expect(git(origin, "branch", "--list", "handbook/*")).toBe("");
  });

  it("given glab not signed in, when a change is opened, then it says which command signs in, and nothing is pushed", async () => {
    const { root, origin, mirror, repo, head } = await repositories();
    const { run } = cli({ "glab auth status": { code: 1 } });

    const refused = await createOwnCliForge(GITLAB, root, () => mirror, FILE_ONLY, run).open(repo, change(head)).catch((err: Error) => err);
    expect(refused).toBeInstanceOf(OwnCliRefused);
    expect((refused as Error).message).toContain("glab auth login --hostname");
    expect(git(origin, "branch", "--list", "handbook/*")).toBe("");
  });

  it("given the branch already on the forge, when a change is opened, then it is refused before anything is pushed or opened", async () => {
    const { root, origin, mirror, repo, head } = await repositories();
    git(origin, "update-ref", "refs/heads/handbook/add-retry", head);
    const { run, calls } = cli({});

    await expect(createOwnCliForge(GITHUB, root, () => mirror, FILE_ONLY, run).open(repo, change(head))).rejects.toThrow(/already exists/);
    expect(calls.some((c) => c.args[0] === "pr")).toBe(false);
  });

  it("given glab refusing to open the merge request, when a change is opened, then the pushed branch is taken back and glab's reason is said", async () => {
    const { root, origin, mirror, repo, head } = await repositories();
    const { run } = cli({ "glab mr create": { code: 1, stderr: "403 Forbidden: you cannot create merge requests here" } });

    await expect(createOwnCliForge(GITLAB, root, () => mirror, FILE_ONLY, run).open(repo, change(head))).rejects.toThrow(/cannot create merge requests here; the branch was removed again/);
    expect(git(origin, "branch", "--list", "handbook/*")).toBe("");
  });

  it("given glab opening the merge request but naming it only on stderr, when a change is opened, then its number is read from there and the branch stays", async () => {
    const { root, origin, mirror, repo, head } = await repositories();
    const { run } = cli({ "glab mr create": { stderr: "Creating merge request...\nhttps://gitlab.com/acme/skills/-/merge_requests/12\n" } });

    expect(await createOwnCliForge(GITLAB, root, () => mirror, FILE_ONLY, run).open(repo, change(head))).toMatchObject({ number: 12, url: "https://gitlab.com/acme/skills/-/merge_requests/12" });
    expect(git(origin, "branch", "--list", "handbook/*")).toBe("handbook/add-retry");
  });

  it("given gh opening the pull request with an answer that names no address, when a change is opened, then the request is read back by its branch and the branch stays", async () => {
    const { root, origin, mirror, repo, head } = await repositories();
    const { run, calls } = cli({ "gh pr view": { stdout: JSON.stringify({ number: 9, url: "https://github.com/acme/skills/pull/9" }) } });

    expect(await createOwnCliForge(GITHUB, root, () => mirror, FILE_ONLY, run).open(repo, change(head))).toMatchObject({ number: 9, url: "https://github.com/acme/skills/pull/9" });
    expect(calls.at(-1)!.args).toEqual(["pr", "view", "handbook/add-retry", "--repo", "acme/skills", "--json", "number,url"]);
    expect(git(origin, "branch", "--list", "handbook/*")).toBe("handbook/add-retry");
  });

  it("given gh opening the pull request and then not naming it at all, when a change is opened, then it says the request opened unnumbered, and the branch stays rather than closing it", async () => {
    const { root, origin, mirror, repo, head } = await repositories();
    const { run } = cli({ "gh pr view": { code: 1 } });

    await expect(createOwnCliForge(GITHUB, root, () => mirror, FILE_ONLY, run).open(repo, change(head))).rejects.toThrow(/opened a request for handbook\/add-retry in skills, but its number was not read/);
    expect(git(origin, "branch", "--list", "handbook/*")).toBe("handbook/add-retry");
  });

  it("given git's settings for the repository allowing only https, when a change to a file address is opened, then git is held to them and nothing is pushed or opened", async () => {
    const { root, origin, mirror, repo, head } = await repositories();
    const { run, calls } = cli({});

    await expect(createOwnCliForge(GITHUB, root, () => mirror, async () => ({ GIT_ALLOW_PROTOCOL: "https" }), run).open(repo, change(head))).rejects.toThrow(/git did not reach skills/);
    expect(git(origin, "branch", "--list", "handbook/*")).toBe("");
    expect(calls.some((c) => c.args[0] === "pr")).toBe(false);
  });

  it("given no settings for reaching the repository, when a change is opened, then it is refused before git reaches anything", async () => {
    const { root, origin, mirror, repo, head } = await repositories();
    const { run } = cli({});

    await expect(createOwnCliForge(GITHUB, root, () => mirror, async () => null, run).open(repo, change(head))).rejects.toBeInstanceOf(OwnCliRefused);
    expect(git(origin, "branch", "--list", "handbook/*")).toBe("");
  });

  it("given gh answering a request's state with something other than JSON, when its state is read, then it is refused as the CLI's answer, not a parse error", async () => {
    const { root, mirror, repo } = await repositories();
    const { run } = cli({ "gh pr view": { stdout: "Unknown JSON field: mergedAt" } });

    await expect(createOwnCliForge(GITHUB, root, () => mirror, FILE_ONLY, run).status!(repo, 7)).rejects.toThrow(/answered request 7's state with something other than JSON/);
  });

  it("given a merged pull request, when its state is read, then gh's answer says merged with its time", async () => {
    const { root, mirror, repo } = await repositories();
    const { run, calls } = cli({ "gh pr view": { stdout: JSON.stringify({ state: "MERGED", mergedAt: "2026-11-02T12:00:00Z", headRefOid: "e".repeat(40) }) } });

    expect(await createOwnCliForge(GITHUB, root, () => mirror, FILE_ONLY, run).status!(repo, 7)).toEqual({ status: "merged", mergedAt: "2026-11-02T12:00:00.000Z", headSha: "e".repeat(40) });
    expect(calls.at(-1)!.args).toContain("state,mergedAt,headRefOid");
  });
});

describe("a request for a branch the runner already pushed, opened with the person's own gh", () => {
  const pushedOn = (origin: string, head: string) => {
    const sha = git(origin, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "the runner's commit");
    git(origin, "update-ref", "refs/heads/handbook/pushed", sha);
    return sha;
  };
  const pushed = (head: string) => ({ title: "Add the pushed skill", body: "Written on the person's machine.", branch: "handbook/pushed", baseSha: head });

  it("given the branch on the forge and gh signed in, when its request is opened, then gh opens it from that branch at its head, and the branch is left as pushed", async () => {
    const { root, origin, mirror, repo, head } = await repositories();
    const sha = pushedOn(origin, head);
    const { run, calls } = cli({ "gh pr create": { stdout: "https://github.com/acme/skills/pull/11\n" } });

    const opened = await createOwnCliForge(GITHUB, root, () => mirror, FILE_ONLY, run).openForBranch!(repo, pushed(head));

    expect(opened).toEqual({ number: 11, url: "https://github.com/acme/skills/pull/11", branch: "handbook/pushed", headSha: sha });
    expect(calls.find((c) => c.args[0] === "pr")!.args.slice(0, 8)).toEqual(["pr", "create", "--repo", "acme/skills", "--head", "handbook/pushed", "--base", "main"]);
    expect(git(origin, "rev-parse", "refs/heads/handbook/pushed")).toBe(sha);
  });

  it("given gh refusing the request, when it is opened for a pushed branch, then gh's reason is said and the branch stays, since it is the person's work", async () => {
    const { root, origin, mirror, repo, head } = await repositories();
    const sha = pushedOn(origin, head);
    const { run } = cli({ "gh pr create": { code: 1, stderr: "a pull request for branch already exists" } });

    await expect(createOwnCliForge(GITHUB, root, () => mirror, FILE_ONLY, run).openForBranch!(repo, pushed(head))).rejects.toThrow(/already exists; the branch stays as it was pushed/);
    expect(git(origin, "rev-parse", "refs/heads/handbook/pushed")).toBe(sha);
  });

  it("given no such branch on the forge, when its request is opened, then it is refused before gh is asked to open anything", async () => {
    const { root, mirror, repo, head } = await repositories();
    const { run, calls } = cli({});

    await expect(createOwnCliForge(GITHUB, root, () => mirror, FILE_ONLY, run).openForBranch!(repo, pushed(head))).rejects.toThrow(/handbook\/pushed is not in skills; the runner pushes it first/);
    expect(calls.some((c) => c.args[0] === "pr")).toBe(false);
  });

  it("given local mode and gh not signed in, when the orchestrator asks for the request of a pushed branch, then it gets GitHub's own page that opens it, filled in, with the command that signs in", async () => {
    const bin = mkdtempSync(join(tmpdir(), "own-gh-"));
    writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "gh"), 0o755);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
    const store = openSqliteStore(":memory:");
    const repo = await store.upsertRepo({ tenant: "acme", id: "skills", team: "Payments", name: "skills", url: "https://github.com/acme/skills.git" });
    await store.setForgeConfig("acme", GITHUB);
    const ctx = { store, dataDir: mkdtempSync(join(tmpdir(), "own-cli-pushed-")), tenant: "acme", allowedHosts: null, vault: null, ownForgeCli: true, addedRepos: new Map([["skills", { id: "skills", forge: "github" as const, kind: "skills" as const, skillsFrom: null, gitOrigin: "https://github.com", memberUrl: null, addedBy: "ada@example.invalid", addedAt: "2026-11-03T00:00:00.000Z", viaOwnCli: true }]]) } as OrchestratorContext;

    const answer = await requestForPushedBranch(ctx, repo, { title: "t", body: "b", branch: "handbook/pushed", baseSha: "a".repeat(40) }).finally(() => vi.unstubAllEnvs());

    expect(answer).toEqual({ createUrl: "https://github.com/acme/skills/compare/main...handbook/pushed?expand=1", reason: expect.stringContaining("gh auth login --hostname github.com") });
  });
});

describe("a new commit on a request's branch, pushed with the person's own sign-in", () => {
  const onForge = (origin: string, head: string) => {
    const sha = git(origin, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "the runner's commit");
    git(origin, "update-ref", "refs/heads/handbook/pushed", sha);
    return sha;
  };
  const update = (expectedHead: string) => ({ files: [{ path: "skills/retry/SKILL.md", content: "# Retry, revised\n" }], title: "Address the review", author: { name: "Ada Lovelace", email: "ada@example.invalid" }, expectedHead });

  it("given the branch on the forge still at the head the change was prepared on, when it is updated, then a commit on that head is pushed as the person and the branch moves forward", async () => {
    const { root, origin, mirror, repo, head } = await repositories();
    const pushed = onForge(origin, head);

    const { headSha } = await createOwnCliForge(GITHUB, root, () => mirror, FILE_ONLY, cli({}).run).updateBranch!(repo, "handbook/pushed", update(pushed));

    expect(git(origin, "rev-parse", "refs/heads/handbook/pushed")).toBe(headSha);
    expect(git(origin, "log", "-1", "--format=%P|%an|%s", headSha)).toBe(`${pushed}|Ada Lovelace|Address the review`);
  });

  it("given the branch moved on the forge since, when it is updated, then it is refused and the forge keeps the commit that moved it", async () => {
    const { root, origin, mirror, repo, head } = await repositories();
    const pushed = onForge(origin, head);
    const moved = git(origin, "commit-tree", `${pushed}^{tree}`, "-p", pushed, "-m", "someone else");
    git(origin, "update-ref", "refs/heads/handbook/pushed", moved);

    await expect(createOwnCliForge(GITHUB, root, () => mirror, FILE_ONLY, cli({}).run).updateBranch!(repo, "handbook/pushed", update(pushed))).rejects.toThrow(/moved since the change was prepared/);
    expect(git(origin, "rev-parse", "refs/heads/handbook/pushed")).toBe(moved);
  });
});

describe("whom the person's own gh or glab is signed in as", () => {
  it("given gh signed in, when its state is read, then it names the login it is signed in as and nothing else of the account", async () => {
    const { run, calls } = cli({ "gh api --hostname": { stdout: JSON.stringify({ login: "ada-l", email: "ada@example.invalid", name: "Ada Lovelace" }) } });

    const status = await ownCliStatus("github", "github.com", run);

    expect(status).toMatchObject({ tool: "gh", installed: true, signedIn: true, account: "ada-l", login: "gh auth login --hostname github.com" });
    expect(JSON.stringify(status)).not.toContain("example.invalid");
    expect(calls.at(-1)!.args).toEqual(["api", "--hostname", "github.com", "user"]);
  });

  it("given glab signed in to a self-managed GitLab, when its state is read, then its username is the account", async () => {
    const { run } = cli({ "glab api --hostname": { stdout: JSON.stringify({ username: "ada-gl", email: "ada@example.invalid" }) } });
    expect((await ownCliStatus("gitlab", "git.example.invalid", run)).account).toBe("ada-gl");
  });

  it("given gh not installed, not signed in, or answering with no login it can name, when its state is read, then no account is named and gh is not asked for one when signed out", async () => {
    const missing = cli({ "gh auth status": { code: 1, missing: true } });
    const signedOut = cli({ "gh auth status": { code: 1 } });
    const odd = cli({ "gh api --hostname": { stdout: JSON.stringify({ login: "<script>" }) } });

    expect(await ownCliStatus("github", "github.com", missing.run)).toMatchObject({ installed: false, signedIn: false, account: null, install: "https://cli.github.com" });
    expect(await ownCliStatus("github", "github.com", signedOut.run)).toMatchObject({ installed: true, signedIn: false, account: null });
    expect(signedOut.calls.some((c) => c.args[0] === "api")).toBe(false);
    expect((await ownCliStatus("github", "github.com", odd.run)).account).toBeNull();
  });
});

describe("what the person's own gh or glab can do, asked of it", () => {
  it("given gh that reports its version and can be git's credential helper, when its state is read, then both are said, asked side by side with whether it is signed in", async () => {
    const { run, calls } = cli({ "gh --version": { stdout: "gh version 2.62.0 (2024-11-14)\nhttps://github.com/cli/cli/releases/tag/v2.62.0\n" } });

    expect(await ownCliStatus("github", "github.com", run)).toMatchObject({ version: "2.62.0", helper: true });
    expect(calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual(expect.arrayContaining(["auth status", "--version", "auth git-credential"]));
  });

  it("given glab too old to be git's credential helper, or not installed, when its state is read, then it says it cannot hand git the sign-in", async () => {
    const old = cli({ "glab --version": { stdout: "glab version 1.22.0 (2022-01-01)\n" }, "glab auth git-credential": { code: 1, stderr: "unknown command \"git-credential\" for \"glab auth\"" } });
    const missing = cli({ "glab auth status": { code: 1, missing: true }, "glab --version": { code: 1, missing: true }, "glab auth git-credential": { code: 1, missing: true } });

    expect(await ownCliStatus("gitlab", "gitlab.com", old.run)).toMatchObject({ version: "1.22.0", helper: false });
    expect(await ownCliStatus("gitlab", "gitlab.com", missing.run)).toMatchObject({ installed: false, version: null, helper: false });
  });

  it("given gh too old to know a field the orchestrator reads, when a request's state is read, then it says to update gh rather than repeating gh's words", async () => {
    const { root, mirror, repo } = await repositories();
    const { run } = cli({ "gh pr view": { code: 1, stderr: "Unknown JSON field: \"headRefOid\"" } });

    await expect(createOwnCliForge(GITHUB, root, () => mirror, FILE_ONLY, run).status!(repo, 7)).rejects.toThrow("gh did not read request 7: your gh does not know what the orchestrator asks of it; update it (https://cli.github.com), then try again");
  });
});

describe("fetching a repository with the person's own sign-in", () => {
  it("given a repository connected with no token in local mode, when git's settings for a fetch are made, then git asks gh for credentials and is handed no header of the orchestrator's", async () => {
    const repo = { tenant: "solo", id: "skills", team: "Me", name: "skills", url: "https://github.com/acme/skills.git", head: null, error: null, syncedAt: null } as RepoRecord;
    const ctx = {
      store: {} as never,
      tenant: "solo",
      vault: null,
      resolveHost: async () => ["140.82.112.3"],
      addedRepos: new Map([["skills", { id: "skills", forge: "github" as const, kind: "skills" as const, skillsFrom: null, gitOrigin: "https://github.com", memberUrl: null, addedBy: "me@example.invalid", addedAt: "2026-11-02T12:00:00.000Z", viaOwnCli: true }]]),
    };

    const access = (await gitAccess(ctx, repo))!;

    const settings = Object.fromEntries(Array.from({ length: Number(access.env.GIT_CONFIG_COUNT) }, (_, n) => [access.env[`GIT_CONFIG_KEY_${n}`], access.env[`GIT_CONFIG_VALUE_${n}`]]).reverse());
    expect(Object.values(access.env)).toContain("!gh auth git-credential");
    expect(Object.keys(settings).some((k) => k!.endsWith(".extraHeader"))).toBe(false);
    expect(access.secrets).toEqual([]);
  });
});

describe("connecting a repository with no token in local mode", () => {
  afterEach(() => vi.unstubAllEnvs());

  /** A stand-in glab on PATH: it hands git the stand-in forge's token as the person's sign-in, and answers a merge request's state. */
  function ownGlab(token: string): void {
    const bin = mkdtempSync(join(tmpdir(), "own-glab-"));
    const script = [
      "#!/bin/sh",
      'case "$1 $2" in',
      `  "auth git-credential") cat >/dev/null; printf 'username=oauth2\\npassword=${token}\\n' ;;`,
      '  "auth status") exit 0 ;;',
      `  "mr view") printf '{"state":"merged","merged_at":"2026-11-02T12:00:00Z"}' ;;`,
      "  *) exit 1 ;;",
      "esac",
    ].join("\n");
    writeFileSync(join(bin, "glab"), `${script}\n`);
    chmodSync(join(bin, "glab"), 0o755);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
  }

  async function orchestrator(ownForgeCli: boolean) {
    const store = openSqliteStore(":memory:");
    const ctx: OrchestratorContext = { store, dataDir: join(mkdtempSync(join(tmpdir(), "own-cli-connect-")), "data"), tenant: "acme", allowedHosts: null, vault: createVault(randomBytes(32)), addedRepos: new Map(), privateNetworkForges: true, ownForgeCli };
    const owner = await principalOf(store, await setupFirstOwner(store, "acme", "setup-code", { code: "setup-code", email: "ada@example.invalid", password: "correct horse battery" }));
    return { ctx, owner };
  }

  it("given local mode and the person's glab signed in, when a GitLab repository is connected with no token, then git reads it with glab's sign-in, its forge is kept, no secret is stored, and its requests go through glab", async () => {
    const forge = await startStandInForge("gitlab");
    try {
      forge.addRepo("acme/skills", { withCommit: true });
      ownGlab(forge.token);
      const { ctx, owner } = await orchestrator(true);

      const repo = await connectRepo(ctx, owner, { forge: "gitlab", url: `${forge.webUrl}/acme/skills.git`, team: "Payments" });

      expect(ctx.addedRepos!.get("skills")).toMatchObject({ viaOwnCli: true });
      expect(await ctx.store.getForgeConfig("acme", "skills")).toMatchObject({ kind: "gitlab", project: "acme/skills" });
      expect(await ctx.store.listSecrets("acme", "")).toEqual([]);
      expect(existsSync(mirrorDir(ctx, "skills"))).toBe(true);
      expect(await (await providerFor(ctx, repo))!.status!(repo, 3)).toEqual({ status: "merged", mergedAt: "2026-11-02T12:00:00.000Z" });
    } finally {
      await forge.close();
    }
  });

  it("given an orchestrator not in local mode, when a GitLab repository is connected with no token, then it is refused as before and nothing is kept", async () => {
    const { ctx, owner } = await orchestrator(false);

    await expect(connectRepo({ ...ctx, resolveHost: async () => ["203.0.113.10"] }, owner, { forge: "gitlab", url: "https://gitlab.example.invalid/acme/skills.git", team: "Payments" })).rejects.toThrow(/enter a token/);
    expect(await ctx.store.getRepo("acme", "skills")).toBeNull();
  });
});

describe("GitHub's GraphQL read with the person's own gh", () => {
  const QUERY = "query($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { projectsV2(first: $first) { nodes { title } } } }";

  it("given gh signed in, when a query is read, then gh posts that one query with its strings as -f and its numbers as -F, and the data comes back", async () => {
    const { run, calls } = cli({ "gh api --hostname": { stdout: JSON.stringify({ data: { repository: { projectsV2: { nodes: [{ title: "Roadmap" }] } } } }) } });

    const data = await ownCliGraphQL<{ repository: unknown }>("github.com", QUERY, { owner: "acme", name: "skills", first: 20 }, run);

    expect(data).toEqual({ repository: { projectsV2: { nodes: [{ title: "Roadmap" }] } } });
    expect(calls.at(-1)!.args).toEqual(["api", "--hostname", "github.com", "graphql", "-f", `query=${QUERY}`, "-f", "owner=acme", "-f", "name=skills", "-F", "first=20"]);
  });

  it("given a mutation, a subscription, the word mutation anywhere, or a string that gh would read as a file, when it is read, then it is refused before gh is asked anything", async () => {
    const { run, calls } = cli({});

    for (const doc of ["mutation { addStar(input: {}) { clientMutationId } }", "subscription { x }", "query { viewer { login } } # then a mutation", "{ viewer { login } }\nmutation M { x }"]) {
      await expect(ownCliGraphQL("github.com", doc, {}, run)).rejects.toBeInstanceOf(OwnCliRefused);
    }
    await expect(ownCliGraphQL("github.com", QUERY, { owner: "@/etc/hosts" }, run)).rejects.toThrow(/starts with @, which gh reads as a file/);
    expect(calls).toEqual([]);
  });

  it("given gh answering an error, when a query is read, then it fails with gh's reason rather than an empty answer", async () => {
    const { run } = cli({ "gh api --hostname": { code: 1, stderr: "HTTP 401: Bad credentials" } });

    await expect(ownCliGraphQL("github.com", QUERY, { owner: "acme", name: "skills", first: 20 }, run)).rejects.toMatchObject({ status: 401 });
  });
});
