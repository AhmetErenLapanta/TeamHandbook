import { readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileLine, isSafeSlug, lineAt, screenedRefusal, traceFinding } from "./queue.js";
import { locateSecret } from "./secrets.js";
import { detectIdentity, locateIdentity } from "./identity.js";
import type { IdentityClass } from "./identity.js";

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

export type CommandRefusal = "unsafe-name" | "unreadable" | "secret" | "identity";

export interface CommandAudit {
  shareable: boolean;
  reason?: CommandRefusal;
  /** the pattern that refused it, or the file that could not be read */
  detail?: string;
  /** only on a clean audit: the text that was screened, which is the text that gets copied */
  content?: string;
  description?: string;
  secret?: { pattern: string; file: string; line?: number };
  /** the class of host-identity trace that refused it, and where - never the value */
  identity?: { class: IdentityClass; where: string; line?: number };
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
 * Every command under one commands directory, by the name it is typed under.
 *
 * Claude Code namespaces a command by its subdirectory, one segment per level:
 * `git/sync.md` is `/git:sync`, a different command from a top-level `sync.md`, and inside
 * a plugin it becomes `/<plugin>:git:sync`. So the name is the relative path with `/`
 * read as `:`, and commandFile turns it back into the same path in the team repository.
 * Keying on the file name alone would make `sync.md` and `git/sync.md` one command, and
 * whichever was read second would quietly stand in for the other. What is dropped without
 * comment is the entry that is not a command at all - .DS_Store sits in the real directory
 * this was measured against.
 */
export function commandsIn(dir: string, namespace: string[] = []): Array<{ name: string; file: string }> {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return commandsIn(path, [...namespace, entry.name]);
      if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
      return [{ name: [...namespace, basename(entry.name, ".md")].join(":"), file: path }];
    });
}

/** Where a command of this name lives below a commands directory: `git:sync` is `git/sync.md`. */
export function commandFile(name: string): string {
  return `${name.split(":").join("/")}.md`;
}

/** The commands configured for THIS machine and THIS project, project scope winning. */
export function readLocalCommands(
  userHome: string = homedir(),
  cwd: string = process.cwd(),
): CommandEntry[] {
  const byName = new Map<string, CommandEntry>();
  for (const { dir, scope } of localCommandDirs(userHome, cwd)) {
    for (const { name, file } of commandsIn(dir)) byName.set(name, { name, scope, file });
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
export function auditCommand(file: string, name: string = basename(file, ".md")): CommandAudit {
  // The name becomes a path inside the team repository, so every segment of it is held to
  // the same rule a skill's directory is: anything else is a file name we would be
  // constructing a path out of, not a command name.
  if (!name.split(":").every(isSafeSlug)) return { shareable: false, reason: "unsafe-name", detail: name };
  // Named by its path under commands/, so git/sync.md is not reported as a sync.md the
  // author has to go looking for among the top-level ones.
  const where = commandFile(name);
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    // unreadable means unscreened, and unscreened must not ship
    return { shareable: false, reason: "unreadable", detail: where };
  }
  const found = locateSecret(content);
  if (found) {
    const secret = { pattern: found.pattern, file: where, line: lineAt(content, found.index) };
    return { shareable: false, reason: "secret", detail: found.pattern, secret };
  }
  // A command is a file of instructions written on ONE machine, so it is the likeliest of
  // the three kinds to say "run it from here" with an absolute path in it. The teammate who
  // types the command has no such directory, so the trace is both a reputation cost and a
  // command that cannot work where it lands.
  const inName = detectIdentity(name);
  if (inName) return { shareable: false, reason: "identity", detail: inName, identity: { class: inName, where: "name" } };
  const trace = locateIdentity(content);
  if (trace) {
    const identity = { class: trace.class, where, line: lineAt(content, trace.index) };
    return { shareable: false, reason: "identity", detail: trace.class, identity };
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
      return screenedRefusal(audit);
  }
}

/** The same refusal with the fix spelled out, for when it is reported rather than listed. */
export function commandRefusalMessage(name: string, audit: CommandAudit): string {
  if (audit.reason === "identity") {
    return (
      `${name} was not shared: ${traceFinding(audit)}. A command is merged as it is, and the ` +
      `teammate who types it has no such account or directory; take the trace out and try again.`
    );
  }
  if (audit.reason === "secret") {
    return (
      `${fileLine(audit.secret?.file ?? "", audit.secret?.line)} looks like it contains a secret (${audit.detail}), so ${name} was not ` +
      `shared. Commands are reviewed and merged as they are, and a redacted one would arrive and ` +
      `then misfire; take the credential out of the command and try again.`
    );
  }
  return commandRefusalSummary(audit);
}
