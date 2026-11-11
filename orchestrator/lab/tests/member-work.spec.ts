import { expect, test } from "@playwright/test";
import { ownerKey, userOf } from "../state.js";
import { as, close, lab, runToReview, signInOnPage } from "./support.js";

const org = lab.orgs.find((o) => o.fixture === "multi-repo");
const code = (org?.repos ?? []).filter((r) => r.code);

/** The Customers board on the organization's tracker, as the Work pages name it. */
const BOARD = "tracker~7";
const SPRINT = `${BOARD}~41`;
const linkOf = (key: string) => `https://tracker.example.invalid/browse/${key}`;

interface Card {
  key: string;
  tasks: { taskId: string; status: string; startedBy: string; requests: { repoId: string; number: number }[] }[];
}

/**
 * Every member of an organization starts work on each of its teams and follows it, except on a
 * team its editors keep to its owners: there only the team's owners and the organization's
 * owners and admins start, and a member reads only the tasks they started themselves. The
 * member here owns no team.
 */
test.describe("a member works the team's issues from the board", () => {
  test.skip(!org || !lab.jira, "this lab has no organization with code repositories or no stand-in tracker");

  test.beforeAll(async () => {
    const admin = await as(org!, "org-admin");
    await admin.ok("PUT", "/api/integrations/tracker", { kind: "jira", url: lab.jira!.url, email: lab.jira!.email, token: lab.jira!.token });
    await admin.ok("PUT", "/api/work/boards/teams", { boards: [{ boardId: BOARD, team: "Customers" }] });
  });

  // Fails while the start form offers a member only the repositories of teams they edit (/api/tasks/options), so none here.
  test.fail("given a member of the organization who owns no team, when they open the Customers sprint board, pick an issue and start its agent, then it starts in their name, the card shows the agent working and then the request in review, and the task and its steps read to them", async ({ page }) => {
    test.setTimeout(300_000);
    // given
    const member = userOf(org!, "member");
    // Read first, so the gap fails at once rather than as a form that never shows its choices.
    const offered = await (await as(org!, "member")).ok<{ repos: { id: string }[] }>("GET", "/api/tasks/options");
    expect(offered.repos.map((r) => r.id)).toEqual(expect.arrayContaining(code.map((r) => r.id)));
    await signInOnPage(page, org!, "member");
    await page.goto(`${org!.url}/${org!.name}/work?source=tracker&board=${encodeURIComponent(BOARD)}&sprint=${encodeURIComponent(SPRINT)}`);
    const board = page.getByRole("group", { name: "Customers Sprint 14 board" });
    await expect(board).toBeVisible();

    // when
    await page.getByRole("checkbox", { name: "Pick HOO-414" }).check();
    await page.getByRole("region", { name: "Picked issues" }).getByRole("button", { name: "Start agents" }).click();
    const form = page.getByRole("form", { name: "Start agents" });
    await form.getByRole("radio", { name: /Let each agent find the repositories/ }).check();
    await form.getByRole("combobox", { name: "Agent", exact: true }).click();
    await page.getByRole("option", { name: "Claude Code" }).click();
    await form.getByRole("button", { name: "Start 1 agent" }).click();

    // then
    await expect(page.getByRole("status").filter({ hasText: /started\./ })).toHaveText(/^1 agent started\./);
    await page.getByRole("region", { name: /^Start agents/ }).getByRole("button", { name: /^Done( picking)?$/ }).click();
    const card = board.getByRole("listitem", { name: /^HOO-414 / });
    await expect(card.getByRole("link", { name: /Agent (queued|working)|Request in review/ })).toBeVisible({ timeout: 60_000 });
    await expect(card.getByRole("link", { name: "Request in review" })).toBeVisible({ timeout: 180_000 });
    const reader = await as(org!, "member");
    const { items } = await reader.ok<{ items: Card[] }>("GET", `/api/work/items?sprint=${encodeURIComponent(SPRINT)}&fresh=1`);
    const started = items.find((i) => i.key === "HOO-414")!.tasks[0]!;
    try {
      expect(started.startedBy).toBe(member.email);
      const shown = await reader.ok<{ task: { status: string }; log: { text: string }[] }>("GET", `/api/tasks/${started.taskId}`);
      expect([shown.task.status, shown.log.length > 0]).toEqual(["needs-review", true]);
    } finally {
      for (const r of started.requests) await close(org!, code.find((c) => c.id === r.repoId)!, r.number);
    }
  });

  // Bound once a task's start reads whether its team is kept to its owners; the refusal's words come with it.
  test.fixme("given a member who started a task on the Customers team, when the team's owner keeps the team's tasks to its owners, then the member's start of another issue is refused with why on the board and the API alike, the owner's task is unknown to them, and the task they started stays theirs to read", async () => {
    test.setTimeout(300_000);
    // given a task the member started while the team was open, and one its owner started
    const admin = await as(org!, "org-admin");
    const owner = await as(org!, ownerKey("Customers"));
    const member = await as(org!, "member");
    const theirs = await runToReview(member, code[0]!, "Expose the return-label endpoint to customers", { agent: "claude-code", issueUrl: linkOf("HOO-414"), targets: "orchestrator", description: "" });
    const owners = await runToReview(owner, code[0]!, "Expose the delivery-window endpoint to customers", { agent: "claude-code", issueUrl: linkOf("HOO-413"), targets: "orchestrator", description: "" });
    try {
      // when the team's owner keeps it to its owners, and the member starts work there
      await owner.ok("PUT", "/api/teams/Customers/restricted", { restricted: true });
      const single = await member.call<{ error?: string }>("POST", "/api/tasks", { title: "Expose the carrier-list endpoint to customers", description: "", repoId: code[0]!.id, agent: "claude-code", issueUrl: linkOf("HOO-415"), targets: "orchestrator" });
      const batch = await member.call<{ started?: unknown[]; refused?: { error: string }[]; error?: string }>("POST", "/api/tasks/batch", { agent: "claude-code", items: [{ issueUrl: linkOf("HOO-415"), repoId: code[0]!.id, targets: "orchestrator", title: "Expose the carrier-list endpoint to customers", description: "" }] });
      const ownersTask = await member.call("GET", `/api/tasks/${owners.id}`);
      const ownTask = await member.call("GET", `/api/tasks/${theirs.id}`);
      const listed = await member.ok<{ tasks: { id: string }[] }>("GET", "/api/tasks");

      // then
      expect(single.status).toBe(403);
      expect(single.json.error).toMatch(/Customers/);
      expect(batch.json.started ?? []).toEqual([]);
      expect(ownersTask.status).toBe(404);
      expect(ownTask.status).toBe(200);
      expect(listed.tasks.map((t) => t.id)).toContain(theirs.id);
      expect(listed.tasks.map((t) => t.id)).not.toContain(owners.id);
    } finally {
      await admin.ok("PUT", "/api/teams/Customers/restricted", { restricted: false });
      for (const task of [theirs, owners]) {
        const shown = await admin.ok<{ task: { targets: { repoId: string; request: { number: number } | null }[] | null } }>("GET", `/api/tasks/${task.id}`);
        for (const target of shown.task.targets ?? []) if (target.request) await close(org!, code.find((c) => c.id === target.repoId)!, target.request.number);
      }
    }
  });
});
