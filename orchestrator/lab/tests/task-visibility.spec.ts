import { expect, test } from "@playwright/test";
import { ownerKey } from "../state.js";
import type { LabOrg, LabRepo } from "../state.js";
import { as, close, ownerOf, runToReview, SHAPES, unique } from "./support.js";

/** The owner of another team in the same organization, one the lab gives an owner. */
const otherOwnerKey = (org: LabOrg, repo: LabRepo) => ownerKey(org.repos.find((r) => r.team !== repo.team && org.users.some((u) => u.key === ownerKey(r.team)))!.team);

/**
 * Every member of an organization reads, follows and lists the tasks of each of its teams, and
 * only those who edit the team cancel one; a team its editors keep to its owners keeps its tasks
 * from everyone else, who find no such task. An admin and the team's owner read both.
 */
test.describe("who sees a task and its log", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when its team's owner runs a task, then a member and another team's owner read, follow and list it but are refused its cancel, and once the team is kept to its owners they find no such task, while the team's owner and an admin see it throughout`, async () => {
      test.setTimeout(180_000);
      // given
      const owner = await ownerOf(org, repo);
      const admin = await as(org, "org-admin");
      const task = await runToReview(owner, repo, unique("Lab task of its team"));
      const reach = async (key: string) => {
        const someone = await as(org, key);
        const read = await someone.call<{ error?: string }>("GET", `/api/tasks/${task.id}`);
        const followed = await someone.call<{ error?: string }>("GET", `/api/tasks/${task.id}/events`);
        const cancelled = await someone.call<{ error?: string }>("POST", `/api/tasks/${task.id}/cancel`);
        const { tasks } = await someone.ok<{ tasks: { id: string }[] }>("GET", `/api/tasks?repo=${repo.id}`);
        return { read: [read.status, read.json.error], followed: followed.status, cancelled: [cancelled.status, cancelled.json.error], listed: tasks.some((t) => t.id === task.id) };
      };
      const outsiders = ["member", otherOwnerKey(org, repo)];
      try {
        // when the team is open
        const open = await Promise.all(outsiders.map(reach));

        // then they read, follow and list it, and are refused its cancel
        for (const [i, seen] of open.entries()) {
          expect(seen, outsiders[i]).toEqual({ read: [200, undefined], followed: 200, cancelled: [403, "only an admin or this team's owner can cancel a task"], listed: true });
        }

        // when the team's owner keeps the team to its owners
        await owner.ok("PUT", `/api/teams/${encodeURIComponent(repo.team)}/restricted`, { restricted: true });
        const kept = await Promise.all(outsiders.map(reach));

        // then it is no task of theirs to read, follow, cancel or list
        for (const [i, seen] of kept.entries()) {
          expect(seen, outsiders[i]).toEqual({ read: [404, "unknown task"], followed: 404, cancelled: [404, "unknown task"], listed: false });
        }
        expect((await owner.call("GET", `/api/tasks/${task.id}`)).status).toBe(200);
        expect((await admin.call("GET", `/api/tasks/${task.id}`)).status).toBe(200);
        expect((await admin.ok<{ tasks: { id: string }[] }>("GET", `/api/tasks?repo=${repo.id}`)).tasks.map((t) => t.id)).toContain(task.id);
      } finally {
        await admin.call("PUT", `/api/teams/${encodeURIComponent(repo.team)}/restricted`, { restricted: false });
        if (task.requestNumber) await close(org, repo, task.requestNumber);
      }
    });
  }
});
