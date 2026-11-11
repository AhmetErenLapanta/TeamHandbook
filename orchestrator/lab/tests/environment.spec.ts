import { expect, test } from "@playwright/test";
import { close, fileAt, ownerOf, runToReview, SHAPES, unique, whileChanged } from "./support.js";

const ENVIRONMENT = ".teamhandbook/environment.json";
const environment = (value: unknown) => ({ [ENVIRONMENT]: JSON.stringify(value, null, 2) + "\n" });

test.describe("a repository's own environment for its tasks", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when its environment file sets a setup, then the setup runs before the agent with its output in the task's log, what it makes stays out of the request, and a setup that edits a tracked file stops the task`, async () => {
      test.setTimeout(180_000);
      // given
      const owner = await ownerOf(org, repo);
      const marker = unique("lab-setup-ran");

      await whileChanged(org, repo, environment({ setup: { command: `echo ${marker} && mkdir -p .lab-cache && echo cached > .lab-cache/made.txt` } }), async () => {
        // when
        const task = await runToReview(owner, repo, unique("Lab task with a setup"));
        try {
          const { log } = await owner.ok<{ log: { text: string }[] }>("GET", `/api/tasks/${task.id}`);
          const lines = log.map((l) => l.text);

          // then
          expect(task.status).toBe("needs-review");
          const ran = lines.findIndex((l) => l.startsWith("Running the repository's setup: "));
          expect(ran).toBeGreaterThanOrEqual(0);
          expect(lines.indexOf(marker)).toBeGreaterThan(ran);
          expect(lines).toContain("The setup created 1 path(s) the change leaves out.");
          expect(lines.findIndex((l) => l.startsWith("Starting "))).toBeGreaterThan(lines.indexOf(marker));
          expect(fileAt(repo, task.request!.branch, ".lab-cache/made.txt")).toBeNull();
        } finally {
          if (task.requestNumber) await close(org, repo, task.requestNumber);
        }
      });

      await whileChanged(org, repo, environment({ setup: { command: "echo changed >> README.md" } }), async () => {
        // when
        const task = await runToReview(owner, repo, unique("Lab task whose setup edits"));

        // then
        expect([task.status, task.requestNumber]).toEqual(["failed", null]);
        expect(task.error).toContain("The repository's setup changed README.md, which the repository tracks");
      });
    });

    test(`given ${org.name}'s ${repo.id}, ${shape}, when its environment file names an allow list, asks for no network, or holds a key the orchestrator does not read, then the task does not run and says why, with the agent never started`, async () => {
      test.setTimeout(180_000);
      // given
      const owner = await ownerOf(org, repo);
      const cases: [unknown, string][] = [
        [{ agent: { allowedDomains: ["registry.npmjs.org"] } }, "The task did not run: .teamhandbook/environment.json allows the agent only registry.npmjs.org, which only container isolation holds."],
        [{ setup: { command: "true", network: false } }, "The task did not run: .teamhandbook/environment.json runs its setup with no network, which only container isolation holds."],
        [{ setup: { command: "true" }, ports: [8080] }, 'The task did not run: .teamhandbook/environment.json has "ports", which the orchestrator does not read.'],
      ];

      for (const [value, said] of cases) {
        await whileChanged(org, repo, environment(value), async () => {
          // when
          const task = await runToReview(owner, repo, unique("Lab task held by its environment"));
          const { log } = await owner.ok<{ log: { text: string }[] }>("GET", `/api/tasks/${task.id}`);

          // then
          expect([task.status, task.error]).toEqual(["failed", said]);
          expect(log.some((l) => l.text.startsWith("Starting "))).toBe(false);
        });
      }
    });
  }
});
