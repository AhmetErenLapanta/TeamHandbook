import type { AgentCapabilities, AgentCodec, AgentDecoder, AgentEvent, AgentFailure, AgentQuestion, RequestKind } from "./contract.js";
import { failure, httpFailure, resetAtFromHeaders } from "./failure.js";
import { MANIFEST } from "./manifest.js";
import { answerValues, showable, UNSHOWN_QUESTION } from "./questions.js";
import { createdPatch, editOf, firstContext, inFolder, num, opencodeMcp, outputLine, outputLines, parseLine, shownTarget, todosOf, tokensOf } from "./frames.js";

/** An error's name is the agent's text and reaches the card's message, so only a plain identifier is kept as its code. */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

/**
 * An OpenCode error as a failure, or null for an abort, which is an interrupt. Its
 * `data.statusCode` is the provider's HTTP status, and a refused one's `data.responseHeaders`
 * say when the limit lifts.
 */
function errorFailure(raw: unknown): AgentFailure | null {
  const error = (raw ?? {}) as Record<string, unknown>;
  if (error.name === "MessageAbortedError") return null;
  const data = (error.data ?? {}) as Record<string, unknown>;
  const detail = JSON.stringify(raw ?? {});
  const status = num(data.statusCode);
  if (status !== null) return httpFailure("OpenCode", status, { resetAt: status === 429 ? resetAtFromHeaders(data.responseHeaders) : undefined, detail });
  return failure("OpenCode", "provider", { ...(typeof error.name === "string" && ERROR_NAME.test(error.name) ? { code: error.name } : {}), retryable: data.isRetryable === true, detail });
}

/** What a permission or a call is aimed at, from the tool's input, or OpenCode's own patterns. */
const TARGET_FIELDS = ["command", "filePath", "path", "pattern", "url"];

const targetOf = (input: Record<string, unknown>): string | null => {
  const target = TARGET_FIELDS.map((k) => input[k]).find((v) => typeof v === "string");
  return typeof target === "string" ? target : null;
};

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** OpenCode's tool that loads a skill, by its name (`{ name }`, 1.19.4); the call's target is the skill, as Claude Code's Skill call's is. */
const SKILL_TOOL = "skill";

/** OpenCode's own to-do list, shown as the plan and not as calls. */
const BOOKKEEPING = new Set(["todowrite", "todoread"]);

/** A call as the live view shows it, a shell call by its command line; none for the agent's own bookkeeping. */
function callEvent(id: string, tool: string, input: Record<string, unknown>, status: "started" | "done" | "failed", work?: string, servers: readonly string[] = []): AgentEvent[] {
  if (BOOKKEEPING.has(tool)) return [];
  const mcp = opencodeMcp(tool, servers);
  const target = tool === SKILL_TOOL ? (typeof input.name === "string" ? input.name : null) : shownTarget(work, targetOf(input));
  return [{ type: "tool_call", id, tool, target, ...(mcp ? { mcp } : {}), ...(tool === "bash" && typeof input.command === "string" ? { command: input.command } : {}), status }];
}

/** Whole lines of a shell call's output that have not gone yet; the rest of a line waits for its end unless the call ended. */
function shellLines(id: string, output: string, sent: number, ended: boolean): { events: AgentEvent[]; sent: number } {
  // OpenCode resends a running command's output whole each time, and starts over when it does.
  const from = output.length < sent ? 0 : sent;
  const rest = output.slice(from);
  const cut = ended ? rest.length : rest.lastIndexOf("\n") + 1;
  const lines = outputLines(rest.slice(0, cut));
  return { events: lines.length ? [{ type: "tool_output", id, lines }] : [], sent: from + cut };
}

/**
 * What a call that ended changed or reported, from its input and OpenCode's metadata: an edit's
 * filediff, apply_patch's files, a write that created its file (a write over a file reports no
 * diff, so none is guessed), and todowrite's whole list.
 */
function callResult(id: string, tool: string, input: Record<string, unknown>, metadata: Record<string, unknown>, work: string | undefined): AgentEvent[] {
  if (tool === "edit") {
    const diff = record(metadata.filediff);
    const patch = typeof diff.patch === "string" ? diff.patch : typeof metadata.diff === "string" ? metadata.diff : null;
    return patch === null ? [] : editOf(id, inFolder(work, diff.file ?? input.filePath), patch);
  }
  if (tool === "apply_patch" && Array.isArray(metadata.files)) {
    return metadata.files.flatMap((f: unknown) => {
      const file = record(f);
      return typeof file.patch === "string" ? editOf(id, inFolder(work, file.relativePath ?? file.filePath), file.patch) : [];
    });
  }
  if (tool === "write" && metadata.exists === false && typeof input.content === "string") return editOf(id, inFolder(work, input.filePath), createdPatch(input.content));
  if (tool === "todowrite") return todosOf(input.todos);
  return [];
}

/** A 1.x tool part that completed or failed: its end, what is left of a shell call's output, and what it changed. */
function ended(id: string, tool: string, state: Record<string, unknown>, sent: number, work: string | undefined, servers: readonly string[] = []): AgentEvent[] {
  const failed = state.status === "error";
  const input = record(state.input);
  const metadata = record(state.metadata);
  const output = typeof metadata.output === "string" ? metadata.output : typeof state.output === "string" ? state.output : "";
  return [...callEvent(id, tool, input, failed ? "failed" : "done", work, servers), ...(tool === "bash" ? shellLines(id, output, sent, true).events : []), ...(failed ? [] : callResult(id, tool, input, metadata, work))];
}

export function opencodeCapabilities(mcp: boolean): AgentCapabilities {
  return { mcp, runsAsYou: false, resume: false, steer: false, approvals: false, questions: false, fork: false, rollback: false, usage: true, plan: false, permissionModes: ["auto"], options: MANIFEST.opencode.options, pendingRequestsSurviveRestart: false };
}

/**
 * OpenCode's `run --format json`. It writes no closing frame: the run is good when the process
 * exits 0 and no error event came, its summary is the last text it wrote, and what it spent is
 * what each step-finish event reports. An error event's `data.statusCode` is the provider's
 * HTTP status; `MessageAbortedError` is an interrupt and never a failure; a process that ends
 * badly with no error event of its own is a transport failure. A call is written once, when it
 * has ended, so it starts and ends in the same line.
 */
export function opencodeDecoder(work?: string, servers: readonly string[] = []): AgentDecoder {
  const context = firstContext();
  let lastText: string | null = null;
  let failed: AgentFailure | null = null;
  let aborted = false;
  return {
    decode(line) {
      const frame = parseLine(line);
      if (!frame) return outputLine(line);
      const part = (frame.part ?? {}) as Record<string, unknown>;
      if (frame.type === "text" && typeof part.text === "string") {
        lastText = part.text;
        return part.text.trim() ? [{ type: "message", text: part.text.trim() }] : [];
      }
      if (frame.type === "tool_use" && typeof part.tool === "string") {
        const state = record(part.state);
        const input = record(state.input);
        if (typeof part.callID !== "string" || (state.status !== "completed" && state.status !== "error")) return [{ type: "tool_call", tool: part.tool, target: null, status: "started" }];
        return [...callEvent(part.callID, part.tool, input, "started", work, servers), ...ended(part.callID, part.tool, state, 0, work, servers)];
      }
      if (frame.type === "step_finish") {
        const tokens = (part.tokens ?? {}) as Record<string, unknown>;
        const cache = record(tokens.cache);
        return [...context(tokensOf(tokens.input, cache.read, cache.write)), { type: "usage", cost: { usd: num(part.cost), inputTokens: num(tokens.input), outputTokens: num(tokens.output) } }];
      }
      if (frame.type === "error") {
        const why = errorFailure(frame.error ?? frame);
        if (!why) {
          aborted = true;
          return [];
        }
        failed = why;
        return [{ type: "error", failure: why }];
      }
      return [];
    },
    finish(exitCode) {
      const summary = lastText ?? "";
      if (aborted && !failed) return { type: "terminal", status: "interrupted", summary };
      if (exitCode === 0 && !failed) return { type: "terminal", status: "completed", summary };
      const why = failed ?? failure("OpenCode", "transport", { code: exitCode === null ? "no exit code" : `exit ${exitCode}` });
      return { type: "terminal", status: "failed", summary, failure: why };
    },
  };
}

/** A session of `opencode serve` the runner holds: it answers its questions, and nothing it asks outlives the task. */
export function opencodeServeCapabilities(mcp: boolean): AgentCapabilities {
  return { ...opencodeCapabilities(mcp), runsAsYou: true, approvals: true };
}

/**
 * One call of OpenCode's client the runner makes for the session: the SDK method's name and its
 * arguments. The codec never names a URL; the runner knows which server version it started and
 * how that version spells the call.
 */
export interface OpencodeCall {
  op: "session.promptAsync" | "session.abort" | "permission.reply" | "question.reply" | "question.reject";
  args: Record<string, unknown>;
}

/** One call of OpenCode 2.x's client, as the 2.x codec writes it; the runner routes it for 2.x. */
export interface Opencode2Call {
  op: "session.prompt" | "session.interrupt" | "permission.reply" | "form.cancel" | "session.form.reply";
  args: Record<string, unknown>;
}

/**
 * A session of `opencode serve`, for the major version the runner read from the server before
 * the first prompt (2.x answers `GET /api/info`, 1.x `GET /global/health`): the calls written
 * differ between them from the very first one, so the version is never guessed from events.
 */
export function opencodeServeCodec(sessionID: string, major: 1 | 2 = 1, work?: string, questions = false, servers: readonly string[] = []): AgentCodec {
  return major === 2 ? opencode2ServeCodec(sessionID, work, questions, servers) : opencode1ServeCodec(sessionID, work, questions, servers);
}

/**
 * A 1.x `question.asked`'s questions as a card shows them, in the order its answer is given, or
 * null for a shape this page cannot show. A question with no options takes the person's words
 * alone, and one that does takes them too unless OpenCode turned that off.
 */
function asked1(raw: unknown): AgentQuestion[] | null {
  if (!Array.isArray(raw)) return null;
  const questions = raw.map((item: unknown, i: number): AgentQuestion | null => {
    const q = record(item);
    const options = Array.isArray(q.options) ? q.options.map(record) : [];
    if (typeof q.question !== "string" || !options.every((o) => typeof o.label === "string" && o.label)) return null;
    return {
      key: `q${i + 1}`,
      title: q.question,
      ...(typeof q.header === "string" && q.header && q.header !== q.question ? { description: q.header } : {}),
      choice: !options.length ? "text" : q.multiple === true ? "many" : "one",
      options: options.map((o) => ({ value: o.label as string, label: o.label as string, ...(typeof o.description === "string" && o.description ? { description: o.description } : {}) })),
      other: q.custom !== false,
    };
  });
  return questions.every((q): q is AgentQuestion => q !== null) ? showable(questions) : null;
}

/**
 * A 2.x form's fields as a card shows them, or null for one this page cannot show: a field of
 * another type than text or a multiple choice, a hidden one, or one that depends on another.
 */
function asked2(raw: unknown): AgentQuestion[] | null {
  if (!Array.isArray(raw)) return null;
  const questions = raw.map((item: unknown, i: number): AgentQuestion | null => {
    const f = record(item);
    const options = Array.isArray(f.options) ? f.options.map(record) : [];
    if (typeof f.key !== "string" || !f.key || (f.type !== "string" && f.type !== "multiselect") || f.hidden === true || (Array.isArray(f.when) && f.when.length)) return null;
    if (!options.every((o) => typeof o.value === "string" && o.value)) return null;
    const title = typeof f.title === "string" && f.title.trim() ? f.title : `Question ${i + 1}`;
    return {
      key: f.key,
      title,
      ...(typeof f.description === "string" && f.description && f.description !== title ? { description: f.description } : {}),
      choice: f.type === "multiselect" ? "many" : options.length ? "one" : "text",
      options: options.map((o) => ({ value: o.value as string, label: typeof o.label === "string" && o.label ? o.label : (o.value as string), ...(typeof o.description === "string" && o.description ? { description: o.description } : {}) })),
      other: f.custom === true,
    };
  });
  return questions.every((q): q is AgentQuestion => q !== null) ? showable(questions) : null;
}

/** An event of the other generation than the one the server reported: 1.x events carry `properties`, 2.x events `data`. */
const otherGeneration = (event: Record<string, unknown>, major: 1 | 2) => (major === 1 ? "data" in event && !("properties" in event) : "properties" in event && !("data" in event));

const MISMATCH: AgentEvent = { type: "notice", text: "OpenCode sends events of another version than it reported; they are not read." };

const PERMISSION_KIND: Record<string, RequestKind> = {
  bash: "command",
  edit: "file-change",
  write: "file-change",
  read: "file-read",
  glob: "file-read",
  grep: "file-read",
  list: "file-read",
  external_directory: "permission",
  webfetch: "permission",
};

/**
 * A session of `opencode serve` (1.x), read from its event stream and written as client calls.
 * Each line read is one SSE event `{type, properties}`; each line written is one OpencodeCall.
 * Only the task's own session counts: an event of another session is dropped, and a question
 * from one is refused without asking, since nobody here started it. A turn ends when the
 * session first goes idle after a prompt (OpenCode says idle more than once for one end), a retry
 * it makes by itself is said and ends nothing; a text part counts once it has ended, a tool once it runs and again when
 * it ends, a shell call's output line by line as it runs, and what a turn spent is what its
 * step-finish parts report. A decision is `once` or `reject` and never
 * `always`, which would write a standing rule; a grant for the task is keyed by the permission
 * and its full patterns.
 */
function opencode1ServeCodec(sessionID: string, work?: string, questions = false, servers: readonly string[] = []): AgentCodec {
  const held = new Map<string, { permission: string; patterns: unknown }>();
  const heldQuestions = new Map<string, AgentQuestion[]>();
  const context = firstContext();
  const seenText = new Set<string>();
  const seenTools = new Set<string>();
  const endedTools = new Set<string>();
  const sent = new Map<string, number>();
  const outbox: string[] = [];
  let lastText = "";
  let turnFailure: AgentFailure | null = null;
  let lastTurn: { ok: boolean; failure: AgentFailure | null; aborted: boolean } | null = null;
  let aborted = false;
  let mismatched = false;
  // Between a prompt and the idle that ends its turn.
  let busy = false;
  const call = (op: OpencodeCall["op"], args: Record<string, unknown>) => JSON.stringify({ op, args } satisfies OpencodeCall);

  return {
    decode(line) {
      const event = parseLine(line);
      if (!event) return outputLine(line);
      if (otherGeneration(event, 1)) return mismatched ? [] : ((mismatched = true), [MISMATCH]);
      const props = (event.properties ?? {}) as Record<string, unknown>;
      if (event.type === "message.part.updated") {
        const part = (props.part ?? {}) as Record<string, unknown>;
        if (part.sessionID !== sessionID) return [];
        if (part.type === "text" && typeof part.text === "string" && typeof part.id === "string" && (part.time as { end?: unknown } | undefined)?.end !== undefined && !part.synthetic && !part.ignored) {
          if (seenText.has(part.id)) return [];
          seenText.add(part.id);
          lastText = part.text;
          return part.text.trim() ? [{ type: "message", text: part.text.trim() }] : [];
        }
        if (part.type === "tool" && typeof part.tool === "string" && typeof part.callID === "string") {
          const id = part.callID;
          const state = record(part.state);
          const over = state.status === "completed" || state.status === "error";
          if ((state.status !== "running" && !over) || endedTools.has(id)) return [];
          const events = seenTools.has(id) ? [] : callEvent(id, part.tool, record(state.input), "started", work, servers);
          seenTools.add(id);
          if (over) {
            endedTools.add(id);
            return [...events, ...ended(id, part.tool, state, sent.get(id) ?? 0, work, servers)];
          }
          const output = record(state.metadata).output;
          if (part.tool !== "bash" || typeof output !== "string") return events;
          const shell = shellLines(id, output, sent.get(id) ?? 0, false);
          sent.set(id, shell.sent);
          return [...events, ...shell.events];
        }
        if (part.type === "step-finish") {
          const tokens = (part.tokens ?? {}) as Record<string, unknown>;
          const cache = record(tokens.cache);
          return [...context(tokensOf(tokens.input, cache.read, cache.write)), { type: "usage", cost: { usd: num(part.cost), inputTokens: num(tokens.input), outputTokens: num(tokens.output) } }];
        }
        return [];
      }
      if (event.type === "permission.asked" && typeof props.id === "string") {
        const permission = typeof props.permission === "string" ? props.permission : "permission";
        if (props.sessionID !== sessionID) {
          outbox.push(call("permission.reply", { requestID: props.id, reply: "reject" }));
          return [{ type: "tool_call", tool: permission, target: null, status: "refused" }];
        }
        const patterns = Array.isArray(props.patterns) ? props.patterns.filter((p): p is string => typeof p === "string") : [];
        held.set(props.id, { permission, patterns });
        const kind = PERMISSION_KIND[permission] ?? (permission.includes("_") ? "mcp" : "permission");
        return [{ type: "request", request: { id: props.id, kind, tool: permission, summary: patterns.length ? patterns.join(" ") : permission } }];
      }
      if (event.type === "permission.replied" && typeof props.requestID === "string") {
        return held.delete(props.requestID) ? [{ type: "request_withdrawn", requestId: props.requestID }] : [];
      }
      if (event.type === "question.asked" && typeof props.id === "string") {
        const asked = props.sessionID === sessionID && questions ? asked1(props.questions) : null;
        if (!asked) {
          outbox.push(call("question.reject", { requestID: props.id }));
          return props.sessionID === sessionID && questions ? [{ type: "notice", text: UNSHOWN_QUESTION }] : [{ type: "tool_call", tool: "question", target: null, status: "refused" }];
        }
        heldQuestions.set(props.id, asked);
        return [{ type: "request", request: { id: props.id, kind: "question", tool: "question", summary: asked[0]!.title, questions: asked } }];
      }
      if ((event.type === "question.replied" || event.type === "question.rejected") && typeof props.requestID === "string") {
        return heldQuestions.delete(props.requestID) ? [{ type: "request_withdrawn", requestId: props.requestID }] : [];
      }
      if (event.type === "session.error") {
        if (props.sessionID !== undefined && props.sessionID !== sessionID) return [];
        const why = errorFailure(props.error);
        if (!why) {
          aborted = true;
          return [];
        }
        turnFailure = why;
        return [{ type: "error", failure: why }];
      }
      const status = event.type === "session.status" && props.sessionID === sessionID ? (props.status as { type?: unknown } | undefined)?.type : undefined;
      if (status === "busy") busy = true;
      // OpenCode tries a refused request again by itself and says so as a status; that is no end of the turn.
      if (status === "retry") return [{ type: "error", failure: failure("OpenCode", "provider_retrying", { retryable: true }) }];
      const idle = (event.type === "session.idle" && props.sessionID === sessionID) || status === "idle";
      // OpenCode says idle twice for one end (a status and an idle event) and again after its last message: only the first ends the turn.
      if (!idle || !busy) return [];
      busy = false;
      const turn: AgentEvent = { type: "turn_finished", ok: !turnFailure && !aborted, summary: lastText, reason: null, turns: null };
      lastTurn = { ok: !turnFailure && !aborted, failure: turnFailure, aborted };
      turnFailure = null;
      aborted = false;
      return [turn];
    },
    finish(exitCode) {
      if (aborted || lastTurn?.aborted) return { type: "terminal", status: "interrupted", summary: lastText, nativeSessionId: sessionID };
      if (lastTurn?.ok) return { type: "terminal", status: "completed", summary: lastText, nativeSessionId: sessionID };
      const why = lastTurn?.failure ?? turnFailure ?? failure("OpenCode", "transport", { code: exitCode === null ? "no exit code" : `exit ${exitCode}` });
      return { type: "terminal", status: "failed", summary: lastText, failure: why, nativeSessionId: sessionID };
    },
    turn: (text) => {
      busy = true;
      return call("session.promptAsync", { sessionID, parts: [{ type: "text", text }] });
    },
    interrupt: () => call("session.abort", { sessionID }),
    answer(requestId, decision) {
      // A question is turned down here; it goes ahead only with its answers.
      if (heldQuestions.has(requestId)) return decision === "deny" && heldQuestions.delete(requestId) ? call("question.reject", { requestID: requestId }) : null;
      if (!held.delete(requestId)) return null;
      return call("permission.reply", { requestID: requestId, reply: decision === "deny" ? "reject" : "once" });
    },
    reply(requestId, answers) {
      const asked = heldQuestions.get(requestId);
      if (!asked) return null;
      // OpenCode takes the answers in the order it asked, each the labels chosen and then the person's own words.
      const given = asked.map((q) => answerValues(q, answers));
      if (!given.every((v): v is string[] => v !== null)) return null;
      heldQuestions.delete(requestId);
      return call("question.reply", { requestID: requestId, answers: given });
    },
    grantKey(requestId) {
      const asked = held.get(requestId);
      return asked ? JSON.stringify([asked.permission, asked.patterns]) : null;
    },
    pending: () => outbox.splice(0),
  };
}

/** OpenCode 2.x error types that mean the account's usage ran out; a quota error with 402 is an empty balance, not a limit that lifts. */
const usageLimited = (type: unknown, status: number | null) => type === "provider.rate-limit" || (type === "provider.quota" && status !== 402);

/** A 2.x error type is OpenCode's text and reaches the card's message, so only a plain dotted name is kept as its code. */
const ERROR_TYPE = /^[a-z][a-z0-9.-]{0,40}$/;

/** A 2.x execution's or retry's error `{type, message, status}` as a failure. */
function error2Failure(raw: unknown, cls?: "provider_retrying"): AgentFailure {
  const error = (raw ?? {}) as Record<string, unknown>;
  const status = num(error.status);
  const code = typeof error.type === "string" && ERROR_TYPE.test(error.type) ? error.type : status !== null ? `HTTP ${status}` : undefined;
  const detail = JSON.stringify(raw ?? {});
  if (cls) return failure("OpenCode", cls, { ...(code ? { code } : {}), retryable: true });
  if (usageLimited(error.type, status)) return failure("OpenCode", "usage_limit", { ...(code ? { code } : {}), retryable: true, detail });
  if (status === 401 || status === 403) return failure("OpenCode", "sign_in", { ...(code ? { code } : {}), detail });
  return failure("OpenCode", "provider", { ...(code ? { code } : {}), retryable: status !== null && status >= 500, detail });
}

const DECLINED = "The person reviewing this task declined this call.";

/** A 2.x result's text parts as one text. */
const textOf = (content: unknown): string => (Array.isArray(content) ? content.flatMap((p: unknown) => (record(p).type === "text" && typeof record(p).text === "string" ? [record(p).text as string] : [])).join("\n") : "");

/**
 * A session of `opencode serve` 2.x, read from `/api/event` and written as client calls. Each
 * line read is one SSE event `{type, data, created}`; only the task's own session counts, and a
 * question from another is refused without asking. A text block counts when it ends (its `text`
 * is whole), a tool once it is called and again when it succeeds or fails, with its output
 * then, and what a step spent is its tokens: input counting the
 * prompt cache read and written, output counting reasoning. 2.x reports no cost, so it stays
 * unknown. An execution's end closes the turn, as there is no idle event. A reject with no
 * message stops OpenCode's whole execution, so a person's deny always carries one: the call is
 * refused and the agent goes on. A form (a question for the person) has no card yet and is
 * cancelled.
 */
function opencode2ServeCodec(sessionID: string, work?: string, questions = false, servers: readonly string[] = []): AgentCodec {
  const held = new Map<string, { action: string; resources: string[] }>();
  const forms = new Map<string, AgentQuestion[]>();
  const context = firstContext();
  const tools = new Map<string, { tool: string; input: Record<string, unknown> }>();
  const outbox: string[] = [];
  let lastText = "";
  let turnFailure: AgentFailure | null = null;
  let lastTurn: { ok: boolean; failure: AgentFailure | null; aborted: boolean } | null = null;
  let mismatched = false;
  const call = (op: Opencode2Call["op"], args: Record<string, unknown>) => JSON.stringify({ op, args } satisfies Opencode2Call);
  const ended = (ok: boolean, aborted: boolean): AgentEvent[] => {
    lastTurn = { ok, failure: turnFailure, aborted };
    turnFailure = null;
    return [{ type: "turn_finished", ok, summary: lastText, reason: null, turns: null }];
  };

  return {
    decode(line) {
      const event = parseLine(line);
      if (!event) return outputLine(line);
      if (otherGeneration(event, 2)) return mismatched ? [] : ((mismatched = true), [MISMATCH]);
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (event.type === "permission.asked" && typeof data.id === "string") {
        const action = typeof data.action === "string" ? data.action : "permission";
        if (data.sessionID !== sessionID) {
          if (typeof data.sessionID === "string") outbox.push(call("permission.reply", { sessionID: data.sessionID, requestID: data.id, decision: "reject", message: DECLINED }));
          return [{ type: "tool_call", tool: action, target: null, status: "refused" }];
        }
        const resources = Array.isArray(data.resources) ? data.resources.filter((r): r is string => typeof r === "string") : [];
        held.set(data.id, { action, resources });
        const kind = PERMISSION_KIND[action] ?? (action.includes("_") ? "mcp" : "permission");
        return [{ type: "request", request: { id: data.id, kind, tool: action, summary: resources.length ? resources.join(" ") : action } }];
      }
      if (data.sessionID !== sessionID) return [];
      switch (event.type) {
        case "session.text.ended":
          if (typeof data.text !== "string") return [];
          lastText = data.text;
          return data.text.trim() ? [{ type: "message", text: data.text.trim() }] : [];
        case "session.tool.input.started":
          if (typeof data.id === "string" && typeof data.name === "string") tools.set(data.id, { tool: data.name, input: {} });
          return [];
        case "session.tool.called": {
          const call = typeof data.id === "string" ? tools.get(data.id) : undefined;
          if (!call) return [];
          call.input = record(data.input);
          return callEvent(data.id as string, call.tool, call.input, "started", work, servers);
        }
        case "session.tool.success":
        case "session.tool.failed": {
          const call = typeof data.id === "string" ? tools.get(data.id) : undefined;
          if (!call) return [];
          const id = data.id as string;
          tools.delete(id);
          const failed = event.type === "session.tool.failed";
          const metadata = record(data.metadata);
          const output = typeof metadata.output === "string" ? metadata.output : textOf(data.content);
          return [...callEvent(id, call.tool, call.input, failed ? "failed" : "done", work, servers), ...(call.tool === "bash" ? shellLines(id, output, 0, true).events : []), ...(failed ? [] : callResult(id, call.tool, call.input, metadata, work))];
        }
        case "session.step.ended":
        case "session.step.failed": {
          const tokens = (data.tokens ?? {}) as Record<string, unknown>;
          const cache = (tokens.cache ?? {}) as Record<string, unknown>;
          const input = tokensOf(tokens.input, cache.read, cache.write);
          return [...context(input), { type: "usage", cost: { usd: num(data.cost), inputTokens: input, outputTokens: tokensOf(tokens.output, tokens.reasoning) } }];
        }
        case "session.retry.scheduled":
          return [{ type: "error", failure: error2Failure(data.error, "provider_retrying") }];
        case "permission.replied":
          return typeof data.requestID === "string" && held.delete(data.requestID) ? [{ type: "request_withdrawn", requestId: data.requestID }] : [];
        case "form.created": {
          const form = (data.form ?? {}) as Record<string, unknown>;
          if (typeof form.id !== "string") return [];
          const asked = questions ? asked2(form.fields) : null;
          if (!asked) {
            outbox.push(call("form.cancel", { sessionID, formID: form.id }));
            return questions ? [{ type: "notice", text: UNSHOWN_QUESTION }] : [{ type: "tool_call", tool: "question", target: null, status: "refused" }];
          }
          forms.set(form.id, asked);
          return [{ type: "request", request: { id: form.id, kind: "question", tool: "question", summary: asked[0]!.title, questions: asked } }];
        }
        case "form.replied":
        case "form.cancelled": {
          const id = typeof data.formID === "string" ? data.formID : typeof record(data.form).id === "string" ? (record(data.form).id as string) : null;
          return id && forms.delete(id) ? [{ type: "request_withdrawn", requestId: id }] : [];
        }
        case "session.execution.succeeded":
          return ended(true, false);
        case "session.execution.interrupted":
          return ended(false, true);
        case "session.execution.failed":
          turnFailure = error2Failure(data.error);
          return [{ type: "error", failure: turnFailure }, ...ended(false, false)];
        default:
          return [];
      }
    },
    finish(exitCode) {
      if (lastTurn?.aborted) return { type: "terminal", status: "interrupted", summary: lastText, nativeSessionId: sessionID };
      if (lastTurn?.ok) return { type: "terminal", status: "completed", summary: lastText, nativeSessionId: sessionID };
      const why = lastTurn?.failure ?? failure("OpenCode", "transport", { code: exitCode === null ? "no exit code" : `exit ${exitCode}` });
      return { type: "terminal", status: "failed", summary: lastText, failure: why, nativeSessionId: sessionID };
    },
    turn: (text) => call("session.prompt", { sessionID, text }),
    interrupt: () => call("session.interrupt", { sessionID }),
    answer(requestId, decision, note) {
      // A form is turned down by cancelling it; it goes ahead only with its answers.
      if (forms.has(requestId)) return decision === "deny" && forms.delete(requestId) ? call("form.cancel", { sessionID, formID: requestId }) : null;
      if (!held.delete(requestId)) return null;
      return call("permission.reply", decision === "deny" ? { sessionID, requestID: requestId, decision: "reject", message: note?.trim() || DECLINED } : { sessionID, requestID: requestId, decision: "once" });
    },
    reply(requestId, answers) {
      const asked = forms.get(requestId);
      if (!asked) return null;
      const answer: Record<string, string | string[]> = {};
      for (const q of asked) {
        const values = answerValues(q, answers);
        if (!values) return null;
        answer[q.key] = q.choice === "many" ? values : values.join(", ");
      }
      forms.delete(requestId);
      return call("session.form.reply", { sessionID, formID: requestId, answer });
    },
    grantKey(requestId) {
      const asked = held.get(requestId);
      return asked ? JSON.stringify([asked.action, asked.resources]) : null;
    },
    pending: () => outbox.splice(0),
  };
}
