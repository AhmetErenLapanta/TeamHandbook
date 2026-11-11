import { useId, useRef, useState } from "react";
import type { Principal } from "../api";
import { ConfirmAction } from "../Confirm";
import { here, navigate } from "../router";
import { manages, policiesApi } from "./api";
import type { PolicyProposal, PolicySaved, RequestConfirmation } from "./api";
import { ChipField } from "./ChipField";
import type { Choice } from "./ChipField";
import { audienceRefusal, AUDIENCE_KINDS, blockRefusal, deleteConsequence, emptyRule, isDeveloperKind, lockedReason, NAME_MAX, policySummary, RULE_BLOCKS, saveNote, savesAsRequest } from "./policy";
import type { Audience, AudienceKind, Policy, PolicyDraft, Rule } from "./policy";
import { PolicyPreviewPanel } from "./Preview";
import { RuleBlock } from "./RuleBlock";
import { ConfirmRequests, OpenedRequests } from "./Save";
import { Select } from "../Select";

const AUDIENCE_LABELS: Record<AudienceKind, string> = {
  workspace: "Everyone in the organization",
  teams: "Members of teams",
  members: "These members",
  "except-members": "Everyone except these members",
  tags: "Members tagged",
  "except-tags": "Everyone except those tagged",
  "service-accounts": "These service accounts",
};

/** `tags` is null when the person does not see members' tags. */
export interface EditorSources { teams: Choice[]; members: Choice[]; repos: Choice[]; tags: Choice[] | null; orchestratorRulesStored: boolean }

function AudiencePicker({ audience, rules, sources, onChange }: { audience: Audience; rules: Rule[]; sources: EditorSources; onChange: (audience: Audience) => void }) {
  const id = useId();
  const refusal = audienceRefusal(audience.kind, rules);
  const choices = audience.kind === "teams" ? sources.teams : audience.kind === "members" || audience.kind === "except-members" ? sources.members : [];
  return (
    <fieldset className="plain-fieldset">
      <legend className="field-label">Applies to</legend>
      <Select label="Who this policy applies to" labelHidden value={audience.kind} onChange={(v) => {
        const kind = v as AudienceKind;
        onChange(kind === "workspace" ? { kind } : { kind, ids: [] });
      }} options={AUDIENCE_KINDS.map((k) => ({ value: k, label: AUDIENCE_LABELS[k], disabled: k !== audience.kind && audienceRefusal(k, rules) !== null }))} />
      {savesAsRequest({ rules }) ? <p className="muted small-print">Blocking rules reach teammates' sessions, which apply to whole teams, so only the organization or teams fit.</p> : null}
      {refusal ? <p className="error">{refusal}</p> : null}
      {audience.kind === "tags" || audience.kind === "except-tags" ? (
        <TagPicker tags={sources.tags} ids={audience.ids} onChange={(ids) => onChange({ kind: audience.kind, ids })} />
      ) : audience.kind === "workspace" ? null : (
        <ChipField
          label={audience.kind === "teams" ? "Teams" : audience.kind === "service-accounts" ? "Service accounts" : "Members"}
          placeholder={audience.kind === "service-accounts" ? "service account id" : audience.kind === "teams" ? "team" : "name or email"}
          values={audience.ids}
          choices={choices}
          free={audience.kind !== "teams"}
          onChange={(ids) => onChange({ kind: audience.kind, ids })}
        />
      )}
    </fieldset>
  );
}

/** Tags are picked from the ones members carry, so a policy never names a tag nobody has. */
function TagPicker({ tags, ids, onChange }: { tags: Choice[] | null; ids: string[]; onChange: (ids: string[]) => void }) {
  if (tags === null) return <p className="muted">Only an owner or an admin sees members' tags.</p>;
  if (!tags.length && !ids.length) {
    return <p className="muted">No member has a tag yet; add one on a member's page in <a href={here("settings", "members")}>Settings</a>.</p>;
  }
  return <ChipField label="Tags" placeholder="pick a tag" values={ids} choices={tags} free={false} show={(id) => id} onChange={onChange} />;
}

function AddBlock({ rules, me, orchestratorRulesStored, onAdd }: { rules: Rule[]; me: Principal; orchestratorRulesStored: boolean; onAdd: (rule: Rule) => void }) {
  // One person's own orchestrator has no teammates whose Claude Code a rule reaches.
  const offered = me.mode === "local" ? RULE_BLOCKS.filter((b) => !isDeveloperKind(b.kind)) : RULE_BLOCKS;
  const blocks = offered.map((b) => ({ ...b, refusal: blockRefusal(b.kind, { rules, isAdmin: manages(me), orchestratorRulesStored }) }));
  // Blocks locked for the same reason say it once on the screen; each locked button still names it to a screen reader.
  const reasons = [...new Set(blocks.flatMap((b) => (b.refusal ? [b.refusal] : [])))];
  return (
    <nav className="panel add-blocks" aria-labelledby="add-blocks-h">
      <h2 id="add-blocks-h">Add a rule</h2>
      <ul className="plain">
        {blocks.map((b) => {
          const hint = `add-${b.kind}-hint`;
          return (
            <li key={b.kind}>
              <button type="button" className="block-button" disabled={b.refusal !== null} aria-describedby={hint} onClick={() => onAdd(emptyRule(b.kind))}>
                <span aria-hidden="true">+ </span>{b.label}
              </button>
              <p id={hint} className={b.refusal ? "visually-hidden" : "muted small-print"}>{b.refusal ?? b.hint}</p>
            </li>
          );
        })}
      </ul>
      {reasons.map((r) => <p key={r} className="muted small-print locked-blocks" aria-hidden="true">{r}</p>)}
    </nav>
  );
}

type Phase = { at: "edit" } | { at: "confirm"; plan: Extract<PolicyProposal, { applies: "request" }>; removing: boolean } | { at: "opened"; saved: Extract<PolicySaved, { saved: "request" }> };

export function PolicyEditor({ me, initial, existing, sources, back, repoName }: { me: Principal; initial: PolicyDraft; existing: Policy | null; sources: EditorSources; back: string; repoName: (id: string) => string }) {
  const [draft, setDraft] = useState<PolicyDraft>(initial);
  // Each block keeps its own key, so removing one leaves what is typed in the others where it was.
  const [keys, setKeys] = useState(() => initial.rules.map((_, i) => i));
  const nextKey = useRef(initial.rules.length);
  const [phase, setPhase] = useState<Phase>({ at: "edit" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = existing?.id ?? null;
  const names = (value: string) => sources.teams.find((t) => t.id === value)?.label ?? sources.members.find((m) => m.id === value)?.label ?? value;
  const locked = lockedReason(draft);
  const setRule = (index: number, rule: Rule) => setDraft({ ...draft, rules: draft.rules.map((r, i) => (i === index ? rule : r)) });

  const finished = (saved: PolicySaved) => {
    if (saved.saved === "request") setPhase({ at: "opened", saved });
    else navigate(back);
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    await work().catch((e: Error) => setError(e.message));
    setBusy(false);
  };
  const save = () => run(async () => {
    if (!savesAsRequest(draft)) return finished(await policiesApi.save(id, draft));
    const plan = await policiesApi.proposal(id, draft);
    if (plan.applies === "now") return finished(await policiesApi.save(id, draft));
    setPhase({ at: "confirm", plan, removing: false });
  });
  // A policy that reaches teammates is removed by a reviewed request, confirmed on the next screen; an orchestrator policy is asked here.
  const remove = () => run(async () => {
    if (!id) return;
    const plan = await policiesApi.proposal(id, null);
    if (plan.applies === "now") return finished(await policiesApi.remove(id));
    setPhase({ at: "confirm", plan, removing: true });
  });
  const confirm = async (c: RequestConfirmation) => {
    if (phase.at !== "confirm") return;
    finished(phase.removing && id ? await policiesApi.remove(id, c) : await policiesApi.save(id, draft, c));
  };

  if (phase.at === "opened") return <OpenedRequests saved={phase.saved} repoName={repoName} back={back} />;
  if (phase.at === "confirm") {
    return <ConfirmRequests plan={phase.plan} action={phase.removing ? "Remove this policy" : "Save this policy"} onConfirm={confirm} onCancel={() => setPhase({ at: "edit" })} />;
  }
  return (
    <div className="policy-editor">
      <p className="policy-summary" role="status" aria-live="polite">{policySummary(draft, names)}</p>
      <div className="policy-columns">
        <section className="panel form policy-form" aria-label="Policy">
          <div className="field">
            <label htmlFor="policy-name">Name</label>
            <input id="policy-name" value={draft.name} maxLength={NAME_MAX} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <AudiencePicker audience={draft.audience} rules={draft.rules} sources={sources} onChange={(audience) => setDraft({ ...draft, audience })} />
        </section>
        <div className="policy-rules">
          {draft.rules.length ? (
            draft.rules.map((rule, i) => <RuleBlock key={keys[i]} rule={rule} index={i} repos={sources.repos} onChange={(r) => setRule(i, r)} onRemove={() => {
              setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) });
              setKeys(keys.filter((_, j) => j !== i));
            }} />)
          ) : (
            <div className="panel"><p className="muted">No rules yet.</p></div>
          )}
        </div>
        <AddBlock rules={draft.rules} me={me} orchestratorRulesStored={sources.orchestratorRulesStored} onAdd={(rule) => {
          setDraft({ ...draft, rules: [...draft.rules, rule] });
          setKeys([...keys, nextKey.current++]);
        }} />
        <PolicyPreviewPanel draft={draft} repoName={repoName} members={sources.members} exportable={manages(me)} />
        <section className="panel save-bar" aria-label="Save">
          <p className="muted">{saveNote(draft)}</p>
          {locked ? <p id="locked-reason" className="locked">{locked}</p> : null}
          {error ? <p className="error" role="alert">{error}</p> : null}
          <div className="actions">
            <button type="button" onClick={save} disabled={busy || locked !== null} aria-describedby={locked ? "locked-reason" : undefined}>{busy ? "Saving…" : "Save policy"}</button>
            <a className="button secondary" href={back}>Cancel</a>
            {existing && savesAsRequest(existing) ? <button type="button" className="secondary danger" onClick={remove} disabled={busy}>Delete this policy</button> : null}
            {existing && !savesAsRequest(existing) ? (
              <ConfirmAction trigger="Delete this policy" consequence={deleteConsequence(existing)} confirm="Delete policy" keep="Keep policy" onConfirm={() => policiesApi.remove(existing.id).then(() => navigate(back))} />
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
