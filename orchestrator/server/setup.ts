import release from "../../package.json" with { type: "json" };
import type { VersionLineBack } from "./versions.js";
import { AGENT_PATHS, ownerLines, ownerRules, ownersOf } from "./codeowners.js";
import { assertSafeGitUrl, assignmentRecordProblem, branchExampleProblem, checkSkillFormat, compareVersions, detectSecret, marketplaceNameProblem, MAX_BODY_LINES, MAX_DESC, MAX_LISTING, MAX_NAME, MIN_STEPS, MIN_TRIGGER_SENTENCES, MIN_VERIFY_ITEMS, PLUGIN_MANIFEST, README_BEGIN, README_END, scaffoldVersionProblem, TEAM_PREFIX_FILE } from "./plugin.js";

/** One thing the setup panel says about a team repository: what is so, and what to do when something is to be done. */
export interface SetupFinding {
  /**
   * "ok" needs nothing; "attention" works but leaves teammates short of something; "problem" stops
   * something from working; "suggestion" is hardening a team chooses, which nothing lacks without.
   */
  level: "ok" | "attention" | "problem" | "suggestion";
  title: string;
  /** One sentence on what it means for teammates. */
  detail?: string;
  next?: string;
  /** The technical side - files, names, versions - for whoever asks, shown folded. */
  more?: string;
  /** A scaffold refresh fixes it, the one the orchestrator opens itself or /handbook:init --upgrade on a teammate's machine. */
  refresh?: true;
}

/** What the setup panel reads from a team repository's tree at one commit. */
export interface SetupInput {
  plugin: { name?: string; version?: string };
  marketplace: { name?: string; owner?: string; plugins: string[] };
  /** The team file as parsed, null when there is none, `problem` when it is not a JSON object. */
  team: { commitPrefix?: string; commitPrefixProblem?: string; branchExample?: string; reviewers?: string[]; labels?: string[]; scaffoldVersion?: string; problem?: string } | null;
  readme: string | null;
  /** Every path in the tree, folders included. */
  paths: ReadonlySet<string>;
  /** The commit that put the version line back after the repository was versioned by commit, when one did. */
  versionBack?: VersionLineBack | null;
  /** Each version-bump job file the repository holds, GitLab's and GitHub's. */
  ciJobs?: string[];
  /** The CODEOWNERS file the forge reads, null when there is none; left out, nothing is said about owners. */
  codeowners?: { path: string; text: string } | null;
}

/** Where /handbook:init writes the optional version-bump job, for GitLab and for GitHub. */
export const CI_JOB_FILES = [".gitlab-ci.yml", ".github/workflows/version-bump.yml"];

/**
 * Whether a version-bump job is the shape written before the commit prefix moved into a
 * variable: one that commits with the prefix written into its shell line.
 */
export function ciJobCarriesPrefix(text: string): boolean {
  return /git commit -am "(?!\$BUMP_MESSAGE")/.test(text);
}

/** The TeamHandbook release this orchestrator was built with, the one a scaffold refresh from here would write. */
export const ORCHESTRATOR_RELEASE: string = release.version;

const REFRESH = "Update TeamHandbook's files from this page, which opens the request for you, or run /handbook:init --upgrade from a teammate's machine.";
const REFRESH_MORE = "The update rewrites the plugin and marketplace manifests, the README's TeamHandbook section and hooks/, and leaves skills, commands and .mcp.json alone.";

/** The entries of a reviewers or labels list the plugin's rule leaves off a request. */
function dropped(kind: "reviewers" | "labels", list: string[] | undefined): string[] {
  return (list ?? []).filter((entry) => assignmentRecordProblem({ [kind]: [entry] }) !== null);
}

/**
 * The team repository's setup as a team lead reads it: whether teammates can join and install
 * it, how far its scaffold is behind this orchestrator's TeamHandbook, what of the scaffold is
 * missing, and what a request leaves out. Each finding says what it means for teammates and,
 * when something is to be done, what. The rules are the plugin's own (join, init, upgrade).
 */
export function setupFindings(input: SetupInput): SetupFinding[] {
  const findings: SetupFinding[] = [];
  const { plugin, marketplace, team } = input;

  const market = marketplace.name;
  const marketProblem = market === undefined ? "missing" : marketplaceNameProblem(market);
  if (marketProblem === "missing") {
    findings.push({ level: "problem", title: "Teammates cannot join yet", detail: ".claude-plugin/marketplace.json is missing or names no marketplace, so /handbook:join refuses this repository.", next: "Set the repository up with /handbook:init, which writes the marketplace with the plugin in it." });
  } else if (marketProblem) {
    findings.push({ level: "problem", title: "Teammates cannot join", detail: `The marketplace is named ${JSON.stringify(market)}, which is ${marketProblem}, so /handbook:join refuses this repository.`, next: "Rename it in .claude-plugin/marketplace.json before anyone subscribes: teammates subscribe by that name." });
  } else if (!plugin.name) {
    findings.push({ level: "problem", title: "Teammates have nothing to install", detail: ".claude-plugin/plugin.json is missing or names no plugin.", next: "Set the repository up with /handbook:init." });
  } else if (!marketplace.plugins.includes(plugin.name)) {
    findings.push({ level: "problem", title: "Teammates cannot install the plugin", detail: `The marketplace ${market} does not list the plugin ${plugin.name}, so /plugin install ${plugin.name}@${market} finds nothing.`, next: `Add ${plugin.name} under plugins in .claude-plugin/marketplace.json.` });
  } else {
    findings.push({ level: "ok", title: "Teammates can install it", more: `Marketplace ${market}${marketplace.owner ? `, owned by ${marketplace.owner}` : ""}; plugin ${plugin.name}${marketplace.plugins.length > 1 ? `; the marketplace also lists ${marketplace.plugins.filter((p) => p !== plugin.name).join(", ")}` : ""}.` });
  }

  if (team === null) {
    findings.push({ level: "attention", title: `No ${TEAM_PREFIX_FILE}`, detail: "This repository was set up before TeamHandbook recorded a team file, so teammates' requests carry no team prefix, naming, reviewers or labels.", next: REFRESH, more: REFRESH_MORE, refresh: true });
  } else if (team.problem) {
    findings.push({ level: "problem", title: `${TEAM_PREFIX_FILE} cannot be read`, detail: `${team.problem}; teammates' TeamHandbook reads none of it.`, next: `Fix ${TEAM_PREFIX_FILE} in the repository.` });
  } else {
    const prefixProblem = team.commitPrefixProblem ?? null;
    if (prefixProblem) findings.push({ level: "problem", title: "The commit prefix is not used", detail: `The one recorded is ${prefixProblem}, so teammates' TeamHandbook and this orchestrator leave it out, and their commits go without the prefix the forge expects.`, next: `Fix commitPrefix in ${TEAM_PREFIX_FILE}, or set it under Edit naming.` });
    const exampleProblem = team.branchExample === undefined || !team.branchExample.trim() ? null : branchExampleProblem(team.branchExample.trim());
    if (exampleProblem) findings.push({ level: "problem", title: "The example branch name is not used", detail: `It is ${exampleProblem}, so teammates' and the orchestrator's requests are not named the team's way.`, next: `Fix branchExample in ${TEAM_PREFIX_FILE}.` });
    if (!prefixProblem && !exampleProblem) {
      const naming = [team.commitPrefix ? `commits start with ${team.commitPrefix}` : "commits carry no prefix", team.branchExample ? `branches are named like ${team.branchExample}` : "branches carry no team naming"];
      findings.push({ level: "ok", title: "Changes follow the team's naming", detail: `${naming.join("; ").replace(/^./, (c) => c.toUpperCase())}.` });
    }
    const unusedReviewers = dropped("reviewers", team.reviewers);
    const unusedLabels = dropped("labels", team.labels);
    if (unusedReviewers.length || unusedLabels.length) {
      const parts = [unusedReviewers.length ? `reviewers ${unusedReviewers.join(", ")}` : "", unusedLabels.length ? `labels ${unusedLabels.join(", ")}` : ""].filter(Boolean);
      findings.push({ level: "attention", title: "Some reviewers or labels are left off requests", detail: `The plugin's rule drops ${parts.join(" and ")}.`, next: "Correct them under Edit reviewers and labels." });
    }

    const recorded = team.scaffoldVersion;
    const newer = recorded === undefined ? null : scaffoldVersionProblem(recorded, ORCHESTRATOR_RELEASE);
    if (recorded === undefined) {
      findings.push({ level: "attention", title: "The age of TeamHandbook's files is not known", detail: "They were written before TeamHandbook recorded its release in them, so how far behind they are is not known.", next: REFRESH, more: REFRESH_MORE, refresh: true });
    } else if (newer) {
      findings.push({ level: "attention", title: "TeamHandbook's files are newer than this orchestrator", detail: `They were written by TeamHandbook ${recorded}; this orchestrator carries ${ORCHESTRATOR_RELEASE}, so what ${recorded} changed is not reflected here.`, next: "Update the orchestrator." });
    } else if (compareVersions(recorded, ORCHESTRATOR_RELEASE) === 0) {
      findings.push({ level: "ok", title: "Up to date", more: `TeamHandbook's files in the repository were written by TeamHandbook ${recorded}, the release this orchestrator carries.` });
    } else {
      findings.push({ level: "attention", title: "TeamHandbook's files are out of date", detail: `They were written by TeamHandbook ${recorded}; this orchestrator carries ${ORCHESTRATOR_RELEASE}.`, next: REFRESH, more: REFRESH_MORE, refresh: true });
    }
  }

  if (input.readme === null) {
    findings.push({ level: "attention", title: "No README.md", detail: "Teammates who open the repository read nothing about joining it.", next: REFRESH, more: REFRESH_MORE, refresh: true });
  } else if (!input.readme.includes(README_BEGIN) || !input.readme.includes(README_END)) {
    findings.push({ level: "attention", title: "The README has no TeamHandbook section", detail: "Teammates who open the repository do not read how to subscribe and join.", next: REFRESH, more: REFRESH_MORE, refresh: true });
  }
  if (!input.paths.has("hooks/hooks.json")) {
    findings.push({ level: "attention", title: "Teammates are not told when new skills arrive", detail: "Their Claude Code does not say at the start of a session how many skills arrived since the last one.", next: REFRESH, more: REFRESH_MORE, refresh: true });
  }

  if (input.paths.has("scripts/bump-version.mjs") && (input.ciJobs ?? []).some(ciJobCarriesPrefix)) {
    if (team?.commitPrefixProblem) {
      findings.push({
        level: "problem",
        title: "The CI job runs a refused commit prefix",
        detail: `The version-bump job writes its commit with the prefix in its shell line, and the prefix ${TEAM_PREFIX_FILE} records is ${team.commitPrefixProblem}. The job runs that line on every merge, with TEAMHANDBOOK_CI_TOKEN, which writes to this repository; a refresh leaves it as it is, since the prefix the forge requires is not known here.`,
        next: `Run /handbook:init --upgrade --commit-prefix "<the prefix the forge requires>" from a teammate's machine: it records the prefix and rewrites the job so no prefix reaches a shell line. Until then, take TEAMHANDBOOK_CI_TOKEN out of the project's CI variables.`,
      });
    } else {
      findings.push({
        level: "attention",
        title: "The CI job is written the old way",
        detail: "The version-bump job carries the commit prefix in its shell line, the shape TeamHandbook wrote before the prefix moved into a variable that no shell line reads as code.",
        next: REFRESH,
        refresh: true,
      });
    }
  }
  if (plugin.version !== undefined && input.versionBack) {
    const back = input.versionBack;
    findings.push({
      level: "attention",
      title: "The version line came back",
      detail: `The repository was versioned by commit, and ${back.sha.slice(0, 7)} by ${back.author || "someone"} on ${back.date.slice(0, 10)} put version ${back.version} back into ${PLUGIN_MANIFEST}. From then on a merge that does not raise it reaches nobody. A share from a TeamHandbook older than 0.31.0, or a conflict resolved on the side with the version, puts it back.`,
      next: "Take it out again with the orchestrator's task Switch the plugin to versioning by commit, or /handbook:init --upgrade --commit-versioning from a teammate's machine, and have everyone who shares run a current TeamHandbook.",
    });
  } else if (plugin.version === undefined) {
    findings.push({ level: "ok", title: "Every merge reaches teammates", more: "The plugin has no version line, so Claude Code versions it by commit: each merge is an update teammates receive." });
  } else if (input.paths.has("scripts/bump-version.mjs")) {
    findings.push({ level: "ok", title: "Each merge raises the version", detail: `It is ${plugin.version} now.`, more: "scripts/bump-version.mjs raises it in CI after each merge." });
  } else {
    findings.push({ level: "ok", title: "Each request raises the version", detail: `It is ${plugin.version} now, and teammates fetch a change once it is merged.`, more: "Each request the orchestrator opens raises the version in .claude-plugin/plugin.json." });
  }
  if (input.codeowners !== undefined) findings.push(ownersFinding(input.codeowners));
  const agents = [...input.paths].filter((p) => /^agents\/[^/]+\.md$/.test(p)).map((p) => p.slice("agents/".length, -".md".length));
  if (agents.length) findings.push({ level: "ok", title: `${agents.length} agent${agents.length === 1 ? "" : "s"} shared`, detail: agents.join(", ") });
  return findings;
}

/**
 * Whether a code owner answers for each path that changes what an agent does on every
 * teammate's machine. A request that changes one of them reaches every session once merged,
 * so its review is the team's last look; with an owner, the forge asks that owner whenever the
 * default branch requires code owner review, which a repository's files do not show.
 */
function ownersFinding(file: { path: string; text: string } | null): SetupFinding {
  const ensure = "The forge asks them only when the default branch requires code owner review; turn that on in its protection settings.";
  if (!file) {
    return {
      level: "suggestion",
      title: "No one is asked to review skill and server changes",
      detail: "A change to skills, MCP servers or hooks is merged with the approval any change needs.",
      next: "Name the team that reviews them in a CODEOWNERS file.",
      more: `Add CODEOWNERS (at the root, .github/ or .gitlab/) with: ${ownerLines(AGENT_PATHS.map((a) => a.path)).join("; ")}. ${ensure}`,
    };
  }
  const rules = ownerRules(file.text);
  const owned = AGENT_PATHS.map((a) => ({ path: a.path, owners: ownersOf(rules, a.probe) }));
  const unowned = owned.filter((o) => !o.owners.length).map((o) => o.path);
  if (unowned.length) {
    return {
      level: "suggestion",
      title: "Some skill and server changes have no reviewer",
      detail: `${file.path} names no owner for ${unowned.join(", ")}, so a change there is merged with the approval any change needs.`,
      next: `Name a reviewer for ${unowned.length === 1 ? "it" : "them"} in ${file.path}.`,
      more: `Add to ${file.path}: ${ownerLines(unowned).join("; ")}. ${ensure}`,
    };
  }
  return { level: "ok", title: "Skill and server changes have reviewers", more: `${owned.map((o) => `${o.path} by ${o.owners.join(" ")}`).join("; ")}, from ${file.path}. ${ensure}` };
}

/** What a repository's page tells teammates to type in Claude Code to join it, or why it tells them nothing. */
export type JoinMessage = { url: string; use: string[]; contribute: string } | { problem: string };

/**
 * A repository's `memberUrl` from the configuration file: the address teammates add as a
 * marketplace and join, which is often not the one the orchestrator fetches from. It is shown to
 * everyone signed in and pasted into teammates' terminals, so one carrying a credential stops
 * the orchestrator at start: masked, it would be a command that fails. Left out, it is null and
 * nothing is derived from the fetch URL, which is the one a token travels in.
 */
export function parseMemberUrl(value: unknown, repoId: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !value || /[\s\p{C}]/u.test(value)) throw new Error(`memberUrl of ${repoId} must be a git URL without spaces or control characters`);
  try {
    assertSafeGitUrl(value);
  } catch {
    throw new Error(`memberUrl of ${repoId} is not a git URL Claude Code adds as a marketplace`);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(value) || /^https?:\/\/[^/]*@/i.test(value) || detectSecret(value)) {
    throw new Error(`memberUrl of ${repoId} carries a credential; every teammate reads it, so give the address without one and let each teammate sign in to the forge`);
  }
  return value;
}

/**
 * The commands a teammate types to join the repository, the ones /handbook:init prints: add
 * the marketplace and install the plugin to use the team's skills, and /handbook:join to share
 * their own as well. Only for a repository teammates can install from, since otherwise the
 * commands fail and the setup panel already says why.
 */
export function joinMessage(memberUrl: string | null, plugin: SetupInput["plugin"], marketplace: SetupInput["marketplace"]): JoinMessage {
  const market = marketplace.name;
  if (!market || marketplaceNameProblem(market) || !plugin.name || !marketplace.plugins.includes(plugin.name)) {
    return { problem: "Teammates cannot join until the first problem under Setup is fixed." };
  }
  if (memberUrl === null) {
    return { problem: "The orchestrator does not know the address teammates add this repository by. Set memberUrl for it in the orchestrator's configuration file and restart the orchestrator." };
  }
  return { url: memberUrl, use: [`/plugin marketplace add ${memberUrl}`, `/plugin install ${plugin.name}@${market}`], contribute: `/handbook:join ${memberUrl}` };
}

/** Whether this page refreshes the scaffold itself, or why it does not. */
export type ScaffoldRefresh = { available: true } | { problem: string };

/**
 * The orchestrator refreshes a scaffold as a task it runs itself, and the scaffold writes the
 * address teammates add the repository by, so it takes an orchestrator that runs tasks and the
 * repository's memberUrl; without either the page says which is missing.
 */
export function scaffoldRefresh(input: { tasks: boolean; configured: boolean; memberUrl: string | null }): ScaffoldRefresh {
  if (!input.tasks) return { problem: "This orchestrator runs no tasks, so the scaffold is refreshed from a teammate's machine." };
  if (!input.configured) return { problem: "This repository is no longer in the orchestrator's configuration, so the orchestrator does not change it." };
  if (input.memberUrl === null) return { problem: "The refresh writes the address teammates add this repository by, and the orchestrator's configuration names none: set memberUrl for it and restart the orchestrator." };
  return { available: true };
}

const FORMAT_RULES: Record<string, string> = {
  frontmatter: "SKILL.md has no frontmatter between --- markers",
  name: `the name is not lower-case letters, digits and dashes of at most ${MAX_NAME} characters, or it carries a reserved word`,
  description: `the description is empty, longer than ${MAX_DESC} characters, or carries XML tags`,
  "listing-cap": `the description and when_to_use run past the ${MAX_LISTING} characters Claude Code lists`,
  trigger: `the description gives fewer than ${MIN_TRIGGER_SENTENCES} sentences saying when to use it, so Claude has little to recognise it by`,
  steps: `it has fewer than ${MIN_STEPS} numbered steps, or a numbered heading with nothing under it`,
  verification: `it has no section saying how to check the work, with at least ${MIN_VERIFY_ITEMS} items`,
  pitfalls: "it has no pitfalls section",
  "no-abs-path": "it names an absolute path of one machine",
  "no-email": "it carries an email address",
  "body-length": `its body runs to ${MAX_BODY_LINES} lines or more`,
};

/**
 * What the plugin's skill format, the one /handbook:learn drafts to, says a team's skill
 * lacks, one sentence per required rule it fails. The checker's own details are left out:
 * they quote the path or address a rule found, and the sentence says enough to find it.
 */
export function skillFormatProblems(text: string): string[] {
  return checkSkillFormat(text.replace(/\r\n/g, "\n"))
    .filter((f) => f.required && !f.ok)
    .map((f) => FORMAT_RULES[f.rule] ?? `it fails the plugin's ${f.rule} rule`);
}
