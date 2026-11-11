import type { FileChange } from "../forge/types.js";
import { gitAsyncMaybe } from "../git.js";
import { commitPrefixProblem, TEAM_PREFIX_FILE } from "../plugin.js";
import { serverProblem, SKILL_SLUG, skillProblem } from "../skill-rules.js";
import type { TaskTemplate } from "./types.js";

/**
 * Files an agent's change can reach whose effect is not a skill's text: code that runs on
 * every teammate's machine or in the team's CI, and the plugin's and the team's own settings.
 * They travel only with a warning at the top of the request, since a person merging a task's
 * request reads it as a change to skills.
 */
const SENSITIVE: { test: (path: string) => boolean; why: string }[] = [
  { test: (p) => p.startsWith("hooks/"), why: "a hook runs on every teammate's machine at the event it names" },
  { test: (p) => p.startsWith(".claude-plugin/"), why: "the plugin's own manifest: its name, version and marketplace entry" },
  { test: (p) => p === ".teamhandbook.json", why: "the team's settings: commit prefix, branch naming, reviewers, labels and where skill use is reported" },
  {
    test: (p) => /^(\.github\/workflows\/|\.gitlab-ci\.yml$|\.gitlab\/ci\/|\.circleci\/|\.buildkite\/|Jenkinsfile$|azure-pipelines\.yml$|bitbucket-pipelines\.yml$)/.test(p),
    why: "the team's CI runs it, with whatever the CI holds",
  },
];

export type ResultCheck = { refused: string } | { warnings: string[] };

/** The plugin's version-bump job: it commits with the team's prefix on every merge. */
const CI_VERSION_JOB = "scripts/bump-version.mjs";

const prefixOf = (text: string | null): unknown => {
  if (text === null) return undefined;
  try {
    return (JSON.parse(text) as { commitPrefix?: unknown } | null)?.commitPrefix;
  } catch {
    return undefined;
  }
};

/**
 * Why an agent's change to the team's commit prefix cannot travel, or null. The prefix is what
 * every share and the version-bump job put on their commits: one the plugin does not accept
 * reaches nobody's commits, and the job commits with whatever the team file says, so a prefix
 * changed beside it breaks every merge's bump until the plugin's refresh rewrites the job with it.
 */
async function prefixProblem(files: FileChange[], mirror: string, baseSha: string): Promise<string | null> {
  const team = files.find((f) => f.path === TEAM_PREFIX_FILE);
  if (!team || team.content === null) return null;
  const after = prefixOf(team.content);
  const before = prefixOf(await gitAsyncMaybe(["show", `${baseSha}:${TEAM_PREFIX_FILE}`], mirror));
  if (after === before) return null;
  if (after !== undefined) {
    const problem = typeof after === "string" ? commitPrefixProblem(after.trim()) : "not text";
    if (problem) return `The agent changed the team's commit prefix to one the plugin does not accept (it is ${problem}); no request was opened.`;
  }
  const job = files.some((f) => f.path === CI_VERSION_JOB && f.content !== null) || (await gitAsyncMaybe(["cat-file", "-e", `${baseSha}:${CI_VERSION_JOB}`], mirror)) !== null;
  if (job) return `The agent changed the team's commit prefix, and the version-bump job (${CI_VERSION_JOB}) commits with it on every merge; change it with /handbook:init --upgrade --commit-prefix, which rewrites the job with it. No request was opened.`;
  return null;
}

/**
 * Why a template's result does not answer the template: it reaches outside the skill's folder,
 * or a new skill's SKILL.md is missing, or an improved one was deleted. Null when it answers,
 * and for a task with no template.
 */
export function templateProblem(template: TaskTemplate | null | undefined, files: FileChange[]): string | null {
  if (!template || template.kind === "scaffold.refresh") return null;
  const folder = `skills/${template.skill}/`;
  const what = template.kind === "skill.write" ? `writes the skill ${template.skill}` : `improves the skill ${template.skill}`;
  const outside = files.filter((f) => !f.path.startsWith(folder)).map((f) => f.path);
  if (outside.length) return `The task ${what}, and the agent also changed ${outside.join(", ")}, outside ${folder}; no request was opened.`;
  const skill = files.find((f) => f.path === `${folder}SKILL.md`);
  if (template.kind === "skill.write" && !skill?.content) return `The task ${what}, and the agent left no ${folder}SKILL.md; no request was opened.`;
  if (template.kind === "skill.improve" && skill && skill.content === null) return `The task ${what}, and the agent deleted its SKILL.md; no request was opened.`;
  return null;
}

function servers(text: string | null): Record<string, unknown> | null {
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const declared = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (declared === undefined) return {};
  return declared && typeof declared === "object" && !Array.isArray(declared) ? (declared as Record<string, unknown>) : null;
}

/**
 * Holds what an agent changed to the rules the plugin applies before anything travels, the
 * same rules the orchestrator's editor applies: a skill's SKILL.md has frontmatter with a name and
 * a description, the name is its folder's, and it holds no secret; a server added to or changed
 * in `.mcp.json` passes the share rule. A change that breaks one is refused whole, as the
 * checks before it are. Files outside skills that run code or configure the plugin are named
 * in warnings for the request.
 */
export async function checkTaskResult(files: FileChange[], mirror: string, baseSha: string): Promise<ResultCheck> {
  const warnings: string[] = [];
  const prefix = await prefixProblem(files, mirror, baseSha);
  if (prefix) return { refused: prefix };
  for (const file of files) {
    const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path);
    if (skill && file.content !== null) {
      const slug = skill[1]!;
      if (!SKILL_SLUG.test(slug)) return { refused: `The agent wrote a skill in skills/${slug}, a folder name the plugin does not read (lower-case letters, digits and dashes); no request was opened.` };
      const problem = skillProblem(slug, file.content);
      if (problem) return { refused: `The agent's skills/${slug}/SKILL.md cannot travel: ${problem}; no request was opened.` };
    }
    if (file.path === ".mcp.json") {
      if (file.content === null) {
        warnings.push(".mcp.json is deleted: every MCP server the team shares goes with it.");
        continue;
      }
      const after = servers(file.content);
      if (!after) return { refused: "The agent left .mcp.json as something other than a JSON object with an mcpServers object; no request was opened." };
      const before = servers(await gitAsyncMaybe(["show", `${baseSha}:.mcp.json`], mirror)) ?? {};
      for (const [name, config] of Object.entries(after)) {
        if (JSON.stringify(before[name]) === JSON.stringify(config)) continue;
        const checked = serverProblem(name, config);
        if ("refused" in checked) return { refused: `The agent's change to .mcp.json cannot travel: ${checked.refused}; no request was opened.` };
        if (checked.audit.startsProcess) warnings.push(`.mcp.json ${name in before ? "changes" : "adds"} the server ${name}, which starts a command on every teammate's machine.`);
      }
      for (const name of Object.keys(before)) if (!(name in after)) warnings.push(`.mcp.json removes the server ${name}.`);
    }
    const sensitive = SENSITIVE.find((rule) => rule.test(file.path));
    if (sensitive) warnings.push(`${file.path} is ${file.content === null ? "deleted" : "changed"}: ${sensitive.why}.`);
  }
  return { warnings };
}
