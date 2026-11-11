import type { PermissionMode } from "../../../shared/permission-mode.js";
import type { TaskCost } from "../types.js";

/**
 * What an agent can do, so the runner, the task form and the readiness check decide by a flag
 * and never by the agent's name. A missing capability is degraded in the open by the caller: a
 * follow-up message waits in a queue without steer, a static tool list stands in for approvals.
 */
export interface AgentCapabilities {
  /** The orchestrator can hold the agent to the allowed MCP tools, one by one. */
  mcp: boolean;
  /** The agent can start with the orchestrator user's own profile. */
  runsAsYou: boolean;
  resume: boolean;
  /** A message can reach the agent while a turn runs. */
  steer: boolean;
  /** A tool call can wait for a person's decision instead of a static allow list. */
  approvals: boolean;
  /** The agent's own questions to the person reach the task's card; without it nothing promises a card for them. */
  questions: boolean;
  fork: boolean;
  rollback: boolean;
  /** The agent reports what it spent; without it a task's cost stays unknown. */
  usage: boolean;
  /** The agent can start by planning, change nothing, and put its plan to the person before it works (LaunchOptions.plan). */
  plan: boolean;
  /** The orchestrator's modes this agent can run in; a task in any other mode does not start on it. */
  permissionModes: readonly PermissionMode[];
  /** What the task form offers for this agent; a choice left out runs with the agent's own default. */
  options: readonly AgentOption[];
  /** A pending decision lives in the agent's process, and a restart ends it unanswered. */
  pendingRequestsSurviveRestart: false;
}

/** A choice the task form offers for one agent, in values the agent's own CLI takes. */
export interface AgentOption {
  id: "model" | "effort";
  label: string;
  choices: readonly { value: string; label: string }[];
}

/** What a task chose of its agent's options, by option id. */
export type AgentChoices = Partial<Record<AgentOption["id"], string>>;

/** Why a task's choices cannot run on this agent, or null: a value the agent does not offer is refused, never passed on. */
export function choicesProblem(options: readonly AgentOption[], choices: AgentChoices = {}): string | null {
  for (const [id, value] of Object.entries(choices)) {
    const option = options.find((o) => o.id === id);
    if (!option) return `this agent offers no ${id} choice`;
    if (!option.choices.some((c) => c.value === value)) return `this agent offers no ${option.label.toLowerCase()} ${JSON.stringify(value)}`;
  }
  return null;
}

/** There is no "always": a decision never outlives the task it was given in. */
export type Decision = "allow-once" | "allow-for-task" | "deny";

export type RequestKind = "command" | "file-read" | "file-change" | "mcp" | "permission" | "question" | "secret" | "plan";

export interface AgentRequest {
  /** Stable for the life of the request, so an answer reaches the question it was given to. */
  id: string;
  kind: RequestKind;
  tool: string;
  /** What the call is aimed at, as data; masked by the runner before it is stored or shown. */
  summary: string;
  /** What a `question` asks, in the agent's own words; data, masked by the runner before it is stored or shown. */
  questions?: AgentQuestion[];
  /** The agent's whole plan, for a `plan` request; data, masked by the runner before it is stored or shown. */
  plan?: string;
}

/** The most a card asks at once, and the most choices one question offers; a longer one is refused, never cut. */
export const QUESTIONS_MAX = 4;
export const OPTIONS_MAX = 8;

/** One question the agent asks the person. `key` is the codec's own, and an answer is given by it. */
export interface AgentQuestion {
  key: string;
  title: string;
  description?: string;
  choice: "one" | "many" | "text";
  options?: { value: string; label: string; description?: string }[];
  /** The person's own words are taken beside the options. */
  other?: boolean;
}

/** The person's answer to each question by its key: the option values chosen, and their own words or null. */
export type AgentAnswers = Record<string, { chosen: string[]; other: string | null }>;

/**
 * Why a turn went wrong, for the runner to act on without reading codes: `usage_limit` waits
 * for its reset, `sign_in` needs the person to sign the agent in again, `provider_retrying` is
 * never a terminal (the agent is trying again on its own), `provider` and `transport` end the
 * turn and say whether trying again later can help. An interrupt is never a failure.
 */
export type FailureClass = "usage_limit" | "sign_in" | "provider" | "provider_retrying" | "transport";

export interface AgentFailure {
  class: FailureClass;
  /** The orchestrator's own words; it never quotes the agent. */
  message: string;
  retryable: boolean;
  /** An HTTP status or the agent's own reason, for the log and the support conversation. */
  code?: string;
  /** When a usage limit lifts, from the agent's own report, and only when that is a time in the near future. */
  resetAt?: string;
  /** The agent's own error text, data only; masked by the runner before it is stored or shown. */
  detail?: string;
}

/**
 * The one stream a session gives the runner. Raw CLI frames never cross it; they go only to the
 * diagnostics sink. Nothing here is shortened: the runner masks credentials and secrets first
 * and only then cuts a long text, since a cut through a token leaves a part neither the
 * credential's value nor a secret pattern recognises.
 */
export type AgentEvent =
  | { type: "message"; text: string }
  /** A stdout line that is not one of the agent's frames; a CLI's own error text arrives this way. Data only. */
  | { type: "output"; text: string }
  /**
   * `id` ties a call to its output and edits; `command` is a shell call's command line, masked and
   * cut; `mcp` names an MCP tool's server and tool apart, so a page needs no agent's naming scheme,
   * and is absent when the name cannot be split for certain.
   */
  | { type: "tool_call"; id?: string; tool: string; target: string | null; status: "started" | "done" | "failed" | "refused"; command?: string; mcp?: { server: string; tool: string }; refusal?: Refusal }
  /** A shell or test call's output as it comes, whole lines only, masked; never what a Read returned or a person's own MCP tool. */
  | { type: "tool_output"; id: string; lines: string[] }
  /** A file the agent changed, by its path in the task's folder; its patch is cut short, and a credential file's is left out. */
  | { type: "edit"; id: string; path: string; additions: number; deletions: number; patch?: string }
  /** The agent's own to-do list, whole each time. */
  | { type: "todos"; items: { text: string; state: "todo" | "doing" | "done" }[] }
  | { type: "request"; request: AgentRequest }
  | { type: "request_resolved"; requestId: string; decision: Decision }
  /** The agent took a question back before anyone answered it; its card has nothing left to decide. */
  | { type: "request_withdrawn"; requestId: string }
  /**
   * How many tokens the agent's first request carried: its system prompt, its tools and the setup
   * it loaded (skills, MCP servers, CLAUDE.md), the reason a cost line gives. Once per session;
   * the log shows no line for it.
   */
  | { type: "context"; tokens: number }
  /** The MCP servers the agent found waiting for a sign-in when the session opened, by name; once, and only when there are some. */
  | { type: "mcp_status"; needsSignIn: string[] }
  /** An addition to what the task spent; a null part is unknown, never estimated. */
  | { type: "usage"; cost: TaskCost }
  /**
   * What this turn has cost so far by the agent's own token counts and its model's list price:
   * the turn's running total, an estimate, from zero at each turn's start. It lets a dollar cap stop
   * a turn that is still running; the turn's `usage` replaces it. An agent whose model has no price
   * sends none, and the log shows no line for it.
   */
  | { type: "spend"; usd: number }
  /** The agent's own end-of-turn frame. A session with steer has several turns. */
  | { type: "turn_finished"; ok: boolean; summary: string; reason: string | null; turns: number | null }
  | { type: "error"; failure: AgentFailure }
  /**
   * Where one of the account's usage windows stands, as the agent reports it; the latest for a
   * window replaces the one before. Only what resuming needs crosses: how full a window is and
   * the plan's overage state stay with the agent.
   */
  | { type: "limit"; window: string; status: "allowed" | "warning" | "refused"; resetAt?: string }
  /**
   * How many pieces of work the agent started in the background are still running: work that
   * outlives its turn and ends on its own. While any is, a turn's end is not the session's: its
   * input stays open so the agent can take up what that work reports.
   */
  | { type: "background"; pending: number }
  /** How the session runs differs from what was asked, in the orchestrator's words: a mode the agent's own settings refused. */
  | { type: "notice"; text: string }
  | AgentTerminal;

/**
 * Why a call was refused, in the orchestrator's own words, never the agent's: a tracker's or a
 * forge's tool that writes, a path the task's rules keep the agent from, or a tool the task does
 * not allow.
 */
export interface Refusal {
  kind: "tracker-write" | "forge-write" | "data-folder" | "not-allowed";
  reason: string;
}

/** The last event of every session, exactly once, after the process has ended. */
export interface AgentTerminal {
  type: "terminal";
  status: "completed" | "interrupted" | "failed";
  summary: string;
  failure?: AgentFailure;
  /** The agent's own session id, for resume. */
  nativeSessionId?: string;
}

/** Reads one session's stdout, line by line, into events; one decoder per session. */
export interface AgentDecoder {
  decode(line: string): AgentEvent[];
  /** The terminal, from what was decoded and how the process ended. */
  finish(exitCode: number | null): AgentTerminal;
}

/**
 * A decoder that also writes what a two-way session sends the agent, one stdin line each. It
 * keeps the requests it decoded, since an answer has to carry what only the agent's own frame
 * held; an answer to a request it does not hold is null. `allow-for-task` goes to the agent as
 * a single allow and never as a standing rule; the session answers the same call again itself.
 */
export interface AgentCodec extends AgentDecoder {
  turn(text: string): string;
  answer(requestId: string, decision: Decision, note?: string): string | null;
  /**
   * The line that gives a held question its answers, or null for a request that is no question it
   * holds; absent for an agent without `questions`. A question is turned down with `answer(…, "deny")`.
   */
  reply?(requestId: string, answers: AgentAnswers): string | null;
  /**
   * The line that approves a held plan as the person changed it, or null for a request that is no
   * plan it holds or a plan left empty; absent for an agent without `plan`. The plan as it came is
   * approved with `answer(…, "allow-once")`, and turned down with `answer(…, "deny")`.
   */
  approvePlan?(requestId: string, plan: string): string | null;
  /**
   * What a grant for the task covers, built from the agent's own frame for a request it holds:
   * the call's full target, not the masked summary two different calls can share. It never
   * leaves the session, so it is never stored, shown or sent.
   */
  grantKey(requestId: string): string | null;
  /** Lines to write now with no person asked: the answer to a call the task does not allow, refused without a question. */
  pending(): string[];
  interrupt(): string;
}

/**
 * A running agent process, as the runner hands it to a session. The runner starts it under
 * the task's isolation, network rule and timeout; a session never starts a process itself.
 */
export interface AgentTransport {
  readonly lines: AsyncIterable<string>;
  write(line: string): void;
  end(): void;
  kill(): void;
  readonly exit: Promise<number | null>;
}

export interface AgentSession {
  /** Ends with exactly one terminal event. */
  readonly events: AsyncIterable<AgentEvent>;
  /**
   * A message for the agent. A session is busy from a message until its turn finishes; while
   * busy, only an agent with `steer` takes another, and otherwise this throws, which tells the
   * caller to hold the message until the turn is done.
   */
  sendTurn(text: string): void;
  /** A request: the terminal still comes from the agent or from the process ending. */
  interrupt(): void;
  /** Needs `approvals`. A note goes with a deny only, and reaches the agent as data. */
  respond(requestId: string, decision: Decision, note?: string): void;
  /** Needs `questions`: the person's answers to a question the agent asked, as data. The runner checks their shape against what was asked. */
  reply(requestId: string, answers: AgentAnswers): void;
  /** Needs `plan`: approves the agent's plan as the person changed it, as data; the plan as it came is approved with `respond`. */
  approvePlan(requestId: string, plan: string): void;
  /** Ends the session once the turn in progress is done: stdin closes and the agent exits by itself. */
  close(): void;
  /** Ends the process now, the force-stop after a close or an interrupt was not enough. */
  stop(): void;
}
