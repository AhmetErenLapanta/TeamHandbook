import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import type { RepoRecord } from "./api";
import { ConnectRepo } from "./ConnectRepo";
import { FORGES } from "../../shared/forge-def";
import { Select } from "./Select";
import { Loading, LoadFailed } from "./Status";
import { APP_FORGES, connectedForge, FORGE_LABEL, forgeApi } from "./forge-connection";
import type { AppForge, ForgeConnections, ForgeRepo, GitLabAppState, Visibility } from "./forge-connection";
import { Hint } from "./Hint";

/** The forge's own refusal names its steps for a personal GitHub account; the screen numbers them. */
const PERSONAL_ACCOUNT = /a personal account/;

/**
 * A self-managed GitLab the operator registered no application for: the organization registers
 * its own there and an owner enters it here, since the orchestrator sends the org's sign-ins to it.
 */
function OwnGitLab({ owner, onSaved }: { owner: boolean; onSaved: () => void }) {
  const id = useId();
  const [state, setState] = useState<GitLabAppState | null>(null);
  const [url, setUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    forgeApi.gitlabApp().then(setState, () => setState(null));
  }, []);
  if (!state || state.operator) return null;
  if (state.app) return <p className="muted">GitLab signs in through your organization's own application at {new URL(state.app.webUrl).host}, entered by {state.app.by}.</p>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    forgeApi.setGitlabApp({ url: url.trim(), clientId: clientId.trim(), clientSecret: secret }).then(
      () => {
        setSecret("");
        setBusy(false);
        forgeApi.gitlabApp().then(setState, () => setState(null));
        onSaved();
      },
      (err: Error) => {
        setError(err.message);
        setBusy(false);
      },
    );
  };
  return (
    <details className="welcome-own-gitlab">
      <summary>Use your own GitLab</summary>
      <p>On your GitLab, add an application with the api scope and this redirect URI:</p>
      {state.redirectUri ? <p><code>{state.redirectUri}</code></p> : <p className="error">This orchestrator has no public address set, so GitLab has nowhere to send you back. Ask whoever runs it to set ORCHESTRATOR_PUBLIC_URL, then open this step again.</p>}
      {owner ? (
        <form className="form" onSubmit={submit} aria-labelledby={`${id}-h`}>
          <h3 id={`${id}-h`}>Your GitLab application</h3>
          <label>GitLab address<input value={url} onChange={(e) => setUrl(e.target.value)} required autoComplete="off" spellCheck={false} placeholder="https://gitlab.example.com" /></label>
          <label>Application ID<input value={clientId} onChange={(e) => setClientId(e.target.value)} required autoComplete="off" spellCheck={false} /></label>
          <label>Secret<input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} required autoComplete="off" /></label>
          <p className="muted">The secret is sealed and never shown again.</p>
          {error ? <p className="error" role="alert">{error}</p> : null}
          <div className="actions"><button type="submit" disabled={busy}>{busy ? "Saving…" : "Save the application"}</button></div>
        </form>
      ) : <p className="muted">Only an owner enters this application: every GitLab sign-in of the organization goes through it.</p>}
    </details>
  );
}

/**
 * Connect GitLab or GitHub: in one click where the operator set the forge's app up, and with a
 * token on a repository where nothing is set up, as a self-hosted orchestrator does.
 */
export function ForgeStep({ forges, repos, problem, owner, paths, onChanged }: { forges: ForgeConnections; repos: RepoRecord[]; problem: string | null; owner: boolean; paths: boolean; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<AppForge | null>(null);
  const offered = APP_FORGES.filter((k) => forges[k]?.available);
  const connect = (kind: AppForge) => {
    setBusy(kind);
    setError(null);
    forgeApi.connect(kind, "welcome").then(({ authorizeUrl }) => window.location.assign(authorizeUrl), (e: Error) => {
      setError(e.message);
      setBusy(null);
    });
  };
  return (
    <>
      {problem ? <p className="error" role="alert">GitLab or GitHub did not connect: {problem.replace(/[.\s]*$/, ".")}</p> : null}
      {APP_FORGES.map((k) => {
        const c = forges[k]?.connection;
        if (!c) return null;
        return (
          <p key={k}>
            {c.problem ? (
              <><span className="error">{FORGE_LABEL[k]} as {c.account} needs reconnecting: {c.problem}</span> <button type="button" className="secondary small" disabled={busy !== null} onClick={() => connect(k)}>Reconnect {FORGE_LABEL[k]}</button></>
            ) : <><span className="badge ok">connected</span> {FORGE_LABEL[k]} as {c.account}</>}
          </p>
        );
      })}
      {offered.length ? (
        <>
          <p>{offered.map((k) => FORGE_LABEL[k]).join(" or ")} asks you to approve TeamHandbook Orchestrator, then brings you back here.</p>
          <div className="actions">
            {offered.filter((k) => !forges[k]?.connection).map((k, n) => (
              <button key={k} type="button" className={n ? "secondary" : undefined} disabled={busy !== null} onClick={() => connect(k)}>{busy === k ? `Opening ${FORGE_LABEL[k]}…` : `Connect ${FORGE_LABEL[k]}`}</button>
            ))}
          </div>
        </>
      ) : connectedForge(forges) ? null : (
        <>
          <p>Connect your team's repository with a token instead. <Hint label="connecting with a token">This orchestrator has no one-click sign-in to GitLab or GitHub set up; connecting the repository connects its forge at the same time.</Hint></p>
          <ConnectRepo repos={repos} forge="gitlab" paths={paths} titled={false} onConnected={onChanged} />
        </>
      )}
      {forges.gitlab?.connection ? null : <OwnGitLab owner={owner} onSaved={onChanged} />}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </>
  );
}

function NewRepository({ kind, onMade }: { kind: AppForge; onMade: (message: string) => void }) {
  const id = useId();
  const [name, setName] = useState("");
  const [team, setTeam] = useState("");
  const group = FORGES[kind].group;
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [namespace, setNamespace] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    forgeApi.teamRepo(kind, { name: name.trim(), team: team.trim(), visibility, ...(group && namespace.trim() ? { namespace: namespace.trim() } : {}) }).then(
      ({ repo, webhook }) => {
        setBusy(false);
        onMade(`${repo.name} is set up on ${FORGE_LABEL[kind]} with the scaffold as its first commit.${webhook === "installed" ? "" : ` The webhook is ${webhook}; the orchestrator reads the repository on its own schedule instead.`}`);
      },
      (err: Error) => {
        setError(err.message);
        setBusy(false);
      },
    );
  };
  return (
    <form className="form" onSubmit={submit} aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>A new repository on {FORGE_LABEL[kind]}</h3>
      <p className="muted">The orchestrator creates this repository on {FORGE_LABEL[kind]} and writes its first commit straight to it. <Hint label="the first commit">It writes straight to it because the repository is new and you asked for it; every later change opens as a request.</Hint></p>
      <label>Repository name<input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" spellCheck={false} placeholder="payments-skills" /></label>
      <label>Team<input value={team} onChange={(e) => setTeam(e.target.value)} required autoComplete="off" placeholder="Payments" /></label>
      <Select label="Visibility" value={visibility} onChange={(v) => setVisibility(v as Visibility)} options={FORGES[kind].visibilities.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))} />
      {group ? (
        <>
          <label>{group.label}<input value={namespace} onChange={(e) => setNamespace(e.target.value)} autoComplete="off" spellCheck={false} placeholder={group.placeholder} aria-describedby={`${id}-group`} /></label>
          <p className="muted" id={`${id}-group`}>{group.meaning}</p>
        </>
      ) : null}
      {error && PERSONAL_ACCOUNT.test(error) ? (
        <div role="alert">
          <p>GitHub lets only a personal account's owner create its repositories. Set it up in three steps:</p>
          <ol>
            <li>On GitHub, create an empty repository named {name.trim() || "for the team's skills"}, without a README.</li>
            <li>Add it to the TeamHandbook Orchestrator app's installation on that account.</li>
            <li>Come back and pick it under Pick an existing repository; the orchestrator writes the scaffold as its first commit.</li>
          </ol>
        </div>
      ) : error ? <p className="error" role="alert">{error}</p> : null}
      <div className="actions"><button type="submit" disabled={busy}>{busy ? "Setting it up…" : "Create the repository"}</button></div>
    </form>
  );
}

function ExistingRepository({ kind, manageUrl, onMade, onCreate }: { kind: AppForge; manageUrl: string | null; onMade: (message: string) => void; onCreate: () => void }) {
  const id = useId();
  const [listed, setListed] = useState<ForgeRepo[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [team, setTeam] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = () => {
    setListed(null);
    setError(null);
    forgeApi.repos(kind).then((r) => setListed(r.filter((x) => !x.connected)), (e: Error) => setError(e.message));
  };
  useEffect(list, [kind]);
  const chosen = listed?.find((r) => r.fullName === picked) ?? null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setError(null);
    const done = chosen.empty
      ? forgeApi.teamRepo(kind, { existing: chosen.fullName, team: team.trim() }).then(({ repo }) => `${repo.name} had no commits, so the orchestrator wrote the scaffold as its first commit and connected it.`)
      : forgeApi.connectRepo(kind, { fullName: chosen.fullName, team: team.trim() }).then(({ repo }) => `${repo.name} is connected; every change to it opens as a request.`);
    done.then(
      (message) => {
        setListed((had) => had?.filter((r) => r.fullName !== chosen.fullName) ?? null);
        setPicked(null);
        setBusy(false);
        onMade(message);
      },
      (err: Error) => {
        setError(err.message);
        setBusy(false);
      },
    );
  };
  if (!listed) return error ? <LoadFailed what="your repositories" reason={error} onRetry={list} /> : <Loading what={`your repositories on ${FORGE_LABEL[kind]}`} />;
  if (!listed.length) {
    return (
      <div className="welcome-step-empty">
        <p>{FORGE_LABEL[kind]} lists no repository this connection reaches that is not connected already.</p>
        <p className="muted">{FORGES[kind].emptyListHint}</p>
        <div className="actions">
          {manageUrl ? <a className="button secondary" href={manageUrl} target="_blank" rel="noreferrer">Choose the repositories the GitHub app reaches</a> : null}
          <button type="button" className="secondary" onClick={list}>Read the list again</button>
          <button type="button" onClick={onCreate}>Create a new one</button>
        </div>
      </div>
    );
  }
  return (
    <form className="form" onSubmit={submit} aria-labelledby={`${id}-h`}>
      <fieldset className="plain-fieldset">
        <legend id={`${id}-h`}>Your repositories on {FORGE_LABEL[kind]}</legend>
        <ul className="plain welcome-repos">
          {listed.map((r) => (
            <li key={r.fullName}>
              <label className="check"><input type="radio" name={`${id}-repo`} checked={picked === r.fullName} onChange={() => setPicked(r.fullName)} required /> {r.fullName} {r.empty ? <span className="badge">empty</span> : null}</label>
            </li>
          ))}
        </ul>
      </fieldset>
      {chosen?.empty ? <p className="muted">This repository has no commits, so the orchestrator writes the scaffold straight to it as its first commit. <Hint label="the first commit">A repository with even one commit is only ever changed through requests.</Hint></p> : null}
      <label>Team<input value={team} onChange={(e) => setTeam(e.target.value)} required autoComplete="off" placeholder="Payments" /></label>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="actions"><button type="submit" disabled={busy || !chosen}>{chosen?.empty ? "Set it up" : "Connect it"}</button></div>
    </form>
  );
}

/** The team's skills repository: one the forge lists, or a new one the orchestrator sets up there. */
export function RepoStep({ forges, repos, paths, onChanged }: { forges: ForgeConnections; repos: RepoRecord[]; paths: boolean; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<string | null>(null);
  const kind = connectedForge(forges);
  const finished = (message: string) => {
    setMade(message);
    onChanged();
  };
  return (
    <>
      <fieldset className="plain-fieldset choice-row">
        <legend>Your team's skills repository</legend>
        <label className="check"><input type="radio" name="repo-choice" checked={!creating} onChange={() => setCreating(false)} /> Pick an existing repository</label>
        <label className="check"><input type="radio" name="repo-choice" checked={creating} onChange={() => setCreating(true)} /> Create a new one</label>
      </fieldset>
      {made ? <p role="status">{made}</p> : null}
      {kind ? (
        creating ? <NewRepository kind={kind} onMade={finished} /> : <ExistingRepository kind={kind} manageUrl={forges[kind]?.connection?.manageUrl ?? null} onMade={finished} onCreate={() => setCreating(true)} />
      ) : creating ? (
        <p className="muted">Connect GitLab or GitHub first. <Hint label="creating the repository">The orchestrator creates the repository through that connection and writes its first commit straight to it, because the repository is new and you asked for it; every later change opens as a request.</Hint></p>
      ) : (
        <ConnectRepo repos={repos} forge="gitlab" paths={paths} titled={false} onConnected={onChanged} />
      )}
    </>
  );
}
