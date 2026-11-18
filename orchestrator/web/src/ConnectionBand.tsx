import { useEffect, useState, useSyncExternalStore } from "react";
import { apiPath } from "./api";
import { connection } from "./connection";

const SHOWN_AFTER_MS = 5_000;
const GIVEN_UP_AFTER_MS = 60_000;
const PROBE_EVERY_MS = 5_000;

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * Under the top bar when the orchestrator stops answering: after five seconds a line in the waiting tone, after a minute the
 * time the page last heard from it with a way to ask again. Back, `onBack` has the page read itself again. Never a toast.
 */
export function ConnectionBand({ onBack }: { onBack: () => void }) {
  const since = useSyncExternalStore(connection.subscribe, connection.since);
  const [now, setNow] = useState(Date.now());
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (since === null) {
      if (shown) {
        setShown(false);
        onBack();
      }
      return;
    }
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    const probe = setInterval(() => void fetch(apiPath("/api/me"), { credentials: "same-origin" }).then(connection.found, () => undefined), PROBE_EVERY_MS);
    return () => {
      clearInterval(tick);
      clearInterval(probe);
    };
  }, [since]);
  useEffect(() => {
    if (since !== null && now - since >= SHOWN_AFTER_MS) setShown(true);
  }, [since, now]);
  if (since === null || !shown) return null;
  const gaveUp = now - since >= GIVEN_UP_AFTER_MS;
  return (
    <p className="waiting connection-band" role="status">
      {gaveUp ? <>The orchestrator does not answer; this page shows what it had at {clock(since)}. <button type="button" className="link" onClick={() => void fetch(apiPath("/api/me"), { credentials: "same-origin" }).then(connection.found, () => undefined)}>Try again</button></> : "Reconnecting to the orchestrator…"}
    </p>
  );
}
