import { useEffect, useState } from "react";
import { api, call, manages, tasksApi } from "../api";
import type { ActivitySummary, Onboarding, Principal, RepoRecord, RequestRecord, TaskOptions } from "../api";
import { cloudSteps, soloSteps, ownForge } from "../setup-steps";
import type { Step } from "../setup-steps";
import { PageHead } from "../design/PageHead";
import { TurnSection } from "../design/TurnSection";
import { connectedForge, useForgeConnections } from "../forge-connection";
import { Markdown } from "../Markdown";
import { InviteForm, MembersSections, useMembers } from "../settings/Members";
import type { PeopleOutcomes as PeopleAnswer, PersonOutcomes } from "../../../shared/activity";
import { here, navigate } from "../router";
import { Loading } from "../Status";
import { CopyText } from "../Confirm";
import { HandbookRail, HandbookSection, pickKey } from "./Handbook";
import type { HandbookPick, Proposed } from "./Handbook";
import { lessonsApi, skillText } from "../TaskLearned";
import type { TaskLessonRow } from "../TaskLearned";
import { ControlsView, PoliciesSection } from "../controls/Controls";
import "./team.css";

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** What the team's repositories share, by name, each with the repository it comes from and the tasks it was started with. */
export interface Shared { skills: { name: string; repo: string; tasks: number | null }[]; mcpServers: { name: string; repo: string; tasks: number | null }[] }

/** A team repository's setup that is wrong, in the finding's own words; `fix` names the one action that puts it right. */
export interface SetupProblem { repoId: string; repoName: string; team: string; title: string; detail: string | null; next: string | null; fix: "refresh" | null }

/**
 * Where the team stands, said once at the top of Team: who is in it, what it shares and what waits
 * for review. A part not read yet is left out rather than guessed; one person's page has no people.
 */
export function teamSentence({ people, shared, lessons }: { people: number | null; shared: Shared | null; lessons: number | null }): string {
  const parts = [
    people === null ? "" : count(people, "person", "people"),
    shared === null ? "" : shared.skills.length || shared.mcpServers.length ? `${count(shared.skills.length, "skill", "skills")} and ${count(shared.mcpServers.length, "MCP server", "MCP servers")} shared` : "nothing shared yet",
    lessons ? `${count(lessons, "lesson waits", "lessons wait")} for review` : "",
  ].filter(Boolean);
  const text = parts.join("; ");
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}.` : "";
}

/** The steps that set a team up: its forge and repository, its people, their join command and a first task. Proposing and merging are using it, not setting it up. */
const SETUP = new Set(["forge", "repo", "members", "join", "start", "task"]);

/** The setup steps still open, the next one first: a required step before an optional one, and a step left for later after both. */
export function openSteps(steps: Step[], skipped: readonly string[]): Step[] {
  const left = steps.filter((s) => !s.done && SETUP.has(s.id));
  const rank = (s: Step) => (skipped.includes(s.id) ? 2 : s.required ? 0 : 1);
  return [...left].sort((a, b) => rank(a) - rank(b));
}

/** A person's last 30 days in one cell: what they kept, undid and merged and what their tasks cost, each only when there is something to say. */
export function outcomesCell(p: PersonOutcomes | undefined): string {
  if (!p || !p.tasks) return "no task";
  const unknown = p.unknownCost ? `${count(p.unknownCost, "task", "tasks")} with no cost` : "";
  const cost = p.usd > 0 ? `$${p.usd.toFixed(2)}${unknown ? ` and ${unknown}` : ""}` : unknown;
  const parts = [p.kept ? `${p.kept} kept` : "", p.undone ? `${p.undone} undone` : "", p.merged ? `${p.merged} merged` : "", cost].filter(Boolean);
  return parts.length ? parts.join(", ") : `${count(p.tasks, "task", "tasks")}, none kept or merged yet`;
}

function useOutcomes(enabled: boolean): Map<string, PersonOutcomes> | null {
  const [byEmail, setByEmail] = useState<Map<string, PersonOutcomes> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    call<PeopleAnswer>("GET", "/api/analytics/people?days=30").then((r) => setByEmail(new Map(r.people.map((p) => [p.email, p]))), () => setByEmail(new Map()));
  }, [enabled]);
  return byEmail;
}

type SharedAnswer = { skills: { name: string; slug: string; repoName: string; tasks: number | null }[]; mcpServers: { name: string; repoName: string; tasks: number | null }[] };

/** What the team shares, read in one answer; one that fails reads as nothing shared rather than a page that waits. */
function useShared(): Shared | null {
  const [shared, setShared] = useState<Shared | null>(null);
  useEffect(() => {
    call<SharedAnswer>("GET", "/api/team/shared?days=30").then(
      (r) => setShared({ skills: r.skills.map((x) => ({ name: x.name || x.slug, repo: x.repoName, tasks: x.tasks })), mcpServers: r.mcpServers.map((x) => ({ name: x.name, repo: x.repoName, tasks: x.tasks })) }),
      () => setShared({ skills: [], mcpServers: [] }),
    );
  }, []);
  return shared;
}

function useSetupProblems(): SetupProblem[] {
  const [problems, setProblems] = useState<SetupProblem[]>([]);
  useEffect(() => {
    call<{ problems: SetupProblem[] }>("GET", "/api/team/setup").then((r) => setProblems(r.problems), () => setProblems([]));
  }, []);
  return problems;
}

/** One setup problem, said once under the head with the one action that fixes it, or what to do where no button does. */
function SetupProblemLine({ problem }: { problem: SetupProblem }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    setBusy(true);
    setError(null);
    tasksApi.start({ title: "", description: "", issueUrl: "", repoId: problem.repoId, agent: "", template: { kind: "scaffold.refresh", commitVersioning: false } })
      .then((task) => navigate(here("tasks", task.id)), (e: Error) => {
        setError(e.message);
        setBusy(false);
      });
  };
  return (
    <div className="setup-problem" role="status">
      <p><span className="state warn">{problem.repoName}</span> {problem.title}{problem.next && !problem.fix ? ` ${problem.next}` : ""}</p>
      {problem.fix === "refresh" ? <button type="button" className="secondary" disabled={busy} onClick={refresh}>Update TeamHandbook's files</button> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </div>
  );
}

/** A lesson still waiting for its person: pending in the orchestrator's own queue, or sent to one of their machines and not decided there. */
export const waiting = (l: Pick<TaskLessonRow, "status">) => l.status === "pending" || l.status === "sent";

/** The person's own lessons, on either kind of orchestrator; an answer that is no list hides the section rather than showing it empty. */
function useLessons(): [TaskLessonRow[] | null, () => void] {
  const [lessons, setLessons] = useState<TaskLessonRow[] | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    call<{ candidates: TaskLessonRow[] }>("GET", "/api/lessons").then((r) => setLessons(r.candidates.filter(waiting)), () => setLessons(null));
  }, [round]);
  return [lessons, () => setRound((n) => n + 1)];
}

/** The setup still open: the next step with its one action, the rest by name. With nothing left the section is not drawn. */
function SettingUp({ steps, skipped }: { steps: Step[]; skipped: readonly string[] }) {
  const [next, ...rest] = steps;
  const mark = (s: Step) => <span className="muted">{skipped.includes(s.id) ? "skipped" : s.required ? "" : "(optional)"}</span>;
  return (
    <TurnSection name="Getting set up" count={steps.length} why="What is left before the team works here; each step goes once it is done." empty="">
      {next ? (
        <div className="setting-up-next">
          <p><strong>{next.title}</strong> {mark(next)}</p>
          <p className="muted">{next.detail}</p>
          <div className="actions"><a className="button secondary" href={next.to}>{next.action}</a></div>
        </div>
      ) : null}
      {rest.length ? <ul className="team-rows">{rest.map((s) => <li key={s.id}>{s.title} {mark(s)}</li>)}</ul> : null}
    </TurnSection>
  );
}

/** Whoever does not manage the members reads each person's last 30 days as a row of its own, over the tasks they can see. */
function PersonTasks({ people }: { people: PersonOutcomes[] }) {
  if (!people.length) return null;
  return (
    <TurnSection name="Tasks by person" count={people.length} why="Every repository, the last 30 days." empty="No task was started in the last 30 days; each person's tasks and how they ended land here.">
      <ul className="team-rows">{people.map((p) => <li key={p.email}>{p.name ?? p.email} <span className="muted">{outcomesCell(p)}</span></li>)}</ul>
    </TurnSection>
  );
}

function Lessons({ lessons, picked, onPick }: { lessons: TaskLessonRow[]; picked: string | null; onPick: (lesson: TaskLessonRow) => void }) {
  if (!lessons.length) return null;
  return (
    <TurnSection name="Lessons to review" count={lessons.length} why="What a task taught, offered as a skill; keep it and every later task loads it." empty="No lesson waits. A task you correct or finish leaves its lesson here.">
      <ul className="team-rows">
        {lessons.map((l) => (
          <li key={l.slug} className={l.slug === picked ? "picked" : undefined}>
            <button type="button" className="row-pick" aria-pressed={l.slug === picked} onClick={() => onPick(l)}><span className="mono">{l.slug}</span></button>
            {l.description ? <span className="muted"> {l.description}</span> : null}
            {l.status === "sent" && l.machine ? <span className="muted"> waits on {l.machine}</span> : null}
          </li>
        ))}
      </ul>
    </TurnSection>
  );
}

/** The picked lesson in the rail: what the person said it comes from, the skill's text, and the decision. */
function LessonRail({ task, slug, onDecided }: { task: string; slug: string; onDecided: () => void }) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof lessonsApi.read>> | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [never, setNever] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDetail(null);
    setFailed(null);
    lessonsApi.read(task, slug).then(setDetail, (e: Error) => setFailed(e.message));
  }, [task, slug]);
  const decide = (action: Promise<unknown>) => {
    setBusy(true);
    setFailed(null);
    action.then(onDecided, (e: Error) => setFailed(e.message)).finally(() => setBusy(false));
  };
  return (
    <section aria-labelledby="lesson-h">
      <h2 id="lesson-h" className="mono">{slug}</h2>
      {failed ? <p className="error" role="alert">{failed}</p> : !detail ? <Loading what="the lesson" /> : (
        <>
          {detail.quote ? <p dir="auto">You said: “{detail.quote}”</p> : null}
          <Markdown text={skillText(detail.skillMd)} />
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => decide(lessonsApi.keep(task, slug))}>Keep</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => decide(lessonsApi.reject(task, slug, never))}>Discard</button>
          </div>
          <label className="check"><input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} /> Never suggest it again</label>
        </>
      )}
    </section>
  );
}

type Personal = NonNullable<TaskOptions["agents"][number]["personal"]>;

/** What one person's own Claude Code starts a task with, read from it: their skills and commands, plugins, MCP servers and CLAUDE.md. */
function useLoaded(enabled: boolean): Personal | null {
  const [personal, setPersonal] = useState<Personal | null>(null);
  useEffect(() => {
    if (!enabled) return;
    tasksApi.options().then((o) => setPersonal(o.agents.find((a) => a.id === "claude-code")?.personal ?? null), () => setPersonal(null));
  }, [enabled]);
  return personal;
}

/** One person's own setup where no team repository exists yet: what their Claude Code loads in one sentence, the list folded, and the one way on, sharing it with a team. */
function YourSetup({ personal }: { personal: Personal | null }) {
  const [sharing, setSharing] = useState(false);
  const servers = personal?.mcpServers ?? [];
  const rows = !personal ? [] : [
    ...personal.commands.map((c) => ({ key: `c:${c.name}`, name: c.name, what: "skill or command" })),
    ...personal.plugins.map((p) => ({ key: `p:${p.name}`, name: p.name, what: p.enabled ? "plugin" : "plugin, turned off" })),
    ...servers.map((m) => ({ key: `m:${m.name}`, name: m.name, what: "MCP server" })),
    ...(personal.claudeMd ? [{ key: "claude-md", name: "CLAUDE.md", what: "your instructions" }] : []),
  ];
  const loads = [count(personal?.commands.length ?? 0, "skill", "skills"), count(servers.length, "MCP server", "MCP servers"), ...(personal?.claudeMd ? ["a CLAUDE.md"] : [])];
  const share = sharing ? (
    <span className="team-share">
      <span><strong>Start a team handbook</strong> <CopyText text="/handbook:init" /></span>
      <span><strong>Join a team handbook</strong> <CopyText text="/handbook:join" /></span>
      <span className="muted">Type one in Claude Code on this computer.</span>
    </span>
  ) : <button type="button" className="secondary" onClick={() => setSharing(true)}>Share with a team</button>;
  return (
    <TurnSection
      name="Team handbook"
      count={rows.length}
      why={rows.length ? `Your Claude Code loads ${loads.join(", ")}; tasks here use ${rows.length === 1 ? "it" : "them"}.` : "What your Claude Code loads shows here."}
      empty={<>Your Claude Code loads nothing of its own yet; a skill, plugin or MCP server you add there shows here. {share}</>}
    >
      <details className="team-fold">
        <summary>Show them</summary>
        <ul className="team-rows">{rows.map((r) => <li key={r.key}><span className="mono">{r.name}</span> <span className="muted">{r.what}, from your Claude Code</span></li>)}</ul>
      </details>
      <p>{share}</p>
    </TurnSection>
  );
}

/**
 * The team's page: how setting up stands while it is open, the lessons waiting for review, the
 * people and how their tasks ended, what the team shares by name, and its policies for whoever
 * sets them. One person's own orchestrator shows the same page without the people, and what its
 * Claude Code loads in their place.
 */
function TeamPage({ me, org, repos }: { me: Principal; org: string; repos: RepoRecord[] | null }) {
  const local = me.mode === "local";
  const managing = manages(me);
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [onboarding, setOnboarding] = useState<Onboarding | null>(null);
  const [picked, setPicked] = useState<{ kind: "lesson"; slug: string; task: string } | { kind: "invite" } | { kind: "handbook"; pick: HandbookPick } | null>(null);
  const [proposed, setProposed] = useState<Proposed>(new Map());
  const members = useMembers(me);
  const outcomes = useOutcomes(!local);
  const [forges] = useForgeConnections(!local && managing);
  const [lessons, readLessons] = useLessons();
  const shared = useShared();
  const problems = useSetupProblems();
  const loaded = useLoaded(local);
  useEffect(() => {
    api.summary().then(setSummary, () => setSummary(null));
    api.onboarding().then(setOnboarding, () => setOnboarding(null));
  }, []);
  const firstRepo = repos?.find((r) => r.configured !== false)?.id;
  const steps = summary && onboarding && managing
    ? onboarding.dismissed ? [] : openSteps(local ? soloSteps(org, summary, repos ?? [], ownForge([]), false) : cloudSteps(org, summary, firstRepo, connectedForge(forges) !== null), onboarding.skipped)
    : [];
  // Only a required step still open is listed; with none the section is not drawn.
  const settingUp = steps.some((s) => s.required) ? steps : [];
  const teamRepos = (repos ?? []).filter((r) => r.kind === "skills" && r.configured !== false);
  const sentence = teamSentence({ people: local ? null : members.users?.length ?? null, shared: local ? null : shared, lessons: lessons?.length ?? null });
  const invite = managing && !local ? <button type="button" onClick={() => setPicked({ kind: "invite" })}>Invite members</button> : null;
  return (
    <div className="page">
      <PageHead title="Team" {...(sentence ? { summary: sentence } : {})} {...(invite ? { actions: invite } : {})} />
      <div className={picked ? "with-rail" : undefined}>
        <div>
          {/* Setup still open is the page's empty state; a team that is set up and broke since sees what broke. */}
          {settingUp.length ? <SettingUp steps={settingUp} skipped={onboarding?.skipped ?? []} /> : null}
          {settingUp.length ? null : problems.map((pr) => <SetupProblemLine key={`${pr.repoId}:${pr.title}`} problem={pr} />)}
          {lessons ? <Lessons lessons={lessons} picked={picked?.kind === "lesson" ? picked.slug : null} onPick={(l) => setPicked({ kind: "lesson", slug: l.slug, task: l.taskId })} /> : null}
          {/* Whoever sees the members sees each one's last 30 days beside their role; anyone else, the tasks they see. */}
          {local ? null : managing ? <MembersSections me={me} data={members} hideEmpty extra={{ name: "Last 30 days", cell: (u) => outcomesCell(outcomes?.get(u.email)) }} /> : outcomes ? <PersonTasks people={[...outcomes.values()]} /> : <Loading what="tasks by person" />}
          {repos === null ? <Loading what="the team handbook" /> : teamRepos.length ? (
            <HandbookSection me={me} repos={repos} counts={shared ?? { skills: [], mcpServers: [] }} picked={picked?.kind === "handbook" ? picked.pick : null} proposed={proposed} onPick={(pick) => setPicked({ kind: "handbook", pick })} onProposed={(repoId, sent, request) => {
              const next = new Map(proposed);
              for (const name of sent.skills) next.set(pickKey(repoId, "skills", name), request);
              for (const name of sent.mcpServers) next.set(pickKey(repoId, "mcp", name), request);
              for (const name of sent.commands) next.set(pickKey(repoId, "commands", name), request);
              setProposed(next);
            }} />
          ) : local ? <YourSetup personal={loaded} /> : null}
          <PoliciesSection me={me} />
        </div>
        {picked ? (
          <aside className="rail" aria-label={picked.kind === "invite" ? "Invite members" : picked.kind === "handbook" ? "The picked row" : "The picked lesson"}>
            {picked.kind === "invite" ? (
              <InviteForm me={me} teams={members.teams} onSent={(sent, skipped) => { members.setSent({ sent, skipped }); members.reload(); setPicked(null); }} onCancel={() => setPicked(null)} />
            ) : picked.kind === "handbook" ? (
              <HandbookRail key={pickKey(picked.pick.repo.id, picked.pick.tab, picked.pick.name)} pick={picked.pick} onOpened={(request: RequestRecord) => {
                setProposed(new Map(proposed).set(pickKey(picked.pick.repo.id, picked.pick.tab, picked.pick.name), request));
                setPicked(null);
              }} />
            ) : (
              <LessonRail key={`${picked.task}/${picked.slug}`} task={picked.task} slug={picked.slug} onDecided={() => { setPicked(null); readLessons(); }} />
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/** The Team section: the page itself, or a policy's own page under policies/ (new, or one by its id). */
export function TeamView({ me, org, repos, page }: { me: Principal; org: string; repos: RepoRecord[] | null; page: string[] }) {
  if (page[0] === "policies" && page[1]) return <ControlsView me={me} page={page[1]} />;
  return <TeamPage me={me} org={org} repos={repos} />;
}
