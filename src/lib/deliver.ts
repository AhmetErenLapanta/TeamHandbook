import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { loadTeamConfig, runGit, saveTeamConfig } from "./init.js";
import type { GitRunner, TeamConfig } from "./init.js";
import { renameSkillMd } from "./distill.js";
import { copySkillPayload } from "./skill-files.js";
import { conflictingOptions, mayUpdate, publishCandidate, runForge } from "./publish.js";
import type { Collision, ForgeRunner, PublishOptions } from "./publish.js";
import { handbookHome } from "./session-state.js";
import { candidatesDir } from "./skill-index.js";
import { isSafeSlug, readCandidateMeta, writeCandidateMeta } from "./queue.js";
import type { CandidateMeta } from "./queue.js";
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
  // skill was captured elsewhere) — so the "loads next session" claim can name where
  originProject?: string;
  // why a team PR could not be auto-opened (the branch is pushed; link is manual)
  prError?: string;
  // the branch prefix the forge forced this push to adopt, once, so it can be said out
  // loud instead of the branch quietly having a different name than the one reported
  learnedBranchPrefix?: string;
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
  if (resolved === "team") {
    if (!team) {
      return {
        ok: false,
        meta,
        error: "no team configured — run /handbook:init or /handbook:join first, or approve with --to personal",
      };
    }
    const delivered = deliverToTeam(dir, meta, team, decidedAt, git, forge, options);
    // The forge taught us its branch rule the only way it can: by refusing one. Remember
    // it here, where the home directory is known, so the next skill goes out first time.
    if (delivered.learnedBranchPrefix) {
      saveTeamConfig({ ...team, branchPrefix: delivered.learnedBranchPrefix }, home);
    }
    return delivered;
  }
  if (resolved === "personal") return deliverPersonal(dir, meta, decidedAt, personalDir, options);
  return deliverSolo(dir, meta, fallbackCwd, decidedAt, options);
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

/** Install into the user-level skills dir: available in every project, only for
 * this user. No origin-project logic — personal skills follow the person. */
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
  const updated: CandidateMeta = {
    ...meta,
    status: "approved",
    decidedAt,
    deliveredTo: placed.target,
    deliveredMode: "personal",
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
  const published = publishCandidate(dir, meta, team, git, forge, options);
  if (!published.ok) {
    return {
      ok: false,
      mode: "team",
      meta,
      error: published.error,
      ...(published.collision ? { collision: published.collision } : {}),
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
    prUrl: published.prUrl,
    ...(published.version ? { version: published.version } : {}),
    manualUrl: published.manualUrl,
    ...(published.prError ? { prError: published.prError } : {}),
    ...(published.learnedBranchPrefix ? { learnedBranchPrefix: published.learnedBranchPrefix } : {}),
  };
}

function deliverSolo(
  dir: string,
  meta: CandidateMeta,
  fallbackCwd: string,
  decidedAt: string,
  options: DeliveryOptions,
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
  // project the reviewer is in right now, name it — otherwise "loads next session"
  // is false for the session they will actually open.
  const installedProject = meta.cwd && existsSync(meta.cwd) ? meta.cwd : fallbackCwd;
  const originProject = installedProject !== fallbackCwd ? basename(installedProject) : undefined;
  const placed = installLocally(dir, meta, skillsDir, options);
  if ("error" in placed) {
    return { ok: false, mode: "solo", meta, error: placed.error, ...(placed.collision ? { collision: placed.collision } : {}) };
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
    ...(warning ? { warning } : {}),
    ...(originProject ? { originProject } : {}),
  };
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
          `It could not open the request for you (${result.prError}) — install and sign in to gh or glab and it will next time.`,
        );
      }
      if (result.manualUrl) lines.push(`Open it here, then merge: ${result.manualUrl}`);
    }
    if (result.updatedExisting) {
      lines.push("The merge replaces their copy, so review the removed lines too, not only the added ones.");
    }
    // The branch is not named what it would normally be named. Say so once, rather than
    // letting the reader find a different name than the one they expected in the forge.
    if (result.learnedBranchPrefix) {
      lines.push(
        `Your project refuses the default branch name, so this went out as ${result.branch}. ` +
          "That prefix is remembered — later skills use it straight away.",
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
    const commit = result.originProject
      ? "Commit it there so the skill travels with that repo."
      : "Commit this directory so the skill travels with the repo.";
    lines.push(`Approved "${name}" and installed it at ${landedAt}. ${loads}. ${commit}`);
  }
  if (result.updatedExisting) {
    lines.push(`This replaced the "${name}" that was already there.`);
  }
  return lines.join("\n");
}
