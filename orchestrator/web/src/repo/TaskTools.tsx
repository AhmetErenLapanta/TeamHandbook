import { useEffect, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { ConfirmAction } from "../Confirm";
import { Hint } from "../Hint";
import { Select } from "../Select";
import { moveInList, tabStop } from "../roving";
import { Loading, LoadFailed } from "../Status";
import { namedValues, sourceInput, sourcePlace, taskTools } from "../task-tools-read";
import type { NewMcpServer, SkillSource, TaskMcpServer } from "../task-tools-read";

export function AddSource({ project, onAdded, onCancel }: { project: string; onAdded: (source: SkillSource) => void; onCancel: () => void }) {
  const [where, setWhere] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const add = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setRefused(null);
    taskTools.addSource(project, sourceInput(where)).then((source) => {
      setWhere("");
      onAdded(source);
    }, (err: Error) => setRefused(err.message)).finally(() => setBusy(false));
  };
  return (
    <form className="form inline-form" onSubmit={add} aria-label="Add a skill repository">
      <label>Folder or git address<input value={where} onChange={(e) => setWhere(e.target.value)} placeholder="~/code/team-skills or https://github.com/team/skills" required autoComplete="off" spellCheck={false} /></label>
      <div className="actions">
        <button type="submit" className="secondary" disabled={busy || !where.trim()}>{busy ? "Reading…" : "Add a skill repository"}</button>
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      {refused ? <p className="error" role="alert">{refused}</p> : null}
    </form>
  );
}

function AddServer({ project, onAdded, onCancel }: { project: string; onAdded: (server: TaskMcpServer) => void; onCancel: () => void }) {
  const [runs, setRuns] = useState<"command" | "url">("command");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [values, setValues] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const add = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setRefused(null);
    const named = namedValues(values);
    const given = Object.keys(named).length ? named : undefined;
    const server: NewMcpServer = runs === "command"
      ? { name: name.trim(), command: command.trim(), ...(args.trim() ? { args: args.trim().split(/\s+/) } : {}), ...(given ? { env: given } : {}) }
      : { name: name.trim(), url: url.trim(), ...(given ? { headers: given } : {}) };
    taskTools.addServer(project, server).then((added) => {
      setName("");
      setCommand("");
      setArgs("");
      setUrl("");
      setValues("");
      onAdded(added);
    }, (err: Error) => setRefused(err.message)).finally(() => setBusy(false));
  };
  return (
    <form className="form" onSubmit={add} aria-label="Add an MCP server">
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="docs" required autoComplete="off" spellCheck={false} /></label>
      <Select label="Runs as" value={runs} onChange={(v) => setRuns(v as "command" | "url")} options={[{ value: "command", label: "A command on this machine" }, { value: "url", label: "An address" }]} />
      {runs === "command" ? (
        <>
          <label>Command<input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" required autoComplete="off" spellCheck={false} /></label>
          <label>Arguments<input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y docs-server" autoComplete="off" spellCheck={false} /></label>
        </>
      ) : <label>Address<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" required autoComplete="off" spellCheck={false} /></label>}
      <label>{runs === "command" ? "Environment, one NAME=value a line" : "Headers, one NAME=value a line"}<textarea value={values} onChange={(e) => setValues(e.target.value)} rows={2} autoComplete="off" spellCheck={false} /></label>
      {refused ? <p className="error" role="alert">{refused}</p> : null}
      <div className="actions">
        <button type="submit" className="secondary" disabled={busy}>Add the MCP server</button>
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * What a project gives its tasks on top of the person's own Claude Code: skill repositories read
 * from a folder or a git address, and MCP servers whose values stay in the orchestrator's vault.
 * Nothing here writes to the person's own settings.
 */
export function TaskTools({ project, canChange }: { project: string; canChange: boolean }) {
  const [sources, setSources] = useState<SkillSource[] | null>(null);
  const [servers, setServers] = useState<TaskMcpServer[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // One row is picked at a time across both lists, and the section's one Remove acts on it.
  const [picked, setPicked] = useState<{ kind: "source" | "server"; id: string } | null>(null);
  const [adding, setAdding] = useState<"source" | "server" | null>(null);
  useEffect(() => {
    setFailed(null);
    taskTools.read(project).then((r) => {
      setSources(r.skillSources);
      setServers(r.mcpServers);
    }, (e: Error) => setFailed(e.message));
  }, [project, reads]);
  const reread = () => setReads((n) => n + 1);
  const pickedSource = picked?.kind === "source" ? sources?.find((s) => s.id === picked.id) ?? null : null;
  const pickedServer = picked?.kind === "server" ? servers?.find((m) => m.id === picked.id) ?? null : null;
  const pick = (kind: "source" | "server", id: string) => setPicked(picked?.kind === kind && picked.id === id ? null : { kind, id });
  const row = (kind: "source" | "server", id: string, index: number, inList: { id: string }[]) => ({
    className: "tool-row",
    role: "option",
    tabIndex: tabStop(index, picked?.kind === kind ? inList.findIndex((r) => r.id === picked.id) : -1),
    "aria-selected": picked?.kind === kind && picked.id === id,
    onClick: () => pick(kind, id),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      pick(kind, id);
    },
  });
  const removed = () => {
    setPicked(null);
    reread();
  };
  const fromGit = (sources ?? []).filter((s) => s.kind === "git");
  const refreshAll = () => {
    setRefreshing(true);
    setNotice(null);
    Promise.all(fromGit.map((s) => taskTools.refresh(project, s.id))).then(() => {
      setNotice(`Read ${fromGit.length === 1 ? "the git repository" : `${fromGit.length} git repositories`} again.`);
      reread();
    }, (e: Error) => setFailed(e.message)).finally(() => setRefreshing(false));
  };
  return (
    <section className="section" aria-labelledby="task-tools-h">
      <h2 id="task-tools-h">
        Skills and MCP servers for tasks here{" "}
        <Hint label="skills and MCP servers for tasks here">A task here runs with the person's own Claude Code, its skills, plugins and MCP servers included, and with what is added here on top. These are kept by the orchestrator and given to each task; nobody's own settings are changed. An MCP server's values are sealed and only their names are shown again. Pick a row to remove it.</Hint>
        {canChange ? (pickedSource ? (
          <ConfirmAction key={pickedSource.id} small trigger="Remove…" triggerLabel={`Remove ${pickedSource.name}`} consequence={`Tasks here stop reading the skills of ${pickedSource.name}. ${pickedSource.kind === "git" ? "The orchestrator's copy of it is deleted; the repository is not touched." : "The folder is not touched."}`} confirm="Remove repository" keep="Keep it" onConfirm={() => taskTools.removeSource(project, pickedSource.id).then(removed)} />
        ) : pickedServer ? (
          <ConfirmAction key={pickedServer.id} small trigger="Remove…" triggerLabel={`Remove ${pickedServer.name}`} consequence={`Tasks here start without ${pickedServer.name}, and its sealed values are deleted.`} confirm="Remove server" keep="Keep it" onConfirm={() => taskTools.removeServer(project, pickedServer.id).then(removed)} />
        ) : null) : null}
      </h2>
      {failed ? <LoadFailed what="the skills and MCP servers" reason={failed} onRetry={reread} /> : !sources || !servers ? <Loading what="the skills and MCP servers" /> : (
        <>
          <h3>Skill repositories</h3>
          {sources.length ? (
            <ul className="tool-list" role="listbox" aria-label="Skill repositories" onKeyDown={moveInList}>
              {sources.map((s, i) => (
                <li key={s.id} {...row("source", s.id, i, sources)}>
                  {s.name} <span className="mono" dir="auto">{sourcePlace(s)}</span> <span className="muted">{s.skills.length} {s.skills.length === 1 ? "skill" : "skills"}</span>
                </li>
              ))}
            </ul>
          ) : <p className="muted">No skill repository yet.</p>}
          {canChange && fromGit.length ? <p><button type="button" className="ghost small" disabled={refreshing} onClick={refreshAll}>{refreshing ? "Reading…" : "Read the git repositories again"}</button></p> : null}
          {notice ? <p className="notice" role="status">{notice}</p> : null}
          {!canChange ? null : adding === "source" ? <AddSource project={project} onCancel={() => setAdding(null)} onAdded={(source) => {
            setAdding(null);
            setNotice(`Added ${source.name}: ${source.skills.length} ${source.skills.length === 1 ? "skill" : "skills"} for tasks here.`);
            reread();
          }} /> : <p><button type="button" className="secondary small" onClick={() => setAdding("source")}>Add a skill repository</button></p>}
          <h3>MCP servers</h3>
          {servers.length ? (
            <ul className="tool-list" role="listbox" aria-label="MCP servers" onKeyDown={moveInList}>
              {servers.map((m, i) => {
                const names = m.transport === "stdio" ? m.env : m.headers;
                return (
                  <li key={m.id} {...row("server", m.id, i, servers)}>
                    {m.name} <span className="mono" dir="auto">{m.transport === "stdio" ? [m.command, ...m.args].join(" ") : m.url}</span>{names.length ? <span className="muted"> with {names.join(", ")}</span> : null}
                  </li>
                );
              })}
            </ul>
          ) : <p className="muted">No MCP server yet.</p>}
          {!canChange ? null : adding === "server" ? <AddServer project={project} onCancel={() => setAdding(null)} onAdded={(server) => {
            setAdding(null);
            setNotice(`Added ${server.name} for tasks here.`);
            reread();
          }} /> : <p><button type="button" className="secondary small" onClick={() => setAdding("server")}>Add an MCP server</button></p>}
        </>
      )}
    </section>
  );
}
