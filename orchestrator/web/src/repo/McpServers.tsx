import { useState } from "react";
import type { RequestRecord } from "../api";
import { McpForm, McpRemoval } from "../Editing";
import type { RepoPanelProps } from "./types";

type Editing = { type: "mcp" } | { type: "mcp-edit"; name: string } | { type: "mcp-remove"; name: string } | null;

/** The team's MCP servers: what each runs, whether teammates get it, and the requests that change them. */
export function McpServers({ repo, data, me, editable, onOpened, selected, onSelect }: RepoPanelProps) {
  const local = me.mode === "local";
  const { inventory } = data;
  const [editing, setEditing] = useState<Editing>(null);
  const inTasks = inventory.mcpServers.some((m) => m.inTasks);
  const opened = (r: RequestRecord) => {
    setEditing(null);
    onOpened(r);
  };
  const formProps = { repoId: repo.id, head: inventory.head, onOpened: opened, onCancel: () => setEditing(null) };
  const stop = (fn: () => void) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    fn();
  };
  return (
    <section className="panel" aria-labelledby="mcp-h">
      <h2 id="mcp-h">
        MCP servers <span className="count">{inventory.mcpServers.length}</span>
        {editable && inventory.mcpServers.length ? <button type="button" className="secondary small" onClick={() => setEditing({ type: "mcp" })}>Add a server</button> : null}
      </h2>
      {!inventory.mcpServers.length && !editing ? (
        <div className="empty">
          <p>{local ? "No MCP server here yet; the first one is in the repository, and in your tasks, once its request is merged." : editable ? "No MCP server is shared here yet; one added here starts on every teammate's machine once its request is merged." : `No MCP server is shared here yet; an owner of ${repo.team} adds the first one.`}</p>
          {editable ? <p><button type="button" onClick={() => setEditing({ type: "mcp" })}>Add a server</button></p> : null}
        </div>
      ) : null}
      {editing?.type === "mcp" ? <McpForm {...formProps} /> : null}
      {editing?.type === "mcp-edit" ? <McpForm key={editing.name} {...formProps} name={editing.name} /> : null}
      {editing?.type === "mcp-remove" ? <McpRemoval key={editing.name} {...formProps} name={editing.name} /> : null}
      {inventory.mcpServers.length ? <table>
        <thead><tr><th>Server</th><th>What it runs</th><th>Status</th>{editable ? <th><span className="visually-hidden">Changes</span></th> : null}</tr></thead>
        <tbody>
          {inventory.mcpServers.map((m) => (
            <tr key={m.name} className={selected === ".mcp.json" ? "selected" : undefined} onClick={() => onSelect(".mcp.json")}>
              <td className="mono"><button type="button" className="link" aria-pressed={selected === ".mcp.json"} onClick={() => onSelect(".mcp.json")}>{m.name}</button></td>
              <td className="mono">{m.target}</td>
              <td>
                {m.shareable ? <span className="badge ok">{local ? "shareable" : "teammates get it"}</span> : <span className="badge warn">not shareable as written</span>}
                <details onClick={(e) => e.stopPropagation()}>
                  <summary>Details</summary>
                  <dl className="facts">
                    <div><dt>Transport</dt><dd>{m.transport}</dd></div>
                    <div><dt>Variables</dt><dd className="mono">{m.envNames.join(", ") || "none"}</dd></div>
                    <div><dt>Share rule</dt><dd>{m.shareable ? "passes" : m.refusal}</dd></div>
                    {inTasks && m.inTasks ? <div><dt>In tasks</dt><dd><span className={`badge ${m.inTasks.usable && !m.inTasks.signIn ? "ok" : "warn"}`}>{!m.inTasks.usable ? "not given" : m.inTasks.signIn ? "given, no sign-in" : "given"}</span> <span className="muted">{m.inTasks.detail}</span></dd></div> : null}
                  </dl>
                </details>
              </td>
              {editable ? (
                <td className="row-actions">
                  <button type="button" className="secondary small" onClick={stop(() => setEditing({ type: "mcp-edit", name: m.name }))}>Edit</button>
                  <button type="button" className="secondary small" onClick={stop(() => setEditing({ type: "mcp-remove", name: m.name }))}>Remove</button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table> : null}
    </section>
  );
}
