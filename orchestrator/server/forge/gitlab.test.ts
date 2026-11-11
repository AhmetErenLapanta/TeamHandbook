import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoRecord } from "../store.js";
import { createGitLabForge } from "./gitlab.js";
import type { ChangeRequest } from "./types.js";

const TOKEN = "glpat-Zx9Qw8Er7Ty6Ui5Op4As";
const BASE = "a".repeat(40);

interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

type Answer = { status: number; body: unknown };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/** A GitLab that records every request it receives and answers from `routes`; anything unrouted is a 404. */
async function fakeGitLab(routes: (method: string, path: string, body: unknown) => Answer | undefined, oauth = false) {
  const recorded: Recorded[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const path = req.url!.replace(/^\/api\/v4/, "");
      recorded.push({ method: req.method!, path, headers: req.headers, body });
      const answer = routes(req.method!, path, body) ?? { status: 404, body: { message: "404 Not found" } };
      res.statusCode = answer.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v4`;
  return { recorded, forge: createGitLabForge({ repoId: "payments-skills", kind: "gitlab", apiUrl, project: "acme/payments-skills" }, TOKEN, fetch, oauth) };
}

const PROJECT = "/projects/acme%2Fpayments-skills";

/** A project whose default branch is main, holding README.md and skills/old/SKILL.md, with users ada and grace. */
function project(extra: (method: string, path: string, body: unknown) => Answer | undefined = () => undefined) {
  return (method: string, path: string, body: unknown): Answer | undefined => {
    const override = extra(method, path, body);
    if (override) return override;
    if (method === "GET" && path === PROJECT) return { status: 200, body: { id: 7, default_branch: "main" } };
    if (method === "GET" && path === `${PROJECT}/repository/files/README.md?ref=${BASE}`) return { status: 200, body: { file_path: "README.md" } };
    if (method === "GET" && path === `${PROJECT}/repository/files/skills%2Fold%2FSKILL.md?ref=${BASE}`) return { status: 200, body: {} };
    if (method === "GET" && path === "/users?username=ada") return { status: 200, body: [{ id: 11, username: "ada" }] };
    if (method === "GET" && path === "/users?username=grace") return { status: 200, body: [{ id: 12, username: "grace" }] };
    if (method === "GET" && path === "/users?username=pat") return { status: 200, body: [{ id: 21, username: "pat" }] };
    if (method === "POST" && path === `${PROJECT}/repository/commits`) return { status: 201, body: { id: "c0ffee".padEnd(40, "0") } };
    if (method === "POST" && path === `${PROJECT}/merge_requests`) return { status: 201, body: { iid: 42, web_url: "https://gitlab.example.invalid/acme/payments-skills/-/merge_requests/42", state: "opened" } };
    return undefined;
  };
}

const REPO = { id: "payments-skills", name: "payments-skills" } as RepoRecord;

function change(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    title: "feat(skill): add on-call-handover",
    body: "Proposed from the orchestrator.",
    branch: "handbook/on-call-handover",
    baseSha: BASE,
    files: [
      { path: "skills/on-call-handover/SKILL.md", content: "---\nname: on-call-handover\n---\n" },
      { path: "README.md", content: "updated\n" },
      { path: "skills/old/SKILL.md", content: null },
    ],
    author: { name: "Ada Example", email: "ada@example.invalid" },
    assignment: { reviewers: ["ada", "grace"], labels: ["skills", "orchestrator"], assignee: "pat" },
    ...overrides,
  };
}

describe("the GitLab forge", () => {
  it("given a commit body apart from the description, when the change is opened, then the commit carries only it and the merge request the description", async () => {
    // given
    const { recorded, forge } = await fakeGitLab(project());

    // when
    await forge.open(REPO, change({ body: "The agent's report: Closes #1", commitBody: "Opened by the orchestrator." }));

    // then
    expect((recorded.find((r) => r.path === `${PROJECT}/repository/commits`)!.body as { commit_message: string }).commit_message).toBe("feat(skill): add on-call-handover\n\nOpened by the orchestrator.");
    expect((recorded.find((r) => r.path === `${PROJECT}/merge_requests`)!.body as { description: string }).description).toBe("The agent's report: Closes #1");
  });

  it("given a change, when it is opened, then one commit carries create, update and delete from the base commit and a merge request targets the default branch", async () => {
    // given
    const { recorded, forge } = await fakeGitLab(project());

    // when
    const opened = await forge.open(REPO, change());

    // then
    expect(opened).toEqual({
      number: 42,
      url: "https://gitlab.example.invalid/acme/payments-skills/-/merge_requests/42",
      branch: "handbook/on-call-handover",
      headSha: "c0ffee".padEnd(40, "0"),
    });
    expect(recorded.find((r) => r.path === `${PROJECT}/repository/commits`)!.body).toEqual({
      branch: "handbook/on-call-handover",
      start_sha: BASE,
      commit_message: "feat(skill): add on-call-handover\n\nProposed from the orchestrator.",
      author_name: "Ada Example",
      author_email: "ada@example.invalid",
      actions: [
        { action: "create", file_path: "skills/on-call-handover/SKILL.md", content: "---\nname: on-call-handover\n---\n" },
        { action: "update", file_path: "README.md", content: "updated\n" },
        { action: "delete", file_path: "skills/old/SKILL.md" },
      ],
    });
    expect(recorded.find((r) => r.path === `${PROJECT}/merge_requests`)!.body).toEqual({
      source_branch: "handbook/on-call-handover",
      target_branch: "main",
      title: "feat(skill): add on-call-handover",
      description: "Proposed from the orchestrator.",
      remove_source_branch: true,
      labels: "skills,orchestrator",
      reviewer_ids: [11, 12],
      assignee_id: 21,
    });
  });

  it("given a reviewer GitLab does not know, when the change is opened, then the request still opens and the name comes back as a note", async () => {
    // given
    const { recorded, forge } = await fakeGitLab(project((method, path) => (path === "/users?username=grace" ? { status: 200, body: [] } : undefined)));

    // when
    const opened = await forge.open(REPO, change());

    // then
    expect(opened.number).toBe(42);
    expect(opened.notes).toEqual(["GitLab has no user grace; not added as a reviewer"]);
    expect((recorded.find((r) => r.path === `${PROJECT}/merge_requests`)!.body as { reviewer_ids: number[] }).reviewer_ids).toEqual([11]);
  });

  it("given any request the forge receives, when it is recorded, then the token sits in the PRIVATE-TOKEN header and in no path or body", async () => {
    // given
    const { recorded, forge } = await fakeGitLab(project());

    // when
    await forge.open(REPO, change());

    // then
    expect(recorded.length).toBeGreaterThan(5);
    for (const r of recorded) {
      expect(r.headers["private-token"]).toBe(TOKEN);
      expect(r.path).not.toContain(TOKEN);
      expect(JSON.stringify(r.body ?? "")).not.toContain(TOKEN);
      expect(r.headers.authorization).toBeUndefined();
    }
  });

  it("given the org's OAuth connection's token, when a change is opened, then every call carries it as a bearer and never in PRIVATE-TOKEN, which GitLab refuses for OAuth", async () => {
    // given
    const { recorded, forge } = await fakeGitLab(project(), true);

    // when
    await forge.open(REPO, change());

    // then
    expect(recorded.length).toBeGreaterThan(5);
    for (const r of recorded) {
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.headers["private-token"]).toBeUndefined();
    }
  });

  it("given GitLab refuses the token and echoes it back, when the change is opened, then the error names the status and not the token", async () => {
    // given
    const { forge } = await fakeGitLab(() => ({ status: 401, body: { message: `401 Unauthorized: token ${TOKEN} is revoked` } }));

    // when
    const error = await forge.open(REPO, change()).catch((e: Error) => e);

    // then
    expect((error as Error).message).toMatch(/^GitLab answered 401 on GET \/projects\/acme%2Fpayments-skills/);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("given a branch that already exists, when a change asks for it, then it is refused before any commit is made", async () => {
    // given
    const { recorded, forge } = await fakeGitLab(
      project((method, path) => (path === `${PROJECT}/repository/branches/handbook%2Fon-call-handover` ? { status: 200, body: { name: "handbook/on-call-handover" } } : undefined)),
    );

    // when
    const attempt = forge.open(REPO, change());

    // then
    await expect(attempt).rejects.toThrow(/already exists/);
    expect(recorded.filter((r) => r.method === "POST")).toEqual([]);
  });

  it("given a deletion of a file the base commit does not hold, when the change is opened, then it is refused before any commit", async () => {
    // given
    const { recorded, forge } = await fakeGitLab(project());

    // when
    const attempt = forge.open(REPO, change({ files: [{ path: "skills/ghost/SKILL.md", content: null }] }));

    // then
    await expect(attempt).rejects.toThrow(/cannot be deleted/);
    expect(recorded.filter((r) => r.method === "POST")).toEqual([]);
  });

  it.each([
    ["opened", "open"],
    ["merged", "merged"],
    ["closed", "closed"],
    ["locked", "closed"],
  ])("given a merge request GitLab calls %s, when its status is read, then the orchestrator calls it %s", async (state, expected) => {
    // given
    const { forge } = await fakeGitLab((method, path) => (path === `${PROJECT}/merge_requests/42` ? { status: 200, body: { iid: 42, web_url: "", state } } : undefined));

    // when
    const { status } = await forge.status!(REPO, 42);

    // then
    expect(status).toBe(expected);
  });

  it.each([
    ["the time GitLab gives", "2026-10-20T09:30:00.000+02:00", "2026-10-20T07:30:00.000Z"],
    ["no time", undefined, null],
    ["something that is not a time", "yesterday", null],
  ])("given a merged merge request with %s, when its status is read, then its merge time is kept in UTC or not at all", async (_label, merged_at, expected) => {
    // given
    const { forge } = await fakeGitLab((method, path) => (path === `${PROJECT}/merge_requests/42` ? { status: 200, body: { iid: 42, web_url: "", state: "merged", merged_at } } : undefined));

    // when
    const state = await forge.status!(REPO, 42);

    // then
    expect(state).toEqual({ status: "merged", mergedAt: expected });
  });

  it.each([
    ["GitLab takes the branch back", { status: 204, body: {} }, "the branch was removed again"],
    ["GitLab refuses to take it back", { status: 403, body: { message: "403 Forbidden" } }, "the branch stayed on GitLab: handbook/on-call-handover"],
  ])("given a merge request GitLab refuses to open and %s, when the change is opened, then the error says what became of the branch", async (_label, deletion, said) => {
    // given
    const { recorded, forge } = await fakeGitLab(
      project((method, path) => {
        if (method === "POST" && path === `${PROJECT}/merge_requests`) return { status: 500, body: { message: "500 Internal Server Error" } };
        if (method === "DELETE" && path === `${PROJECT}/repository/branches/handbook%2Fon-call-handover`) return deletion;
        return undefined;
      }),
    );

    // when
    const attempt = forge.open(REPO, change());

    // then
    await expect(attempt).rejects.toThrow(`the request was not opened: GitLab answered 500 on POST ${PROJECT}/merge_requests: 500 Internal Server Error; ${said}; try again`);
    expect(recorded.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([`${PROJECT}/repository/branches/handbook%2Fon-call-handover`]);
  });

  it("given an API address that answers with a redirect, when a change is opened, then the redirect is not followed and the message says so", async () => {
    // given
    const { recorded, forge } = await fakeGitLab(project((method, path) => (method === "GET" && path === PROJECT ? { status: 302, body: {} } : undefined)));

    // when
    const attempt = forge.open(REPO, change());

    // then
    await expect(attempt).rejects.toThrow(/answered 302 on GET \/projects\/acme%2Fpayments-skills, a redirect the orchestrator does not follow/);
    expect(recorded).toHaveLength(1);
  });
});

describe("what waits to be merged on GitLab", () => {
  it("given open merge requests, one opened by hand and one with text a terminal would act on, when they are listed, then each comes back as plain text with its link, and a link that is not http(s) is dropped", async () => {
    // given
    const { forge, recorded } = await fakeGitLab((method, path) =>
      method === "GET" && path === `${PROJECT}/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=50`
        ? {
            status: 200,
            body: [
              { iid: 7, title: "feat(skill): add on-call", source_branch: "TEAM-7-on-call", web_url: "https://gitlab.example.invalid/acme/payments-skills/-/merge_requests/7", author: { username: "grace" }, updated_at: "2026-10-24T09:00:00Z", state: "opened", source_project_id: 7, target_project_id: 7 },
              { iid: 8, title: "\u001b[2Jclear\nsecond line", source_branch: "x", web_url: "javascript:alert(1)", author: { username: "mallory" }, updated_at: "2026-10-23T09:00:00Z", state: "opened", source_project_id: 99, target_project_id: 7 },
            ],
          }
        : undefined,
    );

    // when
    const pending = await forge.list!(REPO);

    // then
    expect(pending).toEqual([
      { number: 7, title: "feat(skill): add on-call", branch: "TEAM-7-on-call", url: "https://gitlab.example.invalid/acme/payments-skills/-/merge_requests/7", author: "grace", updatedAt: "2026-10-24T09:00:00Z", fromFork: false },
      { number: 8, title: "[2Jclear second line", branch: "x", url: null, author: "mallory", updatedAt: "2026-10-23T09:00:00Z", fromFork: true },
    ]);
    expect(recorded.map((r) => r.method)).toEqual(["GET"]);
    expect(recorded[0]!.headers["private-token"]).toBe(TOKEN);
    expect(JSON.stringify(pending)).not.toContain(TOKEN);
  });
});

describe("a check's outcome on a commit", () => {
  it.each([
    ["failure", "failed"],
    ["error", "failed"],
    ["success", "success"],
    ["pending", "pending"],
  ] as const)("given a review that ends %s, when it is written, then GitLab gets a commit status %s named for the check, and nothing else", async (state, written) => {
    // given
    const sha = "d".repeat(40);
    const P = "/projects/acme%2Fpayments-skills";
    const { recorded, forge } = await fakeGitLab((method, path) => (method === "POST" && path === `${P}/statuses/${sha}` ? { status: 201, body: {} } : undefined));

    // when
    await forge.setCommitStatus!(sha, { state, context: "teamhandbook/review-rules", description: "The change keeps the team's rules." });

    // then
    expect(recorded.map((r) => [r.method, r.path])).toEqual([["POST", `${P}/statuses/${sha}`]]);
    expect(recorded[0]!.body).toEqual({ state: written, name: "teamhandbook/review-rules", description: "The change keeps the team's rules." });
  });
});

describe("a new commit on a merge request's branch", () => {
  const BRANCH = "handbook%2Fon-call-handover";
  const update = (expectedHead = BASE) => ({ files: [{ path: "README.md", content: "skills, revised\n" }, { path: "skills/new.md", content: "# New\n" }], title: "Address the review", author: { name: "Ada Example", email: "ada@example.invalid" }, expectedHead });
  const at = (head: string) => (method: string, path: string) => (method === "GET" && path === `${PROJECT}/repository/branches/${BRANCH}` ? { status: 200, body: { commit: { id: head } } } : undefined);

  it("given the branch still at the head the change was prepared on, when it is updated, then one commit lands on the branch with each existing file held to that head", async () => {
    const { recorded, forge } = await fakeGitLab(project(at(BASE)));

    const updated = await forge.updateBranch!(REPO, "handbook/on-call-handover", update());

    expect(updated).toEqual({ headSha: "c0ffee".padEnd(40, "0") });
    expect(recorded.find((r) => r.method === "POST")!.body).toEqual({
      branch: "handbook/on-call-handover",
      commit_message: "Address the review",
      author_name: "Ada Example",
      author_email: "ada@example.invalid",
      actions: [
        { action: "update", file_path: "README.md", content: "skills, revised\n", last_commit_id: BASE },
        { action: "create", file_path: "skills/new.md", content: "# New\n" },
      ],
    });
  });

  it("given a branch that moved since, when it is updated, then it is refused before anything is written", async () => {
    const { recorded, forge } = await fakeGitLab(project(at("b".repeat(40))));

    await expect(forge.updateBranch!(REPO, "handbook/on-call-handover", update())).rejects.toThrow(/moved since the change was prepared/);
    expect(recorded.some((r) => r.method === "POST")).toBe(false);
  });

  it("given GitLab answering that a file changed since, when it is updated, then it is refused as moved; any other refusal is said as GitLab said it", async () => {
    const changed = await fakeGitLab(project((m, p) => at(BASE)(m, p) ?? (m === "POST" && p === `${PROJECT}/repository/commits` ? { status: 400, body: { message: "You are attempting to update a file that has changed since you started editing it." } } : undefined)));
    const other = await fakeGitLab(project((m, p) => at(BASE)(m, p) ?? (m === "POST" && p === `${PROJECT}/repository/commits` ? { status: 400, body: { message: "Invalid file path" } } : undefined)));

    await expect(changed.forge.updateBranch!(REPO, "handbook/on-call-handover", update())).rejects.toThrow(/moved since the change was prepared/);
    await expect(other.forge.updateBranch!(REPO, "handbook/on-call-handover", update())).rejects.toThrow(/Invalid file path/);
  });
});

describe("the head a merge request's status names", () => {
  it("given an open merge request, when its status is read, then its head commit is named", async () => {
    const head = "d".repeat(40);
    const { forge } = await fakeGitLab((method, path) => (path === `${PROJECT}/merge_requests/42` ? { status: 200, body: { iid: 42, web_url: "", state: "opened", sha: head } } : undefined));

    expect(await forge.status!(REPO, 42)).toEqual({ status: "open", mergedAt: null, headSha: head });
  });
});

describe("a merge request for a branch a runner pushed", () => {
  const PUSHED = "d".repeat(40);
  const pushed = { title: "Add the pushed skill", body: "Written on the person's machine.", branch: "handbook/pushed", baseSha: BASE, assignment: { reviewers: ["ada"], labels: ["skills"], assignee: "pat" } };
  const withBranch = project((method, path) => (method === "GET" && path === `${PROJECT}/repository/branches/handbook%2Fpushed` ? { status: 200, body: { name: "handbook/pushed", commit: { id: PUSHED } } } : undefined));

  it("given the branch on GitLab, when its request is opened, then a merge request goes from it into the default branch with the team's reviewers, and no commit is written", async () => {
    // given
    const { recorded, forge } = await fakeGitLab(withBranch);

    // when
    const opened = await forge.openForBranch!(REPO, pushed);

    // then
    expect(opened).toEqual({ number: 42, url: "https://gitlab.example.invalid/acme/payments-skills/-/merge_requests/42", branch: "handbook/pushed", headSha: PUSHED });
    expect(recorded.find((r) => r.method === "POST" && r.path === `${PROJECT}/merge_requests`)?.body).toEqual({ source_branch: "handbook/pushed", target_branch: "main", title: "Add the pushed skill", description: "Written on the person's machine.", remove_source_branch: true, labels: "skills", reviewer_ids: [11], assignee_id: 21 });
    expect(recorded.some((r) => r.path.includes("/repository/commits"))).toBe(false);
  });

  it("given the branch the machine named as its target, when its request is opened, then the merge request goes into that branch", async () => {
    // given
    const { recorded, forge } = await fakeGitLab(withBranch);

    // when
    await forge.openForBranch!(REPO, { ...pushed, target: "develop" });

    // then
    expect(recorded.find((r) => r.method === "POST" && r.path === `${PROJECT}/merge_requests`)?.body).toMatchObject({ target_branch: "develop" });
  });

  it("given no such branch on GitLab, when its request is opened, then it is refused and no merge request is asked for", async () => {
    // given
    const { recorded, forge } = await fakeGitLab(project());

    // when
    const opening = forge.openForBranch!(REPO, pushed);

    // then
    await expect(opening).rejects.toThrow("branch handbook/pushed is not in payments-skills; the runner pushes it first");
    expect(recorded.some((r) => r.method === "POST")).toBe(false);
  });
});
