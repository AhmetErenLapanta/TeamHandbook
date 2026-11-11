import { expect, test } from "@playwright/test";
import { as, close, lab, ownerOf, runToReview, SHAPES, unique } from "./support.js";

/** An id the orchestrator makes now: its kind, then ten characters of time and sixteen random ones, in lower-case Crockford base32. */
const idOf = (prefix: string) => new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`);

test.describe("the ids the orchestrator gives what it keeps", () => {
  for (const { org, repo } of SHAPES.filter((s, i) => SHAPES.findIndex((t) => t.org === s.org) === i)) {
    test(`given ${org.name}, when a person, an invitation, a key, a service account, a policy, a task and an event are made, then each id names its kind, and a task id of either shape that does not exist is unknown`, async () => {
      test.setTimeout(120_000);
      // given
      const owner = await as(org, "admin");
      const admin = await as(org, "org-admin");

      // when
      const email = `${unique("ids")}@${org.name}.example.invalid`;
      await owner.ok("POST", "/api/users", { email, name: "Lab Ids", role: "member", teams: [], password: lab.password });
      const person = (await owner.ok<{ users: { id: string; email: string }[] }>("GET", "/api/users")).users.find((u) => u.email === email)!;
      const { invited } = await owner.ok<{ invited: { id: string }[] }>("POST", "/api/invites", { emails: `${unique("ids-invite")}@${org.name}.example.invalid`, role: "member", teams: [] });
      const { key } = await owner.ok<{ key: { id: string } }>("POST", "/api/keys", { name: unique("ids-key"), scopes: { repositories: "read" }, expiresInDays: 1 });
      const { serviceAccount } = await owner.ok<{ serviceAccount: { id: string } }>("POST", "/api/service-accounts", { name: unique("ids-bot"), teams: [] });
      const { policy } = await admin.ok<{ policy: { id: string } }>("POST", "/api/policies", { policy: { name: unique("Ids"), audience: { kind: "workspace" }, rules: [{ kind: "task-budget", monthlyUsd: 1000, per: "member" }] } });
      await admin.ok("DELETE", `/api/policies/${policy.id}`);
      const task = await runToReview(await ownerOf(org, repo), repo, unique("Lab task with an id"));
      const { events } = await admin.ok<{ events: { id: string }[] }>("GET", "/api/events");

      try {
        // then
        expect(person.id).toMatch(idOf("usr"));
        expect(invited[0]?.id).toMatch(idOf("inv"));
        expect(key.id).toMatch(idOf("key"));
        expect(serviceAccount.id).toMatch(idOf("svc"));
        expect(policy.id).toMatch(idOf("pol"));
        expect(task.id).toMatch(idOf("tsk"));
        expect(events[0]?.id).toMatch(idOf("evt"));
        for (const missing of ["0123456789ab", `tsk_${"0".repeat(26)}`]) expect((await admin.call<{ error?: string }>("GET", `/api/tasks/${missing}`)).json.error).toBe("unknown task");
      } finally {
        await owner.ok("DELETE", `/api/invites/${invited[0]!.id}`);
        await owner.ok("DELETE", `/api/service-accounts/${serviceAccount.id}`);
        await owner.ok("DELETE", `/api/users/${person.id}`);
        if (task.requestNumber) await close(org, repo, task.requestNumber);
      }
    });
  }
});
