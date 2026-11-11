import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, auth, identityApi, manages, NotFound, setOrg, SignedOut, tasksApi } from "./api";
import type { AuthConfig, IdentityConfig, Inventory, JoinMessage, OrgList, Principal, SkillOverlap, RepoRecord, RequestRecord, ScaffoldRefresh, TaskRecord, UsageCount } from "./api";
import { ActivityView } from "./Activity";
import { Setup, SignIn } from "./Auth";
import { TeamView } from "./team/Team";
import { canEdit, openedNotice, RequestList } from "./Editing";
import { IntegrationsView } from "./Integrations";
import { PageHead } from "./design/PageHead";
import { Hint } from "./Hint";
import { ConnectRepo } from "./ConnectRepo";
import { FirstTask } from "./projects/FirstTask";
import { FolderPicker } from "./projects/FolderPicker";
import type { PickerPlace } from "./projects/FolderPicker";
import { folderPlace, projectsRead } from "./projects-read";
import type { Project } from "./projects-read";
import { ProjectSection } from "./repo/Settings";
import { TaskTools } from "./repo/TaskTools";
import { changesToReview, lastTaskByProject, opensRequests } from "./projects/review";
import { followInApp, here, legacyPath, movedPath, navigate, pathIn, placeOf, rootTarget, useLocation } from "./router";
import { Join } from "./settings/Join";
import { Signup } from "./Signup";
import { ACCOUNT_DELETED, AccountDeleted } from "./settings/Account";
import { SettingsView } from "./settings/Settings";
import { NotFoundPage } from "./NotFound";
import { Commands } from "./repo/Commands";
import { History } from "./repo/History";
import { McpServers } from "./repo/McpServers";
import { Overview } from "./repo/Overview";
import { Requests } from "./repo/Requests";
import { Settings } from "./repo/Settings";
import { Skills } from "./repo/Skills";
import type { RepoPanelProps } from "./repo/types";
import { SectionBoundary } from "./SectionBoundary";
import { Loading, LoadFailed } from "./Status";
import { Shell, SubNav } from "./Shell";
import { startLink, TaskList, TaskView } from "./Tasks";
import { workApi } from "./work/api";
import type { WorkSource } from "./work/api";
import { WorkView } from "./work/Work";
import { OperatorPage } from "./Operator";
import { WelcomeView } from "./Welcome";
import { WORDS } from "./words";

function SyncProblem({ repo, me, error, onSynced }: { repo: RepoRecord; me: Principal; error: string; onSynced: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const again = () => {
    setBusy(true);
    setFailed(null);
    api.sync(repo.id).then(onSynced, (e: Error) => {
      setFailed(e.message);
      setBusy(false);
    });
  };
  return (
    <div className="panel problem" role="alert">
      <p className="error">{repo.head ? "The last sync failed; this page shows the project as the orchestrator last read it." : "The orchestrator has not read this repository yet."} {error}</p>
      {canEdit(me, repo.team) ? (
        <div className="actions">
          <button type="button" onClick={again} disabled={busy}>{busy ? "Syncing…" : "Sync again"}</button>
          {failed ? <span className="error">{failed}</span> : <span className="muted">Check the repository's address and the orchestrator's access to it first when it fails again.</span>}
        </div>
      ) : <p className="muted">An admin or an owner of {repo.team} can sync it again.</p>}
    </div>
  );
}

/**
 * A repository the configuration no longer lists: what that means, and for an admin the way
 * to remove it. Confirmed on the page rather than in a browser dialog.
 */
function OutOfConfiguration({ repo, me, onDisconnected }: { repo: RepoRecord; me: Principal; onDisconnected: () => Promise<unknown> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disconnect = () => {
    setBusy(true);
    setError(null);
    api.disconnect(repo.id).then(
      () => {
        navigate(here("tasks"));
        void onDisconnected();
      },
      (e: Error) => {
        setError(e.message);
        setBusy(false);
      },
    );
  };
  return (
    <section className="panel problem" aria-labelledby="out-h">
      <h2 id="out-h">Not in the configuration</h2>
      <p>The orchestrator's configuration no longer lists this repository, so it is not synced or changed. <Hint label="a repository out of the configuration">Its requests, tasks and history stay readable, and open requests can still be merged or closed. Put it back in ORCHESTRATOR_CONFIG to sync it again.</Hint></p>
      {manages(me) ? (
        asking ? (
          <div className="problem">
            <p>Disconnecting deletes the orchestrator's copy of {repo.name}, its forge access and sealed token, and the id its usage endpoint carries. The team's repository is not touched, and the orchestrator's records of its requests, tasks and skill use stay.</p>
            <div className="actions">
              <button type="button" onClick={disconnect} disabled={busy}>Disconnect {repo.name}</button>
              <button type="button" className="secondary" onClick={() => setAsking(false)} disabled={busy}>Cancel</button>
            </div>
          </div>
        ) : <div className="actions"><button type="button" className="secondary" onClick={() => setAsking(true)}>Disconnect project</button></div>
      ) : <p className="muted">An admin can disconnect it.</p>}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </section>
  );
}

/** The parts of a repository's page, each at /<org>/repositories/<id>/<tab>; the first is the page's own address. */
const REPO_TABS = [
  { id: "overview", label: "Overview" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP servers" },
  { id: "commands", label: "Commands" },
  { id: "requests", label: `${WORDS.request.term}s` },
  { id: "settings", label: "Settings" },
] as const;
type RepoTab = (typeof REPO_TABS)[number]["id"];
const repoTabPath = (repoId: string, tab: RepoTab) => (tab === "overview" ? here("repositories", repoId) : here("repositories", repoId, tab));

function RepoView({ repoId, tab, me, known, onSynced }: { repoId: string; tab: RepoTab; me: Principal; known: RepoRecord | undefined; onSynced: () => Promise<unknown> }) {
  const [data, setData] = useState<{ repo: RepoRecord; inventory: Inventory; join: JoinMessage; refresh: ScaffoldRefresh } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [usage, setUsage] = useState<{ days: number; usage: UsageCount[]; shown: boolean } | null>(null);
  const [overlaps, setOverlaps] = useState<Record<string, SkillOverlap> | null>(null);
  const [requestsRead, setRequestsRead] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  // An answer for a repository opened before this one, landing late, is dropped rather than shown here.
  const shown = useRef(repoId);
  shown.current = repoId;
  const forThis = <T,>(set: (value: T) => void) => (value: T) => {
    if (shown.current === repoId) set(value);
  };
  // A folder without Git, or a Git repository with no commit, has nothing for the orchestrator to read, so its page is the project alone.
  const [folder, setFolder] = useState<{ project: Project; home: string | null } | null>(null);
  const [folderReads, setFolderReads] = useState(0);
  useEffect(() => {
    if (known?.head) return;
    projectsRead.list().then(({ projects, home }) => {
      const project = projects.find((p) => p.id === repoId);
      if (shown.current !== repoId) return;
      setFolder(project?.facts && (project.facts.git === "none" || project.facts.empty) ? { project, home: home ?? null } : null);
    }, () => undefined);
  }, [repoId, known?.head, folderReads]);
  const reload = () => {
    api.usage(repoId).then(forThis(setUsage), forThis(() => setUsage(null)));
    setRequestsRead((n) => n + 1);
  };
  const reloadAll = () => {
    setError(null);
    api.inventory(repoId).then(forThis(setData), forThis((e: Error) => setError(e.message)));
    // Read apart from the inventory: worked out on the server in slices, it fills in once ready.
    api.overlaps(repoId).then(forThis((o) => setOverlaps(o.overlaps)), forThis(() => setOverlaps(null)));
    reload();
  };
  // The repository's record is read before its contents, so a read that lands in between
  // shows as the contents rather than as a record that has not caught up.
  const synced = () => void onSynced().then(reloadAll);
  useEffect(() => {
    setData(null);
    setFolder(null);
    setOverlaps(null);
    setError(null);
    setSelected(undefined);
    setNotice(null);
    reloadAll();
  }, [repoId]);
  // A start reads its repositories after it begins to serve; one not read yet fills in on its own.
  // A folder shown as the project alone is not waited on: a read would only answer that there is nothing to read.
  const firstRead = !folder && Boolean(error && known && !known.head && !known.error);
  useEffect(() => {
    if (!firstRead) return;
    const timer = setTimeout(synced, 2000);
    return () => clearTimeout(timer);
  }, [firstRead, error]);
  if (folder && !data) {
    return <FolderProject project={folder.project} home={folder.home} me={me} onChanged={() => {
      setFolderReads((n) => n + 1);
      void onSynced();
    }} />;
  }
  if (firstRead) return <div className="panel" role="status"><p>The orchestrator is reading {known!.name} for the first time; this page fills in once it has.</p></div>;
  if (error) {
    return known && !known.head && known.error ? <SyncProblem repo={known} me={me} error={error} onSynced={synced} /> : (
      <LoadFailed what={repoId} reason={error} onRetry={reloadAll} panel />
    );
  }
  if (!data) return <Loading what={repoId} panel />;
  const { repo, inventory } = data;
  const configured = repo.configured !== false;
  const editable = configured && canEdit(me, repo.team);
  const opened = (r: RequestRecord, said?: string) => {
    setNotice(said ?? openedNotice(r));
    reload();
  };
  const panel: RepoPanelProps = { repo, data, me, editable, usage, overlaps, onChanged: reloadAll, onOpened: opened, selected, onSelect: setSelected, requestsRead };
  return (
    <div className="repo">
      <header className="repo-head">
        <div>
          <p className="eyebrow">{repo.team}</p>
          <h1>{repo.name}</h1>
          <p className="muted mono">{repo.url}</p>
        </div>
        <dl className="facts">
          <div><dt>Updates</dt><dd>{inventory.plugin.versionedByCommit ? "every merge" : `version ${inventory.plugin.version}`}</dd></div>
          <div><dt>Latest commit</dt><dd className="mono">{inventory.head.slice(0, 7)}</dd></div>
          <div><dt>Synced</dt><dd>{repo.syncedAt?.slice(0, 16).replace("T", " ") ?? "never"}</dd></div>
        </dl>
      </header>
      {!configured ? <OutOfConfiguration repo={repo} me={me} onDisconnected={onSynced} /> : repo.error ? <SyncProblem repo={repo} me={me} error={repo.error} onSynced={synced} /> : null}
      {notice ? <p className="panel notice" role="status">{notice}</p> : null}
      {!editable ? <p className="muted">An admin or an owner of {repo.team} proposes changes here.</p> : null}
      <SubNav label={`${repo.name} sections`} current={repoTabPath(repoId, tab)} links={REPO_TABS.map((t) => ({ to: repoTabPath(repoId, t.id), label: t.label }))} />
      {tab === "overview" ? <Overview {...panel} /> : null}
      {tab === "skills" ? <Skills {...panel} /> : null}
      {tab === "mcp" ? <McpServers {...panel} /> : null}
      {tab === "commands" ? <Commands {...panel} /> : null}
      {tab === "requests" ? <Requests {...panel} /> : null}
      {tab === "settings" ? <Settings {...panel} onRenamed={synced} /> : null}

      {/* A history is picked from a skill, a server or a command, so it shows where those are listed. */}
      {tab === "skills" || tab === "mcp" || tab === "commands" ? (
        <section className="panel" aria-labelledby="hist-h">
          <h2 id="hist-h">History {selected ? <code>{selected}</code> : null}</h2>
          <History repoId={repoId} path={selected} head={inventory.head} />
        </section>
      ) : null}
    </div>
  );
}

/** The tab a repository's address names: none is the overview, and anything else is no page. */
function repoTab(rest: readonly string[]): RepoTab | null {
  if (rest.length === 1) return "overview";
  if (rest.length !== 2) return null;
  return REPO_TABS.find((t) => t.id === rest[1] && t.id !== "overview")?.id ?? null;
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** A repository's health in the list: its setup panel's worst finding, said as a lead would. */
function RepoHealth({ repo, local }: { repo: RepoRecord; local: boolean }) {
  if (repo.configured === false) return <span className="badge warn">not in the configuration</span>;
  if (repo.error) return <span className="badge error">sync failed</span>;
  const health = repo.summary?.health;
  if (health === "problem") return <span className="badge error">{local ? "something needs fixing" : "something stops teammates"}</span>;
  if (health === "attention") return <span className="badge warn">something to look at</span>;
  if (health === "fine") return <span className="badge ok">fine</span>;
  return <span className="muted">not read yet</span>;
}

/** A folder project's own page while it has no commit: its name and place, and what the person decides about it. */
function FolderProject({ project, home, me, onChanged }: { project: Project; home: string | null; me: Principal; onChanged: () => void }) {
  return (
    <div className="repo">
      <header className="repo-head">
        <div>
          <h1>{project.name}</h1>
          <p className="muted mono">{folderPlace(project, home)}</p>
        </div>
      </header>
      <ProjectSection repo={project} me={me} git={project.facts?.git ?? null} onChanged={onChanged} />
      <TaskTools project={project.id} canChange={manages(me)} />
    </div>
  );
}

function Gate({ children }: { children: ReactNode }) {
  return <main className="gate">{children}</main>;
}

export function App() {
  const location = useLocation();
  const [me, setMe] = useState<Principal | null>(null);
  const [gate, setGate] = useState<AuthConfig | null>(null);
  const [orgs, setOrgs] = useState<OrgList | null>(null);
  const [unknownOrg, setUnknownOrg] = useState<string | null>(null);
  const [repos, setRepos] = useState<RepoRecord[] | null>(null);
  const [workSources, setWorkSources] = useState<WorkSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A cloud orchestrator's sign-in is the person's, before any organization; undefined until asked, null on a self-hosted one.
  const [cloud, setCloud] = useState<IdentityConfig | null | undefined>(undefined);
  // A local orchestrator shows no sign-in form: its one person comes in from the address the command prints.
  const [local, setLocal] = useState(false);
  const place = placeOf(location.pathname);
  const signingUp = Boolean(cloud) && /^\/signup(\/|$)/.test(location.pathname);
  const operating = Boolean(cloud) && /^\/operator\/?$/.test(location.pathname);
  const loadRepos = () => api.repos().then(setRepos, (e: Error) => setError(e.message));
  // The organization in the path decides where every call goes and which session answers;
  // one the browser holds no session in asks to sign in there.
  const load = () => {
    const org = placeOf(window.location.pathname).org;
    setError(null);
    setUnknownOrg(null);
    if (cloud === undefined || signingUp || operating) return;
    // A cloud orchestrator has no organization of its own to open: the person's first one, or creating one.
    // An invitation's page is its own, whether or not anyone is signed in.
    if (cloud && /^#\/join\//.test(window.location.hash)) return;
    if (cloud && !org) {
      identityApi.me().then(
        (view) => {
          const first = view.memberships.find((m) => m.reachable);
          navigate(first ? pathIn(first.tenant, "tasks") : "/signup/organization", true);
        },
        () => navigate("/signup", true),
      );
      return;
    }
    api.orgs().then(
      (list) => {
        setOrgs(list);
        // Without a list the orchestrator serves one organization, and unprefixed paths are it.
        setOrg(list ? org : null, list?.default ?? null);
        auth.me().then(
          (user) => {
            setMe(user);
            setGate(null);
            loadRepos();
            // An orchestrator without the work reads, or one that refuses them, offers no board rather than failing the page.
            workApi.sources().then((r) => setWorkSources(r.sources), () => setWorkSources([]));
          },
          (e: Error) => {
            setMe(null);
            // On a cloud orchestrator a signed-in person outside this organization is not a member; anyone else signs in first.
            if (e instanceof SignedOut && cloud) identityApi.me().then(() => setUnknownOrg(org), () => navigate("/signup", true));
            else if (e instanceof SignedOut) auth.config().then(setGate, (err: Error) => setError(err.message));
            else if (e instanceof NotFound && org) setUnknownOrg(org);
            else setError(e.message);
          },
        );
      },
      (e: Error) => setError(e.message),
    );
  };
  useEffect(() => {
    identityApi.config().then(
      (config) => {
        setLocal(config?.mode === "local");
        setCloud(config?.mode === "local" ? null : config);
      },
      () => setCloud(null),
    );
  }, []);
  useEffect(load, [place.org, cloud, signingUp]);
  useEffect(() => {
    document.addEventListener("click", followInApp);
    return () => document.removeEventListener("click", followInApp);
  }, []);
  // An address from before the top sections, or none at all, lands on its page in this organization.
  const joining = location.hash.match(/^#\/join\/([\w-]+)$/)?.[1];
  useEffect(() => {
    if (!me || !orgs || joining) return;
    const home = place.org ?? orgs.default ?? orgs.orgs[0]?.tenant;
    if (!home) return navigate("/signup/organization", true);
    const old = window.location.hash.startsWith("#/") ? legacyPath(window.location.hash, home) : null;
    const moved = place.org ? movedPath(place.org, place.section, place.rest) : null;
    if (old) navigate(old, true);
    else if (!place.org) navigate(rootTarget(location.search, home), true);
    else if (moved) navigate(`${moved}${location.search}`, true);
    else if (!place.section && !place.named) navigate(pathIn(home, "tasks"), true);
  }, [me, orgs, location.pathname, location.hash]);
  if (signingUp) return <Signup config={cloud!} />;
  if (operating) return <OperatorPage />;
  if (joining) return <Join token={joining} onJoined={load} cloud={cloud} />;
  if (location.hash === ACCOUNT_DELETED) return <AccountDeleted />;
  if (unknownOrg) {
    const home = orgs?.default ?? orgs?.orgs.find((o) => o.tenant !== unknownOrg)?.tenant;
    return (
      <Gate>
        <div className="panel form" role="alert">
          <div className="brand">TeamHandbook <span>Orchestrator</span></div>
          <p>You are not a member of {unknownOrg}.</p>
          {home ? <p><a href={pathIn(home, place.section ?? "tasks")}>Go to {home}</a></p> : null}
        </div>
      </Gate>
    );
  }
  if (!me) {
    if (local && gate) {
      return (
        <Gate>
          <div className="panel form" role="alert">
            <div className="brand">TeamHandbook <span>Orchestrator</span></div>
            <p>This orchestrator runs on your machine and signs you in from the address its command prints. Run the command again for a new one.</p>
          </div>
        </Gate>
      );
    }
    if (gate?.setupNeeded) return <Setup onSignedIn={load} />;
    if (gate) return <SignIn config={gate} org={place.org !== orgs?.default ? place.org : null} onSignedIn={load} />;
    return (
      <Gate>
        {error ? (
          <div className="panel form" role="alert">
            <div className="brand">TeamHandbook <span>Orchestrator</span></div>
            <p className="error">{error}</p>
            <button type="button" onClick={load}>Retry connecting</button>
          </div>
        ) : <p className="muted">Loading the orchestrator…</p>}
      </Gate>
    );
  }
  if (!orgs || !place.org || (!place.section && !place.named)) {
    return <Gate>{error ? <div className="panel" role="alert"><p className="error">{error}</p><button type="button" onClick={load}>Retry connecting</button></div> : <p className="muted">Loading the orchestrator…</p>}</Gate>;
  }
  const org = place.org;
  const [first] = place.rest;
  const shownOrgs = orgs.orgs.some((o) => o.tenant === org) ? orgs.orgs : [...orgs.orgs, { tenant: org, name: org, role: me.role }];
  return (
    <Shell me={me} orgs={shownOrgs} org={org} section={place.section} repos={repos ?? []} onSignedOut={load}>
      {error ? (
        <div className="panel" role="alert">
          <p className="error">{error}</p>
          <button type="button" className="secondary" onClick={load}>Retry the organization</button>
        </div>
      ) : null}
      <SectionBoundary path={location.pathname} home={pathIn(org, "tasks")}>
        {!place.section ? <NotFoundPage org={org} path={location.pathname} /> : null}
        {place.section === "activity" ? <ActivityView me={me} repos={repos} page={first} entry={place.rest[1]} /> : null}
        {place.section === "work" ? (
          // A link to start one issue opens the task form filled in, also where no tracker is connected, since a full issue link needs none.
          first === "new" && place.rest.length === 1 ? <TaskList me={me} start={startLink(location.search)} />
            : (first && first !== "backlog") || place.rest.length > 1 ? <NotFoundPage org={org} path={location.pathname} /> : <WorkView me={me} sources={workSources} backlog={first === "backlog"} />
        ) : null}
        {place.section === "repositories" ? (
          first ? (
            repoTab(place.rest) ? (
              <RepoView repoId={first} tab={repoTab(place.rest)!} me={me} known={repos?.find((r) => r.id === first)} onSynced={loadRepos} />
            ) : <NotFoundPage org={org} path={location.pathname} />
          ) : null
        ) : null}
        {place.section === "tasks" ? (first === "new" ? <TaskList me={me} start={startLink(location.search)} repos={repos} onRepos={loadRepos} /> : first ? <TaskView id={first} me={me} /> : <TaskList me={me} repos={repos} picked={new URLSearchParams(location.search).get("repo")} onRepos={loadRepos} />) : null}
        {place.section === "team" ? <TeamView me={me} org={org} repos={repos} page={place.rest} /> : null}
        {place.section === "integrations" ? <IntegrationsView me={me} repos={repos ?? []} /> : null}
        {place.section === "settings" ? <SettingsView me={me} route={`/settings/${place.rest.join("/")}`} onLeft={load} /> : null}
        {place.section === "welcome" ? (place.rest.length ? <NotFoundPage org={org} path={location.pathname} /> : <WelcomeView me={me} org={org} repos={repos ?? []} onRepos={loadRepos} />) : null}
      </SectionBoundary>
    </Shell>
  );
}
