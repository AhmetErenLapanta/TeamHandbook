import type { Page } from "@playwright/test";
import type { WorkItem, WorkItems, WorkMoves, WorkSource } from "../shared/work.js";

// Stand-in answers for /api/work/*, shaped as the contract sets them, so the board is tested
// without a tracker on the network. The columns are a real team's workflow, not the orchestrator's.
export const COLUMNS = [
  { name: "Ready for Dev", statuses: ["Ready for Dev"] },
  { name: "In Dev", statuses: ["In Dev"] },
  { name: "Code Review", statuses: ["Code Review"] },
  { name: "Ready for Test", statuses: ["Ready for Test"] },
  { name: "In Test", statuses: ["In Test"] },
  { name: "Test Passed", statuses: ["Test Passed"] },
  { name: "Done", statuses: ["Done"] },
];

export const JIRA: WorkSource = {
  id: "tracker",
  kind: "jira",
  name: "Jira (acme.atlassian.example)",
  url: "https://acme.atlassian.example",
  via: "token",
  as: "organization",
  can: { boards: true, sprints: true, backlog: true, storyPoints: true, write: true },
  problem: null,
  writeProblem: null,
};

const item = (key: string, summary: string, status: string, category: WorkItem["status"]["category"], extra: Partial<WorkItem> = {}): WorkItem => ({
  key,
  url: `https://acme.atlassian.example/browse/${key}`,
  summary,
  type: "Story",
  status: { name: status, category },
  column: COLUMNS.find((c) => c.statuses.includes(status))?.name ?? null,
  assignee: { name: "Pat Payments" },
  priority: null,
  epic: null,
  labels: [],
  storyPoints: 3,
  tasks: [],
  ...extra,
});

export function sprintItems(): WorkItems {
  return {
    columns: COLUMNS,
    items: [
      item("PAY-101", "Round refunds half to even", "Ready for Dev", "todo", { assignee: { name: "Ada Admin" } }),
      item("PAY-102", "Show the fee before a transfer", "Ready for Dev", "todo", { assignee: null }),
      item("PAY-103", "Retry a failed card capture", "In Dev", "doing", {
        tasks: [{ taskId: "tsk_working", status: "running", phase: "working", targets: [], requests: [], startedBy: "ada@example.invalid", costUsd: 0.4 }],
      }),
      item("PAY-104", "Export statements as CSV", "Code Review", "doing", {
        tasks: [{ taskId: "tsk_review", status: "needs-review", phase: "review", targets: [], requests: [{ repoId: "payments-api", number: 42, status: "open", url: "https://forge.example/acme/payments-api/merge_requests/42", name: "Merge request !42 on GitLab" }], startedBy: "pat@example.invalid", costUsd: 1.25 }],
      }),
      item("PAY-105", "Block a card from the app", "In Test", "doing", { blocked: true }),
      item("PAY-106", "Daily limit per merchant", "Done", "done"),
      item("PAY-107", "Name the payee on the receipt", "Done", "done", {
        tasks: [{ taskId: "tsk_merged", status: "needs-review", phase: "merged", targets: [], requests: [{ repoId: "payments-api", number: 40, status: "merged", url: null, name: "payments-api #40" }], startedBy: "ada@example.invalid", costUsd: null }],
      }),
      item("PAY-108", "Hide a card number in the log", "Archived", "done"),
    ],
    fetchedAt: "2026-11-02T09:00:00Z",
    stale: false,
    truncated: false,
    progress: { todo: 2, doing: 3, done: 3, points: { total: 24, done: 9 } },
  };
}

export interface WorkStandIn {
  sources?: WorkSource[];
  cloud?: boolean;
  items?: () => WorkItems;
  backlog?: () => WorkItems;
  moves?: WorkMoves;
  boards?: { id: string; name: string; type: "scrum"; project: string; url: string; team: string | null }[];
}

/** Answers the work reads from the stand-ins, and in the cloud reports the cloud mode on /api/me. */
export async function standInWork(page: Page, stand: WorkStandIn = {}): Promise<{ saved: unknown[] }> {
  const sources = stand.sources ?? [JIRA];
  if (stand.cloud) {
    await page.route("**/api/me", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "cloud" } } });
    });
  }
  await page.route("**/api/work/sources", (route) => route.fulfill({ json: { sources } }));
  await page.route("**/api/work/boards?*", (route) =>
    route.fulfill({ json: { boards: stand.boards ?? [{ id: "board:7", name: "Payments board", type: "scrum", project: "PAY", url: "https://acme.atlassian.example/board/7", team: "Payments" }], fetchedAt: "2026-11-02T09:00:00Z", stale: false } }),
  );
  await page.route("**/api/work/sprints?*", (route) =>
    route.fulfill({
      json: {
        sprints: [
          { id: "sprint:31", name: "Payments Sprint 31", state: "active", startsAt: "2026-10-27T09:00:00Z", endsAt: "2026-11-07T17:00:00Z", goal: "Refunds and statements" },
          { id: "sprint:32", name: "Payments Sprint 32", state: "future", startsAt: null, endsAt: null, goal: null },
        ],
        fetchedAt: "2026-11-02T09:00:00Z",
        stale: false,
      },
    }),
  );
  await page.route("**/api/work/items?*", (route) => {
    const url = new URL(route.request().url());
    const read = url.searchParams.has("backlog") ? (stand.backlog ?? (() => ({ ...sprintItems(), items: [], progress: { todo: 0, doing: 0, done: 0, points: null } })))() : (stand.items ?? sprintItems)();
    return route.fulfill({ json: read });
  });
  const saved: unknown[] = [];
  let moves = stand.moves;
  if (moves) {
    await page.route("**/api/work/moves?*", async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        saved.push(body);
        moves = { ...moves!, ...body, guessed: false };
      }
      await route.fulfill({ json: moves });
    });
  }
  return { saved };
}

/** A board whose moves nobody set: the server's guess from the stand-in columns, off. */
export const GUESSED_MOVES: WorkMoves = {
  enabled: false,
  guessed: true,
  canChange: true,
  write: { allowed: true, reason: null, off: false },
  moves: { started: "In Dev", requestOpened: "Code Review", merged: "Done" },
};

const CODE = [
  { id: "payments-api", name: "payments-api", team: "Payments" },
  { id: "payments-bff", name: "payments-bff", team: "Payments" },
];

/**
 * Task options with the team's code repositories, and a batch start that answers as the orchestrator
 * does without running anything: the issues at `refuse` refused with a reason, the rest started.
 */
export async function standInStart(page: Page, { refuse = [] as number[], multiRepo = true } = {}): Promise<{ sent: () => Record<string, unknown> | null; asked: () => Record<string, unknown>[] }> {
  let body: Record<string, unknown> | null = null;
  const asked: Record<string, unknown>[] = [];
  // Every issue gets the same answer: one skill suggested with its reason, two on offer.
  await page.route("**/api/tasks/skill-suggestions", async (route) => {
    const ask = route.request().postDataJSON();
    asked.push(ask);
    await route.fulfill({
      json: {
        results: (ask.items as unknown[]).map((_, index) => ({
          index,
          suggestions: [{ skill: "add-endpoint", reason: "the issue adds a route to the payments API" }],
          skills: [{ name: "add-endpoint", description: "Add an endpoint" }, { name: "write-migration", description: "Write a migration" }],
        })),
      },
    });
  });
  await page.route("**/api/tasks/options", async (route) => {
    const real = await route.fetch().then((r) => r.json());
    const code = (multiRepo ? CODE : CODE.slice(0, 1)).map((c) => ({ ...c, kind: "code", ticketExample: null }));
    await route.fulfill({ json: { ...real, repos: [...code, ...real.repos], multiRepo: multiRepo ? { candidates: CODE, maxTargets: 5 } : null } });
  });
  await page.route("**/api/tasks/batch", async (route) => {
    body = route.request().postDataJSON();
    const items = (body!.items as unknown[]).map((_, index) => index);
    await route.fulfill({
      json: {
        started: items.filter((i) => !refuse.includes(i)).map((i) => ({ id: `tsk_started_${i}` })),
        refused: refuse.map((index) => ({ index, error: "this month's task budget for Payments is spent" })),
      },
    });
  });
  return { sent: () => body, asked: () => asked };
}
