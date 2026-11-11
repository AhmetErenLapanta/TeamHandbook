import { useEffect, useRef, useState } from "react";
import { CopyText } from "./Confirm";
import { machinesApi } from "./machines/api";
import type { Machine } from "./machines/api";
import { Loading, LoadFailed } from "./Status";

/** How often the person's machines are read to see this one come online. */
const WATCH_MS = 3_000;

/** How many expired codes are replaced on their own before the screen waits for a click, so a tab left open for hours stops asking. */
const RENEWALS = 6;

/**
 * How long the screen waits for a computer before it says so: the runner connects within seconds
 * of being run, and a person stuck past this wants to know where to look rather than wait more.
 */
const SLOW_MS = 30_000;

type Pairing = { code: string; expiresAt: string; command: string };

function until(at: string): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * The first thing a person does on a team's orchestrator whose tasks run on people's own machines:
 * run one command on this computer. The code is asked for as the screen opens and again when it
 * runs out, so there is nothing to press; the first machine of theirs that comes online is handed on.
 */
export function ConnectComputer({ onConnected }: { onConnected: (machine: Machine) => void }) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [round, setRound] = useState(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!pairing) return;
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [pairing?.code]);
  const connected = useRef(onConnected);
  connected.current = onConnected;
  useEffect(() => {
    let live = true;
    let pair: Pairing | null = null;
    let left = RENEWALS;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      live = false;
      clearInterval(timer);
    };
    const ask = () =>
      machinesApi.pair().then(
        (p) => {
          if (!live) return;
          pair = p;
          setPairing(p);
        },
        (e: Error) => {
          if (!live) return;
          stop();
          setError(e.message);
        },
      );
    const look = () =>
      machinesApi.list().then(
        ({ machines }) => {
          if (!live) return true;
          const online = machines.find((m) => m.online);
          if (online) {
            stop();
            connected.current(online);
            return true;
          }
          if (pair && Date.parse(pair.expiresAt) <= Date.now()) {
            pair = null;
            if (left-- > 0) void ask();
            else {
              stop();
              setPairing(null);
              setStale(true);
            }
          }
          return false;
        },
        () => false,
      );
    void look().then((found) => {
      if (found || !live) return;
      void ask();
      timer = setInterval(() => void look(), WATCH_MS);
    });
    return stop;
  }, [round]);
  const again = () => {
    setError(null);
    setStale(false);
    setPairing(null);
    setRound((r) => r + 1);
  };
  return (
    <section className="panel connect-computer" aria-labelledby="connect-computer-h">
      <h2 id="connect-computer-h">Connect this computer</h2>
      <p>Agents work in folders on your own computer. Run this once in a terminal there; it keeps running until you press Ctrl-C.</p>
      {error ? (
        <LoadFailed what="the command" reason={error} onRetry={again} />
      ) : stale ? (
        <div className="actions"><button type="button" onClick={again}>Get a new command</button></div>
      ) : pairing ? (
        <>
          <CopyText text={pairing.command} label="Copy the command" primary well />
          <p className="muted">The code in it works once, until {until(pairing.expiresAt)}.</p>
          <p className="muted waiting-line" role="status">{slow ? "This computer has not connected yet; the terminal where you ran the command says why." : "Waiting for this computer…"}</p>
        </>
      ) : (
        <Loading what="the command" />
      )}
    </section>
  );
}
