import { useEffect, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { ApiError, call } from "./api";
import { ConfirmAction } from "./Confirm";
import { moveInList, tabStop } from "./roving";
import { here } from "./router";

/** A teammate a task is shared with, to read and nothing more (GOREV-PAYLASIMI-sozlesme.md). */
export interface TaskShare { userId: string; name: string; email: string | null; sharedBy: string; at: string }

const at = (task: string, rest = "") => `/api/tasks/${encodeURIComponent(task)}/shares${rest}`;

export const taskShares = {
  list: (task: string) => call<{ shares: TaskShare[] }>("GET", at(task)).then((b) => b.shares),
  add: (task: string, email: string) => call<{ share: TaskShare }>("POST", at(task), { email }),
  remove: (task: string, userId: string) => call<unknown>("DELETE", at(task, `/${encodeURIComponent(userId)}`)),
};

/**
 * Who else reads a task because someone shared it with them. Whoever started it or edits its team
 * adds a teammate by address and removes one picked from the list; the people it is shared with
 * read it and pass it on to nobody.
 */
export function TaskShares({ task, canShare, manager, adding, onClose }: { task: string; canShare: boolean; manager: boolean; adding: boolean; onClose: () => void }) {
  const [shares, setShares] = useState<TaskShare[] | null>(null);
  const [reads, setReads] = useState(0);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ said: string; notMember: boolean } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    taskShares.list(task).then(setShares, () => setShares([]));
  }, [task, reads]);
  if (!shares || (!shares.length && !adding)) return null;
  const share = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setRefused(null);
    taskShares.add(task, email.trim()).then(() => {
      setEmail("");
      setReads((n) => n + 1);
      onClose();
    }, (err: Error) => setRefused({ said: err.message, notMember: err instanceof ApiError && err.code === "not-a-member" })).finally(() => setBusy(false));
  };
  const pick = (userId: string) => setPicked(picked === userId ? null : userId);
  const chosen = shares.find((s) => s.userId === picked) ?? null;
  return (
    <section aria-labelledby="task-shares-h">
      <h2 id="task-shares-h">
        Shared with{" "}
        {canShare && chosen ? (
          <ConfirmAction key={chosen.userId} small trigger="Remove…" triggerLabel={`Stop sharing with ${chosen.name}`} consequence={`${chosen.name} no longer reads this task.`} confirm="Stop sharing" keep="Keep sharing" onConfirm={() => taskShares.remove(task, chosen.userId).then(() => {
            setPicked(null);
            setReads((n) => n + 1);
          })} />
        ) : null}
      </h2>
      {shares.length && canShare ? (
        <ul className="tool-list" role="listbox" aria-label="Shared with" onKeyDown={moveInList}>
          {shares.map((s, i) => (
            <li key={s.userId} className="tool-row" role="option" tabIndex={tabStop(i, shares.findIndex((x) => x.userId === picked))} aria-selected={picked === s.userId} onClick={() => pick(s.userId)} onKeyDown={(e: KeyboardEvent) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              pick(s.userId);
            }}>
              <span dir="auto">{s.name}</span>{s.email ? <> <span className="muted small">{s.email}</span></> : null}
            </li>
          ))}
        </ul>
      ) : shares.length ? (
        <ul className="plain" aria-label="Shared with">
          {shares.map((s) => <li key={s.userId} dir="auto">{s.name}</li>)}
        </ul>
      ) : null}
      {adding ? (
        <form className="form" onSubmit={share} aria-label="Share this task">
          <label>A teammate's email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" autoFocus /></label>
          <div className="actions">
            <button type="submit" disabled={busy || !email.trim()}>Share</button>
            <button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button>
          </div>
          {refused ? <p className="error" role="alert">{refused.said}{refused.notMember && manager ? <> <a href={here("settings", "members")}>Invite them on Members</a></> : null}</p> : null}
        </form>
      ) : null}
    </section>
  );
}
