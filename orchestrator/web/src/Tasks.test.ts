import { describe, expect, it } from "vitest";
import { againInput, endReasonOf, waitedMs, waitSaid, findLines, formStart, issueLine, LOG_WINDOW, ordinal, resetDay, shownStatus, splitWork, startLink, startSummary, STATUS_TEXT, reviewSummary, targetNames, taskFacts, taskTitle, windowStart } from "./Tasks";
import type { TaskRecord } from "./api";

describe("resetDay", () => {
  it("given a month, including December, when its budgets start again, then it is the first of the next month", () => {
    // given
    const months = ["2026-10", "2026-12"];

    // when
    const days = months.map(resetDay);

    // then
    expect(days).toEqual(["November 1", "January 1"]);
  });
});

describe("splitWork", () => {
  it("given a link, a key, a link with notes under it, and plain words, when the field is read, then the issue and the notes come apart", () => {
    // when
    const read = [
      splitWork("https://acme.atlassian.example/browse/SHOP-233"),
      splitWork("  SHOP-233  "),
      splitWork("https://acme.atlassian.example/browse/SHOP-233\nKeep the old endpoint working.\n"),
      splitWork("Add a retry to the payment webhook"),
      splitWork("see https://acme.atlassian.example/browse/SHOP-233"),
      splitWork("https://acme.atlassian.example/browse/SHOP-233 Work in ~/code."),
      splitWork("SHOP-233 Work in ~/code.\nKeep the old endpoint working."),
    ];

    // then
    expect(read).toEqual([
      { issue: "https://acme.atlassian.example/browse/SHOP-233", notes: "" },
      { issue: "SHOP-233", notes: "" },
      { issue: "https://acme.atlassian.example/browse/SHOP-233", notes: "Keep the old endpoint working." },
      { issue: "", notes: "Add a retry to the payment webhook" },
      { issue: "", notes: "see https://acme.atlassian.example/browse/SHOP-233" },
      { issue: "https://acme.atlassian.example/browse/SHOP-233", notes: "Work in ~/code." },
      { issue: "SHOP-233", notes: "Work in ~/code.\nKeep the old endpoint working." },
    ]);
  });

  it("given a GitLab and a GitHub issue named by path and number, when the field is read, then each is the issue", () => {
    // when
    const read = [splitWork("group/sub/project#12"), splitWork("owner/repo#7\nOnly the parser.")];

    // then
    expect(read).toEqual([{ issue: "group/sub/project#12", notes: "" }, { issue: "owner/repo#7", notes: "Only the parser." }]);
  });
});

describe("startLink", () => {
  it("given a link carrying an issue and a repository with invisible characters in both, when it is read, then each comes back as typed without them", () => {
    // given
    const search = `?issue=${encodeURIComponent("\u200bSHOP-233\u202e\n")}&repo=${encodeURIComponent("payments\ufeff-api")}`;

    // when
    const read = startLink(search);

    // then
    expect(read).toEqual({ issue: "SHOP-233", repo: "payments-api", title: "", description: "", stripped: true });
  });

  it("given a link with neither, when it is read, then the form starts empty", () => {
    // when
    const read = startLink("?source=jira");

    // then
    expect(read).toEqual({ issue: "", repo: "", title: "", description: "", stripped: false });
  });

  it("given a link carrying the work as a prompt with a hidden bidi mark, and one with a clean description, when each is read, then the prompt fills the description without the mark and is flagged, and the clean one is not", () => {
    // when
    const prompted = startLink(`?prompt=${encodeURIComponent("Add a retry\n\u202eto the webhook")}`);
    const described = startLink(`?description=${encodeURIComponent("Add a retry\nto the webhook")}`);

    // then
    expect(prompted).toMatchObject({ description: "Add a retry\nto the webhook", stripped: true });
    expect(described).toMatchObject({ description: "Add a retry\nto the webhook", stripped: false });
  });
});

describe("taskTitle", () => {
  it("given what is at hand, when a title is chosen, then a typed one wins, then the issue's, the template's and the notes' first line", () => {
    // when
    const titles = [
      taskTitle(" Mine ", "From the issue", "From the template", "Notes"),
      taskTitle("", "From the issue", "From the template", "Notes"),
      taskTitle("", null, "From the template", "Notes"),
      taskTitle("", null, null, "First line\nsecond line"),
      taskTitle("", null, null, ""),
    ];

    // then
    expect(titles).toEqual(["Mine", "From the issue", "From the template", "First line", ""]);
  });
});

describe("startSummary", () => {
  it("given the agent picks the repositories for a readable issue, when the start is summed up, then it reads the issue and opens a request per repository", () => {
    // when
    const said = startSummary({ issueKey: "SHOP-233", reads: true, mode: "code", spread: "orchestrator", repos: [], byOrchestrator: false });

    // then
    expect(said).toBe("Reads SHOP-233, picks the repositories; a reviewer merges each change.");
  });

  it("given picked repositories, one repository and the orchestrator's own scaffold, when each start is summed up, then each names what changes", () => {
    // when
    const said = [
      startSummary({ issueKey: "SHOP-233", reads: false, mode: "code", spread: "chosen", repos: ["checkout-service", "payments-bff", "api-gateway"], byOrchestrator: false }),
      startSummary({ issueKey: null, reads: false, mode: "code", spread: "chosen", repos: ["checkout-service"], byOrchestrator: false }),
      startSummary({ issueKey: null, reads: false, mode: "code", spread: "chosen", repos: ["checkout-service"], byOrchestrator: false, forge: "gitlab" }),
      startSummary({ issueKey: null, reads: false, mode: "skills", spread: "chosen", repos: ["payments-skills"], byOrchestrator: true }),
      startSummary({ issueKey: null, reads: false, mode: "code", spread: "chosen", repos: [], byOrchestrator: false, routed: true }),
      startSummary({ issueKey: "SHOP-233", reads: true, mode: "code", spread: "chosen", repos: [], byOrchestrator: false, routed: true }),
    ];

    // then
    expect(said).toEqual([
      "Works from SHOP-233, changes checkout-service, payments-bff and api-gateway in that order; a reviewer merges each change.",
      "Changes checkout-service; a reviewer merges it.",
      "Changes checkout-service; a reviewer merges it on GitLab.",
      "The orchestrator updates payments-skills itself and a reviewer merges it; no agent runs.",
      "Changes your files; you review before keeping.",
      "Reads SHOP-233, changes your files; you review before keeping.",
    ]);
  });
});

describe("issueLine", () => {
  it("given a preview with a title and status, and one with the key alone, when each is shown, then the line holds what was read", () => {
    // given
    const read = { url: "https://acme.atlassian.example/browse/PAY-142", key: "PAY-142", title: "Round refunds half to even", status: "In Progress", reach: "" };
    const keyOnly = { ...read, title: null, status: null };

    // when
    const lines = [issueLine(read), issueLine(keyOnly)];

    // then
    expect(lines).toEqual(["PAY-142 Round refunds half to even (In Progress)", "PAY-142"]);
  });
});

describe("targetNames", () => {
  it("given a task on one repository, one still planning and one over three, when the list names them, then each reads as it stands", () => {
    // given
    const target = (name: string) => ({ repoId: name, name, status: "planned" as const, reason: "", tests: null, error: null, request: null });

    // when
    const names = [
      targetNames({ repoId: "payments-skills", targets: null }),
      targetNames({ repoId: "checkout-service", targets: [] }),
      targetNames({ repoId: "checkout-service", targets: [target("checkout-service"), target("payments-bff"), target("api-gateway")] }),
    ];

    // then
    expect(names).toEqual(["payments-skills", "planning…", "checkout-service, payments-bff, api-gateway"]);
  });
});

describe("ordinal", () => {
  it("given the run order of up to five repositories, when it is said in words, then it reads first to fifth", () => {
    // when
    const words = [1, 2, 3, 4, 5].map(ordinal);

    // then
    expect(words).toEqual(["first", "second", "third", "fourth", "fifth"]);
  });
});

describe("findLines", () => {
  it("given a log, when words are searched in another case, then every line holding them comes back in order, and blank words find nothing", () => {
    // given
    const log = [{ seq: 1, text: "Cloning payments-api" }, { seq: 2, text: "npm test: 3 FAILED" }, { seq: 3, text: "retrying the failed tests" }];

    // when
    const found = findLines(log, " failed ");
    const none = findLines(log, "   ");

    // then
    expect(found).toEqual([2, 3]);
    expect(none).toEqual([]);
  });
});

describe("windowStart", () => {
  it("given a log shorter than a window, a long one, and earlier windows asked for, when the first shown line is picked, then the newest windows show and the start never goes below zero", () => {
    // when
    const short = windowStart(40, 0, null);
    const long = windowStart(LOG_WINDOW * 3, 0, null);
    const twoMore = windowStart(LOG_WINDOW * 3, 2, null);

    // then
    expect(short).toBe(0);
    expect(long).toBe(LOG_WINDOW * 2);
    expect(twoMore).toBe(0);
  });

  it("given the find bar on a line above the window, when the start is picked, then the window reaches back to that line", () => {
    // when
    const start = windowStart(LOG_WINDOW * 2, 0, 12);
    const inside = windowStart(LOG_WINDOW * 2, 0, LOG_WINDOW + 5);

    // then
    expect(start).toBe(12);
    expect(inside).toBe(LOG_WINDOW);
  });
});

describe("formStart", () => {
  it("given a prompt link with a title and a description over two lines, when the form starts, then the description is the work and its line break stays", () => {
    // given
    const start = startLink(`?title=${encodeURIComponent("Tidy refunds")}&description=${encodeURIComponent("Round half to even.\n\u200bKeep the old endpoint.")}`);

    // when
    const filled = formStart(start, JSON.stringify({ work: "an old draft", title: "", notes: "" }));

    // then
    expect(filled).toEqual({ work: "Round half to even.\nKeep the old endpoint.", title: "Tidy refunds", notes: "" });
  });

  it("given a link with an issue and a description, when the form starts, then the issue is the work and the description its notes", () => {
    // when
    const filled = formStart(startLink("?issue=PAY-142&description=Only+the+parser"), null);

    // then
    expect(filled).toEqual({ work: "PAY-142", title: "", notes: "Only the parser" });
  });

  it("given no link, a kept draft and a kept value that is not one, when the form starts, then the draft comes back and the other starts empty", () => {
    // when
    const kept = formStart(undefined, JSON.stringify({ work: "Retry the webhook", title: "Retries", notes: 3 }));
    const broken = formStart(startLink(""), "{");

    // then
    expect(kept).toEqual({ work: "Retry the webhook", title: "Retries", notes: "" });
    expect(broken).toEqual({ work: "", title: "", notes: "" });
  });
});

describe("shownStatus", () => {
  const ended = (over: Partial<TaskRecord>) => ({ status: "needs-review", phase: "review", result: null, changes: null, request: null, ...over }) as TaskRecord;
  it("given changes undone, kept, a request closed and one merged, when the task's page names its status, then each says the person's decision, as every screen does", () => {
    // when
    const shown = [
      ended({ result: "changes", phase: "failed", changes: { files: [], undone: { at: "t", by: "Ada", kept: [] } } }),
      ended({ result: "changes", phase: "merged", changes: { files: [], undone: null, kept: { at: "t", by: "Ada" } } }),
      ended({ result: "request", phase: "failed", request: { status: "closed", provider: "local", branch: "b", url: "u" } }),
      ended({ result: "request", phase: "merged", request: { status: "merged", provider: "local", branch: "b", url: "u" } }),
      ended({ result: "changes", phase: "review", changes: { files: [], undone: null } }),
    ].map((t) => STATUS_TEXT[shownStatus(t)]);

    // then
    expect(shown).toEqual(["changes undone", "changes kept", "closed", "merged", "needs review"]);
  });
});

describe("againInput", () => {
  it("given a task started with approval required, chosen skills and a model, when it is started again, then the new start carries the same mode, skills and choices", () => {
    // given
    const task = { title: "Fix the refund", description: "Fix the refund", issueUrl: null, repoId: "shop", agent: "claude-code", template: null, targetMode: null, targets: null, skills: ["refunds"], choices: { model: "opus" }, mode: "approval-required" } as unknown as TaskRecord;

    // when
    const input = againInput(task);

    // then
    expect(input).toEqual({ title: "Fix the refund", description: "Fix the refund", issueUrl: "", repoId: "shop", agent: "claude-code", template: null, skills: ["refunds"], choices: { model: "opus" }, mode: "approval-required" });
  });

  it("given a task started with a project's skills and an MCP server, when started again, then the same skills by source and name and the same server go with it", () => {
    // when
    const input = againInput({ title: "t", description: "", issueUrl: null, repoId: "shop", agent: "fake", template: null, targets: null, tools: { skills: [{ source: "ssrc_1", name: "release-notes", head: "abc" }], mcpServers: ["mcp_1"] } } as unknown as TaskRecord);

    // then
    expect(input).toMatchObject({ projectSkills: [{ source: "ssrc_1", name: "release-notes" }], mcpServers: ["mcp_1"] });
  });

  it("given a task the orchestrator planned over several repositories and one with no mode recorded, when started again, then the orchestrator plans again and no mode is sent", () => {
    // when
    const input = againInput({ title: "t", description: "", issueUrl: "https://x/1", repoId: "a", agent: "fake", template: null, targetMode: "orchestrator", targets: [] } as unknown as TaskRecord);

    // then
    expect(input).toEqual({ title: "t", description: "", issueUrl: "https://x/1", repoId: "a", agent: "fake", template: null, targets: "orchestrator" });
  });
});

describe("taskFacts", () => {
  const base = { repoId: "shop", team: "Payments", createdBy: "ada@example.invalid", createdAt: "2026-11-03T10:00:00Z", startedAt: null, finishedAt: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, template: null, skills: null } as unknown as TaskRecord;
  const when = () => "at ten";

  it("given a task just queued on a team's orchestrator, when its facts are read, then only the repository with its team, the agent and who started it are, with nothing that is not known", () => {
    // when
    const facts = taskFacts(base, "Claude Code", { email: "lin@example.invalid", mode: "self-hosted" }, when);

    // then
    expect(facts).toEqual({
      where: [{ term: "Repository", value: "shop" }, { term: "Team", value: "Payments" }],
      run: [{ term: "Agent", value: "Claude Code" }, { term: "Started", value: "at ten by ada@example.invalid" }],
    });
  });

  it("given a task that ran and ended with no cost reported, and one still running, when their facts are read, then the first says the cost was not reported and the second says nothing", () => {
    // when
    const ended = taskFacts({ ...base, startedAt: "2026-11-03T10:01:00Z", finishedAt: "2026-11-03T10:05:00Z" }, "Claude Code", { email: "lin@example.invalid", mode: "self-hosted" }, when);
    const running = taskFacts({ ...base, startedAt: "2026-11-03T10:01:00Z" }, "Claude Code", { email: "lin@example.invalid", mode: "self-hosted" }, when);

    // then
    expect(ended.run).toContainEqual({ term: "Cost", value: "Not reported" });
    expect(running.run.map((f) => f.term)).not.toContain("Cost");
  });

  it("given a finished task that carries the orchestrator's own count of how long the agent ran, when its facts are read, then Ran is that count, not the span from start to end", () => {
    // when
    const facts = taskFacts({ ...base, startedAt: "2026-11-03T10:00:00Z", finishedAt: "2026-11-03T12:46:07Z", ranMs: 12 * 60_000 }, "Claude Code", { email: "lin@example.invalid", mode: "self-hosted" }, when);

    // then
    expect(facts.run).toContainEqual({ term: "Ran", value: "12m" });
  });

  it("given a task the orchestrator sent to a folder on one person's own orchestrator, when its facts are read, then the folder is the one it went to, not the record kept for it", () => {
    // when
    const facts = taskFacts(base, "Claude Code", { email: "lin@example.invalid", mode: "local" }, when, "~/code/payments-api");

    // then
    expect(facts.where).toEqual([{ term: "Folder", value: "~/code/payments-api" }]);
  });

  it("given a task run as its person here, when its facts are read, then its cost, the context it started with and what it loaded of their own Claude Code are lines of the run side by side", () => {
    // when
    const facts = taskFacts({ ...base, cost: { usd: 0.41, inputTokens: null, outputTokens: null }, context: { tokens: 48_200 }, loaded: { commands: 12, plugins: 0, mcpServers: 3, claudeMd: true } } as TaskRecord, "Claude Code", { email: "ada@example.invalid", mode: "local" }, when);

    // then
    expect(facts.run.slice(-3)).toEqual([
      { term: "Cost", value: "$0.41" },
      { term: "Context", value: "48k tokens at its start" },
      { term: "Loaded", value: "12 skills or commands, 3 MCP servers and CLAUDE.md" },
    ]);
  });

  it("given one person's own task that ended with tests, a cost and the skills it read first, when its facts are read, then it is theirs, with no team, and each known fact is its own line", () => {
    // given
    const ended = { ...base, startedAt: "2026-11-03T10:00:00Z", finishedAt: "2026-11-03T10:02:05Z", tests: "passed", cost: { usd: 0.0412, inputTokens: null, outputTokens: null }, skills: ["refunds"] } as unknown as TaskRecord;

    // when
    const facts = taskFacts(ended, "", { email: "ada@example.invalid", mode: "local" }, when);

    // then
    expect(facts).toEqual({
      where: [{ term: "Folder", value: "shop" }],
      run: [
        { term: "Agent", value: "The agent" },
        { term: "Started", value: "at ten by you" },
        { term: "Tests", value: "passed" },
        { term: "Ran", value: "2m 5s" },
        { term: "Cost", value: "$0.04" },
        { term: "Reads first", value: "refunds" },
      ],
    });
  });
});

describe("reviewSummary", () => {
  it("given a task that finished in place with two files changed, when its head is read, then it says how long it took, what it changed and that the change waits", () => {
    // given
    const files = [{ path: "a.md" }, { path: "b.md" }] as unknown as NonNullable<TaskRecord["changes"]>["files"];

    // when
    const said = reviewSummary({ startedAt: "2026-11-04T10:00:00Z", finishedAt: "2026-11-04T10:02:05Z", changes: { files, undone: null } });

    // then
    expect(said).toBe("The agent finished in 2m 5s, changing 2 files; the change waits for your review.");
  });

  it("given a folder task that changed two of its repositories, when its head is read, then it names them and says each change waits", () => {
    // given
    const targets = [{ name: "payments-api", status: "request" }, { name: "payments-worker", status: "failed" }] as unknown as NonNullable<TaskRecord["targets"]>;

    // when
    const said = reviewSummary({ startedAt: "2026-11-04T10:00:00Z", finishedAt: "2026-11-04T10:02:05Z", changes: null, targets });

    // then
    expect(said).toBe("The agent finished in 2m 5s, changing payments-api and payments-worker; each change waits for your review.");
  });

  it("given a task whose change stayed on its branch in the person's repository on their machine, when its head is read, then it names the repository and says where the change stays, not that it waits for review", () => {
    // given
    const targets = [{ name: "delivery-service", status: "local", path: "", branch: "task/delivery-window", reason: "no-remote" }] as unknown as NonNullable<TaskRecord["targets"]>;

    // when
    const said = reviewSummary({ startedAt: "2026-11-04T10:00:00Z", finishedAt: "2026-11-04T10:00:01Z", changes: null, targets, ranOn: "ada-laptop" });

    // then
    expect(said).toBe("The agent finished in 1s, changing delivery-service; the change stays on its branch on ada-laptop.");
  });

  it("given a task whose change is a request, when its head is read, then no file count is said that the page does not hold", () => {
    // when
    const said = reviewSummary({ startedAt: "2026-11-04T10:00:00Z", finishedAt: "2026-11-04T10:00:40Z", changes: null });

    // then
    expect(said).toBe("The agent finished in 40s; the change waits for your review.");
  });
});

describe("endReasonOf", () => {
  it("given an error with several lines, an empty one and none, when the head says why a run stopped, then the first line closes the sentence and nothing leaves a full stop", () => {
    // then
    expect(endReasonOf("The plan waited 30 minutes.\nat step 4")).toBe(": The plan waited 30 minutes.");
    expect(endReasonOf("  ")).toBe(".");
    expect(endReasonOf(null)).toBe(".");
  });
});

describe("waitedMs", () => {
  const at = (hm: string) => `2026-11-10T${hm}:00Z`;
  const request = (over: Record<string, unknown>) => ({ id: "r", kind: "plan", payload: {}, status: "answered", responseCapability: "live", answer: null, answeredBy: null, createdAt: at("10:10"), ...over }) as NonNullable<TaskRecord["requests"]>[number];

  it("given a run of two hours with an answered card, a card that ran out, one that overlapped it and one the agent took back, when its waiting is counted, then each stretch counts once and the withdrawn one not at all", () => {
    // given
    const task = {
      startedAt: at("10:00"),
      finishedAt: at("12:00"),
      requests: [
        request({ createdAt: at("10:10"), answeredAt: at("10:20") }),
        request({ createdAt: at("10:30"), status: "expired", expiresAt: at("11:30") }),
        request({ createdAt: at("11:00"), answeredAt: at("11:10") }),
        request({ createdAt: at("11:40"), status: "withdrawn" }),
      ],
    };

    // then
    expect(waitedMs(task)).toBe(70 * 60_000);
  });

  it("given a card still unanswered when the run ended and a task with no cards, when their waiting is counted, then the first waited until the end and the second not at all", () => {
    // then
    expect(waitedMs({ startedAt: at("10:00"), finishedAt: at("10:30"), requests: [request({ createdAt: at("10:10"), status: "pending" })] })).toBe(20 * 60_000);
    expect(waitedMs({ startedAt: at("10:00"), finishedAt: at("10:30") })).toBe(0);
  });
});

describe("waitSaid", () => {
  it("given waits of seven minutes exactly, an hour, two and a half hours and ninety seconds, when each is said, then none carries seconds", () => {
    // then
    expect([7 * 60_000, 60 * 60_000, 150 * 60_000, 90_000].map(waitSaid)).toEqual(["7m", "1h", "2h 30m", "2m"]);
  });
});
