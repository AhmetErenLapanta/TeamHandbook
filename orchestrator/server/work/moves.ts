import type { OrchestratorContext } from "../app.js";
import { manages } from "../auth.js";
import type { Principal } from "../auth.js";
import type { WorkColumn, WorkMoves, WorkMoveTrigger } from "../../shared/work.js";
import { ChangeRefused } from "../changes.js";
import { isOrgSource } from "./ids.js";
import { SourceFailed } from "./provider.js";
import { board, columns } from "./service.js";
import type { Opened, WorkDeps } from "./service.js";

type Ctx = Pick<OrchestratorContext, "store" | "tenant" | "vault" | "forgeApps">;

export const TRIGGERS: readonly WorkMoveTrigger[] = ["started", "requestOpened", "merged"];

/** A board's saved "Move issues as the agent works", with where its issues live, so a task's issue is matched to it. */
export interface SavedMoves {
  enabled: boolean;
  moves: Partial<Record<WorkMoveTrigger, string>>;
  /** The issue address a key on this board starts with: `<site>/browse/<PROJECT>-`. */
  issuePrefix: string | null;
}

/** An organization-token board's setting is the organization's; a board on a person's own server is theirs. */
export const movesKey = (source: string, boardId: string, userId: string) => (isOrgSource(source) ? `work.moves.${boardId}` : `work.moves.${userId}.${boardId}`);

export async function readSaved(ctx: Pick<OrchestratorContext, "store" | "tenant">, key: string): Promise<SavedMoves | null> {
  const raw = await ctx.store.getSetting(ctx.tenant, key);
  try {
    return raw ? (JSON.parse(raw) as SavedMoves) : null;
  } catch {
    return null;
  }
}

const STARTED = [/^(in (dev|development|progress)|doing|development|working)$/i, /\bin (dev|development|progress)\b/i];
const REVIEW = [/^(code review|in review|review)$/i, /\breview\b/i];
const DONE = [/^(done|closed|resolved|complete|completed)$/i];

/**
 * The mapping a board starts from, guessed from its column names: the agent starting puts the
 * issue in the first in-progress column, a request opening puts it in review, a merge puts it
 * in done. A moment with no column that fits moves nothing.
 */
export function guessMoves(cols: readonly WorkColumn[]): Partial<Record<WorkMoveTrigger, string>> {
  const find = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const hit = cols.find((c) => pattern.test(c.name));
      if (hit) return hit.name;
    }
    return undefined;
  };
  const started = find(STARTED);
  const requestOpened = find(REVIEW);
  const merged = find(DONE);
  return { ...(started ? { started } : {}), ...(requestOpened ? { requestOpened } : {}), ...(merged ? { merged } : {}) };
}

async function writeProblem(opened: Opened): Promise<string | null> {
  try {
    return await opened.provider.writable();
  } catch (err) {
    if (err instanceof SourceFailed) return err.message;
    throw err;
  }
}

const canChange = (opened: Opened, user: Principal) => !isOrgSource(opened.source.id) || manages(user);

export async function readMoves(ctx: Ctx, user: Principal, boardId: string, deps: WorkDeps): Promise<WorkMoves> {
  const { opened, native } = await board(ctx, user, boardId, deps);
  const [saved, cols, reason] = await Promise.all([readSaved(ctx, movesKey(opened.source.id, boardId, user.id)), columns(opened, native, deps), writeProblem(opened)]);
  return {
    enabled: Boolean(saved?.enabled) && reason === null,
    guessed: !saved,
    canChange: canChange(opened, user),
    write: { allowed: reason === null, reason, off: !opened.writes },
    moves: saved ? saved.moves : guessMoves(cols),
  };
}

/** Saves the switch and the mapping; turning it on needs a source that moves issues, and each column has to be one of the board's. */
export async function saveMoves(ctx: Ctx, user: Principal, boardId: string, given: unknown, deps: WorkDeps): Promise<{ saved: WorkMoves; detail: string }> {
  const { opened, native, shown } = await board(ctx, user, boardId, deps);
  if (!canChange(opened, user)) throw new ChangeRefused("only an owner or an admin changes this for the organization's tracker");
  const body = given as { enabled?: unknown; moves?: unknown } | null;
  if (typeof body?.enabled !== "boolean" || !body.moves || typeof body.moves !== "object") throw new ChangeRefused("send enabled and moves");
  const names = new Set((await columns(opened, native, deps)).map((c) => c.name));
  const moves: Partial<Record<WorkMoveTrigger, string>> = {};
  for (const [trigger, column] of Object.entries(body.moves as Record<string, unknown>)) {
    if (!TRIGGERS.includes(trigger as WorkMoveTrigger)) throw new ChangeRefused(`a move happens when the agent starts, a request opens or it merges, not on ${trigger}`);
    if (column === null || column === undefined || column === "") continue;
    if (typeof column !== "string" || !names.has(column)) throw new ChangeRefused(`${String(column)} is not a column of this board`);
    moves[trigger as WorkMoveTrigger] = column;
  }
  if (body.enabled) {
    const reason = await writeProblem(opened);
    if (reason) throw new ChangeRefused(reason);
  }
  const site = new URL(shown.url).origin;
  const record: SavedMoves = { enabled: body.enabled, moves, issuePrefix: shown.project ? `${site}/browse/${shown.project}-` : null };
  await ctx.store.setSetting(ctx.tenant, movesKey(opened.source.id, boardId, user.id), JSON.stringify(record));
  const mapped = TRIGGERS.filter((t) => moves[t]).map((t) => `${t} -> ${moves[t]}`);
  return {
    saved: await readMoves(ctx, user, boardId, deps),
    detail: `${body.enabled ? "turned on" : "turned off"} moving issues on ${shown.name}${mapped.length ? `: ${mapped.join(", ")}` : ""}`,
  };
}
