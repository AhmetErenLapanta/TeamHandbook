import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { addMarketplace, answerUsage, createMachine, joinTeam, machineOf, sessionStart, updateMarketplace, useSkill } from "../machine.js";
import type { Machine } from "../machine.js";
import type { LabOrg, LabRepo } from "../state.js";
import { as, fileAt, lab, merge, ownerOf, pluginName, proposeUsage, SHAPES, unique } from "./support.js";

const endpointAt = (repo: LabRepo, ref: string) => (JSON.parse(fileAt(repo, ref, ".teamhandbook.json") ?? "{}") as { usage?: { endpoint?: string } }).usage?.endpoint ?? null;

async function count(org: LabOrg, repo: LabRepo, skill: string): Promise<number> {
  const { usage } = await (await as(org, "admin")).ok<{ usage: { skill: string; count: number }[] }>("GET", `/api/usage?repo=${repo.id}`);
  return usage.find((u) => u.skill === skill)?.count ?? 0;
}

async function usageFinding(org: LabOrg, repo: LabRepo): Promise<string | undefined> {
  const { inventory } = await (await as(org, "member")).ok<{ inventory: { setup: { title: string }[] } }>("GET", `/api/repos/${repo.id}/inventory`);
  return inventory.setup.map((f) => f.title).find((t) => t.startsWith("Skill use") || t.startsWith("Skill-use"));
}

/** A teammate who joins now, so their answer is theirs alone and no other spec's. */
function newcomer(org: LabOrg, repo: LabRepo): Machine {
  const m = machineOf(lab, createMachine(join(org.dir, "devs"), unique("reporter")));
  expect(joinTeam(m, repo.url).status).toBe(0);
  addMarketplace(m);
  return m;
}

test.describe("moving and stopping a team's skill-use reports", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, reporting skill use with an agreeing teammate, when the team is given a new address and then stops, each merged, then the old address is refused at once, the teammate is asked again, and after the stop nothing is sent`, async () => {
      // given a team that reports, and a teammate who agreed
      const owner = await ownerOf(org, repo);
      if (!endpointAt(repo, "HEAD")) {
        const asked = await proposeUsage(owner, org, repo, "ask");
        expect(asked.status, asked.error).toBe(200);
        await merge(org, repo, asked.request!.number);
      }
      const old = endpointAt(repo, "HEAD")!;
      const skill = (await owner.ok<{ inventory: { skills: { slug: string }[] } }>("GET", `/api/repos/${repo.id}/inventory`)).inventory.skills[0]!.slug;
      const called = `${pluginName(repo)}:${skill}`;
      const m = newcomer(org, repo);
      answerUsage(m, "agree", old);
      let before = await count(org, repo, skill);
      useSkill(m, called, unique("turn"));
      expect(await count(org, repo, skill)).toBe(before + 1);
      expect(await usageFinding(org, repo)).toBe("Skill use is reported here");

      // when the team is given a new address
      const rotated = await proposeUsage(owner, org, repo, "rotate");
      expect(rotated.status, rotated.error).toBe(200);
      const next = endpointAt(repo, rotated.request!.branch)!;
      expect(next).not.toBe(old);

      // then the old address stops counting as soon as the request is open
      const hour = new Date().toISOString().slice(0, 13);
      const refused = await fetch(old, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ skill, hour }] }) });
      expect([refused.status, await refused.json()]).toEqual([400, { error: "refused" }]);
      expect(await usageFinding(org, repo)).toBe("Skill-use reports are refused");
      before = await count(org, repo, skill);
      useSkill(m, called, unique("turn"));
      expect(await count(org, repo, skill)).toBe(before);

      // when it is merged and the teammate's copy updates
      await merge(org, repo, rotated.request!.number);
      updateMarketplace(m);

      // then the teammate's agreement, given for the old address, does not carry over: they are asked again
      expect(await usageFinding(org, repo)).toBe("Skill use is reported here");
      expect(sessionStart(m, unique("session"))).toContain(`sent to ${next} and nothing else`);
      useSkill(m, called, unique("turn"));
      expect(await count(org, repo, skill)).toBe(before);
      answerUsage(m, "agree", next);
      useSkill(m, called, unique("turn"));
      expect(await count(org, repo, skill)).toBe(before + 1);

      // when the team stops asking, and that is merged
      const stopped = await proposeUsage(owner, org, repo, "stop");
      expect(stopped.status, stopped.error).toBe(200);
      await merge(org, repo, stopped.request!.number);
      updateMarketplace(m);

      // then the team file asks nothing, the panel says nothing about it, and nothing is sent or asked
      expect(endpointAt(repo, "HEAD")).toBeNull();
      expect(await usageFinding(org, repo)).toBeUndefined();
      before = await count(org, repo, skill);
      useSkill(m, called, unique("turn"));
      expect(await count(org, repo, skill)).toBe(before);
      expect(sessionStart(m, unique("session"))).not.toContain("your team asks");
      const again = await proposeUsage(owner, org, repo, "stop").catch((err: Error) => ({ status: 409, error: err.message }));
      expect(again.status).toBe(409);
      expect(again.error).toContain("this team is not asked to report skill use");
    });
  }
});
