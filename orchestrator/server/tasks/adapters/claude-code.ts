import { resolve, sep } from "node:path";

import { MODE_LABEL } from "../../../shared/permission-mode.js";
import type { PermissionMode } from "../../../shared/permission-mode.js";
import type { AgentCapabilities, AgentChoices, AgentCodec, AgentDecoder, AgentEvent, AgentFailure, AgentOption, AgentQuestion, Refusal, RequestKind } from "./contract.js";
import { choicesProblem } from "./contract.js";
import { failure, httpFailure, resetAtFrom } from "./failure.js";
import { FORGE_REASON, TRACKER_REASON } from "../profile.js";
import { MANIFEST } from "./manifest.js";
import { answerValues, QUESTION_NOT_SHOWN, showable, UNSHOWN_QUESTION } from "./questions.js";
import { claudeReplyCost } from "./prices.js";
import { claudeMcp, createdPatch, editOf, firstContext, inFolder, num, tokensOf, outputLine, outputLines, parseLine, refusedCalls, shownTarget, signInEvents, todosOf } from "./frames.js";

/** Claude Code's `--model` aliases and `--effort` levels, from the manifest. */
export const CLAUDE_OPTIONS: readonly AgentOption[] = MANIFEST["claude-code"].options;

/** The flags for a task's choices; a choice the agent does not offer throws, as the task should never have started with it. */
export function claudeChoiceArgs(choices: AgentChoices = {}): string[] {
  const problem = choicesProblem(CLAUDE_OPTIONS, choices);
  if (problem) throw new Error(problem);
  return [...(choices.model ? ["--model", choices.model] : []), ...(choices.effort ? ["--effort", choices.effort] : [])];
}

export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  mcp: true,
  runsAsYou: true,
  resume: false,
  steer: false,
  approvals: false,
  questions: false,
  fork: false,
  rollback: false,
  usage: true,
  plan: false,
  permissionModes: ["auto"],
  options: CLAUDE_OPTIONS,
  pendingRequestsSurviveRestart: false,
};

/** A two-way session: messages reach the agent while it runs, and its permission questions reach a person. */
export const CLAUDE_TWO_WAY_CAPABILITIES: AgentCapabilities = {
  ...CLAUDE_CAPABILITIES,
  resume: true,
  steer: true,
  approvals: true,
  // AskUserQuestion, in a mode that asks; a card is shown only where the runner says it carries the answer back (LaunchOptions.questions).
  questions: true,
  // Its plan mode, left through ExitPlanMode, which asks in print mode only over the permission prompt (LaunchOptions.plan).
  plan: true,
  permissionModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
};

/**
 * Turns Claude Code's own task list on, which it keeps off by default for current models: its
 * TaskCreate and TaskUpdate calls are the live view's plan. They change nothing but the list and
 * ask no permission (seen in a recorded run, claude-code-live.ndjson).
 */
export const CLAUDE_PLAN_ENV = { CLAUDE_CODE_ENABLE_TODO_TOOLS: "true" } as const;

/** Claude Code's own mode in which it reads and plans, changes nothing, and asks to leave with ExitPlanMode. */
export const CLAUDE_PLAN_MODE = "plan";

/** The modes in which Claude Code asks: its questions come on stdout as control requests (`--permission-prompt-tool stdio`). */
export const ASKING_MODES: readonly PermissionMode[] = ["approval-required", "auto-accept-edits"];

/**
 * Claude Code's own permission mode for each of the orchestrator's. Auto is `dontAsk`: what the
 * task's rules allow runs and everything else is refused without a question, as print mode
 * has always done.
 */
export const CLAUDE_MODE: Record<PermissionMode, string> = {
  "approval-required": "default",
  "auto-accept-edits": "acceptEdits",
  auto: "dontAsk",
  "full-access": "bypassPermissions",
};

const orchestratorMode = (claude: unknown): PermissionMode | null => (Object.keys(CLAUDE_MODE) as PermissionMode[]).find((m) => CLAUDE_MODE[m] === claude) ?? null;

/**
 * Claude Code's `--output-format stream-json`. Text and tool calls come in assistant frames;
 * the result frame closes a turn with its outcome, what it spent and the calls it was refused.
 * Input tokens are the plain ones plus those written to and read from the prompt cache, and
 * stay unknown when the plain count is missing. A result's `usage` covers its own turn and
 * its `total_cost_usd` the whole session so far, so the cost a turn adds is the difference
 * from the last total. The init frame names the session and the mode the agent really runs
 * in: Claude Code passes over a mode its settings turn off without an error, and a mode other
 * than the one asked for is said in a notice. A call's end comes in the user frame that carries
 * its tool_result; `work` is the task's folder, which a changed file is named inside. `opened` is
 * the mode Claude Code was started in when it is not the one the asked mode maps to (Auto that asks
 * opens as `default`), and the init frame is held to that.
 */
export function claudeCodeDecoder(asked: PermissionMode | null = null, work?: string, opened: string | null = asked ? CLAUDE_MODE[asked] : null): AgentDecoder {
  let last: Extract<AgentEvent, { type: "turn_finished" }> | null = null;
  let failed: AgentFailure | null = null;
  let aborted = false;
  let refusedSignIn = false;
  let resetAt: string | undefined;
  let spent: number | null = null;
  let session: string | null = null;
  let told = false;
  const running = new Set<string>();
  const calls = new Map<string, Call>();
  // Calls Claude Code refused on its own, said as they happen; their error result and the result frame's list say nothing more.
  const denied = new Set<string>();
  const tasks = new Map<string, { content: string; status: string }>();
  const context = firstContext();
  // This turn's estimated cost by reply: one reply comes in several frames that repeat its usage, the last one whole.
  const replies = new Map<string, number>();
  let model: string | null = null;
  const spend = (frame: Record<string, unknown>): AgentEvent[] => {
    const message = (frame.message ?? {}) as Record<string, unknown>;
    const named = typeof message.model === "string" ? message.model : model;
    if (typeof message.id !== "string" || !named || !message.usage || typeof message.usage !== "object") return [];
    const cost = claudeReplyCost(named, message.usage as Record<string, unknown>);
    if (cost === null || cost === replies.get(message.id)) return [];
    replies.set(message.id, cost);
    return [{ type: "spend", usd: [...replies.values()].reduce((a, b) => a + b, 0) }];
  };
  return {
    decode(line) {
      const frame = parseLine(line);
      if (!frame) return outputLine(line);
      if (typeof frame.session_id === "string") session = frame.session_id;
      // A task registered in the background outlives the turn that started it; its notification says it ended.
      if (frame.type === "system" && (frame.subtype === "task_started" || frame.subtype === "task_notification") && typeof frame.task_id === "string") {
        const before = running.size;
        if (frame.subtype === "task_started" && frame.is_backgrounded === true) running.add(frame.task_id);
        if (frame.subtype === "task_notification") running.delete(frame.task_id);
        return running.size === before ? [] : [{ type: "background", pending: running.size }];
      }
      if (frame.type === "system" && frame.subtype === "permission_denied" && typeof frame.tool_use_id === "string" && typeof frame.tool_name === "string") {
        const id = frame.tool_use_id;
        if (denied.has(id)) return [];
        denied.add(id);
        const call = calls.get(id) ?? { tool: frame.tool_name, target: null, input: {} };
        return BOOKKEEPING.has(call.tool) ? [] : [{ ...callEvent(id, call, "refused"), refusal: refusalOf(frame) } as AgentEvent];
      }
      if (frame.type === "rate_limit_event") {
        // Sent during turns that go well too, so it is never a failure; a refused one says when the limit lifts.
        const info = (frame.rate_limit_info ?? {}) as Record<string, unknown>;
        const status = LIMIT_STATUS[String(info.status)];
        const reset = resetAtFrom(info.resetsAt);
        if (info.status === "rejected") resetAt = reset;
        if (!status || typeof info.rateLimitType !== "string" || !LIMIT_WINDOWS.has(info.rateLimitType)) return [];
        return [{ type: "limit", window: info.rateLimitType, status, ...(reset ? { resetAt: reset } : {}) }];
      }
      if (frame.type === "system" && frame.subtype === "api_retry") {
        const status = num(frame.error_status);
        return [{ type: "error", failure: failure("Claude Code", "provider_retrying", { ...(status === null ? {} : { code: `HTTP ${status}` }), retryable: true }) }];
      }
      if (frame.type === "system" && frame.subtype === "init") {
        if (typeof frame.model === "string") model = frame.model;
        const notices: AgentEvent[] = [...signInNotice(frame.mcp_servers)];
        if (asked && !told && frame.permissionMode !== undefined && frame.permissionMode !== opened) {
          told = true;
          const running = orchestratorMode(frame.permissionMode);
          notices.push({ type: "notice", text: `${MODE_LABEL[asked]} was asked for, and the agent runs in ${running ? MODE_LABEL[running] : String(frame.permissionMode)}: its own settings refuse ${MODE_LABEL[asked]}.` });
        }
        return notices;
      }
      if (frame.type === "assistant") {
        if (frame.error === "authentication_failed" || (frame.message as { error?: unknown })?.error === "authentication_failed") refusedSignIn = true;
        const content = (frame.message as { content?: unknown })?.content;
        if (!Array.isArray(content)) return [];
        const usage = ((frame.message as { usage?: unknown })?.usage ?? {}) as Record<string, unknown>;
        const loaded = context(tokensOf(usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens));
        return [...loaded, ...spend(frame), ...content.flatMap((part: Record<string, unknown>): AgentEvent[] => {
          if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) return [{ type: "message", text: part.text.trim() }];
          if (part?.type === "tool_use" && typeof part.name === "string") {
            const input = part.input && typeof part.input === "object" ? (part.input as Record<string, unknown>) : {};
            // A skill the agent calls is named by its input, never by a path: the one place a name of a skill is read.
            const target = part.name === "Skill" ? input.skill : [input.file_path, input.pattern, input.path].find((v) => typeof v === "string");
            const call: Call = { tool: part.name, target: shownTarget(work, typeof target === "string" ? target : null), ...(part.name === "Bash" && typeof input.command === "string" ? { command: input.command } : {}), input };
            const id = typeof part.id === "string" && part.id ? part.id : null;
            if (id) calls.set(id, call);
            const shown = BOOKKEEPING.has(part.name) ? [] : [callEvent(id, call, "started")];
            return [...shown, ...(part.name === "TodoWrite" ? todosOf(input.todos) : [])];
          }
          return [];
        })];
      }
      if (frame.type === "user") {
        const content = (frame.message as { content?: unknown })?.content;
        if (!Array.isArray(content)) return [];
        const results = content.filter((part: Record<string, unknown>) => part?.type === "tool_result" && typeof part.tool_use_id === "string");
        // The frame's tool_use_result is its one tool's own output; with several results it belongs to none of them alone.
        const output = results.length === 1 && frame.tool_use_result && typeof frame.tool_use_result === "object" ? (frame.tool_use_result as Record<string, unknown>) : null;
        return results.flatMap((result: Record<string, unknown>) => {
          const id = result.tool_use_id as string;
          const call = calls.get(id);
          if (!call) return [];
          calls.delete(id);
          if (denied.has(id)) return [];
          const failed = result.is_error === true;
          return [...(BOOKKEEPING.has(call.tool) ? [] : [callEvent(id, call, failed ? "failed" : "done")]), ...(call.tool === "Bash" ? shellOutput(id, output, result.content) : []), ...(failed ? [] : [...changed(id, call, output, work), ...taskList(call, output, tasks)])];
        });
      }
      if (frame.type !== "result") return [];
      replies.clear();
      const usage = (frame.usage ?? {}) as Record<string, unknown>;
      const input = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].map(num);
      const total = num(frame.total_cost_usd);
      const added = total === null ? null : total - (spent ?? 0);
      if (total !== null) spent = total;
      const ok = frame.is_error !== true && frame.subtype === "success";
      const reason = typeof frame.terminal_reason === "string" ? frame.terminal_reason : null;
      aborted = !ok && !!reason?.startsWith("aborted_");
      failed = ok || aborted ? null : turnFailure(num(frame.api_error_status), reason, refusedSignIn, resetAt, typeof frame.result === "string" ? frame.result : "");
      last = {
        type: "turn_finished",
        ok,
        summary: typeof frame.result === "string" ? frame.result : "",
        reason: String(frame.subtype ?? "unknown"),
        turns: num(frame.num_turns),
      };
      return [
        ...refusedCalls(frame.permission_denials, (e) => e.tool_name, (e) => e.tool_input, (e) => e.tool_use_id)
          .filter((e) => !(e.type === "tool_call" && e.id && denied.has(e.id)))
          .map((e) => ({ ...e, refusal: NOT_ALLOWED_REFUSAL }) as AgentEvent),
        {
          type: "usage",
          cost: {
            usd: added,
            inputTokens: input[0] === null ? null : input.reduce<number>((sum, n) => sum + (n ?? 0), 0),
            outputTokens: num(usage.output_tokens),
          },
        },
        ...(failed ? [{ type: "error", failure: failed } as const] : []),
        last,
      ];
    },
    finish(exitCode) {
      const end = { summary: last?.summary ?? "", ...(session ? { nativeSessionId: session } : {}) };
      if (exitCode === 0 && last?.ok) return { type: "terminal", status: "completed", ...end };
      if (aborted) return { type: "terminal", status: "interrupted", ...end };
      const why = failed ?? (last ? null : failure("Claude Code", "transport", { code: exitCode === null ? "no exit code" : `exit ${exitCode}` }));
      return { type: "terminal", status: "failed", ...end, ...(why ? { failure: why } : {}) };
    },
  };
}

/**
 * The agent's own bookkeeping, which touches nothing of the task's: its to-do list (shown as the
 * plan, not as calls) and the search that loads its deferred tools. The live view shows no line for them.
 */
const BOOKKEEPING = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "ToolSearch"]);

/** A call the agent made, held from its tool_use to its tool_result. */
interface Call {
  tool: string;
  target: string | null;
  command?: string;
  input: Record<string, unknown>;
}

const callEvent = (id: string | null, call: Call, status: "started" | "done" | "failed" | "refused"): AgentEvent => ({
  type: "tool_call",
  ...(id ? { id } : {}),
  tool: call.tool,
  target: call.target,
  ...(call.command === undefined ? {} : { command: call.command }),
  ...withMcp(call.tool),
  status,
});

const withMcp = (tool: string) => {
  const mcp = claudeMcp(tool);
  return mcp ? { mcp } : {};
};

/** A shell call's output, whole, once it ended: stream-json sends no output while a command runs. */
function shellOutput(id: string, output: Record<string, unknown> | null, content: unknown): AgentEvent[] {
  const text = output
    ? [output.stdout, output.stderr].filter((t): t is string => typeof t === "string" && t !== "").join("\n")
    : typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((p: Record<string, unknown>) => (p?.type === "text" && typeof p.text === "string" ? [p.text] : [])).join("\n")
        : "";
  const lines = outputLines(text);
  return lines.length ? [{ type: "tool_output", id, lines }] : [];
}

type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

const isHunk = (h: Record<string, unknown> | null): boolean =>
  !!h && [h.oldStart, h.oldLines, h.newStart, h.newLines].every((n) => Number.isInteger(n)) && Array.isArray(h.lines) && h.lines.every((l) => typeof l === "string");

/**
 * The file an edit or a write changed, from the tool's own output: its hunks, or for a file it
 * created, its content. Without that output only an edit's input says what changed, and only when
 * it replaced one place; a write's input does not say whether it replaced a file.
 */
function changed(id: string, call: Call, output: Record<string, unknown> | null, work: string | undefined): AgentEvent[] {
  if (call.tool !== "Edit" && call.tool !== "Write") return [];
  const path = inFolder(work, output?.filePath ?? call.input.file_path);
  if (output) {
    if (output.type === "create" && typeof output.content === "string") return editOf(id, path, createdPatch(output.content));
    const hunks = Array.isArray(output.structuredPatch) ? (output.structuredPatch as Record<string, unknown>[]) : [];
    if (!hunks.length || !hunks.every(isHunk)) return [];
    return editOf(id, path, (hunks as unknown as Hunk[]).map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join("\n")).join("\n"));
  }
  const { old_string: before, new_string: after, replace_all: all } = call.input;
  if (call.tool !== "Edit" || typeof before !== "string" || typeof after !== "string" || all === true) return [];
  return editOf(id, path, [...outputLines(before).map((l) => `-${l}`), ...outputLines(after).map((l) => `+${l}`)].join("\n"));
}

/**
 * The agent's to-do list when it keeps it as tasks: TaskCreate's output names the new task, and
 * TaskUpdate changes one, a deleted one leaving the list. The whole list goes each time.
 */
function taskList(call: Call, output: Record<string, unknown> | null, tasks: Map<string, { content: string; status: string }>): AgentEvent[] {
  if (call.tool === "TaskCreate") {
    const task = (output?.task ?? {}) as Record<string, unknown>;
    if (typeof task.id !== "string" || typeof call.input.subject !== "string") return [];
    tasks.set(task.id, { content: call.input.subject, status: "pending" });
  } else if (call.tool === "TaskUpdate") {
    const id = call.input.taskId;
    const task = typeof id === "string" ? tasks.get(id) : undefined;
    if (!task) return [];
    if (call.input.status === "deleted") tasks.delete(id as string);
    if (typeof call.input.status === "string") task.status = call.input.status;
    if (typeof call.input.subject === "string") task.content = call.input.subject;
  } else return [];
  return todosOf([...tasks.values()]);
}

const KIND: Record<string, RequestKind> = { Bash: "command", Read: "file-read", Glob: "file-read", Grep: "file-read", Edit: "file-change", Write: "file-change", NotebookEdit: "file-change" };

const requestKind = (tool: string): RequestKind => KIND[tool] ?? (tool.startsWith("mcp__") ? "mcp" : "permission");

/** What a call is aimed at, as the card shows it; the tool's name when its input names nothing. */
function callSummary(tool: string, input: Record<string, unknown>): string {
  const target = ["command", "file_path", "path", "pattern", "url", "query", "skill"].map((k) => input[k]).find((v) => typeof v === "string");
  return typeof target === "string" ? target : tool;
}

const DECLINED = "The person reviewing this task declined this call.";

const NOT_ALLOWED_REFUSAL: Refusal = { kind: "not-allowed", reason: "This task does not allow this tool." };

/**
 * Why Claude Code refused a call on its own, from its permission_denied frame: the guard hook's own
 * reason names a tracker's or a forge's write, a deny rule keeps the agent from a path, and anything
 * else (a mode that asks nobody) is a tool the task does not allow. The agent's own text is never kept.
 */
function refusalOf(frame: Record<string, unknown>): Refusal {
  const said = [frame.decision_reason, frame.message].filter((t): t is string => typeof t === "string").join("\n");
  if (said.includes(TRACKER_REASON)) return { kind: "tracker-write", reason: TRACKER_REASON };
  if (said.includes(FORGE_REASON)) return { kind: "forge-write", reason: FORGE_REASON };
  if (frame.decision_reason_type === "rule") return { kind: "data-folder", reason: "The task's rules keep the agent away from this path." };
  return NOT_ALLOWED_REFUSAL;
}

/**
 * The MCP servers Claude Code found waiting for a sign-in when the session opened, said once in the
 * orchestrator's words: a session that asks nobody cannot finish a sign-in, so their tools are not
 * there, and the agent would otherwise go on trying them. A plugin's server is named as its own.
 */
function signInNotice(servers: unknown): AgentEvent[] {
  if (!Array.isArray(servers)) return [];
  return signInEvents(servers.flatMap((s: Record<string, unknown> | null) => (s?.status === "needs-auth" && typeof s.name === "string" && s.name ? [s.name.replace(/^plugin_[^_]+_(?=.)/, "")] : [])));
}

/** Claude Code's tool for asking the person, routed to the permission prompt in a mode that asks. */
export const ASK_TOOL = "AskUserQuestion";

/**
 * AskUserQuestion's questions as a card shows them, each with the text its answer is keyed by, or
 * null for a shape this page cannot show: a kind of question other than a choice, a question with
 * no text, or more than a card holds. Claude Code always takes the person's own words besides the
 * options it offers.
 */
function askedOf(raw: unknown): { question: AgentQuestion; text: string }[] | null {
  if (!Array.isArray(raw)) return null;
  const asked: { question: AgentQuestion; text: string }[] = [];
  for (const [i, item] of raw.entries()) {
    const q = (item ?? {}) as Record<string, unknown>;
    if (typeof q.question !== "string" || (q.kind !== undefined && q.kind !== "choice") || !Array.isArray(q.options)) return null;
    const options = q.options.map((o: Record<string, unknown> | null) => ({ label: o?.label, description: o?.description }));
    if (!options.every((o) => typeof o.label === "string" && o.label)) return null;
    asked.push({
      text: q.question,
      question: {
        key: `q${i + 1}`,
        title: q.question,
        choice: q.multiSelect === true ? "many" : "one",
        options: options.map((o) => ({ value: o.label as string, label: o.label as string, ...(typeof o.description === "string" && o.description ? { description: o.description } : {}) })),
        other: true,
      },
    });
  }
  return showable(asked.map((a) => a.question)) ? asked : null;
}
const NOT_ALLOWED = "This task does not allow this tool.";

/** Claude Code's tool for putting its plan to the person, the one way out of its plan mode. */
const PLAN_TOOL = "ExitPlanMode";
/** The tools Claude Code writes a plan file with. */
const PLAN_WRITES = new Set(["Write", "Edit"]);
const PLAN_FIRST = "This task plans first: change nothing until the plan is approved, then finish the plan with ExitPlanMode.";
const PLAN_FIRST_REFUSAL: Refusal = { kind: "not-allowed", reason: "This task plans first: nothing changes until its plan is approved." };
const PLAN_UNREAD = "The plan could not be read. Write the plan to its file, then call ExitPlanMode again.";
const PLAN_DECLINED = "The person reviewing this task declined the plan.";

/** A plan as its card names it: its first line, without a heading's marks. */
const planSummary = (plan: string) => plan.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean) ?? PLAN_TOOL;

/**
 * A session that starts by planning: `mode` is Claude Code's own mode it goes on in once the plan
 * is approved, and `dir` the folder its plan files are written in, the one place it may write first.
 * Claude Code sets broad allow rules such as the whole shell aside while it plans, and its
 * ExitPlanMode puts them back and returns to `default` only when it runs in plan mode (2.1.322's own
 * code): an approval that changed the mode first would leave them out. So an approval changes no
 * mode, and another mode is set once ExitPlanMode has run.
 */
export interface ClaudePlan {
  mode: string;
  dir: string;
}

/** Claude Code's usage windows and statuses, as its rate-limit event names them at the checked version. */
const LIMIT_WINDOWS = new Set(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "overage"]);
const LIMIT_STATUS: Record<string, "allowed" | "warning" | "refused"> = { allowed: "allowed", allowed_warning: "warning", rejected: "refused" };

/** The limit reasons Claude Code ends a turn with when the account's usage runs out. */
const LIMIT_REASONS = new Set(["blocking_limit", "rapid_refill_breaker"]);

/**
 * Why a turn that ended badly did, from its result frame. A usage limit is taken only from a 429
 * or Claude Code's own limit reason, since a limit leads to waiting and resuming by itself; a
 * failure that is the agent's own (too many turns, a budget) has no class.
 */
function turnFailure(status: number | null, reason: string | null, signIn: boolean, resetAt: string | undefined, text: string): AgentFailure | null {
  const detail = text || undefined;
  if (signIn) return failure("Claude Code", "sign_in", { code: status === null ? "authentication_failed" : `HTTP ${status}`, detail });
  if (reason && LIMIT_REASONS.has(reason)) return failure("Claude Code", "usage_limit", { code: reason, retryable: true, resetAt, detail });
  if (status !== null) return httpFailure("Claude Code", status, { resetAt, detail });
  return null;
}

/**
 * A two-way session with `--input-format stream-json`: a message is a user frame on stdin, an
 * interrupt is a control request, and each permission question is a `can_use_tool` control
 * request answered by a control response. An allow carries the call's own input back and never
 * a permission update, so no answer leaves a standing rule behind. A question about a call the
 * task does not allow (one of a placed server's other tools, an edit of the orchestrator's guard in
 * the task's home) reaches no person: it is refused at once, since a person's yes must not
 * widen what the operator allowed, and a path is approved without being read. Stdin closing ends
 * the session once its turn is done. With `questions`, the agent's own AskUserQuestion reaches the
 * person as a card and their answers go back in its input's `answers`, keyed by each question's
 * text; without it, it is refused like any tool the task does not name.
 */
export function claudeCodeCodec(asked: PermissionMode, permitted: (tool: string, input: Record<string, unknown>) => boolean = () => false, work?: string, questions = false, opened: string = CLAUDE_MODE[asked], plan?: ClaudePlan): AgentCodec {
  const decoder = claudeCodeDecoder(asked, work, opened);
  const held = new Map<string, { tool: string; input: Record<string, unknown>; asked?: { question: AgentQuestion; text: string }[]; plan?: { call: string | null } }>();
  let planning = plan !== undefined;
  // The approved ExitPlanMode call whose result the task's own mode waits for.
  let exiting: string | null = null;
  let modes = 0;
  const setMode = (mode: string) => JSON.stringify({ type: "control_request", request_id: `mode-${++modes}`, request: { subtype: "set_permission_mode", mode } });
  // The plan files' own folder, and an edit tool's path inside it, are the only writes planning makes.
  const inPlans = (tool: string, input: Record<string, unknown>) => {
    if (!plan || !PLAN_WRITES.has(tool) || typeof input.file_path !== "string") return false;
    const path = resolve(work ?? plan.dir, input.file_path);
    return path.startsWith(plan.dir + sep);
  };
  // ExitPlanMode returns to Claude Code's default by itself; a task in another mode is set to it once that call has run.
  const approved = (requestId: string, input: Record<string, unknown>, call: string | null) => {
    planning = false;
    if (plan && plan.mode !== CLAUDE_MODE["approval-required"]) {
      if (call) exiting = call;
      else outbox.push(setMode(plan.mode));
    }
    return response(requestId, { behavior: "allow", updatedInput: input });
  };
  const exited = (frame: Record<string, unknown> | null): boolean => {
    if (!exiting || frame?.type !== "user") return false;
    const content = (frame.message as { content?: unknown })?.content;
    return Array.isArray(content) && content.some((part: Record<string, unknown>) => part?.type === "tool_result" && part.tool_use_id === exiting);
  };
  const refused = new Set<string>();
  const outbox: string[] = [];
  let interrupts = 0;
  const response = (requestId: string, answer: Record<string, unknown>) => JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response: answer } });
  return {
    decode(line) {
      const frame = parseLine(line);
      if (frame?.type === "control_cancel_request" && typeof frame.request_id === "string") {
        return held.delete(frame.request_id) ? [{ type: "request_withdrawn", requestId: frame.request_id }] : [];
      }
      // A call refused here ends in the agent's own error result after; it stays refused.
      if (plan && exited(frame)) {
        outbox.push(setMode(plan.mode));
        exiting = null;
      }
      if (frame?.type !== "control_request") return decoder.decode(line).filter((e) => !(e.type === "tool_call" && e.status === "failed" && e.id && refused.has(e.id)));
      const request = (frame.request ?? {}) as Record<string, unknown>;
      if (request.subtype !== "can_use_tool" || typeof frame.request_id !== "string" || typeof request.tool_name !== "string") return [];
      const input = request.input && typeof request.input === "object" ? (request.input as Record<string, unknown>) : {};
      const summary = shownTarget(work, callSummary(request.tool_name, input))!;
      const id = typeof request.tool_use_id === "string" && request.tool_use_id ? request.tool_use_id : null;
      // A plan is put to the person whether the task planned first or the agent went into its own plan mode.
      if (request.tool_name === PLAN_TOOL) {
        const text = typeof input.plan === "string" ? input.plan.trim() : "";
        if (!text) {
          outbox.push(response(frame.request_id, { behavior: "deny", message: PLAN_UNREAD }));
          return [];
        }
        held.set(frame.request_id, { tool: request.tool_name, input, plan: { call: id } });
        return [{ type: "request", request: { id: frame.request_id, kind: "plan", tool: request.tool_name, summary: planSummary(text), plan: text } }];
      }
      if (planning && inPlans(request.tool_name, input)) {
        outbox.push(response(frame.request_id, { behavior: "allow", updatedInput: input }));
        return [];
      }
      if (planning && !(questions && request.tool_name === ASK_TOOL)) {
        outbox.push(response(frame.request_id, { behavior: "deny", message: PLAN_FIRST }));
        if (id) refused.add(id);
        return [{ type: "tool_call", ...(id ? { id } : {}), tool: request.tool_name, target: summary, ...withMcp(request.tool_name), status: "refused", refusal: PLAN_FIRST_REFUSAL }];
      }
      if (questions && request.tool_name === ASK_TOOL) {
        const asked = askedOf(input.questions);
        if (!asked) {
          outbox.push(response(frame.request_id, { behavior: "deny", message: QUESTION_NOT_SHOWN }));
          return [{ type: "notice", text: UNSHOWN_QUESTION }];
        }
        held.set(frame.request_id, { tool: request.tool_name, input, asked });
        return [{ type: "request", request: { id: frame.request_id, kind: "question", tool: request.tool_name, summary: asked[0]!.text, questions: asked.map((a) => a.question) } }];
      }
      if (!permitted(request.tool_name, input)) {
        outbox.push(response(frame.request_id, { behavior: "deny", message: NOT_ALLOWED }));
        if (id) refused.add(id);
        return [{ type: "tool_call", ...(id ? { id } : {}), tool: request.tool_name, target: summary, ...withMcp(request.tool_name), status: "refused", refusal: NOT_ALLOWED_REFUSAL }];
      }
      held.set(frame.request_id, { tool: request.tool_name, input });
      return [{ type: "request", request: { id: frame.request_id, kind: requestKind(request.tool_name), tool: request.tool_name, summary } }];
    },
    finish: decoder.finish,
    turn: (text) => JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }),
    interrupt: () => JSON.stringify({ type: "control_request", request_id: `interrupt-${++interrupts}`, request: { subtype: "interrupt" } }),
    answer(requestId, decision, note) {
      const call = held.get(requestId);
      // A question goes ahead only with its answers; an allow alone would answer nothing.
      // A plan is approved once, never for the task.
      if (!call || (call.asked && decision !== "deny") || (call.plan && decision === "allow-for-task")) return null;
      held.delete(requestId);
      if (call.plan) return decision === "deny" ? response(requestId, { behavior: "deny", message: note?.trim() || PLAN_DECLINED }) : approved(requestId, call.input, call.plan.call);
      return response(requestId, decision === "deny" ? { behavior: "deny", message: note?.trim() || DECLINED } : { behavior: "allow", updatedInput: call.input });
    },
    reply(requestId, answers) {
      const call = held.get(requestId);
      if (!call?.asked) return null;
      const given: Record<string, string | string[]> = {};
      for (const { question, text } of call.asked) {
        const values = answerValues(question, answers);
        if (!values) return null;
        given[text] = question.choice === "many" ? values : values.join(", ");
      }
      held.delete(requestId);
      return response(requestId, { behavior: "allow", updatedInput: { ...call.input, answers: given } });
    },
    approvePlan(requestId, text) {
      const call = held.get(requestId);
      if (!call?.plan || !text.trim()) return null;
      held.delete(requestId);
      return approved(requestId, { ...call.input, plan: text }, call.plan.call);
    },
    grantKey(requestId) {
      const call = held.get(requestId);
      // An answer is given once: a question or a plan is never granted for the task.
      return call && !call.asked && !call.plan ? JSON.stringify([call.tool, call.input]) : null;
    },
    pending: () => outbox.splice(0),
  };
}
