import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { HookInput } from "./hook-io.js";
import { configIsBroken, readConfigFile } from "./config.js";
import { bumpCounter } from "./counters.js";
import { detectIdentity, hostIdentity } from "./identity.js";
import type { HostIdentity } from "./identity.js";
import { detectSecret } from "./secrets.js";
import { sessionSignalCount } from "./signals.js";
import { isBashSuccess } from "./tool-response.js";
import { writeFileAtomic } from "./fs-atomic.js";
import { handbookHome, loadSessionState, saveSessionState } from "./session-state.js";
import type { SessionState, WorkflowSignal, WorkflowTrail } from "./session-state.js";
import {
  buildRoleResolver,
  IGNORED_ROLES,
  isDocPath,
  KEY_CANDIDATE,
  NOT_A_TICKET,
  repoLabels,
  restoreRoleResolver,
  saveRoleResolver,
} from "./mine.js";
import type { SavedRoleResolver, Shape, UnitCollection } from "./mine.js";
import { commandWrites, gitInvocation, programOf, simpleCommands, statusReaches } from "./shell-command.js";
import type { SimpleCommand } from "./shell-command.js";

/** One recognized session. Every identifying value in it is a salted hash; no path, command or text is kept. */
export interface WorkflowLine {
  ts: string;
  session: string;
  signal: WorkflowSignal;
  match: "shape" | "candidate";
  shape: string | null;
  roles: string[];
  repos: string[];
  rolesEdited: number;
  signals: number;
  ticket: string | null;
  maskedCheck: boolean;
}

export const WORKFLOW_LINE_FIELDS = [
  "ts",
  "session",
  "signal",
  "match",
  "shape",
  "roles",
  "repos",
  "rolesEdited",
  "signals",
  "ticket",
  "maskedCheck",
] as const;

/** How much of a mined workflow's core a session has to touch to count as doing it. */
const SHAPE_SHARE = 0.6;
/** Two (repository, role) pairs: one file and its neighbour is an edit, not a workflow. */
const MIN_ROLES = 2;
/** A long session keeps writing; past this many files the trail stops growing rather than the state file. */
const MAX_TRAIL_EDITS = 1000;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

export function workflowsFile(home: string = handbookHome()): string {
  return join(home, "workflows.jsonl");
}

export function minedRecordFile(home: string = handbookHome()): string {
  return join(home, "mined-workflows.json");
}

/**
 * On unless switched off. A config file that exists but cannot be read counts as off, the same
 * way the other switches that decide what is kept fail closed: a typo must not turn recording
 * back on for someone who turned it off.
 */
export function sessionDetectEnabled(home: string = handbookHome()): boolean {
  const sessions = readConfigFile(home).sessions as Record<string, unknown> | undefined;
  return !configIsBroken(home) && sessions?.detect !== false;
}

/**
 * Print mode and the agent SDKs have nobody at the keyboard: a product's own subprocess, an
 * observer, or a loop driving the session. Counting them would put every scripted run in the
 * denominator of a question about how people work.
 */
export function isAutonomous(entrypoint: string | undefined): boolean {
  return !!entrypoint && entrypoint.startsWith("sdk");
}

// ---------------------------------------------------------------------------
// Where a file lives
// ---------------------------------------------------------------------------

/** A file inside a repository: the main checkout's root, the checkout it was written in, and its path there. */
export interface RepoFile {
  repo: string;
  checkout: string;
  path: string;
}

export interface RepoLocator {
  locate(path: string): RepoFile | null;
  /** The paths git ignores in a checkout: a note kept beside the code is not the code. */
  ignored(checkout: string, paths: string[]): Set<string>;
  branch(checkout: string): string | null;
}

/**
 * The repository a directory belongs to. A linked worktree is folded onto its main checkout:
 * otherwise the same repository edited from a worktree and from the main checkout reads as two
 * repositories, which alone clears the two-role floor, and every ticket's worktree would hash to
 * a repository of its own.
 */
export function repositoryOf(dir: string): { repo: string; checkout: string; gitdir: string } | null {
  let at = resolve(dir);
  for (;;) {
    const dotgit = join(at, ".git");
    try {
      const stat = statSync(dotgit);
      // The repository is named by its real path: git writes a worktree's pointer through
      // symlinks resolved, while the tools report the path as typed, and the two spellings of one
      // repository would otherwise hash as two.
      if (stat.isDirectory()) return { repo: realpathSync(at), checkout: at, gitdir: dotgit };
      if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"));
        if (pointer) {
          const gitdir = resolve(at, pointer[1]!.trim());
          const marker = `${sep}.git${sep}worktrees${sep}`;
          const cut = gitdir.lastIndexOf(marker);
          return { repo: realpathSync(cut >= 0 ? gitdir.slice(0, cut) : at), checkout: at, gitdir };
        }
      }
    } catch {
      // not here; keep walking
    }
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

export const diskLocator: RepoLocator = {
  locate(path) {
    const found = repositoryOf(dirname(path));
    if (!found) return null;
    const rel = relative(found.checkout, path).split(sep).join("/");
    if (!rel || rel.startsWith("../") || rel === ".git" || rel.startsWith(".git/")) return null;
    return { repo: found.repo, checkout: found.checkout, path: rel };
  },
  ignored(checkout, paths) {
    if (paths.length === 0) return new Set();
    const result = spawnSync("git", ["-C", checkout, "check-ignore", "--stdin"], {
      input: paths.join("\n"),
      encoding: "utf8",
      timeout: 2_000,
    });
    // Exit 1 means none are ignored. A git that cannot answer leaves every path counted: the
    // cost is a note file read as code, never a record of something that was not written.
    if (result.status !== 0 || typeof result.stdout !== "string") return new Set();
    return new Set(result.stdout.split("\n").filter(Boolean));
  },
  branch(checkout) {
    const found = repositoryOf(checkout);
    if (!found) return null;
    try {
      const head = readFileSync(join(found.gitdir, "HEAD"), "utf8");
      return /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() ?? null;
    } catch {
      return null;
    }
  },
};

// ---------------------------------------------------------------------------
// The miner's last run, as the vocabulary a session is named in
// ---------------------------------------------------------------------------

export interface MinedRecord {
  version: 1;
  at: string;
  repos: { root: string; label: string; family: string }[];
  resolver: SavedRoleResolver;
  prefixes: string[];
  shapes: { id: string; core: string[]; recurrence: number }[];
}

/**
 * Keep what the last `/handbook:mine` run learned, so a session can be named in the same roles
 * without reading any history: the resolver's layout tables, which repository each label stands
 * for, and the core roles of every shape it listed.
 */
export function saveMinedRecord(
  repoPaths: string[],
  collection: UnitCollection,
  shapes: Shape[],
  home: string = handbookHome(),
  now: string = new Date().toISOString(),
): void {
  const unreadable = new Set(collection.unreadable.map((u) => u.path));
  const labels = repoLabels(repoPaths);
  const repos: MinedRecord["repos"] = [];
  for (const path of repoPaths) {
    if (unreadable.has(path)) continue;
    const found = repositoryOf(path);
    const label = labels.get(path)!;
    if (found) repos.push({ root: found.repo, label, family: collection.families.get(label) ?? label });
  }
  const record: MinedRecord = {
    version: 1,
    at: now,
    repos,
    resolver: saveRoleResolver(collection.resolver),
    prefixes: [...collection.prefixes].sort(),
    shapes: shapes.map((s) => ({ id: s.id, core: s.coreFiles.map((f) => f.role), recurrence: s.recurrence })),
  };
  writeFileAtomic(minedRecordFile(home), JSON.stringify(record));
}

export function loadMinedRecord(home: string = handbookHome()): MinedRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(minedRecordFile(home), "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.repos) || !Array.isArray(parsed.shapes)) return null;
    return parsed as MinedRecord;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface Detection {
  match: "shape" | "candidate";
  shape: string | null;
  /** `(repository root, role)` pairs. In memory only: what reaches disk is their hashes. */
  pairs: { repo: string; role: string }[];
}

/**
 * Whether the files a session wrote are a piece of workflow: at least two distinct (repository,
 * role) pairs, and then either most of a mined workflow's core (`shape`) or a role set of its own
 * (`candidate`). Roles come from the miner's resolver, restored from its last run when there is
 * one, so a session and a git history are named in the same words.
 */
export function detectWorkflow(files: RepoFile[], mined: MinedRecord | null): Detection | null {
  if (files.length === 0) return null;
  const resolver = mined ? restoreRoleResolver(mined.resolver) : buildRoleResolver(files.map((f) => f.path));
  // A repository the session only wrote prose in - a note, a brief, a report - had no work done
  // in it, for the same reason the miner sets a docs-only commit aside.
  const worked = new Set(files.filter((f) => !isDocPath(f.path)).map((f) => f.repo));
  const pairs = new Map<string, { repo: string; role: string }>();
  for (const file of files) {
    if (!worked.has(file.repo)) continue;
    const role = resolver(file.path);
    if (IGNORED_ROLES.has(role)) continue;
    pairs.set(`${file.repo}\u0000${role}`, { repo: file.repo, role });
  }
  if (pairs.size < MIN_ROLES) return null;
  const list = [...pairs.values()];
  const shape = mined ? bestShape(list, mined) : null;
  return { match: shape ? "shape" : "candidate", shape, pairs: list };
}

function bestShape(pairs: { repo: string; role: string }[], mined: MinedRecord): string | null {
  const names = new Map(mined.repos.map((r) => [r.root, r]));
  const held = new Set<string>();
  for (const { repo, role } of pairs) {
    const named = names.get(repo);
    if (!named) continue;
    held.add(`${named.label}:${role}`);
    held.add(`${named.family}:${role}`);
  }
  let best: { id: string; share: number; recurrence: number } | null = null;
  for (const shape of mined.shapes) {
    if (shape.core.length === 0) continue;
    const share = shape.core.filter((role) => held.has(role)).length / shape.core.length;
    if (share < SHAPE_SHARE) continue;
    if (!best || share > best.share || (share === best.share && shape.recurrence > best.recurrence)) {
      best = { id: shape.id, share, recurrence: shape.recurrence };
    }
  }
  return best?.id ?? null;
}

// ---------------------------------------------------------------------------
// What a command does
// ---------------------------------------------------------------------------

const PACKAGE_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const SCRIPT_CHECK = /^(test|tests|t|e2e|spec|build|compile|typecheck|type-check|tsc|check)(:|$)/;
const TOOL_CHECKS = new Set(["vitest", "jest", "mocha", "ava", "pytest", "py.test", "tox", "rspec", "phpunit", "tsc"]);
const SUBCOMMAND_CHECKS: Record<string, Set<string>> = {
  go: new Set(["test", "build", "vet"]),
  cargo: new Set(["test", "build", "check", "nextest"]),
  dotnet: new Set(["test", "build"]),
  swift: new Set(["test", "build"]),
  bazel: new Set(["test", "build"]),
  bazelisk: new Set(["test", "build"]),
  playwright: new Set(["test"]),
  cypress: new Set(["run"]),
};
const MAVEN_PHASES = new Set(["test", "verify", "compile", "package", "install"]);
const GRADLE_TASK = /(^|:)(test\w*|check|build|assemble\w*|compile\w*)$/;
const MAKE_TARGETS = new Set(["test", "check", "build", "all"]);

const positional = (args: string[]) => args.filter((a) => !a.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a));

/** Whether a command is a test or a build: the checks whose passing says the work holds together. */
export function isCheck(cmd: SimpleCommand): boolean {
  const [program, ...args] = programOf(cmd);
  if (!program) return false;
  const name = basename(program);
  const words = positional(args);
  if (PACKAGE_RUNNERS.has(name)) {
    const [sub, next] = words;
    if (sub === "exec" || sub === "dlx" || sub === "x") return !!next && TOOL_CHECKS.has(basename(next));
    const script = sub === "run" || sub === "run-script" ? next : sub;
    return !!script && SCRIPT_CHECK.test(script);
  }
  if (name === "npx" || name === "bunx") {
    const [tool, sub] = words;
    if (!tool) return false;
    const toolName = basename(tool);
    return TOOL_CHECKS.has(toolName) || (!!sub && !!SUBCOMMAND_CHECKS[toolName]?.has(sub));
  }
  if (TOOL_CHECKS.has(name)) return true;
  if (/^python[0-9.]*$/.test(name)) {
    const module = args[args.indexOf("-m") + 1];
    return args.includes("-m") && (module === "pytest" || module === "unittest");
  }
  if (name === "node") return args.includes("--test");
  if (SUBCOMMAND_CHECKS[name]) return !!words[0] && SUBCOMMAND_CHECKS[name]!.has(words[0]);
  if (name === "mvn" || name === "mvnw") return words.some((w) => MAVEN_PHASES.has(w));
  if (name === "gradle" || name === "gradlew") return words.some((w) => GRADLE_TASK.test(w));
  if (name === "make") return words.length === 0 || words.some((w) => MAKE_TARGETS.has(w));
  if (name === "xcodebuild") return words.some((w) => w === "test" || w === "build");
  return false;
}

export function isCommit(cmd: SimpleCommand): boolean {
  const [program, ...args] = programOf(cmd);
  return !!program && basename(program) === "git" && gitInvocation(args, ".", ".").sub === "commit";
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface WorkflowDeps {
  /** The entry point Claude Code reports; an empty string is one it did not report. */
  entrypoint?: string;
  locator?: RepoLocator;
  host?: HostIdentity;
  /** The user's home directory, for `~` in a shell target; not the handbook home. */
  userHome?: string;
  now?: () => string;
}

function emptyTrail(): WorkflowTrail {
  return { edits: [], green: false, masked: false, fired: [] };
}

/**
 * Note what one tool call did to the session's trail: the files it wrote inside a repository, a
 * check it ran and whether that check's status can be trusted, and a commit. A commit that lands
 * while the latest check since the last write is green is S1, and records the session at that
 * moment.
 */
export function recordWorkflowEvent(
  input: HookInput,
  home: string = handbookHome(),
  deps: WorkflowDeps = {},
): WorkflowLine | null {
  if (!input.session_id || !sessionDetectEnabled(home)) return null;
  if (isAutonomous(deps.entrypoint ?? process.env.CLAUDE_CODE_ENTRYPOINT)) return null;
  const locator = deps.locator ?? diskLocator;
  const userHome = deps.userHome ?? homedir();
  const cwd = input.cwd ?? "";
  const steps: ({ kind: "write"; path: string } | { kind: "check"; green: boolean; masked: boolean } | { kind: "commit"; ok: boolean })[] = [];

  if (EDIT_TOOLS.has(input.tool_name ?? "")) {
    const filePath = typeof input.tool_input?.file_path === "string" ? input.tool_input.file_path : "";
    if (filePath) steps.push({ kind: "write", path: resolve(cwd || "/", filePath) });
  } else if (input.tool_name === "Bash") {
    const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
    if (!command) return null;
    // The line's exit status stands for every check in it. Most checks in real sessions are piped
    // into tail or grep, which hides their own status; reading those as unknown left the signals
    // all but silent, so they count by the line's status and are marked as read that way.
    const ok = isBashSuccess(input);
    const cmds = simpleCommands(command);
    cmds.forEach((cmd, index) => {
      for (const path of commandWrites(cmds, index, cwd, userHome)) steps.push({ kind: "write", path });
      if (isCheck(cmd)) steps.push({ kind: "check", green: ok, masked: !statusReaches(cmds, index) });
      if (isCommit(cmd)) steps.push({ kind: "commit", ok });
    });
  }
  if (steps.length === 0) return null;

  const state = loadSessionState(input.session_id, home);
  const trail = state.workflow ?? emptyTrail();
  let line: WorkflowLine | null = null;
  let changed = false;
  for (const step of steps) {
    if (step.kind === "write") {
      if (!locator.locate(step.path)) continue;
      trail.green = false;
      trail.masked = false;
      if (!trail.edits.includes(step.path) && trail.edits.length < MAX_TRAIL_EDITS) trail.edits.push(step.path);
      changed = true;
    } else if (step.kind === "check") {
      trail.green = step.green;
      trail.masked = step.masked;
      changed = true;
    } else if (step.ok && trail.green && !trail.fired.includes("S1")) {
      const found = detectTrail(trail, home, deps);
      const outcome = found && writeLine(state, trail, "S1", found, home, deps);
      if (outcome) {
        trail.fired.push("S1");
        if (outcome !== "hygiene") line = outcome;
      }
      changed = true;
    }
  }
  if (!changed) return null;
  state.workflow = trail;
  saveSessionState(state, home);
  return line;
}

/**
 * The end of a session: count it in the denominator (or as skipped, when nobody was driving it),
 * count what detection makes of it whether or not a signal fired, then record it under S2 if its
 * last check after its last write was green. Takes the state the caller already loaded, because
 * the session's evidence is flushed and its file deleted right after this.
 */
export function finishWorkflowSession(
  input: HookInput,
  state: SessionState,
  home: string = handbookHome(),
  deps: WorkflowDeps = {},
): WorkflowLine | null {
  if (!input.session_id || !sessionDetectEnabled(home)) return null;
  const entrypoint = deps.entrypoint ?? process.env.CLAUDE_CODE_ENTRYPOINT;
  // The variable that tells an unattended session apart is not a documented one. Counting whether
  // it arrived is what keeps "no scripted sessions" distinguishable from "nothing said which they
  // were", which would otherwise put every scripted session in the denominator without a trace.
  bumpCounter(entrypoint ? "workflowEntrypointSeen" : "workflowEntrypointMissing", home);
  if (isAutonomous(entrypoint)) {
    bumpCounter("workflowSkippedAutonomous", home);
    return null;
  }
  bumpCounter("workflowSessions", home);
  const trail = state.workflow;
  if (!trail?.edits.length) return null;
  const found = detectTrail(trail, home, deps);
  if (!found) return null;
  // Lines are written only when a signal fires; these counts are what lets a missing line be
  // read as "no workflow" rather than "no signal".
  bumpCounter(found.detection.match === "shape" ? "workflowDetectedShape" : "workflowDetectedCandidate", home);
  if (!trail.green || trail.fired.includes("S2")) return null;
  const outcome = writeLine(state, trail, "S2", found, home, deps);
  return outcome === "hygiene" ? null : outcome;
}

interface Found {
  files: RepoFile[];
  mined: MinedRecord | null;
  detection: Detection;
}

/** What detection makes of the trail so far, or null when it is not a workflow. */
function detectTrail(trail: WorkflowTrail, home: string, deps: WorkflowDeps): Found | null {
  const files = trailFiles(trail.edits, deps.locator ?? diskLocator);
  const mined = loadMinedRecord(home);
  const detection = detectWorkflow(files, mined);
  return detection ? { files, mined, detection } : null;
}

/**
 * Build the line, screen it, write it. "hygiene" when something in it carried a trace of the
 * person or a secret, in which case nothing is written and the skip is counted.
 */
function writeLine(
  state: SessionState,
  trail: WorkflowTrail,
  signal: WorkflowSignal,
  { files, mined, detection }: Found,
  home: string,
  deps: WorkflowDeps,
): WorkflowLine | "hygiene" {
  const locator = deps.locator ?? diskLocator;
  const work = workKey(files, locator, mined?.prefixes ?? []);
  // Screened before hashing as well as after: every field on disk is a hash, so screening only
  // the finished line could never find anything, and a trace in what the hashes are made of is
  // still a reason not to keep the record.
  const host = deps.host ?? hostIdentity();
  const material = [...files.map((f) => f.path), ...detection.pairs.map((p) => p.role), ...(work ? [work] : [])];
  if (material.some((text) => traced(text, host))) {
    bumpCounter("workflowSkippedHygiene", home);
    return "hygiene";
  }

  const salt = installSalt(home);
  const line: WorkflowLine = {
    ts: deps.now?.() ?? new Date().toISOString(),
    session: saltedHash(salt, "session", state.sessionId),
    signal,
    match: detection.match,
    shape: detection.shape,
    roles: [...new Set(detection.pairs.map((p) => saltedHash(salt, "role", `${p.repo}\u0000${p.role}`)))].sort(),
    repos: [...new Set(detection.pairs.map((p) => saltedHash(salt, "repo", p.repo)))].sort(),
    rolesEdited: detection.pairs.length,
    signals: sessionSignalCount(state.sessionId, home) + state.resolvedPairs.length + state.openErrors.length,
    ticket: work ? saltedHash(salt, "ticket", work) : null,
    maskedCheck: trail.masked,
  };
  const serialized = JSON.stringify(line);
  if (traced(serialized, host)) {
    bumpCounter("workflowSkippedHygiene", home);
    return "hygiene";
  }
  mkdirSync(home, { recursive: true });
  appendFileSync(workflowsFile(home), `${serialized}\n`);
  return line;
}

function traced(text: string, host: HostIdentity): boolean {
  return detectIdentity(text, host) !== null || detectSecret(text) !== null;
}

/** The trail's files that are still inside a repository and not ignored by it. */
export function trailFiles(edits: string[], locator: RepoLocator): RepoFile[] {
  const byCheckout = new Map<string, RepoFile[]>();
  for (const edit of edits) {
    const file = locator.locate(edit);
    if (!file) continue;
    const list = byCheckout.get(file.checkout) ?? [];
    list.push(file);
    byCheckout.set(file.checkout, list);
  }
  const files: RepoFile[] = [];
  for (const [checkout, list] of byCheckout) {
    const ignored = locator.ignored(checkout, list.map((f) => f.path));
    files.push(...list.filter((f) => !ignored.has(f.path)));
  }
  return files;
}

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "dev", "trunk", "HEAD"]);

/**
 * What tells this piece of work apart from the next one: the ticket key in the branch the most
 * files were written on, or the branch itself when it carries none. Only ever kept as a hash, so
 * two sessions on the same ticket can be told from two tickets that did the same work.
 */
export function workKey(files: RepoFile[], locator: RepoLocator, prefixes: string[]): string | null {
  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.checkout, (counts.get(file.checkout) ?? 0) + 1);
  const checkout = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
  const branch = checkout ? locator.branch(checkout) : null;
  if (!branch || DEFAULT_BRANCHES.has(branch)) return null;
  for (const match of branch.matchAll(KEY_CANDIDATE)) {
    const prefix = match[1]!;
    if (NOT_A_TICKET.has(prefix) || (prefixes.length > 0 && !prefixes.includes(prefix))) continue;
    return match[0];
  }
  return branch;
}

/**
 * One random salt per install. Stable, so the same ticket or role set hashes alike across sessions
 * and repetition can be counted; local, so a copied record cannot be matched against a list of
 * guesses without it.
 */
function installSalt(home: string): Buffer {
  const file = join(home, "workflow-salt");
  try {
    return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
  } catch {
    mkdirSync(home, { recursive: true });
    try {
      writeFileSync(file, randomBytes(16).toString("hex"), { flag: "wx", mode: 0o600 });
    } catch {
      // another hook created it first; read theirs
    }
    return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
  }
}

function saltedHash(salt: Buffer, kind: string, value: string): string {
  return createHash("sha256").update(salt).update(kind).update("\u0000").update(value).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

/**
 * Which matches count towards the number a user sees. The candidate arm is recorded but not
 * counted until how often it is right has been measured: a count that includes every multi-file
 * session would say "workflow" about work nobody would call one.
 */
const COUNTED_MATCHES = new Set(["shape"]);

export function recentWorkflowSessions(
  home: string = handbookHome(),
  now: number = Date.now(),
  days = 30,
): { recognized: number; matched: number } {
  let raw: string;
  try {
    raw = readFileSync(workflowsFile(home), "utf8");
  } catch {
    return { recognized: 0, matched: 0 };
  }
  const since = now - days * 86_400_000;
  const recognized = new Set<string>();
  const matched = new Set<string>();
  for (const text of raw.split("\n")) {
    if (!text.trim()) continue;
    let line: Partial<WorkflowLine>;
    try {
      line = JSON.parse(text);
    } catch {
      continue;
    }
    const at = Date.parse(line.ts ?? "");
    if (typeof line.session !== "string" || !Number.isFinite(at) || at < since) continue;
    if (line.match && COUNTED_MATCHES.has(line.match)) recognized.add(line.session);
    if (line.match === "shape") matched.add(line.session);
  }
  return { recognized: recognized.size, matched: matched.size };
}
