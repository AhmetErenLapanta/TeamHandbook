import type { PolicyRule } from "../server/plugin.js";
import type { PermissionMode } from "../shared/permission-mode.js";

/** One rule of an OpenCode session, as `POST /session` takes it; of the rules that match a call, the last one decides. */
export interface OpencodeRule {
  permission: string;
  pattern: string;
  action: "allow" | "ask" | "deny";
}

/** The team's file tools as OpenCode names them. */
const FILE_TOOLS: Record<string, string[]> = { Read: ["read", "glob", "grep", "list"], Edit: ["edit"], Glob: ["glob"], Grep: ["grep"] };

/** The tools that run commands or reach the web, which a run as the person never has, as Claude Code's run as you does not. */
const SHELL_AND_WEB = ["bash", "webfetch", "websearch", "codesearch"];

/** A `.git` anywhere in the folder: its config names programs that run as the person on their next commit. */
const GIT_PATHS = [".git", ".git/*", "*/.git", "*/.git/*"];

/**
 * The rules an OpenCode session run as the person holds the agent to, the same as Claude Code's
 * run as you. They go with the session, since OpenCode applies a session's rules after every config
 * file and a deny in a config file of the task's loses to an allow in the person's own (OpenCode
 * 1.19.4 merges `permission` keeping the first file's key order and takes the last matching rule).
 * Anything not named asks the person, the person's MCP tools included; no command or web tool runs;
 * nothing outside the task's folder is reached and nothing is written into a `.git`; the agent's
 * own questions, which no card shows yet, are refused; the team's path rules and denied tools are
 * denied. An MCP tool's call asks, and the session answers it before any person is asked once it can
 * name the call's server (`mcpDecidingCodec`): one that reads goes ahead, a tracker's or a forge's that
 * writes is refused, and one of those it cannot name is refused too. A rule cannot tell them apart,
 * since OpenCode names a tool `<server>_<tool>` in one word.
 */
export function personalRules(mode: PermissionMode, deniedTools: readonly string[], rules: readonly PolicyRule[], readDirs: readonly string[] = []): OpencodeRule[] {
  const set = (permission: string, action: OpencodeRule["action"], pattern = "*"): OpencodeRule => ({ permission, pattern, action });
  const edits = mode === "approval-required" ? "ask" : "allow";
  const team = rules.flatMap((rule) => {
    const [kind, tool, ...rest] = rule.resource.split(":");
    const pattern = rest.join(":");
    if (rule.effect !== "deny" || kind !== "tool" || !pattern || (tool !== "Edit" && tool !== "Read")) return [];
    return FILE_TOOLS[tool]!.map((permission) => set(permission, "deny", pattern));
  });
  return [
    set("*", "ask"),
    ...["read", "glob", "grep", "list", "todowrite", "todoread"].map((tool) => set(tool, "allow")),
    set("edit", edits),
    ...SHELL_AND_WEB.map((tool) => set(tool, "deny")),
    set("external_directory", "deny"),
    ...readDirs.flatMap((dir) => [set("external_directory", "allow", dir), set("external_directory", "allow", `${dir}/*`)]),
    set("question", "deny"),
    ...GIT_PATHS.map((path) => set("edit", "deny", path)),
    ...team,
    ...deniedTools.flatMap((tool) => FILE_TOOLS[tool] ?? []).map((permission) => set(permission, "deny")),
    ...readDirs.map((dir) => set("edit", "deny", `${dir}/*`)),
  ];
}
