import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The product was renamed from console to orchestrator with no alias left behind (BR-2), so the old
// word in a path, a setting, a ref or a key is a leftover that ships. JavaScript's own console object
// is not the word; a file or line that names the old word on purpose is listed, with its reason, in
// old-name.exceptions.json.
const SELF = ["server/old-name.test.ts", "server/old-name.exceptions.json"];
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|gz|tgz|zip)$/i;
// console.log and its family, console[name], and the object handed on as an argument: the runtime's console, not the old name.
const RUNTIME_CONSOLE = /console\s*(\.\s*(log|error|warn|info|debug|trace|table|dir|time|timeEnd|group|groupEnd|assert|count)\b|\[)|\(\s*console\s*[,)]/g;

interface Exceptions {
  files: Record<string, string>;
  lines: { file: string; pattern: string; reason: string }[];
  anywhere: { pattern: string; reason: string }[];
}

const exceptions = JSON.parse(readFileSync(new URL("./old-name.exceptions.json", import.meta.url), "utf8")) as Exceptions;
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).split("\0").filter(Boolean);

function leftovers(): string[] {
  const found: string[] = [];
  for (const file of tracked) {
    if (/console/i.test(file)) found.push(`${file}: the path`);
    if (SELF.includes(file) || Object.hasOwn(exceptions.files, file) || BINARY.test(file) || file.endsWith("package-lock.json")) continue;
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    if (text.includes("\0")) continue;
    const allowed = [...exceptions.lines.filter((e) => e.file === file), ...exceptions.anywhere].map((e) => new RegExp(e.pattern, "gi"));
    text.split("\n").forEach((line, i) => {
      const rest = allowed.reduce((left, pattern) => left.replace(pattern, ""), line.replace(RUNTIME_CONSOLE, ""));
      if (/console/i.test(rest)) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  return found;
}

describe("the old product name", () => {
  it("given every file the orchestrator tracks, when its paths and lines are read, then none says console outside JavaScript's console and the listed exceptions", () => {
    expect(leftovers(), "rename the leftover, or list it with its reason in server/old-name.exceptions.json").toEqual([]);
  });

  it("given the exceptions, when each is checked against the files, then every listed file exists and every listed line still matches, so the list never outlives what it excuses", () => {
    const stale = [
      ...Object.keys(exceptions.files).filter((file) => !tracked.includes(file)),
      ...exceptions.lines.filter((e) => !tracked.includes(e.file) || !new RegExp(e.pattern, "i").test(readFileSync(new URL(`../${e.file}`, import.meta.url), "utf8"))).map((e) => `${e.file}: ${e.pattern}`),
    ];
    expect(stale).toEqual([]);
  });
});
