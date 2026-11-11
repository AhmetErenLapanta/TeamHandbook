import type { TaskLogLine } from "./api";

/** One step of the agent's own plan, as its latest todo list has it. */
export interface PlanStep { text: string; state: "todo" | "doing" | "done" }

export type CallStatus = "started" | "done" | "failed" | "refused";

/** One call as the agent made it: the tool by its own name, its main argument, how it ended, and the orchestrator's own words for why when it was refused. */
export interface ToolCall { tool: string; target: string | null; status: CallStatus; reason: string | null }

/**
 * A tool call as one line: what the agent did, to what, in which service, how it ended, and what it
 * showed. Calls of one kind in a row join into one line; each stays in `calls`, for the fold.
 */
export interface ToolLine {
  kind: "tool";
  key: string;
  at: string;
  /** The tool's name in the product's words: Read, Edited, Ran, Searched, or "Used <its name in words>". */
  verb: string;
  /** The service an MCP tool reaches, as people call it, else its server's name; null for a built-in tool. */
  source: string | null;
  /** What a call acts on when its event names nothing: "an issue". */
  object: string | null;
  calls: ToolCall[];
  status: CallStatus;
  output: string[];
  /** How many lines the call printed, held or not; a file read keeps none of them. */
  outputTotal: number;
  change: { additions: number; deletions: number; patch: string | null } | null;
}

/** A line of the stream: the agent's words, a tool call, a decision taken on a card, what a person told it, or a pause. */
export type StreamLine =
  | { kind: "say"; key: string; at: string; text: string }
  | { kind: "you"; key: string; at: string; text: string; by: string | null }
  | ToolLine
  | { kind: "card"; key: string; at: string; text: string }
  | { kind: "time"; key: string; at: string };

export interface LiveRun { plan: PlanStep[]; stream: StreamLine[]; changed: { path: string; additions: number; deletions: number }[]; costUsd: number | null }

/** Lines of a command's output its fold shows: the end of a long run is what a reader looks for. */
export const OUTPUT_KEPT = 20;
/** Lines a call holds for Show all; a longer output keeps its last ones and its count says how long it was. */
export const OUTPUT_HELD = 2000;
/** A pause between two lines longer than this gets a line of its own with the time. */
const PAUSE_MS = 60_000;

/** Services an MCP tool is known to reach, by a word in its name or its server's. */
const SOURCES: Record<string, string> = { jira: "Jira", confluence: "Confluence", github: "GitHub", gitlab: "GitLab", sentry: "Sentry", linear: "Linear", notion: "Notion", slack: "Slack" };
/** An MCP tool's first word as the verb it is said with. */
const MCP_VERBS: Record<string, string> = { get: "Read", fetch: "Read", view: "Read", read: "Read", search: "Searched", query: "Searched", find: "Searched" };
/** The thing a tool acts on, said when its event names no target. */
const OBJECTS: Record<string, string> = { issue: "an issue", issues: "issues", page: "a page", pages: "pages", comment: "a comment", comments: "comments", project: "a project", projects: "projects", message: "a message", messages: "messages", channel: "a channel" };

const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_\-]+/).filter(Boolean).map((w) => w.toLowerCase());

/** A server's name as the person knows it: the service it reaches when that is known (GitLab, Notion), else its own name. */
export function serviceName(server: string): string {
  const known = words(server).find((w) => SOURCES[w]);
  return known ? SOURCES[known]! : server;
}

/**
 * A tool's name in the product's words: its verb, the service it reaches, and what it acts on when
 * nothing else says. An adapter that names an MCP call's server and tool apart passes them as `mcp`;
 * otherwise they are read from the tool's own name, `mcp__<server>__<tool>`.
 */
export function toolWords(tool: string, named?: { server: string; tool: string } | null): { verb: string; source: string | null; object: string | null } {
  const parsed = /^mcp__(.+?)__(.+)$/.exec(tool);
  const mcp = named ? [tool, named.server, named.tool] : parsed;
  if (!mcp) return { verb: VERBS[tool] ?? `Used ${words(tool).join(" ")}`, source: null, object: null };
  const server = (named ? mcp[1]! : mcp[1]!.replace(/^plugin_[^_]+_/, ""));
  const name = words(mcp[2]!);
  const known = [...name, ...words(server)].find((w) => SOURCES[w]);
  const source = known ? SOURCES[known]! : words(server).join(" ");
  const verb = MCP_VERBS[name[0] ?? ""];
  if (!verb) return { verb: `Used ${name.filter((w) => w !== known).join(" ")}`, source, object: null };
  const object = name.slice(1).map((w) => OBJECTS[w]).find(Boolean) ?? null;
  return { verb, source, object };
}

/** Tools whose target is a path. */
const PATH_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "Glob", "Grep"]);

/** Where a run works and the person's home, so a path reads short: relative to the folder, and from home as `~` outside it. */
export interface RunPlace { folder: string | null; home: string | null }

/** A path as the person reads it: inside the task's folder relative to it, under home as `~`, anything else whole. */
export function shortPath(path: string, { folder, home }: RunPlace): string {
  if (!path.startsWith("/")) return path;
  if (folder && path.startsWith(`${folder}/`)) return path.slice(folder.length + 1);
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

const VERBS: Record<string, string> = { Read: "Read", Edit: "Edited", MultiEdit: "Edited", Write: "Wrote", NotebookEdit: "Edited", Bash: "Ran", Grep: "Searched", Glob: "Searched", WebFetch: "Fetched", WebSearch: "Searched the web", Task: "Asked a helper" };
const PLURAL: Record<string, string> = { Read: "files", Searched: "times", Fetched: "pages" };

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

function planOf(items: unknown): PlanStep[] | null {
  if (!Array.isArray(items)) return null;
  const steps: PlanStep[] = [];
  for (const item of items) {
    const step = item as Record<string, unknown> | null;
    const said = text(step?.text);
    const state = step?.state;
    if (!said || (state !== "todo" && state !== "doing" && state !== "done")) return null;
    steps.push({ text: said, state });
  }
  return steps;
}

/**
 * The live view of a run from its log: the agent's latest plan, its words and tool calls in order,
 * the files it changed so far and what it spent. Only an event whose fields read as the contract
 * has them is drawn; anything else stays in the plain log, where its text already is.
 */
export function liveRun(log: TaskLogLine[], place: RunPlace = { folder: null, home: null }): LiveRun {
  const run: LiveRun = { plan: [], stream: [], changed: [], costUsd: null };
  const tools = new Map<string, ToolLine>();
  const calls = new Map<string, ToolCall>();
  // What each card asked, so its answer reads as one line once it is given.
  const asked = new Map<string, string>();
  const changed = new Map<string, { path: string; additions: number; deletions: number }>();
  const push = (line: StreamLine) => {
    const last = run.stream.at(-1);
    if (last && new Date(line.at).getTime() - new Date(last.at).getTime() > PAUSE_MS) run.stream.push({ kind: "time", key: `time-${line.key}`, at: line.at });
    run.stream.push(line);
  };
  for (const line of log) {
    const data = line.data;
    if (!data || data.type !== line.kind) continue;
    if (line.kind === "message") {
      const said = text(data.text)?.trim();
      if (said) push({ kind: "say", key: `say-${line.seq}`, at: line.at, text: said });
    } else if (line.kind === "steer") {
      const said = text(data.text)?.trim();
      if (said) push({ kind: "you", key: `you-${line.seq}`, at: line.at, text: said, by: text(data.by) });
    } else if (line.kind === "todos") {
      const plan = planOf(data.items);
      if (plan) run.plan = plan;
    } else if (line.kind === "usage") {
      const usd = (data.cost as Record<string, unknown> | null)?.usd;
      if (typeof usd === "number" && Number.isFinite(usd)) run.costUsd = (run.costUsd ?? 0) + usd;
    } else if (line.kind === "tool_call") {
      const tool = text(data.tool);
      const status = data.status;
      if (!tool || (status !== "started" && status !== "done" && status !== "failed" && status !== "refused")) continue;
      const id = text(data.id);
      const known = id ? tools.get(id) : undefined;
      if (known) {
        const call = calls.get(id!);
        if (call) {
          call.status = status;
          if (status === "refused") call.reason = text((data.refusal as Record<string, unknown> | null | undefined)?.reason);
        }
        known.status = status;
        continue;
      }
      const mcpData = data.mcp as Record<string, unknown> | null | undefined;
      const said = toolWords(tool, text(mcpData?.server) && text(mcpData?.tool) ? { server: text(mcpData!.server)!, tool: text(mcpData!.tool)! } : null);
      const reason = status === "refused" ? text((data.refusal as Record<string, unknown> | null | undefined)?.reason) : null;
      const given = tool === "Bash" ? text(data.command) : text(data.target);
      // An adapter that finds no argument to show names the tool itself, which the line says in words instead.
      const call: ToolCall = { tool, target: given === tool ? null : given && PATH_TOOLS.has(tool) ? shortPath(given, place) : given, status, reason };
      const last = run.stream.at(-1);
      // Calls of one kind in a row are one line: reads one after another, or the same refusal again.
      const joins = last?.kind === "tool" && last.verb === said.verb && last.source === said.source && !last.output.length && !last.change
        && (status === "refused" ? last.status === "refused" && last.calls[0]!.tool === tool && last.calls[0]!.reason === reason : status === "started" && last.status !== "failed" && last.status !== "refused" && (PLURAL[said.verb] !== undefined || said.source !== null));
      if (joins && last?.kind === "tool") {
        last.calls.push(call);
        last.status = status;
        if (id) {
          tools.set(id, last);
          calls.set(id, call);
        }
        continue;
      }
      const tooled: ToolLine = { kind: "tool", key: `tool-${line.seq}`, at: line.at, ...said, calls: [call], status, output: [], outputTotal: 0, change: null };
      if (id) {
        tools.set(id, tooled);
        calls.set(id, call);
      }
      push(tooled);
    } else if (line.kind === "tool_output") {
      const tooled = tools.get(text(data.id) ?? "");
      const lines = Array.isArray(data.lines) ? data.lines.filter((l): l is string => typeof l === "string") : [];
      if (tooled) {
        tooled.outputTotal += lines.length;
        // What a file read returned is the file, which is not drawn: only how many lines it was.
        if (!tooled.calls.every((c) => c.tool === "Read")) tooled.output = [...tooled.output, ...lines].slice(-OUTPUT_HELD);
      }
    } else if (line.kind === "edit") {
      const path = text(data.path);
      const additions = count(data.additions);
      const deletions = count(data.deletions);
      if (!path || additions === null || deletions === null) continue;
      const tooled = tools.get(text(data.id) ?? "");
      if (tooled) tooled.change = { additions, deletions, patch: text(data.patch) };
      const before = changed.get(path);
      changed.set(path, { path, additions: (before?.additions ?? 0) + additions, deletions: (before?.deletions ?? 0) + deletions });
    } else if (line.kind === "request") {
      const request = data.request as Record<string, unknown> | null;
      const id = text(request?.id);
      const summary = text(request?.summary);
      if (id && summary) asked.set(id, request?.kind === "question" ? "the question" : summary);
    } else if (line.kind === "request_resolved") {
      const what = asked.get(text(data.requestId) ?? "");
      const said = what ? decided(data.decision, what) : null;
      if (said) push({ kind: "card", key: `card-${line.seq}`, at: line.at, text: said });
    }
  }
  run.changed = [...changed.values()];
  return run;
}

/** A card once it is answered, in one line: "You allowed npm test once". */
function decided(decision: unknown, what: string): string | null {
  if (decision === "allow-once") return `You allowed ${what} once`;
  if (decision === "allow-for-task") return `You allowed ${what} for this task`;
  if (decision === "deny") return `You denied ${what}`;
  return null;
}

const listed = (items: string[], most: number, noun: string) => {
  const shown = items.slice(0, items.length > most + 1 ? most : items.length);
  const rest = items.length - shown.length;
  if (rest) return `${shown.join(", ")} and ${rest} more ${noun}`;
  return shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
};

/**
 * A tool line in words, its parts for the page to set apart: "Read PAY-412 in Jira", "Searched
 * Confluence for "release notes"", "Read deliver.ts, retry.ts and 2 more files", "Ran npm test".
 * `target` is the part in mono, a path or a command; `after` follows it in the line's own words.
 */
export function toolSaid(line: ToolLine): { before: string; target: string | null; after: string } {
  const targets = line.calls.map((c) => c.target).filter((t): t is string => t !== null);
  const searched = line.verb === "Searched";
  const quoted = (t: string) => (searched ? `"${t}"` : t);
  if (line.status === "refused" || line.calls.length === 1) {
    const one = targets[0] ?? null;
    if (line.source) {
      if (searched) return { before: `Searched ${line.source}`, target: null, after: one ? ` for ${quoted(one)}` : "" };
      if (line.verb.startsWith("Used ")) return { before: `${line.verb} in ${line.source}`, target: null, after: "" };
      return { before: `${line.verb} ${one ?? line.object ?? "it"} in ${line.source}`, target: null, after: "" };
    }
    return one ? { before: line.verb, target: searched ? null : one, after: searched ? ` ${quoted(one)}` : "" } : { before: line.verb, target: null, after: "" };
  }
  if (searched) return { before: `Searched${line.source ? ` ${line.source}` : ""} ${line.calls.length} times`, target: null, after: targets.length ? `: ${listed(targets.map(quoted), 2, "")}`.trimEnd() : "" };
  const noun = PLURAL[line.verb] ?? (line.source ? "" : "times");
  return { before: `${line.verb} ${listed(targets.length === line.calls.length ? targets : targets.concat(Array(line.calls.length - targets.length).fill(line.object ?? "it")), 2, noun).trimEnd()}${line.source ? ` in ${line.source}` : ""}`, target: null, after: "" };
}

const COMMAND_SHOWN = 80;

/** A command as its line says it: the first line, cut at a width the row holds; the whole command is in the fold. */
export function commandLine(command: string): string {
  const first = command.trim().split("\n")[0]!.replace(/\s+/g, " ");
  return first.length > COMMAND_SHOWN || command.trim().includes("\n") ? `${first.slice(0, COMMAND_SHOWN).trimEnd()}…` : first;
}

/** A Markdown file the agent wrote whole, as the text it holds: a plan or a note reads as a page, never as a diff of added lines. */
export function writtenDocument(line: ToolLine): string | null {
  const target = line.calls.length === 1 ? line.calls[0]!.target : null;
  if (!target || !/\.md$/i.test(target) || !line.change?.patch || line.change.deletions > 0) return null;
  const added = line.change.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  return added.length ? added.map((l) => l.slice(1)).join("\n") : null;
}

/** The plan the agent wrote into its plan folder, the last one, for a run from before a plan reached its person as a card. */
export function writtenPlan(stream: StreamLine[]): string | null {
  for (const line of [...stream].reverse()) {
    if (line.kind !== "tool" || !line.calls.some((c) => c.target?.includes(".orchestrator-plans/"))) continue;
    const text = writtenDocument(line);
    if (text?.trim()) return text;
  }
  return null;
}

/** What a line's result says in its tone: refused (with how many times), failed, or passed for a command. */
export function toolResult(line: ToolLine): { word: string; tone: string } | null {
  if (line.status === "refused") return { word: line.calls.length > 1 ? `refused ${line.calls.length} times` : "refused", tone: "error" };
  if (line.status === "failed") return { word: "failed", tone: "error" };
  if (line.verb === "Ran" && line.status === "done") return { word: "passed", tone: "ok" };
  return null;
}
