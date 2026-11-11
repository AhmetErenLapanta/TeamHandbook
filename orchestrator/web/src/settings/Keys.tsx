import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { KEY_MOST, keysApi, RESOURCES } from "../api";
import { ConfirmAction, CopyText } from "../Confirm";
import type { Access, KeyView, Principal, Resource, Scopes } from "../api";
import { Hint } from "../Hint";
import { Select } from "../Select";
import { LoadFailed, Loading } from "../Status";

const RESOURCE_LABEL: Record<Resource, string> = {
  repositories: "Repositories",
  requests: "Requests",
  tasks: "Tasks",
  usage: "Usage",
  members: "Members",
  settings: "Settings",
  keys: "This account's API keys",
};

const EXPIRY = [
  { label: "Never", days: null },
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "365 days", days: 365 },
] as const;

function day(at: string | null): string {
  return at ? new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "never";
}

function access(scopes: Scopes): string {
  const given = RESOURCES.filter((r) => scopes[r] !== "none");
  return given.map((r) => `${RESOURCE_LABEL[r]}: ${scopes[r]}`).join(", ");
}

/** A key's secret, shown once right after it is made. */
function NewSecret({ secret, onDone }: { secret: string; onDone: () => void }) {
  return (
    <section className="notice" aria-label="New API key">
      <p>Copy this key now; it is shown once. <Hint label="the key">The orchestrator keeps only its prefix and a hash.</Hint></p>
      <CopyText text={secret} label="Copy key" />
      <div className="actions"><button type="button" className="secondary small" onClick={onDone}>I copied it</button></div>
    </section>
  );
}

export function KeyForm({ serviceAccountId, ceiling = KEY_MOST, onCreated }: { serviceAccountId?: string; ceiling?: Scopes; onCreated: (secret: string) => void }) {
  const [name, setName] = useState("");
  const [days, setDays] = useState<number | null>(30);
  const [scopes, setScopes] = useState<Partial<Scopes>>({ repositories: "read", requests: "read" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    keysApi.create({ name, scopes, expiresInDays: days, ...(serviceAccountId ? { serviceAccountId } : {}) }).then(
      (r) => {
        setName("");
        setBusy(false);
        onCreated(r.secret);
      },
      (err: Error) => {
        setError(err.message);
        setBusy(false);
      },
    );
  };
  return (
    <form className="form" onSubmit={submit} aria-label={serviceAccountId ? "New key for this service account" : "New API key"}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} aria-describedby={error ? errorId : undefined} /></label>
      <Select label="Expires" value={days === null ? "never" : String(days)} onChange={(v) => setDays(v === "never" ? null : Number(v))} options={EXPIRY.map((x) => ({ value: x.days === null ? "never" : String(x.days), label: x.label }))} />
      <fieldset className="plain-fieldset scope-grid">
        <legend>Access</legend>
        <p className="muted small">What the key reads or changes, never more than you can.</p>
        {RESOURCES.filter((r) => ceiling[r] !== "none").map((r) => (
          <Select key={r} label={RESOURCE_LABEL[r]} value={scopes[r] ?? "none"} onChange={(v) => setScopes({ ...scopes, [r]: v as Access })} options={(["none", "read", "write"] as Access[]).filter((a) => a !== "write" || ceiling[r] === "write").map((a) => ({ value: a, label: a === "none" ? "None" : a === "read" ? "Read" : "Write" }))} />
        ))}
      </fieldset>
      <p className="muted">A key never manages members, settings or sign-in, nor merges a request. <Hint label="what a key never does">Those take a person signed in here, so no automation approves what it opened itself.</Hint></p>
      {error ? <p className="error" role="alert" id={errorId}>{error}</p> : null}
      <div className="actions"><button type="submit" disabled={busy}>Create key</button></div>
    </form>
  );
}

export function KeyTable({ keys, label, onChanged }: { keys: KeyView[]; label: string; onChanged: () => void }) {
  if (!keys.length) return <p className="muted">No key yet.</p>;
  return (
    <>
      <table aria-label={label}>
        <thead><tr><th>Key</th><th>Access</th><th>Expires</th><th>Last used</th><th><span className="visually-hidden">Revoke</span></th></tr></thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td>{k.name}<div className="mono muted">{k.prefix}_…</div></td>
              <td>{access(k.scopes)}</td>
              <td>{k.status === "active" ? day(k.expiresAt) : <span className="badge warn">{k.status}</span>}</td>
              <td>{k.lastUsedAt ? day(k.lastUsedAt) : "not yet"}</td>
              <td>
                {k.status === "active" ? (
                  <ConfirmAction
                    small
                    trigger="Revoke"
                    triggerLabel={`Revoke ${k.name}`}
                    consequence="This cannot be undone. Anything using this key is turned away at once, and so is every key it minted."
                    confirm="Revoke key"
                    keep="Keep key"
                    onConfirm={() => keysApi.revoke(k.id).then(onChanged)}
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** Keys of one account, with the form for a new one and the secret of the one just made. */
export function AccountKeys({ serviceAccountId, label, ceiling }: { serviceAccountId?: string; label: string; ceiling?: Scopes }) {
  const [keys, setKeys] = useState<KeyView[] | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => keysApi.list(serviceAccountId).then(setKeys, (e: Error) => setError(e.message));
  useEffect(() => {
    void reload();
  }, [serviceAccountId]);
  return (
    <>
      {keys && error ? <p className="error" role="alert">{error}</p> : null}
      {secret ? <NewSecret secret={secret} onDone={() => setSecret(null)} /> : null}
      {keys ? <KeyTable keys={keys} label={label} onChanged={reload} /> : error ? <LoadFailed what="keys" reason={error} onRetry={() => { setError(null); void reload(); }} /> : <Loading what="keys" />}
      <KeyForm serviceAccountId={serviceAccountId} ceiling={ceiling} onCreated={(s) => {
        setSecret(s);
        void reload();
      }} />
    </>
  );
}

export function ApiKeysSettings({ me }: { me: Principal }) {
  return (
    <section className="panel" aria-labelledby="keys-h">
      <h2 id="keys-h">Your API keys</h2>
      <p className="muted">A key acts as you, never further than your role. <Hint label="using a key">Send it as <code>Authorization: Bearer th_sk_…</code>; it reaches only the resources you give it.</Hint></p>
      <AccountKeys label="Your API keys" ceiling={me.keyCeiling} />
    </section>
  );
}
