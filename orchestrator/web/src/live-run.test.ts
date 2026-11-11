import { describe, expect, it } from "vitest";
import type { TaskLogLine } from "./api";
import { liveRun, OUTPUT_HELD, OUTPUT_KEPT, shortPath, toolResult, toolSaid, writtenDocument, writtenPlan, commandLine } from "./live-run";
import type { StreamLine } from "./live-run";

const said = (l: StreamLine) => {
  if (l.kind !== "tool") return l.kind === "say" ? l.text : l.kind;
  const { before, target, after } = toolSaid(l);
  const result = toolResult(l);
  return `${before}${target ? ` ${target}` : ""}${after}${result ? ` ${result.word}` : ""}`;
};

let seq = 0;
const at = (minute: number) => `2026-11-04T10:${String(minute).padStart(2, "0")}:00Z`;
const event = (data: Record<string, unknown>, minute = 0): TaskLogLine => ({ seq: ++seq, at: at(minute), text: "masked text", kind: data.type as string, data });

describe("liveRun", () => {
  it("given the agent's words, reads in a row and an edit, when the run is read, then the reads are one line, the edit carries its counts, and the file is changed so far", () => {
    // given
    const log = [
      event({ type: "message", text: "I will read the webhook code first." }),
      event({ type: "tool_call", id: "a", tool: "Read", target: "deliver.ts", status: "started" }),
      event({ type: "tool_call", id: "b", tool: "Read", target: "retry.ts", status: "started" }),
      event({ type: "tool_call", id: "c", tool: "Edit", target: "runbook.md", status: "started" }),
      event({ type: "edit", id: "c", path: "runbook.md", additions: 9, deletions: 2, patch: "@@ -1 +1 @@\n-a\n+b" }),
      event({ type: "tool_call", id: "c", tool: "Edit", target: "runbook.md", status: "done" }),
    ];

    // when
    const run = liveRun(log);

    // then
    expect(run.stream.map(said)).toEqual([
      "I will read the webhook code first.",
      "Read deliver.ts and retry.ts",
      "Edited runbook.md",
    ]);
    const edit = run.stream[2]!;
    expect(edit.kind === "tool" && edit.status).toBe("done");
    expect(edit.kind === "tool" && edit.change).toEqual({ additions: 9, deletions: 2, patch: "@@ -1 +1 @@\n-a\n+b" });
    expect(run.changed).toEqual([{ path: "runbook.md", additions: 9, deletions: 2 }]);
  });

  it("given a command with a long output, the agent's plan and two costs, when the run is read, then the command keeps its last lines, the plan is the latest list and the cost adds up", () => {
    // given
    const lines = Array.from({ length: OUTPUT_HELD + 5 }, (_, i) => `line ${i}`);
    const log = [
      event({ type: "todos", items: [{ text: "Read the code", state: "doing" }, { text: "Write the runbook", state: "todo" }] }),
      event({ type: "tool_call", id: "t", tool: "Bash", target: null, command: "npm test", status: "started" }),
      event({ type: "tool_output", id: "t", lines }),
      event({ type: "tool_call", id: "t", tool: "Bash", status: "failed" }),
      event({ type: "todos", items: [{ text: "Read the code", state: "done" }, { text: "Write the runbook", state: "doing" }] }),
      event({ type: "usage", cost: { usd: 0.25, inputTokens: null, outputTokens: null } }),
      event({ type: "usage", cost: { usd: 0.16, inputTokens: null, outputTokens: null } }),
    ];

    // when
    const run = liveRun(log);

    // then
    const ran = run.stream[0]!;
    expect(said(ran)).toBe("Ran npm test failed");
    expect(ran.kind === "tool" && ran.status).toBe("failed");
    expect(ran.kind === "tool" && ran.output.length).toBe(OUTPUT_HELD);
    expect(ran.kind === "tool" && ran.output.at(-1)).toBe(`line ${OUTPUT_HELD + 4}`);
    expect(ran.kind === "tool" && ran.outputTotal).toBe(OUTPUT_HELD + 5);
    expect(OUTPUT_KEPT).toBe(20);
    expect(run.plan).toEqual([{ text: "Read the code", state: "done" }, { text: "Write the runbook", state: "doing" }]);
    expect(run.costUsd).toBeCloseTo(0.41);
  });

  it("given a card answered after a pause, words to the agent and events that do not read as the contract has them, when the run is read, then the answer is one line after a time line, what the person told the agent follows, and the rest stays out of the stream", () => {
    // given
    const log = [
      event({ type: "message", text: "Running the tests needs your yes." }, 1),
      event({ type: "request", request: { id: "r1", kind: "command", tool: "Bash", summary: "npm test" } }, 1),
      event({ type: "request_resolved", requestId: "r1", decision: "allow-once" }, 4),
      event({ type: "steer", text: "Use our logger.", by: "Ada" }, 4),
      event({ type: "tool_call", tool: 7, status: "started" }, 4),
      event({ type: "todos", items: [{ text: "half a step" }] }, 4),
      { seq: ++seq, at: at(4), text: "orchestrator's own line" },
      { seq: ++seq, at: at(4), text: "a kind its data does not match", kind: "message", data: { type: "edit", text: "x" } },
    ];

    // when
    const run = liveRun(log);

    // then
    expect(run.stream.map((l) => [l.kind, "text" in l ? l.text : null])).toEqual([
      ["say", "Running the tests needs your yes."],
      ["time", null],
      ["card", "You allowed npm test once"],
      ["you", "Use our logger."],
    ]);
    expect(run.plan).toEqual([]);
  });
});

describe("a tool call's line in the product's words", () => {
  it("given MCP calls to Jira, Confluence, an unknown server and four refused reads of one tool, when the run is read, then each is said verb first with its service last, the refusals join, and the raw name stays in the call", () => {
    // given
    const log = [
      event({ type: "tool_call", id: "a", tool: "mcp__plugin_atlassian_atlassian__getJiraIssue", target: "PAY-412", status: "started" }),
      event({ type: "tool_call", id: "a", tool: "mcp__plugin_atlassian_atlassian__getJiraIssue", status: "done" }),
      event({ type: "message", text: "Now the release notes." }),
      event({ type: "tool_call", id: "b", tool: "mcp__atlassian__searchConfluenceUsingCql", target: "release notes", status: "started" }),
      event({ type: "message", text: "And the ticket's comments." }),
      event({ type: "tool_call", id: "c", tool: "mcp__atlassian__getJiraIssueComments", target: "mcp__atlassian__getJiraIssueComments", status: "done" }),
      event({ type: "tool_call", id: "d", tool: "mcp__acme_tools__rotateKeys", target: null, status: "done" }),
      ...[1, 2, 3, 4].map((n) => event({ type: "tool_call", id: `r${n}`, tool: "mcp__atlassian__getJiraIssue", target: "PAY-412", status: "refused" })),
    ];

    // when
    const run = liveRun(log);

    // then
    expect(run.stream.map(said)).toEqual([
      "Read PAY-412 in Jira",
      "Now the release notes.",
      `Searched Confluence for "release notes"`,
      "And the ticket's comments.",
      "Read an issue in Jira",
      "Used rotate keys in acme tools",
      "Read PAY-412 in Jira refused 4 times",
    ]);
    const refused = run.stream.at(-1)!;
    expect(refused.kind === "tool" && refused.calls.map((c) => c.tool)).toEqual(Array(4).fill("mcp__atlassian__getJiraIssue"));
  });
});

describe("a refused call's reason and an MCP call's own names", () => {
  it("given refusals of one tool for two reasons and an MCP call whose adapter named its server and tool, when the run is read, then refusals for one reason join and keep it, another reason is its own line, and the named server is the line's source", () => {
    // given
    const wrote = { kind: "tracker-write", reason: "Writing to the tracker is off for every task." };
    const away = { kind: "data-folder", reason: "The task's rules keep the agent away from this path." };
    const log = [
      event({ type: "tool_call", id: "a", tool: "mcp__atlassian__addComment", target: "PAY-412", status: "refused", refusal: wrote }),
      event({ type: "tool_call", id: "b", tool: "mcp__atlassian__addComment", target: "PAY-412", status: "refused", refusal: wrote }),
      event({ type: "tool_call", id: "c", tool: "mcp__atlassian__addComment", target: "PAY-413", status: "refused", refusal: away }),
      event({ type: "tool_call", id: "d", tool: "mcp__plugin_acme_atlassian__getJiraIssue", target: "PAY-412", status: "done", mcp: { server: "atlassian", tool: "getJiraIssue" } }),
    ];

    // when
    const run = liveRun(log);

    // then
    expect(run.stream.map(said)).toEqual(["Used add comment in atlassian refused 2 times", "Used add comment in atlassian refused", "Read PAY-412 in Jira"]);
    const [first, second] = run.stream;
    expect(first!.kind === "tool" && first!.calls[0]!.reason).toBe(wrote.reason);
    expect(second!.kind === "tool" && second!.calls[0]!.reason).toBe(away.reason);
  });
});

describe("paths in a run", () => {
  it("given a path in the task's folder, one under home and one elsewhere, when they are said, then the first is relative, the second from home as a tilde and the third whole, and a call's target in the run is said so", () => {
    // given
    const place = { folder: "/home/ada/code/payments-api", home: "/home/ada" };

    // when
    const short = ["/home/ada/code/payments-api/src/deliver.ts", "/home/ada/notes/todo.md", "/etc/hosts", "src/retry.ts"].map((p) => shortPath(p, place));
    const run = liveRun([event({ type: "tool_call", id: "a", tool: "Read", target: "/home/ada/code/payments-api/src/deliver.ts", status: "done" })], place);

    // then
    expect(short).toEqual(["src/deliver.ts", "~/notes/todo.md", "/etc/hosts", "src/retry.ts"]);
    expect(run.stream.map(said)).toEqual(["Read src/deliver.ts"]);
  });
});

describe("a file read's output", () => {
  it("given a read that returned many lines, when the run is read, then none of its text is kept and only how many lines it was", () => {
    // given
    const log = [
      event({ type: "tool_call", id: "r", tool: "Read", target: "src/ChatService.kt", status: "started" }),
      event({ type: "tool_output", id: "r", lines: Array.from({ length: 240 }, (_, i) => `val x${i} = ${i}`) }),
      event({ type: "tool_call", id: "r", tool: "Read", status: "done" }),
    ];

    // when
    const read = liveRun(log).stream[0]!;

    // then
    expect(read.kind === "tool" && read.output).toEqual([]);
    expect(read.kind === "tool" && read.outputTotal).toBe(240);
  });
});

describe("writtenDocument", () => {
  it("given a Markdown file written whole and a file edited in place, when each is read, then the first is its text without the diff's marks and the second is not a document", () => {
    // given
    const run = liveRun([
      event({ type: "tool_call", id: "a", tool: "Write", target: "plan.md", status: "started" }),
      event({ type: "edit", id: "a", path: "plan.md", additions: 3, deletions: 0, patch: "@@ -0,0 +1,3 @@\n+# Plan\n+\n+| File | Change |" }),
      event({ type: "tool_call", id: "b", tool: "Edit", target: "notes.md", status: "started" }),
      event({ type: "edit", id: "b", path: "notes.md", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }),
    ]);
    const [written, edited] = run.stream.filter((l) => l.kind === "tool");

    // then
    expect(written && written.kind === "tool" && writtenDocument(written)).toBe("# Plan\n\n| File | Change |");
    expect(edited && edited.kind === "tool" && writtenDocument(edited)).toBeNull();
  });
});

describe("commandLine", () => {
  it("given a short command, a long one and a script over several lines, when each is said, then the short stays whole and the others are one cut line", () => {
    // then
    expect(commandLine("npm test")).toBe("npm test");
    expect(commandLine(`echo ${"x".repeat(200)}`)).toHaveLength(81);
    expect(commandLine("cat <<'EOF'\nline one\nline two\nEOF")).toBe("cat <<'EOF'…");
  });
});

describe("writtenPlan", () => {
  it("given a run that wrote a plan into its plan folder and a note elsewhere, when its plan is read, then it is the plan folder's file, and a run with none has no plan", () => {
    // given
    const wrote = (id: string, path: string, text: string) => [
      event({ type: "tool_call", id, tool: "Write", target: path, status: "started" }),
      event({ type: "edit", id, path, additions: 2, deletions: 0, patch: `@@ -0,0 +1,2 @@\n+# ${text}\n+step one` }),
    ];
    const planned = liveRun([...wrote("a", "work/.orchestrator-plans/p.md", "The plan"), ...wrote("b", "notes.md", "A note")]);
    const unplanned = liveRun(wrote("c", "notes.md", "A note"));

    // then
    expect(writtenPlan(planned.stream)).toBe("# The plan\nstep one");
    expect(writtenPlan(unplanned.stream)).toBeNull();
  });
});
