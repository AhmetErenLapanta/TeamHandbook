import { afterEach, describe, expect, it } from "vitest";
import { standIn } from "./opencode-serve.fixture.js";
import { startOpencodeSession } from "./opencode-session.js";

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
});
