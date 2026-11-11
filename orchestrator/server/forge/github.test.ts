import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoRecord } from "../store.js";
import { createGitHubForge } from "./github.js";
import type { ChangeRequest } from "./types.js";

const TOKEN = "ghp_Qa1Ws2Ed3Rf4Tg5Yh6Uj7Ik8Ol9P0";
const BASE = "b".repeat(40);

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

/** A GitHub that records every request it receives and answers from `routes`; anything unrouted is a 404. */
async function fakeGitHub(routes: (method: string, path: string, body: unknown) => Answer | undefined) {
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
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { recorded, forge: createGitHubForge({ repoId: "payments-skills", kind: "github", apiUrl, project: "acme/payments-skills" }, TOKEN) };
}

const R = "/repos/acme/payments-skills";
const COMMIT = "c".repeat(40);

function repository(extra: (method: string, path: string, body: unknown) => Answer | undefined = () => undefined) {
  return (method: string, path: string, body: unknown): Answer | undefined => {
    const override = extra(method, path, body);
    if (override) return override;
    if (method === "GET" && path === R) return { status: 200, body: { default_branch: "trunk" } };
    if (method === "GET" && path === `${R}/git/commits/${BASE}`) return { status: 200, body: { sha: BASE, tree: { sha: "t-base" } } };
    if (method === "POST" && path === `${R}/git/trees`) return { status: 201, body: { sha: "t-new" } };
    if (method === "POST" && path === `${R}/git/commits`) return { status: 201, body: { sha: COMMIT } };
    if (method === "POST" && path === `${R}/git/refs`) return { status: 201, body: { ref: "refs/heads/handbook/on-call-handover" } };
    if (method === "POST" && path === `${R}/pulls`) return { status: 201, body: { number: 9, html_url: "https://github.example.invalid/acme/payments-skills/pull/9" } };
    if (method === "POST" && path === `${R}/pulls/9/requested_reviewers`) return { status: 201, body: {} };
    if (method === "POST" && path === `${R}/issues/9/labels`) return { status: 200, body: [] };
    if (method === "POST" && path === `${R}/issues/9/assignees`) return { status: 201, body: {} };
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
      { path: "skills/old/SKILL.md", content: null },
    ],
    author: { name: "Ada Example", email: "ada@example.invalid" },
    assignment: { reviewers: ["ada", "grace"], labels: ["skills"], assignee: "pat" },
    ...overrides,
  };
}

function bodyOf(recorded: Recorded[], method: string, path: string): unknown {
  return recorded.find((r) => r.method === method && r.path === path)?.body;
}

describe("the GitHub forge", () => {
  it("given a commit body apart from the description, when the change is opened, then the commit carries only it and the pull request the description", async () => {
    // given
    const { recorded, forge } = await fakeGitHub(repository());

    // when
    await forge.open(REPO, change({ body: "The agent's report: Closes #1", commitBody: "Opened by the orchestrator." }));

    // then
    expect((bodyOf(recorded, "POST", `${R}/git/commits`) as { message: string }).message).toBe("feat(skill): add on-call-handover\n\nOpened by the orchestrator.");
    expect((bodyOf(recorded, "POST", `${R}/pulls`) as { body: string }).body).toBe("The agent's report: Closes #1");
  });

  it("given a change, when it is opened, then a tree on the base commit's tree, a commit by the requester, a branch ref and a pull request into the default branch are created", async () => {
    // given
    const { recorded, forge } = await fakeGitHub(repository());

    // when
    const opened = await forge.open(REPO, change());

    // then
    expect(opened).toEqual({ number: 9, url: "https://github.example.invalid/acme/payments-skills/pull/9", branch: "handbook/on-call-handover", headSha: COMMIT });
    expect(bodyOf(recorded, "POST", `${R}/git/trees`)).toEqual({
      base_tree: "t-base",
      tree: [
        { path: "skills/on-call-handover/SKILL.md", mode: "100644", type: "blob", content: "---\nname: on-call-handover\n---\n" },
        { path: "skills/old/SKILL.md", mode: "100644", type: "blob", sha: null },
      ],
    });
    expect(bodyOf(recorded, "POST", `${R}/git/commits`)).toEqual({
      message: "feat(skill): add on-call-handover\n\nProposed from the orchestrator.",
      tree: "t-new",
      parents: [BASE],
      author: { name: "Ada Example", email: "ada@example.invalid" },
    });
    expect(bodyOf(recorded, "POST", `${R}/git/refs`)).toEqual({ ref: "refs/heads/handbook/on-call-handover", sha: COMMIT });
    expect(bodyOf(recorded, "POST", `${R}/pulls`)).toEqual({ title: "feat(skill): add on-call-handover", head: "handbook/on-call-handover", base: "trunk", body: "Proposed from the orchestrator." });
    expect(recorded.some((r) => r.method !== "GET" && /\/git\/refs\/heads\/trunk/.test(r.path))).toBe(false);
  });

  it("given the team's reviewers, labels and the requester's login, when the request is opened, then each is sent to its own endpoint", async () => {
    // given
    const { recorded, forge } = await fakeGitHub(repository());

    // when
    await forge.open(REPO, change());

    // then
    expect(bodyOf(recorded, "POST", `${R}/pulls/9/requested_reviewers`)).toEqual({ reviewers: ["ada", "grace"] });
    expect(bodyOf(recorded, "POST", `${R}/issues/9/labels`)).toEqual({ labels: ["skills"] });
    expect(bodyOf(recorded, "POST", `${R}/issues/9/assignees`)).toEqual({ assignees: ["pat"] });
  });

  it("given a reviewer GitHub refuses, when the change is opened, then the pull request is still returned with a note", async () => {
    // given
    const { forge } = await fakeGitHub(
      repository((method, path) =>
        path === `${R}/pulls/9/requested_reviewers` ? { status: 422, body: { message: "Review requests go to collaborators only." } } : undefined,
      ),
    );

    // when
    const opened = await forge.open(REPO, change());

    // then
    expect(opened.number).toBe(9);
    expect(opened.notes).toEqual(["reviewers were not added: GitHub answered 422 on POST /repos/acme/payments-skills/pulls/9/requested_reviewers: Review requests go to collaborators only."]);
  });

  it("given any request the forge receives, when it is recorded, then the token sits in the bearer header and in no path or body", async () => {
    // given
    const { recorded, forge } = await fakeGitHub(repository());

    // when
    await forge.open(REPO, change());

    // then
    expect(recorded.length).toBeGreaterThan(5);
    for (const r of recorded) {
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.headers["x-github-api-version"]).toBe("2022-11-28");
      expect(r.path).not.toContain(TOKEN);
      expect(JSON.stringify(r.body ?? "")).not.toContain(TOKEN);
    }
  });

  it("given GitHub refuses the token and echoes it back, when the change is opened, then the error names the status and not the token", async () => {
    // given
    const { forge } = await fakeGitHub(() => ({ status: 401, body: { message: `Bad credentials for ${TOKEN}` } }));

    // when
    const error = await forge.open(REPO, change()).catch((e: Error) => e);

    // then
    expect((error as Error).message).toBe("GitHub answered 401 on GET /repos/acme/payments-skills: Bad credentials for ***");
  });

  it("given a branch name GitHub already has, when a change asks for it, then it is refused before any tree or commit is written", async () => {
    // given
    const { recorded, forge } = await fakeGitHub(
      repository((method, path) => (method === "GET" && path === `${R}/git/ref/heads/handbook/on-call-handover` ? { status: 200, body: { ref: "refs/heads/handbook/on-call-handover" } } : undefined)),
    );

    // when
    const attempt = forge.open(REPO, change());

    // then
    await expect(attempt).rejects.toThrow("branch handbook/on-call-handover already exists in payments-skills");
    expect(recorded.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it.each([
    ["GitHub takes the branch back", { status: 204, body: {} }, "the branch was removed again"],
    ["GitHub refuses to take it back", { status: 403, body: { message: "Forbidden" } }, "the branch stayed on GitHub: handbook/on-call-handover"],
  ])("given a pull request GitHub refuses to open and %s, when the change is opened, then the error says what became of the branch", async (_label, deletion, said) => {
    // given
    const { recorded, forge } = await fakeGitHub(
      repository((method, path) => {
        if (method === "POST" && path === `${R}/pulls`) return { status: 500, body: { message: "Server Error" } };
        if (method === "DELETE" && path === `${R}/git/refs/heads/handbook/on-call-handover`) return deletion;
        return undefined;
      }),
    );

    // when
    const attempt = forge.open(REPO, change());

    // then
    await expect(attempt).rejects.toThrow(`the request was not opened: GitHub answered 500 on POST ${R}/pulls: Server Error; ${said}; try again`);
    expect(recorded.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([`${R}/git/refs/heads/handbook/on-call-handover`]);
  });

  it("given a branch that already exists, when the ref is created, then the change is refused and no pull request is opened", async () => {
    // given
    const { recorded, forge } = await fakeGitHub(
      repository((method, path) => (method === "POST" && path === `${R}/git/refs` ? { status: 422, body: { message: "Reference already exists" } } : undefined)),
    );

    // when
    const attempt = forge.open(REPO, change());

    // then
    await expect(attempt).rejects.toThrow(/already exists/);
    expect(recorded.some((r) => r.path === `${R}/pulls`)).toBe(false);
  });

  it.each([
    [{ state: "open", merged: false }, "open"],
    [{ state: "closed", merged: true, merged_at: "2026-10-20T07:30:00Z" }, "merged"],
    [{ state: "closed", merged: false }, "closed"],
  ])("given a pull request reading %j, when its status is read, then the orchestrator calls it %s", async (pull, expected) => {
    // given
    const { forge } = await fakeGitHub((method, path) => (path === `${R}/pulls/9` ? { status: 200, body: pull } : undefined));

    // when
    const { status, mergedAt } = await forge.status!(REPO, 9);

    // then
    expect(status).toBe(expected);
    expect(mergedAt).toBe(expected === "merged" ? "2026-10-20T07:30:00.000Z" : null);
  });
});

describe("what waits to be merged on GitHub", () => {
  it("given open pull requests, when they are listed, then each comes back with its number, branch, author and link, and a link that is not http(s) is dropped", async () => {
    // given
    const { forge, recorded } = await fakeGitHub((method, path) =>
      method === "GET" && path === `${R}/pulls?state=open&sort=updated&direction=desc&per_page=50`
        ? {
            status: 200,
            body: [
              { number: 12, title: "feat(skill): add on-call", head: { ref: "team/on-call", repo: { id: 5 } }, base: { repo: { id: 5 } }, html_url: "https://github.com/acme/payments-skills/pull/12", user: { login: "grace" }, updated_at: "2026-10-24T09:00:00Z" },
              { number: 13, title: "x", head: { ref: "y", repo: { id: 66 } }, base: { repo: { id: 5 } }, html_url: "data:text/html,hi", user: { login: "mallory" }, updated_at: "2026-10-23T09:00:00Z" },
              { number: 14, title: "z", head: { ref: "z", repo: null }, base: { repo: { id: 5 } }, html_url: "https://github.com/acme/payments-skills/pull/14", user: { login: "gone" }, updated_at: "2026-10-22T09:00:00Z" },
            ],
          }
        : undefined,
    );

    // when
    const pending = await forge.list!(REPO);

    // then
    expect(pending).toEqual([
      { number: 12, title: "feat(skill): add on-call", branch: "team/on-call", url: "https://github.com/acme/payments-skills/pull/12", author: "grace", updatedAt: "2026-10-24T09:00:00Z", fromFork: false },
      { number: 13, title: "x", branch: "y", url: null, author: "mallory", updatedAt: "2026-10-23T09:00:00Z", fromFork: true },
      { number: 14, title: "z", branch: "z", url: "https://github.com/acme/payments-skills/pull/14", author: "gone", updatedAt: "2026-10-22T09:00:00Z", fromFork: true },
    ]);
    expect(recorded[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("a check's outcome on a commit", () => {
  it("given a review's verdict, when it is written, then GitHub gets a commit status named for the check, with the description cut to its limit, and nothing else", async () => {
    // given
    const sha = "d".repeat(40);
    const { recorded, forge } = await fakeGitHub((method, path) => (method === "POST" && path === `${R}/statuses/${sha}` ? { status: 201, body: {} } : undefined));

    // when
    await forge.setCommitStatus!(sha, { state: "failure", context: "teamhandbook/review-rules", description: "x".repeat(200) });

    // then
    expect(recorded.map((r) => [r.method, r.path])).toEqual([["POST", `${R}/statuses/${sha}`]]);
    expect(recorded[0]!.body).toEqual({ state: "failure", context: "teamhandbook/review-rules", description: "x".repeat(140) });
  });
});

describe("a new commit on a pull request's branch", () => {
  const update = (expectedHead = BASE) => ({ files: [{ path: "README.md", content: "skills, revised\n" }], title: "Address the review", commitBody: "Asked in review.", author: { name: "Ada Example", email: "ada@example.invalid" }, expectedHead });
  const at = (head: string, patch: Answer = { status: 200, body: {} }) => (method: string, path: string) =>
    method === "GET" && path === `${R}/git/ref/heads/handbook/on-call-handover` ? { status: 200, body: { object: { sha: head } } } : method === "PATCH" && path === `${R}/git/refs/heads/handbook/on-call-handover` ? patch : undefined;

  it("given the branch still at the head the change was prepared on, when it is updated, then a commit on that head moves the branch forward without force", async () => {
    const { recorded, forge } = await fakeGitHub(repository(at(BASE)));

    expect(await forge.updateBranch!(REPO, "handbook/on-call-handover", update())).toEqual({ headSha: COMMIT });
    expect(recorded.find((r) => r.path === `${R}/git/commits`)!.body).toMatchObject({ message: "Address the review\n\nAsked in review.", parents: [BASE] });
    expect(recorded.find((r) => r.method === "PATCH")!.body).toEqual({ sha: COMMIT, force: false });
  });

  it("given a branch that moved since, when it is updated, then it is refused before anything is written, and GitHub refusing the move is refused the same way", async () => {
    const moved = await fakeGitHub(repository(at("d".repeat(40))));
    const raced = await fakeGitHub(repository(at(BASE, { status: 422, body: { message: "Update is not a fast forward" } })));

    await expect(moved.forge.updateBranch!(REPO, "handbook/on-call-handover", update())).rejects.toThrow(/moved since the change was prepared/);
    expect(moved.recorded.some((r) => r.method === "POST" || r.method === "PATCH")).toBe(false);
    await expect(raced.forge.updateBranch!(REPO, "handbook/on-call-handover", update())).rejects.toThrow(/moved since the change was prepared/);
  });
});

describe("the head a pull request's status names", () => {
  it("given a pull request whose head is a full commit, or something else, when its status is read, then the commit is named and anything else is left out", async () => {
    const { forge } = await fakeGitHub((method, path) => (path === `${R}/pulls/9` ? { status: 200, body: { state: "open", merged: false, head: { sha: COMMIT } } } : path === `${R}/pulls/10` ? { status: 200, body: { state: "open", merged: false, head: { sha: "not-a-sha" } } } : undefined));

    expect(await forge.status!(REPO, 9)).toEqual({ status: "open", mergedAt: null, headSha: COMMIT });
    expect(await forge.status!(REPO, 10)).toEqual({ status: "open", mergedAt: null });
  });
});

describe("a pull request for a branch a runner pushed", () => {
  const PUSHED = "d".repeat(40);
  const pushed = { title: "Add the pushed skill", body: "Written on the person's machine.", branch: "handbook/pushed", baseSha: BASE, assignment: { reviewers: ["ada"], labels: ["skills"], assignee: "pat" } };
  const withBranch = repository((method, path) => (method === "GET" && path === `${R}/git/ref/heads/handbook/pushed` ? { status: 200, body: { object: { sha: PUSHED } } } : undefined));

  it("given the branch on GitHub, when its request is opened, then a pull request goes from it into the default branch with the team's reviewers, and nothing is written to the branch", async () => {
    // given
    const { recorded, forge } = await fakeGitHub(withBranch);

    // when
    const opened = await forge.openForBranch!(REPO, pushed);

    // then
    expect(opened).toEqual({ number: 9, url: "https://github.example.invalid/acme/payments-skills/pull/9", branch: "handbook/pushed", headSha: PUSHED });
    expect(bodyOf(recorded, "POST", `${R}/pulls`)).toEqual({ title: "Add the pushed skill", head: "handbook/pushed", base: "trunk", body: "Written on the person's machine." });
    expect(bodyOf(recorded, "POST", `${R}/pulls/9/requested_reviewers`)).toEqual({ reviewers: ["ada"] });
    expect(recorded.filter((r) => r.path.includes("/git/") && r.method !== "GET")).toEqual([]);
  });

  it("given the branch the machine named as its target, when its request is opened, then the pull request goes into that branch without asking for the default", async () => {
    // given
    const { recorded, forge } = await fakeGitHub(withBranch);

    // when
    await forge.openForBranch!(REPO, { ...pushed, target: "develop" });

    // then
    expect(bodyOf(recorded, "POST", `${R}/pulls`)).toMatchObject({ base: "develop" });
    expect(recorded.some((r) => r.method === "GET" && r.path === R)).toBe(false);
  });

  it("given no such branch on GitHub, when its request is opened, then it is refused and no pull request is asked for", async () => {
    // given
    const { recorded, forge } = await fakeGitHub(repository());

    // when
    const opening = forge.openForBranch!(REPO, pushed);

    // then
    await expect(opening).rejects.toThrow("branch handbook/pushed is not in payments-skills; the runner pushes it first");
    expect(recorded.some((r) => r.method === "POST")).toBe(false);
  });
});
