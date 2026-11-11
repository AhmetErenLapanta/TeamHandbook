import { useEffect, useState } from "react";
import { isServiceAccount, policiesApi } from "./api";
import type { PolicyPreview } from "./api";
import { list, rulesProblem, savesAsRequest } from "./policy";
import type { PolicyDraft } from "./policy";
import type { Choice } from "./ChipField";
import { MemberPreview } from "./MemberConfig";
import { Hint } from "../Hint";

const SHOWN = 12;

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function People({ title, people }: { title: string; people: { id: string; name: string }[] }) {
  if (!people.length) return null;
  const rest = people.length - SHOWN;
  return (
    <div>
      <p className="field-label">{title}</p>
      <ul className="chips">{people.slice(0, SHOWN).map((p) => <li key={p.id} className="chip chip-plain">{p.name}</li>)}</ul>
      {rest > 0 ? <p className="muted small-print">and {count(rest, "more", "more")}</p> : null}
    </div>
  );
}

/** Who a draft covers, what tasks under it cost in the last 30 days, and where saving takes it, before anything is saved. */
export function PolicyPreviewPanel({ draft, repoName, members, exportable }: { draft: PolicyDraft; repoName: (id: string) => string; members: Choice[]; exportable: boolean }) {
  const problem = rulesProblem(draft);
  const key = problem ? null : JSON.stringify({ audience: draft.audience, rules: draft.rules });
  const [state, setState] = useState<{ key: string; preview: PolicyPreview | null; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) return;
    let live = true;
    // Asked once typing pauses rather than on every keystroke.
    const timer = setTimeout(() => {
      policiesApi.preview(draft.audience, draft.rules).then(
        (preview) => live && setState({ key, preview, error: null }),
        (e: Error) => live && setState({ key, preview: null, error: e.message }),
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, attempt]);

  const request = savesAsRequest(draft);
  const current = state && state.key === key ? state : null;
  return (
    <section className="panel preview" aria-labelledby="preview-h" aria-busy={key !== null && !current}>
      <h2 id="preview-h">Preview <span className="count">who this covers and what they ran</span></h2>
      {problem ? (
        <p className="muted">{(draft.audience.kind === "tags" || draft.audience.kind === "except-tags") && !draft.audience.ids.length ? "Add a tag to see who this applies to." : "Choose who this applies to and add a rule to preview it."}</p>
      ) : current?.error ? (
        <div role="alert">
          <p className="error">Couldn't preview this policy. {current.error}</p>
          <button type="button" className="secondary small" onClick={() => { setState(null); setAttempt((n) => n + 1); }}>Retry the preview</button>
        </div>
      ) : !current?.preview ? (
        <p className="muted">Working out who this covers…</p>
      ) : (
        <PreviewBody preview={current.preview} request={request} repoName={repoName} exportable={exportable} />
      )}
      <MemberPreview members={members} audience={draft.audience} rules={draft.rules} ready={!problem} />
    </section>
  );
}

/**
 * Claude Code's allowManagedHooksOnly turns off the hooks a plugin brings, so a team file's rules
 * stop reaching teammates there; the managed-settings export carries them instead. The export
 * reads saved policies and is an owner's or admin's, so only they get the link.
 */
/** Why the export is there, said where a region already says its one next step: behind a hint beside the export itself. */
export const MANAGED_HOOKS = "Where an organization allows only managed hooks, policies reach teammates through the managed-settings export.";

/** The managed-settings export, for the one who holds the whole organization; nobody else has anything to download. */
export function ManagedHooksNote({ exportable, repos = [] }: { exportable: boolean; repos?: { id: string; name: string }[] }) {
  if (!exportable) return null;
  return (
    <p className="muted small-print managed-hooks">
      {(repos.length ? repos : [null]).map((r, n) => (
        <span key={r?.id ?? "workspace"}>{n ? ", " : ""}<a href={`/api/policies/export?${r ? `repo=${encodeURIComponent(r.id)}&` : ""}download=1`} download>{r ? `Export the saved policies for ${r.name}` : "Export the saved policies"}</a></span>
      ))} <Hint label="the managed-settings export">{MANAGED_HOOKS}</Hint>
    </p>
  );
}

function PreviewBody({ preview, request, repoName, exportable }: { preview: PolicyPreview; request: boolean; repoName: (id: string) => string; exportable: boolean }) {
  const members = preview.members.filter((m) => !isServiceAccount(m.id));
  const services = preview.members.filter((m) => isServiceAccount(m.id));
  const { tasks, usd, unknownCost } = preview.usage30d;
  const repos = preview.repos.map(repoName);
  return (
    <div className="preview-body">
      <dl className="facts">
        <div><dt>Members</dt><dd>{members.length.toLocaleString("en-US")}</dd></div>
        <div><dt>Teams</dt><dd>{preview.teams.length.toLocaleString("en-US")}</dd></div>
        <div><dt>Service accounts</dt><dd>{services.length.toLocaleString("en-US")}</dd></div>
        <div><dt>Tasks, last 30 days</dt><dd>{tasks.toLocaleString("en-US")}{usd === null ? "" : ` · $${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}</dd></div>
      </dl>
      {unknownCost ? <p className="muted small-print">{count(unknownCost, "task", "tasks")} reported no cost and {unknownCost === 1 ? "is" : "are"} not in the total.</p> : null}
      {preview.members.length ? null : <p className="muted">Nobody is covered yet.</p>}
      <People title="Members" people={members} />
      <People title="Service accounts" people={services} />
      {preview.teams.length ? <p><span className="field-label">Teams</span><br />{list(preview.teams)}</p> : null}
      {request ? (
        <div className="applies applies-request">
          <p><strong>Saved as a request; reaches teammates when merged.</strong></p>
          <p className="muted">{repos.length ? `Saving opens a request on ${list(repos)}.` : "No covered team has a connected repository."}</p>
          <ManagedHooksNote exportable={exportable} repos={preview.repos.map((id) => ({ id, name: repoName(id) }))} />
        </div>
      ) : (
        <div className="applies applies-now">
          <p><strong>Applies now.</strong></p>
          <p className="muted">{repos.length ? `Holds tasks this orchestrator starts on ${list(repos)}, from the moment you save.` : "Holds the tasks this orchestrator starts, from the moment you save. Nothing changes on teammates' machines."}</p>
        </div>
      )}
    </div>
  );
}
