import { expect, test } from "@playwright/test";
import { as, fileAt, SHAPES } from "./support.js";

test.describe("the organization's privacy settings", () => {
  for (const org of [...new Set(SHAPES.map((s) => s.org))]) {
    test(`given ${org.name}, when its people read and change privacy, then a member is refused, each team's skill-use reporting is read from its own team file, the task log is kept between 1 and 365 days, and a change is logged`, async () => {
      // given
      const admin = await as(org, "org-admin");

      // when
      const member = await (await as(org, "member")).call("GET", "/api/privacy");
      const { privacy, usage } = await admin.ok<{ privacy: { leaderboard: string; taskLogDays: number }; usage: { repoId: string; reporting: boolean | null }[] }>("GET", "/api/privacy");
      const tooShort = await admin.call("PUT", "/api/privacy", { ...privacy, taskLogDays: 0 });
      const tooLong = await admin.call("PUT", "/api/privacy", { ...privacy, taskLogDays: 366 });
      const changed = await admin.ok<{ privacy: { taskLogDays: number } }>("PUT", "/api/privacy", { ...privacy, taskLogDays: 7 });

      // then
      expect(member.status).toBe(403);
      for (const { repo } of SHAPES.filter((s) => s.org === org)) {
        const asks = Boolean((JSON.parse(fileAt(repo, "HEAD", ".teamhandbook.json") ?? "{}") as { usage?: { endpoint?: string } }).usage?.endpoint);
        expect([repo.id, usage.find((u) => u.repoId === repo.id)?.reporting]).toEqual([repo.id, asks]);
      }
      expect([tooShort.status, tooLong.status]).toEqual([400, 400]);
      expect(changed.privacy.taskLogDays).toBe(7);
      const { events } = await admin.ok<{ events: { kind: string; detail: string }[] }>("GET", "/api/events?kind=privacy");
      expect(events[0]?.detail).toContain("task logs kept 7 days");
      await admin.ok("PUT", "/api/privacy", privacy);
    });
  }
});
