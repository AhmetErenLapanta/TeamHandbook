import type { SkillSuggestions } from "./api";
import { MOST_SKILLS } from "./api";

/**
 * The skills a task reaches as chips, the agent's suggestions picked to begin with and each saying
 * why, so a person sees what the agent will reach for first and changes it before the task starts.
 * One person's own orchestrator has no team, so its words name none.
 */
export function SkillChips({ label, read, value, onChange, local = false }: { label: string; read: SkillSuggestions; value: string[]; onChange: (next: string[]) => void; local?: boolean }) {
  const why = new Map(read.suggestions.map((s) => [s.skill, s.reason]));
  const toggle = (name: string) => onChange(value.includes(name) ? value.filter((v) => v !== name) : [...value, name]);
  if (!read.skills.length) return <p className="muted small">{local ? "There are no skills here yet." : "The team has no skills here yet."}</p>;
  return (
    <fieldset className="skill-chips">
      <legend>{label} <span className="count">{value.length} of {MOST_SKILLS}</span></legend>
      <div className="chips">
        {read.skills.map((s) => {
          const on = value.includes(s.name);
          return (
            <label key={s.name} className={`chip-pick${on ? " on" : ""}`} title={s.description}>
              <input type="checkbox" checked={on} disabled={!on && value.length >= MOST_SKILLS} onChange={() => toggle(s.name)} />
              <span className="mono">{s.name}</span>
              {why.has(s.name) ? <span className="badge neutral">suggested</span> : null}
            </label>
          );
        })}
      </div>
      {read.suggestions.length ? (
        <ul className="plain reasons">
          {read.suggestions.map((s) => <li key={s.skill} className="muted small"><span className="mono">{s.skill}</span>: {s.reason}</li>)}
        </ul>
      ) : <p className="muted small">{read.note ?? `The agent suggested none; it still has ${local ? "every skill" : "every team skill"}.`}</p>}
    </fieldset>
  );
}
