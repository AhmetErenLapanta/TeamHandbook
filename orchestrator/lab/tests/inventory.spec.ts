import { expect, test } from "@playwright/test";
import { ORGS } from "../orgs.js";

import { as, builtIn, close, commitOf, defaultHead, fileAt, lab, openRepo, orgLabel, runToReview, signInOnPage } from "./support.js";

interface Inventory {
  head: string;
  plugin: { name: string; version?: string; versionedByCommit: boolean };
  skills: { slug: string }[];
  mcpServers: { name: string; shareable: boolean; envNames: string[] }[];
  commands: { name: string }[];
  team: { commitPrefix: string; branchExample?: string; reviewers: string[]; labels: string[] };
}

test.describe("what each team has", () => {
  for (const org of builtIn) {
    const spec = ORGS.find((o) => o.name === org.name)!;
    for (const team of spec.teams) {
      test(`given ${org.name}'s ${team.id} on its ${spec.forge} forge, when a member reads it, then the skills, servers, commands, request settings and versioning the team committed are shown`, async () => {
        // given
        const member = await as(org, "member");
        const repo = org.repos.find((r) => r.id === team.id)!;

        // when
        const { inventory } = await member.ok<{ inventory: Inventory }>("GET", `/api/repos/${team.id}/inventory`);

        // then
        expect(inventory.head).toBe(defaultHead(repo));
        expect(inventory.skills.map((s) => s.slug)).toEqual(expect.arrayContaining(team.skills.map((s) => s.slug)));
        expect(inventory.mcpServers.map((s) => [s.name, s.shareable])).toEqual(expect.arrayContaining(Object.keys(team.mcp ?? {}).map((name) => [name, true])));
        expect(inventory.commands.map((c) => c.name)).toEqual(expect.arrayContaining(Object.keys(team.commands ?? {})));
        expect(inventory.team).toMatchObject({ commitPrefix: team.commitPrefix ?? "", reviewers: team.reviewers, labels: team.labels, ...(team.branchExample ? { branchExample: team.branchExample } : {}) });
        if (!team.switchedBySuite) {
          expect(inventory.plugin.versionedByCommit).toBe(!team.version);
          if (team.version) expect(inventory.plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
        }
      });
    }

    test(`given ${org.name}, when a member opens a repository, then its skills are listed and its history leads with the newest commit`, async ({ browser }) => {
      // given
      const repo = org.repos[0]!;
      const team = spec.teams.find((t) => t.id === repo.id)!;
      const context = await browser.newContext();
      const page = await context.newPage();
      await signInOnPage(page, org, "member");

      // when
      await openRepo(page, org, repo.id, "Skills");

      // then
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(repo.id);
      for (const s of team.skills) await expect(page.getByRole("row", { name: new RegExp(`^${s.slug}`) })).toBeVisible();
      await expect(page.getByRole("region", { name: /^History/ })).toContainText(commitOf(repo, "HEAD", "%s"));
      await context.close();
    });
  }

  for (const org of lab.orgs.filter((o) => o.extra)) {
    test(`given ${orgLabel(org)}, when its admin opens each repository, then the join commands name the memberUrl the lab file gives, or ask for one, and never the lab's copy`, async () => {
      const admin = await as(org, "admin");
      for (const repo of org.repos) {
        // when
        const { join } = await admin.ok<{ join: { url?: string; use?: string[]; problem?: string } }>("GET", `/api/repos/${repo.id}/inventory`);

        // then
        expect(JSON.stringify(join)).not.toContain(repo.bare);
        if (join.use) {
          expect(join.url).toBe(repo.memberUrl);
          expect(join.use[0]).toBe(`/plugin marketplace add ${repo.memberUrl}`);
        } else if (repo.memberUrl) {
          // A repository teammates cannot install from yet shows its setup problem instead of commands.
          expect(join.problem).toContain("first problem under Setup");
        } else {
          expect(join.problem).toContain("Set memberUrl for it in the orchestrator's configuration file");
        }
      }
    });

    test(`given ${orgLabel(org)}, when an owner prepares a change on a repository whose team names branches, then the proposed branch is not the orchestrator's own`, async () => {
      for (const repo of org.repos.filter((r) => r.branchExample)) {
        // given
        const owner = await as(org, `owner:${repo.team}`);

        // when
        const { branch } = await owner.ok<{ branch: string }>("POST", `/api/repos/${repo.id}/changes/proposal`, {
          change: { kind: "skill.add", slug: "lab-naming-check", content: "---\nname: lab-naming-check\ndescription: Use when the lab checks naming.\n---\n\nBody.\n" },
        });

        // then
        expect(branch.startsWith("handbook/orchestrator-")).toBe(false);
      }
    });

    test(`given ${orgLabel(org)}, when an owner refreshes the scaffold of a repository with a memberUrl, then any request it opens writes that address and never the lab's copy`, async () => {
      for (const repo of org.repos.filter((r) => r.memberUrl)) {
        // given
        const owner = await as(org, `owner:${repo.team}`);

        // when
        const task = await runToReview(owner, repo, "", { template: { kind: "scaffold.refresh" } });
        try {
          // then: a scaffold that is current, or newer than this orchestrator, opens nothing; one that is behind opens a request
          if (task.status === "needs-review") {
            const readme = fileAt(repo, task.request!.branch, "README.md") ?? "";
            expect(readme).toContain(repo.memberUrl!);
            expect(readme).not.toContain(repo.bare);
          } else {
            expect(task.error ?? "").not.toContain("memberUrl");
          }
        } finally {
          if (task.requestNumber !== null) await close(org, repo, task.requestNumber);
        }
      }
    });

    test(`given ${orgLabel(org)}, when its admin reads each repository, then the orchestrator holds the copy's head`, async () => {
      const admin = await as(org, "admin");
      for (const repo of org.repos) {
        const { inventory } = await admin.ok<{ inventory: Inventory }>("GET", `/api/repos/${repo.id}/inventory`);
        expect(inventory.head).toBe(defaultHead(repo));
      }
    });
  }
});
