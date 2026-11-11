import { describe, expect, it } from "vitest";
import type { Principal } from "../auth.js";
import { canStartOnTeam, seesTask, seesTeamTasks, visibleTasks } from "./guards.js";

const person = (role: Principal["role"], ownedTeams: string[] = [], restrictedTeams: string[] | null = ["Ledger"]): Principal => ({ id: `usr_${role}`, name: role, email: `${role}@example.invalid`, role, ownedTeams, ...(restrictedTeams ? { restrictedTeams } : {}) });

describe("who starts and reads tasks on a team", () => {
  it("given an organization that keeps Ledger to its owners, when a member, Ledger's owner and an admin ask about Payments and Ledger, then everyone starts on Payments and only the owner and the admin on Ledger", () => {
    // given
    const member = person("member");
    const ledgerOwner = person("member", ["Ledger"]);
    const admin = person("admin");

    // when
    const answers = [member, ledgerOwner, admin].map((p) => [canStartOnTeam(p, "Payments"), canStartOnTeam(p, "Ledger"), seesTeamTasks(p, "Ledger")]);

    // then
    expect(answers).toEqual([
      [true, false, false],
      [true, true, true],
      [true, true, true],
    ]);
  });

  it("given a viewer, when they ask about an open team and a restricted one, then they read the open team's tasks and start nothing anywhere", () => {
    // given
    const viewer = person("viewer");

    // when
    const answers = [seesTeamTasks(viewer, "Payments"), seesTeamTasks(viewer, "Ledger"), canStartOnTeam(viewer, "Payments"), canStartOnTeam(viewer, "Ledger")];

    // then
    expect(answers).toEqual([true, false, false, false]);
  });

  it("given an account whose organization's restricted teams were not read, when it asks about a team it does not own, then it starts nothing there, as before the rule", () => {
    // given
    const unknown = person("member", ["Payments"], null);

    // when
    const answers = [canStartOnTeam(unknown, "Payments"), canStartOnTeam(unknown, "Platform")];

    // then
    expect(answers).toEqual([true, false]);
  });

  it("given a member, the Payments owner and an admin, when a Payments task someone else started and the member's own are read, then only the owner, the admin and its starter read each, and the store filter says the same", () => {
    // given
    const [member, paymentsOwner, admin] = [person("member"), { ...person("member", ["Payments"]), id: "usr_pat", email: "pat@example.invalid" }, person("admin")];
    const theirs = { team: "Payments", createdBy: "someone@example.invalid" };

    // when
    const seen = [seesTask(member, theirs), seesTask(paymentsOwner, theirs), seesTask(admin, theirs), seesTask(member, { team: "Payments", createdBy: member.email })];

    // then
    expect(seen).toEqual([false, true, true, true]);
    expect(visibleTasks(member)).toEqual({ visibleTo: { teams: [], creators: [member.email, member.id], sharedWith: member.id } });
    expect(visibleTasks(paymentsOwner)).toEqual({ visibleTo: { teams: ["Payments"], creators: [paymentsOwner.email, paymentsOwner.id], sharedWith: paymentsOwner.id } });
    expect(visibleTasks(admin)).toEqual({});
  });
});
