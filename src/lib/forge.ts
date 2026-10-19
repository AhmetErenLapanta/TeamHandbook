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

export type ForgeRunner = (tool: "gh" | "glab", args: string[], cwd: string, timeoutMs?: number) => string;

export const FORGE_TIMEOUT_MS = 60_000;

/**
 * How long the sign-in check may take. It sits in front of read-only screens - the share
 * list, the first run of every push, the doctor - and with a CLI installed but its host
 * unreachable it used to inherit the minute a merge request is given to open, freezing a
 * screen that pushes nothing. The same reasoning as the release check in status: a check
 * that stalls the screen it decorates is worse than no check.
 */
export const FORGE_CHECK_TIMEOUT_MS = 5_000;

export function runForge(tool: "gh" | "glab", args: string[], cwd: string, timeoutMs = FORGE_TIMEOUT_MS): string {
  return execFileSync(tool, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: nonInteractiveEnv(),
    timeout: timeoutMs,
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
 * Asked before anything is pushed: by every push decision, by the share list and by the
 * doctor, so each of them tells the user the same thing about the same forge. For most of
 * them a missing forge is a soft failure, said up front: the branch is pushed and a link is
 * printed, or on GitLab the push itself asks for the request. It is a hard one only for a
 * delegated wording, because the delegation was given for the moment the request is
 * opened - if no request can be opened, a commit carrying a sentence nobody read is all
 * that would be left behind, on a branch, waiting for someone to notice. A check that does
 * not answer in time counts as a forge that cannot open one, which keeps both readings on
 * their safe side.
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
      forge(tool, args, repoDir, FORGE_CHECK_TIMEOUT_MS);
      return null;
    } catch (err) {
      const e = err as { code?: string; stderr?: string; message?: string };
      if (e?.code === "ENOENT") return `the ${tool} CLI is not installed`;
      // Not retried without the host: a second attempt would only double the wait.
      if (e?.code === "ETIMEDOUT") return "the forge check timed out";
      const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
      last = (stderr ? stderr.split("\n").at(-1)! : String(e?.message ?? err)).slice(0, 160);
      if (!/unknown (flag|shorthand)/i.test(stderr)) break;
    }
  }
  return `${tool} could not confirm you are signed in${last ? `: ${last}` : ""}`;
}

/** Who a request is assigned to and how it is labelled, as the team repository records it. */
export interface RequestAssignment {
  reviewers: string[];
  labels: string[];
}

/** The repository's address on the web, without the SSH port a remote URL may carry, or
 * null for a remote that has none, such as a local path. */
function webAddress(repoUrl: string): string | null {
  return normalizeRemoteUrl(repoUrl)?.replace(/^([^/:]+):\d+\//, "$1/") ?? null;
}

/**
 * The request a forge reports having opened on this repository, or null.
 *
 * Only a request with a number counts. GitLab prints a "create a merge request" link on
 * every push of a new branch, and GitHub a `pull/new/<branch>` one, with or without a
 * request behind them; reading either as an opened request would tell the user something
 * exists that does not. The URL is held to the repository's own host and path, so a URL
 * that merely has the shape - one quoted in an error about some other host, or a compare
 * link whose branch name ends in a number - is not taken for the request. A repository
 * with no web address, a local path, is held to the shape alone.
 */
export function openedRequestUrl(output: string, repoUrl: string): string | null {
  const web = webAddress(repoUrl);
  const at = web ? web.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "\\S+?";
  const kind = !web ? "(?:-\\/merge_requests|pull)" : forgeTool(repoUrl) === "gh" ? "pull" : "-\\/merge_requests";
  return output.match(new RegExp(`https?:\\/\\/${at}\\/${kind}\\/\\d+(?=[\\s?#]|$)`, "i"))?.[0] ?? null;
}

// The equals form, so a value can never be read as a flag of its own, and one comma-joined
// value per flag, the form both CLIs document. An empty list adds no flag at all.
function assignmentFlags(assignment: RequestAssignment): string[] {
  return [
    ...(assignment.reviewers.length ? [`--reviewer=${assignment.reviewers.join(",")}`] : []),
    ...(assignment.labels.length ? [`--label=${assignment.labels.join(",")}`] : []),
  ];
}

// The last line a failing CLI wrote, except one that is only a URL: gh ends its refusal of a
// second request with the address of the first, and that address is not a reason.
function forgeFailure(tool: "gh" | "glab", err: unknown): string {
  const e = err as { code?: string; stderr?: string; message?: string };
  if (e?.code === "ENOENT") return `the ${tool} CLI is not installed`;
  const lines = (typeof e?.stderr === "string" ? e.stderr : "").split("\n").map((line) => line.trim()).filter(Boolean);
  const said = lines.filter((line) => !/^https?:\/\/\S+$/.test(line)).at(-1) ?? lines.at(-1);
  return (said ?? String(e?.message ?? err)).slice(0, 160);
}

function outputOf(err: unknown): string {
  const e = err as { stdout?: unknown; stderr?: unknown };
  return `${typeof e?.stdout === "string" ? e.stdout : ""}\n${typeof e?.stderr === "string" ? e.stderr : ""}`;
}

/**
 * The refusal both forges give a second open request for one source branch, read as what it
 * says: the branch has a request open, so the push that came before is on it. gh says "a
 * pull request for branch ... already exists" with its address; GitLab says "Another open
 * merge request already exists for this source branch: !12", and the address is built from
 * that `!12` and the repository's own. Who opened it is not said, because it cannot be
 * known here: the first attempt may have opened it without reporting it, or a run before
 * this one did. The same result whatever the team file holds. With no address to be had,
 * the forge's own sentence is kept, so the reader can still tell which request it means.
 */
function existingRequest(tool: "gh" | "glab", repoUrl: string, err: unknown): { url: string | null; existing: true; error?: string } | null {
  const output = outputOf(err);
  if (!/(?:pull|merge) request[^\n]*already exists/i.test(output)) return null;
  const web = webAddress(repoUrl);
  const number = tool === "glab" ? output.match(/!(\d+)/)?.[1] : undefined;
  const url = openedRequestUrl(output, repoUrl) ?? (web && number ? `https://${web}/-/merge_requests/${number}` : null);
  return url ? { url, existing: true } : { url: null, existing: true, error: `a request for this branch is already open (${forgeFailure(tool, err)})` };
}

/**
 * Open the request, carrying the team's reviewers and labels when it records any.
 *
 * One wrong name in the team file must not stop every share, so a request the forge
 * refuses with its assignment is asked for once more without it, and `unassigned` says
 * why the assignment did not go. The second ask is the dangerous one: gh creates the pull
 * request first and requests reviewers after, printing the URL and failing when a login
 * is unknown, so a blind retry would open a second request. The failed call's own output
 * is read for an opened request before anything is retried, and a forge that answers either
 * call with the request already open for the branch is not asked again. A timeout is never
 * retried: whether the request exists is exactly what it leaves unknown. When the retry
 * fails too, `unassigned` still carries why the assignment was refused, because that is the
 * one reason the team file may need correcting.
 */
export function openPr(
  repoUrl: string,
  branch: string,
  title: string,
  body: string,
  repoDir: string,
  forge: ForgeRunner,
  assignment: RequestAssignment = { reviewers: [], labels: [] },
): { url: string | null; error?: string; unassigned?: string; existing?: true } {
  const tool = forgeTool(repoUrl);
  const create = (extra: string[]) =>
    extractUrl(
      tool === "gh"
        ? forge("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body, ...extra], repoDir)
        : forge(
            "glab",
            ["mr", "create", "--source-branch", branch, "--title", title, "--description", body, ...extra, "--yes"],
            repoDir,
          ),
    );
  const flags = assignmentFlags(assignment);
  try {
    return { url: create(flags) };
  } catch (err) {
    // The branch is already pushed, so this is a soft failure (fall back to a manual
    // link) - but surface WHY, so the user isn't left guessing that gh/glab just
    // needs installing or `gh auth login`.
    const existing = existingRequest(tool, repoUrl, err);
    if (existing) return existing;
    const reason = forgeFailure(tool, err);
    const code = (err as { code?: string })?.code;
    if (!flags.length || code === "ENOENT" || code === "ETIMEDOUT") return { url: null, error: reason };
    const opened = openedRequestUrl(outputOf(err), repoUrl);
    if (opened) return { url: opened, unassigned: reason };
    try {
      return { url: create([]), unassigned: reason };
    } catch (retryErr) {
      return { ...(existingRequest(tool, repoUrl, retryErr) ?? { url: null, error: forgeFailure(tool, retryErr) }), unassigned: reason };
    }
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

/**
 * What happens to the request when the forge CLI cannot open it, said before the push.
 *
 * Learning it from a result that has already pushed is too late to do anything about it -
 * install the CLI, sign in, or decide to open the request by hand - and "you decide" is
 * refused for the same reason, so the two are said together. On GitLab the push itself
 * asks for the request, which is why the sentence differs by forge.
 */
export function forgeNotice(repoUrl: string, problem: string): string {
  const byPush = forgeTool(repoUrl) === "glab" && hostFromUrl(repoUrl) !== null;
  return (
    (byPush
      ? `This machine cannot open the merge request with glab (${problem}): the branch will be pushed asking ` +
        "GitLab to open the request itself, and a link printed if it does not."
      : `This machine cannot open the merge request (${problem}): the branch will be pushed and a link printed.`) +
    ' For the same reason "you decide" is not an answer to the commit message here: the wording is asked of you.'
  );
}
