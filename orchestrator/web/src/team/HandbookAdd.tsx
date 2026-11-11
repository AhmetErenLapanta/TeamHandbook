import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { LoadFailed, Loading } from "../Status";
import { handbookApi } from "./handbook-api";
import type { OwnHandbook, OwnItem, Picked } from "./handbook-api";
import { HANDBOOK_TABS } from "./handbook-tabs";
import type { HandbookTab } from "./handbook-tabs";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const LISTS: Record<HandbookTab, keyof Picked> = { skills: "skills", mcp: "mcpServers", commands: "commands" };

const keyOf = (tab: HandbookTab, name: string) => `${tab}/${name}`;

/** What the ticks come to in words: "2 skills and 1 command". */
function summary(picked: Picked): string {
  return [count(picked.skills.length, "skill", "skills"), count(picked.mcpServers.length, "MCP server", "MCP servers"), count(picked.commands.length, "command", "commands")]
    .filter((_, at) => [picked.skills, picked.mcpServers, picked.commands][at]!.length)
    .join(" and ");
}

/**
 * The person's own skills, MCP servers and commands as the section's list, ticks kept across the
 * three tabs. Proposing sends the ticked ones as one request to the team repository, after the
 * person has read its commit message; merging it stays with a person.
 */
export function HandbookAdd({ repoId, head, onProposed, onCancel }: { repoId: string; head: string; onProposed: (picked: Picked, request: { number: number; url: string }) => void; onCancel: () => void }) {
  const [own, setOwn] = useState<OwnHandbook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<HandbookTab>("skills");
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<{ message: string; branch: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const read = () => {
    setError(null);
    handbookApi.own(repoId).then(setOwn, (e: Error) => setError(e.message));
  };
  useEffect(read, [repoId]);
  if (error) return <LoadFailed what="your Claude Code" reason={error} onRetry={read} />;
  if (!own) return <Loading what="your Claude Code" />;
  if (!own.available) {
    return (
      <div role="status">
        <p className="muted">{own.why}</p>
        <p><button type="button" className="secondary" onClick={onCancel}>Close</button></p>
      </div>
    );
  }
  const items = (t: HandbookTab): OwnItem[] => (t === "skills" ? own.skills : t === "mcp" ? own.mcpServers : own.commands);
  const picked: Picked = { skills: [], mcpServers: [], commands: [] };
  for (const t of HANDBOOK_TABS) for (const item of items(t.id)) if (ticked.has(keyOf(t.id, item.name))) picked[LISTS[t.id]].push(item.name);
  const total = picked.skills.length + picked.mcpServers.length + picked.commands.length;
  const toggle = (key: string) => {
    const next = new Set(ticked);
    if (!next.delete(key)) next.add(key);
    setTicked(next);
  };
  const review = () => {
    setProblem(null);
    setBusy(true);
    handbookApi.proposal(repoId, picked).then(
      (proposed) => {
        setConfirm({ message: proposed.proposal, branch: proposed.branch });
        setBusy(false);
      },
      (e: Error) => {
        setProblem(e.message);
        setBusy(false);
      },
    );
  };
  const open = (e: FormEvent) => {
    e.preventDefault();
    if (!confirm) return;
    setProblem(null);
    setBusy(true);
    handbookApi.propose(repoId, picked, confirm.message, confirm.branch, head).then((request) => onProposed(picked, request), (err: Error) => {
      setProblem(err.message);
      setBusy(false);
    });
  };
  if (confirm) {
    return (
      <form className="form editor" onSubmit={open}>
        <p>{summary(picked)} from your Claude Code, as one request to the team's repository.</p>
        <label>Commit message<input value={confirm.message} onChange={(e) => setConfirm({ ...confirm, message: e.target.value })} required /></label>
        <label>Branch<input value={confirm.branch} onChange={(e) => setConfirm({ ...confirm, branch: e.target.value })} required spellCheck={false} /></label>
        {problem ? <p className="error" role="alert">{problem}</p> : null}
        <div className="actions">
          <button type="submit" disabled={busy}>Open request</button>
          <button type="button" className="secondary" onClick={() => setConfirm(null)}>Back</button>
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    );
  }
  const shown = items(tab);
  return (
    <>
      <div className="segmented" role="tablist" aria-label="Your Claude Code">
        {HANDBOOK_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" className="secondary" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {shown.length ? (
        <ul className="team-rows" aria-label={`Your ${HANDBOOK_TABS.find((t) => t.id === tab)!.label}`}>
          {shown.map((item) => (
            <li key={item.name}>
              <label className="team-pick">
                <input type="checkbox" checked={ticked.has(keyOf(tab, item.name))} disabled={!item.addable} onChange={() => toggle(keyOf(tab, item.name))} />
                <span className="mono">{item.name}</span>
              </label>
              {item.description ? <span className="muted"> {item.description}</span> : null}
              <span className="muted"> {!item.addable ? item.why ?? "cannot be shared" : item.inTeam ? "in the team; ticking updates it from yours" : "from your Claude Code"}</span>
            </li>
          ))}
        </ul>
      ) : <p className="muted">Your Claude Code holds none of these.</p>}
      {problem ? <p className="error" role="alert">{problem}</p> : null}
      <div className="actions">
        <button type="button" disabled={!total || busy} onClick={review}>{total ? `Propose ${total} to the team` : "Tick what to propose"}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}
