import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { keysApi, manages, people } from "../api";
import { ConfirmAction } from "../Confirm";
import { Hint } from "../Hint";
import type { Principal, ServiceAccountView, TeamView } from "../api";
import { AccountKeys } from "./Keys";
import { TeamPicker } from "./Members";

function day(at: string | null): string {
  return at ? new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "not yet";
}

function NewServiceAccount({ teams, onCreated }: { teams: TeamView[]; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [owned, setOwned] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    keysApi.createServiceAccount({ name, teams: owned }).then(() => {
      setName("");
      setOwned([]);
      onCreated();
    }, (err: Error) => setError(err.message));
  };
  return (
    <form className="form" onSubmit={submit} aria-labelledby="new-sa-h">
      <h2 id="new-sa-h">Add service account</h2>
      <p className="muted">For CI and automations; it acts on the teams you pick. <Hint label="service accounts">It is a member that owns those teams, so its keys open requests and start tasks there; it never merges.</Hint></p>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></label>
      <div>
        <span>Owns</span>
        <TeamPicker teams={teams} value={owned} onChange={setOwned} label="Teams the service account owns" />
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="actions"><button type="submit">Add service account</button></div>
    </form>
  );
}

function ServiceAccountPanel({ account, teams, onChanged }: { account: ServiceAccountView; teams: TeamView[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="panel" aria-labelledby={`sa-${account.id}`}>
      <h2 id={`sa-${account.id}`}>{account.name}</h2>
      <dl className="facts">
        <div><dt>Active keys</dt><dd>{account.activeKeys}</dd></div>
        <div><dt>Last used</dt><dd>{day(account.lastUsedAt)}</dd></div>
        <div><dt>Added by</dt><dd>{account.createdBy}</dd></div>
      </dl>
      <TeamPicker teams={teams} value={account.ownedTeams} onChange={(t) => keysApi.updateServiceAccount(account.id, { teams: t }).then(onChanged, (e: Error) => setError(e.message))} label={`Teams ${account.name} owns`} />
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="actions">
        <button type="button" className="secondary small" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide keys" : "Show keys"}</button>
        <ConfirmAction
          small
          trigger="Remove"
          triggerLabel={`Remove ${account.name}`}
          consequence={`This cannot be undone. Every key of ${account.name} stops working at once, and the teams it owns lose it as an owner.`}
          confirm="Remove service account"
          keep="Keep service account"
          onConfirm={() => keysApi.removeServiceAccount(account.id).then(onChanged)}
        />
      </div>
      {open ? <AccountKeys serviceAccountId={account.id} label={`Keys of ${account.name}`} /> : null}
    </section>
  );
}

export function ServiceAccountsSettings({ me }: { me: Principal }) {
  const [accounts, setAccounts] = useState<ServiceAccountView[] | null>(null);
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const managing = manages(me);
  const reload = () => {
    if (!managing) return;
    keysApi.serviceAccounts().then(setAccounts, (e: Error) => setError(e.message));
    people.teams().then(setTeams, () => setTeams([]));
  };
  useEffect(reload, [managing]);
  if (!managing) return <section className="panel"><p>Only owners and admins manage service accounts.</p></section>;
  return (
    <>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {accounts && !accounts.length ? <section className="panel"><p className="muted">No service account yet.</p></section> : null}
      {(accounts ?? []).map((a) => <ServiceAccountPanel key={a.id} account={a} teams={teams} onChanged={reload} />)}
      <section className="panel"><NewServiceAccount teams={teams} onCreated={reload} /></section>
    </>
  );
}
