import { useEffect, useState } from "react";
import { api, call, manages } from "../api";
import type { Principal, RepoRecord } from "../api";
import { FolderPicker } from "../projects/FolderPicker";
import { homeRelative, projectsRead } from "../projects-read";
import type { WorkFolder } from "../projects-read";
import { TaskTools } from "../repo/TaskTools";
import { Loading, LoadFailed } from "../Status";
import { here } from "../router";
import { whenShort } from "../task-board";

/**
 * The folders a person's tasks work in: the ones their own Claude Code has worked in, most
 * recently used first, and Add a folder for one it has not. A task picks its folder from what it
 * asks, so nothing here is set per folder; what every task is given is set under it.
 */
export function CodeLivesSettings({ me }: { me: Principal }) {
  return me.mode === "local" ? <OwnFolders me={me} /> : <><ConnectedRepositories /><TeamTaskTools /></>;
}

type SharedRead = { skills: { name: string; slug: string; repoName: string }[]; mcpServers: { name: string; repoName: string }[] };

/** What a team's tasks are given: the skills and MCP servers its repositories declare, read here and changed by a request to the repository. */
function TeamTaskTools() {
  const [shared, setShared] = useState<SharedRead | null>(null);
  useEffect(() => {
    call<SharedRead>("GET", "/api/team/shared?days=30").then(setShared, () => setShared({ skills: [], mcpServers: [] }));
  }, []);
  if (!shared) return <Loading what="the skills and MCP servers for tasks" />;
  return (
    <section className="section" aria-labelledby="code-tools-h">
      <h2 id="code-tools-h">Skills and MCP servers for tasks</h2>
      <p className="muted">They change through a request to the repository that declares them.</p>
      {shared.skills.length || shared.mcpServers.length ? (
        <ul className="plain code-tools">
          {shared.skills.map((x) => <li key={`skill-${x.repoName}-${x.slug}`}><span className="mono" dir="auto">{x.name || x.slug}</span> <span className="muted">skill, {x.repoName}</span></li>)}
          {shared.mcpServers.map((x) => <li key={`mcp-${x.repoName}-${x.name}`}><span className="mono" dir="auto">{x.name}</span> <span className="muted">MCP server, {x.repoName}</span></li>)}
        </ul>
      ) : <p className="muted">Nothing is shared yet.</p>}
    </section>
  );
}

/** A team's tasks work in the repositories its organization connected; nothing is asked and nothing is set per repository here. */
function ConnectedRepositories() {
  const [repos, setRepos] = useState<RepoRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.repos().then((r) => setRepos(r.filter((x) => x.configured !== false && x.kind !== "skills")), (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  if (error) return <LoadFailed what="where your code lives" reason={error} onRetry={() => { setError(null); void load(); }} />;
  if (!repos) return <Loading what="where your code lives" />;
  return (
    <section className="section" aria-labelledby="code-folders-h">
      <h2 id="code-folders-h">Repositories tasks work in</h2>
      {repos.length ? (
        <ul className="plain code-folders">
          {repos.map((r) => <li key={r.id}><strong dir="auto">{r.name}</strong> <span className="muted">{r.team}</span> <a href={here("repositories", r.id)}>Repository settings</a></li>)}
        </ul>
      ) : <p className="muted">No repository is connected yet. Connect one on <a href={here("integrations")}>Integrations</a>.</p>}
    </section>
  );
}

function OwnFolders({ me }: { me: Principal }) {
  const [read, setRead] = useState<{ folders: WorkFolder[]; last: string | null; home: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () => Promise.all([projectsRead.workFolders(), projectsRead.list()]).then(
    ([{ folders }, { last, home }]) => setRead({ folders, last, home: home ?? null }),
    (e: Error) => setError(e.message),
  );
  useEffect(() => {
    void load();
  }, []);
  if (error) return <LoadFailed what="where your code lives" reason={error} onRetry={() => { setError(null); void load(); }} />;
  if (!read) return <Loading what="where your code lives" />;
  return (
    <>
      <section className="section" aria-labelledby="code-folders-h">
        <h2 id="code-folders-h">Folders tasks work in</h2>
        {read.folders.length ? (
          <ul className="plain code-folders">
            {read.folders.map((f) => (
              <li key={f.path}>
                <strong dir="auto">{f.name}</strong> <span className="mono" dir="auto">{homeRelative(f.path, read.home)}</span>
                {f.usedAt ? <span className="muted"> last used {whenShort(f.usedAt)}</span> : null}
              </li>
            ))}
          </ul>
        ) : <p className="muted">No folder yet. A task works in a folder your Claude Code has worked in; add one below.</p>}
        {adding ? (
          <>
            <FolderPicker verb="Add" onOpened={() => {
              setAdding(false);
              void load();
            }} />
            <p><button type="button" className="secondary" onClick={() => setAdding(false)}>Cancel</button></p>
          </>
        ) : <p><button type="button" className="secondary" onClick={() => setAdding(true)}>Add a folder</button></p>}
      </section>
      {read.last ? <TaskTools key={`tools-${read.last}`} project={read.last} canChange={manages(me)} /> : (
        <section className="section" aria-labelledby="code-tools-h">
          <h2 id="code-tools-h">Skills and MCP servers for tasks</h2>
          <p className="muted">Once a task has worked in a folder, you add skills and MCP servers for it here.</p>
        </section>
      )}
    </>
  );
}
