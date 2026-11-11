import { expect, test } from "@playwright/test";
import { as, ownerOf, SHAPES } from "./support.js";

interface Usage {
  byTeam: { team: string }[];
  bySkill: { team: string }[];
  scope?: { teams: string[] };
}

test.describe("skill use for a team's owner", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when its team's owner reads skill use, the leaderboard and the export, then each is kept to the teams they can change, another team's repository is refused, a member sees no breakdown until the owner shows the leaderboard to members, and managers see every team`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const member = await as(org, "member");
      const admin = await as(org, "org-admin");
      const ownTeams = (await owner.ok<{ user: { ownedTeams: string[] } }>("GET", "/api/me")).user.ownedTeams;
      const elsewhere = org.repos.find((r) => !ownTeams.includes(r.team))!;
      const only = (teams: string[]) => teams.every((t) => ownTeams.includes(t));

      // when
      const usage = await owner.ok<Usage>("GET", "/api/activity/usage?days=30");
      const board = await owner.ok<{ teams: { team: string }[]; scope?: { teams: string[] } }>("GET", "/api/activity/leaderboard?days=30");
      const exported = await owner.ok<{ rows: { team: string }[] }>("GET", "/api/activity/usage/export?days=30&format=json");
      const otherRepo = await owner.call<{ error?: string }>("GET", `/api/activity/usage?days=30&repo=${elsewhere.id}`);
      const ownRepo = await owner.call("GET", `/api/activity/usage?days=30&repo=${repo.id}`);
      const memberUsage = await member.ok<Usage>("GET", "/api/activity/usage?days=30");
      const memberBoard = await member.call<{ error?: string }>("GET", "/api/activity/leaderboard?days=30");
      const memberExport = await member.call<{ error?: string }>("GET", "/api/activity/usage/export?days=30&format=json");
      const managers = await admin.ok<Usage>("GET", "/api/activity/usage?days=30");

      // then
      expect(usage.scope?.teams).toEqual([...ownTeams].sort());
      expect(only(usage.byTeam.map((t) => t.team)) && only(usage.bySkill.map((s) => s.team))).toBe(true);
      expect(board.scope?.teams).toEqual([...ownTeams].sort());
      expect(only(board.teams.map((t) => t.team))).toBe(true);
      expect(only(exported.rows.map((r) => r.team))).toBe(true);
      expect([otherRepo.status, otherRepo.json.error]).toEqual([403, "Skill use for one repository is shown to its team's owners, and to owners and admins."]);
      expect(ownRepo.status).toBe(200);
      expect([memberUsage.byTeam, memberUsage.bySkill]).toEqual([[], []]);
      expect([memberBoard.status, memberBoard.json.error]).toEqual([403, "The leaderboard is shown to owners and admins; an owner can show it to members under Settings, Privacy."]);
      expect([memberExport.status, memberExport.json.error]).toEqual([403, "An owner or an admin exports skill use; a team's owner exports their own teams'."]);
      expect(managers.scope).toBeUndefined();

      // when the leaderboard is shown to members
      const { privacy } = await admin.ok<{ privacy: Record<string, unknown> }>("GET", "/api/privacy");
      await admin.ok("PUT", "/api/privacy", { ...privacy, leaderboard: "members" });
      try {
        // then a member sees every team
        expect((await member.call("GET", "/api/activity/leaderboard?days=30")).status).toBe(200);
        expect((await member.ok<Usage>("GET", "/api/activity/usage?days=30")).scope).toBeUndefined();
      } finally {
        await admin.ok("PUT", "/api/privacy", privacy);
      }
    });
  }
});
