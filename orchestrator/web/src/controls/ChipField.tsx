import { useId, useState } from "react";

export interface Choice { id: string; label: string }

/**
 * A list of names a person builds one at a time: typed, or picked from what the orchestrator
 * already knows. `free` lets a name in that is not among the choices.
 */
export function ChipField({ label, values, onChange, choices = [], free = true, placeholder, show = (id) => choices.find((c) => c.id === id)?.label ?? id }: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  choices?: Choice[];
  free?: boolean;
  placeholder?: string;
  show?: (id: string) => string;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const add = () => {
    const typed = text.trim();
    if (!typed) return;
    const match = choices.find((c) => c.id === typed || c.label.toLowerCase() === typed.toLowerCase());
    if (!match && !free) {
      setProblem(`${typed} is not one of the choices.`);
      return;
    }
    const value = match?.id ?? typed;
    if (!values.includes(value)) onChange([...values, value]);
    setText("");
    setProblem(null);
  };
  return (
    <div className="chip-field">
      <label htmlFor={`${id}-in`}>{label}</label>
      {values.length ? (
        <ul className="chips" aria-label={label}>
          {values.map((v) => (
            <li key={v} className="chip">
              <span>{show(v)}</span>
              <button type="button" className="chip-remove" aria-label={`Remove ${show(v)}`} onClick={() => onChange(values.filter((x) => x !== v))}>×</button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="chip-add">
        <input
          id={`${id}-in`}
          value={text}
          list={choices.length ? `${id}-list` : undefined}
          placeholder={placeholder}
          aria-describedby={problem ? `${id}-problem` : undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="secondary small" onClick={add} disabled={!text.trim()}>Add</button>
      </div>
      {choices.length ? (
        <datalist id={`${id}-list`}>
          {choices.filter((c) => !values.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </datalist>
      ) : null}
      {problem ? <p id={`${id}-problem`} className="error">{problem}</p> : null}
    </div>
  );
}
