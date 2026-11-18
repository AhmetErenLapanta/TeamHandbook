import { join } from "node:path";
import { rmSync } from "node:fs";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { OFF_PREFIX } from "../store.js";
import { seededContext, storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { newRepeat, REPEATS_MAX, runRepeats, runTimes } from "./repeats.js";
import { createTaskRunner } from "./runner.js";

const ADA: Principal = { id: "ada", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

describe("a person's task that starts again on a schedule", { timeout: 120_000 }, () => {
  it("given repeats every weekday and every Monday at 9:00, when their run times are read on a Saturday noon and a Monday at 9:00, then each names the last and next time on this machine's clock", () => {
    // given
    const saturday = new Date(2026, 10, 14, 12, 0);
    const monday = new Date(2026, 10, 16, 9, 0);

    // when
    const weekday = runTimes({ every: "weekday", at: "09:00" }, saturday);
    const mondays = runTimes({ every: "monday", at: "09:00" }, monday);

    // then
    expect([weekday.last, weekday.next]).toEqual([new Date(2026, 10, 13, 9, 0), new Date(2026, 10, 16, 9, 0)]);
    expect([mondays.last, mondays.next]).toEqual([new Date(2026, 10, 16, 9, 0), new Date(2026, 10, 23, 9, 0)]);
  });

  it("given a person's repeat every day at 9:00, when the tick comes at 9:00, again a minute later, and on a day the orchestrator was off until 9:30, then it starts once as them, the missed day says so and runs nothing, and a stopped repeat is listed no more", async () => {
    // given
    const { ctx, root } = await seededContext("orchestrator-repeats-", ["payments-skills"]);
    dirs.push(root);
    ctx.mode = "local";
    await storePrincipals(ctx, ADA);
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    await ctx.tasks.ready();
    const app = createApp(ctx, as(ADA));
    const day = (date: number, hours: number, minutes: number) => new Date(2026, 10, date, hours, minutes);
    const repeat = { ...newRepeat(ctx.tenant, ADA.email, { repoId: "payments-skills", title: "Update the dependencies", agent: "fake" }, "Update the dependencies", { every: "day", at: "09:00" }), createdAt: day(10, 8, 0).toISOString() };
    await ctx.store.addRepeat(repeat);
    await ctx.store.reachRepeat(ctx.tenant, repeat.id, day(13, 9, 0).toISOString(), null);

    // when
    const atNine = await runRepeats(ctx, ctx.tasks, day(14, 9, 0), () => {});
    const minuteLater = await runRepeats(ctx, ctx.tasks, day(14, 9, 1), () => {});
    const missed = await runRepeats(ctx, ctx.tasks, day(15, 9, 30), () => {});
    await ctx.tasks.idle();
    const listed = (await (await app.request("/api/tasks/repeats")).json()).repeats;
    const stopped = await app.request(`/api/tasks/repeats/${repeat.id}/stop`, { method: "POST" });
    const after = (await (await app.request("/api/tasks/repeats")).json()).repeats;

    // then
    expect([atNine.length, minuteLater.length, missed.length]).toEqual([1, 0, 0]);
    expect(await ctx.store.getTask(ctx.tenant, atNine[0]!)).toMatchObject({ title: "Update the dependencies", createdBy: ADA.email });
    expect(listed).toMatchObject([{ id: repeat.id, title: "Update the dependencies", every: "day", at: "09:00", skipped: { at: day(15, 9, 0).toISOString(), reason: "This computer was not running the orchestrator at 09:00, so it did not run; it runs at its next time." } }]);
    expect(stopped.status).toBe(200);
    expect(after).toEqual([]);
  });

  it("given two people's repeats due now, one whose account the directory turned off and one whose account is then removed, when the tick comes, then the first is stopped without starting anything and the second's repeats are gone with the account", async () => {
    // given
    const { ctx, root } = await seededContext("orchestrator-repeats-", ["payments-skills"]);
    dirs.push(root);
    ctx.mode = "local";
    const BO: Principal = { id: "bo", name: "Bo Example", email: "bo@example.invalid", role: "admin", ownedTeams: [] };
    await storePrincipals(ctx, ADA, BO);
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    await ctx.tasks.ready();
    const day = (date: number, hours: number, minutes: number) => new Date(2026, 10, date, hours, minutes);
    for (const person of [ADA, BO]) await ctx.store.addRepeat({ ...newRepeat(ctx.tenant, person.email, { repoId: "payments-skills", title: "Update the dependencies", agent: "fake" }, "Update the dependencies", { every: "day", at: "09:00" }), createdAt: day(10, 8, 0).toISOString() });
    await ctx.store.setSetting(ctx.tenant, `${OFF_PREFIX}${ADA.id}`, "off");

    // when
    await ctx.store.deleteUser(ctx.tenant, BO.id);
    const started = await runRepeats(ctx, ctx.tasks, day(14, 9, 0), () => {});

    // then
    expect(started).toEqual([]);
    const left = await ctx.store.listRepeats(ctx.tenant);
    expect(left.map((r) => [r.createdBy, r.stoppedAt !== null])).toEqual([[ADA.email, true]]);
    expect(await ctx.store.listTasks(ctx.tenant)).toEqual([]);
  });

  it("given a person's own orchestrator and a team's, when a start names a repeat, then the first keeps it and starts nothing, and the second refuses it", async () => {
    // given
    const { ctx, root } = await seededContext("orchestrator-repeats-", ["payments-skills"]);
    dirs.push(root);
    await storePrincipals(ctx, ADA);
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    const app = createApp(ctx, as(ADA));
    const ask = () => app.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "payments-skills", title: "Update the dependencies", agent: "fake", repeat: { every: "weekday", at: "09:00" } }) });

    // when
    const team = await ask();
    ctx.mode = "local";
    const own = await ask();

    // then
    expect(team.status).toBe(400);
    expect(own.status).toBe(201);
    expect((await own.json()).repeat).toMatchObject({ title: "Update the dependencies", every: "weekday", at: "09:00", next: expect.any(String) });
    expect(await ctx.store.listTasks(ctx.tenant)).toEqual([]);
    for (let n = 1; n < REPEATS_MAX; n++) expect((await ask()).status).toBe(201);
    const over = await ask();
    expect([over.status, (await over.json()).code]).toEqual([409, "too-many-repeats"]);
  });
});
