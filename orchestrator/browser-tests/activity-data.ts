import type { Page } from "@playwright/test";
import type { EventPage, EventRecord, UsageReport } from "../shared/activity.js";

/** A month of skill use across two teams, answered in place of the orchestrator's own report. */
export async function monthOfUse(page: Page): Promise<UsageReport> {
  const today = Date.parse("2026-10-23T12:00:00Z");
  const series = Array.from({ length: 30 }, (_, i) => ({ day: new Date(today - (29 - i) * 86_400_000).toISOString().slice(0, 10), count: (i * 7) % 11 }));
  const total = series.reduce((n, d) => n + d.count, 0);
  const report: UsageReport = {
    days: 30,
    series,
    total,
    byTeam: [{ team: "Payments", count: total - 40 }, { team: "Platform", count: 40 }],
    bySkill: [
      { repoId: "payments-skills", repo: "payments-skills", team: "Payments", skill: "release-checklist", count: total - 52 },
      { repoId: "platform-skills", repo: "platform-skills", team: "Platform", skill: "rotate-service-certificate", count: 40 },
      { repoId: "payments-skills", repo: "payments-skills", team: "Payments", skill: "add-ledger-migration", count: 12 },
    ],
  };
  await page.route(/\/api\/activity\/usage(\?|$)/, (route) => route.fulfill({ json: report }));
  return report;
}

/** A page of the orchestrator's event log, as its read answers once recording has started. */
export async function someEvents(page: Page): Promise<EventPage> {
  const events: EventPage = {
    retentionDays: 365,
    next: null,
    events: [
      { id: "e2", at: "2026-10-23T10:05:00.000Z", kind: "request.merged", actor: { kind: "user", id: "u1", email: "ada@example.invalid", name: "Ada Admin" }, repoId: "payments-skills", subject: "request:4", detail: "merged #4 on payments-skills" },
      { id: "e1", at: "2026-10-23T09:00:00.000Z", kind: "repo.synced", actor: { kind: "orchestrator", id: null, email: null, name: null }, repoId: "platform-skills", subject: null, detail: "read at start-up", changes: [{ field: "head", from: "1111111", to: "2222222" }, { field: "skills", from: "3", to: "4" }] },
    ],
  };
  await page.route(/\/api\/events(\?|$)/, (route) => route.fulfill({ json: events }));
  return events;
}

/** One event read on its own, as the orchestrator answers an id it knows, and 404 for any other. */
export async function oneEvent(page: Page): Promise<EventRecord> {
  const events = await someEvents(page);
  const record: EventRecord = { event: events.events[1]!, link: "http://127.0.0.1:18181/demo/activity/audit/e1" };
  await page.route(/\/api\/events\/[^/?]+$/, (route) =>
    route.request().url().endsWith("/api/events/e1") ? route.fulfill({ json: record }) : route.fulfill({ status: 404, json: { error: "no such event" } }),
  );
  return record;
}
