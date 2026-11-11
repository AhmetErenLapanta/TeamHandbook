import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { cleanMachine, portFree } from "../clean-machine.js";
import type { CleanMachine } from "../clean-machine.js";
import { OrchestratorClient } from "../client.js";
import { claudeStandIn, contents, drawnTaskPage, started, thePackage, until } from "../solo.js";
import type { Started } from "../solo.js";
import { lab, spareOrchestratorPort, startOrchestratorProcess, unique } from "./support.js";
import type { OrchestratorProcess } from "./support.js";

const TITLE = "Expose the delivery-window endpoint";
const MACHINE = "lab-machine";

interface Done {
  status: string;
  error: string | null;
  result: "request" | "changes" | null;
  requestNumber: number | null;
  changes: { files: { path: string }[]; undone: { kept: string[] } | null } | null;
}

interface Connected {
  orchestrator: OrchestratorProcess;
  tenant: string;
  person: OrchestratorClient;
  machine: CleanMachine;
  runner: Started;
  machineId: string;
  folder: string;
  projectId: string;
  stop: () => Promise<void>;
}

/**
 * A team's orchestrator whose tasks run on people's own machines, a person signed in on its first
 * screen, the command Connect this computer shows run once on a clean machine of theirs with the
 * packed orchestrator and the stand-in claude, and a folder of that machine with no Git opened as
 * a project. The orchestrator runs no task itself: ORCHESTRATOR_SERVER_TASKS is not set.
 */
async function connectedFolder(page: Page): Promise<Connected> {
  const tenant = unique("machine-folder");
  const dir = join(lab.dir, "machine-folder", tenant);
  const code = unique("setup");
  // An orchestrator another run left there answers the health check this one waits for, and refuses this run's setup code.
  expect(await portFree(spareOrchestratorPort(1)), `port ${spareOrchestratorPort(1)} is free`).toBe(true);
  const orchestrator = await startOrchestratorProcess({ port: spareOrchestratorPort(1), tenant, dataDir: join(dir, "data"), store: "sqlite", setupCode: code, env: { ORCHESTRATOR_SERVER_TASKS: "0", ORCHESTRATOR_AGENTS: "claude-code" } });
  let runner: Started | null = null;
  const stop = async () => {
    // A runner that already ended has no process group left to signal.
    if (runner && runner.child.exitCode === null && runner.child.signalCode === null) {
      process.kill(-runner.child.pid!, "SIGINT");
      await Promise.race([runner.exited, new Promise((r) => setTimeout(r, 20_000))]);
    }
    await orchestrator.stop();
  };
  try {
    const email = `person@${tenant}.example.invalid`;
    const person = await OrchestratorClient.setup(orchestrator.url, code, { email, name: "Machine Person" }, lab.password);
    const machine = cleanMachine(join(dir, "machine"), process.env.PATH ?? "");
    const folder = join(machine.home, "work", "notes");
    mkdirSync(join(folder, "src", "endpoints"), { recursive: true });
    writeFileSync(join(folder, "README.md"), "# notes\n\nAnswers the notes calls, an endpoint per call under src/endpoints/.\n");
    writeFileSync(join(folder, "src", "endpoints", "status.ts"), 'export const status = { method: "GET", path: "/status" };\n');

    await page.goto(orchestrator.url);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(lab.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(new RegExp(`/${tenant}/`));
    await page.goto(`${orchestrator.url}/${tenant}/welcome`);
    const connect = page.getByRole("region", { name: "Connect this computer" });
    const command = (await connect.locator(".copy-text code").textContent({ timeout: 30_000 }))!.trim().split(/\s+/);
    expect(command.slice(0, 3)).toEqual(["handbook-orchestrator", "runner", "connect"]);
    // Named here so the machine's own host name stays out of the orchestrator's store and the evidence.
    runner = started("npm", ["exec", "--offline", "--yes", "--package", thePackage(), "--", ...command, "--name", MACHINE], { ...machine.env, ORCHESTRATOR_CLAUDE_BIN: claudeStandIn(join(dir, "machine")) }, machine.home);
    // The machine is connected once it reads so to its person, or it ended and said why.
    const paired = await until(() => person.ok<{ machines: { name: string }[] }>("GET", "/api/machines").then((r) => r.machines.some((m) => m.name === MACHINE)), (on) => on || runner!.child.exitCode !== null, 480);
    expect(paired, `the runner ended ${runner.child.exitCode}: ${runner.said()}`).toBe(true);
    await expect(connect).toBeHidden({ timeout: 60_000 });

    const { machines } = await person.ok<{ machines: { id: string; name: string; revokedAt: string | null }[] }>("GET", "/api/machines");
    const mine = machines.filter((m) => m.name === MACHINE && !m.revokedAt);
    expect(mine).toHaveLength(1);
    const listed = await person.ok<{ folders: { name: string; path: string; git: string }[] }>("GET", `/api/machines/${mine[0]!.id}/folders?under=${encodeURIComponent("~/work")}`);
    expect(listed.folders.find((f) => f.name === "notes")).toMatchObject({ path: "~/work/notes", git: "none" });
    const opened = await person.ok<{ project: { id: string; facts: { git: string } } }>("POST", "/api/projects", { machineId: mine[0]!.id, path: "~/work/notes" });
    expect(opened.project.facts.git).toBe("none");
    return { orchestrator, tenant, person, machine, runner: runner!, machineId: mine[0]!.id, folder, projectId: opened.project.id, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/**
 * A team's or the cloud's orchestrator where a task runs on its person's own machine: a folder of
 * that machine with no Git is worked on in place there, and its task ends at Review changes on the
 * orchestrator's page, with Undo putting the folder back through the machine. The real runner
 * service pairs the machine; the machine is the solo scenarios' clean one, its agent the stand-in.
 */
test.describe("a folder with no Git on a person's connected machine", () => {
  // What the scenario after it takes for granted, so a broken setup is red here rather than an expected failure there.
  test("given a team's orchestrator whose tasks run on people's machines, when a person runs the command Connect this computer shows on their machine and opens a folder of it with no Git, then the machine reads connected, its folder list names the folder with no Git, and the folder is a project", async ({ page }) => {
    test.setTimeout(300_000);
    // given, when
    const connected = await connectedFolder(page);
    try {
      // then
      expect(connected.machine.trapped()).toEqual([]);
      expect(connected.runner.said()).toContain(`This machine is connected to ${connected.tenant} as ${MACHINE}.`);
    } finally {
      await connected.stop();
    }
  });

  test("given a person's connected machine and a folder of it with no Git opened as a project, when they start a task there, then the agent edits the folder in place on the machine, the task's page draws Review changes with the file and its diff, the folder holds no .git and its record is in the machine's data, and Undo on that page puts the folder back byte for byte", async ({ page }) => {
    test.setTimeout(600_000);
    // given
    const connected = await connectedFolder(page);
    try {
      const { person, folder } = connected;
      const before = contents(folder);

      // when
      const { task } = await person.ok<{ task: { id: string } }>("POST", "/api/tasks", { title: TITLE, description: "", repoId: connected.projectId, agent: "claude-code" });
      const done = await until(() => person.ok<{ task: Done }>("GET", `/api/tasks/${task.id}`).then((r) => r.task), (t) => !["queued", "running"].includes(t.status), 2400);

      // then the task ran on the machine and ends at its changes
      expect([done.status, done.error, done.result, done.requestNumber]).toEqual(["needs-review", null, "changes", null]);
      expect(done.changes?.files.map((f) => f.path)).toEqual(["src/endpoints/delivery-window.ts"]);
      expect(readFileSync(join(folder, "src", "endpoints", "delivery-window.ts"), "utf8")).toContain('path: "/delivery-window"');
      expect(existsSync(join(folder, ".git"))).toBe(false);
      const machineData = process.platform === "darwin" ? join(connected.machine.home, "Library", "Application Support", "TeamHandbook Orchestrator") : join(connected.machine.home, ".local", "share", "teamhandbook-orchestrator");
      expect(existsSync(join(machineData, "runner", "machines", connected.tenant, "shadow", connected.projectId, "HEAD"))).toBe(true);
      expect(connected.machine.trapped()).toEqual([]);

      // and its page draws Review changes with the changed file and its diff
      await drawnTaskPage(page, `${connected.orchestrator.url}/${connected.tenant}/tasks/${task.id}`, TITLE);
      const review = page.getByRole("region", { name: /Changes in this folder/ });
      await expect(review.locator("ul.diff-files > li")).toHaveCount(1);
      await review.locator("ul.diff-files > li summary", { hasText: "src/endpoints/delivery-window.ts" }).click();
      await expect(review.locator("ul.diff-files > li")).toContainText('path: "/delivery-window"');

      // when they press Undo on that page and confirm
      await review.getByRole("button", { name: "Undo these changes…" }).click();
      await page.getByRole("button", { name: "Undo changes" }).click();

      // then the page says it was undone, and the machine put the folder back byte for byte
      await expect(review.getByText(/^Undone by /)).toBeVisible({ timeout: 60_000 });
      expect(contents(folder)).toEqual(before);
    } finally {
      await connected.stop();
    }
  });
});
