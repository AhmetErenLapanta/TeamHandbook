import { expect, test } from "@playwright/test";
import { answerUsage, machineOf, outboxExists, sessionStart, updateMarketplace, useSkill } from "../machine.js";
import { ORGS } from "../orgs.js";
import type { LabOrg, LabRepo } from "../state.js";
import { as, builtIn, close, fileAt, lab, merge, ownerOf, pluginName, proposeUsage, unique } from "./support.js";

/** The address the team file asks teammates to report to, at a branch or commit, or null when it asks nothing. */
function endpointAt(repo: LabRepo, ref: string): string | null {
  const text = fileAt(repo, ref, ".teamhandbook.json");
  return text ? ((JSON.parse(text) as { usage?: { endpoint?: string } }).usage?.endpoint ?? null) : null;
}

async function count(org: LabOrg, repo: LabRepo, skill: string): Promise<number> {
  const { usage } = await (await as(org, "admin")).ok<{ usage: { repoId: string; skill: string; count: number }[] }>("GET", `/api/usage?repo=${repo.id}`);
  return usage.find((u) => u.skill === skill)?.count ?? 0;
}

const versionAt = (repo: LabRepo, ref: string) => (JSON.parse(fileAt(repo, ref, ".claude-plugin/plugin.json") ?? "{}") as { version?: string }).version;
const firstSkill = (org: LabOrg, repo: LabRepo) => ORGS.find((o) => o.name === org.name)!.teams.find((t) => t.id === repo.id)!.skills[0]!.slug;

test.describe("skill use reaches the orchestrator only with both answers", () => {
  for (const org of builtIn) {
    const repo = org.repos.find((r) => r.versioning === "number")!;
    // Without a raised version a teammate on a numbered repository never fetches the team's request.
    test(`given ${org.name}'s ${repo.id}, versioned by number, when the team is asked to report skill use, then the request raises the plugin version so teammates fetch it`, async () => {
      test.skip(endpointAt(repo, "HEAD") !== null, "this team already reports skill use; a fresh lab asks it again");
      // given
      const owner = await ownerOf(org, repo);

      // when
      const reply = await proposeUsage(owner, org, repo);
      try {
        // then
        expect(reply.status, reply.error).toBe(200);
        expect(versionAt(repo, reply.request!.branch)).not.toBe(versionAt(repo, "HEAD"));
      } finally {
        if (reply.request) await close(org, repo, reply.request.number);
      }
    });
  }

  for (const org of builtIn) {
    const repo = org.repos.find((r) => r.id === org.developers[0]!.repo)!;
    const teammates = org.developers.filter((d) => d.repo === repo.id);

    test(`given ${org.name}'s ${repo.id} and teammates who agree, decline or have not answered, when the team asks on its forge and each uses a team skill and a personal one of the same name, then only the agreeing teammates' team-skill uses are counted`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const plugin = pluginName(repo);
      const skill = firstSkill(org, repo);
      const machines = teammates.map((d) => ({ dev: d, m: machineOf(lab, d) }));
      let endpoint = endpointAt(repo, "HEAD");
      if (!endpoint) {
        const reply = await proposeUsage(owner, org, repo);
        expect(reply.status, reply.error).toBe(200);
        endpoint = endpointAt(repo, reply.request!.branch)!;
        expect(endpoint).toMatch(new RegExp(`^${org.url}/ingest/usage/[^/]+/${repo.id}$`));

        // when a teammate agrees before the team's request is merged
        const before = await count(org, repo, skill);
        for (const { dev, m } of machines.filter((x) => x.dev.consent === "agree")) {
          updateMarketplace(m);
          answerUsage(m, "agree", endpoint);
          useSkill(m, `${plugin}:${skill}`, unique(dev.name));
        }

        // then the team's half is missing, and nothing was sent
        expect(await count(org, repo, skill)).toBe(before);

        // when a person merges the team's request
        await merge(org, repo, reply.request!.number);
      }
      expect(endpointAt(repo, "HEAD")).toBe(endpoint);

      // when every teammate's copy updates, and each gives their own answer
      for (const { dev, m } of machines) {
        updateMarketplace(m);
        answerUsage(m, dev.consent, endpoint);
      }

      // then only a teammate who has not answered is asked, naming exactly that address
      for (const { dev, m } of machines) {
        const said = sessionStart(m, unique(dev.name));
        if (dev.consent === "undecided") expect(said).toContain(`sent to ${endpoint} and nothing else`);
        else expect(said).not.toContain("your team asks");
      }

      // when each uses the team skill twice and a personal skill of the same name once
      const before = await count(org, repo, skill);
      for (const { dev, m } of machines) {
        useSkill(m, `${plugin}:${skill}`, unique(dev.name));
        useSkill(m, `${plugin}:${skill}`, unique(dev.name));
        useSkill(m, skill, unique(dev.name));
      }

      // then
      const agreeing = machines.filter((x) => x.dev.consent === "agree").length;
      expect(await count(org, repo, skill)).toBe(before + 2 * agreeing);
      for (const { m } of machines.filter((x) => x.dev.consent !== "agree")) expect(outboxExists(m)).toBe(false);
    });
  }

  test("given one organization's usage address, when it is sent to another organization's orchestrator, then the other orchestrator refuses it and neither count moves", async () => {
    // given
    const [from, to] = builtIn as [LabOrg, LabOrg];
    const repo = from.repos.find((r) => r.id === from.developers[0]!.repo)!;
    const endpoint = endpointAt(repo, "HEAD");
    test.skip(!endpoint, "the usage spec above sets the address up");
    const skill = firstSkill(from, repo);
    const before = await count(from, repo, skill);
    const hour = new Date().toISOString().slice(0, 13);

    // when
    const elsewhere = await fetch(endpoint!.replace(from.url, to.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ skill, hour }] }) });
    const unknownSkill = await fetch(endpoint!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ skill: "not-a-team-skill", hour }] }) });

    // then
    expect([elsewhere.status, await elsewhere.json()]).toEqual([400, { error: "refused" }]);
    expect([unknownSkill.status, await unknownSkill.json()]).toEqual([400, { error: "refused" }]);
    expect(await count(from, repo, skill)).toBe(before);
    expect((await (await as(to, "admin")).ok<{ usage: unknown[] }>("GET", `/api/usage?repo=${repo.id}`)).usage).toEqual([]);
  });
});
