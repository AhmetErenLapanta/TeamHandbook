import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import { Evidence, FAIL_GATE } from "../evidence.js";
import { seedTeamRepo } from "../repos.js";
import { lab, spareOrchestratorPort, startOrchestratorProcess, unique } from "./support.js";
import type { OrchestratorProcess, ShownTask } from "./support.js";

const REPO = "team-skills";
const REASON = "The orchestrator restarted before this task finished.";

interface Logged extends ShownTask {
  log: { text: string }[];
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, tries: number): Promise<T> {
  let value = await read();
  for (let i = 0; i < tries && !done(value); i++) {
    await new Promise((r) => setTimeout(r, 250));
    value = await read();
  }
  return value;
}

/** Every file under `dir`, read whole. */
function filesUnder(dir: string): { name: string; text: string }[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: join(entry.parentPath, entry.name), text: readFileSync(join(entry.parentPath, entry.name), "utf8") }));
}

/**
 * An orchestrator that goes away in the middle of a task, as a machine that loses power does: what
 * it left running is ended and the task says why, rather than reading as running forever. The
 * reason and the failed status are today's rule, where nothing resumes; a task that continues
 * after a restart changes those two checks and keeps the others.
 */
test.describe("an orchestrator that stops in the middle of a task", () => {
  let evidence: Evidence | undefined;

  test.afterEach(async ({}, testInfo) => {
    evidence?.decide(testInfo.status === testInfo.expectedStatus, testInfo.error?.message ?? "");
  });

  test("given an orchestrator on SQLite whose task's agent is at work, when the orchestrator's process is killed and started again on the same data, then the agent it left is ended, the task reads failed with why on the API and its page, no request was opened for it, the next task runs to review, and the evidence directory holds the store, the task, the orchestrator's log and the decision without a credential the scenario handed out", async ({ page }) => {
    test.setTimeout(420_000);
    // given an orchestrator with a team repository of its own
    const tenant = unique("restart");
    const dir = join(lab.dir, "orchestrator-restart", tenant);
    const dataDir = join(dir, "data");
    const bare = join(dir, "repos", "team-skills.git");
    seedTeamRepo(lab.path, { id: REPO, team: "Core", reviewers: [], labels: [], skills: [{ slug: "first-skill", description: "Use when the lab restarts an orchestrator.", body: "1. Begin.\n" }] }, bare, `file://${bare}`, join(dir, "scratch"));
    const code = unique("setup");
    const common = { port: spareOrchestratorPort(2), tenant, dataDir, store: "sqlite" as const, repos: [{ id: REPO, team: "Core", url: `file://${bare}` }] };
    // A credential in the task's own words, which the orchestrator stores as written: only the evidence's redaction keeps it out of the directory.
    const planted = `lab-planted-${randomBytes(12).toString("hex")}`;
    const proof = new Evidence(lab.dir, tenant, [lab.password, code, planted]);
    evidence = proof;
    const first = await startOrchestratorProcess({ ...common, setupCode: code });
    let second: OrchestratorProcess | undefined;
    let owner: OrchestratorClient | undefined;
    try {
      owner = await OrchestratorClient.setup(first.url, code, { email: `owner@${tenant}.example.invalid`, name: "Restart Owner" }, lab.password);
      const signedIn = owner;
      const read = (id: string) => signedIn.ok<{ task: ShownTask; log: { text: string }[] }>("GET", `/api/tasks/${id}`).then((r): Logged => ({ ...r.task, log: r.log }));
      const head = async () => (await signedIn.ok<{ repos: { id: string; head: string | null }[] }>("GET", "/api/repos")).repos.find((r) => r.id === REPO)?.head;
      await until(head, Boolean, 480);
      const { task } = await owner.ok<{ task: ShownTask }>("POST", "/api/tasks", { title: unique("Lab task cut short"), description: `Add a skill named after this task.\nstand-in: wait 120 seconds\nThe deploy key is ${planted}.`, repoId: REPO, agent: "fake" });
      const atWork = await until(() => read(task.id), (t) => t.log.some((l) => /waiting 120 seconds \(pid \d+\)/.test(l.text)), 120);
      const agent = Number(/waiting 120 seconds \(pid (\d+)\)/.exec(atWork.log.map((l) => l.text).join("\n"))?.[1]);
      expect([atWork.status, alive(agent)]).toEqual(["running", true]);

      // when the orchestrator's process is killed, leaving its agent, and an orchestrator starts again on the same data
      if (!FAIL_GATE) {
        process.kill(first.pid, "SIGKILL");
        await until(async () => first.running(), (running) => !running, 40);
        second = await startOrchestratorProcess({ ...common, setupCode: unique("unused") });
      }
      const after = await until(() => read(task.id), (t) => t.status !== "running", 120);
      const gone = await until(async () => alive(agent), (running) => !running, 40);

      // then
      expect([after.status, after.error, after.request, after.requestNumber]).toEqual(["failed", REASON, null, null]);
      expect(gone, "the agent the killed orchestrator left").toBe(false);
      const taskPage = `${(second ?? first).url}/${tenant}/tasks/${task.id}`;
      await page.goto(taskPage);
      await page.getByLabel("Email").fill(`owner@${tenant}.example.invalid`);
      await page.getByLabel("Password").fill(lab.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("button", { name: /Restart Owner/ })).toBeVisible();
      await page.goto(taskPage);
      await expect(page.getByText(REASON)).toBeVisible();
      const { task: next } = await owner.ok<{ task: ShownTask }>("POST", "/api/tasks", { title: unique("Lab task after the restart"), description: "Add a skill named after this task.", repoId: REPO, agent: "fake" });
      expect((await until(() => read(next.id), (t) => ["needs-review", "failed", "cancelled"].includes(t.status), 480)).status).toBe("needs-review");
    } finally {
      const tasks = await owner?.call("GET", "/api/tasks").catch(() => null);
      if (tasks) proof.json("tasks.json", tasks.json);
      await second?.stop();
      await first.stop();
      proof.store(join(dataDir, "orchestrator.db"));
      proof.copy("console.log", first.log);
    }

    // and the evidence holds what the orchestrator stored and printed, without the credential the store holds as written
    const db = new DatabaseSync(join(dataDir, "orchestrator.db"), { readOnly: true });
    const stored = db.prepare("SELECT count(*) AS n FROM tasks WHERE description LIKE ?").get(`%${planted}%`) as { n: number };
    db.close();
    expect(stored.n, "the store keeps the task's words as written").toBe(1);
    const kept = filesUnder(proof.dir);
    expect(kept.map((f) => f.name.slice(proof.dir.length + 1)).sort()).toEqual(expect.arrayContaining(["console.log", "store/tasks.ndjson", "tasks.json"]));
    for (const { name, text } of kept) expect(text, name).not.toContain(planted);
    expect(kept.find((f) => f.name.endsWith("store/tasks.ndjson"))!.text).toContain("[redacted:credential]");
    expect(kept.find((f) => f.name.endsWith("store/users.ndjson"))!.text).not.toContain("scrypt$");
    expect(kept.find((f) => f.name.endsWith("store/sessions.ndjson"))!.text).toContain('"csrf":"[withheld]"');
  });
});
