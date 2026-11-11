import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { organizationApi } from "../api";
import type { OrganizationView, Principal } from "../api";
import { LoadFailed, Loading } from "../Status";
import { Hint } from "../Hint";

export function OrganizationSettings({ me }: { me: Principal }) {
  const [view, setView] = useState<OrganizationView | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = () => organizationApi.read().then((v) => {
    setView(v);
    setName(v.name);
  }, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  if (!view) return error ? <LoadFailed what="the organization" reason={error} panel onRetry={() => { setError(null); void load(); }} /> : <Loading what="the organization" panel />;
  const save = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    organizationApi.rename(name).then((v) => {
      setView(v);
      setName(v.name);
      setNotice(`The organization is now named ${v.name}.`);
    }, (err: Error) => setError(err.message));
  };
  return (
    <>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      <section className="panel" aria-labelledby="org-h">
        <h2 id="org-h">Organization</h2>
        {me.role === "owner" ? (
          <form className="form inline-form" onSubmit={save} aria-label="Organization name">
            <label>Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></label>
            <button type="submit" className="secondary">Rename</button>
          </form>
        ) : (
          <p>{view.name}</p>
        )}
        <p className="muted">Its address stays /{view.tenant}. <Hint label="the organization's address">Organizations are added and removed in the orchestrator's configuration file, by whoever runs the orchestrator.</Hint></p>
      </section>
    </>
  );
}
