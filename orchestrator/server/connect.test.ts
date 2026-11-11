import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUser, principalOf, setupFirstOwner, startSession } from "./accounts.js";
import { createApp, mirrorDir, syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import { CSRF_HEADER, sessionCookie } from "./auth.js";
import type { Principal } from "./auth.js";
import { connectRepo, forgeDestination, gitAccess, gitTokenName, loadAddedRepos, offeredForges, yieldToFile } from "./connect.js";
import { ownCliHere } from "./forge/own-cli-here.js";
import { openSqliteStore } from "./store.js";
import { createVault, storeSecret } from "./vault.js";

const TENANT = "acme";
const CODE = "setup-code-for-tests";
const PASSWORD = "correct horse battery";
const TOKEN = "glpat-stand-in-token-0001";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  vi.unstubAllEnvs();
});

function teamRepo(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid", ...args], { cwd: dir });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "skills\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  return dir;
}

async function organization(): Promise<{ ctx: OrchestratorContext; owner: Principal; admin: Principal; member: Principal; root: string }> {
  const base = mkdtempSync(join(tmpdir(), "connect-"));
  const root = join(base, "repos");
  mkdirSync(root);
  const store = openSqliteStore(":memory:");
  const ctx: OrchestratorContext = { store, dataDir: join(base, "data"), tenant: TENANT, allowedHosts: null, vault: createVault(randomBytes(32)), configured: new Set(["listed"]), addedRepos: new Map(), localReposRoot: root, internalForgeHosts: new Set() };
  await store.upsertRepo({ tenant: TENANT, id: "listed", team: "Payments", name: "listed", url: join(base, "listed.git") });
  const owner = await principalOf(store, await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: PASSWORD }));
  const admin = await principalOf(store, await createUser(store, TENANT, new Set(["Payments"]), { email: "grace@example.invalid", role: "admin" }, owner));
  const member = await principalOf(store, await createUser(store, TENANT, new Set(["Payments"]), { email: "max@example.invalid", role: "member", teams: ["Payments"] }, owner));
  return { ctx, owner, admin, member, root };
}

/** A stand-in forge on this machine: records what each request carried and answers each one `status`. */
async function forge(status: number, location?: string): Promise<{ origin: string; seen: { url: string; headers: IncomingHttpHeaders }[] }> {
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    res.writeHead(status, { ...(location ? { location } : {}), "www-authenticate": 'Basic realm="stand-in"' });
    res.end();
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** The operator's leave to fetch from a stand-in forge on this machine, as ORCHESTRATOR_INTERNAL_FORGE_HOSTS gives it. */
function allowInside(ctx: OrchestratorContext, origin: string): void {
  (ctx.internalForgeHosts as Set<string>).add(new URL(origin).host);
}

async function sessionHeaders(ctx: OrchestratorContext, id: string) {
  const s = await startSession(ctx.store, TENANT, id);
  return { cookie: `${sessionCookie(TENANT)}=${s.token}`, [CSRF_HEADER]: s.csrf, "content-type": "application/json" };
}

describe("connecting a repository read by path", () => {
  it("given an admin and a repository under the operator's folder, when they connect it and then remove it, then it is read at once, listed as connected here, logged, and removed with nothing of it left", async () => {
    // given
    const { ctx, admin, root } = await organization();
    const path = teamRepo(root, "payments-skills");
    const app = createApp(ctx);
    const headers = await sessionHeaders(ctx, admin.id);

    // when
    const connected = await app.request("/api/repos", { method: "POST", headers, body: JSON.stringify({ forge: "path", url: path, team: "Payments" }) });
    const listed = (await (await app.request("/api/repos", { headers })).json()) as { repos: { id: string; source: string; head: string | null }[] };
    const removed = await app.request("/api/repos/payments-skills", { method: "DELETE", headers });

    // then
    expect([connected.status, removed.status]).toEqual([200, 200]);
    expect(listed.repos.map((r) => [r.id, r.source, Boolean(r.head)])).toEqual([["listed", "file", false], ["payments-skills", "orchestrator", true]]);
    expect(await ctx.store.getRepo(TENANT, "payments-skills")).toBeNull();
    expect(await loadAddedRepos(ctx.store, TENANT)).toEqual(new Map());
    expect(existsSync(mirrorDir(ctx, "payments-skills"))).toBe(false);
    const { events } = await ctx.store.eventPage(TENANT, {}, null, 10);
    expect(events.map((e) => e.kind).sort()).toEqual(["repo.connected", "repo.removed"]);
  });

  it("given a path outside the operator's folder, inside the orchestrator's data, or an orchestrator with no such folder, when each is connected, then each is refused and nothing is kept", async () => {
    // given
    const { ctx, owner } = await organization();
    const outside = teamRepo(mkdtempSync(join(tmpdir(), "elsewhere-")), "stray");
    const inData = teamRepo(ctx.dataDir, "own");
    const insideRoot = teamRepo(ctx.localReposRoot!, "fine");

    // when
    const attempts = await Promise.allSettled([
      connectRepo(ctx, owner, { forge: "path", url: outside, team: "Payments" }),
      connectRepo(ctx, owner, { forge: "path", url: join(ctx.localReposRoot!, "..", "data", "own"), team: "Payments" }),
      connectRepo({ ...ctx, localReposRoot: null }, owner, { forge: "path", url: insideRoot, team: "Payments" }),
      connectRepo({ ...ctx, localReposRoot: ctx.dataDir }, owner, { forge: "path", url: inData, team: "Payments" }),
    ]);

    // then
    expect(attempts.map((a) => (a.status === "rejected" ? (a.reason as { status: number }).status : 200))).toEqual([400, 400, 409, 400]);
    expect((await ctx.store.listRepos(TENANT)).map((r) => r.id)).toEqual(["listed"]);
  });
});

describe("a cloud orchestrator and paths", () => {
  it("given ORCHESTRATOR_MODE=cloud and a repository under the operator's folder, when it is connected by path, then it is refused, since the orchestrator's machine is no organization's", async () => {
    // given
    const { ctx, owner, root } = await organization();
    const path = teamRepo(root, "payments-skills");
    vi.stubEnv("ORCHESTRATOR_MODE", "cloud");

    // when
    const attempt = connectRepo(ctx, owner, { forge: "path", url: path, team: "Payments" }).finally(() => vi.unstubAllEnvs());

    // then
    await expect(attempt).rejects.toMatchObject({ status: 403, message: expect.stringContaining("not by a path") });
    expect((await ctx.store.listRepos(TENANT)).map((r) => r.id)).toEqual(["listed"]);
  });
});

describe("connecting a repository on a forge", () => {
  it("given a forge that turns the token down, when an owner connects a repository on it, then git sent the token only as that origin's header, and the refusal leaves no record, token, copy or event, and never repeats the token", async () => {
    // given
    const { ctx, owner } = await organization();
    const gitlab = await forge(401);
    allowInside(ctx, gitlab.origin);
    const app = createApp(ctx);

    // when
    const answer = await app.request("/api/repos", { method: "POST", headers: await sessionHeaders(ctx, owner.id), body: JSON.stringify({ forge: "gitlab", url: `${gitlab.origin}/payments/skills.git`, team: "Payments", token: TOKEN }) });
    const text = await answer.text();

    // then
    expect(answer.status).toBe(409);
    expect(text).toContain("not connected");
    expect(text).not.toContain(TOKEN);
    const authorized = gitlab.seen.filter((r) => r.headers.authorization);
    expect(authorized.length).toBeGreaterThan(0);
    for (const r of authorized) expect(r.headers.authorization).toBe(`Basic ${Buffer.from(`oauth2:${TOKEN}`).toString("base64")}`);
    for (const r of gitlab.seen) expect(r.url).not.toContain(TOKEN);
    expect(await ctx.store.getRepo(TENANT, "skills")).toBeNull();
    expect(await ctx.store.listSecrets(TENANT, "")).toEqual([]);
    expect(await ctx.store.getForgeConfig(TENANT, "skills")).toBeNull();
    expect(existsSync(mirrorDir(ctx, "skills"))).toBe(false);
    expect((await ctx.store.eventPage(TENANT, {}, null, 10)).events).toEqual([]);
  });

  it("given a forge that redirects elsewhere, when a repository on it is connected, then git does not follow, so the other address never sees a request or the token", async () => {
    // given
    const { ctx, owner } = await organization();
    const elsewhere = await forge(200);
    const gitlab = await forge(302, `${elsewhere.origin}/payments/skills.git/info/refs?service=git-upload-pack`);
    allowInside(ctx, gitlab.origin);

    // when
    const attempt = connectRepo(ctx, owner, { forge: "gitlab", url: `${gitlab.origin}/payments/skills.git`, team: "Payments", token: TOKEN });

    // then
    await expect(attempt).rejects.toMatchObject({ status: 409 });
    expect(gitlab.seen.length).toBeGreaterThan(0);
    expect(elsewhere.seen).toEqual([]);
  });

  it("given a member, a key, an id the file lists, a token in the address, an address that is not https, one read as an option, and no token, when each connects, then each is refused before anything is written or fetched", async () => {
    // given
    const { ctx, owner, member } = await organization();
    const gitlab = await forge(401);
    allowInside(ctx, gitlab.origin);
    const url = `${gitlab.origin}/payments/skills.git`;
    const key = { ...owner, key: { id: "k", owner: { kind: "user" as const, id: owner.id }, scopes: {} as never, expiresAt: null } };

    // when
    const attempts = await Promise.allSettled([
      connectRepo(ctx, member, { forge: "gitlab", url, team: "Payments", token: TOKEN }),
      connectRepo(ctx, key, { forge: "gitlab", url, team: "Payments", token: TOKEN }),
      connectRepo(ctx, owner, { forge: "gitlab", url, id: "listed", team: "Payments", token: TOKEN }),
      connectRepo(ctx, owner, { forge: "gitlab", url: url.replace("http://", `http://oauth2:${TOKEN}@`), team: "Payments", token: TOKEN }),
      connectRepo(ctx, owner, { forge: "gitlab", url: "http://gitlab.example.invalid/payments/skills.git", team: "Payments", token: TOKEN }),
      connectRepo(ctx, owner, { forge: "gitlab", url: "ext::sh -c touch% /tmp/pwned", team: "Payments", token: TOKEN }),
      connectRepo(ctx, owner, { forge: "gitlab", url: "--upload-pack=touch", team: "Payments", token: TOKEN }),
      connectRepo(ctx, owner, { forge: "gitlab", url, team: "Payments" }),
      connectRepo(ctx, owner, { forge: "github", url: "https://gitlab.example.invalid/payments/skills.git", team: "Payments", token: TOKEN }),
      connectRepo(ctx, owner, { forge: "gitlab", url, project: "payments skills", team: "Payments", token: TOKEN }),
    ]);

    // then
    expect(attempts.map((a) => (a.status === "rejected" ? (a.reason as { status: number }).status : 200))).toEqual([403, 403, 409, 400, 400, 400, 400, 400, 400, 400]);
    for (const a of attempts) expect(String((a as PromiseRejectedResult).reason?.message)).not.toContain(TOKEN);
    expect(gitlab.seen).toEqual([]);
    expect((await ctx.store.listRepos(TENANT)).map((r) => r.id)).toEqual(["listed"]);
    expect(await ctx.store.listSecrets(TENANT, "")).toEqual([]);
  });
});

describe("a forge address that leads inside", () => {
  it("given addresses that resolve to a private network, partly inside, to the metadata service, or to this machine without the operator's leave, when each is connected, then each is refused before anything is fetched, and a host the operator allowed is fetched", async () => {
    // given
    const { ctx, owner } = await organization();
    const here = await forge(401);
    const allowed = await forge(401);
    allowInside(ctx, allowed.origin);
    const answers: Record<string, string[]> = { "gitlab.example.invalid": ["10.0.0.5"], "mixed.example.invalid": ["203.0.113.10", "192.168.1.2"], "metadata.example.invalid": ["169.254.169.254"], "mapped.example.invalid": ["::ffff:127.0.0.1"], "127.0.0.1": ["127.0.0.1"] };
    const shown = { ...ctx, resolveHost: async (host: string) => answers[host] ?? [] };
    const at = (host: string) => ({ forge: "gitlab", url: `https://${host}/payments/skills.git`, team: "Payments", token: TOKEN });

    // when
    const attempts = await Promise.allSettled([
      connectRepo(shown, owner, at("gitlab.example.invalid")),
      connectRepo(shown, owner, at("mixed.example.invalid")),
      connectRepo(shown, owner, at("metadata.example.invalid")),
      connectRepo(shown, owner, at("mapped.example.invalid")),
      connectRepo(shown, owner, { ...at(""), url: `${here.origin}/payments/skills.git` }),
      connectRepo(shown, owner, { ...at(""), url: `${allowed.origin}/payments/skills.git` }),
    ]);

    // then
    expect(attempts.map((a) => (a as PromiseRejectedResult).reason?.status)).toEqual([403, 403, 403, 403, 403, 409]);
    expect(here.seen).toEqual([]);
    expect(allowed.seen.length).toBeGreaterThan(0);
    expect((await ctx.store.listRepos(TENANT)).map((r) => r.id)).toEqual(["listed"]);
  });

  it("given a repository connected here, when it syncs while its host resolves outside and then once it resolves inside, then git is held to the address judged, and nothing is fetched once it leads inside", async () => {
    // given
    const { ctx } = await organization();
    const url = `https://gitlab.example.invalid/payments/skills.git`;
    await ctx.store.upsertRepo({ tenant: TENANT, id: "skills", team: "Payments", name: "skills", url });
    ctx.addedRepos!.set("skills", { id: "skills", forge: "gitlab", kind: "skills", skillsFrom: null, gitOrigin: "https://gitlab.example.invalid", memberUrl: url, addedBy: "ada@example.invalid", addedAt: "2026-01-01T00:00:00.000Z" });
    let answer = ["203.0.113.10"];
    const shown = { ...ctx, resolveHost: async () => answer };

    // when
    const outside = await gitAccess(shown, (await ctx.store.getRepo(TENANT, "skills"))!);
    answer = ["10.0.0.5"];
    const inside = await syncRepo(shown, "skills");

    // then
    expect(Object.entries(outside!.env)).toEqual(expect.arrayContaining([["GIT_CONFIG_KEY_1", "http.curloptResolve"], ["GIT_CONFIG_VALUE_1", "gitlab.example.invalid:443:203.0.113.10"], ["GIT_CONFIG_VALUE_0", "false"]]));
    expect(inside).toEqual({ error: expect.stringContaining("leads to this machine or a network inside it") });
    expect(existsSync(mirrorDir(ctx, "skills"))).toBe(false);
  });
});

describe("a repository the file comes to list", () => {
  it("given a repository connected here, when the configuration file lists the same id at a start, then the file's entry wins and the record and fetch token kept for it here go", async () => {
    // given
    const { ctx, owner, root } = await organization();
    const path = teamRepo(root, "payments-skills");
    await connectRepo(ctx, owner, { forge: "path", url: path, team: "Payments" });
    await ctx.store.setSetting(TENANT, "repo.added.payments-skills", JSON.stringify({ ...ctx.addedRepos!.get("payments-skills"), gitOrigin: "https://gitlab.example.invalid" }));
    await storeSecret(ctx.store, ctx.vault!, TENANT, gitTokenName("payments-skills", "https://gitlab.example.invalid"), TOKEN, "ada@example.invalid");

    // when
    const yielded = await yieldToFile({ ...ctx, addedRepos: new Map() }, new Set(["listed", "payments-skills"]));

    // then
    expect(yielded).toEqual(["payments-skills"]);
    expect(await loadAddedRepos(ctx.store, TENANT)).toEqual(new Map());
    expect(await ctx.store.listSecrets(TENANT, "repo-git-token:")).toEqual([]);
    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("skills\n");
  });
});

describe("a forge on the person's own network, in local mode", () => {
  const at = (address: string, privateNetworkForges: boolean) => forgeDestination({ resolveHost: async () => [address], privateNetworkForges }, new URL("https://git.corp.example.invalid/acme/skills.git"));

  it("given an orchestrator one person runs for themselves, when their GitLab sits on a private network or this machine, then it is reached", async () => {
    for (const address of ["10.20.30.40", "192.168.1.5", "172.20.0.9", "127.0.0.1", "fd12:3456::1"]) expect(await at(address, true)).toBe(address);
  });

  it("given that orchestrator, when the name leads to a cloud's metadata service, a link-local, unspecified or NAT64 address, then it is refused all the same", async () => {
    for (const address of ["169.254.169.254", "fe80::1", "0.0.0.0", "64:ff9b::a9fe:a9fe"]) await expect(at(address, true)).rejects.toThrow(/never reaches/);
  });

  it("given an orchestrator others reach, when the name leads to a private network, then it is refused unless the operator named the host, as before", async () => {
    await expect(at("10.20.30.40", false)).rejects.toThrow(/ORCHESTRATOR_INTERNAL_FORGE_HOSTS/);
  });
});


describe("a local orchestrator and paths under the person's home", () => {
  it("given the home as the folder for paths and the orchestrator's data inside it, when a clone in the home, the data folder and a clone outside the home are connected by path, then the clone is connected, the data folder refused, and the one outside is told it is outside the home", async () => {
    // given
    vi.stubEnv("ORCHESTRATOR_MODE", "local");
    const { ctx, owner } = await organization();
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const local = { ...ctx, localReposRoot: home, dataDir: join(home, "Library", "Application Support", "TeamHandbook Orchestrator") };
    const clone = teamRepo(join(home, "code"), "payments-skills");
    const inData = teamRepo(local.dataDir, "own");
    const elsewhere = teamRepo(mkdtempSync(join(tmpdir(), "elsewhere-")), "scratch");

    // when
    const connected = await connectRepo(local, owner, { forge: "path", url: clone, team: "Payments" });
    const refused = await connectRepo(local, owner, { forge: "path", url: inData, team: "Payments" }).catch((err: { status: number; message: string }) => err);
    const outside = await connectRepo(local, owner, { forge: "path", url: elsewhere, team: "Payments" }).catch((err: { status: number; message: string }) => err);

    // then
    expect(connected.url).toBe(realpathSync(clone));
    expect(refused).toMatchObject({ status: 400, code: "library" });
    expect(outside).toMatchObject({ status: 400, code: "outside-home", message: "that path is outside your home folder; connect a clone inside it" });
  });
});

describe("what a repository connected with nothing but its address is", () => {
  it("given a code repository, a team skills repository, a folder without git and an address with no project, when each is connected with no kind, team or name, then the kind is read off its files, the team is the person's own, a plain folder is not mirrored, and the address is refused by its code", async () => {
    // given
    const { ctx, owner, root } = await organization();
    teamRepo(root, "shop");
    const skills = teamRepo(root, "team-skills");
    mkdirSync(join(skills, ".claude-plugin"));
    writeFileSync(join(skills, ".claude-plugin", "marketplace.json"), "{}");
    execFileSync("git", ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid", "add", "."], { cwd: skills });
    execFileSync("git", ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid", "commit", "-qm", "plugin"], { cwd: skills });
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "todo.md"), "x\n");

    // when
    const shop = await connectRepo(ctx, owner, { forge: "path", url: join(root, "shop") });
    const team = await connectRepo(ctx, owner, { forge: "path", url: skills });
    const notes = await connectRepo(ctx, owner, { forge: "path", url: join(root, "notes") });
    const noProject = await connectRepo(ctx, owner, { forge: "gitlab", url: "https://gitlab.com/acme", token: "glpat-x" }).catch((err: { code: string }) => err);

    // then
    expect([ctx.addedRepos!.get("shop")?.kind, ctx.addedRepos!.get("team-skills")?.kind, ctx.addedRepos!.get("notes")?.kind]).toEqual(["code", "skills", "code"]);
    expect(shop.team).toBe(owner.ownedTeams.length === 1 ? owner.ownedTeams[0] : "Mine");
    expect([shop.head !== null, team.head !== null, notes.head, notes.error]).toEqual([true, true, null, null]);
    expect(noProject).toMatchObject({ code: "address-has-no-project" });
  });
});

describe("which forges a screen offers", () => {
  it("given no Gitea asked for and none connected, when the forges are offered, then GitLab and GitHub are, and Gitea is not until the operator asks for it or a Gitea repository is here", () => {
    const none = { addedRepos: new Map() };
    const withGitea = { addedRepos: new Map([["notes", { forge: "gitea" } as never]]) };

    expect(offeredForges(none, {})).toEqual(["gitlab", "github"]);
    expect(offeredForges(none, { ORCHESTRATOR_FORGE_GITEA: "1" })).toEqual(["gitlab", "github", "gitea"]);
    expect(offeredForges(withGitea, {})).toEqual(["gitlab", "github", "gitea"]);
  });
});

describe("the person's own gh or glab on an orchestrator more than one person reaches", () => {
  it("given an orchestrator that turned the own CLI on at start and has three accounts now, when a GitHub repository is connected with no token, then it is refused and asks for a token, and the own CLI is not used for anything", async () => {
    const { ctx, owner } = await organization();
    const own = { ...ctx, ownForgeCli: true, resolveHost: async () => ["203.0.113.10"] };

    const connecting = connectRepo(own, owner, { forge: "github", url: "https://github.com/acme/skills.git", team: "Payments" });

    await expect(connecting).rejects.toThrow(/reached by more than one person, so a repository is connected with a token here, not with your own gh or glab/);
    expect(await ownCliHere(own, {})).toBe(false);
    expect(await ctx.store.getRepo(TENANT, "skills")).toBeNull();
  });

  it("given an orchestrator only one account holds, when the own CLI is asked for, then it is used, and not when it was never turned on", async () => {
    const store = openSqliteStore(":memory:");
    await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: PASSWORD });

    expect(await ownCliHere({ store, tenant: TENANT, ownForgeCli: true }, {})).toBe(true);
    expect(await ownCliHere({ store, tenant: TENANT, ownForgeCli: false }, {})).toBe(false);
    expect(await ownCliHere({ store, tenant: TENANT, ownForgeCli: true }, { ORCHESTRATOR_HOST: "0.0.0.0" })).toBe(false);
  });
});
