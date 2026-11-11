import { useEffect, useRef, useState } from "react";
import { manages, NotFound } from "../api";
import type { Principal } from "../api";
import { here, navigate, useLocation } from "../router";
import { Select } from "../Select";
import { SubNav } from "../Shell";
import { Loading, LoadFailed, RefreshFailed } from "../Status";
import { PageHead } from "../design/PageHead";
import { workApi } from "./api";
import type { WorkBoard, WorkItem, WorkItems, WorkSource, WorkSprint } from "./api";
import { isMine, morningSummary, nextIssue, placeItems, sprintSummary, taskBadge } from "./board";
import { BoardTeam } from "./BoardTeam";
import { MovesSwitch } from "./Moves";
import { ArrangeColumns } from "./Columns";
import { MOST_AT_ONCE, StartAgents } from "./StartAgents";

/** How often the board asks again: task links are joined fresh on every read, so a card's badge follows its agent. */
const POLL_MS = 10_000;

const usd = (n: number) => `$${n.toFixed(2)}`;
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

/** The sprint board: the team's own tracker columns, each issue with its agent's work on the card. */
export function WorkView({ me, sources, backlog }: { me: Principal; sources: WorkSource[] | null; backlog: boolean }) {
  const location = useLocation();
  if (sources === null) return <Loading what="the issue trackers" panel />;
  if (!sources.length) return <NoTracker me={me} />;
  const params = new URLSearchParams(location.search);
  const source = sources.find((s) => s.id === params.get("source")) ?? sources.find((s) => !s.problem) ?? sources[0]!;
  return <SourceBoard key={source.id} me={me} sources={sources} source={source} params={params} backlog={backlog} />;
}

/** Puts the picked source, board, sprint and filter in the address, so the page can be shared and survives a reload. */
function pickParams(next: Record<string, string | null>) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(next)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  navigate(`${window.location.pathname}?${params.toString()}`, true);
}

/** What kind of board each is, said in the picker: a project read through a person's own server has no boards of its own to list. */
const BOARD_KIND: Record<string, string> = { scrum: "Scrum", kanban: "Kanban", project: "whole project" };

function NoTracker({ me }: { me: Principal }) {
  const href = `${here("integrations")}?open=jira`;
  return (
    <div className="page">
      <header className="page-head"><h1>Work</h1></header>
      <p className="muted">
        {manages(me) ? <><a href={href}>Connect Jira, Linear or GitLab issues</a> to see your sprint here and start agents on its issues.</>
          : <><a href={href}>Connect your own Atlassian MCP server</a> to see your team's Jira sprint here, or ask an owner or an admin to connect the team's tracker.</>}
      </p>
    </div>
  );
}

function SourceBoard({ me, sources, source, params, backlog }: { me: Principal; sources: WorkSource[]; source: WorkSource; params: URLSearchParams; backlog: boolean }) {
  const [boards, setBoards] = useState<WorkBoard[] | null>(null);
  const [sprints, setSprints] = useState<WorkSprint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const board = boards?.find((b) => b.id === params.get("board")) ?? boards?.[0] ?? null;
  const sprint = sprints?.find((s) => s.id === params.get("sprint")) ?? sprints?.find((s) => s.state === "active") ?? sprints?.find((s) => s.state === "future") ?? null;
  const readBoards = () => {
    setError(null);
    workApi.boards(source.id).then((r) => setBoards(r.boards), (e: Error) => setError(e.message));
  };
  useEffect(() => {
    if (!source.problem) readBoards();
  }, [source.id]);
  useEffect(() => {
    setSprints(null);
    if (!board) return;
    if (!source.can.sprints) return setSprints([]);
    workApi.sprints(board.id).then((r) => setSprints(r.sprints), (e: Error) => setError(e.message));
  }, [board?.id]);

  const picker = (
    <div className="work-picker">
      {sources.length > 1 ? <Select label="Source" value={source.id} onChange={(v) => pickParams({ source: v, board: null, sprint: null })} options={sources.map((s) => ({ value: s.id, label: s.name, hint: s.as === "you" ? "as you" : undefined }))} /> : null}
      {boards && boards.length > 1 ? <Select label="Board" value={board?.id ?? ""} onChange={(v) => pickParams({ board: v, sprint: null })} options={boards.map((b) => ({ value: b.id, label: b.name, hint: [BOARD_KIND[b.type], b.project].filter(Boolean).join(", ") || undefined }))} /> : null}
      {sprints && sprints.length ? <Select label="Sprint" value={sprint?.id ?? ""} onChange={(v) => pickParams({ sprint: v })} options={sprints.map((s) => ({ value: s.id, label: s.name, hint: s.state === "active" ? "active" : s.state === "future" ? "next" : "closed" }))} /> : null}
    </div>
  );
  const tracker = source.kind === "jira" ? "Jira" : source.kind === "linear" ? "Linear" : source.kind === "gitlab" ? "GitLab" : "GitHub";
  const head = (title: string, line?: string | null) => (
    <>
      <PageHead
        title={title}
        crumb={board && board.name !== title ? board.name : source.name}
        summary={line ?? undefined}
        actions={board ? <a className="button secondary" href={board.url} target="_blank" rel="noopener noreferrer">Open in {tracker}</a> : undefined}
      />
      {picker}
    </>
  );

  if (source.problem) return <div className="page">{head("Work")}<LoadFailed what={source.name} reason={source.problem} next={<a href={here("integrations")}>Fix the connection under Integrations</a>} panel /></div>;
  if (error) return <div className="page">{head("Work")}<LoadFailed what="the board" reason={error} onRetry={readBoards} panel /></div>;
  if (!boards) return <div className="page">{head("Work")}<Loading what="the boards" panel /></div>;
  if (!board) {
    return (
      <div className="page">
        {head("Work")}
        <div className="panel"><p className="muted">{manages(me) ? `No board is read from ${source.name} yet.` : "No board is mapped to your team yet. Ask an owner or an admin to map your team's board."}</p></div>
      </div>
    );
  }
  if (sprints === null) return <div className="page">{head(board.name)}<Loading what="the sprints" panel /></div>;
  // One person's own machine has no teams: every board it reads is theirs.
  const mapping = me.mode !== "local" && manages(me) && source.as === "organization" ? <BoardTeam key={board.id} board={board} onMapped={(team) => setBoards(boards.map((b) => (b.id === board.id ? { ...b, team } : b)))} /> : null;
  const dates = sprint && (day(sprint.startsAt) || day(sprint.endsAt)) ? `${day(sprint.startsAt) ?? "?"} to ${day(sprint.endsAt) ?? "?"}` : null;
  const keep = params.toString() ? `?${params.toString()}` : "";
  const views = <SubNav label="Work" current={backlog ? here("work", "backlog") + keep : here("work") + keep} links={[{ to: here("work") + keep, label: "Board" }, ...(source.can.backlog ? [{ to: here("work", "backlog") + keep, label: "Backlog" }] : [])]} />;
  if (backlog) {
    return (
      <div className="page">
        {head("Backlog", `The issues on ${board.name} in no sprint, in the tracker's order.`)}
        {mapping}
        {views}
        {source.can.backlog ? <Issues key={`${board.id}:backlog`} me={me} board={board} sprint={null} backlog mine={params.get("mine") === "1"} moves={source.kind === "jira"} /> : <div className="panel"><p className="muted">{source.name} keeps no backlog the orchestrator reads.</p></div>}
      </div>
    );
  }
  // A Kanban board, or a project read through a person's own server with no sprint, is the board
  // itself, every issue on it, as Jira draws it; a Scrum board between sprints keeps its backlog.
  if (!sprint && (source.kind === "jira" || source.kind === "linear") && (board.type === "kanban" || board.type === "project")) {
    return (
      <div className="page">
        {head(board.name, board.type === "project" ? "The whole project, as your server reads it: every issue but its epics, the done ones from the last two weeks." : "Every issue on this board but its epics, the done ones from the last two weeks.")}
        {mapping}
        <Issues key={`${board.id}:board`} me={me} board={board} sprint={null} backlog={false} whole mine={params.get("mine") === "1"} moves={source.kind === "jira"} />
      </div>
    );
  }
  return (
    <div className="page">
      {head(sprint?.name ?? board.name, sprint ? sprintLine(dates, sprint) : source.can.sprints ? "This board has no active or next sprint. The Backlog lists what is waiting." : null)}
      {mapping}
      {views}
      <Issues key={`${board.id}:${sprint?.id ?? ""}`} me={me} board={board} sprint={sprint} backlog={!sprint} mine={params.get("mine") === "1"} moves={source.kind === "jira"} />
    </div>
  );
}

/** A sprint's board, or a list for the backlog; either way issues are picked here to start agents on. */
/** `moves` is set for Jira, the one tracker whose issues the orchestrator moves; elsewhere the switch would only say it cannot. */
function Issues({ me, board, sprint, backlog, mine, moves, whole = false }: { me: Principal; board: WorkBoard; sprint: WorkSprint | null; backlog: boolean; mine: boolean; moves: boolean; whole?: boolean }) {
  const [read, setRead] = useState<WorkItems | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [column, setColumn] = useState(0);
  // The issue read in the right rail: pressing a card picks it, the rail says what it is and starts an agent on it.
  const [chosen, setChosen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const load = (fresh = false) => {
    clearTimeout(timer.current);
    (whole ? workApi.boardItems(board.id, fresh) : sprint && !backlog ? workApi.sprintItems(sprint.id, fresh) : workApi.backlog(board.id, fresh)).then(
      (r) => {
        setRead(r);
        setError(null);
        setRefreshError(null);
      },
      (e: Error) => (read ? setRefreshError(e.message) : setError(e instanceof NotFound ? "This board or sprint is not one you can see." : e.message)),
    ).finally(() => {
      timer.current = setTimeout(() => load(), POLL_MS);
    });
  };
  useEffect(() => {
    load();
    return () => clearTimeout(timer.current);
  }, []);
  if (error) return <LoadFailed what="the issues" reason={error} onRetry={() => load(true)} panel />;
  if (!read) return <Loading what="the issues" panel />;
  const pick = (key: string) => setPicked(picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key]);
  const full = picked.length >= MOST_AT_ONCE;
  const card = (item: WorkItem) => <Card key={item.key} item={item} me={me} picked={picked.includes(item.key)} canPick={!full || picked.includes(item.key)} onPick={() => pick(item.key)} chosen={chosen === item.key} onChoose={() => setChosen(item.key)} />;
  const chosenItem = read.items.find((i) => i.key === chosen) ?? null;
  const rail = (
    <aside className="rail" aria-label="The picked issue">
      {chosenItem ? (
        <ChosenIssue item={chosenItem} me={me} onStart={() => { setPicked([chosenItem.key]); setStarting(true); }} />
      ) : (
        <section><h2>No issue picked</h2><p className="muted">Press an issue to read it here and start an agent on it.</p></section>
      )}
    </aside>
  );
  const shownItems = mine ? read.items.filter((i) => isMine(i, me)) : read.items;
  const filter = (
    <div className="segmented wide" role="group" aria-label="Whose work">
      <button type="button" className="secondary" aria-pressed={!mine} onClick={() => pickParams({ mine: null })}>All issues <span className="count">{read.items.length}</span></button>
      <button type="button" className="secondary" aria-pressed={mine} onClick={() => pickParams({ mine: "1" })}>My work <span className="count">{read.items.filter((i) => isMine(i, me)).length}</span></button>
    </div>
  );
  const picking = picked.length ? (
    <div className="pick-bar" role="region" aria-label="Picked issues">
      <p>{picked.length} {picked.length === 1 ? "issue" : "issues"} picked{full ? `, as many as start at once` : ""}</p>
      <div className="actions">
        <button type="button" onClick={() => setStarting(true)} disabled={starting}>Start agents</button>
        <button type="button" className="secondary" onClick={() => { setPicked([]); setStarting(false); }}>Clear</button>
      </div>
    </div>
  ) : null;
  const startPanel = starting ? (
    <StartAgents
      local={me.mode === "local"}
      items={read.items.filter((i) => picked.includes(i.key))}
      onStarted={() => load()}
      onCancel={() => { setStarting(false); setPicked([]); }}
    />
  ) : null;
  const notice = (
    <>
      <p className="muted small read-at" role="status">
        Read from the tracker at {read.fetchedAt.slice(11, 16)} UTC
        {read.stale ? <> <span className="badge neutral">refreshing</span> The tracker is being read again; the board catches up on its next look.</> : null}
      </p>
      {refreshError ? <RefreshFailed what="issues" reason={refreshError} onRetry={() => load(true)} /> : null}
      {read.truncated ? <p className="muted">The tracker returned more issues than the board shows; the first 500 are here.</p> : null}
    </>
  );
  if (backlog) {
    return (
      <>
        {notice}
        {startPanel}
        <section className="panel" aria-labelledby="backlog-h">
          <h2 id="backlog-h">Waiting <span className="count">{shownItems.length}</span></h2>
          {filter}
          {shownItems.length ? <ul className="plain cards backlog-list">{shownItems.map(card)}</ul> : <p className="muted">{mine ? "Nothing waiting is assigned to you or started by you." : "Nothing is waiting outside a sprint."}</p>}
        </section>
        {picking}
      </>
    );
  }
  const summary = sprintSummary(read);
  const next = nextIssue(read, me);
  const columns = placeItems(read.columns, shownItems);
  const shown = Math.min(column, columns.length - 1);
  return (
    <>
      <section className="work-progress" aria-label="Sprint progress">
        <p>{progressLine(read, summary)}</p>
        <ol className="progress-line" aria-hidden="true">
          {(["done", "doing", "todo"] as const).map((k) => (read.progress[k] ? <li key={k} className={`progress-${k}`} style={{ flexGrow: read.progress[k] }} /> : null))}
        </ol>
        {next ? <p>Next up: <button type="button" className="link" onClick={() => setChosen(next.key)}><span className="mono">{next.key}</span> {next.summary}</button></p> : null}
        <div className="actions">
          <button type="button" className="secondary small" onClick={() => {
            // The note for a team's channel, pasted by the person; the orchestrator sends it nowhere.
            navigator.clipboard.writeText(morningSummary(sprint?.name ?? board.name, read, me)).then(() => setCopied("The morning summary is copied; paste it where your team reads it."), () => setCopied("The browser kept the summary from the clipboard; select the board's text instead."));
          }}>Copy the morning summary</button>
          <button type="button" className="ghost small" onClick={() => load(true)}>Read the tracker again</button>
        </div>
        {copied ? <p role="status" className="muted small">{copied}</p> : null}
      </section>
      {moves ? <MovesSwitch board={board} columns={read.columns} /> : null}
      {board.id.startsWith("mcp:") ? <ArrangeColumns key={read.columns.map((c) => c.name).join("|")} board={board.id} columns={read.columns} onSaved={() => load(true)} /> : null}
      {notice}
      {startPanel}
      {filter}
      {mine && !shownItems.length ? <p className="muted">No issue in this sprint is assigned to you or carries a task you started.</p> : null}
      <div className="segmented wide board-switch" role="group" aria-label="Columns">
        {columns.map((c, i) => (
          <button key={c.name} type="button" className="secondary" aria-pressed={i === shown} onClick={() => setColumn(i)}>{c.name}<span className="visually-hidden"> column,</span> <span className="count">{c.items.length}</span></button>
        ))}
      </div>
      <div className="with-rail">
        <div className="board" role="group" aria-label={`${sprint?.name ?? board.name} board`}>
          {columns.map((c, i) => (
            <section key={c.name} className={`board-col${i === shown ? " chosen" : ""}`} aria-labelledby={`col-${i}`}>
              <h2 id={`col-${i}`}>{c.name} <span className="count">{c.items.length}</span>{points(c.items) ? <span className="muted small">, {points(c.items)} points</span> : null}</h2>
              <ul className="plain cards">{c.items.map(card)}</ul>
            </section>
          ))}
        </div>
        {rail}
      </div>
      {picking}
    </>
  );
}

/** The facts of an issue in the order Jira's card gives them: key, type, priority, points, assignee. */
function facts(item: WorkItem): string {
  return [item.type, item.priority ? `${item.priority} priority` : null, item.storyPoints !== null ? `${item.storyPoints} ${item.storyPoints === 1 ? "point" : "points"}` : null, item.assignee?.name ?? "Unassigned"].filter(Boolean).join(", ");
}

/**
 * A card read like Jira's: the title, the parent under it, then the key and the issue's facts; a
 * flagged one in the waiting tone. When an agent touched the issue, its state is the last line.
 * Pressing the title shows the issue in the right rail; the card itself starts nothing.
 */
function Card({ item, me, picked, canPick, onPick, chosen, onChoose }: { item: WorkItem; me: Principal; picked: boolean; canPick: boolean; onPick: () => void; chosen: boolean; onChoose: () => void }) {
  const latest = item.tasks[0];
  const badge = latest ? taskBadge(latest) : null;
  return (
    <li className={`work-card${picked ? " picked" : ""}${chosen ? " chosen" : ""}${item.blocked ? " flagged" : ""}`} aria-label={`${item.key} ${item.summary}`}>
      <p className="work-card-title">
        <input type="checkbox" checked={picked} disabled={!canPick} onChange={onPick} aria-label={`Pick ${item.key}`} />
        <button type="button" className="link" aria-pressed={chosen} onClick={onChoose}>{item.summary}</button>
      </p>
      {item.epic ? <p className="muted small">{item.epic.summary}</p> : null}
      <p className="muted small">
        <a className="mono" href={item.url} target="_blank" rel="noopener noreferrer">{item.key}</a> {facts(item)}
      </p>
      {item.blocked ? <p className="small"><span className="state warn">Blocked</span> waiting on something else</p> : null}
      {latest && badge ? (
        <p className="work-card-agent small">
          <a className={`state ${badge.tone}`} href={here("tasks", latest.taskId)}>{badge.label}</a>
          {latest.requests.map((r) => (
            <a key={`${r.repoId}#${r.number}`} href={r.url ?? here("tasks", latest.taskId)} {...(r.url ? { target: "_blank", rel: "noopener noreferrer" } : {})}> {r.name}</a>
          ))}
          <span className="muted"> started by {latest.startedBy === me.email ? "you" : latest.startedBy}{item.tasks.length > 1 ? `, ${item.tasks.length - 1} earlier` : ""}</span>
        </p>
      ) : null}
    </li>
  );
}

/** The picked issue in the right rail: what it is, what agents did on it, and its one action. */
function ChosenIssue({ item, me, onStart }: { item: WorkItem; me: Principal; onStart: () => void }) {
  return (
    <>
      <section>
        <h2><span className="mono">{item.key}</span> {item.summary}</h2>
        <p className="muted">{facts(item)}. {item.status.name}{item.epic ? `, in ${item.epic.summary}` : ""}{item.labels.length ? `; labels ${item.labels.join(", ")}` : ""}.</p>
        {item.blocked ? <p><span className="state warn">Blocked</span> waiting on something else.</p> : null}
      </section>
      <section>
        <h2>Agents on it</h2>
        {item.tasks.length ? (
          <ul className="plain">
            {item.tasks.map((t) => (
              <li key={t.taskId}><a className={`state ${taskBadge(t).tone}`} href={here("tasks", t.taskId)}>{taskBadge(t).label}</a>{t.reason ? <> <span className="error">{t.reason}</span></> : null} <span className="muted">started by {t.startedBy === me.email ? "you" : t.startedBy}</span></li>
            ))}
          </ul>
        ) : <p className="muted">No agent has worked on it yet.</p>}
      </section>
      <section>
        <div className="actions">
          <button type="button" onClick={onStart}>Start an agent</button>
          <a className="button ghost" href={item.url} target="_blank" rel="noopener noreferrer">Open the issue</a>
        </div>
      </section>
    </>
  );
}

/** A sprint's dates, the days it has left and its goal, in one sentence; what the tracker does not say is left out. */
function sprintLine(dates: string | null, sprint: WorkSprint): string | null {
  const end = sprint.endsAt ? Date.parse(sprint.endsAt) : NaN;
  const left = Number.isNaN(end) ? null : Math.ceil((end - Date.now()) / 86_400_000);
  const when = [dates, left === null ? null : left > 0 ? `${left} ${left === 1 ? "day" : "days"} left` : "ended"].filter(Boolean).join(", ");
  const said = [when ? `${when}.` : null, sprint.goal ? `Goal: ${sprint.goal}.` : null].filter(Boolean).join(" ");
  return said || null;
}

/** The points of a column's issues; null when none carries an estimate. */
function points(items: WorkItem[]): number | null {
  const estimated = items.filter((i) => i.storyPoints !== null);
  return estimated.length ? estimated.reduce((n, i) => n + (i.storyPoints ?? 0), 0) : null;
}

/** The sprint's progress in one sentence: how far it is, what agents worked on and what it cost. */
function progressLine(read: WorkItems, summary: ReturnType<typeof sprintSummary>): string {
  const p = read.progress;
  const worked = read.items.filter((i) => i.tasks.length).length;
  const cost = summary.costUsd === null ? "" : ` for ${usd(summary.costUsd)}${summary.costPartial ? ", some unreported" : ""}`;
  return [
    `${p.done} of ${summary.total} done, ${p.doing} in progress, ${p.todo} to do${p.points ? `; ${p.points.done} of ${p.points.total} points done` : ""}.`,
    worked ? `Agents worked on ${worked} ${worked === 1 ? "issue" : "issues"}${cost}${summary.openRequests ? `, ${summary.openRequests} in review${summary.reviewOn ? ` on ${summary.reviewOn}` : ""}` : ""}.` : "No agent has worked on these yet.",
    summary.blocked ? `${summary.blocked} flagged.` : "",
  ].filter(Boolean).join(" ");
}
