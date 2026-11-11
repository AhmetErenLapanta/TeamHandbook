import { useEffect, useState } from "react";
import { call } from "../api";
import { Loading, LoadFailed } from "../Status";

type Status = { installed: false; from?: "clone" | "npx"; folder?: string } | { installed: true; refused: string } | { installed: true; running: string; prepared: string | null; failed: { version: string; reason: string } | null };
type Checked = { running: string; newest: string; newer: boolean } | { refused: string };
type Step = { ok: boolean; said: string[]; restart?: "service" | "start-again" };

/** As DEPLOY-sozlesme.md TP-185/177 B has them; nothing here asks the network but Check for updates. */
const update = {
  status: () => call<Status>("GET", "/api/update"),
  check: () => call<Checked>("POST", "/api/update/check"),
  prepare: (version: string) => call<Step>("POST", "/api/update/prepare", { version }),
  apply: () => call<Step>("POST", "/api/update/apply"),
  restart: () => call<{ restarting: true }>("POST", "/api/update/restart"),
};

/**
 * The orchestrator updating itself, one step at a time and only when its person asks: check, then
 * prepare the newer version, then switch to it, then start it again. Each step is the one button.
 */
/** How a copy install.sh did not install is brought up to date, said from how it was taken. */
function NotInstalled({ status }: { status: { from?: "clone" | "npx"; folder?: string } }) {
  if (status.from === "clone") return <p>This orchestrator runs from a clone. To update it, run <code>git pull</code>{status.folder ? <> in <code>{status.folder}</code></> : null}, then <code>npm start</code>.</p>;
  if (status.from === "npx") return <p>This orchestrator runs through npx; <code>npx teamhandbook-orchestrator@latest</code> runs the newest release.</p>;
  return <p>This orchestrator was not installed with install.sh, so it is updated the way it was installed.</p>;
}

export function UpdatesSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [applied, setApplied] = useState<Step | null>(null);
  const [said, setSaid] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    setFailed(null);
    update.status().then(setStatus, (e: Error) => setFailed(e.message));
  }, [reads]);
  // A restart takes the orchestrator away for a moment; the page opens again once it answers, running the new version.
  useEffect(() => {
    if (!restarting) return;
    let away = false;
    const timer = setInterval(() => {
      fetch("/api/health").then((r) => {
        if (r.ok && away) window.location.reload();
        if (!r.ok) away = true;
      }, () => {
        away = true;
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [restarting]);
  const run = <T,>(what: string, step: () => Promise<T>, then: (r: T) => void) => {
    setBusy(what);
    setRefused(null);
    step().then(then, (e: Error) => setRefused(e.message)).finally(() => setBusy(null));
  };
  if (failed) return <LoadFailed what="the update state" reason={failed} onRetry={() => setReads((n) => n + 1)} />;
  if (!status) return <Loading what="the update state" />;
  if (!status.installed) return <section className="section"><NotInstalled status={status} /></section>;
  if ("refused" in status) return <section className="section"><p className="error">{status.refused}</p></section>;
  const newer = checked && "newer" in checked && checked.newer ? checked.newest : null;
  const ready = status.prepared;
  const stepped = (r: Step) => {
    setSaid(r.said);
    if (!r.ok) setRefused(r.said.at(-1) ?? "The step did not finish.");
    setReads((n) => n + 1);
  };
  let line: string;
  let action: { label: string; go: () => void } | null = null;
  if (restarting) line = "Starting again with the new version; this page answers once it is back.";
  else if (applied?.ok) {
    line = applied.restart === "service" ? "Switched. The new version runs once the orchestrator starts again." : "Switched. Start the orchestrator again to run the new version.";
    if (applied.restart === "service") action = { label: "Restart now", go: () => run("restart", update.restart, () => setRestarting(true)) };
  } else if (ready) {
    line = `${ready} is prepared and checked.`;
    action = { label: `Switch to ${ready}`, go: () => run("apply", update.apply, (r) => {
      setApplied(r);
      stepped(r);
    }) };
  } else if (newer) {
    line = `${newer} is out. Preparing downloads and checks it; this version keeps running.`;
    action = { label: `Prepare ${newer}`, go: () => run("prepare", () => update.prepare(newer), stepped) };
  } else {
    line = checked && "refused" in checked ? checked.refused : checked ? `Running ${status.running}, the newest.` : `Running ${status.running}.`;
    action = { label: "Check for updates", go: () => run("check", update.check, setChecked) };
  }
  return (
    <section className="section" aria-labelledby="updates-h">
      <h2 id="updates-h">This orchestrator</h2>
      <p role="status">{line}</p>
      {status.failed && !ready ? <p className="error">{status.failed.version} did not prepare: {status.failed.reason}</p> : null}
      {action ? <div className="actions"><button type="button" disabled={busy !== null} onClick={action.go}>{busy ? "Working…" : action.label}</button></div> : null}
      {refused ? <p className="error" role="alert">{refused}</p> : null}
      {said.length ? <details className="section log-fold"><summary>What the update said</summary><ol className="task-log">{said.map((s, i) => <li key={i} className="mono">{s}</li>)}</ol></details> : null}
    </section>
  );
}
