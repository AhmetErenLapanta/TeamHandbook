import { useState } from "react";
import { call } from "../api";
import type { HandbookSource } from "../handbook/handbook-read";
import { PluginRuns, runsSaid } from "./PluginRuns";

type Ran = { ok: true; command: string } | { ok: false; command: string; why: string };
type Changes = { freshness: { installed: string | null; available: string | null; added: string[]; changed: string[]; removed: string[] }; commands: { added: string[]; changed: string[]; removed: string[] }; mcpServers: { added: string[]; changed: string[]; removed: string[] } };

const list = (names: string[]) => (names.length ? names.join(", ") : null);
const andJoined = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "");

/** "1.5.0 brings 1 hook (after each tool call) and 1 MCP server, adds add-webhook, changes add-endpoint and removes old-deploy." */
function bringsSaid(latest: NonNullable<HandbookSource["latest"]>): string {
  const runs = runsSaid(latest.hooks, latest.mcpServers);
  const skills = andJoined([latest.added.length ? `adds ${latest.added.join(", ")}` : null, latest.changed.length ? `changes ${latest.changed.join(", ")}` : null, latest.removed.length ? `removes ${latest.removed.join(", ")}` : null].filter((p): p is string => p !== null));
  const said = runs && skills ? `brings ${runs}, ${skills}` : runs ? `brings ${runs}` : skills;
  return said ? `${latest.version} ${said}.` : "";
}
/** Every name an update touches, each said with what happens to it. */
const named = (c: { added: string[]; changed: string[]; removed: string[] }) => [...c.added.map((n) => `${n} (added)`), ...c.changed.map((n) => `${n} (changed)`), ...c.removed.map((n) => `${n} (removed)`)];

/**
 * What can be done to one of the person's plugins from their Team page, each on a press and said
 * before it runs: read what an update changes and update, or remove it, with turning it off offered
 * first. Every change is Claude Code's own command.
 */
export function PluginActions({ source, onRan, machine }: { source: HandbookSource; onRan: (said: Ran) => void; machine?: { id: string; name: string } }) {
  const on = machine ? `?${new URLSearchParams({ machine: machine.id })}` : "";
  const [asking, setAsking] = useState<"update" | "remove" | null>(null);
  const [changes, setChanges] = useState<Changes | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [patch, setPatch] = useState<{ name: string; text: string | null; truncated: boolean } | null>(null);
  const readPatch = (name: string) => {
    setPatch({ name, text: null, truncated: false });
    call<{ patch: string; truncated: boolean }>("GET", `/api/handbook/plugins/${encodeURIComponent(source.marketplace ?? "")}/${encodeURIComponent(source.name)}/changes/skills/${encodeURIComponent(name)}`).then(
      (r) => setPatch({ name, text: r.patch, truncated: r.truncated }),
      (e: Error) => setPatch({ name, text: e.message, truncated: false }),
    );
  };
  const run = (op: "update" | "uninstall" | "disable") => {
    setBusy(true);
    call<Ran>("POST", `/api/handbook/plugins/${op}${on}`, { plugin: source.id }).then((r) => {
      setAsking(null);
      onRan(r);
    }, (e: Error) => setProblem(e.message)).finally(() => setBusy(false));
  };
  const openUpdate = () => {
    setAsking("update");
    setProblem(null);
    // A machine's marketplace copy is read on that machine: what the update brings comes with its setup, not from here.
    if (machine) return;
    call<Changes>("GET", `/api/handbook/plugins/${encodeURIComponent(source.marketplace ?? "")}/${encodeURIComponent(source.name)}/changes`).then(setChanges, (e: Error) => setProblem(e.message));
  };
  return (
    <div className="plugin-actions">
      {asking === "update" ? (
        <div className="plugin-ask" role="group" aria-label={`Update ${source.name}`}>
          {!changes && !problem && !machine ? <p className="muted">Reading what {source.latest?.version ?? "the update"} changes…</p> : null}
          {changes ? (
            <dl className="plugin-changes">
              {list(changes.freshness.added) ? <><dt>Adds</dt><dd className="mono">{list(changes.freshness.added)}</dd></> : null}
              {changes.freshness.changed.length ? (
                <><dt>Changes</dt><dd>{changes.freshness.changed.map((name, at) => <span key={name}>{at ? ", " : ""}<button type="button" className="link mono" aria-pressed={patch?.name === name} onClick={() => readPatch(name)}>{name}</button></span>)}</dd></>
              ) : null}
              {list(changes.freshness.removed) ? <><dt>Removes</dt><dd className="mono">{list(changes.freshness.removed)}</dd></> : null}
              {list(named(changes.commands)) ? <><dt>Commands</dt><dd className="mono">{list(named(changes.commands))}</dd></> : null}
              {list(named(changes.mcpServers)) ? <><dt>MCP servers</dt><dd className="mono">{list(named(changes.mcpServers))}</dd></> : null}
            </dl>
          ) : null}
          {patch ? <pre className="handbook-text" aria-label={`What changes in ${patch.name}`}>{patch.text ?? `Reading ${patch.name}…`}{patch.truncated ? "\n…" : ""}</pre> : null}
          <p>This runs <code>claude plugin marketplace update {source.marketplace}</code> and <code>claude plugin update {source.name}@{source.marketplace}</code>{machine ? ` on ${machine.name}` : ""}; your terminal gets it too. {source.latest ? bringsSaid(source.latest) : ""}</p>
          {source.latest ? <PluginRuns hooks={source.latest.hooks} mcpServers={source.latest.mcpServers} /> : null}
          <div className="actions">
            <button type="button" disabled={busy || (!changes && !machine)} onClick={() => run("update")}>Update to {source.latest?.version ?? "the newer version"}</button>
            <button type="button" className="secondary" onClick={() => setAsking(null)}>Cancel</button>
          </div>
        </div>
      ) : asking === "remove" ? (
        <div className="plugin-ask" role="group" aria-label={`Remove ${source.name}`}>
          <p>This runs <code>claude plugin uninstall {source.name}@{source.marketplace}</code>{machine ? ` on ${machine.name}` : ""}; your terminal loses it too, and it cannot be put back from here. Turn it off instead?</p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => run("disable")}>Turn off</button>
            <button type="button" className="danger" disabled={busy} onClick={() => run("uninstall")}>Remove</button>
            <button type="button" className="secondary" onClick={() => setAsking(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          {/* What a newer version brings is read before anything is pressed; Update is the one filled action of an opened row. */}
          {source.latest ? <p>{bringsSaid(source.latest)}</p> : null}
          {source.latest ? <PluginRuns hooks={source.latest.hooks} mcpServers={source.latest.mcpServers} /> : null}
          <div className="actions">
            {source.latest ? <button type="button" className="small" onClick={openUpdate}>Update to {source.latest.version}…</button> : null}
            <button type="button" className="link small" onClick={() => setAsking("remove")}>Remove…</button>
          </div>
        </>
      )}
      {problem ? <p className="error" role="alert">{problem}</p> : null}
    </div>
  );
}
