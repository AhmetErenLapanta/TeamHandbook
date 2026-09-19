import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { isSafeSlug } from "./queue.js";
import { detectSecret } from "./secrets.js";

// Reading the slash commands this machine has, and deciding which of them may travel to a
// team repository.
//
// The third kind of thing a setup is made of, after skills and MCP servers, and the
// cheapest of the three to carry: a command is a markdown file Claude Code reads when
// someone types its name. It opens no connection and starts no process, so the questions
// auditServer has to ask do not arise here. The one question that does is the same one
// auditSkillDir asks - a command body is text an author wrote, and text an author wrote
// can hold a token.
//
// Read-only, like mcp.ts: nothing here writes to ~/.claude or to the project.

export type CommandScope = "personal" | "project";

export interface CommandEntry {
  name: string;
  scope: CommandScope;
  file: string;
}

export type CommandRefusal = "unsafe-name" | "unreadable" | "secret";

export interface CommandAudit {
  shareable: boolean;
  reason?: CommandRefusal;
  /** the pattern that refused it, or the file that could not be read */
  detail?: string;
  /** only on a clean audit: the text that was screened, which is the text that gets copied */
  content?: string;
  description?: string;
  secret?: { pattern: string; file: string };
}

/**
 * Where a command this machine can run lives: the user-level directory that loads in every
 * project, and the current project's own.
 *
 * Mirrors localSkillDirs and readLocalServers, for the reason they give: the client
 * resolves the project one over the personal one when the names collide, and a screen that
 * offered the other copy would share a file the author is not looking at.
 */
export function localCommandDirs(
  userHome: string = homedir(),
  cwd: string = process.cwd(),
): Array<{ dir: string; scope: CommandScope }> {
  return [
    { dir: join(userHome, ".claude", "commands"), scope: "personal" },
    { dir: join(cwd, ".claude", "commands"), scope: "project" },
  ];
}

/**
 * The commands configured for THIS machine and THIS project, project scope winning.
 *
 * Top-level `.md` files only. Claude Code also namespaces commands by subdirectory, where
 * `git/sync.md` is `/git:sync`, and those are deliberately out of scope here rather than
 * flattened: the name a namespaced command travels under is not the name it is typed
 * under, and guessing which of the two the team wants is not a guess this makes. The
 * listing says so, so a setup that has them is not quietly reported as complete. What the
 * filter drops without comment is the entry that is not a command at all - .DS_Store sits
 * in the real directory this was measured against.
 */
export function readLocalCommands(
  userHome: string = homedir(),
  cwd: string = process.cwd(),
): CommandEntry[] {
  const byName = new Map<string, CommandEntry>();
  for (const { dir, scope } of localCommandDirs(userHome, cwd)) {
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const name = basename(entry, ".md");
      byName.set(name, { name, scope, file: join(dir, entry) });
    }
  }
  return [...byName.values()];
}

/**
 * A command's own description, for a list that has to fit three kinds of thing on one
 * screen.
 *
 * Deliberately not parseSkillFrontmatter: that one requires a `name` field and returns
 * nothing without it, while a command's name is its file name and frontmatter is optional
 * for it. Reading it with the skill parser would leave most commands describing themselves
 * as nothing, and requiring frontmatter would refuse commands Claude Code runs happily.
 */
export function commandDescription(content: string): string {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  const described = frontmatter?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (described) return described.replace(/^["']|["']$/g, "");
  const body = frontmatter ? content.slice(frontmatter[0].length) : content;
  return body.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#")) ?? "";
}

/**
 * Everything that can be decided about a command file by reading it.
 *
 * The same shape as auditSkillDir and for the same reason: two callers, the inventory
 * screen and the publishing path, and a screen that judged with its own copy of the rules
 * would eventually offer something the enforcing path refuses - or stop offering something
 * it would accept, and grow a shortcut past the sieve to fix that. The sieve runs here,
 * once, and the text it cleared is the text the caller writes.
 *
 * It refuses rather than redacts, as intakeSkill does: a command with its credential
 * blanked out still installs, still reads as complete to the teammate who types it, and
 * fails only when they run it.
 */
export function auditCommand(file: string): CommandAudit {
  const name = basename(file, ".md");
  // The name becomes a path inside the team repository, so it is held to the same rule a
  // skill's directory is: anything else is a file name we would be constructing a path out
  // of, not a command name.
  if (!isSafeSlug(name)) return { shareable: false, reason: "unsafe-name", detail: name };
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    // unreadable means unscreened, and unscreened must not ship
    return { shareable: false, reason: "unreadable", detail: basename(file) };
  }
  const pattern = detectSecret(content);
  if (pattern) {
    return { shareable: false, reason: "secret", detail: pattern, secret: { pattern, file: basename(file) } };
  }
  return { shareable: true, content, description: commandDescription(content) };
}

/** The short form for a list, beside the skills and the servers. */
export function commandRefusalSummary(audit: CommandAudit): string {
  switch (audit.reason) {
    case "unsafe-name":
      return `"${audit.detail}" cannot be a command name (lowercase letters, digits and dashes)`;
    case "unreadable":
      return `"${audit.detail}" cannot be read, so it cannot be screened`;
    default:
      return `it looks like it contains a secret (${audit.detail})`;
  }
}

/** The same refusal with the fix spelled out, for when it is reported rather than listed. */
export function commandRefusalMessage(name: string, audit: CommandAudit): string {
  if (audit.reason === "secret") {
    return (
      `"${audit.secret?.file}" looks like it contains a secret (${audit.detail}), so ${name} was not ` +
      `shared. Commands are reviewed and merged as they are, and a redacted one would arrive and ` +
      `then misfire; take the credential out of the command and try again.`
    );
  }
  return commandRefusalSummary(audit);
}
