import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { apiPath, identityApi, join } from "../api";
import type { IdentityConfig, Role, SignInProvider } from "../api";
import { Help, LegalLinks } from "../Signup";
import { Hint } from "../Hint";

const PROVIDER_NAME: Record<SignInProvider, string> = { google: "Google", github: "GitHub", microsoft: "Microsoft" };
import { ROLE_LABEL } from "./Members";

/** What joining with each role lets the person do, said to them before they accept. */
const JOINING_AS: Record<Role, string> = {
  owner: "You'll have full control of the organization: its members and roles, repositories, settings and every team's work.",
  admin: "You'll manage members, repositories and settings, and see every team's skills, MCP servers and commands.",
  member: "You'll see every team's skills, MCP servers and commands, and propose changes to them for the team to review.",
  viewer: "You'll see every team's skills, tasks and requests, without changing anything.",
};

function day(at: string): string {
  return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** The page an invitation link opens: who invited whom to what, and what joining means, then a name and a password, or single sign-on. */
export function Join({ token, onJoined, cloud }: { token: string; onJoined: () => void; cloud?: IdentityConfig | null }) {
  const [invite, setInvite] = useState<{ email: string; role: Role; teams: string[]; invitedBy: string; org: string; expiresAt: string; sso: boolean; ssoRequired: boolean; signedIn?: boolean; emailMatches?: boolean | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  useEffect(() => {
    join.read(token).then((r) => setInvite({ ...r.invite, org: r.org, sso: r.sso, signedIn: r.signedIn, emailMatches: r.emailMatches }), (e: Error) => setProblem(e.message));
  }, [token]);
  // A cloud identity signed in as the invited address joins here; the server checks the address again.
  const joinSignedIn = () => {
    setBusy(true);
    setError(null);
    identityApi
      .me()
      .then((view) => identityApi.join(token, view.csrf))
      .then(
        (joined) => window.location.assign(joined.next),
        (err: Error) => {
          setError(err.message);
          setBusy(false);
        },
      );
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    join.accept(token, form).then(
      () => {
        window.location.hash = "/";
        onJoined();
      },
      (err: Error) => {
        setError(err.message);
        setBusy(false);
      },
    );
  };
  const described = error ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  // On a cloud orchestrator each provider's button is a form of its own, which a form around them would break.
  const Frame = cloud ? "section" : "form";
  return (
    <main className="gate">
      <Frame className="panel form" onSubmit={cloud ? undefined : submit} aria-labelledby="join-h">
        <div className="brand">TeamHandbook <span>Orchestrator</span></div>
        <h1 id="join-h">{invite ? `Join ${invite.org}` : "Join the organization"}</h1>
        {problem ? <p className="error" role="alert">{problem}</p> : null}
        {problem && cloud ? <Help config={cloud} /> : null}
        {!invite && !problem ? <p className="muted">Reading the invitation…</p> : null}
        {invite ? (
          <>
            <p>{invite.invitedBy} invited {invite.email} to {invite.org} as {ROLE_LABEL[invite.role]}{invite.teams.length ? `, team owner of ${invite.teams.join(", ")}` : ""}.</p>
            <p>{JOINING_AS[invite.role]} <Hint label="this invitation">{invite.teams.length ? `As team owner of ${invite.teams.join(", ")}, you also edit ${invite.teams.length === 1 ? "that team's" : "those teams'"} skills, MCP servers and commands. ` : ""}The link works once, until {day(invite.expiresAt)}.</Hint></p>
            {cloud && invite.signedIn && invite.emailMatches ? (
              <>
                {error ? <p className="error" role="alert">{error}</p> : null}
                <button type="button" onClick={joinSignedIn} disabled={busy}>Join {invite.org}</button>
                <LegalLinks privacyUrl={cloud.privacyUrl} termsUrl={cloud.termsUrl} />
              </>
            ) : cloud ? (
              <>
                <p className="muted">{invite.signedIn ? `You are signed in with another address; sign in with the account that has ${invite.email}.` : `Sign in with the account that has ${invite.email}.`}</p>
                {cloud.providers.map((p) => (
                  <form key={p} method="post" action={`/api/auth/${p}/start`}>
                    <input type="hidden" name="invite" value={token} />
                    <button type="submit">Sign in with {PROVIDER_NAME[p]}</button>
                  </form>
                ))}
                <Help config={cloud} />
                <LegalLinks privacyUrl={cloud.privacyUrl} termsUrl={cloud.termsUrl} />
              </>
            ) : invite.ssoRequired ? (
              <>
                <p>Addresses at {invite.email.slice(invite.email.lastIndexOf("@") + 1)} sign in with SSO, as {invite.email}.</p>
                <a className="button" href={apiPath("/api/auth/oidc/start")}>Sign in with SSO</a>
              </>
            ) : (
              <>
                <label>Name<input autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} {...described} /></label>
                <label>Password<input type="password" autoComplete="new-password" minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required {...described} /></label>
                {error ? <p className="error" role="alert" id={errorId}>{error}</p> : null}
                <button type="submit" disabled={busy}>Join and sign in</button>
                {invite.sso ? (
                  <>
                    <p className="muted">Or sign in through your identity provider with {invite.email}; the invitation is used the same way.</p>
                    <a className="button secondary" href={apiPath("/api/auth/oidc/start")}>Sign in with SSO</a>
                  </>
                ) : null}
              </>
            )}
          </>
        ) : null}
      </Frame>
    </main>
  );
}
