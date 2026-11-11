import type { OrchestratorContext } from "../app.js";
import { manages } from "../auth.js";
import type { Principal } from "../auth.js";
import type { WorkBoard, WorkBoards, WorkColumn, WorkSource, WorkSources, WorkBoardTeams, WorkColumns, WorkItem, WorkItems, WorkSprints } from "../../shared/work.js";
import { ChangeRefused } from "../changes.js";
import { shown } from "../integrations/issue-preview.js";
import type { WorkCache } from "./cache.js";
import { forgeIssueAccess } from "../forge/oauth-access.js";
import { seesTeamTasks } from "../tasks/guards.js";
import type { AppForge } from "../forge/oauth.js";
import { gitlabProvider } from "./gitlab.js";
import { githubProvider, ownCliFetch } from "./github.js";
import type { GraphQL } from "./github.js";
import { ownCliGraphQL, ownCliReader, ownCliReady, runOwnCli } from "../forge/own-cli.js";
import type { CliRun } from "../forge/own-cli.js";
import { boardId, isOrgSource, parseBoardId, parseSprintId, sprintId } from "./ids.js";
import { jiraProvider } from "./jira.js";
import { linearEndpoint, linearProvider } from "./linear.js";
import { taskLinks } from "./links.js";
import { mcpJiraProvider, missing, READ_TOOLS } from "./mcp-jira.js";
import { boardProjects, boardTeams, PROJECTS_KEY, TEAMS_KEY } from "./gate.js";
import { columnOf, SourceFailed } from "./provider.js";
import type { ApiAccess, BoardRead, ItemRead, ItemScope, Memo, Provider } from "./provider.js";
import { sourceView, workSources } from "./sources.js";
import { writesOff, writesOn } from "./writes.js";
import type { Source } from "./sources.js";

/** A source, board or sprint this person is not shown; the answer is the same whether it exists or not. */
export class WorkNotFound extends Error {}

export interface WorkDeps {
  cache: WorkCache;
  send: typeof fetch;
  /** What reads a forge's issues through the organization's connection; left out, the forge connection's own. */
  forgeAccess?: (ctx: Ctx, kind: AppForge) => Promise<ApiAccess | null>;
  /** What runs the person's own gh; left out, the gh on this machine. */
  cliRun?: CliRun;
}

type Ctx = Pick<OrchestratorContext, "store" | "tenant" | "vault" | "forgeApps"> & Partial<Pick<OrchestratorContext, "ownForgeCli" | "dataDir">>;

export interface Opened {
  source: Source;
  provider: Provider;
  /** The credential the answers are masked against before they reach a screen. */
  secrets: string[];
  /** The prefix of every cached answer: the tenant, the source, and the organization's token or the person whose server it is. */
  scope: string;
  /** Whether moving issues is turned on for this source's tracker; off, its provider moves nothing. */
  writes: boolean;
  /** On a person's own server, the columns they arranged for each of its boards, by the board's own id. */
  layouts?: Record<string, WorkColumn[]>;
}

/**
 * A source as a board reads it. Unless moving issues is turned on for its tracker, its provider
 * moves nothing: what would move an issue is refused before the tracker is asked, so a board
 * reads the tracker and never changes it.
 */
async function open(ctx: Ctx, user: Principal, sourceId: string, deps: WorkDeps): Promise<Opened> {
  const opened = { ...(await openSource(ctx, user, sourceId, deps)), ...(sourceId.startsWith("mcp:") ? { layouts: await readLayouts(ctx, user, sourceId) } : {}) };
  if (await writesOn(ctx)) return { ...opened, writes: true };
  const off = writesOff(opened.source.kind);
  // GitLab and GitHub issues are never moved, and their sources say so themselves; Jira's says the switch is off.
  const provider: Provider = {
    ...opened.provider,
    ...(opened.source.kind === "jira" ? { writable: async () => off } : {}),
    transition: async () => {
      throw new SourceFailed(off);
    },
  };
  return { ...opened, provider, writes: false };
}

async function openSource(ctx: Ctx, user: Principal, sourceId: string, deps: WorkDeps): Promise<Omit<Opened, "writes">> {
  const source = (await workSources(ctx, user)).find((s) => s.id === sourceId);
  if (!source) throw new WorkNotFound("no such source");
  // The organization's answers are keyed by when its token was set: a new token, with other
  // permissions, reads anew at once instead of after the cached minute.
  const scope = `${ctx.tenant}:${source.id}:${"config" in source ? source.tokenSetAt : "connection" in source ? source.connection.at : user.id}:`;
  const memo: Memo = async (key, load) => (await deps.cache.read(scope + key, load)).value;
  if ("config" in source) {
    const token = await source.token();
    if (!token) throw new SourceFailed("the tracker's token is not stored; set it again under Integrations");
    if (source.kind === "jira") return { source, provider: jiraProvider(source.config, token, memo, deps.send), secrets: [token], scope };
    if (source.kind === "gitlab") return { source, provider: gitlabProvider({ baseUrl: `${source.config.url}/api/v4`, headers: { "private-token": token } }, memo, deps.send), secrets: [token], scope };
    if (source.kind === "linear") return { source, provider: linearProvider(linearEndpoint(source.config.url), token, memo, deps.send), secrets: [token], scope };
    throw new SourceFailed("the orchestrator reads GitHub issues through the organization's GitHub connection");
  }
  if ("connection" in source) {
    const access = await (deps.forgeAccess ?? forgeIssueAccess)(ctx, source.kind);
    if (!access) throw new SourceFailed(`connect ${source.kind === "gitlab" ? "GitLab" : "GitHub"} again under Integrations`);
    const secrets = Object.values(access.headers).map((v) => v.replace(/^Bearer /, ""));
    const send = access.send ?? deps.send;
    const provider = source.kind === "gitlab" ? gitlabProvider(access, memo, send) : githubProvider(access, send);
    return { source, provider, secrets, scope };
  }
  if ("repos" in source) {
    const run = deps.cliRun ?? runOwnCli;
    // Asked once a minute, so a gh that is missing or signed out says which command puts it right.
    await memo("gh-ready", () => ownCliReady("github", source.host, run).then(() => true, (err: Error) => Promise.reject(new SourceFailed(err.message))));
    const graphql: GraphQL = (query, variables) => ownCliGraphQL(source.host, query, variables, run);
    return { source, provider: githubProvider({ baseUrl: `https://api.${source.host}`, headers: {} }, ownCliFetch(ownCliReader("github", source.host, run)), source.repos, { graphql, memo }), secrets: [], scope };
  }
  const credential = await source.credential();
  if (credential === null) throw new SourceFailed(`sign in to ${source.server.name} again under Integrations`);
  return { source, provider: mcpJiraProvider(source.server, credential, memo, deps.send), secrets: credential ? [credential] : [], scope };
}

function boardView(opened: Opened, board: BoardRead, teams: Record<string, string>): WorkBoard {
  const id = boardId({ source: opened.source.id, board: board.native });
  return { id, name: shown(board.name, opened.secrets), type: board.type, project: board.project, url: board.url, team: isOrgSource(opened.source.id) ? (teams[id] ?? null) : null };
}

/**
 * The boards this person is shown. A person's own server shows them what their own sign-in sees.
 * The organization's token sees more than any one person should: its boards are shown to owners
 * and admins, and, once one of them maps a board to a team, to whoever reads that team's work.
 */
async function visibleBoards(ctx: Ctx, user: Principal, opened: Opened, deps: WorkDeps, fresh = false) {
  const read = await deps.cache.read(`${opened.scope}boards`, () => opened.provider.boards(), fresh);
  const teams = await boardTeams(ctx);
  const boards = read.value.map((b) => boardView(opened, b, teams));
  const shownTo = !isOrgSource(opened.source.id) || manages(user) ? boards : boards.filter((b) => b.team !== null && seesTeamTasks(user, b.team));
  return { boards: shownTo, fetchedAt: read.fetchedAt, stale: read.stale };
}

/**
 * Every source this person reads work from, each asked whether it reads and whether it moves
 * issues: a source that does not open says why, and moves nothing.
 */
export async function describeSources(ctx: Ctx, user: Principal, deps: WorkDeps): Promise<WorkSources> {
  const described: WorkSource[] = [];
  for (const source of await workSources(ctx, user)) {
    try {
      const opened = await open(ctx, user, source.id, deps);
      const server = "server" in source ? source.server : null;
      const unread = server ? READ_TOOLS.filter((t) => !server.tools.includes(t)) : [];
      if (server && unread.length) {
        const problem = missing(server.name, unread);
        described.push(sourceView(source, problem, problem));
        continue;
      }
      described.push(sourceView(source, await opened.provider.writable(), null));
    } catch (err) {
      if (!(err instanceof SourceFailed)) throw err;
      described.push(sourceView(source, err.message, err.message));
    }
  }
  return { sources: described };
}

export async function listBoards(ctx: Ctx, user: Principal, sourceId: string, deps: WorkDeps, fresh = false): Promise<WorkBoards> {
  const opened = await open(ctx, user, sourceId, deps);
  const { boards, fetchedAt, stale } = await visibleBoards(ctx, user, opened, deps, fresh);
  return { boards, fetchedAt, stale };
}

/** A board id the screen sent back, honoured only when it is one of the boards this person is shown. */
export async function board(ctx: Ctx, user: Principal, id: string, deps: WorkDeps): Promise<{ opened: Opened; native: string; shown: WorkBoard }> {
  const ref = parseBoardId(id);
  if (!ref) throw new WorkNotFound("no such board");
  const opened = await open(ctx, user, ref.source, deps);
  if (!opened.provider.boardPattern.test(ref.board)) throw new WorkNotFound("no such board");
  const { boards } = await visibleBoards(ctx, user, opened, deps);
  const shown = boards.find((b) => b.id === id);
  if (!shown) throw new WorkNotFound("no such board");
  return { opened, native: ref.board, shown };
}

export async function listSprints(ctx: Ctx, user: Principal, id: string, deps: WorkDeps, fresh = false): Promise<WorkSprints> {
  const { opened, native } = await board(ctx, user, id, deps);
  const read = await deps.cache.read(`${opened.scope}board:${native}:sprints`, () => opened.provider.sprints(native), fresh);
  const sprints = read.value.map(({ native: sprint, ...s }) => ({ ...s, id: sprintId({ source: opened.source.id, board: native, sprint }), name: shown(s.name, opened.secrets), goal: s.goal === null ? null : shown(s.goal, opened.secrets) }));
  return { sprints, fetchedAt: read.fetchedAt, stale: read.stale };
}

export async function columns(opened: Opened, native: string, deps: WorkDeps, fresh = false) {
  const read = (await deps.cache.read(`${opened.scope}board:${native}:columns`, () => opened.provider.columns(native), fresh)).value;
  const layout = opened.layouts?.[native];
  return layout ? arranged(read, layout) : read;
}

/** Where a person keeps the columns they arranged for the boards of their own server. */
const layoutsKey = (user: Principal, sourceId: string) => `work.columns.${user.id}.${sourceId}`;

async function readLayouts(ctx: Ctx, user: Principal, sourceId: string): Promise<Record<string, WorkColumn[]>> {
  const raw = await ctx.store.getSetting(ctx.tenant, layoutsKey(user, sourceId));
  try {
    return raw ? (JSON.parse(raw) as Record<string, WorkColumn[]>) : {};
  } catch {
    return {};
  }
}

/**
 * The columns a person arranged, laid over what the tracker reads now: a status the tracker no
 * longer has is dropped, and one it has that no column names keeps a column of its own at the
 * end, so no issue goes missing from the board.
 */
export function arranged(read: readonly WorkColumn[], layout: readonly WorkColumn[]): WorkColumn[] {
  const known = new Set(read.flatMap((c) => c.statuses));
  const placed = new Set<string>();
  const columns = layout.map((c) => ({ name: c.name, statuses: c.statuses.filter((s) => known.has(s) && !placed.has(s) && placed.add(s)) })).filter((c) => c.statuses.length);
  return [...columns, ...read.filter((c) => c.statuses.some((s) => !placed.has(s))).map((c) => ({ name: c.name, statuses: c.statuses.filter((s) => !placed.has(s)) }))];
}

/**
 * Saves how a person groups their own server's board into columns, or, sent null, goes back to a
 * column per status. Each column names statuses the board has, each status once; only a board read
 * through the person's own server is arranged here, as the organization's board has Jira's own.
 */
export async function saveLayout(ctx: Ctx, user: Principal, boardGiven: string, given: unknown, deps: WorkDeps): Promise<WorkColumns> {
  const { opened, native } = await board(ctx, user, boardGiven, deps);
  if (!opened.source.id.startsWith("mcp:")) throw new ChangeRefused("this board keeps the tracker's own columns");
  const body = given as { columns?: unknown } | null;
  const layouts = await readLayouts(ctx, user, opened.source.id);
  if (body?.columns === null) {
    delete layouts[native];
  } else {
    const read = await columns({ ...opened, layouts: {} }, native, deps);
    const known = new Set(read.flatMap((c) => c.statuses));
    const list = Array.isArray(body?.columns) ? (body!.columns as unknown[]) : null;
    if (!list || list.length > 30) throw new ChangeRefused("send up to 30 columns, each a name and its statuses");
    const seen = new Set<string>();
    const cleaned = list.map((c) => {
      const { name, statuses } = (c ?? {}) as { name?: unknown; statuses?: unknown };
      if (typeof name !== "string" || !name.trim() || name.length > 60) throw new ChangeRefused("name each column in up to 60 characters");
      if (!Array.isArray(statuses) || !statuses.every((s) => typeof s === "string" && known.has(s) && !seen.has(s) && seen.add(s))) throw new ChangeRefused("each column holds statuses this board has, each status in one column");
      return { name: name.trim(), statuses: statuses as string[] };
    });
    layouts[native] = cleaned;
  }
  await ctx.store.setSetting(ctx.tenant, layoutsKey(user, opened.source.id), JSON.stringify(layouts));
  return { columns: await columns({ ...opened, layouts }, native, deps) };
}

export async function listColumns(ctx: Ctx, user: Principal, id: string, deps: WorkDeps): Promise<WorkColumns> {
  const { opened, native } = await board(ctx, user, id, deps);
  return { columns: await columns(opened, native, deps) };
}

/** An issue as a screen shows it: its text masked against the credential, and withheld where it reads like a secret. */
function cleanItem(item: ItemRead, secrets: string[], user: Principal): Omit<WorkItem, "tasks" | "column"> {
  return {
    ...item,
    summary: shown(item.summary, secrets),
    labels: item.labels.map((l) => shown(l, secrets)),
    epic: item.epic ? { key: item.epic.key, summary: shown(item.epic.summary, secrets) } : null,
    assignee: item.assignee ? { name: shown(item.assignee.name, secrets), you: assignedTo(item.assignee, user) } : null,
  };
}

/** Whether the assignee is this person: the same email on Jira, the same forge login on GitLab and GitHub. */
function assignedTo(assignee: NonNullable<ItemRead["assignee"]>, user: Principal): boolean {
  // A source read as the person knows it outright: Jira's own "assigned to me".
  if (assignee.you !== undefined) return assignee.you;
  const same = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
  return same(assignee.email, user.email) || same(assignee.login, user.forgeLogin);
}

/** A sprint's issues, a board's backlog or a whole board with no sprints, each in the board column its status sits in, with the orchestrator tasks started from it. */
export async function listItems(ctx: Ctx, user: Principal, given: { sprint: string } | { backlog: string } | { board: string }, deps: WorkDeps, fresh = false): Promise<WorkItems> {
  let boardGiven: string;
  let sprint: string | null = null;
  if ("sprint" in given) {
    const ref = parseSprintId(given.sprint);
    if (!ref) throw new WorkNotFound("no such sprint");
    boardGiven = boardId(ref);
    sprint = ref.sprint;
  } else {
    boardGiven = "backlog" in given ? given.backlog : given.board;
  }
  const { opened, native } = await board(ctx, user, boardGiven, deps);
  if (sprint !== null) {
    const known = (await listSprints(ctx, user, boardGiven, deps)).sprints;
    const asked = sprintId({ source: opened.source.id, board: native, sprint });
    if (!opened.provider.sprintPattern.test(sprint) || !known.some((s) => s.id === asked)) throw new WorkNotFound("no such sprint");
  }
  const whole = "board" in given;
  const scope: ItemScope = sprint !== null ? { sprint } : whole ? { board: true } : { backlog: true };
  const [read, cols] = await Promise.all([
    deps.cache.read(`${opened.scope}board:${native}:items:${sprint ?? (whole ? "board" : "backlog")}`, () => opened.provider.items(native, scope), fresh),
    columns(opened, native, deps, fresh),
  ]);
  const raw = read.value.items.map((i) => cleanItem(i, opened.secrets, user));
  const links = await taskLinks(ctx, user, raw.map((i) => i.key));
  const items: WorkItem[] = raw.map((i) => ({ ...i, column: columnOf(cols, i.status.name), tasks: links.get(i.key) ?? [] }));
  const estimated = items.filter((i) => i.storyPoints !== null);
  return {
    columns: cols,
    items,
    fetchedAt: read.fetchedAt,
    stale: read.stale,
    truncated: read.value.truncated,
    progress: {
      todo: items.filter((i) => i.status.category === "todo").length,
      doing: items.filter((i) => i.status.category === "doing").length,
      done: items.filter((i) => i.status.category === "done").length,
      points: estimated.length ? { total: sum(estimated), done: sum(estimated.filter((i) => i.status.category === "done")) } : null,
    },
  };
}

const sum = (items: WorkItem[]) => items.reduce((n, i) => n + (i.storyPoints ?? 0), 0);

/** Every board the organization reads, through its tracker token or its forge connections. */
async function orgBoards(ctx: Ctx, user: Principal, deps: WorkDeps): Promise<WorkBoard[]> {
  const boards: WorkBoard[] = [];
  for (const source of (await workSources(ctx, user)).filter((s) => isOrgSource(s.id))) {
    try {
      boards.push(...(await visibleBoards(ctx, user, await open(ctx, user, source.id, deps), deps)).boards);
    } catch (err) {
      // A source that does not read right now lists no boards to map; the others still do.
      if (!(err instanceof SourceFailed)) throw err;
    }
  }
  return boards;
}

/** Every board the organization reads, with the team it is mapped to; for an owner or an admin, who map them. */
export async function readBoardTeams(ctx: Ctx, user: Principal, deps: WorkDeps): Promise<WorkBoardTeams> {
  if (!manages(user)) throw new ChangeRefused("only an owner or an admin maps the organization's boards to teams");
  return { boards: (await orgBoards(ctx, user, deps)).map((b) => ({ boardId: b.id, name: b.name, team: b.team })) };
}

/** Maps boards to teams; a board left out keeps its team, and a null team takes it back to owners and admins alone. */
export async function saveBoardTeams(ctx: Ctx, user: Principal, given: unknown, deps: WorkDeps): Promise<{ saved: WorkBoardTeams; changed: string[] }> {
  if (!manages(user)) throw new ChangeRefused("only an owner or an admin maps the organization's boards to teams");
  const list = (given as { boards?: unknown })?.boards;
  if (!Array.isArray(list) || list.length > 500) throw new ChangeRefused("send boards: [{ boardId, team }]");
  const shown = new Map((await orgBoards(ctx, user, deps)).map((b) => [b.id, b]));
  const teams = new Set((await ctx.store.listRepos(ctx.tenant)).map((r) => r.team));
  const [current, projects] = await Promise.all([boardTeams(ctx), boardProjects(ctx)]);
  const changed: string[] = [];
  for (const entry of list as { boardId?: unknown; team?: unknown }[]) {
    if (typeof entry?.boardId !== "string" || !shown.has(entry.boardId)) throw new ChangeRefused("one of the boards is not read with the organization's tracker");
    if (entry.team !== null && (typeof entry.team !== "string" || !teams.has(entry.team))) throw new ChangeRefused("a board is mapped to a team the orchestrator has a repository for, or to none");
    if ((current[entry.boardId] ?? null) === entry.team) continue;
    if (entry.team === null) {
      delete current[entry.boardId];
      delete projects[entry.boardId];
    } else {
      current[entry.boardId] = entry.team;
      const project = shown.get(entry.boardId)!.project;
      if (project) projects[entry.boardId] = project;
    }
    changed.push(`${entry.boardId} -> ${entry.team ?? "owners and admins only"}`);
  }
  await ctx.store.setSetting(ctx.tenant, TEAMS_KEY, JSON.stringify(current));
  await ctx.store.setSetting(ctx.tenant, PROJECTS_KEY, JSON.stringify(projects));
  return { saved: await readBoardTeams(ctx, user, deps), changed };
}
