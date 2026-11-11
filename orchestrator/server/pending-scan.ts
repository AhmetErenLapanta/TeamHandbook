import { commandRefusal } from "./changes.js";
import type { ForgeKind, PendingShare } from "./forge/types.js";
import { FORGES, isHostedForge } from "../shared/forge-def.js";
import { gitAsyncBytes, gitAsyncMaybe } from "./git.js";
import { auditCommandText, declaredServers, detectSecret, TEAM_PREFIX_FILE } from "./plugin.js";
import { MAX_SKILL_BYTES, serverProblem, SKILL_SLUG, skillProblem } from "./skill-rules.js";
import { hostsIn, isAgentPath, supplyChainFindings } from "./supply-chain.js";
import type { SupplyCheck } from "./supply-chain.js";

export interface ScanFinding {
  /** `refused`: the plugin's share would not send it as written. `attention`: it travels, and does more than change a skill's text. */
  level: "refused" | "attention";
  path: string;
  detail: string;
  /** For a supply-chain finding: which check, how much it can do on a teammate's machine, and the line it was found on. */
  check?: SupplyCheck;
  risk?: "high" | "medium";
  line?: number;
  evidence?: string;
}

/**
 * A waiting request read against the plugin's share rules before anyone merges it. Read from
 * the orchestrator's own copy, which every sync fills with the forge's request heads, so the scan
 * asks the forge nothing and writes nothing to it: its result is shown in the orchestrator only.
 */
export interface PendingScan {
  state: "clean" | "attention" | "refused" | "unread";
  /** The commit read; null when the copy does not have the request yet. */
  head: string | null;
  findings: ScanFinding[];
  /** Why nothing was read, when it was not. */
  reason?: string;
}

/** More changed files than a review screen reads one by one; such a request is read on its forge. */
export const SCAN_MAX_FILES = 300;

const SENSITIVE: { test: (path: string) => boolean; why: string }[] = [
  { test: (p) => p.startsWith("hooks/"), why: "a hook runs on every teammate's machine at the event it names" },
  { test: (p) => p.startsWith(".claude-plugin/"), why: "the plugin's own manifest: its name, version and marketplace entry" },
  { test: (p) => p === TEAM_PREFIX_FILE, why: "the team's settings and policies, read into every teammate's session" },
];

function requestRefs(kind: ForgeKind, share: PendingShare): string[] {
  // The ref that holds a waiting request's commits in a mirror: the forge's own ref for its number,
  // and for a local branch the branch. A fork's branch name is any name, so a fork's request is
  // read only through its number.
  const own = share.number === null || !isHostedForge(kind) ? [] : [FORGES[kind].requestRef(share.number)];
  return share.fromFork ? own : [...own, `refs/heads/${share.branch}`];
}

interface Changed {
  path: string;
  mode: string;
  blob: string;
  deleted: boolean;
}

async function changedFiles(mirror: string, base: string, head: string): Promise<Changed[]> {
  const raw = (await gitAsyncMaybe(["diff", "--raw", "-z", "--no-renames", "--no-abbrev", base, head], mirror)) ?? "";
  const parts = raw.split("\0");
  const changed: Changed[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [, mode, , blob, status] = parts[i]!.split(" ");
    changed.push({ path: parts[i + 1]!, mode: mode!, blob: blob!, deleted: status === "D" });
  }
  return changed;
}

async function text(mirror: string, blob: string): Promise<string | null> {
  const size = Number((await gitAsyncMaybe(["cat-file", "-s", blob], mirror))?.trim());
  if (!Number.isFinite(size) || size > MAX_SKILL_BYTES) return null;
  return (await gitAsyncBytes(["cat-file", "blob", blob], mirror)).toString("utf8");
}

const servers = (content: string | null): Record<string, unknown> | null => {
  if (content === null) return {};
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? declaredServers(content) : null;
  } catch {
    return null;
  }
};

/** What the plugin's share rules say about each file a request changes. Values are never quoted: a finding names a file, a pattern or a key. */
async function screen(mirror: string, base: string, files: Changed[]): Promise<ScanFinding[]> {
  const findings: ScanFinding[] = [];
  const refuse = (path: string, detail: string) => findings.push({ level: "refused", path, detail });
  const note = (path: string, detail: string) => findings.push({ level: "attention", path, detail });
  let known: Set<string> | null = null;
  const knownHosts = async () => (known ??= await hostsAt(mirror, base));
  for (const file of files) {
    const skill = /^skills\/([^/]+)\/(.+)$/.exec(file.path);
    const command = /^commands\/(.+)\.md$/.exec(file.path);
    if (file.deleted) {
      if (skill?.[2] === "SKILL.md") note(file.path, `removes the skill ${skill[1]}`);
      else if (command) note(file.path, `removes the command /${command[1]!.split("/").join(":")}`);
      else if (file.path === ".mcp.json") note(file.path, "deletes .mcp.json: every MCP server the team shares goes with it");
      const sensitive = SENSITIVE.find((s) => s.test(file.path));
      if (sensitive) note(file.path, `deleted: ${sensitive.why}`);
      continue;
    }
    // A link is not screened for what it points at, so the plugin's share sends none.
    if (file.mode === "120000" && (skill || command)) {
      refuse(file.path, "a symbolic link, which the plugin's share does not send");
      continue;
    }
    const content = file.mode === "160000" ? null : await text(mirror, file.blob);
    if (content === null && (skill || command || file.path === ".mcp.json")) {
      refuse(file.path, `larger than ${MAX_SKILL_BYTES / 1024} KiB or not a file, so it is not screened`);
      continue;
    }
    if (content !== null && isAgentPath(file.path)) {
      findings.push(...supplyChainFindings(file.path, content, await gitAsyncMaybe(["show", `${base}:${file.path}`], mirror), await knownHosts()));
    }
    if (skill) {
      const [, slug, rest] = skill;
      if (!SKILL_SLUG.test(slug!)) refuse(file.path, `skills/${slug} is a folder name the plugin does not read (lower-case letters, digits and dashes)`);
      else if (rest === "SKILL.md") {
        const problem = skillProblem(slug!, content!);
        if (problem) refuse(file.path, problem);
      } else {
        const secret = detectSecret(content!);
        if (secret) refuse(file.path, `looks like it contains a ${secret}`);
      }
      continue;
    }
    if (command) {
      const name = command[1]!.split("/").join(":");
      const audit = auditCommandText(name, content!);
      if (!audit.shareable) refuse(file.path, commandRefusal(name, audit));
      continue;
    }
    if (file.path === ".mcp.json") {
      const after = servers(content);
      if (!after) {
        refuse(file.path, "not a JSON object with an mcpServers object");
        continue;
      }
      const before = servers(await gitAsyncMaybe(["show", `${base}:.mcp.json`], mirror)) ?? {};
      for (const [name, config] of Object.entries(after)) {
        if (JSON.stringify(before[name]) === JSON.stringify(config)) continue;
        const checked = serverProblem(name, config);
        if ("refused" in checked) refuse(file.path, checked.refused);
        else if (checked.audit.startsProcess) note(file.path, `${name in before ? "changes" : "adds"} the server ${name}, which starts a command on every teammate's machine`);
      }
      for (const name of Object.keys(before)) if (!(name in after)) note(file.path, `removes the server ${name}`);
      continue;
    }
    const sensitive = SENSITIVE.find((s) => s.test(file.path));
    if (sensitive) {
      const secret = content === null ? null : detectSecret(content);
      if (secret) refuse(file.path, `looks like it contains a ${secret}`);
      else note(file.path, `changed: ${sensitive.why}`);
    }
  }
  return findings;
}

/** Every host an http(s) address in the default branch names, read once per scan: an address the team already uses is not new. */
async function hostsAt(mirror: string, base: string): Promise<Set<string>> {
  const found = (await gitAsyncMaybe(["grep", "-I", "-h", "-o", "-E", "https?://[^/[:space:]\"'<>]+", base], mirror)) ?? "";
  return new Set(hostsIn(found));
}

const scanned = new Map<string, PendingScan>();
const SCANS_KEPT = 500;

/** One waiting request read against the share rules, kept per commit pair so a reload reads nothing again. */
export async function scanPending(mirror: string, repoHead: string, kind: ForgeKind, share: PendingShare): Promise<PendingScan> {
  let head: string | null = null;
  for (const ref of requestRefs(kind, share)) {
    head = (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], mirror))?.trim() || null;
    if (head) break;
  }
  if (!head) return { state: "unread", head: null, findings: [], reason: "the orchestrator's copy does not hold this request's commits yet; sync the repository to read them" };
  const base = (await gitAsyncMaybe(["merge-base", repoHead, head], mirror))?.trim();
  if (!base) return { state: "unread", head, findings: [], reason: "this request shares no history with the default branch" };
  const key = `${mirror}\0${base}\0${head}`;
  const known = scanned.get(key);
  if (known) return known;
  const files = await changedFiles(mirror, base, head);
  let result: PendingScan;
  if (files.length > SCAN_MAX_FILES) {
    result = { state: "unread", head, findings: [], reason: `it changes ${files.length} files, more than the ${SCAN_MAX_FILES} the orchestrator screens; read it on the forge` };
  } else {
    const findings = await screen(mirror, base, files);
    result = { state: findings.some((f) => f.level === "refused") ? "refused" : findings.length ? "attention" : "clean", head, findings };
  }
  if (scanned.size >= SCANS_KEPT) scanned.delete(scanned.keys().next().value!);
  scanned.set(key, result);
  return result;
}
