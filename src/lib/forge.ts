import { execFileSync } from "node:child_process";
import { normalizeRemoteUrl } from "./distill.js";
import { nonInteractiveEnv } from "./init.js";

// Everything that talks to a forge rather than to git: which host a URL belongs to, how
// to open a merge request there, and where to send someone when the CLI for it is
// missing. Shared by publish, which has always delivered skills this way, and by init,
// which now delivers the scaffold the same way.

export function hostFromUrl(url: string): string | null {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return null;
  return normalized.slice(0, normalized.indexOf("/"));
}

export type ForgeRunner = (tool: "gh" | "glab", args: string[], cwd: string) => string;

export const FORGE_TIMEOUT_MS = 60_000;

export function runForge(tool: "gh" | "glab", args: string[], cwd: string): string {
  return execFileSync(tool, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: nonInteractiveEnv(),
    timeout: FORGE_TIMEOUT_MS,
  });
}

export function manualPrUrl(repoUrl: string, branch: string): string | null {
  const normalized = normalizeRemoteUrl(repoUrl);
  if (!normalized) return null;
  const host = hostFromUrl(repoUrl);
  if (host && host.includes("github")) {
    return `https://${normalized}/pull/new/${branch}`;
  }
  return `https://${normalized}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
}

function extractUrl(output: string): string | null {
  return output.match(/https?:\/\/\S+/)?.[0] ?? null;
}

/** Which CLI opens a merge request against this repository. One reading, used by both
 * openPr and the sign-in check, so the check cannot end up asking a different tool than
 * the one that will be asked to open the request. */
export function forgeTool(repoUrl: string): "gh" | "glab" {
  const host = hostFromUrl(repoUrl);
  return host && host.includes("github") ? "gh" : "glab";
}

/**
 * Why a merge request could not be opened from this machine, or null when one could.
 *
 * Asked BEFORE the push, and only for a run whose wording was delegated. Everywhere else a
 * forge that is missing is a soft failure: the branch is pushed and the user is handed a
 * link to open the request by hand. It cannot be soft for a delegated run, because the
 * delegation was given for the moment the request is opened - if no request can be opened,
 * a commit carrying a sentence nobody read is all that would be left behind, on a branch,
 * waiting for someone to notice.
 */
export function forgeSignInProblem(repoUrl: string, repoDir: string, forge: ForgeRunner): string | null {
  const tool = forgeTool(repoUrl);
  const host = hostFromUrl(repoUrl);
  // The host is named where the CLI accepts it, so a machine signed in to some other
  // forge does not read as signed in to this one. Measured with the gh on the machine this
  // was written on: `gh auth status --hostname bogus.invalid` exits 1 saying "You are not
  // logged into any accounts on bogus.invalid", and a host it holds a token for exits 0 -
  // so a failure throws here rather than returning quietly. glab documents the same flag
  // but was not installed there and is therefore unverified, which is why an old build
  // that does not know the flag falls back to the plain command rather than being
  // reported as a sign-in failure it is not.
  const attempts = host ? [["auth", "status", "--hostname", host], ["auth", "status"]] : [["auth", "status"]];
  let last = "";
  for (const args of attempts) {
    try {
      forge(tool, args, repoDir);
      return null;
    } catch (err) {
      const e = err as { code?: string; stderr?: string; message?: string };
      if (e?.code === "ENOENT") return `the ${tool} CLI is not installed`;
      const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
      last = (stderr ? stderr.split("\n").at(-1)! : String(e?.message ?? err)).slice(0, 160);
      if (!/unknown (flag|shorthand)/i.test(stderr)) break;
    }
  }
  return `${tool} could not confirm you are signed in${last ? `: ${last}` : ""}`;
}

export function openPr(
  repoUrl: string,
  branch: string,
  title: string,
  body: string,
  repoDir: string,
  forge: ForgeRunner,
): { url: string | null; error?: string } {
  const host = hostFromUrl(repoUrl);
  try {
    const out =
      forgeTool(repoUrl) === "gh"
        ? forge("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body], repoDir)
        : forge(
            "glab",
            ["mr", "create", "--source-branch", branch, "--title", title, "--description", body, "--yes"],
            repoDir,
          );
    return { url: extractUrl(out) };
  } catch (err) {
    // The branch is already pushed, so this is a soft failure (fall back to a manual
    // link) - but surface WHY, so the user isn't left guessing that gh/glab just
    // needs installing or `gh auth login`.
    const e = err as { code?: string; stderr?: string; message?: string };
    const tool = forgeTool(repoUrl);
    let reason: string;
    if (e?.code === "ENOENT") reason = `the ${tool} CLI is not installed`;
    else {
      const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
      reason = (stderr ? stderr.split("\n").at(-1)! : String(e?.message ?? err)).slice(0, 160);
    }
    return { url: null, error: reason };
  }
}

/**
 * The clause that says no merge request can be opened from this machine.
 *
 * One phrasing for every path, because it is one rule: "you decide" is an answer about the
 * merge request, and a machine with no way to open one would turn it into a commit pushed
 * to a branch with nobody told. The sentence around it is built where the decision is
 * made, so the same clause serves both the run that delegated and the run that has not
 * been asked yet.
 */
export function noRequestPossible(reason: string): string {
  return `no merge request can be opened from this machine (${reason})`;
}
