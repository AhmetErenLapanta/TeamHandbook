import { expect, test } from "@playwright/test";
import { MULTI_REPO_ISSUE } from "../multi-repo.js";
import { ownerKey } from "../state.js";
import type { LabRepo } from "../state.js";
import { as, close, descriptionOf, fileAt, lab, onForge, runToReview } from "./support.js";

/** A task over several repositories as the design's task JSON carries it. */
interface MultiTask {
  status: string;
  error: string | null;
  targets: { repoId: string; status: string; reason: string | null; tests: string | null; error: string | null; request: { number: number; url: string; status: string } | null }[] | null;
}

const org = lab.orgs.find((o) => o.fixture === "multi-repo");
const code = (org?.repos ?? []).filter((r) => r.code);
const ENDPOINT = "shipment-tracking";

/** What the stand-in claude adds to each repository shape for the issue's endpoint. */
const added: Record<string, string> = {
  "customer-gateway": `endpoints/${ENDPOINT}.json`,
  "customer-bff": "src/controllers/ShipmentTrackingController.ts",
  "shipment-service": `src/endpoints/${ENDPOINT}.ts`,
};

// An issue link is https and carries the key. The orchestrator reads an issue only from a tracker of the link's own origin,
// and the stand-in Jira is plain http on this machine, so the task's title carries the issue's summary as a person types it.
const issueUrl = () => `https://tracker.example.invalid/browse/${MULTI_REPO_ISSUE.key}`;

test.describe("one issue's endpoint through a gateway, a backend-for-frontend and a service", () => {
  test.skip(!org || !lab.jira, "this lab has no organization with code repositories or no stand-in tracker");

  test.beforeAll(async () => {
    // The tracker the task reads the issue from: the lab's stand-in Jira, behind its API token.
    await (await as(org!, "admin")).ok("PUT", "/api/integrations/tracker", { kind: "jira", url: lab.jira!.url, email: lab.jira!.email, token: lab.jira!.token });
  });

  for (const repo of code) {
    test(`given ${repo.id}, a code repository taking its setup from ${repo.code!.skillsFrom}, when its team's owner starts a Claude Code task from ${MULTI_REPO_ISSUE.key}, then the agent's change opens one request under the issue's key with the endpoint added, and the repository's checks ran`, async () => {
      test.setTimeout(180_000);
      // given
      const owner = await as(org!, ownerKey(repo.team));

      // when
      const task = await runToReview(owner, repo, MULTI_REPO_ISSUE.summary, { agent: "claude-code", issueUrl: issueUrl(), description: "" });
      try {
        const { log } = await owner.ok<{ log: { text: string }[] }>("GET", `/api/tasks/${task.id}`);

        // then
        expect([task.status, task.error]).toEqual(["needs-review", null]);
        expect(task.request!.branch).toContain(MULTI_REPO_ISSUE.key);
        expect(fileAt(repo, task.request!.branch, added[repo.id]!)).not.toBeNull();
        expect((await onForge(repo, task.requestNumber!)).state).toBe("opened");
        expect(log.map((l) => l.text).join("\n")).toContain("checks pass");
      } finally {
        if (task.requestNumber) await close(org!, repo, task.requestNumber);
      }
    });
  }

  test(`given shipment-service, when the agent's change breaks the repository's checks, then the task stops with the checks' last line and opens no request`, async () => {
    test.setTimeout(180_000);
    // given
    const repo = code.find((r) => r.id === "shipment-service") as LabRepo;
    const owner = await as(org!, ownerKey(repo.team));

    // when
    const task = await runToReview(owner, repo, MULTI_REPO_ISSUE.summary, { agent: "claude-code", issueUrl: issueUrl(), description: "stand-in: break the checks of the service" });
    try {
      const { log } = await owner.ok<{ log: { text: string }[] }>("GET", `/api/tasks/${task.id}`);

      // then
      expect(log.map((l) => l.text).join("\n")).toContain("a check fails: a file carries the LAB-BROKEN marker");
      expect([task.status, task.requestNumber, task.error]).toEqual(["failed", null, "The tests failed (exit code 1); no request was opened. Last line: a check fails: a file carries the LAB-BROKEN marker"]);
    } finally {
      if (task.requestNumber) await close(org!, repo, task.requestNumber);
    }
  });

  // One task, its targets run one after another, each in its own checkout with its own request.
  // Targets are pinned, so no planning step runs: the order is the form's, the service first.
  test(`given the three code repositories pinned as targets, when one task is started from ${MULTI_REPO_ISSUE.key}, then they run service, backend-for-frontend and gateway in turn, each opening one request under the issue's key that says which part it is, and when the service's checks fail the task stops there, the other two are skipped and no request opens`, async () => {
    test.setTimeout(300_000);
    // given
    const owner = await as(org!, ownerKey("Customers"));
    const ids = ["shipment-service", "customer-bff", "customer-gateway"];
    const repoOf = (id: string) => code.find((r) => r.id === id)!;
    const run = async (description: string) => {
      const { task } = await owner.ok<{ task: { id: string } }>("POST", "/api/tasks", { title: MULTI_REPO_ISSUE.summary, description, repoId: ids[0], agent: "claude-code", issueUrl: issueUrl(), targets: ids });
      for (let i = 0; i < 480; i++) {
        const shown = (await owner.ok<{ task: MultiTask }>("GET", `/api/tasks/${task.id}`)).task;
        if (["needs-review", "failed", "cancelled"].includes(shown.status)) return shown;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("the task did not end");
    };

    // when every target's change passes its checks
    const passed = await run("");
    try {
      // then each target opened its part of the change, in order, under the issue's key
      expect(passed.status).toBe("needs-review");
      expect(passed.targets!.map((t) => [t.repoId, t.status, t.tests])).toEqual(ids.map((id) => [id, "request", "passed"]));
      for (const [i, target] of passed.targets!.entries()) {
        const forge = await onForge(repoOf(target.repoId), target.request!.number);
        expect(forge.source).toContain(MULTI_REPO_ISSUE.key);
        // Under the orchestrator's own header, as every request it opens begins.
        expect(await descriptionOf(repoOf(target.repoId), target.request!.number, forge.source)).toContain(`Part ${i + 1} of 3 for ${MULTI_REPO_ISSUE.key}.`);
        expect(fileAt(repoOf(target.repoId), forge.source, added[target.repoId]!)).not.toBeNull();
      }
    } finally {
      for (const target of passed.targets ?? []) if (target.request) await close(org!, repoOf(target.repoId), target.request.number);
    }

    // when the service's change breaks its checks
    const broken = await run("stand-in: break the checks of the service");

    // then the task stops at the service and the rest are not started
    expect(broken.status).toBe("failed");
    expect(broken.error).toContain("shipment-service");
    expect(broken.targets!.map((t) => [t.repoId, t.status, t.request])).toEqual([["shipment-service", "failed", null], ["customer-bff", "skipped", null], ["customer-gateway", "skipped", null]]);
    expect(broken.targets!.slice(1).map((t) => t.error)).toEqual(["An earlier repository did not finish.", "An earlier repository did not finish."]);
  });

  test(`given the three code repositories and no choice made, when one task is started from ${MULTI_REPO_ISSUE.key} for the orchestrator to plan, then the planning step names the service, the backend-for-frontend and the gateway in that order with a reason each, the log says so, every one opens its request, and a start without an issue link is refused`, async () => {
    test.setTimeout(300_000);
    // given
    const owner = await as(org!, ownerKey("Customers"));
    const ids = ["shipment-service", "customer-bff", "customer-gateway"];

    // when
    const unlinked = await owner.call<{ error?: string }>("POST", "/api/tasks", { title: MULTI_REPO_ISSUE.summary, description: "", repoId: ids[0], agent: "claude-code", targets: "orchestrator" });
    const { task } = await owner.ok<{ task: { id: string } }>("POST", "/api/tasks", { title: MULTI_REPO_ISSUE.summary, description: "", repoId: ids[0], agent: "claude-code", issueUrl: issueUrl(), targets: "orchestrator" });
    let planned!: MultiTask;
    for (let i = 0; i < 480; i++) {
      planned = (await owner.ok<{ task: MultiTask }>("GET", `/api/tasks/${task.id}`)).task;
      if (["needs-review", "failed", "cancelled"].includes(planned.status)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      const { log } = await owner.ok<{ log: { text: string }[] }>("GET", `/api/tasks/${task.id}`);

      // then
      expect([unlinked.status, unlinked.json.error]).toEqual([400, "a task over several repositories needs an issue link"]);
      expect([planned.status, planned.error]).toEqual(["needs-review", null]);
      expect(planned.targets!.map((t) => [t.repoId, t.status])).toEqual(ids.map((id) => [id, "request"]));
      expect(planned.targets!.every((t) => t.reason?.startsWith("it "))).toBe(true);
      expect(log.map((l) => l.text)).toContain("Planned 3 repositories: shipment-service, customer-bff, customer-gateway.");
    } finally {
      for (const target of planned?.targets ?? []) if (target.request) await close(org!, code.find((r) => r.id === target.repoId)!, target.request.number);
    }
  });
});
