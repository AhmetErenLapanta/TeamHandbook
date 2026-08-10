import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLearnPayload, signalFromLearnPayload } from "./learn.js";
import { runManualSignal } from "./pipeline.js";
import { sieveSignal } from "./gate.js";
import { buildScorePrompt } from "./score.js";
import { buildDistillPrompt } from "./distill.js";
import { flushSessionEnd, workRecordFromState, workRecurrences } from "./signals.js";
import type { Signal } from "./signals.js";
import { recordActivity } from "./capture.js";
import { saveSessionState, emptySessionState } from "./session-state.js";
import { pendingWorkNudge } from "./notify.js";
import { candidatesDir } from "./skill-index.js";
import type { ClaudeRunner } from "./score.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-proc-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const procedureJson = JSON.stringify({
  goal: "Add a new MCP tool that exposes a BFF endpoint",
  steps: [
    "Create request/response DTOs mirroring the BFF contract",
    "Add a client method calling the BFF endpoint",
    "Implement the service with formatResponseForAI",
    "Register the @McpTool and update the system prompt",
  ],
  verification: "gradle test passes and the tool answers in a live chat",
  edits: ["src/Dto.kt", "src/Service.kt"],
});

describe("procedure learning (T2 task mode)", () => {
  it("parses a procedure payload and builds a task signal", () => {
    const { payload, error } = parseLearnPayload(procedureJson, "/repo");
    expect(error).toBeUndefined();
    expect(payload?.kind).toBe("procedure");
    const signal = signalFromLearnPayload(payload!, "2026-08-08T00:00:00Z");
    expect(signal.task?.goal).toContain("MCP tool");
    expect(signal.task?.steps).toHaveLength(4);
    expect(signal.family).toBe("task");
    expect(signal.trigger).toBe("manual");
    expect(signal.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects procedures with fewer than two steps and rewards clear errors", () => {
    expect(parseLearnPayload(JSON.stringify({ goal: "x", steps: ["only one"] })).error).toContain("at least 2");
    expect(parseLearnPayload(JSON.stringify({ goal: "", steps: ["a", "b"] })).error).toContain("goal");
  });

  it("secret-vetoes a procedure whose steps carry a token", () => {
    const { payload } = parseLearnPayload(
      JSON.stringify({ goal: "deploy", steps: ["export TOKEN=glpat-xJ2vRq8kQzWn5pYtBs7d", "push"] }),
      "/repo",
    );
    const signal = signalFromLearnPayload(payload!, "2026-08-08T00:00:00Z");
    const decision = sieveSignal(signal, 1);
    expect(decision.pass).toBe(false);
    expect(decision.reason).toBe("secret");
  });

  it("renders the task case into both prompts", () => {
    const { payload } = parseLearnPayload(procedureJson, "/repo");
    const signal = signalFromLearnPayload(payload!, "2026-08-08T00:00:00Z");
    expect(buildScorePrompt(signal, 1)).toContain("completed task procedure");
    expect(buildScorePrompt(signal, 1)).toContain("1. Create request/response DTOs");
    expect(buildDistillPrompt(signal, 1)).toContain("step-by-step procedure");
  });

  it("runs a procedure end-to-end through the manual pipeline into a candidate", async () => {
    const runner: ClaudeRunner = async (prompt) =>
      prompt.includes("kebab-case-skill-name")
        ? JSON.stringify({
            name: "add-mcp-tool",
            description: "Use when adding a new MCP tool backed by a BFF endpoint.",
            body: "## When to use\n\n…\n\n## Steps\n\n1. DTOs\n2. Client\n3. Service\n4. Tool",
            expect: "gradle test passes and the tool answers in chat",
          })
        : JSON.stringify({
            scores: { recurrence: 2, unfindability: 2, generality: 2, durability: 1, costOfError: 1 },
            rationale: "recurring team procedure",
            duplicateOf: null,
          });
    const { payload } = parseLearnPayload(procedureJson, "/repo");
    const signal = signalFromLearnPayload(payload!, "2026-08-08T00:00:00Z");
    const outcome = await runManualSignal(signal, home, { runner, remoteUrl: () => null });
    expect(outcome.stage).toBe("written");
    const dir = join(candidatesDir(home), "add-mcp-tool");
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("name: add-mcp-tool");
    const grounded = JSON.parse(readFileSync(join(dir, "grounded-case.json"), "utf8"));
    expect(grounded.task.goal).toContain("MCP tool");
    expect(grounded.task.steps).toHaveLength(4);
  });
});

describe("repeated-work detection (T3)", () => {
  function sessionWithActivity(id: string): void {
    const state = emptySessionState(id);
    saveSessionState(state, home);
    for (const cmd of ["./gradlew test", "npm run build"]) {
      recordActivity(
        { session_id: id, tool_name: "Bash", tool_input: { command: cmd }, hook_event_name: "PostToolUse" },
        home,
      );
    }
    recordActivity(
      { session_id: id, tool_name: "Edit", tool_input: { file_path: "/repo/src/A.kt" }, hook_event_name: "PostToolUse" },
      home,
    );
  }

  it("records a work shape at session end and counts recurrences", () => {
    for (const id of ["s1", "s2", "s3"]) {
      sessionWithActivity(id);
      flushSessionEnd(id, home);
    }
    const rec = workRecurrences(home);
    expect(rec).toHaveLength(1);
    expect(rec[0]!.count).toBe(3);
    expect(rec[0]!.families).toContain("gradlew test");
    expect(rec[0]!.exts).toContain(".kt");
  });

  it("keeps work records weak — they are recurrence counters, never skill material", () => {
    const work = workRecordFromState(
      { activity: { families: ["gradlew test"], exts: [".kt"] } },
      "s1",
      "2026-08-08T00:00:00Z",
    )!;
    expect(work.kind).toBe("weak");
    expect(work.work).toBeDefined();
  });

  it("nudges once per work shape at the default threshold (2)", () => {
    for (const id of ["s1", "s2"]) {
      sessionWithActivity(id);
      flushSessionEnd(id, home);
    }
    const nudge = pendingWorkNudge(home);
    expect(nudge).toContain("similar work 2 times");
    expect(nudge).toContain("/handbook:learn");
    expect(pendingWorkNudge(home)).toBeNull();
  });

  it("honors a configured nudge threshold", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ notify: { workNudgeThreshold: 4 } }));
    for (const id of ["s1", "s2", "s3"]) {
      sessionWithActivity(id);
      flushSessionEnd(id, home);
    }
    expect(pendingWorkNudge(home)).toBeNull();
  });

  it("stays silent below the threshold and for command-only sessions", () => {
    sessionWithActivity("s1");
    flushSessionEnd("s1", home);
    expect(pendingWorkNudge(home)).toBeNull();
    const none = workRecordFromState({ activity: { families: ["npm test"], exts: [] } }, "s", "t");
    expect(none).toBeNull();
  });
});
