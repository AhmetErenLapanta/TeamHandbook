import { expect, test } from "@playwright/test";
import { copyFile, doctor, machineOf, updateMarketplace } from "../machine.js";
import { ORGS } from "../orgs.js";
import type { LabRepo } from "../state.js";
import { builtIn, close, fileAt, lab, merge, onForge, ownerOf, runToReview, unique } from "./support.js";
import type { ShownTask } from "./support.js";

const versionAt = (repo: LabRepo, ref: string) => (JSON.parse(fileAt(repo, ref, ".claude-plugin/plugin.json") ?? "{}") as { version?: string }).version;
const forgeName = (repo: LabRepo) => (repo.forge === "local" ? "the orchestrator's local forge" : repo.forge === "gitlab" ? "the stand-in GitLab" : "the stand-in GitHub");

test.describe("a task run by the stand-in agent", () => {
  for (const org of builtIn) {
    const dev = org.developers[0]!;
    const repo = org.repos.find((r) => r.id === dev.repo)!;

    test(`given ${org.name}'s ${repo.id}, when its owner hands a task to the stand-in agent, then it waits for review with a request on ${forgeName(repo)}, and once a person merges it the teammate's copy holds the agent's skill`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const title = unique("Lab task");
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");

      // when
      const task = await runToReview(owner, repo, title);

      // then
      expect([task.status, task.error]).toEqual(["needs-review", null]);
      expect(task.request).toMatchObject({ status: "open", provider: repo.forge });
      if (repo.forge !== "local") expect(await onForge(repo, task.requestNumber!)).toMatchObject({ state: "opened", source: task.request!.branch });
      // The repository names no MCP tool a task may call, so each of the team's servers stays
      // out, a browser-login one included, and the log says which.
      const servers = Object.keys(ORGS.find((o) => o.name === org.name)!.teams.find((t) => t.id === repo.id)!.mcp ?? {});
      const { log } = await owner.ok<{ log: { text: string }[] }>("GET", `/api/tasks/${task.id}`);
      const leftOut = log.map((l) => l.text).find((t) => t.startsWith("MCP servers left out")) ?? "";
      for (const name of servers) expect(leftOut).toContain(name);

      // when a person merges the request
      await merge(org, repo, task.requestNumber!);

      // then the task shows the decision, and the teammate gets the skill with the next update
      expect((await owner.ok<{ task: ShownTask }>("GET", `/api/tasks/${task.id}`)).task.request?.status).toBe("merged");
      const m = machineOf(lab, dev);
      updateMarketplace(m);
      expect(copyFile(m, `skills/${slug}/SKILL.md`)).toContain(`Written by the stand-in agent for the task "${title}"`);
      expect(doctor(m).teamCopy).toMatch(/^✔ team plugin copy/);
    });
  }

  for (const org of builtIn) {
    const repo = org.repos.find((r) => r.versioning === "number")!;
    // A task's request takes the same version bump as an edit on the screen, or a merged task reaches nobody.
    test(`given ${org.name}'s ${repo.id}, versioned by number, when a task's request opens, then it raises the plugin version so teammates fetch the agent's change`, async () => {
      // given
      const owner = await ownerOf(org, repo);

      // when
      const task = await runToReview(owner, repo, unique("Lab version task"));
      try {
        // then
        expect(task.status).toBe("needs-review");
        expect(versionAt(repo, task.request!.branch)).not.toBe(versionAt(repo, "HEAD"));
      } finally {
        if (task.requestNumber !== null) await close(org, repo, task.requestNumber);
      }
    });
  }

  // A team that polices branch names refuses a task's branch in any other shape; a keyed example
  // needs a ticket a task does not have, so these are the repositories whose example needs none.
  for (const { org, repo } of builtIn.flatMap((o) => o.repos.filter((r) => r.branchExample?.includes("/")).map((r) => ({ org: o, repo: r })))) {
    test(`given ${org.name}'s ${repo.id}, whose team names branches like ${repo.branchExample}, when a task's request opens, then its branch has that shape`, async () => {
      // given
      const owner = await ownerOf(org, repo);

      // when
      const task = await runToReview(owner, repo, unique("Lab branch task"));
      try {
        // then
        expect(task.status).toBe("needs-review");
        expect(task.request!.branch).toMatch(new RegExp(`^${repo.branchExample!.slice(0, repo.branchExample!.lastIndexOf("/") + 1)}`));
      } finally {
        if (task.requestNumber !== null) await close(org, repo, task.requestNumber);
      }
    });
  }

  for (const { org, repo } of builtIn.flatMap((o) => o.repos.filter((r) => /^[A-Z][A-Z0-9]+-\d+/.test(r.branchExample ?? "") && !/^[A-Z][A-Z0-9]+-\d+$/.test(r.commitPrefix ?? "")).map((r) => ({ org: o, repo: r })))) {
    const key = /^([A-Z][A-Z0-9]+)-/.exec(repo.branchExample!)![1]!;

    test(`given ${org.name}'s ${repo.id}, whose team names branches like ${repo.branchExample}, when a task names an issue, then its branch leads with the issue's key`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const issue = `${key}-${100 + Math.floor(Math.random() * 900)}`;

      // when
      const task = await runToReview(owner, repo, "", { issueUrl: `https://tracker.example.invalid/browse/${issue}` });
      try {
        // then
        expect([task.status, task.title]).toEqual(["needs-review", `Work on ${issue}`]);
        expect(task.request!.branch.startsWith(`${issue}-`)).toBe(true);
      } finally {
        if (task.requestNumber !== null) await close(org, repo, task.requestNumber);
      }
    });

    test(`given ${org.name}'s ${repo.id}, whose team names branches like ${repo.branchExample}, when a task names no ticket, then it is refused before it runs, saying an issue link fills the ticket`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const before = (await owner.ok<{ tasks: unknown[] }>("GET", `/api/tasks?repo=${repo.id}`)).tasks.length;

      // when
      const asked = await owner.call<{ error?: string }>("POST", "/api/tasks", { title: unique("Lab keyed task"), description: "", repoId: repo.id, agent: "fake" });

      // then
      expect([asked.status, asked.json.error]).toEqual([409, `${repo.id} names branches with a ticket first (its example is ${repo.branchExample}), and this task names none: start it with an issue link whose key fills it`]);
      expect((await owner.ok<{ tasks: unknown[] }>("GET", `/api/tasks?repo=${repo.id}`)).tasks.length).toBe(before);
    });
  }
});
