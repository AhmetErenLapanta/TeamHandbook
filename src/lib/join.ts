import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertSafeGitUrl, BrokenConfigError, loadTeamConfig, runGit, saveTeamConfig } from "./init.js";
import { configIsBroken } from "./config.js";
import type { GitRunner } from "./init.js";
import { handbookHome, handbookWorkdir } from "./session-state.js";

export interface JoinResult {
  ok: boolean;
  name?: string;
  url?: string;
  home?: string;
  error?: string;
}

function readMarketplaceName(repoDir: string): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(repoDir, ".claude-plugin", "marketplace.json"), "utf8"),
    );
    return typeof parsed?.name === "string" && parsed.name ? parsed.name : null;
  } catch {
    return null;
  }
}

/**
 * Why the clone failed, in the words of someone who can act on it. git already says
 * which of these it is; the first person to hit this got "git clone failed (is the URL
 * correct and reachable?)" with git's own line appended, and had to work the rest out
 * themselves — the URL was right and reachable, they simply had no credentials for a
 * private repository. A handbook repo is private more often than not, so this is the
 * common path, not the edge case.
 */
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

export function joinTeamRepo(
  url: string,
  home: string = handbookHome(),
  git: GitRunner = runGit,
  now: string = new Date().toISOString(),
): JoinResult {
  if (!url.trim()) return { ok: false, error: "a git URL is required" };
  try {
    assertSafeGitUrl(url);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  if (configIsBroken(home)) {
    return { ok: false, error: new BrokenConfigError(home).message };
  }
  const existing = loadTeamConfig(home);
  if (existing && existing.repoUrl !== url) {
    return {
      ok: false,
      error: `already joined ${existing.repoUrl}; run /handbook:leave (or edit ${join(home, "config.json")}) to switch teams`,
    };
  }
  const workdir = handbookWorkdir("handbook-join-", home);
  const repoDir = join(workdir, "repo");
  try {
    try {
      git(["clone", "--depth", "1", "--single-branch", "--", url, repoDir], workdir);
    } catch (err) {
      return { ok: false, error: cloneFailureReason(url, err) };
    }
    const name = readMarketplaceName(repoDir);
    if (!name) {
      return {
        ok: false,
        error: "the repository has no .claude-plugin/marketplace.json — is it a TeamHandbook team repo?",
      };
    }
    saveTeamConfig(
      {
        ...(existing ?? {}),
        repoUrl: url,
        marketplaceName: name,
        joinedAt: now,
      },
      home,
    );
    return { ok: true, name, url, home };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

export function formatJoinSuccess(result: JoinResult): string {
  return [
    `Joined the team skill base at ${result.url}.`,
    "",
    "  engine:  approved skills will now target this repository",
    `  config:  team repo saved to ${join(result.home ?? "", "config.json")}`,
    "",
    "To finish, connect Claude Code to the team marketplace (built-in commands):",
    "",
    `  /plugin marketplace add ${result.url}`,
    `  /plugin install ${result.name}@${result.name}`,
  ].join("\n");
}
