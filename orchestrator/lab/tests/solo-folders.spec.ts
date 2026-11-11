import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CleanMachine } from "../clean-machine.js";
import { contents, drawnTaskPage, personsRepository, soloSession, until } from "../solo.js";
import type { SoloSession } from "../solo.js";
import { labDir } from "../state.js";

/**
 * The orchestrator alone on one machine opens any folder of the person's, Git or not, and the
 * first task's outcome follows what the folder is: a folder with no Git gets Review changes on
 * the files the agent edited in place, a Git repository with no origin gets a request on a branch
 * in it, and one whose origin is on GitHub or GitLab gets that request with the forge's create
 * link when no gh or glab is signed in. The steps drive the routes the first screen calls, and each
 * task's page is then opened in the browser, so a page that breaks while drawing what the task did
 * fails here. The machine is the solo scenarios' clean one (lab/clean-machine.ts), its agent the
 * stand-in claude.
 */

interface Opened {
  project: { id: string; name: string; facts: { git: "none" | "repo" | "origin"; origin: { forge: string; web: string } | null; kind: string } };
  existing: boolean;
}

interface Done {
  status: string;
  error: string | null;
  requestNumber: number | null;
  request: { branch: string } | null;
  result: "request" | "changes" | null;
  changes: { files: { path: string }[]; undone: { kept: string[] } | null } | null;
}

const TITLE = "Expose the delivery-window endpoint";

const git = (machine: CleanMachine, cwd: string, args: string[]) => {
  const done = spawnSync("git", args, { cwd, env: machine.env, encoding: "utf8" });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${done.stderr}`);
  return done.stdout.trim();
};

/** A task asking the stand-in agent for one endpoint, followed until it waits for review with its request recorded or its changes made in place, or ends otherwise. */
async function endpointTask(solo: SoloSession, projectId: string): Promise<{ id: string; done: Done }> {
  const { task } = await solo.call<{ task: { id: string } }>("POST", "/api/tasks", { title: TITLE, description: "", repoId: projectId, agent: "claude-code" });
  const done = await until(() => solo.call<{ task: Done }>("GET", `/api/tasks/${task.id}`).then((r) => r.task), (t) => !["queued", "running"].includes(t.status) && (t.status !== "needs-review" || t.requestNumber !== null || t.result === "changes"), 2400);
  return { id: task.id, done };
}

/** The task's page on the person's own orchestrator, under the organization it signs them in to. */
async function taskPage(solo: SoloSession, id: string): Promise<void> {
  await solo.page.goto(solo.base);
  await solo.page.waitForURL(/\/activity$/);
  const org = new URL(solo.page.url()).pathname.split("/")[1]!;
  await drawnTaskPage(solo.page, `${solo.base}/${org}/tasks/${id}`, TITLE);
}

const dataDirOf = (home: string) => (process.platform === "darwin" ? join(home, "Library", "Application Support", "TeamHandbook Orchestrator") : join(home, ".local", "share", "teamhandbook-orchestrator"));

const stamp = (what: string) => join(labDir(), "solo-folders", `${what}-${Date.now().toString(36)}`);

test.describe("the orchestrator alone opens a folder of the person's", () => {
  test("given a folder of the person's with no Git, when they open it and start a task, then the agent edits its files in place, the task's page draws Review changes with each changed file and its diff, the folder holds no .git and its history is in the data directory, and Undo on that page puts the folder back byte for byte", async ({ page }) => {
    test.setTimeout(600_000);
    // given a clean machine and a folder of the person's with no .git
    const solo = await soloSession(page, stamp("no-git"));
    try {
      const folder = join(solo.machine.home, "work", "notes");
      mkdirSync(join(folder, "src", "endpoints"), { recursive: true });
      writeFileSync(join(folder, "README.md"), "# notes\n\nAnswers the notes calls, an endpoint per call under src/endpoints/.\n");
      writeFileSync(join(folder, "src", "endpoints", "status.ts"), 'export const status = { method: "GET", path: "/status" };\n');
      const before = contents(folder);

      // when they open it and start a task there
      const { project } = await solo.call<Opened>("POST", "/api/projects", { path: folder });
      const { id, done } = await endpointTask(solo, project.id);

      // then the agent changed the folder itself and the task ends at its changes
      expect(project.facts.git).toBe("none");
      expect([done.status, done.error, done.result, done.requestNumber]).toEqual(["needs-review", null, "changes", null]);
      expect(done.changes?.files.map((f) => f.path)).toEqual(["src/endpoints/delivery-window.ts"]);
      expect(readFileSync(join(folder, "src", "endpoints", "delivery-window.ts"), "utf8")).toContain('path: "/delivery-window"');
      expect(existsSync(join(folder, ".git"))).toBe(false);
      const shadow = join(dataDirOf(solo.machine.home), "shadow");
      expect(readdirSync(shadow).some((tenant) => existsSync(join(shadow, tenant, project.id, "HEAD")))).toBe(true);

      // and its page draws Review changes with the changed file and its diff
      await taskPage(solo, id);
      const review = solo.page.getByRole("region", { name: /Changes in this folder/ });
      await expect(review.locator("ul.diff-files > li")).toHaveCount(1);
      const file = review.locator("ul.diff-files > li summary", { hasText: "src/endpoints/delivery-window.ts" });
      await file.click();
      await expect(review.locator("ul.diff-files > li")).toContainText('path: "/delivery-window"');
      await expect(review.getByRole("button", { name: "Make this a Git repository" })).toBeVisible();

      // when they press Undo on that page and confirm
      await review.getByRole("button", { name: "Undo these changes…" }).click();
      await solo.page.getByRole("button", { name: "Undo changes" }).click();

      // then the page says it was undone, and the folder is byte for byte as it was before the task
      await expect(review.getByText(/^Undone by /)).toBeVisible();
      expect(contents(folder)).toEqual(before);
      const after = await solo.call<{ task: Done }>("GET", `/api/tasks/${id}`);
      expect(after.task.changes?.undone).toEqual(expect.objectContaining({ kept: [] }));
    } finally {
      await solo.stop();
    }
  });

  test("given a folder with no Git holding a file that looks like a secret, when the person makes it a Git repository, then that one call only starts the repository, the first commit is asked with a message written for them to change, it offers the secret-looking file unticked, the commit they make leaves it out, and the next task ends at a request on a branch in it", async ({ page }) => {
    test.setTimeout(600_000);
    // given
    const solo = await soloSession(page, stamp("make-it-git"));
    try {
      const folder = join(solo.machine.home, "work", "tracking");
      mkdirSync(join(folder, "src", "endpoints"), { recursive: true });
      writeFileSync(join(folder, "README.md"), "# tracking\n\nAnswers the tracking calls, an endpoint per call under src/endpoints/.\n");
      writeFileSync(join(folder, "src", "endpoints", "status.ts"), 'export const status = { method: "GET", path: "/status" };\n');
      writeFileSync(join(folder, ".env"), "GITLAB_TOKEN=glpat-AbCdEfGhIjKlMnOpQrSt\n");
      const { project } = await solo.call<Opened>("POST", "/api/projects", { path: folder });
      expect(project.facts.git).toBe("none");

      // when the person makes it a Git repository
      const made = await solo.call<Opened>("POST", `/api/projects/${project.id}/git/init`, { commandId: "make-it-git-1" });

      // then it is a repository with no commit yet, and the first commit is asked with a message written for them
      expect(made.project.facts.git).toBe("repo");
      expect(spawnSync("git", ["-C", folder, "rev-parse", "--verify", "--quiet", "HEAD"], { env: solo.machine.env }).status).not.toBe(0);
      const asked = await solo.call<{ files: { path: string; secretLike: boolean }[]; first: boolean; message: string }>("GET", `/api/projects/${project.id}/git/commit`);
      expect([asked.first, asked.message]).toEqual([true, `Start ${project.name}`]);
      expect(asked.files.find((f) => f.path === ".env")?.secretLike).toBe(true);
      expect(asked.files.filter((f) => f.path !== ".env").every((f) => !f.secretLike)).toBe(true);

      // when they change the message and commit with the secret-looking file left out
      const committed = await solo.call<{ headSha: string }>("POST", `/api/projects/${project.id}/git/commit`, { commandId: "make-it-git-2", message: "Track the shipments", exclude: [".env"] });

      // then one commit holds the folder's files with that message, the secret-looking file not among them
      expect(git(solo.machine, folder, ["rev-parse", "HEAD"])).toBe(committed.headSha);
      expect(git(solo.machine, folder, ["log", "--format=%s"])).toBe("Track the shipments");
      expect(git(solo.machine, folder, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").sort()).toEqual(["README.md", "src/endpoints/status.ts"]);

      // when they start a task there
      const { id, done } = await endpointTask(solo, project.id);

      // then it ends at a request on a branch in the folder's repository, and its page draws
      expect([done.status, done.error]).toEqual(["needs-review", null]);
      await taskPage(solo, id);
      expect(git(solo.machine, folder, ["show", `${done.request!.branch}:src/endpoints/delivery-window.ts`])).toContain('path: "/delivery-window"');
    } finally {
      await solo.stop();
    }
  });

  test("given a Git repository of the person's with no origin, when they open it and start a task, then it is a repository with no origin, the task's branch is in it with the change, the request is recorded and waits for review, and the person's checkout is as it was", async ({ page }) => {
    test.setTimeout(600_000);
    // given
    const solo = await soloSession(page, stamp("no-origin"));
    try {
      const repo = personsRepository(solo.machine);
      const head = git(solo.machine, repo, ["rev-parse", "HEAD"]);

      // when
      const { project } = await solo.call<Opened>("POST", "/api/projects", { path: repo });
      const { id, done } = await endpointTask(solo, project.id);

      // then
      expect([project.facts.git, project.facts.origin]).toEqual(["repo", null]);
      await taskPage(solo, id);
      expect([done.status, done.error]).toEqual(["needs-review", null]);
      expect(done.requestNumber).not.toBeNull();
      expect(git(solo.machine, repo, ["show", `${done.request!.branch}:src/endpoints/delivery-window.ts`])).toContain('path: "/delivery-window"');
      expect([git(solo.machine, repo, ["rev-parse", "--abbrev-ref", "HEAD"]), git(solo.machine, repo, ["rev-parse", "HEAD"]), git(solo.machine, repo, ["status", "--porcelain"])]).toEqual(["main", head, ""]);
    } finally {
      await solo.stop();
    }
  });

  test("given a Git repository of the person's whose origin is on GitLab and no glab on the machine, when they open it and start a task, then GitLab is told from the origin without a question, the request is recorded here, and the task says it was not opened on GitLab with the link that opens it there", async ({ page }) => {
    test.setTimeout(600_000);
    // given an origin the orchestrator reads from the folder's own config and reaches for nothing on, with no glab to push through
    const solo = await soloSession(page, stamp("gitlab-origin"));
    try {
      const repo = personsRepository(solo.machine);
      git(solo.machine, repo, ["remote", "add", "origin", "https://gitlab.com/solo-person/delivery-service.git"]);

      // when
      const { project } = await solo.call<Opened>("POST", "/api/projects", { path: repo });
      const { id, done } = await endpointTask(solo, project.id);
      // The line about the origin is written once the request is recorded, a moment after the task waits for review.
      const said = (t: string) => t.startsWith("Not opened on the repository's forge:");
      const { log } = await until(() => solo.call<{ log: { text: string }[] }>("GET", `/api/tasks/${id}`), (r) => r.log.some((l) => said(l.text)), 120);

      // then
      expect(project.facts).toMatchObject({ git: "origin", origin: { forge: "gitlab" } });
      expect([done.status, done.error]).toEqual(["needs-review", null]);
      expect(done.requestNumber).not.toBeNull();
      const told = log.map((l) => l.text).find(said) ?? "";
      expect(told).toContain("glab is not installed on this machine");
      const link = new URL(/Open it there: (\S+)$/.exec(told)?.[1] ?? "https://link.example.invalid");
      expect(`${link.origin}${link.pathname}`).toBe("https://gitlab.com/solo-person/delivery-service/-/merge_requests/new");
      expect([link.searchParams.get("merge_request[source_branch]"), link.searchParams.get("merge_request[target_branch]")]).toEqual([done.request!.branch, "main"]);
      await taskPage(solo, id);
    } finally {
      await solo.stop();
    }
  });

  test("given folders no project opens, when the person asks for each by its path and the folder list is asked under them, then the home itself, a folder outside it, a link under the home that leads out of it, ~/Library and the orchestrator's own data are each refused with why, the list answers 400 under a dot folder or a path with .., and lists none of them", async ({ page }) => {
    test.setTimeout(300_000);
    // given
    const solo = await soloSession(page, stamp("refused"));
    try {
      const home = solo.machine.home;
      const outside = join(home, "..", "outside");
      mkdirSync(outside, { recursive: true });
      mkdirSync(join(home, ".ssh"), { recursive: true });
      mkdirSync(join(home, "Library", "Notes"), { recursive: true });
      mkdirSync(join(home, "work", "kept"), { recursive: true });
      symlinkSync(outside, join(home, "escape"));
      const dataDir = dataDirOf(home);

      // when
      const opened = async (path: string) => {
        const { status, json } = await solo.ask<{ error?: string; code?: string }>("POST", "/api/projects", { path });
        return [status, json.code, Boolean(json.error)];
      };
      const answers = {
        home: await opened(home),
        outside: await opened(outside),
        escape: await opened(join(home, "escape")),
        library: await opened(join(home, "Library", "Notes")),
        data: await opened(dataDir),
      };
      const underDot = await solo.ask("GET", `/api/local/folders?under=${encodeURIComponent(join(home, ".ssh"))}`);
      const climbing = await solo.ask("GET", `/api/local/folders?under=${encodeURIComponent(`${home}/work/../..`)}`);
      const listed = await solo.call<{ folders: { name: string; path: string }[]; suggestions: { path: string }[] }>("GET", "/api/local/folders");

      // then
      expect(answers).toEqual({
        home: [400, "home-itself", true],
        outside: [400, "outside-home", true],
        escape: [400, "outside-home", true],
        library: [400, "library", true],
        data: [400, expect.stringMatching(/^(library|data-dir|hidden)$/), true],
      });
      expect([underDot.status, climbing.status]).toEqual([400, 400]);
      const shown = [...listed.folders, ...listed.suggestions].map((f) => f.path);
      expect(listed.folders.map((f) => f.name)).toContain("work");
      for (const path of shown) {
        expect(path.startsWith(home), path).toBe(true);
        expect(path.slice(home.length + 1).split("/").some((part) => part.startsWith(".") || part === "Library"), path).toBe(false);
      }
      expect(listed.folders.map((f) => f.name)).not.toContain("escape");
    } finally {
      await solo.stop();
    }
  });
});
