import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { identityApi, SignedOut } from "./api";
import type { IdentityConfig, IdentityView, SignInProvider } from "./api";
import { navigate, pathIn } from "./router";
import { LoadFailed, Loading } from "./Status";
import { Hint } from "./Hint";

const PROVIDER: Record<SignInProvider, string> = { google: "Google", github: "GitHub", microsoft: "Microsoft" };

/**
 * What the orchestrator sends back when a sign-in does not finish: a code, and here the sentence for
 * it. A code this page does not know gets the general sentence, so a link carrying text of its
 * own shows nothing of it.
 */
const PROBLEMS: Record<string, string> = {
  browser: "This sign-in was started in another browser or tab. Start it again here.",
  expired: "This sign-in took too long or was already used. Start it again.",
  "provider-error": "The provider did not finish the sign-in. Try again.",
  "unverified-email": "Your provider has not verified this account's email address. Verify it there, or sign in another way.",
  "personal-microsoft": "Microsoft sign-in takes work and school accounts only. Sign in with Google or GitHub instead.",
  "unvouched-microsoft": "Microsoft does not vouch for this account's email address: only your organization's Microsoft admin can, by verifying its domain. Sign in with Google or GitHub instead, or ask that admin.",
  "address-taken": "This email address already signs in with another provider. Sign in with that one, then add this provider under Your account.",
  "invite-unknown": "This invitation link is not valid any more. Ask for a new one.",
  "invite-email": "This invitation is for another email address. Sign in with the account that has that address.",
  "invite-elsewhere": "An invitation is accepted only from the orchestrator's own page. Open its link again.",
  "plan-limit": "This organization has as many members as its plan allows. Ask an owner to make room.",
  "invite-expired": "This invitation expired. Ask whoever invited you for a new one.",
  "already-member": "You are already a member of that organization.",
  "already-account": "This email address already has an account in that organization. Ask its owner to remove it and invite you again.",
  "login-taken": "That account already signs in to this orchestrator as someone else, so it is not added to yours.",
};
export const GENERAL_PROBLEM = "That sign-in did not finish. Try again.";

export function problemSentence(code: string, signsInWith: string | null = null): string {
  // The providers come from the address, so each is checked against the names the page knows before it is shown.
  const ways = (signsInWith ?? "").split(",").filter((w): w is SignInProvider => Object.hasOwn(PROVIDER, w)).map((w) => PROVIDER[w]);
  if (code === "address-taken" && ways.length) return `This email address already signs in with ${ways.join(" or ")}. Sign in with ${ways.length > 1 ? "one of those" : ways[0]}, then add this provider under Your account.`;
  return Object.hasOwn(PROBLEMS, code) ? PROBLEMS[code]! : GENERAL_PROBLEM;
}

/** The orchestrator's privacy policy and terms of use, when its operator set them. */
export function LegalLinks({ privacyUrl, termsUrl }: { privacyUrl?: string | null; termsUrl?: string | null }) {
  if (!privacyUrl && !termsUrl) return null;
  return (
    <p className="muted legal">
      {termsUrl ? <a href={termsUrl}>Terms of use</a> : null}
      {termsUrl && privacyUrl ? " · " : null}
      {privacyUrl ? <a href={privacyUrl}>Privacy policy</a> : null}
    </p>
  );
}

/** An address from a name: lowercase letters, digits and dashes, as the orchestrator takes it. */
export function slugOf(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 39);
}

/** Where someone stuck gets help, when the orchestrator's operator gives an address for it. */
export function Help({ config }: { config: Pick<IdentityConfig, "helpUrl"> }) {
  return config.helpUrl ? <p className="muted"><a href={config.helpUrl}>Stuck? Get help</a></p> : null;
}

function SignInButtons({ config }: { config: IdentityConfig }) {
  if (!config.providers.length) return <p className="error">Nobody can sign in here yet: the orchestrator's operator has not set up Google, GitHub or Microsoft.</p>;
  return (
    <div className="stack">
      {config.providers.map((p) => <a key={p} className="button" href={`/api/auth/${p}/start`}>Sign in with {PROVIDER[p]}</a>)}
    </div>
  );
}

/** `/signup`: sign in with a provider, whether to create an organization or to reach one. */
function SignUp({ config }: { config: IdentityConfig }) {
  const [view, setView] = useState<IdentityView | null | undefined>(undefined);
  const problem = new URLSearchParams(window.location.search).get("problem");
  useEffect(() => {
    identityApi.me().then(setView, () => setView(null));
  }, []);
  if (view === undefined) return <Loading what="your sign-in" />;
  if (view) {
    const reachable = view.memberships.filter((m) => m.reachable);
    return (
      <>
        <h1 id="signup-h">Signed in as {view.identity.email}</h1>
        {problem ? <p className="error" role="alert">{problemSentence(problem, new URLSearchParams(window.location.search).get("with"))}</p> : null}
        <p className="muted">Not you, or another address? <button type="button" className="link" onClick={() => identityApi.signOut(view.csrf).then(() => setView(null), () => setView(null))}>Use another account</button></p>
        {reachable.length ? (
          <ul className="plain">{reachable.map((m) => <li key={m.tenant}><a href={pathIn(m.tenant, "tasks")}>Open {m.name}</a></li>)}</ul>
        ) : <p>You are not a member of an organization yet. Create one, or ask a teammate to invite {view.identity.email}.</p>}
        {config.signupOpen ? <a className="button" href="/signup/organization">Create an organization</a> : null}
        <Help config={config} />
      </>
    );
  }
  return (
    <>
      <h1 id="signup-h">{config.signupOpen ? "Start with TeamHandbook Orchestrator" : "Sign in"}</h1>
      <p>Your team's skills, MCP servers and commands in one place, with every change reviewed by the team.</p>
      {problem ? <p className="error" role="alert">{problemSentence(problem, new URLSearchParams(window.location.search).get("with"))}</p> : null}
      <SignInButtons config={config} />
      <Help config={config} />
      <p className="muted">An organization you create is yours: nobody joins without an invitation. <Hint label="signing up">Microsoft takes work and school accounts only.</Hint></p>
      <p className="muted">This is the hosted TeamHandbook Orchestrator; to run it on your own machine, see {config.readmeUrl ? <a href={config.readmeUrl}>the README</a> : "the README"}.</p>
    </>
  );
}

/** `/signup/organization`: the signed-in person names their organization and becomes its owner. */
function CreateOrganization({ config }: { config: IdentityConfig }) {
  const [view, setView] = useState<IdentityView | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [edited, setEdited] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const slugHint = useId();
  const load = () => identityApi.me().then(setView, (e: Error) => (e instanceof SignedOut ? navigate("/signup", true) : setError(e.message)));
  useEffect(() => {
    void load();
  }, []);
  if (!config.signupOpen) return <p className="error" role="alert">Signup is closed until this orchestrator's operator publishes its privacy policy and terms of use.</p>;
  if (!view) return error ? <LoadFailed what="your sign-in" reason={error} onRetry={() => { setError(null); void load(); }} /> : <Loading what="your sign-in" />;
  const described = error ? { "aria-describedby": errorId } : {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    identityApi.createOrganization({ name: name.trim(), slug, acceptTerms: accepted }, view.csrf).then(
      (created) => window.location.assign(created.next),
      (err: Error) => {
        setError(err.message);
        setBusy(false);
      },
    );
  };
  return (
    <form className="form" onSubmit={submit} aria-labelledby="create-org-h">
      <h1 id="create-org-h">Create your organization</h1>
      <p className="muted">Signed in as {view.identity.email}. You become its owner and invite your team from Settings.</p>
      <label>Organization name<input value={name} onChange={(e) => {
        setName(e.target.value);
        if (!edited) setSlug(slugOf(e.target.value));
      }} required maxLength={80} autoComplete="organization" {...described} /></label>
      <label>Web address<input value={slug} onChange={(e) => {
        setEdited(true);
        setSlug(e.target.value.toLowerCase());
      }} required pattern="[a-z0-9][a-z0-9\-]{1,38}" autoComplete="off" spellCheck={false} aria-describedby={error ? `${slugHint} ${errorId}` : slugHint} /></label>
      <p className="muted" id={slugHint}>Your organization is at /{slug || "your-address"}, in lowercase letters, digits and dashes. <Hint label="the web address">It does not change later, and nobody else gets it, even after the organization is deleted.</Hint></p>
      <label className="check"><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} required {...described} /> I accept the <a href={config.termsUrl!}>terms of use</a> and have read the <a href={config.privacyUrl!}>privacy policy</a>.</label>
      {error ? <p className="error" role="alert" id={errorId}>{error}</p> : null}
      <div className="actions"><button type="submit" disabled={busy}>{busy ? "Creating…" : "Create organization"}</button></div>
      <Help config={config} />
    </form>
  );
}

/** The signup screens of a cloud orchestrator, under /signup. */
export function Signup({ config }: { config: IdentityConfig }) {
  const creating = window.location.pathname.replace(/\/+$/, "") === "/signup/organization";
  return (
    <main className="gate">
      <section className="panel form" aria-labelledby={creating ? "create-org-h" : "signup-h"}>
        <div className="brand">TeamHandbook <span>Orchestrator</span></div>
        {creating ? <CreateOrganization config={config} /> : <SignUp config={config} />}
        <LegalLinks privacyUrl={config.privacyUrl} termsUrl={config.termsUrl} />
      </section>
    </main>
  );
}
