import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { Evidence, FAIL_GATE } from "../evidence.js";
import { until } from "../solo.js";
import { connectLaptop, runOnMachine, signInOnPage, stopRunner, teamOrchestrator } from "./machines.js";
import type { Laptop, TeamOrchestrator } from "./machines.js";
import { lab } from "./support.js";

/** The account the stand-in claude reports itself signed in with on a machine (lab/stand-in-claude.mjs). */
const AGENT_ACCOUNT = "solo@person.example.invalid";
const TITLE = "Add a note to the first skill";

const machineData = (home: string) => (process.platform === "darwin" ? join(home, "Library", "Application Support", "TeamHandbook Orchestrator") : join(home, ".local", "share", "teamhandbook-orchestrator"));

/** Where the machine keeps its connection: its token and its key, in a file only its person reads. */
const profileOf = (laptop: Laptop, tenant: string) => join(machineData(laptop.machine.home), "runner", "machines", tenant, "profile.json");

/** Every file under a directory with its text. */
const filesUnder = (dir: string): { name: string; text: string }[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ name: join(e.parentPath, e.name), text: readFileSync(join(e.parentPath, e.name), "latin1") }));

const root = (team: TeamOrchestrator, what: string) => join(lab.dir, "own-machine", team.tenant, what);

/** Which machine holds a task, as the orchestrator's store records it; the screens and the API name none. */
function claimedBy(team: TeamOrchestrator, taskId: string): string | null {
  const db = new DatabaseSync(join(team.dataDir, "orchestrator.db"), { readOnly: true });
  try {
    return ((db.prepare("SELECT claimed_by FROM tasks WHERE id = ?").get(taskId) as { claimed_by: string | null } | undefined)?.claimed_by) ?? null;
  } finally {
    db.close();
  }
}

interface Shown {
  status: string;
  startedAt: string | null;
  waitingFor: "machine" | "connect" | null;
}

/**
 * A task runs on the machine of the person who takes it, with the agent installed there, and on
 * no other: no teammate's machine, no shared one and not the orchestrator's. A person connects
 * their machine once, with the command Settings shows them. The orchestrator is a team's of its
 * own for each scenario (lab/tests/machines.ts), reached by its machines through a link the
 * scenario cuts and gives back; a machine is a clean one running the packed orchestrator's runner
 * with the stand-in claude. Each run keeps an evidence directory (lab/evidence.ts) with the
 * machine's output beside the orchestrator's log and store, redacted. Run alone on one machine,
 * the orchestrator is that machine, and no connecting step exists (solo.spec.ts).
 */
test.describe("work runs on the machine of the person who takes it", () => {
  let evidence: Evidence | null = null;
  test.afterEach(async ({}, testInfo) => {
    evidence?.decide(testInfo.status === testInfo.expectedStatus, testInfo.error?.message ?? "");
    evidence = null;
  });

  test("given a member with a laptop and no machine connected yet, when they connect it once with the command Settings shows them, then the machine is theirs with the agents it has, the same code connects no second machine, and neither the code, the machine's key nor its agent's account reaches the orchestrator's store, its log or the evidence", async ({ page }) => {
    test.setTimeout(300_000);
    // given
    const team = await teamOrchestrator("own-machine");
    const proof = new Evidence(lab.dir, team.tenant, [lab.password]);
    evidence = proof;
    let laptop: Laptop | null = null;
    let second: ReturnType<typeof runOnMachine> | null = null;
    const secrets: string[] = [];
    try {
      // when
      laptop = await connectLaptop(page, team, "member", root(team, "laptop"));
      const code = laptop.command.at(-1)!;
      const profile = JSON.parse(readFileSync(profileOf(laptop, team.tenant), "utf8")) as Record<string, string>;
      const token = profile.token!;
      secrets.push(code, token);
      // The fault --fail-gate leaves in: the machine's token is not handed to the evidence. Its profile is kept a value a
      // line, where no field name marks the token, so only the scenario's secrets mask it.
      for (const secret of FAIL_GATE ? [code] : secrets) proof.add(secret);
      proof.write("machine-profile.txt", Object.values(profile).join("\n") + "\n");
      const member = await team.as("member");
      const listed = await until(() => member.ok<{ machines: { name: string; agents: { id: string }[] }[] }>("GET", "/api/machines").then((r) => r.machines), (ms) => ms.some((m) => m.agents.length > 0), 240);
      second = runOnMachine(root(team, "second"), laptop.command, "second-laptop");
      const ended = await Promise.race([second.runner.exited, new Promise<"still running">((r) => setTimeout(() => r("still running"), 60_000))]);

      // then the machine is the member's, with the agent it has
      expect(listed.map((m) => [m.name, m.agents.map((a) => a.id)])).toEqual([[laptop.name, ["claude-code"]]]);
      expect(laptop.runner.said()).toContain(`This machine is connected to ${team.tenant} as ${laptop.name}.`);
      // and the code it used connects nothing else
      expect([ended, second.runner.said()]).toEqual([1, expect.stringMatching(/^handbook-orchestrator: /)]);
      expect((await member.ok<{ machines: unknown[] }>("GET", "/api/machines")).machines).toHaveLength(1);
      expect([...laptop.machine.trapped(), ...second.machine.trapped()]).toEqual([]);
    } finally {
      await laptop?.stop();
      if (second) await stopRunner(second.runner);
      proof.write("machine.txt", laptop?.runner.said() ?? "");
      await team.stop();
      proof.copy("orchestrator.log", team.orchestrator.log);
      proof.store(join(team.dataDir, "orchestrator.db"));
    }

    // and none of the machine's credentials, nor its agent's account, reach the orchestrator's store or log, nor the evidence
    const kept = [...filesUnder(team.dataDir).filter((f) => /orchestrator\.db/.test(f.name)), { name: "the orchestrator's log", text: readFileSync(team.orchestrator.log, "utf8") }, ...filesUnder(proof.dir)];
    expect(kept.map((f) => f.name.slice(proof.dir.length + 1))).toEqual(expect.arrayContaining(["machine.txt", "machine-profile.txt", "orchestrator.log", "store/machines.ndjson"]));
    for (const { name, text } of kept) {
      for (const secret of secrets) expect(text.includes(secret), `${name} holds a credential of the machine`).toBe(false);
      expect(text.includes(AGENT_ACCOUNT), `${name} holds the account of the machine's agent`).toBe(false);
    }
  });

  test("given a member whose machine is not connected and a teammate whose machine is, when the member starts a task, then the task says Connect your machine, nothing runs on the teammate's machine or on the orchestrator, and once the member connects theirs the same task is taken by it", async ({ page }) => {
    test.setTimeout(300_000);
    // given
    const team = await teamOrchestrator("own-machine");
    let teammates: Laptop | null = null;
    let members: Laptop | null = null;
    try {
      teammates = await connectLaptop(page, team, "teammate", root(team, "teammate-laptop"));
      const member = await team.as("member");

      // when the member starts a task
      const { task } = await member.ok<{ task: { id: string } }>("POST", "/api/tasks", { title: TITLE, description: "", repoId: team.repoId, agent: "claude-code" });
      await signInOnPage(page, team, team.person("member").email);
      await page.goto(`${team.url}/${team.tenant}/tasks/${task.id}`);

      // then it waits for the member's machine, and the teammate's takes it through more than one of its polls
      await expect(page.getByText("This task waits for your machine: none of yours is connected yet.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Connect your machine" })).toBeVisible();
      await new Promise((r) => setTimeout(r, 5_000));
      const waiting = await member.ok<{ task: Shown }>("GET", `/api/tasks/${task.id}`);
      expect([waiting.task.status, waiting.task.startedAt, waiting.task.waitingFor, claimedBy(team, task.id)]).toEqual(["queued", null, "connect", null]);

      // when the member connects theirs
      members = await connectLaptop(page, team, "member", root(team, "member-laptop"));

      // then the member's machine takes the same task, and the teammate's never did
      await until(() => claimedBy(team, task.id), (holder) => holder !== null, 240);
      expect(claimedBy(team, task.id)).toBe(members.id);
      expect((await member.ok<{ task: Shown }>("GET", `/api/tasks/${task.id}`)).task.waitingFor).toBeNull();
      expect(teammates.runner.said()).not.toContain(task.id);
      expect([...teammates.machine.trapped(), ...members.machine.trapped()]).toEqual([]);
    } finally {
      await members?.stop();
      await teammates?.stop();
      await team.stop();
    }
  });

  test.fixme("given a task at work on the member's machine, when the machine loses its connection in the middle and gets it back, then the task runs once, opens one request, and its page shows the machine out of touch and back", async () => {
    // Bound once a task runs on a person's machine in the lab: the machine clones over https or ssh alone, and the lab's stand-in forges answer http.
  });

  test.fixme("given a task at work on the member's machine, when the machine sleeps longer than the orchestrator waits for it and wakes, then the task does not read running forever, does not run twice, and says what became of it", async () => {
    // Bound with the scenario before it, once a task runs on a person's machine in the lab.
  });

  test("given a member's connected machine, when they remove it in Settings, then the machine is told the orchestrator no longer takes it, it takes no task, and the next start says Connect your machine", async ({ page }) => {
    test.setTimeout(300_000);
    // given
    const team = await teamOrchestrator("own-machine");
    let laptop: Laptop | null = null;
    try {
      laptop = await connectLaptop(page, team, "member", root(team, "laptop"));
      const member = await team.as("member");

      // when they remove it in Settings
      await page.goto(`${team.url}/${team.tenant}/settings/machines`);
      await page.getByRole("button", { name: `Remove ${laptop.name}` }).click();
      await page.getByRole("button", { name: "Remove machine" }).click();

      // then it reads removed, and the machine is told at its next call
      const { machines } = await member.ok<{ machines: { name: string; revokedAt: string | null }[] }>("GET", "/api/machines");
      expect(machines.find((m) => m.name === laptop!.name)?.revokedAt).not.toBeNull();
      const told = await until(() => laptop!.runner.said(), (said) => said.includes("the orchestrator no longer takes this machine; connect it again from Settings"), 240);
      expect(told).toContain("the orchestrator no longer takes this machine; connect it again from Settings");

      // when the member starts a task
      const { task } = await member.ok<{ task: { id: string } }>("POST", "/api/tasks", { title: TITLE, description: "", repoId: team.repoId, agent: "claude-code" });
      await new Promise((r) => setTimeout(r, 5_000));

      // then it waits for a machine of theirs to be connected, and the removed one took nothing
      const shown = await member.ok<{ task: Shown }>("GET", `/api/tasks/${task.id}`);
      expect([shown.task.status, shown.task.waitingFor, claimedBy(team, task.id)]).toEqual(["queued", "connect", null]);
      expect(laptop.machine.trapped()).toEqual([]);
    } finally {
      await laptop?.stop();
      await team.stop();
    }
  });
});
