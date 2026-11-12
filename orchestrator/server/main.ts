import { existsSync } from "node:fs";
import { workFolders } from "./work-folders.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { randomBytes } from "node:crypto";
import { createApp, inConfiguration, syncRepos } from "./app.js";
import { addedCodeTarget, loadAddedRepos, yieldToFile } from "./connect.js";
import { drainTurns } from "./git.js";
import { reconcileLocalRequests } from "./propose.js";
import type { OrchestratorContext } from "./app.js";
import { allowedHosts, authMode, orchestratorAuth, secureOrchestrator } from "./auth.js";
import { createOidcClient, oidcConfigFromEnv } from "./oidc.js";
import { ConfigRefused, readConfig, servedOrgs } from "./config.js";
import type { OrchestratorConfig, OrgConfig } from "./config.js";
import { dataDirSentence, orchestratorDataDir, holdDataDir, privateDataDir } from "./data-lock.js";
import { migrateStoreCommand } from "./migrate-store.js";
import { migrateCommand } from "./migrate.js";
import { doctorCommand } from "./doctor.js";
import { oldSettingsRefused } from "./old-settings.js";
import { cloudMode, cloudSettingsRefused, orchestratorMode, localMode } from "./mode.js";
import { Hono } from "hono";
import type { Context } from "hono";
import { identityRoutes, identitySessionOf } from "./cloud-identity.js";
import { helpUrl, legalLinks, readmeUrl } from "./legal.js";
import type { LegalLinks } from "./legal.js";
import { cloudRegistry } from "./orgs.js";
import type { CloudOrgs } from "./orgs.js";
import { quotaSettings } from "./quotas.js";
import { operatorEmails, operatorRoutes } from "./operator.js";
import { signupRoutes } from "./signup.js";
import { orgName } from "./organization.js";
import { socialClientsFromEnv } from "./social.js";
import { backupSettings, startBackups } from "./backup.js";
import type { BackupSettings } from "./backup.js";
import { readSecretEnv } from "./secret-env.js";
import { identityEventDays } from "./identity-funnel.js";
import { parseMemberUrl } from "./setup.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";
import { openPostgresStore } from "./store-postgres.js";
import { orgRoutes } from "./orgs.js";
import { registryUrl } from "./mcp-registry.js";
import { startAutoSync, syncMinutes } from "./auto-sync.js";
import { startEffects } from "./effect-handlers.js";
import { startCleanup, startLeaseExpiry } from "./cleanup.js";
import { logSummaryCommand } from "./log-summary.js";
import { startLoopMonitor } from "./diagnostics.js";
import { organizationRunners } from "./runner-routes.js";
import { startEmbeddedRunner } from "../runner/embedded.js";
import { startRequestWatch, storeFollowUps } from "./tasks/watch.js";
import { lessonPlaceOf, startLessonSweep } from "./lessons.js";
import { Redactor } from "./tasks/redact.js";
import { askForLink, LOCAL_PORT, localLinkRoutes, localMachine, localOwnerName, localReposRoot, signInSentence, localStartProblem, openBrowser, pickPort, reentrySecret, runningAddress, signInPage, writeLocalAddress } from "./local.js";
import { installLogger, logFormat } from "./log.js";
import type { LogFormat } from "./log.js";
import { metricsToken } from "./metrics.js";
import type { ServedOrg } from "./orgs.js";
import { dropLocalLink, localOnePerson, localOwner, mintLocalLink, oneAccountOnly } from "./accounts.js";
import { ownForgeCliOffered, singlePersonOrchestrator, vaultFor } from "./vault.js";
import { recordEvent } from "./events.js";
import { onePersonRefusal } from "./tasks/profile.js";
import { storeKeys } from "./integrations/keys.js";
import { withSlack } from "./integrations/slack.js";
import { parseCodeTarget, parseMcpTools, parseRepoJobs, parseTracker, taskOptionsFromEnv } from "./tasks/config.js";
import { startScheduler } from "./tasks/triggers.js";
import { seedDemoTask } from "./tasks/demo.js";
import { createTaskRunner, startAutoContinue, startTaskLimits } from "./tasks/runner.js";
import { forgeAppsFromEnv } from "./forge/oauth.js";
import type { ForgeApps } from "./forge/oauth.js";
import { movesOnPhase, withMergeMoves } from "./work/move.js";
import { startAutomationWatch } from "./work/automations.js";
import { WORK_DEPS } from "./work/routes.js";
import { stopCliSignIns } from "./forge/cli-sign-in.js";
import { stopDeviceSignIns } from "./forge/device-sign-in.js";
import { localRepoPath } from "./forge/local.js";

/**
 * Repositories are connected from a file, so a self-hosted install is reproducible from
 * configuration: the file is re-read at every start and its entries are upserted.
 */
function loadConfig(file: string | undefined): OrchestratorConfig {
  if (!file) return {};
  // A file named and not there - a mistyped path, a volume not mounted - would read as every
  // repository taken out of the configuration; the orchestrator stops instead.
  if (!existsSync(file)) {
    console.error(`ORCHESTRATOR_CONFIG names ${file}, which does not exist; this orchestrator stops without touching its repositories`);
    process.exit(1);
  }
  try {
    return readConfig(file);
  } catch (err) {
    if (!(err instanceof ConfigRefused)) throw err;
    console.error(`ORCHESTRATOR_CONFIG: ${err.message}; this orchestrator stops without touching its repositories`);
    process.exit(1);
  }
}

// Before any setting is read, subcommands included: one still under its old name stops the start.
const oldNames = oldSettingsRefused();
if (oldNames) {
  console.error(oldNames);
  process.exit(1);
}

// `node dist/server.js migrate-store ...` moves a SQLite database into Postgres and exits, starting
// no orchestrator. Only that exact word: a lab or a script passes other arguments the orchestrator ignores.
if (process.argv[2] === "migrate-store") process.exit(await migrateStoreCommand(process.argv.slice(3)));
// `node dist/server.js migrate` moves a Postgres database to this image's schema and exits, holding no organization.
if (process.argv[2] === "migrate") process.exit(await migrateCommand(process.argv.slice(3)));
// `node dist/server.js doctor [--fix]` looks a stopped orchestrator's data over and says what is wrong, each with its fix.
if (process.argv[2] === "doctor") process.exit(await doctorCommand(process.argv.slice(3)));
// `node dist/server.js log-summary <file>...` reads a JSON log on this machine and prints each route's count and times.
if (process.argv[2] === "log-summary") process.exit(logSummaryCommand(process.argv.slice(3)));

// Before anything is written: every line the orchestrator logs, from here on, goes out redacted.
let logAs: LogFormat;
try {
  logAs = logFormat();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
installLogger(logAs);

// Before anything is held or opened: a cloud orchestrator missing what it needs stops with all of it named.
let cloud: boolean;
let signupDays = 0;
try {
  cloud = cloudMode();
  const refused = cloud ? cloudSettingsRefused() : null;
  if (refused) throw new Error(`${refused}; this orchestrator stops`);
  const hostRefused = localStartProblem();
  if (hostRefused) throw new Error(`${hostRefused}; this orchestrator stops`);
  if (cloud) signupDays = identityEventDays();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const dataDir = orchestratorDataDir();
// Before the store opens, a mirror syncs or a task is recovered: a second orchestrator on the same
// data directory stops here and changes nothing of the one already running.
try {
  privateDataDir(dataDir);
  holdDataDir(dataDir);
} catch (err) {
  // A second local start is someone opening the orchestrator again: they are shown the one already running.
  const running = localMode() ? runningAddress(dataDir) : null;
  if (running) {
    // A fresh one-time link from the running one, since the first was used; its address alone when it does not answer.
    const link = (await askForLink(dataDir, running)) ?? running;
    const page = signInPage(dataDir, link);
    console.log(`The orchestrator is already running. ${signInSentence(page, openBrowser(page) !== null)}`);
    process.exit(0);
  }
  console.error((err as Error).message);
  process.exit(1);
}
const config = loadConfig(process.env.ORCHESTRATOR_CONFIG);
// A cloud orchestrator's organizations are the ones people create, read from the store; the file lists only those its operator runs.
const orgs = cloud ? (config.orgs ?? []) : servedOrgs(config);
const tenants = orgs.map((o) => o.tenant);
// Read before anything is opened or synced, so a refused setting leaves no database or mirror behind.
const orgSettings = (org: OrgConfig) => {
  const repos = org.repos ?? [];
  for (const repo of repos) parseTracker(repo.tracker, repo.id);
  const memberUrls = new Map(repos.flatMap((r) => {
    const url = parseMemberUrl(r.memberUrl, r.id);
    return url === null ? [] : [[r.id, url] as const];
  }));
  const mcpTools = new Map(repos.map((r) => [r.id, parseMcpTools(r.mcpTools, r.id)] as const));
  const testCommands = new Map(repos.flatMap((r) => (r.testCommand ? [[r.id, r.testCommand] as const] : [])));
  const codeTargets = new Map(repos.flatMap((r) => {
    const target = parseCodeTarget(r, repos);
    return target ? [[r.id, target] as const] : [];
  }));
  const jobs = new Map(repos.map((r) => [r.id, parseRepoJobs(r, process.env)] as const));
  return { memberUrls, mcpTools, testCommands, codeTargets, jobs };
};
const settings = new Map(orgs.map((org) => [org.tenant, orgSettings(org)] as const));
const mode = authMode();
// Read with the rest of the configuration, so an address that is refused leaves nothing opened.
let mcpRegistry: string | null;
let syncEvery: number;
let scrapeToken: string | null;
let databaseUrl: string | undefined;
try {
  mcpRegistry = registryUrl();
  syncEvery = syncMinutes();
  scrapeToken = metricsToken();
  databaseUrl = readSecretEnv(process.env, "ORCHESTRATOR_DATABASE_URL");
} catch (err) {
  console.error(`${(err as Error).message}; this orchestrator stops`);
  process.exit(1);
}
// Read before the store opens, which takes its copy before an upgrade where these settings say.
let backups: BackupSettings;
try {
  backups = backupSettings(process.env, dataDir);
} catch (err) {
  console.error(`${(err as Error).message}; this orchestrator stops`);
  process.exit(1);
}
// On Postgres the store lives outside the data directory, so the store holds the tenants as
// the data directory's lock holds the directory. An orchestrator that loses that hold exits at once,
// writing nothing more: what it leaves is what a killed orchestrator leaves, and the next start sets
// it right.
let store: Store;
try {
  store = databaseUrl
    ? await openPostgresStore(databaseUrl, tenants, (reason) => {
        console.error(`the database connection holding ${tenants.length === 1 ? "tenant" : "tenants"} ${tenants.map((t) => JSON.stringify(t)).join(", ")} closed (${reason}); this orchestrator stops before it writes anything more`);
        process.exit(1);
      }, { migrate: !cloud })
    : openSqliteStore(join(dataDir, "orchestrator.db"), { backupDir: backups.dir, say: console.log });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const publicUrl = process.env.ORCHESTRATOR_PUBLIC_URL;
let forgeApps: ForgeApps;
try {
  forgeApps = forgeAppsFromEnv(process.env);
} catch (err) {
  console.error(`${(err as Error).message}; this orchestrator stops`);
  process.exit(1);
}
const secure = secureOrchestrator(publicUrl);
// Sign-in providers, legal links and the daily signup limit, read with the rest so a bad one stops the start.
let signInClients: ReturnType<typeof socialClientsFromEnv>;
let legal: LegalLinks;
let help: string | null;
let orgsPerDay: number;
let operators: Set<string>;
try {
  signInClients = socialClientsFromEnv(process.env, publicUrl);
  legal = legalLinks();
  help = helpUrl();
  orgsPerDay = Number(process.env.ORCHESTRATOR_ORGS_PER_IDENTITY_DAY ?? 3);
  if (!Number.isInteger(orgsPerDay) || orgsPerDay < 1) throw new Error("ORCHESTRATOR_ORGS_PER_IDENTITY_DAY is a whole number of 1 or more");
  operators = operatorEmails();
} catch (err) {
  console.error(`${(err as Error).message}; this orchestrator stops`);
  process.exit(1);
}
const oidcConfig = oidcConfigFromEnv(process.env, publicUrl);
const oidc = oidcConfig ? createOidcClient(oidcConfig) : null;
// The key that seals sign-ins, tokens and secrets: the one the operator set, or, on an orchestrator only
// its one user reaches, one it made for itself in the data directory.
let accounts = 0;
for (const tenant of tenants) accounts += await store.countUsers(tenant);
const sealing = (() => {
  try {
    return vaultFor(process.env, dataDir, singlePersonOrchestrator({ host: process.env.ORCHESTRATOR_HOST ?? "127.0.0.1", publicUrl, devAdmin: mode === "dev-admin", accounts, proxied: Boolean(process.env.ORCHESTRATOR_TRUSTED_PROXY?.trim()) }));
  } catch (err) {
    console.error(`${(err as Error).message}; this orchestrator stops`);
    process.exit(1);
  }
})();
if (sealing.said) console.log(sealing.said);
if (localMode()) localOnePerson(store, tenants);
else if (sealing.source === "generated") oneAccountOnly(store, tenants);
const vault = sealing.vault;
const hosts = allowedHosts(mode);
const trustedProxies = (process.env.ORCHESTRATOR_TRUSTED_PROXY ?? "").split(",").map((p) => p.trim()).filter(Boolean);
const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs");
// Read once here, so a task setting the orchestrator refuses stops the start rather than the first
// organization created later, which a cloud orchestrator with none yet would otherwise meet.
try {
  taskOptionsFromEnv(process.env, dataDir, fakeAgent, () => null);
} catch (err) {
  console.error(`${(err as Error).message}; this orchestrator stops`);
  process.exit(1);
}
// Every event the log takes is offered to Slack once written, so nothing that records a request
// or a task knows about Slack. The event names its own org; the store and vault are shared.
withSlack(store, () => ({ store, tenant: tenants[0]!, vault }));

/**
 * One org's context, built field by field: what is keyed by repository id - the listed set,
 * member addresses, test commands, MCP tools, the task runner - is the org's own, since two
 * orgs can each have a repository of the same id.
 */
/** Aborted when a signal stops the process, for what waits on a client: a runner's poll. */
const closing = new AbortController();

/** On a local orchestrator, whose tasks its own runner leases and the machine row that runner holds them under. */
let ownRunner = null as { person: string; holder: string } | null;

async function prepareOrg(org: OrgConfig): Promise<OrchestratorContext> {
  const tenant = org.tenant;
  const { memberUrls, testCommands } = settings.get(tenant)!;
  // A local orchestrator that took a second account or a service account before it was kept to one person
  // still holds them: its person's own gh or glab sign-in would then act for them too, so it is not offered.
  const several = localMode() ? await onePersonRefusal({ store, tenant }, process.env, tenants) : null;
  if (several) console.warn(`Your own gh or glab sign-in is not used: ${several}. Remove the other accounts to use it again.`);
  const ctx: OrchestratorContext = {
    store,
    mode: orchestratorMode(),
    dataDir,
    tenant,
    // One person's own orchestrator reaches the forge on their own network and opens requests with
    // their own gh or glab sign-in, as their own git does: it answers this machine only and only a
    // browser holding its one-time sign-in. The sign-in alone also reaches a self-hosted one that
    // has no account but its one admin; see ownForgeCliOffered.
    ...(localMode() ? { privateNetworkForges: true } : {}),
    ...(ownForgeCliOffered({ local: localMode(), cloud, devAdmin: mode === "dev-admin", host: process.env.ORCHESTRATOR_HOST ?? "127.0.0.1", publicUrl, proxied: Boolean(process.env.ORCHESTRATOR_TRUSTED_PROXY?.trim()) }) && !several ? { ownForgeCli: true } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    oidc: org.sso ? oidc : null,
    vault,
    allowedHosts: hosts,
    trustedProxies,
    // Without a file nothing is listed: a repository taken out of an earlier file, with the token
    // its URL carried, is not fetched again because the file is not there this time.
    configured: new Set((org.repos ?? []).map((r) => r.id)),
    memberUrls,
    testCommands,
    audit: (actor, kind, fields) => recordEvent(ctx, actor, kind, fields),
    localMcp: process.env.ORCHESTRATOR_MCP_LOCAL === "1",
    mcpRegistry,
    apiKeys: storeKeys(store, tenant),
    // Each org reads paths from a folder of its own, so one org's admin does not connect, and read, another's.
    localReposRoot: localReposRoot(process.env, tenants, tenant),
    internalForgeHosts: new Set((process.env.ORCHESTRATOR_INTERNAL_FORGE_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)),
    forgeApps,
  };

  ctx.runnerService = organizationRunners(ctx);
  ctx.closing = closing.signal;
  // A local orchestrator is one person's: it makes them its owner itself, with no code or password,
  // and signs them in through the one-time link it opens.
  // Its tasks run on this machine, under the one machine row it keeps for its person and through the
  // same calls a connected machine makes over HTTP.
  if (localMode()) {
    const owner = await localOwner(store, tenant, { email: "owner@this-machine.invalid", name: localOwnerName() });
    // Tasks record who started them by email, and a lease names the machine that holds it.
    ownRunner = { person: owner.email, holder: (await localMachine(store, tenant, owner)).id };
    // A task started with no project named goes to one of the folders the person works in with Claude Code.
    ctx.workFolders = async () => workFolders({ dataDir, opened: (await store.listRepos(tenant)).flatMap((r) => localRepoPath(r.url) ?? []) });
  }
  // An org without an owner is set up once, by whoever holds this code. It is printed at every
  // start until an owner exists, and it is worth nothing after that.
  else if (mode === "local" && !cloud && (await store.countOwners(tenant)) === 0) {
    const given = readSecretEnv(process.env, "ORCHESTRATOR_SETUP_TOKEN");
    ctx.setupCode = given || randomBytes(9).toString("base64url");
    const which = tenants.length === 1 ? "This orchestrator" : `Org ${tenant}`;
    if (!given) console.log(`${which} has no owner yet. Open it and create the first owner with setup code ${ctx.setupCode}`);
  }

  for (const id of await yieldToFile(ctx, ctx.configured!)) console.log(`start: ${id} is in the configuration file now, so the file's entry is the one read; the copy connected from the screen and its token are set aside`);
  ctx.addedRepos = await loadAddedRepos(store, tenant);
  for (const repo of org.repos ?? []) await store.upsertRepo({ ...repo, tenant });


  // What an orchestrator that died in the middle of a write left is set right before anyone is served.
  for (const line of await reconcileLocalRequests(ctx)) console.log(`start: ${line}`);
  return ctx;
}

// Every org is set right before any org's tasks run: a start clears the scratch directories
// the orgs share, and a task already running for one org would have its own cleared under it.
const contexts: OrchestratorContext[] = [];
for (const org of orgs) contexts.push(await prepareOrg(org));
for (const ctx of cloud ? contexts : contexts.slice(1)) ctx.webBase = `/${ctx.tenant}/`;
// A request merging moves its task's issue on, in the org the event names.
withMergeMoves(store, (tenant) => contexts.find((c) => c.tenant === tenant), WORK_DEPS);
/** What stops each organization's watch over its tasks' requests, one for every organization served, a later one included. */
const watches: (() => void)[] = [];
const wire = (ctx: OrchestratorContext): ServedOrg => {
  const { mcpTools, testCommands, codeTargets, jobs } = settings.get(ctx.tenant)!;
  ctx.tasks = createTaskRunner(ctx, {
    ...taskOptionsFromEnv(process.env, dataDir, fakeAgent, (repo) => testCommands.get(repo.id) ?? null),
    mcpTools: (repo) => mcpTools.get(repo.id) ?? [],
    codeTarget: (repo) => codeTargets.get(repo.id) ?? addedCodeTarget(ctx, repo.id),
    orgs: tenants,
    onPhase: movesOnPhase(ctx, WORK_DEPS),
  });
  ctx.jobs = (repo) => jobs.get(repo.id) ?? { jobs: [], triggerSecret: null };
  startScheduler(ctx, ctx.tasks, ctx.jobs);
  watches.push(startRequestWatch(ctx, storeFollowUps(ctx)));
  ctx.lessons = lessonPlaceOf(process.env, tenants, ctx);
  if (ctx.lessons) watches.push(startLessonSweep(ctx, ctx.lessons));
  watches.push(startAutomationWatch(ctx, WORK_DEPS));
  if (ctx.runnerService) watches.push(startAutoContinue(ctx.tasks));
  watches.push(startTaskLimits(ctx.tasks));
  return { ctx, app: createApp(ctx, orchestratorAuth(store, ctx.tenant, mode, secure)) };
};
const served: ServedOrg[] = contexts.map(wire);

// A local orchestrator's own runner starts with it and stops with it: it leases its person's tasks
// and runs them here through the task runner, as a connected machine runs them there.
const embedded =
  ownRunner && served[0]
    ? await startEmbeddedRunner({ service: served[0].ctx.runnerService!, ...ownRunner, executor: served[0].ctx.tasks!.leased(), dataDir, mask: (text) => new Redactor().line(text) })
    : null;
if (embedded?.recovered.length) console.log(`start: ${embedded.recovered.length} task${embedded.recovered.length === 1 ? "" : "s"} this machine ran before the stop ${embedded.recovered.length === 1 ? "was" : "were"} interrupted`);
// The tasks a stop cut off, a crash's and a clean stop's alike, go on by themselves unless a restart keeps cutting them off.
const goingOn = embedded && ownRunner ? await served[0]!.ctx.tasks!.autoContinue(ownRunner.holder) : [];
if (goingOn.length) console.log(`start: ${goingOn.length} interrupted task${goingOn.length === 1 ? " goes" : "s go"} on by ${goingOn.length === 1 ? "itself" : "themselves"}`);

/**
 * One more organization served while the orchestrator runs: one a person created on this node or
 * another. Only the per-org steps run; what a start does once for every org (the setup code,
 * clearing the scratch directories the orgs share) is not repeated.
 */
const serveTenant = async (tenant: string): Promise<ServedOrg> => {
  const org: OrgConfig = { tenant, sso: false };
  settings.set(tenant, orgSettings(org));
  const ctx = await prepareOrg(org);
  ctx.webBase = `/${tenant}/`;
  contexts.push(ctx);
  return wire(ctx);
};
let cloudOrgs: CloudOrgs | undefined;
if (cloud) {
  // The organizations the file lists hold their slugs, so nobody signs up for one of them.
  for (const { tenant } of orgs) await store.insertOrg({ tenant, name: await orgName(store, tenant), createdBy: "operator", createdAt: new Date().toISOString(), quotas: quotaSettings(), deletedAt: null });
  for (const org of await store.listOrgs()) if (!settings.has(org.tenant)) served.push(await serveTenant(org.tenant));
  const registry = cloudRegistry(served, store, serveTenant);
  const identity = new Hono();
  identity.route("/", identityRoutes({ store, secure, clients: signInClients, trustedProxies, legal, helpUrl: help, readmeUrl: readmeUrl(), registry, ...(publicUrl ? { publicUrl } : {}), landing: (memberships) => (memberships.length ? `/${memberships[0]!.tenant}/` : "/signup/organization") }));
  identity.route("/", signupRoutes({ store, secure, registry, legal, quotas: () => quotaSettings(), perDay: orgsPerDay }));
  identity.route("/", operatorRoutes({ store, secure, operators }));
  const memberships = async (c: Context) => {
    const session = await identitySessionOf(c, store, secure);
    return session ? (await store.listMemberships(session.identityId)).map((u) => u.tenant) : [];
  };
  cloudOrgs = { registry, store, secure, identity, shared: { ...(publicUrl ? { publicUrl } : {}), vault, trustedProxies }, memberships };
}

const hostname = process.env.ORCHESTRATOR_HOST || "127.0.0.1";
// A local orchestrator takes another port when 8080 is held, so a second app on the machine does not stop it.
const port = process.env.ORCHESTRATOR_PORT ? Number(process.env.ORCHESTRATOR_PORT) : localMode() ? await pickPort(LOCAL_PORT, hostname) : 8080;
const address = `http://127.0.0.1:${port}/`;
// The sign-in page holds one live address at a time: a new one takes back the last, if nobody opened it.
let pageToken: string | null = null;
/** A fresh one-time link that signs the local person in; the browser trades it for a session once. */
const signInLink = async () => {
  const tenant = served[0]!.ctx.tenant;
  if (pageToken) await dropLocalLink(store, tenant, pageToken);
  pageToken = await mintLocalLink(store, tenant);
  return `${address}api/auth/local?token=${pageToken}`;
};
if (localMode()) served[0]!.ctx.localSignedIn = async () => void signInPage(dataDir, await signInLink());
const app = orgRoutes(served, { mode, secure, allowedHosts: hosts, logFormat: logAs, metricsToken: scrapeToken, dataDir, secrets: sealing.source, ...(cloudOrgs ? { cloud: cloudOrgs } : {}), ...(localMode() ? { local: localLinkRoutes(dataDir, signInLink) } : {}) });
const webRoot = resolve(process.env.ORCHESTRATOR_WEB_ROOT ?? "dist/web");
app.use("/*", serveStatic({ root: webRoot }));
app.get("*", serveStatic({ path: join(webRoot, "index.html") }));

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`TeamHandbook Orchestrator listening on http://${info.address}:${info.port}${cloud ? ", in cloud mode, serving the organizations people create" : tenants.length === 1 ? "" : `, serving ${tenants.join(", ")}`}`);
  if (!localMode()) console.log(dataDirSentence(dataDir));
  if (localMode()) {
    writeLocalAddress(dataDir, address);
    reentrySecret(dataDir);
    void signInLink().then((link) => {
      // The link itself is never printed: it carries the one-time sign-in, and a terminal's output is copied and logged.
      const page = signInPage(dataDir, link);
      console.log(`${signInSentence(page, openBrowser(page) !== null)} It answers this machine only.`);
    });
  }
});

// Copies of the orchestrator while it runs: on the schedule ORCHESTRATOR_BACKUP_HOURS sets, and on SIGUSR2.
startBackups(store, async () => (await Promise.all(tenants.map((t) => store.listRepos(t)))).flat(), backups, console.log, console.error);

// The mirrors are brought up to date while the orchestrator serves: what was read at the last start
// stays readable meanwhile, and a repository read for the first time says so until it is.
const syncing = new AbortController();
for (const { ctx } of served) {
  // The repositories the file lists. One it no longer lists is kept, marked and readable, and is
  // not fetched again - a token in its URL is one the operator took out - until it is listed
  // again or an admin disconnects it; marking rather than removing keeps its requests' history.
  const unlisted = (await store.listRepos(ctx.tenant)).filter((r) => !inConfiguration(ctx, r.id)).map((r) => r.id);
  if (unlisted.length) console.log(`start: kept and not synced, since ${process.env.ORCHESTRATOR_CONFIG ? "the configuration file does not list them" : "no ORCHESTRATOR_CONFIG is set"}: ${unlisted.join(", ")}`);
  const synced = syncRepos(ctx, (await store.listRepos(ctx.tenant)).filter((r) => inConfiguration(ctx, r.id)).map((r) => r.id), syncing.signal);
  // The demo's example task starts from a repository that has been read.
  if (process.env.ORCHESTRATOR_DEMO === "1" && ctx === served[0]!.ctx) {
    void synced.then(() => (syncing.signal.aborted ? null : seedDemoTask(ctx, ctx.tasks!))).catch((err: Error) => console.error(`demo task: ${err.message}`));
  }
}
// After that, every few minutes, so a merge made on the forge shows without anyone pressing Sync.
startAutoSync(served.map((s) => s.ctx), syncEvery, syncing.signal);

// A self-hosted orchestrator is the one process on its database, so what its last run left is set
// right before its worker starts: effects tied to that process are cancelled, the rest freed.
// A cloud node is one of several, and another node's effects are not its to touch: there an
// effect whose holder stopped is taken up once its lease runs out.
if (!cloud) {
  for (const { ctx } of served) {
    const recovered = await store.recoverEffects(ctx.tenant, new Date().toISOString());
    if (recovered.cancelled || recovered.requeued) console.log(`start (${ctx.tenant}): ${recovered.cancelled} effects of the last run cancelled, ${recovered.requeued} taken up again`);
  }
}
const stopEffects = startEffects(store, () => served.map((s) => s.ctx), `orchestrator-${process.pid}-${randomBytes(4).toString("hex")}`);
startLoopMonitor();
// What is kept for a time goes once an hour, every organization's by its own retention, in one round.
startCleanup(store, () => served.map((s) => s.ctx), { signupDays });
startLeaseExpiry(store);

// A stop asked for by a signal - docker stop, systemd, Ctrl-C - stops the running tasks'
// agents and deletes their directories first; an agent in a group of its own would otherwise
// outlive the orchestrator that watched it. A second signal exits at once, and what that leaves
// is ended at the next start.
//
// Writes are waited for too: the listener stops taking connections, the requests already
// running finish, and every write to a team repository that has begun (a merge, a request's
// branch) completes, so none is cut off between its steps. All of it gets STOP_GRACE_MS, under
// the ten seconds `docker stop` waits before it kills; what does not finish by then is set
// right by the next start's reconciliation.
const STOP_GRACE_MS = 8_000;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`${signal}: finishing what is under way, then stopping`);
    syncing.abort();
    closing.abort();
    for (const stop of watches) stop();
    // A forge CLI sign-in still waiting for its person is stopped, so no CLI outlives the orchestrator.
    stopCliSignIns();
    stopDeviceSignIns();
    const requestsDone = new Promise<void>((resolve) => server.close(() => resolve()));
    const stopped = Promise.all([...served.map(({ ctx }) => ctx.tasks!.shutdown()), ...(embedded ? [embedded.loop.stop()] : []), stopEffects(), requestsDone.then(() => drainTurns(STOP_GRACE_MS))]);
    void Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS))]).finally(() => process.exit(0));
  });
}
