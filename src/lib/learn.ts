import { resolve } from "node:path";
import { commandFamily, fingerprint, normalizeErrorText } from "./normalize.js";
import type { Signal, TaskCase } from "./signals.js";

export interface ErrorFixPayload {
  kind: "error-fix";
  command: string;
  error: string;
  resolvedCommand?: string;
  edits: string[];
  cwd: string;
  sessionId: string;
}

export interface ProcedurePayload {
  kind: "procedure";
  task: TaskCase;
  edits: string[];
  cwd: string;
  sessionId: string;
}

export type LearnPayload = ErrorFixPayload | ProcedurePayload;

export interface LearnParseResult {
  payload?: LearnPayload;
  error?: string;
}

function parseCommon(p: Record<string, unknown>, defaultCwd: string) {
  if (p.edits !== undefined && (!Array.isArray(p.edits) || p.edits.some((e) => typeof e !== "string"))) {
    return { error: '"edits" must be an array of file paths' as const };
  }
  const cwd = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd : defaultCwd;
  return {
    cwd,
    edits: ((p.edits as string[] | undefined) ?? []).filter((e) => e.trim()).map((e) => resolve(cwd, e)),
    sessionId: typeof p.sessionId === "string" && p.sessionId.trim() ? p.sessionId : "manual",
  };
}

export function parseLearnPayload(raw: string, defaultCwd: string = process.cwd()): LearnParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "payload is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "payload must be a JSON object" };
  }
  const p = parsed as Record<string, unknown>;

  // Procedure mode: a completed task worth teaching (goal + steps).
  if (p.goal !== undefined || p.steps !== undefined) {
    if (typeof p.goal !== "string" || !p.goal.trim()) {
      return { error: 'a procedure payload needs a non-empty "goal" string (what the task achieved)' };
    }
    if (
      !Array.isArray(p.steps) ||
      p.steps.length < 2 ||
      p.steps.some((s) => typeof s !== "string" || !s.trim())
    ) {
      return { error: 'a procedure payload needs "steps": at least 2 non-empty strings, in order' };
    }
    if (p.verification !== undefined && typeof p.verification !== "string") {
      return { error: '"verification" must be a string' };
    }
    const common = parseCommon(p, defaultCwd);
    if ("error" in common) return { error: common.error };
    return {
      payload: {
        kind: "procedure",
        task: {
          goal: p.goal.trim(),
          steps: (p.steps as string[]).map((s) => s.trim()),
          ...(typeof p.verification === "string" && p.verification.trim()
            ? { verification: p.verification.trim() }
            : {}),
        },
        ...common,
      },
    };
  }

  // Error→fix mode (the original shape).
  if (typeof p.command !== "string" || !p.command.trim()) {
    return {
      error:
        'payload needs either "command"+"error" (an error→fix case) or "goal"+"steps" (a task procedure)',
    };
  }
  if (typeof p.error !== "string" || !p.error.trim()) {
    return { error: 'payload needs a non-empty "error" string (the error output)' };
  }
  if (p.resolvedCommand !== undefined && typeof p.resolvedCommand !== "string") {
    return { error: '"resolvedCommand" must be a string' };
  }
  const common = parseCommon(p, defaultCwd);
  if ("error" in common) return { error: common.error };
  return {
    payload: {
      kind: "error-fix",
      command: p.command.trim(),
      error: p.error,
      ...(typeof p.resolvedCommand === "string" && p.resolvedCommand.trim()
        ? { resolvedCommand: p.resolvedCommand.trim() }
        : {}),
      ...common,
    },
  };
}

export function signalFromLearnPayload(payload: LearnPayload, ts: string): Signal {
  if (payload.kind === "procedure") {
    const normalizedGoal = normalizeErrorText(payload.task.goal.toLowerCase());
    return {
      ts,
      sessionId: payload.sessionId,
      kind: "candidate",
      fingerprint: fingerprint("task", normalizedGoal),
      family: "task",
      command: "",
      error: "",
      cwd: payload.cwd,
      count: 1,
      edits: payload.edits,
      task: payload.task,
      trigger: "manual",
    };
  }
  const error = normalizeErrorText(payload.error);
  const family = commandFamily(payload.command);
  return {
    ts,
    sessionId: payload.sessionId,
    kind: "candidate",
    fingerprint: fingerprint(family, error),
    family,
    command: payload.command,
    error,
    cwd: payload.cwd,
    count: 1,
    edits: payload.edits,
    ...(payload.resolvedCommand ? { resolvedCommand: payload.resolvedCommand, resolvedAt: ts } : {}),
    trigger: "manual",
  };
}
