import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Server } from "node:http";
import { expect, test } from "@playwright/test";
import { freePort, portFree } from "../clean-machine.js";
import { OrchestratorClient } from "../client.js";
import { startFakeForge } from "../forge.js";
import { seedTeamRepo } from "../repos.js";
import { labGit } from "../run.js";
import { until } from "../solo.js";
import { lab, readHead, spareOrchestratorPort, startOrchestratorProcess, unique } from "./support.js";
import type { OrchestratorProcess } from "./support.js";

const PROJECT = "team/core-skills";
const REPO = "core-skills";

interface Shown {
  status: string;
  error: string | null;
  requestNumber: number | null;
  request: { branch: string; provider: string; url: string | null } | null;
}

interface StatusRead {
  source: string;
  detail: { status: string; headSha: string; review: { decision: string; approvedBy: string[] }; checks: { state: string; checks: { name: string; state: string }[] } };
  comments: { author: string; body: string; path: string | null }[];
}

/**
 * A team repository on Gitea: connected with a token, its task's request opened there as a pull
 * request, and read back as every forge's is, its review, its checks and what was said on it,
 * through to the merge a person makes on Gitea. The Gitea is the lab's stand-in (lab/forge.ts),
 * started for the scenario alone, its repository served over git's HTTP protocol to the
 * orchestrator's mirror; the orchestrator is one of its own, its agent the lab's fake one.
 */
test.describe("a team repository on Gitea", () => {
  test("given a team repository on Gitea, when an admin connects it with a token and a task runs to review, then the change is a pull request on Gitea on the task's branch, the orchestrator reads it open, a reviewer's approval, a CI run and what was said on it read back, and once a person merges it on Gitea it reads merged", async () => {
    test.setTimeout(300_000);
    // given a Gitea with the team's repository, and an orchestrator that mirrors it from there
    const tenant = unique("gitea-work");
    const dir = join(lab.dir, "gitea-work", tenant);
    const token = `lab-gitea-${randomBytes(12).toString("hex")}`;
    const gitea = `http://127.0.0.1:${await freePort()}`;
    const root = join(dir, "forge");
    const bare = join(root, `${PROJECT}.git`);
    seedTeamRepo(lab.path, { id: REPO, team: "Core", reviewers: [], labels: [], skills: [{ slug: "first-skill", description: "Use when a team works on Gitea.", body: "1. Begin.\n" }] }, bare, `${gitea}/${PROJECT}.git`, join(dir, "scratch"));
    const forge: Server = await startFakeForge({ kind: "gitea", port: Number(new URL(gitea).port), token, root, path: lab.path, projects: [PROJECT], users: ["orchestrator-bot", "rev"], log: join(dir, "forge.log"), scratch: dir });
    const port = spareOrchestratorPort(1);
    // An orchestrator another run left there answers the health check this one waits for, and refuses this run's setup code.
    expect(await portFree(port), `port ${port} is free`).toBe(true);
    const code = unique("setup");
    let orchestrator: OrchestratorProcess | null = null;
    const onGitea = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await fetch(`${gitea}/api/v1/repos/${PROJECT}${path}`, { method, headers: { authorization: `token ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return (await res.json().catch(() => null)) as T;
    };
    const labCall = (path: string, body: unknown) => fetch(`${gitea}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      orchestrator = await startOrchestratorProcess({ port, tenant, dataDir: join(dir, "data"), store: "sqlite", setupCode: code, repos: [{ id: REPO, team: "Core", url: `${gitea}/${PROJECT}.git` }] });
      const admin = await OrchestratorClient.setup(orchestrator.url, code, { email: `admin@${tenant}.example.invalid`, name: "Gitea Admin" }, lab.password);
      await readHead(admin, REPO);

      // when an admin connects it with a token, and a task runs to review
      await admin.ok("PUT", `/api/repos/${REPO}/forge`, { kind: "gitea", apiUrl: `${gitea}/api/v1`, project: PROJECT, token });
      const { task } = await admin.ok<{ task: { id: string } }>("POST", "/api/tasks", { title: unique("Lab task on Gitea"), description: "Add a skill named after this task.", repoId: REPO, agent: "fake" });
      const done = await until(() => admin.ok<{ task: Shown }>("GET", `/api/tasks/${task.id}`).then((r) => r.task), (t) => !["queued", "running"].includes(t.status) && (t.status !== "needs-review" || t.requestNumber !== null), 480);

      // then the change is a pull request on Gitea, on the task's branch, written as one commit on the base
      expect([done.status, done.error, done.request?.provider]).toEqual(["needs-review", null, "gitea"]);
      const number = done.requestNumber!;
      const pull = await onGitea<{ state: string; head: { ref: string; sha: string }; base: { ref: string }; html_url: string; user: { login: string } }>("GET", `/pulls/${number}`);
      expect([pull.state, pull.head.ref, pull.base.ref, done.request?.url]).toEqual(["open", done.request!.branch, "main", pull.html_url]);
      expect(labGit(lab.path, ["rev-list", "--count", `main..${pull.head.ref}`], bare)).toBe("1");
      expect(labGit(lab.path, ["diff", "--name-only", `main...${pull.head.ref}`], bare).split("\n").every((f) => f.startsWith("skills/"))).toBe(true);

      // and the orchestrator reads it open, with nothing said and no review yet
      const read = () => admin.ok<{ status: StatusRead }>("GET", `/api/repos/${REPO}/requests/${number}/status`).then((r) => r.status);
      const first = await read();
      expect([first.source, first.detail.status, first.detail.headSha, first.detail.review.decision]).toEqual(["forge", "open", pull.head.sha, "none"]);

      // when a reviewer approves it on Gitea, CI reports a run on its head, and two things are said on it
      await labCall("/lab/review", { project: PROJECT, number, user: "rev", state: "APPROVED" });
      await labCall("/lab/check", { project: PROJECT, sha: pull.head.sha, name: "lint", state: "success" });
      await labCall("/lab/comment", { project: PROJECT, number, user: "rev", body: "Reads well." });
      await labCall("/lab/comment", { project: PROJECT, number, user: "rev", body: "One word here.", path: "README.md", line: 1 });
      await admin.ok("POST", `/api/repos/${REPO}/requests/${number}/refresh`);

      // then each reads back through the orchestrator
      const reviewed = await until(read, (s) => s.detail.review.decision === "approved" && s.comments.length === 2, 120);
      expect(reviewed.detail.review).toEqual({ decision: "approved", approvedBy: ["rev"] });
      expect(reviewed.detail.checks.checks.map((c) => [c.name, c.state])).toEqual([["lint", "success"]]);
      expect(reviewed.comments.map((c) => [c.author, c.body, c.path]).sort()).toEqual([["rev", "One word here.", "README.md"], ["rev", "Reads well.", null]]);

      // when a person merges it on Gitea
      await onGitea("POST", `/pulls/${number}/merge`, { Do: "merge" });
      await admin.ok("POST", `/api/repos/${REPO}/requests/${number}/refresh`);

      // then it reads merged, and the merge is on the default branch
      expect((await until(read, (s) => s.detail.status === "merged", 120)).detail.status).toBe("merged");
      expect(labGit(lab.path, ["merge-base", "--is-ancestor", pull.head.sha, "main"], bare)).toBe("");
    } finally {
      await orchestrator?.stop();
      await new Promise<void>((resolve) => forge.close(() => resolve()));
    }
  });
});
