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

export type Fault = "none" | "expired-token" | "no-access" | "rate-limited" | "unreachable" | "issue-gone";

export async function jiraSite(options: { secondBoard?: boolean } = {}): Promise<{ server: Server; url: string; fault: { now: Fault } }> {
  const fault = { now: "none" as Fault };
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
  if (options.secondBoard) {
    const board = (answers[0]![1] as { values: Record<string, unknown>[] }).values;
    board.push({ id: 22, name: "Platform board", type: "scrum", location: { projectKey: "PLT" } });
    const copies = answers.filter(([prefix]) => prefix.includes("/board/21/")).map(([prefix, body]): [string, unknown] => [
      prefix.replace("/board/21/", "/board/22/").replace("/sprint/41/", "/sprint/42/"),
      JSON.parse(JSON.stringify(body).replaceAll("Payments Sprint 41", "Platform Sprint 12").replaceAll('"id":41', '"id":42').replaceAll("PAY-30", "PLT-40")),
    ]);
    answers.push(...copies);
  }
  const server = createServer((req, res) => {
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (fault.now === "unreachable") return void req.socket.destroy();
    if (fault.now === "expired-token" || req.headers.authorization !== `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`) return json(401, {});
    if (fault.now === "rate-limited") return void res.writeHead(429, { "content-type": "application/json", "retry-after": "30" }).end("{}");
    if (fault.now === "no-access" && /\/board\/\d+\/(sprint\/\d+\/issue|backlog)/.test(req.url!)) return json(403, { errorMessages: ["no access"] });
    const single = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)/.exec(req.url!)?.[1];
    if (single) {
      const known = [...SPRINT_ISSUES, issue("PAY-310", "Hide a card number in the log", "Ready for Dev"), ...SPRINT_ISSUES.map((i) => issue(i.key.replace("PAY-30", "PLT-40"), i.fields.summary, i.fields.status.name))].find((i) => i.key === single);
      return known && !(fault.now === "issue-gone" && single === "PAY-301") ? json(200, { id: known.key.replace(/\D/g, ""), ...known }) : json(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
    }
    const hit = answers.find(([prefix]) => req.url!.startsWith(prefix));
    if (hit && fault.now === "issue-gone") return json(200, JSON.parse(JSON.stringify(hit[1]).replace(/\{"key":"PAY-301".*?"customfield_10016":\d+\}\},?/, "")));
    return hit ? json(200, hit[1]) : json(404, { errorMessages: ["not found"] });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, fault };
}

/** Points the organization's tracker at the site, and gives back how to disconnect it again. */
export async function connectJira(page: Page, url: string): Promise<() => Promise<void>> {
  const headers = { "x-csrf-token": (await (await page.request.get("/api/me")).json()).csrf };
  const saved = await page.request.put("/api/integrations/tracker", { headers, data: { kind: "jira", url, email: EMAIL, token: TOKEN } });
  if (!saved.ok()) throw new Error(`the tracker was not saved: ${await saved.text()}`);
  return async () => void (await page.request.delete("/api/integrations/tracker", { headers }));
}
