import { useEffect, useState } from "react";
import { myMcpApi, teamMcpApi } from "./api";
import type { TeamMcpServer } from "./api";
import { ConfirmAction } from "./Confirm";
import { firstPick, groupTools } from "./MyMcpServers";
import { Loading, LoadFailed } from "./Status";

/**
 * The servers the team repositories declare that sign people in. A task reaches one with the
 * sign-in of whoever started it, or else the organization's; with neither it cannot sign in.
 */
export function TeamMcpServers() {
  const [read, setRead] = useState<{ servers: TeamMcpServer[]; canManage: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => teamMcpApi.list().then(setRead, (e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const run = (work: () => Promise<unknown>, done: string | null) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    work().then(
      () => {
        setBusy(false);
        if (done) setNotice(done);
        load();
      },
      (e: Error) => {
        setBusy(false);
        setError(e.message);
      },
    );
  };
  if (!read) return error ? <LoadFailed what="team MCP servers" reason={error} onRetry={() => { setError(null); load(); }} /> : <Loading what="team MCP servers" />;
  if (!read.servers.length) return <p className="muted">No team repository declares a server that signs people in.</p>;
  return (
    <>
      <p className="muted">A task reaches these with the sign-in of whoever started it, or else the organization's.</p>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <ul className="plain my-servers">
        {read.servers.map((s) => <TeamServerRow key={s.key} server={s} canManage={read.canManage} busy={busy} run={run} done={(said) => { setNotice(said); load(); }} />)}
      </ul>
    </>
  );
}

function TeamServerRow({ server, canManage, busy, run, done }: { server: TeamMcpServer; canManage: boolean; busy: boolean; run: (work: () => Promise<unknown>, done: string | null) => void; done: (said: string) => void }) {
  const [offered, setOffered] = useState<{ name: string; description: string; writes: boolean; reads: boolean }[] | null>(null);
  const [chosen, setChosen] = useState<string[]>(server.tools);
  // Connecting for oneself is adding the same server as one's own, then signing in to it.
  const connectMine = () =>
    run(async () => {
      if (!server.mine) await myMcpApi.add({ name: server.name, description: `The team's ${server.name}`, transport: "http", url: server.url, auth: "oauth" });
      window.location.assign(await myMcpApi.connect(server.name));
    }, null);
  const connectEveryone = () => run(async () => window.location.assign(await teamMcpApi.connectForEveryone(server.key)), null);
  const load = () =>
    run(async () => {
      const listed = await teamMcpApi.tools(server.key);
      setOffered(listed);
      setChosen(firstPick(listed, server.tools));
    }, null);
  const toggle = (n: string) => setChosen(chosen.includes(n) ? chosen.filter((c) => c !== n) : [...chosen, n]);
  const tools = offered ? groupTools(offered) : null;
  const writing = offered ? chosen.filter((n) => offered.find((t) => t.name === n)?.writes) : (server.everyone?.writing ?? []);
  return (
    <li className="panel my-server">
      <div className="card-head">
        <h4>{server.name}</h4>
        <span className={`badge ${server.everyone ? "ok" : "warn"}`}>{server.everyone ? "Connected for everyone's tasks" : "Needs a sign-in"}</span>
      </div>
      <p className="mono small-print">{server.url}</p>
      <p className="small-print">Declared by {server.repos.map((r) => `${r.team} · ${r.name}`).join(", ")}</p>
      {server.everyone ? <p>Acts as the account {server.everyone.by} signed in with in every task whose starter has not connected it, since {server.everyone.at.slice(0, 10)}.</p> : null}
      <p className="small-print">{server.mine ? "Your own sign-in is used in the tasks you start, once connected; manage it under Your MCP servers." : "Your tasks use the organization's sign-in, if there is one."}</p>
      <div className="row-actions">
        {!server.mine ? <button type="button" className="small" disabled={busy} onClick={connectMine}>Connect for my tasks</button> : null}
        {canManage ? (
          server.everyone ? (
            <ConfirmAction
              small
              trigger="Disconnect for everyone"
              triggerLabel={`Disconnect ${server.name} for everyone's tasks`}
              consequence={`Tasks whose starter has not connected ${server.name} stop reaching it, and the organization's sign-in is deleted.`}
              confirm={`Disconnect ${server.name}`}
              keep="Keep it connected"
              onConfirm={() => teamMcpApi.disconnectForEveryone(server.key).then(() => done(`${server.name} is disconnected from everyone's tasks.`))}
            />
          ) : <button type="button" className="secondary small" disabled={busy} onClick={connectEveryone}>Connect for everyone's tasks</button>
        ) : null}
        {canManage ? <button type="button" className="secondary small" disabled={busy} onClick={load}>Load tools</button> : null}
      </div>
      {canManage && tools ? (
        <>
          {tools.reads.length ? <fieldset className="teams"><legend>Reads</legend>{tools.reads.map((t) => <label key={t.name} className="check" title={t.description || undefined}><input type="checkbox" checked={chosen.includes(t.name)} onChange={() => toggle(t.name)} />{t.name}</label>)}</fieldset> : null}
          {tools.writes.length ? <fieldset className="teams"><legend>Writes</legend>{tools.writes.map((t) => <label key={t.name} className="check" title={t.description || undefined}><input type="checkbox" checked={chosen.includes(t.name)} onChange={() => toggle(t.name)} />{t.name}</label>)}</fieldset> : null}
          <div className="row-actions"><button type="button" className="small" disabled={busy} onClick={() => run(() => teamMcpApi.saveTools(server.key, chosen), `Saved the tools everyone's tasks may use of ${server.name}.`)}>Save tools</button></div>
        </>
      ) : null}
      {server.everyone && writing.length ? <p className="warning" role="note">This lets a task change things in {server.name} as {server.everyone.by}: {writing.join(", ")}.</p> : null}
      {canManage ? <p className="small-print muted">{server.tools.length ? `Everyone's tasks may use: ${server.tools.join(", ")}` : "No tool is picked for everyone's tasks yet."} Tools a repository's mcpTools names in the orchestrator's configuration are allowed besides.</p> : null}
    </li>
  );
}
