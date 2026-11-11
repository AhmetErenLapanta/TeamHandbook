/**
 * The source of the run-as-me guard's PreToolUse hook, written into the task's guard folder and run
 * by Claude Code as a program of its own for each MCP or file-writing call, never in the
 * orchestrator: it denies a write outside the folder the task works in or into a .git there, a
 * tracker's or a forge's tool that does not read, and a call it cannot read. It lets an MCP tool that reads run in
 * every mode, Auto's included, which otherwise refuses any tool no rule names: a person's Jira or Slack reads are
 * theirs, as in their own sessions. Every other MCP tool is left to the person's own permission rules and the task's
 * mode, which ask on its card or refuse.
 */
export function guardHookSource({ work, editTools, readingTool, refused, editReason, gitReason, unreadReason, readReason }: { readReason: string; work: string; editTools: readonly string[]; readingTool: RegExp; refused: { families: readonly { tool: RegExp; reason: string }[]; prefix: RegExp }; editReason: string; gitReason: string; unreadReason: string }): string {
  return [
    'import { realpathSync } from "node:fs";',
    'import { basename, dirname, resolve, sep } from "node:path";',
    'let text = "";',
    "for await (const chunk of process.stdin) text += chunk;",
    "let call = null;",
    "try { call = JSON.parse(text); } catch {}",
    'const deny = (reason) => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));',
    'const allow = (reason) => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: reason } }));',
    // A call it cannot read is denied: the hook is reached only for MCP and file-writing tools, and one it cannot name is not let through.
    'const name = call && typeof call.tool_name === "string" ? call.tool_name : null;',
    `const WORK = ${JSON.stringify(work)};`,
    // The real path of where a write lands, read through the deepest part that exists, so a link inside the folder that points out of it is followed.
    "const real = (path) => { const rest = []; for (let at = path; ; at = dirname(at)) { try { return resolve(realpathSync(at), ...rest.reverse()); } catch { if (dirname(at) === at) return null; rest.push(basename(at)); } } };",
    `if (name !== null && ${JSON.stringify(editTools)}.includes(name)) {`,
    "  const input = call.tool_input ?? {};",
    '  const target = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;',
    // A ".." is refused outright: read as text it can stay inside the folder while the system follows a link above it out.
    '  const where = target === null || target.split(/[\\\\/]/).includes("..") ? null : real(resolve(typeof call.cwd === "string" ? call.cwd : WORK, target));',
    `  if (where === null || (where !== WORK && !where.startsWith(WORK + sep))) deny(${JSON.stringify(editReason)});`,
    // A git directory's config names filters, diff drivers and signing programs that run as the person on their next commit.
    // Matched in any case: macOS and Windows folders read .GIT as .git.
    `  else if (where.slice(WORK.length).split(sep).some((part) => part.toLowerCase() === ".git")) deny(${JSON.stringify(gitReason)});`,
    `} else if (name === null) {`,
    `  deny(${JSON.stringify(unreadReason)});`,
    // mcp__<server>__<tool>, where either name can hold "__" itself: a tracker's or a forge's call reads only when every
    // way of splitting the name gives a reading tool, so no writing tool hides behind a reading last part; whoever's server it is.
    ...refused.families.flatMap(({ tool, reason }) => [
      `} else if (name.startsWith("mcp__") && ${tool.toString()}.test(name) && name.slice(5).split("__").slice(1).map((_, at, all) => all.slice(at).join("__")).some((part) => !${readingTool.toString()}.test(part.replace(${refused.prefix.toString()}, "")))) {`,
      `  deny(${JSON.stringify(reason)});`,
    ]),
    // Any server's tool that reads, by every way of splitting its name, runs; a deny rule of the guard's still holds over it.
    `} else if (name.startsWith("mcp__") && name.slice(5).split("__").slice(1).map((_, at, all) => all.slice(at).join("__")).every((part) => ${readingTool.toString()}.test(part.replace(${refused.prefix.toString()}, "")))) {`,
    `  allow(${JSON.stringify(readReason)});`,
    "}",
    "",
    
  ].join("\n");
}
