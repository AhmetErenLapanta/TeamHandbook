import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { saveEnabled } from "../integrations/records.js";
import { TRACKER, TRACKER_TOKEN_SECRET } from "../integrations/tracker.js";
import { openSqliteStore } from "../store.js";
import { createVault, storeSecret } from "../vault.js";
import { WorkCache } from "./cache.js";
import { workRoutes } from "./routes.js";
import { saveWrites } from "./writes.js";

// An orchestrator with the organization's Jira connected to a stand-in site on no network, for the
// work tests: the site answers by path and keeps every path it was asked.

export const ADA: Principal = { id: "u-ada", name: "Ada Admin", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
export const PAT: Principal = { id: "u-pat", name: "Pat Owner", email: "pat@example.invalid", role: "member", ownedTeams: ["Payments"] };
export const SAM: Principal = { id: "u-sam", name: "Sam Member", email: "sam@example.invalid", role: "member", ownedTeams: [] };
export const SITE = "https://acme.atlassian.example";
export const TOKEN = "ATATT3xFfGF0-stand-in-token-0001";


export const ISSUES = [
  {
    key: "PAY-142",
    fields: {
      summary: "Round refunds half to even",
      status: { name: "In Dev", statusCategory: { key: "indeterminate" } },
      assignee: { displayName: "Pat Owner", emailAddress: "pat@example.invalid" },
      priority: { name: "High" },
      labels: ["refunds"],
      issuetype: { name: "Story" },
      parent: { key: "PAY-100", fields: { summary: "Refund accuracy", issuetype: { name: "Epic", hierarchyLevel: 1 } } },
      issuelinks: [],
      customfield_10016: 3,
      customfield_10021: [{ value: "Impediment" }],
    },
  },
  {
    key: "PAY-143",
    fields: {
      summary: `use ${TOKEN} for the export`,
      status: { name: "Done", statusCategory: { key: "done" } },
      assignee: null,
      priority: null,
      labels: [],
      issuetype: { name: "Bug" },
      issuelinks: [{ type: { inward: "is blocked by" }, inwardIssue: { key: "PAY-9", fields: { status: { statusCategory: { key: "new" } } } } }],
      customfield_10016: 5,
    },
  },
  {
    key: "PAY-144",
    fields: { summary: "Ledger export", status: { name: "Triage", statusCategory: { key: "new" } }, labels: [], issuetype: { name: "Task" }, parent: { key: "PAY-143", fields: { summary: "not an epic", issuetype: { name: "Bug" } } } },
  },
];

/** Every move the site's workflow offers, from any status. */
const WORKFLOW = [
  { id: "11", to: { name: "Ready for Dev", statusCategory: { key: "new" } } },
  { id: "21", to: { name: "In Dev", statusCategory: { key: "indeterminate" } } },
  { id: "31", to: { name: "Code Review", statusCategory: { key: "indeterminate" } } },
  { id: "41", to: { name: "Done", statusCategory: { key: "done" } } },
];

/** A Jira site on no network: answers by path, and keeps every path it was asked. */
function jira(can: { transition: boolean }) {
  const asked: string[] = [];
  const moved: string[] = [];
  // Every call that is not a read, whatever its path: what a test counts to prove Jira is left as it is.
  const writes: string[] = [];
  const statuses: Record<string, string> = {};
  // A teammate changing an issue in Jira: its status and labels as the sprint's list reads them, over ISSUES.
  const labels: Record<string, string[]> = {};
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const answers: [string, unknown, number?][] = [
    ["/rest/agile/1.0/board?", { values: [{ id: 12, name: "Payments board", type: "scrum", location: { projectKey: "PAY" } }, { id: 13, name: "People ops", type: "kanban", location: { projectKey: "HR" } }], isLast: true }],
    ["/rest/agile/1.0/board/12/sprint?", { values: [{ id: 34, name: "Sprint 34", state: "active", startDate: "2026-11-01T00:00:00.000Z", endDate: "2026-11-14T00:00:00.000Z", goal: "Refunds" }, { id: 35, name: "Sprint 35", state: "future" }] }],
    ["/rest/agile/1.0/board/13/sprint?", { errorMessages: ["The board does not support sprints"] }, 400],
    ["/rest/agile/1.0/board/12/configuration", { columnConfig: { columns: [{ name: "Ready for Dev", statuses: [{ id: "1" }] }, { name: "In Dev", statuses: [{ id: "2" }] }, { name: "Code Review", statuses: [{ id: "3" }] }, { name: "Done", statuses: [{ id: "4" }] }] }, estimation: { field: { fieldId: "customfield_10016" } } }],
    ["/rest/api/3/status", [{ id: "1", name: "Ready for Dev" }, { id: "2", name: "In Dev" }, { id: "3", name: "Code Review" }, { id: "4", name: "Done" }]],
    ["/rest/api/3/field", [{ id: "customfield_10021", name: "Flagged" }, { id: "customfield_10016", name: "Story point estimate" }]],
    ["/rest/agile/1.0/board/12/backlog?", { issues: [], total: 0 }],
  ];
  const send = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    asked.push(path);
    if ((init?.method ?? "GET") !== "GET") writes.push(`${init!.method} ${path}`);
    if (new Headers(init?.headers).get("authorization") !== `Basic ${Buffer.from(`bot@example.invalid:${TOKEN}`).toString("base64")}`) return new Response("{}", { status: 401 });
    if (path === "/rest/api/3/mypermissions?permissions=TRANSITION_ISSUES") return json({ permissions: { TRANSITION_ISSUES: { havePermission: can.transition } } });
    const moving = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/transitions)?/.exec(url.pathname);
    if (moving) {
      const key = moving[1]!;
      if (!moving[2]) return json({ fields: { status: { name: statuses[key] ?? "Ready for Dev" } } });
      if (init?.method === "POST") {
        const id = (JSON.parse(String(init.body)) as { transition: { id: string } }).transition.id;
        moved.push(`${key} ${id}`);
        statuses[key] = WORKFLOW.find((t) => t.id === id)!.to.name;
        return new Response(null, { status: 204 });
      }
      return json({ transitions: WORKFLOW });
    }
    if (path.startsWith("/rest/agile/1.0/board/12/sprint/34/issue?")) {
      const issues = ISSUES.map((i) => ({ ...i, fields: { ...i.fields, ...(statuses[i.key] ? { status: { name: statuses[i.key], statusCategory: { key: "indeterminate" } } } : {}), ...(labels[i.key] ? { labels: labels[i.key] } : {}) } }));
      return json({ issues, total: issues.length });
    }
    const hit = answers.find(([prefix]) => path.startsWith(prefix));
    return new Response(JSON.stringify(hit?.[1] ?? {}), { status: hit ? (hit[2] ?? 200) : 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { asked, send, moved, statuses, labels, writes };
}

/** `writes` lets the orchestrator change issues, as an owner does under Integrations; off is the orchestrator's default. */
export async function jiraOrchestrator(can = { transition: true }, writes = true) {
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: "unused", tenant: "acme", vault: createVault(randomBytes(32)) };
  const events: string[] = [];
  ctx.audit = async (actor, kind, fields) => void events.push(`${actor.email} ${kind} ${fields.detail}`);
  await saveEnabled(ctx, TRACKER, { kind: "jira", url: SITE, email: "bot@example.invalid" }, ADA);
  await storeSecret(ctx.store, ctx.vault!, ctx.tenant, TRACKER_TOKEN_SECRET, TOKEN, ADA.email);
  if (writes) await saveWrites(ctx, true);
  await ctx.store.upsertRepo({ tenant: "acme", id: "payments-skills", team: "Payments", name: "payments-skills", url: "https://gitlab.example/acme/payments-skills.git" });
  const fake = jira(can);
  const who = { user: ADA };
  const app = new Hono<OrchestratorEnv>();
  app.use(async (c, next) => {
    c.set("user", who.user);
    await next();
  });
  const deps = { cache: new WorkCache(), send: fake.send };
  app.route("/", workRoutes(ctx, deps));
  const call = async (user: Principal, path: string, init?: RequestInit) => {
    who.user = user;
    const res = await app.request(path, init);
    return { status: res.status, body: await res.json() };
  };
  return { ctx, events, call, deps, asked: fake.asked, moved: fake.moved, statuses: fake.statuses, labels: fake.labels, writes: fake.writes };
}

export const put = (body: unknown): RequestInit => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
