import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ownerKey } from "../state.js";
import type { OrchestratorClient } from "../client.js";
import { SPRINT_ISSUES } from "../multi-repo.js";
import { as, close, lab, onForge, runToReview, signInOnPage } from "./support.js";

const org = lab.orgs.find((o) => o.fixture === "multi-repo");
const code = (org?.repos ?? []).filter((r) => r.code);

interface SprintIssue {
  key: string;
  fields: { summary: string; status: { name: string } };
}

interface Shown {
  id: string;
  status: string;
  error: string | null;
  targets: { repoId: string; status: string; request: { number: number } | null }[] | null;
}

/** The stand-in Jira, read with the account the orchestrator is given. */
async function jira<T>(path: string): Promise<T> {
  const res = await fetch(`${lab.jira!.url}${path}`, { headers: { authorization: `Basic ${Buffer.from(`${lab.jira!.email}:${lab.jira!.token}`).toString("base64")}` } });
  return (await res.json()) as T;
}

/** The active sprint of the team's board and its issues, as a sprint view reads them. */
async function activeSprint(): Promise<{ id: number; name: string; issues: SprintIssue[] }> {
  const { values } = await jira<{ values: { id: number }[] }>("/rest/agile/1.0/board?projectKeyOrId=HOO");
  const { values: sprints } = await jira<{ values: { id: number; name: string }[] }>(`/rest/agile/1.0/board/${values[0]!.id}/sprint?state=active`);
  const { issues } = await jira<{ issues: SprintIssue[] }>(`/rest/agile/1.0/sprint/${sprints[0]!.id}/issue`);
  return { ...sprints[0]!, issues };
}

/** The Customers board on the organization's tracker, as the Work pages name it. */
const BOARD = "tracker~7";
const SPRINT_ISSUE = SPRINT_ISSUES[0]!;

/** The organization's tracker: the stand-in Jira, with the token given. */
async function connectTracker(admin: OrchestratorClient, token: string): Promise<void> {
  await admin.ok("PUT", "/api/integrations/tracker", { kind: "jira", url: lab.jira!.url, email: lab.jira!.email, token });
}

const transitions = async () => ((await (await fetch(`${lab.jira!.url}/lab/transitions`)).json()) as { transitions: { key: string; from: string; to: string }[] }).transitions;

const jiraWrites = () => readFileSync(join(lab.dir, "logs", "jira.log"), "utf8").split("\n").filter((l) => l.endsWith(" WRITE"));
// An issue link is https and carries the key; the orchestrator reads the issue from the tracker it is connected to.
const linkOf = (key: string) => `https://tracker.example.invalid/browse/${key}`;

test.describe("a sprint's issues worked by agents side by side", () => {
  test.skip(!org || !lab.jira, "this lab has no organization with code repositories or no stand-in tracker");

  test.beforeAll(async () => {
    // The tracker read with the token that only reads, and the board kept to the Customers team.
    const admin = await as(org!, "org-admin");
    await connectTracker(admin, lab.jira!.token);
    await admin.ok("PUT", "/api/work/boards/teams", { boards: [{ boardId: BOARD, team: "Customers" }] });
  });

  test("given the active sprint's three issues on the team's board, when the team's owner starts a task for each at once, each planned by the orchestrator across the code repositories, then the three run side by side, each opens its requests under its own key in every repository, and nothing is written to Jira", async () => {
    test.setTimeout(420_000);
    // given
    const owner = await as(org!, ownerKey("Customers"));
    const sprint = await activeSprint();
    const writesBefore = jiraWrites().length;

    // when
    const started = await Promise.all(
      sprint.issues.map((issue) =>
        owner.ok<{ task: { id: string } }>("POST", "/api/tasks", { title: issue.fields.summary, description: "stand-in: wait 6 seconds", repoId: code[0]!.id, agent: "claude-code", issueUrl: linkOf(issue.key), targets: "orchestrator" }).then((r) => ({ key: issue.key, id: r.task.id })),
      ),
    );
    let together = 0;
    let shown: (Shown & { key: string })[] = [];
    for (let i = 0; i < 960; i++) {
      shown = await Promise.all(started.map(async (s) => ({ key: s.key, ...(await owner.ok<{ task: Shown }>("GET", `/api/tasks/${s.id}`)).task })));
      together = Math.max(together, shown.filter((t) => t.status === "running").length);
      if (shown.every((t) => ["needs-review", "failed", "cancelled"].includes(t.status))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      // then
      expect(sprint.name).toBe("Customers Sprint 14");
      expect(sprint.issues.map((i) => i.key)).toEqual(["HOO-412", "HOO-413", "HOO-414"]);
      expect(together).toBe(3);
      for (const task of shown) {
        expect([task.key, task.status, task.error]).toEqual([task.key, "needs-review", null]);
        expect(task.targets!.map((t) => [t.repoId, t.status])).toEqual(["shipment-service", "customer-bff", "customer-gateway"].map((id) => [id, "request"]));
        for (const target of task.targets!) expect((await onForge(code.find((r) => r.id === target.repoId)!, target.request!.number)).source).toContain(task.key);
      }
      expect(jiraWrites().length).toBe(writesBefore);
    } finally {
      for (const task of shown) for (const target of task.targets ?? []) if (target.request) await close(org!, code.find((r) => r.id === target.repoId)!, target.request.number);
    }
  });

  test("given the Customers board read with the organization's Jira token, when people open its sprint, then the orchestrator names the board, its columns as the team's own workflow, its active sprint's three issues and its backlog, a member of the organization sees it as the board of a team whose work they read, and so does the team's owner", async () => {
    // given
    const admin = await as(org!, "org-admin");
    const owner = await as(org!, ownerKey("Customers"));
    const member = await as(org!, "member");

    // when
    const { sources } = await admin.ok<{ sources: { id: string; via: string; can: { write: boolean }; writeProblem: string | null; problem: string | null }[] }>("GET", "/api/work/sources");
    const { boards } = await admin.ok<{ boards: { id: string; name: string; type: string }[] }>("GET", "/api/work/boards?source=tracker");
    const board = boards.find((b) => b.name === "Customers board")!;
    const { columns } = await admin.ok<{ columns: { name: string }[] }>("GET", `/api/work/boards/${board.id}/columns`);
    const { sprints } = await admin.ok<{ sprints: { id: string; name: string; state: string }[] }>("GET", `/api/work/sprints?board=${board.id}`);
    const active = sprints.find((x) => x.state === "active")!;
    const items = await admin.ok<{ items: { key: string; column: string; storyPoints: number | null }[]; progress: { todo: number; points: { total: number } | null } }>("GET", `/api/work/items?sprint=${active.id}`);
    const backlog = await admin.ok<{ items: { key: string }[] }>("GET", `/api/work/items?backlog=${board.id}`);
    const memberBoards = await member.ok<{ boards: unknown[] }>("GET", "/api/work/boards?source=tracker");
    const ownerBoards = await owner.ok<{ boards: { id: string }[] }>("GET", "/api/work/boards?source=tracker");

    // then
    expect(sources.find((x) => x.id === "tracker")).toMatchObject({ via: "token", can: { write: false }, writeProblem: "The organization's Jira token has no permission to move issues", problem: null });
    expect(board.type).toBe("scrum");
    expect(columns.map((c) => c.name)).toEqual(["Ready for Dev", "In Dev", "Code Review", "Ready for Test", "In Test", "Test Passed", "Done"]);
    expect([active.name, sprints.map((x) => x.state).sort()]).toEqual(["Customers Sprint 14", ["active", "future"]]);
    expect(items.items.map((i) => [i.key, i.column, i.storyPoints])).toEqual([["HOO-412", "Ready for Dev", 5], ["HOO-413", "Ready for Dev", 3], ["HOO-414", "Ready for Dev", 2]]);
    expect(items.progress).toMatchObject({ todo: 3, points: { total: 10 } });
    expect(backlog.items.map((i) => i.key)).toEqual(["HOO-415", "HOO-416"]);
    expect((memberBoards.boards as { id: string }[]).map((b) => b.id)).toEqual([board.id]);
    expect(ownerBoards.boards.map((b) => b.id)).toContain(board.id);
  });

  test("given the sprint's three issues, when the team's owner starts agents for them together, then the board's cards each link their task and requests while the agents work, a teammate's move in Jira shows on a fresh read, the backlog keeps no task, and with no move set nothing is written to Jira", async () => {
    test.setTimeout(420_000);
    // given
    const owner = await as(org!, ownerKey("Customers"));
    const sprint = (await owner.ok<{ sprints: { id: string; state: string }[] }>("GET", `/api/work/sprints?board=${BOARD}`)).sprints.find((x) => x.state === "active")!;
    const { items } = await owner.ok<{ items: { key: string; summary: string }[] }>("GET", `/api/work/items?sprint=${sprint.id}`);
    const writesBefore = jiraWrites().length;

    // when
    const batch = await owner.ok<{ started: { id: string }[]; refused: { index: number; error: string }[] }>("POST", "/api/tasks/batch", {
      agent: "claude-code",
      items: items.map((i) => ({ issueUrl: linkOf(i.key), repoId: code[0]!.id, targets: "orchestrator", title: i.summary, description: "stand-in: wait 6 seconds" })),
    });
    const linked = async () => (await owner.ok<{ items: { key: string; column: string; tasks: { taskId: string; status: string; requests: { repoId: string; number: number }[] }[] }[] }>("GET", `/api/work/items?sprint=${sprint.id}&fresh=1`)).items;
    let cards = await linked();
    for (let i = 0; i < 960 && !cards.every((c) => c.tasks[0]?.status === "needs-review"); i++) {
      await new Promise((r) => setTimeout(r, 500));
      cards = await linked();
    }
    await fetch(`${lab.jira!.url}/lab/move`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "HOO-414", status: "Ready for Test" }) });
    let moved = await linked();
    for (let i = 0; i < 160 && moved.find((c) => c.key === "HOO-414")?.column !== "Ready for Test"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      moved = await linked();
    }
    try {
      // then
      expect(batch.refused).toEqual([]);
      expect(batch.started).toHaveLength(3);
      for (const card of cards) {
        expect([card.key, card.tasks[0]?.status, card.tasks[0]?.requests.map((r) => r.repoId).sort()]).toEqual([card.key, "needs-review", ["customer-bff", "customer-gateway", "shipment-service"]]);
      }
      expect(moved.find((c) => c.key === "HOO-414")?.column).toBe("Ready for Test");
      expect((await owner.ok<{ items: { tasks: unknown[] }[] }>("GET", `/api/work/items?backlog=${BOARD}`)).items.every((i) => i.tasks.length === 0)).toBe(true);
      expect(jiraWrites().length).toBe(writesBefore);
      expect(await transitions()).toEqual([]);
    } finally {
      await fetch(`${lab.jira!.url}/lab/move`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "HOO-414", status: "Ready for Dev" }) });
      for (const card of cards) for (const r of card.tasks[0]?.requests ?? []) await close(org!, code.find((c) => c.id === r.repoId)!, r.number);
    }
  });

  test("given the Customers board, when an owner turns on moving issues, then with the reading token it is refused with the reason, and once the tracker holds a token that moves issues it is saved and logged, and a sprint issue moves to In Dev when its agent starts and to Code Review when its request opens", async () => {
    test.setTimeout(300_000);
    // given
    const admin = await as(org!, "org-admin");
    const owner = await as(org!, ownerKey("Customers"));
    const wanted = { started: "In Dev", requestOpened: "Code Review" };

    // when the tracker reads only
    const offered = await admin.ok<{ enabled: boolean; guessed: boolean; write: { allowed: boolean; reason: string | null }; moves: Record<string, string> }>("GET", `/api/work/moves?board=${BOARD}`);
    const refusedOn = await admin.call<{ error?: string }>("PUT", `/api/work/moves?board=${BOARD}`, { enabled: true, moves: wanted });

    // then
    expect(offered).toMatchObject({ enabled: false, guessed: true, write: { allowed: false }, moves: { started: "In Dev", requestOpened: "Code Review", merged: "Done" } });
    expect([refusedOn.status, refusedOn.json.error]).toEqual([400, "The organization's Jira token has no permission to move issues"]);

    // when an admin gives the tracker a token that moves issues
    await connectTracker(admin, lab.jira!.writeToken!);
    const changedAt = Date.now();
    let allowed = false;
    for (let i = 0; i < 160 && !allowed; i++) {
      allowed = (await admin.ok<{ write: { allowed: boolean } }>("GET", `/api/work/moves?board=${BOARD}`)).write.allowed;
      if (!allowed) await new Promise((r) => setTimeout(r, 500));
    }
    // A new token is read for what it is allowed when it is saved, not a minute later.
    expect(Date.now() - changedAt, "how long the orchestrator took to see the new token's permission").toBeLessThan(5_000);
    try {
      const saved = await admin.ok<{ enabled: boolean; moves: Record<string, string> }>("PUT", `/api/work/moves?board=${BOARD}`, { enabled: true, moves: wanted });
      const { events } = await admin.ok<{ events: { kind: string; detail: string }[] }>("GET", "/api/events?kind=work.moves");
      const issue = SPRINT_ISSUE;
      const task = await runToReview(owner, code[0]!, issue.summary, { agent: "claude-code", issueUrl: linkOf(issue.key), targets: "orchestrator", description: "" });

      // then
      expect(allowed).toBe(true);
      expect(saved).toMatchObject({ enabled: true, moves: wanted });
      expect(events[0]?.detail).toBe("turned on moving issues on Customers board: started -> In Dev, requestOpened -> Code Review");
      expect(task.status).toBe("needs-review");
      expect((await transitions()).filter((t) => t.key === issue.key).map((t) => [t.from, t.to])).toEqual([["Ready for Dev", "In Dev"], ["In Dev", "Code Review"]]);
      for (const target of (await owner.ok<{ task: { targets: { repoId: string; request: { number: number } | null }[] } }>("GET", `/api/tasks/${task.id}`)).task.targets ?? []) {
        if (target.request) await close(org!, code.find((c) => c.id === target.repoId)!, target.request.number);
      }
    } finally {
      await admin.call("PUT", `/api/work/moves?board=${BOARD}`, { enabled: false, moves: wanted });
      await connectTracker(admin, lab.jira!.token);
      await fetch(`${lab.jira!.url}/lab/move`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: SPRINT_ISSUE.key, status: "Ready for Dev" }) });
    }
  });

  test("given the sprint board in the browser, when the team's owner opens it, picks an issue and starts its agent, then the columns are the team's workflow, the started card shows its agent working and then its request in review, and the start is not refused", async ({ page }) => {
    test.setTimeout(300_000);
    // given
    await signInOnPage(page, org!, ownerKey("Customers"));
    await page.goto(`${org!.url}/${org!.name}/work?source=tracker&board=${encodeURIComponent(BOARD)}&sprint=${encodeURIComponent(`${BOARD}~41`)}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Customers Sprint 14");
    const board = page.getByRole("group", { name: "Customers Sprint 14 board" });
    for (const column of ["Ready for Dev", "In Dev", "Code Review", "Done"]) await expect(board.getByRole("heading", { name: new RegExp(`^${column}\\b`) })).toBeVisible();

    // when
    await page.getByRole("checkbox", { name: "Pick HOO-413" }).check();
    await page.getByRole("region", { name: "Picked issues" }).getByRole("button", { name: "Start agents" }).click();
    const form = page.getByRole("form", { name: "Start agents" });
    await form.getByRole("radio", { name: /Let each agent find the repositories/ }).check();
    await form.getByRole("combobox", { name: "Agent", exact: true }).click();
    await page.getByRole("option", { name: "Claude Code" }).click();
    await form.getByRole("button", { name: "Start 1 agent" }).click();

    // then
    const result = page.getByRole("status").filter({ hasText: /started\./ });
    await expect(result).toHaveText(/^1 agent started\./);
    // "Done picking" once the results' button is told apart from the board's Done column; "Done" before.
    await page.getByRole("region", { name: /^Start agents/ }).getByRole("button", { name: /^Done( picking)?$/ }).click();
    const card = board.getByRole("listitem", { name: /^HOO-413 / });
    await expect(card.getByRole("link", { name: /Agent (queued|working)|Request in review/ })).toBeVisible({ timeout: 60_000 });
    await expect(card.getByRole("link", { name: "Request in review" })).toBeVisible({ timeout: 180_000 });
  });

  test("given the sprint board in the browser, when the team's owner picks the sprint's three issues and starts their agents together, then all three start, the board shows each card's agent, and the three run side by side to their requests", async ({ page }) => {
    test.setTimeout(420_000);
    // given
    const owner = await as(org!, ownerKey("Customers"));
    const sprint = `${BOARD}~41`;
    await signInOnPage(page, org!, ownerKey("Customers"));
    await page.goto(`${org!.url}/${org!.name}/work?source=tracker&board=${encodeURIComponent(BOARD)}&sprint=${encodeURIComponent(sprint)}`);
    const board = page.getByRole("group", { name: "Customers Sprint 14 board" });

    // when
    for (const key of ["HOO-412", "HOO-413", "HOO-414"]) await page.getByRole("checkbox", { name: `Pick ${key}` }).check();
    await page.getByRole("region", { name: "Picked issues" }).getByRole("button", { name: "Start agents" }).click();
    const form = page.getByRole("form", { name: "Start agents" });
    await form.getByRole("radio", { name: /Let each agent find the repositories/ }).check();
    await form.getByRole("combobox", { name: "Agent", exact: true }).click();
    await page.getByRole("option", { name: "Claude Code" }).click();
    await form.getByRole("button", { name: "Start 3 agents" }).click();
    await expect(page.getByRole("status").filter({ hasText: /started\./ })).toHaveText(/^3 agents started\./);
    await page.getByRole("region", { name: /^Start agents/ }).getByRole("button", { name: /^Done( picking)?$/ }).click();
    const linked = async () => (await owner.ok<{ items: { key: string; tasks: { taskId: string; status: string; requests: { repoId: string; number: number }[] }[] }[] }>("GET", `/api/work/items?sprint=${encodeURIComponent(sprint)}&fresh=1`)).items;
    let most = 0;
    let cards = await linked();
    for (let i = 0; i < 480 && !cards.every((c) => c.tasks[0]?.status === "needs-review"); i++) {
      most = Math.max(most, cards.filter((c) => c.tasks[0]?.status === "running").length);
      await new Promise((r) => setTimeout(r, 500));
      cards = await linked();
    }
    try {
      // then
      for (const key of ["HOO-412", "HOO-413", "HOO-414"]) await expect(board.getByRole("listitem", { name: new RegExp(`^${key} `) }).getByRole("link", { name: /Agent (queued|working)|Request in review/ })).toBeVisible();
      expect(cards.map((c) => [c.key, c.tasks[0]?.status])).toEqual([["HOO-412", "needs-review"], ["HOO-413", "needs-review"], ["HOO-414", "needs-review"]]);
      expect(most, "agents seen running at once").toBeGreaterThan(1);
    } finally {
      for (const card of cards) for (const r of card.tasks[0]?.requests ?? []) await close(org!, code.find((c) => c.id === r.repoId)!, r.number);
    }
  });
});
