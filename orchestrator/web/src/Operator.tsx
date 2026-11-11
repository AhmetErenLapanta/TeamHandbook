import { useEffect, useState } from "react";
import { identityApi, NotFound } from "./api";
import { Loading, LoadFailed } from "./Status";
import { Select } from "./Select";

const STEPS = ["signed up", "created an organization", "connected a forge", "started a first task", "merged a first request"] as const;
type Step = (typeof STEPS)[number];

interface Signup {
  identityId: string;
  provider: string;
  emailDomain: string;
  signedUpAt: string;
  orgCreated: { tenant: string; at: string } | null;
  viaInvite: boolean;
  lastStep: Step;
}
interface Funnel { people: Signup[]; counts: Record<Step, number>; days: number; keptDays: number }

const PROVIDER: Record<string, string> = { google: "Google", github: "GitHub", microsoft: "Microsoft" };
const day = (at: string) => at.slice(0, 10);

/**
 * The page for the people who run a cloud orchestrator: everyone who signed up in a window, how
 * far each got, and how many reached each step. It names an address's domain, never the address,
 * and an organization by its address only, since the operator is no member of it.
 */
export function OperatorPage() {
  const [days, setDays] = useState(30);
  const [read, setRead] = useState<Funnel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const load = () => {
    setError(null);
    setRead(null);
    identityApi.operatorFunnel<Funnel>(days).then(setRead, (e: Error) => (e instanceof NotFound ? setMissing(true) : setError(e.message)));
  };
  useEffect(load, [days]);
  if (missing) {
    return (
      <main className="page" id="content">
        <div className="page-head"><h1>Page not found</h1></div>
        <p>There is no page at this address.</p>
      </main>
    );
  }
  const windows = [7, 30, 90].filter((d) => !read || d <= read.keptDays);
  return (
    <main className="page operator" id="content">
      <div className="page-head">
        <h1>Signups</h1>
        <p className="muted">Everyone who signed up to this orchestrator, and how far each got. Addresses show by their domain; each visit here is recorded.</p>
      </div>
      <Select label="Signed up in the last" value={String(days)} onChange={(v) => setDays(Number(v))} options={windows.map((d) => ({ value: String(d), label: `${d} days` }))} />
      {error ? <LoadFailed what="the signups" reason={error} onRetry={load} panel /> : !read ? <Loading what="the signups" panel /> : (
        <>
          <section className="panel" aria-labelledby="funnel-h">
            <h2 id="funnel-h">How far they got</h2>
            <dl className="facts">
              {STEPS.map((s) => <div key={s}><dt>{s}</dt><dd>{read.counts[s].toLocaleString("en-US")}</dd></div>)}
            </dl>
          </section>
          <section className="panel" aria-labelledby="people-h">
            <h2 id="people-h">Signups <span className="count">{read.people.length}</span></h2>
            {read.people.length ? (
              <table>
                <thead><tr><th scope="col">Signed up</th><th scope="col">With</th><th scope="col">Domain</th><th scope="col">Organization</th><th scope="col">Furthest step</th></tr></thead>
                <tbody>
                  {read.people.map((p) => (
                    <tr key={p.identityId}>
                      <td>{day(p.signedUpAt)}</td>
                      <td>{PROVIDER[p.provider] ?? p.provider}</td>
                      <td>{p.emailDomain}</td>
                      <td>{p.orgCreated ? `/${p.orgCreated.tenant}, created ${day(p.orgCreated.at)}` : p.viaInvite ? "joined by invitation" : <span className="muted">none yet</span>}</td>
                      <td>{p.lastStep}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="muted">Nobody signed up in the last {read.days} days.</p>}
          </section>
        </>
      )}
    </main>
  );
}
