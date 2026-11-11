import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, ApiError, integrationsApi, issuesApi, manages, MOST_SKILLS, taskLimitsApi, tasksApi } from "./api";
import { ConfirmAction, CopyText } from "./Confirm";
import { FORGE, ForgeReach, useForgeReach } from "./ForgeReach";
import type { AgentChoices, AgentSummary, CurrentBudgets, IssuePreview, Principal, RepoRecord, RequestStatus, SkillSuggestions, TaskLimits, TaskLogLine, TaskOptions, TaskRecord, TaskStartInput, TaskStatus, TaskTarget, TaskTargets, TaskTemplate } from "./api";
import { here, navigate, placeOf } from "./router";
import { PROMISE } from "./words";
import { Select } from "./Select";
import { AgentChoicesPicker, chosen } from "./AgentChoices";
import { NextStep } from "./NextStep";
import { ATTENTION, decisionOf, taskRows } from "./attention";
import { ChangeCounts } from "./ChangeCounts";
import { ChangeWeight } from "./design/ChangeWeight";
import { PageHead } from "./design/PageHead";
import { TurnSection } from "./design/TurnSection";
import { stateOf, stateSaid } from "./task-state";
import type { Decided } from "./attention";
import { readSeen } from "./AttentionWatcher";
import { ForgeState } from "./ForgeState";
import { SignInLine } from "./machines/SignIn";
import { readPref, usePref, writePref } from "./prefs";
import { RequestDiff } from "./RequestDiff";
import { requestReads } from "./request-reads";
import { FORGES, forgeRequestName, isHostedForge } from "../../shared/forge-def";
import { homeRelative, pastedPath, projectsRead } from "./projects-read";
import type { WorkFolder } from "./projects-read";
import { workApi } from "./work/api";
import type { WorkStarter } from "./work/api";
import { WelcomeView } from "./Welcome";
import { Announcer } from "./Announcer";
import { Hint } from "./Hint";
import { mergeCommand, sentence } from "./said";
import { liveRun, writtenPlan } from "./live-run";
import { useProjectChecks } from "./ProjectChecks";
import { checkWords, stillFails, verificationRead } from "./verification-read";
import type { TaskVerification } from "./verification-read";
import { boardApi, cardState, daySentence, cardUnread, whenShort } from "./task-board";
import type { BoardCard, TaskBoard, Turn } from "./task-board";
import { LiveRun, RunPlan } from "./LiveRun";
import { SkillChips } from "./SkillChips";
import { AgentLoaded, loadedList, NO_TOOLS, TaskToolsPick } from "./TaskToolsPick";
import type { PickedTools } from "./TaskToolsPick";
import { asksNow, machineWait, TaskRequests, WaitingNote } from "./TaskRequests";
import { TaskShares } from "./TaskShares";
import { TaskLearned } from "./TaskLearned";
import { useFolderReview } from "./projects/ReviewChanges";
import { addQuote, TaskFollowUp } from "./TaskFollowUp";
import { limitsLine } from "./settings/TaskLimits";
import { McpSignIn } from "./McpSignIn";
import { TaskQuestion } from "./TaskQuestion";
import { TaskWhere } from "./TaskWhere";
import { TaskSuggestions } from "./TaskSuggestions";
import type { Quote } from "./diff-quote";
import type { SelectOption } from "./Select";
import { Loading, LoadFailed, RefreshFailed } from "./Status";

const ACTIVE: TaskStatus[] = ["queued", "running"];
const AGAIN: TaskStatus[] = ["failed", "cancelled"];
type ShownStatus = TaskStatus | "merged" | "closed" | "undone" | "kept";
export const STATUS_TEXT: Record<ShownStatus, string> = {
  queued: "queued",
  running: "running",
  "needs-review": "needs review",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
  merged: "merged",
  closed: "closed",
  undone: "changes undone",
  kept: "changes kept",
};
/** What happened to a change on its forge, named by the forge's own word for it when it is known: "Merge request !12 on GitLab was merged." */
function changeSaid(forge: { kind: string; number: number } | string | null | undefined, number: number, status: RequestStatus): string {
  const kind = typeof forge === "string" ? forge : forge?.kind;
  const name = kind && isHostedForge(kind) ? forgeRequestName(kind, typeof forge === "object" && forge ? forge.number : number) : "The change";
  return `${name} ${REQUEST_TEXT[status]}.`;
}

const REQUEST_TEXT = {
  open: "waits for a person to review and merge it",
  merged: "was merged",
  closed: "was closed without being merged",
};

/**
 * A task started again as it was first started: its work, agent and options, the same repositories
 * and skills, planned again by the orchestrator or the ones a person named, and how far the agent
 * acts without asking, which left out would fall back to the default.
 */
export function againInput(task: TaskRecord): TaskStartInput {
  return {
    title: task.title, description: task.description, issueUrl: task.issueUrl ?? "", repoId: task.repoId, agent: task.agent, template: task.template,
    ...(task.targetMode === "orchestrator" ? { targets: "orchestrator" as const } : task.targets?.length ? { targets: task.targets.map((t) => t.repoId) } : {}),
    ...(task.skills?.length ? { skills: task.skills } : {}),
    ...(task.choices && Object.keys(task.choices).length ? { choices: task.choices } : {}),
    ...(task.mode ? { mode: task.mode } : {}),
    ...(task.tools?.skills.length ? { projectSkills: task.tools.skills.map((s) => ({ source: s.source, name: s.name })) } : {}),
    ...(task.tools?.mcpServers.length ? { mcpServers: task.tools.mcpServers } : {}),
  };
}

/** A task whose work a person has decided shows that decision, not a review that is over. */
export function shownStatus(task: Decided): ShownStatus {
  const decided = decisionOf(task);
  if (decided) return decided;
  return task.status === "needs-review" && task.request?.status === "merged" ? "merged" : task.status;
}

function StatusBadge({ task }: { task: TaskRecord }) {
  const state = stateOf(task);
  const said = stateSaid(state, task.forge);
  return (
    <>
      <span className={`state ${said.tone}`} data-status={state}>{said.word}</span>
      {task.queuePosition !== null ? <span className="muted" data-queue={task.queuePosition}> #{task.queuePosition} in line</span> : null}
    </>
  );
}

function duration(task: Pick<TaskRecord, "startedAt" | "finishedAt">): string {
  if (!task.startedAt) return "not started";
  const ms = new Date(task.finishedAt ?? Date.now()).getTime() - new Date(task.startedAt).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function ordinal(n: number): string {
  return ["first", "second", "third", "fourth", "fifth"][n - 1] ?? `${n}th`;
}

function cost(task: TaskRecord): string {
  const { usd, inputTokens, outputTokens } = task.cost;
  if (usd === null && inputTokens === null && outputTokens === null) return "unknown";
  const parts = [usd !== null ? `$${usd.toFixed(4)}` : "cost unknown"];
  if (inputTokens !== null || outputTokens !== null) parts.push(`${inputTokens ?? "?"} in / ${outputTokens ?? "?"} out tokens`);
  return `${parts.join(", ")}${task.costPartial ? ", some parts unreported" : ""}`;
}

const READINESS_STATE: Record<AgentSummary["state"], { text: string; tone: string }> = {
  ready: { text: "Ready", tone: "ok" },
  warnings: { text: "Ready with warnings", tone: "warn" },
  "not-ready": { text: "Not ready", tone: "error" },
};

/**
 * Where the agent picked in the form stands, as the last readiness check found it: a state, and
 * for an admin the way to what each check found. It informs; it never stops a start.
 */
function AgentNote({ agent, details }: { agent: TaskOptions["agents"][number] | undefined; details: boolean }) {
  const readiness = agent?.readiness;
  if (!agent) return null;
  if (!readiness) {
    return (
      <p className="muted" role="status" aria-label={`${agent.label} readiness`}>
        <span className="state neutral">Checking</span> whether {agent.label} can run here…
      </p>
    );
  }
  const notReady = readiness.state === "not-ready";
  const { text, tone } = READINESS_STATE[readiness.state];
  return (
    <p className="muted" role={notReady ? "alert" : "note"} aria-label={`${agent.label} readiness`}>
      <span className={`state ${tone}`}>{text}</span>
      {/* The first warning or failure arrives as a few fixed words; beside the badge it reads as one sentence. */}
      {readiness.first ? <> {sentence(readiness.first)}</> : notReady ? " A task started now fails." : null}
      {details && readiness.state !== "ready" ? <> <a href={here("settings", "agents")}>See details</a></> : notReady ? <> <Hint label={`why ${agent.label} is not ready`}>A task started now fails. An admin sees why on Agent readiness.</Hint></> : null}
    </p>
  );
}

/** Why a run ended, from the first line it left as its error: ": why." after the time, or a full stop when it said nothing. */
export function endReasonOf(error: string | null): string {
  const first = error?.trim().split("\n")[0]?.trim().replace(/[.\s]+$/, "");
  return first ? `: ${first}.` : ".";
}

function usd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The first day of the month after `month` (YYYY-MM), when every monthly budget starts again. */
export function resetDay(month: string): string {
  const [year, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, m, 1)).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** The monthly budgets the next task counts against, and the one that stops it once reached. */
export function BudgetNote({ budgets }: { budgets: CurrentBudgets }) {
  if (!budgets.budgets.length) return null;
  return (
    <ul className="plain budgets" aria-label="Task budgets">
      {budgets.budgets.map((b) => (
        <li key={`${b.policyId ?? b.policy}:${b.per}`}>
          {b.reached ? (
            <><span className="badge error">Budget reached</span> Tasks start again on {resetDay(budgets.month)}.</>
          ) : (
            <><span className="badge ok">Monthly budget left</span> {usd(b.leftUsd)} of {usd(b.monthlyUsd)}{b.per === "member" ? " for you" : ", shared"}.</>
          )}{" "}
          <Hint label={`the budget ${b.policy}`}>
            {b.reached ? `${usd(b.spentUsd)} of ${usd(b.monthlyUsd)} spent this month${b.per === "member" ? " by you" : ""} under ${b.policy}.` : `Under ${b.policy}.`}
            {b.unknownCost ? ` ${b.unknownCost} ${b.unknownCost === 1 ? "task" : "tasks"} this month reported no cost and ${b.unknownCost === 1 ? "is" : "are"} not counted.` : ""}
          </Hint>
        </li>
      ))}
    </ul>
  );
}

/** The pasted text as an issue and notes: a first line that is a link or an issue key is the issue, the rest the notes. */
export function splitWork(text: string): { issue: string; notes: string } {
  const [first = "", ...rest] = text.trim().split("\n");
  // The issue is the first word of the first line, so words written beside it stay notes instead of hiding the issue.
  const [head = "", ...beside] = first.trim().split(/\s+/);
  // A Jira key, or a GitLab or GitHub issue as path#number; the orchestrator turns either into a link on the connected tracker.
  const issue = /^https:\/\/\S+$/.test(head) || /^[A-Z][A-Z0-9_]+-\d+$/.test(head) || /^[\w.-]+(\/[\w.-]+)+#\d+$/.test(head) ? head : "";
  return issue ? { issue, notes: [beside.join(" "), ...rest].join("\n").trim() } : { issue: "", notes: text.trim() };
}

// Zero-width, direction and control characters: a pasted or forwarded link carries them unseen and they would change what the task reads.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Whether the person last left a task's log open or folded; until they have, it opens only while there is no change to read. */
export const LOG_OPEN_KEY = "orchestrator.task.log";

/** A log line's time in the reader's own clock, as the task's meta line says its start; a line and the meta never disagree by a zone. */
function logTime(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

/** One line of the task page's rail: what a fact is, and its value. */
export interface TaskFact { term: string; value: string }

/**
 * A task's facts for the page's rail, leaving out what is not known yet: where it works, then
 * the agent, who started it and when, its tests, time and cost once there are any, and what it
 * writes and reads first.
 */
export function taskFacts(task: TaskRecord, agent: string, me: Pick<Principal, "email" | "mode">, when: (at: string) => string, folder: string | null = null): { where: TaskFact[]; run: TaskFact[] } {
  // A task the orchestrator sent to a folder names that folder, as its run's first line does, not the record it keeps for it.
  const where = [{ term: me.mode === "local" ? "Folder" : "Repository", value: folder ?? task.repoId }];
  if (me.mode !== "local") where.push({ term: "Team", value: task.team });
  const run = [{ term: "Agent", value: agent || "The agent" }, { term: "Started", value: `${when(task.createdAt)} by ${task.createdBy === me.email ? "you" : task.createdBy}` }];
  if (task.tests === "passed" || task.tests === "failed") run.push({ term: "Tests", value: task.tests });
  if (task.startedAt && task.finishedAt) run.push({ term: "Ran", value: duration(task) });
  // What a run cost, the context it opened with and what it loaded sit side by side, so the reader sees what drove the cost without the page claiming it.
  if (task.cost.usd !== null) run.push({ term: "Cost", value: `$${task.cost.usd.toFixed(task.cost.usd < 0.01 ? 4 : 2)}${task.costPartial ? ", some parts unreported" : ""}` });
  else if (task.startedAt && task.finishedAt && task.cost.inputTokens === null && task.cost.outputTokens === null) run.push({ term: "Cost", value: "Not reported" });
  if (task.context?.tokens) run.push({ term: "Context", value: `${task.context.tokens >= 1000 ? `${Math.round(task.context.tokens / 1000)}k` : task.context.tokens} tokens at its start` });
  if (task.loaded && loadedList(task.loaded)) run.push({ term: "Loaded", value: loadedList(task.loaded)! });
  if (task.template?.kind === "scaffold.refresh") run.push({ term: "Does", value: task.template.commitVersioning ? "Refreshes the scaffold and switches to versioning by commit" : "Refreshes the scaffold" });
  else if (task.template) run.push({ term: "Does", value: `${task.template.kind === "skill.write" ? "Writes" : "Improves"} the skill ${task.template.skill}` });
  if (task.skills?.length) run.push({ term: "Reads first", value: task.skills.join(", ") });
  return { where, run };
}

// The same, with line breaks and tabs kept, for a description that runs over several lines.
const INVISIBLE_IN_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** What a link fills the task form with, never a start. */
export interface TaskStart { issue: string; repo: string; title: string; description: string }

/** What a link to `work/new` or `tasks/new` fills the task form with: the issue, repository, title and description as given, never more. */
export function startLink(search: string): TaskStart {
  const params = new URLSearchParams(search);
  const clean = (name: string) => (params.get(name) ?? "").replace(INVISIBLE, "").trim();
  return { issue: clean("issue"), repo: clean("repo"), title: clean("title"), description: (params.get("description") ?? "").replace(INVISIBLE_IN_TEXT, "").trim() };
}

/** What the form starts with: a link's values, else the words this browser kept from the last visit. */
export function formStart(start: TaskStart | undefined, kept: string | null): { work: string; title: string; notes: string } {
  if (start && (start.issue || start.title || start.description)) {
    return start.issue ? { work: start.issue, title: start.title, notes: start.description } : { work: start.description, title: start.title, notes: "" };
  }
  try {
    const read = JSON.parse(kept ?? "null") as Record<string, unknown> | null;
    const text = (key: string) => (typeof read?.[key] === "string" ? (read[key] as string) : "");
    return { work: text("work"), title: text("title"), notes: text("notes") };
  } catch {
    return { work: "", title: "", notes: "" };
  }
}

/** Unsent words in the task form, per organization, so a closed tab or a slip of the back button loses nothing. */
const DRAFT_KEY = "orchestrator.task.draft";

/** The line naming a linked issue: its key, with its title and, in brackets, its status when the orchestrator read them. */
export function issueLine(preview: IssuePreview): string {
  return `${[preview.key ?? preview.url, preview.title].filter(Boolean).join(" ")}${preview.status ? ` (${preview.status})` : ""}`;
}

/** A title the server takes when none is typed: the issue's, the template's, or the first line of the notes. */
export function taskTitle(typed: string, issueTitle: string | null, templateTitle: string | null, notes: string): string {
  return (typed.trim() || issueTitle || templateTitle || notes.split("\n", 1)[0] || "").trim().slice(0, 120);
}

/** What starting the task does, in one line beside the button. */
export function startSummary(input: { issueKey: string | null; reads: boolean; mode: "code" | "skills"; spread: "orchestrator" | "chosen"; repos: string[]; byOrchestrator: boolean; routed?: boolean; forge?: "gitlab" | "github" | null }): string {
  const from = input.issueKey ? `${input.reads ? "Reads" : "Works from"} ${input.issueKey}, ` : "";
  // The folder is not known before the start, so what it holds, Git or none, is not said either.
  if (input.routed) return `${from}changes your files; you review before keeping.`.replace(/^./, (c) => c.toUpperCase());
  if (input.byOrchestrator) return `The orchestrator updates ${input.repos[0] ?? "the repository"} itself and a reviewer merges it; no agent runs.`;
  if (input.mode === "code" && input.spread === "orchestrator") return `${from}picks the repositories; a reviewer merges each change.`;
  const names = input.repos.length > 1 ? `${input.repos.slice(0, -1).join(", ")} and ${input.repos.at(-1)}${input.mode === "code" ? " in that order" : ""}` : input.repos[0] ?? "the repository";
  const on = input.forge ? ` on ${FORGES[input.forge].label}` : "";
  const review = input.repos.length > 1 ? "a reviewer merges each change." : `a reviewer merges it${on}.`;
  const text = `${from}changes ${names}; ${review}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A short help text kept behind a small (i), opened with a click or the keyboard. */
type SkillKind = "any" | "skill.write" | "skill.improve" | "scaffold.refresh" | "scaffold.switch";
const SKILL_KINDS: SelectOption[] = [
  { value: "any", label: "Any change" },
  { value: "skill.write", label: "Write a new skill" },
  { value: "skill.improve", label: "Improve a skill" },
  { value: "scaffold.refresh", label: "Refresh the TeamHandbook scaffold" },
  { value: "scaffold.switch", label: "Switch the plugin to versioning by commit" },
];

// The agents' names as people know them, read once per page load: a task records the agent's id,
// which is the orchestrator's word for it, not the person's.
let labels: Promise<Map<string, string>> | null = null;
function agentLabels(): Promise<Map<string, string>> {
  labels ??= tasksApi.options().then((o) => new Map(o.agents.map((a) => [a.id, a.label])), () => {
    labels = null;
    return new Map();
  });
  return labels;
}

const RETIRED_AGENT = "an agent no longer offered";

/** An agent's name for a person; empty until it is read, and "an agent no longer offered" when the orchestrator has none by that id. */
export function useAgentLabel(id: string): string {
  const [known, setKnown] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    let current = true;
    agentLabels().then((m) => current && setKnown(m));
    return () => {
      current = false;
    };
  }, []);
  return known === null ? "" : known.get(id) ?? RETIRED_AGENT;
}

/** An agent's name in a row: from the options the page already read when it has them, so the column is not empty while a second read lands. */
function AgentName({ id, known }: { id: string; known?: TaskOptions["agents"] | null }) {
  const read = useAgentLabel(id);
  if (!known) return <>{read}</>;
  return <>{known.find((a) => a.id === id)?.label ?? RETIRED_AGENT}</>;
}

/** `defaultRepo`: the repository the rail picked, else the last one used, so the first task still takes two choices. */
function NewTask({ options, budgets, limits = null, start, local, approver, defaultRepo = null, onStarted, onCancel, focus = false, first = false }: { options: TaskOptions; budgets: CurrentBudgets | null; limits?: TaskLimits | null; start?: TaskStart; local: boolean; approver: boolean; defaultRepo?: string | null; onStarted: (task: TaskRecord) => void; onCancel?: () => void; focus?: boolean; first?: boolean }) {
  const codeRepos = options.repos.filter((r) => r.kind === "code");
  const skillRepos = options.repos.filter((r) => r.kind !== "code");
  const linkedCode = codeRepos.some((r) => r.id === start?.repo);
  const linkedSkills = skillRepos.some((r) => r.id === start?.repo);
  const usualCode = !start?.repo && codeRepos.some((r) => r.id === defaultRepo) ? defaultRepo : null;
  const draftKey = `${DRAFT_KEY}:${placeOf(window.location.pathname).org ?? ""}`;
  const [initial] = useState(() => formStart(start, readPref(draftKey)));
  const restored = !start?.issue && !start?.title && !start?.description && Boolean(initial.work || initial.title || initial.notes);
  const [work, setWork] = useState(initial.work);
  const [mode, setMode] = useState<"code" | "skills">(linkedSkills || (!local && !codeRepos.length) ? "skills" : "code");
  const [spread, setSpread] = useState<"orchestrator" | "chosen">(options.multiRepo && !linkedCode && !usualCode ? "orchestrator" : "chosen");
  const [picked, setPicked] = useState<string[]>(linkedCode ? [start!.repo] : usualCode ? [usualCode] : codeRepos.length === 1 ? [codeRepos[0]!.id] : []);
  const [skillRepo, setSkillRepo] = useState(linkedSkills ? start!.repo : skillRepos[0]?.id ?? "");
  const [kind, setKind] = useState<SkillKind>("any");
  const [skill, setSkill] = useState("");
  const [skills, setSkills] = useState<string[] | null>(null);
  const [title, setTitle] = useState(initial.title);
  const [notes, setNotes] = useState(initial.notes);
  // The first task asks for no agent: the first one that is ready takes it, as a person's own orchestrator has few.
  const [agent, setAgent] = useState((first ? options.agents.find((a) => a.readiness?.ready !== false) : undefined)?.id ?? options.agents[0]?.id ?? "");
  const [choices, setChoices] = useState<AgentChoices>({});
  const [preview, setPreview] = useState<IssuePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ code?: string; status?: number }>({});
  const [suggested, setSuggested] = useState<SkillSuggestions | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [useSkills, setUseSkills] = useState<string[]>([]);
  const [tools, setTools] = useState<PickedTools>(NO_TOOLS);
  const errorId = useId();
  const workId = useId();
  const split = splitWork(work);
  const issue = split.issue;
  const budgetReached = Boolean(budgets?.budgets.some((b) => b.reached));

  // Leaving the page with words typed and not started asks first; a link's own filling is not typed.
  const typed = work !== initial.work || title !== initial.title || notes !== initial.notes;
  const empty = !work.trim() && !title.trim() && !notes.trim();
  useEffect(() => {
    if (typed) writePref(draftKey, empty ? null : JSON.stringify({ work, title, notes }));
  }, [work, title, notes]);
  useEffect(() => {
    if (!typed) return;
    const hold = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [typed]);
  // The pasted issue is read once typing stops, the way the task will read it.
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!issue) return;
    let current = true;
    const timer = setTimeout(() => {
      issuesApi.preview(issue).then((p) => current && setPreview(p), (e: Error) => current && setPreviewError(e.message));
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [issue]);
  // The skills offered for improving are the repository's own, as the orchestrator last read it.
  useEffect(() => {
    if (mode !== "skills" || kind !== "skill.improve" || !skillRepo) return;
    setSkills(null);
    api.inventory(skillRepo).then(
      ({ inventory }) => {
        const slugs = inventory.skills.map((s) => s.slug);
        setSkills(slugs);
        setSkill(slugs[0] ?? "");
      },
      () => setSkills([]),
    );
  }, [mode, kind, skillRepo]);

  const template: TaskTemplate | null = mode === "code" || kind === "any" ? null
    : kind === "scaffold.refresh" || kind === "scaffold.switch" ? { kind: "scaffold.refresh", commitVersioning: kind === "scaffold.switch" }
      : { kind, skill: skill.trim() };
  const byOrchestrator = template?.kind === "scaffold.refresh";
  const templateTitle = !template ? null
    : template.kind === "scaffold.refresh" ? (template.commitVersioning ? "chore: switch the plugin to versioning by commit" : "chore: refresh the team handbook scaffold")
      : template.skill ? `${template.kind === "skill.write" ? "Write" : "Improve"} the skill ${template.skill}` : null;
  // A code task the orchestrator plans, or one over several repositories, carries targets; one repository picked without an issue is a task on that repository alone.
  // On a person's own orchestrator a code task names no folder: the orchestrator picks it from what the task asks and says so in the run's first line.
  const routed = local && mode === "code";
  // Beside a list of tasks the form is the box and Start; the agent and the other choices fold under More options.
  const compact = local && !first;
  // The servers the newest task found needing a sign-in are the ones the next task will find too, so the form says so before Start.
  const [starters, setStarters] = useState<WorkStarter[]>([]);
  // A first task offers a few found in the folder the person worked in last: a TODO, a failing test.
  useEffect(() => {
    if (!first || !local) return;
    projectsRead.list().then(({ last }) => (last ? workApi.starters(last).then((r) => setStarters(r.starters.slice(0, 3))) : undefined), () => setStarters([]));
  }, [first, local]);
  const [lastNeeds, setLastNeeds] = useState<string[]>([]);
  useEffect(() => {
    if (local) tasksApi.page(null).then((r) => setLastNeeds(r.tasks[0]?.mcpNeedsSignIn ?? []), () => setLastNeeds([]));
  }, [local]);
  const several = !routed && mode === "code" && (spread === "orchestrator" || picked.length > 1);
  const targets: TaskTargets | undefined = !routed && mode === "code" && options.multiRepo && issue && (spread === "orchestrator" || picked.length > 1) ? (spread === "orchestrator" ? "orchestrator" : picked) : undefined;
  const repoId = routed ? "" : mode === "skills" ? skillRepo : spread === "chosen" ? picked[0] ?? "" : codeRepos[0]?.id ?? "";
  const startRepo = options.repos.find((r) => r.id === repoId);
  // A code project's checks are said here only while this Start would approve them; one project at a time.
  // A folder on a person's own machine has its checks approved by that person, whatever their role; the orchestrator answers its checks to nobody else.
  const checks = useProjectChecks(mode === "code" && !several && startRepo?.kind === "code" ? repoId : null, "needed", approver || Boolean(startRepo?.machine));
  const ticketMissing = startRepo?.ticketExample != null && !issue;
  // What the agent is told besides the issue: the words written with the link in the box, then the notes field's.
  const asked = issue ? [split.notes, notes].filter(Boolean).join("\n\n") : split.notes;
  const named = taskTitle(title, preview?.title ?? null, templateTitle, asked);
  // An empty form says nothing beside Start: its own label already asks for the work.
  const blank = !work.trim() && !templateTitle;
  const missing = blank ? null
    : several && !issue ? "Paste an issue link to let the agent pick the repositories or to change several."
      : !routed && mode === "code" && spread === "chosen" && !picked.length ? "Pick a repository."
        : ticketMissing ? `${startRepo!.name} names branches after a ticket (its example is ${startRepo!.ticketExample}); paste its issue link.`
          : template && template.kind !== "scaffold.refresh" && !template.skill ? "Name the skill."
            : !named && !issue ? "Describe the work." : null;
  const described = error ? { "aria-invalid": true as const, "aria-describedby": errorId } : {};
  const pickNames = (mode === "skills" ? [skillRepo] : picked).map((id) => options.repos.find((r) => r.id === id)?.name ?? id);
  const summary = startSummary({ issueKey: preview?.key ?? (issue && !issue.startsWith("https://") ? issue : null), reads: Boolean(preview?.title), mode, spread: mode === "code" && options.multiRepo ? spread : "chosen", repos: pickNames, byOrchestrator, routed, forge: startRepo?.forge ?? null });
  // Where the orchestrator was not sure which folder the words point to, it asks once; the person picks or types one and the same start goes again with it.
  // Where the agent can plan first, the person can ask to see its plan before it changes anything; off until they do.
  const [planFirst, setPlanFirst] = useState(false);
  const [asking, setAsking] = useState<{ question: string; folders: WorkFolder[] } | null>(null);
  // Where nothing reads the issue, the agent sees only its link: the person signs in to the tracker, or starts on the link alone.
  const [unread, setUnread] = useState<string | null>(null);
  const [linkAlone, setLinkAlone] = useState(false);
  const [typedPath, setTypedPath] = useState("");
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    if (local) projectsRead.list().then((r) => setHome(r.home ?? null), () => setHome(null));
  }, [local]);
  // New words can point somewhere else, so a question about the old words no longer stands.
  useEffect(() => {
    setAsking(null);
    setUnread(null);
    setLinkAlone(false);
  }, [work]);
  const agentPicker = byOrchestrator || first ? null : <Select label="Agent" value={agent} onChange={(v) => { setAgent(v); setChoices({}); }} describedBy={error ? errorId : undefined} invalid={Boolean(error)} options={options.agents.map((a) => ({ value: a.id, label: a.label, hint: a.readiness && !a.readiness.ready ? "not ready" : undefined }))} />;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    begin();
  };
  // The tracker's own sign-in comes back here; what was typed is kept as a draft meanwhile.
  const signIn = (id: "jira" | "linear" | "gitlab") => {
    setError(null);
    integrationsApi.signInService(id).then((url) => window.location.assign(url), (e: Error) => setError(e.message));
  };
  const begin = (path?: string, alone = false) => {
    if (missing) return;
    setBusy(true);
    setError(null);
    checks.consent().then(() => tasksApi.start({ title: named, description: asked, issueUrl: issue, ...(repoId ? { repoId } : {}), ...(path ? { path } : {}), ...(linkAlone || alone ? { withoutIssueText: true } : {}), ...(planFirst && options.agents.find((a) => a.id === agent)?.plan ? { planFirst: true } : {}), agent, template, ...(targets ? { targets } : {}), ...(useSkills.length ? { skills: useSkills } : {}), ...(chosen(choices) ? { choices: chosen(choices) } : {}), ...(tools.projectSkills.length ? { projectSkills: tools.projectSkills } : {}),
      // Every pick is named, none as well; a command server ticked on a team's orchestrator goes as the person's own confirmation of its command.
      mcpServers: tools.mcpServers, ...(!local && tools.commands.length ? { mcpConfirmed: tools.commands } : {}) })).then(
      (task) => {
        writePref(draftKey, null);
        setWork("");
        setTitle("");
        setNotes("");
        onStarted(task);
      },
      (err: Error) => {
        if (err instanceof ApiError && err.code === "issue-unread") {
          setUnread(err.message);
          return;
        }
        if (err instanceof ApiError && err.code === "pick-folder") {
          projectsRead.workFolders().then((r) => r.folders, () => []).then((folders) => setAsking({ question: err.message, folders }));
          return;
        }
        setError(err.message);
        setRefusal(err instanceof ApiError ? { code: err.code, status: err.status } : {});
      },
    ).finally(() => setBusy(false));
  };
  // Suggestions are of the skills where the work would run, so a change of place clears them.
  useEffect(() => {
    setSuggested(null);
    setSuggestError(null);
    setUseSkills([]);
  }, [repoId, mode, spread, picked.join(",")]);
  const suggest = () => {
    setSuggesting(true);
    setSuggestError(null);
    tasksApi.suggestSkills({ agent, repoId, ...(issue ? { issueUrl: issue } : { description: split.notes || work }), ...(targets ? { targets } : {}) }).then((r) => {
      setSuggested(r);
      setUseSkills(r.suggestions.map((s) => s.skill).slice(0, MOST_SKILLS));
    }, (e: Error) => setSuggestError(e.message)).finally(() => setSuggesting(false));
  };
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]);
  const max = options.multiRepo?.maxTargets ?? 1;
  if (!options.repos.length && !local) {
    return <p className="muted" role="note">You cannot start tasks: starting one takes the admin role or ownership of the team whose project it changes.</p>;
  }
  return (
    <div className="with-rail new-task">
      <form className="task-form" onSubmit={submit} aria-label="New task">
        {options.profile.personal ? (
          <p className={options.profile.refused ? "error" : "muted"} role="note">{options.profile.refused ? `Tasks do not run: ${options.profile.refused}.` : options.profile.note}</p>
        ) : null}
        {start?.repo && !linkedCode && !linkedSkills ? <p className="muted" role="note">The link names a repository you do not start tasks in here; pick one below.</p> : null}
        {restored && !empty ? (
          <p className="muted small" role="note">
            The words you had not started are back.{" "}
            <button type="button" className="link" onClick={() => {
              setWork("");
              setTitle("");
              setNotes("");
            }}>Clear them</button>
          </p>
        ) : null}
        <label htmlFor={workId} className="work-label">What needs doing?</label>
        <textarea id={workId} className={first ? "work" : "work compact"} value={work} onChange={(e) => setWork(e.target.value)} rows={first ? 3 : 2} maxLength={8500} placeholder="https://… or what needs to change" autoFocus={focus} {...described} />
        {options.agents.find((a) => a.id === agent)?.plan ? (
          <label className="check"><input type="checkbox" checked={planFirst} onChange={(e) => setPlanFirst(e.target.checked)} />Show me the plan before it changes anything</label>
        ) : null}
        {first && starters.length && !work.trim() ? (
          <div className="starters">
            <p className="muted small" id={`${workId}-starters`}>Or start with</p>
            {/* A row fills the box with the whole of what the agent is asked, so the person reads it before Start. */}
            <ul className="plain starter-list" aria-labelledby={`${workId}-starters`}>
              {starters.map((s) => (
                <li key={`${s.kind}:${s.where}:${s.title}`}>
                  <button type="button" className="ghost" onClick={() => setWork(`${s.title}\n\n${s.description}`)}>
                    <span dir="auto">{s.title}</span> <span className="mono muted small" dir="auto">{s.where}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {local ? <McpSignIn names={lastNeeds} /> : null}
        {issue ? (
          <div className="issue-card" role="status" aria-label="Issue">
            {previewError ? <p className="error">{previewError}</p> : !preview ? <p className="muted">Reading the issue…</p> : (
              <>
                <p><a href={preview.url} target="_blank" rel="noopener noreferrer" className="mono">{preview.key ?? preview.url}</a>{preview.title ? <> <strong>{preview.title}</strong></> : null}{preview.status ? <span className="badge neutral">{preview.status}</span> : null}</p>
                <p className="muted">{preview.reach}</p>
                {preview.connect ? <p><button type="button" className="secondary small" onClick={() => signIn(preview.connect!.id)}>Sign in with {preview.connect.name}</button> <span className="muted small">to let the agent read {preview.key ?? "it"}</span></p> : null}
              </>
            )}
          </div>
        ) : null}
        {!first && !compact && (codeRepos.length || local) && skillRepos.length ? (
          <div className="segmented wide" role="group" aria-label="What changes">
            <button type="button" className="secondary" aria-pressed={mode === "code"} onClick={() => setMode("code")}>Code</button>
            <button type="button" className="secondary" aria-pressed={mode === "skills"} onClick={() => setMode("skills")}>{local ? "Skills" : "Team skills"}</button>
          </div>
        ) : null}
        {/* Where the work happens and who does it, side by side: the two choices a start takes after the work itself. */}
        <div className="row task-where">
        {mode === "code" ? (!routed && codeRepos.length > 1 ? (
          <fieldset className="plain-fieldset repos-pick">
            <legend>Repositories <Hint label="repositories">Each repository runs in turn with its own checkout, tests and request; the first one that fails stops the rest.</Hint></legend>
            {options.multiRepo ? (
              <>
                <label className="check"><input type="radio" name="spread" checked={spread === "orchestrator"} onChange={() => setSpread("orchestrator")} />Let the agent decide (recommended)</label>
                <label className="check"><input type="radio" name="spread" checked={spread === "chosen"} onChange={() => setSpread("chosen")} />Pick repositories</label>
              </>
            ) : null}
            {spread === "chosen" ? (
              <div className="chips" role="group" aria-label="Repositories, in the order they run">
                {codeRepos.map((r) => {
                  const at = picked.indexOf(r.id);
                  return (
                    <label key={r.id} className={`chip-pick${at >= 0 ? " on" : ""}`}>
                      <input type="checkbox" checked={at >= 0} disabled={at < 0 && picked.length >= max} onChange={() => toggle(r.id)} />
                      {at >= 0 ? <span className="order" aria-hidden="true">{at + 1}</span> : null}
                      <span>{r.name}{r.machine ? <span className="muted"> on {r.machine}</span> : null}</span>
                    </label>
                  );
                })}
              </div>
            ) : null}
          </fieldset>
        ) : null) : (
          <div className="row">
            {skillRepos.length > 1 ? <Select label="Repository" value={skillRepo} onChange={setSkillRepo} options={skillRepos.map((r) => ({ value: r.id, label: r.name, hint: r.team }))} describedBy={error ? errorId : undefined} invalid={Boolean(error)} /> : null}
            <Select label="Kind of task" value={kind} onChange={(v) => { setKind(v as SkillKind); setSkill(""); }} options={SKILL_KINDS} />
            {kind === "skill.write" ? (
              <label>Skill name<input value={skill} onChange={(e) => setSkill(e.target.value)} maxLength={63} pattern="[a-z0-9][a-z0-9-]*" placeholder="on-call-handover" required /></label>
            ) : null}
            {kind === "skill.improve" ? (
              <Select label="Skill" value={skill} onChange={setSkill} disabled={!skills?.length} placeholder={skills === null ? "Loading the repository's skills…" : "This repository has no skill yet"} options={(skills ?? []).map((s) => ({ value: s, label: s }))} />
            ) : null}
          </div>
        )}
        {compact ? null : agentPicker}
        </div>
        <div className="agent-lines">
          {byOrchestrator ? null : <AgentNote agent={options.agents.find((a) => a.id === agent)} details={options.readinessReport} />}
          {byOrchestrator || startRepo?.ownSetup === false ? null : <AgentLoaded label={options.agents.find((a) => a.id === agent)?.label ?? ""} personal={options.agents.find((a) => a.id === agent)?.personal} />}
          {byOrchestrator || !local || !agent ? null : <SignInLine agentId={agent} />}
        </div>
        {!template && work.trim() && repoId && agent ? (
          <div className="suggest-skills">
            {suggested ? <SkillChips label="Skills to use first" read={suggested} value={useSkills} onChange={setUseSkills} local={local} /> : (
              <p>
                <button type="button" className="secondary small" disabled={suggesting} onClick={suggest}>{suggesting ? "Asking the agent…" : "Suggest skills"}</button>{" "}
                <Hint label="suggested skills">The agent reads the work and names the {local ? "" : "team "}skills to use first; it still has every one.</Hint>
              </p>
            )}
            {suggestError ? <p className="muted small" role="status">No suggestion: {suggestError}</p> : null}
          </div>
        ) : null}
        {first ? null : (
          <details className="more">
            <summary>More options</summary>
            <div className="task-form">
              {compact ? agentPicker : null}
            <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder={named || "From the issue"} {...described} /></label>
              {issue ? <label>Notes for the agent<textarea className="short" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={8000} /></label> : null}
              {byOrchestrator ? null : <AgentChoicesPicker options={options.agents.find((a) => a.id === agent)?.options} value={choices} onChange={setChoices} />}
              {repoId && !targets ? <TaskToolsPick key={repoId} repoId={repoId} value={tools} onChange={setTools} canAdd={local} /> : null}
            </div>
          </details>
        )}
        {unread ? (
          <div className="issue-unread" role="group" aria-label="The issue is not read">
            <p dir="auto">{unread}</p>
            <div className="actions">
              {preview?.connect ? <button type="button" className="secondary small" onClick={() => signIn(preview.connect!.id)}>Sign in with {preview.connect.name}</button> : <a className="button secondary small" href={here("integrations")}>Connect</a>}
              <button type="button" className="secondary small" disabled={busy} onClick={() => {
                setLinkAlone(true);
                setUnread(null);
                begin(undefined, true);
              }}>Start on the link alone</button>
            </div>
          </div>
        ) : null}
        {asking ? (
          <div className="pick-folder" role="group" aria-label="Which folder">
            <p dir="auto">{asking.question}</p>
            {asking.folders.length ? (
              <ul className="plain">
                {asking.folders.map((f) => (
                  <li key={f.path}>
                    <button type="button" className="ghost" disabled={busy} onClick={() => begin(f.path)}>
                      <span dir="auto">{f.name}</span> <span className="mono muted" dir="auto">{homeRelative(f.path, home)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <label>A folder's path<input type="text" value={typedPath} onChange={(e) => setTypedPath(e.target.value)} placeholder="~/code" dir="auto" onKeyDown={(e) => {
              if (e.key !== "Enter" || !typedPath.trim()) return;
              e.preventDefault();
              begin(pastedPath(typedPath, home));
            }} /></label>
          </div>
        ) : null}
        {checks.view}
        <div className="actions start">
          <button type="submit" disabled={busy || budgetReached || blank || Boolean(missing)}>Start task</button>
          {onCancel ? <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button> : null}
          <span className="muted" aria-live="polite">{missing ?? summary}</span>
        </div>
        {error ? <p className="error" role="alert" id={errorId}>{error}<NextStep {...refusal} /></p> : null}
      </form>
      {/* Before a start, what the person agrees to: where the agent works, how the change is taken back, and what limits it. */}
      {/* Beside a list of tasks the rail folds on a narrow screen, so the list is not pushed below the first screen; it opens on asking. */}
      {first ? (
        <aside className="rail" aria-label="Before it starts">
          <section aria-labelledby={`${workId}-where`}>
            <h2 id={`${workId}-where`}>Where it works</h2>
            <p dir="auto">{routed ? "The folder the orchestrator picks from what you ask; the run's first line says which, and Change moves it." : targets === "orchestrator" ? "The repositories the orchestrator picks from the issue" : several ? picked.map((id) => options.repos.find((r) => r.id === id)?.name ?? id).join(", ") : startRepo ? `${startRepo.name}${startRepo.machine ? `, on ${startRepo.machine}` : local ? "" : `, ${startRepo.team}`}` : "No repository picked yet"}</p>
            {startRepo?.result && !several ? <p className="muted">{startRepo.result === "changes" ? "The agent edits its files in place; Undo puts every file back." : "Nothing lands until a reviewer merges the change."}</p> : null}
          </section>
          {budgets?.budgets.length || limits ? (
            <section aria-labelledby={`${workId}-limits`}>
              <h2 id={`${workId}-limits`}>Limits</h2>
              {limits ? <p>{limitsLine(limits)} <a href={here("settings", "task-limits")}>Change</a></p> : null}
              {budgets?.budgets.length ? <BudgetNote budgets={budgets} /> : null}
            </section>
          ) : null}
        </aside>
      ) : (
        <details className="rail-fold" open={!window.matchMedia("(max-width: 1023px)").matches}>
          <summary>Where it works and what limits it</summary>
        <aside className="rail" aria-label="Before it starts">
          <section aria-labelledby={`${workId}-where`}>
            <h2 id={`${workId}-where`}>Where it works</h2>
            <p dir="auto">{routed ? "The folder the orchestrator picks from what you ask; the run's first line says which, and Change moves it." : targets === "orchestrator" ? "The repositories the orchestrator picks from the issue" : several ? picked.map((id) => options.repos.find((r) => r.id === id)?.name ?? id).join(", ") : startRepo ? `${startRepo.name}${startRepo.machine ? `, on ${startRepo.machine}` : local ? "" : `, ${startRepo.team}`}` : "No repository picked yet"}</p>
            {startRepo?.result && !several ? <p className="muted">{startRepo.result === "changes" ? "The agent edits its files in place; Undo puts every file back." : "Nothing lands until a reviewer merges the change."}</p> : null}
          </section>
          {budgets?.budgets.length || limits ? (
            <section aria-labelledby={`${workId}-limits`}>
              <h2 id={`${workId}-limits`}>Limits</h2>
              {limits ? <p>{limitsLine(limits)} <a href={here("settings", "task-limits")}>Change</a></p> : null}
              {budgets?.budgets.length ? <BudgetNote budgets={budgets} /> : null}
            </section>
          ) : null}
        </aside>
        </details>
      )}
    </div>
  );
}

const TARGET_STATUS: Record<TaskTarget["status"], { text: string; tone: string }> = {
  planned: { text: "waiting its turn", tone: "neutral" },
  working: { text: "working", tone: "warn" },
  tests: { text: "running tests", tone: "warn" },
  request: { text: "in review", tone: "ok" },
  failed: { text: "failed", tone: "error" },
  skipped: { text: "skipped", tone: "neutral" },
  local: { text: "kept on this machine", tone: "neutral" },
};

/** A task in a folder of several repositories: its targets are the folder's own repositories, which have no page of their own. */
const inFolder = (task: Pick<TaskRecord, "repoId" | "targets">) => Boolean(task.targets?.length) && task.targets!.every((t) => t.repoId === task.repoId || t.repoId.startsWith(`${task.repoId}--`));

/** What a task in a folder changed, a repository at a time under its name: where its work lands, then the change itself. */
function FolderChanges({ task, local, starter, onChanged, onQuote }: { task: TaskRecord; local: boolean; starter: boolean; onChanged: () => void; onQuote?: (quote: Quote) => void }) {
  const changed = (task.targets ?? []).filter((t) => t.status === "request" || t.status === "failed" || t.status === "local");
  // One filled Keep at most: while several repositories wait for an answer, each one's Keep is secondary.
  const waiting = changed.filter((t) => t.request?.status === "open").length;
  return (
    <section className="section" aria-labelledby="task-folder-h">
      <h2 id="task-folder-h">Changes</h2>
      {changed.map((t) => (
        <section key={`${t.repoId}:${t.path ?? ""}`} className="repo-group" aria-label={shownName(t)}>
          <h3 className="mono">{shownName(t)}</h3>
          {t.request ? (
            <>
              {local ? null : <p className="muted">Its work reaches {t.name} only through a review, which a person merges.</p>}
              {local ? null : <p>{changeSaid(t.forge, t.request.number, t.request.status)}</p>}
              {local && t.request.status === "open" ? <LocalRequestGroup repoId={t.repoId} number={t.request.number} starter={starter} only={waiting === 1} onAnswered={onChanged} /> : null}
              <RequestDiff reads={requestReads(t.repoId, t.request.number)} bare {...(onQuote ? { onQuote } : {})} />
            </>
          ) : t.status === "local" && t.branch ? (
            <>
              <p className="muted">{keptLocally(t.reason, t.branch, task.ranOn ?? null)}</p>
              {t.reason === "unpushed" && t.forge && starter
                ? <OpenKept taskId={task.id} position={task.targets!.indexOf(t)} forge={t.forge} onOpened={onChanged} />
                : <CopyText text={`git switch ${t.branch}`} label="Copy the command" />}
            </>
          ) : null}
          {t.error ? <p className="error">{t.error}</p> : null}
        </section>
      ))}
    </section>
  );
}

/** One repository's change in a folder task on one person's own orchestrator: where it reaches, then its answers in one line, kept into their checkout, discarded, or opened on its forge. */
function LocalRequestGroup({ repoId, number, starter, only, onAnswered }: { repoId: string; number: number; starter: boolean; only: boolean; onAnswered: () => void }) {
  const reach = useForgeReach(repoId, number);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const answer = (action: "merge" | "close") => api.requestAction(repoId, number, action).then(onAnswered);
  const keep = () => {
    setBusy(true);
    setRefused(null);
    answer("merge").catch((e: Error) => setRefused(e.message)).finally(() => setBusy(false));
  };
  const merge = refused ? mergeCommand(refused) : null;
  return (
    <>
      {reach.line}
      {starter || reach.action ? (
        <div className="actions">
          {starter ? (
            <>
              <button type="button" className={only ? undefined : "secondary"} disabled={busy} onClick={keep}>Keep these changes</button>
              <ConfirmAction trigger="Discard these changes…" consequence="The task's branch is dropped; your checkout does not change." confirm="Discard changes" keep="Keep them for now" onConfirm={() => answer("close")} />
            </>
          ) : null}
          {reach.action}
        </div>
      ) : null}
      {refused ? <p className="error" role="alert">{merge ? <>{merge.said}: <CopyText text={merge.command} /></> : refused}</p> : null}
      {reach.refusal}
    </>
  );
}

/** A change a machine kept on its branch, pushed and opened as a request on its forge when its starter asks; the machine answers why when it cannot. */
function OpenKept({ taskId, position, forge, onOpened }: { taskId: string; position: number; forge: "gitlab" | "github"; onOpened: () => void }) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const noun = FORGE[forge].noun;
  const open = () => {
    setBusy(true);
    setRefused(null);
    tasksApi.openKept(taskId, position).then(onOpened, (e: Error) => setRefused(e.message)).finally(() => setBusy(false));
  };
  return (
    <>
      <div className="actions"><button type="button" className="secondary" disabled={busy} onClick={open}>{busy ? `Opening a ${noun}…` : `Open a ${noun}`}</button></div>
      {refused ? <p className="error" role="alert">{refused}</p> : null}
    </>
  );
}

/** A repository of a folder by where it is in it; the folder itself, and a repository named by its request, by the name it has. */
const shownName = (t: TaskTarget) => (t.status === "local" && t.path ? t.path : t.name);

/** Where a change a machine kept stays, and why it came no further. */
function keptLocally(reason: string, branch: string, machine: string | null): string {
  const there = `on the branch ${branch} in this repository${machine ? ` on ${machine}` : ""}`;
  if (reason === "no-remote") return `With no remote to push to, its change stays ${there}.`;
  if (reason === "not-connected") return `Its remote is not one of this organization's connected repositories, so its change stays ${there}.`;
  return `Nothing is pushed to its remote yet, so its change stays ${there}.`;
}

/** One card per repository a task over several changes, in the order they run, as the task's stream updates them. */
export function TargetCards({ task }: { task: TaskRecord }) {
  const targets = task.targets ?? [];
  return (
    <section className="section" aria-labelledby="task-targets-h">
      <h2 id="task-targets-h">Repositories <span className="count">{targets.length || ""}</span></h2>
      {!targets.length ? (
        <p className="muted" role="status">{ACTIVE.includes(task.status) ? "Planning which repositories the change needs…" : "No repository was planned."}</p>
      ) : (
        <ol className="target-cards">
          {targets.map((t, i) => (
            <li key={t.repoId} className="target-card" aria-label={`${t.name}, ${TARGET_STATUS[t.status].text}`}>
              <div className="card-head">
                <h3><span className="muted">{i + 1}.</span> <a href={here("repositories", t.repoId)}>{t.name}</a></h3>
                <span className={`badge ${TARGET_STATUS[t.status].tone}`}>{TARGET_STATUS[t.status].text}</span>
              </div>
              <p className="muted">{t.reason}</p>
              <dl className="facts">
                <div><dt>Tests</dt><dd>{t.tests ?? (ACTIVE.includes(task.status) ? "not run yet" : "none ran")}</dd></div>
                <div><dt>Change</dt><dd>{t.request ? (t.request.url.startsWith("http") ? <><a href={t.request.url} target="_blank" rel="noopener noreferrer">{t.forge ? forgeRequestName(t.forge, t.request.number) : "See it on the forge"}</a><span className="muted">, {REQUEST_STATUS_TEXT[t.request.status]}</span></> : REQUEST_STATUS_TEXT[t.request.status]) : "none yet"}</dd></div>
              </dl>
              {t.error ? <p className="error">{t.error}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const REQUEST_STATUS_TEXT: Record<RequestStatus, string> = { open: "in review", merged: "merged", closed: "closed" };

/** The repositories a task changes, as the task list names them. */
export function targetNames(task: Pick<TaskRecord, "repoId" | "targets">): string {
  if (!task.targets) return task.repoId;
  if (!task.targets.length) return "planning…";
  return task.targets.map((t) => t.name).join(", ");
}

// The sections of Tasks, by whose move it is; Waiting for a computer only where tasks run on people's machines, since it fills nowhere else.
const TURNS: { id: Turn; name: string; why: string; empty: string }[] = [
  { id: "yours", name: "Your turn", why: "Each one waits for you to read, answer or continue it.", empty: "Nothing waits on you. A task lands here when its change is ready or its agent asks you something." },
  { id: "agents", name: "The agents' turn", why: "Running or in line; nothing to do yet.", empty: "No agent is at work. A task you start runs here until it needs you." },
  { id: "done", name: "Done this week", why: "Kept, undone or failed. A failed task says why on its page.", empty: "Nothing has finished this week." },
  { id: "waiting", name: "Waiting for a computer", why: "Each starts by itself when its computer is back.", empty: "No task waits for a computer. A task started while its computer sleeps lands here." },
];

/** One section's rows: the state, the title with where and by whom under it, the change's weight, then time and cost. */
function BoardRows({ cards, me, agents }: { cards: BoardCard[]; me: Principal; agents: TaskOptions["agents"] | null }) {
  const seen = readSeen();
  return (
    <table className="row-cards turn-rows">
      <tbody>
        {cards.map((c) => {
          const state = cardState(c);
          const unread = cardUnread(c, seen);
          // A card from an orchestrator that does not name the agent yet leaves it out rather than calling it retired.
          const agent = agents && c.agent ? agents.find((a) => a.id === c.agent)?.label ?? RETIRED_AGENT : null;
          const meta = [c.repoId, agent, `started by ${c.createdBy === me.email ? "you" : c.createdBy}`].filter(Boolean).join(", ");
          return (
            <tr key={c.id} onClick={() => navigate(here("tasks", c.id))}>
              <td className="rc-status"><span className={`state ${state.tone}`}>{state.label}</span></td>
              <td className="rc-title">
                <a className="row-link" href={here("tasks", c.id)} dir="auto">{unread ? <strong>{c.title}</strong> : c.title}</a>
                {unread ? <span className="visually-hidden"> (new)</span> : null}
                {c.issueKey ? <> <span className="muted mono">{c.issueKey}</span></> : null}
                {c.reason && (c.next === "retry" || c.next === "continue") ? <div className="small" dir="auto"><span className="error">{c.reason}</span> <a href={here("tasks", c.id)}>{c.next === "retry" ? "Run again" : "Continue"}</a></div> : null}
                <div className="muted small" dir="auto">{meta}</div>
              </td>
              <td className="rc-extra rc-weight">{c.changes ? <><ChangeWeight added={c.changes.additions} removed={c.changes.deletions} /> <span className="diff-stat"><ChangeCounts added={c.changes.additions} removed={c.changes.deletions} /></span></> : null}</td>
              <td className="rc-extra num">{c.startedAt ? (c.finishedAt ? duration(c) : `${duration(c)} so far`) : null}</td>
              <td className="rc-extra num">{c.cost.usd !== null ? `$${c.cost.usd.toFixed(2)}` : c.startedAt && c.finishedAt ? <span className="muted">not reported</span> : null}</td>
              <td className="rc-extra num">{whenShort(c.finishedAt ?? c.createdAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Every task the person reads, newest first and a page at a time, folded at the foot of Tasks: the
 * sections above hold this week and what waits, and an older task is still found here. Read only
 * once it is opened.
 */
function AllTasks({ me, agents, picked = null }: { me: Principal; agents: TaskOptions["agents"] | null; picked?: string | null }) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const read = (from: string | null) => {
    setBusy(true);
    tasksApi.page(from).then((page) => {
      // An older page adds what the ones before did not have; the first page is the list.
      setTasks((had) => (from && had ? [...had, ...page.tasks.filter((t) => !had.some((h) => h.id === t.id))] : page.tasks));
      setNext(page.next);
      setError(null);
    }, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  useEffect(() => {
    if (open && !tasks) read(null);
  }, [open]);
  // The rail's repository narrows the fold too, a task over several repositories counted in each.
  const inPicked = (t: TaskRecord) => !picked || t.repoId === picked || (Array.isArray(t.targets) && t.targets.some((x) => x.repoId === picked));
  const rows = (tasks ? taskRows(tasks.filter(inPicked), me.email, readSeen(), "all") : []).map((r) => ({ ...r, wait: machineWait(r.task, me) }));
  const costed = rows.some(({ task: t }) => t.cost.usd !== null || t.cost.inputTokens !== null || t.cost.outputTokens !== null);
  return (
    <details className="section log-fold" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>All tasks {tasks ? <span className="count">{`${tasks.length}${next ? "+" : ""}`}</span> : null}</summary>
      {error ? <LoadFailed what="tasks" reason={error} onRetry={() => read(null)} /> : !tasks ? (open ? <Loading what="tasks" /> : null) : !rows.length ? <p className="muted">No task has run yet.</p> : (
        <table className="row-cards">
          <thead><tr><th>Task</th><th>Project</th><th>Agent</th><th>Status</th><th className="num">Duration</th>{costed ? <th className="num">Cost</th> : null}</tr></thead>
          <tbody>
            {rows.map(({ task: t, call, unread, wait }) => (
              <tr key={t.id} onClick={() => navigate(here("tasks", t.id))}>
                <td className="rc-title"><a className="row-link" href={here("tasks", t.id)} dir="auto">{unread ? <strong>{t.title}</strong> : t.title}</a>{unread ? <span className="visually-hidden"> (new)</span> : null}{t.sharedWith?.includes(me.id) && t.createdBy !== me.email ? <span className="muted small"> shared with you</span> : null}{t.issueKey ? <> <span className="muted mono">{t.issueKey}</span></> : null}</td>
                <td className="mono rc-meta">{targetNames(t)}</td>
                <td className="rc-meta"><AgentName id={t.agent} known={agents} /></td>
                <td className="rc-status">{call ? <span className={`state ${ATTENTION[call].tone}`}>{ATTENTION[call].label}</span> : wait ? <><span className="state warn">{wait.badge}</span> <a href={here("settings", "machines")} onClick={(e) => e.stopPropagation()}>{wait.link}</a></> : <StatusBadge task={t} />}</td>
                <td className="rc-extra num">{t.startedAt ? duration(t) : null}</td>
                {costed ? <td className="rc-extra num">{cost(t) === "unknown" ? null : cost(t)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next ? <button type="button" className="secondary" onClick={() => read(next)} disabled={busy}>{busy ? "Loading older tasks…" : "Show older tasks"}</button> : null}
    </details>
  );
}

const lowerFirst = (line: string) => `${line.charAt(0).toLowerCase()}${line.slice(1)}`;

/** `picked`: the repository the list is narrowed to; `repos` names the ones to narrow to, and `onRepos` reads them again. */
export function TaskList({ me, start, repos = null, picked = null, onRepos }: { me: Principal; start?: TaskStart; repos?: RepoRecord[] | null; picked?: string | null; onRepos?: () => Promise<unknown> }) {
  const [options, setOptions] = useState<TaskOptions | null>(null);
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  // A budget read that fails leaves the form as it was: the server still refuses a task over budget.
  const [budgets, setBudgets] = useState<CurrentBudgets | null>(null);
  const readBudgets = () => tasksApi.budgets().then(setBudgets, () => setBudgets(null)).finally(() => setRailRead((n) => n + 1));
  const [limits, setLimits] = useState<TaskLimits | null>(null);
  // The form's rail says what a task stops at; the form waits for it, so the list below does not move when it arrives.
  const [railRead, setRailRead] = useState(0);
  const [lastRepo, setLastRepo] = useState<string | null>(null);
  const [welcome, setWelcome] = useState<"open" | "left" | null>(null);
  // A repository removed from its settings comes back here to be told so.
  const removed = new URLSearchParams(window.location.search).get("removed");
  const [notice, setNotice] = useState<string | null>(removed ? `${removed} is removed.` : null);
  useEffect(() => {
    if (removed) void onRepos?.();
  }, [removed]);
  useEffect(() => {
    projectsRead.list().then((r) => setLastRepo(r.last), () => setLastRepo(null));
  }, []);
  const reload = () => boardApi.read(picked).then((read) => {
    setBoard(read);
    setError(null);
  }, (e: Error) => setError(e.message));
  // A later reload that fails keeps the form it already has; only a form that never loaded shows the failure.
  const loadOptions = () =>
    tasksApi.options().then(
      (loaded) => {
        setOptions(loaded);
        setOptionsError(null);
      },
      (e: Error) => setOptionsError(e.message),
    );
  useEffect(() => {
    loadOptions();
    readBudgets();
    taskLimitsApi.read().then(setLimits, () => setLimits(null)).finally(() => setRailRead((n) => n + 1));
  }, []);
  const repoKey = repos?.map((r) => r.id).join(",") ?? null;
  const optionsFor = useRef(repoKey);
  useEffect(() => {
    if (optionsFor.current !== null && optionsFor.current !== repoKey) loadOptions();
    optionsFor.current = repoKey;
  }, [repoKey]);
  useEffect(() => {
    reload();
  }, [picked]);
  // The first visit starts the agents' check; the form shows its findings once it has finished.
  useEffect(() => {
    if (!options?.agents.some((a) => !a.readiness)) return;
    const timer = setTimeout(loadOptions, 2000);
    return () => clearTimeout(timer);
  }, [options]);
  // While an agent works or a task waits for its computer, the board is read again so a row moves to its turn as it happens.
  useEffect(() => {
    if (!board || (!board.counts.agents && !board.counts.waiting)) return;
    const timer = setInterval(reload, 1500);
    return () => clearInterval(timer);
  }, [board]);
  // The rows wait for the agents' names as well, so no row is drawn without its agent and filled a moment later.
  const listed = Boolean(board && ((options && railRead >= 2) || optionsError));
  const empty = Boolean(board && TURNS.every((t) => !board.counts[t.id]));
  const turns = TURNS.filter((t) => t.id !== "waiting" || me.tasksRunHere === false);
  const shownRepos = repos ?? [];
  const pickedName = picked ? shownRepos.find((r) => r.id === picked)?.name ?? picked : null;
  const day = board ? daySentence(board) : null;
  // A narrowed list says whose day it is; a repository with nothing open says so rather than nothing.
  const daySaid = pickedName ? `In ${pickedName}, ${day ? lowerFirst(day) : "nothing waits on you and no agent is at work."}` : day;
  const local = me.mode === "local";
  // One filter at the head of the list: every repository, or one the tasks changed.
  // A team with several repositories can narrow the list to one; the filter only filters, and one person's folders have none.
  const configured = shownRepos.filter((r) => r.configured !== false);
  const list = (
    <>
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      {!local && repos !== null && !shownRepos.some((r) => r.configured !== false) ? (
        <div className="empty-state">
          <p className="empty-state-title">No repository is connected yet.</p>
          <p className="muted">{!manages(me) ? "An owner or an admin connects them." : <>Connect GitLab or GitHub and pick a repository in the <a href={here("welcome")}>welcome steps</a>.</>}</p>
        </div>
      ) : null}
      {/* The box stays at the top of the page whatever is on the board: what needs doing is the one thing the page is for. */}
      <section className="section" aria-labelledby="new-task-h">
        <h2 id="new-task-h" className={empty ? undefined : "visually-hidden"}>New task</h2>
        {/* A task over several projects is planned and run by the orchestrator, so where tasks run on people's machines the form offers one project. */}
        {options && railRead >= 2 ? (
          <NewTask key={options.repos.map((r) => r.id).join(",")} options={me.tasksRunHere === false ? { ...options, multiRepo: null } : options} budgets={budgets} limits={limits} {...(start ? { start } : {})} local={me.mode === "local"} approver={manages(me)} defaultRepo={picked ?? lastRepo} first={local && empty && !start} onStarted={(task) => navigate(here("tasks", task.id))} />
        ) : optionsError ? <LoadFailed what="the task form" reason={optionsError} onRetry={loadOptions} /> : <Loading what="the task form" />}
      </section>
      {listed && !(local && empty) && daySaid ? <p className="muted day-sentence" role="status">{daySaid}</p> : null}
      {listed && !local && (configured.length > 1 || picked) ? (
        <div className="list-filter">
          <Select label="Show tasks in" labelHidden value={picked ?? ""} onChange={(id) => navigate(id ? `${here("tasks")}?${new URLSearchParams({ repo: id })}` : here("tasks"))} options={[{ value: "", label: "All repositories" }, ...configured.map((r) => ({ value: r.id, label: r.name }))]} />
        </div>
      ) : null}
      {/* The columns are named once above every section, quietly; each section's rows hold the same widths. */}
      {listed && !empty ? (
        <div className="turn-columns" aria-hidden="true">
          <span />
          <table className="row-cards turn-rows">
            <thead><tr><th className="rc-status" /><th className="rc-title" /><th className="rc-weight">Changes</th><th className="rc-extra num">Ran</th><th className="rc-extra num">Cost</th><th className="rc-extra num">When</th></tr></thead>
          </table>
        </div>
      ) : null}
      {/* A refresh that fails keeps the rows last read under the line that says so. */}
      {error && board ? <RefreshFailed what="tasks" reason={error} onRetry={reload} /> : null}
      {error && !board ? <LoadFailed what="tasks" reason={error} onRetry={reload} /> : !listed ? ((options && railRead >= 2) || optionsError ? <Loading what="tasks" /> : null) : empty ? null : (
        turns.filter((t) => board!.counts[t.id] > 0).map((t) => {
          const cards = board!.sections[t.id];
          const more = board!.counts[t.id] - cards.length;
          return (
            <TurnSection key={t.id} name={t.name} count={board!.counts[t.id]} why={t.why} empty={t.empty}>
              <BoardRows cards={cards} me={me} agents={options?.agents ?? null} />
              {more > 0 ? <p className="muted small">{more} more; All tasks below holds them.</p> : null}
            </TurnSection>
          );
        })
      )}
      {(local && empty) || !((options && railRead >= 2) || optionsError) ? null : <AllTasks me={me} agents={options?.agents ?? null} picked={picked} />}
    </>
  );
  // With nothing to run in yet, Tasks is the first screen: the promise, then the one question, which folder or repository.
  // A self-hosted orchestrator has its repositories listed in its configuration file, so its empty state says that instead.
  // One person's own orchestrator asks for no folder: its first screen is the one box, and the orchestrator picks the folder from what the task asks.
  const nothingYet = !local && repos !== null && !shownRepos.some((r) => r.configured !== false);
  // A team with nothing connected opens its setup steps for whoever manages it, whoever runs the server.
  const welcomed = Boolean(me.runners && me.tasksRunHere === false) || manages(me);
  if (nothingYet && welcomed && welcome === null) setWelcome("open");
  if (welcome === "open") return <WelcomeView me={me} org={placeOf(window.location.pathname).org ?? ""} repos={repos ?? []} onRepos={onRepos ?? (() => Promise.resolve())} onFinished={() => setWelcome("left")} />;
  return (
    <div className="page">
      <PageHead
        title={local && empty ? PROMISE : "Tasks"}
      />
      {list}
    </div>
  );
}

/** The log lines that hold the words searched for, in the order they were written; case does not count. */
export function findLines(log: Pick<TaskLogLine, "seq" | "text">[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  return needle ? log.filter((l) => l.text.toLowerCase().includes(needle)).map((l) => l.seq) : [];
}

/** A line with each place the searched words occur marked. */
function marked(text: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase();
  if (!needle) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = text.toLowerCase().indexOf(needle); at !== -1; at = text.toLowerCase().indexOf(needle, from)) {
    parts.push(text.slice(from, at), <mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return parts;
}

/** Log lines on the page at once: a long run stays quick to scroll, and earlier lines are a press away. */
export const LOG_WINDOW = 1500;
// How near the bottom of the page counts as following the log as it runs.
const AT_END_PX = 48;
/** Where each task's page was scrolled to, for this tab's visit: coming back to a task lands where it was left. */
const scrolledTo = new Map<string, number>();

/** The first log line shown: the newest windows asked for, reaching back further to a line the find bar went to. */
export function windowStart(total: number, earlier: number, foundAt: number | null): number {
  const start = Math.max(0, total - LOG_WINDOW * (1 + earlier));
  return foundAt !== null && foundAt >= 0 && foundAt < start ? foundAt : start;
}

const atEnd = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - AT_END_PX;

/**
 * The task's log, with a find bar over the lines this page holds: Enter goes to the next match
 * and Shift+Enter to the one before, and the line found is scrolled to. While the task runs, a
 * reader at the end of the page stays there as lines arrive; one reading further up is told how
 * many arrived and taken to them when they ask.
 */
function TaskLog({ id, log, outputCut, live }: { id: string; log: TaskLogLine[]; outputCut: boolean; live: boolean }) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const [earlier, setEarlier] = useState(0);
  const [unseen, setUnseen] = useState(0);
  const following = useRef(false);
  const seenLength = useRef(0);
  const restored = useRef(false);
  const hits = findLines(log, query);
  const current = hits.length ? hits[Math.min(at, hits.length - 1)] : null;
  const from = windowStart(log.length, earlier, current === null ? null : log.findIndex((l) => l.seq === current));
  useEffect(() => {
    const onScroll = () => {
      following.current = atEnd();
      scrolledTo.set(id, window.scrollY);
      if (following.current) setUnseen(0);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [id]);
  useEffect(() => {
    const added = log.length - seenLength.current;
    seenLength.current = log.length;
    if (!log.length) return;
    if (!restored.current) {
      restored.current = true;
      const y = scrolledTo.get(id);
      if (y !== undefined) window.scrollTo(0, y);
      return;
    }
    if (!live || added <= 0) return;
    if (following.current) window.scrollTo(0, document.documentElement.scrollHeight);
    else setUnseen((n) => n + added);
  }, [log.length]);
  useEffect(() => {
    if (current !== null) document.getElementById(`log-line-${current}`)?.scrollIntoView({ block: "nearest" });
  }, [current]);
  const step = (by: number) => hits.length && setAt((Math.min(at, hits.length - 1) + by + hits.length) % hits.length);
  const toEnd = () => {
    setUnseen(0);
    following.current = true;
    window.scrollTo(0, document.documentElement.scrollHeight);
  };
  return (
    <>
      {outputCut ? <p className="muted" role="note">Part of the output was left out; the log marks where. <Hint label="what the log keeps">The log holds the start and the end of the agent's and the tests' output, and every line the orchestrator wrote.</Hint></p> : null}
      {log.length ? (
        <div className="log-find" role="search" aria-label="Find in the log">
          <label className="filter">
            Find in the log
            <input type="search" data-page-search value={query} onChange={(e) => {
              setQuery(e.target.value);
              setAt(0);
            }} onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            }} />
          </label>
          {query.trim() ? <span className="muted small" role="status">{hits.length ? `${hits.indexOf(current!) + 1} of ${hits.length}` : "No line matches."}</span> : null}
        </div>
      ) : null}
      {from > 0 ? <p><button type="button" className="secondary small" onClick={() => setEarlier(earlier + 1)}>Show earlier lines ({from})</button></p> : null}
      {/* The lines stay a list a screen reader reads at will; what changes is said once by the page's announcer,
          since a busy run's every line read out as it arrived drowned the one that mattered. */}
      <div role="log" aria-label="Task log" aria-live="off">
        <ol className={`task-log${live ? "" : " task-log-ended"}`}>
          {log.slice(from).map((line) => (
            <li key={line.seq} id={`log-line-${line.seq}`} aria-current={line.seq === current ? "true" : undefined}>
              <span className="muted mono">{logTime(line.at)}</span> <span dir="auto">{marked(line.text, query)}</span>
            </li>
          ))}
        </ol>
      </div>
      {log.length ? null : <p className="muted">{live ? "Nothing logged yet; lines show here as the agent writes them." : "Nothing was logged."}</p>}
      {unseen ? <button type="button" className="secondary small log-new" onClick={toEnd}>{unseen} new {unseen === 1 ? "line" : "lines"}</button> : null}
    </>
  );
}

export function TaskView({ id, me }: { id: string; me: Principal }) {
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [log, setLog] = useState<TaskLogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outputCut, setOutputCut] = useState(false);
  // What the page says when a read of a task it already shows fails: one line, the server's reason behind a hint.
  const [stale, setStale] = useState<{ line: string; reason: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [dropped, setDropped] = useState(0);
  // The agents' names and where this person may act come in one read the page waits for, so its header is drawn once, whole.
  const [offered, setOffered] = useState<{ editable: string[]; agents: TaskOptions["agents"] } | null>(null);
  const fallbackLabel = useAgentLabel(task?.agent ?? "");
  const [logPref, setLogPref] = usePref(LOG_OPEN_KEY);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const after = useRef(0);
  useEffect(() => {
    after.current = 0;
    setLog([]);
    setTask(null);
    setError(null);
    setStale(null);
    setOutputCut(false);
    setRefused(null);
    let stopped = false;
    let loaded = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () =>
      tasksApi.get(id, after.current).then(
        ({ task, log, outputCut, next }) => {
          if (stopped) return;
          loaded = true;
          failures = 0;
          setStale(null);
          setTask(task);
          if (outputCut) setOutputCut(true);
          if (log.length) {
            after.current = next ?? log[log.length - 1]!.seq;
            setLog((prev) => [...prev, ...log]);
          }
          // A long log comes a page at a time: the next page is read at once, a finished task's too.
          const more = next !== undefined && next !== null;
          if (more || ACTIVE.includes(task.status)) timer = setTimeout(poll, more ? 0 : 1000);
        },
        (e: Error) => {
          if (stopped) return;
          if (!loaded) return setError(e.message);
          // A page following a running task rides out a short break: it keeps what it has and
          // tries again, waiting twice as long each time up to 15 seconds.
          failures++;
          const wait = Math.min(15_000, 1000 * 2 ** failures);
          setStale({ line: `The task did not refresh; trying again in ${wait / 1000} s.`, reason: e.message });
          timer = setTimeout(poll, wait);
        },
      );
    // A stream carries the log as it is written; when one cannot open or is lost, or the task
    // has finished and the orchestrator closes it, the page asks as it always did.
    let source: EventSource | null = null;
    const follow = () => {
      if (typeof EventSource === "undefined") return poll();
      source = new EventSource(tasksApi.eventsUrl(id, after.current));
      source.addEventListener("task", (e) => {
        loaded = true;
        setStale(null);
        setTask(JSON.parse((e as MessageEvent<string>).data) as TaskRecord);
      });
      source.addEventListener("log", (e) => {
        const { log, outputCut } = JSON.parse((e as MessageEvent<string>).data) as { log: TaskLogLine[]; outputCut: boolean };
        if (outputCut) setOutputCut(true);
        if (!log.length) return;
        after.current = log[log.length - 1]!.seq;
        setLog((prev) => [...prev, ...log]);
      });
      source.onerror = () => {
        source?.close();
        source = null;
        if (!stopped) poll();
      };
    };
    follow();
    tasksApi.options().then((o) => setOffered({ editable: o.repos.map((r) => r.id), agents: o.agents }), () => setOffered({ editable: [], agents: [] }));
    return () => {
      stopped = true;
      source?.close();
      clearTimeout(timer);
    };
  }, [id, attempt]);
  const reread = () => tasksApi.get(id, after.current).then((r) => setTask(r.task), (e: Error) => setStale({ line: "The task did not refresh.", reason: e.message }));
  const review = useFolderReview({ task, mine: task?.createdBy === me.email, onChanged: () => void reread() });
  // The agent's events, drawn as a stream; read again only when the log grows, not on every render.
  // Paths in the run read short: from the task's folder, and from home as `~` outside it.
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    projectsRead.list().then((r) => setHome(r.home ?? null), () => setHome(null));
  }, []);
  const folder = task?.routing?.path ?? null;
  const run = useMemo(() => liveRun(log, { folder, home }), [log, folder, home]);
  // The run keeps its newest line in view until the person scrolls up; reaching the bottom again, by hand or by Jump to latest, picks it up.
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    const onScroll = () => setFollowing(window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 48);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (following && task && ACTIVE.includes(task.status)) window.scrollTo(0, document.documentElement.scrollHeight);
  }, [run.stream.length, Boolean(offered)]);
  const [sharing, setSharing] = useState(false);
  // What the project's checks showed, read once the task's run is over; none approved, none shown.
  const [checks, setChecks] = useState<{ repoId: string; verification: TaskVerification }[]>([]);
  const settled = task ? !ACTIVE.includes(task.status) : false;
  // A task sent to a folder has its checks from the start, so its first line can say them; any other task's are read once it ends.
  const routedHere = Boolean(task?.routing);
  useEffect(() => {
    if (!settled && !routedHere) return;
    verificationRead.task(id).then(setChecks, () => setChecks([]));
  }, [id, settled, routedHere, task?.finishedAt]);
  if (error) return <LoadFailed what="the task" reason={error} onRetry={() => setAttempt((n) => n + 1)} panel />;
  if (!task || !offered) return <Loading what="the task" panel />;
  const working = ACTIVE.includes(task.status);
  const agentLabel = offered.agents.find((a) => a.id === task.agent)?.label ?? fallbackLabel;
  const editable = offered.editable;
  const act = (run: () => Promise<unknown>) => {
    setBusy(true);
    setRefused(null);
    run().catch((e: Error) => setRefused(e.message)).finally(() => setBusy(false));
  };
  // The same inputs as a new task; this one keeps its record and log as they are.
  const again = () => act(() => tasksApi.start(againInput(task)).then((started) => navigate(here("tasks", started.id))));
  // A task that stopped with a plan nobody had answered goes on from that plan, which Run again would lose.
  const askedPlan = (task.requests ?? []).some((r) => r.kind === "plan" && r.status !== "answered" && Boolean(r.payload.plan));
  // A run from before plans came as cards left its plan only in its plan folder, which its stream shows being written.
  const filedPlan = askedPlan ? null : writtenPlan(run.stream);
  const heldPlan = ["interrupted", "failed", "cancelled"].includes(task.status) && (task.planToApprove === true || askedPlan || filedPlan !== null);
  const approveHeldPlan = () => act(() => tasksApi.continueWithPlan(task.id, filedPlan ?? undefined).then(() => setAttempt((n) => n + 1)));
  const request = task.request;
  const refresh = () =>
    act(() => api.requestAction(task.repoId, task.requestNumber!, "refresh").then((r) => request && setTask({ ...task, request: { ...request, status: r.status as typeof request.status } })));
  const canEdit = editable.includes(task.repoId);
  // Whoever started the task or edits its team shares it, as the server decides it (sharesTask): starting
  // tasks in a project is wider, since every member starts them on an open team. A teammate it is shared
  // with reads it and passes it on to nobody.
  const canShare = task.createdBy === me.email || task.createdBy === me.id || manages(me) || (me.role !== "viewer" && me.ownedTeams.includes(task.team));
  // Only the person who started the task follows it up, and only while the orchestrator takes one; a teammate reviewing it suggests one to them.
  const followUp = task.followUp && task.createdBy === me.email ? task.followUp : null;
  const suggestTo = !followUp && task.suggests ? task.startedBy?.name ?? "the person who started this task" : null;
  const quote = followUp || suggestTo ? (q: Quote) => setQuotes(addQuote(quotes, q)) : undefined;
  // Whoever started the task, an admin or the team's owner takes a file out of its open request once the agent is done; the changes are read again after.
  const drops = (task.createdBy === me.email || manages(me) || me.ownedTeams.includes(task.team)) && request?.status === "open" && !ACTIVE.includes(task.status);
  const drop = (path: string) => tasksApi.dropFromRequest(task.id, path).then(() => {
    setDropped((n) => n + 1);
    void reread();
  });
  const status = shownStatus(task);
  const state = stateOf(task);
  const stateWord = stateSaid(state, task.forge);
  const requestOpen = task.requestNumber !== null && !task.targets;
  // On one person's own orchestrator the request is its own copy's: the page answers it, keeping or discarding the change, and never names it.
  const ownCopy = me.mode === "local" && requestOpen && request?.provider === "local";
  const answer = (action: "merge" | "close") => api.requestAction(task.repoId, task.requestNumber!, action).then((r) => request && setTask({ ...task, request: { ...request, status: r.status as typeof request.status } }));
  // The log leads only while there is no change to read; once the person opens or folds it, that stays.
  // A change whose checks still fail says so in its head, in the server's one sentence.
  const failing = checks.map((c) => c.verification).find((v) => v.verdict === "broken" || v.verdict === "failing-before") ?? null;
  // A task that ended with nothing here to review leaves its run and log as the only things to read: a failed one opens its run and says how long it went, one in review opens its log, which says where its change is.
  const nothingHere = task.requestNumber === null && !task.changes?.files.length && !task.targets?.length;
  const stoppedBare = task.status === "failed" && nothingHere;
  // A run that stopped to ask something waits on its starter's answer: the card is the one thing to read, so no log opens by itself.
  const asking = Boolean(task.question && !task.question.answer && !working);
  // A run that wrote no event is read from its plain log.
  const live = run.stream.length > 0 || run.plan.length > 0 || Boolean(task.routing);
  // Where the task works heads its run on a person's own orchestrator; only its starter moves it, and only while it runs.
  const where = (moves: boolean) => (task.routing ? <TaskWhere task={task} routing={task.routing} canMove={moves && task.createdBy === me.email} checked={[...new Set(checks.flatMap((c) => c.verification.checks.map((k) => k.command)))]} onChecksOff={() => void verificationRead.task(id).then(setChecks, () => setChecks([]))} /> : null);
  const spent = run.costUsd ?? task.cost.usd;
  // The newest of the agent's own words, for the announcer while it works.
  const lastSaid = [...run.stream].reverse().find((l) => l.kind === "say")?.text ?? "";
  // The log leads only while there is no stream or change to read; once the person opens or folds it, that stays.
  // A closed Log is remembered for every task; an open one only for the task it was opened on.
  const logOpen = logPref === `open:${id}` || (logPref !== "closed" && !asking && ((!live && (working || task.status === "failed" || task.status === "interrupted")) || (task.status === "needs-review" && nothingHere)));
  // Stopping sits at the foot of the run, with the steer field when there is one, whenever the reader can stop the task.
  const stop = ACTIVE.includes(task.status) && canEdit ? (
    <ConfirmAction
      danger
      trigger="Stop…"
      consequence={task.status === "queued"
        ? "The task leaves the line before it starts. This cannot be undone; starting it again is a new task."
        : "The agent stops now; what it changed so far waits for your review."}
      confirm="Stop task"
      keep={task.status === "queued" ? "Keep it in line" : "Keep it running"}
      onConfirm={() => tasksApi.cancel(id).then(setTask)}
    />
  ) : null;
  const jump = working && live && !following ? <button type="button" className="run-jump secondary small" onClick={() => {
    setFollowing(true);
    window.scrollTo(0, document.documentElement.scrollHeight);
  }}>Jump to latest</button> : null;
  const facts = taskFacts(task, agentLabel, me, (at) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), task.routing ? homeRelative(task.routing.path, home) : null);
  return (
    <div className="page task-page">
      <Announcer message={`${stateWord.word}${asksNow(task) ? `; ${agentLabel || "the agent"} asks you` : ""}${working && lastSaid ? `. ${lastSaid}` : ""}`} />
      {/* The answers stay in view: the header holds the state and the one thing to do next. */}
      <PageHead
        sticky
        title={task.title}
        below={working && run.plan.length ? <RunPlan plan={run.plan} /> : null}
        {...(asking ? { summary: `The agent stopped to ask ${task.createdBy === me.email ? "you" : task.createdBy}.` } : working && task.startedAt && task.waitingFor ? (spent !== null ? { summary: `The agent has spent $${spent.toFixed(2)} so far.` } : {}) : working && task.startedAt ? { summary: <RunSummary task={task} spent={spent} /> } : failing ? { summary: <span className="error">{failing.reason}</span> } : status === "needs-review" ? { summary: reviewSummary(task) } : stoppedBare && task.startedAt ? { summary: `The agent stopped after ${duration(task)}${endReasonOf(task.error)}` } : {})}
        actions={(
          <>
            {review.actions}
            {ownCopy ? (request?.status === "open" && canEdit ? (
              <>
                {request.heldReason === undefined ? <button type="button" disabled={busy} onClick={() => act(() => answer("merge"))}>Keep these changes</button> : null}
                <ConfirmAction trigger="Discard these changes…" consequence="The task's branch is dropped; your checkout does not change." confirm="Discard changes" keep="Keep them for now" onConfirm={() => answer("close")} />
              </>
            ) : null) : requestOpen ? <a className={`button${task.status === "needs-review" ? "" : " secondary"}`} href={here("repositories", task.repoId, "requests")}>Open the request</a> : null}
            {heldPlan && canEdit && !asking ? <button type="button" onClick={approveHeldPlan} disabled={busy} title="The task goes on from the plan the agent made, which nobody had answered yet.">Approve the plan and continue</button> : null}
            {AGAIN.includes(task.status) && canEdit && !asking ? <button type="button" onClick={again} disabled={busy} title="Starts a new task with the same work, project, agent and options; this one stays as it is.">Run again</button> : null}
            {canShare && !sharing ? <button type="button" className="secondary" onClick={() => setSharing(true)}>Share…</button> : null}
          </>
        )}
      >
        <span className={`state ${stateWord.tone}`} data-status={state}>{stateWord.word}{task.queuePosition !== null ? `, #${task.queuePosition} in line` : ""}</span>
      </PageHead>
      {/* The change is the page; what was asked and how the run went sit beside it in the rail. */}
      <div className="with-rail">
        <div className="task-main">
          {stale ? <p className="error" role="status">{stale.line} <Hint label="why the task did not refresh">{stale.reason}</Hint></p> : null}
          {task.error && !(task.question && !task.question.answer) && !(stoppedBare && task.startedAt) ? (task.status === "needs-review" ? <p className="muted" role="note">{task.error}</p> : <p className="error" role="alert">{task.error}</p>) : null}
          <TaskQuestion task={task} mine={task.createdBy === me.email} agent={agentLabel} onAnswered={(next) => {
            setTask(next);
            setAttempt((n) => n + 1);
          }} />
          {refused ? <p className="error" role="alert">{mergeCommand(refused) ? <>{mergeCommand(refused)!.said}: <CopyText text={mergeCommand(refused)!.command} /></> : refused}</p> : null}
          <WaitingNote task={task} me={me} onContinued={() => setAttempt((n) => n + 1)} />
          <McpSignIn names={task.mcpNeedsSignIn ?? []} />
          {working && live ? <section className="section" aria-label="The agent at work"><LiveRun run={run} withPlan={false} first={where(true)} working={task.status === "running" && !task.waitingFor} /></section> : null}
          {/* A card waits where the agent stopped for it: right after what it did so far. */}
          <TaskRequests task={task} me={me} agent={agentLabel} onAnswered={reread} />
          {task.targets ? (inFolder(task) ? <FolderChanges task={task} local={me.mode === "local"} starter={task.createdBy === me.email} onChanged={() => void reread()} {...(quote ? { onQuote: quote } : {})} /> : <TargetCards task={task} />) : null}
          {review.section}
          {requestOpen ? (
            <section className="section" aria-labelledby="task-req-h">
              <h2 id="task-req-h">Changes</h2>
              {/* The request and where the forge has it are one statement: two lines held together, not two paragraphs. */}
              {ownCopy ? null : (
                <div className="request-state">
                  <p>{request ? changeSaid(task.forge, task.requestNumber!, request.status) : "The change was opened."}</p>
                  {request ? <ForgeState request={{ repoId: task.repoId, number: task.requestNumber!, status: request.status, provider: request.provider, ...(request.heldReason !== undefined ? { heldReason: request.heldReason } : {}) }} /> : null}
                </div>
              )}
              {request?.status === "open" && request.provider !== "local" && canEdit ? <p><button type="button" className="secondary small" onClick={refresh} disabled={busy}>Refresh from {request.provider}</button></p> : null}
              {me.mode === "local" && request?.status === "open" && request.provider === "local" ? <ForgeReach repoId={task.repoId} number={task.requestNumber!} /> : null}
              <RequestDiff key={`${task.id}:${dropped}`} reads={requestReads(task.repoId, task.requestNumber!)} bare {...(quote ? { onQuote: quote } : {})} {...(drops ? { onDrop: drop } : {})} ownCopy={ownCopy} />
            </section>
          ) : null}
          {/* While the agent waits on a card, the card's own words go to it: a second box at the foot only covered it. */}
          <TaskSuggestions task={task} me={me} onAnswered={(continued) => {
            // A suggestion continued with is a new turn when the task was in review; reading the task says which.
            if (continued && followUp === "continue") setAttempt((n) => n + 1);
            else void reread();
          }} />
          {followUp && !(followUp !== "continue" && asksNow(task)) ? (
            <TaskFollowUp task={task} kind={followUp} jump={jump} stop={stop} quotes={quotes} onQuotes={setQuotes} onSent={() => {
              // A continued run is a new turn on the same task, followed from its start; anything else reads where the task stands now.
              if (followUp === "continue") setAttempt((n) => n + 1);
              else void reread();
            }} />
          ) : suggestTo ? (
            <TaskFollowUp task={task} kind="suggest" suggestTo={suggestTo} quotes={quotes} onQuotes={setQuotes} onSent={() => void reread()} />
          ) : stop ? (
            <form className="run-steer" aria-label="Stop the task" onSubmit={(e) => e.preventDefault()}>{jump}{stop}</form>
          ) : null}
          {!working && live ? (
            <details className="section log-fold" open={stoppedBare && !asking}>
              <summary>How the agent got here</summary>
              <LiveRun run={run} first={where(false)} />
            </details>
          ) : null}
          <details className="section log-fold" open={logOpen} onToggle={(e) => {
            const now = (e.currentTarget as HTMLDetailsElement).open;
            if (now !== logOpen) setLogPref(now ? `open:${id}` : "closed");
          }}>
            <summary>Log {log.length ? <span className="count">{log.length}</span> : null}</summary>
            <TaskLog key={id} id={id} log={log} outputCut={outputCut} live={ACTIVE.includes(task.status)} />
          </details>
        </div>
        <aside className="rail" aria-label="About this task">
          {checks.some((c) => c.verification.checks.length) ? <TaskChecks checks={checks} machineOf={task.runner === "local" ? (task.createdBy === me.email ? "you" : task.createdBy) : null} /> : null}
          {task.description && task.description !== task.title ? (
            <section aria-labelledby="task-ask-h">
              <h2 id="task-ask-h">The ask</h2>
              <p className="pre" dir="auto">{task.description}</p>
            </section>
          ) : null}
          <section aria-labelledby="task-where-h">
            <h2 id="task-where-h">Where</h2>
            <Facts facts={facts.where} />
            {task.issueUrl?.startsWith("https://") ? <p>Works on <a href={task.issueUrl} target="_blank" rel="noopener noreferrer">{task.issueKey ?? task.issueUrl}</a>, read through {me.mode === "local" ? "your" : "the team's"} MCP servers.</p> : null}
          </section>
          {task.folderTrust === "unasked" && task.createdBy === me.email ? <FolderTrustLine task={task} onAnswered={reread} /> : null}
          <TaskShares task={task.id} canShare={canShare} manager={manages(me)} adding={sharing} onClose={() => setSharing(false)} />
          {working && run.changed.length ? (
            <section aria-labelledby="task-changed-h">
              <h2 id="task-changed-h">Changed so far</h2>
              <ul className="run-changed">
                {run.changed.map((f) => <li key={f.path}><span className="mono" dir="auto">{f.path}</span> <ChangeWeight added={f.additions} removed={f.deletions} /></li>)}
              </ul>
            </section>
          ) : null}
          <section aria-labelledby="task-run-h">
            <h2 id="task-run-h">Run</h2>
            <Facts facts={facts.run} />
          </section>
          {working ? null : <TaskLearned key={task.id} task={task.id} finishedAt={task.finishedAt} />}
        </aside>
      </div>
    </div>
  );
}

/**
 * The one question a folder of the person's own asks, once: may its next tasks load the folder's
 * own Claude Code settings. They stay off until the person says yes; a task already running keeps
 * what it started with.
 */
function FolderTrustLine({ task, onAnswered }: { task: TaskRecord; onAnswered: () => void }) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const answer = (trusted: boolean) => {
    setBusy(true);
    setRefused(null);
    projectsRead.trust(task.repoId, trusted).then(onAnswered, (e: Error) => setRefused(e.message)).finally(() => setBusy(false));
  };
  return (
    <section aria-labelledby="task-trust-h">
      <h2 id="task-trust-h">This folder's settings</h2>
      <p>Use this folder's own Claude Code settings for the next tasks here? <Hint label="the folder's own settings">They can run programs and change where the model is reached. This task runs without them.</Hint></p>
      <div className="actions">
        <button type="button" className="secondary small" disabled={busy} onClick={() => answer(true)}>Use them</button>
        <button type="button" className="ghost small" disabled={busy} onClick={() => answer(false)}>Keep them off</button>
      </div>
      {refused ? <p className="error" role="alert">{refused}</p> : null}
    </section>
  );
}

/** Where a finished task stands while its change waits on the person: how long it took and what it changed. */
export function reviewSummary(task: Pick<TaskRecord, "startedAt" | "finishedAt" | "changes" | "targets" | "ranOn">): string {
  const took = task.startedAt && task.finishedAt ? ` in ${duration(task)}` : "";
  const changed = (task.targets ?? []).filter((t) => t.status === "request" || t.status === "failed" || t.status === "local");
  if (changed.length && changed.every((t) => t.status === "local")) {
    const on = task.ranOn ? ` on ${task.ranOn}` : "";
    return `The agent finished${took}, changing ${listed(changed.map(shownName))}; ${changed.length === 1 ? `the change stays on its branch${on}` : `the changes stay on their branches${on}`}.`;
  }
  if (changed.length) return `The agent finished${took}, changing ${listed(changed.map(shownName))}; ${changed.length === 1 ? "the change waits" : "each change waits"} for your review.`;
  const files = task.changes?.files.length ?? 0;
  return `The agent finished${took}${files ? `, changing ${files} ${files === 1 ? "file" : "files"}` : ""}; the change waits for your review.`;
}

const listed = (names: string[]) => (names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * The rail's first section once a run is over: each command the project is checked with, a line
 * each with how it stood before and after the agent's work, its output behind a fold.
 */
function TaskChecks({ checks, machineOf }: { checks: { repoId: string; verification: TaskVerification }[]; machineOf: string | null }) {
  const many = checks.length > 1;
  // A machine's verdicts are its exit codes as the orchestrator read them, said as the request says it.
  const ran = machineOf !== null && checks.some((c) => c.verification.verdict !== "not-run");
  return (
    <section aria-labelledby="task-checks-h">
      <h2 id="task-checks-h">Checks</h2>
      {ran ? <p className="muted small">These checks ran on {machineOf === "you" ? "your" : `${machineOf}'s`} machine, not on the orchestrator.</p> : null}
      <ul className="plain run-checks">
        {checks.flatMap(({ repoId, verification }) => verification.checks.map((c) => {
          const last = c.after.at(-1) ?? c.before;
          return (
            <li key={`${repoId}:${c.command}`} className={stillFails(c) ? "error" : undefined}>
              <details>
                <summary><span className="mono">{c.command}</span>{many ? <span className="muted"> in {repoId}</span> : null} {checkWords(c)}</summary>
                {last?.output ? <pre className="pre mono">{last.cut ? `${last.cut} lines left out\n` : ""}{last.output}</pre> : <p className="muted small">No output.</p>}
              </details>
            </li>
          );
        }))}
      </ul>
    </section>
  );
}

/** A running task's time and cost, counting once a second on its own so the page around it stays still. */
function RunSummary({ task, spent }: { task: TaskRecord; spent: number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>The agent has worked {duration(task)}{spent !== null ? `; $${spent.toFixed(2)} so far` : ""}.</>;
}

function Facts({ facts }: { facts: TaskFact[] }) {
  return <dl>{facts.map((f) => <Fragment key={f.term}><dt>{f.term}</dt><dd dir="auto">{f.value}</dd></Fragment>)}</dl>;
}
