import { expect, test } from "@playwright/test";
import { ownerKey } from "../state.js";
import type { ForgeAppCall } from "../forge.js";
import { as, close, lab, signInOnPage } from "./support.js";

const org = lab.orgs.find((o) => o.name === "initech");
const repo = org?.repos.find((r) => r.id === "web-skills");
const github = lab.forges.find((f) => f.kind === "github");

/** The Web team's repository on the stand-in GitHub, as the Work pages name it through the organization's GitHub connection. */
const SOURCE = "forge:github";
const BOARD = `${SOURCE}~initech/web-skills`;
/** What the orchestrator asks of an installation token that reads a board: issues and metadata, nothing else. */
const READS_ISSUES = { issues: "read", metadata: "read" };

const appCalls = async () => ((await (await fetch(`${github!.url}/lab/app`)).json()) as { calls: ForgeAppCall[] }).calls;

interface Card {
  key: string;
  url: string;
  column: string;
  tasks: { taskId: string; status: string; requests: { repoId: string; number: number }[] }[];
}

test.describe("a team's GitHub issues worked by agents", () => {
  test.skip(!org || !repo || !github, "this lab has no organization on the stand-in GitHub");
  test.describe.configure({ mode: "serial" });

  test.afterAll(async () => {
    // The board goes back to owners and admins while it is still shown, then GitHub is disconnected.
    await (await as(org!, "org-admin")).call("PUT", "/api/work/boards/teams", { boards: [{ boardId: BOARD, team: null }] });
    await (await as(org!, "admin")).call("DELETE", "/api/forge/github/connection");
  });

  test("given the orchestrator registered as a GitHub App installed on the organization's account, when its owner connects GitHub and an admin maps the Web repository to the Web team, then the repository is a board with the columns Open and Closed, the open milestone is its only sprint with its three issues, the issue in no milestone is the backlog, the team's owner and a member see that board and not the unmapped one, and every read is made with a token that reads issues and nothing else", async ({ page }) => {
    // given
    const callsBefore = (await appCalls()).length;

    // when the owner connects GitHub: the installation returns to the orchestrator, which takes it as the organization's
    await signInOnPage(page, org!, "admin");
    const { csrf } = (await (await page.request.get(`${org!.url}/api/me`)).json()) as { csrf: string };
    const begun = (await (await page.request.post(`${org!.url}/api/forge/github/connect`, { headers: { "x-csrf-token": csrf }, data: {} })).json()) as { authorizeUrl: string };
    await page.goto(begun.authorizeUrl);
    await page.waitForURL(/forge_connected=github/);

    // and an admin maps the board to the Web team
    const admin = await as(org!, "org-admin");
    const owner = await as(org!, ownerKey("Web"));
    const member = await as(org!, "member");
    await admin.ok("PUT", "/api/work/boards/teams", { boards: [{ boardId: BOARD, team: null }] });
    const { sources } = await admin.ok<{ sources: { id: string; kind: string; via: string; as: string; can: { write: boolean }; writeProblem: string | null; problem: string | null }[] }>("GET", "/api/work/sources");
    const { boards } = await admin.ok<{ boards: { id: string; name: string; type: string; team: string | null }[] }>("GET", `/api/work/boards?source=${SOURCE}`);
    const ownerBefore = await owner.ok<{ boards: { id: string }[] }>("GET", `/api/work/boards?source=${SOURCE}`);
    await admin.ok("PUT", "/api/work/boards/teams", { boards: [{ boardId: BOARD, team: "Web" }] });
    const { columns } = await admin.ok<{ columns: { name: string }[] }>("GET", `/api/work/boards/${encodeURIComponent(BOARD)}/columns`);
    const { sprints } = await admin.ok<{ sprints: { id: string; name: string; state: string }[] }>("GET", `/api/work/sprints?board=${encodeURIComponent(BOARD)}`);
    const sprint = await admin.ok<{ items: Card[] }>("GET", `/api/work/items?sprint=${encodeURIComponent(sprints[0]!.id)}`);
    const backlog = await admin.ok<{ items: Card[] }>("GET", `/api/work/items?backlog=${encodeURIComponent(BOARD)}`);
    const ownerAfter = await owner.ok<{ boards: { id: string }[] }>("GET", `/api/work/boards?source=${SOURCE}`);
    const memberBoards = await member.ok<{ boards: unknown[] }>("GET", `/api/work/boards?source=${SOURCE}`);
    const calls = (await appCalls()).slice(callsBefore);

    // then
    expect(sources.find((s) => s.id === SOURCE)).toMatchObject({ kind: "github", via: "app", as: "organization", can: { write: false }, writeProblem: "The orchestrator does not move GitHub issues yet", problem: null });
    expect(boards.map((b) => [b.id, b.type]).sort()).toEqual([[`${SOURCE}~initech/support-skills`, "repository"], [BOARD, "repository"]]);
    expect(ownerBefore.boards).toEqual([]);
    expect(columns.map((c) => c.name)).toEqual(["Open", "Closed"]);
    expect(sprints.map((s) => s.name)).toEqual(["Web, November"]);
    expect(sprint.items.map((i) => [i.key, i.column]).sort()).toEqual([["initech/web-skills#101", "Open"], ["initech/web-skills#102", "Open"], ["initech/web-skills#103", "Open"]]);
    expect(backlog.items.map((i) => i.key)).toEqual(["initech/web-skills#105"]);
    expect(ownerAfter.boards.map((b) => b.id)).toEqual([BOARD]);
    expect((memberBoards.boards as { id: string }[]).map((b) => b.id)).toEqual([BOARD]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => JSON.stringify(c.permissions) !== JSON.stringify(READS_ISSUES))).toEqual([]);
  });

  // Fails while the orchestrator refuses an issue link that is not https, the connected GitHub's own address included.
  test.fail("given November's milestone on the Web board, when the Web team's owner picks two of its issues and starts an agent for each together, then both start, each task carries its issue, and each card links its task", async () => {
    test.setTimeout(300_000);
    // given
    const owner = await as(org!, ownerKey("Web"));
    const { sprints } = await owner.ok<{ sprints: { id: string }[] }>("GET", `/api/work/sprints?board=${encodeURIComponent(BOARD)}`);
    const read = async () => (await owner.ok<{ items: Card[] }>("GET", `/api/work/items?sprint=${encodeURIComponent(sprints[0]!.id)}&fresh=1`)).items;
    const picked = (await read()).filter((i) => i.key.endsWith("#101") || i.key.endsWith("#102"));

    // when
    const batch = await owner.ok<{ started: { id: string; issueUrl: string | null }[]; refused: { index: number; error: string }[] }>("POST", "/api/tasks/batch", {
      agent: "fake",
      items: picked.map((i) => ({ issueUrl: i.url, repoId: repo!.id })),
    });
    let cards = await read();
    for (let i = 0; i < 480 && batch.started.length && !picked.every((p) => cards.find((c) => c.key === p.key)?.tasks[0]?.status === "needs-review"); i++) {
      await new Promise((r) => setTimeout(r, 500));
      cards = await read();
    }
    try {
      // then
      expect(batch.refused).toEqual([]);
      expect(batch.started.map((t) => t.issueUrl).sort()).toEqual(picked.map((i) => i.url).sort());
      for (const p of picked) expect(cards.find((c) => c.key === p.key)?.tasks.map((t) => t.status)).toEqual(["needs-review"]);
    } finally {
      for (const card of cards) for (const r of card.tasks[0]?.requests ?? []) await close(org!, repo!, r.number);
    }
  });
});
