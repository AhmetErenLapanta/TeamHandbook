import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { call, tasksApi } from "./api";
import type { RepoRecord } from "./api";
import { ConfirmAction } from "./Confirm";
import { Loading, LoadFailed } from "./Status";
import type { WorkAutomation, WorkBoards, WorkColumns } from "../../shared/work";

const automationsApi = {
  list: () => call<{ enabled: boolean; automations: WorkAutomation[] }>("GET", "/api/work/automations"),
  turn: (enabled: boolean) => call<{ enabled: boolean }>("PUT", "/api/work/automations", { enabled }),
  add: (input: Record<string, unknown>) => call<{ automation: WorkAutomation }>("POST", "/api/work/automations", input),
  change: (id: string, input: Record<string, unknown>) => call<{ automation: WorkAutomation }>("PUT", `/api/work/automations/${encodeURIComponent(id)}`, input),
  remove: (id: string) => call<{ ok: true }>("DELETE", `/api/work/automations/${encodeURIComponent(id)}`),
  deliveries: (id: string) => call<{ deliveries: { at: string; detail: string }[] }>("GET", `/api/work/automations/${encodeURIComponent(id)}/deliveries`),
};

const when = (a: WorkAutomation) => (a.trigger.kind === "column" ? `an issue of ${a.project} moves into ${a.trigger.column}` : `an issue of ${a.project} gets the label ${a.trigger.label}`);
const does = (a: WorkAutomation) => (a.action === "start" ? `start a task in ${a.by.name}'s name` : "draft a task for someone to start");

/**
 * Integrations > Automations, for owners and admins: what a change on the organization's tracker
 * board sets going. A draft waits on the Work screen for a person to start it; starting by itself
 * is chosen per automation, and every automation turns off with one switch.
 */
export function Automations({ repos }: { repos: RepoRecord[] }) {
  const [read, setRead] = useState<{ enabled: boolean; automations: WorkAutomation[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () => automationsApi.list().then(setRead, (e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const run = (work: Promise<unknown>, said: string) => {
    setError(null);
    work.then(() => {
      setNotice(said);
      load();
    }, (e: Error) => setError(e.message));
  };
  if (!read) return error ? <LoadFailed what="automations" reason={error} onRetry={() => { setError(null); load(); }} /> : <Loading what="automations" />;
  return (
    <>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <label className="check">
        <input type="checkbox" checked={read.enabled} onChange={(e) => run(automationsApi.turn(e.target.checked), e.target.checked ? "Automations run again." : "Every automation is off.")} />
        Run automations
      </label>
      {!read.enabled ? <p className="muted">Every automation is off: changes on the tracker are logged and set nothing going.</p> : null}
      {read.automations.length ? (
        <ul className="automations" aria-label="Automations">
          {read.automations.map((a) => <AutomationRow key={a.id} automation={a} run={run} />)}
        </ul>
      ) : <p className="muted">No automation yet. Each one reads its board once a minute for an issue moving into its column or getting its label.</p>}
      {adding ? <AddAutomation repos={repos} onAdded={(a) => { setAdding(false); setNotice(`${a.name} is set up.`); load(); }} onCancel={() => setAdding(false)} /> : <button type="button" className="secondary" onClick={() => setAdding(true)}>Add automation</button>}
    </>
  );
}

function AutomationRow({ automation: a, run }: { automation: WorkAutomation; run: (work: Promise<unknown>, said: string) => void }) {
  const [deliveries, setDeliveries] = useState<{ at: string; detail: string }[] | null>(null);
  const show = () => (deliveries ? setDeliveries(null) : automationsApi.deliveries(a.id).then((r) => setDeliveries(r.deliveries), () => setDeliveries([])));
  return (
    <li className="panel">
      <h4>{a.name}</h4>
      <p>When {when(a)}, {does(a)} on {a.repoId} with {a.agent}.{a.filter.labels.length ? ` Only issues labelled ${a.filter.labels.join(", ")}.` : ""}</p>
      {a.action === "start" ? <p className="warning" role="note">A task starts with nobody pressing Start, in {a.by.name}'s name and under every rule a start from the screen meets.</p> : null}
      <div className="row-actions">
        <label className="check">
          <input type="checkbox" checked={a.enabled} onChange={(e) => run(automationsApi.change(a.id, { enabled: e.target.checked }), `${a.name} is ${e.target.checked ? "on" : "off"}.`)} />
          On
        </label>
        <button type="button" className="secondary small" aria-expanded={Boolean(deliveries)} onClick={show}>Deliveries</button>
        <ConfirmAction small trigger="Remove" triggerLabel={`Remove ${a.name}`} consequence="The automation and the drafts it made waiting are deleted. Its deliveries stay in the event log." confirm={`Remove ${a.name}`} keep="Keep it" onConfirm={() => automationsApi.remove(a.id).then(() => run(Promise.resolve(), `${a.name} is removed.`))} />
      </div>
      {deliveries ? (
        deliveries.length ? (
          <ul aria-label={`Deliveries of ${a.name}`}>{deliveries.map((d) => <li key={`${d.at}${d.detail}`}><span className="mono small-print">{d.at.slice(0, 16).replace("T", " ")}</span> {d.detail}</li>)}</ul>
        ) : <p className="muted">No change has reached it yet.</p>
      ) : null}
    </li>
  );
}

function AddAutomation({ repos, onAdded, onCancel }: { repos: RepoRecord[]; onAdded: (a: WorkAutomation) => void; onCancel: () => void }) {
  const [boards, setBoards] = useState<WorkBoards["boards"] | null>(null);
  const [agents, setAgents] = useState<{ id: string; label: string }[]>([]);
  const [columns, setColumns] = useState<WorkColumns["columns"]>([]);
  const [form, setForm] = useState({ name: "", board: "", kind: "column", column: "", label: "", labels: "", repoId: repos[0]?.id ?? "", agent: "", action: "draft" });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<WorkBoards>("GET", "/api/work/boards?source=tracker").then((r) => setBoards(r.boards), (e: Error) => setError(e.message));
    tasksApi.options().then((o) => {
      setAgents(o.agents);
      setForm((f) => ({ ...f, agent: f.agent || o.agents[0]?.id || "" }));
    }, () => undefined);
  }, []);
  // The repositories arrive after the form opens on a fresh page; the first is picked once they do.
  useEffect(() => {
    if (!form.repoId && repos[0]) setForm((f) => ({ ...f, repoId: repos[0]!.id }));
  }, [repos]);
  useEffect(() => {
    if (!form.board) return setColumns([]);
    call<WorkColumns>("GET", `/api/work/boards/${encodeURIComponent(form.board)}/columns`).then((r) => setColumns(r.columns), (e: Error) => setError(e.message));
  }, [form.board]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const trigger = form.kind === "column" ? { kind: "column", column: form.column } : { kind: "label", label: form.label.trim() };
    const labels = form.labels.split(",").map((l) => l.trim()).filter(Boolean);
    automationsApi.add({ name: form.name.trim(), board: form.board, trigger, filter: { labels }, repoId: form.repoId, agent: form.agent, action: form.action }).then((r) => onAdded(r.automation), (err: Error) => setError(err.message));
  };
  return (
    <form className="form" onSubmit={submit} aria-label="Add automation">
      <label>Name<input value={form.name} onChange={set("name")} required maxLength={60} /></label>
      <label>
        Board
        <select value={form.board} onChange={set("board")} required>
          <option value="">Pick a board</option>
          {(boards ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label>
      <label>
        When
        <select value={form.kind} onChange={set("kind")}>
          <option value="column">An issue moves into a column</option>
          <option value="label">An issue gets a label</option>
        </select>
      </label>
      {form.kind === "column" ? (
        <label>
          Column
          <select value={form.column} onChange={set("column")} required>
            <option value="">Pick a column</option>
            {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        </label>
      ) : <label>Label<input value={form.label} onChange={set("label")} required maxLength={100} /></label>}
      <label>Only issues labelled (optional, separated by commas)<input value={form.labels} onChange={set("labels")} maxLength={400} /></label>
      <label>
        Repository
        <select value={form.repoId} onChange={set("repoId")} required>
          {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      <label>
        Agent
        <select value={form.agent} onChange={set("agent")} required>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </label>
      <fieldset>
        <legend>Then</legend>
        <label className="check"><input type="radio" name="action" value="draft" checked={form.action === "draft"} onChange={set("action")} />Draft a task for someone to start</label>
        <label className="check"><input type="radio" name="action" value="start" checked={form.action === "start"} onChange={set("action")} />Start the task in my name</label>
      </fieldset>
      {form.action === "start" ? <p className="warning" role="note">A task starts with nobody pressing Start, in your name and under every rule a start from the screen meets. Drafting is the safe choice.</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="actions">
        <button type="submit">Add automation</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
