import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoRecord } from "../store.js";
import { createGiteaForge, giteaComments, giteaRunnerSeen, readGiteaRequest } from "./gitea.js";
import { forgeHttp } from "./http.js";
import { ForgeRefusal } from "./local.js";
import type { ChangeRequest } from "./types.js";

const TOKEN = "gitea-stand-in-token-0123456789abcdef";
const BASE = "b".repeat(40);
const COMMIT = "c".repeat(40);
const R = "/repos/acme/payments-skills";

interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

type Answer = { status: number; body: unknown };
type Routes = (method: string, path: string, body: unknown) => Answer | undefined;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/** A Gitea that records every request it receives and answers from `routes`; anything unrouted is a 404. */
async function fakeGitea(routes: Routes) {
  const recorded: Recorded[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      recorded.push({ method: req.method!, path: req.url!, headers: req.headers, body });
      const answer = routes(req.method!, req.url!, body) ?? { status: 404, body: { message: "Not Found" } };
      res.statusCode = answer.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  return { recorded, apiUrl, forge: createGiteaForge({ repoId: "payments-skills", kind: "gitea", apiUrl, project: "acme/payments-skills" }, TOKEN) };
}

/** A repository whose base commit holds skills/handover/SKILL.md and skills/old/SKILL.md, and nothing at the new path. */
function repository(extra: Routes = () => undefined): Routes {
  return (method, path, body) => {
    const override = extra(method, path, body);
    if (override) return override;
    if (method === "GET" && path === `/api/v1${R}`) return { status: 200, body: { default_branch: "trunk" } };
    if (method === "GET" && path === `/api/v1${R}/contents/skills/handover/SKILL.md?ref=${BASE}`) return { status: 200, body: { type: "file", sha: "blob-handover" } };
    if (method === "GET" && path === `/api/v1${R}/contents/skills/old/SKILL.md?ref=${BASE}`) return { status: 200, body: { type: "file", sha: "blob-old" } };
    if (method === "POST" && path === `/api/v1${R}/branches`) return { status: 201, body: { name: "handbook/on-call-handover" } };
    if (method === "POST" && path === `/api/v1${R}/contents`) return { status: 201, body: { commit: { sha: COMMIT } } };
    if (method === "POST" && path === `/api/v1${R}/pulls`) return { status: 201, body: { number: 9, html_url: "https://gitea.example.invalid/acme/payments-skills/pulls/9" } };
    if (method === "POST" && path === `/api/v1${R}/pulls/9/requested_reviewers`) return { status: 201, body: [] };
    if (method === "GET" && path === `/api/v1${R}/labels?limit=50`) return { status: 200, body: [{ id: 4, name: "skills" }, { id: 7, name: "on-call" }] };
    if (method === "POST" && path === `/api/v1${R}/issues/9/labels`) return { status: 200, body: [] };
    if (method === "PATCH" && path === `/api/v1${R}/issues/9`) return { status: 201, body: {} };
    if (method === "DELETE" && path === `/api/v1${R}/branches/handbook/on-call-handover`) return { status: 204, body: null };
    return undefined;
  };
}

const repo = { tenant: "acme", id: "payments-skills", team: "Payments", name: "payments-skills", url: "https://gitea.example.invalid/acme/payments-skills.git", head: BASE, error: null, syncedAt: null } as RepoRecord;

const change = (over: Partial<ChangeRequest> = {}): ChangeRequest => ({
  title: "Update the on-call handover skill",
  body: "Adds the pager step.",
  branch: "handbook/on-call-handover",
  baseSha: BASE,
  files: [
    { path: "skills/handover/SKILL.md", content: "# Handover\n" },
    { path: "skills/pager/SKILL.md", content: "# Pager\n" },
    { path: "skills/old/SKILL.md", content: null },
  ],
  author: { name: "Ada Lovelace", email: "ada@example.invalid" },
  assignment: { reviewers: ["grace"], labels: ["skills", "on-call"], assignee: "ada" },
  ...over,
});

const writes = (recorded: Recorded[]) => recorded.filter((r) => r.method !== "GET");

describe("a pull request on Gitea", () => {
  it("given a change, when it is opened, then the branch is made at the base, the files are written onto it as one commit by the person, and the pull request carries the team's reviewers, labels and assignee", async () => {
    const { recorded, forge } = await fakeGitea(repository());

    const opened = await forge.open(repo, change());

    expect(opened).toEqual({ number: 9, url: "https://gitea.example.invalid/acme/payments-skills/pulls/9", branch: "handbook/on-call-handover", headSha: COMMIT });
    expect(writes(recorded).map((r) => [r.method, r.path.replace("/api/v1", ""), r.body])).toEqual([
      ["POST", `${R}/branches`, { new_branch_name: "handbook/on-call-handover", old_ref_name: BASE }],
      [
        "POST",
        `${R}/contents`,
        {
          branch: "handbook/on-call-handover",
          files: [
            { operation: "update", path: "skills/handover/SKILL.md", sha: "blob-handover", content: Buffer.from("# Handover\n").toString("base64") },
            { operation: "create", path: "skills/pager/SKILL.md", content: Buffer.from("# Pager\n").toString("base64") },
            { operation: "delete", path: "skills/old/SKILL.md", sha: "blob-old" },
          ],
          message: "Update the on-call handover skill\n\nAdds the pager step.",
          author: { name: "Ada Lovelace", email: "ada@example.invalid" },
          committer: { name: "TeamHandbook Orchestrator", email: "orchestrator@teamhandbook.invalid" },
        },
      ],
      ["POST", `${R}/pulls`, { title: "Update the on-call handover skill", head: "handbook/on-call-handover", base: "trunk", body: "Adds the pager step." }],
      ["POST", `${R}/pulls/9/requested_reviewers`, { reviewers: ["grace"] }],
      ["POST", `${R}/issues/9/labels`, { labels: [4, 7] }],
      ["PATCH", `${R}/issues/9`, { assignees: ["ada"] }],
    ]);
    for (const r of recorded) {
      expect(r.headers.authorization).toBe(`token ${TOKEN}`);
      expect(r.path).not.toContain(TOKEN);
    }
  });

  it("given the branch already on Gitea, when a change is opened, then it is refused before anything is written", async () => {
    const { recorded, forge } = await fakeGitea(repository((method, path) => (method === "GET" && path === `/api/v1${R}/branches/handbook/on-call-handover` ? { status: 200, body: { name: "handbook/on-call-handover" } } : undefined)));

    await expect(forge.open(repo, change())).rejects.toThrow(ForgeRefusal);
    expect(writes(recorded)).toEqual([]);
  });

  it("given a path that is a symbolic link or a folder at the base, when a change writes it, then it is refused before any branch is made", async () => {
    for (const [at, says] of [[{ type: "symlink", sha: "blob-link" }, "it is a symlink"], [[{ type: "file", name: "SKILL.md" }], "it is a folder"]] as const) {
      const { recorded, forge } = await fakeGitea(repository((method, path) => (method === "GET" && path.startsWith(`/api/v1${R}/contents/skills/handover`) ? { status: 200, body: at } : undefined)));

      await expect(forge.open(repo, change())).rejects.toThrow(new RegExp(`refusing skills/handover/SKILL.md: ${says} in payments-skills`));
      expect(writes(recorded)).toEqual([]);
    }
  });

  it("given a change removing a file the base does not hold, when it is opened, then it is refused before any branch is made", async () => {
    const { recorded, forge } = await fakeGitea(repository());

    await expect(forge.open(repo, change({ files: [{ path: "skills/gone/SKILL.md", content: null }] }))).rejects.toThrow(/skills\/gone\/SKILL.md is not in payments-skills to remove/);
    expect(writes(recorded)).toEqual([]);
  });

  it("given Gitea refusing to write the files, when a change is opened, then the branch it made is taken back and its reason is said", async () => {
    const { recorded, forge } = await fakeGitea(repository((method, path) => (method === "POST" && path === `/api/v1${R}/contents` ? { status: 422, body: { message: "sha does not match" } } : undefined)));

    await expect(forge.open(repo, change())).rejects.toThrow(/the change was not written: .*sha does not match.*; the branch was removed again/);
    expect(recorded.at(-1)).toMatchObject({ method: "DELETE", path: `/api/v1${R}/branches/handbook/on-call-handover` });
    expect(recorded.some((r) => r.path.endsWith("/pulls"))).toBe(false);
  });

  it("given Gitea refusing the pull request, when a change is opened, then the branch is taken back", async () => {
    const { recorded, forge } = await fakeGitea(repository((method, path) => (method === "POST" && path === `/api/v1${R}/pulls` ? { status: 403, body: { message: "forbidden" } } : undefined)));

    await expect(forge.open(repo, change())).rejects.toThrow(/the request was not opened: .*; the branch was removed again; try again/);
    expect(recorded.at(-1)).toMatchObject({ method: "DELETE", path: `/api/v1${R}/branches/handbook/on-call-handover` });
  });

  it("given a label the repository does not have, when a change is opened, then the request is opened with the labels it has and the missing one is noted", async () => {
    const { recorded, forge } = await fakeGitea(repository());

    const opened = await forge.open(repo, change({ assignment: { reviewers: [], labels: ["skills", "urgent"] } }));

    expect(opened.notes).toEqual(["labels were not added: urgent is not a label of payments-skills; add it on Gitea, or take it out of the team's labels"]);
    expect(recorded.find((r) => r.path.endsWith("/issues/9/labels"))?.body).toEqual({ labels: [4] });
  });
});

describe("reading what Gitea says of requests", () => {
  it("given a merged, a closed and an open pull request, when each is read, then each says where it stands", async () => {
    const pulls: Record<string, unknown> = { 1: { state: "closed", merged: true, merged_at: "2026-11-02T12:00:00Z" }, 2: { state: "closed", merged: false }, 3: { state: "open", merged: false } };
    const { forge } = await fakeGitea((method, path) => {
      const n = /\/pulls\/(\d)$/.exec(path)?.[1];
      return method === "GET" && n ? { status: 200, body: pulls[n] } : undefined;
    });

    expect(await forge.status!(repo, 1)).toEqual({ status: "merged", mergedAt: "2026-11-02T12:00:00.000Z" });
    expect(await forge.status!(repo, 2)).toEqual({ status: "closed", mergedAt: null });
    expect(await forge.status!(repo, 3)).toEqual({ status: "open", mergedAt: null });
  });

  it("given open pull requests, one from a fork, when what waits is listed, then each is shown as text and the fork is marked", async () => {
    const { recorded, forge } = await fakeGitea((method, path) =>
      method === "GET" && path.startsWith(`/api/v1${R}/pulls?`)
        ? {
            status: 200,
            body: [
              { number: 4, title: "Add <b>retry</b>", html_url: "https://gitea.example.invalid/acme/payments-skills/pulls/4", updated_at: "2026-11-02T10:00:00Z", head: { ref: "handbook/retry", repo_id: 1 }, base: { repo_id: 1 }, user: { login: "grace" } },
              { number: 5, title: "From a fork", html_url: "javascript:alert(1)", updated_at: "2026-11-01T10:00:00Z", head: { ref: "patch-1", repo_id: 2 }, base: { repo_id: 1 }, user: { login: "max" } },
            ],
          }
        : undefined,
    );

    const listed = await forge.list!(repo);

    expect(recorded[0]!.path).toBe(`/api/v1${R}/pulls?state=open&sort=recentupdate&limit=50`);
    expect(listed).toMatchObject([
      { number: 4, title: "Add <b>retry</b>", branch: "handbook/retry", url: "https://gitea.example.invalid/acme/payments-skills/pulls/4", author: "grace", fromFork: false },
      { number: 5, url: null, fromFork: true },
    ]);
  });

  it("given a check's outcome, when it is set on a commit, then Gitea is sent its state, context and a description cut to 140 characters", async () => {
    const { recorded, forge } = await fakeGitea((method, path) => (method === "POST" && path === `/api/v1${R}/statuses/${COMMIT}` ? { status: 201, body: {} } : undefined));

    await forge.setCommitStatus!(COMMIT, { state: "failure", context: "teamhandbook/review", description: "x".repeat(200) });

    expect(recorded[0]!.body).toEqual({ state: "failure", context: "teamhandbook/review", description: "x".repeat(140) });
  });
});

describe("reading a request on Gitea as the orchestrator reads every forge", () => {
  const on = async (routes: Routes) => {
    const { apiUrl } = await fakeGitea(routes);
    return { http: forgeHttp("Gitea", apiUrl, TOKEN, { authorization: `token ${TOKEN}` }, fetch), config: { repoId: "payments-skills", kind: "gitea" as const, apiUrl, project: "acme/payments-skills" } };
  };
  const P = `/api/v1${R}`;
  const pull = (over: Record<string, unknown> = {}) => ({ number: 9, state: "open", merged: false, mergeable: true, html_url: "https://gitea.example.invalid/acme/payments-skills/pulls/9", head: { ref: "handbook/on-call-handover", sha: COMMIT, repo_id: 1 }, base: { repo_id: 1 }, user: { login: "ada" }, requested_reviewers: [], ...over });

  it("given an approval, a dismissed request for changes and a failed status, when the request is read, then it is approved by the one who approved, mergeable, and its checks fail", async () => {
    const { http, config } = await on((method, path) => {
      if (method !== "GET") return undefined;
      if (path === `${P}/pulls/9`) return { status: 200, body: pull() };
      if (path === `${P}/pulls/9/reviews?limit=50`)
        return { status: 200, body: [{ id: 1, user: { login: "grace" }, state: "APPROVED", submitted_at: "2026-11-02T12:00:00Z" }, { id: 2, user: { login: "max" }, state: "REQUEST_CHANGES", dismissed: true, submitted_at: "2026-11-02T12:01:00Z" }, { id: 3, user: { login: "max" }, state: "COMMENT", submitted_at: "2026-11-02T12:02:00Z" }] };
      if (path === `${P}/commits/${COMMIT}/statuses?limit=50`) return { status: 200, body: [{ id: 5, context: "ci/test", status: "failure", target_url: "https://gitea.example.invalid/ci/5", updated_at: "2026-11-02T12:03:00Z" }] };
      return undefined;
    });

    const detail = await readGiteaRequest(http, config, 9);

    expect(detail).toMatchObject({ number: 9, status: "open", headSha: COMMIT, mergeability: { state: "mergeable" }, review: { decision: "approved", approvedBy: ["grace"] }, checks: { state: "failing", checks: [{ name: "ci/test", group: "status", state: "failure" }] } });
  });

  it("given a request Gitea cannot merge, one merged, and one with no status yet, when each is read, then they read as a conflict, not open, and checks not yet known", async () => {
    let answer = pull({ mergeable: false });
    const { http, config } = await on((method, path) => {
      if (method !== "GET") return undefined;
      if (path === `${P}/pulls/9`) return { status: 200, body: answer };
      if (path.startsWith(`${P}/pulls/9/reviews`) || path.startsWith(`${P}/commits/`)) return { status: 200, body: [] };
      return undefined;
    });

    expect((await readGiteaRequest(http, config, 9)).mergeability).toEqual({ state: "conflict", reason: "the branch conflicts with its base" });
    expect((await readGiteaRequest(http, config, 9)).checks.state).toBe("unknown");
    answer = pull({ state: "closed", merged: true });
    expect(await readGiteaRequest(http, config, 9)).toMatchObject({ status: "merged", mergeability: { state: "not-open" } });
  });

  it("given a conversation and a review with a comment on a line, when what was said is read, then both come newest first, the line comment with its file and line", async () => {
    const { http, config } = await on((method, path) => {
      if (method !== "GET") return undefined;
      if (path === `${P}/issues/9/comments`) return { status: 200, body: [{ id: 11, body: "Looks right.\nOne nit.", user: { login: "grace" }, updated_at: "2026-11-02T12:00:00Z", html_url: "https://gitea.example.invalid/c/11" }] };
      if (path === `${P}/pulls/9/reviews?limit=50`) return { status: 200, body: [{ id: 3, comments_count: 1 }, { id: 4, comments_count: 0 }] };
      if (path === `${P}/pulls/9/reviews/3/comments`) return { status: 200, body: [{ id: 21, body: "Rename this.", user: { login: "ada" }, updated_at: "2026-11-02T12:05:00Z", path: "README.md", position: 3 }] };
      return undefined;
    });

    expect((await giteaComments(http, config, 9)).map((c) => [c.author, c.body, c.path, c.line])).toEqual([
      ["ada", "Rename this.", "README.md", 3],
      ["grace", "Looks right.\nOne nit.", null, null],
    ]);
  });

  it("given a request from a fork, when the runner's report is checked against it, then its branch, author and head are read and the fork is told", async () => {
    const { http, config } = await on((method, path) => (method === "GET" && path === `${P}/pulls/9` ? { status: 200, body: pull({ head: { ref: "patch-1", sha: COMMIT, repo_id: 2 } }) } : undefined));

    expect(await giteaRunnerSeen(http, config, 9)).toEqual({ sourceBranch: "patch-1", fromFork: true, author: "ada", headSha: COMMIT, url: "https://gitea.example.invalid/acme/payments-skills/pulls/9", open: true });
  });
});

