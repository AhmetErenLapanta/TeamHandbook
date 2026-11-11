import { useEffect, useState } from "react";
import { accessApi } from "../api";
import type { AppGrant, Principal, SessionListing } from "../api";
import { ConfirmAction } from "../Confirm";
import { settingsSectionInMode } from "../navigation";
import { here } from "../router";
import { LoadFailed, Loading } from "../Status";
import { Hint } from "../Hint";

function when(at: string | null): string {
  return at ? new Date(at).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "unknown";
}

/** The apps this person let reach the orchestrator's MCP server, each taken back on its own. */
function ApprovedApps() {
  const [apps, setApps] = useState<AppGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = () => accessApi.apps().then(setApps, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="panel" aria-labelledby="apps-h">
      <h2 id="apps-h">Apps you approved {apps ? <span className="count">{apps.length}</span> : null}</h2>
      <p className="muted">MCP clients you let act as you through the orchestrator's MCP server. <Hint label="approved apps">Taking one back ends its access at once; it asks you to approve it again.</Hint></p>
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      {error ? <LoadFailed what="the apps you approved" reason={error} onRetry={() => { setError(null); void load(); }} /> : !apps ? <Loading what="the apps you approved" /> : apps.length ? (
        <table>
          <thead><tr><th>App</th><th>Can</th><th>Approved</th><th><span className="visually-hidden">Take back</span></th></tr></thead>
          <tbody>
            {apps.map((a) => (
              <tr key={a.id}>
                <td>{a.clientName}</td>
                <td>{a.scopes.join(", ")}</td>
                <td>{when(a.createdAt)}</td>
                <td>
                  <ConfirmAction
                    small
                    trigger="Take back"
                    triggerLabel={`Take back the access of ${a.clientName} approved ${when(a.createdAt)}`}
                    consequence={`${a.clientName} stops reaching the orchestrator at its next call.`}
                    confirm="Take back access"
                    keep="Keep access"
                    onConfirm={() =>
                      accessApi.takeBack(a.id).then(() => {
                        setNotice(`${a.clientName} no longer has access.`);
                        return load();
                      })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted">No app has been approved to act as you.</p>}
    </section>
  );
}

/** Where this person is signed in, each session ended on its own, the apps they approved; their API keys and machines are one page away. */
export function AccessSettings({ me }: { me: Principal }) {
  const [sessions, setSessions] = useState<SessionListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = () => accessApi.sessions().then(setSessions, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <section className="panel" aria-labelledby="sessions-h">
        <h2 id="sessions-h">Where you are signed in {sessions ? <span className="count">{sessions.length}</span> : null}</h2>
        <p className="muted">Each browser you signed in from. <Hint label="sessions">Signing a browser out ends it at its next request, an open task stream included.</Hint></p>
        {notice ? <p className="notice" role="status">{notice}</p> : null}
        {error ? <LoadFailed what="your sessions" reason={error} onRetry={() => { setError(null); void load(); }} /> : !sessions ? <Loading what="your sessions" /> : sessions.length ? (
          <table>
            <thead><tr><th>Browser</th><th>Signed in</th><th>Last seen</th><th>Ends</th><th><span className="visually-hidden">End</span></th></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{s.userAgent ?? "unknown"}{s.current ? <> <span className="badge ok">this browser</span></> : null}</td>
                  <td>{when(s.createdAt)}</td>
                  <td>{when(s.lastSeenAt)}</td>
                  <td>{when(s.expiresAt)}</td>
                  <td>
                    <ConfirmAction
                      small
                      trigger="Sign out there"
                      triggerLabel={`Sign out ${s.userAgent ?? "an unknown browser"}, signed in ${when(s.createdAt)}`}
                      consequence={s.current ? "This signs you out of this browser." : "That browser is signed out at its next request."}
                      confirm="Sign out there"
                      keep="Stay signed in there"
                      onConfirm={() =>
                        accessApi.end(s.id).then(() => {
                          if (s.current) window.location.assign("/");
                          setNotice("The session is ended.");
                          return load();
                        })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No browser is signed in as you.</p>}
      </section>
      <ApprovedApps />
      <section className="panel" aria-labelledby="tokens-h">
        <h2 id="tokens-h">Keys</h2>
        <p className="muted">Automation signs in with an API key: <a href={here("settings", "api-keys")}>see and revoke your API keys</a>.</p>
        {settingsSectionInMode(me, "machines") ? <p className="muted">Your machines run your tasks; see and remove them on <a href={here("settings", "machines")}>Your machines</a>.</p> : null}
      </section>
    </>
  );
}
