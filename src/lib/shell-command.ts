import { basename, isAbsolute, join, resolve } from "node:path";
import { statSync } from "node:fs";

/**
 * One command of a shell line, with its quoting already resolved: `words` are what the program
 * receives, `redirects` are where the shell itself sends output, and `then` is how the NEXT command
 * is joined to this one. That last part is what decides whether this command's exit status is the
 * one the whole line reports.
 */
export interface SimpleCommand {
  words: string[];
  redirects: { op: string; target: string }[];
  then: "&&" | "||" | ";" | "|" | "&" | null;
}

const OPERATORS = ["&&", "||", ";;", ";", "|&", "|", "&", "(", ")"];
const REDIRECTS = ["&>>", "&>", ">>", ">|", ">&", "<<<", "<<-", "<<", "<&", "<>", ">", "<"];

/**
 * Splits a command line into simple commands the way a shell would, closely enough to tell a
 * command from the text it carries. A `>` inside quotes, an awk program or a heredoc body is
 * text, not a redirect; reading it as one turns every quoted separator and every inline script
 * into a file the session supposedly wrote.
 */
export function simpleCommands(line: string): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], redirects: [], then: null };
  let word = "";
  let inWord = false;
  let pendingRedirect: string | null = null;
  const heredocs: { delimiter: string; strip: boolean }[] = [];
  let i = 0;

  const endWord = () => {
    if (!inWord) return;
    if (pendingRedirect) {
      if (pendingRedirect === "<<" || pendingRedirect === "<<-") {
        heredocs.push({ delimiter: word, strip: pendingRedirect === "<<-" });
      } else {
        current.redirects.push({ op: pendingRedirect, target: word });
      }
      pendingRedirect = null;
    } else {
      current.words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endCommand = (then: SimpleCommand["then"]) => {
    endWord();
    if (current.words.length || current.redirects.length) {
      current.then = then;
      out.push(current);
    } else if (then && out.length) {
      out[out.length - 1]!.then = then;
    }
    current = { words: [], redirects: [], then: null };
  };
  const skipHeredocBodies = () => {
    while (heredocs.length && i < line.length) {
      const { delimiter, strip } = heredocs.shift()!;
      while (i < line.length) {
        const end = line.indexOf("\n", i);
        const text = line.slice(i, end === -1 ? line.length : end);
        i = end === -1 ? line.length : end + 1;
        if ((strip ? text.replace(/^\t+/, "") : text) === delimiter) break;
      }
    }
  };

  while (i < line.length) {
    const c = line[i]!;
    if (c === "\\") {
      if (line[i + 1] === "\n") {
        i += 2;
        continue;
      }
      word += line[i + 1] ?? "";
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      const stop = end === -1 ? line.length : end;
      word += line.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length) {
          word += line[i + 1];
          i += 2;
        } else if (line[i] === "$" && line[i + 1] === "(") {
          const end = closingParen(line, i + 1);
          word += line.slice(i, end + 1);
          i = end + 1;
        } else {
          word += line[i];
          i++;
        }
      }
      inWord = true;
      i++;
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      const end = closingParen(line, i + 1);
      word += line.slice(i, end + 1);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === "`") {
      const end = line.indexOf("`", i + 1);
      const stop = end === -1 ? line.length : end;
      word += line.slice(i, stop + 1);
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (c === "#" && !inWord) {
      const end = line.indexOf("\n", i);
      i = end === -1 ? line.length : end;
      continue;
    }
    if (c === "\n") {
      endCommand(";");
      i++;
      skipHeredocBodies();
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }
    // A digit run directly before a redirect names the descriptor (`2>`), and is not a word.
    if (/[0-9]/.test(c) && !inWord) {
      const m = /^[0-9]+(?=[<>])/.exec(line.slice(i));
      if (m) {
        const op = REDIRECTS.find((r) => line.startsWith(r, i + m[0].length))!;
        endWord();
        pendingRedirect = `${m[0]}${op}`;
        i += m[0].length + op.length;
        continue;
      }
    }
    const redirect = REDIRECTS.find((r) => line.startsWith(r, i));
    if (redirect) {
      endWord();
      pendingRedirect = redirect;
      i += redirect.length;
      continue;
    }
    const operator = OPERATORS.find((o) => line.startsWith(o, i));
    if (operator) {
      endCommand(operator === "(" || operator === ")" || operator === ";;" ? ";" : operator === "|&" ? "|" : (operator as SimpleCommand["then"]));
      i += operator.length;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endCommand(null);
  return out;
}

function closingParen(line: string, open: number): number {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === "(") depth++;
    else if (line[i] === ")" && --depth === 0) return i;
  }
  return line.length - 1;
}

/** Output redirects that put a file on disk; `2>` is a log of the command, not work. */
const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "1>", "1>>", "1>|"]);

// Prefixes that run the next word as the command, so the program is whatever follows them.
const WRAPPERS = new Set(["sudo", "command", "nohup", "time", "nice", "exec", "env", "builtin"]);

/** The program and its arguments, past assignments and wrappers such as `timeout 600`. */
export function programOf(cmd: SimpleCommand): string[] {
  const words = [...cmd.words];
  while (words.length) {
    const first = words[0]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) words.shift();
    else if (WRAPPERS.has(first)) words.shift();
    else if (first === "timeout") {
      words.shift();
      while (words.length && words[0]!.startsWith("-")) words.shift();
      words.shift();
    } else break;
  }
  return words;
}

/**
 * Whether this command's exit status is what the line reports: true when every command after it
 * is joined by `&&`. `npm test | tail` reports tail's status, `npm test; echo done` reports echo's,
 * and reading either as a passing test would mark failed work green.
 */
export function statusReaches(cmds: SimpleCommand[], index: number): boolean {
  for (let i = index; i < cmds.length - 1; i++) if (cmds[i]!.then !== "&&") return false;
  return true;
}

/** Where `cd` left the shell before command `index`, or null once that can no longer be told. */
function directoryAt(cmds: SimpleCommand[], index: number, cwd: string, home: string): string | null {
  let dir: string | null = cwd;
  for (let i = 0; i < index; i++) {
    const words = programOf(cmds[i]!);
    if (words[0] !== "cd" && words[0] !== "pushd") continue;
    const target = words[1];
    dir = target && dir ? resolvePath(target, dir, home) : null;
  }
  return dir;
}

/** An absolute path for a target word, or null for anything a shell would still expand. */
export function resolvePath(target: string, dir: string, home: string): string | null {
  let path = target;
  if (path === "~" || path.startsWith("~/")) path = home + path.slice(1);
  else if (path.startsWith("$HOME/")) path = home + path.slice(5);
  else if (path.startsWith("${HOME}/")) path = home + path.slice(7);
  if (!path || /[$`*?[\]{}]/.test(path)) return null;
  if (path.startsWith("/dev/")) return null;
  return isAbsolute(path) ? resolve(path) : resolve(dir, path);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function operands(args: string[]): string[] {
  const out: string[] = [];
  let literal = false;
  for (const arg of args) {
    if (!literal && arg === "--") literal = true;
    else if (literal || !arg.startsWith("-") || arg === "-") out.push(arg);
  }
  return out;
}

/** The files `sed` edits in place, or none when it only prints. */
function sedTargets(args: string[]): string[] {
  let inPlace = false;
  let hasScript = false;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      files.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--in-place")) inPlace = true;
    else if (arg.startsWith("--expression=") || arg.startsWith("--file=")) hasScript = true;
    else if (arg === "--expression" || arg === "--file") {
      hasScript = true;
      i++;
    } else if (arg.startsWith("-") && arg.length > 1 && !arg.startsWith("--")) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (flag === "i") {
          inPlace = true;
          // BSD sed takes the backup suffix as its own word, and `''` is how it says "none".
          if (j === arg.length - 1 && args[i + 1] === "") i++;
          break;
        }
        if (flag === "e" || flag === "f") {
          hasScript = true;
          if (j === arg.length - 1) i++;
          break;
        }
      }
    } else files.push(arg);
  }
  if (!inPlace) return [];
  return hasScript ? files : files.slice(1);
}

/** Destinations of a copy or a move: the last operand, or each source inside it when it is a directory. */
function copyTargets(args: string[], dir: string, home: string): string[] {
  const words = operands(args);
  if (words.length < 2) return [];
  const destination = resolvePath(words[words.length - 1]!, dir, home);
  if (!destination) return [];
  const sources = words.slice(0, -1);
  if (sources.length > 1 || isDirectory(destination)) return sources.map((s) => join(destination, basename(s)));
  return [destination];
}

/** A `git` call's subcommand and its arguments, past the options that come before it. */
export function gitInvocation(args: string[], dir: string, home: string): { sub: string; rest: string[]; base: string } {
  let base = dir;
  let rest = args;
  while (rest.length && rest[0]!.startsWith("-")) {
    if (rest[0] === "-C" && rest[1]) {
      base = resolvePath(rest[1], base, home) ?? base;
      rest = rest.slice(2);
    } else rest = rest.slice(rest[0] === "-c" ? 2 : 1);
  }
  return { sub: rest[0] ?? "", rest: rest.slice(1), base };
}

/**
 * The files one command of a line changes on disk, as absolute paths. Only the target of a write
 * counts: a repository named on the command line, a path that is read, or text that merely looks
 * like a path says nothing about what changed.
 */
export function commandWrites(cmds: SimpleCommand[], index: number, cwd: string, home: string): string[] {
  const dir = directoryAt(cmds, index, cwd, home);
  if (!dir) return [];
  const cmd = cmds[index]!;
  const targets: string[] = [];
  const add = (word: string, base = dir) => {
    const path = resolvePath(word, base, home);
    if (path) targets.push(path);
  };
  for (const { op, target } of cmd.redirects) if (WRITE_REDIRECTS.has(op)) add(target);
  const [program, ...args] = programOf(cmd);
  switch (program ? basename(program) : "") {
    case "tee":
      for (const file of operands(args)) add(file);
      break;
    case "sed":
    case "gsed":
      for (const file of sedTargets(args)) add(file);
      break;
    case "cp":
    case "mv":
    case "install":
      targets.push(...copyTargets(args, dir, home));
      break;
    case "git": {
      const { sub, rest, base } = gitInvocation(args, dir, home);
      if (sub === "mv") targets.push(...copyTargets(rest, base, home));
      else if (sub === "rm") for (const file of operands(rest)) add(file, base);
      break;
    }
  }
  return targets;
}

/** Every file a command line changes on disk, once each. */
export function shellWriteTargets(line: string, cwd: string, home: string): string[] {
  const cmds = simpleCommands(line);
  return [...new Set(cmds.flatMap((_, index) => commandWrites(cmds, index, cwd, home)))];
}
