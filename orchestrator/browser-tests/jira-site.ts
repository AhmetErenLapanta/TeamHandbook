import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";

// A Jira site on this machine for the Work screen's whole path: the orchestrator's tracker setting
// points at it, and the board is read through the orchestrator's own /api/work. Nothing leaves the
// machine; the site answers the Agile and REST paths the orchestrator asks, and nothing else.

export const EMAIL = "bot@example.invalid";
export const TOKEN = "stand-in-jira-token-0001";

const WORKFLOW = ["Ready for Dev", "In Dev", "Code Review", "Ready for Test", "In Test", "Test Passed", "Done"];

const issue = (key: string, summary: string, status: string) => ({
  key,
  fields: {
    summary,
    status: { name: status, statusCategory: { key: status === "Done" ? "done" : status === "Ready for Dev" ? "new" : "indeterminate" } },
    assignee: { displayName: "Lin" },
    labels: [],
    issuetype: { name: "Story" },
    issuelinks: [],
    customfield_10016: 2,
  },
});

export const SPRINT_ISSUES = [
  issue("PAY-301", "Round refunds half to even", "Ready for Dev"),
  issue("PAY-302", "Export statements as CSV", "In Dev"),
  issue("PAY-303", "Name the payee on the receipt", "Test Passed"),
];

export async function jiraSite(): Promise<{ server: Server; url: string }> {
  const answers: [string, unknown][] = [
    ["/rest/agile/1.0/board?", { values: [{ id: 21, name: "Payments board", type: "scrum", location: { projectKey: "PAY" } }], isLast: true }],
    ["/rest/agile/1.0/board/21/sprint?", { values: [{ id: 41, name: "Payments Sprint 41", state: "active", startDate: "2026-11-02T09:00:00.000Z", endDate: "2026-11-13T17:00:00.000Z", goal: "Refunds" }], isLast: true }],
    ["/rest/agile/1.0/board/21/configuration", { columnConfig: { columns: WORKFLOW.map((name, i) => ({ name, statuses: [{ id: String(i + 1) }] })) }, estimation: { field: { fieldId: "customfield_10016" } } }],
    ["/rest/api/3/status", WORKFLOW.map((name, i) => ({ id: String(i + 1), name }))],
    ["/rest/api/3/field", [{ id: "customfield_10016", name: "Story point estimate" }]],
    ["/rest/agile/1.0/board/21/sprint/41/issue?", { issues: SPRINT_ISSUES, total: SPRINT_ISSUES.length }],
    ["/rest/agile/1.0/board/21/backlog?", { issues: [issue("PAY-310", "Hide a card number in the log", "Ready for Dev")], total: 1 }],
    ["/rest/api/3/mypermissions?permissions=TRANSITION_ISSUES", { permissions: { TRANSITION_ISSUES: { havePermission: false } } }],
  ];
  const server = createServer((req, res) => {
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.headers.authorization !== `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`) return json(401, {});
    const hit = answers.find(([prefix]) => req.url!.startsWith(prefix));
    return hit ? json(200, hit[1]) : json(404, { errorMessages: ["not found"] });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Points the organization's tracker at the site, and gives back how to disconnect it again. */
export async function connectJira(page: Page, url: string): Promise<() => Promise<void>> {
  const headers = { "x-csrf-token": (await (await page.request.get("/api/me")).json()).csrf };
  const saved = await page.request.put("/api/integrations/tracker", { headers, data: { kind: "jira", url, email: EMAIL, token: TOKEN } });
  if (!saved.ok()) throw new Error(`the tracker was not saved: ${await saved.text()}`);
  return async () => void (await page.request.delete("/api/integrations/tracker", { headers }));
}
