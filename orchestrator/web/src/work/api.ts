import type { Principal } from "../api";
import { call } from "../api";
import { lastAnswer, rememberAnswer } from "../last-answer";
import type { WorkBoards, WorkBoardTeams, WorkColumn, WorkColumns, WorkItems, WorkMoves, WorkSource, WorkSources, WorkSprints, WorkStarters } from "../../../shared/work";

export type { WorkBoard, WorkColumn, WorkItem, WorkItems, WorkMoves, WorkMoveTrigger, WorkSource, WorkSprint, WorkStarter, WorkTaskLink, TaskPhase } from "../../../shared/work";

const query = (params: Record<string, string | undefined>) => new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1]))).toString();

const paths = {
  boards: (source: string) => `/api/work/boards?${query({ source })}`,
  sprints: (board: string) => `/api/work/sprints?${query({ board })}`,
  sprintItems: (sprint: string) => `/api/work/items?${query({ sprint })}`,
  backlog: (board: string) => `/api/work/items?${query({ backlog: board })}`,
  boardItems: (board: string) => `/api/work/items?${query({ board })}`,
};

/** A tracker read keeps its answer, so the screen revisited draws it at once and reads again behind it; `fresh` skips the orchestrator's own cache. */
const reading = <T>(path: string, fresh = false) => call<T>("GET", fresh ? `${path}&fresh=1` : path).then((r) => rememberAnswer(path, r));

/** What each tracker read answered last, if it did. */
export const lastWork = {
  boards: (source: string) => lastAnswer<WorkBoards>(paths.boards(source)),
  sprints: (board: string) => lastAnswer<WorkSprints>(paths.sprints(board)),
  sprintItems: (sprint: string) => lastAnswer<WorkItems>(paths.sprintItems(sprint)),
  backlog: (board: string) => lastAnswer<WorkItems>(paths.backlog(board)),
  boardItems: (board: string) => lastAnswer<WorkItems>(paths.boardItems(board)),
};

/** The orchestrator's reads of the organization's trackers; it never writes to one except through `saveMoves`' switch. */
export const workApi = {
  sources: () => call<WorkSources>("GET", "/api/work/sources"),
  boards: (source: string) => reading<WorkBoards>(paths.boards(source)),
  sprints: (board: string) => reading<WorkSprints>(paths.sprints(board)),
  sprintItems: (sprint: string, fresh = false) => reading<WorkItems>(paths.sprintItems(sprint), fresh),
  backlog: (board: string, fresh = false) => reading<WorkItems>(paths.backlog(board), fresh),
  saveColumns: (board: string, columns: WorkColumn[] | null) => call<WorkColumns>("PUT", `/api/work/boards/${encodeURIComponent(board)}/columns`, { columns }),
  boardItems: (board: string, fresh = false) => reading<WorkItems>(paths.boardItems(board), fresh),
  moves: (board: string) => call<WorkMoves>("GET", `/api/work/moves?${query({ board })}`),
  saveMoves: (board: string, next: Pick<WorkMoves, "enabled" | "moves">) => call<WorkMoves>("PUT", `/api/work/moves?${query({ board })}`, next),
  /** Which team sees an organization board; only an owner or an admin sets it, and a member sees only their team's. */
  mapBoard: (boardId: string, team: string | null) => call<WorkBoardTeams>("PUT", "/api/work/boards/teams", { boards: [{ boardId, team }] }),
  /** Tasks the opened folder suggests by being read alone: its own TODO notes, then its tests and linter; nothing runs. */
  starters: (project: string) => call<WorkStarters>("GET", `/api/work/starters?${query({ project })}`),
};

