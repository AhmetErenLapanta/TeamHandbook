import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

import { fakeAgentAdapter } from "../agents.js";
import { taskPaths } from "../isolation.js";
import type { AgentEvent, AgentTransport } from "./contract.js";
import { openSession } from "./session.js";

const SCRIPT = join(import.meta.dirname, "..", "..", "..", "demo", "fake-agent.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The runner's part, as small as a test needs: the program on pipes, its stdout as lines. */
function processTransport(program: string, args: string[], cwd: string): AgentTransport {
  const child = spawn(program, args, { cwd, stdio: ["pipe", "pipe", "inherit"] });
  const exit = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return {
    lines: createInterface({ input: child.stdout }),
    write: (line) => void child.stdin.write(line + "\n"),
    end: () => void child.stdin.end(),
    kill: () => void child.kill("SIGKILL"),
    exit,
  };
}

function start(mode: "approval-required" | "auto" = "approval-required") {
  const work = mkdtempSync(join(tmpdir(), "orchestrator-fake-two-way-"));
  dirs.push(work);
  const { call, codec } = fakeAgentAdapter(SCRIPT).twoWay!.launch(taskPaths(work, "t", "0123456789ab"), { skills: [], mcpServers: {}, mcpTools: [] }, { mode });
  return { work, session: openSession(codec, processTransport(call.program, call.args, work)) };
}

describe("the stand-in agent in a two-way session", () => {
  it("given a message that asks before it writes, when the person allows it and the session closes after the turn, then the question, the answer and the skill all happen and the session completes", async () => {
    // given
    const { work, session } = start();

    // when
    session.sendTurn("Add an on-call note\nstand-in: ask Write notes.md");
    const events: AgentEvent[] = [];
    for await (const e of session.events) {
      events.push(e);
      if (e.type === "request") session.respond(e.request.id, "allow-once");
      if (e.type === "turn_finished") session.close();
    }

    // then
    expect(events.filter((e) => e.type === "request")).toEqual([{ type: "request", request: { id: "ask-1-1", kind: "permission", tool: "Write", summary: "notes.md" } }]);
    expect(events).toContainEqual({ type: "message", text: "allowed Write notes.md" });
    expect(events.at(-1)).toEqual({ type: "terminal", status: "completed", summary: "Done with turn 1." });
    expect(existsSync(join(work, "skills", "add-an-on-call-note", "SKILL.md"))).toBe(true);
  });

  it("given Auto, when the message asks before it writes, then the stand-in goes ahead without a question, as an agent in Auto does", async () => {
    // given
    const { session } = start("auto");

    // when
    session.sendTurn("Add an on-call note\nstand-in: ask Write notes.md");
    const events: AgentEvent[] = [];
    for await (const e of session.events) {
      events.push(e);
      if (e.type === "turn_finished") session.close();
    }

    // then
    expect(events.some((e) => e.type === "request")).toBe(false);
    expect(events).toContainEqual({ type: "message", text: "allowed Write notes.md without a question" });
    expect(events.at(-1)).toMatchObject({ type: "terminal", status: "completed" });
  });

  it("given each mode the stand-in offers, when it starts, then it runs, and only the asking modes are told to ask", () => {
    const adapter = fakeAgentAdapter(SCRIPT);
    expect(adapter.twoWay!.capabilities.permissionModes).toEqual(["approval-required", "auto-accept-edits", "auto"]);
    const args = (mode: "approval-required" | "auto-accept-edits" | "auto") => adapter.twoWay!.launch(taskPaths("/data", "t", "0123456789ab"), { skills: [], mcpServers: {}, mcpTools: [] }, { mode }).call.args;
    expect(args("approval-required")).toContain("--asks");
    expect(args("auto-accept-edits")).toContain("--asks");
    expect(args("auto")).not.toContain("--asks");
  });

  it("given a turn that waits, when it is interrupted, then the stand-in stops the turn at once and the session ends interrupted", async () => {
    // given
    const { session } = start();
    const began = Date.now();

    // when
    session.sendTurn("Slow work\nstand-in: wait 30 seconds");
    const events: AgentEvent[] = [];
    for await (const e of session.events) {
      events.push(e);
      if (e.type === "message" && e.text.startsWith("reading the message")) session.interrupt();
      if (e.type === "turn_finished") session.close();
    }

    // then
    expect(events.at(-1)).toEqual({ type: "terminal", status: "interrupted", summary: "" });
    expect(Date.now() - began).toBeLessThan(15_000);
  });
});

describe("the stand-in agent as the live view sees it", () => {
  it("given a one-shot task, when the stand-in writes its skill, then its plan moves to done, the write is a change inside the folder with every line added, and its check is a command with its output, each call by its own id", async () => {
    // given
    const work = mkdtempSync(join(tmpdir(), "orchestrator-fake-live-"));
    dirs.push(work);
    const transport = processTransport(process.execPath, [SCRIPT, "--title", "Add an on-call note"], work);
    transport.write("Add an on-call note");
    transport.end();

    // when
    const events: AgentEvent[] = [];
    for await (const e of openSession(fakeAgentAdapter(SCRIPT).decoder(work), transport).events) events.push(e);

    // then
    const plans = events.flatMap((e) => (e.type === "todos" ? [e.items.map((i) => i.state)] : []));
    expect(plans).toEqual([["done", "doing", "todo"], ["done", "done", "done"]]);
    expect(events.filter((e) => e.type === "tool_call").map((e) => e.type === "tool_call" && `${e.id} ${e.tool} ${e.status}`)).toEqual(["call-1 Write started", "call-1 Write done", "call-2 Bash started", "call-2 Bash done"]);
    expect(events.find((e) => e.type === "edit")).toMatchObject({ type: "edit", id: "call-1", path: "skills/add-an-on-call-note/SKILL.md", additions: 6, deletions: 0 });
    expect(events.find((e) => e.type === "tool_output")).toEqual({ type: "tool_output", id: "call-2", lines: ["SKILL.md"] });
    expect(events.find((e) => e.type === "tool_call" && e.tool === "Bash")).toMatchObject({ command: "ls skills/add-an-on-call-note" });
    expect(events.at(-1)).toMatchObject({ type: "terminal", status: "completed" });
  });

  it("given the stand-in's live lines with a path outside the folder or a state it does not know, when they are read, then the edit is dropped and so is the step", () => {
    const decoder = fakeAgentAdapter(SCRIPT).decoder("/data/tasks/t/0123456789ab/work");
    expect(decoder.decode(JSON.stringify({ type: "edit", id: "call-1", path: "/etc/hosts", patch: "+x" }))).toEqual([]);
    expect(decoder.decode(JSON.stringify({ type: "edit", id: "call-1", path: "../home/settings.json", patch: "+x" }))).toEqual([]);
    expect(decoder.decode(JSON.stringify({ type: "todos", todos: [{ content: "a", status: "pending" }, { content: "b", status: "blocked" }] }))).toEqual([{ type: "todos", items: [{ text: "a", state: "todo" }] }]);
    expect(decoder.decode(JSON.stringify({ type: "tool_call", id: "call-1", tool: "Write", target: "a", status: "exploded" }))).toEqual([]);
  });
});
