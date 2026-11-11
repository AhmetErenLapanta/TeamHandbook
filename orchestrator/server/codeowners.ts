/**
 * Where GitHub and GitLab look for a CODEOWNERS file, in the order the first found is the one
 * used: GitHub reads .github/, the root, then docs/; GitLab the root, docs/, then .gitlab/.
 */
export const CODEOWNERS_FILES = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS", ".gitlab/CODEOWNERS"];

/**
 * The paths that change what an agent does on every teammate's machine, each with a file under
 * it to ask about: a rule written for the folder or for the file both answer for it.
 */
export const AGENT_PATHS: { path: string; probe: string }[] = [
  { path: "skills/", probe: "skills/any-skill/SKILL.md" },
  { path: ".mcp.json", probe: ".mcp.json" },
  { path: "hooks/", probe: "hooks/hooks.json" },
  { path: ".claude-plugin/", probe: ".claude-plugin/plugin.json" },
  { path: ".teamhandbook.json", probe: ".teamhandbook.json" },
];

interface OwnerRule {
  pattern: RegExp;
  owners: string[];
}

/**
 * A CODEOWNERS pattern as both forges read it, the way .gitignore patterns are read: a leading
 * `/` or a `/` inside ties it to the root, otherwise it matches at any depth; a trailing `/`
 * or a name that is a folder takes everything under it; `*` stays within one folder and `**`
 * crosses them.
 */
const GLOB: Record<string, string> = { "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*", "?": "[^/]" };

function patternOf(raw: string): RegExp {
  const anchored = raw.startsWith("/") || raw.slice(0, -1).includes("/");
  const body = raw.replace(/^\//, "").replace(/\/$/, "");
  const source = body
    .split(/(\*\*\/?|\*|\?)/)
    .map((part) => GLOB[part] ?? part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
    .join("");
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${source}(?:/.*)?$`);
}

/** The rules of a CODEOWNERS file, in order: comments, blank lines and GitLab's section headers are not rules. */
export function ownerRules(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || /^\^?\[[^\]]*\]/.test(trimmed)) continue;
    const [pattern, ...owners] = trimmed.split(/\s+/);
    rules.push({ pattern: patternOf(pattern!), owners: owners.filter((o) => !o.startsWith("#")) });
  }
  return rules;
}

/** Who owns a path: the last rule that matches decides, and a rule that names nobody leaves it unowned. */
export function ownersOf(rules: readonly OwnerRule[], path: string): string[] {
  let owners: string[] = [];
  for (const rule of rules) if (rule.pattern.test(path)) owners = rule.owners;
  return owners;
}

/** The lines that give each unowned path an owner, for the team lead to fill in and add. */
export function ownerLines(paths: readonly string[]): string[] {
  return paths.map((p) => `/${p} @your-org/your-team`);
}
