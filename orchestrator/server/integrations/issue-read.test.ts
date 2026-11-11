import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import type { CliRun } from "../forge/own-cli.js";
import type { Principal } from "../auth.js";
import { openSqliteStore } from "../store.js";
import type { IssueLink } from "../tasks/issue.js";
import { createVault, storeSecret } from "../vault.js";
import { readIssue } from "./issue-read.js";
import { saveEnabled } from "./records.js";
import { TRACKER, TRACKER_TOKEN_SECRET } from "./tracker.js";
import type { TrackerConfig } from "./tracker.js";

const ADMIN: Principal = { id: "a", name: "Ada Admin", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const TOKEN = "ATATT3xFfGF0-stand-in-token-0001";
const SITE = "https://acme.atlassian.example";

/** The calls a stand-in tracker took, and the answers it gives by path; nothing leaves the test. */
function tracker(answers: Record<string, unknown>, status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: string | null }[] = [];
  const send = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? String(init.body) : null });
    const path = new URL(url).pathname + new URL(url).search;
    const body = Object.entries(answers).find(([prefix]) => path.startsWith(prefix))?.[1];
    return new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 404 : status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, send };
}

async function connected(config: TrackerConfig, token: string | null = TOKEN): Promise<OrchestratorContext> {
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: "unused", tenant: "acme", vault: createVault(randomBytes(32)) };
  await saveEnabled(ctx, TRACKER, config, ADMIN);
  if (token) await storeSecret(ctx.store, ctx.vault!, ctx.tenant, TRACKER_TOKEN_SECRET, token, ADMIN.email);
  return ctx;
}

const adf = (...paragraphs: string[]) => ({ type: "doc", content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) });
const JIRA_ISSUE: IssueLink = { url: `${SITE}/browse/PAY-142`, kind: "jira", key: "PAY-142", branchToken: "PAY-142" };

describe("reading the issue a task works on", () => {
  it("given a Jira site and its token, when the issue is read, then the agent gets its title, description, acceptance criteria, sub-tasks and latest comments, asked with the token alone", async () => {
    // given
    const ctx = await connected({ kind: "jira", url: SITE, email: "bot@example.invalid" });
    const { calls, send } = tracker({
      "/rest/api/3/issue/PAY-142?": {
        names: { customfield_10042: "Acceptance Criteria", summary: "Summary" },
        fields: {
          summary: "Round refunds half to even",
          status: { name: "In Progress" },
          issuetype: { name: "Story" },
          description: adf("Refunds are rounded up today.", "Use banker's rounding."),
          customfield_10042: adf("A refund of 0.125 becomes 0.12."),
          subtasks: [{ key: "PAY-143", fields: { summary: "Update the ledger test", status: { name: "To Do" } } }],
        },
      },
      "/rest/api/3/issue/PAY-142/comment": { comments: [{ author: { displayName: "Lin" }, created: "2026-10-20T10:00:00.000+0000", body: adf("Mind the old exports.") }] },
    });

    // when
    const read = await readIssue(ctx, JIRA_ISSUE, ADMIN, send);

    // then
    expect(read).toEqual({
      summary: "acceptance criteria, 1 sub-task(s), 1 comment(s)",
      title: "Round refunds half to even",
      status: "In Progress",
      text: [
        "PAY-142: Round refunds half to even",
        "Status: In Progress · Type: Story",
        "",
        "Description:",
        "Refunds are rounded up today.\nUse banker's rounding.",
        "",
        "Acceptance criteria:",
        "A refund of 0.125 becomes 0.12.",
        "",
        "Sub-tasks:",
        "- PAY-143 Update the ledger test (To Do)",
        "",
        "Latest comments, newest first:",
        "- Lin, 2026-10-20:",
        "Mind the old exports.",
      ].join("\n"),
    });
    expect(calls.map((c) => c.url)).toEqual([`${SITE}/rest/api/3/issue/PAY-142?expand=names`, `${SITE}/rest/api/3/issue/PAY-142/comment?orderBy=-created&maxResults=5`]);
    expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`bot@example.invalid:${TOKEN}`).toString("base64")}`);
  });

  it("given an issue link on another host, when it is read, then nothing is sent there and the reason is given", async () => {
    // given
    const ctx = await connected({ kind: "jira", url: SITE, email: "bot@example.invalid" });
    const { calls, send } = tracker({});

    // when
    const read = await readIssue(ctx, { ...JIRA_ISSUE, url: "https://elsewhere.example/browse/PAY-142" }, ADMIN, send);

    // then
    expect(read).toEqual({ problem: "the issue is not on the connected tracker (acme.atlassian.example)" });
    expect(calls).toEqual([]);
  });

  it("given a comment carrying a secret and a tracker echoing the token, when the issue is read, then neither reaches the text", async () => {
    // given
    const ctx = await connected({ kind: "jira", url: SITE, email: "bot@example.invalid" });
    const { send } = tracker({
      "/rest/api/3/issue/PAY-142?": { fields: { summary: `token ${TOKEN}`, description: adf("Use ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 to pull.") } },
      "/rest/api/3/issue/PAY-142/comment": { comments: [] },
    });

    // when
    const read = await readIssue(ctx, JIRA_ISSUE, ADMIN, send);

    // then
    const text = (read as { text: string }).text;
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789");
    expect(text).toContain("[redacted:");
  });

  it("given a token the tracker refuses, when the issue is read, then the reason says so without the token", async () => {
    // given
    const ctx = await connected({ kind: "jira", url: SITE, email: "bot@example.invalid" });
    const { send } = tracker({ "/rest/api/3/issue/PAY-142?": { message: `bad ${TOKEN}` } }, 401);

    // when
    const read = await readIssue(ctx, JIRA_ISSUE, ADMIN, send);

    // then
    expect(read).toEqual({ problem: "the tracker refused the token (401)" });
  });

  it("given a tracker with no token, when the issue is read, then nothing is asked and the agent keeps the link", async () => {
    // given
    const ctx = await connected({ kind: "jira", url: SITE }, null);
    const { calls, send } = tracker({});

    // when
    const read = await readIssue(ctx, JIRA_ISSUE, ADMIN, send);

    // then
    expect(read).toBeNull();
    expect(calls).toEqual([]);
  });

  it("given GitLab issues and a token, when an issue is read, then it is asked with the private token and system notes are left out", async () => {
    // given
    const ctx = await connected({ kind: "gitlab", url: "https://gitlab.example" });
    const { calls, send } = tracker({
      "/api/v4/projects/acme%2Fpayments/issues/12/notes": [
        { system: true, author: { name: "GitLab" }, created_at: "2026-10-21T00:00:00Z", body: "changed the label" },
        { system: false, author: { name: "Pat" }, created_at: "2026-10-20T00:00:00Z", body: "Keep the CSV export." },
      ],
      "/api/v4/projects/acme%2Fpayments/issues/12": { title: "Refund rounding", state: "opened", labels: ["bug"], description: "Round half to even." },
    });

    // when
    const read = await readIssue(ctx, { url: "https://gitlab.example/acme/payments/-/issues/12", kind: "gitlab", key: "acme/payments#12", branchToken: "payments-12" }, ADMIN, send);

    // then
    expect((read as { text: string }).text).toBe(["acme/payments#12: Refund rounding", "State: opened · Labels: bug", "", "Description:", "Round half to even.", "", "Latest comments, newest first:", "- Pat, 2026-10-20:", "Keep the CSV export."].join("\n"));
    expect(calls.every((c) => c.headers["private-token"] === TOKEN)).toBe(true);
  });

  it("given boards mapped to teams, when a member who owns no team's board has a task on PAY-142, then the tracker is not asked and the reason is given", async () => {
    // given
    const ctx = await connected({ kind: "jira", url: SITE, email: "bot@example.invalid" });
    await ctx.store.setSetting(ctx.tenant, "work.boards.teams", JSON.stringify({ "tracker~12": "Payments" }));
    await ctx.store.setSetting(ctx.tenant, "work.boards.projects", JSON.stringify({ "tracker~12": "PAY" }));
    const { calls, send } = tracker({});
    const member: Principal = { id: "m", name: "Mel Member", email: "mel@example.invalid", role: "member", ownedTeams: ["Lending"] };

    // when
    const read = await readIssue(ctx, JIRA_ISSUE, member, send);

    // then
    expect(read).toEqual({ problem: "the issue's project is not on a board shown to this person" });
    expect(calls).toEqual([]);
  });

  it("given a Linear workspace and its API key, when an issue is read, then one GraphQL query to Linear's API brings its title, state, description, sub-issues and latest comments newest first", async () => {
    // given
    const ctx = await connected({ kind: "linear", url: "https://linear.app/acme" }, "lin_api_stand-in-key-0001");
    const { calls, send } = tracker({
      "/graphql": { data: { issue: {
        title: "Refund rounding", description: "Round half to even.", priority: 2, priorityLabel: "High", state: { name: "In Progress" }, labels: { nodes: [{ name: "bug" }] },
        children: { nodes: [{ identifier: "ENG-13", title: "Rounding table", state: { name: "Todo" } }] },
        comments: { nodes: [{ body: "First.", createdAt: "2026-11-01T09:00:00.000Z", user: { name: "Kai" } }, { body: "Keep the CSV export.", createdAt: "2026-11-02T09:00:00.000Z", user: { name: "Lee" } }] },
      } } },
    });

    // when
    const read = await readIssue(ctx, { url: "https://linear.app/acme/issue/ENG-12/refund-rounding", kind: "linear", key: "ENG-12", branchToken: "ENG-12" }, ADMIN, send);

    // then
    expect((read as { text: string }).text).toBe(["ENG-12: Refund rounding", "State: In Progress · Priority: High · Labels: bug", "", "Description:", "Round half to even.", "", "Sub-issues:", "- ENG-13 Rounding table (Todo)", "", "Latest comments, newest first:", "- Lee, 2026-11-02:", "Keep the CSV export.", "- Kai, 2026-11-01:", "First."].join("\n"));
    expect(calls.map((c) => [c.url, c.headers.authorization])).toEqual([["https://api.linear.app/graphql", "lin_api_stand-in-key-0001"]]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ query: expect.stringMatching(/^query /), variables: { id: "ENG-12" } });
  });

  it("given the ENG team's board mapped to Payments, when a Payments owner and a Lending owner each have a task on ENG-12, then the first gets its text and the second is not read", async () => {
    // given
    const ctx = await connected({ kind: "linear", url: "https://linear.app/acme" }, "lin_api_stand-in-key-0001");
    await ctx.store.setSetting(ctx.tenant, "work.boards.teams", JSON.stringify({ "tracker~11111111-2222-3333-4444-555555555555": "Payments" }));
    await ctx.store.setSetting(ctx.tenant, "work.boards.projects", JSON.stringify({ "tracker~11111111-2222-3333-4444-555555555555": "ENG" }));
    const { calls, send } = tracker({ "/graphql": { data: { issue: { title: "Refund rounding", state: { name: "Todo" } } } } });
    const issue: IssueLink = { url: "https://linear.app/acme/issue/ENG-12", kind: "linear", key: "ENG-12", branchToken: "ENG-12" };
    const payments: Principal = { id: "p", name: "Pat Payments", email: "pat@example.invalid", role: "member", ownedTeams: ["Payments"] };
    const lending: Principal = { id: "m", name: "Mel Member", email: "mel@example.invalid", role: "member", ownedTeams: ["Lending"] };

    // when
    const owner = await readIssue(ctx, issue, payments, send);
    const other = await readIssue(ctx, issue, lending, send);

    // then
    expect((owner as { title: string }).title).toBe("Refund rounding");
    expect(other).toEqual({ problem: "the issue's project is not on a board shown to this person" });
    expect(calls).toHaveLength(1);
  });

  it("given a Linear workspace, when the issue is in another workspace, then nothing is sent and the reason is given", async () => {
    // given
    const ctx = await connected({ kind: "linear", url: "https://linear.app/acme" }, "lin_api_stand-in-key-0001");
    const { calls, send } = tracker({});

    // when
    const read = await readIssue(ctx, { url: "https://linear.app/acme-labs/issue/ENG-12", kind: "linear", key: "ENG-12", branchToken: "ENG-12" }, ADMIN, send);

    // then
    expect(read).toEqual({ problem: "the issue is not in the connected Linear workspace (acme)" });
    expect(calls).toEqual([]);
  });
});

/** One person's own machine with a project whose folder names a GitHub repository as origin, and their gh standing in. */
async function ownMachine(origin: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "own-issue-"));
  const folder = `${dataDir}-project`;
  mkdirSync(join(folder, ".git"), { recursive: true });
  writeFileSync(join(folder, ".git", "config"), `[remote "origin"]\n\turl = ${origin}\n`);
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir, tenant: "acme", vault: null, ownForgeCli: true };
  await ctx.store.upsertRepo({ tenant: "acme", id: "web-skills", team: "Mine", name: "web-skills", url: folder });
  const ran: string[][] = [];
  const answers: Record<string, unknown> = {
    user: { login: "solo-person" },
    "repos/acme/web-skills/issues/101": { title: "Expose the order-history endpoint", state: "open", body: "Customers see past orders.", labels: [{ name: "customer-api" }] },
    "repos/acme/web-skills/issues/101/comments?per_page=100": [{ user: { login: "kai" }, created_at: "2026-11-01T09:00:00Z", body: "First." }, { user: { login: "lee" }, created_at: "2026-11-02T09:00:00Z", body: "Page it by 20." }],
  };
  const run: CliRun = async (tool, args) => {
    ran.push([tool, ...args]);
    if (args[0] === "auth") return { code: 0, stdout: "", stderr: "", missing: false };
    const answer = answers[args[3]!];
    return answer ? { code: 0, stdout: JSON.stringify(answer), stderr: "", missing: false } : { code: 1, stdout: "", stderr: "HTTP 404", missing: false };
  };
  return { ctx, run, ran };
}

const OWNER: Principal = { id: "u-solo", name: "Solo Person", email: "solo@example.invalid", role: "owner", ownedTeams: [] };
const GITHUB_ISSUE: IssueLink = { url: "https://github.com/acme/web-skills/issues/101", kind: "github", key: "acme/web-skills#101", branchToken: "web-skills-101" };

describe("reading a GitHub issue with the person's own gh on their own machine", () => {
  it("given an issue of the repository a project names as origin, when a task reads it, then the agent gets its title, state, labels, description and latest comments newest first, read through gh", async () => {
    // given
    const { ctx, run, ran } = await ownMachine("git@github.com:acme/web-skills.git");

    // when
    const read = await readIssue(ctx, GITHUB_ISSUE, OWNER, undefined, run);

    // then
    expect(read).toEqual({
      text: "acme/web-skills#101: Expose the order-history endpoint\nState: open · Labels: customer-api\n\nDescription:\nCustomers see past orders.\n\nLatest comments, newest first:\n- lee, 2026-11-02:\nPage it by 20.\n- kai, 2026-11-01:\nFirst.",
      summary: "2 comment(s)",
      title: "Expose the order-history endpoint",
      status: "open",
    });
    expect(ran.every(([tool]) => tool === "gh")).toBe(true);
  });

  it("given an issue of a repository no project names as origin, when a task reads it, then it gets its link alone and gh is not asked", async () => {
    // given
    const { ctx, run, ran } = await ownMachine("git@github.com:acme/other.git");

    // when
    const read = await readIssue(ctx, GITHUB_ISSUE, OWNER, undefined, run);

    // then
    expect(read).toBeNull();
    expect(ran).toEqual([]);
  });
});
