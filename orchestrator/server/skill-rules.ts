import { auditServer, detectSecret, parseSkillFrontmatter } from "./plugin.js";
import type { McpAudit } from "./plugin.js";

/**
 * The plugin's rules for what may travel in a team repository, as the orchestrator applies them to
 * every change it proposes: one a person writes on the screen and one an agent leaves in a
 * task's checkout answer to the same rule, so a task cannot carry what the editor refuses.
 */

export const SKILL_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The name of a skill a Skill call names: a plugin's skill is called `plugin:name`, the name is what a team's repository calls it; null for anything else. */
export const calledSkill = (target: string | null | undefined): string | null => {
  const name = target?.split(":").at(-1);
  return name && SKILL_SLUG.test(name) ? name : null;
};
export const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_SKILL_BYTES = 256 * 1024;

/** Why a skill's SKILL.md cannot travel as written, or null when it can. */
export function skillProblem(slug: string, content: string): string | null {
  if (!content.trim()) return "SKILL.md is empty";
  if (Buffer.byteLength(content) > MAX_SKILL_BYTES) return "SKILL.md is larger than 256 KiB";
  const text = content.replace(/\r\n/g, "\n");
  // A second `name:` would make the folder's name and the name a reader takes two different things.
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  if ((frontmatter.match(/^name\s*:/gm) ?? []).length > 1) return "the frontmatter names the skill more than once";
  const summary = parseSkillFrontmatter(text);
  if (!summary) return "SKILL.md needs frontmatter with a name and a description";
  if (summary.name !== slug) return `the frontmatter name is "${summary.name}"; it has to match the skill's folder, ${slug}`;
  // The same sieve the plugin runs on a skill before it travels: the team repository is
  // read by everyone on the team, and a token pasted into a skill would reach them all.
  const secret = detectSecret(text);
  if (secret) return `SKILL.md contains what looks like a ${secret}; move it into an environment variable and refer to it by name`;
  return null;
}

/**
 * Why the plugin's share rule refused a server, said for this screen. The plugin's own
 * summary ends in advice for its command line ("run share again"); here the next step is
 * the form in front of the person. Built from the audit's fields, which name a key, a pattern
 * or a class of trace and never a value.
 */
export function serverRefusal(name: string, audit: McpAudit): string {
  const where = audit.at ? `its ${audit.at}` : "its definition";
  const fix = "move the value into an environment variable referenced as ${VAR} and review again";
  switch (audit.reason) {
    case "credential-field":
      return `${name} is not shareable as written: ${audit.detail} holds a literal value; ${fix}`;
    case "secret-pattern":
      return `${name} is not shareable as written: ${where} looks like it contains a secret (${audit.detail}); ${fix}`;
    case "url-token":
      return `${name} is not shareable as written: its URL carries what looks like a credential (${audit.detail}); ${fix}`;
    case "identity":
      return `${name} is not shareable as written: ${where} carries a trace of one machine (${audit.detail}); ${fix}`;
    default:
      return `${name} is not a server definition the orchestrator can propose (${audit.detail ?? "unsupported shape"})`;
  }
}

/**
 * The plugin's share rule for one MCP server, with the orchestrator's own addition: `args` has to
 * be a list, since the plugin's rule passes one that is not and the request would then
 * describe a command other than the one teammates run. Its values go nowhere - not into the
 * answer, a log or the store.
 */
export function serverProblem(name: string, config: unknown): { refused: string } | { audit: McpAudit } {
  if (!SERVER_NAME.test(name)) return { refused: "a server name is letters, digits, dot, dash or underscore" };
  const audit = auditServer(config);
  const args = (config as { args?: unknown } | null)?.args;
  if (audit.migratable && args !== undefined && !Array.isArray(args)) return { refused: `${name}: args has to be a list, one argument per entry` };
  if (!audit.migratable) return { refused: serverRefusal(name, audit) };
  return { audit };
}
