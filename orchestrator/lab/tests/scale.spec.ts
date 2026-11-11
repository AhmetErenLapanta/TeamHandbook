import { expect, test } from "@playwright/test";
import type { LabRepo } from "../state.js";
import { as, fileAt, forgeCall, headOf, lab, ownerOf, pick, close, startTenantOrchestrator, unique } from "./support.js";

const versionAt = (repo: LabRepo, ref: string) => (JSON.parse(fileAt(repo, ref, ".claude-plugin/plugin.json") ?? "{}") as { version?: string }).version;
const skillText = (slug: string) => `---\nname: ${slug}\ndescription: Use when two orchestrators ask at the same moment.\n---\n\nBody.\n`;

test.describe("an orchestrator under a large repository", () => {
  test("given a repository of 2000 skills, when a member reads its inventory, then the orchestrator keeps answering who is signed in while it reads them and their overlaps", async () => {
    test.setTimeout(180_000);
    // given
    const { org, repo } = pick("acme", "bulk-skills");
    const member = await as(org, "member");
    const admin = await as(org, "admin");

    // when the inventory and the overlaps its page asks for next are read
    const started = Date.now();
    const reading = Promise.all([
      member.ok<{ inventory: { skills: unknown[] } }>("GET", `/api/repos/${repo.id}/inventory`),
      member.ok<{ overlaps: Record<string, unknown> }>("GET", `/api/repos/${repo.id}/overlaps`),
    ]).then(([inv]) => inv);
    let done = false;
    void reading.finally(() => (done = true));
    const waits: number[] = [];
    let resets = 0;
    while (!done) {
      const asked = Date.now();
      // A call held past the server's keep-alive is reset rather than answered: a wait all the same.
      const answered = await admin.call("GET", "/api/me").then((r) => r.status === 200, () => false);
      if (!answered) resets += 1;
      waits.push(Date.now() - asked);
      await new Promise((r) => setTimeout(r, 100));
    }

    // then
    const { inventory } = await reading;
    expect(inventory.skills.length).toBeGreaterThanOrEqual(2000);
    test.info().annotations.push({ type: "measured", description: `inventory read ${Date.now() - started} ms; slowest /api/me ${Math.max(0, ...waits)} ms over ${waits.length} calls, ${resets} reset` });
    expect(Math.max(0, ...waits)).toBeLessThan(1000);
  });
});

test.describe("two tenants of one Postgres with the same team repository", () => {
  test("given a second tenant's orchestrator connected to the same repository on the stand-in GitLab, when both orchestrators open a request at the same moment, then each raises the plugin to a different version", async () => {
    // given
    const { org, repo } = pick("globex", "data-skills");
    const forge = lab.forges.find((f) => f.kind === repo.forge)!;
    const shadow = await startTenantOrchestrator(2, [{ id: repo.id, team: repo.team, url: repo.url }]);
    const opened: { orchestrator: "ours" | "theirs"; number: number }[] = [];
    try {
      await shadow.admin.ok("PUT", `/api/repos/${repo.id}/forge`, { kind: "gitlab", apiUrl: forge.api, project: repo.project, token: forge.token });
      let theirHead = "";
      for (let i = 0; i < 240 && !theirHead; i++) {
        const { repos } = await shadow.admin.ok<{ repos: { id: string; head: string | null }[] }>("GET", "/api/repos");
        theirHead = repos.find((r) => r.id === repo.id)?.head ?? "";
        if (!theirHead) await new Promise((r) => setTimeout(r, 250));
      }
      const owner = await ownerOf(org, repo);
      const ourHead = await headOf(org, repo);
      const [mine, yours] = [unique("tenant-one"), unique("tenant-two")];
      const ask = async (client: typeof owner, slug: string, head: string) => {
        const change = { kind: "skill.add", slug, content: skillText(slug) };
        const { branch } = await client.ok<{ branch: string }>("POST", `/api/repos/${repo.id}/changes/proposal`, { change });
        return client.call<{ request?: { number: number; branch: string }; error?: string }>("POST", `/api/repos/${repo.id}/changes`, { baseSha: head, change, message: `add ${slug}`, branch });
      };

      // when
      const [ours, theirs] = await Promise.all([ask(owner, mine, ourHead), ask(shadow.admin, yours, theirHead)]);
      if (ours.json.request) opened.push({ orchestrator: "ours", number: ours.json.request.number });
      if (theirs.json.request) opened.push({ orchestrator: "theirs", number: theirs.json.request.number });

      // then
      expect([ours.status, theirs.status]).toEqual([200, 200]);
      expect(versionAt(repo, ours.json.request!.branch)).not.toBe(versionAt(repo, theirs.json.request!.branch));
    } finally {
      for (const o of opened) {
        if (o.orchestrator === "ours") await close(org, repo, o.number);
        else await forgeCall(repo, "PUT", `/projects/${encodeURIComponent(repo.project!)}/merge_requests/${o.number}`, { state_event: "close" });
      }
      shadow.stop();
    }
  });
});
