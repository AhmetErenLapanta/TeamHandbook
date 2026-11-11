import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import { seedTeamRepo } from "../repos.js";
import { as, lab, SHAPES, spareOrchestratorPort, startOrchestratorProcess, unique } from "./support.js";

const REPO = "team-skills";

/** A team repository of its own under `dir`, under the id both orgs give theirs. */
function teamRepo(dir: string, team: string, slug: string) {
  const bare = join(dir, "repos", `${team.toLowerCase()}.git`);
  seedTeamRepo(lab.path, { id: REPO, team, reviewers: [], labels: [], skills: [{ slug, description: `Use when the lab checks ${team}.`, body: "1. Begin.\n" }] }, bare, `file://${bare}`, join(dir, "scratch", team));
  return { id: REPO, team, url: `file://${bare}` };
}

/** A task for the stand-in agent, once the orchestrator has read the repository, followed until it waits for review. */
async function taskInReview(owner: OrchestratorClient, title: string): Promise<string> {
  const head = async () => (await owner.ok<{ repos: { id: string; head: string | null }[] }>("GET", "/api/repos")).repos.find((r) => r.id === REPO)?.head;
  for (let i = 0; i < 120 && !(await head()); i++) await new Promise((r) => setTimeout(r, 500));
  const { task } = await owner.ok<{ task: { id: string } }>("POST", "/api/tasks", { title, description: "Add a skill named after this task.", repoId: REPO, agent: "fake" });
  for (let i = 0; i < 240; i++) {
    const { task: now } = await owner.ok<{ task: { status: string } }>("GET", `/api/tasks/${task.id}`);
    if (now.status === "needs-review") return task.id;
    if (["failed", "cancelled"].includes(now.status)) throw new Error(`the task ${title} ended ${now.status}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the task ${title} did not reach review`);
}

test.describe("two orgs on one orchestrator keep apart", () => {
  test.beforeAll(async () => {
    const probe = await (await as(SHAPES[0]!.org, "member")).call("GET", "/api/orgs");
    test.skip(!("default" in probe.json), "this orchestrator serves one org only");
    test.skip(!lab.jira, "this lab has no stand-in tracker");
  });

  test("given two orgs on one orchestrator, each with a repository of the same id and a task, and the second reading Jira, when a member of the first reaches for the second's tasks, repository and Work source with their session, an API key of the first and the second's ids, through the API and the pages, then every attempt is refused or finds nothing, and nothing of the second is shown", async ({ page }) => {
    test.setTimeout(300_000);
    // given
    const dir = join(lab.dir, "org-isolation", unique("two"));
    const [alpha, beta] = [unique("alpha"), unique("beta")];
    const code = unique("setup");
    const served = await startOrchestratorProcess({
      port: spareOrchestratorPort(2),
      tenant: alpha,
      dataDir: join(dir, "data"),
      store: "sqlite",
      setupCode: code,
      orgs: [{ tenant: alpha, repos: [teamRepo(join(dir, "alpha"), "Core", "alpha-skill")] }, { tenant: beta, repos: [teamRepo(join(dir, "beta"), "Ops", "beta-skill")] }],
    });
    try {
      const alphaOwner = await OrchestratorClient.setup(served.url, code, { email: `owner@${alpha}.example.invalid`, name: "Alpha Owner" }, lab.password);
      const betaOwner = await OrchestratorClient.setup(served.url, code, { email: `owner@${beta}.example.invalid`, name: "Beta Owner" }, lab.password, beta);
      const memberEmail = `member@${alpha}.example.invalid`;
      await alphaOwner.ok("POST", "/api/users", { email: memberEmail, name: "Alpha Member", role: "member", teams: ["Core"], password: lab.password });
      const member = await OrchestratorClient.signIn(served.url, memberEmail, lab.password);
      const betaTitle = unique("beta-secret-plan");
      const [alphaTask, betaTask] = await Promise.all([taskInReview(alphaOwner, unique("alpha-task")), taskInReview(betaOwner, betaTitle)]);
      await betaOwner.ok("PUT", "/api/integrations/tracker", { kind: "jira", url: lab.jira!.url, email: lab.jira!.email, token: lab.jira!.token });
      const betaBoards = await betaOwner.ok<{ boards: { id: string; name: string }[] }>("GET", "/api/work/boards?source=tracker");
      const board = betaBoards.boards[0]!;
      const { secret } = await alphaOwner.ok<{ secret: string }>("POST", "/api/keys", { name: unique("alpha-key"), scopes: { repositories: "read", tasks: "read" }, expiresInDays: 1 });
      const memberOnBeta = OrchestratorClient.withCookie(served.url, member.cookie);
      const keyOn = (path: string) => fetch(`${served.url}${path}`, { headers: { authorization: `Bearer ${secret}` } }).then(async (r) => ({ status: r.status, body: await r.text() }));

      // when the member's session reaches for the second org's paths
      const onBeta = [`/api/orgs/${beta}/tasks`, `/api/orgs/${beta}/tasks/${betaTask}`, `/api/orgs/${beta}/repos`, `/api/orgs/${beta}/repos/${REPO}/inventory`, `/api/orgs/${beta}/work/sources`, `/api/orgs/${beta}/work/boards?source=tracker`];
      const bySession = await Promise.all(onBeta.map((path) => memberOnBeta.call("GET", path)));
      // and the first org's key does the same
      const byKey = await Promise.all(onBeta.map(keyOn));
      // and the second's ids are asked of the first org, where the member and the key belong
      const copiedIds = await Promise.all([member.call("GET", `/api/tasks/${betaTask}`), alphaOwner.call("GET", `/api/tasks/${betaTask}`), keyOn(`/api/tasks/${betaTask}`).then((r) => ({ status: r.status, json: r.body }))]);
      const ownSources = await alphaOwner.ok<{ sources: { id: string }[] }>("GET", "/api/work/sources");
      const boardFromBeta = await alphaOwner.call("GET", `/api/work/sprints?board=${encodeURIComponent(board.id)}`);
      const ownTasks = await member.ok<{ tasks: { id: string }[] }>("GET", "/api/tasks");
      const ownRepos = await alphaOwner.ok<{ repos: { id: string; team: string }[] }>("GET", "/api/repos");
      // The same paths read by the second org's owner, so a refusal above is the boundary and not a wrong path.
      const control = await Promise.all(onBeta.map((path) => OrchestratorClient.withCookie(served.url, betaOwner.cookie).call("GET", path)));

      // then
      expect(control.map((r) => r.status)).toEqual(onBeta.map(() => 200));
      expect(JSON.stringify(control[1]!.json)).toContain(betaTitle);
      for (const [i, reply] of bySession.entries()) expect([onBeta[i], reply.status], "the first org's session on the second's path").toEqual([onBeta[i], 401]);
      for (const [i, reply] of byKey.entries()) expect([onBeta[i], reply.status], "the first org's key on the second's path").toEqual([onBeta[i], 401]);
      expect(copiedIds.map((r) => r.status)).toEqual([404, 404, 404]);
      expect(ownSources.sources).toEqual([]);
      expect(boardFromBeta.status).toBe(404);
      expect(ownTasks.tasks.map((t) => t.id)).toEqual([alphaTask]);
      expect(ownRepos.repos.map((r) => [r.id, r.team])).toEqual([[REPO, "Core"]]);
      const answered = JSON.stringify([bySession.map((r) => r.json), byKey.map((r) => r.body), copiedIds.map((r) => r.json), boardFromBeta.json]);
      for (const leaked of [betaTask, betaTitle, "Ops", "beta-skill", board.name]) expect(answered, `an answer naming ${leaked}`).not.toContain(leaked);

      // when the member signs in to the pages and opens the second org's addresses and its task id under the first
      await page.goto(served.url);
      await page.getByLabel("Email").fill(memberEmail);
      await page.getByLabel("Password").fill(lab.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("button", { name: /Alpha Member/ })).toBeVisible();
      const shown: Record<string, string> = {};
      for (const path of [`/${beta}/tasks/${betaTask}`, `/${beta}/repositories`, `/${beta}/work`, `/tasks/${betaTask}`]) {
        await page.goto(`${served.url}${path}`);
        await page.waitForLoadState("networkidle");
        shown[path] = await page.locator("body").innerText();
      }

      // then the second org's pages ask for its own sign-in, and the first org has no such task
      for (const path of [`/${beta}/tasks/${betaTask}`, `/${beta}/repositories`, `/${beta}/work`]) expect([path, shown[path]], "a page of the second org").toEqual([path, expect.stringMatching(/Sign in/)]);
      for (const [path, text] of Object.entries(shown)) {
        for (const leaked of [betaTitle, "Ops", "beta-skill", board.name]) expect(text, `${path} naming ${leaked}`).not.toContain(leaked);
      }
    } finally {
      await served.stop();
    }
  });
});
