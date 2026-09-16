import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join } from "node:path";

// candidate.json is the queue's own bookkeeping, not part of the skill: it carries the
// session id and the absolute cwd the lesson was captured in, so copying it into a team
// repository would publish one developer's machine layout. writeFileAtomic can leave a
// candidate.json.tmp-<pid>-... sibling behind when a write is interrupted, so the whole
// prefix is excluded rather than the exact name.
function isQueueBookkeeping(name: string): boolean {
  return name.startsWith("candidate.json");
}

export interface SkillFiles {
  /** paths relative to the skill directory, depth first and sorted for a stable copy order */
  files: string[];
  /**
   * Entries that are neither a regular file nor a directory - symlinks above all.
   * Copying one follows it wherever it points, which may be outside the skill; dropping
   * one silently is the pruning bug this module exists to stop. So the walk reports them
   * and the caller that owns a trust boundary refuses the whole skill instead.
   */
  skipped: string[];
}

/**
 * Every file a skill directory is made of.
 *
 * A skill is not just its SKILL.md. Measured on one real machine, 7 of 21 installed
 * skills carry something else next to it - a preflight script, a reference SQL file, a
 * server the skill starts - and those are the working parts. A copy that moves two known
 * filenames hands the person on the other end a skill that installs, looks complete, and
 * breaks at the moment they run it.
 */
export function listSkillFiles(dir: string): SkillFiles {
  const files: string[] = [];
  const skipped: string[] = [];
  const walk = (current: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      // only at the root: a nested candidate.json is a file the skill chose to ship
      if (prefix === "" && isQueueBookkeeping(entry.name)) continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
      else skipped.push(rel);
    }
  };
  walk(dir, "");
  return { files, skipped };
}

/**
 * Install a skill directory: its SKILL.md, plus every other file it carries.
 *
 * SKILL.md is passed in rather than copied because the caller has already read it (so an
 * unreadable candidate fails before a half-built directory exists) and may have rewritten
 * its frontmatter name for a suffixed slug.
 *
 * `files` defaults to a fresh walk, which is what the delivery paths want. A caller that
 * screened the files first passes the exact list it screened, so the set that was cleared
 * and the set that gets copied cannot drift apart.
 */
export function copySkillPayload(
  srcDir: string,
  destDir: string,
  skillMd: string,
  files: string[] = listSkillFiles(srcDir).files,
): void {
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, "SKILL.md"), skillMd);
  for (const rel of files) {
    if (rel === "SKILL.md") continue;
    const target = join(destDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(srcDir, rel), target);
  }
}
