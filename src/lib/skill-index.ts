import { readdirSync, readFileSync } from "node:fs";
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

export function defaultSkillDirs(home: string = handbookHome(), cwd: string = process.cwd()): string[] {
  return [candidatesDir(home), join(cwd, ".claude", "skills")];
}

export function parseSkillFrontmatter(md: string): SkillSummary | null {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
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
