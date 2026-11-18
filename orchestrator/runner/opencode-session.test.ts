import { afterEach, describe, expect, it } from "vitest";
import { standIn } from "./opencode-serve.fixture.js";
import { contextWindows, startOpencodeSession } from "./opencode-session.js";

describe("a task's OpenCode session over its own server", () => {
  const closers: (() => void)[] = [];
  afterEach(() => closers.splice(0).forEach((close) => close()));

  it("given the task's permission rules, when the session starts, then OpenCode made it under those rules and the codec and transport belong to that session", async () => {
    const fake = standIn();
    const permission = { "*": "deny", read: "allow", bash: "ask" };

    const session = await startOpencodeSession({ program: "opencode", cwd: "/", env: {}, permission, spawn: fake.spawn });
    closers.push(() => session.stop());

    expect(session.sessionId).toBe("ses_1");
    expect(fake.seen.find((s) => s.path === "/session")?.body).toEqual({ permission });
    expect(session.codec.turn("go")).toContain("ses_1");
  });

  it("given a server that will not make a session, when the session starts, then the start fails and the server is stopped", async () => {
    let stopped = false;
    const fake = standIn((req, res) => {
      if (req.url !== "/session") return false;
      res.writeHead(500).end();
      return true;
    });
    const spawn: typeof fake.spawn = (...args) => {
      const child = fake.spawn(...args);
      child.once("exit", () => (stopped = true));
      return child;
    };

    await expect(startOpencodeSession({ program: "opencode", cwd: "/", env: {}, permission: {}, spawn })).rejects.toThrow(/answered POST session with 500/);
    expect(stopped).toBe(true);
  });

  it("given a server turned off for the task that OpenCode left disabled and one it connected anyway, when the session starts, then the first starts with what loaded as its first event and the second starts no session at all", async () => {
    // given
    const servers: Parameters<typeof standIn>[0] = (req, res) => {
      if (req.method !== "GET" || req.url !== "/mcp") return false;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ tracker: { status: "connected" }, docs: { status: "disabled" }, notes: { status: "needs_auth" } }));
      return true;
    };
    const left = standIn(servers);
    const loadedAnyway = standIn(servers);

    // when
    const session = await startOpencodeSession({ program: "opencode", cwd: "/", env: {}, permission: {}, off: ["docs"], spawn: left.spawn });
    closers.push(() => session.stop());
    const refused = startOpencodeSession({ program: "opencode", cwd: "/", env: {}, permission: {}, off: ["tracker"], spawn: loadedAnyway.spawn });

    // then
    expect(session.codec.decode("{}")[0]).toEqual({ type: "loaded", plugins: null, skills: null, mcpServers: [{ name: "tracker", state: "connected" }, { name: "docs", state: "off" }, { name: "notes", state: "needs-sign-in" }] });
    await expect(refused).rejects.toThrow("MCP server tracker is off for this task and was loaded anyway, so no session was started");
    expect(loadedAnyway.seen.some((s) => s.path === "/session")).toBe(false);
  });

  it("given OpenCode's provider table, when the session starts, then each model's context window is known by provider and model, and a model with no usable limit is left out", () => {
    // when
    const windows = contextWindows({ providers: [{ id: "stand-in-cloud", models: { "big-model": { limit: { context: 200_000, output: 8_000 } }, "odd-model": { limit: { context: "lots" } } } }, { id: "local", models: { tiny: { limit: { context: 8_192 } } } }], default: { "stand-in-cloud": "big-model" } });

    // then
    expect(windows).toEqual({ "stand-in-cloud/big-model": 200_000, "local/tiny": 8_192 });
    expect(contextWindows(null)).toEqual({});
  });
});
