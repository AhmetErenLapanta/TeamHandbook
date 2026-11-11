import { useState } from "react";
import { tasksApi } from "../api";
import type { JoinMessage, ScaffoldRefresh, SetupFinding } from "../api";
import { here, navigate } from "../router";
import type { RepoPanelProps } from "./types";

const LEVEL: Record<SetupFinding["level"], { badge: string; text: string }> = {
  ok: { badge: "ok", text: "fine" },
  attention: { badge: "warn", text: "attention" },
  problem: { badge: "error", text: "problem" },
  suggestion: { badge: "neutral", text: "suggestion" },
};

/** Starts the orchestrator's own scaffold refresh as a task and opens it; the task opens the request. */
function RefreshScaffold({ repoId, refresh }: { repoId: string; refresh: ScaffoldRefresh }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if ("problem" in refresh) return <p className="muted">{refresh.problem}</p>;
  const start = () => {
    setBusy(true);
    setError(null);
    tasksApi
      .start({ title: "", description: "", issueUrl: "", repoId, agent: "", template: { kind: "scaffold.refresh", commitVersioning: false } })
      .then((task) => navigate(here("tasks", task.id)), (e: Error) => {
        setError(e.message);
        setBusy(false);
      });
  };
  return (
    <div className="actions">
      <button type="button" disabled={busy} onClick={start}>Update TeamHandbook's files</button>
      <span className="muted">The orchestrator writes the files this release writes and opens them as a request; no agent runs.</span>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </div>
  );
}

/** The repository's setup as a team lead reads it: what teammates can do with it, and what to do about what is missing. */
function SetupPanel({ findings, repoId, refresh, editable, local }: { findings: SetupFinding[]; repoId: string; refresh: ScaffoldRefresh; editable: boolean; local: boolean }) {
  // A suggestion is shown and not counted: nothing is short without it.
  const open = findings.filter((f) => f.level === "attention" || f.level === "problem").length;
  const stops = findings.some((f) => f.level === "problem");
  return (
    <section className="panel" aria-labelledby="setup-h">
      <h2 id="setup-h">Setup</h2>
      <p>{stops ? <span className="badge error">{local ? "Something needs fixing" : "Something stops teammates"}</span> : open ? <span className="badge warn">{open === 1 ? "One thing" : `${open} things`} to look at</span> : <span className="badge ok">All checks pass</span>}</p>
      {/* Open when something asks for the lead; folded when all is well, so the page leads with what to do. */}
      <details open={open > 0}>
        <summary>{open ? "What to look at" : "Every check"}</summary>
      <ul className="findings">
        {findings.map((f) => (
          <li key={f.title}>
            <span className={`badge ${LEVEL[f.level].badge}`}>{LEVEL[f.level].text}</span> <strong>{f.title}</strong>
            {f.detail ? <p className="muted">{f.detail}</p> : null}
            {f.next ? <p>What to do: {f.next}</p> : null}
            {f.more ? <details><summary>Details</summary><p className="muted">{f.more}</p></details> : null}
          </li>
        ))}
      </ul>
      </details>
      {editable && findings.some((f) => f.refresh) ? <RefreshScaffold repoId={repoId} refresh={refresh} /> : null}
    </section>
  );
}

/** One command a teammate types, selectable as text; the button copies it where the browser allows it. */
function CommandLine({ text }: { text: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = () => {
    if (!navigator.clipboard) return setCopied("select it and copy");
    navigator.clipboard.writeText(text).then(() => setCopied("copied"), () => setCopied("select it and copy"));
  };
  return (
    <li>
      <code>{text}</code> <button type="button" className="secondary small" aria-label={`Copy ${text}`} onClick={copy}>Copy</button>
      {copied ? <span className="muted" role="status"> {copied}</span> : null}
    </li>
  );
}

/** The message a team lead hands teammates: what to type in Claude Code to use the team's skills, and to share their own. */
function JoinPanel({ join }: { join: JoinMessage }) {
  return (
    <section className="panel" aria-labelledby="join-h">
      <h2 id="join-h">How teammates join</h2>
      {"problem" in join ? <p className="muted">{join.problem}</p> : (
        <>
          <p>To use the team's skills, in Claude Code:</p>
          <ul className="plain">{join.use.map((c) => <CommandLine key={c} text={c} />)}</ul>
          <p>To also share their own, with TeamHandbook installed:</p>
          <ul className="plain"><CommandLine text={join.contribute} /></ul>
          <p className="muted">A private repository also needs each teammate signed in to its forge on their own machine.</p>
        </>
      )}
    </section>
  );
}

/** What the repository offers teammates and what to do about its setup. */
export function Overview({ data, editable, repo, me }: RepoPanelProps) {
  const { skills, mcpServers, commands } = data.inventory;
  const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  return (
    <>
      <SetupPanel findings={data.inventory.setup} repoId={repo.id} refresh={data.refresh} editable={editable} local={me.mode === "local"} />
      <section className="panel" aria-labelledby="shares-h">
        <h2 id="shares-h">What it shares</h2>
        <p>
          <a href={here("repositories", repo.id, "skills")}>{plural(skills.length, "skill")}</a>, <a href={here("repositories", repo.id, "mcp")}>{plural(mcpServers.length, "MCP server")}</a>, <a href={here("repositories", repo.id, "commands")}>{plural(commands.length, "slash command")}</a>
        </p>
      </section>
      {/* On one person's own machine there are no teammates to hand the commands to. */}
      {me.mode === "local" ? null : <JoinPanel join={data.join} />}
    </>
  );
}
