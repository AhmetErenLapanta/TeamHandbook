import { describe, expect, it, vi } from "vitest";
import { restrictedKey } from "../accounts.js";
import type { Principal } from "../auth.js";
import { ORCHESTRATOR_ACTOR, recordEvent } from "../events.js";
import type { TaskRecord } from "../tasks/types.js";
import { UNKNOWN_COST } from "../tasks/types.js";
import { ADA, jiraOrchestrator, PAT, put, SAM, SITE } from "./jira-stand-in.js";
import { movesOnPhase, withMergeMoves } from "./move.js";

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function task(by: Principal, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    tenant: "acme", id: "tsk_pay142000001", repoId: "payments-skills", team: "Payments", title: "t", description: "", issueUrl: `${SITE}/browse/PAY-142`, issueKey: "PAY-142", agent: "claude", status: "running",
    createdBy: by.email, createdAt: "2026-11-02T09:00:00.000Z", startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: UNKNOWN_COST, requestNumber: null, error: null, ...over,
  };
}

/** The organization's Jira with the Payments board mapped to Payments, its switch as given, and Pat and Sam as accounts. */
async function board(enabled: boolean, writes = true) {
  const at = await jiraOrchestrator(undefined, writes);
  for (const user of [PAT, SAM]) await at.ctx.store.insertUser({ tenant: "acme", id: user.id, email: user.email, name: user.name, role: "member", passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: null, createdAt: "2026-11-01T00:00:00.000Z" });
  await at.ctx.store.setOwnedTeams("acme", PAT.id, ["Payments"]);
  await at.call(ADA, "/api/work/boards/teams", put({ boards: [{ boardId: "tracker~12", team: "Payments" }] }));
  await at.call(ADA, "/api/work/moves?board=tracker~12", put({ enabled, moves: { started: "In Dev", requestOpened: "Code Review", merged: "Done" } }));
  at.events.length = 0;
  return at;
}

describe("an issue moving as its task goes on", () => {
  it("given the switch on, when Pat's task starts its agent, opens its requests and then starts again, then the issue moves to In Dev and Code Review and never back, each move logged first", async () => {
    // given
    const { ctx, deps, moved, events } = await board(true);
    const onPhase = movesOnPhase(ctx, deps);

    // when
    await onPhase(task(PAT), "working");
    await onPhase(task(PAT), "review");
    await onPhase(task(PAT), "working");

    // then
    expect(moved).toEqual(["PAY-142 21", "PAY-142 31"]);
    expect(events).toEqual([
      "pat@example.invalid work.moved moved PAY-142 from Ready for Dev to In Dev (In Dev) with the organization's token, as the agent started on task tsk_pay142000001",
      "pat@example.invalid work.moved moved PAY-142 from In Dev to Code Review (Code Review) with the organization's token, as the requests opened on task tsk_pay142000001",
    ]);
  });

  it("given the switch off, when a task starts, then nothing moves and nothing is logged", async () => {
    // given
    const { ctx, deps, moved, events } = await board(false);

    // when
    await movesOnPhase(ctx, deps)(task(PAT), "working");

    // then
    expect([moved, events]).toEqual([[], []]);
  });

  it("given Payments open to every member and a task Sam started there, when its agent starts, then the issue moves, as the board is shown to whoever starts tasks on its team", async () => {
    // given
    const { ctx, deps, moved } = await board(true);

    // when
    await movesOnPhase(ctx, deps)(task(SAM), "working");

    // then
    expect(moved).toEqual(["PAY-142 21"]);
  });

  it("given Payments kept to its owners and a task Sam started there, when its agent starts, then the issue does not move, as the board is not shown to Sam", async () => {
    // given
    const { ctx, deps, moved } = await board(true);
    await ctx.store.setSetting("acme", restrictedKey("Payments"), "1");

    // when
    await movesOnPhase(ctx, deps)(task(SAM), "working");

    // then
    expect(moved).toEqual([]);
  });

  it("given an orchestrator with no event log, when a task starts, then the move is refused before it is sent", async () => {
    // given
    const { ctx, deps, moved } = await board(true);
    delete ctx.audit;

    // when
    const started = movesOnPhase(ctx, deps)(task(PAT), "working");

    // then
    await expect(started).rejects.toThrow(/event log/);
    expect(moved).toEqual([]);
  });

  it("given a task whose request merges, when the merge is written to the event log, then the issue moves to Done", async () => {
    // given
    const { ctx, deps, moved } = await board(true);
    await ctx.store.createTask(task(PAT, { status: "needs-review", requestNumber: 7 }));
    await ctx.store.saveRequest({ tenant: "acme", repoId: "payments-skills", number: 7, provider: "gitlab", url: "https://gitlab.example/acme/payments-skills/-/merge_requests/7", branch: "b", headSha: "a".repeat(40), title: "t", status: "merged", createdAt: "2026-11-02T10:00:00.000Z", createdBy: "x" });
    withMergeMoves(ctx.store, () => ctx, deps);

    // when
    await recordEvent(ctx, ORCHESTRATOR_ACTOR, "request.merged", { repoId: "payments-skills", subject: "request:7", detail: "merged on the forge" });

    // then
    await vi.waitFor(() => expect(moved).toEqual(["PAY-142 41"]));
  });
});

describe("an issue moved by hand on the board", () => {
  it("given the Payments owner on their team's board, when they move an issue to Code Review, then it moves, and someone not shown the board and an issue of another project are refused", async () => {
    // given
    const { call, moved } = await board(false);

    // when
    const byPat = await call(PAT, "/api/work/items/PAY-142/transition", post({ board: "tracker~12", column: "Code Review" }));
    const bySam = await call(SAM, "/api/work/items/PAY-142/transition", post({ board: "tracker~12", column: "Done" }));
    const otherProject = await call(PAT, "/api/work/items/HR-1/transition", post({ board: "tracker~12", column: "Done" }));

    // then
    expect([byPat.status, byPat.body]).toEqual([200, { status: { name: "Code Review", category: "doing" }, column: "Code Review" }]);
    expect([bySam.status, otherProject.status]).toEqual([404, 400]);
    expect(moved).toEqual(["PAY-142 31"]);
  });
});

describe("an issue left as it is while changing issues is off", () => {
  it("given the board's moves on but changing issues off under Integrations, when Pat's task starts, opens its requests and merges, then Jira is sent no write and not even asked for the issue's moves", async () => {
    // given
    const { ctx, deps, moved, writes, asked } = await board(true, false);
    await ctx.store.createTask(task(PAT, { status: "needs-review", requestNumber: 7 }));
    await ctx.store.saveRequest({ tenant: "acme", repoId: "payments-skills", number: 7, provider: "gitlab", url: "https://gitlab.example/acme/payments-skills/-/merge_requests/7", branch: "b", headSha: "a".repeat(40), title: "t", status: "merged", createdAt: "2026-11-02T10:00:00.000Z", createdBy: "x" });
    withMergeMoves(ctx.store, () => ctx, deps);
    const before = asked.length;

    // when
    await movesOnPhase(ctx, deps)(task(PAT), "working");
    await movesOnPhase(ctx, deps)(task(PAT), "review");
    await recordEvent(ctx, ORCHESTRATOR_ACTOR, "request.merged", { repoId: "payments-skills", subject: "request:7", detail: "merged on the forge" });
    await new Promise((r) => setTimeout(r, 50));

    // then
    expect([moved, writes]).toEqual([[], []]);
    expect(asked.slice(before).filter((p) => p.includes("/issue/"))).toEqual([]);
  });

  it("given changing issues off, when the Payments owner moves an issue by hand or turns the board's moves on, then each is refused with where it is turned on, and Jira is sent no write", async () => {
    // given
    const { call, moved, writes, asked } = await board(false, false);

    // when
    const byHand = await call(PAT, "/api/work/items/PAY-142/transition", post({ board: "tracker~12", column: "Code Review" }));
    const turnOn = await call(ADA, "/api/work/moves?board=tracker~12", put({ enabled: true, moves: { started: "In Dev" } }));
    const sources = await call(ADA, "/api/work/sources");

    // then
    const off = "Changing issues in Jira is off, so a card that moves here changes nothing there. An owner or an admin turns it on under Integrations.";
    expect([byHand.status, byHand.body.error]).toEqual([400, off]);
    expect([turnOn.status, turnOn.body.error]).toEqual([400, off]);
    expect(sources.body.sources[0]).toMatchObject({ can: { write: false }, writeProblem: off });
    expect([moved, writes]).toEqual([[], []]);
    expect(asked.some((p) => p.startsWith("/rest/agile/1.0/board"))).toBe(true);
  });
});
