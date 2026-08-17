import { execFileSync } from "node:child_process";

// Why a git clone failed, in words the person who is stuck can act on. Shared by join
// and init because both of them reach a forge before anything else can happen, and both
// used to report every failure as the same shrug.

/** What this machine already has for signing in to a forge. Probed only on the failure
 * path, so the cost lands on the person who is already stuck. */
export interface CredentialState {
  ghInstalled: boolean;
  ghAuthenticated: boolean;
}

export function probeCredentials(): CredentialState {
  const run = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] });
  try {
    run("gh", ["--version"]);
  } catch {
    return { ghInstalled: false, ghAuthenticated: false };
  }
  try {
    run("gh", ["auth", "status"]);
    return { ghInstalled: true, ghAuthenticated: true };
  } catch {
    return { ghInstalled: true, ghAuthenticated: false };
  }
}

/** The one command this machine needs next, rather than a menu of everything that
 * could be wrong somewhere. */
function credentialAdvice(url: string, creds: CredentialState): string {
  if (!url.startsWith("http")) {
    return (
      "This is an SSH URL, so it needs a key this forge recognises: `ssh-keygen -t ed25519`, " +
      "then add ~/.ssh/id_ed25519.pub to your account's SSH keys."
    );
  }
  if (!creds.ghInstalled) {
    return "Install the GitHub CLI and sign in once: `brew install gh` then `gh auth login`. Run both in your own terminal, not here — the login is interactive.";
  }
  if (!creds.ghAuthenticated) {
    return "The GitHub CLI is installed but not signed in. Run `gh auth login` in your own terminal — the login is interactive, so it cannot happen from inside a session.";
  }
  return (
    "The GitHub CLI is signed in, so the account it is signed in as is probably not the one " +
    "with access. Check with `gh auth status`, and ask whoever set the handbook up to add that account."
  );
}

export function cloneFailureReason(
  url: string,
  err: unknown,
  creds: CredentialState = probeCredentials(),
): string {
  const raw = String(err instanceof Error ? err.message : err);
  const text = raw.toLowerCase();
  const detail = raw.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "";
  if (text.includes("could not read username") || text.includes("terminal prompts disabled") || text.includes("authentication failed")) {
    return (
      `cannot sign in to ${url} — this machine has no git credentials for it. A team handbook ` +
      "is normally a private repo, so this is the usual first step, not a fault. " +
      credentialAdvice(url, creds) +
      " You also need to have been given access to the repository itself; the two are separate."
    );
  }
  if (text.includes("permission denied (publickey)") || text.includes("host key verification")) {
    return (
      `SSH refused by ${url} — the key this machine offers is not registered on that host, or ` +
      "no key is loaded. Add your public key to the forge account, or use the HTTPS URL with credentials."
    );
  }
  if (text.includes("repository not found") || text.includes("not found") || text.includes("does not exist")) {
    return (
      `${url} is not there, or your account cannot see it. A private repo answers exactly the ` +
      "same way as a typo, so check the URL first, then whether you have been given access."
    );
  }
  if (text.includes("could not resolve host") || text.includes("network") || text.includes("timed out")) {
    return `cannot reach ${url} from this machine (network or DNS): ${detail}`;
  }
  return `git clone failed for ${url}: ${detail}`;
}
