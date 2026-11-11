import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";

/**
 * A stand-in Jira Cloud for the lab: an issue, its comments and its subtasks over the REST API
 * (v3 with its document-format description, and v2 with plain text), and Jira Software's boards,
 * sprints and backlog over the Agile API (rest/agile/1.0), with the JQL search a sprint view asks
 * (`sprint = <id>`, `sprint in openSprints()`, `project = <key>`), with the statuses, fields and
 * permissions a board view reads to name its columns, find its Flagged field and learn whether
 * the account moves issues. All behind the email and API
 * token a person enters in the orchestrator. A board's columns are the team's own workflow, each mapped
 * to its statuses, as a board's configuration gives them. The one write it takes is moving an issue
 * through its workflow (`/rest/api/3/issue/<key>/transitions`), and only with the write token: the
 * token a person enters by default reads, and its transition is refused as Jira refuses an account
 * without the permission. Every transition made is kept for a test at `/lab/transitions`; every
 * other write is refused and recorded, so a test can tell nothing else was ever written back. A
 * teammate moving a card on the board is the lab's own `POST /lab/move`, and linking one issue as
 * blocked by others is `POST /lab/link`, both outside the Jira API.
 * No real Jira is reached.
 */

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  status: string;
  subtasks: { key: string; summary: string; status: string }[];
  comments: { author: string; body: string; created: string }[];
  /** Story, Task or Bug; a Story when left out. */
  type?: string;
  assignee?: string | null;
  storyPoints?: number | null;
  priority?: string;
  labels?: string[];
  /** Flagged on the board, as a team marks an issue that is held up. */
  flagged?: boolean;
  /** The issues that block this one, as Jira's "is blocked by" links name them. */
  blockedBy?: string[];
}

/** A scrum board over one project: its columns, its sprints and what waits in its backlog. */
export interface JiraBoard {
  id: number;
  name: string;
  projectKey: string;
  projectName: string;
  columns: { name: string; statuses: string[] }[];
  sprints: { id: number; name: string; state: "active" | "future" | "closed"; goal: string; startDate: string | null; endDate: string | null; issues: string[] }[];
  backlog: string[];
}

export interface JiraConfig {
  port: number;
  email: string;
  /** Reads only: the token a person enters when the orchestrator is not let write to Jira. */
  token: string;
  /** Reads and moves issues through their workflow: the account given the permission to transition. */
  writeToken?: string;
  issues: JiraIssue[];
  boards?: JiraBoard[];
  log: string;
}

/** Atlassian's document format for plain paragraphs, the shape API v3 gives a description in. */
function adf(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n\n").map((paragraph) => ({ type: "paragraph", content: [{ type: "text", text: paragraph }] })),
  };
}

/** Jira's own status ids and categories for the statuses a lab board uses. */
const STATUSES: Record<string, { id: string; category: "new" | "indeterminate" | "done"; categoryName: string }> = {
  "To Do": { id: "10000", category: "new", categoryName: "To Do" },
  "Selected for Development": { id: "10001", category: "new", categoryName: "To Do" },
  "In Progress": { id: "3", category: "indeterminate", categoryName: "In Progress" },
  "In Review": { id: "10002", category: "indeterminate", categoryName: "In Progress" },
  Done: { id: "10003", category: "done", categoryName: "Done" },
  // A team's own workflow, the kind a delivery team keeps on its board.
  "Ready for Dev": { id: "10010", category: "new", categoryName: "To Do" },
  "In Dev": { id: "10011", category: "indeterminate", categoryName: "In Progress" },
  "Code Review": { id: "10012", category: "indeterminate", categoryName: "In Progress" },
  "Ready for Test": { id: "10013", category: "indeterminate", categoryName: "In Progress" },
  "In Test": { id: "10014", category: "indeterminate", categoryName: "In Progress" },
  "Test Passed": { id: "10015", category: "indeterminate", categoryName: "In Progress" },
};

export interface JiraTransition {
  at: string;
  key: string;
  from: string;
  to: string;
}

/** Jira Cloud's usual custom fields for a sprint, story points and the Flagged mark; a site finds each by its name. */
const SPRINT_FIELD = "customfield_10020";
const POINTS_FIELD = "customfield_10016";
const FLAGGED_FIELD = "customfield_10021";
const FIELDS = [
  { id: "summary", name: "Summary", custom: false },
  { id: "status", name: "Status", custom: false },
  { id: SPRINT_FIELD, name: "Sprint", custom: true },
  { id: POINTS_FIELD, name: "Story point estimate", custom: true },
  { id: FLAGGED_FIELD, name: "Flagged", custom: true },
];

export function startJira(config: JiraConfig): Promise<void> {
  const base = `http://127.0.0.1:${config.port}`;
  const basic = (token: string) => `Basic ${Buffer.from(`${config.email}:${token}`).toString("base64")}`;
  const reads = new Set([basic(config.token), ...(config.writeToken ? [basic(config.writeToken)] : [])]);
  const writes = config.writeToken ? basic(config.writeToken) : null;
  const boards = config.boards ?? [];
  const transitions: JiraTransition[] = [];
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const notFound = (res: ServerResponse, what = "Not found.") => json(res, 404, { errorMessages: [what] });

  const statusOf = (name: string) => {
    const known = STATUSES[name] ?? { id: "1", category: "new" as const, categoryName: "To Do" };
    return { id: known.id, name, statusCategory: { key: known.category, name: known.categoryName } };
  };
  const sprintView = (board: JiraBoard, sprint: JiraBoard["sprints"][number]) => ({
    id: sprint.id,
    self: `${base}/rest/agile/1.0/sprint/${sprint.id}`,
    state: sprint.state,
    name: sprint.name,
    goal: sprint.goal,
    ...(sprint.startDate ? { startDate: sprint.startDate } : {}),
    ...(sprint.endDate ? { endDate: sprint.endDate } : {}),
    originBoardId: board.id,
  });
  const boardView = (board: JiraBoard) => ({ id: board.id, self: `${base}/rest/agile/1.0/board/${board.id}`, name: board.name, type: "scrum", location: { projectKey: board.projectKey, projectName: board.projectName, displayName: `${board.projectName} (${board.projectKey})` } });
  const sprintsOf = (key: string) => boards.flatMap((b) => b.sprints.filter((s) => s.issues.includes(key)).map((s) => sprintView(b, s)));

  const issueView = (issue: JiraIssue, version: string) => {
    const body = (text: string) => (version === "3" ? adf(text) : text);
    const commentList = issue.comments.map((c, i) => ({ id: String(10_000 + i), author: { displayName: c.author }, body: body(c.body), created: c.created }));
    return {
      id: String(10_000 + config.issues.indexOf(issue)),
      key: issue.key,
      self: `${base}/rest/api/${version}/issue/${issue.key}`,
      fields: {
        summary: issue.summary,
        description: body(issue.description),
        status: statusOf(issue.status),
        issuetype: { name: issue.type ?? "Story", subtask: false },
        priority: { name: issue.priority ?? "Medium" },
        assignee: issue.assignee ? { displayName: issue.assignee, accountId: `lab-${issue.assignee.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` } : null,
        labels: issue.labels ?? [],
        project: { key: issue.key.split("-")[0] },
        subtasks: issue.subtasks.map((s) => ({ key: s.key, fields: { summary: s.summary, status: statusOf(s.status) } })),
        comment: { startAt: 0, maxResults: commentList.length, total: commentList.length, comments: commentList },
        [SPRINT_FIELD]: sprintsOf(issue.key).map(({ id, name, state, goal, originBoardId }) => ({ id, name, state, goal, boardId: originBoardId })),
        [POINTS_FIELD]: issue.storyPoints ?? null,
        [FLAGGED_FIELD]: issue.flagged ? [{ id: "10019", value: "Impediment" }] : null,
        issuelinks: (issue.blockedBy ?? []).flatMap((key) => {
          const by = findIssue(key);
          return by ? [{ id: `link-${by.key}-${issue.key}`, type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: by.key, fields: { summary: by.summary, status: statusOf(by.status) } } }] : [];
        }),
      },
    };
  };
  const findIssue = (key: string) => config.issues.find((i) => i.key === key);
  /** Where an issue goes from here: every other status of its board's columns, or the usual three without a board. */
  const targetsOf = (issue: JiraIssue) => {
    const board = boards.find((b) => b.projectKey === issue.key.split("-")[0]);
    const statuses = board ? board.columns.flatMap((c) => c.statuses) : ["To Do", "In Progress", "Done"];
    return statuses.filter((name) => name !== issue.status).map((name) => ({ id: String(20 + Object.keys(STATUSES).indexOf(name)), name, to: statusOf(name), isAvailable: true }));
  };

  /** One page of issues, as every Agile and search answer pages them: startAt and maxResults from the query, 50 at most. */
  const page = (res: ServerResponse, url: URL, keys: string[], version = "3") => {
    const startAt = Math.max(0, Number(url.searchParams.get("startAt") ?? 0) || 0);
    const maxResults = Math.min(50, Math.max(1, Number(url.searchParams.get("maxResults") ?? 50) || 50));
    const issues = keys.map(findIssue).filter((i): i is JiraIssue => !!i);
    return json(res, 200, { expand: "names,schema", startAt, maxResults, total: issues.length, issues: issues.slice(startAt, startAt + maxResults).map((i) => issueView(i, version)) });
  };

  /** The JQL a sprint or project view asks; anything else answers 400 as Jira does for a clause it cannot read. */
  const search = (res: ServerResponse, url: URL) => {
    const jql = (url.searchParams.get("jql") ?? "").replace(/\s+ORDER BY .*$/i, "").trim();
    let keys: string[] | null = null;
    const sprint = /^sprint\s*=\s*(\d+)$/i.exec(jql);
    const project = /^project\s*=\s*"?([A-Z][A-Z0-9]*)"?$/i.exec(jql);
    if (sprint) keys = boards.flatMap((b) => b.sprints.filter((s) => s.id === Number(sprint[1])).flatMap((s) => s.issues));
    else if (/^sprint\s+in\s+openSprints\(\)$/i.test(jql)) keys = boards.flatMap((b) => b.sprints.filter((s) => s.state === "active").flatMap((s) => s.issues));
    else if (project) keys = config.issues.filter((i) => i.key.startsWith(`${project[1]!.toUpperCase()}-`)).map((i) => i.key);
    if (!keys) return json(res, 400, { errorMessages: [`The lab's Jira reads sprint = <id>, sprint in openSprints() or project = <key>, not: ${jql.slice(0, 80)}`] });
    return page(res, url, keys);
  };

  const agile = (res: ServerResponse, url: URL) => {
    const parts = url.pathname.slice("/rest/agile/1.0/".length).split("/").filter(Boolean);
    if (parts[0] === "board" && parts.length === 1) {
      const project = url.searchParams.get("projectKeyOrId");
      const found = boards.filter((b) => !project || b.projectKey === project);
      return json(res, 200, { maxResults: 50, startAt: 0, total: found.length, isLast: true, values: found.map(boardView) });
    }
    if (parts[0] === "board" && parts[1]) {
      const board = boards.find((b) => b.id === Number(parts[1]));
      if (!board) return notFound(res, `Board ${parts[1]} does not exist or you do not have permission to see it.`);
      if (parts.length === 2) return json(res, 200, boardView(board));
      if (parts[2] === "configuration") {
        return json(res, 200, {
          id: board.id,
          name: board.name,
          type: "scrum",
          columnConfig: { columns: board.columns.map((c) => ({ name: c.name, statuses: c.statuses.map((s) => ({ id: statusOf(s).id, self: `${base}/rest/api/3/status/${statusOf(s).id}` })) })), constraintType: "none" },
          estimation: { type: "field", field: { fieldId: POINTS_FIELD, displayName: "Story point estimate" } },
          ranking: { rankCustomFieldId: 10019 },
        });
      }
      if (parts[2] === "sprint" && parts[3] && parts[4] === "issue") {
        const sprint = board.sprints.find((s) => s.id === Number(parts[3]));
        if (!sprint) return notFound(res, `Sprint ${parts[3]} does not exist on board ${board.id}.`);
        return page(res, url, sprint.issues);
      }
      if (parts[2] === "sprint" && parts.length === 3) {
        const states = (url.searchParams.get("state") ?? "active,future,closed").split(",");
        const found = board.sprints.filter((s) => states.includes(s.state));
        return json(res, 200, { maxResults: 50, startAt: 0, isLast: true, values: found.map((s) => sprintView(board, s)) });
      }
      if (parts[2] === "backlog") return page(res, url, board.backlog);
      if (parts[2] === "issue") return page(res, url, [...board.sprints.flatMap((s) => s.issues), ...board.backlog]);
    }
    if (parts[0] === "sprint" && parts[1]) {
      const owner = boards.find((b) => b.sprints.some((s) => s.id === Number(parts[1])));
      const sprint = owner?.sprints.find((s) => s.id === Number(parts[1]));
      if (!owner || !sprint) return notFound(res, `Sprint ${parts[1]} does not exist.`);
      if (parts.length === 2) return json(res, 200, sprintView(owner, sprint));
      if (parts[2] === "issue") return page(res, url, sprint.issues);
    }
    return notFound(res);
  };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", base);
      const method = req.method ?? "GET";
      const lab = url.pathname.startsWith("/lab/");
      appendFileSync(config.log, `${new Date().toISOString()} ${method} ${url.pathname}${url.search}${method === "GET" || lab ? "" : " WRITE"}\n`);
      if (url.pathname === "/health") return json(res, 200, { ok: true });
      // A teammate moving a card on the board in Jira, as the lab plays it: not part of the Jira API.
      if (lab && url.pathname === "/lab/transitions") return json(res, 200, { transitions });
      if (lab && url.pathname === "/lab/move" && method === "POST") {
        let body: { key?: string; status?: string };
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          return json(res, 400, { error: "send {key, status}" });
        }
        const issue = findIssue(String(body.key));
        if (!issue || typeof body.status !== "string" || !STATUSES[body.status]) return json(res, 400, { error: `send a known key and one of ${Object.keys(STATUSES).join(", ")}` });
        issue.status = body.status;
        return json(res, 200, { key: issue.key, status: issue.status });
      }
      // A teammate linking an issue as blocked by others in Jira; an empty list takes the links away.
      if (lab && url.pathname === "/lab/link" && method === "POST") {
        let body: { key?: string; blockedBy?: unknown };
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          return json(res, 400, { error: "send {key, blockedBy}" });
        }
        const issue = findIssue(String(body.key));
        const by = Array.isArray(body.blockedBy) ? body.blockedBy.map(String) : null;
        if (!issue || !by || by.some((key) => !findIssue(key))) return json(res, 400, { error: "send a known key and the known keys that block it" });
        issue.blockedBy = by;
        return json(res, 200, { key: issue.key, blockedBy: by });
      }
      if (!reads.has(req.headers.authorization ?? "")) return json(res, 401, { errorMessages: ["You are not authenticated."] });
      const moving = /^\/rest\/api\/(2|3)\/issue\/([A-Z][A-Z0-9]*-\d+)\/transitions$/.exec(url.pathname);
      if (moving) {
        const issue = findIssue(moving[2]!);
        if (!issue) return notFound(res, "Issue does not exist or you do not have permission to see it.");
        if (method === "GET") return json(res, 200, { expand: "transitions", transitions: targetsOf(issue) });
        if (method !== "POST") return json(res, 405, { errorMessages: ["The lab's Jira takes no writes but a transition."] });
        if (req.headers.authorization !== writes) return json(res, 403, { errorMessages: ["You do not have permission to transition this issue."] });
        let body: { transition?: { id?: string } };
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          return json(res, 400, { errorMessages: ["The request body is not JSON."] });
        }
        const to = targetsOf(issue).find((t) => t.id === String(body.transition?.id));
        if (!to) return json(res, 400, { errorMessages: [`Transition id '${String(body.transition?.id)}' is not valid for this issue.`] });
        transitions.push({ at: new Date().toISOString(), key: issue.key, from: issue.status, to: to.name });
        appendFileSync(config.log, `${new Date().toISOString()} TRANSITION ${issue.key} ${issue.status} -> ${to.name}\n`);
        issue.status = to.name;
        res.writeHead(204);
        res.end();
        return;
      }
      // Writing back is off in the product; anything but a read or a transition is refused here and left in the log.
      if (method !== "GET") return json(res, 405, { errorMessages: ["The lab's Jira takes no writes but a transition."] });
      if (url.pathname.startsWith("/rest/agile/1.0/")) return agile(res, url);
      if (/^\/rest\/api\/(2|3)\/status$/.test(url.pathname)) return json(res, 200, Object.keys(STATUSES).map(statusOf));
      if (/^\/rest\/api\/(2|3)\/field$/.test(url.pathname)) return json(res, 200, FIELDS.map((f) => ({ ...f, schema: { type: f.custom ? "array" : "string" } })));
      // What the account is allowed: moving an issue through its workflow only with the write token.
      if (/^\/rest\/api\/(2|3)\/mypermissions$/.test(url.pathname)) {
        const asked = (url.searchParams.get("permissions") ?? "").split(",").filter(Boolean);
        const moves = req.headers.authorization === writes;
        const known: Record<string, { id: string; name: string; have: boolean }> = { BROWSE_PROJECTS: { id: "10", name: "Browse Projects", have: true }, TRANSITION_ISSUES: { id: "46", name: "Transition Issues", have: moves }, EDIT_ISSUES: { id: "12", name: "Edit Issues", have: false } };
        return json(res, 200, { permissions: Object.fromEntries(asked.filter((k) => known[k]).map((k) => [k, { id: known[k]!.id, key: k, name: known[k]!.name, type: "PROJECT", havePermission: known[k]!.have }])) });
      }
      if (/^\/rest\/api\/(2|3)\/search(\/jql)?$/.test(url.pathname)) return search(res, url);
      const match = /^\/rest\/api\/(2|3)\/issue\/([A-Z][A-Z0-9]*-\d+)(\/comment)?$/.exec(url.pathname);
      if (!match) return notFound(res);
      const [, version, key, comments] = match;
      const issue = findIssue(key!);
      if (!issue) return notFound(res, "Issue does not exist or you do not have permission to see it.");
      const view = issueView(issue, version!);
      if (comments) return json(res, 200, view.fields.comment);
      return json(res, 200, view);
    });
  });
  return new Promise((resolve) => server.listen(config.port, "127.0.0.1", () => resolve()));
}

/** Run as `lab.mjs jira <config.json>`: the stand-in lives until down.sh stops it. */
export async function jiraMain(file: string): Promise<void> {
  const config = JSON.parse(readFileSync(file, "utf8")) as JiraConfig;
  await startJira(config);
  appendFileSync(config.log, `jira listening on 127.0.0.1:${config.port}\n`);
}
