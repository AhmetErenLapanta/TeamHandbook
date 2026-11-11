import type { Principal } from "../api";
import { call } from "../api";
import type { WorkBoards, WorkBoardTeams, WorkColumn, WorkColumns, WorkItems, WorkMoves, WorkSource, WorkSources, WorkSprints, WorkStarters } from "../../../shared/work";

export type { WorkBoard, WorkColumn, WorkItem, WorkItems, WorkMoves, WorkMoveTrigger, WorkSource, WorkSprint, WorkStarter, WorkTaskLink, TaskPhase } from "../../../shared/work";

const query = (params: Record<string, string | undefined>) => new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1]))).toString();

/** The orchestrator's reads of the organization's trackers; it never writes to one except through `saveMoves`' switch. */
export const workApi = {
  sources: () => call<WorkSources>("GET", "/api/work/sources"),
  boards: (source: string) => call<WorkBoards>("GET", `/api/work/boards?${query({ source })}`),
  sprints: (board: string) => call<WorkSprints>("GET", `/api/work/sprints?${query({ board })}`),
  sprintItems: (sprint: string, fresh = false) => call<WorkItems>("GET", `/api/work/items?${query({ sprint, fresh: fresh ? "1" : undefined })}`),
  backlog: (board: string, fresh = false) => call<WorkItems>("GET", `/api/work/items?${query({ backlog: board, fresh: fresh ? "1" : undefined })}`),
  saveColumns: (board: string, columns: WorkColumn[] | null) => call<WorkColumns>("PUT", `/api/work/boards/${encodeURIComponent(board)}/columns`, { columns }),
  boardItems: (board: string, fresh = false) => call<WorkItems>("GET", `/api/work/items?${query({ board, fresh: fresh ? "1" : undefined })}`),
  moves: (board: string) => call<WorkMoves>("GET", `/api/work/moves?${query({ board })}`),
  saveMoves: (board: string, next: Pick<WorkMoves, "enabled" | "moves">) => call<WorkMoves>("PUT", `/api/work/moves?${query({ board })}`, next),
  /** Which team sees an organization board; only an owner or an admin sets it, and a member sees only their team's. */
  mapBoard: (boardId: string, team: string | null) => call<WorkBoardTeams>("PUT", "/api/work/boards/teams", { boards: [{ boardId, team }] }),
  /** Tasks the opened folder suggests by being read alone: its own TODO notes, then its tests and linter; nothing runs. */
  starters: (project: string) => call<WorkStarters>("GET", `/api/work/starters?${query({ project })}`),
};

