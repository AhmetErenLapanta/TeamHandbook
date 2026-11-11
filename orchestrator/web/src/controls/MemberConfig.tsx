import { useEffect, useId, useState } from "react";
import type { MemberConfig, RepoReach } from "../../../shared/member-config";
import { here } from "../router";
import { memberConfigApi } from "./api";
import type { Choice } from "./ChipField";
import { draftEffects } from "./draft-effects";
import type { Audience, Rule } from "./policy";
import { Select } from "../Select";

function Held({ reason }: { reason: string }) {
  return <span className="held"> Blocked: {reason}</span>;
}

function Repo({ repo }: { repo: RepoReach }) {
  return (
    <section className="reach" aria-labelledby={`reach-${repo.repoId}`}>
      <h3 id={`reach-${repo.repoId}`}><a href={here("repositories", repo.repoId)}>{repo.name}</a> <span className="count">{repo.team}</span></h3>
      {repo.problem ? <p className="error">The team's rules here do not read: {repo.problem}</p> : null}
      <p className="field-label">Skills <span className="count">{repo.skills.length}</span></p>
      {repo.skills.length ? <ul className="plain">{repo.skills.map((s) => <li key={s.slug}><span className="mono">{s.slug}</span>{s.removedBy ? <Held reason={s.removedBy.reason} /> : null}</li>)}</ul> : <p className="muted">None.</p>}
      <p className="field-label">MCP servers <span className="count">{repo.mcpServers.length}</span></p>
      {repo.mcpServers.length ? (
        <ul className="plain">
          {repo.mcpServers.map((m) => (
            <li key={m.name}>
              <span className="mono">{m.name}</span>{m.removedBy ? <Held reason={m.removedBy.reason} /> : null}
              {m.tools.length ? <ul className="plain nested">{m.tools.map((t) => <li key={t.resource}>tool <span className="mono">{t.tool}</span><Held reason={t.reason} /></li>)}</ul> : null}
            </li>
          ))}
        </ul>
      ) : <p className="muted">None.</p>}
      <p className="field-label">Commands <span className="count">{repo.commands.length}</span></p>
      {repo.commands.length ? <p className="mono">{repo.commands.map((c) => `/${c}`).join("  ")}</p> : <p className="muted">None.</p>}
      {repo.tools.length ? (
        <>
          <p className="field-label">Claude Code tools held back</p>
          <ul className="plain">{repo.tools.map((t) => <li key={t.resource}><span className="mono">{t.resource.replace(/^tool:/, "")}</span><Held reason={t.reason} /></li>)}</ul>
        </>
      ) : null}
    </section>
  );
}

/** What one member's sessions get from their teams, what the teams' rules take away, and where the orchestrator keeps them from starting a task. */
export function MemberConfigSection({ id }: { id: string }) {
  const [config, setConfig] = useState<MemberConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setConfig(null);
    setError(null);
    memberConfigApi.get(id).then((c) => live && setConfig(c), (e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id, attempt]);
  const refused = config?.tasks.filter((t) => t.refusal) ?? [];
  return (
    <section className="panel member-config" aria-labelledby="member-config-h" aria-busy={!config && !error}>
      <h2 id="member-config-h">What reaches their sessions</h2>
      {error ? (
        <div role="alert">
          <p className="error">Couldn't load this member's configuration. {error}</p>
          <button type="button" className="secondary small" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </div>
      ) : null}
      {!config && !error ? <p className="muted">Reading their teams' repositories…</p> : null}
      {config ? (
        <>
          <p className="muted">
            {config.teams.length ? `Through ${config.teams.join(", ")}: what each team repository gives their Claude Code, and what the team's rules take away.` : "Not on a team, so no team repository reaches their sessions."}
          </p>
          {config.repos.map((r) => <Repo key={r.repoId} repo={r} />)}
          <h3>Starting tasks</h3>
          {refused.length ? (
            <ul className="plain">{refused.map((t) => <li key={t.repoId}><strong>{t.name}</strong>: {t.refusal}</li>)}</ul>
          ) : <p className="muted">No orchestrator rule keeps them from starting a task.</p>}
        </>
      ) : null}
    </section>
  );
}

/** The policy editor's preview for one chosen member: what the draft would take from them, read with the draft in place. */
export function MemberPreview({ members, audience, rules, ready }: { members: Choice[]; audience: Audience; rules: Rule[]; ready: boolean }) {
  const id = useId();
  const [member, setMember] = useState("");
  const [state, setState] = useState<{ key: string; effects: { what: string; reason: string }[] | null; error: string | null } | null>(null);
  const key = ready && member ? JSON.stringify({ member, audience, rules }) : null;
  useEffect(() => {
    if (!key) return;
    let live = true;
    const timer = setTimeout(() => {
      memberConfigApi.preview(member, audience, rules).then(
        (p) => live && setState({ key, effects: draftEffects(p.before, p.after), error: null }),
        (e: Error) => live && setState({ key, effects: null, error: e.message }),
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key]);
  if (!members.length) return null;
  const name = members.find((m) => m.id === member)?.label ?? "";
  const current = state && state.key === key ? state : null;
  return (
    <div className="member-preview">
      <div className="member-pick">
        <Select label="Preview for a member" value={member} onChange={setMember} options={[{ value: "", label: "Choose a member" }, ...members.map((m) => ({ value: m.id, label: m.label }))]} />
        {member ? <button type="button" className="secondary small" onClick={() => setMember("")}>Close member preview</button> : null}
      </div>
      {!member ? <p className="muted small-print">Choose members to preview this policy.</p> : null}
      {member && !ready ? <p className="muted small-print">Complete this policy to preview it for {name}.</p> : null}
      {member && ready ? (
        <div role="status" aria-live="polite">
          {current?.error ? <p className="error">Couldn't preview this policy for {name}. {current.error}</p> : null}
          {!current ? <p className="muted small-print">Reading what reaches {name}…</p> : null}
          {current?.effects ? (
            current.effects.length ? (
              <ul className="plain">{current.effects.map((e) => <li key={e.what}><strong>{e.what}</strong><span className="held"> · {e.reason}</span></li>)}</ul>
            ) : <p className="muted">This policy takes nothing from {name}.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
