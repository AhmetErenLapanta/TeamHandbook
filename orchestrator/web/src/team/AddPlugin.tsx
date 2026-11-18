import { useEffect, useState } from "react";
import { call } from "../api";
import { LoadFailed, Loading } from "../Status";
import { PluginRuns, runsSaid } from "./PluginRuns";

export interface Offered { id: string; name: string; marketplace: string; description?: string; version?: string; skills: number | null; commands: number | null; hooks: { name: string; commands: string[] }[] | null; mcpServers: string[] }
type Ran = { ok: true; command: string } | { ok: false; command: string; why: string };

const counted = (n: number | null, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : null);
/** The catalogue Claude Code ships with: hundreds of plugins, offered only to a search. */
export const OFFICIAL_MARKETPLACE = "claude-plugins-official";
const FIRST_ROWS = 8;

/** The plugins to list: with no words, only those of marketplaces the person added themselves; with words, any marketplace picked, the official one included. */
export function listedFor(offered: Offered[], words: string, marketplace: string): Offered[] {
  const needle = words.trim().toLowerCase();
  return offered.filter((p) => (marketplace === "" || p.marketplace === marketplace)
    && (needle ? `${p.name} ${p.description ?? ""}`.toLowerCase().includes(needle) : marketplace !== "" || p.marketplace !== OFFICIAL_MARKETPLACE));
}

/**
 * The plugins the marketplaces the person's Claude Code knows offer, to install one with Claude
 * Code's own command after saying what it runs. A marketplace Claude Code does not know is added in
 * the person's terminal, never from here.
 */
export function AddPlugin({ onRan, onCancel }: { onRan: (r: Ran) => void; onCancel: () => void }) {
  const [offered, setOffered] = useState<Offered[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<Offered | null>(null);
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState("");
  const [marketplace, setMarketplace] = useState("");
  const [more, setMore] = useState(false);
  const read = () => {
    setError(null);
    call<{ plugins: Offered[] }>("GET", "/api/handbook/plugins/available").then((r) => setOffered(r.plugins), (e: Error) => setError(e.message));
  };
  useEffect(read, []);
  if (error) return <LoadFailed what="the plugins on offer" reason={error} onRetry={read} />;
  if (!offered) return <Loading what="the plugins on offer" />;
  const shown = listedFor(offered, words, marketplace);
  const install = (p: Offered) => {
    setBusy(true);
    call<Ran>("POST", "/api/handbook/plugins/install", { plugin: p.id }).then(onRan, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <div className="plugin-add" role="group" aria-label="Add a plugin">
      {asking ? (
        <>
          <p>This runs <code>claude plugin install {asking.name}@{asking.marketplace}</code>; your terminal gets it too. {runsSaid(asking.hooks ?? [], asking.mcpServers) ? `It runs ${runsSaid(asking.hooks ?? [], asking.mcpServers)}, in your terminal and in tasks started here.` : ""}</p>
          <PluginRuns hooks={asking.hooks ?? []} mcpServers={asking.mcpServers} />
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => install(asking)}>Install {asking.name}</button>
            <button type="button" className="secondary" onClick={() => setAsking(null)}>Back</button>
          </div>
        </>
      ) : (
        <>
          {offered.length ? (
            <>
              <div className="plugin-add-find">
                <label className="filter small">Find a plugin<input type="search" value={words} onChange={(e) => { setWords(e.target.value); setMore(false); }} /></label>
                <label className="filter small">From
                  <select value={marketplace} onChange={(e) => { setMarketplace(e.target.value); setMore(false); }}>
                    <option value="">Marketplaces you added</option>
                    {[...new Set(offered.map((p) => p.marketplace))].sort().map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
              </div>
              {shown.length ? (
                <ul className="team-rows plugin-add-list">
                  {(more ? shown : shown.slice(0, FIRST_ROWS)).map((p) => (
                    <li key={p.id} className="plugin-add-row">
                      <span className="plugin-add-what"><span className="mono">{p.name}</span>{" "}<span className="muted plugin-add-line">{p.marketplace}{p.version ? ` ${p.version}` : ""}{p.description ? `: ${p.description}` : ""}</span></span>
                      <button type="button" className="secondary small" onClick={() => setAsking(p)}>Install…</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="muted">{words.trim() ? "No plugin matches." : "Search for a plugin, or pick a marketplace."}</p>}
              {!more && shown.length > FIRST_ROWS ? <p><button type="button" className="link small" onClick={() => setMore(true)}>Show more ({shown.length - FIRST_ROWS})</button></p> : null}
            </>
          ) : <p className="muted">The marketplaces your Claude Code knows offer nothing you have not installed. Add another with <code>claude plugin marketplace add</code> in your terminal.</p>}
          <p><button type="button" className="secondary" onClick={onCancel}>Close</button></p>
        </>
      )}
    </div>
  );
}
