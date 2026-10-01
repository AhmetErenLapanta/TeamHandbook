import { existsSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  decideCommitSubject,
  loadTeamConfig,
  proposalFingerprint,
  runGit,
  saveTeamConfig,
} from "./init.js";
import type { GitRunner, TeamConfig } from "./init.js";
import { renameSkillMd } from "./distill.js";
import { copySkillPayload } from "./skill-files.js";
import { conflictingOptions, mayUpdate, publishCandidate, runForge } from "./publish.js";
import type { Collision, ForgeRunner, PublishOptions } from "./publish.js";
import { handbookHome } from "./session-state.js";
import { candidatesDir } from "./skill-index.js";
import {
  auditSkillDir,
  identityInSkillDir,
  isSafeSlug,
  readCandidateMeta,
  secretInSkillDir,
  skillRefusalMessage,
  writeCandidateMeta,
} from "./queue.js";
import type { CandidateMeta } from "./queue.js";
import type { IdentityClass } from "./identity.js";
import { displayPath } from "./display-path.js";

export function soloSkillsDir(projectCwd: string): string {
  return join(projectCwd, ".claude", "skills");
}

/** User-level skills: Claude Code loads these in every project. The "keep it for
 * yourself" home for general lessons. */
export function personalSkillsDir(): string {
  return join(homedir(), ".claude", "skills");
}

export type DeliveryTarget = "personal" | "project" | "team";

/** The project a skill installs into: the one it was captured in, with the reviewer's
 * own project standing in only when that origin is gone. One definition, because the
 * label below has to answer from the same rule the copy obeys - a second copy of this
 * condition is exactly how the text came to promise a directory the copy never used. */
function deliveryOrigin(
  meta: CandidateMeta,
  fallbackCwd: string,
  dirExists: (path: string) => boolean = existsSync,
): string {
  return meta.cwd && dirExists(meta.cwd) ? meta.cwd : fallbackCwd;
}

export function resolveDeliveryDir(
  meta: CandidateMeta,
  fallbackCwd: string,
  dirExists: (path: string) => boolean = existsSync,
): string {
  return soloSkillsDir(deliveryOrigin(meta, fallbackCwd, dirExists));
}

/** How the "add it to a project" option must read BEFORE it is picked. The reviewer
 * decides from the option text, and a candidate harvested in another project installs
 * there, not where they are standing - so when the two differ the text names the origin
 * instead of saying "this". approveAndDeliver reports that project too (originProject),
 * but only after the copy, which is one decision too late to change the answer. */
export function projectTargetLabel(
  meta: CandidateMeta,
  fallbackCwd: string,
  dirExists: (path: string) => boolean = existsSync,
): string {
  const origin = deliveryOrigin(meta, fallbackCwd, dirExists);
  if (origin === fallbackCwd) return "this project's .claude/skills";
  // The bare name, not the absolute path: it is what the reviewer recognizes, and the
  // full path is already on the line the CLI prints once the skill has landed.
  return `${basename(origin)}'s .claude/skills (where it was captured, not this project)`;
}

export interface DeliverResult {
  ok: boolean;
  mode?: "solo" | "personal" | "team";
  meta?: CandidateMeta;
  deliveredTo?: string;
  branch?: string;
  prUrl?: string;
  version?: string;
  manualUrl?: string;
  error?: string;
  // set when solo delivery could not use the origin project and fell back to cwd
  warning?: string;
  // set when solo delivery landed in a DIFFERENT project than the current one (the
  // skill was captured elsewhere) - so the "loads next session" claim can name where
  originProject?: string;
  // why a team PR could not be auto-opened (the branch is pushed; link is manual)
  prError?: string;
  // the branch prefix the forge forced this push to adopt, once, so it can be said out
  // loud instead of the branch quietly having a different name than the one reported
  learnedBranchPrefix?: string;
  // the commit prefix this push read out of the team repository, for a machine that joined
  // before the repository recorded one; the caller persists it
  learnedCommitPrefix?: string;
  // The name the skill was actually filed under. It is not always the one the reviewer
  // typed, and for a year it was nowhere in this type: publishCandidate picked
  // skills/foo-2, deliver dropped the field on the way through, and the CLI printed the
  // reviewer's own spelling back at them. Somebody who fixes a rule and re-sends it was
  // told their correction had reached the team while the team still had the old one.
  deliveredSlug?: string;
  // set when this delivery rewrote a skill that was already there, which only ever
  // happens because the reviewer asked for it a second time, knowing
  updatedExisting?: boolean;
  // the destination already has this name and NOTHING was written; the reviewer decides
  collision?: Collision;
  // the subject the team commit was made with, prefix included
  commitMessage?: string;
  // the subject a team delivery would commit with, carried on the refusal that asks the
  // reviewer to decide the wording; absent on every other refusal
  proposedMessage?: string;
  // its fingerprint, which a delegated approval has to name back
  proposalHash?: string;
}

/** How a reviewer answers a refusal: send it as an update to what is there, or under a
 * different name. Absent on the first attempt, which is why the refusal exists. */
export type DeliveryOptions = PublishOptions;

export function approveAndDeliver(
  home: string = handbookHome(),
  slug: string,
  fallbackCwd: string = process.cwd(),
  decidedAt: string = new Date().toISOString(),
  team: TeamConfig | null = loadTeamConfig(home),
  git: GitRunner = runGit,
  forge: ForgeRunner = runForge,
  target?: DeliveryTarget,
  personalDir: string = personalSkillsDir(),
  options: DeliveryOptions = {},
): DeliverResult {
  if (!isSafeSlug(slug)) return { ok: false, error: `invalid candidate name "${slug}"` };
  if (options.as !== undefined && !isSafeSlug(options.as)) {
    return { ok: false, error: `"${options.as}" cannot be a skill name (lowercase letters, digits and dashes)` };
  }
  // Before the candidate is read, and before any destination is touched: this pair can
  // delete a skill the reviewer was never shown.
  const conflict = conflictingOptions(options);
  if (conflict) return { ok: false, error: conflict };
  const dir = join(candidatesDir(home), slug);
  const meta = readCandidateMeta(dir);
  if (!meta) return { ok: false, error: `no candidate named "${slug}"` };
  if (meta.status !== "pending") {
    return { ok: false, meta, error: `candidate "${slug}" is already ${meta.status}` };
  }
  // The per-skill decision: an explicit --to wins, then the harvest's suggestion,
  // then the legacy default (team when configured, else the project).
  const resolved: DeliveryTarget = target ?? meta.suggestedTarget ?? (team ? "team" : "project");
  // A commit message means nothing anywhere but the team, where a commit is made. Said
  // out loud rather than dropped: a reviewer who asked their wording to go somewhere and
  // was told nothing would believe it had. The check is on the RESOLVED target, so a
  // plain `approve` that the harvest suggests keeping personally is caught too.
  const wording = options.commitMessage ?? {};
  // A draft mined from a repository's history goes back into that repository, and a
  // project skill is a tracked file there, so this one approval makes a commit without
  // opening a merge request. It is the only project delivery with a wording to ask about;
  // every other one still copies files and is told so below.
  const commitsLocally = resolved === "project" && meta.origin === "mine";
  if (resolved !== "team" && !commitsLocally && (wording.message !== undefined || wording.delegated !== undefined)) {
    return {
      ok: false,
      meta,
      error:
        `this approval installs "${slug}" into ${resolved === "personal" ? "your own skills" : "the project"}, ` +
        "which copies files and makes no commit, so there is no commit message to give. Approve with " +
        "--to team for a message to have somewhere to go, or drop the flag. Nothing was written.",
    };
  }
  if (resolved === "team") {
    if (!team) {
      return {
        ok: false,
        meta,
        error: "no team configured - run /handbook:init or /handbook:join first, or approve with --to personal",
      };
    }
    const delivered = deliverToTeam(dir, meta, team, decidedAt, git, forge, options);
    // The forge taught us its branch rule the only way it can: by refusing one, and the
    // repository told us the commit rule by recording it. Remember both here, where the
    // home directory is known, so the next skill goes out first time - and in one save,
    // because two saves from the same stale `team` lose whichever was written first.
    const learned = {
      ...(delivered.learnedBranchPrefix ? { branchPrefix: delivered.learnedBranchPrefix } : {}),
      ...(delivered.learnedCommitPrefix !== undefined ? { commitPrefix: delivered.learnedCommitPrefix } : {}),
    };
    if (Object.keys(learned).length) saveTeamConfig({ ...team, ...learned }, home);
    return delivered;
  }
  if (resolved === "personal") return deliverPersonal(dir, meta, decidedAt, personalDir, options);
  return deliverSolo(dir, meta, fallbackCwd, decidedAt, options, commitsLocally ? git : undefined);
}

/**
 * Write the skill into a local skills directory and report the name it landed under.
 *
 * A name already taken here is refused, exactly as the team path refuses it. The first
 * version of this function suffixed instead, on the reasoning that the suffix was at least
 * VISIBLE locally (the CLI prints the target path, so `.../skills/foo-2` was on screen).
 * That reasoning was wrong in a way only running it shows: suffixing DELIVERS, so the
 * candidate is `approved` by the time the message suggests `--update`, and `approved` is
 * terminal - no path in queue.ts returns a candidate to `pending`. The product printed a
 * command that answered with "already approved" and left the user holding the two
 * disagreeing skills this refusal exists to prevent. Refusing costs an operation that
 * can now fail; it buys a refusal the user can actually act on, with the candidate still
 * waiting for them.
 */
function installLocally(
  dir: string,
  meta: CandidateMeta,
  skillsDir: string,
  options: DeliveryOptions,
): { slug: string; target: string; updatedExisting: boolean } | { error: string; collision?: Collision } {
  const slug = options.as ?? meta.slug;
  const target = join(skillsDir, slug);
  const occupied = existsSync(target);
  const updatedExisting = occupied && mayUpdate(options, slug);
  if (occupied && !updatedExisting) {
    return { error: localCollisionMessage(slug, skillsDir, options.as !== undefined), collision: { kind: "skill", name: slug } };
  }
  try {
    // read before creating the target: an unreadable candidate must not leave an
    // empty skill dir behind
    const skillMd = readFileSync(join(dir, "SKILL.md"), "utf8");
    // An update replaces what is there rather than merging into it, so a file the new
    // version dropped does not stay behind and keep being read.
    if (updatedExisting) rmSync(target, { recursive: true, force: true });
    // rewrite the frontmatter name when the directory name is not the candidate's own, so
    // it doesn't shadow the skill it collided with
    copySkillPayload(dir, target, slug === meta.slug ? skillMd : renameSkillMd(skillMd, slug));
  } catch (err) {
    return { error: `delivery failed: ${String(err)}` };
  }
  return { slug, target, updatedExisting };
}

/**
 * The local refusal, which has to name a route that works.
 *
 * It says the directory out loud because, unlike the team repository, this one is on the
 * reviewer's own disk and they can look. And it warns before the choice rather than after
 * it: a local `--update` is an immediate rmSync with no merge request in front of it and
 * nothing to revert from.
 */
function localCollisionMessage(name: string, skillsDir: string, chosen: boolean): string {
  const taken = `a skill named "${name}" is already installed at ${displayPath(join(skillsDir, name))}. Nothing was written.`;
  const warning =
    "Replacing it happens immediately and cannot be undone - there is no merge request in front of a local install.";
  return chosen
    ? `${taken} Pick a name nothing has taken with --as, or drop --as and approve with --update to replace the skill this candidate collided with. ${warning}`
    : `${taken} Approve again with --update to replace it, or with --as <name> to install this one under a different name. ${warning}`;
}

/** The fields every successful delivery reports about the name it used. */
function namedAs(
  placed: { slug: string; updatedExisting: boolean },
): Pick<DeliverResult, "deliveredSlug" | "updatedExisting"> {
  return {
    deliveredSlug: placed.slug,
    ...(placed.updatedExisting ? { updatedExisting: true } : {}),
  };
}

/**
 * The trace of this machine in the candidate about to be delivered, under the name it
 * will be delivered as.
 *
 * What is done with the answer depends on WHERE it is going, and that is the whole of the
 * rule: a project copy is committed to a repository other people read, so a trace there is
 * refused exactly as the team route refuses it, while a personal copy never leaves this
 * machine and the path in it may be the reviewer's own working directory - refusing that
 * would take a working skill away over a trace that is true and useful where it lands.
 */
function traceInCandidate(dir: string, meta: CandidateMeta, options: DeliveryOptions) {
  return identityInSkillDir(dir, options.as ?? meta.slug);
}

function identityRefusal(dir: string, slug: string, trace: { class: IdentityClass; where: string }): string {
  return skillRefusalMessage(displayPath(dir), slug, {
    shareable: false,
    reason: "identity",
    detail: trace.class,
    identity: trace,
  });
}

/** Install into the user-level skills dir: available in every project, only for
 * this user. No origin-project logic - personal skills follow the person. */
export function deliverPersonal(
  dir: string,
  meta: CandidateMeta,
  decidedAt: string,
  skillsDir: string = personalSkillsDir(),
  options: DeliveryOptions = {},
): DeliverResult {
  const placed = installLocally(dir, meta, skillsDir, options);
  if ("error" in placed) {
    return { ok: false, mode: "personal", meta, error: placed.error, ...(placed.collision ? { collision: placed.collision } : {}) };
  }
  const trace = traceInCandidate(dir, meta, options);
  const secret = secretInSkillDir(dir);
  const updated: CandidateMeta = {
    ...meta,
    status: "approved",
    decidedAt,
    deliveredTo: placed.target,
    deliveredMode: "personal",
    // Recorded, not refused: this copy stays on the machine the trace names, and a secret in
    // it is the reviewer's own. The record is what the reviewer sees if they later decide it
    // should go to a project or the team.
    ...(trace || secret
      ? {
          hygiene: {
            ...(trace ? { identity: trace.class, where: trace.where } : {}),
            ...(secret ? { secret } : {}),
          },
        }
      : {}),
  };
  writeCandidateMeta(dir, updated);
  return {
    ok: true,
    mode: "personal",
    meta: updated,
    deliveredTo: placed.target,
    ...namedAs(placed),
  };
}

function deliverToTeam(
  dir: string,
  meta: CandidateMeta,
  team: TeamConfig,
  decidedAt: string,
  git: GitRunner,
  forge: ForgeRunner,
  options: DeliveryOptions,
): DeliverResult {
  // A team skill reaches everyone who installs the plugin, and a candidate can be edited in the
  // queue after the harvest or the miner screened it, so this door audits it exactly as the
  // share door does - before a clone exists for a credential to be copied into.
  const refusal = auditRefusal(dir, options.as ?? meta.slug);
  if (refusal) return { ok: false, mode: "team", meta, error: refusal };
  const published = publishCandidate(dir, meta, team, git, forge, options);
  if (!published.ok) {
    return {
      ok: false,
      mode: "team",
      meta,
      error: published.error,
      ...(published.collision ? { collision: published.collision } : {}),
      ...(published.proposedMessage ? { proposedMessage: published.proposedMessage } : {}),
      ...(published.proposalHash ? { proposalHash: published.proposalHash } : {}),
    };
  }
  const deliveredTo = published.prUrl ?? `${team.repoUrl} (branch ${published.branch})`;
  const updated: CandidateMeta = { ...meta, status: "approved", decidedAt, deliveredTo, deliveredMode: "team" };
  writeCandidateMeta(dir, updated);
  return {
    ok: true,
    mode: "team",
    meta: updated,
    deliveredTo,
    ...(published.skillSlug ? { deliveredSlug: published.skillSlug } : {}),
    ...(published.updatedExisting ? { updatedExisting: true } : {}),
    branch: published.branch,
    commitMessage: published.commitMessage,
    prUrl: published.prUrl,
    ...(published.version ? { version: published.version } : {}),
    manualUrl: published.manualUrl,
    ...(published.prError ? { prError: published.prError } : {}),
    ...(published.learnedBranchPrefix ? { learnedBranchPrefix: published.learnedBranchPrefix } : {}),
    ...(published.learnedCommitPrefix !== undefined ? { learnedCommitPrefix: published.learnedCommitPrefix } : {}),
  };
}

function deliverSolo(
  dir: string,
  meta: CandidateMeta,
  fallbackCwd: string,
  decidedAt: string,
  options: DeliveryOptions,
  commit?: GitRunner,
): DeliverResult {
  // Surface a fall-back honestly: installing into the wrong project silently is
  // worse than a warning the reviewer can act on.
  const originGone = !!meta.cwd && !existsSync(meta.cwd);
  const noOrigin = !meta.cwd;
  const skillsDir = resolveDeliveryDir(meta, fallbackCwd);
  const warning =
    originGone || noOrigin
      ? `origin project ${meta.cwd ? `"${displayPath(meta.cwd)}" no longer exists` : "was not recorded"}; installed into the current project instead (${displayPath(skillsDir)})`
      : undefined;
  // The skill installs into the project where it was captured. If that is not the
  // project the reviewer is in right now, name it - otherwise "loads next session"
  // is false for the session they will actually open.
  const installedProject = meta.cwd && existsSync(meta.cwd) ? meta.cwd : fallbackCwd;
  const originProject = installedProject !== fallbackCwd ? basename(installedProject) : undefined;
  // Before anything is written: a project skill is committed with the repository, so this
  // copy travels to everyone who clones it - the same journey the team route makes, taken
  // through the reviewer's own commit instead of a merge request.
  // The wording is decided before any screen runs and before anything is written, so a
  // reviewer who has not been asked yet is asked while the candidate is still untouched.
  const named = options.as ?? meta.slug;
  let subject: string | undefined;
  if (commit) {
    const proposal = projectCommitProposal(named);
    const decided = decideCommitSubject(
      options.commitMessage ?? {},
      proposal,
      "",
      "approve it again",
      NO_REQUEST_HERE,
    );
    if ("error" in decided) {
      return {
        ok: false,
        mode: "solo",
        meta,
        error: decided.error,
        proposedMessage: proposal,
        proposalHash: proposalFingerprint(proposal),
      };
    }
    subject = decided.subject;
  }
  // A committed skill is read by everyone who clones the repository, which is the journey
  // the share door screens for. The draft was screened when it was written, but a candidate
  // can be edited in the queue after that, so the last word is here.
  if (commit) {
    const refusal = auditRefusal(dir, named);
    if (refusal) return { ok: false, mode: "solo", meta, error: refusal };
  }
  const trace = traceInCandidate(dir, meta, options);
  if (trace) {
    return { ok: false, mode: "solo", meta, error: identityRefusal(dir, named, trace) };
  }
  const placed = installLocally(dir, meta, skillsDir, options);
  if ("error" in placed) {
    return { ok: false, mode: "solo", meta, error: placed.error, ...(placed.collision ? { collision: placed.collision } : {}) };
  }
  if (commit && subject !== undefined) {
    const failure = commitProjectSkill(commit, installedProject, placed.target, subject);
    if (failure) {
      // Nothing is left behind that the candidate no longer accounts for: the skill is
      // only installed because it was about to be committed, and `approved` is terminal,
      // so a candidate left pending has to be left with nothing written for it either.
      // The empty directories go too, or the refusal's "nothing was installed" is a lie
      // the next `ls` catches.
      uninstall(placed.target, skillsDir);
      return { ok: false, mode: "solo", meta, error: failure };
    }
  }
  const updated: CandidateMeta = {
    ...meta,
    status: "approved",
    decidedAt,
    deliveredTo: placed.target,
    deliveredMode: "solo",
  };
  writeCandidateMeta(dir, updated);
  return {
    ok: true,
    mode: "solo",
    meta: updated,
    deliveredTo: placed.target,
    ...namedAs(placed),
    ...(subject !== undefined ? { commitMessage: subject } : {}),
    ...(warning ? { warning } : {}),
    ...(originProject ? { originProject } : {}),
  };
}

/**
 * Why a candidate may not be handed to other people, or null when it may.
 *
 * The share door's own audit, so the doors that send a skill somewhere cannot drift apart.
 * Every refusal refuses, not only the secret one: the audit stops at its first finding and the
 * secret scan comes last, so a symlink or a broken frontmatter answers before a single file has
 * been read - and a symlink the copy then skips is the silent pruning the share door exists to
 * refuse. The message names the class and the file, never the value.
 */
function auditRefusal(dir: string, named: string): string | null {
  const audit = auditSkillDir(dir);
  return audit.shareable ? null : skillRefusalMessage(displayPath(dir), named, audit);
}

/** Why "you decide" is not an answer on this route: there is no merge request for it to
 * be an answer about. The commit is made in the user's own repository and goes nowhere. */
const NO_REQUEST_HERE =
  "a project skill is committed into this repository itself, so there is no merge request to open";

export function projectCommitProposal(slug: string): string {
  return `add the ${slug} skill, drafted from this repository's history`;
}

/**
 * Commit the installed skill, and nothing else that happens to be in the tree.
 *
 * Pathspec-scoped on both halves: `git commit` with no paths would sweep up whatever the
 * user had already staged and put the product's message on it. The user's own work in
 * progress is not part of this delivery and must still be theirs afterwards.
 */
function commitProjectSkill(git: GitRunner, repoDir: string, target: string, subject: string): string | null {
  const path = relative(repoDir, target);
  try {
    git(["add", "--", path], repoDir);
    git(["commit", "--only", "-m", subject, "--", path], repoDir);
  } catch (err) {
    const reason = (err as Error).message;
    // A repository that ignores this directory is an ordinary repository, not a broken
    // one, and `-f` is not the answer: the repository has said it does not want these
    // files tracked, and a skill forced past that is a skill its own team deletes again.
    // The reviewer is told what to change and keeps their candidate.
    if (/ignored by one of your .gitignore|Use -f if you really want/.test(reason)) {
      return (
        `${displayPath(target)} is ignored by this repository's .gitignore, so a project skill cannot be ` +
        "committed there. Nothing was written and the candidate is still waiting. Either allow the path " +
        "and approve it again, or keep this one for yourself with `--to personal`, which installs " +
        "without committing. Allowing it takes two lines, because git cannot re-include anything " +
        "inside a directory that was excluded outright: replace the `.claude` rule with `.claude/*` " +
        "and add `!.claude/skills/` under it."
      );
    }
    return (
      `the skill could not be committed to ${displayPath(target)}: ${reason}. ` +
      "Nothing was written and the candidate is still pending, so fix the repository and approve it again."
    );
  }
  return null;
}

/**
 * Undo an install that was only made in order to be committed.
 *
 * The directories it created go with it, but only while they are empty: `.claude/skills`
 * usually holds other skills, and a failed delivery must not take them.
 */
function uninstall(target: string, skillsDir: string): void {
  rmSync(target, { recursive: true, force: true });
  for (const dir of [skillsDir, dirname(skillsDir)]) {
    try {
      rmdirSync(dir);
    } catch {
      return; // not empty, or not ours: stop climbing
    }
  }
}

/**
 * What the reviewer is told after a verdict lands.
 *
 * It lives here rather than in the CLI because the one thing it has to get right is a
 * field of DeliverResult, and a message built where nothing can test it is how the
 * suffix went unreported in the first place: publishCandidate returned
 * `skillDir: "skills/foo-2"`, the conversion dropped it, and the line below printed the
 * name the reviewer had typed. Every sentence here names the skill by what was written.
 */
export function formatApproveResult(slug: string, result: DeliverResult): string {
  const name = result.deliveredSlug ?? slug;
  // Every ok result carries deliveredTo, but the type does not promise it: shortening it
  // for display must not turn a delivery that forgot the field into a crash on the
  // success line.
  const landedAt = result.deliveredTo ? displayPath(result.deliveredTo) : "(not recorded)";
  const lines: string[] = [];
  if (result.mode === "team") {
    // What the reader needs is not "it worked" but what is now true and what is left for
    // them: a request exists, it carries the version teammates update to, and nothing
    // reaches anyone until a human merges it.
    const bump = result.version
      ? ` It also raises the handbook to v${result.version}, which is what makes teammates' copies refresh.`
      : "";
    const what = result.updatedExisting
      ? `Sent "${name}" to the team as an update to the skill they already had`
      : `Shared "${name}" with the team`;
    if (result.prUrl) {
      lines.push(`${what}: ${result.prUrl}`);
      lines.push(`Merge that request and every teammate gets it at their next session.${bump}`);
    } else {
      lines.push(`${what} on branch ${result.branch}.${bump}`);
      if (result.prError) {
        lines.push(
          `It could not open the request for you (${result.prError}) - install and sign in to gh or glab and it will next time.`,
        );
      }
      if (result.manualUrl) lines.push(`Open it here, then merge: ${result.manualUrl}`);
    }
    if (result.updatedExisting) {
      lines.push("The merge replaces their copy, so review the removed lines too, not only the added ones.");
    }
    // What the commit says, in the reviewer's own words when they gave any: the request
    // is theirs, and the sentence on it is the one thing about it they were asked for.
    if (result.commitMessage) lines.push(`The commit says: ${result.commitMessage}`);
    // The branch is not named what it would normally be named. Say so once, rather than
    // letting the reader find a different name than the one they expected in the forge.
    if (result.learnedBranchPrefix) {
      lines.push(
        `Your project refuses the default branch name, so this went out as ${result.branch}. ` +
          "That prefix is remembered - later skills use it straight away.",
      );
    }
    return lines.join("\n");
  }
  if (result.mode === "personal") {
    lines.push(
      `Kept "${name}" for you at ${landedAt}. Claude will load it in every project from your next session.`,
    );
  } else {
    if (result.warning) lines.push(`Note: ${result.warning}`);
    const loads = result.originProject
      ? `Claude will load it in ${result.originProject} (where it was captured) next session`
      : "Claude will load it next session";
    // "this directory" is only the right repo to commit when the skill landed here; when
    // it landed in the project it was captured in, that is the repo the skill travels with.
    // A mined draft was committed by this very approval, so telling its reviewer to go and
    // commit it sends them to look for a change that is already in their log.
    const commit = result.commitMessage
      ? `It is committed, so it already travels with the repo. The commit says: ${result.commitMessage}`
      : result.originProject
        ? "Commit it there so the skill travels with that repo."
        : "Commit this directory so the skill travels with the repo.";
    lines.push(`Approved "${name}" and installed it at ${landedAt}. ${loads}. ${commit}`);
  }
  if (result.updatedExisting) {
    lines.push(`This replaced the "${name}" that was already there.`);
  }
  return lines.join("\n");
}
