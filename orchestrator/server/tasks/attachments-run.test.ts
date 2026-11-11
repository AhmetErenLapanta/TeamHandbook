import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS, attachmentPath } from "../attachments.js";
import type { Principal } from "../auth.js";
import { seededContext, storePrincipals } from "../test-fixtures.js";
import { claudeCodeAdapter, fakeAgentAdapter } from "./agents.js";
import { createTaskRunner } from "./runner.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the claude CLI that keeps its arguments, its prompt and whether the attached file reads, at `record`, then changes nothing. */
function recordingClaude(dir: string, record: string): string {
  const bin = join(dir, "claude-recording.mjs");
  writeFileSync(
    bin,
    `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const prompt = readFileSync(0, "utf8");
const added = argv[argv.indexOf("--add-dir") + 1];
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, prompt, read: added && existsSync(added + "/screenshot.png") ? readFileSync(added + "/screenshot.png", "utf8") : null }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Done.", total_cost_usd: 0 }));
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe("the files attached to a task, as its agent reads them", { timeout: 120_000 }, () => {
  it("given a file attached to a task while it waits in line, and one whose name is no file's, when its Claude Code agent starts, then the file is copied outside the working tree, opened to it for reading only, and named in its prompt as data", async () => {
    // given
    const { ctx, root } = await seededContext("th-attach-", ["payments-skills"]);
    dirs.push(root);
    await storePrincipals(ctx, ADMIN);
    const record = join(root, "claude-run.json");
    const tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT), claudeCodeAdapter(recordingClaude(root, record))], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH }, concurrency: 1 });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    await tasks.start({ repo, title: "Hold the line", description: "stand-in: wait 2 seconds", agent: "fake", user: ADMIN });
    const task = await tasks.start({ repo, title: "Fix the layout", description: "", agent: "claude-code", user: ADMIN });
    const id = "att_screenshot00000000000000";
    const path = attachmentPath(ctx.dataDir, ctx.tenant, id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "stand-in image bytes");
    await ctx.store.insertAttachment({ tenant: ctx.tenant, id, taskId: task.id, name: "screenshot.png", mime: "image/png", size: 20, sha256: "0".repeat(64), createdBy: ADMIN.email, createdAt: new Date().toISOString() }, ATTACHMENT_LIMITS);
    const odd = "att_dotdot000000000000000000";
    writeFileSync(attachmentPath(ctx.dataDir, ctx.tenant, odd), "notes");
    await ctx.store.insertAttachment({ tenant: ctx.tenant, id: odd, taskId: task.id, name: "..", mime: "text/plain", size: 5, sha256: "1".repeat(64), createdBy: ADMIN.email, createdAt: new Date().toISOString() }, ATTACHMENT_LIMITS);

    // when
    await tasks.idle();

    // then
    expect(existsSync(record)).toBe(true);
    const { argv, prompt, read } = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; prompt: string; read: string | null };
    const added = argv[argv.indexOf("--add-dir") + 1]!;
    expect(added.endsWith(join(task.id, "attachments"))).toBe(true);
    expect(argv).toContain(`Edit(/${added}/**),Write(/${added}/**),NotebookEdit(/${added}/**)`);
    expect(read).toBe("stand-in image bytes");
    expect(prompt).toContain("## Files attached to this task");
    expect(prompt).toContain("screenshot.png (image)");
    expect(prompt).toContain("attachment (text)");
    expect(added.includes(`${join("work")}/`)).toBe(false);
  });
});
