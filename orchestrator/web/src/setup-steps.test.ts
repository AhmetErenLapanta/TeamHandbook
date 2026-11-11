import { describe, expect, it } from "vitest";
import type { ActivitySummary, ForgeCard, OwnCli, RepoRecord, TaskRecord } from "./api";
import { cloudSteps, ownForge, soloSteps } from "./setup-steps";
import { shownStatus, STATUS_TEXT } from "./Tasks";

const summary = (over: Partial<ActivitySummary> = {}): ActivitySummary => ({
  repos: 0,
  requests: { open: 0, merged: 0, closed: 0 },
  members: 1,
  usage: { days: 30, total: 0, top: [] },
  tasks: { total: 0, recent: [] },
  forges: { hosted: 0, connected: 0 },
  tracker: false,
  ...over,
});

describe("a team's steps", () => {
  it("given a new team's orchestrator, when its steps are checked, then the welcome's four come first and proposing and merging still close the list", () => {
    // when
    const steps = cloudSteps("acme", summary(), undefined);

    // then
    expect(steps.map((s) => s.id)).toEqual(["forge", "repo", "members", "start", "propose", "merge"]);
    expect(steps.filter((s) => s.required).map((s) => s.id)).toEqual(["forge", "repo", "members", "propose", "merge"]);
    expect(steps.find((s) => s.id === "forge")?.to).toBe("/acme/welcome?step=forge");
    expect(steps.find((s) => s.id === "start")).toMatchObject({ to: "/acme/work", action: "Open Work" });
  });

  it("given a repository connected with a token, teammates and a connected tracker, when checked, then the forge, the repository, the team and the first work are done", () => {
    // given
    const set = summary({ repos: 1, members: 2, forges: { hosted: 1, connected: 1 }, tracker: true });

    // when
    const steps = cloudSteps("acme", set, "payments-skills");

    // then
    expect(steps.filter((s) => s.done).map((s) => s.id)).toEqual(["forge", "repo", "members", "start"]);
    expect(steps.find((s) => s.id === "propose")?.to).toBe("/acme/repositories/payments-skills");
  });
});

describe("one person's orchestrator on their own machine", () => {
  const project = (kind: "skills" | "code") => ({ id: kind, name: kind, kind, configured: true }) as RepoRecord;
  const none = { done: false, detail: "" };

  it("given nothing opened yet, when the steps are read, then two are required and lead to the welcome, a folder and the first task, and the team's skills, GitHub or GitLab and Jira are optional, with no organization, invitation or agent step", () => {
    // when
    const steps = soloSteps("me", summary(), [], none, false);

    // then
    expect(steps.map((s) => [s.id, s.required, s.done])).toEqual([["repo", true, false], ["task", true, false], ["team-skills", false, false], ["forge", false, false], ["tracker", false, false]]);
    expect(steps.map((s) => s.to)).toEqual(["/me/welcome", "/me/welcome", "/me/repositories?connect=path", "/me/integrations?open=github", "/me/integrations?open=jira"]);
    expect(steps.map((s) => `${s.title} ${s.detail}`).join(" ")).not.toMatch(/repositor|request|branch|\bgit\b/i);
  });

  it("given a project and a task, when the steps are read, then both are done and the team's skills wait until a folder of them is open", () => {
    // when
    const steps = soloSteps("me", summary({ repos: 1, tasks: { total: 1, recent: [] } }), [project("code")], none, false);

    // then
    expect(steps.filter((s) => s.done).map((s) => s.id)).toEqual(["repo", "task"]);
  });

  it("given a folder recognised as team skills, when the steps are read, then adding the team's skills is done", () => {
    // when
    const steps = soloSteps("me", summary({ repos: 1 }), [project("skills")], none, false);

    // then
    expect(steps.find((s) => s.id === "team-skills")?.done).toBe(true);
  });

  it("given a tracker connected by token, or Jira signed in through its card, when the steps are read, then connecting Jira is done either way", () => {
    // when
    const byToken = soloSteps("me", summary({ tracker: true }), [], none, false);
    const signedIn = soloSteps("me", summary(), [], none, true);

    // then
    expect(byToken.find((s) => s.id === "tracker")?.done).toBe(true);
    expect(signedIn.find((s) => s.id === "tracker")?.done).toBe(true);
  });

  it("given gh or glab signed in on this machine, when the steps are read, then connecting GitHub or GitLab is done", () => {
    // when
    const steps = soloSteps("me", summary(), [], { done: true, detail: "Signed in with gh." }, false);

    // then
    expect(steps.find((s) => s.id === "forge")).toMatchObject({ done: true, detail: "Signed in with gh." });
  });
});

describe("one person's own gh or glab", () => {
  const card = (id: "github" | "gitlab", ownCli: Partial<OwnCli> | null, state: "off" | "connected" = "off") =>
    ({ id, state, enabledBy: null, enabledAt: null, repos: [], connection: null, ownCli: ownCli && { tool: id === "github" ? "gh" : "glab", name: id, host: `${id}.com`, installed: false, signedIn: false, account: null, install: "", login: id === "github" ? "gh auth login" : "glab auth login", repos: [], ...ownCli } }) as ForgeCard;

  it("given gh signed in and glab missing, when read, then it is done and says gh is signed in", () => {
    // when
    const own = ownForge([card("gitlab", {}), card("github", { installed: true, signedIn: true })]);

    // then
    expect(own).toEqual({ done: true, detail: "Signed in with gh." });
  });

  it("given gh signed in as a login the CLI names, when read, then it says who it is signed in as", () => {
    // when
    const own = ownForge([card("github", { installed: true, signedIn: true, account: "ada-example" })]);

    // then
    expect(own).toEqual({ done: true, detail: "Signed in as ada-example with gh." });
  });

  it("given gh installed but signed out, when read, then it is not done and gives the command to run", () => {
    // when
    const own = ownForge([card("github", { installed: true })]);

    // then
    expect(own).toEqual({ done: false, detail: "Run gh auth login in a terminal on this machine." });
  });

  it("given neither installed, when read, then it says to install the first and sign in", () => {
    // when
    const own = ownForge([card("github", {}), card("gitlab", {})]);

    // then
    expect(own).toEqual({ done: false, detail: "Install gh, then run gh auth login." });
  });

  it("given a GitHub card connected another way, when read, then it is done", () => {
    // when
    const own = ownForge([card("github", null, "connected")]);

    // then
    expect(own.done).toBe(true);
  });
});

describe("a recent task's status on Activity", () => {
  const recent = (patch: Partial<ActivitySummary["tasks"]["recent"][number]>): ActivitySummary["tasks"]["recent"][number] => ({ id: "t", title: "Tidy the readme", team: "Mine", status: "needs-review", createdAt: "2026-11-03T10:00:00.000Z", phase: "review", result: null, changes: null, request: null, requests: [], ...patch });

  it("given recent tasks undone, kept, closed and still waiting, when their status is named, then each reads as the task list names it", () => {
    // when
    const named = [
      recent({ result: "changes", changes: { undone: true, kept: false } }),
      recent({ result: "changes", changes: { undone: false, kept: true } }),
      recent({ request: { status: "closed" } }),
      recent({}),
    ].map((t) => STATUS_TEXT[shownStatus(t)]);

    // then
    expect(named).toEqual([STATUS_TEXT.undone, STATUS_TEXT.kept, STATUS_TEXT.closed, STATUS_TEXT["needs-review"]]);
  });
});
