import { useEffect, useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { account, ApiError, identityApi } from "../api";
import type { DeletionSummary, IdentityConfig, IdentityView, Org, Principal, SignInProvider } from "../api";
import { ConfirmAction } from "../Confirm";
import { Select } from "../Select";
import { Hint } from "../Hint";
import { LoadFailed, Loading } from "../Status";
import { PageHead } from "../design/PageHead";
import { SettingsSection } from "./SettingsSection";
import { problemSentence } from "../Signup";
import { ROLE_LABEL } from "./Members";

/** Where a person goes once their account is deleted: no session is left to show anything else. */
export const ACCOUNT_DELETED = "#/account-deleted";

/** The organizations this browser is signed in to; an orchestrator with one answers with none, and then it is the one on screen. */
function useOrgs(me: Principal): { orgs: Org[]; defaultOrg: string } | null {
  const [found, setFound] = useState<{ orgs: Org[]; defaultOrg: string } | null>(null);
  useEffect(() => {
    account.orgs().then(
      (list) => setFound({ orgs: list.orgs.length ? list.orgs : [{ tenant: list.default, name: "this organization", role: me.role }], defaultOrg: list.default }),
      () => setFound({ orgs: [{ tenant: "", name: "this organization", role: me.role }], defaultOrg: "" }),
    );
  }, [me.id]);
  return found;
}

function Name({ me, orgs, defaultOrg, onRenamed }: { me: Principal; orgs: Org[]; defaultOrg: string; onRenamed: () => void }) {
  const [name, setName] = useState(me.name);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const errorId = useId();
  const save = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    Promise.all(orgs.map((o) => account.rename(o.tenant, defaultOrg, name))).then(
      () => {
        setNotice(orgs.length > 1 ? `Your name is ${name.trim()} in each of your ${orgs.length} organizations.` : `Your name is ${name.trim()}.`);
        onRenamed();
      },
      (err: Error) => setError(err.message),
    );
  };
  return (
    <SettingsSection name="Name" why="How every organization you belong to shows you.">
      <form className="form inline-form" onSubmit={save} aria-label="Your name">
        <label>Name<input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} aria-describedby={error ? errorId : undefined} /></label>
        <button type="submit" className="secondary">Save name</button>
      </form>
      {error ? <p className="error" role="alert" id={errorId}>{error}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
    </SettingsSection>
  );
}

/** The summary first, the address typed back, then every organization's account deleted. */
function Delete({ me, orgs, defaultOrg }: { me: Principal; orgs: Org[]; defaultOrg: string }) {
  const [summaries, setSummaries] = useState<{ org: Org; summary: DeletionSummary }[] | null>(null);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const review = () => {
    setError(null);
    Promise.all(orgs.map(async (org) => ({ org, summary: await account.summary(org.tenant, defaultOrg) }))).then(setSummaries, (err: Error) => setError(`Couldn't read what deleting your account removes. ${err.message}`));
  };
  const blocked = summaries?.filter((s) => s.summary.blocked) ?? [];
  const remove = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // One organization after another, the one on screen last: a refusal part-way leaves the
    // rest signed in, and the page still answers to say so.
    const order = [...orgs].sort((a, b) => Number(a.tenant === defaultOrg) - Number(b.tenant === defaultOrg));
    order.reduce((done, org) => done.then(() => account.remove(org.tenant, defaultOrg, confirm)), Promise.resolve() as Promise<unknown>).then(
      () => window.location.replace(`/${ACCOUNT_DELETED}`),
      (err: Error) => {
        setError(err.message);
        setBusy(false);
      },
    );
  };
  return (
    <SettingsSection name="Delete your account" why="Ends your access everywhere at once; this cannot be undone." danger>
      {!summaries ? (
        <>
          <p>Your account is removed from {orgs.length > 1 ? `each of the ${orgs.length} organizations you are signed in to` : "this organization"}, with its sessions and API keys. <Hint label="deleting your account">The requests and tasks you started stay with their teams.</Hint></p>
          <button type="button" className="secondary" onClick={review}>Review what is deleted…</button>
        </>
      ) : (
        <>
          <ul className="plain">
            {summaries.map(({ org, summary }) => (
              <li key={org.tenant || "this"}>
                <strong>{org.name}</strong>: {ROLE_LABEL[summary.role]}
                {summary.ownedTeams.length ? `, owns ${summary.ownedTeams.join(", ")}` : ""}; {summary.activeKeys} active API key{summary.activeKeys === 1 ? "" : "s"} revoked; {summary.openRequests} open request{summary.openRequests === 1 ? "" : "s"} stay for review
                {summary.unfinishedTasks.length ? `; ${summary.unfinishedTasks.length} task${summary.unfinishedTasks.length === 1 ? "" : "s"} still running (${summary.unfinishedTasks.map((t) => t.title).join(", ")}) finish and open a request for review` : ""}
                {summary.blocked ? <div className="error">{summary.blocked}</div> : null}
              </li>
            ))}
          </ul>
          {blocked.length ? (
            <p className="error">Your account cannot be deleted while you are the only owner of {blocked.map((b) => b.org.name).join(", ")}.</p>
          ) : (
            <form className="form" onSubmit={remove} aria-label="Delete your account">
              <label>Type {me.email} to confirm<input autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} required aria-describedby={error ? errorId : undefined} /></label>
              <div className="actions">
                <button type="submit" disabled={busy || confirm.trim().toLowerCase() !== me.email}>Delete my account</button>
                <button type="button" className="secondary" onClick={() => setSummaries(null)}>Keep my account</button>
              </div>
            </form>
          )}
        </>
      )}
      {error ? <p className="error" role="alert" id={errorId}>{error}</p> : null}
    </SettingsSection>
  );
}

const PROVIDER_NAME: Record<SignInProvider, string> = { google: "Google", github: "GitHub", microsoft: "Microsoft" };

/**
 * On a cloud orchestrator, the providers this person signs in with: another one of their own is
 * added through that provider, and any but the last is removed. Either takes a sign-in from the
 * last ten minutes, so a browser someone left open does not add a way in.
 */
function SignInWays() {
  const [view, setView] = useState<IdentityView | null>(null);
  const [config, setConfig] = useState<IdentityConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [dropping, setDropping] = useState<SignInProvider | null>(null);
  const query = new URLSearchParams(window.location.search);
  const linked = query.get("linked") as SignInProvider | null;
  const problem = query.get("link-problem");
  const confirming = query.get("link-confirm");
  const [waiting, setWaiting] = useState<{ provider: SignInProvider; email: string } | null>(null);
  const [added, setAdded] = useState<SignInProvider | null>(null);
  const load = () => identityApi.me().then(setView, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    if (confirming) identityApi.awaitingLogin(confirming).then(setWaiting, (e: Error) => setError(e.message));
    identityApi.config().then((c) => setConfig(c && "providers" in c ? c : null), () => setConfig(null));
  }, []);
  const refused = (e: Error) => {
    if (e instanceof ApiError && e.code === "reauth") setStale(true);
    else setError(e.message);
  };
  const confirm = () => {
    setError(null);
    identityApi.confirmLogin(confirming!, view!.csrf).then(({ provider }) => {
      setWaiting(null);
      setAdded(provider);
      window.history.replaceState(null, "", window.location.pathname);
      return load();
    }, refused);
  };
  const add = (provider: SignInProvider) => {
    setError(null);
    identityApi.addLogin(provider, view!.csrf).then(({ url }) => window.location.assign(url), refused);
  };
  if (!view) return error ? <SettingsSection name="How you sign in"><LoadFailed what="how you sign in" reason={error} onRetry={() => { setError(null); void load(); }} /></SettingsSection> : null;
  const have = new Set(view.logins.map((l) => l.provider));
  const more = (config?.providers ?? []).filter((p) => !have.has(p));
  return (
    <SettingsSection name="How you sign in" why="Only an account under your own address is added, and never one someone else signs in with.">
      {(added ?? linked) && PROVIDER_NAME[(added ?? linked)!] ? <p className="notice" role="status">You can now sign in with {PROVIDER_NAME[(added ?? linked)!]} too.</p> : null}
      {waiting ? (
        <div className="panel problem" role="alert">
          <p>Add the {PROVIDER_NAME[waiting.provider]} account <strong>{waiting.email}</strong> only if it is yours: whoever holds it reaches all of your organizations. <Hint label="this account">Its address is not {view.identity.email}, the one you sign in with.</Hint></p>
          <div className="actions">
            <button type="button" onClick={confirm}>Add {waiting.email}</button>
            <button type="button" className="secondary" onClick={() => { setWaiting(null); window.history.replaceState(null, "", window.location.pathname); }}>Do not add it</button>
          </div>
        </div>
      ) : null}
      {problem ? <p className="error" role="alert">{problemSentence(problem)}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {stale ? <p className="error" role="alert">Changing how you sign in takes a recent sign-in. <a href={`/api/auth/${view.identity.signedInWith}/start`}>Sign in with {PROVIDER_NAME[view.identity.signedInWith]} again</a>, then come back here.</p> : null}
      <table>
        <thead><tr><th>Provider</th><th>Address</th></tr></thead>
        <tbody>
          {view.logins.map((l) => (
            <tr key={l.provider}>
              <td>{PROVIDER_NAME[l.provider]}{l.provider === view.identity.signedInWith ? <span className="muted"> (this sign-in)</span> : null}</td>
              <td>{l.email}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        {more.map((p) => <button key={p} type="button" className="secondary" onClick={() => add(p)}>Add {PROVIDER_NAME[p]}</button>)}
        {/* The last way in is never removed, so a removal is offered only while there are two. */}
        {view.logins.length > 1 ? (
          <>
            <Select label="Stop signing in with" value={dropping ?? view.logins[0]!.provider} onChange={(v) => setDropping(v as SignInProvider)} options={view.logins.map((l) => ({ value: l.provider, label: PROVIDER_NAME[l.provider] }))} />
            <ConfirmAction
              trigger={`Remove ${PROVIDER_NAME[dropping ?? view.logins[0]!.provider]}…`}
              triggerLabel={`Remove ${PROVIDER_NAME[dropping ?? view.logins[0]!.provider]} as a way to sign in`}
              consequence={`You no longer sign in with ${PROVIDER_NAME[dropping ?? view.logins[0]!.provider]}.`}
              confirm="Remove"
              keep="Keep it"
              onConfirm={() => identityApi.removeLogin(dropping ?? view.logins[0]!.provider, view.csrf).then(() => {
                setDropping(null);
                return load();
              }, refused)}
            />
          </>
        ) : null}
      </div>
    </SettingsSection>
  );
}

/** Where the person stands, said once at the top: who they are signed in as, and where. */
function accountSummary(me: Principal, orgs: number): string {
  // One person's own orchestrator has nobody signing in to it, so no address or role is said.
  if (me.mode === "local") return "This orchestrator is yours; nobody signs in to it.";
  const role = ROLE_LABEL[me.role].toLowerCase();
  return `Signed in as ${me.email}, ${/^[aeiou]/.test(role) ? "an" : "a"} ${role} here${orgs > 1 ? ` and in ${orgs - 1} other organization${orgs === 2 ? "" : "s"}` : ""}.`;
}

export function AccountSettings({ me, nav, onChanged }: { me: Principal; nav: ReactNode; onChanged: () => void }) {
  const found = useOrgs(me);
  return (
    <>
      <PageHead title="Your account" summary={found ? accountSummary(me, found.orgs.length) : undefined} />
      {nav}
      {!found ? <Loading what="your account" /> : (
        <>
          <Name me={me} orgs={found.orgs} defaultOrg={found.defaultOrg} onRenamed={onChanged} />
          {me.mode === "cloud" ? <SignInWays /> : null}
          {me.mode === "local" ? (
            <SettingsSection name="Your data" why="It runs on this machine for you alone.">
              <p>Stopping the orchestrator and deleting its data directory removes all it keeps; your folders, repositories and their branches stay where they are.</p>
            </SettingsSection>
          ) : <Delete me={me} orgs={found.orgs} defaultOrg={found.defaultOrg} />}
        </>
      )}
    </>
  );
}

/** The page after deletion, shown without a session. */
export function AccountDeleted() {
  return (
    <main className="gate">
      <div className="panel form" role="status">
        <div className="brand">TeamHandbook <span>Orchestrator</span></div>
        <h1>Your account is deleted</h1>
        <p>You are signed out of every organization it belonged to, and its API keys no longer work. An owner or admin invites you again if you need to come back.</p>
        <a className="button secondary" href="/">Go to sign-in</a>
      </div>
    </main>
  );
}
