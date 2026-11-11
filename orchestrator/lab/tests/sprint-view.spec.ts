import { expect, test } from "@playwright/test";
import type { OrchestratorClient } from "../client.js";
import { Evidence } from "../evidence.js";
import { until } from "../solo.js";
import { SPRINT_ISSUES } from "../multi-repo.js";
import { ownerKey } from "../state.js";
import { as, close, lab, runToReview, signInOnPage } from "./support.js";

const org = lab.orgs.find((o) => o.fixture === "multi-repo");
const code = (org?.repos ?? []).filter((r) => r.code);

/** The Customers board on the organization's tracker, and its active sprint, as the Work pages name them. */
const BOARD = "tracker~7";
const SPRINT = `${BOARD}~41`;
/** An issue's link on the connected tracker, which the orchestrator reads the issue from. */
const linkOf = (key: string) => `${lab.jira!.url}/browse/${key}`;

interface Item {
  key: string;
  assignee: { name: string } | null;
  storyPoints: number | null;
  blocked?: boolean;
  status: { category: "todo" | "doing" | "done" };
  tasks: { taskId: string; requests: { repoId: string; number: number; status: string }[]; costUsd: number | null }[];
}

interface Read {
  items: Item[];
  progress: { todo: number; doing: number; done: number; points: { total: number; done: number } | null };
}

/** The stand-in Jira's own way for a teammate to link an issue as blocked by others; an empty list takes the links away. */
const blockedBy = (key: string, keys: string[]) => fetch(`${lab.jira!.url}/lab/link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, blockedBy: keys }) });

/** A cost as the Work page writes it. */
const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * A sprint as a team lead reads it on the orchestrator: who each issue is assigned to, the
 * requests its agents opened, what is blocked, how far the sprint is and what its agents cost,
 * the same on the API and on the Work page. The tracker is the lab's stand-in Jira, its Customers
 * board and active sprint (lab/multi-repo.ts); a teammate links an issue as blocked there.
 */
test.describe("a sprint's view", () => {
  test.skip(!org || !lab.jira, "this lab has no organization with code repositories or no stand-in tracker");

  test("given the Customers sprint with an issue blocked in Jira, when its owner starts an agent on one issue and opens the sprint, then each issue reads its assignee and points, the started one its request and cost, the blocked one Blocked, and the Work page's progress, open requests, blocked count, cost and points are the API's", async ({ page }) => {
    test.setTimeout(420_000);
    // given
    const admin = await as(org!, "org-admin");
    const owner: OrchestratorClient = await as(org!, ownerKey("Customers"));
    await admin.ok("PUT", "/api/integrations/tracker", { kind: "jira", url: lab.jira!.url, email: lab.jira!.email, token: lab.jira!.token });
    await admin.ok("PUT", "/api/work/boards/teams", { boards: [{ boardId: BOARD, team: "Customers" }] });
    expect((await blockedBy("HOO-414", ["HOO-416"])).status).toBe(200);
    const proof = new Evidence(lab.dir, "sprint-view", [lab.password]);
    let opened: { repoId: string; number: number }[] = [];
    try {
      // when the team's owner starts an agent on HOO-413 and it runs to review
      const issue = SPRINT_ISSUES.find((i) => i.key === "HOO-413")!;
      const task = await runToReview(owner, code[0]!, issue.summary, { agent: "claude-code", issueUrl: linkOf(issue.key), targets: "orchestrator", description: "" });
      // A task over three repositories runs past runToReview's minute; it is followed until it ends.
      const shown = await until(() => owner.ok<{ task: { status: string; cost: { usd: number | null }; targets: { repoId: string; request: { number: number } | null }[] | null } }>("GET", `/api/tasks/${task.id}`), (r) => !["queued", "running"].includes(r.task.status), 1200);
      opened = (shown.task.targets ?? []).flatMap((t) => (t.request ? [{ repoId: t.repoId, number: t.request.number }] : []));
      const read = await owner.ok<Read>("GET", `/api/work/items?sprint=${encodeURIComponent(SPRINT)}&fresh=1`);
      proof.json("sprint.json", read);
      const item = (key: string) => read.items.find((i) => i.key === key)!;

      // then the API reads each issue's assignee and points, the started issue's request and cost, and the blocked one
      expect(shown.task.status).toBe("needs-review");
      expect(opened.length).toBeGreaterThan(0);
      expect(read.items.map((i) => [i.key, i.assignee?.name ?? null, i.storyPoints, i.blocked === true]).sort()).toEqual([
        ["HOO-412", "Cara Customers", 5, false],
        ["HOO-413", "Cara Customers", 3, false],
        ["HOO-414", null, 2, true],
      ]);
      const link = item("HOO-413").tasks.find((t) => t.taskId === task.id)!;
      expect(link.requests.map((r) => [r.repoId, r.number, r.status]).sort()).toEqual(opened.map((o) => [o.repoId, o.number, "open"]).sort());
      expect(link.costUsd).toBe(shown.task.cost.usd);
      const total = read.items.length;
      expect(read.progress.todo + read.progress.doing + read.progress.done).toBe(total);
      expect(read.progress.points).toEqual({ total: 10, done: read.items.filter((i) => i.status.category === "done").reduce((n, i) => n + (i.storyPoints ?? 0), 0) });

      // when the owner opens the sprint on the Work page
      await signInOnPage(page, org!, ownerKey("Customers"));
      await page.goto(`${org!.url}/${org!.name}/work?source=tracker&board=${encodeURIComponent(BOARD)}&sprint=${encodeURIComponent(SPRINT)}`);

      // then its progress, open requests, blocked count, cost and points are the API's
      const progress = page.getByRole("region", { name: "Sprint progress" });
      const open = new Set(read.items.flatMap((i) => i.tasks.flatMap((t) => t.requests.filter((r) => r.status === "open").map((r) => `${r.repoId}#${r.number}`))));
      const costs = read.items.flatMap((i) => i.tasks.map((t) => t.costUsd));
      const spent = costs.filter((c): c is number => c !== null).reduce((n, c) => n + c, 0);
      await expect(progress).toContainText(`${read.progress.done} of ${total} done`);
      await expect(progress).toContainText(open.size ? `${open.size} in review` : "Agents worked on");
      await expect(progress).toContainText("1 flagged");
      if (costs.some((c) => c !== null)) await expect(progress).toContainText(`for ${usd(spent)}`);
      await expect(progress).toContainText(`${read.progress.points!.done} of 10 points done`);
      // and each card says who it is assigned to, what blocks it, and the started one's requests
      const card = (key: string) => page.getByRole("listitem", { name: new RegExp(`^${key} `) });
      await expect(card("HOO-414").getByText("Blocked", { exact: true })).toBeVisible();
      await expect(card("HOO-414")).toContainText("Unassigned");
      await expect(card("HOO-413")).toContainText("Cara Customers");
      for (const o of opened) await expect(card("HOO-413").getByRole("link", { name: `${o.repoId} #${o.number}` })).toBeVisible();
      await page.screenshot({ path: `${proof.dir}/sprint.png`, fullPage: true });
    } finally {
      await blockedBy("HOO-414", []);
      for (const o of opened) await close(org!, code.find((c) => c.id === o.repoId)!, o.number);
    }
  });
});
