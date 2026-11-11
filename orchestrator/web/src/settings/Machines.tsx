import { useEffect, useRef, useState } from "react";
import { NotFound } from "../api";
import { ConfirmAction, CopyText } from "../Confirm";
import { machinesApi } from "../machines/api";
import type { Machine } from "../machines/api";
import { agentLine } from "../machines/SignIn";
import { here } from "../router";
import { Loading, LoadFailed } from "../Status";

/** While a new machine is being connected, how often the list is read again to see it arrive. */
const WATCH_MS = 3_000;

function when(at: string | null): string {
  return at ? at.slice(0, 16).replace("T", " ") : "never";
}

/**
 * The machines that run this person's tasks, each with the agent CLIs it found and whether each
 * is signed in, and the way to connect another: a one-time code and the command that uses it.
 * Tasks run only on the machine of the person who starts them.
 */
export function MachinesSettings() {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; command: string } | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval>>();
  const read = () => machinesApi.list().then((r) => {
    setError(null);
    setMachines(r.machines);
    return r.machines;
  }, (e: Error) => {
    if (e instanceof NotFound) setMissing(true);
    else setError(e.message);
    return null;
  });
  useEffect(() => {
    void read();
    return () => clearInterval(timer.current);
  }, []);
  const connect = () => {
    setPairError(null);
    machinesApi.pair().then((p) => {
      setPairing(p);
      const before = new Set((machines ?? []).map((m) => m.id));
      clearInterval(timer.current);
      timer.current = setInterval(() => {
        void read().then((now) => {
          if (now?.some((m) => !before.has(m.id)) || Date.parse(p.expiresAt) < Date.now()) {
            clearInterval(timer.current);
            setPairing(null);
          }
        });
      }, WATCH_MS);
    }, (e: Error) => setPairError(e.message));
  };
  if (missing) return <LoadFailed what="your machines" reason="This orchestrator does not answer for machines yet; it runs tasks itself." next={<a href={here("tasks")}>Start a task</a>} panel />;
  if (error) return <LoadFailed what="your machines" reason={error} onRetry={() => void read()} panel />;
  if (!machines) return <Loading what="your machines" panel />;
  const pairingBody = pairing ? (
    <>
      <p>Run this on the machine, once, before {when(pairing.expiresAt)}; the code works one time and is not shown again.</p>
      <CopyText text={pairing.command} label="Copy the command" />
      <p className="muted small" role="status">Waiting for the machine to connect…</p>
    </>
  ) : null;
  const pairFailed = pairError ? <p className="error" role="alert">{pairError}</p> : null;
  if (!machines.length) {
    return (
      <section className="panel" aria-labelledby="machines-h">
        <h2 id="machines-h" className="visually-hidden">Your machines</h2>
        <div className="empty-state">
          <p className="empty-state-title">No machine connected yet</p>
          <p className="muted">Tasks you start run only on your machines.</p>
          {pairingBody ?? <div className="actions"><button type="button" onClick={connect}>Connect a machine</button></div>}
          {pairFailed}
        </div>
      </section>
    );
  }
  return (
    <>
      <section className="panel" aria-labelledby="machines-h">
        <h2 id="machines-h" className="visually-hidden">Your machines</h2>
        <p className="muted">{machines.length === 1 ? "1 machine is connected." : `${machines.length} machines are connected.`} Tasks you start run here, with the agent CLIs you are signed in to; nothing runs on anyone else's machine.</p>
        <ul className="plain machines">
          {machines.map((m) => (
            <li key={m.id} className="machine" aria-label={m.name}>
              <p className="machine-head">
                <strong>{m.name}</strong>
                <span className="muted small"> {m.platform}{m.owner ? `, ${m.owner}` : ""}</span>
                {m.paused ? <span className="badge warn">Paused</span> : m.online ? <span className="badge ok">Online</span> : <span className="badge">Offline, last seen {when(m.lastSeenAt)}</span>}
              </p>
              <ul className="plain machine-agents">
                {m.agents.map((a) => (
                  <li key={a.id}>
                    {agentLine(a)}
                    {a.signIn === "signed-out" && a.signInCommand ? <span className="small"> Run on {m.name}: <CopyText text={a.signInCommand} label={`Copy the sign-in command for ${a.label}`} /></span> : null}
                  </li>
                ))}
              </ul>
              <ConfirmAction
                small
                trigger="Remove"
                triggerLabel={`Remove ${m.name}`}
                consequence={`${m.name} stops taking your tasks at once; a task it is running stops and waits for you to continue it.`}
                confirm="Remove machine"
                keep="Keep machine"
                onConfirm={() => machinesApi.remove(m.id).then(() => read())}
              />
            </li>
          ))}
        </ul>
      </section>
      <section className="panel" aria-labelledby="connect-machine-h">
        <h2 id="connect-machine-h">Connect a machine</h2>
        {pairingBody ?? <div className="actions"><button type="button" onClick={connect}>Connect a machine</button></div>}
        {pairFailed}
      </section>
    </>
  );
}
