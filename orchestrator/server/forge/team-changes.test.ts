import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLUGIN_MANIFEST } from "../plugin.js";
import { manifestVersion, skillChanges, skillPatch, versionDiff } from "./team-changes.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/**
 * The payments-skills team repository through three versions: 1.0.0 with add-endpoint and
 * old-review, 1.1.0 changing add-endpoint, then 1.2.0 adding review-checklist and removing
 * old-review; each commit by its own stand-in author.
 */
function teamRepository() {
  const repo = mkdtempSync(join(tmpdir(), "team-changes-"));
  roots.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const commit = (by: string, subject: string) => {
    git("add", "-A");
    git("-c", `user.name=${by}`, "-c", "user.email=stand-in@example.invalid", "commit", "-q", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  const write = (path: string, text: string) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const version = (v: string) => write(PLUGIN_MANIFEST, `${JSON.stringify({ name: "payments-skills", version: v })}\n`);
  git("init", "-q", "-b", "main");
  version("1.0.0");
  write("skills/add-endpoint/SKILL.md", "# Add an endpoint\n");
  write("skills/old-review/SKILL.md", "# Review\n");
  write("commands/release.md", "Release it.\n");
  write(".mcp.json", `${JSON.stringify({ mcpServers: { jira: { url: "https://jira.example.invalid/mcp" }, postgres: { command: "pg-mcp" } } })}\n`);
  commit("Ada", "Start the handbook");
  write("skills/add-endpoint/SKILL.md", `# Add an endpoint\nWith its gateway entry.\nexport GH_TOKEN=${["ghp", "0123456789abcdefghijklmnopqrstuvwxyzAB"].join("_")}\n`);
  commit("Bea", "Add the gateway step");
  version("1.1.0");
  commit("Bea", "Release 1.1.0");
  write("skills/review-checklist/SKILL.md", "# Review checklist\n");
  rmSync(join(repo, "skills", "old-review"), { recursive: true });
  write("commands/standup.md", "Say what moved.\n");
  write(".mcp.json", `${JSON.stringify({ mcpServers: { jira: { url: "https://jira.example.invalid/mcp/v2" }, sentry: { url: "https://sentry.example.invalid/mcp" } } })}\n`);
  const last = commit("Cem", "Replace the old review");
  version("1.2.0");
  const head = commit("Cem", "Release 1.2.0");
  return { repo, head, last };
}

describe("what changed in a team repository's handbook", () => {
  it("given a repository through three versions, when its skills' last changes are read, then each skill names the commit that last touched it and a removed one is not named", async () => {
    // given
    const { repo, head, last } = teamRepository();

    // when
    const changes = await skillChanges(repo, head);

    // then
    expect(changes.get("review-checklist")).toEqual({ sha: last, at: expect.any(String), by: "Cem", subject: "Replace the old review" });
    expect(changes.get("add-endpoint")).toMatchObject({ by: "Bea", subject: "Add the gateway step" });
    expect([...changes.keys()].sort()).toEqual(["add-endpoint", "old-review", "review-checklist"]);
  });

  it("given a person on 1.0.0, one on 1.1.0, one on the current 1.2.0 and one on a version the repository never had, when the difference to the current version is read, then each gets what updating brings, and the unknown one gets none", async () => {
    // given
    const { repo, head } = teamRepository();

    // when
    const [fromFirst, fromSecond, current, unknown] = await Promise.all(["1.0.0", "1.1.0", "1.2.0", "0.9.0"].map((from) => versionDiff(repo, head, from)));

    // then
    expect(await manifestVersion(repo, head)).toBe("1.2.0");
    expect(fromFirst).toEqual({
      from: "1.0.0",
      to: "1.2.0",
      added: ["review-checklist"],
      changed: ["add-endpoint"],
      removed: ["old-review"],
      commands: { added: ["standup"], changed: [], removed: [] },
      mcpServers: { added: ["sentry"], changed: ["jira"], removed: ["postgres"] },
    });
    expect(fromSecond).toMatchObject({ from: "1.1.0", added: ["review-checklist"], changed: [], removed: ["old-review"] });
    expect(current).toMatchObject({ from: "1.2.0", to: "1.2.0", added: [], changed: [], removed: [], commands: { added: [], changed: [], removed: [] } });
    expect(JSON.stringify(fromFirst)).not.toContain("jira.example.invalid");
    expect(unknown).toBeNull();
  });

  it("given a person on 1.0.0, when add-endpoint's change is read before updating, then it is the diff of its folder since that version, a line that looks like a secret is held back, and a skill that did not change reads as none", async () => {
    // given
    const { repo, head } = teamRepository();

    // when
    const patch = await skillPatch(repo, head, "1.0.0", "add-endpoint");
    const unchanged = await skillPatch(repo, head, "1.1.0", "add-endpoint");

    // then
    expect(patch?.truncated).toBe(false);
    expect(patch?.patch).toContain("+With its gateway entry.");
    expect(patch?.patch).toContain("[withheld: a line that looks like it holds a");
    expect(patch?.patch).not.toContain("0123456789abcdefghij");
    expect(unchanged).toBeNull();
  });
});

