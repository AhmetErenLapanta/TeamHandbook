import { expect, test } from "@playwright/test";
import { doctor, updateMarketplace } from "../machine.js";
import { ORGS } from "../orgs.js";
import { ownerKey } from "../state.js";
import type { LabOrg, LabRepo } from "../state.js";
import { as, fileAt, merge, openRepo, ownerOf, propose, SHAPES, signInOnPage, teammateOn, unique, whileChanged } from "./support.js";

interface SkillItem {
  slug: string;
  format: string[];
}

interface ServerItem {
  name: string;
  transport: string;
  inTasks?: { usable: boolean; detail: string; signIn: boolean };
}

async function inventory(org: LabOrg, repo: LabRepo) {
  return (await (await as(org, "member")).ok<{ inventory: { skills: SkillItem[]; mcpServers: ServerItem[]; setup: { level: string; title: string; detail?: string; next?: string }[] } }>("GET", `/api/repos/${repo.id}/inventory`)).inventory;
}

/** A skill the plugin's format takes whole: two trigger sentences, three steps, a check with two items, pitfalls. */
const wellFormed = (slug: string) => `---
name: ${slug}
description: Use when a release candidate needs its final checks. Also use when a hotfix is about to be tagged.
---

# Run the release checks

## Steps

1. Freeze merges to the release branch.
2. Run the full test suite on the candidate.
3. Compare the changelog against the merged requests.

## Verification

- Every test passed on the candidate commit.
- The changelog names every merged request.

## Pitfalls

- A merge that lands after the freeze skips the checks.
`;

const twin = (slug: string) => `---\nname: ${slug}\ndescription: Use when reconciling the monthly vendor invoices against the purchase ledger before closing the books.\n---\n\nBody.\n`;

async function addAndMerge(org: LabOrg, repo: LabRepo, slug: string, content: string): Promise<void> {
  const opened = await propose(await ownerOf(org, repo), org, repo, { kind: "skill.add", slug, content }, `add ${slug}`);
  expect(opened.status, opened.error).toBe(200);
  await merge(org, repo, opened.request!.number);
}

test.describe("what the plugin's rules say about a team's skills and servers", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when a well-formed skill and two skills that answer the same requests are merged, then the first has nothing the format asks for, the two name each other, and a thin seed skill lists what it lacks, on the page too`, async ({ browser }) => {
      // given
      const good = unique("well-formed");
      const [one, two] = [unique("vendor-invoices"), unique("vendor-ledger")];

      // when
      await addAndMerge(org, repo, good, wellFormed(good));
      await addAndMerge(org, repo, one, twin(one));
      await addAndMerge(org, repo, two, twin(two));

      // then
      const { skills } = await inventory(org, repo);
      const of = (slug: string) => skills.find((s) => s.slug === slug)!;
      expect(of(good).format).toEqual([]);
      const { overlaps } = await (await as(org, "member")).ok<{ overlaps: Record<string, { names: string[]; more: number }> }>("GET", `/api/repos/${repo.id}/overlaps`);
      const named = (slug: string) => overlaps[slug] ?? { names: [], more: 0 };
      // The page names a few and counts the rest; a skill named in neither does not answer the same requests.
      expect(named(one).names.includes(two) || named(one).more > 0).toBe(true);
      expect(named(two).names.includes(one) || named(two).more > 0).toBe(true);
      expect(named(good).names).not.toContain(one);
      const seed = of(ORGS.find((o) => o.name === org.name)!.teams.find((t) => t.id === repo.id)!.skills[0]!.slug);
      expect(seed.format).toEqual(expect.arrayContaining(["it has no pitfalls section"]));

      // and the owner's page says the same
      const context = await browser.newContext();
      const page = await context.newPage();
      await signInOnPage(page, org, ownerKey(repo.team));
      await openRepo(page, org, repo.id, "Skills");
      const more = named(one).more ? ` and ${named(one).more} more` : "";
      await expect(page.getByText(`Answers the same requests as ${named(one).names.join(", ")}${more}, so Claude can pick either.`)).toBeVisible();
      await expect(page.getByRole("row", { name: new RegExp(`^${good}`) })).not.toContainText("the plugin's skill format asks for");
      await context.close();
    });
  }

  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when a member reads its MCP servers on an orchestrator that runs tasks, then each says whether a task gets it, and a server that signs in through a browser is marked so`, async ({ browser }) => {
      // given
      const declared = (JSON.parse(fileAt(repo, "HEAD", ".mcp.json") ?? "{}") as { mcpServers?: Record<string, Record<string, unknown>> }).mcpServers ?? {};
      test.skip(!Object.keys(declared).length, "this team shares no MCP server");

      // when
      const { mcpServers } = await inventory(org, repo);

      // then: the stand-in agent cannot be held to named tools, so a server is usable only where
      // the orchestrator also offers Claude Code and the repository names one of the server's tools;
      // a usable server that sends no credential is marked as signing in through a browser
      const spec = ORGS.find((o) => o.name === org.name)!;
      const tools = spec.teams.find((t) => t.id === repo.id)!.mcpTools ?? [];
      for (const [name, config] of Object.entries(declared)) {
        const verdict = mcpServers.find((s) => s.name === name)?.inTasks;
        const usable = (spec.agents ?? "fake").includes("claude-code") && tools.some((t) => t.startsWith(`${name}/`));
        const signIn = usable && typeof config.url === "string" && !config.headers;
        expect([name, verdict?.usable, verdict?.signIn, Boolean(verdict?.detail)]).toEqual([name, usable, signIn, true]);
      }

      // and each server's details on the page say the same
      const context = await browser.newContext();
      const page = await context.newPage();
      await signInOnPage(page, org, "member");
      await openRepo(page, org, repo.id, "MCP servers");
      await expect(page.getByRole("region", { name: /^MCP servers/ }).getByText("In tasks", { exact: true }).first()).toBeAttached();
      for (const [name, config] of Object.entries(declared)) {
        const usable = (spec.agents ?? "fake").includes("claude-code") && tools.some((t) => t.startsWith(`${name}/`));
        const badge = !usable ? "not given" : typeof config.url === "string" && !config.headers ? "given, no sign-in" : "given";
        await expect(page.getByRole("row", { name: new RegExp(`^${name}\\b`) })).toContainText(badge);
      }
      await context.close();
    });
  }

  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when a teammate's merge writes a version into the plugin manifest, then the panel names a returned version line only where the repository was versioned by commit, and the teammate's doctor agrees`, async () => {
      // given
      const m = teammateOn(org, repo);
      updateMarketplace(m);
      const manifest = JSON.parse(fileAt(repo, "HEAD", ".claude-plugin/plugin.json")!) as Record<string, unknown>;
      const byCommit = manifest.version === undefined;
      const version = byCommit ? "0.9.0" : `${String(manifest.version).split(".").slice(0, 2).join(".")}.99`;

      await whileChanged(org, repo, { ".claude-plugin/plugin.json": JSON.stringify({ ...manifest, version }, null, 2) + "\n" }, async () => {
        // when
        const back = (await inventory(org, repo)).setup.find((f) => f.title === "The version line came back");

        // then
        if (byCommit) {
          expect(back).toMatchObject({ level: "attention" });
          expect(back?.detail).toMatch(new RegExp(`^The repository was versioned by commit, and [0-9a-f]{7} by Lab Teammate on \\d{4}-\\d{2}-\\d{2} put version ${version.replace(/\./g, "\\.")} back`));
          expect(doctor(m).teamCopy).toContain(`the team repo carries a version line again (v${version})`);
        } else {
          expect(back).toBeUndefined();
        }
      });

      // then once put back
      expect((await inventory(org, repo)).setup.find((f) => f.title === "The version line came back")).toBeUndefined();
      updateMarketplace(m);
      expect(doctor(m).teamCopy).toMatch(/^✔ team plugin copy/);
    });
  }
});
