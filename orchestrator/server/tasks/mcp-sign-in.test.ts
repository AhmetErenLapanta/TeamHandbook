import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUser } from "../accounts.js";
import type { OrchestratorContext } from "../app.js";
import { openSqliteStore } from "../store.js";
import { claudeCodeAdapter } from "./agents.js";
import { startMcpSignInSession } from "./mcp-sign-in.js";
import { createTaskRunner } from "./runner.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for the claude CLI in a stream-json session: it answers mcp_status with one plugin server and one of the
 * person's own, in the status `docs` starts with, answers mcp_authenticate with a sign-in address, and reports `docs`
 * connected once it has been asked `connectAfter` more times.
 */
function standIn(docs: "needs-auth" | "connected", connectAfter = 2): string {
  const dir = mkdtempSync(join(tmpdir(), "th-mcp-sign-in-"));
  dirs.push(dir);
  const file = join(dir, "claude-stand-in.mjs");
  writeFileSync(
    file,
    `#!${process.execPath}
import { createInterface } from "node:readline";
let docs = ${JSON.stringify(docs)};
let after = -1;
const say = (id, response) => console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response } }));
for await (const line of createInterface({ input: process.stdin })) {
  const { request_id: id, request } = JSON.parse(line);
  if (request.subtype === "mcp_status") {
    if (after > 0 && --after === 0) docs = "connected";
    say(id, { mcpServers: [{ name: "plugin_atlassian_docs", status: docs }, { name: "tracker", status: "connected" }] });
  }
  if (request.subtype === "mcp_authenticate") {
    after = ${connectAfter};
    say(id, { authUrl: "https://auth.example.invalid/authorize?state=abc", requiresUserAction: true, callbackExpected: true });
  }
}
`,
  );
  chmodSync(file, 0o755);
  return file;
}

const until = async (check: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("signing a person's MCP server in from a short session", { timeout: 60_000 }, () => {
  it("given a plugin's server that needs a sign-in, when it is asked for by the name the page shows, then the address to open comes back first and the session reads signed in once Claude Code connects it", async () => {
    // given
    const program = standIn("needs-auth");

    // when
    const session = startMcpSignInSession(program, { PATH: process.env.PATH ?? "" }, tmpdir(), "docs");
    const first = await session.first;
    const waiting = session.state();
    await until(() => session.state().state !== "waiting");

    // then
    expect(first).toEqual({ authorizeUrl: "https://auth.example.invalid/authorize?state=abc" });
    expect(waiting).toEqual({ state: "waiting" });
    expect(session.state()).toEqual({ state: "signed-in" });
  });

  it("given a server already signed in and a name no server has, when each is asked for, then the first says so with no address and the second fails saying why", async () => {
    // given
    const program = standIn("connected");

    // when
    const signed = startMcpSignInSession(program, { PATH: process.env.PATH ?? "" }, tmpdir(), "docs");
    const unknown = startMcpSignInSession(program, { PATH: process.env.PATH ?? "" }, tmpdir(), "wiki");
    const answers = [await signed.first, await unknown.first];

    // then
    expect(answers).toEqual([{ signedIn: true }, { failed: "Claude Code has no one server by that name; use the command instead." }]);
    expect([signed.state().state, unknown.state().state]).toEqual(["signed-in", "failed"]);
  });

  it("given a sign-in the person never finishes, when its time runs out, then it reads failed with the reason to try again", async () => {
    // given
    const program = standIn("needs-auth", 10_000);

    // when
    const session = startMcpSignInSession(program, { PATH: process.env.PATH ?? "" }, tmpdir(), "docs", 3_000);
    await session.first;
    await until(() => session.state().state !== "waiting");

    // then
    expect(session.state()).toEqual({ state: "failed", why: "The sign-in did not come back; try again, or sign in with claude and /mcp." });
  });
});

describe("who a one-click sign-in reaches", { timeout: 60_000 }, () => {
  it("given one person's orchestrator on this machine, when it is and is not the one their own Claude Code is reached from, then only the first starts a sign-in", async () => {
    // given
    const program = standIn("needs-auth");
    const dir = mkdtempSync(join(tmpdir(), "th-mcp-sign-in-runner-"));
    dirs.push(dir);
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: dir, tenant: "acme" };
    await createUser(ctx.store, ctx.tenant, new Set(["Mine"]), { email: "ada@example.invalid", name: "Ada Example", role: "owner" }, { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] });
    const runner = createTaskRunner(ctx, { agents: [claudeCodeAdapter(program)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH, HOME: dir }, profile: "personal" });

    // when
    ctx.ownForgeCli = false;
    const remote = await runner.startMcpSignIn("docs");
    ctx.ownForgeCli = true;
    const own = await runner.startMcpSignIn("docs");

    // then
    expect(remote).toEqual({ failed: "Your Claude Code is reached only by an orchestrator on your own machine that you alone use; sign in with claude and /mcp." });
    expect(own).toEqual({ authorizeUrl: "https://auth.example.invalid/authorize?state=abc" });
    expect(runner.mcpSignInState("docs").state).toBe("waiting");
  });
});
