import { resolve } from "node:path";
import { commandFamily, fingerprint, normalizeErrorText } from "./normalize.js";
import type { Signal } from "./signals.js";

export interface LearnPayload {
  command: string;
  error: string;
  resolvedCommand?: string;
  edits: string[];
  cwd: string;
  sessionId: string;
}

export interface LearnParseResult {
  payload?: LearnPayload;
  error?: string;
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
  if (typeof p.command !== "string" || !p.command.trim()) {
    return { error: 'payload needs a non-empty "command" string (the command that failed)' };
  }
  if (typeof p.error !== "string" || !p.error.trim()) {
    return { error: 'payload needs a non-empty "error" string (the error output)' };
  }
  if (p.edits !== undefined && (!Array.isArray(p.edits) || p.edits.some((e) => typeof e !== "string"))) {
    return { error: '"edits" must be an array of file paths' };
  }
  if (p.resolvedCommand !== undefined && typeof p.resolvedCommand !== "string") {
    return { error: '"resolvedCommand" must be a string' };
  }
  const cwd = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd : defaultCwd;
  return {
    payload: {
      command: p.command.trim(),
      error: p.error,
      ...(typeof p.resolvedCommand === "string" && p.resolvedCommand.trim()
        ? { resolvedCommand: p.resolvedCommand.trim() }
        : {}),
      edits: ((p.edits as string[] | undefined) ?? [])
        .filter((e) => e.trim())
        .map((e) => resolve(cwd, e)),
      cwd,
      sessionId: typeof p.sessionId === "string" && p.sessionId.trim() ? p.sessionId : "manual",
    },
  };
}

export function signalFromLearnPayload(payload: LearnPayload, ts: string): Signal {
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
