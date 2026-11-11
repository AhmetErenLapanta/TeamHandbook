import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { skeletonFiles } from "../server/plugin.js";
import plugin from "../../package.json" with { type: "json" };
import type { SeedSkill, TeamSpec } from "./orgs.js";
import { labGit, labGitMaybe } from "./run.js";
import type { Identity } from "./run.js";

/**
 * One team repository the way /handbook:init leaves it - the plugin's own scaffold, stamped with
 * this tree's release - then filled with a few weeks of a team's skills, commands and MCP
 * servers, one commit each. The bare repository fetches the result from a scratch work tree,
 * the move a merge makes on a forge, so nothing here needs a remote that accepts writes.
 */
export function seedTeamRepo(path: string, team: TeamSpec, bare: string, url: string, scratch: string): void {
  const work = join(scratch, team.id);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(bare, { recursive: true });
  const branch = team.defaultBranch ?? "main";
  labGit(path, ["init", "--bare", "--quiet", `--initial-branch=${branch}`], bare);
  labGit(path, ["init", "--quiet", `--initial-branch=${branch}`], work);
  const commit = (subject: string, files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      writeFileSync(join(work, file), content);
    }
    labGit(path, ["add", "-A"], work);
    labGit(path, ["commit", "--quiet", "-m", subject], work);
  };
  const prefix = team.commitPrefix ? `${team.commitPrefix} ` : "";
  commit(
    `${prefix}chore: scaffold team skill base`,
    skeletonFiles(team.id, url, null, team.commitPrefix ?? "", team.withCi ?? false, team.branchExample, { reviewers: team.reviewers, labels: team.labels }, plugin.version, team.version),
  );
  // A team set up the way the lab models one names who answers for its agent configuration.
  commit(`${prefix}chore: name the team's owners`, { CODEOWNERS: `* @lab/${team.id}\n` });
  for (const s of team.skills) commit(`${prefix}feat(skill): add ${s.slug}`, { [`skills/${s.slug}/SKILL.md`]: skillMarkdown(s) });
  if (team.bulkSkills) commit(`${prefix}feat(skill): add ${team.bulkSkills} skills`, bulkSkillFiles(team.bulkSkills));
  if (team.mcp) commit(`${prefix}feat(mcp): add ${Object.keys(team.mcp).join(", ")}`, { ".mcp.json": JSON.stringify({ mcpServers: team.mcp }, null, 2) + "\n" });
  for (const [name, md] of Object.entries(team.commands ?? {})) commit(`${prefix}feat(command): add /${name}`, { [`commands/${name}.md`]: md });
  labGit(path, ["fetch", "--quiet", work, `${branch}:${branch}`], bare);
  rmSync(work, { recursive: true, force: true });
}

/**
 * A code repository a task changes, not a skills repository: its own files in one commit, with no
 * plugin scaffold, fetched into the bare repository the way a team repository is.
 */
export function seedCodeRepo(path: string, team: Pick<TeamSpec, "id" | "defaultBranch"> & { files: Record<string, string> }, bare: string, scratch: string): void {
  const work = join(scratch, team.id);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(bare, { recursive: true });
  const branch = team.defaultBranch ?? "main";
  labGit(path, ["init", "--bare", "--quiet", `--initial-branch=${branch}`], bare);
  labGit(path, ["init", "--quiet", `--initial-branch=${branch}`], work);
  for (const [file, content] of Object.entries(team.files)) {
    mkdirSync(dirname(join(work, file)), { recursive: true });
    writeFileSync(join(work, file), content);
  }
  labGit(path, ["add", "-A"], work);
  labGit(path, ["commit", "--quiet", "-m", "chore: the service as it stands"], work);
  labGit(path, ["fetch", "--quiet", work, `${branch}:${branch}`], bare);
  rmSync(work, { recursive: true, force: true });
}

export function skillMarkdown(s: SeedSkill): string {
  return `---\nname: ${s.slug}\ndescription: ${s.description}\n---\n\n${s.body}`;
}

/**
 * One commit on the default branch of a bare repository, the way a merge elsewhere lands there,
 * built through an index of its own in `scratch`. `null` deletes a file.
 */
export function commitOnDefault(path: string, bare: string, files: Record<string, string | null>, subject: string, who: Identity, scratch: string): void {
  commitOnBranch(path, bare, labGit(path, ["symbolic-ref", "--short", "HEAD"], bare), files, subject, who, scratch);
}

/**
 * The same commit on `branch`: on top of it when it exists, else on a new branch from the
 * default branch's head - a teammate's share pushed to the team repository.
 */
export function commitOnBranch(path: string, bare: string, branch: string, files: Record<string, string | null>, subject: string, who: Identity, scratch: string): void {
  const existing = labGitMaybe(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], bare);
  const head = existing ?? labGit(path, ["rev-parse", "HEAD"], bare);
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "index-"));
  const env = { GIT_INDEX_FILE: join(dir, "index") };
  try {
    labGit(path, ["read-tree", head], bare, { env });
    for (const [file, content] of Object.entries(files)) {
      if (content === null) {
        // Mode 0 takes the entry out; --force-remove would need a work tree a bare repository lacks.
        labGit(path, ["update-index", "--index-info"], bare, { env, input: `0 ${"0".repeat(40)}\t${file}\n` });
      } else {
        const blob = labGit(path, ["hash-object", "-w", "--stdin"], bare, { input: content });
        labGit(path, ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], bare, { env });
      }
    }
    const tree = labGit(path, ["write-tree"], bare, { env });
    const commit = labGit(path, ["commit-tree", tree, "-p", head, "-m", subject], bare, { who });
    labGit(path, ["update-ref", `refs/heads/${branch}`, commit, existing ?? ""], bare);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `count` skills whose descriptions share no word, about 140 words each: no two answer the same
 * requests, so what the orchestrator spends reading them is the reading, not a match it reports.
 */
function bulkSkillFiles(count: number): Record<string, string> {
  const word = (n: number) => {
    let text = "";
    for (let left = n + 26 * 27; left > 0; left = Math.floor(left / 26)) text = String.fromCharCode(97 + (left % 26)) + text;
    return text;
  };
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const words = Array.from({ length: 140 }, (_, j) => word(i * 140 + j)).join(" ");
    const slug = `bulk-${String(i).padStart(4, "0")}`;
    files[`skills/${slug}/SKILL.md`] = skillMarkdown({ slug, description: `Use when ${words}.`, body: "1. Read the request.\n" });
  }
  return files;
}
