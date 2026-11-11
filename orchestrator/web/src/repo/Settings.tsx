import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, manages } from "../api";
import { ConfirmAction } from "../Confirm";
import { Hint } from "../Hint";
import type { Principal, RepoRecord, RequestRecord, UsageAction } from "../api";
import { TeamNamingForm, TeamSettingsForm, UsageReportForm } from "../Editing";
import { projectsRead } from "../projects-read";
import type { GitState } from "../projects-read";
import { Select } from "../Select";
import { Loading } from "../Status";
import { TaskTools } from "./TaskTools";
import { here, navigate } from "../router";
import type { RepoPanelProps } from "./types";

type Editing = { type: "usage"; action: UsageAction } | { type: "team" } | { type: "naming" } | null;

/** The name a project shows under; its id, and so its address, stays as it was. */
function ProjectName({ repo, onRenamed }: { repo: RepoRecord; onRenamed: () => void }) {
  const [name, setName] = useState(repo.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    projectsRead.rename(repo.id, name).then(({ project }) => {
      setName(project.name);
      setNotice(`The project is now named ${project.name}.`);
      onRenamed();
    }, (err: Error) => setError(err.message)).finally(() => setBusy(false));
  };
  return (
    <>
      <form className="form inline-form" onSubmit={save} aria-label="Project name">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></label>
        <button type="submit" className="secondary" disabled={busy || !name.trim() || name.trim() === repo.name}>Rename</button>
      </form>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
    </>
  );
}

/** How requests to the repository are named and reviewed, whether the team reports skill use, and where its forge access is set. */
/** Which team's skills a code project's tasks read; the choice the first screen no longer asks. */
function SkillsFrom({ repo, onChanged }: { repo: RepoRecord; onChanged: () => void }) {
  const [sources, setSources] = useState<RepoRecord[] | null>(null);
  const [value, setValue] = useState(repo.skillsFrom ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    api.repos().then((repos) => setSources(repos.filter((r) => r.kind !== "code" && r.id !== repo.id && r.configured !== false)), (e: Error) => setError(e.message));
  }, [repo.id]);
  const pick = (next: string) => {
    const before = value;
    setValue(next);
    setBusy(true);
    setError(null);
    setNotice(null);
    projectsRead.readSkillsFrom(repo.id, next || null).then(() => {
      const source = sources?.find((r) => r.id === next);
      setNotice(source ? `Tasks in ${repo.name} read the skills of ${source.name}.` : `Tasks in ${repo.name} read no team's skills.`);
      onChanged();
    }, (err: Error) => {
      setValue(before);
      setError(err.message);
    }).finally(() => setBusy(false));
  };
  return (
    <>
      {sources ? <Select label="Skills its tasks read" value={value} onChange={pick} disabled={busy} options={[{ value: "", label: "None" }, ...sources.map((r) => ({ value: r.id, label: r.name }))]} /> : error ? null : <Loading what="the skills projects" />}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
    </>
  );
}

/** Git started in a folder that has none, offered here rather than in a task's review, where a person who does not use Git meets no word of it. */
function MakeGit({ repo, onMade }: { repo: RepoRecord; onMade: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const make = () => {
    setBusy(true);
    setError(null);
    projectsRead.gitInit(repo.id).then(onMade, (e: Error) => {
      setError(e.message);
      setBusy(false);
    });
  };
  return (
    <>
      <div className="actions"><button type="button" className="secondary" disabled={busy} onClick={make}>Make this a Git repository</button></div>
      <p className="muted">Starts Git in this folder so its history is kept. No file is added or committed; a task's review then offers to commit what it changed.</p>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </>
  );
}

/** A project's own name, the skills a code project's tasks read and, for a folder, whether it uses Git. */
export function ProjectSection({ repo, me, git, onChanged }: { repo: RepoRecord; me: Principal; git?: GitState | null; onChanged: () => void }) {
  const owner = manages(me) && repo.configured !== false;
  return (
    <section className="panel" aria-labelledby="project-h">
      <h2 id="project-h">Project <Hint label="the project's name">{repo.source === "file" ? "Its name is set in the orchestrator's configuration file, by whoever runs the orchestrator." : "Renaming changes only the name it shows under. Its address and its tasks stay as they are."}</Hint></h2>
      {/* A project listed in the configuration file takes its name from there on every start, so a name given here would not last. */}
      {repo.source === "file" ? <p>{repo.name}</p> : owner ? <ProjectName repo={repo} onRenamed={onChanged} /> : <p>{repo.name}</p>}
      {repo.kind === "code" && repo.source !== "file" && owner ? <SkillsFrom repo={repo} onChanged={onChanged} /> : null}
      {git === "none" && owner ? <MakeGit repo={repo} onMade={onChanged} /> : null}
      {git && git !== "none" ? <p className="muted">This folder is a Git repository: a task's review offers to commit what it changed.</p> : null}
      {/* Removing is the project's own action, on its own page: a row of the list carries none. */}
      {manages(me) && repo.source === "orchestrator" ? (
        <div className="actions">
          <ConfirmAction
            danger
            trigger="Remove project…"
            consequence={me.mode === "local"
              ? `The orchestrator's copy of ${repo.name} is deleted. ${repo.name} itself is not touched, and its requests and tasks stay readable here.`
              : `The orchestrator's copy of ${repo.name}, its forge access and sealed token are deleted. The team's repository is not touched, and the orchestrator's records of its requests, tasks and skill use stay.`}
            confirm="Remove project"
            keep="Keep project"
            onConfirm={() => api.disconnect(repo.id).then(() => navigate(`${here("tasks")}?removed=${encodeURIComponent(repo.name)}`))}
          />
        </div>
      ) : null}
    </section>
  );
}

export function Settings({ repo, data, me, editable, onOpened, onRenamed }: RepoPanelProps & { onRenamed: () => void }) {
  const local = me.mode === "local";
  const { inventory } = data;
  const team = inventory.team;
  const [editing, setEditing] = useState<Editing>(null);
  const opened = (r: RequestRecord) => {
    setEditing(null);
    onOpened(r);
  };
  const askedToReport = (r: RequestRecord) => {
    setEditing(null);
    onOpened(r, `Request #${r.number} opened on ${r.branch}. Nothing is reported until it is merged and each teammate agrees on their own machine.`);
  };
  const formProps = { repoId: repo.id, head: inventory.head, onOpened: opened, onCancel: () => setEditing(null) };
  return (
    <>
      <ProjectSection repo={repo} me={me} onChanged={onRenamed} />
      <TaskTools project={repo.id} canChange={editable} />

      <section className="panel" aria-labelledby="team-h">
        <h2 id="team-h">
          Requests to this repository
          {editable && !team?.problem ? <button type="button" className="secondary small" onClick={() => setEditing({ type: "naming" })}>Edit naming</button> : null}
          {editable && !team?.problem ? <button type="button" className="secondary small" onClick={() => setEditing({ type: "team" })}>Edit reviewers and labels</button> : null}
        </h2>
        {editing?.type === "naming" ? <TeamNamingForm {...formProps} team={team} /> : null}
        {editing?.type === "team" ? <TeamSettingsForm {...formProps} team={team} /> : null}
        {team ? (
          team.problem ? <p className="error">{team.problem}</p> : (
            <dl className="facts wide">
              <div><dt>Commit prefix</dt><dd className="mono">{team.commitPrefixProblem ? "not used, see Setup" : team.commitPrefix || "none"}</dd></div>
              <div><dt>Branch example</dt><dd className="mono">{team.branchExample || "none"}</dd></div>
              <div><dt>Reviewers</dt><dd>{team.reviewers === undefined ? "not recorded" : team.reviewers.join(", ") || "none"}</dd></div>
              <div><dt>Labels</dt><dd>{team.labels === undefined ? "not recorded" : team.labels.join(", ") || "none"}</dd></div>
              <div><dt>TeamHandbook's files</dt><dd>{team.scaffoldVersion ? `written by TeamHandbook ${team.scaffoldVersion}` : "version not recorded"}</dd></div>
              {local ? null : <div><dt>Skill use</dt><dd>{team.usageEndpoint ? "reported by teammates who agreed" : "not reported"}</dd></div>}
            </dl>
          )
        ) : <p className="muted">No .teamhandbook.json: set up before TeamHandbook recorded one.</p>}
        {editable && editing?.type === "usage" ? <UsageReportForm key={editing.action} repoId={repo.id} head={inventory.head} action={editing.action} onOpened={editing.action === "ask" ? askedToReport : opened} onCancel={() => setEditing(null)} /> : null}
        {/* Skill use is what teammates' machines report, read on a page one person's own machine does not have. */}
        {editable && !local && editing?.type !== "usage" && !team?.problem ? (
          team?.usageEndpoint ? (
            <div className="actions">
              <button type="button" className="secondary" onClick={() => setEditing({ type: "usage", action: "rotate" })}>Give the team a new usage address</button>
              <button type="button" className="secondary" onClick={() => setEditing({ type: "usage", action: "stop" })}>Stop asking for skill use</button>
            </div>
          ) : (
            <div className="actions">
              <button type="button" onClick={() => setEditing({ type: "usage", action: "ask" })}>Ask this team to report skill use</button>
              <span className="muted">Opens a request; each teammate still agrees on their own machine before anything is sent.</span>
            </div>
          )
        ) : null}
      </section>

      {manages(me) ? (
        <section className="panel" aria-labelledby="forge-h">
          <h2 id="forge-h">{local ? "Where requests open" : "Forge access"}</h2>
          <p>Where requests for {repo.name} open, and the token they open with, are set under <a href={here("integrations", repo.id)}>Integrations</a>.</p>
        </section>
      ) : null}
    </>
  );
}
