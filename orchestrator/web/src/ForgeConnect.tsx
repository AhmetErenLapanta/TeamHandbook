import { useEffect, useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ApiError, forgeApi } from "./api";
import type { ForgeCard as ForgeCardData, ForgeCheck, ForgeConnection, ForgeHost, ForgeRepo, ForgeSignIn, ForgeStep, OrgGitLabApp, RepoRecord } from "./api";
import { Connect } from "./Connect";
import { Hint } from "./Hint";
import { here } from "./router";
import { sentence } from "./said";
import { ConfirmAction } from "./Confirm";
import { Loading, LoadFailed } from "./Status";
import { FORGES } from "../../shared/forge-def";
import { APP_FORGES, FORGE_LABEL } from "./forge-connection";
import type { AppForge } from "./forge-connection";

type Kind = AppForge;

/**
 * What the card offers on each forge beyond what the forge definition says: an organization's own
 * application, the visibilities a new repository takes, and whether it is made in a group.
 */
const CARD: Record<AppForge, { ownApplication: boolean; visibilities: readonly string[]; namespace: boolean }> = {
  gitlab: { ownApplication: true, visibilities: ["private", "internal", "public"], namespace: true },
  github: { ownApplication: false, visibilities: ["private", "public"], namespace: false },
};
const day = (at: string) => at.slice(0, 10);

/**
 * Each host of this forge the organization reaches, as a card: how it is reached (the one-click
 * connection, the organization's own application, tokens pasted for single repositories), its
 * repositories, and, where a token is pasted, the page that makes one and what it has to allow.
 */
export function ForgeHosts({ kind }: { kind: Kind }) {
  const [hosts, setHosts] = useState<ForgeHost[] | null>(null);
  useEffect(() => {
    forgeApi.hosts().then((r) => setHosts(r.hosts.filter((h) => h.kind === kind)), () => setHosts([]));
  }, [kind]);
  if (!hosts?.length) return null;
  const forge = FORGES[kind].label;
  return (
    <ul className="forge-hosts" aria-label={`${forge} hosts`}>
      {hosts.map((h) => {
        const byToken = h.repos.filter((r) => r.via === "token");
        const byConnection = h.repos.filter((r) => r.via === "connection");
        return (
          <li key={h.apiUrl} className="panel">
            <h4>{forge} at {new URL(h.webUrl).host}</h4>
            {h.connection ? <p>Connected as {h.connection.account}{h.ownApplication ? ", through the organization's own application" : ""}.</p> : h.ownApplication ? <p>The organization's own application is entered; nobody connected through it yet.</p> : null}
            {h.repos.length ? <p>{[byConnection.length ? `${byConnection.map((r) => r.id).join(", ")} through the connection` : "", byToken.length ? `${byToken.map((r) => r.id).join(", ")} with a token` : ""].filter(Boolean).join("; ")}.</p> : <p className="muted">No repository on it yet.</p>}
            {byToken.length ? <p>Make a token at <a href={h.credentials.tokenPage} target="_blank" rel="noopener">{new URL(h.credentials.tokenPage).host}</a> that allows: {h.credentials.scopes.join(", ")}.</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** What a return from the forge says, read once from the address it came back to. */
export function forgeReturn(): { connected: Kind | null; problem: string | null } {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("forge_connected");
  return { connected: (APP_FORGES as readonly (string | null)[]).includes(connected) ? (connected as AppForge) : null, problem: params.get("forge_problem") };
}

/**
 * The organization's one-click connection to GitLab or GitHub, for its owners and admins: connect
 * once, then pick the repositories the orchestrator reads and opens requests in, or have it make the
 * team repository. When the operator has not set the forge's application up, the card keeps the
 * token form alone, and on GitLab an owner enters the organization's own application.
 */
export function ForgeConnect({ kind, repos, onChanged }: { kind: Kind; repos: RepoRecord[]; onChanged: () => void }) {
  const forge = FORGES[kind].label;
  const [state, setState] = useState<{ connection: ForgeConnection | null; available: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = () => forgeApi.connection(kind).then(setState, (e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, [kind]);
  const back = forgeReturn();
  const changed = (said: string) => {
    setNotice(said);
    load();
    onChanged();
  };
  if (!state) return error ? <LoadFailed what={`the ${forge} connection`} reason={error} onRetry={() => { setError(null); load(); }} /> : <Loading what={`the ${forge} connection`} />;
  if (!state.available) return CARD[kind].ownApplication ? <OwnGitLabApp onSaved={load} /> : null;
  const connect = () => {
    setError(null);
    forgeApi.connect(kind).then((r) => window.location.assign(r.authorizeUrl), (e: Error) => setError(e.message));
  };
  const c = state.connection;
  return (
    <section className="forge-connect" aria-label={`${forge} connection`}>
      {back.connected === kind && c ? <p role="status">Connected to {forge} as {c.account}.</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {/* Unconnected, the card above offers Connect with the forge as its one action; here is only the other way, an organization's own application. */}
      {!c ? (
        CARD[kind].ownApplication ? <OwnGitLabApp onSaved={load} beside /> : null
      ) : (
        <>
          <p>Connected as {c.account} by {c.by} on {day(c.at)}.</p>
          {c.problem ? (
            <>
              <p className="error" role="alert">{c.problem}</p>
              <button type="button" onClick={connect}>Reconnect with {forge}</button>
            </>
          ) : null}
          <ConnectionCheck kind={kind} />
          <ForgeRepos kind={kind} repos={repos} onConnected={changed} />
          {c.manageUrl ? <p><a href={c.manageUrl} target="_blank" rel="noopener">Choose the repositories the {forge} app reaches</a></p> : null}
          <TeamRepository kind={kind} repos={repos} onMade={changed} />
          <ConfirmAction
            trigger={`Disconnect ${forge}`}
            consequence={`The orchestrator stops reaching ${forge} through this connection. A repository still connected through it has to be removed first.`}
            confirm="Disconnect"
            keep="Keep connection"
            onConfirm={() => forgeApi.disconnect(kind).then((r) => changed(r.note ?? `${forge} is disconnected.`))}
          />
        </>
      )}
    </section>
  );
}

/** Asks the forge whether the connection still works and allows what the orchestrator needs; nothing on the forge changes. */
function ConnectionCheck({ kind }: { kind: Kind }) {
  const [check, setCheck] = useState<ForgeCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    setBusy(true);
    setError(null);
    forgeApi.check(kind).then((r) => {
      setBusy(false);
      setCheck(r.check);
    }, (e: Error) => {
      setBusy(false);
      setError(e.message);
    });
  };
  return (
    <>
      <button type="button" className="secondary small" disabled={busy} onClick={run}>Check connection</button>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {check?.ok ? <p role="status">Works as {check.account}{check.version ? `, on ${FORGES[kind].label} ${check.version}` : ""}.</p> : null}
      {check && !check.ok ? (
        <div role="alert">
          <p>{check.problem ?? `The connection does not allow everything the orchestrator needs on ${FORGES[kind].label}.`}</p>
          {check.missing.length ? <ul aria-label="What the connection lacks">{check.missing.map((m) => <li key={m}>{m}</li>)}</ul> : null}
        </div>
      ) : null}
    </>
  );
}

const teamsOf = (repos: RepoRecord[]) => [...new Set(repos.map((r) => r.team))].sort();

/** A team typed or picked; a new team starts with the repository connected for it. */
function TeamInput({ label, value, onChange, teams }: { label: string; value: string; onChange: (v: string) => void; teams: string[] }) {
  const list = useId();
  return (
    <label>
      {label}
      <input list={list} value={value} onChange={(e) => onChange(e.target.value)} required maxLength={60} />
      <datalist id={list}>{teams.map((t) => <option key={t} value={t} />)}</datalist>
    </label>
  );
}

function ForgeRepos({ kind, repos, onConnected }: { kind: Kind; repos: RepoRecord[]; onConnected: (said: string) => void }) {
  const forge = FORGES[kind].label;
  const [listed, setListed] = useState<ForgeRepo[] | null>(null);
  const [teams, setTeams] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const load = () => forgeApi.repos(kind).then((r) => setListed(r.repos), (e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, [kind]);
  const known = teamsOf(repos);
  const run = (work: Promise<unknown>, said: string) => {
    setError(null);
    work.then(() => {
      load();
      onConnected(said);
    }, (e: Error) => setError(e.message));
  };
  if (!listed) return error ? <LoadFailed what={`${forge} repositories`} reason={error} onRetry={() => { setError(null); load(); }} /> : <Loading what={`${forge} repositories`} />;
  return (
    <>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {!listed.length ? <p className="muted">{forge} lists no repository for this connection yet.</p> : (
        <ul className="forge-repos" aria-label={`${forge} repositories`}>
          {listed.map((r) => {
            const team = teams[r.fullName] ?? "";
            return (
              <li key={r.fullName}>
                <span className="mono">{r.fullName}</span>
                {r.connected ? <span className="badge ok">Connected</span> : (
                  <span className="actions">
                    <TeamInput label={`Team for ${r.fullName}`} value={team} onChange={(v) => setTeams({ ...teams, [r.fullName]: v })} teams={known} />
                    <button type="button" className="secondary small" disabled={!team.trim()} onClick={() => run(forgeApi.connectRepo(kind, { fullName: r.fullName, team: team.trim() }), `${r.fullName} is connected for ${team.trim()}.`)}>Connect {r.fullName}</button>
                    {r.empty ? (
                      <button type="button" className="secondary small" disabled={!team.trim()} onClick={() => run(forgeApi.teamRepo(kind, { existing: r.fullName, team: team.trim() }), `${r.fullName} is the team repository of ${team.trim()}.`)}>Use {r.fullName} as the team repository</button>
                    ) : null}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function TeamRepository({ kind, repos, onMade }: { kind: Kind; repos: RepoRecord[]; onMade: (said: string) => void }) {
  const forge = FORGES[kind].label;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", team: "", visibility: "private", namespace: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<ForgeStep[] | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSteps(null);
    setBusy(true);
    const input = { name: form.name.trim(), team: form.team.trim(), visibility: form.visibility, ...(CARD[kind].namespace && form.namespace.trim() ? { namespace: form.namespace.trim() } : {}) };
    forgeApi.teamRepo(kind, input).then(
      (r) => {
        setBusy(false);
        const name = r.repo.url.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
        setMade(`Created ${name}.${r.webhook === "installed" ? "" : ` The webhook is ${r.webhook}.`}`);
        setOpen(false);
        onMade(`The team repository for ${input.team} is on ${forge}.`);
      },
      (err: Error) => {
        setBusy(false);
        // A refusal the person gets past on the forge itself, such as a personal GitHub account, comes as steps to take there.
        const given = err instanceof ApiError && Array.isArray(err.body.steps) ? (err.body.steps as ForgeStep[]) : null;
        if (given?.length) setSteps(given);
        else setError(err.message);
      },
    );
  };
  return (
    <>
      {made ? <p role="status">{made}</p> : null}
      {steps ? (
        <div role="alert">
          <p>{forge} does not let the orchestrator create this repository. Make it there, then come back:</p>
          <ol aria-label="Steps to make the team repository">
            {steps.map((s) => <li key={s.text}>{s.url ? <a href={s.url} target="_blank" rel="noopener">{s.text}</a> : s.text}</li>)}
          </ol>
        </div>
      ) : null}
      {!open ? <button type="button" className="secondary" onClick={() => setOpen(true)}>Create team repository</button> : (
        <form className="form" onSubmit={submit} aria-label="Create team repository">
          <p className="muted">The orchestrator creates this repository on {forge} and writes its first commit straight to it, because the repository is new and you asked for it. Every later change opens as a request.</p>
          <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={100} /></label>
          <TeamInput label="Team" value={form.team} onChange={(v) => setForm({ ...form, team: v })} teams={teamsOf(repos)} />
          <label>
            Visibility
            <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
              {CARD[kind].visibilities.map((v) => <option key={v} value={v}>{v[0]!.toUpperCase() + v.slice(1)}</option>)}
            </select>
          </label>
          {CARD[kind].namespace ? <label>Group (optional)<input value={form.namespace} onChange={(e) => setForm({ ...form, namespace: e.target.value })} maxLength={200} /></label> : null}
          {error ? <p className="error" role="alert">{error}</p> : null}
          <div className="actions">
            <button type="submit" disabled={busy}>Create repository</button>
            <button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </>
  );
}

/** An organization's own GitLab application, for a GitLab the operator did not set one up for. */
/** `beside` is set when Connect is the card's first action, so the application's Save is a second one. */
function OwnGitLabApp({ onSaved, beside = false }: { onSaved: () => void; beside?: boolean }) {
  const [read, setRead] = useState<{ app: OrgGitLabApp | null; redirectUri: string | null; operator: boolean } | null>(null);
  const [form, setForm] = useState({ url: "", clientId: "", clientSecret: "" });
  const [error, setError] = useState<string | null>(null);
  const load = () => forgeApi.gitlabApp().then(setRead, (e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  if (!read || read.operator) return error ? <p className="error" role="alert">{error}</p> : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    forgeApi.saveGitlabApp(form).then(() => {
      setForm({ url: "", clientId: "", clientSecret: "" });
      load();
      onSaved();
    }, (err: Error) => setError(err.message));
  };
  return (
    <form className="form" onSubmit={submit} aria-label="Your GitLab application">
      <p>Use your own GitLab application to connect a GitLab of your own once for the organization. Create it in GitLab with the api scope and this redirect address.</p>
      {read.redirectUri ? <p>Redirect URI: <span className="mono">{read.redirectUri}</span></p> : null}
      {read.app ? <p>The application at {read.app.webUrl} was entered by {read.app.by} on {day(read.app.at)}.</p> : null}
      <label>GitLab address<input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://gitlab.example.com" required /></label>
      <label>Application ID<input value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} required autoComplete="off" /></label>
      <label>Secret<input type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} required autoComplete="off" /></label>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="actions">
        <button type="submit" className={beside ? "secondary" : undefined}>Save application</button>
        {read.app ? (
          <ConfirmAction
            trigger="Remove application"
            consequence="GitLab can no longer be connected through this application until one is entered again."
            confirm="Remove"
            keep="Keep application"
            onConfirm={() => forgeApi.removeGitlabApp().then(() => {
              load();
              onSaved();
            })}
          />
        ) : null}
      </div>
    </form>
  );
}

/**
 * A forge's card on Integrations on one person's machine, with one main action as every service has:
 * it signs their own gh or glab in through the browser and follows it to the end, the token staying
 * with the CLI. Tokens for single repositories wait under "Other ways to connect".
 */
export function ForgeConnectCard({ card, repos, other, onChanged }: { card: ForgeCardData; repos: RepoRecord[]; other: ReactNode; onChanged: () => void }) {
  const kind = card.id;
  const forge = FORGE_LABEL[kind];
  const [read, setRead] = useState<ForgeSignIn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => forgeApi.signInState(kind).then(setRead, (e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, [kind]);
  const waiting = read?.signIn.state === "waiting";
  // While the person approves in the browser the card asks every two seconds, and stops once the CLI ends.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      forgeApi.signInState(kind).then((r) => {
        setRead(r);
        if (r.signIn.state === "done") onChanged();
      }, () => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting, kind]);
  const signIn = () => {
    setBusy(true);
    setError(null);
    forgeApi.signIn(kind).then(setRead, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  if (!read) return <Connect id={kind} name={forge} level={3} connected={card.state === "connected"} about={error ? "" : `Loading ${forge}.`} action={null} other={other} error={error} />;
  // Where the person's own CLI is not offered, the card's one action is the organization's connection.
  if (!read.offered || !read.cli) {
    const connectOrg = () => {
      setBusy(true);
      setError(null);
      forgeApi.connect(kind).then((r) => window.location.assign(r.authorizeUrl), (e: Error) => {
        setError(e.message);
        setBusy(false);
      });
    };
    const c = card.connection;
    const about = c
      ? `Connected as ${c.account}.`
      : !read.org
        ? sentence(read.why ?? `An owner or an admin connects ${forge}`)
        : read.org.available
          ? `Connect ${forge} once for the organization: the orchestrator reads the repositories you pick and opens their requests there.`
          : read.why
            ? sentence(`${read.why}; connect with a token under Other ways to connect`)
            : (
              <>
                {read.org.missing[0]} <Hint label={`connecting ${forge} with one click`}>Its operator sets ORCHESTRATOR_FORGE_{kind.toUpperCase()}_*, ORCHESTRATOR_PUBLIC_URL and ORCHESTRATOR_SECRET_KEY, as the operator's guide to forge applications describes.</Hint>
              </>
            );
    const action = c || !read.org?.available ? null : <button type="button" className="secondary" disabled={busy} onClick={connectOrg}>Connect with {forge}</button>;
    return <Connect id={kind} name={forge} level={3} connected={Boolean(c) || card.state === "connected"} about={about} action={action} other={other} error={error} />;
  }
  const cli = read.cli;
  const flow = read.signIn;
  const failed = flow.state === "failed" ? flow.error : null;
  const about = cli.signedIn
    ? `Connected as ${cli.account ?? "you"} on ${cli.host}.`
    : cli.installed
      ? `Sign in with your own ${cli.tool} through the browser; its sign-in stays with ${cli.tool}, and requests open on ${forge} as you.`
      : `${cli.name} is not on this machine. Install it, then check again.`;
  const status = flow.state === "waiting" ? (
    <p>
      {flow.code ? <>Enter <span className="mono">{flow.code}</span> on {forge}{flow.url ? <>: <a href={flow.url} target="_blank" rel="noopener">Open {forge}</a></> : null}. </> : flow.url ? <><a href={flow.url} target="_blank" rel="noopener">Open {forge}</a> to sign in. </> : null}
      {flow.note ? <>{flow.note}. </> : null}Waiting for {forge}.
    </p>
  ) : null;
  const action = cli.signedIn ? null : !cli.installed ? (
    <>
      {read.installLine ? <span className="mono">{read.installLine}</span> : <a href={cli.install} target="_blank" rel="noopener">Install {cli.tool}</a>}
      <button type="button" className="secondary" onClick={() => load()}>Check again</button>
    </>
  ) : (
    <button type="button" className="secondary" disabled={busy || flow.state === "waiting"} onClick={signIn}>Sign in with {forge}</button>
  );
  return <Connect id={kind} name={forge} level={3} connected={cli.signedIn} about={about} status={status} action={action} other={other} error={error ?? failed} />;
}
