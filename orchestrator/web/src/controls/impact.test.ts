import { describe, expect, it } from "vitest";
import type { TeamView } from "../api";
import { changeImpact, patternMatches } from "./impact";
import type { Policy } from "./policy";

const teams: TeamView[] = [{ team: "payments", repos: ["payments-skills"], owners: [], canEdit: true }];
const policy = (id: string, resources: string[], repos?: string[]): Policy => ({ id, name: id, audience: { kind: "workspace" }, rules: [{ kind: "mcp-access", effect: "deny", resources, reason: "r" }], updatedAt: null, updatedBy: null, repos });

describe("what a change touches before its request opens", () => {
  it("given a skill removal with reported use, when its impact is read, then use is summed for that repository and the latest hour kept", () => {
    const impact = changeImpact("payments-skills", { kind: "skill.delete", slug: "deploy" }, {
      teams,
      usage: [
        { repoId: "payments-skills", skill: "deploy", count: 3, lastHour: "2026-10-20T10" },
        { repoId: "payments-skills", skill: "deploy", count: 4, lastHour: "2026-10-22T09" },
        { repoId: "other", skill: "deploy", count: 99, lastHour: "2026-10-23T09" },
      ],
      usageDays: 30,
      overlaps: {},
      policies: [],
    });
    expect(impact).toMatchObject({ subject: "deploy", removing: true, team: "payments", usage: { count: 7, days: 30, lastHour: "2026-10-22T09" } });
  });

  it("given policies on a server, on one of its tools and on another repository, when a server change is read, then only those holding it here are named", () => {
    const impact = changeImpact("payments-skills", { kind: "mcp.remove", name: "search" }, {
      teams,
      usage: [],
      usageDays: 30,
      overlaps: {},
      policies: [policy("whole", ["mcp:sea*"]), policy("tool", ["mcp:search/query"]), policy("elsewhere", ["mcp:search"], ["mobile-skills"]), policy("other", ["mcp:searcher"])],
    });
    expect(impact?.policies.map((p) => p.id)).toEqual(["whole", "tool"]);
    expect(impact?.usage).toBeNull();
  });

  it("given a change to the team's settings, when its impact is read, then there is nothing to show", () => {
    expect(changeImpact("payments-skills", { kind: "team.settings", reviewers: [], labels: [] }, { teams, usage: [], usageDays: 30, overlaps: {}, policies: [] })).toBeNull();
  });

  it("given whole-value wildcards, when matched, then a star spans any run and the rest is literal", () => {
    expect(patternMatches("skill:dep*", "skill:deploy")).toBe(true);
    expect(patternMatches("skill:dep.oy", "skill:deploy")).toBe(false);
    expect(patternMatches("skill:deploy", "skill:deploy-two")).toBe(false);
  });
});
