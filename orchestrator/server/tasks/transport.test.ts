import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processTransport } from "./transport.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in agent: each line it reads comes back as `heard <line>`, and it exits 0 when its input closes. */
function echoAgent(): string {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-transport-"));
  dirs.push(dir);
  const program = join(dir, "echo.mjs");
  writeFileSync(program, 'import { createInterface } from "node:readline";\nfor await (const line of createInterface({ input: process.stdin })) console.log(`heard ${line}`);\n');
  return program;
}

const run = (program: string, args: string[], timeoutMs = 60_000) => {
  const logged: string[] = [];
  const transport = processTransport({ program: process.execPath, args: [program, ...args], env: { PATH: process.env.PATH ?? "" }, cwd: tmpdir() }, { timeoutMs, signal: new AbortController().signal, onLine: (stream, line) => logged.push(`${stream}: ${line}`) });
  return { transport, logged };
};

const all = async (lines: AsyncIterable<string>) => {
  const read: string[] = [];
  for await (const line of lines) read.push(line);
  return read;
};

describe("an agent process with its input kept open", { timeout: 60_000 }, () => {
  it("given an agent that answers each line, when two lines are written and its input is closed, then it hears both in order, its lines reach the session and the log, and it exits cleanly", async () => {
    // given
    const { transport, logged } = run(echoAgent(), []);

    // when
    transport.write("the task's prompt");
    transport.write("a message while it works");
    transport.end();
    const read = await all(transport.lines);

    // then
    expect(read).toEqual(["heard the task's prompt", "heard a message while it works"]);
    expect(logged).toEqual(["stdout: heard the task's prompt", "stdout: heard a message while it works"]);
    expect(await transport.exit).toBe(0);
  });

  it("given an agent whose input stays open, when it is killed, then its lines end, it exits and the run reads as cancelled", async () => {
    // given
    const { transport } = run(echoAgent(), []);
    transport.write("still listening");

    // when
    const first = await transport.lines[Symbol.asyncIterator]().next();
    transport.kill();

    // then
    expect(first.value).toBe("heard still listening");
    expect(await all(transport.lines)).toEqual([]);
    expect((await transport.outcome).cancelled).toBe(true);
  });

  it("given an agent that has already exited, when a line is written to it, then nothing throws and the outcome is the one it ended with", async () => {
    // given
    const { transport } = run(echoAgent(), []);
    transport.end();
    await transport.exit;

    // when
    transport.write("too late");

    // then
    expect((await transport.outcome).code).toBe(0);
  });
});
