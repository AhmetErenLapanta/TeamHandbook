import { describe, expect, it } from "vitest";
import type { Principal } from "./api";
import { activityPagesFor, settingsSectionInMode, settingsSectionsFor } from "./navigation";

const owner: Principal = { id: "u1", name: "Ada", email: "ada@example.test", role: "owner", ownedTeams: [] };
const ids = (me: Principal) => settingsSectionsFor(me).map((s) => s.id);

describe("the settings each kind of orchestrator shows", () => {
  it("given an owner on one's own machine, when the sections are listed, then only their account, where their code lives, task limits, agent readiness, task secrets, privacy and updates show", () => {
    // when
    const shown = ids({ ...owner, mode: "local" });

    // then
    expect(shown).toEqual(["account", "code", "task-limits", "task-secrets", "agents", "privacy", "updates"]);
  });

  it("given a member in the cloud, when the sections are listed, then their machines show beside their account", () => {
    // when
    const shown = ids({ ...owner, role: "member", mode: "cloud", runners: true });

    // then
    expect(shown).toEqual(["account", "members", "api-keys", "access", "machines"]);
  });

  it("given a self-hosted owner, when the sections are listed, then every section shows, the machines that run the team's tasks among them", () => {
    // when
    const shown = ids({ ...owner, mode: "self-hosted", runners: true });

    // then
    expect(shown).toContain("machines");
    expect(shown).toContain("members");
  });

  it("given an owner on one's own machine, when a team section is asked for by address, then that orchestrator does not have it", () => {
    // when
    const has = ["members", "security", "service-accounts", "machines"].map((id) => settingsSectionInMode({ ...owner, mode: "local" }, id));

    // then
    expect(has).toEqual([false, false, false, false]);
  });

  it("given an owner on a team's orchestrator, when Updates is asked for by address, then it does not have it, since it is updated where it is deployed", () => {
    // then
    expect(settingsSectionInMode({ ...owner, mode: "self-hosted" }, "updates")).toBe(false);
    expect(settingsSectionInMode({ ...owner, mode: "local" }, "updates")).toBe(true);
  });

  it("given any orchestrator, when where the code lives is asked for by address, then it has it, a team's showing the repositories it connected", () => {
    // when
    const has = (["self-hosted", "cloud", "local"] as const).map((mode) => settingsSectionInMode({ ...owner, mode }, "code"));

    // then
    expect(has).toEqual([true, true, true]);
  });

  it("given an owner on one's own machine and on a team's, when the sections are listed, then the ones both have come in the same order and Your account is first in both", () => {
    // when
    const own = ids({ ...owner, mode: "local" });
    const team = ids({ ...owner, mode: "self-hosted", runners: true });

    // then
    expect(own[0]).toBe("account");
    expect(team[0]).toBe("account");
    expect(team.filter((id) => own.includes(id))).toEqual(own.filter((id) => team.includes(id)));
  });

  it("given an owner on any orchestrator, when the sections are listed, then Task limits is among them, since every task stops at its limits on a team's as on one's own", () => {
    // when
    const has = (["self-hosted", "cloud", "local"] as const).map((mode) => ids({ ...owner, mode }).includes("task-limits"));

    // then
    expect(has).toEqual([true, true, true]);
  });
});

describe("the machines section", () => {
  it("given a cloud or self-hosted orchestrator that cannot yet connect machines, when the sections are listed or the address is asked for, then Your machines is not there", () => {
    // when
    const cloud = ids({ ...owner, mode: "cloud" });
    const asked = settingsSectionInMode({ ...owner, mode: "self-hosted" }, "machines");

    // then
    expect(cloud).not.toContain("machines");
    expect(asked).toBe(false);
  });
});

describe("the activity pages each kind of orchestrator shows", () => {
  it("given an owner on one's own machine, when the pages are listed, then nothing about a team shows", () => {
    // when
    const shown = activityPagesFor({ ...owner, mode: "local" }).map((p) => p.id);

    // then
    expect(shown).toEqual(["logs", "news"]);
  });

  it("given a self-hosted owner, when the pages are listed, then the leaderboard, AI requests and the audit show", () => {
    // when
    const shown = activityPagesFor({ ...owner, mode: "self-hosted" }).map((p) => p.id);

    // then
    expect(shown).toEqual(["usage", "leaderboard", "ai", "logs", "audit", "news"]);
  });
});
