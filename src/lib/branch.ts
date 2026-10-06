import { readFileSync } from "node:fs";
import { join } from "node:path";
import { uniqueSlug } from "./distill.js";
import { forgeNotice, forgeSignInProblem, forgeTool, hostFromUrl, manualPrUrl, noRequestPossible, openPr } from "./forge.js";
import type { ForgeRunner } from "./forge.js";
import {
  commitMessageProblem,
  decideCommitSubject,
  proposalFingerprint,
  pushFailureReason,
  pushRuleSubject,
  TEAM_PREFIX_FILE,
} from "./init.js";
import type { CommitMessageChoice, GitRunner, TeamConfig } from "./init.js";
import { detectIdentity } from "./identity.js";
import { detectSecret } from "./secrets.js";

// The branch a request to the team repository goes out on: the name proposed for it, the
// user's decision about that name, the push itself, and what the other branches in the
// repository already claim. Every route that pushes to the team - a share, a team approval
// out of review, a scaffold refresh - comes through here. The defect this replaced was one
// of three routes pushing on its own terms after the other two had been fixed, so the
// name, the push and the refusal now have exactly one definition each.
//
// The name is the user's. The product proposes one and the user confirms or changes it,
// the same way they already answer for the commit message; nothing here learns a rule
// from a refusal, rewrites a name the user gave, or remembers anything between runs.

/** A ticket key at the front of a branch name: `TEAM-12` in `TEAM-12-fix-login`. */
const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+/;

export function ticketKey(name: string | undefined): string | undefined {
  return name?.trim().match(TICKET_KEY)?.[0];
}

/** Where a proposal may take a ticket key from, besides the team's own settings. */
export interface BranchHints {
  /** the branch checked out in the repository the command was run from */
  current?: string;
  /**
   * A branch name the user gave earlier in this session. Each command runs as a fresh
   * process, so the session's memory is the caller's to pass back; nothing here writes it
   * anywhere.
   */
  previous?: string;
}

/** The branch checked out in `cwd`, or undefined outside a repository or on a detached HEAD. */
export function currentBranch(cwd: string, git: GitRunner): string | undefined {
  try {
    return String(git(["symbolic-ref", "--short", "-q", "HEAD"], cwd) ?? "").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function branchHints(cwd: string, git: GitRunner, previous?: string): BranchHints {
  return { current: currentBranch(cwd, git), ...(previous ? { previous } : {}) };
}

/** What the user decided about the push beyond its commit message. */
export interface PushChoice {
  /** The branch the user named. Pushed exactly as given: never suffixed, never renamed. */
  branch?: string;
  hints?: BranchHints;
  /**
   * The user's answer to an unmerged branch that already raises the plugin to the version
   * this request would claim: send this one past it rather than stopping.
   */
  versionAfterOpen?: boolean;
}

/**
 * The branch shown to the user: a concrete name, or the shape a name needs when the one
 * part of it only they know - which ticket this is - is missing.
 */
export type BranchProposal = { branch: string } | { template: string; example: string };

/**
 * The name proposed for this push, from the most specific source that has an answer.
 *
 * A ticket key from the branch the user is working on comes first, because a share made
 * in the middle of a ticket belongs to that ticket; then the key of a branch they named
 * earlier in this session; then the prefixes this machine was configured with; then the
 * shape of the example the team repository records; then the plain slug. Only the
 * proposal is made unique against the branches that exist: a name the user gives is
 * theirs, and a collision with it is put back to them rather than suffixed.
 */
export function proposeBranch(
  slug: string,
  team: TeamConfig,
  example: string | undefined,
  hints: BranchHints,
  taken: ReadonlySet<string>,
): BranchProposal {
  const free = (name: string) => uniqueSlug(name, (candidate) => taken.has(candidate));
  const key = ticketKey(hints.current) ?? ticketKey(hints.previous);
  if (key) return { branch: free(`${key}-${slug}`) };
  const prefix = team.branchPrefix?.trim();
  if (prefix) return { branch: free(`${prefix}${slug}`) };
  const commitKey = ticketKey(team.commitPrefix);
  if (commitKey) return { branch: free(`${commitKey}-${slug}`) };
  if (example) {
    // The example's own ticket number is an illustration, not this push's ticket, so a
    // keyed shape is shown with the key left for the user to fill in.
    if (ticketKey(example)) return { template: `<TICKET>-${slug}`, example };
    const slash = example.lastIndexOf("/");
    if (slash > 0) return { branch: free(`${example.slice(0, slash + 1)}${slug}`) };
  }
  return { branch: free(slug) };
}

// Long enough for a ticket key and a sentence's worth of slug, short enough that a branch
// list stays readable. git sets no limit of its own that matters here.
const BRANCH_NAME_MAX = 200;

/**
 * Why `name` cannot be the branch this pushes, or null when it can.
 *
 * The branch is seen by everyone who reads the team repository, so it passes the same
 * screens as everything else that leaves this machine: a trace of the machine or a
 * credential is refused here, before git ever sees it. git then decides whether it is a
 * branch name at all - `check-ref-format --branch` is git's own rule, so nothing here
 * re-implements it and drifts from it.
 */
export function branchNameProblem(name: string, git: GitRunner, cwd: string): string | null {
  if (!name.trim() || name !== name.trim()) return "it is empty or starts or ends with a space";
  if (name.length > BRANCH_NAME_MAX) return `it is longer than ${BRANCH_NAME_MAX} characters`;
  if (/\p{C}/u.test(name)) return "it carries a control character";
  const trace = branchTrace(name);
  if (trace) return trace;
  // A leading dash would be read as an option, and `--branch` expands "@{-1}" into whatever
  // branch was checked out before - a name that passes the check by turning into another.
  if (name.startsWith("-") || name.includes("@{")) return "git does not accept it as a branch name";
  try {
    git(["check-ref-format", "--branch", name], cwd);
  } catch {
    return "git does not accept it as a branch name";
  }
  return null;
}

/**
 * Why `name` would carry this machine or a credential to everyone who reads the branch
 * list, or null. Said by class, never by quoting the name: a refusal that printed the
 * trace would put it on the screen the sieve exists to keep it off.
 */
export function branchTrace(name: string): string | null {
  const identity = detectIdentity(name);
  if (identity) return `it carries a trace of this machine (${identity}), and every teammate reads the branch list`;
  const secret = detectSecret(name);
  if (secret) return `it carries what looks like a ${secret}, and every teammate reads the branch list`;
  return null;
}

// The same reasoning as the commit-prefix record next to it: read out of a repository
// somebody else controls, shown on a screen and copied into a branch name.
const BRANCH_EXAMPLE_MAX = 100;

/** Why this cannot be recorded or read as the team's example branch name, or null. */
export function branchExampleProblem(value: string): string | null {
  if (value.length > BRANCH_EXAMPLE_MAX) return `longer than ${BRANCH_EXAMPLE_MAX} characters`;
  if (/\p{C}/u.test(value)) return "carrying a control character";
  const identity = detectIdentity(value);
  if (identity) return `carrying a trace of a machine (${identity})`;
  const secret = detectSecret(value);
  if (secret) return `carrying what looks like a ${secret}`;
  return null;
}

/**
 * The example branch name a cloned team repository records, and nothing else.
 *
 * An example rather than a rule: a forge's pattern is written for the forge, and turning
 * it into a name means parsing somebody's regular expression, which is the guessing this
 * replaced. A person who knows the repository writes one name the way they would name a
 * branch there, and the proposal takes its shape.
 */
export function readTeamBranchExample(repoDir: string): { example?: string; problem?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(repoDir, TEAM_PREFIX_FILE), "utf8"))?.branchExample;
  } catch {
    return {};
  }
  if (typeof raw !== "string" || !raw.trim()) return {};
  const value = raw.trim();
  const problem = branchExampleProblem(value);
  return problem ? { problem } : { example: value };
}

/** The repository's branches, by name, with the commit each one points at. */
export function remoteHeads(git: GitRunner, repoDir: string): Map<string, string> {
  try {
    const heads = new Map<string, string>();
    for (const line of String(git(["ls-remote", "--heads", "origin"], repoDir) ?? "").split("\n")) {
      const [sha, ref] = line.split("\t");
      if (sha && ref?.startsWith("refs/heads/")) heads.set(ref.slice("refs/heads/".length), sha.trim());
    }
    return heads;
  } catch {
    // Best-effort: an offline failure here costs nothing, because the push itself still
    // reports what went wrong.
    return new Map();
  }
}

/** An unmerged branch that already raises the plugin past the default branch. */
export interface VersionClaim {
  branch: string;
  version: string;
}

function versionParts(version: string): number[] | null {
  const parts = version.split(".").map(Number);
  return parts.length === 3 && parts.every((n) => Number.isInteger(n) && n >= 0) ? parts : null;
}

/** Positive when `a` is the later version, null when either is not MAJOR.MINOR.PATCH. */
export function compareVersions(a: string, b: string): number | null {
  const x = versionParts(a);
  const y = versionParts(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

export function readPluginVersion(repoDir: string): string | undefined {
  try {
    const version = JSON.parse(readFileSync(join(repoDir, ".claude-plugin", "plugin.json"), "utf8"))?.version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every branch in the team repository that is not merged and already claims a plugin
 * version above the default branch's.
 *
 * Two requests that raise the same version both merge without a conflict - git sees the
 * identical line twice - and the second one reaches nobody, because the version it was
 * meant to move had already moved. That happened across commands: an abandoned branch from
 * one route and a share from another both carried the same raise, and only an attentive
 * reader noticed. A merge request is not needed to see it: the branch is enough, so this
 * asks git rather than a forge, in one shallow fetch for all of them. Best-effort and
 * silent: a repository it cannot read is a check it could not make, not a share to stop.
 */
export function openVersionClaims(
  git: GitRunner,
  repoDir: string,
  heads: Map<string, string>,
  current: string | undefined,
): VersionClaim[] {
  if (!current || !versionParts(current)) return [];
  try {
    const tip = String(git(["rev-parse", "HEAD"], repoDir) ?? "").trim();
    const others = [...heads].filter(([, sha]) => sha !== tip).map(([branch]) => branch);
    if (!others.length) return [];
    git(
      ["fetch", "--quiet", "--depth", "1", "origin", ...others.map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`)],
      repoDir,
    );
    const claims: VersionClaim[] = [];
    for (const branch of others) {
      let version: unknown;
      try {
        const manifest = git(["show", `refs/remotes/origin/${branch}:.claude-plugin/plugin.json`], repoDir);
        version = JSON.parse(String(manifest ?? ""))?.version;
      } catch {
        continue;
      }
      if (typeof version === "string" && (compareVersions(version, current) ?? 0) > 0) claims.push({ branch, version });
    }
    return claims;
  } catch {
    return [];
  }
}

function highest(versions: string[]): string | undefined {
  return versions.reduce<string | undefined>(
    (top, v) => (top === undefined || (compareVersions(v, top) ?? 0) > 0 ? v : top),
    undefined,
  );
}

/** The version this request takes when it goes past the claims: one patch above the highest. */
export function versionPast(current: string, claims: VersionClaim[]): string {
  const top = versionParts(highest([current, ...claims.map((c) => c.version)])!)!;
  return [top[0], top[1], top[2]! + 1].join(".");
}

function claimMessage(claims: VersionClaim[], current: string, rerun: string): string {
  const named = claims.map((c) => `"${c.branch}" (${c.version})`).join(", ");
  return (
    `the team repository has ${claims.length === 1 ? "a branch" : "branches"} that ${claims.length === 1 ? "is" : "are"} ` +
    `not merged and already raise${claims.length === 1 ? "s" : ""} the plugin past ${current}: ${named}. If this request ` +
    "raises it to the same number and both are merged, the second one reaches nobody - the version line merges as " +
    `identical and no teammate's copy refreshes for it. Either send this one as ${versionPast(current, claims)}, past ` +
    `${claims.length === 1 ? "it" : "them"} - ${rerun} with \`--version-after-open\` - or stop here and merge or close ` +
    `${claims.length === 1 ? "that branch" : "those branches"} first. Nothing was committed and nothing was pushed.`
  );
}

function shownBranch(proposal: BranchProposal): string {
  return "branch" in proposal
    ? `\`${proposal.branch}\``
    : `\`${proposal.template}\` (branches here look like \`${proposal.example}\`: which ticket is this?)`;
}

/**
 * The one question every push asks before it happens, as one line.
 *
 * Either half is left out once the user has answered it: `--branch` answers the first,
 * `--message` (or a delegation) the second, and a run given both asks nothing.
 */
export function pushQuestion(branch: BranchProposal | null, message: string | null): string {
  if (branch && message !== null) {
    return `Branch ${shownBranch(branch)} · message \`${message}\` - confirm or change either.`;
  }
  if (branch) return `Branch ${shownBranch(branch)} - confirm or change it.`;
  return `Message \`${message}\` - confirm or change it.`;
}

/** What one run decided, ready to push. */
export interface PushPlan {
  branch: string;
  subject: string;
  /** The versions unmerged branches claim, which the version raise has to go past. Empty
   * when nothing is in the way. */
  claims: VersionClaim[];
  /** Why no merge request can be opened from this machine, or null when one can. */
  forgeProblem: string | null;
}

/** What stopped one run before anything was committed. */
export interface PushRefusal {
  error: string;
  /** the name shown to the user, so the caller can hand it straight back */
  proposedBranch?: string;
  proposedMessage: string;
  proposalHash: string;
}

/**
 * What a push would look like, read from the clone before anything is decided: the name
 * it would propose, whether a merge request can be opened from here, and which unmerged
 * branches already claim a version. The decision below and the scaffold refresh's plan
 * both read it, so the screen that previews a push and the run that asks before pushing
 * cannot disagree about any of the three.
 */
export interface PushPreview {
  taken: ReadonlySet<string>;
  proposal: BranchProposal;
  forgeProblem: string | null;
  /** the default branch's plugin version, when it has one this can read */
  current?: string;
  claims: VersionClaim[];
}

export function previewPush(
  git: GitRunner,
  forge: ForgeRunner,
  repoDir: string,
  team: TeamConfig,
  slug: string,
  hints: BranchHints = {},
): PushPreview {
  const heads = remoteHeads(git, repoDir);
  const taken = new Set(heads.keys());
  const current = readPluginVersion(repoDir);
  return {
    taken,
    proposal: proposeBranch(slug, team, readTeamBranchExample(repoDir).example ?? team.branchExample, hints, taken),
    forgeProblem: forgeSignInProblem(team.repoUrl, repoDir, forge),
    ...(current ? { current } : {}),
    claims: openVersionClaims(git, repoDir, heads, current),
  };
}

/** The refusal that stops a push for a version another branch already claims, or null. */
export function versionClaimProblem(preview: PushPreview, rerun: string): string | null {
  return preview.claims.length && preview.current ? claimMessage(preview.claims, preview.current, rerun) : null;
}

export interface PushQuestionInput {
  git: GitRunner;
  forge: ForgeRunner;
  repoDir: string;
  team: TeamConfig;
  /** what the proposal is built from: the name of the thing being sent */
  slug: string;
  choice: PushChoice;
  message: CommitMessageChoice;
  proposedMessage: string;
  messagePrefix: string;
  /** how this particular command is run again */
  rerun: string;
}

/**
 * Everything a push needs decided, decided in one place: the branch, the commit message,
 * and what to do about a version another branch already claims.
 *
 * The refusal names every open question at once rather than one per run, so the user
 * answers a single screen - the branch, the message, and a version in the way - and the
 * second run is the one that pushes. It runs after the clone, because both the proposal
 * and the collision check read the branches that exist, and before the checkout, so a run
 * that stops leaves nothing behind.
 */
export function decidePush(input: PushQuestionInput): ({ ok: true } & PushPlan) | ({ ok: false } & PushRefusal) {
  const { git, repoDir, team, choice, message, proposedMessage, rerun } = input;
  const preview = previewPush(git, input.forge, repoDir, team, input.slug, choice.hints);
  const { forgeProblem } = preview;
  const decided = decideCommitSubject(
    message,
    proposedMessage,
    input.messagePrefix,
    rerun,
    forgeProblem ? noRequestPossible(forgeProblem) : undefined,
  );
  let branchShown: BranchProposal | null = null;
  let branchSaid: string | null = null;
  if (choice.branch === undefined) {
    // The proposal is built from names this machine did not write - a server, a skill
    // directory - so it is screened like a name the user typed, and one that fails is
    // neither shown nor handed back to be confirmed.
    const unusable = "branch" in preview.proposal ? branchNameProblem(preview.proposal.branch, git, repoDir) : null;
    branchShown = unusable ? null : preview.proposal;
    branchSaid = unusable
      ? `branch name required: the branch this would propose cannot be used (${unusable}), so ask the user for ` +
        `one and ${rerun} with \`--branch <name>\`.`
      : "branch name required: nothing is pushed under a name the user has not seen. Show it to them with the " +
        `message, then ${rerun} with \`--branch <name>\`: the one above if they confirmed it, or the one they gave.`;
  } else {
    const problem = branchNameProblem(choice.branch, git, repoDir);
    if (problem && branchTrace(choice.branch)) {
      // Not echoed and not handed back: the name is what carries the trace.
      branchSaid = `the branch given cannot be used: ${problem}. Ask for another and ${rerun} with \`--branch <name>\`.`;
    } else if (problem) {
      branchShown = { branch: choice.branch };
      branchSaid = `"${choice.branch}" cannot be the branch: ${problem}. Ask for another and ${rerun} with \`--branch <name>\`.`;
    } else if (preview.taken.has(choice.branch)) {
      // Never suffixed: the user named this branch, and "TEAM-12-2" is not a name they
      // chose. The branch that is there may carry a request of its own.
      branchShown = { branch: choice.branch };
      branchSaid =
        `the team repository already has a branch named "${choice.branch}", which may carry an open request of ` +
        `its own, so nothing was pushed over it and no other name was picked for you. Ask for another name and ` +
        `${rerun} with \`--branch <name>\`, or merge or delete that branch first.`;
    }
  }
  const claimSaid = choice.versionAfterOpen ? null : versionClaimProblem(preview, rerun);
  if (!("error" in decided) && !branchSaid && !claimSaid) {
    return { ok: true, branch: choice.branch!, subject: decided.subject, claims: preview.claims, forgeProblem };
  }
  // A proposal that cannot be a title is not shown either: the refusal below says why, and
  // the wording has to be the user's own.
  const asksMessage =
    "error" in decided &&
    message.message === undefined &&
    message.delegated === undefined &&
    commitMessageProblem(proposedMessage) === null;
  const asked = branchShown || asksMessage ? [pushQuestion(branchShown, asksMessage ? proposedMessage : null)] : [];
  return {
    ok: false,
    error: [
      ...asked,
      ...("error" in decided ? [decided.error] : []),
      ...(branchSaid ? [branchSaid] : []),
      ...(claimSaid ? [claimSaid] : []),
      // On the screen that asks, before anything is pushed: the user learns how the request
      // will reach the forge while they can still do something about it, not after the push.
      ...(asked.length && forgeProblem ? [forgeNotice(team.repoUrl, forgeProblem)] : []),
    ].join("\n"),
    ...(branchShown && "branch" in branchShown ? { proposedBranch: branchShown.branch } : {}),
    proposedMessage,
    proposalHash: proposalFingerprint(proposedMessage),
  };
}

/**
 * The push options that ask GitLab to open the merge request itself, or none.
 *
 * Only when glab cannot open it from here and the remote is a real host: GitLab honours
 * these on the push it receives, so a machine without the CLI still gets a request rather
 * than a link. A push option cannot carry a line break, so the title travels and the
 * description cannot.
 */
export function requestPushOptions(repoUrl: string, forgeProblem: string | null, title: string): string[] {
  if (!forgeProblem || forgeTool(repoUrl) !== "glab" || !hostFromUrl(repoUrl)) return [];
  return ["-o", "merge_request.create", "-o", `merge_request.title=${title}`, "-o", "merge_request.remove_source_branch"];
}

export interface Pushed {
  /** everything git printed, the forge's own reply included */
  output: string;
  /** whether the server accepted the push options this push carried */
  optionsSent: boolean;
}

/**
 * Push `ref` to the team repository, exactly as named, once.
 *
 * There is no retry under another name: a refused name goes back to the user with the
 * forge's own words. A server that does not take push options - one that is not GitLab
 * after all - refuses before any ref moves, so the plain push after it is the same push
 * without the request attached.
 */
export function pushBranch(git: GitRunner, repoDir: string, ref: string, options: string[] = []): Pushed {
  const push = (extra: string[]) => String(git(["push", ...extra, "origin", ref], repoDir) ?? "");
  if (!options.length) return { output: push([]), optionsSent: false };
  try {
    return { output: push(options), optionsSent: true };
  } catch (err) {
    if (!/does not support push options/i.test(String(err instanceof Error ? err.message : err))) throw err;
    return { output: push([]), optionsSent: false };
  }
}

/**
 * The merge request GitLab reports having opened for a push, or null.
 *
 * Only a request with a number counts. GitLab prints a "create a merge request" link on
 * every push of a new branch, with or without push options, and reading that as an opened
 * request would tell the user something exists that does not.
 */
export function openedRequestUrl(output: string): string | null {
  return output.match(/https?:\/\/\S+?\/-\/merge_requests\/\d+(?=\s|$)/)?.[0] ?? null;
}

export interface RequestOutcome {
  prUrl?: string;
  manualUrl?: string;
  prError?: string;
  /** The description the request should carry and could not, when GitLab opened it from a
   * push: the reviewer still needs it, so the caller prints it to be pasted in. */
  unattachedDescription?: string;
}

/** Open the merge request for a branch that has just been pushed, by whichever route this
 * machine has, and say honestly which one it was. */
export function openRequest(
  repoUrl: string,
  branch: string,
  title: string,
  body: string,
  repoDir: string,
  forge: ForgeRunner,
  forgeProblem: string | null,
  pushed: Pushed,
): RequestOutcome {
  const manualUrl = manualPrUrl(repoUrl, branch) ?? undefined;
  if (!forgeProblem) {
    const pr = openPr(repoUrl, branch, title, body, repoDir, forge);
    return pr.url ? { prUrl: pr.url } : { manualUrl, ...(pr.error ? { prError: pr.error } : {}) };
  }
  if (pushed.optionsSent) {
    const url = openedRequestUrl(pushed.output);
    if (url) return { prUrl: url, unattachedDescription: body };
    return { manualUrl, prError: `${forgeProblem}, and GitLab did not report opening a request for the push` };
  }
  return { manualUrl, prError: forgeProblem };
}

/**
 * Why a push to the team repository failed, in words the user can act on.
 *
 * A refused branch NAME is answered with the forge's own sentence and the same question
 * the run asked before it pushed, the refused name back in it to be changed. Nothing is
 * retried under a name of the product's choosing: the rule may be one the product reads
 * wrong, and the name is the user's. The refusal carries the name and the message so the
 * caller can put that question back on screen once, rather than once per item it carried.
 */
export function pushFailure(
  repoUrl: string,
  branch: string,
  subject: string,
  err: unknown,
  rerun: string,
  commitPrefixFix: string,
): { error: string; proposedBranch?: string; proposedMessage?: string } {
  const fix = [
    "Nothing reached the repository.",
    pushQuestion({ branch }, subject),
    `Ask for a name the rule accepts, then ${rerun} with \`--branch <name>\`.`,
  ].join("\n");
  const error = pushFailureReason(repoUrl, branch, err, fix, commitPrefixFix);
  return pushRuleSubject(String(err instanceof Error ? err.message : err)) === "branch-name"
    ? { error, proposedBranch: branch, proposedMessage: subject }
    : { error };
}

/** The few lines a result prints when a request went out without its description. */
export function unattachedDescriptionLines(description: string | undefined): string[] {
  if (!description) return [];
  return [
    "",
    "GitLab opened the request from the push, and a push cannot carry its description. Paste this into it:",
    "",
    ...description.split("\n").map((line) => (line ? `    ${line}` : "")),
  ];
}
