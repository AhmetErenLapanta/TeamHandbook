import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import { as, close, ownerOf, runToReview, SHAPES, unique, whileChanged } from "./support.js";

const ENVIRONMENT = ".teamhandbook/environment.json";

test.describe("secrets a repository's tasks run with", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when an admin saves a secret for it, then only owners and admins signed in manage secrets, the value is never shown or logged, the task gets it by name with every write of it masked, and a change holding it opens no request`, async () => {
      test.setTimeout(240_000);
      // given
      const admin = await as(org, "org-admin");
      const owner = await ownerOf(org, repo);
      const name = `LAB_TOKEN_${randomBytes(4).toString("hex").toUpperCase()}`;
      const value = `lab-secret-${randomBytes(12).toString("hex")}`;
      const { secret: keySecret } = await admin.ok<{ secret: string }>("POST", "/api/keys", { name: unique("secrets-key"), scopes: { repositories: "read" }, expiresInDays: 1 });
      const said = (r: { status: number; json: { error?: string } }) => [r.status, r.json.error];

      // when people other than an admin try, and the admin sends what is refused
      const byOwner = await owner.call<{ error?: string }>("PUT", "/api/task-secrets", { scope: "repo", target: repo.id, name, value });
      const byMember = await (await as(org, "member")).call<{ error?: string }>("PUT", "/api/task-secrets", { scope: "repo", target: repo.id, name, value });
      const byKey = await OrchestratorClient.withKey(org.url, keySecret).call<{ error?: string }>("GET", "/api/task-secrets");
      const short = await admin.call<{ error?: string }>("PUT", "/api/task-secrets", { scope: "repo", target: repo.id, name, value: "seven77" });
      const lower = await admin.call<{ error?: string }>("PUT", "/api/task-secrets", { scope: "repo", target: repo.id, name: "lab_token", value });
      const reserved = await admin.call<{ error?: string }>("PUT", "/api/task-secrets", { scope: "repo", target: repo.id, name: "PATH", value });

      // then
      expect(said(byOwner)).toEqual([403, "only an owner or an admin manages task secrets"]);
      expect(said(byMember)).toEqual([403, "only an owner or an admin manages task secrets"]);
      expect(byKey.status).toBe(403);
      expect(short.status).toBe(400);
      expect(short.json.error).toMatch(/^a secret's value is at least 8 characters; a shorter one \w+ not be masked in the task's log$/);
      expect(said(lower)).toEqual([400, "a secret's name is an environment variable name: capital letters, digits and underscores, up to 64"]);
      expect(said(reserved)).toEqual([400, "PATH is set by the orchestrator or the system for every task; pick another name"]);

      // when the admin saves it
      const { secret } = await admin.ok<{ secret: { scope: string; target: string; name: string } }>("PUT", "/api/task-secrets", { scope: "repo", target: repo.id, name, value });
      try {
        const listed = await admin.ok<{ secrets: { name: string; target: string }[] }>("GET", "/api/task-secrets");

        // then it is listed by name alone and logged without its value
        expect(secret).toMatchObject({ scope: "repo", target: repo.id, name });
        expect(listed.secrets.some((s) => s.name === name && s.target === repo.id)).toBe(true);
        expect(JSON.stringify(listed)).not.toContain(value);
        const events = await admin.ok<{ events: { kind: string; detail: string }[] }>("GET", "/api/events?kind=task");
        expect(events.events.map((e) => [e.kind, e.detail])).toContainEqual(["task-secret.set", `${name} for repository ${repo.id}; the value is not recorded`]);

        // when a task's setup prints it
        await whileChanged(org, repo, { [ENVIRONMENT]: JSON.stringify({ setup: { command: `printenv ${name}` } }) + "\n" }, async () => {
          const task = await runToReview(owner, repo, unique("Lab task with a secret"));
          try {
            const { log } = await owner.ok<{ log: { text: string }[] }>("GET", `/api/tasks/${task.id}`);
            const lines = log.map((l) => l.text);

            // then it ran with the secret, masked wherever the task wrote it
            expect(task.status).toBe("needs-review");
            expect(lines).toContain(`The task runs with these task secrets, by name: ${name}.`);
            expect(lines).toContain("[redacted:credential]");
            expect(JSON.stringify(log)).not.toContain(value);
          } finally {
            if (task.requestNumber) await close(org, repo, task.requestNumber);
          }
        });

        // when the agent writes the value into its change
        const leaking = await runToReview(owner, repo, `Lab task ${value}`);

        // then no request opens, and its log holds the value masked
        expect([leaking.status, leaking.requestNumber]).toEqual(["failed", null]);
        expect(leaking.error).toMatch(/^The agent's change to .+ holds a credential the orchestrator passed to it; no request was opened\.$/);
        expect(JSON.stringify((await owner.ok<{ log: unknown[] }>("GET", `/api/tasks/${leaking.id}`)).log)).not.toContain(value);
      } finally {
        await admin.ok("DELETE", "/api/task-secrets", { scope: "repo", target: repo.id, name });
      }
      const after = await admin.ok<{ events: { kind: string; detail: string }[] }>("GET", "/api/events?kind=task");
      expect(after.events.map((e) => [e.kind, e.detail])).toContainEqual(["task-secret.deleted", `${name} for repository ${repo.id} deleted`]);
    });
  }
});
