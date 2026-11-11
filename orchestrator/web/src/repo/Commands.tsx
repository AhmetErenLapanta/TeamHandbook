import { useState } from "react";
import type { RequestRecord } from "../api";
import { CommandEditor, CommandRemoval } from "../Editing";
import type { RepoPanelProps } from "./types";

type Editing = { type: "command-add" } | { type: "command-edit"; name: string } | { type: "command-remove"; name: string } | null;

/** The team's slash commands, and the requests that change them. */
export function Commands({ repo, data, editable, onOpened, selected, onSelect }: RepoPanelProps) {
  const { inventory } = data;
  const [editing, setEditing] = useState<Editing>(null);
  const opened = (r: RequestRecord) => {
    setEditing(null);
    onOpened(r);
  };
  const formProps = { repoId: repo.id, head: inventory.head, onOpened: opened, onCancel: () => setEditing(null) };
  return (
    <section className="panel" aria-labelledby="cmd-h">
      <h2 id="cmd-h">
        Slash commands <span className="count">{inventory.commands.length}</span>
        {editable ? <button type="button" className="secondary small" onClick={() => setEditing({ type: "command-add" })}>Add a command</button> : null}
      </h2>
      {editing?.type === "command-add" ? <CommandEditor {...formProps} /> : null}
      {editing?.type === "command-edit" ? <CommandEditor key={editing.name} {...formProps} name={editing.name} /> : null}
      {editing?.type === "command-remove" ? <CommandRemoval key={editing.name} {...formProps} name={editing.name} /> : null}
      {inventory.commands.length ? (
        <ul className="plain">
          {inventory.commands.map((cmd) => (
            <li key={cmd.name}>
              <button type="button" className="link" aria-pressed={selected === cmd.file} onClick={() => onSelect(cmd.file)}><code>/{cmd.name}</code></button> <span className="muted">{cmd.description}</span>
              {editable ? (
                <span className="row-actions">
                  {" "}<button type="button" className="secondary small" aria-label={`Edit /${cmd.name}`} onClick={() => setEditing({ type: "command-edit", name: cmd.name })}>Edit</button>
                  <button type="button" className="secondary small" aria-label={`Remove /${cmd.name}`} onClick={() => setEditing({ type: "command-remove", name: cmd.name })}>Remove</button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : <p className="muted">None shared yet. A command reaches this list when a request adds it under commands/.</p>}
    </section>
  );
}
