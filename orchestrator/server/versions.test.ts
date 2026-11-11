import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../demo/seed.js";
import { mirrorDir, syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { Principal } from "./auth.js";
import { prepareChange } from "./changes.js";
import { localRepoPath } from "./forge/local.js";
import { git } from "./git.js";
import { readInventory } from "./inventory.js";
import { propose } from "./propose.js";
import { openSqliteStore } from "./store.js";
import { versionLineBack, versionRaise, versionRaiseNote } from "./versions.js";
import { mkdirSync } from "node:fs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OWNER: Principal = { id: "p", name: "Pat Example", email: "pat@example.invalid", role: "member", ownedTeams: ["Payments"] };
const SKILL = (name: string) => `---\nname: ${name}\ndescription: Use at shift change to hand over the pager.\n---\n\n1. Write the handover.\n`;

/** The seeded Payments repository, its plugin's version line set to `version` (or removed for null) on main. */
async function payments(version: string | null): Promise<{ ctx: OrchestratorContext; bare: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-versions-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  const entry = config.repos.find((r: { id: string }) => r.id === "payments-skills");
  await ctx.store.upsertRepo({ ...entry, tenant: config.tenant });
  const bare = localRepoPath(entry.url)!;
  commitManifest(bare, root, "main", "main", version);
  await syncRepo(ctx, "payments-skills");
  return { ctx, bare, root };
}

/** Writes the manifest's version on `branch`, starting from `from`, the way a teammate's push would. */
function commitManifest(bare: string, root: string, from: string, branch: string, version: string | null): void {
  const work = mkdtempSync(join(root, "work-"));
  git(["clone", "--quiet", "--branch", from, bare, work], work);
  const file = join(work, ".claude-plugin", "plugin.json");
  const { version: _old, ...rest } = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify(version === null ? rest : { ...rest, version }, null, 2) + "\n");
  git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-qam", `chore: version ${version}`], work);
  git(["fetch", "--quiet", work, `HEAD:refs/heads/${branch}`], bare);
}

describe("the version an orchestrator request raises the plugin to", () => {
  it("given unmerged branches that already claim higher versions, when a raise is computed, then it goes one patch past the highest and names them", async () => {
    // given
    const { ctx, bare, root } = await payments("0.1.5");
    commitManifest(bare, root, "main", "handbook/share-a", "0.1.6");
    commitManifest(bare, root, "main", "handbook/share-b", "0.1.9");
    commitManifest(bare, root, "main", "handbook/older", "0.1.5");
    await syncRepo(ctx, "payments-skills");
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head!;

    // when
    const raise = await versionRaise(mirrorDir(ctx, "payments-skills"), head);

    // then
    expect(raise!.version).toBe("0.1.10");
    expect(raise!.past).toEqual([
      { branch: "handbook/share-a", version: "0.1.6" },
      { branch: "handbook/share-b", version: "0.1.9" },
    ]);
    expect(JSON.parse(raise!.file.content!).version).toBe("0.1.10");
    expect(versionRaiseNote(raise!)).toBe("Raises the plugin to version 0.1.10, past 0.1.6 on handbook/share-a and 0.1.9 on handbook/share-b, which are not merged yet, so teammates fetch it once this is merged.");
  });

  it.each([
    ["versioned by commit", null],
    ["a version that is not MAJOR.MINOR.PATCH", "1.2"],
  ])("given a repository %s, when a raise is computed, then there is none", async (_label, version) => {
    // given
    const { ctx } = await payments(version);
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head!;

    // when
    const raise = await versionRaise(mirrorDir(ctx, "payments-skills"), head);

    // then
    expect(raise).toBeNull();
  });

  it("given a request just opened from the orchestrator, when the next one is prepared, then it raises past the first instead of to the same number", async () => {
    // given
    const { ctx, bare } = await payments("0.1.5");
    const open = async (slug: string) => {
      const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
      const prepared = await prepareChange(mirrorDir(ctx, repo.id), repo.head!, { kind: "skill.add", slug, content: SKILL(slug) }, `feat(skill): add ${slug}`, "Pat");
      return propose(ctx, repo, OWNER, prepared);
    };
    const first = await open("on-call");

    // when
    const second = await open("handover");

    // then
    expect(JSON.parse(git(["show", `${first.branch}:.claude-plugin/plugin.json`], bare)).version).toBe("0.1.6");
    expect(JSON.parse(git(["show", `${second.branch}:.claude-plugin/plugin.json`], bare)).version).toBe("0.1.7");
  });
});

describe("the default branch moving on while a change is prepared", () => {
  it("given main raised past the version a change was prepared from, when the raise is described, then main is named as reached, not as unmerged", async () => {
    // given
    const { ctx, bare, root } = await payments("0.1.5");
    const prepared = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head!;
    commitManifest(bare, root, "main", "main", "0.1.6");
    commitManifest(bare, root, "main", "handbook/share-a", "0.1.8");
    await syncRepo(ctx, "payments-skills");

    // when
    const raise = (await versionRaise(mirrorDir(ctx, "payments-skills"), prepared))!;

    // then
    expect(raise.version).toBe("0.1.9");
    expect(versionRaiseNote(raise)).toBe("Raises the plugin to version 0.1.9, past 0.1.6, which main reached since this change was prepared, and past 0.1.8 on handbook/share-a, which is not merged yet, so teammates fetch it once this is merged.");
  });
});

describe("a version line that came back", () => {
  /** A repository whose plugin manifest goes through `versions` in order, null for a manifest without the line, each commit by `author`. */
  function history(versions: (string | null)[], author = "Grace Example <grace@example.invalid>"): string {
    const repo = mkdtempSync(join(tmpdir(), "orchestrator-version-back-"));
    dirs.push(repo);
    git(["init", "--quiet", "--initial-branch", "main"], repo);
    mkdirSync(join(repo, ".claude-plugin"));
    for (const [i, version] of versions.entries()) {
      writeFileSync(join(repo, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "payments-skills", ...(version === null ? {} : { version }) }, null, 2) + "\n");
      writeFileSync(join(repo, `step-${i}.md`), "step\n");
      git(["add", "-A"], repo);
      git(["commit", "--quiet", "--author", author, "-m", `chore: step ${i}`], repo);
    }
    return repo;
  }

  it("given a repository switched to versioning by commit and then given a version again, when it is read, then the commit that put it back and its author are named", async () => {
    // given
    const repo = history(["0.1.5", null, null, "0.1.5"], "Old Teammate <old@example.invalid>");

    // when
    const back = await versionLineBack(repo, "HEAD");

    // then
    expect(back).toMatchObject({ sha: git(["rev-parse", "HEAD"], repo).trim(), author: "Old Teammate", version: "0.1.5" });
  });

  it.each([
    ["a repository that carried a version from its first commit and only raised it", ["0.1.0", "0.1.1", "0.1.2"]],
    ["a repository still versioned by commit after the switch", ["0.1.0", null, null]],
  ])("given %s, when it is read, then nothing came back", async (_label, versions) => {
    expect(await versionLineBack(history(versions), "HEAD")).toBeNull();
  });

  it("given the demo's repository, versioned by commit, given a version by a later push, when its inventory is read, then the setup panel says the line came back", async () => {
    // given
    const { ctx } = await payments("0.1.5");

    // when
    const inventory = await readInventory(mirrorDir(ctx, "payments-skills"));

    // then
    expect(inventory.setup.map((f) => `${f.level}: ${f.title}`)).toContain("attention: The version line came back");
  });

  it("given a share branched before the switch, merged with its conflict resolved on the side with the version, when it is read, then the merge is the commit named", async () => {
    // given
    const repo = history(["0.1.0"]);
    const manifest = join(repo, ".claude-plugin", "plugin.json");
    git(["checkout", "--quiet", "-b", "share"], repo);
    writeFileSync(manifest, JSON.stringify({ name: "payments-skills", version: "0.1.1" }, null, 2) + "\n");
    git(["commit", "--quiet", "-am", "feat(skill): a share from an older TeamHandbook"], repo);
    git(["checkout", "--quiet", "main"], repo);
    writeFileSync(manifest, JSON.stringify({ name: "payments-skills" }, null, 2) + "\n");
    git(["commit", "--quiet", "-am", "chore: switch to versioning by commit"], repo);
    git(["merge", "--quiet", "--no-commit", "-X", "theirs", "share"], repo);
    git(["commit", "--quiet", "--no-edit", "--author", "Merging Teammate <merge@example.invalid>"], repo);

    // when
    const back = await versionLineBack(repo, "HEAD");

    // then
    expect(back).toMatchObject({ sha: git(["rev-parse", "HEAD"], repo).trim(), author: "Merging Teammate", version: "0.1.1" });
  });

  it("given a version put back and then raised again, when it is read, then the commit that put it back is still the one named", async () => {
    // given
    const repo = history(["0.1.0", null, "0.1.4", "0.1.5"]);
    const putBack = git(["rev-parse", "HEAD~1"], repo).trim();

    // when
    const back = await versionLineBack(repo, "HEAD");

    // then
    expect(back).toMatchObject({ sha: putBack, version: "0.1.4" });
  });
});
