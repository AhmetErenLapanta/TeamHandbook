import { useId, useState } from "react";
import type { FormEvent } from "react";
import { apiPath, auth } from "./api";
import type { AuthConfig } from "./api";
import { CopyText } from "./Confirm";
import { Hint } from "./Hint";
import { LegalLinks } from "./Signup";

function problemFromHash(): string | null {
  const query = window.location.hash.split("?")[1];
  return query ? new URLSearchParams(query).get("problem") : null;
}

export function SignIn({ config, org = null, onSignedIn }: { config: AuthConfig; org?: string | null; onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(problemFromHash());
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const described = error ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    auth.login(email, password).then(onSignedIn, (err: Error) => {
      setError(err.message);
      setBusy(false);
    });
  };
  return (
    <main className="gate">
      <form className="panel form" onSubmit={submit} aria-labelledby="signin-h">
        <div className="brand">TeamHandbook <span>Orchestrator</span></div>
        <h1 id="signin-h">Sign in</h1>
        {org ? <p className="muted">to {org}</p> : null}
        <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required {...described} /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required {...described} /></label>
        {error ? <p className="error" role="alert" id={errorId}>{error}</p> : null}
        <button type="submit" disabled={busy}>Sign in</button>
        {config.sso ? <a className="button secondary" href={apiPath("/api/auth/oidc/start")}>Sign in with SSO</a> : null}
        <LegalLinks privacyUrl={config.privacyUrl} termsUrl={config.termsUrl} />
      </form>
    </main>
  );
}

export function Setup({ onSignedIn }: { onSignedIn: () => void }) {
  const [form, setForm] = useState({ code: "", name: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value }),
    ...(error ? { "aria-invalid": true, "aria-describedby": errorId } : {}),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    auth.setup(form).then(onSignedIn, (err: Error) => {
      setError(err.message);
      setBusy(false);
    });
  };
  return (
    <main className="gate">
      <form className="panel form" onSubmit={submit} aria-labelledby="setup-h">
        <div className="brand">TeamHandbook <span>Orchestrator</span></div>
        <h1 id="setup-h">Create the first owner</h1>
        <p className="muted">No account exists yet; the setup code is in the orchestrator's log, and it works once. <Hint label="the setup code">Run without Docker, it is in the output of the terminal the orchestrator runs in. To choose it yourself, start the orchestrator with <code>ORCHESTRATOR_SETUP_TOKEN</code> set; the log then names no code.</Hint></p>
        <CopyText text={`docker compose logs orchestrator | grep "setup code"`} label="Copy the command for Docker Compose" />
        <label>Setup code<input autoComplete="off" {...field("code")} required /></label>
        <label>Name<input autoComplete="name" {...field("name")} /></label>
        <label>Email<input type="email" autoComplete="username" {...field("email")} required /></label>
        <label>Password<input type="password" autoComplete="new-password" minLength={12} {...field("password")} required /></label>
        {error ? <p className="error" role="alert" id={errorId}>{error}</p> : null}
        <button type="submit" disabled={busy}>Create owner and sign in</button>
      </form>
    </main>
  );
}
