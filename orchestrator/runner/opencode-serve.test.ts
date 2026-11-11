import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { routeOf, serveEnv, startOpencodeServe } from "./opencode-serve.js";
import { standIn } from "./opencode-serve.fixture.js";

describe("one task's OpenCode server", () => {
  const closers: (() => void)[] = [];
  afterEach(() => closers.splice(0).forEach((close) => close()));

  it("given each call the shared codec writes, when it is routed, then it goes to OpenCode's own route with its body, and an id that could leave the route is refused", () => {
    expect(routeOf({ op: "session.promptAsync", args: { sessionID: "ses_1", parts: [{ type: "text", text: "go" }] } })).toEqual({ method: "POST", path: "/session/ses_1/prompt_async", body: { parts: [{ type: "text", text: "go" }] } });
    expect(routeOf({ op: "session.abort", args: { sessionID: "ses_1" } })).toEqual({ method: "POST", path: "/session/ses_1/abort", body: {} });
    expect(routeOf({ op: "permission.reply", args: { requestID: "per_9", reply: "once" } })).toEqual({ method: "POST", path: "/permission/per_9/reply", body: { reply: "once" } });
    expect(() => routeOf({ op: "session.abort", args: { sessionID: "../config" } })).toThrow(/no usable sessionID/);
  });

  it("given a person whose environment holds a server password of their own or turns project config back on, when the task's server starts, then it gets this task's password and never reads the repository's config", () => {
    const env = serveEnv({ PATH: "/usr/bin", OPENCODE_SERVER_PASSWORD: "theirs", OPENCODE_PASSWORD: "theirs-too", OPENCODE_DISABLE_PROJECT_CONFIG: "0" }, "task-only");
    expect(env).toEqual({ PATH: "/usr/bin", OPENCODE_SERVER_PASSWORD: "task-only", OPENCODE_PASSWORD: "task-only", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" });
  });

  it("given the server listening, when a session is made, the codec answers a permission and the server sends an event, then every call carries the task's password and the event reaches the session", async () => {
    let stream: ServerResponse | null = null;
    const fake = standIn((req, res) => {
      if (req.url !== "/event") return false;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": hello\n\n");
      stream = res;
      return true;
    });
    const serve = await startOpencodeServe({ program: "opencode", cwd: "/", env: { PATH: "/usr/bin" }, spawn: fake.spawn });
    closers.push(() => serve.stop());

    expect(await serve.createSession({ "*": "deny" })).toBe("ses_1");
    const transport = serve.transport();
    const reading = transport.lines[Symbol.asyncIterator]().next();
    while (!stream) await new Promise((r) => setTimeout(r, 5));
    (stream as ServerResponse).write(`data: ${JSON.stringify({ type: "permission.asked", properties: { id: "per_9" } })}\n\n`);
    transport.write(JSON.stringify({ op: "permission.reply", args: { requestID: "per_9", reply: "once" } }));

    expect(JSON.parse((await reading).value as string)).toEqual({ type: "permission.asked", properties: { id: "per_9" } });
    while (!fake.seen.some((s) => s.path === "/permission/per_9/reply")) await new Promise((r) => setTimeout(r, 5));
    expect(fake.seen.find((s) => s.path === "/session")?.body).toEqual({ permission: { "*": "deny" } });
    expect(fake.seen.find((s) => s.path === "/permission/per_9/reply")?.body).toEqual({ reply: "once" });
    expect(new Set(fake.seen.map((s) => s.auth)).size).toBe(1);
    expect(fake.env[0]!.OPENCODE_SERVER_PASSWORD).toMatch(/^[\w-]{43}$/);
    transport.kill();
    expect(await serve.exit).toBe(0);
  });

  it("given an event stream that goes quiet, when the silence passes, then the stream is opened again on the same server", async () => {
    let opened = 0;
    const fake = standIn((req, res) => {
      if (req.url !== "/event") return false;
      opened += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (opened === 2) res.write(`data: ${JSON.stringify({ type: "session.idle" })}\n\n`);
      return true;
    });
    const serve = await startOpencodeServe({ program: "opencode", cwd: "/", env: {}, spawn: fake.spawn, silenceMs: 200 });
    closers.push(() => serve.stop());

    const first = await serve.transport().lines[Symbol.asyncIterator]().next();

    expect(JSON.parse(first.value as string)).toEqual({ type: "session.idle" });
    expect(opened).toBe(2);
  });

  it("given a server that says it listens on another address, when it starts, then the start fails and the server is stopped", async () => {
    const fake = standIn(undefined, () => "opencode server listening on http://127.0.0.1:1");
    closers.push(fake.close);

    await expect(startOpencodeServe({ program: "opencode", cwd: "/", env: {}, spawn: fake.spawn })).rejects.toThrow(/somewhere other than/);
  });
});
