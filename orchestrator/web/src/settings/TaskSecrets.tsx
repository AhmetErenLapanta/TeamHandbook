import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { api, manages, taskSecrets } from "../api";
import type { Principal, RepoRecord, TaskSecretView } from "../api";
import { ConfirmAction } from "../Confirm";
import { Hint } from "../Hint";
import { Select } from "../Select";

function day(at: string): string {
  return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** On one person's own machine every repository is under the one name they never see, so a team's secret is every repository's. */
function whose(s: Pick<TaskSecretView, "scope" | "target">, local: boolean): string {
  return s.scope === "team" ? (local ? "every repository" : `team ${s.target}`) : `repository ${s.target}`;
}

function NewSecret({ repos, local, op, onSaved }: { repos: RepoRecord[]; local: boolean; op: string[] | null; onSaved: (saved: TaskSecretView) => void }) {
  const teams = [...new Set(repos.map((r) => r.team))].sort();
  const [scope, setScope] = useState<"team" | "repo">("team");
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [from, setFrom] = useState<"typed" | "op">("typed");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fromOp = from === "op" && op !== null;
  const errorId = useId();
  const targets = scope === "team" ? teams : repos.map((r) => r.id);
  const chosen = targets.includes(target) ? target : targets[0] ?? "";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    taskSecrets.set({ scope, target: chosen, name: name.trim(), ...(fromOp ? { secret: { provider: "op" as const, reference: reference.trim() } } : { value }) }).then(
      (saved) => {
        setName("");
        setValue("");
        setReference("");
        onSaved(saved);
      },
      (err: Error) => setError(err.message),
    );
  };
  const described = error ? { "aria-describedby": errorId } : {};
  return (
    <form className="form" onSubmit={submit} aria-labelledby="new-secret-h">
      <h2 id="new-secret-h">Add a secret</h2>
      <Select label="Applies to" value={scope} onChange={(v) => setScope(v as "team" | "repo")} describedBy={described["aria-describedby"]} options={[{ value: "team", label: local ? "Every repository" : "Every repository of a team" }, { value: "repo", label: "One repository" }]} />
      {local && scope === "team" ? null : <Select label={scope === "team" ? "Team" : "Repository"} value={chosen} onChange={setTarget} describedBy={described["aria-describedby"]} options={targets.map((t) => ({ value: t, label: t }))} />}
      <label>Name<input value={name} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="NPM_TOKEN" required maxLength={64} autoComplete="off" spellCheck={false} {...described} /></label>
      {op ? <Select label="Value" value={from} onChange={(v) => setFrom(v as "typed" | "op")} describedBy={described["aria-describedby"]} options={[{ value: "typed", label: "Typed here" }, { value: "op", label: "Read from 1Password" }]} /> : null}
      {fromOp ? (
        <>
          <label>1Password reference<input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={`op://${op[0] ?? "vault"}/item/field`} required autoComplete="off" spellCheck={false} {...described} /></label>
          <p className="muted">Read when each task starts, from {op.length === 1 ? "the vault" : "the vaults"} {op.join(", ")}; nothing is copied here.</p>
        </>
      ) : (
        <>
          <label>{op ? "Typed value" : "Value"}<input type="password" value={value} onChange={(e) => setValue(e.target.value)} required autoComplete="off" {...described} /></label>
          <p className="muted">A task's agent gets it as an environment variable; once saved it is never shown again. <Hint label="changing a value">Save it again to change it.</Hint></p>
        </>
      )}
      {error ? <p className="error" role="alert" id={errorId}>{error}</p> : null}
      <div className="actions"><button type="submit" disabled={!chosen}>Save secret</button></div>
    </form>
  );
}

export function TaskSecretsSettings({ me }: { me: Principal }) {
  const [secrets, setSecrets] = useState<TaskSecretView[] | null>(null);
  const [vault, setVault] = useState(true);
  const [op, setOp] = useState<string[] | null>(null);
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const managing = manages(me);
  const local = me.mode === "local";
  const reload = () => taskSecrets.list().then((r) => {
    setSecrets(r.secrets);
    setVault(r.vault);
    setOp(r.op ?? null);
  }, (e: Error) => setError(`Couldn't load task secrets. ${e.message}`));
  useEffect(() => {
    if (!managing) return;
    void reload();
    api.repos().then(setRepos, () => setRepos([]));
  }, [managing]);
  if (!managing) return <section className="panel"><p>Only owners and admins manage task secrets.</p></section>;
  return (
    <>
      <section className="panel" aria-labelledby="secrets-h">
        <h2 id="secrets-h">Task secrets <span className="count">{secrets?.length ?? 0}</span></h2>
        <p className="muted">Values a task's agent needs, masked in its log. <Hint label="which value applies">{local
          ? "A repository's own value replaces the one for every repository of the same name."
          : "A repository's value replaces its team's of the same name."}</Hint></p>
        {error ? <p className="error" role="alert">{error}</p> : null}
        {notice ? <p className="notice" role="status">{notice}</p> : null}
        {!vault ? <p className="error">{local ? "No secret is stored: the orchestrator has no key to seal them. Run handbook-orchestrator doctor for the step that fixes it." : "Set ORCHESTRATOR_SECRET_KEY where the orchestrator runs; without it no secret is stored."}</p> : null}
        {!secrets ? <p className="muted">Loading task secrets...</p> : secrets.length ? (
          <table>
            <thead><tr><th>Name</th><th>Applies to</th><th>Changed</th><th><span className="visually-hidden">Delete</span></th></tr></thead>
            <tbody>
              {secrets.map((s) => (
                <tr key={`${s.scope}:${s.target}:${s.name}`}>
                  <td><span className="mono">{s.name}</span>{s.reference ? <div className="muted mono small">{s.reference}</div> : null}</td>
                  <td>{whose(s, local)}</td>
                  <td>{day(s.updatedAt)}<div className="muted">by {s.updatedBy}</div></td>
                  <td>
                    <ConfirmAction
                      small
                      trigger="Delete"
                      triggerLabel={`Delete ${s.name} for ${whose(s, local)}`}
                      consequence={`This cannot be undone. The next task on ${whose(s, local)} starts without ${s.name}.`}
                      confirm="Delete secret"
                      keep="Keep secret"
                      onConfirm={() => taskSecrets.remove(s).then(reload)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No task secret yet.</p>}
      </section>
      {vault ? (
        <section className="panel">
          <NewSecret repos={repos} local={local} op={op} onSaved={(saved) => {
            setNotice(saved.reference ? `Saved ${saved.name} for ${whose(saved, local)}; each task reads it from ${saved.reference}.` : `Saved ${saved.name} for ${whose(saved, local)}. The value is not shown again.`);
            void reload();
          }} />
        </section>
      ) : null}
    </>
  );
}
