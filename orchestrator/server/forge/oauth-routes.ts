import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { principalOf } from "../accounts.js";
import type { OrchestratorContext } from "../app.js";
import { manages, secureOrchestrator } from "../auth.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { recordEvent } from "../events.js";
import { browserMark, pkce, sameBrowser } from "../integrations/mcp-oauth.js";
import { NO_VAULT, storeSecret } from "../vault.js";
import {
  connectionKey,
  connectionRepos,
  FORGE_CALLBACK,
  ForgeSignInFailed,
  forgeConnectionView,
  gitlabAccount,
  gitlabAuthorizeUrl,
  gitlabExchange,
  gitlabRevoke,
  PENDING_CONNECT_MS,
  PENDING_CONNECTS,
  readConnection,
  forgeApp,
  readGitLabTokens,
  ORG_GITLAB_APP,
  readOrgGitLabApp,
  sealGitLabTokens,
  writeConnection,
} from "./oauth.js";
import type { AppForge, ReturnPage } from "./oauth.js";
import { FORGES } from "../../shared/forge-def.js";
import { cliSignInState, SignInRefused, startCliSignIn } from "./cli-sign-in.js";
import { ownCliStatus } from "./own-cli.js";
import { githubInstallationAccount, githubInstallUrl, githubUserToken } from "./oauth-github.js";
import { listConnectionRepos } from "./oauth-repos.js";
import { checkConnection } from "./probe.js";
import { createTeamRepo, MakeItOnGitHub } from "./bootstrap.js";
import type { TeamRepoInput } from "./bootstrap.js";
import { ForgeHttpError } from "./http.js";
import { connectRepo, forgeDestination } from "../connect.js";
import { publicRepo } from "../app.js";
import { OrchestratorError } from "../errors.js";
import { route } from "../route-scopes.js";
import { ownCliHere } from "./own-cli-here.js";

const FORGE_NAME: Record<AppForge, string> = { gitlab: "GitLab", github: "GitHub" };

function forgeOf(value: string | undefined): AppForge | null {
  return value === "gitlab" || value === "github" ? value : null;
}

/**
 * The cookie that ties a forge sign-in to the browser that began it. It is not the MCP sign-in's
 * cookie: over https both live at "/", and a server signed in to in another tab would replace it.
 */
export function forgeSignInCookie(secure: boolean): { name: string; path: string } {
  return { name: `${secure ? "__Host-" : ""}th_forge_signin`, path: secure ? "/" : FORGE_CALLBACK };
}

function redirectUriOf(ctx: OrchestratorContext): string | null {
  return ctx.publicUrl ? `${ctx.publicUrl.replace(/\/+$/, "")}${FORGE_CALLBACK}` : null;
}

/**
 * What keeps an owner from connecting this forge with one click, in the order the operator fixes
 * them, each one sentence the card shows as it is. The secret key comes first: without it no token
 * is kept either, so only the others can offer a token meanwhile. The settings' names are in the
 * card's hint and the operator's guide.
 */
export async function connectMissing(ctx: OrchestratorContext, kind: AppForge): Promise<string[]> {
  const missing: string[] = [];
  const meanwhile = "until then, connect with a token under Other ways to connect.";
  if (!ctx.vault) missing.push(`Whoever runs the orchestrator sets its secret key first, which seals every ${FORGE_NAME[kind]} token; nothing connects until then.`);
  if (!(await forgeApp(ctx, kind))) missing.push(`Whoever runs the orchestrator registers it as a ${kind === "gitlab" ? "GitLab OAuth application" : "GitHub App"} first; ${meanwhile}`);
  if (!ctx.publicUrl) missing.push(`Whoever runs the orchestrator sets its public address first, where ${FORGE_NAME[kind]} returns the browser after the sign-in; ${meanwhile}`);
  return missing;
}

/** Only an owner or an admin signed in to the orchestrator connects or disconnects the org's forge; an API key never does. */
function connector(user: Principal): boolean {
  return !user.key && manages(user);
}

/**
 * The org's one-click forge connection: `signedIn` behind the orchestrator's sign-in, and `open` for
 * the one address the forge returns the browser to. That return carries no session, so it
 * finishes only the sign-in this browser began, by the cookie set when it began, and only for a
 * person who still manages the org's integrations when it comes back.
 */
export function forgeConnectRoutes(ctx: OrchestratorContext): { open: Hono; signedIn: Hono<OrchestratorEnv> } {
  const open = new Hono();
  const signedIn = new Hono<OrchestratorEnv>();
  const secure = secureOrchestrator(ctx.publicUrl);

  /** The host the person's own CLI signs in to: that of their first repository reached with it, else the forge's own. */
  const signInHost = async (kind: AppForge): Promise<string> => {
    for (const added of ctx.addedRepos?.values() ?? []) {
      if (!added.viaOwnCli || added.forge !== kind) continue;
      const config = await ctx.store.getForgeConfig(ctx.tenant, added.id);
      if (config) return new URL(config.apiUrl).host.replace(/^api\./, "");
    }
    return FORGES[kind].homeHosts[0]!;
  };

  /**
   * Whether the card signs the person's own CLI in, and where that stands. Only one person's own
   * orchestrator does, the rule Run as me keeps, and only one that opens requests with that CLI.
   */
  const signInRead = async (kind: AppForge) => {
    const tool = kind === "github" ? "gh" : "glab";
    // Run as me's rule, said in this card's own words: the refusal names a rule the card does not show.
    const own = await ownCliHere(ctx);
    const why = ctx.ownForgeCli && !own ? `signing in with your own ${tool} is for an orchestrator only one person reaches, on this machine` : null;
    // Where the person's own CLI is not offered, the card's one action is the organization's connection, when the orchestrator can make one.
    const missing = await connectMissing(ctx, kind);
    const org = { available: missing.length === 0, missing };
    if (!own) return { offered: false, why, org, cli: null, installLine: null, signIn: { state: "idle" as const } };
    const host = await signInHost(kind);
    const repos = [...(ctx.addedRepos?.values() ?? [])].filter((a) => a.viaOwnCli && a.forge === kind).map((a) => a.id);
    return { offered: true, why: null, org, cli: { ...(await ownCliStatus(kind, host)), repos }, installLine: process.platform === "darwin" ? `brew install ${tool}` : null, signIn: cliSignInState(kind, host) };
  };

  // The machine's owner signed in, never a key: the CLI it starts signs in as that person.
  const signInRefusal = (user: Principal) => (user.key || !manages(user) ? "only this machine's owner, signed in, signs their own CLI in" : null);

  route(signedIn, "GET /api/forge/:kind/sign-in", async (c) => {
    const kind = forgeOf(c.req.param("kind"));
    if (!kind) return c.json({ error: "a forge is gitlab or github" }, 404);
    // Anyone else signed in reads only that an owner or an admin connects it: nothing of the machine's CLI or the connection's setup.
    if (signInRefusal(c.get("user"))) return c.json({ offered: false, why: `an owner or an admin connects ${FORGE_NAME[kind]}`, org: null, cli: null, installLine: null, signIn: { state: "idle" } });
    return c.json(await signInRead(kind));
  });

  // Starts the person's own CLI sign-in on this machine; the card follows it with the GET above.
  route(signedIn, "POST /api/forge/:kind/sign-in", async (c) => {
    const kind = forgeOf(c.req.param("kind"));
    if (!kind) return c.json({ error: "a forge is gitlab or github" }, 404);
    const refused = signInRefusal(c.get("user"));
    if (refused) return c.json({ error: refused }, 403);
    const read = await signInRead(kind);
    if (!read.offered || !read.cli) return c.json({ error: `${read.why ?? "this orchestrator opens requests with a token or the organization's connection, not with your own CLI"}; connect ${FORGE_NAME[kind]} under Other ways to connect` }, 409);
    try {
      await startCliSignIn(kind, read.cli.host);
    } catch (err) {
      if (err instanceof SignInRefused) return c.json({ error: err.message }, 400);
      throw err;
    }
    return c.json(await signInRead(kind));
  });

  route(signedIn, "GET /api/forge/:kind/connection", async (c) => {
    const kind = forgeOf(c.req.param("kind"));
    if (!kind) return c.json({ error: "a forge is gitlab or github" }, 404);
    if (!manages(c.get("user"))) return c.json({ error: `only an owner or an admin reads the organization's ${FORGE_NAME[kind]} connection` }, 403);
    const missing = await connectMissing(ctx, kind);
    return c.json({ connection: await forgeConnectionView(ctx, kind), available: missing.length === 0, missing });
  });

  // Reads the forge with the connection and changes nothing: whether the token opens, which account, and whether what it was granted is enough.
  route(signedIn, "GET /api/forge/:kind/connection/check", async (c) => {
    const kind = forgeOf(c.req.param("kind"));
    if (!kind) return c.json({ error: "a forge is gitlab or github" }, 404);
    if (!manages(c.get("user"))) return c.json({ error: `only an owner or an admin checks the organization's ${FORGE_NAME[kind]} connection` }, 403);
    return c.json({ check: await checkConnection(ctx, kind) });
  });

  route(signedIn, "POST /api/forge/:kind/connect", async (c) => {
    const kind = forgeOf(c.req.param("kind"));
    if (!kind) return c.json({ error: "a forge is gitlab or github" }, 404);
    const user = c.get("user");
    if (!connector(user)) return c.json({ error: `only an owner or an admin signed in to the orchestrator connects the organization's ${FORGE_NAME[kind]}` }, 403);
    const missing = await connectMissing(ctx, kind);
    if (missing.length) return c.json({ error: missing[0] }, 409);
    const redirectUri = redirectUriOf(ctx)!;
    const { verifier, challenge } = pkce();
    const browser = browserMark();
    // A page name from a fixed list, never an address: a return the forge sends cannot be pointed anywhere else.
    const body = (await c.req.json().catch(() => ({}))) as { return?: unknown };
    const page: ReturnPage = body.return === "welcome" ? "welcome" : "integrations";
    const state = PENDING_CONNECTS.add({ tenant: ctx.tenant, kind, userId: user.id, verifier, redirectUri, browser: browser.hash, page });
    const cookie = forgeSignInCookie(secure);
    setCookie(c, cookie.name, browser.value, { httpOnly: true, sameSite: "Lax", secure, path: cookie.path, maxAge: PENDING_CONNECT_MS / 1000 });
    // GitHub's installation page takes no code challenge: the installation it returns is held to the installer's own list instead.
    if (kind === "gitlab") {
      const app = (await forgeApp(ctx, "gitlab"))!;
      // An org's own GitLab is an address an owner entered: it is held to where the orchestrator may reach before the browser is sent there.
      if (await readOrgGitLabApp(ctx)) await forgeDestination(ctx, new URL(app.webUrl));
      return c.json({ authorizeUrl: gitlabAuthorizeUrl(app, redirectUri, state, challenge) });
    }
    return c.json({ authorizeUrl: githubInstallUrl((await forgeApp(ctx, "github"))!, state) });
  });

  /** A forge's own refusal, as the screen shows it: what the forge said, never the token. */
  const forgeSaid = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      if (err instanceof ForgeHttpError) throw new OrchestratorError("forge-refused", err.message, 502);
      throw err;
    }
  };

  // An org's own GitLab application: an owner's to enter, since the orchestrator sends the org's sign-ins and tokens to the address it names.
  const ownerOnly = (user: Principal) => !user.key && user.role === "owner";

  route(signedIn, "GET /api/forge/gitlab/app", async (c) => {
    if (!manages(c.get("user"))) return c.json({ error: "only an owner or an admin reads the organization's GitLab application" }, 403);
    return c.json({ app: await readOrgGitLabApp(ctx), redirectUri: redirectUriOf(ctx), operator: Boolean(ctx.forgeApps?.gitlab) });
  });

  route(signedIn, "PUT /api/forge/gitlab/app", async (c) => {
    const user = c.get("user");
    if (!ownerOnly(user)) return c.json({ error: "only an owner signed in to the orchestrator sets the organization's own GitLab application" }, 403);
    if (await readConnection(ctx, "gitlab")) return c.json({ error: "disconnect GitLab first; its tokens belong to the application it was connected through" }, 409);
    if (!ctx.vault) return c.json({ error: NO_VAULT }, 409);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
    if (!/^[A-Za-z0-9._-]{8,200}$/.test(clientId)) return c.json({ error: "enter the application ID GitLab shows for the application" }, 400);
    if (clientSecret.length < 8 || clientSecret.length > 512 || /\s/.test(clientSecret)) return c.json({ error: "enter the application's secret" }, 400);
    let web: URL;
    try {
      web = new URL(String(body.url ?? ""));
    } catch {
      return c.json({ error: "enter your GitLab's https address" }, 400);
    }
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(web.hostname);
    if ((web.protocol !== "https:" && !(web.protocol === "http:" && loopback)) || web.username || web.password || web.search || web.hash || web.pathname.replace(/\/+$/, "")) {
      return c.json({ error: "enter your GitLab's https address alone, as https://gitlab.example.com" }, 400);
    }
    await forgeDestination(ctx, web);
    const record = { webUrl: web.origin, clientId, by: user.name, at: new Date().toISOString() };
    await storeSecret(ctx.store, ctx.vault, ctx.tenant, ORG_GITLAB_APP, clientSecret, user.email);
    await ctx.store.setSetting(ctx.tenant, ORG_GITLAB_APP, JSON.stringify(record));
    await recordEvent(ctx, user, "forge.app.set", { subject: "forge:gitlab", detail: `set the organization's own GitLab application at ${web.host}` });
    return c.json({ app: record });
  });

  route(signedIn, "DELETE /api/forge/gitlab/app", async (c) => {
    const user = c.get("user");
    if (!ownerOnly(user)) return c.json({ error: "only an owner signed in to the orchestrator removes the organization's own GitLab application" }, 403);
    if (await readConnection(ctx, "gitlab")) return c.json({ error: "disconnect GitLab first; its tokens belong to this application" }, 409);
    const record = await readOrgGitLabApp(ctx);
    if (!record) return c.json({ error: "the organization has no GitLab application of its own" }, 404);
    await ctx.store.deleteSecret(ctx.tenant, ORG_GITLAB_APP);
    await ctx.store.deleteSetting(ctx.tenant, ORG_GITLAB_APP);
    await recordEvent(ctx, user, "forge.app.removed", { subject: "forge:gitlab", detail: `removed the organization's own GitLab application at ${new URL(record.webUrl).host}` });
    return c.json({ ok: true });
  });

  route(signedIn, "GET /api/forge/:kind/repos", async (c) => {
    const kind = forgeOf(c.req.param("kind"));
    if (!kind) return c.json({ error: "a forge is gitlab or github" }, 404);
    if (!connector(c.get("user"))) return c.json({ error: `only an owner or an admin signed in to the orchestrator lists the organization's repositories on ${FORGE_NAME[kind]}` }, 403);
    return c.json({ repos: await forgeSaid(() => listConnectionRepos(ctx, kind)) });
  });

  route(signedIn, "POST /api/forge/:kind/repos/connect", async (c) => {
    const kind = forgeOf(c.req.param("kind"));
    if (!kind) return c.json({ error: "a forge is gitlab or github" }, 404);
    const user = c.get("user");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // Only a repository the connection lists: an address typed in would send the connection's token wherever it pointed.
    const listed = (await forgeSaid(() => listConnectionRepos(ctx, kind))).find((r) => r.fullName === body.fullName);
    if (!listed) return c.json({ error: `${FORGE_NAME[kind]} does not list that repository for this connection. ${FORGES[kind].emptyListHint}` }, 404);
    if (listed.connected) return c.json({ error: `that repository is already connected as ${listed.connected}` }, 409);
    const repo = await connectRepo(ctx, user, { forge: kind, url: listed.url, team: body.team, kind: body.kind, id: body.id, name: body.name, skillsFrom: body.skillsFrom }, kind);
    await recordEvent(ctx, user, "repo.connected", { repoId: repo.id, subject: `repo:${repo.id}`, detail: `${repo.name} of team ${repo.team}, ${ctx.addedRepos?.get(repo.id)?.kind ?? "skills"}, on ${FORGE_NAME[kind]} through the organization's connection` });
    return c.json({ repo: publicRepo(ctx, repo) });
  });

  route(signedIn, "POST /api/forge/:kind/team-repo", async (c) => {
    const kind = forgeOf(c.req.param("kind"));
    if (!kind) return c.json({ error: "a forge is gitlab or github" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as TeamRepoInput;
    try {
      const made = await createTeamRepo(ctx, c.get("user"), kind, body);
      return c.json({ repo: publicRepo(ctx, made.repo), webhook: made.webhook });
    } catch (err) {
      // The way through on a personal account comes with its steps, for the screen to show one by one.
      if (err instanceof MakeItOnGitHub) return c.json({ error: err.message, code: err.code, steps: err.steps }, 409);
      throw err;
    }
  });

  route(signedIn, "DELETE /api/forge/:kind/connection", async (c) => {
    const kind = forgeOf(c.req.param("kind"));
    if (!kind) return c.json({ error: "a forge is gitlab or github" }, 404);
    const user = c.get("user");
    if (!connector(user)) return c.json({ error: `only an owner or an admin signed in to the orchestrator disconnects the organization's ${FORGE_NAME[kind]}` }, 403);
    const record = await readConnection(ctx, kind);
    if (!record) return c.json({ error: `${FORGE_NAME[kind]} is not connected` }, 404);
    // A repository reached through the connection would be left with no way to its forge.
    const repos = connectionRepos(ctx, kind);
    if (repos.length) return c.json({ error: `${repos.join(", ")} ${repos.length === 1 ? "reaches" : "reach"} ${FORGE_NAME[kind]} through this connection; remove ${repos.length === 1 ? "it" : "them"} under Projects first`, repos }, 409);
    // A GitHub installation stays on GitHub until someone with rights on that account removes it there; the card says so.
    const gitlab = kind === "gitlab" ? await forgeApp(ctx, "gitlab") : null;
    if (gitlab) {
      const tokens = await readGitLabTokens(ctx).catch(() => null);
      if (tokens) await gitlabRevoke(gitlab, tokens);
    }
    await ctx.store.deleteSecret(ctx.tenant, connectionKey(kind));
    await ctx.store.deleteSetting(ctx.tenant, connectionKey(kind));
    await recordEvent(ctx, user, "forge.disconnected", { subject: `forge:${kind}`, detail: `disconnected ${FORGE_NAME[kind]} (${record.account}) from the organization` });
    return c.json({ ok: true, ...(kind === "github" ? { note: `The app stays installed on ${record.account}; remove it in that account's GitHub settings to take its access away.` } : {}) });
  });

  route(open, "GET /integrations/forge/callback", async (c: Context) => {
    let page: ReturnPage = "integrations";
    const back = (query: string) => c.redirect(`/${encodeURIComponent(ctx.tenant)}/${page}?${query}`, 302);
    const problem = (text: string) => back(`forge_problem=${encodeURIComponent(text)}`);
    const cookie = forgeSignInCookie(secure);
    const presented = getCookie(c, cookie.name);
    deleteCookie(c, cookie.name, { path: cookie.path, secure });
    const pending = PENDING_CONNECTS.take(c.req.query("state") ?? "");
    if (!pending || pending.tenant !== ctx.tenant) return problem("That sign-in is unknown or expired; press Connect with GitLab or Connect with GitHub again.");
    page = pending.page;
    if (!sameBrowser(pending, presented)) return problem(`That sign-in was begun in another browser; press Connect with ${FORGE_NAME[pending.kind]} again in this one.`);
    const name = FORGE_NAME[pending.kind];
    // The role is read again: it can change in the minutes the person spends on the forge.
    const account = await ctx.store.getUser(ctx.tenant, pending.userId);
    const user = account ? await principalOf(ctx.store, account) : null;
    if (!user || !manages(user)) return problem(`Only an owner or an admin connects ${name}; your role changed during the sign-in.`);
    const code = c.req.query("code");
    if (!code) return problem(`The sign-in to ${name} was not completed.`);
    try {
      if (pending.kind === "github") return await finishGitHub(c, user, code, pending.redirectUri, problem, back);
      const app = await forgeApp(ctx, "gitlab");
      if (!app || !ctx.vault) return problem(`This orchestrator no longer offers a ${name} connection; connect each repository with a token under Projects, or ask whoever runs the orchestrator to set it up again.`);
      const tokens = await gitlabExchange(app, code, pending.verifier, pending.redirectUri);
      const login = await gitlabAccount(app, tokens.accessToken);
      const before = await readConnection(ctx, "gitlab");
      const repos = connectionRepos(ctx, "gitlab");
      // Repositories already reached through the connection were reached as its account; another one need not see them.
      if (before && repos.length && before.account !== login) {
        await gitlabRevoke(app, tokens);
        return problem(`This connection serves ${repos.join(", ")} as ${before.account}; sign in to GitLab as ${before.account}, or remove those repositories first.`);
      }
      // The pair this replaces is revoked first: GitLab's refresh tokens do not lapse on their own.
      const replaced = before ? await readGitLabTokens(ctx).catch(() => null) : null;
      if (replaced) await gitlabRevoke(app, replaced);
      await sealGitLabTokens(ctx, tokens, user.email);
      await writeConnection(ctx, "gitlab", { via: "oauth", account: login, apiUrl: app.apiUrl, redirectUri: pending.redirectUri, by: user.name, byEmail: user.email, at: new Date().toISOString(), problem: null });
      await recordEvent(ctx, user, before ? "forge.reconnected" : "forge.connected", { subject: "forge:gitlab", detail: `${before ? "connected GitLab again" : "connected GitLab"} for the organization, as ${login}` });
      return back("forge_connected=gitlab");
    } catch (err) {
      if (err instanceof ForgeSignInFailed) return problem(err.message);
      if ((err as Error).message === NO_VAULT) return problem(NO_VAULT);
      throw err;
    }
  });

  /**
   * GitHub returns from the installation with the installation's id on the address and the
   * installer's code. `setup_action=request` means a member asked an admin of the account to
   * install it: nothing is installed yet, so nothing is connected.
   */
  async function finishGitHub(c: Context, user: Principal, code: string, redirectUri: string, problem: (text: string) => Response, back: (query: string) => Response): Promise<Response> {
    const app = await forgeApp(ctx, "github");
    if (!app) return problem("This orchestrator no longer offers a GitHub connection; connect each repository with a token under Projects, or ask whoever runs the orchestrator to set it up again.");
    if (c.req.query("setup_action") === "request") return problem("GitHub sent the installation to an owner of that account to approve; connect again once it is installed.");
    const raw = c.req.query("installation_id") ?? "";
    if (!/^[0-9]{1,15}$/.test(raw)) return problem("GitHub returned no installation; install the app from this orchestrator again.");
    const installationId = Number(raw);
    const userToken = await githubUserToken(app, code, redirectUri);
    const { login, organization } = await githubInstallationAccount(app, userToken, installationId);
    const before = await readConnection(ctx, "github");
    const repos = connectionRepos(ctx, "github");
    if (before && repos.length && before.installationId !== installationId) {
      return problem(`This connection serves ${repos.join(", ")} through the installation on ${before.account}; change that installation, or remove those repositories first.`);
    }
    await writeConnection(ctx, "github", { via: "app", account: login, organization, apiUrl: app.apiUrl, installationId, by: user.name, byEmail: user.email, at: new Date().toISOString(), problem: null });
    await recordEvent(ctx, user, before ? "forge.reconnected" : "forge.connected", { subject: "forge:github", detail: `${before ? "connected GitHub again" : "connected GitHub"} for the organization, through the app installed on ${login}` });
    return back("forge_connected=github");
  }

  return { open, signedIn };
}
