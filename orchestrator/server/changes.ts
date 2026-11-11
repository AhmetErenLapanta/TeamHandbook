import type { FileChange } from "./forge/types.js";
import { OrchestratorError } from "./errors.js";
import { gitAsyncMaybe } from "./git.js";
import {
  assignmentRecordProblem,
  auditCommandText,
  branchExampleProblem,
  commandFile,
  commitMessagePrefix,
  commitMessageProblem,
  commitPrefixProblem,
  commitSubject,
  declaredServers,
  mergeServersIntoMcpJson,
  PLUGIN_MANIFEST,
  TEAM_PREFIX_FILE,
} from "./plugin.js";
import type { CommandAudit } from "./plugin.js";
import { MAX_SKILL_BYTES, SERVER_NAME, serverProblem, SKILL_SLUG as SLUG, skillProblem } from "./skill-rules.js";
import { versionRaise, versionRaiseNote } from "./versions.js";
import { branchProblem, proposedBranch, recordedCommitPrefix, TICKET_PLACEHOLDER } from "./branches.js";
import type { TeamNaming } from "./branches.js";

/**
 * What a person can ask the orchestrator to change, turned into whole files against the commit
 * the screen showed. Every builder reads the repository at that commit, refuses rather than
 * guesses, and never writes outside the place its kind of change belongs: a skill edit
 * cannot reach .mcp.json, which is how the server rule would otherwise be walked around.
 */
export type ChangeInput =
  | { kind: "skill.add"; slug: string; content: string }
  | { kind: "skill.edit"; slug: string; content: string }
  | { kind: "skill.delete"; slug: string }
  | { kind: "mcp.add"; name: string; config: unknown }
  | { kind: "mcp.edit"; name: string; config: unknown }
  | { kind: "mcp.remove"; name: string }
  | { kind: "command.add"; name: string; content: string }
  | { kind: "command.edit"; name: string; content: string }
  | { kind: "command.delete"; name: string }
  | { kind: "team.settings"; reviewers: string[]; labels: string[] }
  | { kind: "team.naming"; commitPrefix: string; branchExample: string };

export interface BuiltChange {
  files: FileChange[];
  /** The commit title the orchestrator proposes; the person confirms or rewrites it. */
  proposal: string;
  body: string[];
  /** A short name for the branch. */
  topic: string;
}

export class ChangeRefused extends OrchestratorError {
  constructor(message: string) {
    super("change-refused", message, 400);
  }
}

export const MCP_FILE = ".mcp.json";
/** Present only when /handbook:init set up the CI job that raises the version after a merge. */
export const CI_BUMP_SCRIPT = "scripts/bump-version.mjs";

export function show(mirror: string, head: string, path: string): Promise<string | null> {
  return gitAsyncMaybe(["show", `${head}:${path}`], mirror);
}

export async function filesUnder(mirror: string, head: string, dir: string): Promise<string[]> {
  const out = await gitAsyncMaybe(["ls-tree", "-r", "--name-only", head, "--", dir], mirror);
  return out ? out.split("\n").filter(Boolean) : [];
}

async function skillFiles(input: { slug: string; content: string }, exists: boolean, mirror: string, head: string): Promise<FileChange[]> {
  if (typeof input.content !== "string") throw new ChangeRefused("SKILL.md is empty");
  const problem = skillProblem(input.slug, input.content);
  if (problem) throw new ChangeRefused(problem);
  const content = input.content.replace(/\r\n/g, "\n");
  const path = `skills/${input.slug}/SKILL.md`;
  if (exists && (await show(mirror, head, path)) === content) throw new ChangeRefused("SKILL.md is unchanged");
  return [{ path, content: content.endsWith("\n") ? content : `${content}\n` }];
}

function cleanList(values: unknown, what: string): string[] {
  if (!Array.isArray(values) || !values.every((v) => typeof v === "string")) throw new ChangeRefused(`${what} is a list of names`);
  return [...new Set((values as string[]).map((v) => v.trim()).filter(Boolean))];
}

function describeServer(name: string, config: Record<string, unknown>, requiresEnv: string[]): string[] {
  const lines = ["", `- server: \`${name}\``];
  if (typeof config.url === "string") lines.push(`- endpoint: \`${config.url}\``);
  if (typeof config.command === "string") {
    const args = Array.isArray(config.args) ? config.args.map(String) : [];
    lines.push(`- command: \`${[config.command, ...args].join(" ")}\``);
    lines.push("", "Enabling the plugin runs that command on every teammate's machine, with their privileges. Review it the way you would review a dependency.");
  }
  if (requiresEnv.length) lines.push("", `Each teammate sets ${requiresEnv.map((v) => `\`${v}\``).join(", ")} before it starts.`);
  return lines;
}

/**
 * Why the plugin's share rule refused a command, said for this screen; built from the audit's
 * fields, which name a pattern or a class of trace and never the value.
 */
export function commandRefusal(name: string, audit: CommandAudit): string {
  if (audit.reason === "unsafe-name") return "a command name is lower-case letters, digits and dashes, with a colon between a folder and the name, at most four deep, and not a device name Windows keeps, such as con or nul";
  const line = audit.secret?.line ?? (audit.identity?.where === "name" ? undefined : audit.identity?.line);
  const where = audit.identity?.where === "name" ? "its name" : `commands/${commandFile(name)}${line ? ` line ${line}` : ""}`;
  if (audit.reason === "secret") return `/${name} is not shareable as written: ${where} looks like it contains a secret (${audit.detail}); move the value into an environment variable and refer to it by name`;
  return `/${name} is not shareable as written: ${where} carries a trace of one machine (${audit.detail}); the teammate who types it has no such account or directory, so take it out`;
}

function serverName(value: unknown): string {
  const name = String(value ?? "");
  if (!SERVER_NAME.test(name)) throw new ChangeRefused("a server name is letters, digits, dot, dash or underscore");
  return name;
}

/** The team's .mcp.json without one server, in the shape the team wrote it, every other key kept. */
function withoutServer(existing: string | null, name: string): string {
  let parsed: unknown = null;
  try {
    parsed = existing === null ? null : JSON.parse(existing);
  } catch {
    throw new ChangeRefused(`${MCP_FILE} is not valid JSON; fix it in the repository first, the orchestrator will not overwrite a file it cannot read`);
  }
  const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  if (existing !== null && !isObject(parsed)) throw new ChangeRefused(`${MCP_FILE} is not a JSON object`);
  // The same reading as the plugin's merge: the documented wrapper when there is one, else a bare map of servers.
  const servers = isObject(parsed) ? (isObject(parsed.mcpServers) ? parsed.mcpServers : parsed) : {};
  if (!Object.hasOwn(servers, name)) throw new ChangeRefused(`${MCP_FILE} declares no server ${name} to remove`);
  delete servers[name];
  return JSON.stringify(parsed, null, 2) + "\n";
}

export async function buildChange(mirror: string, head: string, raw: unknown): Promise<BuiltChange> {
  const input = (raw ?? {}) as Partial<Record<string, unknown>> & { kind?: unknown };
  switch (input.kind) {
    case "skill.add":
    case "skill.edit": {
      const slug = String(input.slug ?? "");
      if (!SLUG.test(slug)) throw new ChangeRefused("a skill name is lower-case letters, digits and dashes");
      const exists = (await filesUnder(mirror, head, `skills/${slug}`)).length > 0;
      if (input.kind === "skill.add" && exists) throw new ChangeRefused(`${slug} already exists; edit it instead`);
      if (input.kind === "skill.edit" && !exists) throw new ChangeRefused(`there is no skill ${slug} to edit`);
      return {
        files: await skillFiles({ slug, content: input.content as string }, exists, mirror, head),
        proposal: `feat(skill): ${exists ? "update" : "add"} ${slug}`,
        body: [`${exists ? "Updates" : "Adds"} the skill \`${slug}\`.`],
        topic: `skill-${slug}`,
      };
    }
    case "skill.delete": {
      const slug = String(input.slug ?? "");
      if (!SLUG.test(slug)) throw new ChangeRefused("a skill name is lower-case letters, digits and dashes");
      const files = await filesUnder(mirror, head, `skills/${slug}`);
      if (!files.length) throw new ChangeRefused(`there is no skill ${slug} to remove`);
      return {
        files: files.map((path) => ({ path, content: null })),
        proposal: `chore(skill): remove ${slug}`,
        body: [`Removes the skill \`${slug}\` and every file it ships (${files.length}).`],
        topic: `remove-${slug}`,
      };
    }
    case "mcp.add":
    case "mcp.edit": {
      const name = String(input.name ?? "");
      const checked = serverProblem(name, input.config);
      if ("refused" in checked) throw new ChangeRefused(checked.refused);
      const { audit } = checked;
      const config = input.config as Record<string, unknown>;
      const existing = await show(mirror, head, MCP_FILE);
      const editing = input.kind === "mcp.edit";
      let merged: { merged: string; collided: string[]; replaced: string[] };
      try {
        merged = mergeServersIntoMcpJson(existing, [{ name, scope: "project", config }], (n) => editing && n === name);
      } catch (err) {
        throw new ChangeRefused((err as Error).message);
      }
      if (merged.collided.length) throw new ChangeRefused(`${MCP_FILE} already declares ${name}; edit it instead`);
      if (editing && !merged.replaced.includes(name)) throw new ChangeRefused(`${MCP_FILE} declares no server ${name} to edit`);
      if (editing && JSON.stringify(declaredServers(existing)[name]) === JSON.stringify(config)) throw new ChangeRefused(`${name} is unchanged`);
      return {
        files: [{ path: MCP_FILE, content: merged.merged }],
        proposal: `feat(mcp): ${editing ? "update" : "add"} ${name}`,
        body: [`${editing ? "Changes" : "Declares"} the MCP server \`${name}\` (${audit.transport}) for everyone who installs this plugin.`, ...describeServer(name, config, audit.requiresEnv)],
        topic: `mcp-${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
      };
    }
    case "command.add":
    case "command.edit": {
      const name = String(input.name ?? "");
      if (typeof input.content !== "string" || !input.content.trim()) throw new ChangeRefused("the command's text is empty");
      if (Buffer.byteLength(input.content) > MAX_SKILL_BYTES) throw new ChangeRefused("the command is larger than 256 KiB");
      const content = input.content.replace(/\r\n/g, "\n");
      // The plugin's own share rule for a command, so the orchestrator never opens one its share
      // would refuse: a name that is not a path under commands/, a secret, a trace of a machine.
      const audit = auditCommandText(name, content);
      if (!audit.shareable) throw new ChangeRefused(commandRefusal(name, audit));
      const path = `commands/${commandFile(name)}`;
      const existing = await show(mirror, head, path);
      const editing = input.kind === "command.edit";
      if (!editing && existing !== null) throw new ChangeRefused(`/${name} already exists; edit it instead`);
      if (editing && existing === null) throw new ChangeRefused(`there is no command /${name} to edit`);
      const text = content.endsWith("\n") ? content : `${content}\n`;
      if (text === existing) throw new ChangeRefused(`/${name} is unchanged`);
      return {
        files: [{ path, content: text }],
        proposal: `feat(command): ${editing ? "update" : "add"} /${name}`,
        body: [`${editing ? "Changes" : "Adds"} the slash command \`/${name}\` (${path}) for everyone who installs this plugin.`],
        topic: `command-${name.replace(/:/g, "-")}`,
      };
    }
    case "command.delete": {
      const name = String(input.name ?? "");
      const named = auditCommandText(name, "");
      if (!named.shareable) throw new ChangeRefused(commandRefusal(name, named));
      const path = `commands/${commandFile(name)}`;
      if ((await show(mirror, head, path)) === null) throw new ChangeRefused(`there is no command /${name} to remove`);
      return {
        files: [{ path, content: null }],
        proposal: `chore(command): remove /${name}`,
        body: [`Removes the slash command \`/${name}\` (${path}); teammates lose it once their plugin updates.`],
        topic: `remove-command-${name.replace(/:/g, "-")}`,
      };
    }
    case "mcp.remove": {
      const name = serverName(input.name);
      return {
        files: [{ path: MCP_FILE, content: withoutServer(await show(mirror, head, MCP_FILE), name) }],
        proposal: `chore(mcp): remove ${name}`,
        body: [`Removes the MCP server \`${name}\`; teammates' Claude Code stops starting it once their plugin updates. Every other entry in ${MCP_FILE} is kept.`],
        topic: `remove-mcp-${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
      };
    }
    case "team.settings": {
      const reviewers = cleanList(input.reviewers, "reviewers");
      const labels = cleanList(input.labels, "labels");
      // The plugin's rule for what a team file records, so the orchestrator never writes an
      // entry the plugin would drop when it opens a request: more than twenty, a comma in a
      // label, a secret's shape, a trace of a machine, a name no forge accepts.
      const problem = assignmentRecordProblem({ reviewers, labels });
      if (problem) throw new ChangeRefused(problem);
      const { existing, json } = await teamFile(mirror, head);
      const content = JSON.stringify({ ...json, reviewers, labels }, null, 2) + "\n";
      if (content === existing) throw new ChangeRefused("the reviewers and labels are unchanged");
      return {
        files: [{ path: TEAM_PREFIX_FILE, content }],
        proposal: "chore: set the reviewers and labels for requests to this repository",
        body: [
          `Requests to this repository will ask ${reviewers.join(", ") || "no one"} to review`,
          `and carry ${labels.length ? labels.join(", ") : "no label"}. Every other setting in ${TEAM_PREFIX_FILE} is kept.`,
        ],
        topic: "request-settings",
      };
    }
    case "team.naming": {
      if (typeof input.commitPrefix !== "string" || typeof input.branchExample !== "string") throw new ChangeRefused("the commit prefix and the example branch are text");
      const commitPrefix = input.commitPrefix.trim();
      const branchExample = input.branchExample.trim();
      // The plugin's own rules, so the orchestrator never records a prefix or an example that
      // teammates' TeamHandbook then leaves out.
      const prefixProblem = commitPrefixProblem(commitPrefix);
      if (prefixProblem) throw new ChangeRefused(`that commit prefix cannot be recorded: it is ${prefixProblem}`);
      const exampleProblem = branchExample ? branchExampleProblem(branchExample) : null;
      if (exampleProblem) throw new ChangeRefused(`that example branch cannot be recorded: it is ${exampleProblem}`);
      const { existing, json } = await teamFile(mirror, head);
      const recorded = recordedCommitPrefix(json.commitPrefix).prefix ?? "";
      // The CI job's own version commits carry the prefix it was written with; a new prefix in
      // the team file alone leaves that job writing commits the forge then refuses. The plugin's
      // refresh given the prefix writes both in one request; it records no empty one, so a
      // cleared prefix goes into the team file first and the job is rewritten from it.
      if (commitPrefix !== recorded && (await show(mirror, head, CI_BUMP_SCRIPT)) !== null) {
        const how = commitPrefix
          ? `run /handbook:init --upgrade --commit-prefix "${commitPrefix}" from a teammate's machine, which writes the team file and the job in one request`
          : `set commitPrefix to "" in ${TEAM_PREFIX_FILE}, then run /handbook:init --upgrade from a teammate's machine, which rewrites the job from it`;
        throw new ChangeRefused(`this repository's CI job writes its version commits with the team's prefix built in, so the prefix changes together with that job: ${how}`);
      }
      const next: Record<string, unknown> = { ...json, commitPrefix, branchExample };
      // A key written empty would read as an answer, so a cleared example is a key removed, as /handbook:init leaves it.
      if (!branchExample) delete next.branchExample;
      const content = JSON.stringify(next, null, 2) + "\n";
      if (content === existing) throw new ChangeRefused("the commit prefix and the example branch are unchanged");
      return {
        files: [{ path: TEAM_PREFIX_FILE, content }],
        proposal: "chore: set how commits and branches to this repository are named",
        body: [
          commitPrefix ? `Commits to this repository will start with \`${commitPrefix}\`.` : "Commits to this repository will carry no prefix.",
          branchExample ? `Branches will be named like \`${branchExample}\`.` : "Branches will follow no example.",
          `Every other setting in ${TEAM_PREFIX_FILE} is kept.`,
        ],
        topic: "naming",
      };
    }
    default:
      throw new ChangeRefused("unknown kind of change");
  }
}

/** The team file at `head` as an object, empty when there is none; one that is not a JSON object is refused rather than overwritten. */
export async function teamFile(mirror: string, head: string): Promise<{ existing: string | null; json: Record<string, unknown> }> {
  const existing = await show(mirror, head, TEAM_PREFIX_FILE);
  if (existing === null) return { existing, json: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    throw new ChangeRefused(`${TEAM_PREFIX_FILE} is not valid JSON; fix it in the repository first, the orchestrator will not overwrite a file it cannot read`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ChangeRefused(`${TEAM_PREFIX_FILE} is not a JSON object`);
  return { existing, json: parsed as Record<string, unknown> };
}

export interface PreparedChange {
  title: string;
  body: string;
  branch: string;
  files: FileChange[];
}

/**
 * The person's commit message, with the team's prefix on it once. The orchestrator proposes a
 * title, but never commits one nobody confirmed: a missing message is refused, not filled in.
 */
export async function prepareChange(mirror: string, head: string, input: unknown, message: unknown, by: string, naming: TeamNaming = {}, branch?: unknown): Promise<PreparedChange> {
  return prepareBuilt(mirror, head, await buildChange(mirror, head, input), message, by, naming, branch);
}

/**
 * The same for a change the orchestrator built itself rather than from what a person sent, such as
 * the usage endpoint, whose address only the orchestrator knows. Every request the orchestrator opens
 * goes through here: the person's confirmed message, the team's prefix, and the version raise
 * that makes it reach teammates.
 */
export async function prepareBuilt(mirror: string, head: string, built: BuiltChange, message: unknown, by: string, naming: TeamNaming = {}, branch?: unknown): Promise<PreparedChange> {
  if (typeof message !== "string" || !message.trim()) throw new ChangeRefused(`write the commit message; the orchestrator proposes "${built.proposal}"`);
  const problem = commitMessageProblem(message);
  if (problem) throw new ChangeRefused(`that commit message cannot be used: ${problem}`);
  // The branch the person confirmed, or the one the orchestrator proposes; either passes the same
  // screens, and a proposal still waiting for its ticket is refused rather than sent.
  const name = typeof branch === "string" ? branch : proposedBranch(built.topic, naming);
  const branchRefusal = await branchProblem(name);
  if (branchRefusal) throw new ChangeRefused(typeof branch === "string" ? branchRefusal : `this team names branches like ${naming.branchExample}; name the ticket in the branch, in place of ${TICKET_PLACEHOLDER} in ${name}`);
  const raise = await versionRaise(mirror, head);
  const body = [...built.body, "", `Proposed from the TeamHandbook Orchestrator by ${by}.`];
  if (raise) body.push(versionRaiseNote(raise));
  return {
    title: commitSubject(commitMessagePrefix(naming.commitPrefix), message),
    body: body.join("\n"),
    branch: name,
    files: raise ? [...built.files, raise.file] : built.files,
  };
}
