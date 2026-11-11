import type { AgentChoices, AgentOption } from "./api";
import { Select } from "./Select";

/** What a picked agent lets a person choose, read from the agent itself: nothing shows for an agent that offers nothing. */
export function AgentChoicesPicker({ options, value, onChange }: { options: AgentOption[] | undefined; value: AgentChoices; onChange: (next: AgentChoices) => void }) {
  if (!options?.length) return null;
  return (
    <>
      {options.map((o) => (
        <Select
          key={o.id}
          label={o.label}
          value={value[o.id] ?? ""}
          onChange={(v) => onChange({ ...value, [o.id]: v || undefined })}
          options={[{ value: "", label: "The agent's default" }, ...o.choices]}
        />
      ))}
    </>
  );
}

/** Only what was chosen, so a choice left at the default is not sent. */
export function chosen(value: AgentChoices): AgentChoices | undefined {
  const picked = Object.fromEntries(Object.entries(value).filter(([, v]) => v)) as AgentChoices;
  return Object.keys(picked).length ? picked : undefined;
}
