import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compareVersions, MARKETPLACE_MANIFEST, PLUGIN_MANIFEST, scaffoldVersionProblem, TEAM_PREFIX_FILE, upgradeCandidates } from "../plugin.js";
import { ORCHESTRATOR_RELEASE } from "../setup.js";
import type { VersionRaise } from "../versions.js";
import type { ScaffoldTemplate } from "./types.js";

/** The plugin's version-bump job: it raises the version on every merge and fails on a manifest without one. */
const CI_VERSION_JOB = "scripts/bump-version.mjs";

export interface ScaffoldRefresh {
  /** What the orchestrator says it did, in the request's report section and the log. */
  summary: string;
  /** Files the refresh left as they are, and a README replaced whole: named first in the request. */
  warnings: string[];
  /** The version line taken out, for the switch to versioning by commit; its note waits for the branches read in the request's turn. */
  switched: { from: string; marketplace: string } | null;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const exists = (path: string) => access(path).then(() => true, () => false);

/**
 * The switch's terms as the plugin states them, for the request: what the merge does, what an
 * open request that raises the version does to it, and the condition nobody here can check -
 * that everyone who shares to the repository runs a TeamHandbook that no longer raises one.
 */
export function switchNote({ from: current, marketplace }: { from: string; marketplace: string }, raise: VersionRaise | null): string {
  const open = raise?.past.length ? ` Open now: ${raise.past.map((c) => `${c.branch} (${c.version})`).join(", ")}.` : "";
  return [
    `This request switches the repository to versioning by commit: it takes "version": "${current}" out of ${PLUGIN_MANIFEST},`,
    "nothing raises a version after it, and every merge reaches teammates' copies when their copy of the plugin updates.",
    `Open requests that raise the version conflict with this commit, since they change the line it deletes; merge or close them first.${open}`,
    `Once this is merged, a teammate with auto-update on for the marketplace moves in their next session; the others run \`claude plugin update ${marketplace}@${marketplace}\`, then a new session or \`/reload-plugins\`.`,
    "A TeamHandbook older than 0.31.0 still raises a version when it shares, which puts the line back. The orchestrator cannot see",
    "which release each teammate runs, so check that everyone who shares to this repository is on 0.31.0 or later before merging.",
  ].join("\n");
}

/**
 * The plugin's scaffold refresh, done by the orchestrator in a task's checkout instead of an
 * agent: the files `/handbook:init --upgrade` would write today, written for the address
 * teammates add the repository by and the release recorded in the team file; the version line
 * is raised in the request's turn as every orchestrator request's is, or, for the switch to
 * versioning by commit, taken out here. Team-owned paths (skills, commands, agents, .mcp.json) are never
 * offered by the plugin and so never written. Refuses rather than writes when the plugin's
 * own rules say no: a scaffold newer than this orchestrator, or a switch the repository cannot take.
 */
export async function refreshScaffold(
  work: string,
  memberUrl: string,
  template: ScaffoldTemplate,
): Promise<ScaffoldRefresh | { refused: string }> {
  const marketplace = (await readJson(join(work, MARKETPLACE_MANIFEST)))?.name;
  if (typeof marketplace !== "string" || !marketplace) {
    return { refused: `The repository has no ${MARKETPLACE_MANIFEST} naming its marketplace, so there is no scaffold to refresh; no request was opened.` };
  }
  const recorded = (await readJson(join(work, TEAM_PREFIX_FILE)))?.scaffoldVersion;
  const newer = recorded === undefined ? null : scaffoldVersionProblem(recorded, ORCHESTRATOR_RELEASE);
  if (newer) return { refused: `The scaffold was not refreshed: ${newer}` };
  const current = (await readJson(join(work, PLUGIN_MANIFEST)))?.version;
  if (template.commitVersioning) {
    if (await exists(join(work, CI_VERSION_JOB))) {
      return { refused: `The repository runs the version-bump job (${CI_VERSION_JOB}), which raises the version on every merge and fails on a manifest without one; take the job and that script out first. No request was opened.` };
    }
    if (current === undefined) return { refused: `The repository is already versioned by commit: ${PLUGIN_MANIFEST} carries no version. No request was opened.` };
    if (typeof current !== "string" || compareVersions(current, current) === null) {
      return { refused: `${PLUGIN_MANIFEST} has a version this cannot read, so there is no line to take out; no request was opened.` };
    }
  }

  const candidates = upgradeCandidates(work, { repoUrl: memberUrl, marketplaceName: marketplace }, undefined, {}, undefined, template.commitVersioning);
  const written: string[] = [];
  for (const [path, content] of Object.entries(candidates.files)) {
    const target = join(work, path);
    if ((await readFile(target, "utf8").catch(() => null)) === content) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    written.push(path);
  }
  // The release that wrote the scaffold, on every refresh that writes anything: an older copy
  // then refuses to put back what this one replaced.
  const team = await readJson(join(work, TEAM_PREFIX_FILE));
  if (team && team.scaffoldVersion !== ORCHESTRATOR_RELEASE) {
    await writeFile(join(work, TEAM_PREFIX_FILE), JSON.stringify({ ...team, scaffoldVersion: ORCHESTRATOR_RELEASE }, null, 2) + "\n");
    if (!written.includes(TEAM_PREFIX_FILE)) written.push(TEAM_PREFIX_FILE);
  }
  if (!written.length) return { refused: `The scaffold is already what TeamHandbook ${ORCHESTRATOR_RELEASE} writes; no request was opened.` };

  const warnings = [
    ...candidates.withheld.map((w) => `${w.path} is left as it is: ${w.reason}`),
    ...candidates.linked.map((w) => `${w.path} is left as it is: ${w.reason}`),
    ...(candidates.readmeWhole && written.includes("README.md")
      ? [`README.md is replaced whole (${candidates.readmeWhole.reason === "unmarked" ? "it has no TeamHandbook markers" : "its TeamHandbook markers are broken"}); ${candidates.readmeWhole.lost.length} line(s) of it do not carry over.`]
      : []),
  ];
  return {
    summary: `Refreshed the scaffold to what TeamHandbook ${ORCHESTRATOR_RELEASE} writes, for teammates adding ${memberUrl}: ${written.join(", ")}.`,
    warnings,
    switched: template.commitVersioning ? { from: current as string, marketplace } : null,
  };
}
