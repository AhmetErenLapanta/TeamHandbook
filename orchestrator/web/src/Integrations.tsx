import { useEffect, useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { call, integrationsApi } from "./api";
import type { CatalogService, OrchestratorMcpCard, ForgeCard, IntegrationCard, Integrations, Principal, RepoRecord, SlackCard, TrackerCard, TrackerConfig } from "./api";
import { Automations } from "./Automations";
import { ConfirmAction } from "./Confirm";
import { Connect } from "./Connect";
import { ForgeConnect, ForgeConnectCard, ForgeHosts, forgeReturn } from "./ForgeConnect";
import { sentence } from "./said";
import { FORGES, isHostedForge } from "../../shared/forge-def";
import { ChangeForm, ForgePanel, openedNotice } from "./Editing";
import { MyMcpServers } from "./MyMcpServers";
import { TeamMcpServers } from "./TeamMcpServers";
import { here } from "./router";
import { Select } from "./Select";
import { Loading, LoadFailed, RefreshFailed } from "./Status";
import { WORDS } from "./words";
import { workApi } from "./work/api";
import type { WorkBoardTeams } from "../../shared/work";

const ABOUT: Record<IntegrationCard["id"], { title: string; text: string }> = {
  gitlab: { title: "GitLab", text: "Open each change as a merge request on the team's GitLab project, with its reviewers and labels." },
  github: { title: "GitHub", text: "Open each change as a pull request on the team's GitHub repository, with its reviewers and labels." },
  slack: { title: "Slack", text: "Tell a channel when a request opens, merges or closes, and when a task finishes or fails." },
  tracker: { title: "Issue tracker", text: "Name a task's issue by key; with a token the agent reads its text." },
  "orchestrator-mcp": { title: "Orchestrator MCP", text: "Reach the orchestrator from Claude Code, approved once in the browser: read teams, requests and tasks, and propose changes for review." },
};

const MINE = { title: "Your MCP servers", text: "Add a remote server by its address or one run by a command, sign in once, and pick the tools a task gets." };
const TEAM = { title: "Team MCP servers", text: "Connect one that signs people in, for your own tasks or, as an owner or an admin, for everyone's." };
const AUTOMATIONS = { title: "Automations", text: "When an issue moves into a column or gets a label on the tracker's board, draft a task for someone to start, or start it." };

type CardId = IntegrationCard["id"] | "team" | "mine" | "automations";

/** The card a link opens the page on, such as Get started's optional steps do with `?open=tracker`; `?open=jira` is the Jira card, always shown at the top. */
function linkedCard(): IntegrationCard["id"] | null {
  const id = new URLSearchParams(window.location.search).get("open");
  return id !== null && Object.hasOwn(ABOUT, id) ? (id as IntegrationCard["id"]) : null;
}

/** Who each MCP card is for, said under its title: the three are easy to mistake for one another. */
const FOR: Partial<Record<CardId, string>> = {
  "orchestrator-mcp": "From Claude Code to the orchestrator: teammates reach the orchestrator from their own sessions.",
  team: "For your team's tasks: the servers the team repositories declare.",
  mine: "For your own tasks: servers only the tasks you start get.",
};

/** The page's groups, in the order a team sets them up. */
const GROUPS: { id: string; title: string; text: string; cards: CardId[] }[] = [
  { id: "hosting", title: "Code hosting", text: "Where a repository's requests open, and where they are merged.", cards: ["gitlab", "github"] },
  { id: "notifications", title: "Notifications", text: "Where the team hears what happens.", cards: ["slack"] },
  { id: "issues", title: "Issue tracking", text: "Where a task's issue comes from.", cards: ["tracker", "automations"] },
  { id: "mcp", title: "MCP servers", text: WORDS.mcpServer.means, cards: ["orchestrator-mcp", "team", "mine"] },
];

const STATE: Record<IntegrationCard["state"], { label: string; tone: string }> = {
  connected: { label: "Connected", tone: "ok" },
  requested: { label: "Requested", tone: "warn" },
  off: { label: "Not set up", tone: "" },
};

const day = (at: string) => at.slice(0, 10);

/** What Slack's approval screen sent the person back with: the channel was added, or why not. */
function slackReturn(): { added: boolean; problem: string | null } {
  const params = new URLSearchParams(window.location.search);
  return { added: params.get("slack") === "added", problem: params.get("slackProblem") };
}

function Enabled({ by, at }: { by: string | null; at: string | null }) {
  if (!by || !at) return null;
  return <p className="muted small-print">Enabled by {by} on {day(at)}</p>;
}

/**
 * Integrations: a card for each service the orchestrator works with, its state, and who turned it
 * on. Set up opens the card's own settings in place; what an admin alone changes is shown to
 * everyone else as it stands.
 */
export function IntegrationsView({ me, repos }: { me: Principal; repos: RepoRecord[] }) {
  const [read, setRead] = useState<Integrations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // A forge's connection returns here with the card it was started from to open.
  const slackBack = slackReturn();
  const [open, setOpen] = useState<IntegrationCard["id"] | null>(() => forgeReturn().connected ?? linkedCard() ?? (slackBack.added ? "slack" : null));
  const forgeProblem = forgeReturn().problem;
  // A server's sign-in returns here with what happened; that card opens to say it. Atlassian's, begun from the Jira card, says it there.
  const [mineOpen, setMineOpen] = useState(() => /[?&](connected=(?!atlassian\b)|problem=)/.test(window.location.search + window.location.hash));
  const load = () => {
    setError(null);
    integrationsApi.list().then(setRead, (e: Error) => setError(e.message));
  };
  useEffect(() => {
    load();
  }, []);
  const loaded = read !== null;
  useEffect(() => {
    if (loaded && open) document.getElementById(`card-${open}`)?.scrollIntoView({ block: "start" });
  }, [loaded]);
  const words = query.trim().toLowerCase();
  const [teamOpen, setTeamOpen] = useState(false);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const about = (id: CardId) => (id === "team" ? TEAM : id === "mine" ? MINE : id === "automations" ? AUTOMATIONS : ABOUT[id]);
  const matches = (id: CardId) => !words || `${about(id).title} ${about(id).text} ${FOR[id] ?? ""}`.toLowerCase().includes(words);
  // The page is laid out the same in every mode. Automations are an owner's or an admin's to set;
  // nobody else is shown the card.
  const local = Boolean(read?.local);
  // With Jira signed in, the tracker's token card waits until it is set up or asked for from the
  // Jira card, so issues are not offered twice.
  const trackerSet = Boolean(read?.integrations.some((c) => c.id === "tracker" && (c as TrackerCard).config));
  const present = (id: CardId) =>
    (id !== "tracker" || trackerSet || !read?.jira.mcp?.connected || open === "tracker") &&
    (id === "team" || id === "mine" || (id === "automations" ? Boolean(read?.canManage) : Boolean(read?.integrations.some((c) => c.id === id))));
  const jiraShown = !words || `jira atlassian ${JIRA_ABOUT}`.toLowerCase().includes(words);
  const catalogShown = (read?.catalog ?? []).filter((c) => !words || `${c.name} ${c.about}`.toLowerCase().includes(words));
  const groups = GROUPS.map((g) => ({ ...g, cards: g.cards.filter((id) => present(id) && matches(id)) })).filter((g) => g.cards.length);
  const card = (id: CardId) => {
    const title = about(id).title;
    const forLine = FOR[id] ? <p className="small-print muted">{FOR[id]}</p> : null;
    if (id === "team" || id === "mine" || id === "automations") {
      const isOpen = id === "team" ? teamOpen : id === "mine" ? mineOpen : automationsOpen;
      const toggle = () => (id === "team" ? setTeamOpen(!teamOpen) : id === "mine" ? setMineOpen(!mineOpen) : setAutomationsOpen(!automationsOpen));
      return (
        <li key={id} className="panel card">
          <div className="card-head"><h3 id={`card-${id}`}>{title}</h3></div>
          {forLine}
          <p>{about(id).text}</p>
          <button type="button" className="secondary" aria-expanded={isOpen} aria-controls={`body-${id}`} onClick={toggle}>{isOpen ? "Close" : "Manage"}</button>
          {isOpen ? <div id={`body-${id}`} className="card-body" role="region" aria-labelledby={`card-${id}`}>{id === "team" ? <TeamMcpServers /> : id === "mine" ? <MyMcpServers me={me} repos={repos} /> : <Automations repos={repos} />}</div> : null}
        </li>
      );
    }
    const c = read!.integrations.find((x) => x.id === id)!;
    // A forge is one main action, as Jira is: the person's own CLI on their own machine, the organization's connection elsewhere; tokens, hosts and an own application are under Other ways to connect.
    if (isHostedForge(c.id)) {
      const forgeCard = c as ForgeCard;
      return (
        <li key={id} className="panel card">
          <ForgeConnectCard card={forgeCard} repos={repos} onChanged={load} other={<ForgeBody card={forgeCard} forges={read!.integrations.filter((x): x is ForgeCard => isHostedForge(x.id))} repos={repos} canManage={read!.canManage} local={local} onChanged={load} />} />
        </li>
      );
    }
    // Slack is one main action once whoever runs the orchestrator has registered a Slack app: Slack's own approval screen picks the channel; the webhook address is under Other ways to connect.
    if (c.id === "slack" && c.state === "off" && read!.canManage && c.addable) {
      return (
        <li key={id} className="panel card">
          <SlackAdd card={c} read={read!} onSaved={load} problem={slackBack.problem} />
        </li>
      );
    }
    return (
      <li key={id} className="panel card">
        <div className="card-head">
          <h3 id={`card-${id}`}>{title}</h3>
          {STATE[c.state].tone ? <span className={`badge ${STATE[c.state].tone}`}>{STATE[c.state].label}</span> : <span className="badge">{STATE[c.state].label}</span>}
        </div>
        {forLine}
        <p>{about(id).text}</p>
        <Enabled by={c.enabledBy} at={c.enabledAt} />
        <button type="button" className="secondary" aria-expanded={open === c.id} aria-controls={`body-${id}`} onClick={() => setOpen(open === c.id ? null : c.id)}>
          {open === c.id ? "Close" : c.state === "off" ? "Set up" : "Manage"}
        </button>
        {open === c.id ? (
          <div id={`body-${id}`} className="card-body" role="region" aria-labelledby={`card-${id}`}>
            {c.id === "slack" ? <SlackBody card={c} read={read!} onSaved={load} added={slackBack.added} /> : null}
            {c.id === "tracker" ? <TrackerBody card={c} canManage={read!.canManage} onSaved={load} repos={repos} local={local} /> : null}
            {c.id === "orchestrator-mcp" ? <OrchestratorMcpBody card={c} repos={repos} onOpened={load} /> : null}
            {c.id === "tracker" && ((c as TrackerCard).config?.kind ?? "jira") === "jira" ? <WritesSwitch on={read!.writes} canManage={read!.canManage} onChanged={load} /> : null}
          </div>
        ) : null}
      </li>
    );
  };
  return (
    <section className="integrations" aria-labelledby="integrations-h">
      <header className="page-head">
        <h1 id="integrations-h">Integrations</h1>
        <p className="muted">Services the orchestrator works with.</p>
        {read?.claudeCodeServers ? <p className="muted">{read.claudeCodeServers === 1 ? "Your tasks use the MCP server in your Claude Code." : `Your tasks use the ${read.claudeCodeServers} MCP servers in your Claude Code.`}</p> : null}
      </header>
      {/* The forge names only what went wrong; the next step is said here once, as Welcome says it. */}
      {forgeProblem ? <p className="error" role="alert">GitLab or GitHub did not connect: {sentence(forgeProblem)} Press Connect with GitLab or Connect with GitHub to try again.</p> : null}
      {!read ? (error ? <LoadFailed what="integrations" reason={error} onRetry={load} panel /> : <Loading what="integrations" panel />) : (
        <>
          <label className="search">
            <span className="visually-hidden">Search integrations</span>
            <input type="search" placeholder="Search integrations" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {error ? <RefreshFailed what="integrations" reason={error} onRetry={load} /> : null}
          {/* What connects in one sign-in sits first, in the page's card layout like every group. */}
          {jiraShown || catalogShown.length ? (
            <section className="integration-group" aria-labelledby="group-start">
              <h2 id="group-start">Start here</h2>
              <p className="muted">Sign in once and the orchestrator reads it as you. Nothing there changes.</p>
              {read.signIn ? null : <p className="warning" id="start-no-return">A sign-in returns to this orchestrator's own address, and none is set. Whoever runs it sets ORCHESTRATOR_PUBLIC_URL; until then these sign-ins are off.</p>}
              <ul className="cards">
                {jiraShown ? (
                  <li className="panel card">
                    <JiraCard read={read} onToken={() => {
                      setOpen("tracker");
                      requestAnimationFrame(() => document.getElementById("card-tracker")?.scrollIntoView({ block: "start" }));
                    }} />
                  </li>
                ) : null}
                {catalogShown.map((service) => (
                  <li key={service.id} className="panel card">
                    <CatalogEntry service={service} signIn={read.signIn} onTools={() => {
                      setMineOpen(true);
                      requestAnimationFrame(() => document.getElementById("card-mine")?.scrollIntoView({ block: "start" }));
                    }} />
                  </li>
                ))}
              </ul>
              <p className="muted small">Another service with a remote MCP server is added by its address under <button type="button" className="link" onClick={() => {
                setMineOpen(true);
                requestAnimationFrame(() => document.getElementById("card-mine")?.scrollIntoView({ block: "start" }));
              }}>Your MCP servers</button>.</p>
            </section>
          ) : null}
          {!groups.length && !jiraShown && !catalogShown.length ? <p className="muted">No integration matches "{query}".</p> : (
            groups.map((g) => (
              <section key={g.id} className="integration-group" aria-labelledby={`group-${g.id}`}>
                <h2 id={`group-${g.id}`}>{g.title}</h2>
                <p className="muted">{g.text}</p>
                <ul className="cards">{g.cards.map(card)}</ul>
              </section>
            ))
          )}
        </>
      )}
    </section>
  );
}

const JIRA_ABOUT = "See your Jira boards on Work and start agents on their issues. Nothing in Jira changes.";

/**
 * Jira first, in one step: signing in with Atlassian makes Atlassian's MCP server the person's own,
 * allowed only the tools that read, and opens Atlassian's approval screen; back here the card says
 * Connected and how many boards Work reads. An owner or an admin can use an API token instead.
 * Nothing in Jira changes either way unless changing issues is turned on.
 */
function JiraCard({ read, onToken }: { read: Integrations; onToken: () => void }) {
  const tracker = read.integrations.find((c): c is TrackerCard => c.id === "tracker");
  const source = read.jira.mcp?.connected ? `mcp:${read.jira.mcp.name}` : tracker?.config?.kind === "jira" && tracker.token ? "tracker" : null;
  const [boards, setBoards] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (source) workApi.boards(source).then((r) => setBoards(r.boards.length), () => setBoards(null));
  }, [source]);
  const signIn = () => {
    setBusy(true);
    setError(null);
    integrationsApi.signInJira().then((url) => window.location.assign(url), (e: Error) => {
      setError(e.message);
      setBusy(false);
    });
  };
  return (
    <Connect
      id="jira"
      name="Jira"
      level={3}
      connected={Boolean(source)}
      about={source ? `${source === "tracker" ? "Read with an API token." : "Read through Atlassian as you."}${boards === null ? "" : ` ${boards} ${boards === 1 ? "board" : "boards"} on Work.`} Nothing in Jira changes.` : "See your Jira boards on Work and start agents on their issues. Nothing in Jira changes."}
      action={source ? <a className="button" href={here("work")}>Open Work</a> : <button type="button" disabled={busy || !read.signIn} aria-describedby={read.signIn ? undefined : "start-no-return"} onClick={signIn}>Sign in with Atlassian</button>}
      other={!source && read.canManage ? <p>Read Jira, Linear or GitLab issues with an API token instead. <button type="button" className="link" onClick={onToken}>Use an API token instead</button></p> : undefined}
      error={error}
    />
  );
}


/**
 * A service from the catalogue in one step: signing in adds its own MCP server as the person's and
 * opens its approval screen; back here only its tools that read are allowed, so a task the person
 * starts reads it as them and changes nothing there.
 */
function CatalogEntry({ service, signIn: returns, onTools }: { service: CatalogService; signIn: boolean; onTools: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = Boolean(service.server?.connected);
  const signIn = () => {
    setBusy(true);
    setError(null);
    integrationsApi.signInCatalog(service.id).then((url) => window.location.assign(url), (e: Error) => {
      setError(`${e.message} Add it with a token under Your MCP servers instead.`);
      setBusy(false);
    });
  };
  const tools = service.server?.tools ?? 0;
  return (
    <Connect
      id={service.id}
      name={service.name}
      level={3}
      connected={connected}
      about={connected ? `${tools ? `${tools} ${tools === 1 ? "tool reads" : "tools read"} ${service.name} as you in tasks you start.` : `No tool is allowed yet; load them under Your MCP servers.`} Nothing in ${service.name} changes.` : service.about}
      action={connected ? <button type="button" className="secondary" onClick={onTools}>Choose tools</button> : <button type="button" className="secondary" disabled={busy || !returns} aria-describedby={returns ? undefined : "start-no-return"} onClick={signIn}>Sign in with {service.name}</button>}
      error={error}
    />
  );
}

/**
 * Whether moving a card on Work moves its issue in Jira, the one tracker the orchestrator moves
 * issues in: off until an owner or an admin turns it on, so Jira is read and nothing there changes
 * unasked. A task's agent never changes an issue, whatever this says: the switch opens only the
 * orchestrator's own moves, so the tracker's writing tools stay refused to every agent.
 */
function WritesSwitch({ on, canManage, onChanged }: { on: boolean; canManage: boolean; onChanged: () => void }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flip = () => {
    setBusy(true);
    setError(null);
    integrationsApi.saveWrites(!on).then(onChanged, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const said = on
    ? "On: moving a card on Work moves its issue in Jira."
    : "Off: the orchestrator reads Jira and changes nothing there.";
  return (
    <div className="moves-switch">
      <button type="button" role="switch" aria-checked={on} aria-describedby={id} disabled={busy || !canManage} onClick={flip} className="switch">
        <span className="switch-track" aria-hidden="true"><span className="switch-knob" /></span>
        Move Jira issues when a card moves on Work
      </button>
      <p id={id} className="muted small">{said}{!canManage ? " An owner or an admin turns it on." : ""}</p>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </div>
  );
}

/** Whether the orchestrator reads a repository from a path on its own machine, where requests open on its local copy. */
export function reachedByPath(url: string): boolean {
  return url.startsWith("file://") || url.startsWith("/");
}

/**
 * The forge settings a repository's own address points to: its GitLab or GitHub API and project,
 * for the form to start from. Null for an address that names neither, such as a path.
 */
export function forgeGuess(url: string): { kind: "gitlab" | "github"; apiUrl: string; project: string } | null {
  if (reachedByPath(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const project = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!project.includes("/")) return null;
  return parsed.hostname === "github.com"
    ? { kind: "github", apiUrl: "https://api.github.com", project }
    : { kind: "gitlab", apiUrl: `${parsed.origin}/api/v4`, project };
}

/**
 * Where each repository's requests open, and what to do to open them on this forge: a repository
 * reached by its forge address is set up here with a token; one reached by a path on this machine
 * opens them on the orchestrator's local copy until the configuration gives its forge address instead.
 */
function ForgeBody({ card, forges, repos, canManage, local, onChanged }: { card: ForgeCard; forges: ForgeCard[]; repos: RepoRecord[]; canManage: boolean; local: boolean; onChanged: () => void }) {
  const forge = FORGES[card.id].label;
  const [open, setOpen] = useState<string | null>(null);
  const listed = repos.filter((r) => r.configured !== false);
  const where = (r: RepoRecord) => {
    const set = forges.flatMap((f) => f.repos.map((x) => ({ ...x, kind: f.id }))).find((x) => x.repoId === r.id);
    if (set) return `${FORGES[set.kind].label}${set.project ? `, ${set.project}` : ""}`;
    return reachedByPath(r.url) ? "The orchestrator's own copy" : "Nowhere yet: no token is set";
  };
  // The organization's one-click connection and its hosts are a team's; on one person's machine each repository takes its own token.
  const oneClick = canManage && !local ? (
    <>
      <ForgeHosts kind={card.id} />
      <ForgeConnect kind={card.id} repos={repos} onChanged={onChanged} />
    </>
  ) : null;
  if (!listed.length) return <>{oneClick}{canManage ? null : <p className="muted">No repository is connected yet. An owner or an admin connects them on Repositories.</p>}</>;
  const byPath = listed.filter((r) => reachedByPath(r.url));
  return (
    <>
      {oneClick}
      <p>A request opens on {forge} when its repository is reached by its {forge} address and has a token here. Merging then happens on {forge}, with the team's reviewers and labels.</p>
      <table>
        <thead><tr><th scope="col">Repository</th><th scope="col">Read from</th><th scope="col">Requests open on</th>{canManage ? <th scope="col"><span className="visually-hidden">Action</span></th> : null}</tr></thead>
        <tbody>
          {listed.map((r) => (
            <tr key={r.id}>
              <th scope="row">{r.name}</th>
              <td>{reachedByPath(r.url) ? (local ? "A path on this machine" : "A path on the server") : new URL(r.url).host}</td>
              <td>{where(r)}</td>
              {canManage ? (
                <td>
                  {reachedByPath(r.url) ? null : (
                    <button type="button" className="secondary small" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)} aria-label={`Set up ${forge} for ${r.name}`}>
                      {open === r.id ? "Close" : "Set up"}
                    </button>
                  )}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {open ? (() => {
        const repo = listed.find((r) => r.id === open)!;
        const guess = forgeGuess(repo.url);
        return <ForgePanel key={repo.id} repo={repo} {...(guess ? { suggest: guess } : {})} />;
      })() : null}
      {!canManage ? <p className="muted">An owner or admin sets where a repository's requests open.</p> : null}
      {canManage && byPath.length ? (
        <details>
          <summary>Open the requests of {byPath.length === 1 ? byPath[0]!.name : `${byPath.length} repositories read from a path`} on {forge}</summary>
          <p>The orchestrator reads {byPath.map((r) => r.name).join(", ")} from a path on this machine, so their requests open on its own copy. To open them on {forge}, give each its {forge} address in the file ORCHESTRATOR_CONFIG names, restart the orchestrator, then press Set up here and enter a token:</p>
          <pre className="pre mono">{JSON.stringify({ id: byPath[0]!.id, team: byPath[0]!.team, name: byPath[0]!.name, url: `https://${FORGES[card.id].homeHosts[0]}/<${FORGES[card.id].projectShape.replace("/", ">/<")}>.git` }, null, 2)}</pre>
          <p className="muted">Only the url changes; the requests and tasks the orchestrator recorded stay with the repository. A private project is read with a token in that address, which the orchestrator masks wherever it shows it.</p>
        </details>
      ) : null}
    </>
  );
}

function Problem({ error, id }: { error: string | null; id: string }) {
  return error ? <p className="error" role="alert" id={id}>{error}</p> : null;
}

function useAction(onDone: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<unknown>, done: string) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    work().then(
      () => {
        setBusy(false);
        setNotice(done);
        onDone();
      },
      (e: Error) => {
        setBusy(false);
        setError(e.message);
      },
    );
  };
  /** After a confirmed change, which reports its own failure in the question it asked. */
  const done = (said: string) => {
    setError(null);
    setNotice(said);
    onDone();
  };
  return { error, notice, busy, run, done, setNotice, setError };
}

/** Slack in one step: its approval screen, where the person picks the channel, and back with the channel's webhook address sealed. */
function SlackAdd({ card, read, onSaved, problem }: { card: SlackCard; read: Integrations; onSaved: () => void; problem: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(problem);
  const add = () => {
    setBusy(true);
    setError(null);
    integrationsApi.addSlack().then((url) => window.location.assign(url), (e: Error) => {
      setError(e.message);
      setBusy(false);
    });
  };
  return <Connect id="slack" name="Slack" level={3} connected={false} about={ABOUT.slack.text} action={<button type="button" disabled={busy} onClick={add}>Add to Slack</button>} other={<SlackBody card={card} read={read} onSaved={onSaved} added={false} />} error={error} />;
}

function SlackBody({ card, read, onSaved, added }: { card: SlackCard; read: Integrations; onSaved: () => void; added: boolean }) {
  const [webhook, setWebhook] = useState("");
  const [events, setEvents] = useState<string[]>(card.events.length ? card.events : read.slackEvents.map((e) => e.kind));
  const action = useAction(onSaved);
  const errorId = useId();
  if (!read.canManage) {
    return card.state === "off" ? <p className="muted">An admin connects a Slack channel.</p> : <p>Posting {card.events.length} kinds of event to the channel.</p>;
  }
  const save = (e: FormEvent) => {
    e.preventDefault();
    action.run(() => integrationsApi.saveSlack({ ...(webhook ? { webhookUrl: webhook } : {}), events }).finally(() => setWebhook("")), "Saved. The webhook address is sealed; the orchestrator never shows it again.");
  };
  const toggle = (kind: string) => setEvents(events.includes(kind) ? events.filter((k) => k !== kind) : [...events, kind]);
  return (
    <form className="form" onSubmit={save} aria-label="Slack notifications">
      {added ? <p role="status">Slack added the channel. Pick the events to post below.</p> : null}
      {card.state === "off" && !card.addable && card.redirectUri ? <p className="muted small">To add Slack in one press, whoever runs this orchestrator registers a Slack app with the redirect address {card.redirectUri} and sets ORCHESTRATOR_SLACK_CLIENT_ID and ORCHESTRATOR_SLACK_CLIENT_SECRET.</p> : null}
      <label>
        Incoming webhook address
        <input type="password" autoComplete="off" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder={card.state === "off" ? "https://hooks.slack.com/services/..." : "set; empty keeps it"} required={card.state === "off"} aria-describedby={action.error ? errorId : undefined} />
      </label>
      <fieldset className="teams">
        <legend>Post when</legend>
        {read.slackEvents.map((e) => (
          <label key={e.kind} className="check"><input type="checkbox" checked={events.includes(e.kind)} onChange={() => toggle(e.kind)} />{e.label}</label>
        ))}
      </fieldset>
      {card.delivery ? <p className={card.delivery.ok ? "muted" : "error"}>Last message {day(card.delivery.at)}: {card.delivery.detail}</p> : null}
      {!read.vault ? <p className="error">Set ORCHESTRATOR_SECRET_KEY on the server to store a webhook address.</p> : null}
      <Problem error={action.error} id={errorId} />
      {action.notice ? <p role="status">{action.notice}</p> : null}
      <div className="actions">
        <button type="submit" disabled={action.busy || !read.vault}>Save</button>
        {card.state !== "off" ? (
          <>
            <button type="button" className="secondary" disabled={action.busy} onClick={() => action.run(integrationsApi.testSlack, "Test message sent; the last message line says how it went.")}>Send a test message</button>
            <ConfirmAction
              trigger="Disconnect"
              triggerLabel="Disconnect Slack"
              consequence="The channel stops hearing about requests and tasks at once, and the webhook address is deleted; connecting again needs it pasted again."
              confirm="Disconnect Slack"
              keep="Keep Slack"
              onConfirm={() => integrationsApi.removeSlack().then(() => action.done("Slack is disconnected and its webhook address removed."))}
            />
          </>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Which team sees each board the organization reads: a board read with the organization's token
 * shows more than any one person should, so until it is mapped to a team only owners and admins
 * see it, and a task reads an issue through the token only on a board shown to its person.
 */
function BoardTeams({ repos }: { repos: RepoRecord[] }) {
  const [boards, setBoards] = useState<WorkBoardTeams["boards"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = () => {
    setLoadError(null);
    call<WorkBoardTeams>("GET", "/api/work/boards/teams").then((r) => setBoards(r.boards), (e: Error) => setLoadError(e.message));
  };
  useEffect(() => {
    load();
  }, []);
  const teams = [...new Set(repos.map((r) => r.team))].sort();
  const map = (board: WorkBoardTeams["boards"][number], team: string) => {
    setError(null);
    call<WorkBoardTeams>("PUT", "/api/work/boards/teams", { boards: [{ boardId: board.boardId, team: team || null }] }).then((r) => {
      setBoards(r.boards);
      setNotice(team ? `${board.name} is shown to ${team}.` : `${board.name} is shown to owners and admins only.`);
    }, (e: Error) => setError(e.message));
  };
  return (
    <section aria-label="Boards and teams">
      <h4>Boards and teams</h4>
      <p className="muted">A board shows to the team it is mapped to, and to owners and admins; one mapped to none shows to owners and admins only.</p>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {!boards ? (loadError ? <LoadFailed what="the boards" reason={loadError} onRetry={load} /> : <Loading what="the boards" />) : !boards.length ? <p className="muted">The tracker lists no board for the organization yet.</p> : (
        <table>
          <thead><tr><th scope="col">Board</th><th scope="col">Shown to</th></tr></thead>
          <tbody>
            {boards.map((b) => (
              <tr key={b.boardId}>
                <th scope="row">{b.name}</th>
                <td>
                  <select aria-label={`Team for ${b.name}`} value={b.team ?? ""} onChange={(e) => map(b, e.target.value)}>
                    <option value="">None: owners and admins only</option>
                    {teams.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function TrackerBody({ card, canManage, onSaved, repos, local }: { card: TrackerCard; canManage: boolean; onSaved: () => void; repos: RepoRecord[]; local: boolean }) {
  const [form, setForm] = useState<TrackerConfig>(card.config ?? { kind: "jira", url: "" });
  const [token, setToken] = useState("");
  const action = useAction(onSaved);
  const errorId = useId();
  const reading = card.token
    ? <p>Issues are read with a token set by {card.token.setBy} on {day(card.token.setAt)}: a task gets its issue's text, description, acceptance criteria, sub-tasks and latest comments.</p>
    : <p className="muted">No token is set, so a task gets its issue's link only.</p>;
  if (!canManage) {
    return (
      <>
        {card.config ? <p>Tasks link to {card.config.kind} issues at <span className="mono">{card.config.url}</span>.</p> : <p className="muted">An admin connects the issue tracker.</p>}
        {card.config ? reading : null}
      </>
    );
  }
  const save = (e: FormEvent) => {
    e.preventDefault();
    action.run(() => integrationsApi.saveTracker({ ...form, ...(token ? { token } : {}) }).finally(() => setToken("")), "Saved. A task's issue can now be named by its key.");
  };
  return (
    <form className="form" onSubmit={save} aria-label="Issue tracker">
      <Select label="Tracker" value={form.kind} onChange={(v) => setForm({ kind: v as TrackerConfig["kind"], url: "" })} options={[{ value: "jira", label: "Jira" }, { value: "linear", label: "Linear" }, { value: "gitlab", label: "GitLab issues" }, { value: "github", label: "GitHub issues" }]} />
      <label>
        Address
        <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder={form.kind === "jira" ? "https://acme.atlassian.net" : form.kind === "linear" ? "https://linear.app/acme" : `https://${FORGES[form.kind].homeHosts[0]}`} required={form.kind === "jira" || form.kind === "linear"} aria-describedby={action.error ? errorId : undefined} />
      </label>
      {form.kind === "jira" ? (
        <label>
          Account email
          <input type="email" value={form.email ?? ""} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="the account the API token belongs to" aria-describedby={action.error ? errorId : undefined} />
        </label>
      ) : null}
      {form.kind !== "github" ? (
        <label>
          {form.kind === "jira" ? "API token" : form.kind === "linear" ? "API key" : "Access token"}
          <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={card.token ? "set; empty keeps it while the site stays" : "read-only; leave empty to link issues without reading them"} aria-describedby={action.error ? errorId : undefined} />
        </label>
      ) : null}
      {card.config ? reading : null}
      {card.config && card.token && !local ? <BoardTeams repos={repos} /> : null}
      <Problem error={action.error} id={errorId} />
      {action.notice ? <p role="status">{action.notice}</p> : null}
      <div className="actions">
        <button type="submit" disabled={action.busy}>Save</button>
        {card.state !== "off" ? (
          <ConfirmAction
            trigger="Disconnect"
            triggerLabel="Disconnect the issue tracker"
            consequence="Tasks get an issue's link only from now on, issue keys stop becoming links, and the token is deleted."
            confirm="Disconnect tracker"
            keep="Keep tracker"
            onConfirm={() => integrationsApi.removeTracker().then(() => action.done("The issue tracker is disconnected and its token removed."))}
          />
        ) : null}
      </div>
    </form>
  );
}

function OrchestratorMcpBody({ card, repos, onOpened }: { card: OrchestratorMcpCard; repos: RepoRecord[]; onOpened: () => void }) {
  const [setting, setSetting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = (r: OrchestratorMcpCard["repos"][number]): ReactNode =>
    r.state === "connected" ? "Connected" : r.state === "requested" && r.request ? <a href={r.request.url}>Requested in #{r.request.number}</a> : "Not set up";
  return (
    <>
      {card.missing.length ? (
        <ul className="findings">{card.missing.map((m) => <li key={m} className="error">{m}</li>)}</ul>
      ) : null}
      {card.endpoint ? (
        <p>Teammates reach it at <span className="mono">{card.endpoint}</span>. Turning it on for a team opens a request that adds it to the team's <code>.mcp.json</code>; once merged, each teammate's Claude Code asks them to approve it in the browser the first time, as themselves. An API key works too, for automation.</p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <table>
        <thead><tr><th>Repository</th><th>State</th><th>Enabled</th><th><span className="visually-hidden">Action</span></th></tr></thead>
        <tbody>
          {card.repos.map((r) => {
            const repo = repos.find((x) => x.id === r.repoId);
            return (
              <tr key={r.repoId}>
                <td>{r.name}</td>
                <td>{status(r)}</td>
                <td>{r.enabledBy && r.enabledAt ? `${r.enabledBy}, ${day(r.enabledAt)}` : ""}</td>
                <td>
                  {r.state === "off" && r.canChange && !card.missing.length && repo?.head && setting !== r.repoId ? (
                    <button type="button" className="small" onClick={() => setSetting(r.repoId)}>Set up</button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {setting ? (
        <ChangeForm
          repoId={setting}
          head={repos.find((x) => x.id === setting)?.head ?? ""}
          steps={{
            proposal: () => integrationsApi.mcpProposal(setting),
            send: (message, branch) => integrationsApi.proposeMcp(setting, repos.find((x) => x.id === setting)?.head ?? "", message, branch),
          }}
          submitLabel="Review the request"
          onOpened={(r) => {
            setSetting(null);
            setNotice(openedNotice(r));
            onOpened();
          }}
          onCancel={() => setSetting(null)}
        >
          {() => (
            <>
              <h4>Add the orchestrator's MCP server to {repos.find((x) => x.id === setting)?.name}</h4>
              <pre className="pre mono">{JSON.stringify({ mcpServers: { "teamhandbook-orchestrator": card.entry } }, null, 2)}</pre>
            </>
          )}
        </ChangeForm>
      ) : null}
    </>
  );
}
