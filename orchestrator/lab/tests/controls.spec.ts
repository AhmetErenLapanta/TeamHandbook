import { expect, test } from "@playwright/test";
import { sharedMessage, TEMPLATES } from "../../web/src/controls/policy.js";
import type { OrchestratorClient } from "../client.js";
import { callTool, pluginMcpTool, updateMarketplace } from "../machine.js";
import { ORGS } from "../orgs.js";
import type { LabOrg, LabRepo } from "../state.js";
import { as, close, filledBranch, merge, ownerOf, pluginName, runToReview, SHAPES, teammateOn, unique } from "./support.js";

type Draft = { name: string; audience: { kind: string; ids?: string[] }; rules: Record<string, unknown>[] };

/** A template as the editor opens it, filled in the way a person would before saving. */
function fromTemplate(id: string, fill: (draft: Draft) => void): Draft {
  const draft = structuredClone(TEMPLATES.find((t) => t.id === id)!.draft({ teams: [], everyone: true })) as unknown as Draft;
  fill(draft);
  return draft;
}

/**
 * A developer policy saved or removed as the editor does it: the requests it would open are
 * asked for first, then sent with the message their proposals share, each repository's branch
 * and the heads that were shown; every request opened is merged.
 */
async function throughRequests(client: OrchestratorClient, org: LabOrg, ask: { id?: string; policy?: Draft; remove?: true }): Promise<{ id: string; repos: string[] }> {
  const plan = await client.ok<{ applies: string; repos: { repoId: string; head: string; proposal: string; branch: string }[] }>("POST", "/api/policies/proposal", ask);
  expect(plan.applies).toBe("request");
  const repoOf = (id: string) => org.repos.find((r) => r.id === id)!;
  const body = {
    ...(ask.policy ? { policy: ask.policy } : {}),
    message: sharedMessage(plan.repos.map((r) => r.proposal)),
    branches: Object.fromEntries(plan.repos.map((r) => [r.repoId, filledBranch(repoOf(r.repoId), r.branch)])),
    baseShas: Object.fromEntries(plan.repos.map((r) => [r.repoId, r.head])),
  };
  const saved = ask.remove ? await client.ok<Saved>("DELETE", `/api/policies/${ask.id}`, body) : await client.ok<Saved>("POST", "/api/policies", body);
  expect(saved.failed).toEqual([]);
  for (const r of saved.requests) await merge(org, repoOf(r.repoId), r.number);
  return { id: saved.id, repos: saved.requests.map((r) => r.repoId) };
}

interface Saved {
  saved: string;
  id: string;
  requests: { repoId: string; number: number }[];
  failed: unknown[];
}

const reasonOf = (draft: Draft) => String(draft.rules[0]!.reason);
const otherRepo = (org: LabOrg, repo: LabRepo) => org.repos.find((r) => r.team !== repo.team)!;
const firstSkill = (org: LabOrg, repo: LabRepo) => ORGS.find((o) => o.name === org.name)!.teams.find((t) => t.id === repo.id)!.skills[0]!.slug;

test.describe("the policy editor's templates, through each repository's requests to a teammate's session", () => {
  for (const org of [...new Set(SHAPES.map((s) => s.org))]) {
    test(`given ${org.name}, when an admin retires an MCP server for everyone from the template, then every repository gets a request, and once merged each shape's teammate is stopped calling it until the policy is removed`, async () => {
      test.setTimeout(300_000);
      // given
      const admin = await as(org, "org-admin");
      const server = unique("retired").replace(/-/g, "_");
      const draft = fromTemplate("retire-mcp", (d) => (d.rules[0]!.resources = [`mcp:${server}`]));
      const shapes = SHAPES.filter((s) => s.org === org).map((s) => ({ repo: s.repo, m: teammateOn(org, s.repo) }));
      const call = (repo: LabRepo, m: ReturnType<typeof teammateOn>) => callTool(m, unique("session"), pluginMcpTool(pluginName(repo), server, "getIssue"), {}, { name: `plugin:${pluginName(repo)}:${server}`, source: "plugin" }).denied;

      // when
      const saved = await throughRequests(admin, org, { policy: draft });
      try {
        // then
        expect(saved.repos.sort()).toEqual(org.repos.map((r) => r.id).sort());
        const listed = (await admin.ok<{ policies: { id: string; repos?: string[] }[] }>("GET", "/api/policies")).policies.find((p) => p.id === saved.id);
        expect(listed?.repos?.sort()).toEqual(saved.repos.sort());
        for (const { repo, m } of shapes) {
          updateMarketplace(m);
          expect(call(repo, m), repo.id).toContain(reasonOf(draft));
        }
      } finally {
        await throughRequests(admin, org, { id: saved.id, remove: true });
      }
      for (const { repo, m } of shapes) {
        updateMarketplace(m);
        expect(call(repo, m), repo.id).toBeNull();
      }
    });
  }

  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when its team's owner makes Bash read-only for the team from the template, then only that repository gets a request, and once merged a teammate's rm is stopped and ls is not, until the policy is removed`, async () => {
      test.setTimeout(180_000);
      // given
      const owner = await ownerOf(org, repo);
      const draft = fromTemplate("read-only-bash", (d) => (d.audience.ids = [repo.team]));
      const m = teammateOn(org, repo);

      // when
      const saved = await throughRequests(owner, org, { policy: draft });
      try {
        updateMarketplace(m);

        // then
        expect(saved.repos).toEqual([repo.id]);
        expect(callTool(m, unique("session"), "Bash", { command: "rm -rf build" }).denied).toContain(reasonOf(draft));
        expect(callTool(m, unique("session"), "Bash", { command: "ls skills" }).denied).toBeNull();
      } finally {
        await throughRequests(owner, org, { id: saved.id, remove: true });
      }
      updateMarketplace(m);
      expect(callTool(m, unique("session"), "Bash", { command: "rm -rf build" }).denied).toBeNull();
    });

    test(`given ${org.name}'s ${repo.id}, ${shape}, when its team's owner keeps another team's skill from the team with the template, then a teammate is stopped using it and keeps their own team's skills, and the owner cannot reach the other team's repository with it`, async () => {
      test.setTimeout(180_000);
      // given
      const owner = await ownerOf(org, repo);
      const other = otherRepo(org, repo);
      const kept = firstSkill(org, other);
      const draft = fromTemplate("skill-one-team", (d) => {
        d.audience.ids = [repo.team];
        d.rules[0]!.resources = [`skill:${kept}`];
      });
      const m = teammateOn(org, repo);

      // when the owner names the other team as well
      const reaching = await owner.call<{ error?: string }>("POST", "/api/policies/proposal", { policy: { ...draft, audience: { kind: "teams", ids: [repo.team, other.team] } } });

      // then it is refused
      expect([reaching.status, reaching.json.error]).toEqual([403, `only an admin or an owner of ${other.team} can change this policy`]);

      // when the owner keeps it to their own team
      const saved = await throughRequests(owner, org, { policy: draft });
      try {
        updateMarketplace(m);

        // then
        expect(callTool(m, unique("session"), "Skill", { skill: `${pluginName(other)}:${kept}` }).denied).toContain(reasonOf(draft));
        expect(callTool(m, unique("session"), "Skill", { skill: `${pluginName(repo)}:${firstSkill(org, repo)}` }).denied).toBeNull();
      } finally {
        await throughRequests(owner, org, { id: saved.id, remove: true });
      }
    });
  }
});

test.describe("the orchestrator's own rules: a task budget from the template and repository access", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when people set the orchestrator's own rules for its team, then only an owner or an admin saves them, at once and without a request, the preview names who they cover, and a denied repository refuses the team owner's task until the rule is removed`, async () => {
      test.setTimeout(180_000);
      // given
      const admin = await as(org, "org-admin");
      const member = await as(org, "member");
      const owner = await ownerOf(org, repo);
      const budget = fromTemplate("team-task-budget", (d) => {
        d.audience.ids = [repo.team];
        d.rules[0]!.monthlyUsd = 25;
      });
      const denied: Draft = { name: unique("No tasks here"), audience: { kind: "teams", ids: [repo.team] }, rules: [{ kind: "repo-access", effect: "deny", repos: [repo.id] }] };

      // when
      const byMember = await member.call<{ error?: string }>("POST", "/api/policies", { policy: budget });
      const byOwner = await owner.call<{ error?: string }>("POST", "/api/policies", { policy: budget });
      const preview = await admin.ok<{ members: { name: string }[]; teams: string[]; repos: string[] }>("POST", "/api/policies/preview", { audience: denied.audience, rules: denied.rules });
      const saved = await admin.ok<{ saved: string; policy: { id: string } }>("POST", "/api/policies", { policy: budget });
      const access = await admin.ok<{ saved: string; policy: { id: string } }>("POST", "/api/policies", { policy: denied });
      try {
        const refused = await owner.call<{ error?: string }>("POST", "/api/tasks", { title: unique("Lab task under a denied repository"), description: "", repoId: repo.id, agent: "fake", issueUrl: "https://tracker.example.invalid/browse/LAB-1" });

        // then
        expect([byMember.status, byMember.json.error]).toEqual([403, "only an owner or an admin sets the orchestrator's own rules"]);
        expect([byOwner.status, byOwner.json.error]).toEqual([403, "only an owner or an admin sets the orchestrator's own rules"]);
        expect([saved.saved, access.saved]).toEqual(["applied", "applied"]);
        expect([preview.teams, preview.repos]).toEqual([[repo.team], [repo.id]]);
        expect(preview.members.map((p) => p.name)).toContain((await owner.ok<{ user: { name: string } }>("GET", "/api/me")).user.name);
        expect([refused.status, refused.json.error]).toEqual([403, `"${denied.name}" does not let you start tasks on ${repo.id}.`]);
      } finally {
        await admin.ok("DELETE", `/api/policies/${access.policy.id}`);
        await admin.ok("DELETE", `/api/policies/${saved.policy.id}`);
      }

      // when the rule is gone, then the owner's task runs, and the budget that held no reported cost did not stop it
      const task = await runToReview(owner, repo, unique("Lab task after the rule"));
      expect(task.status).toBe("needs-review");
      if (task.requestNumber) await close(org, repo, task.requestNumber);
    });
  }

  for (const org of [...new Set(SHAPES.map((s) => s.org))]) {
    test(`given ${org.name}, when its owner sets an orchestrator rule, then it is saved as an admin's would be`, async () => {
      // given
      const owner = await as(org, "admin");
      const rule: Draft = { name: unique("Owner's budget"), audience: { kind: "workspace" }, rules: [{ kind: "task-budget", monthlyUsd: 100, per: "member" }] };

      // when
      const saved = await owner.call<{ saved?: string; policy?: { id: string } }>("POST", "/api/policies", { policy: rule });
      if (saved.json.policy) await (await as(org, "org-admin")).ok("DELETE", `/api/policies/${saved.json.policy.id}`);

      // then
      expect([saved.status, saved.json.saved]).toEqual([200, "applied"]);
    });
  }
});
