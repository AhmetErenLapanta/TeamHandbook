import type { Page } from "@playwright/test";

// A company's lists, answered in the browser: thousands of requests, hundreds of people, a
// repository with thousands of skills. Nothing reaches the orchestrator's own records.

type Status = "open" | "merged" | "closed";

const STATUSES: Status[] = ["open", "merged", "closed"];

/**
 * `count` requests on payments-skills, newest first, answered a page at a time after a cursor
 * as the orchestrator does; a merge from the screen marks the request merged. Returns every list
 * URL asked for.
 */
export async function manyRequests(page: Page, count = 5000, statusOf: (n: number) => Status = (n) => STATUSES[n % 10 === 0 ? 0 : n % 10 < 8 ? 1 : 2]!): Promise<URL[]> {
  const asked: URL[] = [];
  const all = Array.from({ length: count }, (_, i) => {
    const number = count - i;
    return {
      repoId: "payments-skills",
      number,
      url: `local://requests/payments-skills/${number}`,
      branch: `handbook/orchestrator-change-${number}`,
      title: `PAY feat(skill): change ${number}`,
      status: statusOf(number),
      provider: "local",
      createdAt: new Date(Date.UTC(2026, 0, 1) + number * 60_000).toISOString(),
      createdBy: "ada@example.invalid",
    };
  });
  await page.route((url) => url.pathname === "/api/requests", (route) => {
    const url = new URL(route.request().url());
    asked.push(url);
    const status = url.searchParams.get("status");
    // The cursor is the number of the last row a page held; the orchestrator's own is opaque too.
    const after = Number(url.searchParams.get("after") ?? Infinity);
    const matching = status ? all.filter((r) => r.status === status) : all;
    const counts = Object.fromEntries(STATUSES.map((s) => [s, all.filter((r) => r.status === s).length]));
    const rest = matching.filter((r) => r.number < after);
    const requests = rest.slice(0, 50);
    return route.fulfill({ json: { requests, total: matching.length, counts, pageSize: 50, next: rest.length > 50 ? String(requests.at(-1)!.number) : null } });
  });
  await page.route(/\/api\/repos\/payments-skills\/requests\/\d+\/merge$/, (route) => {
    const number = Number(route.request().url().split("/").at(-2));
    const request = all.find((r) => r.number === number)!;
    request.status = "merged";
    return route.fulfill({ json: { request } });
  });
  return asked;
}

/** The orchestrator's own people and 300 more. */
export async function manyPeople(page: Page): Promise<void> {
  await page.route("**/api/users", async (route) => {
    const { users } = await (await route.fetch()).json();
    const more = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, email: `person${i}@example.invalid`, name: `Person ${String(i).padStart(3, "0")}`, role: "member", ownedTeams: [], forgeLogin: null, signIn: ["password"], createdAt: "2026-01-01T00:00:00.000Z" }));
    await route.fulfill({ json: { users: [...users, ...more] } });
  });
}

/** payments-skills as it is, with 2000 skills. */
export async function manySkills(page: Page): Promise<void> {
  await page.route("**/api/repos/payments-skills/inventory", async (route) => {
    const body = await (await route.fetch()).json();
    const skills = Array.from({ length: 2000 }, (_, i) => ({ slug: `skill-${String(i).padStart(4, "0")}`, name: `skill-${i}`, description: `Use when step ${i} comes up.`, files: ["SKILL.md"], format: [] }));
    await route.fulfill({ json: { ...body, inventory: { ...body.inventory, skills } } });
  });
}

/** `count` finished tasks on payments-skills, newest first, answered a page at a time after a cursor as the orchestrator does. Returns every list URL asked for. */
export async function manyTasks(page: Page, count = 120): Promise<URL[]> {
  const asked: URL[] = [];
  const all = Array.from({ length: count }, (_, i) => {
    const n = count - i;
    const createdAt = new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
    return { id: `tsk_${String(n).padStart(8, "0")}`, repoId: "payments-skills", team: "Payments", title: `Task ${n}`, description: "", issueUrl: null, issueKey: null, agent: "fake", status: "cancelled", createdBy: "ada@example.invalid", createdAt, startedAt: createdAt, finishedAt: createdAt, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, request: null };
  });
  await page.route((url) => url.pathname === "/api/tasks", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const url = new URL(route.request().url());
    // The tab's attention watcher reads the person's recent tasks on every page with `since`; only the list's own pages are counted.
    if (!url.searchParams.has("since")) asked.push(url);
    // The cursor is the number of the last task a page held; the orchestrator's own is opaque too.
    const after = Number(url.searchParams.get("after") ?? Infinity);
    const rest = all.filter((t) => Number(t.id.slice(4)) < after);
    const tasks = rest.slice(0, 50);
    return route.fulfill({ json: { tasks, next: rest.length > 50 ? tasks.at(-1)!.id.slice(4) : null } });
  });
  return asked;
}
