import { isAbsolute, normalize, sep } from "node:path";

import type { AgentEvent } from "./contract.js";

export function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A stdout line that is no frame of the agent's still reaches the log, unless it is blank. */
export function outputLine(line: string): AgentEvent[] {
  return line.trim() ? [{ type: "output", text: line }] : [];
}

/**
 * A path the agent named, as a path inside the task's folder, or null when it is outside it or the
 * folder is not known: the live view shows a changed file by its place in the folder and never a
 * path outside it. The agent names paths from its own resolved working directory, which can sit
 * under another prefix than the orchestrator's (/var against /private/var), so the folder is
 * found after any prefix.
 */
export function inFolder(work: string | undefined, path: unknown): string | null {
  if (!work || typeof path !== "string" || !path) return null;
  const named = normalize(path);
  const root = normalize(work).replace(/\/+$/, "") + sep;
  const at = isAbsolute(named) ? named.indexOf(root) : 0;
  const inside = isAbsolute(named) ? (at < 0 ? null : named.slice(at + root.length)) : named;
  return inside && inside.split(sep).every((part) => part !== "" && part !== "." && part !== "..") ? inside : null;
}

/** What a call is aimed at as the live view and a card show it: inside the task's folder by its place there, anything else as the agent named it. */
export const shownTarget = (work: string | undefined, target: string | null): string | null => (target === null ? null : (inFolder(work, target) ?? target));

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;

/** A tool's output as whole lines without terminal colour codes; a trailing newline adds no empty line. */
export function outputLines(text: string): string[] {
  const lines = text.replace(ANSI, "").replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The to-do items the page draws; a list cut by items splits no secret, so it is cut here. */
export const MAX_TODOS = 30;

const TODO_STATE: Record<string, "todo" | "doing" | "done"> = { pending: "todo", in_progress: "doing", completed: "done" };

/**
 * An agent's to-do list in the contract's states. Claude Code and OpenCode name an item's text
 * `content` and its states alike; an item in any other state (OpenCode's cancelled) is no step
 * left to take and is dropped. Nothing when the list is not one.
 */
export function todosOf(raw: unknown): AgentEvent[] {
  if (!Array.isArray(raw)) return [];
  const items = raw.flatMap((item: Record<string, unknown> | null) => {
    const state = TODO_STATE[String(item?.status)];
    const text = typeof item?.content === "string" ? item.content.trim() : "";
    return state && text ? [{ text, state }] : [];
  });
  return [{ type: "todos", items: items.slice(0, MAX_TODOS) }];
}

/**
 * A file the agent changed, from a unified patch: its changed lines are counted, and its headers
 * are left out, since OpenCode's name the file by its full path on the machine (`Index: /Users/you/…`)
 * and the patch is shown on the team's page.
 */
export function editOf(id: string, path: string | null, patch: string): AgentEvent[] {
  if (!path) return [];
  const all = patch.split("\n");
  const hunks = all.findIndex((l) => l.startsWith("@@"));
  const lines = hunks > 0 ? all.slice(hunks) : all;
  patch = lines.join("\n");
  const additions = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const deletions = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  return [{ type: "edit", id, path, additions, deletions, patch }];
}

/** A new file's content as the patch that adds it. */
export const createdPatch = (content: string): string => outputLines(content).map((l) => `+${l}`).join("\n");

/** A plugin's server as Claude Code names it, `plugin_<plugin>_<server>`: the page names the server. */
const PLUGIN_SERVER = /^plugin_[^_]+_(?=.)/;

/** Claude Code's `mcp__<server>__<tool>` split apart, or null for any other name or one a "__" leaves ambiguous. */
export function claudeMcp(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.slice(5).split("__");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { server: parts[0].replace(PLUGIN_SERVER, ""), tool: parts[1] };
}

/**
 * OpenCode's `<server>_<tool>` split by the servers the session has: OpenCode joins the two after
 * turning every character but letters, digits, "_" and "-" into "_", so a tool id is read against
 * each server's name made the same way. Null when no server, or more than one, starts it.
 */
export function opencodeMcp(id: string, servers: readonly string[]): { server: string; tool: string } | null {
  const matches = servers.filter((server) => {
    const joined = server.replace(/[^a-zA-Z0-9_-]/g, "_") + "_";
    return id.startsWith(joined) && id.length > joined.length;
  });
  if (matches.length !== 1) return null;
  const server = matches[0]!;
  return { server, tool: id.slice(server.length + 1) };
}

/**
 * The MCP servers waiting for a sign-in when a session opened, as every agent says them: one event
 * the task keeps and one line in the orchestrator's words. Nothing when none waits.
 */
export function signInEvents(waiting: readonly string[]): AgentEvent[] {
  if (!waiting.length) return [];
  const one = waiting.length === 1;
  const names = one ? waiting[0]! : `${waiting.slice(0, -1).join(", ")} and ${waiting.at(-1)}`;
  return [
    { type: "mcp_status", needsSignIn: [...waiting] },
    { type: "notice", text: `${names} ${one ? "needs" : "need"} a sign-in, so ${one ? "its" : "their"} tools are not in this task. Sign ${one ? "it" : "them"} in on this machine, then start the task again.` },
  ];
}

/** The tokens a sum of known counts makes, or null when the first is unknown: a part nobody reported is never guessed. */
export const tokensOf = (first: unknown, ...more: unknown[]): number | null => (num(first) === null ? null : more.reduce<number>((sum, n) => sum + (num(n) ?? 0), num(first)!));

/** The session's context once: the first request's input as the agent reports it, cache read and written included. */
export function firstContext(): (tokens: number | null) => AgentEvent[] {
  let told = false;
  return (tokens) => {
    if (told || tokens === null || tokens <= 0) return [];
    told = true;
    return [{ type: "context", tokens }];
  };
}

/** At most this many refused calls are read from one run; a looping agent asks the same thing thousands of times. */
export const MAX_REFUSED = 50;

/** The tool and its target from an agent's report of a call it was refused, with the call's id when the report names it, so the live view marks the call it already shows. */
export function refusedCalls(raw: unknown, tool: (e: Record<string, unknown>) => unknown, input: (e: Record<string, unknown>) => unknown, id: (e: Record<string, unknown>) => unknown = () => undefined): AgentEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_REFUSED).flatMap((e: Record<string, unknown>) => {
    const name = tool(e ?? {});
    if (typeof name !== "string" || !name) return [];
    const given = input(e ?? {});
    const target = typeof given === "string" ? given : ["command", "url", "query", "file_path", "path"].map((k) => (given as Record<string, unknown> | undefined)?.[k]).find((v) => typeof v === "string");
    const call = id(e ?? {});
    return [{ type: "tool_call", ...(typeof call === "string" && call ? { id: call } : {}), tool: name, target: typeof target === "string" ? target : null, status: "refused" } as const];
  });
}
