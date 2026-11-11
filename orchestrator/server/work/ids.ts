import { SERVER_NAME } from "../skill-rules.js";

/**
 * A board or sprint id as the screen holds it: `<source>~<board>` and `<source>~<board>~<sprint>`.
 * The parts go into the path of a request made with the organization's token, so each is held
 * to its own shape here, and a provider checks its own stricter one before a request; the id is
 * also only honoured when the board is one this person is shown, so a made-up id reaches nothing.
 */
export interface BoardRef {
  source: string;
  board: string;
}

export interface SprintRef extends BoardRef {
  sprint: string;
}

const PART = /^[A-Za-z0-9._/-]{1,140}$/;

/** GitHub issues read with the person's own gh, on their own machine. */
export const OWN_GITHUB = "own:github";

/** A source read as the organization, whose boards are shown by team; a person's own server or gh is read as them. */
export const isOrgSource = (id: string): boolean => !id.startsWith("mcp:") && id !== OWN_GITHUB;

export function isSourceId(id: string): boolean {
  if (id === "tracker" || id === "forge:gitlab" || id === "forge:github" || id === OWN_GITHUB) return true;
  return id.startsWith("mcp:") && SERVER_NAME.test(id.slice(4));
}

export const boardId = (ref: BoardRef): string => `${ref.source}~${ref.board}`;
export const sprintId = (ref: SprintRef): string => `${boardId(ref)}~${ref.sprint}`;

export function parseBoardId(id: string): BoardRef | null {
  const [source, board, ...rest] = id.split("~");
  return rest.length === 0 && source && board && isSourceId(source) && PART.test(board) && !board.includes("..") ? { source, board } : null;
}

export function parseSprintId(id: string): SprintRef | null {
  const at = id.lastIndexOf("~");
  const board = at > 0 ? parseBoardId(id.slice(0, at)) : null;
  const sprint = id.slice(at + 1);
  return board && PART.test(sprint) && !sprint.includes("/") ? { ...board, sprint } : null;
}
