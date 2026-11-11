import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { copyFile, createMachine, doctor, joinTeam, machineOf, updateMarketplace } from "../machine.js";
import { labGit } from "../run.js";
import { ownerKey } from "../state.js";
import type { LabOrg, LabRepo } from "../state.js";
import plugin from "../../../package.json" with { type: "json" };
import { as, close, commitOnDefault, fileAt, lab, merge, openRepo, ownerOf, pick, propose, runToReview, SHAPES, signInOnPage, TASK_PAGE, teammateOn, unique, whileChanged } from "./support.js";

interface Finding {
  level: string;
  title: string;
}



async function inventoryOf(org: LabOrg, repo: LabRepo) {
  return (await as(org, "member")).ok<{ inventory: { setup: Finding[] }; join: { url?: string; use?: string[]; contribute?: string; problem?: string } }>("GET", `/api/repos/${repo.id}/inventory`);
}

const titles = async (org: LabOrg, repo: LabRepo) => (await inventoryOf(org, repo)).inventory.setup.map((f) => f.title);
const versionAt = (repo: LabRepo, ref: string) => (JSON.parse(fileAt(repo, ref, ".claude-plugin/plugin.json") ?? "{}") as { version?: string }).version;
const changedPaths = (repo: LabRepo, branch: string) => labGit(lab.path, ["diff", "--name-only", `HEAD...${branch}`], repo.bare).split("\n").filter(Boolean);
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";


test.describe("refreshing a team repository's scaffold, with no agent", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, left with an old scaffold by a teammate's merge, when its owner refreshes the scaffold and the request is merged, then the teammate's doctor stops warning, a new teammate joins at the memberUrl, and the panel says current`, async () => {
      // given a scaffold an older TeamHandbook wrote, missing a file today's writes
      const m = teammateOn(org, repo);
      const team = JSON.parse(fileAt(repo, "HEAD", ".teamhandbook.json")!) as Record<string, unknown>;
      commitOnDefault(repo, { ".teamhandbook.json": json({ ...team, scaffoldVersion: "0.20.0" }), "hooks/hooks.json": null }, "chore: an older scaffold");
      await (await as(org, "admin")).ok("POST", `/api/repos/${repo.id}/sync`);
      updateMarketplace(m);
      expect(doctor(m).teamRepo).toMatch(/^⚠ team repo: .* reachable, but 1 scaffold file\(s\) this version ships are not in it at all/);
      expect(await titles(org, repo)).toEqual(expect.arrayContaining(["TeamHandbook's files are out of date", "Teammates are not told when new skills arrive"]));
      const before = versionAt(repo, "HEAD");

      // when
      const task = await runToReview(await ownerOf(org, repo), repo, "", { template: { kind: "scaffold.refresh" } });

      // then the request writes scaffold files only, and raises a number where there is one
      expect([task.status, task.error, task.agent]).toEqual(["needs-review", null, "orchestrator"]);
      const paths = changedPaths(repo, task.request!.branch);
      expect(paths).toEqual(expect.arrayContaining(["hooks/hooks.json", ".teamhandbook.json"]));
      expect(paths.filter((p) => /^(skills|commands|agents)\/|^\.mcp\.json$/.test(p))).toEqual([]);
      expect(JSON.parse(fileAt(repo, task.request!.branch, ".teamhandbook.json")!).scaffoldVersion).toBe(plugin.version);
      if (repo.versioning === "number") expect(versionAt(repo, task.request!.branch)).not.toBe(before);
      else expect(versionAt(repo, task.request!.branch)).toBeUndefined();

      // when a person merges it and the teammate's marketplace updates
      await merge(org, repo, task.requestNumber!);
      updateMarketplace(m);

      // then
      expect(doctor(m).teamRepo).toMatch(/^✔ team repo: .* reachable$/);
      expect(doctor(m).teamCopy).toMatch(/^✔ team plugin copy/);
      expect(copyFile(m, "hooks/hooks.json")).not.toBeNull();
      expect(fileAt(repo, "HEAD", "README.md")).toContain(`/plugin marketplace add ${repo.memberUrl}`);
      if (repo.forge !== "local") expect(fileAt(repo, "HEAD", "README.md")).not.toContain(repo.url);
      const { inventory, join: joining } = await inventoryOf(org, repo);
      expect(inventory.setup.map((f) => f.title)).toEqual(expect.arrayContaining(["Up to date"]));
      expect(inventory.setup.filter((f) => f.level === "attention" || f.level === "problem")).toEqual([]);
      expect(joining).toEqual({ url: repo.memberUrl, use: [`/plugin marketplace add ${repo.memberUrl}`, `/plugin install ${repo.id}@${repo.id}`], contribute: `/handbook:join ${repo.memberUrl}` });
      const newcomer = machineOf(lab, createMachine(join(org.dir, "devs"), unique("newcomer")));
      const joined = joinTeam(newcomer, repo.memberUrl!);
      expect(joined.status).toBe(0);
      expect(joined.stdout).toContain(`/plugin marketplace add ${repo.memberUrl}`);
    });
  }

  test("given a scaffold that is already current, when its owner refreshes it, then the task ends without a request and says why", async () => {
    // given
    const { org, repo } = pick("acme", "mobile-skills");

    // when
    const task = await runToReview(await ownerOf(org, repo), repo, "", { template: { kind: "scaffold.refresh" } });

    // then
    expect([task.status, task.requestNumber]).toEqual(["failed", null]);
    expect(task.error).toBe(`The scaffold is already what TeamHandbook ${plugin.version} writes; no request was opened.`);
  });

  test("given a repository whose configuration gives no memberUrl, when its owner asks for a refresh, then it is refused before a task starts, and the page says to set the address instead of showing join commands", async () => {
    // given
    const { org, repo } = pick("initech", "support-skills");
    expect(repo.memberUrl).toBeNull();
    const owner = await ownerOf(org, repo);
    const before = (await owner.ok<{ tasks: unknown[] }>("GET", `/api/tasks?repo=${repo.id}`)).tasks.length;

    // when
    const asked = await owner.call<{ error?: string }>("POST", "/api/tasks", { title: "", repoId: repo.id, agent: "fake", template: { kind: "scaffold.refresh" } });

    // then
    expect([asked.status, asked.json.error]).toEqual([409, `${repo.id} has no memberUrl in the orchestrator's configuration: the scaffold writes the address teammates add the repository by, so it is not refreshed without one`]);
    expect((await owner.ok<{ tasks: unknown[] }>("GET", `/api/tasks?repo=${repo.id}`)).tasks.length).toBe(before);
    expect((await inventoryOf(org, repo)).join.problem).toContain("Set memberUrl for it in the orchestrator's configuration file");
  });
});

test.describe("switching a repository to versioning by commit", () => {
  test("given a numbered repository and a teammate on its version, when its owner switches it and the request is merged, then the teammate's doctor follows the commit, updates arrive by commit, and later edits raise no version", async () => {
    // given
    const { org, repo } = pick("acme", "billing-skills");
    test.skip(versionAt(repo, "HEAD") === undefined, "an earlier run switched this repository; a fresh lab switches it again");
    const owner = await ownerOf(org, repo);
    const m = teammateOn(org, repo);
    updateMarketplace(m);
    const before = versionAt(repo, "HEAD")!;
    expect(doctor(m).teamCopy).toBe(`✔ team plugin copy: this machine's marketplace copy is at v${before}, the team repo at v${before}`);

    // when
    const task = await runToReview(owner, repo, "", { template: { kind: "scaffold.refresh", commitVersioning: true } });

    // then the request takes the version line out and says what teammates do
    expect([task.status, task.error]).toEqual(["needs-review", null]);
    expect(changedPaths(repo, task.request!.branch)).toEqual(expect.arrayContaining([".claude-plugin/plugin.json"]));
    expect(versionAt(repo, task.request!.branch)).toBeUndefined();

    // when a person merges it
    await merge(org, repo, task.requestNumber!);

    // then the teammate is told their copy is behind, by commit, until it updates
    expect(doctor(m).teamCopy).toMatch(/^⚠ team plugin copy: this machine's marketplace copy is at commit [0-9a-f]{12} but the team repo is at [0-9a-f]{12}/);
    updateMarketplace(m);
    expect(doctor(m).teamCopy).toMatch(/^✔ team plugin copy: this machine's marketplace copy is at commit [0-9a-f]{12}, the same as the team repo$/);
    expect(await titles(org, repo)).toEqual(expect.arrayContaining(["Every merge reaches teammates"]));

    // when a later edit is merged
    const slug = unique("after-switch");
    const text = `---\nname: ${slug}\ndescription: Use when the lab checks an edit after the switch.\n---\n\nBody.\n`;
    const edit = await propose(owner, org, repo, { kind: "skill.add", slug, content: text }, `add ${slug}`);
    expect(edit.status, edit.error).toBe(200);
    expect(changedPaths(repo, edit.request!.branch)).toEqual([`skills/${slug}/SKILL.md`]);
    await merge(org, repo, edit.request!.number);

    // then it reaches the teammate by commit alone
    expect(doctor(m).teamCopy).toMatch(/^⚠ team plugin copy: .* at commit /);
    updateMarketplace(m);
    expect(doctor(m).teamCopy).toMatch(/the same as the team repo$/);
    expect(copyFile(m, `skills/${slug}/SKILL.md`)).toBe(text);

    // and asking again is refused
    const again = await runToReview(owner, repo, "", { template: { kind: "scaffold.refresh", commitVersioning: true } });
    expect([again.status, again.requestNumber, again.error]).toEqual(["failed", null, "The repository is already versioned by commit: .claude-plugin/plugin.json carries no version. No request was opened."]);
  });

  test("given a repository that runs the version-bump CI job, when its owner asks to switch it to versioning by commit, then the task ends without a request, naming the job", async () => {
    // given
    const { org, repo } = pick("vandelay", "release-skills");
    expect(repo.ci).toBe(true);
    const owner = await ownerOf(org, repo);
    expect(await titles(org, repo)).toEqual(expect.arrayContaining(["Each merge raises the version"]));

    // when
    const task = await runToReview(owner, repo, "", { template: { kind: "scaffold.refresh", commitVersioning: true } });
    try {
      // then
      expect([task.status, task.requestNumber]).toEqual(["failed", null]);
      expect(task.error).toContain("The repository runs the version-bump job (scripts/bump-version.mjs)");
      expect(versionAt(repo, "HEAD")).toBeDefined();
    } finally {
      if (task.requestNumber !== null) await close(org, repo, task.requestNumber);
    }
  });

  test("given a repository with the version-bump CI job whose team file a teammate gave a new prefix, the way the orchestrator's refusal advises, when its owner refreshes the scaffold, then the request rewrites the CI job for the new prefix", async () => {
    // given
    const { org, repo } = pick("vandelay", "release-skills");
    const owner = await ownerOf(org, repo);
    const team = JSON.parse(fileAt(repo, "HEAD", ".teamhandbook.json")!) as Record<string, unknown>;
    await whileChanged(org, repo, { ".teamhandbook.json": json({ ...team, commitPrefix: "VAN-9" }) }, async () => {
      // when
      const task = await runToReview(owner, repo, "", { template: { kind: "scaffold.refresh" } });
      try {
        // then
        expect([task.status, task.error]).toEqual(["needs-review", null]);
        expect(changedPaths(repo, task.request!.branch)).toEqual(expect.arrayContaining([".gitlab-ci.yml"]));
        expect(fileAt(repo, task.request!.branch, ".gitlab-ci.yml")).toContain("VAN-9");
      } finally {
        if (task.requestNumber !== null) await close(org, repo, task.requestNumber);
      }
    });
  });
});

async function signedIn(browser: Browser, org: LabOrg, key: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInOnPage(page, org, key);
  return { page, close: () => context.close() };
}

test.describe("the refresh offered on the setup panel", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, whose scaffold a teammate's merge left behind, when its owner presses Update TeamHandbook's files on its page, then the orchestrator's own task opens a request, and a member is not offered the button`, async ({ browser }) => {
      await whileChanged(org, repo, { "hooks/hooks.json": null }, async () => {
        // given
        const member = await signedIn(browser, org, "member");
        await openRepo(member.page, org, repo.id);
        await expect(member.page.getByRole("region", { name: /^Setup/ })).toContainText("Teammates are not told when new skills arrive");
        await expect(member.page.getByRole("button", { name: "Update TeamHandbook's files" })).toHaveCount(0);
        await member.close();
        const owner = await signedIn(browser, org, ownerKey(repo.team));
        await openRepo(owner.page, org, repo.id);

        // when
        await owner.page.getByRole("button", { name: "Update TeamHandbook's files" }).click();

        // then
        await expect(owner.page).toHaveURL(TASK_PAGE);
        const id = TASK_PAGE.exec(owner.page.url())![1]!;
        await owner.close();
        const api = await ownerOf(org, repo);
        let task = (await api.ok<{ task: { status: string; agent: string; requestNumber: number | null; request: { branch: string } | null } }>("GET", `/api/tasks/${id}`)).task;
        for (let i = 0; i < 240 && !["needs-review", "failed"].includes(task.status); i++) {
          await new Promise((r) => setTimeout(r, 250));
          task = (await api.ok<{ task: typeof task }>("GET", `/api/tasks/${id}`)).task;
        }
        try {
          expect([task.status, task.agent]).toEqual(["needs-review", "orchestrator"]);
          expect(changedPaths(repo, task.request!.branch)).toEqual(expect.arrayContaining(["hooks/hooks.json"]));
        } finally {
          if (task.requestNumber !== null) await close(org, repo, task.requestNumber);
        }
      });
    });
  }

  test("given a repository whose configuration gives no memberUrl and whose scaffold is behind, when its owner opens its page, then the panel says why the orchestrator does not refresh it instead of offering the button", async ({ browser }) => {
    const { org, repo } = pick("initech", "support-skills");
    await whileChanged(org, repo, { "hooks/hooks.json": null }, async () => {
      // when
      const owner = await signedIn(browser, org, ownerKey(repo.team));
      await openRepo(owner.page, org, repo.id);

      // then
      const region = owner.page.getByRole("region", { name: /^Setup/ });
      await expect(region).toContainText("Teammates are not told when new skills arrive");
      await expect(region).toContainText("set memberUrl for it and restart the orchestrator");
      await expect(owner.page.getByRole("button", { name: "Update TeamHandbook's files" })).toHaveCount(0);
      await owner.close();
    });
  });
});
