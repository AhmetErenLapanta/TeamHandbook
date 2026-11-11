import { expect, test } from "@playwright/test";
import { ownerKey, userOf } from "../state.js";
import { as, close, lab } from "./support.js";

const org = lab.orgs.find((o) => o.name === "globex");
const repo = org?.repos.find((r) => r.id === "data-skills");
const gitlab = lab.forges.find((f) => f.kind === "gitlab");
const PROJECT = "globex/data-skills";

interface Card {
  key: string;
  url: string;
  column: string | null;
  assignee: { name: string; you?: boolean } | null;
  priority: string | null;
  storyPoints: number | null;
  blocked?: boolean;
  tasks: { taskId: string; status: string; requests: { repoId: string; number: number }[] }[];
}

/** A person's id, which the lab keeps by email alone. */
async function idOf(email: string): Promise<string> {
  const { users } = await (await as(org!, "org-admin")).ok<{ users: { id: string; email: string }[] }>("GET", "/api/users");
  return users.find((u) => u.email === email)!.id;
}

/**
 * The Data team's issues on the stand-in GitLab, read with the organization's tracker token as a
 * free GitLab answers them: a project is a board, its board lists the columns between Open and
 * Closed, an active milestone the sprint, the issues in no milestone the backlog, and no
 * iterations.
 */
test.describe("a team's GitLab issues worked by agents", () => {
  test.skip(!org || !repo || !gitlab, "this lab has no organization on the stand-in GitLab");
  test.describe.configure({ mode: "serial" });
  let board = "";

  test.afterAll(async () => {
    const admin = await as(org!, "org-admin");
    if (board) await admin.call("PUT", "/api/work/boards/teams", { boards: [{ boardId: board, team: null }] });
    await admin.call("PATCH", `/api/users/${await idOf(userOf(org!, ownerKey("Data")).email)}`, { forgeLogin: null });
    await admin.call("DELETE", "/api/integrations/tracker");
  });

  test("given the Data project on the stand-in GitLab with a November milestone, when an admin connects GitLab as the tracker, maps the project to the Data team and names the team's owner by their GitLab login, then the project is a board with the columns Open, Doing, Review and Closed, November is its only sprint with its three issues in their lists, the issue in no milestone is the backlog and blocked, and the owner's own issue reads as theirs", async () => {
    // given
    const admin = await as(org!, "org-admin");
    const owner = await as(org!, ownerKey("Data"));

    // when
    await admin.ok("PUT", "/api/integrations/tracker", { kind: "gitlab", url: gitlab!.url, token: gitlab!.token });
    await admin.ok("PATCH", `/api/users/${await idOf(userOf(org!, ownerKey("Data")).email)}`, { forgeLogin: "hana" });
    const { sources } = await admin.ok<{ sources: { id: string; kind: string; via: string; can: { write: boolean }; problem: string | null }[] }>("GET", "/api/work/sources");
    const { boards } = await admin.ok<{ boards: { id: string; name: string; type: string }[] }>("GET", "/api/work/boards?source=tracker");
    board = boards.find((b) => b.name === PROJECT)?.id ?? "";
    await admin.ok("PUT", "/api/work/boards/teams", { boards: [{ boardId: board, team: "Data" }] });
    const { columns } = await owner.ok<{ columns: { name: string }[] }>("GET", `/api/work/boards/${encodeURIComponent(board)}/columns`);
    const { sprints } = await owner.ok<{ sprints: { id: string; name: string; state: string }[] }>("GET", `/api/work/sprints?board=${encodeURIComponent(board)}`);
    const sprint = await owner.ok<{ items: Card[] }>("GET", `/api/work/items?sprint=${encodeURIComponent(sprints[0]!.id)}`);
    const backlog = await owner.ok<{ items: Card[] }>("GET", `/api/work/items?backlog=${encodeURIComponent(board)}`);

    // then
    expect(sources.find((s) => s.id === "tracker")).toMatchObject({ kind: "gitlab", via: "token", can: { write: false }, problem: null });
    // The token is the lab's one GitLab token, so every organization's projects are listed with this one.
    expect(boards.find((b) => b.name === PROJECT)).toMatchObject({ type: "project" });
    expect(columns.map((c) => c.name)).toEqual(["Open", "Doing", "Review", "Closed"]);
    expect(sprints.map((s) => [s.name, s.state])).toEqual([["Data, November", "active"]]);
    expect(sprint.items.map((i) => [i.key, i.column, i.storyPoints]).sort()).toEqual([
      [`${PROJECT}#101`, "Doing", 3],
      [`${PROJECT}#102`, "Review", 2],
      [`${PROJECT}#103`, "Open", 1],
    ]);
    const byKey = new Map(sprint.items.map((i) => [i.key, i]));
    expect(byKey.get(`${PROJECT}#101`)!.assignee).toEqual({ name: "Hana Data", you: true });
    expect(byKey.get(`${PROJECT}#102`)!.priority).toBe("high");
    expect(backlog.items.map((i) => [i.key, i.blocked])).toEqual([[`${PROJECT}#105`, true]]);
  });

  test("given November's sprint on the Data board, when the Data team's owner starts an agent for two of its issues together, then both start with their GitLab links, and each card links its task until the request is in review", async () => {
    test.setTimeout(300_000);
    // given
    const owner = await as(org!, ownerKey("Data"));
    const { sprints } = await owner.ok<{ sprints: { id: string }[] }>("GET", `/api/work/sprints?board=${encodeURIComponent(board)}`);
    const read = async () => (await owner.ok<{ items: Card[] }>("GET", `/api/work/items?sprint=${encodeURIComponent(sprints[0]!.id)}&fresh=1`)).items;
    const picked = (await read()).filter((i) => i.key.endsWith("#101") || i.key.endsWith("#103"));

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
