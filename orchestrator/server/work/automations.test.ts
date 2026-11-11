import { describe, expect, it } from "vitest";
import { AutomationWatch, pollAutomations } from "./automations.js";
import { ADA, jiraOrchestrator, PAT, put, SAM } from "./jira-stand-in.js";

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The organization's Jira, the Payments board mapped to Payments, Ada stored as the admin she is, and a watch over its automations read tick by tick. */
async function orchestrator_() {
  const at = await jiraOrchestrator(undefined, false);
  await at.ctx.store.insertUser({ tenant: "acme", id: ADA.id, email: ADA.email, name: ADA.name, role: "admin", passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: null, createdAt: "2026-11-01T00:00:00.000Z" });
  await at.call(ADA, "/api/work/boards/teams", put({ boards: [{ boardId: "tracker~12", team: "Payments" }] }));
  const deliveries = async (id: string) => (await at.call(ADA, `/api/work/automations/${id}/deliveries`)).body.deliveries.map((d: { detail: string }) => d.detail);
  const watch = new AutomationWatch();
  // A read a minute after the last one, as the watch makes them: the board's cached answers are past their time.
  const tick = () => {
    at.deps.cache.evict("");
    return pollAutomations(at.ctx, at.deps, watch);
  };
  return { ...at, deliveries, tick };
}

const AUTOMATION = { name: "Start in dev", board: "tracker~12", trigger: { kind: "column", column: "In Dev" }, repoId: "payments-skills", agent: "claude" };

describe("an automation on a tracker board, read for its changes", () => {
  it("given an admin's automation drafting a task when an issue moves into In Dev and its board read once, when a teammate moves PAY-144 there in Jira, then the next read drafts a task for the Payments owner, not a member, the one after drafts nothing more, and Jira is sent no write", async () => {
    // given
    const { call, deliveries, tick, statuses, writes } = await orchestrator_();
    const { automation } = (await call(ADA, "/api/work/automations", post(AUTOMATION))).body;
    const first = await tick();

    // when
    statuses["PAY-144"] = "In Dev";
    const second = await tick();
    const third = await tick();

    // then
    expect(automation).toMatchObject({ action: "draft", enabled: true, project: "PAY", trigger: { kind: "column", column: "In Dev", statuses: ["In Dev"] }, by: { id: ADA.id, name: ADA.name } });
    expect([first, second, third]).toEqual([0, 1, 0]);
    expect((await call(PAT, "/api/work/drafts")).body.drafts).toEqual([expect.objectContaining({ automation: automation.id, issueKey: "PAY-144", issueUrl: "https://acme.atlassian.example/browse/PAY-144", repoId: "payments-skills" })]);
    expect((await call(SAM, "/api/work/drafts")).body.drafts).toEqual([]);
    expect(await deliveries(automation.id)).toEqual(["PAY-144 moved to In Dev: a task is drafted for someone to start"]);
    expect(writes).toEqual([]);
  });

  it("given PAY-142 already in In Dev, when the orchestrator starts again and reads the board, then that first read acts on nothing", async () => {
    // given
    const { call, tick, deliveries } = await orchestrator_();
    const { automation } = (await call(ADA, "/api/work/automations", post(AUTOMATION))).body;

    // when
    const first = await tick();
    const again = await tick();

    // then
    expect([first, again]).toEqual([0, 0]);
    expect((await call(PAT, "/api/work/drafts")).body.drafts).toEqual([]);
    expect(await deliveries(automation.id)).toEqual([]);
  });

  it("given an automation filtered to issues labelled refunds, when one issue moves into In Dev without the label and another with it, then only the labelled one is acted on", async () => {
    // given
    const { call, tick, statuses, labels, deliveries } = await orchestrator_();
    const { automation } = (await call(ADA, "/api/work/automations", post({ ...AUTOMATION, filter: { labels: ["refunds"] } }))).body;
    await tick();

    // when
    statuses["PAY-144"] = "In Dev";
    statuses["PAY-143"] = "In Dev";
    labels["PAY-143"] = ["refunds"];
    await tick();

    // then
    expect(await deliveries(automation.id)).toEqual(["PAY-143 moved to In Dev: a task is drafted for someone to start"]);
  });

  it("given an automation drafting a task when an issue gets the label ready, when a teammate labels PAY-144 ready, then a task is drafted for it", async () => {
    // given
    const { call, tick, labels, deliveries } = await orchestrator_();
    const { automation } = (await call(ADA, "/api/work/automations", post({ ...AUTOMATION, trigger: { kind: "label", label: "ready" } }))).body;
    await tick();

    // when
    labels["PAY-144"] = ["ready"];
    await tick();

    // then
    expect(await deliveries(automation.id)).toEqual(["PAY-144 labelled ready: a task is drafted for someone to start"]);
  });

  it("given the organization's automations turned off, when an issue moves, then the board is not read and nothing is drafted", async () => {
    // given
    const { call, tick, statuses, asked } = await orchestrator_();
    await call(ADA, "/api/work/automations", post(AUTOMATION));
    await call(ADA, "/api/work/automations", put({ enabled: false }));
    const before = asked.length;

    // when
    statuses["PAY-144"] = "In Dev";
    await tick();
    await tick();

    // then
    expect(asked.length).toBe(before);
    expect((await call(PAT, "/api/work/drafts")).body.drafts).toEqual([]);
  });

  it("given an automation acting on one change a minute, when two issues move in the same read, then the second is logged and dropped", async () => {
    // given
    const { call, tick, statuses, labels, deliveries } = await orchestrator_();
    const { automation } = (await call(ADA, "/api/work/automations", post({ ...AUTOMATION, perMinute: 1 }))).body;
    await tick();

    // when
    statuses["PAY-144"] = "In Dev";
    statuses["PAY-143"] = "In Dev";
    labels["PAY-143"] = [];
    await tick();

    // then
    expect(await deliveries(automation.id)).toEqual(["PAY-144 moved to In Dev: not acted on: more than 1 changes in a minute", "PAY-143 moved to In Dev: a task is drafted for someone to start"]);
  });

  it("given a member, when they set up an automation, then they are refused", async () => {
    // given
    const { call } = await orchestrator_();

    // when
    const made = await call(PAT, "/api/work/automations", post(AUTOMATION));

    // then
    expect(made.status).toBe(403);
  });

  it("given an automation whose admin is no longer one, when its board would be read, then it is not read, nothing starts, and it says why once", async () => {
    // given
    const { ctx, call, tick, statuses, deliveries, asked } = await orchestrator_();
    const { automation } = (await call(ADA, "/api/work/automations", post({ ...AUTOMATION, action: "start" }))).body;
    await ctx.store.setRole(ctx.tenant, ADA.id, "member");
    const before = asked.length;

    // when
    statuses["PAY-144"] = "In Dev";
    await tick();
    await tick();

    // then
    expect(asked.length).toBe(before);
    expect(await deliveries(automation.id)).toEqual(["PAY is not read: Ada Admin set this up and is no longer an owner or an admin"]);
  });
});
