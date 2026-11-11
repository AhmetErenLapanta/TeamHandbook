import { describe, expect, it } from "vitest";
import { UNKNOWN_COST } from "../tasks/types.js";
import { ADA, jiraOrchestrator as orchestrator_, PAT, put, SAM, SITE, TOKEN } from "./jira-stand-in.js";

describe("the organization's Jira boards, shown by team", () => {
  it("given two boards and none mapped, when an admin, the Payments owner and a member list them, then only the admin sees them", async () => {
    // given
    const { call } = await orchestrator_();

    // when
    const ada = await call(ADA, "/api/work/boards?source=tracker");
    const pat = await call(PAT, "/api/work/boards?source=tracker");
    const sam = await call(SAM, "/api/work/boards?source=tracker");

    // then
    expect(ada.body.boards.map((b: { id: string; name: string; team: null }) => [b.id, b.name, b.team])).toEqual([["tracker~12", "Payments board", null], ["tracker~13", "People ops", null]]);
    expect(pat.body.boards).toEqual([]);
    expect(sam.body.boards).toEqual([]);
  });

  it("given the admin maps the Payments board to Payments, when the Payments owner lists boards and asks for the other board's sprints, then they see only theirs and the other board is unknown, with Jira not asked for it", async () => {
    // given
    const { call, events, asked } = await orchestrator_();
    const mapped = await call(ADA, "/api/work/boards/teams", put({ boards: [{ boardId: "tracker~12", team: "Payments" }] }));

    // when
    const boards = await call(PAT, "/api/work/boards?source=tracker");
    const other = await call(PAT, "/api/work/sprints?board=tracker~13");

    // then
    expect(mapped.body.boards).toEqual([{ boardId: "tracker~12", name: "Payments board", team: "Payments" }, { boardId: "tracker~13", name: "People ops", team: null }]);
    expect(events).toEqual(["ada@example.invalid work.boards.teams mapped the organization's boards to teams: tracker~12 -> Payments"]);
    expect(boards.body.boards.map((b: { id: string; team: string }) => [b.id, b.team])).toEqual([["tracker~12", "Payments"]]);
    expect(other.status).toBe(404);
    expect(asked.some((p) => p.startsWith("/rest/agile/1.0/board/13"))).toBe(false);
  });

  it("given a member, when they map a board to a team, then they are refused and nothing is mapped", async () => {
    // given
    const { call } = await orchestrator_();

    // when
    const refused = await call(PAT, "/api/work/boards/teams", put({ boards: [{ boardId: "tracker~12", team: "Payments" }] }));

    // then
    expect(refused.status).toBe(403);
    expect((await call(PAT, "/api/work/boards?source=tracker")).body.boards).toEqual([]);
  });

  it("given ids that are not boards this person is shown, when they are sent back, then each is unknown and none reaches a Jira path", async () => {
    // given
    const { call, asked } = await orchestrator_();
    await call(ADA, "/api/work/boards/teams", put({ boards: [{ boardId: "tracker~12", team: "Payments" }] }));
    const before = asked.length;

    // when
    const answers = [];
    for (const path of ["/api/work/sprints?board=tracker~12/../../rest/api/3/myself", "/api/work/sprints?board=tracker~99", "/api/work/items?sprint=tracker~12~99", "/api/work/items?sprint=tracker~12~34%3Fx", "/api/work/sprints?board=mcp:atlassian~PAY"]) answers.push(await call(PAT, path));

    // then
    expect(answers.map((a) => a.status)).toEqual([404, 404, 404, 404, 404]);
    expect(asked.slice(before).filter((p) => !p.startsWith("/rest/agile/1.0/board?") && !p.startsWith("/rest/agile/1.0/board/12/sprint?"))).toEqual([]);
  });
});

describe("a sprint on the team's own workflow", () => {
  it("given the active sprint with three issues and a task on one, when the Payments owner reads it, then each issue sits in its board column with its points, epic, flags and task, and the progress counts them", async () => {
    // given
    const { ctx, call } = await orchestrator_();
    await call(ADA, "/api/work/boards/teams", put({ boards: [{ boardId: "tracker~12", team: "Payments" }] }));
    await ctx.store.createTask({ tenant: "acme", id: "tsk_pay142000001", repoId: "payments-skills", team: "Payments", title: "t", description: "", issueUrl: `${SITE}/browse/PAY-142`, issueKey: "PAY-142", agent: "claude", status: "running", createdBy: PAT.email, createdAt: "2026-11-02T09:00:00.000Z", startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: UNKNOWN_COST, requestNumber: null, error: null });

    // when
    const sprints = await call(PAT, "/api/work/sprints?board=tracker~12");
    const columns = await call(PAT, "/api/work/boards/tracker~12/columns");
    const items = await call(PAT, `/api/work/items?sprint=${encodeURIComponent(sprints.body.sprints[0].id)}`);

    // then
    expect(sprints.body.sprints).toEqual([
      { id: "tracker~12~34", name: "Sprint 34", state: "active", startsAt: "2026-11-01T00:00:00.000Z", endsAt: "2026-11-14T00:00:00.000Z", goal: "Refunds" },
      { id: "tracker~12~35", name: "Sprint 35", state: "future", startsAt: null, endsAt: null, goal: null },
    ]);
    expect(columns.body.columns.map((c: { name: string }) => c.name)).toEqual(["Ready for Dev", "In Dev", "Code Review", "Done"]);
    expect(items.body.columns).toEqual(columns.body.columns);
    const [first, second, third] = items.body.items;
    expect(first).toEqual({
      key: "PAY-142",
      url: `${SITE}/browse/PAY-142`,
      summary: "Round refunds half to even",
      type: "Story",
      status: { name: "In Dev", category: "doing" },
      column: "In Dev",
      assignee: { name: "Pat Owner", you: true },
      priority: "High",
      epic: { key: "PAY-100", summary: "Refund accuracy" },
      labels: ["refunds"],
      storyPoints: 3,
      blocked: true,
      tasks: [{ taskId: "tsk_pay142000001", status: "running", phase: "working", result: null, targets: [], requests: [], startedBy: PAT.email, costUsd: null }],
    });
    expect([second.column, second.blocked, second.storyPoints, second.tasks]).toEqual(["Done", true, 5, []]);
    expect([third.column, third.blocked, third.epic, third.status.category]).toEqual([null, false, null, "todo"]);
    expect(items.body.progress).toEqual({ todo: 1, doing: 1, done: 1, points: { total: 8, done: 5 } });
  });

  it("given an issue title carrying the token, when the sprint is read, then the token reaches no answer", async () => {
    // given
    const { call } = await orchestrator_();

    // when
    const items = await call(ADA, "/api/work/items?sprint=tracker~12~34");

    // then
    expect(items.body.items[1].summary).not.toContain(TOKEN);
    expect(items.body.items[0].assignee).toEqual({ name: "Pat Owner", you: false });
    expect(JSON.stringify(items.body)).not.toContain("pat@example.invalid");
    expect(JSON.stringify(items.body)).not.toContain(TOKEN);
  });

  it("given a Kanban board, when its sprints are asked for, then there are none", async () => {
    // given
    const { call } = await orchestrator_();

    // when
    const sprints = await call(ADA, "/api/work/sprints?board=tracker~13");

    // then
    expect(sprints.body.sprints).toEqual([]);
  });

  it("given the boards read a moment ago, when they are listed again, then Jira is not asked twice", async () => {
    // given
    const { call, asked } = await orchestrator_();
    await call(ADA, "/api/work/boards?source=tracker");

    // when
    await call(ADA, "/api/work/boards?source=tracker");

    // then
    expect(asked.filter((p) => p.startsWith("/rest/agile/1.0/board?"))).toHaveLength(1);
  });
});

describe("the organization's boards for every member (BA-3)", () => {
  it("given the Payments board mapped to Payments, when a member of the organization whose teams are open and one kept off Payments list boards, then only the first sees it and reads its sprint", async () => {
    // given
    const { call } = await orchestrator_();
    await call(ADA, "/api/work/boards/teams", put({ boards: [{ boardId: "tracker~12", team: "Payments" }] }));
    const open = { ...SAM, restrictedTeams: [] };
    const kept = { ...SAM, restrictedTeams: ["Payments"] };

    // when
    const forOpen = await call(open, "/api/work/boards?source=tracker");
    const sprint = await call(open, "/api/work/items?sprint=tracker~12~34");
    const forKept = await call(kept, "/api/work/boards?source=tracker");

    // then
    expect(forOpen.body.boards.map((b: { id: string }) => b.id)).toEqual(["tracker~12"]);
    expect(sprint.status).toBe(200);
    expect(forKept.body.boards).toEqual([]);
  });
});

