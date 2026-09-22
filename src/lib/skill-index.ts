import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { handbookHome } from "./session-state.js";

export interface SkillSummary {
  name: string;
  description: string;
  scope?: string;
}

export function candidatesDir(home: string = handbookHome()): string {
  return join(home, "candidates");
}

/** Where a lesson could already live: the review queue, this project, and the
 * user-level skills that load in every project. Missing the personal dir means a
 * lesson you KEPT is invisible to dedup and gets proposed again every session. */
export function defaultSkillDirs(home: string = handbookHome(), cwd: string = process.cwd()): string[] {
  return [candidatesDir(home), join(cwd, ".claude", "skills"), join(homedir(), ".claude", "skills")];
}

// A YAML block scalar header: `description: >-` and the indented lines that follow it are
// the value. Descriptions are long enough that hand-written skills reach for this
// routinely - 11 of the 23 installed on the machine this was measured on - and reading
// only the header gives every one of them the description ">-".
const BLOCK_SCALAR = /^[|>][-+]?\d*$/;

function foldBlockScalar(lines: string[], start: number, folded: boolean): { value: string; next: number } {
  const body: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (!/^\s/.test(line)) break;
    body.push(line.trim());
  }
  while (body.length && body.at(-1) === "") body.pop();
  // ">" folds its lines into one paragraph and keeps a blank line as a break; "|" keeps
  // every newline. Both are trimmed of the trailing blank lines "-" strips.
  const value = folded
    ? body.reduce((text, line) => (line === "" ? `${text}\n` : text === "" || text.endsWith("\n") ? text + line : `${text} ${line}`), "")
    : body.join("\n");
  return { value, next: i - 1 };
}

export function parseSkillFrontmatter(md: string): SkillSummary | null {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields = new Map<string, string>();
  const lines = match[1]!.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i]!.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (BLOCK_SCALAR.test(value)) {
      const block = foldBlockScalar(lines, i + 1, value.startsWith(">"));
      value = block.value;
      i = block.next;
    } else if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    fields.set(kv[1]!, value);
  }
  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !description) return null;
  const scope = fields.get("scope");
  return { name, description, ...(scope ? { scope } : {}) };
}

// A REJECTED candidate must not count as an "existing skill": rejecting once is
// not "never again", so the gate's dedup must not silently suppress the same
// learning forever. (Explicit suppression is the separate muted-fingerprints list.)
/**
 * Only a PENDING candidate blocks a new proposal. A decided one does not: an
 * approved candidate is represented by the skill it installed (which is listed from
 * the real skill dirs), so counting the archived copy too would mean a skill you
 * deleted could never be learned again - and a rejected one is meant to be
 * re-proposable unless you muted it with `reject --never`.
 */
function isDecidedCandidate(dir: string, entry: string): boolean {
  try {
    const meta = JSON.parse(readFileSync(join(dir, entry, "candidate.json"), "utf8"));
    return meta?.status === "rejected" || meta?.status === "approved";
  } catch {
    return false; // not a candidate dir (a plain skill), or unreadable - count it
  }
}

export function listExistingSkills(dirs: string[]): SkillSummary[] {
  const byName = new Map<string, SkillSummary>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (isDecidedCandidate(dir, entry)) continue;
      let raw: string;
      try {
        raw = readFileSync(join(dir, entry, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const summary = parseSkillFrontmatter(raw);
      if (summary && !byName.has(summary.name)) byName.set(summary.name, summary);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
