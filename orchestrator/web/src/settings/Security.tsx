import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { directory, directoryJoin, manages, scim, ssoDomains } from "../api";
import type { DirectoryJoin, DirectoryView, Principal, ScimStatus, SsoDomain, TagPreview } from "../api";
import { Select } from "../Select";
import { ConfirmAction, CopyText } from "../Confirm";
import { LoadFailed, Loading } from "../Status";

/** A panel's one-sentence summary, with the rest behind More for whoever needs it. */
function About({ topic, lead, children }: { topic: string; lead: string; children: string }) {
  return (
    <div className="muted">
      <p>{lead}</p>
      <details>
        <summary>More<span className="visually-hidden"> about {topic}</span></summary>
        <p>{children}</p>
      </details>
    </div>
  );
}

/** What each group gives: its tag, or nothing when the field is empty. */
type Draft = Record<string, string>;

function mappingOf(draft: Draft): { group: string; tag: string }[] {
  return Object.entries(draft).filter(([, tag]) => tag.trim()).map(([group, tag]) => ({ group, tag: tag.trim().toLowerCase() }));
}

function DirectorySync({ me, view, onApplied }: { me: Principal; view: DirectoryView; onApplied: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => Object.fromEntries(view.groups.map((g) => [g.group, g.tag ?? ""])));
  const [preview, setPreview] = useState<TagPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const edit = (group: string, tag: string) => {
    setDraft({ ...draft, [group]: tag });
    setPreview(null);
  };
  const run = () => {
    setError(null);
    setNotice(null);
    directory.preview(mappingOf(draft)).then(setPreview, (e: Error) => setError(e.message));
  };
  const apply = () => {
    if (!preview) return;
    directory.apply(mappingOf(draft), preview.fingerprint).then(
      () => {
        setPreview(null);
        setNotice("Applied. Members of each group have its tag, and lose it when a later sign-in no longer lists the group.");
        onApplied();
      },
      (e: Error) => setError(e.message),
    );
  };
  if (!view.groups.length) {
    return <p className="muted">No group yet. Groups appear here once members sign in through SSO and the ID token lists them in the {view.sso?.groupsClaim ?? "groups"} claim.</p>;
  }
  return (
    <>
      <About topic="directory sync" lead="Members of each group get its tag and lose it when they leave the group.">Tags added by hand stay. A group with no tag gives none. A change is previewed first, and only an owner applies it.</About>
      <table>
        <thead><tr><th>Group</th><th>Members</th><th>Tag</th></tr></thead>
        <tbody>
          {view.groups.map((g) => (
            <tr key={g.group}>
              <td className="mono">{g.group}</td>
              <td>{g.members}</td>
              <td><input aria-label={`Tag for ${g.group}`} value={draft[g.group] ?? ""} onChange={(e) => edit(g.group, e.target.value)} placeholder="no tag" /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button type="button" className="secondary" onClick={run}>Preview</button>
        {me.role === "owner" ? <button type="button" disabled={!preview} onClick={apply}>Apply tag changes</button> : <span className="muted">Only an owner applies a change.</span>}
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      {preview ? (
        <section aria-labelledby="preview-h">
          <h3 id="preview-h">Preview</h3>
          {preview.changes.length ? (
            <table>
              <thead><tr><th>Member</th><th>Gains</th><th>Loses</th></tr></thead>
              <tbody>
                {preview.changes.map((c) => (
                  <tr key={c.member.id}>
                    <td>{c.member.name}<div className="muted">{c.member.email}</div></td>
                    <td>{c.gains.join(", ") || "none"}</td>
                    <td>{c.loses.join(", ") || "none"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted">Nobody's tags change.</p>}
        </section>
      ) : null}
    </>
  );
}

/** Domains whose addresses sign in through SSO once a TXT record proves the organization holds them. */
function SsoDomains({ me }: { me: Principal }) {
  const [domains, setDomains] = useState<SsoDomain[] | null>(null);
  const [sso, setSso] = useState(false);
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);
  const owner = me.role === "owner";
  const reload = () => ssoDomains.list().then((r) => {
    setDomains(r.domains);
    setSso(r.sso);
  }, (e: Error) => setError(e.message));
  useEffect(() => {
    void reload();
  }, []);
  const act = (run: Promise<unknown>, failed: string) => {
    setError(null);
    run.then(reload, (e: Error) => setError(`${failed} ${e.message}`));
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    act(ssoDomains.add(adding).then(() => setAdding("")), "Failed to add the SSO domain.");
  };
  if (!domains) return error ? <LoadFailed what="SSO domains" reason={error} onRetry={() => { setError(null); void reload(); }} /> : <Loading what="SSO domains" />;
  return (
    <>
      <About topic="SSO domains" lead="Everyone at a verified domain signs in through SSO.">They join as members when the identity provider lets them in, and a password no longer opens their account. Owners keep their password, so a broken provider locks nobody out. Once a domain is verified, only addresses at verified domains join without an invitation.</About>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {domains.length ? (
        <table>
          <thead><tr><th>Domain</th><th>Status</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
          <tbody>
            {domains.map((d) => (
              <tr key={d.domain}>
                <td className="mono">{d.domain}</td>
                <td>
                  {d.verified ? "Verified; signs in with SSO" : (
                    <>
                      Add this TXT record, then verify:
                      <div className="mono">{d.record.name}</div>
                      <code className="link">{d.record.value}</code>
                    </>
                  )}
                </td>
                <td className="row-actions">
                  {owner && !d.verified ? <button type="button" className="secondary small" aria-label={`Verify ${d.domain}`} onClick={() => act(ssoDomains.verify(d.domain), "Failed to verify the SSO domain.")}>Verify</button> : null}
                  {owner ? <button type="button" className="secondary small" aria-label={`Remove ${d.domain}`} onClick={() => act(ssoDomains.remove(d.domain), "Failed to remove the SSO domain. Try again.")}>Remove</button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted">No domain yet.</p>}
      {owner && sso ? (
        <form className="form inline-form" onSubmit={add} aria-label="Add a domain">
          <label>Domain<input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="example.com" required /></label>
          <button type="submit" className="secondary">Add domain</button>
        </form>
      ) : <p className="muted">{owner ? "Set up single sign-on to add a domain." : "Only an owner adds, verifies and removes domains."}</p>}
    </>
  );
}

/** The directory's own token: shown once, replaced or turned off by an owner. */
function Provisioning({ me }: { me: Principal }) {
  const [status, setStatus] = useState<ScimStatus | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owner = me.role === "owner";
  const reload = () => scim.read().then(setStatus, (e: Error) => setError(e.message));
  useEffect(() => {
    void reload();
  }, []);
  const make = () => scim.create().then((r) => {
    setFresh(r.token);
    return reload();
  });
  if (!status) return error ? <LoadFailed what="directory provisioning" reason={error} onRetry={() => { setError(null); void reload(); }} /> : <Loading what="directory provisioning" />;
  return (
    <>
      <About topic="directory provisioning" lead="Your identity provider adds, turns off and removes people here.">It also keeps the groups directory sync maps to tags. Once it is on, single sign-on stops adding people nobody assigned, and someone the directory turns off loses their sessions, API keys and app tokens at once. The last owner is never turned off this way.</About>
      <dl className="facts">
        <div><dt>SCIM base URL</dt><dd><CopyText text={status.baseUrl} label="Copy the SCIM base URL" /></dd></div>
        <div><dt>Token</dt><dd>{status.token ? <>{status.token.prefix}_… made by {status.token.createdBy}; {status.token.lastUsedAt ? `last used ${new Date(status.token.lastUsedAt).toLocaleString()}` : "not used yet"}</> : "none; provisioning is off"}</dd></div>
      </dl>
      {fresh ? (
        <section className="notice" aria-label="New SCIM token">
          <p>Give this token to your identity provider now; it is shown once.</p>
          <CopyText text={fresh} label="Copy the SCIM token" />
          <div className="actions"><button type="button" className="secondary small" onClick={() => setFresh(null)}>I copied it</button></div>
        </section>
      ) : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {owner ? (
        <div className="actions">
          {status.token ? (
            <>
              <ConfirmAction trigger="Replace token" consequence="The token the identity provider uses now stops working at once; give it the new one." confirm="Make a new token" keep="Keep the token" onConfirm={make} />
              <ConfirmAction trigger="Turn off" consequence="The identity provider no longer reaches this organization, and single sign-on adds people again. Nobody already here is removed." confirm="Turn off provisioning" keep="Keep it on" onConfirm={() => scim.remove().then(reload)} />
            </>
          ) : <button type="button" onClick={() => make().catch((e: Error) => setError(e.message))}>Make a SCIM token</button>}
        </div>
      ) : <p className="muted">Only an owner turns provisioning on or off.</p>}
    </>
  );
}

const DIRECTORY_NAME = { google: "Google Workspace", microsoft: "Microsoft" } as const;

/** On a cloud orchestrator: whether people in the owner's own Google Workspace or Microsoft directory join without an invitation. */
function JoinByDirectory({ me }: { me: Principal }) {
  const [read, setRead] = useState<{ join: DirectoryJoin | null; yours: { provider: "google" | "microsoft"; directory: string } | null } | null>(null);
  const [role, setRole] = useState<"member" | "viewer">("member");
  const [error, setError] = useState<string | null>(null);
  const load = () => directoryJoin.read().then(setRead, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  const change = (on: boolean) => {
    setError(null);
    directoryJoin.set(on, role).then(load, (e: Error) => setError(e.message));
  };
  const owner = me.role === "owner";
  return (
    <section className="panel" aria-labelledby="directory-join-h">
      <h2 id="directory-join-h">Join without an invitation</h2>
      <About topic="joining by directory" lead="People signed in with an account in your own Google Workspace or Microsoft directory see this organization and join it with one click.">
        The directory is the one your own account is in, as Google or Microsoft says when you sign in, so nobody opens an organization to a directory they are not in. GitHub names no directory. Someone you remove comes back only through an invitation.
      </About>
      {read && error ? <p className="error" role="alert">{error}</p> : null}
      {!read ? (error ? <LoadFailed what="who joins without an invitation" reason={error} onRetry={() => { setError(null); void load(); }} /> : <Loading what="who joins without an invitation" />) : read.join ? (
        <>
          <p>People in the {DIRECTORY_NAME[read.join.provider]} directory <span className="mono">{read.join.directory}</span> join as {read.join.role}s.</p>
          {owner ? <div className="actions"><button type="button" className="secondary" onClick={() => change(false)}>Stop letting them join</button></div> : null}
        </>
      ) : !owner ? <p>Nobody joins without an invitation.</p> : read.yours ? (
        <div className="form">
          <p>Let people in your {DIRECTORY_NAME[read.yours.provider]} directory <span className="mono">{read.yours.directory}</span> join.</p>
          <Select label="They join as" value={role} onChange={(v) => setRole(v as "member" | "viewer")} options={[{ value: "member", label: "Member" }, { value: "viewer", label: "Viewer" }]} />
          <div className="actions"><button type="button" onClick={() => change(true)}>Let them join</button></div>
        </div>
      ) : <p>Nobody joins without an invitation. To open it to your colleagues, sign in with your Google Workspace or Microsoft work account.</p>}
    </section>
  );
}

export function SecuritySettings({ me }: { me: Principal }) {
  const [view, setView] = useState<DirectoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const managing = manages(me);
  useEffect(() => {
    if (managing) directory.read().then(setView, (e: Error) => setError(e.message));
  }, [managing, version]);
  if (!managing) return <section className="panel"><p>Only owners and admins see security settings.</p></section>;
  return (
    <>
      {me.mode === "cloud" ? <JoinByDirectory me={me} /> : null}
      <section className="panel" aria-labelledby="sso-h">
        <h2 id="sso-h">Single sign-on</h2>
        {error ? <LoadFailed what="single sign-on and directory settings" reason={error} onRetry={() => { setError(null); setVersion(version + 1); }} /> : null}
        {view?.sso ? (
          <dl className="facts">
            <div><dt>OpenID Connect</dt><dd className="mono">{view.sso.issuer}</dd></div>
            <div><dt>Groups claim</dt><dd className="mono">{view.sso.groupsClaim}</dd></div>
          </dl>
        ) : view ? <p>Single sign-on is off. It is set where the orchestrator runs, with ORCHESTRATOR_OIDC_ISSUER, ORCHESTRATOR_OIDC_CLIENT_ID and ORCHESTRATOR_OIDC_CLIENT_SECRET.</p> : null}
        <details className="muted">
          <summary>Why not SAML?</summary>
          <p>SAML is not offered: checking a SAML response safely takes an XML signature library this orchestrator does not carry. Identity providers that speak SAML also speak OpenID Connect; connect that.</p>
        </details>
      </section>
      <section className="panel" aria-labelledby="domains-h">
        <h2 id="domains-h">SSO domains</h2>
        <SsoDomains me={me} />
      </section>
      <section className="panel" aria-labelledby="scim-h">
        <h2 id="scim-h">Directory provisioning (SCIM)</h2>
        <Provisioning me={me} />
      </section>
      <section className="panel" aria-labelledby="dir-h">
        <h2 id="dir-h">Directory sync</h2>
        {view ? <DirectorySync me={me} view={view} onApplied={() => setVersion(version + 1)} /> : error ? null : <Loading what="directory sync" />}
      </section>
    </>
  );
}
