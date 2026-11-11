import { describe, expect, it } from "vitest";
import { TRACKER_TOKEN_SECRET } from "../integrations/tracker.js";
import { storeSecret } from "../vault.js";
import { ADA, jiraOrchestrator, PAT, put, TOKEN } from "./jira-stand-in.js";
import { guessMoves } from "./moves.js";

const columns = (...names: string[]) => names.map((name) => ({ name, statuses: [name] }));

describe("the mapping a board starts from", () => {
  it("given boards with their own workflows, when the moves are guessed, then started, request opened and merged land in the in-progress, review and done columns, and a board with none of them moves nothing", () => {
    // given
    const boards = [
      columns("Ready for Dev", "In Dev", "Code Review", "Ready for Test", "In Test", "Test Passed", "Done"),
      columns("To Do", "In Progress", "In Review", "Done"),
      columns("Backlog", "Selected for Development", "Doing", "Closed"),
      columns("Backlog", "Selected"),
    ];

    // when
    const guessed = boards.map(guessMoves);

    // then
    expect(guessed).toEqual([
      { started: "In Dev", requestOpened: "Code Review", merged: "Done" },
      { started: "In Progress", requestOpened: "In Review", merged: "Done" },
      { started: "Doing", merged: "Closed" },
      {},
    ]);
  });
});

describe("Move issues as the agent works, on the organization's Jira", () => {
  it("given a board with nothing saved and a token that moves issues, when an admin opens its setting, then it is off with the guessed mapping, and the admin changes it", async () => {
    // given
    const { call } = await jiraOrchestrator();

    // when
    const opened = await call(ADA, "/api/work/moves?board=tracker~12");

    // then
    expect(opened.body).toEqual({ enabled: false, guessed: true, canChange: true, write: { allowed: true, reason: null, off: false }, moves: { started: "In Dev", requestOpened: "Code Review", merged: "Done" } });
  });

  it("given an admin turns it on with their mapping, when it is read again, then it is on and saved, and the event log says who did it", async () => {
    // given
    const { call, events } = await jiraOrchestrator();

    // when
    const saved = await call(ADA, "/api/work/moves?board=tracker~12", put({ enabled: true, moves: { started: "In Dev", requestOpened: "Code Review", merged: null } }));

    // then
    expect(saved.body).toMatchObject({ enabled: true, guessed: false, moves: { started: "In Dev", requestOpened: "Code Review" } });
    expect((await call(ADA, "/api/work/moves?board=tracker~12")).body.enabled).toBe(true);
    expect(events).toContain("ada@example.invalid work.moves turned on moving issues on Payments board: started -> In Dev, requestOpened -> Code Review");
  });

  it("given the Payments owner on the board mapped to their team, when they read and change the setting, then they see it unchangeable and are refused", async () => {
    // given
    const { call } = await jiraOrchestrator();
    await call(ADA, "/api/work/boards/teams", put({ boards: [{ boardId: "tracker~12", team: "Payments" }] }));

    // when
    const read = await call(PAT, "/api/work/moves?board=tracker~12");
    const changed = await call(PAT, "/api/work/moves?board=tracker~12", put({ enabled: true, moves: {} }));

    // then
    expect(read.body.canChange).toBe(false);
    expect(changed.status).toBe(403);
  });

  it("given a token with no permission to move issues, when the setting is read and turned on, then it says why and stays off", async () => {
    // given
    const { call } = await jiraOrchestrator({ transition: false });

    // when
    const read = await call(ADA, "/api/work/moves?board=tracker~12");
    const turned = await call(ADA, "/api/work/moves?board=tracker~12", put({ enabled: true, moves: { started: "In Dev" } }));
    const sources = await call(ADA, "/api/work/sources");

    // then
    expect(read.body.write).toEqual({ allowed: false, reason: "The organization's Jira token has no permission to move issues", off: false });
    expect(turned.status).toBe(400);
    expect((await call(ADA, "/api/work/moves?board=tracker~12")).body.enabled).toBe(false);
    expect(sources.body.sources[0]).toMatchObject({ can: { write: false }, writeProblem: "The organization's Jira token has no permission to move issues", problem: null });
  });

  it("given a column the board does not have, when it is saved as a move, then it is refused", async () => {
    // given
    const { call } = await jiraOrchestrator();

    // when
    const saved = await call(ADA, "/api/work/moves?board=tracker~12", put({ enabled: false, moves: { merged: "Shipped" } }));

    // then
    expect([saved.status, saved.body.error]).toEqual([400, "Shipped is not a column of this board"]);
  });

  it("given a token with no permission to move issues, when an admin stores one that has it, then the setting says it moves issues at once", async () => {
    // given
    const can = { transition: false };
    const { ctx, call } = await jiraOrchestrator(can);
    expect((await call(ADA, "/api/work/moves?board=tracker~12")).body.write.allowed).toBe(false);

    // when
    can.transition = true;
    await new Promise((r) => setTimeout(r, 5));
    await storeSecret(ctx.store, ctx.vault!, ctx.tenant, TRACKER_TOKEN_SECRET, TOKEN, ADA.email);
    const read = await call(ADA, "/api/work/moves?board=tracker~12");

    // then
    expect(read.body.write).toEqual({ allowed: true, reason: null, off: false });
  });
});
