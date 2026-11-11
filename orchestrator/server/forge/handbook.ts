import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { BuiltChange } from "../changes.js";
import { ChangeRefused, filesUnder, MCP_FILE, show } from "../changes.js";
import type { FileChange } from "./types.js";
import { auditCommand, auditSkillDir, buildInventory, commandFile, declaredServers, detectSecret, mergeServersIntoMcpJson } from "../plugin.js";
import type { InventoryPaths } from "../plugin.js";

/** The names a team repository carries, in the shape /handbook:share's inventory marks "on the team" from. */
export interface TeamAssets {
  skills: string[];
  servers: string[];
  commands: string[];
}

/** One thing in the person's own Claude Code as the Team handbook offers it: a name and a sentence, never a definition or a value. */
export interface OwnItem {
  name: string;
  description: string;
  /** The team repository already carries this name, so taking it updates the team's copy. */
  inTeam: boolean;
  addable: boolean;
  why?: string;
}

export interface OwnHandbook {
  skills: OwnItem[];
  mcpServers: OwnItem[];
  commands: OwnItem[];
}

/** The skills, servers and commands a team repository carries at `head`, by name. */
export async function teamHandbook(mirror: string, head: string): Promise<TeamAssets> {
  const skills = [...new Set((await filesUnder(mirror, head, "skills")).map((path) => path.split("/")[1]).filter((name): name is string => Boolean(name)))];
  const servers = Object.keys(declaredServers(await show(mirror, head, MCP_FILE)));
  const commands = (await filesUnder(mirror, head, "commands")).filter((path) => path.endsWith(".md")).map((path) => basename(path, ".md"));
  return { skills, servers, commands };
}

/**
 * The person's own skills, MCP servers and commands, read as /handbook:share reads them, each with
 * whether it can go to the team and why not. A server whose definition holds a credential is
 * listed, so the person sees it, and is never addable; its definition is not part of the answer.
 */
export function ownHandbook(team: TeamAssets | null, paths: InventoryPaths = {}): OwnHandbook {
  const inventory = buildInventory(paths, team);
  const item = (thing: { name: string; shareable: boolean; reason?: string; onTeam?: true }, description: string): OwnItem => ({
    name: thing.name,
    description,
    inTeam: Boolean(thing.onTeam),
    addable: thing.shareable,
    ...(thing.shareable ? {} : { why: thing.reason ?? "it cannot go to the team as it stands" }),
  });
  const once = <T extends { name: string }>(items: T[]) => [...new Map(items.map((i) => [i.name, i])).values()];
  return {
    skills: once(inventory.skills).map((skill) => item(skill, skill.description)),
    mcpServers: once(inventory.servers).map((server) => item(server, server.startsProcess ? "Runs a program on the machine of whoever uses it" : `Reached over ${server.transport}`)),
    commands: once(inventory.commands).map((command) => item(command, command.description)),
  };
}

const names = (value: unknown, what: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new ChangeRefused(`${what} is a list of names`);
  return [...new Set(value)];
};

/** Text as a change carries it, or null for bytes that are not UTF-8 text, which a request through the orchestrator cannot carry. */
function textOf(path: string): string | null {
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  return bytes.includes(0) || Buffer.from(text, "utf8").length !== bytes.length ? null : text;
}

/**
 * One change to the team repository with what the person picked from their own Claude Code: a name
 * the team does not carry is added, one it carries is replaced by the person's copy. Every pick is
 * screened before anything is built, as /handbook:share screens it, and one that holds a credential
 * stops the whole change: nothing of it reaches a request.
 */
export async function buildHandbookChange(mirror: string, head: string, raw: unknown, paths: InventoryPaths = {}): Promise<BuiltChange> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const pick = { skills: names(input.skills, "skills"), servers: names(input.mcpServers, "mcpServers"), commands: names(input.commands, "commands") };
  if (!pick.skills.length && !pick.servers.length && !pick.commands.length) throw new ChangeRefused("pick at least one skill, MCP server or command");
  const team = await teamHandbook(mirror, head);
  const inventory = buildInventory(paths, team);
  const mine = <T extends { name: string; shareable: boolean; reason?: string }>(items: T[], name: string, what: string): T => {
    const found = items.find((i) => i.name === name);
    if (!found) throw new ChangeRefused(`your Claude Code has no ${what} ${name}`);
    if (!found.shareable) throw new ChangeRefused(`${name} cannot go to the team: ${found.reason ?? "it does not pass the share rules"}`);
    return found;
  };
  const files: FileChange[] = [];
  const write = (path: string, content: string) => {
    const secret = detectSecret(content);
    if (secret) throw new ChangeRefused(`${path} looks like it holds a secret (${secret}); nothing was proposed`);
    files.push({ path, content });
  };

  for (const name of pick.skills) {
    const skill = mine(inventory.skills, name, "skill");
    const audit = auditSkillDir(skill.dir);
    if (!audit.shareable) throw new ChangeRefused(`${name} cannot go to the team: ${audit.detail ?? audit.reason ?? "it does not pass the share rules"}`);
    const base = `skills/${name}`;
    const taken = new Set<string>();
    for (const rel of audit.files!) {
      const path = `${base}/${rel}`;
      const content = rel === "SKILL.md" ? audit.skillMd! : textOf(join(skill.dir, rel));
      if (content === null) throw new ChangeRefused(`${name} carries ${rel}, which is not text; share it with /handbook:share from your terminal`);
      if ((await show(mirror, head, path)) !== content) write(path, content);
      taken.add(path);
    }
    if (!taken.has(`${base}/SKILL.md`)) {
      write(`${base}/SKILL.md`, audit.skillMd!);
      taken.add(`${base}/SKILL.md`);
    }
    for (const path of await filesUnder(mirror, head, base)) if (!taken.has(path)) files.push({ path, content: null });
  }

  if (pick.servers.length) {
    const entries = pick.servers.map((name) => mine(inventory.servers, name, "MCP server").entry);
    const existing = await show(mirror, head, MCP_FILE);
    const { merged } = mergeServersIntoMcpJson(existing, entries, (name) => team.servers.includes(name));
    if (merged !== existing) write(MCP_FILE, merged);
  }

  for (const name of pick.commands) {
    const command = mine(inventory.commands, name, "command");
    const audit = auditCommand(command.file, name);
    if (!audit.shareable) throw new ChangeRefused(`${name} cannot go to the team: ${audit.detail ?? audit.reason ?? "it does not pass the share rules"}`);
    const path = `commands/${commandFile(name)}`;
    if ((await show(mirror, head, path)) !== audit.content) write(path, audit.content!);
  }

  if (!files.length) throw new ChangeRefused("the team's copies already match yours; nothing to propose");
  const picked = [...pick.skills, ...pick.servers, ...pick.commands];
  const updated = picked.filter((name) => team.skills.includes(name) || team.servers.includes(name) || team.commands.includes(name));
  const added = picked.filter((name) => !updated.includes(name));
  return {
    files,
    proposal: `feat(handbook): ${[added.length ? `add ${added.join(", ")}` : "", updated.length ? `update ${updated.join(", ")}` : ""].filter(Boolean).join("; ")}`,
    body: [...(added.length ? [`Adds ${added.map((n) => `\`${n}\``).join(", ")} from its proposer's own Claude Code.`] : []), ...(updated.length ? [`Updates ${updated.map((n) => `\`${n}\``).join(", ")} to its proposer's copy.`] : [])],
    topic: `handbook-${picked[0]}`,
  };
}
