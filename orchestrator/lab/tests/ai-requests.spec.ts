import { expect, test } from "@playwright/test";
import type { OrchestratorClient } from "../client.js";
import type { LabRepo } from "../state.js";
import { as, commitOnDefault, ownerOf, SHAPES, unique } from "./support.js";

interface Stats {
  merged: number;
  aiAssisted: number;
}

interface AiAnalytics {
  byAgent: { agent: string; requests: number }[];
  byRepo: (Stats & { repoId: string })[];
  byPerson: (Stats & { email: string })[] | null;
}

const read = (client: OrchestratorClient) => client.ok<AiAnalytics>("GET", "/api/analytics/ai-requests?days=30");
const statsOf = (report: AiAnalytics, repo: LabRepo): Stats => report.byRepo.find((r) => r.repoId === repo.id) ?? { merged: 0, aiAssisted: 0 };

test.describe("requests a coding agent helped write", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when two requests are squash-merged, one with Claude Code as a co-author, then both count as merged and one as AI-assisted, managers see it per person, and the team's owner and a member do not`, async () => {
      test.setTimeout(120_000);
      // given
      const admin = await as(org, "org-admin");
      const owner = await ownerOf(org, repo);
      const before = statsOf(await read(admin), repo);
      const note = unique("lab-ai-note");

      // when
      commitOnDefault(repo, { [`notes/${note}.md`]: "Written with an agent.\n" }, `Add the lab's first note (#${9000 + before.merged})\n\nCo-Authored-By: Claude <noreply@anthropic.com>`);
      commitOnDefault(repo, { [`notes/${note}-2.md`]: "Written by a person.\n" }, `Add the lab's second note (#${9001 + before.merged})`);
      commitOnDefault(repo, { [`notes/${note}.md`]: null, [`notes/${note}-2.md`]: null }, "Take the lab's notes back out");
      await owner.ok("POST", `/api/repos/${repo.id}/sync`);
      const byAdmin = await read(admin);
      const byOwner = await read(owner);
      const byMember = await read(await as(org, "member"));
      const badDays = await admin.call<{ error?: string }>("GET", "/api/analytics/ai-requests?days=0");

      // then
      expect(statsOf(byAdmin, repo)).toMatchObject({ merged: before.merged + 2, aiAssisted: before.aiAssisted + 1 });
      expect(byAdmin.byAgent.find((a) => a.agent === "claude-code")?.requests).toBeGreaterThanOrEqual(1);
      expect(byAdmin.byPerson?.find((p) => p.email === "teammate@lab.example.invalid")?.aiAssisted).toBeGreaterThanOrEqual(1);
      expect(statsOf(byOwner, repo)).toMatchObject({ merged: before.merged + 2, aiAssisted: before.aiAssisted + 1 });
      expect([byOwner.byPerson, byMember.byPerson]).toEqual([null, null]);
      expect([badDays.status, badDays.json.error]).toEqual([400, "days is a whole number from 1 to 365"]);
    });
  }
});
