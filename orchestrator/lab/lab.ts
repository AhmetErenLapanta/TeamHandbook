import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OrchestratorClient } from "./client.js";
import { dnsMain, preloadSource } from "./dns.js";
import type { DnsConfig } from "./dns.js";
import { cloudLocalConfig, frontMain } from "./cloud-local.js";
import { forgeMain } from "./forge.js";
import { registryMain } from "./registry.js";
import { signInProvidersMain } from "./sign-in-providers.js";
import type { SignInProvidersConfig } from "./sign-in-providers.js";
import { GITHUB_ISSUES, GITHUB_MILESTONES, GITLAB_BOARD_LISTS, GITLAB_ISSUES, GITLAB_MILESTONES, GITLAB_NAMES, SIGN_IN_PEOPLE, signInClients } from "./cloud.js";
import type { RegistryConfig } from "./registry.js";
import { idpMain } from "./idp.js";
import { jiraMain } from "./jira.js";
import type { JiraConfig } from "./jira.js";
import { mcpOauthMain } from "./mcp-oauth.js";
import type { McpOauthConfig } from "./mcp-oauth.js";
import type { IdpClient, IdpConfig } from "./idp.js";
import type { FakeForgeConfig, ForgeApp } from "./forge.js";
import { addMarketplace, answerUsage, copyDir, createMachine, doctor, joinTeam, machineOf, sessionStart, updateMarketplace, useSkill } from "./machine.js";
import { BOARDS, emailOf, ISSUES, ORGS } from "./orgs.js";
import type { ExtraOrgFile, OrgSpec, PersonSpec } from "./orgs.js";
import { commitOnDefault, seedCodeRepo, seedTeamRepo } from "./repos.js";
import { branchExampleProblem } from "../server/plugin.js";
import { parseMemberUrl } from "../server/setup.js";
import { labGit, labGitMaybe, labEnv } from "./run.js";
import { labDir, MARKER, readLab, stateFile } from "./state.js";
import type { Consent, LabDeveloper, LabForge, LabOrg, LabRepo, LabSsoPerson, LabState, LabUser, Store } from "./state.js";

const ORCHESTRATOR_DIR = resolve(process.env.LAB_ORCHESTRATOR_DIR ?? process.cwd());
const PLUGIN_DIST = resolve(ORCHESTRATOR_DIR, "..", "dist");
// One password for every lab account: the lab answers only on 127.0.0.1 and holds nothing but stand-ins.
const PASSWORD = "lab password long enough";
const PORT_BASE = Number(process.env.LAB_PORT_BASE ?? 18400);
// The image docker-compose.yml pins for its postgres profile, so the lab adds no pull of its own.
const POSTGRES_IMAGE = "postgres:16.10-alpine";
const NAME = /^[a-z][a-z0-9-]{1,30}$/;

function say(line: string): void {
  console.log(`lab: ${line}`);
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
}

async function waitFor(url: string, what: string, seconds = 60): Promise<void> {
  for (let i = 0; i < seconds * 4; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} did not answer on ${url}; its log is under ${join(labDir(), "logs")}`);
}

function onPath(name: string, path: string): string {
  return spawnSync("sh", ["-c", `command -v ${name}`], { env: { PATH: path }, encoding: "utf8" }).stdout.trim();
}

/**
 * The lab's PATH: git and node linked from where they really are, a stand-in claude that
 * writes down every call and makes a task's change without a model, and the system's own directories.
 * No other agent CLI, gh or glab is on it, and `up` stops if any of them would resolve to
 * anything but the lab's own.
 */
function prepareBin(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const git = onPath("git", process.env.PATH ?? "");
  if (!git) throw new Error("git is not on PATH");
  // The real file, not a link to it: a git that finds its helpers next to itself finds them there.
  symlinkSync(realpathSync(git), join(bin, "git"));
  symlinkSync(process.execPath, join(bin, "node"));
  const log = join(dir, "logs", "claude-calls.log");
  // The lab's stand-in for the Claude Code CLI (lab/stand-in-claude.mjs): every call written down, with
  // what a Claude Code session started that way would load, then run.
  const loads = join(dir, "logs", "claude-loads.ndjson");
  copyFileSync(join(ORCHESTRATOR_DIR, "lab", "stand-in-claude.mjs"), join(bin, "claude.mjs"));
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nLAB_CLAUDE_LOADS='${loads}' exec node '${join(bin, "claude.mjs")}' "$@"\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const path = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  for (const name of ["claude", "opencode", "codex", "cursor-agent", "gemini", "gh", "glab"]) {
    const found = onPath(name, path);
    if (found && found !== join(bin, name)) throw new Error(`${name} resolves to ${found} on the lab's PATH; the lab never runs a real ${name}, so it stops`);
  }
  return path;
}

function docker(args: string[]): { status: number; out: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

async function startPostgres(state: LabState, port: number): Promise<void> {
  const container = `teamhandbook-orchestrator-lab-${createHash("sha256").update(state.dir).digest("hex").slice(0, 8)}`;
  const started = docker(["run", "-d", "--name", container, "--label", `teamhandbook-orchestrator-lab=${state.dir}`, "-e", "POSTGRES_USER=lab", "-e", "POSTGRES_PASSWORD=lab", "-e", "POSTGRES_DB=lab", "-p", `127.0.0.1:${port}:5432`, POSTGRES_IMAGE]);
  if (started.status !== 0) throw new Error(`docker could not start the lab's Postgres: ${started.out}`);
  state.postgres = { url: `postgres://lab:lab@127.0.0.1:${port}/lab`, container };
  save(state);
  // Over TCP inside the container: the image's first-start server listens only on its socket,
  // so an answer here is the server that stays.
  for (let i = 0; i < 120; i++) {
    if (docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "lab", "-d", "lab"]).status === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("the lab's Postgres did not become ready in 60 seconds");
}

function save(state: LabState): void {
  writeFileSync(stateFile(state.dir), JSON.stringify(state, null, 2) + "\n");
}

function startProcess(state: LabState, name: string, args: string[], env: NodeJS.ProcessEnv): void {
  const out = openSync(join(state.dir, "logs", `${name}.log`), "a");
  const child = spawn("node", args, { detached: true, stdio: ["ignore", out, out], env, cwd: ORCHESTRATOR_DIR });
  child.unref();
  state.processes.push({ name, pid: child.pid! });
  save(state);
}

function readExtraOrgs(): ExtraOrgFile["orgs"] {
  const file = process.env.LAB_EXTRA_ORGS;
  if (!file) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as ExtraOrgFile;
  for (const org of parsed.orgs ?? []) {
    if (!NAME.test(org.name)) throw new Error(`an extra organization's name is lower-case letters, digits and dashes: ${JSON.stringify(org.name)}`);
    if (ORGS.some((o) => o.name === org.name)) throw new Error(`an extra organization takes a name the lab does not use already`);
    for (const repo of org.repos ?? []) {
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(repo.id)) throw new Error(`a repository id is lower-case letters, digits and dashes: ${JSON.stringify(repo.id)}`);
      if (!existsSync(repo.path)) throw new Error(`${repo.path} does not exist`);
      // The orchestrator's own rule, so a refused address stops the lab here rather than its orchestrator at start.
      if (repo.memberUrl !== undefined) parseMemberUrl(repo.memberUrl, repo.id);
      const example = repo.branchExample === undefined ? null : typeof repo.branchExample === "string" ? branchExampleProblem(repo.branchExample.trim()) : "not a string";
      if (example) throw new Error(`the branchExample of ${repo.id} is ${example}`);
    }
  }
  return parsed.orgs ?? [];
}

/** An extra organization as the lab runs it: its repositories copied in, on the local forge, with one admin, an owner per team, a member and a few teammates. */
function extraSpec(org: ExtraOrgFile["orgs"][number]): OrgSpec & { copies: ExtraOrgFile["orgs"][number]["repos"] } {
  const teams = [...new Set(org.repos.map((r) => r.team))];
  const people: PersonSpec[] = [
    { key: "admin", name: "Lab Owner", role: "owner", teams: [] },
    { key: "org-admin", name: "Lab Admin", role: "admin", teams: [] },
    ...teams.map((team, i) => ({ key: `owner:${team}`, name: `Lab Team Owner ${i + 1}`, role: "member" as const, teams: [team] })),
    { key: "member", name: "Lab Member", role: "member", teams: [] },
  ];
  const consents: Consent[] = ["agree", "undecided", "decline"];
  const developers = Array.from({ length: Math.min(org.developers ?? 2, 3) }, (_, i) => ({ name: `dev${i + 1}`, repo: org.repos[0]!.id, consent: consents[i]! }));
  return { name: org.name, extra: true, store: org.store ?? "sqlite", forge: "local", teams: [], people, developers, forgeUsers: [], copies: org.repos };
}

/** The team file at the copy's head, or nothing when it has none or it is not a JSON object. */
function teamFileOf(path: string, bare: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(labGitMaybe(path, ["show", "HEAD:.teamhandbook.json"], bare) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function versioningOf(path: string, bare: string): "number" | "commit" {
  const text = labGitMaybe(path, ["show", "HEAD:.claude-plugin/plugin.json"], bare);
  try {
    return text && typeof (JSON.parse(text) as { version?: unknown }).version === "string" ? "number" : "commit";
  } catch {
    return "commit";
  }
}

async function up(): Promise<void> {
  const dir = labDir();
  if (existsSync(stateFile(dir))) throw new Error(`a lab is already set up at ${dir}; stop it with npm run lab:down first`);
  // up.sh has put the marker and this very bundle there, and nothing else.
  if (readdirSync(dir).some((entry) => entry !== "lab.mjs" && entry !== MARKER)) throw new Error(`${dir} holds something other than a lab; set LAB_DIR to an empty or missing directory`);
  if (!existsSync(join(ORCHESTRATOR_DIR, "dist", "server.js"))) throw new Error("the orchestrator is not built; run npm run build first");
  const extras = readExtraOrgs().map(extraSpec);
  const specs: (OrgSpec & { copies?: ExtraOrgFile["orgs"][number]["repos"] })[] = [...ORGS, ...extras];

  const ports = { gitlab: PORT_BASE + 1, github: PORT_BASE + 2, postgres: PORT_BASE + 3, idp: PORT_BASE + 4, jira: PORT_BASE + 5, mcp: PORT_BASE + 6, dns: PORT_BASE + 7, registry: PORT_BASE + 8, signIn: PORT_BASE + 9, orchestrator: (i: number) => PORT_BASE + 10 + i };
  // Two ports past the last orchestrator stay free for the throwaway tenants the test suite starts.
  const used = [ports.gitlab, ports.github, ports.postgres, ports.idp, ports.jira, ports.mcp, ports.dns, ports.registry, ports.signIn, ...specs.map((_, i) => ports.orchestrator(i)), ports.orchestrator(specs.length), ports.orchestrator(specs.length + 1)];
  // The demo's compose stack listens on 8080, or on ORCHESTRATOR_HOST_PORT next to it, and the
  // browser suite on 18181; a lab started beside either keeps clear of them.
  const kept = used.find((p) => (p >= 8000 && p < 8100) || p === 18181 || String(p) === process.env.ORCHESTRATOR_HOST_PORT);
  if (kept) throw new Error(`port ${kept} belongs to the demo or the browser suite; set LAB_PORT_BASE so the lab's ports stay clear of 8000-8099 and 18181`);
  for (const port of used) {
    if (!(await portFree(port))) throw new Error(`port ${port} is taken; set LAB_PORT_BASE to a free range`);
  }
  mkdirSync(join(dir, "logs"), { recursive: true });
  const path = prepareBin(dir);

  const state: LabState = { dir, orchestratorDir: ORCHESTRATOR_DIR, pluginDist: PLUGIN_DIST, path, password: PASSWORD, forges: [], postgres: null, idp: null, jira: null, mcpOauth: null, orgs: [], processes: [] };
  save(state);

  if (specs.some((s) => s.store === "postgres")) {
    say("starting the shared Postgres in docker");
    await startPostgres(state, ports.postgres);
  }

  say("seeding team repositories with the plugin's own scaffold");
  const hosted: Record<"gitlab" | "github", FakeForgeConfig> = {
    gitlab: { kind: "gitlab", port: ports.gitlab, token: `lab-gitlab-${randomBytes(12).toString("hex")}`, root: join(dir, "forges", "gitlab"), path, projects: [], users: [], log: join(dir, "logs", "forge-gitlab.log"), scratch: join(dir, "forges", "scratch"), issues: GITLAB_ISSUES, milestones: GITLAB_MILESTONES, boardLists: GITLAB_BOARD_LISTS, names: GITLAB_NAMES },
    github: { kind: "github", port: ports.github, token: `lab-github-${randomBytes(12).toString("hex")}`, root: join(dir, "forges", "github"), path, projects: [], users: [], log: join(dir, "logs", "forge-github.log"), scratch: join(dir, "forges", "scratch"), issues: GITHUB_ISSUES, milestones: GITHUB_MILESTONES },
  };
  mkdirSync(hosted.gitlab.scratch, { recursive: true });
  const orgRepos = new Map<string, LabRepo[]>();
  for (const spec of specs) {
    const orgDir = join(dir, "orgs", spec.name);
    const repos: LabRepo[] = [];
    for (const team of spec.teams) {
      let bare: string;
      let url: string;
      let project: string | undefined;
      if (spec.forge === "local") {
        bare = join(orgDir, "repos", `${team.id}.git`);
        url = `file://${bare}`;
      } else {
        project = `${spec.name}/${team.id}`;
        bare = join(hosted[spec.forge].root, `${project}.git`);
        url = `http://127.0.0.1:${hosted[spec.forge].port}/${project}.git`;
        hosted[spec.forge].projects.push(project);
      }
      if (team.code) seedCodeRepo(path, { id: team.id, defaultBranch: team.defaultBranch, files: team.code.files }, bare, join(dir, "scratch"));
      else seedTeamRepo(path, team, bare, url, join(dir, "scratch"));
      repos.push({
        id: team.id,
        team: team.team,
        forge: spec.forge,
        url,
        bare,
        ...(project ? { project } : {}),
        // Teammates reach a hosted forge by another name than the orchestrator does, so a test can tell
        // which address the orchestrator wrote for them.
        memberUrl: team.noMemberUrl ? null : url.replace("http://127.0.0.1:", "http://localhost:"),
        ci: team.withCi ?? false,
        versioning: team.version ? "number" : "commit",
        ...(team.commitPrefix ? { commitPrefix: team.commitPrefix } : {}),
        ...(team.branchExample ? { branchExample: team.branchExample } : {}),
        reviewers: team.reviewers,
        labels: team.labels,
        ...(team.code ? { code: { skillsFrom: team.code.skillsFrom } } : {}),
      });
    }
    for (const copy of spec.copies ?? []) {
      const bare = join(orgDir, "repos", `${copy.id}.git`);
      labGit(path, ["clone", "--bare", "--quiet", "--", copy.path, bare], dir);
      const team = teamFileOf(path, bare);
      if (copy.branchExample && team.branchExample !== copy.branchExample.trim()) {
        commitOnDefault(path, bare, { [".teamhandbook.json"]: JSON.stringify({ ...team, branchExample: copy.branchExample.trim() }, null, 2) + "\n" }, "chore: record the team's branch naming", { name: "Lab Seed", email: "seed@lab.example.invalid" }, join(dir, "scratch"));
      }
      const recorded = teamFileOf(path, bare);
      repos.push({
        id: copy.id,
        team: copy.team,
        forge: "local",
        url: `file://${bare}`,
        bare,
        // Only the address the file gives: the copy's own path is no address a teammate adds.
        memberUrl: copy.memberUrl ?? null,
        ci: labGitMaybe(path, ["cat-file", "-e", "HEAD:scripts/bump-version.mjs"], bare) !== null,
        versioning: versioningOf(path, bare),
        ...(typeof recorded.commitPrefix === "string" && recorded.commitPrefix ? { commitPrefix: recorded.commitPrefix } : {}),
        ...(typeof recorded.branchExample === "string" && recorded.branchExample ? { branchExample: recorded.branchExample } : {}),
        reviewers: Array.isArray(recorded.reviewers) ? recorded.reviewers.filter((r): r is string => typeof r === "string") : [],
        labels: Array.isArray(recorded.labels) ? recorded.labels.filter((l): l is string => typeof l === "string") : [],
      });
    }
    if (spec.forge !== "local") hosted[spec.forge].users.push(...spec.forgeUsers);
    orgRepos.set(spec.name, repos);
  }

  // The GitHub App an organization's orchestrator is registered as: its key pair made here, the public
  // half given to the stand-in GitHub, installed on the organization's account over its repositories.
  const appAt = specs.findIndex((s) => s.githubApp);
  let githubApp: { org: string; app: ForgeApp; privateKey: string } | null = null;
  if (appAt >= 0) {
    const spec = specs[appAt]!;
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const installation = { id: 51_001, account: spec.name, type: "Organization" as const, repositories: hosted.github.projects.filter((p) => p.startsWith(`${spec.name}/`)), installer: `${spec.name}-owner` };
    const app: ForgeApp = { id: "424242", slug: `${spec.name}-orchestrator`, clientId: `Iv1.${randomBytes(8).toString("hex")}`, clientSecret: randomBytes(20).toString("hex"), publicKey, callback: `http://127.0.0.1:${ports.orchestrator(appAt)}/integrations/forge/callback`, installation };
    hosted.github.app = app;
    githubApp = { org: spec.name, app, privateKey };
  }

  for (const kind of ["gitlab", "github"] as const) {
    const config = hosted[kind];
    if (!config.projects.length) continue;
    const file = join(dir, "forges", `${kind}.json`);
    writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    say(`starting the stand-in ${kind === "gitlab" ? "GitLab" : "GitHub"} on 127.0.0.1:${config.port}`);
    startProcess(state, `forge-${kind}`, [join(dir, "lab.mjs"), "forge", file], labEnv(path, { HOME: config.root }));
    await waitFor(`http://127.0.0.1:${config.port}/health`, `the stand-in ${kind}`);
    const forge: LabForge = { kind, url: `http://127.0.0.1:${config.port}`, api: kind === "gitlab" ? `http://127.0.0.1:${config.port}/api/v4` : `http://127.0.0.1:${config.port}/api`, token: config.token };
    state.forges.push(forge);
    save(state);
  }

  // One provider for every organization that signs in through one, each its own client.
  const sso = new Map<string, { client: IdpClient; people: LabSsoPerson[] }>();
  for (const [i, spec] of specs.entries()) {
    if (!spec.sso?.length) continue;
    const people = spec.sso.map((p) => ({ key: p.key, sub: `${spec.name}-${p.key}`, email: p.email ?? emailOf(spec.name, p.key), name: p.name, groups: p.groups, verified: p.verified ?? true }));
    sso.set(spec.name, { client: { id: `lab-${spec.name}`, secret: randomBytes(16).toString("hex"), redirect: `http://127.0.0.1:${ports.orchestrator(i)}/api/auth/oidc/callback` }, people });
  }
  if (sso.size) {
    const file = join(dir, "idp.json");
    const config: IdpConfig = { port: ports.idp, people: [...sso.values()].flatMap((o) => o.people), clients: [...sso.values()].map((o) => o.client), log: join(dir, "logs", "idp.log") };
    writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    say(`starting the stand-in identity provider on 127.0.0.1:${ports.idp}`);
    startProcess(state, "idp", [join(dir, "lab.mjs"), "idp", file], labEnv(path, { HOME: dir }));
    await waitFor(`http://127.0.0.1:${ports.idp}/health`, "the stand-in identity provider");
    state.idp = { url: `http://127.0.0.1:${ports.idp}` };
    save(state);
  }

  // The tracker a task reads an issue from: a stand-in Jira behind an API token, and a stand-in
  // MCP server behind OAuth, both over the same issues.
  const jira: JiraConfig = { port: ports.jira, email: "lab-bot@lab.example.invalid", token: `lab-jira-${randomBytes(12).toString("hex")}`, writeToken: `lab-jira-write-${randomBytes(12).toString("hex")}`, issues: ISSUES, boards: BOARDS, log: join(dir, "logs", "jira.log") };
  writeFileSync(join(dir, "jira.json"), JSON.stringify(jira, null, 2) + "\n");
  startProcess(state, "jira", [join(dir, "lab.mjs"), "jira", join(dir, "jira.json")], labEnv(path, { HOME: dir }));
  const people = specs.flatMap((s) => [...s.people.map((p) => emailOf(s.name, p.key)), ...s.developers.map((d) => `${d.name}@dev.example.invalid`)]);
  // Twenty seconds, so a scenario sees the orchestrator refresh a sign-in without waiting long.
  const mcp: McpOauthConfig = { port: ports.mcp, people, issues: ISSUES, accessSeconds: 20, log: join(dir, "logs", "mcp-oauth.log") };
  writeFileSync(join(dir, "mcp-oauth.json"), JSON.stringify(mcp, null, 2) + "\n");
  startProcess(state, "mcp-oauth", [join(dir, "lab.mjs"), "mcp-oauth", join(dir, "mcp-oauth.json")], labEnv(path, { HOME: dir }));
  say(`starting the stand-in Jira on 127.0.0.1:${ports.jira} and the stand-in OAuth MCP server on 127.0.0.1:${ports.mcp}`);
  await waitFor(`http://127.0.0.1:${ports.jira}/health`, "the stand-in Jira");
  await waitFor(`http://127.0.0.1:${ports.mcp}/health`, "the stand-in OAuth MCP server");
  state.jira = { url: `http://127.0.0.1:${ports.jira}`, email: jira.email, token: jira.token, writeToken: jira.writeToken! };
  state.mcpOauth = { url: `http://127.0.0.1:${ports.mcp}` };
  save(state);

  // Email domains are verified by a TXT record; the orchestrator with single sign-on asks this
  // stand-in for it, through a preload that points Node's resolver here, and no real resolver.
  const dns: DnsConfig = { port: ports.dns, records: join(dir, "dns.json"), log: join(dir, "logs", "dns.log") };
  writeFileSync(join(dir, "dns-config.json"), JSON.stringify(dns, null, 2) + "\n");
  writeFileSync(join(dir, "dns-preload.mjs"), preloadSource(ports.dns));
  startProcess(state, "dns", [join(dir, "lab.mjs"), "dns", join(dir, "dns-config.json")], labEnv(path, { HOME: dir }));
  for (let i = 0; i < 40 && !(existsSync(dns.log) && readFileSync(dns.log, "utf8").includes("dns listening")); i++) await new Promise((r) => setTimeout(r, 250));
  state.dns = { port: ports.dns, records: dns.records };
  save(state);

  const registry: RegistryConfig = { port: ports.registry, log: join(dir, "logs", "registry.log") };
  writeFileSync(join(dir, "registry.json"), JSON.stringify(registry, null, 2) + "\n");
  startProcess(state, "registry", [join(dir, "lab.mjs"), "registry", join(dir, "registry.json")], labEnv(path, { HOME: dir }));
  await waitFor(`http://127.0.0.1:${ports.registry}/health`, "the stand-in MCP Registry");
  state.registry = { url: `http://127.0.0.1:${ports.registry}` };
  save(state);

  // The providers a person signs up to a cloud orchestrator with: Google, GitHub and Microsoft, all on this machine.
  const orchestratorUrls = [...specs.map((_, i) => ports.orchestrator(i)), ports.orchestrator(specs.length), ports.orchestrator(specs.length + 1)].map((p) => `http://127.0.0.1:${p}`);
  const signIn: SignInProvidersConfig = { port: ports.signIn, people: SIGN_IN_PEOPLE, clients: signInClients(orchestratorUrls), log: join(dir, "logs", "sign-in.log") };
  writeFileSync(join(dir, "sign-in.json"), JSON.stringify(signIn, null, 2) + "\n");
  startProcess(state, "sign-in", [join(dir, "lab.mjs"), "sign-in", join(dir, "sign-in.json")], labEnv(path, { HOME: dir }));
  await waitFor(`http://127.0.0.1:${ports.signIn}/health`, "the stand-in sign-in providers");
  state.signIn = { url: `http://127.0.0.1:${ports.signIn}`, clients: signIn.clients };
  save(state);

  for (const [i, spec] of specs.entries()) {
    const org = await startOrg(state, spec, i, ports.orchestrator(i), orgRepos.get(spec.name) ?? [], sso.get(spec.name) ?? null, githubApp?.org === spec.name ? githubApp : null);
    state.orgs.push(org);
    save(state);
  }
  say(`ready; the accounts' password is "${PASSWORD}"`);
  status(state);
}

async function startOrg(state: LabState, spec: OrgSpec, index: number, port: number, repos: LabRepo[], sso: { client: IdpClient; people: LabSsoPerson[] } | null, githubApp: { app: ForgeApp; privateKey: string } | null): Promise<LabOrg> {
  const orgDir = join(state.dir, "orgs", spec.name);
  const url = `http://127.0.0.1:${port}`;
  for (const sub of ["home", "tmp", "data"]) mkdirSync(join(orgDir, sub), { recursive: true });
  // The app's secrets reach the orchestrator as files, the way an operator keeps them out of the environment.
  const appFiles = githubApp ? { key: join(orgDir, "github-app.pem"), secret: join(orgDir, "github-app-secret") } : null;
  if (githubApp && appFiles) {
    writeFileSync(appFiles.key, githubApp.privateKey, { mode: 0o600 });
    writeFileSync(appFiles.secret, githubApp.app.clientSecret + "\n", { mode: 0o600 });
  }
  const configFile = join(orgDir, "orchestrator.json");
  // A hosted forge's deliveries reach the orchestrator's hook signed with this; the review check needs one.
  const hookSecret = randomBytes(24).toString("hex");
  writeFileSync(configFile, JSON.stringify({ tenant: spec.name, repos: repos.map((r) => ({ id: r.id, team: r.team, name: r.id, url: r.url, ...(r.forge !== "local" ? { triggerSecretEnv: "LAB_FORGE_HOOK_SECRET" } : {}), ...(r.code ? { kind: "code", skillsFrom: r.code.skillsFrom, ...(r.branchExample ? { naming: { branchExample: r.branchExample } } : {}) } : {}), ...(spec.teams.find((t) => t.id === r.id)?.testCommand ? { testCommand: spec.teams.find((t) => t.id === r.id)!.testCommand } : {}), ...(r.memberUrl && !r.code ? { memberUrl: r.memberUrl } : {}), ...(spec.teams.find((t) => t.id === r.id)?.mcpTools ? { mcpTools: spec.teams.find((t) => t.id === r.id)!.mcpTools } : {}) })) }, null, 2) + "\n");
  const code = `lab-setup-${randomBytes(8).toString("hex")}`;
  const store: Store = spec.store === "postgres" && state.postgres ? "postgres" : "sqlite";
  say(`starting ${spec.extra ? `extra organization ${index + 1 - ORGS.length}` : spec.name}'s orchestrator on ${url} (${store}, ${spec.forge} forge)`);
  startProcess(
    state,
    `orchestrator-${spec.name}`,
    // The lab directory rides along as an argument the orchestrator ignores, so down.sh can tell
    // a lab orchestrator from any other node process before it stops one.
    [join(ORCHESTRATOR_DIR, "dist", "server.js"), state.dir],
    labEnv(state.path, {
      HOME: join(orgDir, "home"),
      TMPDIR: join(orgDir, "tmp"),
      ORCHESTRATOR_DATA_DIR: join(orgDir, "data"),
      ORCHESTRATOR_CONFIG: configFile,
      ORCHESTRATOR_PORT: String(port),
      ORCHESTRATOR_HOST: "127.0.0.1",
      // A team's orchestrator, named so: one person's own, with no sign-in, is a mode of its own.
      ORCHESTRATOR_MODE: "self-hosted",
      // Its tasks run here, as the lab's scenarios expect, rather than waiting for the starter's machine.
      ORCHESTRATOR_SERVER_TASKS: "1",
      ORCHESTRATOR_AUTH: "local",
      ORCHESTRATOR_SETUP_TOKEN: code,
      ORCHESTRATOR_SECRET_KEY: randomBytes(32).toString("base64"),
      ORCHESTRATOR_PUBLIC_URL: url,
      // A real agent CLI never starts in the lab: Claude Code, where it is offered, is the lab's stand-in claude.
      ORCHESTRATOR_AGENTS: spec.agents ?? "fake",
      ORCHESTRATOR_CLAUDE_BIN: join(state.dir, "bin", "claude"),
      // The lab's stand-in MCP server and its sign-in are on this machine over http, which a person's own server needs this to reach.
      ORCHESTRATOR_MCP_LOCAL: "1",
      ORCHESTRATOR_WEB_ROOT: join(ORCHESTRATOR_DIR, "dist", "web"),
      ORCHESTRATOR_GIT_NAME: "Lab Orchestrator",
      ORCHESTRATOR_GIT_EMAIL: `orchestrator@${spec.name}.example.invalid`,
      ...(store === "postgres" ? { ORCHESTRATOR_DATABASE_URL: state.postgres!.url } : {}),
      ...(sso ? { ORCHESTRATOR_OIDC_ISSUER: state.idp!.url, ORCHESTRATOR_OIDC_CLIENT_ID: sso.client.id, ORCHESTRATOR_OIDC_CLIENT_SECRET: sso.client.secret } : {}),
      ...(githubApp && appFiles
        ? {
            ORCHESTRATOR_FORGE_GITHUB_URL: state.forges.find((f) => f.kind === "github")!.url,
            ORCHESTRATOR_FORGE_GITHUB_APP_ID: githubApp.app.id,
            ORCHESTRATOR_FORGE_GITHUB_APP_SLUG: githubApp.app.slug,
            ORCHESTRATOR_FORGE_GITHUB_CLIENT_ID: githubApp.app.clientId,
            ORCHESTRATOR_FORGE_GITHUB_CLIENT_SECRET_FILE: appFiles.secret,
            ORCHESTRATOR_FORGE_GITHUB_PRIVATE_KEY_FILE: appFiles.key,
          }
        : {}),
      LAB_FORGE_HOOK_SECRET: hookSecret,
      ...(spec.taskConcurrency ? { ORCHESTRATOR_TASK_CONCURRENCY: String(spec.taskConcurrency) } : {}),
      ...(state.registry ? { ORCHESTRATOR_MCP_REGISTRY_URL: state.registry.url } : {}),
      ...(sso && state.dns ? { NODE_OPTIONS: `--import=${pathToFileURL(join(state.dir, "dns-preload.mjs")).href}` } : {}),
    }),
  );
  await waitFor(`${url}/api/health`, `${spec.name}'s orchestrator`);

  const users: LabUser[] = spec.people.map((p) => ({ key: p.key, email: emailOf(spec.name, p.key), name: p.name, role: p.role, teams: p.teams }));
  const admin = users.find((u) => u.key === "admin")!;
  const client = await OrchestratorClient.setup(url, code, admin, state.password);
  for (const user of users.filter((u) => u !== admin)) {
    await client.ok("POST", "/api/users", { email: user.email, name: user.name, role: user.role, teams: user.teams, password: state.password });
  }
  for (const repo of repos.filter((r) => r.forge !== "local")) {
    const forge = state.forges.find((f) => f.kind === repo.forge)!;
    await client.ok("PUT", `/api/repos/${repo.id}/forge`, { kind: repo.forge, apiUrl: forge.api, project: repo.project, token: forge.token });
  }
  // The orchestrator syncs each repository once it serves; wait until every one has been read.
  for (let i = 0; i < 240; i++) {
    const { repos: listed } = await client.ok<{ repos: { id: string; head: string | null; error: string | null }[] }>("GET", "/api/repos");
    const failed = listed.find((r) => r.error);
    if (failed) throw new Error(`${spec.name}'s orchestrator could not read ${failed.id}: ${failed.error}`);
    if (repos.every((r) => listed.find((l) => l.id === r.id)?.head)) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const developers: LabDeveloper[] = [];
  for (const dev of spec.developers) {
    const repo = repos.find((r) => r.id === dev.repo)!;
    const { home, handbook } = createMachine(join(orgDir, "devs"), dev.name);
    const m = machineOf(state, { home, handbook });
    const joined = joinTeam(m, repo.url);
    const copy = joined.status === 0 ? addMarketplace(m) : null;
    developers.push({ name: dev.name, repo: repo.id, consent: dev.consent, home, handbook, copy, joined: (joined.status === 0 ? joined.stdout : joined.stderr).trim().split("\n")[0] ?? "" });
  }
  return { name: spec.name, extra: spec.extra === true, url, port, store, dir: orgDir, repos, users, developers, sso: sso?.people ?? [], hookSecret, ...(spec.fixture ? { fixture: spec.fixture } : {}) };
}

function label(org: LabOrg, index: number): string {
  return org.extra ? `extra organization ${index}` : org.name;
}

function status(state: LabState = readLab()): void {
  let extra = 0;
  for (const org of state.orgs) {
    console.log(`\n${label(org, org.extra ? ++extra : 0)}  ${org.url}  (${org.store})`);
    for (const user of org.users) console.log(`  ${user.role.padEnd(6)} ${user.email}${user.teams.length ? `  (${user.teams.join(", ")})` : ""}`);
    for (const repo of org.repos) console.log(`  repo   ${repo.id}  ${repo.forge}, versioned by ${repo.versioning}`);
    for (const dev of org.developers) console.log(`  dev    ${dev.name} on ${dev.repo}, ${dev.consent}${dev.copy ? "" : ` - not joined: ${dev.joined}`}`);
  }
  console.log(`\nPassword for every account: ${state.password}`);
  console.log("Run the suite with npm run lab:test; stop everything with npm run lab:down.");
}

/** `lab dev <org> <developer> <doctor|update|session|use <skill>|agree|decline>`: one teammate's machine, by hand. */
function dev(args: string[]): void {
  const [orgName, devName, action, arg] = args;
  const state = readLab();
  const org = state.orgs.find((o) => o.name === orgName);
  const developer = org?.developers.find((d) => d.name === devName);
  if (!org || !developer) throw new Error("usage: lab dev <org> <developer> <doctor|update|session|use <plugin:skill>|agree|decline>");
  const m = machineOf(state, developer);
  if (action === "doctor") console.log(doctor(m).output);
  else if (action === "update") {
    updateMarketplace(m);
    console.log(`updated ${copyDir(m)}`);
  } else if (action === "session") console.log(sessionStart(m, `lab-${Date.now()}`));
  else if (action === "use" && arg) useSkill(m, arg, `lab-${Date.now()}`);
  else if (action === "agree" || action === "decline") {
    const endpoint = /sent to (\S+) and nothing else/.exec(sessionStart(m, `lab-${Date.now()}`))?.[1];
    if (action === "agree" && !endpoint) throw new Error("the team has not asked for skill use on this machine's copy yet");
    answerUsage(m, action, endpoint ?? "");
  } else throw new Error(`unknown action ${action}`);
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, () => Promise<void> | void> = {
  up,
  status: () => status(),
  dev: () => dev(rest),
  forge: () => forgeMain(rest[0]!),
  idp: () => idpMain(rest[0]!),
  jira: () => jiraMain(rest[0]!),
  "mcp-oauth": () => mcpOauthMain(rest[0]!),
  dns: () => dnsMain(rest[0]!),
  registry: () => registryMain(rest[0]!),
  "sign-in": () => signInProvidersMain(rest[0]!),
  "cloud-local-config": () => cloudLocalConfig(rest),
  front: () => frontMain(rest[0]!),
};
const chosen = commands[command ?? ""];
if (!chosen) {
  console.error("usage: lab.mjs up | status | dev <org> <developer> <action> | forge <config> | idp <config> | jira <config> | mcp-oauth <config> | dns <config> | registry <config> | sign-in <config> | cloud-local-config <dir> <http port> <postgres host> [privacy] [terms] [help] | front <config>");
  process.exit(2);
}
Promise.resolve(chosen()).catch((err: Error) => {
  console.error(`lab: ${err.message}`);
  if (command === "up") console.error("lab: npm run lab:down stops what was started and deletes the lab directory");
  process.exit(1);
});
