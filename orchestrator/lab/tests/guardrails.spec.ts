import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import { ORGS } from "../orgs.js";
import type { LabOrg, LabRepo } from "../state.js";
import { as, close, descriptionOf, fileAt, lab, ownerOf, runToReview, SHAPES, spareOrchestratorPort, startOrchestratorProcess, unique, whileChanged } from "./support.js";

const firstSkill = (org: LabOrg, repo: LabRepo) => ORGS.find((o) => o.name === org.name)!.teams.find((t) => t.id === repo.id)!.skills[0]!.slug;

/** The team file with one more policy, as a teammate would merge it on the forge. */
function withPolicy(repo: LabRepo, rules: { action: string; resource: string; reason: string }[]): Record<string, string> {
  const team = JSON.parse(fileAt(repo, "HEAD", ".teamhandbook.json")!) as { policies?: unknown[] };
  const policy = { id: unique("lab-guard"), name: "Lab guard", rules: rules.map((r) => ({ ...r, effect: "deny" })) };
  return { ".teamhandbook.json": JSON.stringify({ ...team, policies: [...(team.policies ?? []), policy] }, null, 2) + "\n" };
}

test.describe("the guardrails on an agent's work", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when the agent reports calls it was refused, then its request tells the reviewer the network it had and each refused call, quoted as data`, async () => {
      test.setTimeout(120_000);
      // given
      const owner = await ownerOf(org, repo);

      // when
      const task = await runToReview(owner, repo, unique("Lab refused calls"), { description: "Add a skill named after this task.\nstand-in: be refused Bash rm -rf ../outside\nstand-in: be refused WebFetch https://exfil.example.invalid/x" });
      try {
        const body = await descriptionOf(repo, task.requestNumber!, task.request!.branch);

        // then
        expect(task.status).toBe("needs-review");
        expect(body).toContain("## What the agent was refused");
        expect(body).toMatch(/Network: (none|open)/);
        expect(body).toContain("Bash rm -rf ../outside");
        expect(body).toContain("WebFetch https://exfil.example.invalid/x");
      } finally {
        if (task.requestNumber) await close(org, repo, task.requestNumber);
      }
    });

    test(`given ${org.name}'s ${repo.id}, ${shape}, when the team's policies keep a skill from use and the hooks from edits, then a task's agent is not given that skill, and an agent that changes a hook opens no request`, async () => {
      test.setTimeout(180_000);
      // given
      const owner = await ownerOf(org, repo);
      const skill = firstSkill(org, repo);
      const reason = "Hooks change through a teammate";

      await whileChanged(org, repo, withPolicy(repo, [
        { action: "skill.use", resource: `skill:${skill}`, reason: "Kept from tasks in the lab" },
        { action: "tool.use", resource: "tool:Edit:hooks/*", reason },
      ]), async () => {
        // when
        const plain = await runToReview(owner, repo, unique("Lab task under policies"));
        const hooked = await runToReview(owner, repo, unique("Lab task changing a hook"), { description: "Add a skill named after this task.\nstand-in: change a hook" });
        try {
          const { log } = await owner.ok<{ log: { text: string }[] }>("GET", `/api/tasks/${plain.id}`);

          // then
          expect(log.map((l) => l.text).join("\n")).toContain(`Left out by the team's policies, skills: ${skill}.`);
          expect(hooked.requestNumber).toBeNull();
          expect(hooked.error).toContain(`The agent changed hooks/notice.mjs, which the team's policy keeps from being edited: ${reason}. No request was opened.`);
        } finally {
          if (plain.requestNumber) await close(org, repo, plain.requestNumber);
          if (hooked.requestNumber) await close(org, repo, hooked.requestNumber);
        }
      });
    });

    test(`given ${org.name}'s ${repo.id}, ${shape}, when a service account starts a task, then it cannot merge the request its agent opened, while the team's owner can review it`, async () => {
      test.setTimeout(120_000);
      // given
      const admin = await as(org, "admin");
      const { serviceAccount } = await admin.ok<{ serviceAccount: { id: string } }>("POST", "/api/service-accounts", { name: unique("lab-bot"), teams: [repo.team] });
      const made = await admin.ok<{ secret: string }>("POST", "/api/keys", { name: unique("lab-key"), scopes: { repositories: "read", requests: "write", tasks: "write" }, serviceAccountId: serviceAccount.id, expiresInDays: 1 });
      const bot = OrchestratorClient.withKey(org.url, made.secret);

      // when
      const task = await runToReview(bot, repo, unique("Lab task a bot started"));
      const merged = await bot.call<{ error?: string }>("POST", `/api/repos/${repo.id}/requests/${task.requestNumber}/merge`);

      // then
      try {
        expect(task.status).toBe("needs-review");
        // A key merges nothing, so the refusal comes before the check on who started the task.
        expect([merged.status, merged.json.error]).toEqual([403, "an API key cannot do this; it takes a person signed in to the orchestrator"]);
        const { requests } = await (await ownerOf(org, repo)).ok<{ requests: { number: number; status: string }[] }>("GET", `/api/requests?repo=${repo.id}`);
        expect(requests.find((r) => r.number === task.requestNumber)?.status).toBe("open");
      } finally {
        if (task.requestNumber) await close(org, repo, task.requestNumber);
      }
    });
  }

  test("given an orchestrator told to pass a forge token to its tasks, when it starts, then it stops before running anything and says why", async () => {
    // given
    const tenant = unique("forge-token");
    const dir = join(lab.dir, "guardrails", tenant);

    // when
    const started = await startOrchestratorProcess({ port: spareOrchestratorPort(1), tenant, dataDir: join(dir, "data"), store: "sqlite", setupCode: unique("setup"), env: { ORCHESTRATOR_TASK_ENV_PASS: "PATH,GITLAB_TOKEN" } });
    await started.stop();

    // then
    expect(started.running()).toBe(false);
    expect(readFileSync(started.log, "utf8")).toContain("ORCHESTRATOR_TASK_ENV_PASS names GITLAB_TOKEN, a forge credential; a task's agent never gets one, so it cannot push or merge its own request");
  });
});
