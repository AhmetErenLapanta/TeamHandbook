import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createMachine, joinTeam, machineOf } from "../machine.js";

import type { LabOrg, LabRepo } from "../state.js";
import { as, close, defaultHead, fileAt, lab, merge, onForge, openRepo, ownerOf, pick, propose, SHAPES, signInOnPage, unique, whileChanged } from "./support.js";

interface Finding {
  level: "ok" | "suggestion" | "attention" | "problem";
  title: string;
  detail?: string;
  next?: string;
  more?: string;
}

const REFRESH = "Update TeamHandbook's files from this page, which opens the request for you, or run /handbook:init --upgrade from a teammate's machine";


async function panel(org: LabOrg, repoId: string): Promise<{ head: string; setup: Finding[] }> {
  const { inventory } = await (await as(org, "member")).ok<{ inventory: { head: string; setup: Finding[] } }>("GET", `/api/repos/${repoId}/inventory`);
  return inventory;
}

const finding = (setup: Finding[], title: string) => setup.find((f) => f.title === title);
const versionAt = (repo: LabRepo, ref: string) => (JSON.parse(fileAt(repo, ref, ".claude-plugin/plugin.json") ?? "{}") as { version?: string }).version;
const teamFile = (repo: LabRepo) => JSON.parse(fileAt(repo, "HEAD", ".teamhandbook.json")!) as Record<string, unknown>;
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";


test.describe("the setup panel on the lab's four repository shapes", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, as the lab set it up, when a member reads its setup, then teammates can join, the scaffold is current, nothing needs looking at, and its versioning is named`, async () => {
      // when
      const { head, setup } = await panel(org, repo.id);

      // then
      expect(head).toBe(defaultHead(repo));
      expect(setup.filter((f) => f.level === "attention" || f.level === "problem")).toEqual([]);
      expect(finding(setup, "Teammates can install it")?.more).toBe(`Marketplace ${repo.id}, owned by ${repo.id} maintainers; plugin ${repo.id}.`);
      expect(finding(setup, "Up to date")).toBeDefined();
      if (repo.versioning === "number") {
        expect(finding(setup, "Each request raises the version")).toMatchObject({ detail: expect.stringContaining(`It is ${versionAt(repo, "HEAD")} now`), more: expect.stringContaining("Each request the orchestrator opens raises the version") });
      } else {
        expect(finding(setup, "Every merge reaches teammates")).toBeDefined();
      }
      const naming = finding(setup, "Changes follow the team's naming")?.detail;
      expect(naming).toBe(`${repo.commitPrefix ? `Commits start with ${repo.commitPrefix}` : "Commits carry no prefix"}; ${repo.branchExample ? `branches are named like ${repo.branchExample}` : "branches carry no team naming"}.`);
    });
  }

  test("given the repository versioned by number, when an owner's edit is merged, then the panel names the version the merge raised", async () => {
    // given
    const { org, repo } = pick("acme", "payments-skills");
    const before = versionAt(repo, "HEAD")!;
    const slug = unique("setup-version");

    // when
    const opened = await propose(await ownerOf(org, repo), org, repo, { kind: "skill.add", slug, content: `---\nname: ${slug}\ndescription: Use when the lab checks the setup panel's version.\n---\n\nBody.\n` }, `add ${slug}`);
    expect(opened.status, opened.error).toBe(200);
    await merge(org, repo, opened.request!.number);

    // then
    const after = versionAt(repo, "HEAD")!;
    expect(after).not.toBe(before);
    const { setup } = await panel(org, repo.id);
    expect(finding(setup, "Each request raises the version")?.detail).toContain(`It is ${after} now`);
  });

  test("given the repository versioned by number, when a teammate's merge stamps an older scaffold, then the panel says it is behind and how to refresh it, until it is put back", async () => {
    const { org, repo } = pick("acme", "payments-skills");
    await whileChanged(org, repo, { ".teamhandbook.json": json({ ...teamFile(repo), scaffoldVersion: "0.20.0" }) }, async () => {
      // then
      const behind = finding((await panel(org, repo.id)).setup, "TeamHandbook's files are out of date");
      expect(behind).toMatchObject({ level: "attention" });
      expect(behind?.detail).toContain("They were written by TeamHandbook 0.20.0");
      expect(behind?.next).toContain(REFRESH);
    });
    expect(finding((await panel(org, repo.id)).setup, "Up to date")).toBeDefined();
  });

  test("given the repository versioned by commit, when a teammate's merge deletes hooks/hooks.json, then the panel says teammates miss the session note and how to get it back", async () => {
    const { org, repo } = pick("acme", "platform-skills");
    await whileChanged(org, repo, { "hooks/hooks.json": null }, async () => {
      // then
      const hooks = finding((await panel(org, repo.id)).setup, "Teammates are not told when new skills arrive");
      expect(hooks).toMatchObject({ level: "attention" });
      expect(hooks?.next).toContain(REFRESH);
    });
    expect(finding((await panel(org, repo.id)).setup, "Teammates are not told when new skills arrive")).toBeUndefined();
  });

  test("given the repository named by ticket key, when a teammate adds a reviewer the plugin's rule drops, then the panel names it and the orchestrator's next request on GitLab leaves it off while asking the other nine", async () => {
    const { org, repo } = pick("vandelay", "imports-skills");
    await whileChanged(org, repo, { ".teamhandbook.json": json({ ...teamFile(repo), reviewers: [...repo.reviewers, "Lab Person"] }) }, async () => {
      // then the panel names it
      const dropped = finding((await panel(org, repo.id)).setup, "Some reviewers or labels are left off requests");
      expect(dropped).toMatchObject({ level: "attention", detail: "The plugin's rule drops reviewers Lab Person." });

      // and a request the orchestrator opens asks exactly the nine it keeps, never the forge about the dropped one
      const slug = unique("setup-reviewers");
      const opened = await propose(await ownerOf(org, repo), org, repo, { kind: "skill.add", slug, content: `---\nname: ${slug}\ndescription: Use when the lab checks dropped reviewers.\n---\n\nBody.\n` }, `add ${slug}`);
      try {
        expect(opened.status, opened.error).toBe(200);
        expect(opened.request!.branch.startsWith(`${repo.commitPrefix}-`)).toBe(true);
        expect((await onForge(repo, opened.request!.number)).reviewers).toEqual(repo.reviewers);
        expect(JSON.stringify(opened.request!.notes ?? [])).not.toContain("Lab Person");
      } finally {
        if (opened.request) await close(org, repo, opened.request.number);
      }
    });
  });

  test("given the repository on master, when a teammate's merge renames the marketplace to a name join refuses, then the panel and a new teammate's join both say no one can join, and both recover once it is put back", async ({ browser }) => {
    const { org, repo } = pick("vandelay", "exports-skills");
    const market = JSON.parse(fileAt(repo, "HEAD", ".claude-plugin/marketplace.json")!) as Record<string, unknown>;
    await whileChanged(org, repo, { ".claude-plugin/marketplace.json": json({ ...market, name: "Exports Skills" }) }, async () => {
      // then the panel says so
      const refused = finding((await panel(org, repo.id)).setup, "Teammates cannot join");
      expect(refused).toMatchObject({ level: "problem" });
      expect(refused?.detail).toContain('"Exports Skills", which is not a plain name');

      // and the plugin's own join agrees on a new teammate's machine
      const joined = joinTeam(machineOf(lab, createMachine(join(org.dir, "devs"), unique("newcomer"))), repo.url);
      expect(joined.status).toBe(1);
      expect(joined.stderr).toContain("not a plain name");

      // and the screen shows it to the team's owner
      const context = await browser.newContext();
      const page = await context.newPage();
      await signInOnPage(page, org, "owner:Exports");
      await openRepo(page, org, repo.id);
      const region = page.getByRole("region", { name: /^Setup/ });
      // The state is the badge's; a problem-level finding reads as stopping teammates.
      await expect(region).toContainText("Something stops teammates");
      await expect(region).toContainText("Teammates cannot join");
      await context.close();
    });

    // then once put back
    expect(finding((await panel(org, repo.id)).setup, "Teammates can install it")).toBeDefined();
    const joined = joinTeam(machineOf(lab, createMachine(join(org.dir, "devs"), unique("newcomer"))), repo.url);
    expect([joined.status, joined.stderr]).toEqual([0, ""]);
  });

  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when its CODEOWNERS names its team, covers only other paths, or is gone, then the panel says the agent configuration has owners, which part has none, or that nobody owns it`, async () => {
      // given
      const owned = finding((await panel(org, repo.id)).setup, "Skill and server changes have reviewers");
      const owner = `@lab/${repo.id}`;

      // then
      expect(owned?.more).toContain(`skills/ by ${owner}`);

      // when only the code has an owner
      await whileChanged(org, repo, { CODEOWNERS: `/src/ ${owner}\n` }, async () => {
        // then
        const some = finding((await panel(org, repo.id)).setup, "Some skill and server changes have no reviewer");
        // A suggestion once the orchestrator stops counting code owners as something to look at, an attention before.
        expect(["suggestion", "attention"]).toContain(some?.level);
        expect(some?.detail).toContain("CODEOWNERS names no owner for skills/");
      });

      // when there is none
      await whileChanged(org, repo, { CODEOWNERS: null }, async () => {
        // then
        expect(["suggestion", "attention"]).toContain(finding((await panel(org, repo.id)).setup, "No one is asked to review skill and server changes")?.level);
      });
    });
  }
});
