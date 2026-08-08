import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidatesDir,
  defaultSkillDirs,
  listExistingSkills,
  parseSkillFrontmatter,
} from "./skill-index.js";

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: "${description}"\n---\n\nBody.\n`;
}

function writeSkill(dir: string, name: string, description: string): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), skillMd(name, description));
}

describe("parseSkillFrontmatter", () => {
  it("reads name and description from quoted frontmatter", () => {
    expect(parseSkillFrontmatter(skillMd("fix-npm", 'handles "quoted" values'))).toEqual({
      name: "fix-npm",
      description: 'handles "quoted" values',
    });
  });

  it("reads unquoted values", () => {
    expect(parseSkillFrontmatter("---\nname: fix-npm\ndescription: plain text\n---\n")).toEqual({
      name: "fix-npm",
      description: "plain text",
    });
  });

  it.each([
    ["no frontmatter", "# just markdown"],
    ["missing description", "---\nname: fix-npm\n---\n"],
    ["missing name", "---\ndescription: x\n---\n"],
  ])("returns null on %s", (_label, md) => {
    expect(parseSkillFrontmatter(md)).toBeNull();
  });
});

describe("listExistingSkills", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("collects skills across directories sorted by name", () => {
    const dirA = join(home, "a");
    const dirB = join(home, "b");
    writeSkill(dirA, "zeta-skill", "last");
    writeSkill(dirB, "alpha-skill", "first");
    expect(listExistingSkills([dirA, dirB])).toEqual([
      { name: "alpha-skill", description: "first" },
      { name: "zeta-skill", description: "last" },
    ]);
  });

  it("keeps the first occurrence on duplicate names", () => {
    const dirA = join(home, "a");
    const dirB = join(home, "b");
    writeSkill(dirA, "same-skill", "from a");
    writeSkill(dirB, "same-skill", "from b");
    expect(listExistingSkills([dirA, dirB])).toEqual([{ name: "same-skill", description: "from a" }]);
  });

  it("skips missing directories, entries without SKILL.md, and invalid frontmatter", () => {
    const dir = join(home, "a");
    writeSkill(dir, "good-skill", "valid");
    mkdirSync(join(dir, "no-skill-file"), { recursive: true });
    mkdirSync(join(dir, "bad-frontmatter"), { recursive: true });
    writeFileSync(join(dir, "bad-frontmatter", "SKILL.md"), "# no frontmatter");
    expect(listExistingSkills([dir, join(home, "missing")])).toEqual([
      { name: "good-skill", description: "valid" },
    ]);
  });
});

describe("defaultSkillDirs", () => {
  it("covers the candidate queue and the project's local skills", () => {
    expect(defaultSkillDirs("/home/u/.teamhandbook", "/repo")).toEqual([
      candidatesDir("/home/u/.teamhandbook"),
      join("/repo", ".claude", "skills"),
    ]);
  });
});
