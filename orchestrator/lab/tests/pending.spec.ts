import { expect, test } from "@playwright/test";
import { ownerKey } from "../state.js";
import type { LabOrg, LabRepo } from "../state.js";
import { as, close, lab, merge, openRepo, ownerOf, pick, propose, SHAPES, signInOnPage, teammateShare, unique, withdrawShare } from "./support.js";

interface Pending {
  number: number | null;
  title: string;
  branch: string;
  author: string;
  byOrchestrator: boolean;
}

/** How long the orchestrator keeps one read of a forge's waiting requests, so page loads do not spend the team's rate limit. */
const PENDING_FRESH_MS = 30_000;

async function pending(org: LabOrg, repo: LabRepo): Promise<Pending[]> {
  const { pending: listed } = await (await as(org, "member")).ok<{ pending: Pending[] | null }>("GET", `/api/repos/${repo.id}/pending`);
  return listed ?? [];
}

const skillText = (slug: string) => `---\nname: ${slug}\ndescription: Use when the lab checks what waits to be merged.\n---\n\nBody.\n`;

test.describe("what waits to be merged, whoever opened it", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, with a request from the orchestrator and a teammate's share from their own machine, when anyone reads what waits to be merged, then both are listed by who opened them, on the page too`, async ({ browser }) => {
      // given
      const owner = await ownerOf(org, repo);
      const slug = unique("pending");
      const ours = await propose(owner, org, repo, { kind: "skill.add", slug, content: skillText(slug) }, `add ${slug}`);
      expect(ours.status, ours.error).toBe(200);
      const theirs = await teammateShare(repo, "nora", { [`skills/${slug}-shared/SKILL.md`]: skillText(`${slug}-shared`) }, `feat(skill): add ${slug}-shared`);

      try {
        // when
        const listed = await pending(org, repo);

        // then
        expect(listed.find((p) => p.branch === ours.request!.branch)).toMatchObject({ byOrchestrator: true, number: ours.request!.number });
        expect(listed.find((p) => p.branch === theirs.branch)).toMatchObject({ byOrchestrator: false, author: "nora", number: theirs.number, title: `feat(skill): add ${slug}-shared` });

        // and the page shows the teammate's share under Waiting to be merged, the orchestrator's under its own requests
        const context = await browser.newContext();
        const page = await context.newPage();
        await signInOnPage(page, org, ownerKey(repo.team));
        await openRepo(page, org, repo.id, "Requests");
        const waiting = page.getByRole("region", { name: /^Waiting to be merged/ });
        await expect(waiting).toContainText(`feat(skill): add ${slug}-shared`);
        await expect(waiting).toContainText("opened from the orchestrator");
        await context.close();
      } finally {
        await close(org, repo, ours.request!.number).catch(() => undefined);
        await withdrawShare(repo, theirs).catch(() => undefined);
      }
    });
  }

  for (const { shape, org, repo } of [SHAPES[0]!, SHAPES[2]!]) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, whose waiting requests were just read, when the orchestrator merges its own request, then the next look does not list it as someone else's waiting share`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const slug = unique("merged-here");
      const ours = await propose(owner, org, repo, { kind: "skill.add", slug, content: skillText(slug) }, `add ${slug}`);
      expect(ours.status, ours.error).toBe(200);
      expect((await pending(org, repo)).find((p) => p.branch === ours.request!.branch)?.byOrchestrator).toBe(true);

      // when
      await merge(org, repo, ours.request!.number);

      // then
      expect((await pending(org, repo)).map((p) => p.branch)).not.toContain(ours.request!.branch);
    });
  }

  test("given a teammate's share on the stand-in GitLab that was listed as waiting, when the teammate withdraws it, then it is gone once the orchestrator's read of the forge is older than its keeping time", async () => {
    test.setTimeout(2 * PENDING_FRESH_MS + 60_000);
    // given: listed once a read older than the keeping time gives way to a new one
    const { org, repo } = pick("vandelay", "exports-skills");
    const slug = unique("withdrawn");
    const theirs = await teammateShare(repo, "nora", { [`skills/${slug}/SKILL.md`]: skillText(slug) }, `feat(skill): add ${slug}`);
    try {
      const listedBy = Date.now() + PENDING_FRESH_MS + 5_000;
      while (!(await pending(org, repo)).some((p) => p.branch === theirs.branch) && Date.now() < listedBy) await new Promise((r) => setTimeout(r, 1_000));
      expect((await pending(org, repo)).map((p) => p.branch)).toContain(theirs.branch);

      // when
      await withdrawShare(repo, theirs);
      await new Promise((r) => setTimeout(r, PENDING_FRESH_MS + 1_000));

      // then
      expect((await pending(org, repo)).map((p) => p.branch)).not.toContain(theirs.branch);
    } catch (err) {
      await withdrawShare(repo, theirs).catch(() => undefined);
      throw err;
    }
  });
});
