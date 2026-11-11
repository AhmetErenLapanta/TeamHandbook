import { expect, test } from "@playwright/test";
import { copyFile, machineOf, updateMarketplace } from "../machine.js";
import { ORGS } from "../orgs.js";
import type { LabOrg, LabRepo } from "../state.js";
import { as, builtIn, close, fileAt, lab, merge, needsTicket, ownerOf, runToReview, unique } from "./support.js";
import { labGit } from "../run.js";

const forgeName = (repo: LabRepo) => (repo.forge === "local" ? "the orchestrator's local forge" : repo.forge === "gitlab" ? "the stand-in GitLab" : "the stand-in GitHub");
const seedSkill = (org: LabOrg, repo: LabRepo) => ORGS.find((o) => o.name === org.name)!.teams.find((t) => t.id === repo.id)!.skills[0]!.slug;

/** The paths a request's branch changes against the default branch it was cut from. */
function changedPaths(repo: LabRepo, branch: string): string[] {
  return labGit(lab.path, ["diff", "--name-only", `HEAD...${branch}`], repo.bare).split("\n").filter(Boolean).sort();
}

test.describe("a task cut to one skill", () => {
  for (const org of builtIn) {
    const dev = org.developers[0]!;
    const repo = org.repos.find((r) => r.id === dev.repo)!;
    // A numbered repository's request also raises the plugin version; nothing else leaves the skill's folder.
    const allowed = (slug: string) => [`skills/${slug}/SKILL.md`, ...(repo.versioning === "number" ? [".claude-plugin/plugin.json"] : [])].sort();

    test(`given ${org.name}'s ${repo.id}, when its owner asks the stand-in agent to write a new skill from the template without a title, then the request on ${forgeName(repo)} holds only that skill, and once merged the teammate's copy has it`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const slug = unique("templated");

      // when
      const task = await runToReview(owner, repo, "", { template: { kind: "skill.write", skill: slug } });

      // then
      // A task that names an issue is titled after it.
      expect([task.status, task.error]).toEqual(["needs-review", null]);
      expect(task.title).toMatch(needsTicket(repo) ? /^Work on [A-Z]+-\d+$/ : new RegExp(`^Write the skill ${slug}$`));
      expect(changedPaths(repo, task.request!.branch)).toEqual(allowed(slug));
      expect(fileAt(repo, task.request!.branch, `skills/${slug}/SKILL.md`)).toMatch(new RegExp(`^---\\nname: ${slug}\\ndescription: Use when `));

      // when a person merges it
      await merge(org, repo, task.requestNumber!);
      const m = machineOf(lab, dev);
      updateMarketplace(m);

      // then
      expect(copyFile(m, `skills/${slug}/SKILL.md`)).toContain(`name: ${slug}`);
    });

    test(`given ${org.name}'s ${repo.id}, when its owner asks the stand-in agent to improve a skill the team has, then the request changes only that skill and keeps its name`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const slug = seedSkill(org, repo);

      // when
      const task = await runToReview(owner, repo, "", { template: { kind: "skill.improve", skill: slug } });
      try {
        // then
        expect([task.status, task.error]).toEqual(["needs-review", null]);
        expect(task.title).toMatch(needsTicket(repo) ? /^Work on [A-Z]+-\d+$/ : new RegExp(`^Improve the skill ${slug}$`));
        expect(changedPaths(repo, task.request!.branch)).toEqual(allowed(slug));
        expect(fileAt(repo, task.request!.branch, `skills/${slug}/SKILL.md`)).toContain(`name: ${slug}\n`);
        expect(fileAt(repo, task.request!.branch, `skills/${slug}/SKILL.md`)).not.toBe(fileAt(repo, "HEAD", `skills/${slug}/SKILL.md`));
      } finally {
        if (task.requestNumber !== null) await close(org, repo, task.requestNumber);
      }
    });

    test(`given ${org.name}'s ${repo.id} and a template task whose agent also changes a hook, when it ends, then it fails naming the file outside the skill's folder and no request is opened`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const slug = unique("strays");
      const before = (await owner.ok<{ total: number }>("GET", `/api/requests?repo=${repo.id}`)).total;

      // when
      const task = await runToReview(owner, repo, "", { template: { kind: "skill.write", skill: slug }, description: "stand-in: change a hook" });

      // then
      expect([task.status, task.requestNumber]).toEqual(["failed", null]);
      expect(task.error).toContain(`outside skills/${slug}/`);
      expect(task.error).toContain("hooks/notice.mjs");
      expect((await owner.ok<{ total: number }>("GET", `/api/requests?repo=${repo.id}`)).total).toBe(before);
    });
  }

  test("given each organization, when a template names a skill the wrong way round, a name that is no slug, or comes from a member, then it is refused before anything runs", async () => {
    for (const org of builtIn) {
      // given
      const repo = org.repos.find((r) => r.id === org.developers[0]!.repo)!;
      const owner = await ownerOf(org, repo);
      const member = await as(org, "member");
      // A repository whose branches start with a ticket takes an issue too, so the template's own checks are what answer.
      const issue = needsTicket(repo) ? { issueUrl: `https://tracker.example.invalid/browse/${/^([A-Z][A-Z0-9]*)-/.exec(repo.branchExample!)![1]}-321` } : {};
      const ask = (who: typeof owner, template: unknown) => who.call<{ error?: string }>("POST", "/api/tasks", { title: "", repoId: repo.id, agent: "fake", template, ...issue });
      const before = (await owner.ok<{ tasks: unknown[] }>("GET", `/api/tasks?repo=${repo.id}`)).tasks.length;

      // when
      const existing = await ask(owner, { kind: "skill.write", skill: seedSkill(org, repo) });
      const missing = await ask(owner, { kind: "skill.improve", skill: unique("not-there") });
      const unnamed = await ask(owner, { kind: "skill.write", skill: "Not A Slug" });
      const stranger = await ask(member, { kind: "skill.write", skill: unique("member") });

      // then
      expect([existing.status, existing.json.error]).toEqual([409, `${repo.id} already has the skill ${seedSkill(org, repo)}; improve it instead`]);
      expect([missing.status, missing.json.error?.startsWith(`${repo.id} has no skill `)]).toEqual([409, true]);
      expect(unnamed.status).toBe(400);
      expect(stranger.status).toBe(403);
      expect((await owner.ok<{ tasks: unknown[] }>("GET", `/api/tasks?repo=${repo.id}`)).tasks.length).toBe(before);
    }
  });
});
